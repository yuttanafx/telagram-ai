import { z } from 'zod';
import { REGIMES, STRATEGIES } from '@/lib/strategies';
import { ProfileSchema } from '@/lib/profiles';
import { who } from '@/lib/auth';
import { getSettings, setJSON } from '@/lib/store';
export const dynamic = 'force-dynamic';

const IDS = STRATEGIES.map((s) => s.id) as [string, ...string[]];
const Body = z.object({ provider: z.enum(['anthropic', 'openai', 'google']).optional(), model: z.string().max(80).optional(), paused: z.boolean().optional(), intervalMin: z.number().int().min(1).max(240).optional(), regimeSource: z.enum(['ai', 'chart', 'tradingview', 'webhook', 'both']).optional(), holdSec: z.number().int().min(0).max(60).optional(), newsOn: z.boolean().optional(), newsBefore: z.number().int().min(5).max(180).optional(), newsAfter: z.number().int().min(5).max(180).optional(), newsImpact: z.enum(['High', 'Medium']).optional(), newsUntil: z.number().int().min(0).optional(), map: z.record(z.enum(REGIMES), z.array(z.enum(IDS))).optional(), gridProfiles: z.record(z.string(), ProfileSchema).optional(), gridMap: z.record(z.enum(REGIMES), z.string()).optional(), symGrid: z.record(z.string().regex(/^[A-Z0-9]{1,6}$/), z.object({ profiles: z.record(z.string(), ProfileSchema), map: z.record(z.enum(REGIMES), z.string()) })).optional() });

export async function POST(req: Request) {
  if ((await who(req))?.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'bad body' }, { status: 400 });
  const next = { ...(await getSettings()), ...p.data };
  // every regime must point at an existing profile, and a profile's id must match its key
  for (const [k, v] of Object.entries(next.gridProfiles)) if (v.id !== k) return Response.json({ error: 'profile id mismatch' }, { status: 400 });
  for (const id of Object.values(next.gridMap)) if (!next.gridProfiles[id]) return Response.json({ error: `ไม่พบโปรไฟล์ ${id}` }, { status: 400 });
  if (Object.keys(next.symGrid ?? {}).length > 40) return Response.json({ error: 'ตั้งแยกรายคู่ได้ไม่เกิน 40 คู่' }, { status: 400 });
  for (const [sym, o] of Object.entries(next.symGrid ?? {})) {
    for (const [k, v] of Object.entries(o.profiles)) if (v.id !== k) return Response.json({ error: `โปรไฟล์ของ ${sym}: id ไม่ตรง` }, { status: 400 });
    for (const id of Object.values(o.map)) if (!o.profiles[id]) return Response.json({ error: `${sym}: ไม่พบโปรไฟล์ ${id}` }, { status: 400 });
  }
  await setJSON('settings', next);
  return Response.json(next);
}
