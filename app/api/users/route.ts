import { z } from 'zod';
import { randomBytes, randomUUID } from 'crypto';
import { hashPw, who } from '@/lib/auth';
import { ak, getJSON, getUsers, saveUsers } from '@/lib/store';
import { hasOwnKey } from '@/lib/aiconf';
import type { User } from '@/lib/types';
export const dynamic = 'force-dynamic';

// One user = one MT5 trading account = one EA key.
//  password: the user's dashboard login          eaKey: goes into that account's EA (AI_EAKey), only works on `login`
const Body = z.object({
  action: z.enum(['create', 'reset', 'resetKey', 'bind', 'delete']),
  name: z.string().trim().min(1).max(40).optional(),
  id: z.string().optional(),
  login: z.string().trim().regex(/^\d{4,12}$/, 'เลขบัญชี MT5 ต้องเป็นตัวเลข 4-12 หลัก').optional(),
});
const newPassword = () => randomBytes(12).toString('base64url');          // 16 chars, shown once
const newEAKey = () => 'ea_' + randomBytes(18).toString('base64url');     // shown once, stored only as a hash

async function pub(users: User[]) {
  return Promise.all(users.map(async (u) => {
    const seen = await getJSON<{ ts: number } | null>(ak('seen', u.id), null);
    return { id: u.id, name: u.name, login: u.login ?? '', hasKey: !!u.keyHash, aiKey: await hasOwnKey(u.id), createdAt: u.createdAt, lastSeen: u.lastSeen, eaSeen: seen?.ts };
  }));
}

export async function GET(req: Request) {
  if ((await who(req))?.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json({ users: await pub(await getUsers()) });
}

export async function POST(req: Request) {
  if ((await who(req))?.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: p.error.issues[0]?.message || 'bad body' }, { status: 400 });
  const users = await getUsers();
  const { action, name, id, login } = p.data;
  const taken = (l: string, except?: string) => users.some((x) => x.login === l && x.id !== except);

  if (action === 'create') {
    if (!name) return Response.json({ error: 'ต้องใส่ชื่อผู้ใช้' }, { status: 400 });
    if (!login) return Response.json({ error: 'ต้องใส่เลขบัญชี MT5 ของผู้ใช้' }, { status: 400 });
    if (taken(login)) return Response.json({ error: 'เลขบัญชีนี้ผูกกับผู้ใช้อื่นอยู่แล้ว' }, { status: 400 });
    if (users.length >= 50) return Response.json({ error: 'ผู้ใช้เต็ม 50 คนแล้ว' }, { status: 400 });
    const password = newPassword(), eaKey = newEAKey();
    users.push({ id: randomUUID().slice(0, 8), name, hash: hashPw(password), createdAt: Date.now(), login, keyHash: hashPw(eaKey) });
    await saveUsers(users);
    return Response.json({ name, login, password, eaKey, users: await pub(users) });
  }
  const u = users.find((x) => x.id === id);
  if (!u) return Response.json({ error: 'ไม่พบผู้ใช้' }, { status: 404 });
  if (action === 'reset') {
    const password = newPassword();
    u.hash = hashPw(password);
    await saveUsers(users);
    return Response.json({ name: u.name, password, users: await pub(users) });
  }
  if (action === 'resetKey') {
    if (!u.login) return Response.json({ error: 'ผู้ใช้นี้ยังไม่ได้ผูกเลขบัญชี MT5' }, { status: 400 });
    const eaKey = newEAKey();
    u.keyHash = hashPw(eaKey);
    await saveUsers(users);
    return Response.json({ name: u.name, login: u.login, eaKey, users: await pub(users) });
  }
  if (action === 'bind') { // set / change the MT5 account number: the old EA key stops working and a new one is issued
    if (!login) return Response.json({ error: 'ต้องใส่เลขบัญชี MT5' }, { status: 400 });
    if (taken(login, u.id)) return Response.json({ error: 'เลขบัญชีนี้ผูกกับผู้ใช้อื่นอยู่แล้ว' }, { status: 400 });
    const eaKey = newEAKey();
    u.login = login; u.keyHash = hashPw(eaKey);
    await saveUsers(users);
    return Response.json({ name: u.name, login, eaKey, users: await pub(users) });
  }
  const rest = users.filter((x) => x.id !== id);
  await saveUsers(rest);
  return Response.json({ users: await pub(rest) });
}
