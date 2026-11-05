import { z } from 'zod';
import { eaAuth, pickAcct, who } from '@/lib/auth';
import { decide } from '@/lib/ai';
import { DEFAULT_MAP, STRATEGIES, evaluate, type Strategy } from '@/lib/strategies';
import { addCmd, ak, every, getJSON, getSettings, setJSON } from '@/lib/store';
import { getAiConf } from '@/lib/aiconf';
import { regimeFor, saveSymRow } from '@/lib/regime';
import { fetchTech, regimeFromTech } from '@/lib/tvscan';
import type { Mkt } from '@/lib/types';
import { newsFor, newsText, noteSymbol } from '@/lib/news';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({
  symbol: z.string(), tf: z.string(), price: z.coerce.number(), adx: z.coerce.number(), rsi: z.coerce.number(),
  atr: z.coerce.number().positive(), ema20: z.coerce.number(), ema50: z.coerce.number(),
  execute: z.boolean().optional(), lot: z.coerce.number().optional(),
});
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

// Called by the EA (or from the dashboard for a test run).
// Flow: AI names the market regime -> strategies mapped to that regime are pulled in -> server rules check entry
//       -> risk manager -> queue for the EA.
export async function POST(req: Request) {
  // EA: its own account (per-account EA key). Admin test run: the account selected in the dashboard.
  const me = await who(req);
  const fromEA = me?.role !== 'admin';
  let acct = 'main';
  if (fromEA) {
    const a = await eaAuth(req);
    if (!a.ok) return Response.json({ error: a.msg }, { status: a.status });
    acct = a.acct;
    if (every('seen:' + acct, 120_000)) await setJSON(ak('seen', acct), { ts: Date.now() });
  } else acct = await pickAcct(req, me!);
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'bad body' }, { status: 400 });
  const ind = { ...p.data, symbol: p.data.symbol.toUpperCase() };
  const settings = await getSettings();
  const conf = await getAiConf(acct); // this account's own AI settings (interval, provider, key)

  // EA calls are throttled by the interval set in the dashboard (admin test runs are never throttled).
  if (fromEA) {
    const last = await getJSON<number>(ak('lastrun:' + ind.symbol, acct), 0);
    const wait = last + conf.intervalMin * 60_000 - Date.now();
    if (wait > 5_000) return Response.json({ skipped: true, nextInSec: Math.ceil(wait / 1000) });
    await setJSON(ak('lastrun:' + ind.symbol, acct), Date.now());
  }

  await noteSymbol(ind.symbol);
  const nw = await newsFor(ind.symbol, settings);   // strong news near this symbol -> no AI call, regime = news (no strategies mapped = no trade)
  // regime source "tradingview": the server reads ADX/EMA from TradingView (no AI call, no Pine). If TradingView is unreachable it falls back to the AI.
  let tv: { regime: any; confidence: number; reason: string; provider: null; model: string } | null = null;
  if (fromEA && !nw.active && settings.regimeSource === 'tradingview') {
    const t = await fetchTech(ind.symbol, ind.tf);
    if (t) {
      const prev = await getJSON<any>(ak('decision', acct), null);
      const regime = regimeFromTech(t, prev?.symbol === ind.symbol ? prev.regime : undefined);
      tv = { regime, confidence: 0.9, provider: null, model: 'tradingview', reason: `จาก TradingView (${t.ticker}, ${ind.tf}): ADX ${t.adx.toFixed(1)}, EMA20 ${t.ema20 >= t.ema50 ? 'สูงกว่า' : 'ต่ำกว่า'} EMA50` };
    }
  }
  const d = tv ? tv : nw.active ? { regime: 'news' as const, confidence: 1, reason: newsText(nw), provider: null as any, model: 'news-guard' } : fromEA ? await regimeFor(ind, conf.intervalMin, acct) : await decide(ind, acct);

  // Strategies for this regime (an empty list = do not trade in this regime).
  const ids = settings.map?.[d.regime] ?? DEFAULT_MAP[d.regime] ?? [];
  const cands = ids.map((id) => STRATEGIES.find((x) => x.id === id)).filter(Boolean) as Strategy[];
  const evals = cands.map((s) => ({ s, ev: evaluate(s, ind) }));
  const okCount = (e: (typeof evals)[number]) => e.ev.results.filter((r) => r.ok).length;
  const best = evals.find((e) => e.ev.passed) ?? [...evals].sort((a, b) => okCount(b) - okCount(a))[0];
  const s = best?.s;
  const ev = best?.ev ?? null;
  const pass = !!s && !!ev?.passed && d.confidence >= Number(process.env.MIN_CONFIDENCE ?? 0.6);

  const snap = { price: ind.price, adx: ind.adx, rsi: ind.rsi, atr: ind.atr, ema20: ind.ema20, ema50: ind.ema50 };
  let cmdId: string | undefined;
  if (pass && p.data.execute && s) {
    const buy = s.side === 'BUY';
    const cmd = await addCmd({
      symbol: ind.symbol, side: s.side, lot: p.data.lot ?? 0.01, source: 'ai',
      mkt: { regime: d.regime, confidence: d.confidence, strategy: s.name, reason: d.reason, tf: ind.tf, ts: Date.now(), ind: snap } as Mkt,
      sl: r5(ind.price + (buy ? -1.5 : 1.5) * ind.atr), tp: r5(ind.price + (buy ? 2.5 : -2.5) * ind.atr),
    }, acct);
    cmdId = cmd.id;
  }
  const out = {
    ...d, symbol: ind.symbol, tf: ind.tf, ts: Date.now(), strategy_id: s?.id ?? 'no_trade', strategy: s?.name ?? 'ไม่เทรด',
    candidates: cands.map((c) => c.name), eval: ev, pass, cmdId, src: fromEA ? 'ea' : 'test', ind: snap, newsGuard: !!nw.active,
  };
  await setJSON(ak('decision', acct), out);
  if (fromEA) await saveSymRow(acct, { symbol: ind.symbol, tf: ind.tf, ts: Date.now(), regime: d.regime, confidence: d.confidence, reason: d.reason, profile: out.strategy, price: ind.price });
  return Response.json(out);
}
