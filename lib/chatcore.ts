import { analyze, chat, macro, MACRO_RE, MARKET_RE, NEWS_RE } from '@/lib/ai';
import { clock, newsView } from '@/lib/news';
import { ak, getCmds, getJSON, getSettings } from '@/lib/store';

export type ChatAnswer = { text: string; provider?: any; live?: any };

// The one place that answers a chat question for a trading account (same logic for the web page and the MT5 EA).
// The web function has a hard time limit (maxDuration 30 s); going past it shows a 504 in the browser. So the whole answer works to a
// deadline (CHAT_BUDGET_MS, default 25 s): providers get time-outs, and if anything still runs late the person gets a clear message instead.
const BUDGET = Number(process.env.CHAT_BUDGET_MS ?? 25_000);
export async function answerChat(message: string, acct: string, extra = '', budget = BUDGET): Promise<ChatAnswer> {
  const t0 = Date.now();
  const late: ChatAnswer = { text: 'AI ใช้เวลานานเกินไป (เกิน ' + Math.round(budget / 1000) + ' วินาที) ลองกดอีกครั้ง หรือถามให้สั้นลง ถ้าเป็นการวิเคราะห์ข่าว ครั้งหน้ามักเร็วขึ้นเพราะข้อมูลข่าวถูกเก็บไว้แล้ว' };
  return Promise.race([run(message, acct, extra, t0 + budget), new Promise<ChatAnswer>((res) => setTimeout(() => res(late), budget + 1_500))]);
}

async function run(message: string, acct: string, extra: string, deadline: number): Promise<ChatAnswer> {
  const detail = (e: any) => `\n[สาเหตุ: ${String(e?.message ?? e).slice(0, 420)}]`; // errors come from the caller's own key/provider
  // quota / overload / slow answers are temporary: say so plainly instead of showing a provider error
  const busy = (e: any) => /429|quota|rate.?limit|resource.?exhausted|timeout|timed out|aborted|overloaded|503|502|504|no time left/i.test(String(e?.message ?? e));
  const wait = 'AI ติดโควต้าหรือตอบช้าชั่วคราว ลองถามใหม่อีกครั้งใน 1 นาที (ระบบเทรดและ EA ทำงานปกติ ไม่กระทบ)';
  const [cmds, decision, settings] = await Promise.all([getCmds(acct), getJSON<any>(ak('decision', acct), null), getSettings()]);
  let newsCtx = '';
  try { // upcoming events + guard status, so every answer (market, macro, news) can take the news into account
    const syms = await getJSON<string[]>('symbols', []);
    const nv = await newsView(settings, syms.length ? syms : [decision?.symbol ?? 'XAUUSD']);
    const act = nv.groups.find((g) => g.active);
    newsCtx = `\nข่าวสำคัญที่กำลังจะมา (เวลาไทย): ${JSON.stringify(nv.upcoming.slice(0, 5).map((e) => ({ สกุลเงิน: e.cur, ข่าว: e.title, เวลา: clock(e.ts), ค่าคาดการณ์: e.forecast, ค่าก่อนหน้า: e.previous })))}` +
      `\nระบบหยุดเปิดออเดอร์ช่วงข่าว: ${act ? 'กำลังหยุดอยู่เพราะ ' + act.active!.title : nv.enabled ? 'ปกติ' : 'ปิดอยู่'} (หยุดก่อนข่าว ${nv.before} นาที หลังข่าว ${nv.after} นาที) สถานะปฏิทินข่าว: ${nv.status}`;
  } catch {}
  const ctx = (extra ? `${extra}\n` : '') + `ข้อมูลระบบ:\nระบบ${settings.paused ? 'ถูกหยุดชั่วคราว' : 'ทำงานปกติ'}\nการตัดสินใจล่าสุดของ AI: ${decision ? JSON.stringify({ symbol: decision.symbol, regime: decision.regime, strategy: decision.strategy, confidence: decision.confidence, reason: decision.reason, passRules: decision.pass, tf: decision.tf, dataSource: decision.src === 'test' ? 'ตัวอย่างจากปุ่มทดสอบ (ไม่ใช่ตลาดจริง)' : decision.src === 'ea' ? 'EA' : decision.src, ageMin: decision.ts ? Math.round((Date.now() - decision.ts) / 60_000) : null, indicators: decision.ind ?? 'ยังไม่มี' }) : 'ยังไม่มี'}\nคำสั่งล่าสุด: ${JSON.stringify(cmds.slice(0, 5).map((c) => ({ symbol: c.symbol, side: c.side, lot: c.lot, status: c.status, note: c.note })))}` + newsCtx;
  // Economic-trend questions go to the macro analyst (live search when the provider supports it).
  // Everything else is answered exactly as before.
  if (MACRO_RE.test(message) || NEWS_RE.test(message)) {
    try {
      const r = await macro(message.slice(0, 500), ctx, { tech: MARKET_RE.test(message), news: NEWS_RE.test(message) }, acct, deadline); // "analyse the market + economy" = technical read first
      return { text: r.text, provider: r.provider, live: r.live };
    } catch (e) {
      if (busy(e)) return { text: wait + detail(e) }; // keep the real provider error visible: "busy" also covers real quota / timeout problems that do not go away by waiting
      return { text: 'วิเคราะห์เศรษฐกิจไม่สำเร็จ ตรวจสอบ API key และชื่อโมเดลในหน้า Dashboard (ส่วนผู้ให้บริการ AI)' + detail(e) };
    }
  }
  if (MARKET_RE.test(message)) {
    try {
      const r = await analyze(message.slice(0, 500), ctx, acct, deadline);
      return { text: r.text, provider: r.provider };
    } catch (e) {
      if (busy(e)) return { text: wait + detail(e) }; // keep the real provider error visible: "busy" also covers real quota / timeout problems that do not go away by waiting
      return { text: 'วิเคราะห์ตลาดไม่สำเร็จ ตรวจสอบ API key และชื่อโมเดลในหน้า Dashboard (ส่วนผู้ให้บริการ AI)' + detail(e) };
    }
  }
  try {
    const r = await chat(message.slice(0, 500), ctx, acct, deadline);
    return { text: r.text, provider: r.provider };
  } catch (e) {
    if (busy(e)) return { text: wait + detail(e) }; // keep the real provider error visible: "busy" also covers real quota / timeout problems that do not go away by waiting
    return { text: 'เรียก AI ไม่สำเร็จ ตรวจสอบ API key ในหน้า Dashboard (ส่วนผู้ให้บริการ AI)' + detail(e) };
  }
}
