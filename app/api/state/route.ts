import { STRATEGIES } from '@/lib/strategies';
import { pickAcct, who } from '@/lib/auth';
import { ak, every, getJSON, getMany, getSettings, getStoredKeys, getUsers, setJSON } from '@/lib/store';
import { newsView } from '@/lib/news';
import { getAiConf } from '@/lib/aiconf';
import { listSymRows, symKey } from '@/lib/regime';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { return await handle(req); } catch (e: any) {
    if (/max requests limit|max daily request limit|quota/i.test(String(e?.message))) return Response.json({ error: 'ฐานข้อมูล (Upstash Redis) ใช้คำสั่งเต็มโควตาแล้ว ผู้ดูแลต้องอัปเกรดแผนหรือรอรอบเดือนใหม่' }, { status: 503 });
    throw e;
  }
}
async function handle(req: Request) {
  const me = await who(req);
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const acct = await pickAcct(req, me);
  // a dashboard with voice alerts is listening (addCmd treats the flag as fresh for 20 s, so writing it every 10 s per instance is enough)
  if (new URL(req.url).searchParams.get('voice') === '1' && every('voice:' + acct, 10_000)) await setJSON(ak('voiceAt', acct), Date.now());
  // one MGET for everything that must be fresh; settings / keys / users come from the short in-instance cache
  const [[cmdsRaw, decision, symsRaw, symIdx], settings, saved] = await Promise.all([
    getMany<any>([ak('cmds', acct), ak('decision', acct), 'symbols', ak('symidx', acct)]), getSettings(), getStoredKeys(),
  ]);
  const cmds: any[] = cmdsRaw ?? [];
  const syms: string[] = symsRaw ?? [];
  const news = await newsView(settings, syms.length ? syms : [decision?.symbol ?? 'XAUUSD']).catch(() => null);
  const mask = (v?: string) => (v ? '••••' + v.slice(-4) : '');
  const env = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, google: process.env.GOOGLE_GENERATIVE_AI_API_KEY };
  const keys = Object.fromEntries((['anthropic', 'openai', 'google'] as const).map((p) => [p, !!(saved[p] || env[p])]));
  const keyHints = Object.fromEntries((['anthropic', 'openai', 'google'] as const).map((p) => [p, saved[p] ? mask(saved[p]) : env[p] ? 'จาก Vercel' : '']));
  const admin = me.role === 'admin';
  // AI settings of the account being viewed. A member only ever sees (a masked hint of) their OWN key, never the admin's.
  const conf = await getAiConf(acct);
  const P3 = ['anthropic', 'openai', 'google'] as const;
  const ai = conf.own
    ? { own: true, provider: conf.provider, model: conf.model, intervalMin: conf.intervalMin, keys: Object.fromEntries(P3.map((p) => [p, !!conf.keys[p]])), keyHints: Object.fromEntries(P3.map((p) => [p, mask(conf.keys[p])])) }
    : { own: false, provider: conf.provider, model: conf.model, intervalMin: conf.intervalMin, keys, keyHints };
  const symbols = await listSymRows(acct, symIdx ?? []);   // every pair this account's EA(s) have reported
  const want = new URL(req.url).searchParams.get('sym');
  const selRow = symbols.find((r) => r.key === want) ?? symbols.find((r) => decision?.symbol && r.key === symKey(decision.symbol)) ?? symbols[0] ?? null;
  const cs = selRow ? { s: selRow.key, tf: selRow.tf } : decision?.symbol && decision?.tf ? { s: symKey(decision.symbol), tf: decision.tf } : null;
  const chart = cs ? await getJSON<any>(`bars:${cs.s}:${cs.tf}`, null) : null; // candles last sent by an EA for the selected pair
  const users = await getUsers();
  const cur = acct === 'main' ? null : users.find((u) => u.id === acct);
  const account = { id: acct, name: cur ? cur.name : 'บัญชีหลัก', login: cur?.login ?? '' };
  const accounts = admin ? [{ id: 'main', name: 'บัญชีหลัก (Admin)', login: '' }, ...users.map((u) => ({ id: u.id, name: u.name, login: u.login ?? '' }))] : undefined;
  return Response.json({ ai, symbols, selSym: selRow?.key ?? null, chart, account, accounts, news, cmds: cmds.slice(0, 15), decision, settings, me, strategies: STRATEGIES.map((s) => ({ id: s.id, name: s.name, side: s.side, conds: s.conds.map((c) => c.text) })), keys: admin ? keys : {}, keyHints: admin ? keyHints : {} });
}
