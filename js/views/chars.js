// 墨游 · 角色：照老版的“登场人物”卡片；点开看全部，编辑在弹出层里

import { db } from '../db.js';
import { el, uid, toast, sheet } from '../util.js';
import { connLabel, resolveConnection, go, setCurrentStory } from '../state.js';
import { streamWithRetry } from '../api.js';
import { latestCheckpoint, memoryText, splitNames } from '../prompt.js';
import { chaptersOf } from '../fanwai.js';
import { normalizeUsage, computeCost, recordUsage } from '../cost.js';

function pathTo(nodes, nodeId) {
  const out = [];
  let cur = nodeId ? nodes.get(nodeId) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
  return out;
}
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

export async function render(root, { id }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
  story.cards = story.cards || [];
  const nodes = new Map((await db.byStory(id)).map((n) => [n.id, n]));
  const opened = new Set();

  const saveNow = async () => {
    story.updatedAt = Date.now();
    try { await db.put('stories', story); } catch { toast('保存失败'); }
  };
  const cp = () => latestCheckpoint(pathTo(nodes, story.headId));
  const stateOf = (c) => {
    const m = cp();
    const s = m?.mem?.cards?.[c.name];
    return { now: s?.now ?? c.now, arc: s?.arc ?? c.arc, relation: s?.relation ?? c.relation, from: s ? m.mem.upTo : 0 };
  };

  const wrap = el('div', { class: 'wrap' });
  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('div', { class: 'title', style: { paddingLeft: '6px' } }, '角色', el('div', { class: 'sub', text: story.title || '未命名故事' })),
      el('button', { class: 'icon-btn', 'aria-label': '新角色', onclick: () => editCard(null) }, '＋')),
    el('div', { class: 'scroll' }, wrap)));

  function memo(label, text, { badge = '', clamp = false } = {}) {
    const t = String(text || '').trim();
    return el('div', { class: 'memo' },
      el('div', { class: 'memo-h' }, el('span', { text: label }), badge ? el('span', { class: 'memo-badge', text: badge }) : null),
      el('div', { class: 'memo-t' + (clamp ? ' clamp' : '') + (t ? '' : ' none'), text: t || '还没写' }));
  }

  function cardEl(c) {
    const s = stateOf(c);
    const isOpen = opened.has(c.id);
    const desc = lines(c.initial || c.base)[0] || '';
    const forbidN = lines(c.forbid).length;
    const voiceN = lines(c.voice).length;
    const toggle = () => { if (isOpen) opened.delete(c.id); else opened.add(c.id); draw(); };
    return el('div', { class: 'npc-card', 'data-name': c.name },
      el('div', { class: 'npc-head', onclick: toggle },
        el('span', { class: 'npc-name', text: c.name || '未命名' }),
        el('span', { class: 'badge', text: c.core ? '常驻' : '被提到才发' }),
        c.auto ? el('span', { class: 'badge ai', text: 'AI 新加' }) : null,
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'btn small ghost', onclick: (e) => { e.stopPropagation(); editCard(c); } }, '编辑')),
      c.aliases?.trim() ? el('div', { class: 'npc-alias', text: '也叫 ' + c.aliases.trim() }) : null,
      c.auto ? el('div', { class: 'npc-alias', text: `整理第 ${c.auto.from}–${c.auto.to} 章时自动建的，点“编辑”过目、保存后这个标记就去掉` }) : null,
      desc ? el('div', { class: 'npc-desc' + (isOpen ? '' : ' clamp'), text: isOpen ? (c.initial || c.base || '').trim() : desc }) : null,
      memo('当前状态与称呼', s.now, { badge: s.from ? `第 ${s.from} 章整理` : '', clamp: !isOpen }),
      ...(isOpen ? [
        memo('变化轨迹', s.arc, { badge: s.from ? `第 ${s.from} 章整理` : '' }),
        memo('关系档案', s.relation, { badge: s.from ? `第 ${s.from} 章整理` : '' }),
        c.initial?.trim() && c.base?.trim() ? memo('底色', c.base) : null,
        memo('原话锚', c.voice),
        memo('禁止清单', c.forbid),
      ].filter(Boolean) : []),
      el('div', { class: 'npc-foot' },
        ...[forbidN ? el('span', { class: 'tag', text: `禁止清单 ${forbidN} 条` }) : null,
          voiceN ? el('span', { class: 'tag', text: `原话锚 ${voiceN} 句` }) : null].filter(Boolean),
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'npc-more', onclick: toggle }, isOpen ? '收起' : '展开全部')));
  }

  function draw() {
    wrap.replaceChildren();
    const m = cp();
    if (m && story.cards.some((c) => m.mem.cards?.[c.name])) {
      wrap.append(el('div', { class: 'hint', style: { margin: '0 2px 12px' } },
        `当前状态、变化轨迹、关系档案跟着前情档案走（整理到第 ${m.mem.upTo} 章）。`,
        el('a', { href: 'javascript:void 0', onclick: () => go('memory/' + encodeURIComponent(id)) }, '看记忆')));
    }
    if (!story.cards.length) {
      wrap.append(el('div', { class: 'empty', style: { padding: '28px 8px' } }, '还没有角色卡。', el('br'), '可以手动建，也可以让 AI 先从世界设定和玩过的剧情里拆一版草稿。'));
    }
    const core = story.cards.filter((c) => c.core);
    const rest = story.cards.filter((c) => !c.core);
    if (core.length) wrap.append(el('div', { class: 'section-title', text: rest.length ? '常驻' : '登场人物' }), ...core.map(cardEl));
    if (rest.length) wrap.append(el('div', { class: 'section-title', text: core.length ? '被提到才出场' : '登场人物' }), ...rest.map(cardEl));
    wrap.append(
      el('div', { class: 'row', style: { marginTop: '14px' } },
        el('button', { class: 'btn primary', onclick: () => editCard(null) }, '＋ 新角色'),
        el('button', { class: 'btn', onclick: () => aiSplit() }, '让 AI 从设定和剧情里拆角色卡')),
      el('div', { class: 'hint', style: { marginTop: '12px' } },
        '“常驻”的角色每轮都发给模型；其他角色只在最近的剧情或你的输入里被提到时才发。在场角色的禁止清单会贴在每轮最后提醒模型。游玩时某一章“⋯ → 这不像他”会把纠正写进禁止清单。剧情里新登场、会反复出现的角色，整理前情时会自动建卡（标“AI 新加”）。'));
  }
  const redraw = draw;
  const onCards = (e) => {
    if (e.detail?.storyId !== story.id || !Array.isArray(e.detail.cards)) return;
    story.cards = e.detail.cards;
    db.byStory(id).then((ns) => { nodes.clear(); ns.forEach((n) => nodes.set(n.id, n)); draw(); }).catch(() => draw());
  };
  window.addEventListener('moyu:cards', onCards);

  function editCard(existing) {
    const isNew = !existing;
    const c = existing ? { ...existing } : { id: uid(), name: '', aliases: '', core: story.cards.length < 3, initial: '', base: '', voice: '', forbid: '', arc: '', now: '', relation: '' };
    // 整理过前情、档案里有这个人：这三栏以档案为准，编辑的也是档案里的那份
    const m = cp();
    const memEntry = existing && m?.mem?.cards?.[existing.name] ? m.mem.cards[existing.name] : null;
    if (memEntry) { c.now = memEntry.now ?? c.now; c.arc = memEntry.arc ?? c.arc; c.relation = memEntry.relation ?? c.relation; }
    const memHint = memEntry ? `现在以前情档案（整理到第 ${m.mem.upTo} 章）为准，改了会一起改档案。` : '';
    const s = sheet({ title: isNew ? '新角色' : (c.name || '角色卡') });
    const f = {};
    const field = (key, label, { tall = false, hint = '', lock = false, ph = '' } = {}) => {
      const inp = tall ? el('textarea', { placeholder: ph }) : el('input', { type: 'text', placeholder: ph });
      if (tall) inp.style.minHeight = '96px';
      inp.value = c[key] || '';
      f[key] = inp;
      return el('div', { class: 'field' }, el('label', { text: (lock ? '🔒 ' : '') + label }), inp, hint ? el('div', { class: 'hint', text: hint }) : null);
    };
    const core = el('input', { type: 'checkbox' }); core.checked = !!c.core;
    s.body.append(
      el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '12px' } }, '🔒 的几栏是这个人的底稿，以后的自动存档不会改它们，只有你能改。写成具体动作比形容词管用：不写“他很傲娇”，写“被夸时会岔开话题，过一会儿又绕回来问你是不是真心的”。'),
      field('name', '名字', { ph: '例：沈澜' }),
      field('aliases', '别名', { ph: '用顿号分开，例：沈总、阿澜', hint: '剧情里出现名字或别名，就算“被提到”。' }),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '常驻', el('small', { text: '主要角色打开：每轮都发。配角关掉：被提到才发，省钱也省注意力。' })), el('label', { class: 'switch' }, core, el('span'))),
      field('initial', '一、初始设定', { tall: true, lock: true, ph: '开局给的设定：身份、外貌、和主角的起点关系、登场时的态度' }),
      field('base', '二、底色', { tall: true, ph: '遇事反应：被夸、被拒、吃醋、被冒犯时具体会做什么；说话的样子；身份与配套（谁伺候他、钱怎么花、什么事不会亲自动手）' }),
      field('voice', '原话锚（一行一句）', { tall: true, lock: true, ph: '他说过的、最像他的几句话。只用来校准口气，模型不会照抄。' }),
      field('forbid', '禁止清单（一行一条）', { tall: true, lock: true, ph: '例：不会当众道歉（第12章纠正）\n不会主动解释自己', hint: '游玩时在某一章点“⋯ → 这不像他”，会自动写进这里。' }),
      field('arc', '三、变化轨迹', { tall: true, ph: '第几章发生了什么、他因此哪里变了、哪里没变', hint: memHint }),
      field('now', '四、当前状态与称呼', { tall: true, ph: '现在走到哪一步、对主角的立场、彼此怎么称呼', hint: memHint }),
      field('relation', '关系档案', { tall: true, ph: '相处梗、称呼史、生效中的约定、亲密档案', hint: memHint }),
    );
    s.foot.append(...[
      isNew ? null : el('button', {
        class: 'btn danger', style: { marginRight: 'auto' },
        onclick: async () => {
          if (!confirm(`删除「${c.name || '这个角色'}」的角色卡？`)) return;
          story.cards = story.cards.filter((x) => x.id !== c.id);
          await saveNow(); s.close(); redraw();
        },
      }, '删除'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          for (const k of Object.keys(f)) c[k] = f[k].value;
          c.name = c.name.trim();
          if (!c.name) { toast('名字要填'); return; }
          c.core = core.checked;
          c.updatedAt = Date.now();
          delete c.auto;
          const i = story.cards.findIndex((x) => x.id === c.id);
          if (i >= 0) story.cards[i] = c; else story.cards.push(c);
          if (memEntry) {
            if (existing.name !== c.name) delete m.mem.cards[existing.name];
            m.mem.cards[c.name] = { ...memEntry, now: c.now, arc: c.arc, relation: c.relation };
            await db.put('nodes', m.node).catch(() => {});
          }
          await saveNow(); s.close(); toast('角色卡已保存'); redraw();
        },
      }, '保存'),
    ].filter(Boolean));
  }

  async function aiSplit() {
    const path = pathTo(nodes, story.headId);
    const chs = chaptersOf(path);
    const m = cp();
    // 最近的剧情原文：从后往前取，最多约 3 万字
    const picked = [];
    let used = 0;
    for (let i = chs.length - 1; i >= 0; i--) {
      const c = chs[i];
      const block = `【第${c.no}章${c.title ? ' · ' + c.title : ''}】\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`;
      if (used && used + block.length > 30000) break;
      picked.unshift({ no: c.no, block });
      used += block.length;
    }
    if (!story.world?.trim() && !picked.length) { toast('先写世界设定，或者玩几章'); return; }
    const conn = await resolveConnection(story);
    if (!conn) { toast('先在设置里添加连接'); return; }
    const s = sheet({ title: '从设定和剧情里拆角色卡' });
    const status = el('div', { class: 'thinking', text: '正在整理' });
    const range = picked.length ? `第 ${picked[0].no}–${picked[picked.length - 1].no} 章` : '';
    s.body.append(el('div', { class: 'hint', style: { marginTop: 0 } },
      `用「${connLabel(conn)}」读一遍${story.world?.trim() ? '世界设定' : ''}${m && picked.length && picked[0].no > 1 ? '、前情档案' : ''}${picked.length ? `${story.world?.trim() ? '和' : ''}最近的剧情（${range}，约 ${used} 字）` : ''}，整理出角色卡草稿。已经有卡的不会重复；没写到的栏留空。`), status);
    const ctrl = new AbortController();
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => { ctrl.abort('user'); s.close(); } }, '取消'));
    const have = story.cards.filter((c) => c.name?.trim()).map((c) => c.name.trim() + (c.aliases?.trim() ? '（' + c.aliases.trim() + '）' : ''));
    const prompt = '下面是一个文字互动小说的' + [story.world?.trim() ? '世界设定' : '', picked.length ? '已经玩过的剧情' : ''].filter(Boolean).join('和') +
      '。请把其中除主角（玩家扮演的“你”）以外、有名有姓、会反复出现的角色，整理成角色卡草稿。剧情里新登场的角色（包括设定里没有的）也要整理。\n' +
      (have.length ? '这些角色已经有卡了，不要再写：' + have.join('、') + '\n' : '') +
      '要求：只根据下面的原文，不要编造没写到的内容；没写到的栏留空字符串；路人和只出现一次的角色不要。只输出一个 JSON 数组，不要任何说明或代码块标记。\n' +
      '每个元素：{"name":"名字","aliases":"别名、别人对他的称呼，用顿号分开","core":是否主要角色(true/false),"initial":"身份、外貌、和主角的关系、初始态度；剧情里登场的写清第几章怎么登场","base":"性格底色：遇事怎么反应、怎么说话","voice":"他说过的有代表性的原话，原样摘，一行一句","forbid":"明确写了或明显看得出他不会做的事，一行一条","now":"（剧情里出现过才写）现在走到哪一步、对主角的立场、彼此怎么称呼","relation":"（剧情里出现过才写）和主角的关系：相处梗、称呼、约定"}\n\n' +
      [story.world?.trim() ? '【世界设定】\n' + story.world.trim() : '',
        m && picked.length && picked[0].no > 1 ? '【前情档案（更早的剧情）】\n' + memoryText(m.mem) : '',
        picked.length ? `【最近的剧情：${range}】\n` + picked.map((x) => x.block).join('\n\n') : ''].filter(Boolean).join('\n\n');
    let raw = '';
    try {
      const r = await streamWithRetry(conn, {
        system: '你是资料整理助手，只输出 JSON。', messages: [{ role: 'user', content: prompt }], maxTokens: 8000, signal: ctrl.signal,
        onText: (_d, full) => { raw = full; status.textContent = `正在整理（已收到 ${full.length} 字）`; },
      });
      raw = r.text;
      const u = normalizeUsage(r.usage, { inChars: prompt.length + 20, outChars: raw.length });
      recordUsage({ kind: '拆角色卡', storyId: story.id, model: conn.model, usage: u, cost: computeCost(u, conn) });
    } catch (e) {
      if (e.kind === 'aborted') return;
      status.className = 'err'; status.textContent = '整理失败：' + e.message + (e.hint ? '。' + e.hint : '');
      return;
    }
    let arr = null;
    try {
      const a = raw.indexOf('['), b = raw.lastIndexOf(']');
      arr = JSON.parse(raw.slice(a, b + 1));
      if (!Array.isArray(arr)) throw new Error('不是数组');
    } catch {
      status.className = 'err';
      status.replaceChildren('模型返回的格式看不懂，可以再试一次或换个模型。', el('pre', { class: 'raw', text: raw.slice(0, 1500) }));
      return;
    }
    const existing = new Set(story.cards.flatMap((c) => splitNames(c)));
    const txt = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).trim();
    const drafts = arr.filter((x) => x && x.name).map((x) => ({
      id: uid(), name: String(x.name).trim(), aliases: txt(x.aliases), core: x.core === true || x.core === 'true',
      initial: txt(x.initial), base: txt(x.base), voice: txt(x.voice), forbid: txt(x.forbid),
      arc: '', now: txt(x.now), relation: txt(x.relation),
    }));
    const dup = (d) => splitNames(d).some((n) => existing.has(n));
    status.remove();
    if (!drafts.length) { s.body.append(el('div', { class: 'hint', text: '没找到还没建卡的角色。' })); return; }
    const checks = drafts.map((d) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !dup(d);
      s.body.append(el('label', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, cb,
        el('div', { style: { flex: 1 } },
          el('div', { style: { fontWeight: 600 } }, d.name, d.core ? el('span', { class: 'badge', text: '常驻' }) : null, dup(d) ? el('span', { class: 'badge', text: '已有同名' }) : null),
          el('div', { class: 'hint', style: { marginTop: '4px' }, text: (d.initial || d.base || '').slice(0, 120) }))));
      return cb;
    });
    s.foot.replaceChildren(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const picked = drafts.filter((_, i) => checks[i].checked);
          story.cards.push(...picked);
          await saveNow(); s.close(); toast(`加了 ${picked.length} 张角色卡，记得逐个过目`); redraw();
        },
      }, '添加选中的'));
  }

  draw();
  return () => window.removeEventListener('moyu:cards', onCards);
}
