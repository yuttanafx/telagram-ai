import { eaAuth } from '@/lib/auth';
import { getCmds, saveCmds } from '@/lib/store';
import { notifyCmd } from '@/lib/telegram';
export const dynamic = 'force-dynamic';

// EA reports back as plain text: id|status|ticket|price|note   (status = done | failed)
export async function POST(req: Request) {
  const a = await eaAuth(req);
  if (!a.ok) return new Response(a.msg, { status: a.status });
  const [id, status, ticket, price, note] = (await req.text()).trim().split('|');
  const cmds = await getCmds(a.acct);
  const c = cmds.find((x) => x.id === id);
  if (!c) return new Response('not found', { status: 404 });
  c.status = status === 'done' ? 'done' : 'failed';
  c.ticket = Number(ticket) || undefined;
  c.price = Number(price) || undefined;
  c.note = note || c.note;
  await saveCmds(cmds, a.acct);
  await notifyCmd(c, a.acct);
  return new Response('ok');
}
