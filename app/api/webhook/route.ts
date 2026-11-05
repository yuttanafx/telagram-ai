import { z } from 'zod';
import { isWebhook, resolveAcct } from '@/lib/auth';
import { addCmd, ak, getJSON } from '@/lib/store';
import { saveExternalRegime } from '@/lib/regime';
import { REGIMES } from '@/lib/strategies';
export const dynamic = 'force-dynamic';

const Body = z.object({
  symbol: z.string().min(3).max(20),
  side: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(['BUY', 'SELL'])),
  lot: z.coerce.number().positive(),
  sl: z.coerce.number().optional(),
  tp: z.coerce.number().optional(),
  account: z.union([z.string(), z.number()]).optional(), // MT5 account number (or user id) the order is for; missing = main account
});

// Market-regime message (e.g. from the TradingView script in /tradingview): {"type":"regime","symbol":"XAUUSD","regime":"trend_up"}
const ALIAS: Record<string, string> = {
  trend_up: 'trend_up', up: 'trend_up', uptrend: 'trend_up', bull: 'trend_up', bullish: 'trend_up',
  trend_down: 'trend_down', down: 'trend_down', downtrend: 'trend_down', bear: 'trend_down', bearish: 'trend_down',
  range: 'range', ranging: 'range', sideways: 'range', side: 'range',
  volatile: 'volatile', volatility: 'volatile', news: 'news',
};
const RegimeBody = z.object({
  symbol: z.string().min(3).max(20), regime: z.string().max(20),
  confidence: z.coerce.number().min(0).max(1).optional(),
  ttlMin: z.coerce.number().min(1).max(1440).optional(),   // how long the regime stays valid without a new message (default 120)
  account: z.union([z.string(), z.number()]).optional(),    // only this MT5 account; missing = every account
});

// TradingView: POST https://YOUR-APP.vercel.app/api/webhook?key=WEBHOOK_SECRET
export async function POST(req: Request) {
  if (!isWebhook(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await req.json().catch(() => null);
  if (raw && typeof raw === 'object' && (raw.type === 'regime' || (raw.regime && !raw.side))) {
    const r = RegimeBody.safeParse(raw);
    if (!r.success) return Response.json({ error: 'bad body', issues: r.error.issues }, { status: 400 });
    const regime = ALIAS[r.data.regime.trim().toLowerCase().replace(/[\s-]+/g, '_')];
    if (!regime || !(REGIMES as readonly string[]).includes(regime)) return Response.json({ error: `regime ไม่ถูกต้อง ใช้ได้: ${REGIMES.join(', ')}` }, { status: 400 });
    let acct: string | undefined;
    if (r.data.account != null && String(r.data.account).trim() !== '') {
      const a = await resolveAcct(String(r.data.account));
      if (!a) return Response.json({ error: 'ไม่พบบัญชีนี้ในระบบ' }, { status: 404 });
      acct = a;
    }
    await saveExternalRegime(r.data.symbol, { regime, confidence: r.data.confidence ?? 1, ts: Date.now(), ttl: (r.data.ttlMin ?? 120) * 60_000 }, acct);
    return Response.json({ ok: true, regime, scope: acct ? 'account' : 'all' });
  }
  const p = Body.safeParse(raw);
  if (!p.success) return Response.json({ error: 'bad body', issues: p.error.issues }, { status: 400 });
  const { account, ...order } = p.data;
  const acct = await resolveAcct(account == null ? '' : String(account));
  if (!acct) return Response.json({ error: 'ไม่พบบัญชีนี้ในระบบ' }, { status: 404 });
  const symbol = order.symbol.toUpperCase();
  const dec = await getJSON<any>(ak('decision', acct), null); // latest AI analysis, attached only if it is the same symbol and fresh
  const mkt = dec && dec.symbol === symbol && dec.ind && Date.now() - dec.ts < 30 * 60_000
    ? { regime: dec.regime, confidence: dec.confidence, strategy: dec.strategy, reason: dec.reason, tf: dec.tf, ts: dec.ts, ind: dec.ind } : undefined;
  const cmd = await addCmd({ ...order, symbol, source: 'webhook', mkt }, acct);
  return Response.json({ id: cmd.id, status: cmd.status, note: cmd.note });
}
