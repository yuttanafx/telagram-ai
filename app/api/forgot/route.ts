import { randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { hashPw } from '@/lib/auth';
import { getJSON, getUsers, saveUsers, setJSON } from '@/lib/store';
export const dynamic = 'force-dynamic';

const Body = z.object({ login: z.string().trim().max(20), eaKey: z.string().trim().min(1).max(200) });
const same = (a?: string, b?: string) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// "Forgot password" from the login page, without being signed in and without e-mail.
// Proof of identity = the member's MT5 account number AND their personal EA key (the secret the admin issued; it is also
// typed into their EA in MT5). Both must match one member. A new random web password is issued and shown once; the old one
// stops working. The EA key and the account binding do not change. The admin password (ADMIN_KEY) cannot be reset here.
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const fk = 'rfail:' + ip; // brute-force guard: 6 wrong tries per IP per 15 minutes
  const f = await getJSON<{ n: number; ts: number }>(fk, { n: 0, ts: 0 });
  const live = Date.now() - f.ts < 15 * 60_000;
  if (live && f.n >= 6) return Response.json({ error: 'ลองผิดบ่อยเกินไป รอสักครู่แล้วลองใหม่' }, { status: 429 });

  const p = Body.safeParse(await req.json().catch(() => null));
  const login = p.success ? p.data.login.replace(/\D/g, '') : '';
  const users = await getUsers();
  const h = p.success ? hashPw(p.data.eaKey) : '';
  const u = login && p.success ? users.find((x) => x.login === login && same(x.keyHash, h)) : undefined;
  if (!u) {
    await setJSON(fk, { n: live ? f.n + 1 : 1, ts: live ? f.ts : Date.now() });
    // one generic message: do not reveal whether the account number or the key was wrong
    return Response.json({ error: 'เลขบัญชี MT5 หรือ EA key ไม่ถูกต้อง (ถ้าไม่มี EA key แล้ว ให้ติดต่อผู้ดูแลเพื่อรีเซ็ตรหัสให้)' }, { status: 400 });
  }
  const password = randomBytes(12).toString('base64url');
  u.hash = hashPw(password);
  await saveUsers(users);
  return Response.json({ password, name: u.name });
}
