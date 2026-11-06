// 墨游 · 存档员：把新发生的剧情整理进前情档案
// 档案挂在某一章的回复节点上（node.checkpoint）。回退、开分支时，自动用当前这条线上最近的那份。

import { db } from './db.js';
import { streamWithRetry } from './api.js';
import { latestCheckpoint, memoryText, applyCardState, splitNames } from './prompt.js';
import { chaptersOf } from './fanwai.js';
import { normalizeUsage, computeCost, recordUsage } from './cost.js';

export const BATCH = 20;          // 一次最多整理多少章
const SUMMARY_LIMIT = 8000;       // 各段摘要超过这么多字，就把最早的一半压缩成“早期概要”

export function emptyMemory() {
  return { upTo: 0, early: '', earlyUpTo: 0, summaries: [], irreversible: [], corrections: [], items: [], threads: [], knowledge: [], offscreen: [], repeats: [], conflicts: [], unsure: [], cards: {}, runs: 0 };
}

/** 当前这条线：最近一次存档整理到第几章、后面还有哪些章没整理 */
export function pendingChapters(path) {
  const cp = latestCheckpoint(path);
  const all = chaptersOf(path);
  let upTo = 0;
  if (cp) {
    const hit = all.find((c) => c.id === cp.node.id);
    upTo = hit ? hit.no : (cp.mem.upTo || 0);
  }
  return { cp, upTo, all, pending: all.filter((c) => c.no > upTo) };
}

function arr(v) { return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).map((x) => x.trim()).filter(Boolean) : []; }
function dedupeAppend(a, b) {
  const seen = new Set(a.map((x) => x.trim()));
  return [...a, ...b.filter((x) => !seen.has(x.trim()))];
}

function parseJson(raw) {
  const t = String(raw || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('没有找到 JSON');
  return JSON.parse(t.slice(a, b + 1));
}

function chapterBlock(c) {
  return `【第${c.no}章${c.title ? ' · ' + c.title : ''}】\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`;
}

function archivistPrompt(story, prev, batch) {
  const cards = (story.cards || []).filter((c) => c.name?.trim()).map((c) => {
    const s = applyCardState(c, prev);
    return [`· ${c.name}${c.aliases?.trim() ? '（' + c.aliases.trim() + '）' : ''}`,
      c.initial?.trim() ? '  初始设定：' + c.initial.trim().slice(0, 300) : '',
      s.now?.trim() ? '  当前状态：' + s.now.trim() : '',
      s.arc?.trim() ? '  变化轨迹：' + s.arc.trim() : '',
      s.relation?.trim() ? '  关系档案：' + s.relation.trim() : ''].filter(Boolean).join('\n');
  }).join('\n');
  const from = batch[0].no;
  const to = batch[batch.length - 1].no;
  const prevText = prev.upTo ? memoryText(prev) + (prev.unsure?.length ? '\n〔待确认〕\n' + prev.unsure.map((x) => '- ' + x).join('\n') : '') : '（还没有，这是第一次整理）';
  return {
    system: '你是这部文字互动小说的存档员。把新发生的剧情整理进前情档案：只记正文里确实发生的事，不脑补、不美化、不写感想；拿不准的放进“unsure”。只输出一个 JSON 对象，不要任何说明，也不要代码块标记。',
    user: [
      story.world?.trim() ? '【世界设定】\n' + story.world.trim().slice(0, 4000) : '',
      cards ? '【角色卡（初始设定、原话、禁止清单这些不归你改；你只负责“当前状态”“变化轨迹”“关系档案”）】\n' + cards : '【角色卡】\n（还没有任何角色卡）',
      '【已有的前情档案】\n' + prevText,
      `【新的剧情：第${from}–${to}章】\n` + batch.map(chapterBlock).join('\n\n'),
      '【请输出这个 JSON】\n' + JSON.stringify({
        summary: `第${from}–${to}章的剧情摘要，300到600字。按时间顺序写具体发生了什么：谁做了什么、说了哪句关键的话、局面怎么变了。不写评价`,
        irreversible: ['这一段新增的不可逆的事：受伤、失去、承诺、人情、关系越线、身份暴露……一条一件；没有就空数组'],
        items: ['新增或变化的物品、信物、特殊标记：谁给了谁什么、现在在谁手里'],
        threads: ['更新后的完整列表：所有仍然悬而未决的事、未兑现的承诺、情感负债、修罗场暗线；已经解决的删掉'],
        knowledge: ['更新后的完整列表：重要的信息差，写成“某事：谁知道／谁不知道（从什么渠道知道）”，尤其写清主角自己知道什么'],
        offscreen: ['更新后的完整列表：主角看不见的地方，各角色接下来想做什么、正在做什么（只写正文里有迹可循的）'],
        repeats: ['最近这一段里反复出现、开始变成套路的互动或写法，接下来该避开的；没有就空数组'],
        newCharacters: [{
          name: '这一段新登场、之后还会反复出现的重要角色（尤其是和主角有感情线、或者有明确目的还会再找上门的），而且【角色卡】里还没有；路人、一次性角色不要写；没有就空数组',
          aliases: '别名、别人对他的称呼，用顿号分开',
          core: '是不是主要角色：true 或 false',
          initial: '身份、外貌、怎么登场的、和主角的关系、对主角的初始态度',
          base: '从正文看出来的性格底色：遇事怎么反应、怎么说话',
          voice: '正文里他说过的有代表性的原话，原样摘，一行一句',
          forbid: '从正文看他明显不会做的事，一行一条；看不出来就空字符串',
          now: '现在走到哪一步、对主角的立场、彼此怎么称呼',
          relation: '和主角的关系：相处梗、称呼、约定',
        }],
        cards: { 角色名: { now: '现在走到哪一步、对主角的立场、彼此怎么称呼（整段重写成最新的）', arcAdd: '这一段里让他发生变化的节点：第几章、发生了什么、哪里变了哪里没变；没有就空字符串', relation: '和主角的关系档案：相处梗、称呼史、生效的约定、亲密档案。在旧的基础上合并更新，不要丢掉旧内容' } },
        conflicts: ['新剧情和已有设定或档案矛盾的地方（不要自己改，列出来给玩家裁决）'],
        unsure: ['拿不准的地方'],
      }, null, 1),
      'cards 里只写这一段出场或有变化、而且已经有角色卡的角色，键用角色卡上的名字；还没有卡的重要新角色写进 newCharacters。',
    ].filter(Boolean).join('\n\n'),
  };
}

function merge(prev, j, from, to, story) {
  const m = { ...emptyMemory(), ...prev };
  m.upTo = to;
  m.summaries = [...(prev.summaries || []), { from, to, text: String(j.summary || '').trim() || '（这一段没有整理出摘要）' }];
  m.irreversible = dedupeAppend(prev.irreversible || [], arr(j.irreversible));
  m.items = dedupeAppend(prev.items || [], arr(j.items));
  if (Array.isArray(j.threads)) m.threads = arr(j.threads);
  if (Array.isArray(j.knowledge)) m.knowledge = arr(j.knowledge);
  if (Array.isArray(j.offscreen)) m.offscreen = arr(j.offscreen);
  if (Array.isArray(j.repeats)) m.repeats = arr(j.repeats);
  m.conflicts = dedupeAppend(prev.conflicts || [], arr(j.conflicts).map((x) => `（第${from}–${to}章）${x}`));
  m.unsure = dedupeAppend(prev.unsure || [], arr(j.unsure).map((x) => `（第${from}–${to}章）${x}`));
  m.cards = { ...(prev.cards || {}) };
  const names = new Set((story.cards || []).map((c) => c.name));
  if (j.cards && typeof j.cards === 'object') {
    for (const [name, v] of Object.entries(j.cards)) {
      if (!v || typeof v !== 'object' || !names.has(name)) continue;
      const card = (story.cards || []).find((c) => c.name === name);
      const old = applyCardState(card, prev);
      const arcAdd = String(v.arcAdd || '').trim();
      m.cards[name] = {
        now: String(v.now || '').trim() || old.now || '',
        arc: [old.arc?.trim(), arcAdd].filter(Boolean).join('\n'),
        relation: String(v.relation || '').trim() || old.relation || '',
      };
    }
  }
  m.runs = (prev.runs || 0) + 1;
  m.at = Date.now();
  return m;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const txt = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).trim();

/** 存档员发现的新角色：自动建卡（不常驻、标“AI 新加”），存进故事，并通知打开着的页面 */
async function addNewCharacters(story, j, from, to) {
  const list = Array.isArray(j.newCharacters) ? j.newCharacters : [];
  if (!list.length) return [];
  let base = null;
  try { base = await db.get('stories', story.id); } catch {}
  base = base || story;
  base.cards = base.cards || [];
  const known = new Set();
  for (const c of base.cards) splitNames(c).forEach((a) => known.add(a));
  const added = [];
  for (const x of list) {
    const name = String(x?.name || '').trim();
    if (!name || name.length > 20 || known.has(name)) continue;
    const aliases = txt(x.aliases);
    if (splitNames({ name, aliases }).some((a) => known.has(a))) continue;
    const card = {
      id: newId(), name, aliases, core: x.core === true || x.core === 'true',
      initial: txt(x.initial), base: txt(x.base), voice: txt(x.voice), forbid: txt(x.forbid),
      arc: `第${from}–${to}章登场`, now: txt(x.now), relation: txt(x.relation),
      auto: { from, to, at: Date.now() },
    };
    base.cards.push(card);
    splitNames(card).forEach((a) => known.add(a));
    added.push(card);
  }
  if (!added.length) return [];
  base.updatedAt = Date.now();
  await db.put('stories', base);
  story.cards = base.cards;
  try { window.dispatchEvent(new CustomEvent('moyu:cards', { detail: { storyId: story.id, cards: base.cards, added: added.map((c) => c.name) } })); } catch {}
  return added;
}

async function compressIfLong(m, conn, signal, track) {
  const total = (m.summaries || []).reduce((a, x) => a + x.text.length, 0);
  if (total <= SUMMARY_LIMIT || m.summaries.length < 3) return m;
  const half = Math.ceil(m.summaries.length / 2);
  const old = m.summaries.slice(0, half);
  const user = (m.early?.trim() ? `【已有的早期概要（第1–${m.earlyUpTo}章）】\n${m.early.trim()}\n\n` : '') +
    '【要并进去的摘要】\n' + old.map((x) => `第${x.from}–${x.to}章：${x.text}`).join('\n') +
    `\n\n把上面的内容合并压缩成一段“早期概要”（第1–${old[old.length - 1].to}章），1200到1800字：保留关键事件、关系变化、伏笔和人物的重要选择，按时间顺序，不写评价。只输出概要正文。`;
  const r = await streamWithRetry(conn, { system: '你是这部文字互动小说的存档员，只输出概要正文。', messages: [{ role: 'user', content: user }], maxTokens: 4000, signal });
  track(r, user.length, '压缩前情');
  return { ...m, early: r.text.trim(), earlyUpTo: old[old.length - 1].to, summaries: m.summaries.slice(half) };
}

/**
 * 整理当前这条线上还没整理的章节。
 * nodes：Map；path：当前这条线；返回 { written: [节点], cost, from, to }
 * onProgress(text) 报进度
 */
// 同一个故事同时只跑一个整理（游玩页后台整理时打开记忆页，不会重复跑）
const active = new Map();
export function archivingNow(storyId) { return active.get(storyId) || null; }

export async function runArchivist(story, nodes, path, conn, opts = {}) {
  if (active.has(story.id)) { const e = new Error('这个故事正在整理前情，等它完成再试'); e.kind = 'busy'; throw e; }
  const info = { text: '正在整理前情', ctrl: opts.ctrl || null };
  active.set(story.id, info);
  const onProgress = opts.onProgress || (() => {});
  try {
    return await runInner(story, nodes, path, conn, { ...opts, onProgress: (t) => { info.text = t; onProgress(t); } });
  } finally {
    active.delete(story.id);
  }
}

async function runInner(story, nodes, path, conn, { signal, onProgress = () => {}, minChapters = 1 } = {}) {
  const { cp, upTo, pending } = pendingChapters(path);
  if (pending.length < minChapters) return { written: [], from: 0, to: 0 };
  let prev = cp ? cp.mem : emptyMemory();
  const written = [];
  const newCards = [];
  let costSum = null;
  const track = (r, inChars, kind = '整理前情') => {
    const u = normalizeUsage(r.usage, { inChars, outChars: r.text.length });
    const c = computeCost(u, conn);
    if (c) costSum = costSum && costSum.currency === c.currency ? { ...c, amount: costSum.amount + c.amount, est: costSum.est || c.est } : c;
    recordUsage({ kind, storyId: story.id, model: conn?.model || '', usage: u, cost: c });
  };
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const from = batch[0].no;
    const to = batch[batch.length - 1].no;
    onProgress(`正在整理第 ${from}–${to} 章`);
    const p = archivistPrompt(story, prev, batch);
    let r;
    let raw = '';
    r = await streamWithRetry(conn, {
      system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 8000, signal,
      onText: (_d, full) => { raw = full; onProgress(`正在整理第 ${from}–${to} 章（已写 ${full.length} 字）`); },
    });
    raw = r.text;
    track(r, p.system.length + p.user.length);
    let j;
    try { j = parseJson(raw); } catch {
      const e = new Error('存档员返回的格式看不懂，可以重试或换个模型');
      e.detail = raw.slice(0, 1500);
      throw e;
    }
    newCards.push(...(await addNewCharacters(story, j, from, to)).map((c) => c.name));
    let m = merge(prev, j, from, to, story);
    m = await compressIfLong(m, conn, signal, track);
    m.lastRun = { at: Date.now(), from, to, model: conn?.model || '', cost: costSum };
    const node = nodes.get(batch[batch.length - 1].id);
    if (!node) break;
    node.checkpoint = m;
    await db.put('nodes', node);
    // 通知当前打开的页面：它手里的同一节点对象要补上这份档案，免得之后保存时把档案覆盖掉
    try { window.dispatchEvent(new CustomEvent('moyu:checkpoint', { detail: { storyId: story.id, nodeId: node.id, mem: m } })); } catch {}
    written.push(node);
    prev = m;
  }
  return { written, from: pending[0].no, to: prev.upTo || 0, cost: costSum, prevUpTo: upTo, newCards };
}
