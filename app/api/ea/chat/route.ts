import { eaAuth } from '@/lib/auth';
import { answerChat } from '@/lib/chatcore';
import { ak, getJSON, setJSON } from '@/lib/store';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Chat typed on the MT5 chart (the box under the AI orb). The EA posts JSON and reads plain text back:
//   request : { symbol, message, price, regime, profile, conf, pl, buys, sells }   headers: x-api-key, x-account
//   reply   : "ok=1\nreply=<answer>"
// Same brain and same account context as the web chat (answerChat), the web chat route is untouched. Short answers (the box is small)
// and a per-account rate limit, because every message costs the account's AI tokens.
const GAP_MS = 5_000;
const PER_DAY = Number(process.env.EA_CHAT_PER_DAY ?? 100);
const MAX_CHARS = 230;      // the EA box shows 8 lines of ~30 characters
const BUDGET_MS = 24_000;   // the EA waits at most ChatTimeoutMs (set it to 30000); answer before that. The function limit is 30 s
const text = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// MT5 cannot render markdown or line breaks: strip them and cut at a sentence end
function plain(t: string) {
  let s = t.replace(/```[\s\S]*?```/g, '').replace(/\*+/g, '').replace(/`+/g, '').replace(/^#{1,6}\s*/gm, '').replace(/^>\s?/gm, '').replace(/\s*\n+\s*/g, ' ').trim();
  if (s.length > MAX_CHARS) {
    const cut = s.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(' '));
    s = (end > MAX_CHARS * 0.5 ? cut.slice(0, end) : cut).trim() + ' ... (ดูต่อบนเว็บ)';
  }
  return s;
}
const num = (v: any, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-');
const str = (v: any, n = 24) => String(v ?? '').replace(/[\r\n"\\]/g, ' ').slice(0, n);

export async function POST(req: Request) {
  const a = await eaAuth(req);
  if (!a.ok) return text(a.msg, a.status);
  const b = await req.json().catch(() => null);
  const q = typeof b?.message === 'string' ? b.message.trim().slice(0, 300) : '';
  if (!q) return text('ไม่มีข้อความ', 400);

  const k = ak('eachat', a.acct), day = new Date().toISOString().slice(0, 10);
  const st = await getJSON<{ ts: number; day: string; n: number }>(k, { ts: 0, day, n: 0 });
  const n = st.day === day ? st.n : 0;
  const wait = st.ts + GAP_MS - Date.now();
  if (wait > 0) return text(`ถามถี่เกินไป รออีก ${Math.ceil(wait / 1000)} วินาที`, 429);
  if (n >= PER_DAY) return text(`ถามครบ ${PER_DAY} ข้อความต่อวันแล้ว ถามต่อบนหน้าเว็บได้ หรือรอพรุ่งนี้`, 429);
  await setJSON(k, { ts: Date.now(), day, n: n + 1 });

  // live numbers from the chart the question was typed on (fresher than what the server has stored)
  const extra = `ข้อมูลสดจากกราฟ MT5 ของผู้ถาม (ใช้ข้อมูลนี้ก่อน): symbol ${str(b?.symbol)} ราคา ${num(b?.price, 5)} สภาพตลาดที่ EA แสดง ${str(b?.regime) || 'ยังไม่มี'} ` +
    `(มั่นใจ ${num(Number(b?.conf) * 100, 0)}%) โปรไฟล์กริด ${str(b?.profile) || 'ยังไม่มี'} กำไรขาดทุนลอยตัว ${num(b?.pl)} ดอลลาร์ ไม้ Buy ${num(b?.buys, 0)} ไม้ Sell ${num(b?.sells, 0)}`;
  const ask = q + '\n(ตอบสั้นมาก 2 ประโยค รวมไม่เกิน 200 ตัวอักษร เป็นข้อความธรรมดา ไม่ใช้ตารางหรือ markdown)';
  const r = await answerChat(ask, a.acct, extra, BUDGET_MS);
  return text('ok=1\nreply=' + plain(r.text));
}
