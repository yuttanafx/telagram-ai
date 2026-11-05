import { z } from 'zod';
import { eaAuth } from '@/lib/auth';
import { gridFor } from '@/lib/profiles';
import { ak, every, getJSON, getSettings, setJSON } from '@/lib/store';
import { getAiConf } from '@/lib/aiconf';
import { externalRegime, regimeFor, saveSymRow, symKey } from '@/lib/regime';
import { regimeFromBars } from '@/lib/chart';
import { fetchTech, regimeFromTech } from '@/lib/tvscan';
import { evKey, newsFor, newsText, noteSymbol } from '@/lib/news';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({
  symbol: z.string(), tf: z.string(), price: z.coerce.number(), adx: z.coerce.number(), rsi: z.coerce.number(),
  atr: z.coerce.number().positive(), ema20: z.coerce.number(), ema50: z.coerce.number(),
  bars: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).max(300).optional(), // candles from the EA: [time,o,h,l,c]
});

// The grid EA calls this. The AI only names the market regime; the grid profile for that regime
// (set in the dashboard) is sent back as plain key=value lines. Throttled by the dashboard interval.
export async function POST(req: Request) {
  const a = await eaAuth(req);
  if (!a.ok) return new Response(a.msg, { status: a.status });
  const acct = a.acct;
  if (every('seen:' + acct, 120_000)) await setJSON(ak('seen', acct), { ts: Date.now() }); // "EA last seen" only needs to be minutes-accurate
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return new Response('bad body', { status: 400 });
  const ind = { ...p.data, symbol: p.data.symbol.toUpperCase() };
  const settings = await getSettings();
  const conf = await getAiConf(acct); // this account's own AI settings
  const key = ak('gridstate:' + ind.symbol, acct);

  let st = await getJSON<any>(key, null);
  await noteSymbol(ind.symbol);
  const nw = await newsFor(ind.symbol, settings);   // cheap (cached calendar) and checked on every call, so the switch happens within one EA push
    // candles are always stored (the dashboard draws the chart from them), whatever the regime source is
  const bars = p.data.bars && p.data.bars.length >= 2 ? p.data.bars : null;
  if (bars && every(`bars:${symKey(ind.symbol)}:${ind.tf}`, 120_000)) await setJSON(`bars:${symKey(ind.symbol)}:${ind.tf}`, { ts: Date.now(), bars: bars.slice(-150) });
  const useExt = settings.regimeSource === 'webhook' || settings.regimeSource === 'both';
  const ext = !useExt ? null : await externalRegime(ind.symbol, acct);   // regime sent by a TradingView alert
  const writeDecision = async (r: { regime: string; confidence: number; reason: string; provider?: any; model?: string; ts: number }) => {
    const { prof } = gridFor(settings, ind.symbol, r.regime);
    await setJSON(ak('decision', acct), {
      regime: r.regime, confidence: r.confidence, reason: r.reason, provider: r.provider ?? null, model: r.model ?? '',
      symbol: ind.symbol, tf: ind.tf, ts: r.ts, kind: 'grid', strategy_id: prof.id, strategy: prof.name,
      candidates: [prof.name], eval: null, pass: false, src: 'ea', newsGuard: r.regime === 'news' && !!nw.active,
      ind: { price: ind.price, adx: ind.adx, rsi: ind.rsi, atr: ind.atr, ema20: ind.ema20, ema50: ind.ema50 },
    });
  };
  if (nw.active) {
    const id = evKey(nw.active);
    if (st?.newsId !== id) { // news window just started: switch to the news profile now
      st = { regime: 'news', confidence: 1, reason: newsText(nw), hold: false, ts: Date.now(), newsId: id };
      await setJSON(key, st);
      await writeDecision({ ...st, model: 'news-guard' });
    }
  } else if (settings.regimeSource === 'tradingview' && await (async () => { // regime pulled from TradingView by the server (no Pine, no webhook)
    const t = await fetchTech(ind.symbol, ind.tf);
    if (!t) return false;
    const regime = regimeFromTech(t, st?.src === 'tv' ? st.regime : undefined);
    if (!st || st.src !== 'tv' || st.regime !== regime || st.newsId) {
      st = { regime, confidence: 0.9, reason: `จาก TradingView (${t.ticker}, ${ind.tf}): ADX ${t.adx.toFixed(1)}, EMA20 ${t.ema20 >= t.ema50 ? 'สูงกว่า' : 'ต่ำกว่า'} EMA50`, hold: false, ts: Date.now(), src: 'tv' };
      await setJSON(key, st);
      await writeDecision({ ...st, model: 'tradingview' });
    }
    return true;
  })()) { /* st already updated above */
  } else if (settings.regimeSource === 'chart' || settings.regimeSource === 'tradingview') { // also the fallback when TradingView cannot be reached // regime computed by fixed rules from the EA's candles: no AI call, no TradingView
    const r = bars ? regimeFromBars(bars as any, st?.src === 'chart' ? st.regime : undefined) : null;
    if (r) {
      if (!st || st.src !== 'chart' || st.regime !== r.regime || st.newsId) {
        st = { regime: r.regime, confidence: 0.9, reason: `คำนวณจากกราฟ: ADX ${r.adx.toFixed(1)}, EMA20 ${r.ema20 >= r.ema50 ? 'สูงกว่า' : 'ต่ำกว่า'} EMA50`, hold: false, ts: Date.now(), src: 'chart' };
        await setJSON(key, st);
        await writeDecision({ ...st, model: 'chart-rules' });
      }
    } else { // no (or too few) candles: keep the EA's current settings
      st = { ...(st ?? { regime: 'volatile', confidence: 0, reason: 'รอข้อมูลกราฟจาก EA (ต้องใช้ EA เวอร์ชันใหม่)', ts: Date.now() }), hold: true };
    }
  } else if (ext) { // webhook regime wins while it is still valid (no AI call)
    if (st?.extTs !== ext.ts || st?.newsId) {
      st = { regime: ext.regime, confidence: ext.confidence, reason: 'สภาพตลาดจาก TradingView webhook', hold: false, ts: ext.ts, extTs: ext.ts };
      await setJSON(key, st);
      await writeDecision({ ...st, model: 'webhook' });
    }
  } else if (settings.regimeSource === 'webhook') { // webhook only: nothing valid yet -> EA keeps its current settings, no AI cost
    st = st ?? { regime: 'volatile', confidence: 0, reason: 'รอสัญญาณสภาพตลาดจาก webhook', hold: true, ts: Date.now() };
    if (st.extTs === undefined) st = { ...st, hold: true };
  } else if (!st || st.newsId || st.ts + conf.intervalMin * 60_000 - Date.now() <= 5_000 || (st.hold && Number(st.confidence) === 0 && !!bars)) { // last: a stale failed result (hold, 0%) is re-evaluated right away when candles exist // normal AI run (also right after a news window ends)
    const d = await regimeFor(ind, conf.intervalMin, acct);
    const minConf = Number(process.env.MIN_CONFIDENCE ?? 0.6);
    // AI failed (quota / timeout / no key => confidence 0): fall back to the fixed chart rules instead of holding at VOLATILE 0%
    const fb = d.confidence === 0 && bars ? regimeFromBars(bars as any, st?.src === 'aifb' ? st.regime : undefined) : null;
    if (fb) {
      const now = Date.now(), iv = conf.intervalMin * 60_000, retry = Math.min(5 * 60_000, iv); // ask the AI again in <= 5 min
      const reason = `${d.reason} → ใช้กฎจากกราฟแทนชั่วคราว: ADX ${fb.adx.toFixed(1)}, EMA20 ${fb.ema20 >= fb.ema50 ? 'สูงกว่า' : 'ต่ำกว่า'} EMA50`;
      st = { regime: fb.regime, confidence: 0.85, reason, hold: false, ts: now - iv + retry, src: 'aifb' };
      await setJSON(key, st);
      await writeDecision({ regime: fb.regime, confidence: 0.85, reason, model: 'chart-fallback', ts: now });
    } else {
      st = { regime: d.regime, confidence: d.confidence, reason: d.reason, hold: d.confidence < minConf, ts: Date.now() };
      await setJSON(key, st);
      await writeDecision({ regime: d.regime, confidence: d.confidence, reason: d.reason, provider: (d as any).provider, model: (d as any).model, ts: st.ts });
    }
  }

  const { prof: f, scoped } = gridFor(settings, ind.symbol, st.regime);   // this pair's own profile set if it has one
  await saveSymRow(acct, { symbol: ind.symbol, tf: ind.tf, ts: Date.now(), regime: st.regime, confidence: Number(st.confidence), reason: String(st.reason ?? ''), profile: f.name + (scoped ? ' (เฉพาะคู่)' : ''), hold: !!st.hold, price: ind.price });
  const sig = [f.id, +f.buy, +f.sell, f.lot, f.lotMult, f.step, f.stepW, f.stepA, f.max, f.tpN, f.tpO, f.recMult].join('|'); // EA re-applies only when this changes
  const lines = [
    'ok=1', `hold=${st.hold ? 1 : 0}`, `regime=${st.regime}`, `conf=${Number(st.confidence).toFixed(2)}`, `profile=${f.id}`, `sig=${sig}`,
    `buy=${+f.buy}`, `sell=${+f.sell}`, `lot=${f.lot}`, `lotMult=${f.lotMult}`, `step=${f.step}`, `stepW=${f.stepW}`, `stepA=${f.stepA}`,
    `max=${f.max}`, `tpN=${f.tpN}`, `tpO=${f.tpO}`, `recMult=${f.recMult}`,
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
