import { timingSafeEqual } from 'crypto';
import { hashPw, whoami } from '@/lib/auth';
import { answerChat } from '@/lib/chatcore';
import { addCmd, ak, getJSON, getUsers, setJSON } from '@/lib/store';
import { esc, saveLinks, tgApi, tgSend, type Kb, type TgLink } from '@/lib/telegram';
import { CFG_KEYS, cfgButton, cfgHome, cfgValue } from '@/lib/tgconfig';
import { MENU_KEYS, gate, onMenuButton, plain, setPaused, showDaily, showMain, showOrders, showStatus } from '@/lib/tgmenu';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Telegram bot webhook. Register it once with POST /api/telegram/setup (see README).
// Private chats only. A chat must log in with the same password used for the dashboard (/login <password>);
// after that it receives order notifications for that account, gets the button menus, and can ask the AI.
// Menus (main, trend, EA settings, notifications, status, orders) live in lib/tgmenu.ts, the grid/AI settings in lib/tgconfig.ts.
const MAX_FAILS = 6, LOCK_MS = 15 * 60_000;
const MAX_LOT = Number(process.env.MAX_LOT ?? 0.1);
const LOTS = (process.env.TELEGRAM_LOTS || '0.01,0.02,0.05,0.1').split(',').map(Number).filter((v) => v > 0 && v <= MAX_LOT);

const HELP = `พิมพ์ /menu เพื่อเปิดเมนูปุ่มกด (วิเคราะห์แนวโน้ม, ตั้งค่า EA, สถานะ, การแจ้งเตือน) หรือใช้คำสั่ง
/login <รหัสผ่าน> ผูกแชทนี้กับบัญชีของคุณ (รหัสเดียวกับที่ใช้เข้าเว็บ)
/status สถานะระบบและการตัดสินใจล่าสุดของ AI
/orders ออเดอร์ของ EA (ไม้ที่เปิดอยู่ + ปิดล่าสุด)
/daily สรุปยอดรายวัน
/buy [คู่เงิน] <lot> [sl] [tp] สั่งซื้อ เช่น /buy XAUUSD 0.01 หรือ /buy 0.01 (ใช้คู่ล่าสุดของ AI)
/sell [คู่เงิน] <lot> [sl] [tp] สั่งขาย
/confirm ยืนยันออเดอร์ที่รออยู่ (หมดอายุใน 2 นาที) /cancel ยกเลิก
/settings ตั้งค่ากริด/AI ของบัญชีคุณ (ผู้ดูแลแก้ค่ากลาง)
/pause /resume หยุด/เปิดระบบ (ผู้ดูแลเท่านั้น)
/logout เลิกผูกแชทนี้
พิมพ์ข้อความธรรมดาเพื่อถาม AI ได้เลย เช่น "วิเคราะห์ทอง"`;

const eq = (a: string | null, b: string | undefined) => {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const SYM_RE = /^[A-Z0-9._#-]{3,20}$/;
type Order = { symbol: string; side: 'BUY' | 'SELL'; lot: number; sl?: number; tp?: number };
type Me = TgLink;

export async function POST(req: Request) {
  // Telegram sends the secret we gave setWebhook in this header; without it anyone could post fake updates
  if (!eq(req.headers.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) return new Response('unauthorized', { status: 401 });
  const update = await req.json().catch(() => null);
  // always answer 200 so Telegram does not keep retrying the same update
  const cq = update?.callback_query;
  if (cq) {
    if (cq.message?.chat?.type !== 'private') return new Response('ok');
    const chatId = String(cq.message.chat.id);
    try { await onButton(chatId, cq); } catch (e: any) { await tgSend(chatId, 'เกิดข้อผิดพลาด: ' + String(e?.message ?? e).slice(0, 200)); }
    return new Response('ok');
  }
  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string' || msg.chat?.type !== 'private') return new Response('ok');
  const chatId = String(msg.chat.id);
  try { await onText(chatId, msg.message_id, msg.text.trim()); } catch (e: any) { await tgSend(chatId, 'เกิดข้อผิดพลาด: ' + String(e?.message ?? e).slice(0, 200)); }
  return new Response('ok');
}

// who is this chat? The link stays valid only while the password it was made with is still the current one:
// a deleted user, a reset password or a changed ADMIN_KEY logs the chat out too.
async function session(chatId: string): Promise<Me | null> {
  const me = (await getJSON<Record<string, TgLink>>('tg:links', {}))[chatId];
  if (!me?.pwh) return null;
  if (me.role === 'admin') return process.env.ADMIN_KEY && me.pwh === hashPw(process.env.ADMIN_KEY) ? me : null;
  const u = (await getUsers()).find((x) => x.id === me.acct);
  return u && u.hash === me.pwh ? me : null;
}
const NEED_LOGIN = 'ยังไม่ได้ล็อกอิน พิมพ์ /login <รหัสผ่าน> ก่อน (รหัสเดียวกับที่ใช้เข้าเว็บ)';

/* ---------- order flow ---------- */
// Same path as the dashboard BUY/SELL button: queue + risk limits (MAX_LOT, ALLOWED_SYMBOLS) + news guard + pause all apply.
async function place(chatId: string, acct: string, o: Order) {
  const c = await addCmd({ ...o, source: 'manual', noHold: true }, acct);
  if (c.status === 'blocked') return; // addCmd already pushed the ⛔ reason to every chat of this account
  return tgSend(chatId, `ส่งคำสั่งเข้าคิวแล้ว (id ${c.id}) EA จะรับภายในไม่กี่วินาที`);
}
// order ready -> ask for the final tap (or send at once when TELEGRAM_CONFIRM=off)
async function ask(chatId: string, acct: string, o: Order) {
  if (process.env.TELEGRAM_CONFIRM === 'off') return place(chatId, acct, o);
  await setJSON(`tg:pend:${chatId}`, { order: o, exp: Date.now() + 120_000 });
  return tgSend(chatId, `⚠️ <b>ยืนยันออเดอร์</b>\n${o.side === 'BUY' ? '🟢' : '🔴'} <b>${o.side}</b> ${esc(o.symbol)} · lot <b>${o.lot}</b>${o.sl ? ' · SL ' + o.sl : ''}${o.tp ? ' · TP ' + o.tp : ''}\n<i>กดยืนยันภายใน 2 นาที</i>`,
    [[{ text: '✅ ยืนยัน ส่งออเดอร์', callback_data: 'ok' }, { text: '❌ ยกเลิก', callback_data: 'no' }]], true);
}
async function resolvePending(chatId: string, acct: string, send: boolean) {
  const pk = `tg:pend:${chatId}`, p = await getJSON<any>(pk, null);
  if (!p || p.exp < Date.now()) return tgSend(chatId, 'ไม่มีออเดอร์ที่รอยืนยัน (หรือหมดเวลาแล้ว)');
  await setJSON(pk, null); // one-shot: a second tap / /confirm can never send the same order twice
  return send ? place(chatId, acct, p.order) : tgSend(chatId, 'ยกเลิกออเดอร์แล้ว');
}
async function symbolChoices(acct: string): Promise<string[]> {
  const dec = await getJSON<any>(ak('decision', acct), null);
  const allow = (process.env.ALLOWED_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [...new Set([String(dec?.symbol ?? '').toUpperCase(), ...(await getJSON<string[]>('symbols', [])).map((s) => String(s).toUpperCase()), ...allow])].filter((s) => SYM_RE.test(s)).slice(0, 8);
}
const lotButtons = (side: string, sym: string): Kb => [
  LOTS.map((l) => ({ text: String(l), callback_data: `l:${side}:${sym}:${l}` })),
  [{ text: '❌ ยกเลิก', callback_data: 'no' }],
];

/* ---------- buttons ---------- */
async function onButton(chatId: string, cq: any) {
  tgApi('answerCallbackQuery', { callback_query_id: cq.id }); // stops the spinner on the tapped button
  const me = await session(chatId);
  if (!me) return tgSend(chatId, NEED_LOGIN);
  const acct = me.acct;
  const [k, ...a] = String(cq.data ?? '').split(':');
  if (MENU_KEYS.has(k)) return onMenuButton(chatId, me, cq.message.message_id, [k, ...a]); // menus edit the tapped message in place
  if (CFG_KEYS.has(k)) { // grid/AI settings: every screen is a fresh message, so take the buttons off the old one
    tgApi('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    return cfgButton(chatId, me, [k, ...a]);
  }
  // order-flow buttons are single use: take the buttons off the tapped message so a double tap cannot repeat a step
  if (['o', 's', 'l', 'ok', 'no'].includes(k)) tgApi('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (k === 'ok' || k === 'no') return resolvePending(chatId, acct, k === 'ok');

  const side = a[0] === 'BUY' || a[0] === 'SELL' ? a[0] : null;
  if (!side || !LOTS.length) return tgSend(chatId, 'ปุ่มนี้ใช้ไม่ได้ ลองพิมพ์ /menu ใหม่');
  const icon = side === 'BUY' ? '🟢' : '🔴';
  if (k === 'o') { // step 1: side chosen -> pick the pair (skipped when only one is known)
    const syms = await symbolChoices(acct);
    if (!syms.length) return tgSend(chatId, `ยังไม่รู้ว่าบัญชีนี้เทรดคู่ไหน พิมพ์เอง เช่น /${side.toLowerCase()} XAUUSD 0.01`);
    if (syms.length === 1) return tgSend(chatId, `${icon} ${side} ${syms[0]}\nเลือกขนาด lot`, lotButtons(side, syms[0]));
    return tgSend(chatId, `${icon} ${side}\nเลือกคู่เงิน`, [...syms.map((s) => [{ text: s, callback_data: `s:${side}:${s}` }]), [{ text: '❌ ยกเลิก', callback_data: 'no' }]]);
  }
  const symbol = String(a[1] ?? '');
  if (!SYM_RE.test(symbol)) return;
  if (k === 's') return tgSend(chatId, `${icon} ${side} ${symbol}\nเลือกขนาด lot`, lotButtons(side, symbol)); // step 2
  if (k === 'l') { // step 3: lot chosen -> final confirmation
    const lot = Number(a[2]);
    if (!(lot > 0) || lot > MAX_LOT) return tgSend(chatId, `lot ต้องอยู่ระหว่าง 0 ถึง ${MAX_LOT}`);
    return ask(chatId, acct, { symbol, side, lot });
  }
}

/* ---------- text commands ---------- */
async function onText(chatId: string, messageId: number, text: string) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.startsWith('/') ? raw.slice(1).split('@')[0].toLowerCase() : '';
  const arg = rest.join(' ');

  if (cmd === 'login') return login(chatId, messageId, arg);
  const me = await session(chatId);
  if (cmd === 'start' || cmd === 'help') { await tgSend(chatId, 'MT5 Signal Hub\n\n' + HELP); return me ? showMain(chatId, me) : undefined; }
  if (!me) return tgSend(chatId, NEED_LOGIN);
  const acct = me.acct;

  if (cmd === 'settings') return cfgHome(chatId, me);
  if (cmd === 'menu') return showMain(chatId, me);
  if (cmd === 'logout') {
    const links = await getJSON<Record<string, TgLink>>('tg:links', {});
    delete links[chatId]; await saveLinks(links);
    return tgSend(chatId, 'เลิกผูกแชทนี้แล้ว');
  }
  if (cmd === 'status') return showStatus(chatId, me);
  if (cmd === 'orders') return showOrders(chatId, me);
  if (cmd === 'daily') return showDaily(chatId, me);
  if (cmd === 'pause' || cmd === 'resume') return tgSend(chatId, await setPaused(me, cmd === 'pause'));
  if (cmd === 'confirm' || cmd === 'cancel') return resolvePending(chatId, acct, cmd === 'confirm');

  if (cmd === 'buy' || cmd === 'sell') {
    const t = arg.split(/\s+/).filter(Boolean);
    const sym = t.length && !Number.isFinite(Number(t[0])) ? t.shift()!.toUpperCase() : '';
    const [lot, sl, tp] = t.map(Number);
    if ((sym && !SYM_RE.test(sym)) || !(lot > 0) || [sl, tp].some((v) => v !== undefined && !Number.isFinite(v))) return tgSend(chatId, `รูปแบบ: /${cmd} [คู่เงิน] <lot> [sl] [tp]\nเช่น /${cmd} XAUUSD 0.01 หรือกด /menu`);
    const dec = await getJSON<any>(ak('decision', acct), null);
    const symbol = sym || String(dec?.symbol ?? '').toUpperCase();
    if (!symbol) return tgSend(chatId, `ยังไม่รู้ว่าบัญชีนี้เทรดคู่ไหน ระบุชื่อคู่เงิน เช่น /${cmd} XAUUSD ${lot}`);
    return ask(chatId, acct, { symbol, side: cmd.toUpperCase() as 'BUY' | 'SELL', lot, sl: sl || undefined, tp: tp || undefined });
  }
  if (cmd) return tgSend(chatId, 'ไม่รู้จักคำสั่งนี้\n\n' + HELP);

  // a settings field is waiting for a typed number
  const ed = await getJSON<{ pid: string; field: string; exp: number } | null>(`tg:edit:${chatId}`, null);
  if (ed && ed.exp > Date.now()) return cfgValue(chatId, me, ed, text);

  // plain text = ask the AI (same brain as the web chat); every message costs the account's AI tokens, so it is rate limited per account
  const wait = await gate(acct);
  if (wait) return tgSend(chatId, wait);
  tgApi('sendChatAction', { chat_id: chatId, action: 'typing' });
  const r = await answerChat(text.slice(0, 500), acct, '', 24_000);
  return tgSend(chatId, plain(r.text) || 'ไม่มีคำตอบ');
}

async function login(chatId: string, messageId: number, pw: string) {
  // the message contains a password: remove it from the chat right away (works in private chats)
  tgApi('deleteMessage', { chat_id: chatId, message_id: messageId });
  const fk = `tg:fail:${chatId}`, now = Date.now();
  const f = await getJSON<{ n: number; ts: number }>(fk, { n: 0, ts: 0 });
  if (f.n >= MAX_FAILS && now - f.ts < LOCK_MS) return tgSend(chatId, 'ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่');
  const w = pw ? await whoami(pw) : null;
  if (!w) {
    await setJSON(fk, { n: now - f.ts < LOCK_MS ? f.n + 1 : 1, ts: now });
    return tgSend(chatId, 'รหัสผ่านไม่ถูกต้อง พิมพ์ /login <รหัสผ่าน> (ข้อความที่มีรหัสผ่านจะถูกลบให้อัตโนมัติ)');
  }
  if (f.n) await setJSON(fk, { n: 0, ts: 0 });
  const links = await getJSON<Record<string, TgLink>>('tg:links', {});
  const me: TgLink = { acct: w.acct, role: w.role, name: w.name, ts: now, pwh: hashPw(pw), ...(links[chatId]?.notify ? { notify: links[chatId].notify } : {}) }; // keep this chat's notification choices across re-login
  links[chatId] = me;
  await saveLinks(links);
  await tgSend(chatId, `ล็อกอินสำเร็จ: ${w.name}${w.role === 'admin' ? ' (ผู้ดูแล)' : ''}\nจากนี้จะได้รับแจ้งเตือนออเดอร์ของบัญชีนี้ที่แชทนี้ กดปุ่มด้านล่างได้เลย`);
  return showMain(chatId, me);
}
