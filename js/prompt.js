// 墨游 · 每轮重新拼装发给模型的内容
// 顺序：不常变的放前面（规则 → 设定 → 格式），剧情原文在后——以后加缓存时省钱。

import { forContext } from './parse.js';

export const DEFAULT_RULES = `【玩法】
- 你是这场文字互动小说的主持人（GM）兼叙述者，负责世界和其中所有角色；玩家扮演主角，用第二人称“你”称呼主角。
- 玩家输入里，“”内是主角说出口的话；引号外是动作或内心想法。内心想法其他角色听不到，也无从得知。
- 不替主角说话、做决定或主动行动；主角身体的自然反应可以写。
- 只有玩家宣布才算结局。

【节奏】
- 每轮只推进一个场景里的一两个关键动作，不跳时间、不切场景，不用“几天后”“两人聊了很久”这类概括带过。
- 停在局面发生变化、需要主角接招的地方，不替主角把反应写完。
- 世界不需要主角推动也会运转：角色有自己的目标和生活，会主动出手。

【人物】
- 每个角色有自己的动机、立场和说话方式，按人设行事，不为剧情需要突然变脸。
- 感情变化要有来由，建立在和主角共同经历的具体事件上，不凭空生出深情或敌意。
- 角色只知道通过合理渠道得知的事，不开上帝视角。

【文风】
- 小说式文笔，传统中文自然段，对白、动作、心理融合在段落里；不一句一段，也不堆成大块。
- 感情交给细节和动作，不替人物总结；少用套话和固定句式。`;

export function formatContract({ danmu = true, options = true } = {}) {
  const parts = [
    '每次回复严格按下面的格式，不要输出格式以外的说明：',
    '# 本章标题（第一行，四到十二个字，不写“第几章”）',
    '（空一行后写正文）',
  ];
  if (danmu) {
    parts.push(
      '【弹幕】',
      '网名：弹幕内容',
      '（3到8条，一行一条。弹幕是正在看这段剧情的读者实况：吐槽、嗑CP、站队、预测、尖叫，长短错落；不复述正文原句，不写分析文。剧中人物不知道弹幕存在。）'
    );
  }
  if (options) {
    parts.push(
      '【选项】',
      'A. ……',
      'B. ……',
      'C. ……',
      '（3个方向明显不同的参考行动：写具体能做的事，不写结果，不泄露隐藏信息。玩家也可以完全不按选项来。）'
    );
  }
  parts.push('', '玩家以“（出戏）”开头的话是场外交流：用场外身份简短直接地回答，不推进剧情，不用上面的格式。');
  return parts.join('\n');
}

export function userContent(node, { withDirector = false } = {}) {
  let c;
  if (node.kind === 'start') {
    c = '（开始游戏）\n' + (node.text?.trim()
      ? '开场：' + node.text.trim()
      : '请根据设定写开场：交代主角此刻所处的情境，停在第一个需要主角行动的地方。');
  } else if (node.kind === 'continue') {
    c = '（继续：让剧情自然往前走一步，不替我做选择）';
  } else if (node.kind === 'ooc') {
    c = '（出戏）' + (node.text || '');
  } else {
    c = node.text || '';
  }
  if (withDirector && node.director?.trim()) c += directorBlock(node.director);
  return c;
}

export function directorBlock(text) {
  return text?.trim() ? '\n\n【导演指令·仅本轮有效，来自玩家的场外要求：照做，但不要在正文里提到】\n' + text.trim() : '';
}

export const CONTINUE_MSG = '（系统：上一条回复中途断开了。请从断开的地方直接接着往下写完，不要重复已经写过的内容，不要加任何开场白；写完后照常附上格式要求里的其余部分。）';

/** 从某一段往后重写：前文保留，后面按要求重新写 */
export function rewriteMsg(note) {
  return '（系统：上一条回复只保留到这里，后面的内容作废。请从这里直接接着往下重新写' +
    (note?.trim() ? '，这次的要求：' + note.trim() : '') +
    '。不要重复已经写过的内容，不要加开场白；写完后照常附上格式要求里的其余部分。）';
}

// ───────────── 角色卡与规则模块 ─────────────

export function splitNames(card) {
  return [card.name, ...String(card.aliases || '').split(/[,，、;；\s]+/)].map((x) => (x || '').trim()).filter((x) => x.length >= 1);
}

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const asList = (t) => lines(t).map((l) => (/^[-*•·]/.test(l) ? l.replace(/^[-*•·]\s*/, '- ') : '- ' + l)).join('\n');

export function cardText(c) {
  const parts = [`【角色卡·${c.name || '未命名'}】` + (c.aliases?.trim() ? `（也叫：${c.aliases.trim()}）` : '')];
  if (c.initial?.trim()) parts.push('〔初始设定〕\n' + c.initial.trim());
  if (c.base?.trim()) parts.push('〔底色：遇事怎么做、说话的样子、身份与配套〕\n' + c.base.trim());
  if (c.voice?.trim()) parts.push('〔原话（只用来校准口气和节奏，不要照抄）〕\n' + asList(c.voice));
  if (c.forbid?.trim()) parts.push('〔禁止：他不会这样做〕\n' + asList(c.forbid));
  if (c.arc?.trim()) parts.push('〔变化轨迹〕\n' + c.arc.trim());
  if (c.now?.trim()) parts.push('〔当前状态与称呼〕\n' + c.now.trim());
  if (c.relation?.trim()) parts.push('〔和主角的关系档案〕\n' + c.relation.trim());
  return parts.join('\n');
}

function mentioned(text, card) {
  if (!text) return false;
  return splitNames(card).some((n) => (n === card.name || n.length >= 2) && text.includes(n));
}

/** 用来判断“谁在场 / 哪个关键词出现了”的文字：本轮输入、导演指令、最近两条回复 */
export function scanText(path, extra = '') {
  const users = path.filter((n) => n.role === 'user');
  const replies = path.filter((n) => n.role === 'assistant' && n.text);
  const u = users[users.length - 1];
  return [u?.text || '', u?.director || '', ...replies.slice(-2).map((n) => n.text), extra].join('\n');
}

/**
 * 选出这一轮要发的角色卡和模块。
 * modules：全局模块库；story.modules：这个故事启用的模块；story.manualOn：手动开着的情境模块
 */
export function selectExtras(story, path, modules = [], extra = '') {
  const scan = scanText(path, extra);
  const cards = (story.cards || []).filter((c) => c.name?.trim());
  const sentCards = cards.filter((c) => c.core || mentioned(scan, c));
  const present = sentCards.filter((c) => mentioned(scan, c));
  const enabled = new Set(Object.keys(story.modules || {}).filter((k) => story.modules[k]));
  const sentModules = modules.filter((m) => {
    if (!enabled.has(m.id) || !m.text?.trim()) return false;
    if (m.mode === 'manual') return !!story.manualOn?.[m.id];
    if (m.mode === 'keyword') return String(m.keywords || '').split(/[,，、;；\s]+/).filter(Boolean).some((k) => scan.includes(k));
    return true;
  });
  return { sentCards, present, sentModules };
}

/** 末尾提醒：在场角色的禁止清单，放在最后一条玩家消息里（离模型“下笔”最近） */
/** 每轮最后一句的格式提醒：规则很长时模型容易忘了写弹幕和选项 */
export function formatTail(story) {
  const want = [story.danmu !== false ? '【弹幕】' : '', story.options !== false ? '【选项】（A/B/C 三行）' : ''].filter(Boolean);
  if (!want.length) return '';
  return `\n\n（格式提醒：正文写完后依次写${want.join('和')}，不要省略。）`;
}

export function tailReminder(present, { maxEach = 5 } = {}) {
  const rows = present.filter((c) => c.forbid?.trim()).map((c) => `- ${c.name}：${lines(c.forbid).slice(-maxEach).map((l) => l.replace(/^[-*•·]\s*/, '')).join('；')}`);
  if (!rows.length) return '';
  return '\n\n【在场角色提醒·玩家场外设置，不要在正文里提到】\n' + rows.join('\n');
}

// ───────────── 前情档案（存档挂在某一章的回复节点上） ─────────────

/** 当前这条线上最近的一次存档：{ index, node, mem }，没有则 null */
export function latestCheckpoint(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].checkpoint) return { index: i, node: path[i], mem: path[i].checkpoint };
  }
  return null;
}

/** 角色卡上会随剧情变的三栏：有存档就用存档里最新的 */
export function applyCardState(card, mem) {
  const s = mem?.cards?.[card.name];
  if (!s) return card;
  return { ...card, now: s.now ?? card.now, arc: s.arc ?? card.arc, relation: s.relation ?? card.relation };
}

const bullet = (arr) => (arr || []).map((x) => String(x || '').trim()).filter(Boolean).map((x) => '- ' + x.replace(/^[-*•·]\s*/, '')).join('\n');

export function memoryText(mem) {
  if (!mem) return '';
  const out = [`【前情档案：第 1–${mem.upTo} 章已整理；之后的剧情见对话原文。档案里的是已经发生的事实】`];
  if (mem.early?.trim()) out.push('〔早期概要〕\n' + mem.early.trim());
  if (mem.summaries?.length) out.push('〔各段摘要〕\n' + mem.summaries.map((x) => `第${x.from}–${x.to}章：${x.text.trim()}`).join('\n'));
  const sec = (title, arr) => { const b = bullet(arr); if (b) out.push(`〔${title}〕\n${b}`); };
  sec('不可逆的事（永久有效）', mem.irreversible);
  sec('勘误（和上面冲突时以这里为准）', mem.corrections);
  sec('物品与信物', mem.items);
  sec('未决事项、未兑现的承诺、暗线', mem.threads);
  sec('信息差：谁知道什么、谁不知道', mem.knowledge);
  sec('暗处动向：各角色接下来想做什么', mem.offscreen);
  sec('最近反复出现的套路（接下来换个写法）', mem.repeats);
  return out.join('\n');
}

/**
 * path：从第一条到当前的节点（最后一条通常是刚发出的玩家输入）
 * opts.modules：全局规则模块库
 * 返回 { system, messages, info }，info.parts 是各部分的明细（给查看器用）
 */
export function buildContext(story, path, { budgetChars = 60000, keepRawLast = 2, modules = [], extra = '', globalMemo = '' } = {}) {
  const { sentCards, present, sentModules } = selectExtras(story, path, modules, extra);
  const cp = latestCheckpoint(path);
  const parts = [];
  const add = (label, text, kind) => { if (text?.trim()) parts.push({ label, text: text.trim(), kind }); };
  add('开头', '你正在主持一场文字互动小说。', 'base');
  add('规则（这个故事）', story.rules?.trim() ? '【规则】\n' + story.rules.trim() : '', 'rules');
  add('全局备忘', globalMemo?.trim() ? '【全局备忘（所有故事通用）】\n' + globalMemo.trim() : '', 'rules');
  for (const m of sentModules) add(`规则模块 · ${m.name}${m.mode === 'manual' ? '（情境）' : m.mode === 'keyword' ? '（关键词）' : ''}`, `【规则模块·${m.name}】\n${m.text.trim()}`, 'module');
  add('世界与角色设定', story.world?.trim() ? '【世界与角色设定】\n' + story.world.trim() : '', 'world');
  const coreFirst = [...sentCards].sort((a, b) => (b.core ? 1 : 0) - (a.core ? 1 : 0));
  for (const c of coreFirst) add(`角色卡 · ${c.name}${c.core ? '（常驻）' : '（被提到）'}`, cardText(applyCardState(c, cp?.mem)), 'card');
  if (cp) add(`前情档案 · 整理到第 ${cp.mem.upTo} 章`, memoryText(cp.mem), 'memory');
  add('输出格式', '【输出格式】\n' + formatContract({ danmu: story.danmu !== false, options: story.options !== false }), 'format');
  const system = parts.map((p) => p.text).join('\n\n');

  // 有存档时：对话原文只从存档那一章开始（那一章本身留作衔接），更早的由前情档案代替
  const recentPath = cp ? path.slice(cp.index) : path;
  // 出戏对话：之后已经回到正戏的，就不再发给模型
  let lastPlayUser = -1;
  recentPath.forEach((n, i) => { if (n.role === 'user' && n.kind !== 'ooc') lastPlayUser = i; });
  const kept = recentPath.filter((n, i) => !(n.kind === 'ooc' && i < lastPlayUser));

  // 最近 keepRawLast 轮的回复保留弹幕和选项（让模型延续口气），更早的只留正文
  const playReplies = kept.filter((n) => n.role === 'assistant' && n.kind !== 'ooc');
  const rawSet = new Set(playReplies.slice(-keepRawLast).map((n) => n.id));

  const lastUserIdx = kept.map((n) => n.role).lastIndexOf('user');
  let messages = [];
  const tail = tailReminder(present);
  const fmtTail = formatTail(story);
  kept.forEach((n, i) => {
    if (n.role === 'user') {
      const isLastUser = i === lastUserIdx;
      let c = userContent(n, { withDirector: isLastUser });
      if (isLastUser && tail && n.kind !== 'ooc') c += tail;
      if (isLastUser && fmtTail && n.kind !== 'ooc') c += fmtTail;
      messages.push({ role: 'user', content: c });
    } else if (n.text && n.text.trim()) {
      const content = n.kind === 'ooc' || rawSet.has(n.id) ? n.text.trim() : forContext(n.text);
      messages.push({ role: 'assistant', content });
    }
  });

  // 超出预算时从最早的开始丢（至少保留最后 6 条）
  let trimmed = 0;
  const size = (ms) => ms.reduce((a, m) => a + m.content.length, 0);
  while (messages.length > 6 && size(messages) + system.length > budgetChars) {
    messages.shift();
    trimmed++;
  }
  // 第一条必须是用户消息（Claude 等接口的要求）；从存档处开始或被截断后，第一条可能是回复
  if (messages.length && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: cp ? '（更早的剧情见系统提示里的“前情档案”。下面从最近一章接着来。）' : '（更早的剧情因为太长没有发送。下面从这里接着来。）' });
  }
  const historyChars = size(messages);
  return {
    system,
    messages,
    info: {
      systemChars: system.length, historyChars, totalChars: system.length + historyChars, trimmed, count: messages.length,
      parts: parts.map((p) => ({ label: p.label, chars: p.text.length, text: p.text, kind: p.kind })),
      tail, cards: sentCards.map((c) => c.name), present: present.map((c) => c.name), modules: sentModules.map((m) => m.name),
      memoryUpTo: cp ? cp.mem.upTo : 0,
    },
  };
}
