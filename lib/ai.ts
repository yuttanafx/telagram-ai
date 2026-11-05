import { generateObject, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { REGIMES, type Ind } from './strategies';
import type { Keys } from './store';
import { getAiConf } from './aiconf';
import type { Settings } from './types';

type P = Settings['provider'];
const ORDER: P[] = ['anthropic', 'openai', 'google'];
const DEFAULT_MODEL: Record<P, string> = {
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  google: process.env.GOOGLE_MODEL || 'gemini-3.5-flash',
};
function modelFor(p: P, id: string, k: Keys) {
  if (p === 'openai') return createOpenAI({ apiKey: k.openai })(id);
  if (p === 'google') return createGoogleGenerativeAI({ apiKey: k.google })(id);
  return createAnthropic({ apiKey: k.anthropic })(id);
}

// Tries the account's selected provider first, then its other providers that have a key. A member's account only ever
// uses that member's own keys (see aiconf.ts), so every member pays for their own tokens.
// `deadline` (epoch ms): stop trying further providers when there is no time left (the web function has a hard limit; past it the browser gets a 504).
const sig = (deadline?: number) => (deadline ? AbortSignal.timeout(Math.max(3_000, deadline - Date.now() - 500)) : undefined);
async function withFallback<T>(fn: (m: any, p: P, id: string, k: Keys) => Promise<T>, acct = 'main', deadline?: number): Promise<T & { provider: P; model: string }> {
  const s = await getAiConf(acct), keys = s.keys;
  const chain = [s.provider, ...ORDER.filter((p) => p !== s.provider)].filter((p) => !!keys[p]);
  const none = new Error(s.own ? 'ยังไม่ได้ใส่ API key ของคุณ (ใส่ได้ในการ์ด "ผู้ให้บริการ AI")' : 'ยังไม่ได้ใส่ API key ของผู้ให้บริการ AI (ใส่ได้ในหน้า Dashboard)');
  const errs: string[] = []; // keep EVERY provider's error: showing only the last one hides why the provider you selected failed
  for (const p of chain) {
    if (deadline && Date.now() > deadline - 4_000 && errs.length) break;
    const id = p === s.provider && s.model ? s.model : DEFAULT_MODEL[p];
    try { return { ...(await fn(modelFor(p, id, keys), p, id, keys)), provider: p, model: id } as any; }
    catch (e: any) { errs.push(`${p}: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`); }
  }
  if (!errs.length) throw none;
  throw new Error(errs.join(' | '));
}

const Decision = z.object({
  regime: z.enum(REGIMES),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('เหตุผลสั้น ๆ ภาษาไทย ไม่เกิน 2 ประโยค'),
});

// The AI only classifies the market regime. Which strategies run for that regime is decided by the
// mapping in the dashboard, and entry conditions are checked by the server rules.
export async function decide(ind: Ind, acct = 'main') {
  try {
    return await withFallback(async (model) => {
      const { object } = await generateObject({
        model, schema: Decision, temperature: 0,
        prompt: `จัดสภาพตลาดจากข้อมูลอินดิเคเตอร์ให้เป็นหนึ่งในนี้\n- trend_up: แนวโน้มขาขึ้นชัด (ADX สูง, EMA20 > EMA50)\n- trend_down: แนวโน้มขาลงชัด (ADX สูง, EMA20 < EMA50)\n- range: ไซด์เวย์ (ADX ต่ำ, EMA แคบ/พันกัน)\n- volatile: ผันผวนผิดปกติ ไม่มีทิศทางชัด (ATR กว้างเมื่อเทียบราคา)\n- news: สัญญาณว่าอยู่ในช่วงข่าวแรง\nถ้าไม่แน่ใจให้ลดค่า confidence\n\nข้อมูล:\n${JSON.stringify(ind)}`,
      });
      return object;
    }, acct);
  } catch (e: any) {
    return { regime: 'volatile' as const, confidence: 0, reason: `AI ใช้งานไม่ได้: ${String(e?.message ?? e).slice(0, 360)}`, provider: null as any, model: '' };
  }
}

export async function chat(message: string, context: string, acct = 'main', deadline?: number) {
  return withFallback(async (model) => {
    const { text } = await generateText({
      model, temperature: 0.3,
      system: 'คุณคือ AI Strategist ของระบบเทรด MT5 ตอบภาษาไทย สั้น 1-3 ประโยค ไม่ใช้ markdown เพราะจะถูกอ่านออกเสียง ใช้ข้อมูลระบบด้านล่างเท่านั้น ห้ามแต่งตัวเลข และห้ามรับประกันกำไร\n' + context,
      prompt: message, abortSignal: sig(deadline), maxRetries: 1,
    });
    return { text };
  }, acct, deadline);
}

// ---------------------------------------------------------------------------------------------
// Economic / macro trend analysis (chat only). Advisory text: it never touches orders, strategies,
// grid profiles or any trading setting. Live web search is used when the provider supports it.
// ---------------------------------------------------------------------------------------------
export const NEWS_RE = /ข่าว|ปฏิทินเศรษฐกิจ|\b(nfp|cpi|fomc|calendar|news)\b/i;
export const MACRO_RE = /เศรษฐกิจ|เงินเฟ้อ|ดอกเบี้ย|เฟด|ธนาคารกลาง|ถดถอย|ว่างงาน|พันธบัตร|ค่าเงิน|ดอลลาร์|ราคาทอง|ทองคำ|น้ำมัน|ข่าวเศรษฐกิจ|ปัจจัยพื้นฐาน|\b(fed|fomc|cpi|ppi|nfp|gdp|pce|macro|inflation|recession|yield|rate (cut|hike)|dxy|tariff)\b/i;

const NO_LIVE_NOTE = ' (หมายเหตุ: ครั้งนี้ไม่ได้ค้นข้อมูลสด ตัวเลขล่าสุดอาจไม่ครบ แนะนำเช็กปฏิทินเศรษฐกิจอีกครั้ง)';

function macroSystem(context: string, live: boolean, o: { tech?: boolean; news?: boolean } = {}) {
  const today = new Date().toLocaleDateString('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });
  return [
    `คุณคือนักวิเคราะห์เศรษฐกิจมหภาคของระบบเทรด MT5 วันนี้คือ ${today} ตอบภาษาไทย ไม่ใช้ markdown เพราะจะถูกอ่านออกเสียง`,
    ...(o.news ? ['ผู้ใช้ถามเรื่องข่าว: เริ่มด้วยข่าวแรงที่ใกล้ที่สุดจาก "ข่าวสำคัญที่กำลังจะมา" ในข้อมูลระบบ (ชื่อข่าว เวลา ค่าคาดการณ์เทียบค่าก่อนหน้า) บอกว่าระบบหยุดเปิดออเดอร์ใหม่ช่วงไหน แล้วอธิบายผลที่น่าจะมีต่อสินทรัพย์ที่ระบบเทรด ถ้าค้นเว็บได้ให้เสริมพาดหัวข่าวสำคัญล่าสุดที่กระทบสินทรัพย์นั้น (เช่นเหตุการณ์ภูมิรัฐศาสตร์) และบอกว่าข่าวด่วนที่ไม่มีกำหนดเวลาล่วงหน้า ระบบหยุดเทรดให้เองไม่ได้ ผู้ดูแลต้องกดปุ่มหยุดเพราะข่าวด่วน'] : []),
    ...(o.tech ? ['ผู้ใช้ขอให้วิเคราะห์ตลาด: เริ่มด้วยมุมมองเชิงเทคนิค 2 ประโยคจากค่าอินดิเคเตอร์ MT5 ในข้อมูลระบบ (ทิศทาง EMA20/EMA50, โมเมนตัม RSI, ความแรงเทรนด์ ADX, ความผันผวน ATR) แล้วต่อด้วยปัจจัยเศรษฐกิจ รวมไม่เกิน 7 ประโยค'] : []),
    'ตอบ 4-6 ประโยค เรียงตามนี้: ภาพรวมแนวโน้ม → ปัจจัยหลักที่ขับเคลื่อน (เช่น ดอกเบี้ย เงินเฟ้อ ตลาดแรงงาน ค่าเงินดอลลาร์ ราคาพลังงาน) → ผลที่น่าจะมีต่อสินทรัพย์ที่ผู้ใช้ถาม หรือสินทรัพย์ที่ระบบกำลังเทรดอยู่ → สิ่งที่ควรระวัง/ตัวเลขข่าวที่จะออก',
    live ? 'ใช้ข้อมูลล่าสุดจากการค้นหา และบอกช่วงเวลาของข้อมูลที่อ้างถึง' : 'คุณไม่มีข้อมูลเรียลไทม์ ให้พูดถึงแนวโน้มเชิงโครงสร้างและปัจจัยที่ต้องจับตา',
    'ห้ามแต่งตัวเลขหรือวันที่ ถ้าไม่แน่ใจให้บอกว่าไม่แน่ใจ ห้ามรับประกันกำไร ห้ามสั่งให้ซื้อหรือขายตรง ๆ ให้พูดเป็นมุมมองและความเสี่ยง',
    'นี่เป็นการวิเคราะห์เพื่อประกอบการตัดสินใจเท่านั้น ไม่เปลี่ยนคำสั่งหรือการตั้งค่าของระบบเทรด',
    context,
  ].join('\n');
}

// Google: call the REST API directly with the google_search tool (the installed SDK only knows the
// legacy tool name for non-"gemini-2" models, which newer Gemini versions may reject).
async function geminiSearch(key: string, id: string, system: string, message: string, deadline: number) {
  const call = async (search: boolean, ms: number, model: string) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        ...(search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(ms),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j?.error?.message ?? 'error'}`);
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((x: any) => x?.text ?? '').join('').trim();
    if (!text) throw new Error('Gemini ไม่ส่งข้อความกลับมา (อาจถูกตัวกรองความปลอดภัยบล็อก)');
    return text;
  };
  const left = () => deadline - Date.now();
  // Order of attempts (each one only if there is time left): 1) live search on the chosen model, 2) the chosen model without search,
  // 3) cheaper fallback models without search (their quota is separate). The first one that answers wins, so a 429 on the
  // search tool no longer ends in an error message.
  const fallbacks = (process.env.GOOGLE_FALLBACK_MODELS ?? 'gemini-2.5-flash-lite,gemini-2.5-flash').split(',').map((x) => x.trim()).filter((x) => x && x !== id);
  let first: any = null;
  const plan: { search: boolean; model: string }[] = [{ search: true, model: id }, { search: false, model: id }, ...fallbacks.map((m) => ({ search: false, model: m }))];
  for (const st of plan) {
    const t = left();
    if (t < 3_500) break;
    // the live search gets most of the time but leaves room for the fallbacks; the others share what is left
    const ms = st.search ? Math.max(5_000, Math.min(16_000, t - 8_000)) : Math.max(3_000, Math.min(10_000, t - 500));
    try { return { text: await call(st.search, ms, st.model), live: st.search }; }
    catch (e) { if (!first) first = e; }
  }
  throw first ?? new Error('Gemini: no time left');
}

export async function macro(message: string, context: string, o: { tech?: boolean; news?: boolean } = {}, acct = 'main', deadline = Date.now() + 24_000) {
  return withFallback(async (_m, p, id, keys) => {
    if (p === 'google') {
      const g = await geminiSearch(keys.google!, id, macroSystem(context, true, o), message, deadline);
      return g.live ? g : { text: g.text + NO_LIVE_NOTE, live: false };
    }
    if (p === 'openai') {
      const { text } = await generateText({
        model: createOpenAI({ apiKey: keys.openai }).responses(id), temperature: 0.3,
        tools: { web_search_preview: createOpenAI({ apiKey: keys.openai }).tools.webSearchPreview({}) },
        system: macroSystem(context, true, o), prompt: message, abortSignal: sig(deadline), maxRetries: 1,
      });
      return { text, live: true };
    }
    // Anthropic (installed SDK has no web-search tool): answer from the model's own knowledge and say so.
    const { text } = await generateText({ model: _m, temperature: 0.3, system: macroSystem(context, false, o), prompt: message, abortSignal: sig(deadline), maxRetries: 1 });
    return { text: text.trim() + NO_LIVE_NOTE, live: false };
  }, acct, deadline);
}

// ---------------------------------------------------------------------------------------------
// Market analysis on request ("วิเคราะห์ตลาดตอนนี้"): technical read of the latest indicator snapshot
// the EA sent from MT5. Advisory text only; it never changes orders or settings.
// ---------------------------------------------------------------------------------------------
export const MARKET_RE = /วิเคราะห์(ตลาด|กราฟ|ทอง|ราคา)|สรุปตลาด|ภาพรวมตลาด|ทิศทาง(ตลาด|ราคา)|แนวโน้ม(ตลาด|ราคา)|ตลาด(ตอนนี้|เป็น(ยังไง|อย่างไร)|ไปทางไหน|ขึ้นหรือลง)|\bmarket (analysis|outlook|summary)\b/i;

export async function analyze(message: string, context: string, acct = 'main', deadline?: number) {
  return withFallback(async (model) => {
    const { text } = await generateText({
      model, temperature: 0.3,
      system: [
        'คุณคือนักวิเคราะห์ตลาดของระบบเทรด MT5 ตอบภาษาไทย ไม่ใช้ markdown เพราะจะถูกอ่านออกเสียง',
        'วิเคราะห์เชิงเทคนิคจากค่าอินดิเคเตอร์ล่าสุดในข้อมูลระบบเท่านั้น ตอบ 4-5 ประโยค เรียงตามนี้: สรุปทิศทาง (ดู EMA20 เทียบ EMA50 และราคาเทียบ EMA) → ความแรงเทรนด์ (ADX เกิน 25 = เทรนด์ชัด ต่ำกว่า 20 = ไซด์เวย์) → โมเมนตัม (RSI เกิน 70 = ซื้อมากเกินไป ต่ำกว่า 30 = ขายมากเกินไป) → ความผันผวน (ATR เทียบราคา) พร้อมระยะ ±1.5 ATR เป็นแนวรับ/ต้านคร่าว ๆ → ข้อควรระวัง',
        'บอก symbol, ไทม์เฟรม และว่าข้อมูลเก่าเท่าไร (ageMin นาที) ถ้าเกิน 60 นาทีให้เตือนว่าข้อมูลอาจไม่ทันตลาด ถ้ายังไม่มีข้อมูลอินดิเคเตอร์ให้บอกตรง ๆ ว่ายังไม่มีข้อมูลจาก EA ถ้า dataSource เป็นตัวอย่างจากปุ่มทดสอบ ให้บอกว่าข้อมูลนี้เป็นตัวเลขตัวอย่าง ไม่ใช่ตลาดจริง และไม่วิเคราะห์ราวกับเป็นตลาดจริง',
        'ห้ามแต่งตัวเลข ห้ามรับประกันกำไร ห้ามสั่งซื้อขายตรง ๆ ให้พูดเป็นมุมมองและความเสี่ยง นี่ไม่เปลี่ยนคำสั่งหรือการตั้งค่าของระบบ',
        context,
      ].join('\n'),
      prompt: message, abortSignal: sig(deadline), maxRetries: 1,
    });
    return { text };
  }, acct, deadline);
}
