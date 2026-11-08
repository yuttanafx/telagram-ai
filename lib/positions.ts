import { ak, getJSON, getMany } from './store';
import { esc } from './telegram';

// Snapshots of the EA's own positions, written by /api/ea/positions and read by the Telegram status / orders screens.
export type PosSnap = {
  ts: number; symbol: string; bal?: number; eq?: number;
  pos: [number, number, number, number, number, number, number, string][];   // ticket, type, volume, open, current, profit, open time (UTC s), comment
  closed: [number, number, number, number, number, number][];                // deal, side, volume, close price, profit, close time (UTC s)
  days?: [number, number, number, number][];                                 // day key (yyyymmdd), closed trades, winners, net profit (incl. swap + commission)
  tk?: number;                                                               // today's day key as the EA sees it
  ds?: number;                                                               // start of today (UTC seconds) in the EA's day timezone
};

export async function getPosSnaps(acct: string): Promise<PosSnap[]> {
  const idx = await getJSON<string[]>(ak('posidx', acct), []);
  if (!idx.length) return [];
  const rows = await getMany<PosSnap>(idx.map((s) => ak('pos:' + s, acct)));
  return rows.filter((r): r is PosSnap => !!r).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const sg = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
const hm = (sec: number) => new Date(sec * 1000).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts: number) => { const m = Math.floor((Date.now() - ts) / 60_000); return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม.ที่แล้ว`; };
const STALE_MS = 6 * 60_000;   // the EA sends at least every few minutes while it runs
const MAX_POS = 24, MAX_CLOSED = 6;

export function posSummary(snaps: PosSnap[]): string {
  const n = snaps.reduce((s, x) => s + x.pos.length, 0);
  if (!snaps.length) return '📦 ออเดอร์เปิดของ EA: ยังไม่มีข้อมูลจาก EA\n';
  const fl = snaps.reduce((s, x) => s + x.pos.reduce((q, p) => q + p[5], 0), 0);
  const tk = Math.max(0, ...snaps.map((s) => s.tk ?? 0));
  const today = tk ? snaps.reduce((s, x) => s + (x.days ?? []).filter((d) => d[0] === tk).reduce((q, d) => q + d[3], 0), 0) : null;
  return `📦 ออเดอร์เปิดของ EA <b>${n}</b> ไม้ · ลอย <b>${sg(fl)}$</b>${today !== null ? ` · ปิดวันนี้ <b>${sg(today)}$</b>` : ''}\n`;
}

const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const dd = (k: number) => String(k % 100).padStart(2, '0');
const mm = (k: number) => String(Math.floor(k / 100) % 100).padStart(2, '0');
const dayLabel = (k: number) => `${dd(k)}/${mm(k)}`;
const keyToDate = (k: number) => new Date(Date.UTC(Math.floor(k / 10000), (Math.floor(k / 100) % 100) - 1, k % 100));
const dateToKey = (d: Date) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();

export type Led = Record<number, [number, number, number]>;   // day key -> [closed trades, winners, net profit]

// All symbols added together. Days before the reset day are left out.
export async function getLedger(acct: string): Promise<{ led: Led; since: number }> {
  const [idx, since] = await Promise.all([getJSON<string[]>(ak('posidx', acct), []), getJSON<number>(ak('ledgerSince', acct), 0)]);
  const led: Led = {};
  if (idx.length) {
    const rows = await getMany<Record<string, [number, number, number]>>(idx.map((s) => ak('ledger:' + s, acct)));
    for (const r of rows) for (const [ks, v] of Object.entries(r ?? {})) {
      const k = Number(ks);
      if (k < since) continue;
      const c = led[k] ?? [0, 0, 0];
      led[k] = [c[0] + v[0], c[1] + v[1], c[2] + v[2]];
    }
  }
  return { led, since };
}

// Summary of the trades this EA closed: by day (7), by week starting Monday (8) or by month (12). Built from the ledger, so weeks and months stay after the daily detail is gone.
export function periodText(led: Led, mode: string, snaps: PosSnap[]): string {
  const keys = Object.keys(led).map(Number);
  if (!keys.length) return '📅 <b>สรุปยอด</b>\nยังไม่มีข้อมูลสถิติ (ต้องใช้ EA เวอร์ชันใหม่ เปิด AI_ReportPos ไว้ และมีไม้ที่ปิดแล้ว)';
  const groups = new Map<number, { n: number; w: number; p: number; label: string }>();
  for (const k of keys) {
    const [n, w, p] = led[k];
    let g: number, label: string;
    if (mode === 'w') {
      const d = keyToDate(k); const off = (d.getUTCDay() + 6) % 7;            // days since Monday
      const s = new Date(d.getTime() - off * 86_400_000), e = new Date(s.getTime() + 6 * 86_400_000);
      g = dateToKey(s); label = `${dayLabel(dateToKey(s))}–${dayLabel(dateToKey(e))}`;
    } else if (mode === 'm') {
      g = Math.floor(k / 100); label = `${TH_MON[(g % 100) - 1]} ${Math.floor(g / 100)}`;
    } else { g = k; label = dayLabel(k); }
    const c = groups.get(g) ?? { n: 0, w: 0, p: 0, label };
    c.n += n; c.w += w; c.p += p; groups.set(g, c);
  }
  const lim = mode === 'm' ? 12 : mode === 'w' ? 8 : 7;
  const rows = [...groups.entries()].sort((a, b) => b[0] - a[0]).slice(0, lim);
  const title = mode === 'm' ? 'รายเดือน (12 เดือนล่าสุด)' : mode === 'w' ? 'รายสัปดาห์ (8 สัปดาห์ล่าสุด · เริ่มวันจันทร์)' : 'รายวัน (7 วันล่าสุด)';
  let out = `📅 <b>สรุปยอด${title}</b>\n`, tn = 0, tw = 0, tp = 0;
  for (const [, c] of rows) {
    out += `${c.p >= 0 ? '✅' : '❌'} ${c.label} · ปิด ${c.n} ไม้ (ชนะ ${c.w} / แพ้ ${c.n - c.w}) · <b>${sg(c.p)}$</b>\n`;
    tn += c.n; tw += c.w; tp += c.p;
  }
  out += `\nรวม ${tn} ไม้ · ชนะ ${tn ? Math.round((tw / tn) * 100) : 0}% · <b>${sg(tp)}$</b>`;
  const last = snaps.length ? snaps.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
  return out + `\n<i>${last ? `ข้อมูลจาก EA ${ago(last.ts)} · ` : ''}นับเฉพาะไม้ที่ปิดแล้ว ไม่รวมกำไรลอย</i>`;
}

// Every position the EA holds (whatever opened it) + the latest closed trades.
export function posText(snaps: PosSnap[]): string {
  if (!snaps.length) return '📦 <b>ออเดอร์ของ EA</b>\nยังไม่มีข้อมูลจาก EA (ตรวจว่า EA เปิดอยู่ และเปิด AI_ReportPos ไว้)';
  let out = '📦 <b>ออเดอร์ที่เปิดอยู่</b>\n', shown = 0, total = 0;
  const last = snaps.reduce((a, b) => (b.ts > a.ts ? b : a));
  if (last.eq !== undefined) out += `Balance ${Number(last.bal ?? 0).toFixed(2)} · Equity ${Number(last.eq).toFixed(2)}\n`;
  for (const s of snaps) {
    const fl = s.pos.reduce((q, p) => q + p[5], 0), nb = s.pos.filter((p) => p[1] === 0).length;
    const stale = s.pos.length > 0 && Date.now() - s.ts > STALE_MS;
    out += `\n<b>${esc(s.symbol)}</b> · B ${nb} / S ${s.pos.length - nb} · ลอย <b>${sg(fl)}$</b> · ${ago(s.ts)}${stale ? ' ⚠️ ข้อมูลเก่า (EA อาจหยุดส่ง)' : ''}\n`;
    if (!s.pos.length) { out += 'ไม่มีไม้ค้าง\n'; continue; }
    for (const p of s.pos) {
      total++;
      if (shown >= MAX_POS) continue;
      shown++;
      out += `${p[1] === 0 ? '🟢 BUY' : '🔴 SELL'} ${p[2]} @${p[3]} → ${p[4]} · <b>${sg(p[5])}$</b> · #${p[0]}${p[7].startsWith('Hub:') ? ' · เว็บ' : ''}\n`;
    }
  }
  if (total > shown) out += `\n…และอีก ${total - shown} ไม้\n`;
  const ds = Math.max(0, ...snaps.map((s) => s.ds ?? 0));   // the list of closed trades only shows today; yesterday's detail disappears by itself (the daily / weekly / monthly totals stay)
  const closed = snaps.flatMap((s) => s.closed.map((c) => ({ sym: s.symbol, c }))).filter((x) => !ds || x.c[5] >= ds).sort((a, b) => b.c[5] - a.c[5]).slice(0, MAX_CLOSED);
  if (!closed.length) out += '\n🏁 วันนี้ยังไม่มีไม้ที่ปิด\n';
  else {
    out += '\n🏁 <b>ปิดวันนี้ (ล่าสุด)</b>\n';
    for (const { sym, c } of closed) out += `${c[4] >= 0 ? '✅' : '❌'} ${hm(c[5])} ${c[1] === 0 ? 'BUY' : 'SELL'} ${esc(sym)} ${c[2]} @${c[3]} · <b>${sg(c[4])}$</b>\n`;
  }
  return out.trimEnd();
}
