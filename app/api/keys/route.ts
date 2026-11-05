import { z } from 'zod';
import { pickAcct, who } from '@/lib/auth';
import { getStoredKeys, setJSON } from '@/lib/store';
import { saveAiConf } from '@/lib/aiconf';
export const dynamic = 'force-dynamic';

const Body = z.object({ provider: z.enum(['anthropic', 'openai', 'google']), key: z.string().trim().max(300) });

// Save (or clear, with an empty string) an AI provider key. Keys are never sent back to the browser.
//  - admin on the main account: the shared/admin key (as before)
//  - a member: their OWN key, stored encrypted, used only for their own account (they pay for their own tokens)
export async function POST(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'bad body' }, { status: 400 });
  if (p.data.key && /\s/.test(p.data.key)) return Response.json({ error: 'key ห้ามมีช่องว่าง' }, { status: 400 });
  const acct = await pickAcct(req, me);
  if (acct !== 'main') { await saveAiConf(acct, { key: { provider: p.data.provider, value: p.data.key } }); return Response.json({ ok: true }); }
  if (me.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const saved = await getStoredKeys();
  if (p.data.key) saved[p.data.provider] = p.data.key; else delete saved[p.data.provider];
  await setJSON('apikeys', saved);
  return Response.json({ ok: true });
}
