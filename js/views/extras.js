// 墨游 · 番外册：列表、新建、阅读与重写

import { db } from '../db.js';
import { el, uid, toast, menu, sheet, promptText, ago, approxTokens } from '../util.js';
import { resolveConnection, connLabel, getModules, go, setCurrentStory } from '../state.js';
import { streamWithRetry, ApiError } from '../api.js';
import { normalizeUsage, computeCost, fmtMoney, fmtTokens, recordUsage } from '../cost.js';
import { getTemplates, getBase, buildExtraContext, chaptersOf, extraBlocks, SCOPES, LENGTHS } from '../fanwai.js';

const SCOPE_SHORT = { all: '全知', public: '只知道公开的事', char: '视角角色所知' };

function pathTo(nodes, nodeId) {
  const out = [];
  let cur = nodeId ? nodes.get(nodeId) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
  return out;
}

function sw(checked) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  return { input, el: el('label', { class: 'switch' }, input, el('span')) };
}

function curVersion(x) { return x.versions?.[x.cur ?? 0] || null; }
function extraTitle(x) {
  const v = curVersion(x);
  const t = v?.text ? extraBlocks(v.text).title : '';
  return t || x.tplName || '番外';
}
function metaLine(x) {
  return [x.tplName || '自定义', x.anchorNo > 0 ? `第 ${x.anchorNo} 章之后` : '正史开始前', SCOPE_SHORT[x.scopeUsed] || '', x.pov ? '视角：' + x.pov : ''].filter(Boolean).join(' · ');
}

export async function render(root, { id, extraId }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
  const nodes = new Map((await db.byStory(id)).map((n) => [n.id, n]));
  if (extraId) return renderReader(root, story, nodes, extraId);
  return renderList(root, story, nodes);
}

// ───────────── 列表 ─────────────
async function renderList(root, story, nodes) {
  const extras = (await db.extrasOf(story.id)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const wrap = el('div', { class: 'wrap' });
  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('div', { class: 'title', style: { paddingLeft: '6px', minHeight: '36px', display: 'flex', flexDirection: 'column', justifyContent: 'center' } }, '番外', el('div', { class: 'sub', text: story.title || '未命名故事' }))),
    el('div', { class: 'scroll' }, wrap)));

  wrap.append(el('button', { class: 'btn primary block', style: { margin: '4px 0 12px' }, onclick: () => newExtra(story, nodes) }, '✦ 写一篇番外'));
  if (!extras.length) wrap.append(el('div', { class: 'empty', style: { padding: '28px 8px' } }, '还没有番外。', el('br'), '论坛体、日记体、采访……或者写一句突然想到的点子。'));
  // 按形式筛选（照老版碎片集）
  const kinds = [...new Set(extras.map((x) => x.tplName || '自定义'))];
  const list = el('div');
  let filter = '';
  const drawList = () => {
    list.replaceChildren();
    for (const x of extras) {
      if (filter && (x.tplName || '自定义') !== filter) continue;
      list.append(itemEl(x));
    }
  };
  if (kinds.length > 1) {
    const bar = el('div', { class: 'filters' });
    const chips = [['', '全部'], ...kinds.map((k) => [k, k])].map(([k, label]) => {
      const b = el('button', { class: 'chip' + (k === filter ? ' on' : ''), onclick: () => { filter = k; chips.forEach((c) => c.classList.toggle('on', c === b)); drawList(); } }, label);
      return b;
    });
    bar.append(...chips);
    wrap.append(bar);
  }
  wrap.append(list);
  function itemEl(x) {
    const v = curVersion(x);
    const first = v?.text ? (extraBlocks(v.text).blocks[0] || '') : '';
    return el('div', { class: 'card story-card', onclick: () => go(`extra/${encodeURIComponent(story.id)}/${encodeURIComponent(x.id)}`) },
      el('div', { class: 't' }, el('span', { text: extraTitle(x) }), (x.versions?.length || 0) > 1 ? el('span', { class: 'badge', text: `${x.versions.length} 个版本` }) : null),
      el('div', { class: 'm', text: metaLine(x) }),
      first ? el('div', { class: 'm clamp', style: { color: 'var(--text3)' }, text: first.replace(/\s+/g, ' ').slice(0, 80) }) : null,
      el('div', { class: 'd', text: ago(x.updatedAt) }));
  }
  drawList();
  wrap.append(el('div', { class: 'hint', style: { marginTop: '16px' } },
    '番外单独存放：不改正史，也不会作为前情发给正文。想互动着玩 IF 线，用正文某一章的“回到这里”开分支。',
    el('br'), el('a', { href: 'javascript:void 0', onclick: () => go('settings/fanwai') }, '管理番外模板和通用要求')));
}

// ───────────── 新建 ─────────────
async function newExtra(story, nodes) {
  const templates = await getTemplates();
  const modules = await getModules();
  const enabledAlways = modules.filter((m) => m.mode !== 'manual' && m.mode !== 'keyword' && story.modules?.[m.id]);
  const chapters = chaptersOf(pathTo(nodes, story.headId));
  const cards = (story.cards || []).filter((c) => c.name?.trim());
  const s = sheet({ title: '写一篇番外' });

  const tplSel = el('select');
  templates.forEach((t) => tplSel.append(el('option', { value: t.id }, t.name)));
  tplSel.append(el('option', { value: '__custom' }, '自定义（自己写要求）'));
  const req = el('textarea', { style: { minHeight: '80px' } });
  const povSel = el('select');
  povSel.append(el('option', { value: '' }, '不指定'));
  cards.forEach((c) => povSel.append(el('option', { value: c.name }, c.name)));
  const povFree = el('input', { type: 'text', placeholder: '没建卡的角色，直接写名字' });
  const anchorSel = el('select');
  anchorSel.append(el('option', { value: String(chapters.length) }, chapters.length ? `当前进度（第 ${chapters.length} 章之后）` : '正史还没开始'));
  [...chapters].reverse().slice(1).forEach((c) => anchorSel.append(el('option', { value: String(c.no) }, `第 ${c.no} 章之后${c.title ? ' · ' + c.title : ''}`)));
  const recent = el('input', { type: 'number', min: '0', max: '20', step: '1' }); recent.value = '6';
  const pinBox = el('div');
  const pinChecks = chapters.map((c) => {
    const cb = el('input', { type: 'checkbox', value: String(c.no) });
    pinBox.append(el('label', { class: 'switch-row', style: { justifyContent: 'flex-start', gap: '10px', padding: '6px 0' } }, cb,
      el('div', { class: 'lbl', style: { fontSize: '14px' } }, `第 ${c.no} 章${c.title ? ' · ' + c.title : ''}`, c.said ? el('small', { text: c.said.slice(0, 40) }) : null)));
    return cb;
  });
  const scopeSel = el('select');
  for (const [k, v] of Object.entries(SCOPES)) scopeSel.append(el('option', { value: k }, v));
  let length = 'mid';
  const lenSeg = el('div', { class: 'seg' });
  for (const [k, [label, n]] of Object.entries(LENGTHS)) {
    const b = el('button', { class: k === length ? 'on' : '', onclick: () => { length = k; lenSeg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); } }, `${label} · 约${n}字`);
    lenSeg.append(b);
  }
  const withMods = sw(true);
  const tplHint = el('div', { class: 'hint' });
  const syncTpl = () => {
    const t = templates.find((x) => x.id === tplSel.value);
    req.placeholder = t ? '这次想看什么？可以不填。例：他们吵架那晚，八卦组在扒' : '想看什么就写什么。例：如果他们小时候就认识；二十年后的同学会';
    tplHint.textContent = t ? `${SCOPE_SHORT[t.scope] ? '默认知情范围：' + SCOPE_SHORT[t.scope] + '。' : ''}${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}` : '自定义番外：要求写得越具体越好。写完满意的话，可以在设置里存成模板。';
  };
  tplSel.addEventListener('change', syncTpl); syncTpl();

  s.body.append(...[
    el('div', { class: 'field' }, el('label', { text: '形式' }), tplSel, tplHint),
    el('div', { class: 'field' }, el('label', { text: '要求' }), req),
    el('div', { class: 'field' }, el('label', { text: '视角角色（日记、采访这类要选）' }), povSel, el('div', { style: { height: '6px' } }), povFree),
    el('div', { class: 'field' }, el('label', { text: '时间点' }), anchorSel, el('div', { class: 'hint', text: '时间点之后的正史一律不发给模型，番外就不会提前写到。' })),
    el('div', { class: 'field' }, el('label', { text: '带上时间点前最近几章的原文' }), recent, el('div', { class: 'hint', text: '让模型熟悉人物口吻和最近发生的事。更早的剧情可以在下面单独指定。' })),
    chapters.length ? el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer' }, text: '额外指定章节作素材（可选）' }), pinBox) : null,
    el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { text: '知情范围' }), scopeSel),
    el('div', { class: 'field' }, el('label', { text: '篇幅' }), lenSeg),
    enabledAlways.length ? el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '带上这个故事的规则模块', el('small', { text: enabledAlways.map((m) => m.name).join('、') + '（不带正文的游玩规则）' })), withMods.el) : null,
  ].filter(Boolean));
  s.foot.append(
    el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const t = templates.find((x) => x.id === tplSel.value) || null;
        if (!t && !req.value.trim()) { toast('自定义番外要写一下想看什么'); return; }
        const anchorNo = Number(anchorSel.value) || 0;
        const anchorCh = chapters.find((c) => c.no === anchorNo);
        const x = {
          id: uid(), storyId: story.id, createdAt: Date.now(), updatedAt: Date.now(),
          tplName: t ? t.name : '自定义', tplText: t ? t.text : '', tplScope: t ? t.scope : 'all',
          request: req.value.trim(), pov: (povFree.value.trim() || povSel.value || '').trim(),
          scope: scopeSel.value, anchorId: anchorCh ? anchorCh.id : null, anchorNo,
          recentN: Math.max(0, Math.min(20, Number(recent.value) || 0)),
          pinned: pinChecks.filter((c) => c.checked).map((c) => Number(c.value)),
          length, withModules: enabledAlways.length ? withMods.input.checked : false,
          versions: [], cur: 0, pending: true,
        };
        x.scopeUsed = x.scope !== 'follow' ? x.scope : x.tplScope;
        await db.put('extras', x);
        s.close();
        go(`extra/${encodeURIComponent(story.id)}/${encodeURIComponent(x.id)}`);
      },
    }, '开始写'));
}

// ───────────── 阅读与重写 ─────────────
async function renderReader(root, story, nodes, extraId) {
  const x = await db.get('extras', extraId);
  if (!x) { toast('找不到这篇番外'); go(`extra/${encodeURIComponent(story.id)}`); return; }
  // 上次没写完就被打断的
  for (const v of x.versions || []) if (v.status === 'streaming') { v.status = v.text?.trim() ? 'partial' : 'error'; v.error = { message: '生成被中断了', hint: '可以点“接着写”或“重写”。' }; }

  const st = { streaming: null, lastCtx: null, frame: 0 };
  let destroyed = false;
  const titleEl = el('div', { class: 'title' });
  const content = el('div', { class: 'feed' });
  const scroller = el('div', { class: 'scroll' }, content);
  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go(`extra/${encodeURIComponent(story.id)}`) }, '‹'),
      titleEl,
      el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: () => moreMenu() }, '⋯')),
    scroller));

  const save = () => { x.updatedAt = Date.now(); return db.put('extras', x).catch(() => {}); };
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;

  function draw({ stick = false } = {}) {
    const keep = stick && nearBottom();
    const v = curVersion(x);
    titleEl.replaceChildren(extraTitle(x), el('div', { class: 'sub', text: '番外 · 不进正史' }));
    content.replaceChildren();
    content.append(el('div', { class: 'card', style: { fontFamily: 'var(--ui-font)', fontSize: '13.5px', marginTop: '8px' } },
      el('div', { class: 'muted', text: metaLine(x) }),
      x.request ? el('div', { style: { marginTop: '4px' }, text: '要求：' + x.request }) : null));
    const g = el('div', { class: 'gm' });
    const live = !!st.streaming;
    if (v?.text) {
      const { title, blocks } = extraBlocks(v.text);
      if (title) g.append(el('h2', { text: title, style: { marginTop: '14px' } }));
      blocks.forEach((b, i) => g.append(el('p', { class: [b.includes('\n') ? 'fw' : '', live && i === blocks.length - 1 ? 'cursor' : ''].filter(Boolean).join(' ') || null, text: b })));
    } else if (live) {
      g.append(el('div', { class: 'thinking', style: { marginTop: '14px' }, text: v?.thinking ? '模型思考中' : '正在构思' }));
    }
    content.append(g);
    if (!live && v) {
      if (v.stopped && v.text?.trim()) content.append(el('div', { class: 'note', text: '已停止，这篇没写完。' }));
      else if (v.status === 'partial' && !v.error) content.append(el('div', { class: 'note', text: '达到输出上限，没写完。可以点“接着写”。' }));
      if (v.error) content.append(errorBox(v.error));
    }
    const tools = el('div', { class: 'tools', style: { margin: '14px 0 30px' } });
    if (live) tools.append(el('button', { class: 'btn small danger', onclick: () => st.streaming?.ctrl.abort('user') }, '停止'));
    else {
      if ((x.versions?.length || 0) > 1) {
        const i = x.cur ?? 0;
        const prev = el('button', { 'aria-label': '上一个版本', onclick: async () => { x.cur = i - 1; await save(); draw(); } }, '‹');
        const next = el('button', { 'aria-label': '下一个版本', onclick: async () => { x.cur = i + 1; await save(); draw(); } }, '›');
        prev.disabled = i <= 0; next.disabled = i >= x.versions.length - 1;
        tools.append(el('span', { class: 'ver' }, prev, `${i + 1}/${x.versions.length}`, next));
      }
      tools.append(...[
        el('button', { class: 'btn small', onclick: () => generate('new') }, v ? '重写' : '开始写'),
        v ? el('button', { class: 'btn small', onclick: async () => {
          const r = await promptText({ title: '换个要求重写', value: x.request, placeholder: '这次想看什么？', okText: '重写' });
          if (r == null) return;
          x.request = r.trim(); await save(); generate('new');
        } }, '换个要求') : null,
        v?.text?.trim() ? el('button', { class: 'btn small primary', onclick: () => generate('continue') }, '接着写') : null,
      ].filter(Boolean));
      if (v?.cost || v?.usageN) {
        tools.append(el('button', {
          class: 'meta', style: { border: 0, background: 'transparent', cursor: 'pointer', padding: '4px 0' },
          onclick: () => { const u = v.usageN; if (u) toast(`${u.est ? '粗估' : ''}输入 ${fmtTokens(u.input)} · 输出 ${fmtTokens(u.output)}${v.cost ? ' · ' + fmtMoney(v.cost) : ''}`, 4000); },
        }, [v.model, v.cost ? fmtMoney(v.cost) : fmtTokens((v.usageN?.input || 0) + (v.usageN?.output || 0)) + ' token'].filter(Boolean).join(' · ')));
      }
    }
    content.append(tools);
    if (keep) scroller.scrollTop = scroller.scrollHeight;
  }

  function errorBox(err) {
    const box = el('div', { class: 'err' }, el('div', { class: 'h', text: '⚠ ' + (err.message || '出错了') }));
    if (err.hint) box.append(el('div', { class: 'hint', text: err.hint }));
    if (err.detail) box.append(el('pre', { text: [err.url, err.detail].filter(Boolean).join('\n') }));
    return box;
  }

  async function buildCtx() {
    const modules = x.withModules ? (await getModules()).filter((m) => m.mode !== 'manual' && m.mode !== 'keyword' && story.modules?.[m.id]) : [];
    const base = await getBase();
    const path = x.anchorId ? pathTo(nodes, x.anchorId) : [];
    const chapters = chaptersOf(path);
    return buildExtraContext(story, {
      chapters, anchorNo: chapters.length, recentN: x.recentN, pinned: x.pinned || [],
      template: { name: x.tplName, text: x.tplText, scope: x.tplScope }, request: x.request, scope: x.scope, pov: x.pov,
      length: x.length, modules, base,
    });
  }

  async function generate(mode) {
    if (st.streaming) return;
    const conn = await resolveConnection(story);
    const ctx = await buildCtx();
    st.lastCtx = ctx;
    let v;
    let base = '';
    const messages = [...ctx.messages];
    if (mode === 'continue') {
      v = curVersion(x);
      base = v.text || '';
      messages.push({ role: 'assistant', content: base }, { role: 'user', content: '（接着上面的内容往下写，直接续写，不要重复已经写过的部分，不要加开场白。）' });
    } else {
      v = { text: '', createdAt: Date.now() };
      x.versions = x.versions || [];
      x.versions.push(v);
      x.cur = x.versions.length - 1;
    }
    v.status = 'streaming'; v.error = null; v.stopped = false; v.thinking = false; v.model = conn?.model || '';
    delete x.pending;
    await save();
    const ctrl = new AbortController();
    st.streaming = { ctrl };
    draw();
    let usageRaw = null;
    let lastSave = 0;
    try {
      const r = await streamWithRetry(conn, {
        system: ctx.system, messages, signal: ctrl.signal, maxTokens: Math.max(Number(conn?.maxTokens) || 4000, x.length === 'long' ? 8000 : 4000),
        onText: (_d, full) => {
          v.text = base + full; v.thinking = false;
          if (!st.frame) st.frame = requestAnimationFrame(() => { st.frame = 0; if (!destroyed) draw({ stick: true }); });
          const now = Date.now(); if (now - lastSave > 1500) { lastSave = now; save(); }
        },
        onThinking: () => { if (!v.thinking && !v.text) { v.thinking = true; draw(); } },
      }, { onConnPatch: (p) => { if (conn) { Object.assign(conn, p); db.put('connections', { ...conn }).catch(() => {}); } } });
      v.text = base + r.text;
      v.status = r.truncated ? 'partial' : 'done';
      usageRaw = r.usage || null;
    } catch (e) {
      const err = e instanceof ApiError ? e.toJSON() : { message: String(e?.message || e) };
      v.text = base + (e?.partial || '');
      const has = !!v.text.trim();
      if (err.kind === 'aborted') { v.stopped = has; v.status = has ? 'partial' : 'error'; v.error = has ? null : { message: '已停止', hint: '还没写出内容就停下了，可以点“重写”。' }; }
      else { v.status = has ? 'partial' : 'error'; v.error = err; }
    } finally {
      if (st.frame) { cancelAnimationFrame(st.frame); st.frame = 0; }
      st.streaming = null;
      v.thinking = false;
      const outChars = Math.max(0, (v.text || '').length - base.length);
      if (outChars > 0 || usageRaw) {
        const u = normalizeUsage(usageRaw, { inChars: ctx.info.totalChars + base.length, outChars });
        const c = computeCost(u, conn);
        if (mode === 'continue' && v.usageN) {
          v.usageN = { input: v.usageN.input + u.input, cached: (v.usageN.cached || 0) + u.cached, output: v.usageN.output + u.output, est: v.usageN.est || u.est };
          v.cost = c && v.cost && v.cost.currency === c.currency ? { ...c, amount: v.cost.amount + c.amount, est: v.cost.est || c.est } : (c || v.cost || null);
        } else { v.usageN = u; v.cost = c; }
        recordUsage({ kind: '番外', storyId: story.id, model: conn.model, usage: u, cost: c });
      }
      await save();
      if (!destroyed) draw();
    }
  }

  async function moreMenu() {
    if (st.streaming) return;
    const v = curVersion(x);
    const k = await menu(extraTitle(x), [
      v ? { key: 'edit', label: '修改文字' } : null,
      v ? { key: 'copy', label: '复制全文' } : null,
      { key: 'ctx', label: '查看发给模型的内容', hint: '这篇用了哪几章、哪些角色卡' },
      v && x.versions.length > 1 ? { key: 'delv', label: '删除当前这个版本', danger: true } : null,
      { key: 'del', label: '删除这篇番外', danger: true },
    ]);
    if (k === 'copy') navigator.clipboard?.writeText(v.text || '').then(() => toast('已复制'), () => toast('复制失败'));
    else if (k === 'edit') {
      const s = sheet({ title: '修改番外' });
      const area = el('textarea', { style: { minHeight: '56vh' } });
      area.value = v.text || '';
      s.body.append(el('div', { class: 'field' }, area));
      s.foot.append(el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
        el('button', { class: 'btn primary', onclick: async () => { v.text = area.value; v.edited = true; await save(); s.close(); toast('已修改'); draw(); } }, '保存'));
    } else if (k === 'ctx') {
      const ctx = st.lastCtx || await buildCtx();
      const s = sheet({ title: '这篇番外发给模型的内容' });
      s.body.append(
        el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '10px' } }, `共约 ${ctx.info.totalChars.toLocaleString()} 字（粗估约 ${approxTokens(ctx.info.totalChars).toLocaleString()} token）。正史素材：${ctx.info.chapters.length ? '第 ' + ctx.info.chapters.join('、') + ' 章' : '无'}；角色卡：${ctx.info.cards.join('、') || '无'}。`),
        ...ctx.info.parts.map((p) => el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer', fontSize: '14px' }, text: `${p.label} · ${p.chars.toLocaleString()} 字` }), el('pre', { class: 'raw', text: p.text }))),
        el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer', fontSize: '14px' }, text: '最后的要求' }), el('pre', { class: 'raw', text: ctx.messages[0].content })));
      s.foot.append(el('button', { class: 'btn primary', onclick: () => s.close() }, '关闭'));
    } else if (k === 'delv') {
      if (!confirm('删除当前这个版本？')) return;
      x.versions.splice(x.cur, 1); x.cur = Math.max(0, Math.min(x.cur, x.versions.length - 1)); await save(); draw();
    } else if (k === 'del') {
      if (!confirm('删除这篇番外？')) return;
      await db.del('extras', x.id); toast('已删除'); go(`extra/${encodeURIComponent(story.id)}`);
    }
  }

  draw();
  if (x.pending) generate('new');
  return () => { destroyed = true; if (st.streaming) st.streaming.ctrl.abort('leave'); };
}
