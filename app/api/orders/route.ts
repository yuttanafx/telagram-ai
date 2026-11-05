import { z } from 'zod';
import { pickAcct, who } from '@/lib/auth';
import { addCmd, ak, getCmds, getJSON, saveCmds } from '@/lib/store';
export const dynamic = 'force-dynamic';

const Body = z.object({
  side: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(['BUY', 'SELL'])),
  lot: z.coerce.number().positive(),
  symbol: z.string().min(3).max(20).optional(),
});

// Manual first order from the dashboard (BUY / SELL button). Same queue, risk limits and news guard as every other order;
// the EA picks it up within a few seconds. No SL/TP: the grid EA manages the exit. Admin or user (own account only).
export async function POST(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const acct = await pickAcct(req, me);
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'ข้อมูลไม่ถูกต้อง (ต้องมี BUY/SELL และ lot > 0)' }, { status: 400 });
  const dec = await getJSON<any>(ak('decision', acct), null);
  const symbol = (p.data.symbol?.trim() || dec?.symbol || '').toUpperCase();
  if (!symbol) return Response.json({ error: 'ยังไม่รู้ว่าบัญชีนี้เทรดคู่ไหน ใส่ชื่อคู่เงินในช่อง Symbol หรือรอให้ EA ส่งข้อมูลมาก่อน' }, { status: 400 });
  const cmd = await addCmd({ symbol, side: p.data.side, lot: p.data.lot, source: 'manual', noHold: true }, acct);
  return Response.json({ id: cmd.id, status: cmd.status, note: cmd.note, symbol });
}

// "Clear history" button: removes finished commands (done / failed / blocked). Waiting (pending) and just-sent ones stay,
// so an order that is still on its way to the EA is never lost.
export async function DELETE(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const acct = await pickAcct(req, me);
  const cmds = await getCmds(acct);
  const keep = cmds.filter((c) => c.status === 'pending' || c.status === 'sent');
  await saveCmds(keep, acct);
  return Response.json({ removed: cmds.length - keep.length, kept: keep.length });
}
