// 墨游 · 番外：模板、通用要求、每篇番外发给模型的内容
// 番外不进正史：不写回剧情，也不会作为前情发给正文。

import { db } from './db.js';
import { uid } from './util.js';
import { forContext, parseReply } from './parse.js';
import { cardText, splitNames } from './prompt.js';

export const SCOPES = {
  follow: '跟随形式',
  all: '全知：正史里发生过的都能写',
  public: '只知道公开的事：旁人能看到、听说的',
  char: '只知道视角角色知道的事',
};

export const LENGTHS = { short: ['短', 1000], mid: ['中', 2500], long: ['长', 5000] };

export const DEFAULT_BASE = `- 第一行写番外标题（# 开头），然后是正文。
- 这是非正史番外：不改变正史的事实、人物认知和关系进度；论坛猜测、网友同人、假设剧情都不算正史。
- 人物保持正史人设；配角各有自己的性格和立场，不要所有人都变成同一种嗑CP的群众。
- 重点是把人物写鲜活：有趣的假设、生活细节、旁观者视角、无关紧要的小事件。梗要充分展开，不硬写升华结尾。
- 可以原创正文没写过的小事，但不擅自新增重大秘密、新的感情史、或会影响正史判断的大事件。`;

const BUILTIN = [
  ['小说体', 'all', '用小说正文的写法写一个完整的小场景：有开头、发展和收尾。传统中文自然段，对白、动作、心理融合在段落里。'],
  ['论坛体', 'public', '写成真实网络论坛的帖子：楼主开帖，后面十几到二十几层回复，用“楼主”“1楼”“回复#3”这类标记。不同楼层的人立场和掌握的信息都不同：有人分析得准，有人一本正经胡说八道，有人歪楼、抬杠、玩梗、潜水打卡。不要求最后得出正确答案。'],
  ['日记体', 'char', '用视角角色的第一人称写日记，可以按日期分段。写他嘴上不会说出口的真实想法；表面说的和心里想的可以有落差，但要符合他的人设。'],
  ['采访体', 'char', '视角角色接受一场采访：一问一答，问题写“问：”，回答写“答：”。他按自己的性格回答，可以绕弯子、答非所问、避而不答，不要求每题都有工整答案。'],
  ['剧本体', 'all', '写成广播剧剧本：“角色名：台词”，动作神态放在括号里，可以加【音效：……】，场景转换写“第二幕·地点”。台词有来有回，不用“嗯”“哦”凑行数。'],
  ['群聊记录', 'all', '模拟聊天软件的群聊或私聊记录：“昵称：内容”一条一行，可以有时间、撤回提示、【表情包：……】、【语音 0:12，转文字：……】、已读不回。每个人说话方式不同；群里每个人只知道自己知道的事。'],
  ['角色图鉴', 'all', '写成游戏角色图鉴：基本信息、性格关键词、外貌关键词、和主角现在的关系、口头禅、一两条日常小事。条目化，可以玩梗，但不能和正史人设冲突。'],
  ['吐槽局', 'public', '几个已登场的配角凑在一起吃饭喝酒，聊主角和这段关系的八卦。以对话为主，互相接梗拆台，有人说漏嘴、有人护短、有人看热闹不嫌事大，可以跑题。'],
];

export function builtinTemplates() {
  return BUILTIN.map(([name, scope, text], i) => ({ id: 'builtin-' + i, name, scope, text, note: '' }));
}

export async function getTemplates() {
  const v = await db.kvGet('fwTemplates', null);
  return Array.isArray(v) ? v : builtinTemplates();
}
export async function saveTemplates(list) { return db.kvSet('fwTemplates', list); }
export async function getBase() {
  const v = await db.kvGet('fwBase', null);
  return v == null ? DEFAULT_BASE : v;
}
export async function saveBase(text) { return db.kvSet('fwBase', text); }

export function newTemplate() { return { id: uid(), name: '', scope: 'all', text: '', note: '' }; }

/**
 * 正史章节：沿当前这条线，每一章 = 一条有正文的回复 + 它前面那句玩家输入
 * 返回 [{ no, id, title, said, text }]
 */
export function chaptersOf(path) {
  const out = [];
  let lastUser = null;
  for (const n of path) {
    if (n.role === 'user') { if (n.kind !== 'ooc') lastUser = n; continue; }
    if (n.kind === 'ooc' || !n.text?.trim()) continue;
    const said = !lastUser ? '' : lastUser.kind === 'start' ? (lastUser.text?.trim() ? '开场：' + lastUser.text.trim() : '') : lastUser.kind === 'continue' ? '（继续）' : lastUser.text || '';
    out.push({ no: out.length + 1, id: n.id, title: parseReply(n.text).title, said, text: forContext(n.text) });
  }
  return out;
}

/**
 * 拼一篇番外要发的内容。
 * opts: { chapters, anchorNo, recentN, pinned:[no], template, request, scope, pov, length, modules(已筛好要带的), base }
 */
export function buildExtraContext(story, opts) {
  const { chapters, anchorNo, recentN = 6, pinned = [], template, request = '', pov = '', length = 'mid', modules = [], base = DEFAULT_BASE } = opts;
  const scope = opts.scope && opts.scope !== 'follow' ? opts.scope : (template?.scope || 'all');
  const upto = chapters.filter((c) => c.no <= anchorNo);
  const recent = recentN > 0 ? upto.slice(-recentN) : [];
  const pinnedSet = new Set(pinned.filter((no) => no <= anchorNo));
  const picked = upto.filter((c) => pinnedSet.has(c.no) || recent.includes(c));
  const material = picked.map((c) => `【第${c.no}章${c.title ? ' · ' + c.title : ''}】${pinnedSet.has(c.no) ? '（指定素材）' : ''}\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`).join('\n\n');

  // 角色卡：常驻的、视角角色、素材里被提到的
  const scan = material + '\n' + request + '\n' + pov;
  const cards = (story.cards || []).filter((c) => c.name?.trim() && (c.core || c.name === pov || splitNames(c).some((n) => (n === c.name || n.length >= 2) && scan.includes(n))));

  const scopeText = scope === 'public'
    ? '写这篇的人（网友、路人、旁人）只知道公开发生、旁人能看到或听说的事：公开场合的言行、传闻、照片、热搜之类。私下的对话、内心想法、亲密细节一律不知道，只能猜，而且可以猜错。'
    : scope === 'char'
      ? (pov ? `以${pov}的视角写：只能写${pov}亲眼见过、亲耳听过、或通过合理渠道得知的事；${pov}不知道的事，不能写成他知道。` : '以视角角色的视角写：只能写他亲眼见过、亲耳听过、或通过合理渠道得知的事。')
      : '可以写正史里发生过的任何事，但不能和正史矛盾。';
  const [lenLabel, lenChars] = LENGTHS[length] || LENGTHS.mid;

  const parts = [];
  const add = (label, text) => { if (text?.trim()) parts.push({ label, text: text.trim() }); };
  add('开头', '你在为一部文字互动小说写番外。番外是独立于正史的创作，写完不推进主线。');
  add('番外通用要求', '【番外通用要求】\n' + base);
  add(`形式 · ${template?.name || '自定义'}`, '【这篇的形式与写法】\n' + (template?.text?.trim() || '按下面玩家的要求来写。'));
  add('知情范围', '【知情范围】\n' + scopeText);
  for (const m of modules) add(`规则模块 · ${m.name}`, `【规则模块·${m.name}】\n${m.text.trim()}`);
  add('世界设定', story.world?.trim() ? '【世界设定】\n' + story.world.trim() : '');
  for (const c of cards) add(`角色卡 · ${c.name}`, cardText(c));
  add('时间点', anchorNo > 0
    ? `【时间点】这篇番外发生在正史第 ${anchorNo} 章之后。第 ${anchorNo} 章之后的正史还没有发生，不要写到。`
    : '【时间点】正史还没开始，按设定写。');
  add(`正史素材 · ${picked.length} 章`, material ? '【正史素材（只用来了解人物和发生过的事，不要照抄原句）】\n' + material : '');
  const system = parts.map((p) => p.text).join('\n\n');
  const user = `请写这篇番外，篇幅大约 ${lenChars} 字（${lenLabel}篇）。` + (request.trim() ? `\n这次的要求：${request.trim()}` : '') + (pov && scope !== 'char' ? `\n视角角色：${pov}` : '');
  return {
    system,
    messages: [{ role: 'user', content: user }],
    info: { parts: parts.map((p) => ({ label: p.label, chars: p.text.length, text: p.text })), totalChars: system.length + user.length, chapters: picked.map((c) => c.no), cards: cards.map((c) => c.name), scope },
  };
}

/** 番外原文 → 标题 + 段落块（保留单个换行，论坛、群聊这类形式靠换行分楼层） */
export function extraBlocks(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  let title = '';
  let body = raw;
  const first = raw.split('\n')[0] || '';
  const m = first.match(/^#{1,4}\s*(.+?)\s*#*$/);
  if (m) { title = m[1].replace(/^\*+|\*+$/g, '').trim(); body = raw.slice(first.length).trim(); }
  const blocks = body.split(/\n\s*\n/).map((b) => b.replace(/\*\*(.+?)\*\*/g, '$1').trim()).filter(Boolean);
  return { title, blocks };
}
