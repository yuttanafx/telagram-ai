import { getAiConf, saveAiConf } from './aiconf';
import { answerChat } from './chatcore';
import { ak, getCmds, getJSON, getSettings, saveCmds, setJSON } from './store';
import { getLedger, getPosSnaps, periodText, posSummary, posText } from './positions';
import { esc, RTH, saveLinks, tgEdit, tgSend, type Kb, type NotifyEvt, type TgLink } from './telegram';

// The button menus of the bot: main menu, trend analysis, EA settings, notifications, status, orders.
// Every screen is edited IN PLACE (one message that changes as you tap) instead of piling up new messages.
type Me = TgLink;
export const MENU_KEYS = new Set(['mn', 'st', 'od', 'dy', 'dc', 'tr', 'ta', 'tm', 'ea', 'ei', 'es', 'en', 'eh', 'pa', 're', 'nt', 'nq']);

const GAP_MS = 3_000;
const PER_DAY = Number(process.env.TELEGRAM_CHAT_PER_DAY ?? 100);
const isMember = (me: Me) => me.acct !== 'main';
const B = (text: string, callback_data: string) => ({ text, callback_data });
const ck = (on: boolean, label: string) => (on ? '✓ ' : '') + label;
const BACK = [B('‹ เมนูหลัก', 'mn')];
const SRC_NAME: Record<string, string> = { ai: 'AI', chart: 'กราฟ EA', tradingview: 'TradingView', webhook: 'webhook', both: 'webhook+AI' };
const ICON: Record<string, string> = { pending: '📥', sent: '📤', done: '✅', failed: '❌', blocked: '⛔' };
const rth = (r: string): [string, string] => RTH[r] ?? ['•', r];
const hms = () => new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
const clock = (ts: number) => new Date(ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts: number) => { const m = Math.floor((Date.now() - ts) / 60_000); return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม.ที่แล้ว`; };
export const plain = (t: string) => t.replace(/```[\s\S]*?```/g, '').replace(/\*+/g, '').replace(/`+/g, '').replace(/^#{1,6}\s*/gm, '').trim();
const put = (chatId: string, mid: number | undefined, text: string, kb?: Kb) => (mid ? tgEdit(chatId, mid, text, kb, true) : tgSend(chatId, text, kb, true));

// AI questions cost the account's own tokens: spacing + a daily cap per account. Returns a message when the question must wait.
export async function gate(acct: string): Promise<string | null> {
  const k = ak('tgchat', acct), day = new Date().toISOString().slice(0, 10);
  const st = await getJSON<{ ts: number; day: string; n: number }>(k, { ts: 0, day, n: 0 });
  const n = st.day === day ? st.n : 0;
  const wait = st.ts + GAP_MS - Date.now();
  if (wait > 0) return `ถามถี่เกินไป รออีก ${Math.ceil(wait / 1000)} วินาที`;
  if (n >= PER_DAY) return `ถามครบ ${PER_DAY} ข้อความต่อวันแล้ว ลองใหม่พรุ่งนี้`;
  await setJSON(k, { ts: Date.now(), day, n: n + 1 });
  return null;
}

export async function setPaused(me: Me, paused: boolean): Promise<string> {
  if (isMember(me)) return 'คำสั่งนี้ใช้ได้เฉพาะผู้ดูแล';
  await setJSON('settings', { ...(await getSettings()), paused });
  return paused ? '⏸ หยุดระบบแล้ว (ไม่รับ/ไม่ส่งออเดอร์ใหม่ให้ EA)' : '▶️ เปิดระบบแล้ว';
}

/* ---------- main menu ---------- */
export async function showMain(chatId: string, me: Me, mid?: number) {
  const [s, conf, seen] = await Promise.all([getSettings(), getAiConf(me.acct), getJSON<{ ts: number } | null>(ak('seen', me.acct), null)]);
  const online = !!seen && Date.now() - seen.ts < 5 * 60_000;
  return put(chatId, mid,
    `📶 <b>MT5 Signal Hub</b>\n<b>ระบบ:</b> ${s.paused ? '⏸ หยุดชั่วคราว' : 'ทำงานปกติ'} · AI วิเคราะห์ทุก ${conf.intervalMin} นาที\n<b>EA:</b> ${online ? '🟢 ออนไลน์' : '🔴 ไม่พบสัญญาณ'}${seen ? ' · ' + ago(seen.ts) : ''}`,
    [[B('📈 วิเคราะห์แนวโน้ม', 'tr'), B('⚙️ ตั้งค่า EA', 'ea')], [B('📊 สถานะ', 'st'), B('🔔 การแจ้งเตือน', 'nt')], [B('🟢 BUY', 'o:BUY'), B('🔴 SELL', 'o:SELL')], [B('📋 ออเดอร์ของ EA', 'od'), B('📅 สรุปยอด', 'dy')]]);
}

/* ---------- status / orders ---------- */
export async function showStatus(chatId: string, me: Me, mid?: number) {
  const [s, cmds, dec, snaps] = await Promise.all([getSettings(), getCmds(me.acct), getJSON<any>(ak('decision', me.acct), null), getPosSnaps(me.acct)]);
  const open = cmds.filter((c) => c.status === 'pending' || c.status === 'sent').length;
  return put(chatId, mid, `📊 <b>สถานะระบบ</b>\n${s.paused ? '⏸ หยุดชั่วคราว' : '▶️ ทำงานปกติ'}\nคิวค้าง <b>${open}</b> คำสั่ง\n${posSummary(snaps)}` + (dec
    ? `\n🤖 <b>AI ล่าสุด</b> (${clock(dec.ts)})\n${esc(dec.symbol)} · ${esc(dec.regime)} · ${esc(dec.strategy)} · มั่นใจ <b>${Math.round((dec.confidence ?? 0) * 100)}%</b>` + (dec.reason ? `\n<blockquote>${esc(dec.reason)}</blockquote>` : '')
    : '\nAI ล่าสุด: ยังไม่มี') + `\n<i>อัปเดต ${hms()}</i>`,
    [[B('📋 ออเดอร์ของ EA', 'od')], [B('🔄 รีเฟรช', 'st'), B('‹ กลับ', 'mn')]]);
}
export async function showOrders(chatId: string, me: Me, mid?: number) {
  const [cmdsAll, snaps] = await Promise.all([getCmds(me.acct), getPosSnaps(me.acct)]);
  const dsMs = Math.max(0, ...snaps.map((s) => s.ds ?? 0)) * 1000;
  const cmds = cmdsAll.filter((c) => !dsMs || c.ts >= dsMs || c.status === 'pending' || c.status === 'sent').slice(0, 5);   // only today's (older ones are cleared daily)
  return put(chatId, mid, posText(snaps) + `\n\n📋 <b>คำสั่งจากเว็บ/AI วันนี้</b>\n` + (cmds.length
    ? cmds.map((c) => `${ICON[c.status] ?? ''} ${clock(c.ts)} <b>${c.side}</b> ${esc(c.symbol)} ${c.lot}${c.ticket ? ' #' + c.ticket : ''}${c.note ? ' – ' + esc(c.note.slice(0, 60)) : ''}`).join('\n') : 'ยังไม่มีคำสั่งวันนี้') + `\n<i>อัปเดต ${hms()}</i>`,
    [[B('📅 สรุปยอด', 'dy')], [B('🔄 รีเฟรช', 'od'), B('‹ กลับ', 'mn')]]);
}
export async function showDaily(chatId: string, me: Me, mid?: number, mode?: string) {
  const m = mode === 'w' || mode === 'm' ? mode : 'd';
  const [{ led }, snaps] = await Promise.all([getLedger(me.acct), getPosSnaps(me.acct)]);
  const tab = (k: string, label: string) => B((m === k ? '• ' : '') + label, `dy:${k}`);
  return put(chatId, mid, periodText(led, m, snaps) + `\n<i>อัปเดต ${hms()}</i>`,
    [[tab('d', 'รายวัน'), tab('w', 'รายสัปดาห์'), tab('m', 'รายเดือน')], [B('📋 ออเดอร์ของ EA', 'od'), B('🗑 ล้างประวัติ', 'dc')], [B('🔄 รีเฟรช', `dy:${m}`), B('‹ กลับ', 'mn')]]);
}

// Clear history: finished web/AI commands older than today (the bot also does this by itself once a day), or the whole statistics (start counting again from today).
const BKK = 7 * 3_600_000;
export async function clearHistory(chatId: string, me: Me, mid: number, x?: string) {
  const snaps = await getPosSnaps(me.acct);
  const b = new Date(Date.now() + BKK);
  const todayStartMs = Math.max(0, ...snaps.map((s) => s.ds ?? 0)) * 1000 || Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - BKK;
  const todayKey = Math.max(0, ...snaps.map((s) => s.tk ?? 0)) || b.getUTCFullYear() * 10000 + (b.getUTCMonth() + 1) * 100 + b.getUTCDate();
  if (x === 'c') {
    const all = await getCmds(me.acct);
    const keep = all.filter((c) => c.ts >= todayStartMs || c.status === 'pending' || c.status === 'sent');
    await saveCmds(keep, me.acct);
    return put(chatId, mid, `🧹 ล้างรายการคำสั่งเก่าแล้ว <b>${all.length - keep.length}</b> รายการ\nยอดรายวัน/สัปดาห์/เดือนยังอยู่ครบ`, [[B('‹ กลับ', 'dy:d')]]);
  }
  if (x === 'z') return put(chatId, mid, '⚠️ <b>ล้างสถิติทั้งหมด?</b>\nยอดรายวัน รายสัปดาห์ และรายเดือนที่เก็บไว้จะถูกลบ แล้วเริ่มนับใหม่ตั้งแต่วันนี้\nกู้คืนไม่ได้', [[B('✅ ยืนยัน ล้างทั้งหมด', 'dc:zy'), B('❌ ยกเลิก', 'dc')]]);
  if (x === 'zy') {
    await setJSON(ak('ledgerSince', me.acct), todayKey);
    return put(chatId, mid, '♻️ ล้างสถิติแล้ว เริ่มนับใหม่ตั้งแต่วันนี้', [[B('‹ กลับ', 'dy:d')]]);
  }
  return put(chatId, mid, '🗑 <b>ล้างประวัติ</b>\n• <b>รายการคำสั่งเก่า</b> ลบคำสั่งจากเว็บ/AI ที่เก่ากว่าวันนี้ (บอทล้างให้เองทุกวันอยู่แล้ว)\n• <b>สถิติทั้งหมด</b> ลบยอดรายวัน/สัปดาห์/เดือนที่เก็บไว้ แล้วเริ่มนับใหม่ตั้งแต่วันนี้\n\nยอดรายสัปดาห์และรายเดือนจะคงอยู่ จนกว่าจะกดล้างสถิติ',
    [[B('🧹 ล้างรายการคำสั่งเก่า', 'dc:c')], [B('♻️ ล้างสถิติทั้งหมด', 'dc:z')], [B('‹ กลับ', 'dy:d')]]);
}

/* ---------- trend analysis ---------- */
export async function showTrend(chatId: string, me: Me, mid?: number) {
  const d = await getJSON<any>(ak('decision', me.acct), null);
  const back = [B('🔄 รีเฟรช', 'tr'), B('‹ กลับ', 'mn')];
  if (!d) return put(chatId, mid, `📈 <b>วิเคราะห์แนวโน้ม</b>\nยังไม่มีข้อมูล รอ EA ส่งข้อมูลรอบแรก (ตรวจว่า EA เปิดอยู่และตั้ง AI_Url / AI_EAKey ถูกต้อง)\n<i>อัปเดต ${hms()}</i>`, [back]);
  const [ic, name] = rth(d.regime), i = d.ind ?? {};
  return put(chatId, mid,
    `${ic} <b>${esc(d.symbol)} ${esc(d.tf)} — ${name}</b>\nความมั่นใจ <b>${Math.round((d.confidence ?? 0) * 100)}%</b> · <b>${esc(d.strategy)}</b>${i.price ? ` · ราคา <b>${i.price}</b>` : ''}\n` +
    (i.rsi !== undefined ? `RSI ${Number(i.rsi).toFixed(0)} · ADX ${Number(i.adx).toFixed(0)}\n` : '') +
    `อัปเดต ${d.ts ? ago(d.ts) : '-'}${d.src === 'test' ? ' (ข้อมูลทดสอบ ไม่ใช่ตลาดจริง)' : ''}` +
    (d.reason ? `\n<blockquote>${esc(String(d.reason).slice(0, 220))}</blockquote>` : '') + `\n<i>รีเฟรชล่าสุด ${hms()}</i>`,
    [[B('🤖 วิเคราะห์เทคนิคด้วย AI', 'ta')], [B('🌐 เทคนิค + เศรษฐกิจ + ข่าว', 'tm')], back]);
}
async function runAI(chatId: string, me: Me, mid: number, mode: 'ta' | 'tm') {
  const d = await getJSON<any>(ak('decision', me.acct), null);
  if (!d?.symbol) return showTrend(chatId, me, mid);
  const wait = await gate(me.acct);
  if (wait) return tgSend(chatId, wait);
  const title = mode === 'ta' ? 'วิเคราะห์เทคนิคด้วย AI' : 'เทคนิค + เศรษฐกิจ + ข่าว';
  await put(chatId, mid, `⏳ <b>กำลังวิเคราะห์...</b>\n${esc(d.symbol)} · ${title}\nใช้เวลาประมาณ 10–25 วินาที`);
  // the wording decides which analyst answers: "วิเคราะห์ตลาด" = technical read, adding economy/news words = macro analyst with the technical read first
  const q = mode === 'ta' ? `วิเคราะห์ตลาด ${d.symbol} ตอนนี้ จากข้อมูลเทคนิคล่าสุดเท่านั้น สรุปสั้นๆ ไม่เกิน 8 บรรทัด` : `วิเคราะห์ตลาด ${d.symbol} ตอนนี้ ร่วมกับเศรษฐกิจและข่าวสำคัญ สรุปสั้นๆ ไม่เกิน 10 บรรทัด`;
  const r = await answerChat(q, me.acct, '', 24_000);
  return put(chatId, mid, `${rth(d.regime)[0]} <b>${esc(d.symbol)} · ${title}</b>\n\n${esc(plain(r.text) || 'ไม่มีคำตอบ').slice(0, 3500)}`, [[B('🔄 วิเคราะห์ใหม่', mode), B('‹ กลับ', 'tr')]]);
}

/* ---------- EA settings ---------- */
export async function showEA(chatId: string, me: Me, mid?: number) {
  const [s, conf] = await Promise.all([getSettings(), getAiConf(me.acct)]);
  const admin = !isMember(me), iv = conf.intervalMin;
  const kb: Kb = [];
  if (admin) kb.push([s.paused ? B('▶️ เปิดระบบ', 're') : B('⏸ หยุดระบบ', 'pa')]);
  kb.push(([[5, '5 น.'], [15, '15 น.'], [30, '30 น.'], [60, '1 ชม.']] as [number, string][]).map(([n, l]) => B(ck(iv === n, l), `ei:${n}`)));
  if (admin) {
    kb.push((['ai', 'chart', 'tradingview'] as const).map((k) => B(ck(s.regimeSource === k, SRC_NAME[k]), `es:${k}`)));
    kb.push((['webhook', 'both'] as const).map((k) => B(ck(s.regimeSource === k, SRC_NAME[k]), `es:${k}`)));
    kb.push([B(`ข่าวแรง: ${s.newsOn ? 'เปิด (กดปิด)' : 'ปิด (กดเปิด)'}`, 'en')]);
    kb.push(([[0, 'ไม่หน่วง'], [15, 'หน่วง 15 วิ'], [30, 'หน่วง 30 วิ']] as [number, string][]).map(([n, l]) => B(ck(s.holdSec === n, l), `eh:${n}`)));
  }
  kb.push([B('🧩 โปรไฟล์กริด / จับคู่ / AI', 'cfg')], BACK);
  return put(chatId, mid,
    `⚙️ <b>ตั้งค่า EA</b>\n<b>ระบบ:</b> ${s.paused ? '⏸ หยุดชั่วคราว' : 'ทำงานปกติ'} · AI วิเคราะห์ทุก ${iv} นาที\n<b>แหล่งสภาพตลาด:</b> ${SRC_NAME[s.regimeSource] ?? s.regimeSource} · <b>หยุดก่อนข่าวแรง:</b> ${s.newsOn ? 'เปิด' : 'ปิด'}\n<b>หน่วงออเดอร์:</b> ${s.holdSec ? s.holdSec + ' วินาที' : 'ไม่หน่วง'}` +
    (admin ? '\n<i>ค่ากลาง มีผลกับทุกบัญชีที่ไม่ได้ตั้งของตัวเอง (ความถี่ AI ตั้งแยกรายบัญชี)</i>' : '\n<i>ความถี่ AI เป็นของบัญชีคุณ ส่วนแหล่งสภาพตลาด ข่าว และการหน่วงเป็นค่ากลางที่ผู้ดูแลตั้ง</i>'), kb);
}

/* ---------- notifications (per chat) ---------- */
const EVT: [NotifyEvt, string][] = [['q', 'ออเดอร์เข้าคิว'], ['ok', 'เปิดออเดอร์สำเร็จ'], ['bad', 'ล้มเหลว / ถูกบล็อก / หมดอายุ'], ['reg', 'สภาพตลาดเปลี่ยน']];
export async function showNotify(chatId: string, me: Me, mid?: number) {
  const cur = (await getJSON<Record<string, TgLink>>('tg:links', {}))[chatId]?.notify ?? {};
  return put(chatId, mid, '🔔 <b>การแจ้งเตือน</b>\nเลือกเหตุการณ์ที่จะให้บอทแจ้งในแชทนี้ (ตั้งแยกแต่ละแชท)\n<i>✓ = เปิดอยู่ กดเพื่อสลับ</i>',
    [...EVT.map(([e, l]) => [B(ck(cur[e] !== false, l), `nq:${e}`)]), BACK]);
}

/* ---------- button router ---------- */
export async function onMenuButton(chatId: string, me: Me, mid: number, [k, x]: string[]) {
  const admin = !isMember(me);
  const onlyAdmin = () => tgSend(chatId, 'คำสั่งนี้ใช้ได้เฉพาะผู้ดูแล');
  switch (k) {
    case 'mn': return showMain(chatId, me, mid);
    case 'st': return showStatus(chatId, me, mid);
    case 'od': return showOrders(chatId, me, mid);
    case 'dy': return showDaily(chatId, me, mid, x);
    case 'dc': return clearHistory(chatId, me, mid, x);
    case 'tr': return showTrend(chatId, me, mid);
    case 'ta': case 'tm': return runAI(chatId, me, mid, k);
    case 'ea': return showEA(chatId, me, mid);
    case 'ei': {
      const n = Number(x);
      if (![5, 15, 30, 60].includes(n)) return;
      if (admin) await setJSON('settings', { ...(await getSettings()), intervalMin: n }); else await saveAiConf(me.acct, { intervalMin: n });
      return showEA(chatId, me, mid);
    }
    case 'es': case 'en': case 'eh': case 'pa': case 're': {
      if (!admin) return onlyAdmin();
      const s = await getSettings();
      if (k === 'es' && ['ai', 'chart', 'tradingview', 'webhook', 'both'].includes(x)) await setJSON('settings', { ...s, regimeSource: x as any });
      else if (k === 'en') await setJSON('settings', { ...s, newsOn: !s.newsOn });
      else if (k === 'eh' && [0, 15, 30].includes(Number(x))) await setJSON('settings', { ...s, holdSec: Number(x) });
      else if (k === 'pa' || k === 're') await setJSON('settings', { ...s, paused: k === 'pa' });
      return showEA(chatId, me, mid);
    }
    case 'nt': return showNotify(chatId, me, mid);
    case 'nq': {
      if (!EVT.some(([e]) => e === x)) return;
      const links = await getJSON<Record<string, TgLink>>('tg:links', {});
      if (!links[chatId]) return;
      const cur = links[chatId].notify ?? {};
      links[chatId].notify = { ...cur, [x]: cur[x as NotifyEvt] === false };
      await saveLinks(links);
      return showNotify(chatId, me, mid);
    }
  }
}
