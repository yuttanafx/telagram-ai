import { getJSON, setJSON } from './store';
import type { Cmd } from './types';

// Telegram bot integration. Everything here is a no-op until TELEGRAM_BOT_TOKEN is set, so it costs no Redis commands when unused.
export const tgEnabled = () => !!process.env.TELEGRAM_BOT_TOKEN;

// chat id -> the trading account that chat is logged into ('main' = admin account, otherwise a user id)
export type NotifyEvt = 'q' | 'ok' | 'bad' | 'reg'; // order queued / opened / failed-or-blocked / market regime changed
export type TgLink = { acct: string; role: 'admin' | 'user'; name: string; ts: number; pwh?: string; notify?: Partial<Record<NotifyEvt, boolean>> }; // notify: per chat, missing = on // pwh = hash of the password used to log in: a changed/reset password logs the chat out
export type TgLinks = Record<string, TgLink>;
export const getLinks = () => getJSON<TgLinks>('tg:links', {}, 30_000); // short cache: used on every order event
export const saveLinks = (l: TgLinks) => setJSON('tg:links', l);

export async function tgApi(method: string, body: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<any> {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return { ok: false, description: 'TELEGRAM_BOT_TOKEN not set' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return await r.json();
  } catch (e: any) {
    return { ok: false, description: String(e?.message ?? e) };
  }
}

// Plain text on purpose (no parse_mode): AI answers and order notes contain characters that break Markdown/HTML parsing.
export type BtnStyle = 'primary' | 'success' | 'danger'; // Bot API button colors: blue / green / red (clients older than Feb 2026 just show the normal button)
export type Kb = { text: string; callback_data: string; style?: BtnStyle }[][]; // inline buttons under a message (callback_data max 64 bytes)
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // for HTML-mode messages

// One place decides every button color: green = go / confirm / BUY, red = stop / cancel / SELL, blue = everything else, back links stay neutral.
function styleOf(b: { text: string; callback_data: string }): BtnStyle | undefined {
  if (process.env.TELEGRAM_BUTTON_STYLE === 'off' || b.text.startsWith('‹')) return undefined;
  const [k, a] = b.callback_data.split(':');
  if (k === 'ok' || k === 'ck' || k === 're') return 'success';
  if (k === 'no' || k === 'cn' || k === 'pa') return 'danger';
  if (k === 'o' || k === 's' || k === 'l') return a === 'SELL' ? 'danger' : 'success';
  return 'primary';
}
// html = true: the text is HTML (bold, code, blockquote ...) and every dynamic value in it must go through esc(). Default stays plain text,
// which is what AI answers and anything user-typed need.
const styled = (kb: Kb) => kb.map((r) => r.map((b) => ({ ...b, style: b.style ?? styleOf(b) })));
export async function tgSend(chatId: string | number, text: string, kb?: Kb, html = false) {
  const n = Math.max(1, Math.ceil(text.length / 4000));
  const markup = kb ? { inline_keyboard: styled(kb) } : undefined;
  for (let i = 0; i < n; i++)
    await tgApi('sendMessage', { chat_id: chatId, text: text.slice(i * 4000, (i + 1) * 4000), disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}), ...(markup && i === n - 1 ? { reply_markup: markup } : {}) });
}

// Replace a message in place (menus that change as you tap, like the settings toggles). Falls back to a new message if the old one can no longer be edited.
export async function tgEdit(chatId: string | number, messageId: number, text: string, kb?: Kb, html = false) {
  const r = await tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}), reply_markup: { inline_keyboard: kb ? styled(kb) : [] } });
  if (!r.ok && !/not modified/i.test(String(r.description ?? ''))) await tgSend(chatId, text, kb, html);
  return r;
}

// Push a message to every chat logged into this trading account. Never throws: a Telegram problem must not block order handling.
export async function notifyAcct(acct: string, text: string, html = false, evt?: NotifyEvt) {
  if (!tgEnabled()) return;
  try {
    const links = await getLinks();
    const ids = Object.entries(links).filter(([, l]) => l.acct === acct && (!evt || l.notify?.[evt] !== false)).map(([id]) => id);
    await Promise.all(ids.map((id) => tgSend(id, text, undefined, html)));
  } catch {}
}

const SRC: Record<string, string> = { webhook: 'TradingView', ai: 'AI', manual: 'ทำเอง' };
const HEAD: Record<string, string> = { pending: '📥 รับคำสั่งเข้าคิวแล้ว', done: '✅ เปิดออเดอร์สำเร็จ', failed: '❌ ออเดอร์ล้มเหลว', blocked: '⛔ ออเดอร์ถูกบล็อก', sent: '📤 ส่งให้ EA แล้ว' };
export const cmdText = (c: Cmd) =>
  `<b>${HEAD[c.status] ?? esc(c.status)}</b>\n${c.side === 'BUY' ? '🟢' : '🔴'} <b>${c.side}</b> ${esc(c.symbol)} · lot <b>${c.lot}</b>` +
  (c.sl ? ` · SL ${c.sl}` : '') + (c.tp ? ` · TP ${c.tp}` : '') +
  `\n<i>ที่มา: ${esc(SRC[c.source] ?? c.source)}</i>` +
  (c.ticket ? `\n🎫 Ticket <code>${c.ticket}</code>` : '') + (c.price ? `${c.ticket ? ' · ' : '\n'}ราคา <b>${c.price}</b>` : '') +
  (c.note ? `\n<blockquote>${esc(c.note)}</blockquote>` : '');
export const notifyCmd = (c: Cmd, acct: string) => notifyAcct(acct, cmdText(c), true, c.status === 'pending' ? 'q' : c.status === 'done' ? 'ok' : 'bad');

export const RTH: Record<string, [string, string]> = { trend_up: ['📈', 'ขาขึ้น'], trend_down: ['📉', 'ขาลง'], range: ['↔️', 'ไซด์เวย์'], volatile: ['⚡', 'ผันผวน'], news: ['📰', 'ช่วงข่าว'] };
const rth = (r: string) => RTH[r] ?? ['•', r];
export const notifyRegime = (acct: string, o: { symbol: string; tf: string; from: string; to: string; confidence: number; strategy: string; price: number }) =>
  notifyAcct(acct, `🔄 <b>สภาพตลาดเปลี่ยน</b>\n${esc(o.symbol)} ${esc(o.tf)}: ${rth(o.from).join(' ')} → <b>${rth(o.to).join(' ')}</b>\nมั่นใจ <b>${Math.round(o.confidence * 100)}%</b> · กลยุทธ์ <b>${esc(o.strategy)}</b> · ราคา <b>${o.price}</b>`, true, 'reg');
