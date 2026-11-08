import { ak, getJSON, getMany } from './store';
import { esc } from './telegram';

// Snapshots of the EA's own positions, written by /api/ea/positions and read by the Telegram status / orders screens.
export type PosSnap = {
  ts: number; symbol: string; bal?: number; eq?: number;
  pos: [number, number, number, number, number, number, number, string][];   // ticket, type, volume, open, current, profit, open time (UTC s), comment
  closed: [number, number, number, number, number, number][];                // deal, side, volume, close price, profit, close time (UTC s)
  days?: [number, number, number, number][];                                 // day key (yyyymmdd), closed trades, winners, net profit (incl. swap + commission)
  tk?: number;                                                               // today's day key as the EA sees it
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

const dayLabel = (k: number) => `${String(k % 100).padStart(2, '0')}/${String(Math.floor(k / 100) % 100).padStart(2, '0')}`;

// Daily summary of the trades this EA closed (all symbols added together), last 7 days.
export function dailyText(snaps: PosSnap[]): string {
  const m = new Map<number, [number, number, number]>();
  for (const s of snaps) for (const d of s.days ?? []) { const c = m.get(d[0]) ?? [0, 0, 0]; c[0] += d[1]; c[1] += d[2]; c[2] += d[3]; m.set(d[0], c); }
  if (!m.size) return '📅 <b>สรุปยอดรายวัน</b>\nยังไม่มีข้อมูลรายวันจาก EA (ต้องใช้ EA เวอร์ชันใหม่ และเปิด AI_ReportPos ไว้)';
  const rows = [...m.entries()].sort((a, b) => b[0] - a[0]).slice(0, 7);
  let out = '📅 <b>สรุปยอดรายวัน</b> (7 วันล่าสุด)\n', tn = 0, tw = 0, tp = 0;
  for (const [k, [n, w, p]] of rows) {
    out += `${p >= 0 ? '✅' : '❌'} ${dayLabel(k)} · ปิด ${n} ไม้ (ชนะ ${w} / แพ้ ${n - w}) · <b>${sg(p)}$</b>\n`;
    tn += n; tw += w; tp += p;
  }
  out += `\nรวม ${tn} ไม้ · ชนะ ${tn ? Math.round((tw / tn) * 100) : 0}% · <b>${sg(tp)}$</b>`;
  const last = snaps.reduce((a, b) => (b.ts > a.ts ? b : a));
  return out + `\n<i>ข้อมูลจาก EA ${ago(last.ts)} · นับเฉพาะไม้ที่ปิดแล้ว ไม่รวมกำไรลอย</i>`;
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
  const closed = snaps.flatMap((s) => s.closed.map((c) => ({ sym: s.symbol, c }))).sort((a, b) => b.c[5] - a.c[5]).slice(0, MAX_CLOSED);
  if (closed.length) {
    out += '\n🏁 <b>ปิดล่าสุด</b>\n';
    for (const { sym, c } of closed) out += `${c[4] >= 0 ? '✅' : '❌'} ${hm(c[5])} ${c[1] === 0 ? 'BUY' : 'SELL'} ${esc(sym)} ${c[2]} @${c[3]} · <b>${sg(c[4])}$</b>\n`;
  }
  return out.trimEnd();
}
