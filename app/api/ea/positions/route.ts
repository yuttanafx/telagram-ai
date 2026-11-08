import { z } from 'zod';
import { eaAuth } from '@/lib/auth';
import { ak, getJSON, setJSON } from '@/lib/store';
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
  days: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).max(12).optional(),   // [day yyyymmdd, closed trades, winners, net profit incl. swap + commission]
  tk: z.number().optional(),                                                                    // today's day key in the same day timezone
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
  return new Response('ok');
}
