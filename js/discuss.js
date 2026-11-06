// yl2c · 讨论：读某个故事（或全局）的设定和记忆来聊天，聊完整理成修改清单，确认后写回

import { db } from './db.js';
import { uid } from './util.js';
import { getGlobalMemo, setGlobalMemo, getDefaultRules, getModules } from './state.js';
import { cardText, applyCardState, latestCheckpoint, memoryText } from './prompt.js';
import { chaptersOf } from './fanwai.js';

// ───── 存储：讨论列表 + 每个讨论单独一条 ─────
export async function listDiscussions() {
  const list = (await db.kvGet('disc.index', null)) || [];
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function getDiscussion(id) { return db.kvGet('disc.' + id, null); }
export async function saveDiscussion(d) {
  d.updatedAt = Date.now();
  await db.kvSet('disc.' + d.id, d);
  const list = (await db.kvGet('disc.index', null)) || [];
  const meta = { id: d.id, title: d.title, storyId: d.storyId || '', updatedAt: d.updatedAt, count: d.messages.length };
  const i = list.findIndex((x) => x.id === d.id);
  if (i >= 0) list[i] = meta; else list.push(meta);
  await db.kvSet('disc.index', list);
}
export async function deleteDiscussion(id) {
  await db.del('kv', 'disc.' + id);
  const list = ((await db.kvGet('disc.index', null)) || []).filter((x) => x.id !== id);
  await db.kvSet('disc.index', list);
}
export function newDiscussion(storyId, title) {
  return { id: uid(), storyId: storyId || '', title, messages: [], chapters: 0, connId: null, createdAt: Date.now(), updatedAt: Date.now() };
}

// ───── 读故事：当前这条线 ─────
export async function loadStoryState(storyId) {
  const story = await db.get('stories', storyId);
  if (!story) return null;
  const nodes = new Map((await db.byStory(storyId)).map((n) => [n.id, n]));
  const path = [];
  let cur = story.headId ? nodes.get(story.headId) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
  return { story, nodes, path, cp: latestCheckpoint(path) };
}

// ───── 发给模型的资料 ─────
const ROLE = `你是用户的写作搭档。用户在玩一部（或几部）AI 文字互动小说，现在跳出剧情，和你讨论设定、人物、剧情走向，或者纠正模型写歪的地方。
- 只讨论，不要写正文章节，不要替用户推进剧情。
- 说话直接、具体，指出设定之间的矛盾或模糊处；用户的决定以用户为准。
- 下面的资料是这部故事目前的设定和前情档案，档案里的是已经发生的事实。`;

export async function buildDiscussContext(d) {
  const parts = [];
  const add = (label, text) => { if (text?.trim()) parts.push({ label, text: text.trim() }); };
  const memo = await getGlobalMemo();
  if (d.storyId) {
    const s = await loadStoryState(d.storyId);
    if (!s) throw new Error('这个讨论关联的故事已经不在了');
    const { story, path, cp } = s;
    add('开头', ROLE + `\n\n【当前讨论的故事：${story.title || '未命名故事'}】`);
    add('全局备忘', memo ? '【全局备忘（所有故事通用）】\n' + memo : '');
    add('本故事规则', story.rules ? '【本故事规则】\n' + story.rules : '');
    add('世界与角色设定', story.world ? '【世界与角色设定】\n' + story.world : '');
    add('开场', story.opening ? '【开场】\n' + story.opening : '');
    for (const c of (story.cards || []).filter((x) => x.name?.trim())) add('角色卡 · ' + c.name, cardText(applyCardState(c, cp?.mem)));
    if (cp) {
      add('前情档案', memoryText(cp.mem));
      if (cp.mem.unsure?.length) add('待确认', '〔存档员拿不准的〕\n' + cp.mem.unsure.map((x) => '- ' + x).join('\n'));
    }
    const chs = chaptersOf(path);
    add('进度', `【进度】当前这条线一共 ${chs.length} 章${cp ? `，前情档案整理到第 ${cp.mem.upTo} 章` : '，还没有整理过前情档案'}。`);
    const n = Math.min(d.chapters || 0, chs.length);
    if (n) add(`最近 ${n} 章原文`, `【最近 ${n} 章原文】\n` + chs.slice(-n).map((c) => `〔第${c.no}章${c.title ? ' · ' + c.title : ''}〕\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`).join('\n\n'));
  } else {
    add('开头', ROLE.replace('下面的资料是这部故事目前的设定和前情档案，档案里的是已经发生的事实。', '这次是全局讨论：聊的是所有故事通用的写法、规则和偏好。'));
    add('全局备忘', '【全局备忘（所有故事每轮都会带上）】\n' + (memo || '（目前是空的）'));
    add('默认规则', '【默认规则（新故事会复制一份）】\n' + (await getDefaultRules()));
    const mods = await getModules();
    if (mods.length) add('规则模块库', '【规则模块库（各故事自己选择启用）】\n' + mods.map((m) => `〔${m.name}〕\n${(m.text || '').trim()}`).join('\n\n'));
    const stories = await db.all('stories');
    if (stories.length) add('故事列表', '【用户现有的故事】\n' + stories.map((s) => `- ${s.title || '未命名'}：${(s.world || '').replace(/\s+/g, ' ').slice(0, 80)}`).join('\n'));
  }
  const system = parts.map((p) => p.text).join('\n\n');
  return { system, parts: parts.map((p) => ({ label: p.label, chars: p.text.length, text: p.text })) };
}

export function chatMessages(d) {
  const ms = d.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim()).map((m) => ({ role: m.role, content: m.content }));
  while (ms.length && ms[0].role !== 'user') ms.shift();
  return ms;
}

// ───── 整理成修改 ─────
const CARD_FIELDS = { initial: '初始设定', base: '底色', voice: '原话锚', forbid: '禁止清单', now: '当前状态', arc: '变化轨迹', relation: '关系档案' };
const MEM_FIELDS = { corrections: '勘误', irreversible: '不可逆的事', threads: '未决事项与暗线', knowledge: '信息差', items: '物品与信物', offscreen: '暗处动向' };
export const TARGET_LABEL = { world: '世界设定', opening: '开场', rules: '规则', card: '角色卡', newcard: '新角色卡', memory: '前情档案', newstory: '新故事' };

export function changesPrompt(d) {
  const story = !!d.storyId;
  const targets = story ? `可用的 target：
- "rules"：写作规则、文风要求、"以后要/不要怎样"。text 写成一两条可以直接放进规则的话。
- "world"：世界观、背景、人物关系等设定的补充。op 为 "append"（追加）或 "replace"（把 old 原文换成 text；old 必须一字不差地出自现有设定）。
- "opening"：开场，op 只能 "replace"，text 是完整新开场。
- "card"：修改已有角色卡，name 写角色名，field 取 ${Object.keys(CARD_FIELDS).join(' / ')}（${Object.values(CARD_FIELDS).join('、')}），追加 text。
- "newcard"：新角色，name 写名字，text 写初始设定。
- "memory"：纠正或补充已经发生的剧情事实，field 取 ${Object.keys(MEM_FIELDS).join(' / ')}（${Object.values(MEM_FIELDS).join('、')}），纠错一律用 corrections。` : `可用的 target：
- "rules"：所有故事通用的写作规则、偏好。text 写成一两条可以直接放进规则的话。
- "newstory"：讨论里聊出了一个新故事，title 写故事名，text 写世界与角色设定，opening 写开场（可空）。`;
  return `根据上面的讨论，把用户确定下来的结论整理成要写回的修改。
${targets}

要求：
- 只收用户明确同意或提出的结论；还在犹豫、被否定的不要收。
- 合并同类，最多 6 条，越少越好。每条 text 简洁，能直接写进去，不要写"根据讨论"之类的话。
- 没有可写的就输出空数组。
- 只输出一个 JSON 对象，不要任何说明，也不要代码块标记：
{"changes":[{"target":"...","op":"append","name":"","field":"","old":"","text":"...","title":"","opening":"","why":"一句话说明"}]}`;
}

export function parseChanges(raw, isStory = true) {
  const t = String(raw || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有按格式返回，可以再试一次');
  const j = JSON.parse(t.slice(a, b + 1));
  const arr = Array.isArray(j.changes) ? j.changes : [];
  return arr.filter((c) => c && TARGET_LABEL[c.target] && (String(c.text || '').trim() || c.target === 'newstory')).slice(0, 8).map((c) => ({
    id: uid(), target: c.target, op: c.op === 'replace' ? 'replace' : 'append',
    name: String(c.name || '').trim(), field: String(c.field || '').trim(), old: String(c.old || ''),
    text: String(c.text || '').trim(), title: String(c.title || '').trim(), opening: String(c.opening || '').trim(),
    why: String(c.why || '').trim(),
    dest: c.target === 'rules' ? (isStory ? 'story' : 'global') : '', // 规则写到哪：story / global，界面上可切换
    on: true,
  }));
}

/** 一条修改的说明文字（给确认界面用），会根据故事实际情况调整去向 */
export function describeChange(c, s) {
  const cp = s?.cp;
  if (c.target === 'rules') return c.dest === 'global' ? '规则 → 全局备忘（所有故事）' : '规则 → 本故事规则';
  if (c.target === 'world') return c.op === 'replace' && c.old && (s?.story.world || '').includes(c.old) ? '世界设定 · 改一处' : '世界设定 · 追加';
  if (c.target === 'opening') return '开场 · 替换';
  if (c.target === 'card') {
    const card = (s?.story.cards || []).find((x) => x.name === c.name);
    if (!card) return `新角色卡 · ${c.name}`;
    return `角色卡 · ${c.name} · ${CARD_FIELDS[c.field] || '初始设定'}`;
  }
  if (c.target === 'newcard') return `新角色卡 · ${c.name || '未命名'}`;
  if (c.target === 'memory') return cp ? `前情档案 · ${MEM_FIELDS[c.field] || '勘误'}` : '前情档案（还没整理过）→ 改写进世界设定';
  if (c.target === 'newstory') return `新故事 · ${c.title || '未命名'}`;
  return c.target;
}

const appendText = (old, add) => (String(old || '').trim() ? String(old).trimEnd() + '\n' + add : add);

/**
 * 应用勾选的修改。返回 { done: [说明], newStory: prefill|null }。
 * 写之前存一份撤销快照。
 */
export async function applyChanges(d, changes) {
  const picked = changes.filter((c) => c.on);
  const done = [];
  let newStory = null;
  const s = d.storyId ? await loadStoryState(d.storyId) : null;
  const memo0 = await getGlobalMemo();
  let memo = memo0;
  const undo = { at: Date.now(), discId: d.id, globalMemo: memo0, story: s ? JSON.parse(JSON.stringify(s.story)) : null, node: s?.cp ? JSON.parse(JSON.stringify(s.cp.node)) : null };
  let storyDirty = false;
  let nodeDirty = false;

  for (const c of picked) {
    const label = describeChange(c, s);
    if (c.target === 'newstory') { newStory = { title: c.title, world: c.text, opening: c.opening }; done.push(label); continue; }
    if (c.target === 'rules' && (c.dest === 'global' || !s)) { memo = appendText(memo, c.text); done.push('规则 → 全局备忘'); continue; }
    if (!s) continue;
    const story = s.story;
    story.cards = story.cards || [];
    if (c.target === 'rules') { story.rules = appendText(story.rules, c.text); storyDirty = true; }
    else if (c.target === 'world') {
      if (c.op === 'replace' && c.old && (story.world || '').includes(c.old)) story.world = story.world.replace(c.old, c.text);
      else story.world = appendText(story.world, c.text);
      storyDirty = true;
    } else if (c.target === 'opening') { story.opening = c.text; storyDirty = true; }
    else if (c.target === 'card' || c.target === 'newcard') {
      let card = story.cards.find((x) => x.name === c.name);
      if (!card) {
        card = { id: uid(), name: c.name || '未命名', aliases: '', core: false, initial: c.text, base: '', voice: '', forbid: '', arc: '', now: '', relation: '' };
        story.cards.push(card);
      } else {
        const f = CARD_FIELDS[c.field] ? c.field : 'initial';
        // 当前状态 / 变化轨迹 / 关系档案：有前情档案时以档案为准，写进档案
        if (['now', 'arc', 'relation'].includes(f) && s.cp) {
          const mem = s.cp.mem;
          mem.cards = mem.cards || {};
          const cur = applyCardState(card, mem);
          mem.cards[card.name] = { ...(mem.cards[card.name] || {}), [f]: appendText(cur[f], c.text) };
          nodeDirty = true;
        } else card[f] = appendText(card[f], c.text);
      }
      storyDirty = true;
    } else if (c.target === 'memory') {
      if (s.cp) {
        const f = MEM_FIELDS[c.field] ? c.field : 'corrections';
        s.cp.mem[f] = [...(s.cp.mem[f] || []), c.text];
        nodeDirty = true;
      } else { story.world = appendText(story.world, '【补充】' + c.text); storyDirty = true; }
    }
    done.push(label);
  }
  await db.kvSet('disc.undo', undo);
  if (memo !== memo0) await setGlobalMemo(memo);
  if (storyDirty) { s.story.updatedAt = Date.now(); await db.put('stories', s.story); }
  if (nodeDirty) { s.cp.node.checkpoint = s.cp.mem; await db.put('nodes', s.cp.node); }
  return { done, newStory };
}

export async function getUndo() { return db.kvGet('disc.undo', null); }
export async function undoLast() {
  const u = await getUndo();
  if (!u) return false;
  await setGlobalMemo(u.globalMemo || '');
  if (u.story) await db.put('stories', u.story);
  if (u.node) await db.put('nodes', u.node);
  await db.del('kv', 'disc.undo');
  return true;
}

// ───── 新故事 ─────
export const NEWSTORY_PROMPT = `根据上面的讨论，整理出一个新故事的开局资料。只输出一个 JSON 对象，不要任何说明，也不要代码块标记：
{"title":"故事名","world":"世界与角色设定：世界观、主角是谁、登场角色和人设、开局处境，写具体","opening":"开场（可以空）","rulesExtra":"讨论里定下的这个故事专属写法要求（可以空）"}`;

export function parseNewStory(raw) {
  const t = String(raw || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有按格式返回，可以再试一次');
  const j = JSON.parse(t.slice(a, b + 1));
  return { title: String(j.title || '').trim(), world: String(j.world || '').trim(), opening: String(j.opening || '').trim(), rulesExtra: String(j.rulesExtra || '').trim() };
}
