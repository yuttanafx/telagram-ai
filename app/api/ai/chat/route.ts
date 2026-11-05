import { pickAcct, who } from '@/lib/auth';
import { answerChat } from '@/lib/chatcore';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { message } = await req.json().catch(() => ({ message: '' }));
  if (!message || typeof message !== 'string') return Response.json({ error: 'bad body' }, { status: 400 });
  const acct = await pickAcct(req, me);
  return Response.json(await answerChat(message, acct));
}
