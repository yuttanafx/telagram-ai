import { randomBytes } from 'crypto';
import { z } from 'zod';
import { hashPw, who } from '@/lib/auth';
import { getUsers, saveUsers } from '@/lib/store';
export const dynamic = 'force-dynamic';

const Body = z.object({ action: z.literal('resetPassword'), current: z.string().min(1).max(200) });

// A member resets their OWN web password: type the current one to confirm, the server issues a new random one (shown once).
// The old password stops working immediately (other devices are signed out). The admin password is the ADMIN_KEY env variable,
// so it cannot be changed here. EA key and MT5 account binding are not touched.
export async function POST(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (me.role !== 'user' || !me.id) return Response.json({ error: 'ผู้ดูแลเปลี่ยนรหัสผ่านได้ที่ ADMIN_KEY ใน Vercel' }, { status: 400 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'ต้องกรอกรหัสผ่านปัจจุบัน' }, { status: 400 });
  const users = await getUsers();
  const u = users.find((x) => x.id === me.id);
  if (!u) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (hashPw(p.data.current.trim()) !== u.hash) return Response.json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' }, { status: 400 });
  const password = randomBytes(12).toString('base64url');
  u.hash = hashPw(password);
  await saveUsers(users);
  return Response.json({ password });
}
