import { every, getJSON, setJSON } from './store';
import type { Settings } from './types';

// ---------------------------------------------------------------------------------------------
// News guard. Scheduled high-impact events (NFP, CPI, FOMC ...) come from a public economic-calendar
// feed (cached in Redis). From `newsBefore` minutes before until `newsAfter` minutes after an event that
// touches the traded currencies, NEW orders are blocked and the grid EA is switched to the "news" profile.
// The admin can also start a manual "breaking news" pause for news that has no schedule.
// ---------------------------------------------------------------------------------------------
export type NewsEvent = { title: string; cur: string; ts: number; impact: 'High' | 'Medium'; forecast?: string; previous?: string };
type Cache = { events: NewsEvent[]; fetchedAt: number; triedAt: number; error?: string };
export type NewsFeed = { events: NewsEvent[]; status: 'ok' | 'stale' | 'error'; error?: string; fetchedAt: number };
export type NewsCheck = { active: NewsEvent | null; resumeAt: number; next: NewsEvent | null; status: NewsFeed['status']; error?: string };

// Unofficial public feed (ForexFactory data). Override with NEWS_FEED_URLS (comma separated) if it ever moves.
const FEEDS = (process.env.NEWS_FEED_URLS || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://nfs.faireconomy.media/ff_calendar_nextweek.json')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FRESH = 60 * 60_000, RETRY = 5 * 60_000, MAX_AGE = 48 * 3600_000;

async function pull(url: string): Promise<NewsEvent[]> {
  const r = await fetch(url, { cache: 'no-store', headers: { 'user-agent': 'Mozilla/5.0 (compatible; SignalHub/1.0)', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j: any = await r.json();
  if (!Array.isArray(j)) throw new Error('รูปแบบข้อมูลปฏิทินไม่ตรงที่คาด');
  const out: NewsEvent[] = [];
  for (const e of j) {
    const ts = Date.parse(e?.date), impact = String(e?.impact ?? '');
    if (!isFinite(ts) || (impact !== 'High' && impact !== 'Medium')) continue;
    out.push({ title: String(e.title ?? '').slice(0, 80), cur: String(e.country ?? '').toUpperCase().slice(0, 3), ts, impact,
      forecast: e.forecast ? String(e.forecast).slice(0, 20) : undefined, previous: e.previous ? String(e.previous).slice(0, 20) : undefined });
  }
  return out;
}

export async function getNews(now = Date.now()): Promise<NewsFeed> {
  const c = await getJSON<Cache | null>('newscache', null, 30_000);
  if (c && c.events.length && now - c.fetchedAt < FRESH) return { events: c.events, status: 'ok', fetchedAt: c.fetchedAt };
  const usable = (x: Cache | null) => !!x && x.events.length > 0 && now - x.fetchedAt < MAX_AGE;
  if (c && now - c.triedAt < RETRY) return { events: usable(c) ? c.events : [], status: usable(c) ? 'stale' : 'error', error: c.error, fetchedAt: c.fetchedAt }; // failed recently: do not hammer the feed
  try {
    const res = await Promise.allSettled(FEEDS.map(pull));
    const ok = res.filter((x): x is PromiseFulfilledResult<NewsEvent[]> => x.status === 'fulfilled');
    if (!ok.length) throw (res[0] as PromiseRejectedResult).reason;
    const events = ok.flatMap((x) => x.value).filter((e) => e.ts > now - 86_400_000).sort((a, b) => a.ts - b.ts);
    if (!events.length) throw new Error('ไม่พบข่าวในปฏิทิน');
    await setJSON('newscache', { events, fetchedAt: now, triedAt: now });
    return { events, status: 'ok', fetchedAt: now };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 120);
    const base: Cache = c ?? { events: [], fetchedAt: 0, triedAt: 0 };
    await setJSON('newscache', { ...base, triedAt: now, error: msg });
    return { events: usable(base) ? base.events : [], status: usable(base) ? 'stale' : 'error', error: msg, fetchedAt: base.fetchedAt };
  }
}

// Which currencies' news can move this symbol.
const CUR = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY']);
export function currenciesOf(symbol: string): string[] {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const metal = s.match(/^(XAU|XAG|XPT|XPD)([A-Z]{3})?/);
  if (metal) return metal[2] && CUR.has(metal[2]) && metal[2] !== 'USD' ? ['USD', metal[2]] : ['USD']; // metals are priced in USD
  const fx = s.match(/^([A-Z]{3})([A-Z]{3})/);
  if (fx && CUR.has(fx[1]) && CUR.has(fx[2])) return [fx[1], fx[2]];
  return ['USD']; // indices, oil, crypto ... : US news by default
}

export const evKey = (e: NewsEvent) => `${e.cur}|${e.title}|${e.ts}`;
export const clock = (ts: number) => new Date(ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
export const newsText = (n: NewsCheck) =>
  n.active ? `ช่วงข่าวแรง ${n.active.cur === 'ALL' ? '' : n.active.cur + ' '}${n.active.title} หยุดเปิดออเดอร์ใหม่ถึง ${clock(n.resumeAt)}` : '';

export async function newsFor(symbol: string, s: Settings, now = Date.now(), feed?: NewsFeed): Promise<NewsCheck> {
  if (s.newsUntil && now < s.newsUntil) // manual "breaking news" pause: applies to every symbol, even if the calendar guard is off
    return { active: { title: 'ข่าวด่วน (สั่งหยุดเอง)', cur: 'ALL', ts: now, impact: 'High' }, resumeAt: s.newsUntil, next: null, status: 'ok' };
  if (!s.newsOn) return { active: null, resumeAt: 0, next: null, status: 'ok' };
  const f = feed ?? (await getNews(now));
  const curs = currenciesOf(symbol), before = s.newsBefore * 60_000, after = s.newsAfter * 60_000;
  const evs = f.events.filter((e) => curs.includes(e.cur) && (e.impact === 'High' || s.newsImpact === 'Medium')).sort((a, b) => a.ts - b.ts);
  const act = evs.filter((e) => now >= e.ts - before && now <= e.ts + after);
  return {
    active: act[0] ?? null, resumeAt: act.length ? Math.max(...act.map((e) => e.ts + after)) : 0,
    next: evs.find((e) => e.ts - before > now) ?? null, status: f.status, error: f.error,
  };
}

// Remember which symbols the EAs trade (for the dashboard's news card).
export async function noteSymbol(sym: string) {
  if (!every('sym:' + sym, 600_000)) return; // already noted recently by this instance
  const l = await getJSON<string[]>('symbols', []);
  if (!l.includes(sym)) await setJSON('symbols', [sym, ...l].slice(0, 8));
}

export async function newsView(s: Settings, symbols: string[]) {
  const now = Date.now(), feed = s.newsOn ? await getNews(now) : { events: [], status: 'ok' as const, fetchedAt: 0 };
  const groups = await Promise.all(symbols.map(async (symbol) => { const n = await newsFor(symbol, s, now, feed); return { symbol, active: n.active, resumeAt: n.resumeAt, next: n.next }; }));
  const curs = new Set(symbols.flatMap(currenciesOf));
  const upcoming = feed.events.filter((e) => curs.has(e.cur) && (e.impact === 'High' || s.newsImpact === 'Medium') && e.ts + s.newsAfter * 60_000 > now && e.ts < now + 24 * 3600_000).slice(0, 8);
  return { enabled: s.newsOn, before: s.newsBefore, after: s.newsAfter, impact: s.newsImpact, until: s.newsUntil, status: feed.status, error: feed.error, fetchedAt: feed.fetchedAt, groups, upcoming };
}
