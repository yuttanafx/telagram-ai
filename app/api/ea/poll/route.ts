import { eaAuth } from '@/lib/auth';
import { getCmds, getSettings, saveCmds } from '@/lib/store';
import { symKey } from '@/lib/regime';
import { notifyCmd } from '@/lib/telegram';
export const dynamic = 'force-dynamic';

// The EA calls this every few seconds. Plain text, one command per line: id|symbol|side|lot|sl|tp
export async function GET(req: Request) {
  const a = await eaAuth(req);
  if (!a.ok) return new Response(a.msg, { status: a.status });
  if ((await getSettings()).paused) return new Response('', { headers: { 'content-type': 'text/plain' } });
  const want = new URL(req.url).searchParams.get('symbol');   // optional: a chart only takes orders for its own symbol
  const cmds = await getCmds(a.acct);
  const now = Date.now();
  const out: string[] = [];
  const expired: typeof cmds = [];
  let changed = false;
  for (const c of cmds) {
    if (c.status !== 'pending') continue;
    if (c.holdUntil && now < c.holdUntil) continue; // still being announced on the dashboard
    if (want && symKey(c.symbol) !== symKey(want)) { if (now - c.ts > 120_000) { c.status = 'failed'; c.note = 'หมดอายุ (ไม่มี EA ของคู่นี้มารับภายใน 2 นาที)'; changed = true; expired.push(c); } continue; }
    changed = true;
    if (now - c.ts > 120_000) { c.status = 'failed'; c.note = 'หมดอายุ (EA ไม่ได้รับภายใน 2 นาที) เช็กว่า EA เปิดอยู่ และ AI_Url / AI_EAKey ถูกต้อง และ AI_WebOrders = true'; expired.push(c); continue; }
    c.status = 'sent';
    out.push([c.id, c.symbol, c.side, c.lot, c.sl ?? 0, c.tp ?? 0].join('|'));
  }
  if (changed) await saveCmds(cmds, a.acct);
  for (const c of expired) await notifyCmd(c, a.acct);
  return new Response(out.join('\n'), { headers: { 'content-type': 'text/plain' } });
}
