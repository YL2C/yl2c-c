// 墨游 · 用量与花费
// 接口返回用量就用真实数字；不返回就按字数粗估（标“约”）。价格由用户在连接里填。

import { db } from './db.js';
import { toast } from './util.js';

export const CUR = { CNY: '¥', USD: '$' };

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把各家的用量字段统一成 { input, cached, output, est } */
export function normalizeUsage(raw, { inChars = 0, outChars = 0 } = {}) {
  // 有的中转站会返回全是 0 的用量：当成没返回，按字数粗估
  const zero = raw && !Number(raw.input_tokens || raw.prompt_tokens || 0) && !Number(raw.output_tokens || raw.completion_tokens || 0) &&
    !Number(raw.cache_read_input_tokens || 0) && !Number(raw.cache_creation_input_tokens || 0);
  if (zero && (inChars || outChars)) raw = null;
  if (raw && (raw.input_tokens != null || raw.output_tokens != null)) {
    const cacheRead = raw.cache_read_input_tokens || 0;
    const cacheWrite = raw.cache_creation_input_tokens || 0;
    return { input: (raw.input_tokens || 0) + cacheRead + cacheWrite, cached: cacheRead, output: raw.output_tokens || 0, est: false };
  }
  if (raw && (raw.prompt_tokens != null || raw.completion_tokens != null)) {
    const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
    return { input: raw.prompt_tokens || 0, cached, output: raw.completion_tokens || 0, est: false };
  }
  // 中文大约一字一个 token 上下，只作粗估
  return { input: Math.round(inChars), cached: 0, output: Math.round(outChars), est: true };
}

export function hasPrice(conn) {
  return num(conn?.priceIn) != null || num(conn?.priceOut) != null;
}

/** 价格单位：每百万 token。没填价格返回 null */
export function computeCost(u, conn) {
  if (!u || !hasPrice(conn)) return null;
  const ip = num(conn.priceIn) ?? 0;
  const op = num(conn.priceOut) ?? 0;
  const cp = num(conn.priceCache) ?? ip;
  const amount = ((Math.max(0, u.input - u.cached)) * ip + u.cached * cp + u.output * op) / 1e6;
  return { amount, currency: conn.currency || 'CNY', est: !!u.est };
}

export function fmtMoney(c) {
  if (!c) return '';
  const a = c.amount;
  const s = a === 0 ? '0' : a < 0.01 ? Number(a.toPrecision(2)).toString() : a < 1 ? a.toFixed(3) : a.toFixed(2);
  return `${c.est ? '约' : ''}${CUR[c.currency] || ''}${s}`;
}

export function fmtTokens(n) {
  n = Math.round(n || 0);
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + '千';
  return String(n);
}

export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 记一笔账，返回本月合计 { CNY, USD, input, output, count } */
export async function addSpend(cost, usage) {
  const all = (await db.kvGet('spend', null)) || {};
  const k = monthKey();
  const m = all[k] || { CNY: 0, USD: 0, input: 0, output: 0, count: 0 };
  if (cost) m[cost.currency] = (m[cost.currency] || 0) + cost.amount;
  if (usage) { m.input += usage.input || 0; m.output += usage.output || 0; }
  m.count += 1;
  all[k] = m;
  try { await db.kvSet('spend', all); } catch {}
  return m;
}

/**
 * 每次调用模型都记一笔：kind（正文/整理前情/拆角色卡/补选项/番外…）、用量、金额。
 * 进月度合计，也进“最近的调用”清单（最多 300 条），方便看 token 花在哪了。
 */
export async function recordUsage({ kind = '正文', storyId = '', model = '', usage = null, cost = null } = {}) {
  try {
    const log = (await db.kvGet('usageLog', null)) || [];
    log.push({ at: Date.now(), kind, storyId, model, input: usage?.input || 0, cached: usage?.cached || 0, output: usage?.output || 0, est: !!usage?.est, cost });
    while (log.length > 300) log.shift();
    await db.kvSet('usageLog', log);
  } catch {}
  const m = await addSpend(cost, usage).catch(() => null);
  if (m) checkBudget(m).catch(() => {});
  return m;
}
export async function getUsageLog(storyId) {
  const log = (await db.kvGet('usageLog', null)) || [];
  return storyId ? log.filter((x) => x.storyId === storyId) : log;
}

export async function getMonthSpend(k = monthKey()) {
  const all = (await db.kvGet('spend', null)) || {};
  return all[k] || { CNY: 0, USD: 0, input: 0, output: 0, count: 0 };
}

export async function getBudget() {
  return (await db.kvGet('budget', null)) || { amount: '', currency: 'CNY' };
}
export async function setBudget(b) { return db.kvSet('budget', b); }

/** 本月花费超过提醒额度时，每天提醒一次 */
export async function checkBudget(month) {
  const b = await getBudget();
  const limit = num(b.amount);
  if (limit == null || limit <= 0) return;
  const spent = month[b.currency] || 0;
  if (spent < limit) return;
  const today = new Date().toDateString();
  if ((await db.kvGet('budgetWarned', '')) === today) return;
  await db.kvSet('budgetWarned', today);
  toast(`本月已花 ${CUR[b.currency]}${spent.toFixed(2)}，超过了你设的 ${CUR[b.currency]}${limit} 提醒线`, 5000);
}
