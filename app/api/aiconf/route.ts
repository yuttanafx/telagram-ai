import { z } from 'zod';
import { pickAcct, who } from '@/lib/auth';
import { getSettings, setJSON } from '@/lib/store';
import { saveAiConf } from '@/lib/aiconf';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['anthropic', 'openai', 'google']).optional(),
  model: z.string().trim().max(80).regex(/^[A-Za-z0-9._:\/-]*$/, 'ชื่อโมเดลมีอักขระที่ไม่ถูกต้อง').optional(),
  intervalMin: z.number().int().min(1).max(240).optional(),
});

// Provider / model / "analyse every N minutes" of ONE account. A member edits their own; the admin edits the main account
// (or the account selected in the dashboard). Shared admin settings elsewhere stay in /api/settings.
export async function POST(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: p.error.issues[0]?.message || 'bad body' }, { status: 400 });
  const acct = await pickAcct(req, me);
  if (acct === 'main') {
    if (me.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
    await setJSON('settings', { ...(await getSettings()), ...p.data });
  } else await saveAiConf(acct, p.data);
  return Response.json({ ok: true });
}
