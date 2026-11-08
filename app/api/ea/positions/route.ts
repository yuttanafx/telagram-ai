import { z } from 'zod';
import { eaAuth } from '@/lib/auth';
import { ak, every, getCmds, getJSON, saveCmds, setJSON } from '@/lib/store';
import { symKey } from '@/lib/regime';
export const dynamic = 'force-dynamic';

// The EA sends a snapshot of ALL the positions it manages on one symbol (grid orders, dashboard BUY/SELL buttons, web orders), plus its latest closed deals.
//   pos    = [ticket, type (0 buy / 1 sell), volume, open price, current price, profit incl. swap, open time (UTC seconds), comment]
//   closed = [deal ticket, side of the position that was closed (0 buy / 1 sell), volume, close price, profit incl. swap + commission, close time (UTC seconds)]
// The Telegram "ออเดอร์" / "สถานะ" buttons read this snapshot; nothing here sends or changes an order.
const Body = z.object({
  symbol: z.string().max(32),
  bal: z.coerce.number().optional(),
  eq: z.coerce.number().optional(),
  pos: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.string().max(40)])).max(60),
  closed: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])).max(30),
  days: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).max(80).optional(),   // [day yyyymmdd, closed trades, winners, net profit incl. swap + commission]
  tk: z.number().optional(),                                                                    // today's day key in the same day timezone
  ds: z.number().optional(),                                                                    // start of today (UTC seconds) in that timezone
});

export async function POST(req: Request) {
  const a = await eaAuth(req);
  if (!a.ok) return new Response(a.msg, { status: a.status });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return new Response('bad body', { status: 400 });
  const sym = symKey(p.data.symbol);
  if (!sym) return new Response('bad symbol', { status: 400 });
  await setJSON(ak('pos:' + sym, a.acct), { ...p.data, symbol: p.data.symbol.toUpperCase(), ts: Date.now() });
  const idxKey = ak('posidx', a.acct);
  const idx = await getJSON<string[]>(idxKey, []);   // the list of symbols is only written when a new symbol shows up
  if (!idx.includes(sym)) await setJSON(idxKey, [...idx, sym].slice(0, 40));

  // Daily ledger (kept per symbol, so two EAs never overwrite each other): day -> [closed trades, winners, net profit]. It is what the weekly / monthly summaries are built from,
  // so it keeps growing after the MT5 history window has moved on. Days before the "reset" day (set with the Telegram clear button) are ignored.
  if (p.data.days?.length) {
    const lk = ak('ledger:' + sym, a.acct);
    const [led, since] = await Promise.all([getJSON<Record<string, [number, number, number]>>(lk, {}), getJSON<number>(ak('ledgerSince', a.acct), 0)]);
    let changed = false;
    for (const d of p.data.days) {
      if (d[0] < since) continue;
      const nv: [number, number, number] = [d[1], d[2], Math.round(d[3] * 100) / 100];
      const o = led[d[0]];
      if (!o || o[0] !== nv[0] || o[1] !== nv[1] || o[2] !== nv[2]) { led[d[0]] = nv; changed = true; }
    }
    const keys = Object.keys(led).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 800))) { delete led[k]; changed = true; }
    if (changed) await setJSON(lk, led);
  }

  // Once per day (when the EA's day changes): drop old finished commands. Pending / sent ones are kept.
  if (p.data.ds && every('purge:' + a.acct, 30 * 60_000)) {
    const lp = ak('lastPurge', a.acct);
    if ((await getJSON<number>(lp, 0)) !== p.data.ds) {
      const cmds = await getCmds(a.acct);
      const keep = cmds.filter((c) => c.ts >= p.data.ds! * 1000 || c.status === 'pending' || c.status === 'sent');
      if (keep.length !== cmds.length) await saveCmds(keep, a.acct);
      await setJSON(lp, p.data.ds);
    }
  }
  return new Response('ok');
}
