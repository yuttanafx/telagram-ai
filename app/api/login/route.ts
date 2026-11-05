import { whoami } from '@/lib/auth';
import { getJSON, getUsers, saveUsers, setJSON } from '@/lib/store';
export const dynamic = 'force-dynamic';

// Simple brute-force guard: 8 wrong passwords per IP per 10 minutes.
export async function POST(req: Request) {
  try { return await handle(req); } catch (e: any) {
    if (/max requests limit|max daily request limit|quota/i.test(String(e?.message))) return Response.json({ error: 'ฐานข้อมูล (Upstash Redis) ใช้คำสั่งเต็มโควตาแล้ว ผู้ดูแลต้องอัปเกรดแผนหรือรอรอบเดือนใหม่' }, { status: 503 });
    throw e;
  }
}
async function handle(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const fk = 'fail:' + ip;
  const f = await getJSON<{ n: number; ts: number }>(fk, { n: 0, ts: 0 });
  const live = Date.now() - f.ts < 10 * 60_000;
  if (live && f.n >= 8) return Response.json({ error: 'ลองผิดบ่อยเกินไป รอสักครู่แล้วลองใหม่' }, { status: 429 });

  const { password } = await req.json().catch(() => ({ password: '' }));
  const w = await whoami(typeof password === 'string' ? password.trim() : '');
  if (!w) {
    await setJSON(fk, { n: live ? f.n + 1 : 1, ts: live ? f.ts : Date.now() });
    return Response.json({ error: 'รหัสผ่านไม่ถูกต้อง' }, { status: 401 });
  }
  if (w.id) { const us = await getUsers(); const u = us.find((x) => x.id === w.id); if (u) { u.lastSeen = Date.now(); await saveUsers(us); } }
  return Response.json({ role: w.role, name: w.name });
}
