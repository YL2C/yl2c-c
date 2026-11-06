// yl2c · 讨论页：列表 + 单个讨论

import { db } from '../db.js';
import { el, toast, sheet, menu, promptText, autoGrow, ago } from '../util.js';
import { go, getConnections, resolveConnection, connLabel, getGlobalMemo, setGlobalMemo } from '../state.js';
import { streamWithRetry, ApiError } from '../api.js';
import { normalizeUsage, computeCost, fmtMoney, recordUsage } from '../cost.js';
import { openStoryEditor } from './story-edit.js';
import {
  listDiscussions, getDiscussion, saveDiscussion, deleteDiscussion, newDiscussion,
  buildDiscussContext, chatMessages, changesPrompt, parseChanges, describeChange, applyChanges,
  loadStoryState, getUndo, undoLast, NEWSTORY_PROMPT, parseNewStory,
} from '../discuss.js';

export async function render(root, { id }) {
  if (id) return renderChat(root, id);
  return renderList(root);
}

// ───────────── 列表 ─────────────
async function renderList(root) {
  const [list, stories, memo] = await Promise.all([listDiscussions(), db.all('stories'), getGlobalMemo()]);
  const titleOf = new Map(stories.map((s) => [s.id, s.title || '未命名故事']));
  const wrap = el('div', { class: 'wrap' });

  const start = async () => {
    const items = [{ key: '', label: '🌐 全局', hint: '所有故事通用的写法、规则、偏好；也能聊出新故事' }];
    stories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((s) => items.push({ key: s.id, label: '📖 ' + (s.title || '未命名故事'), hint: '读这个故事的设定、角色卡和前情档案' }));
    const k = await menu('讨论什么？', items);
    if (k === null) return;
    const d = newDiscussion(k, k ? titleOf.get(k) : '全局');
    await saveDiscussion(d);
    go('discuss/' + encodeURIComponent(d.id));
  };

  wrap.append(
    el('button', { class: 'btn primary block', style: { margin: '4px 0 12px' }, onclick: start }, '＋ 新讨论'),
    el('div', { class: 'card', style: { cursor: 'pointer' }, onclick: async () => {
      const v = await promptText({ title: '全局备忘', value: memo, hint: '所有故事每一轮都会带上这里的内容，越短越省钱。讨论里“整理成修改”选了“全局”的规则会追加到这里。', okText: '保存' });
      if (v === null) return;
      await setGlobalMemo(v.trim());
      toast('已保存');
      go('discuss');
    } },
      el('div', { style: { fontWeight: '600' } }, '🌐 全局备忘'),
      el('div', { class: 'hint', style: { marginTop: '4px' }, text: memo ? `${memo.length} 字 · 每个故事每轮都会带上 · 点开修改` : '空的。所有故事每一轮都会带上这里的内容。' })),
  );

  if (!list.length) wrap.append(el('div', { class: 'empty' }, '还没有讨论。', el('br'), '可以选一个故事，聊人设、纠正剧情，聊完一键写回。'));
  for (const x of list) {
    const scope = x.storyId ? (titleOf.get(x.storyId) || '（故事已删除）') : '全局';
    wrap.append(el('div', { class: 'card story-card', onclick: () => go('discuss/' + encodeURIComponent(x.id)) },
      el('div', { class: 't' }, el('span', { text: x.title || scope }),
        el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: async (e) => {
          e.stopPropagation();
          const k = await menu(x.title || scope, [{ key: 'rename', label: '重命名' }, { key: 'del', label: '删除', danger: true }]);
          if (k === 'rename') {
            const d = await getDiscussion(x.id);
            const v = await promptText({ title: '重命名', value: d.title, multiline: false });
            if (v?.trim()) { d.title = v.trim(); await saveDiscussion(d); go('discuss'); }
          } else if (k === 'del' && confirm('删除这个讨论？已经写回的修改不受影响。')) { await deleteDiscussion(x.id); go('discuss'); }
        } }, '⋯')),
      el('div', { class: 'm', text: (x.storyId ? '📖 ' : '🌐 ') + scope + ` · ${x.count || 0} 条` }),
      el('div', { class: 'd', text: ago(x.updatedAt) })));
  }

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' }, el('div', { class: 'title', style: { paddingLeft: '6px', minHeight: '36px', display: 'flex', alignItems: 'center' } }, '讨论')),
    el('div', { class: 'scroll' }, wrap)));
}

// ───────────── 单个讨论 ─────────────
async function renderChat(root, id) {
  const d = await getDiscussion(id);
  if (!d) { toast('找不到这个讨论'); go('discuss'); return; }
  const storyTitle = d.storyId ? ((await db.get('stories', d.storyId))?.title || '（故事已删除）') : '全局';
  let conn = null;
  const pickConn = async () => {
    const list = await getConnections();
    conn = (d.connId && list.find((c) => c.id === d.connId)) || (d.storyId ? await resolveConnection(await db.get('stories', d.storyId)) : await resolveConnection(null));
  };
  await pickConn();
  let ctrl = null;
  let destroyed = false;

  const titleEl = el('div', { class: 'title' });
  const chip = el('button', { class: 'model-chip', onclick: () => chooseConn() });
  const feed = el('div', { class: 'feed disc-feed' });
  const scroller = el('div', { class: 'scroll' }, feed);
  const ta = el('textarea', { rows: 1, placeholder: d.storyId ? '比如：程岘最近太软了，他不会主动道歉……' : '比如：以后所有故事男主都不要动不动红眼眶' });
  const sendBtn = el('button', { class: 'send', onclick: () => (ctrl ? ctrl.abort() : onSend()) }, '发送');
  const chipChanges = el('button', { class: 'chip', onclick: () => makeChanges() }, '✍️ 整理成修改');
  const chipNew = el('button', { class: 'chip', onclick: () => makeNewStory() }, '＋ 生成新故事');
  const chipCh = el('button', { class: 'chip', onclick: () => chooseChapters() });
  const composer = el('div', { class: 'composer' },
    el('div', { class: 'bar' }, chipChanges, d.storyId ? chipCh : null, chipNew),
    el('div', { class: 'inrow' }, ta, sendBtn));
  autoGrow(ta);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); } });

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go('discuss') }, '‹'),
      titleEl, chip,
      el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: () => moreMenu() }, '⋯')),
    scroller, composer));

  async function header() {
    let chars = 0;
    try { chars = (await buildDiscussContext(d)).system.length; } catch {}
    titleEl.replaceChildren(d.title || storyTitle, el('div', { class: 'sub', text: `${d.storyId ? '📖 ' + storyTitle : '🌐 全局'} · 资料约 ${chars} 字` }));
    chip.textContent = conn ? connLabel(conn) : '未连接';
    chip.classList.toggle('warn', !conn);
    chipCh.textContent = d.chapters ? `带原文 ${d.chapters} 章` : '不带原文';
    chipCh.classList.toggle('on', !!d.chapters);
  }

  function bubble(m) {
    if (m.role === 'note') {
      return el('div', { class: 'disc-note' }, el('div', { text: m.content }),
        m.undo ? el('button', { class: 'btn small ghost', style: { marginTop: '6px' }, onclick: async () => {
          const u = await getUndo();
          if (!u || u.at !== m.undo) { toast('只能撤销最近一次写回'); return; }
          if (!confirm('撤销这次写回？设定、角色卡、前情档案和全局备忘会回到写回之前。')) return;
          await undoLast();
          m.content += '\n（已撤销）';
          delete m.undo;
          await saveDiscussion(d);
          draw();
          toast('已撤销');
        } }, '撤销这次写回') : null);
    }
    const body = el('div', { class: 'disc-text', text: m.content || (m.streaming ? '…' : '') });
    const meta = [m.cost ? fmtMoney(m.cost) : '', m.error || ''].filter(Boolean).join(' · ');
    return el('div', { class: 'disc-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.error ? ' err' : '') }, body, meta ? el('div', { class: 'disc-meta', text: meta }) : null);
  }

  function draw(stick = true) {
    if (!d.messages.length) {
      feed.replaceChildren(el('div', { class: 'empty' },
        d.storyId ? `会带上「${storyTitle}」的设定、角色卡和前情档案。` : '会带上全局备忘、默认规则和规则模块库。',
        el('br'), '聊完点下面的“整理成修改”，确认后写回。'));
      return;
    }
    feed.replaceChildren(...d.messages.map(bubble));
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  async function callModel(system, messages, maxTokens, onText) {
    if (!conn) { toast('先在设置里添加一个连接'); throw new Error('no conn'); }
    ctrl = new AbortController();
    sendBtn.textContent = '停止';
    sendBtn.classList.add('stop');
    try {
      const r = await streamWithRetry(conn, { system, messages, maxTokens, signal: ctrl.signal, onText: (_, full) => onText && onText(full) });
      const inChars = system.length + messages.reduce((a, m) => a + m.content.length, 0);
      const u = normalizeUsage(r.usage, { inChars, outChars: r.text.length });
      return { text: r.text, cost: computeCost(u, conn), usage: u };
    } finally {
      ctrl = null;
      sendBtn.textContent = '发送';
      sendBtn.classList.remove('stop');
    }
  }

  async function onSend() {
    const text = ta.value.trim();
    if (!text) return;
    if (!conn) { toast('先在设置里添加一个连接'); return; }
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
    d.messages.push({ role: 'user', content: text });
    if (d.messages.filter((m) => m.role === 'user').length === 1 && (!d.title || d.title === storyTitle)) d.title = text.slice(0, 18);
    const a = { role: 'assistant', content: '', streaming: true };
    d.messages.push(a);
    draw();
    await saveDiscussion(d);
    let last = 0;
    try {
      const { system } = await buildDiscussContext(d);
      const msgs = chatMessages({ messages: d.messages.slice(0, -1) });
      const r = await callModel(system, msgs, Number(conn.maxTokens) || 8000, (full) => {
        a.content = full;
        const node = feed.lastChild?.querySelector('.disc-text');
        if (node) node.textContent = full;
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) scroller.scrollTop = scroller.scrollHeight;
        if (Date.now() - last > 1500) { last = Date.now(); saveDiscussion(d).catch(() => {}); }
      });
      a.content = r.text;
      a.cost = r.cost;
      recordUsage({ kind: '讨论', storyId: d.storyId, model: conn.model, usage: r.usage, cost: r.cost });
    } catch (e) {
      if (e?.message !== 'no conn') {
        a.content = e?.partial || a.content || '';
        a.error = e instanceof ApiError && e.kind === 'aborted' ? '已停止' : '出错：' + (e?.message || e);
        if (!a.content.trim()) { d.messages.pop(); d.messages.pop(); ta.value = text; ta.dispatchEvent(new Event('input')); toast(a.error, 4000); }
      }
    }
    delete a.streaming;
    await saveDiscussion(d);
    if (!destroyed) draw();
  }

  async function makeChanges() {
    if (ctrl) return;
    if (!d.messages.some((m) => m.role === 'assistant' && m.content?.trim())) { toast('先聊几句再整理'); return; }
    const s = sheet({ title: '整理成修改' });
    const status = el('div', { class: 'hint', text: '正在整理…（只调用一次，量不大）' });
    s.body.append(status);
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => { ctrl?.abort(); s.close(); } }, '取消'));
    let changes;
    let state;
    try {
      const { system } = await buildDiscussContext(d);
      const msgs = chatMessages(d);
      msgs.push({ role: 'user', content: changesPrompt(d) });
      if (msgs.length > 1 && msgs[msgs.length - 2].role === 'user') msgs.splice(msgs.length - 1, 0, { role: 'assistant', content: '（继续）' });
      const r = await callModel(system, msgs, 4000);
      recordUsage({ kind: '整理修改', storyId: d.storyId, model: conn.model, usage: r.usage, cost: r.cost });
      changes = parseChanges(r.text, !!d.storyId);
      state = d.storyId ? await loadStoryState(d.storyId) : null;
      status.textContent = changes.length ? `${changes.length} 条修改，默认全选。不要的取消勾选，文字可以直接改。${r.cost ? '（这次整理 ' + fmtMoney(r.cost) + '）' : ''}` : '讨论里没有找到可以写回的结论。';
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'aborted') return;
      status.textContent = '整理失败：' + (e?.message || e);
      return;
    }
    if (!changes.length) return;
    const list = el('div');
    const applyBtn = el('button', { class: 'btn primary' });
    const count = () => { const n = changes.filter((c) => c.on).length; applyBtn.textContent = n ? `写回 ${n} 条` : '写回'; applyBtn.disabled = !n; };
    for (const c of changes) {
      const lbl = el('span', { class: 'chg-lbl', text: describeChange(c, state) });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      cb.addEventListener('change', () => { c.on = cb.checked; item.classList.toggle('off', !c.on); count(); });
      const txt = el('textarea', { class: 'chg-text' });
      txt.value = c.text;
      txt.addEventListener('input', () => { c.text = txt.value; });
      let dest = null;
      if (c.target === 'rules' && d.storyId) {
        const b1 = el('button', { class: 'seg' }, '本故事规则');
        const b2 = el('button', { class: 'seg' }, '全局');
        const set = (v) => { c.dest = v; b1.classList.toggle('on', v === 'story'); b2.classList.toggle('on', v === 'global'); lbl.textContent = describeChange(c, state); };
        b1.onclick = () => set('story');
        b2.onclick = () => set('global');
        set(c.dest || 'story');
        dest = el('div', { class: 'segs' }, b1, b2);
      }
      const item = el('div', { class: 'card chg' },
        el('label', { class: 'chg-head' }, cb, lbl),
        dest,
        c.target === 'world' && c.op === 'replace' && c.old ? el('div', { class: 'chg-old', text: '原文：' + c.old }) : null,
        txt,
        c.why ? el('div', { class: 'hint', text: c.why }) : null);
      list.append(item);
      setTimeout(() => autoGrow(txt, 0.3), 0);
    }
    s.body.append(list);
    s.foot.replaceChildren(el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'), applyBtn);
    count();
    applyBtn.onclick = async () => {
      applyBtn.disabled = true;
      try {
        const { done, newStory } = await applyChanges(d, changes);
        const u = await getUndo();
        if (done.length) d.messages.push({ role: 'note', content: '已写回：\n' + done.map((x) => '· ' + x).join('\n'), undo: u?.at });
        await saveDiscussion(d);
        s.close();
        draw();
        header();
        toast('已写回');
        if (newStory) {
          const st = await openStoryEditor(null, newStory);
          if (st) go('play/' + encodeURIComponent(st.id));
        }
      } catch (e) { toast('写回失败：' + (e?.message || e), 4000); applyBtn.disabled = false; }
    };
  }

  async function makeNewStory() {
    if (ctrl) return;
    if (!d.messages.some((m) => m.role === 'assistant' && m.content?.trim())) { toast('先聊一聊新故事的设定，再生成'); return; }
    toast('正在根据讨论整理新故事…', 4000);
    try {
      const { system } = await buildDiscussContext(d);
      const msgs = chatMessages(d);
      if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.push({ role: 'assistant', content: '（继续）' });
      msgs.push({ role: 'user', content: NEWSTORY_PROMPT });
      const r = await callModel(system, msgs, 6000);
      recordUsage({ kind: '生成新故事', storyId: d.storyId, model: conn.model, usage: r.usage, cost: r.cost });
      const prefill = parseNewStory(r.text);
      const st = await openStoryEditor(null, prefill);
      if (st) go('play/' + encodeURIComponent(st.id));
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === 'aborted') && e?.message !== 'no conn') toast('生成失败：' + (e?.message || e), 4000);
    }
  }

  async function chooseChapters() {
    const k = await menu('讨论时带上最近几章原文？', [
      { key: '0', label: '不带', hint: '只带设定、角色卡和前情档案，最省' },
      { key: '3', label: '最近 3 章' }, { key: '5', label: '最近 5 章' }, { key: '10', label: '最近 10 章', hint: '每条消息都会多发这些字，费用明显增加' },
    ]);
    if (k === null) return;
    d.chapters = Number(k);
    await saveDiscussion(d);
    header();
  }

  async function chooseConn() {
    const list = await getConnections();
    if (!list.length) { go('settings/new'); return; }
    const k = await menu('这个讨论用哪个连接', list.map((c) => ({ key: c.id, label: connLabel(c), hint: c.model })));
    if (k === null) return;
    d.connId = k;
    await saveDiscussion(d);
    await pickConn();
    header();
  }

  async function moreMenu() {
    const k = await menu(d.title || storyTitle, [
      { key: 'ctx', label: '查看发给模型的资料' },
      d.storyId ? { key: 'go', label: '去这个故事' } : null,
      { key: 'pop', label: '删掉最后一轮' },
      { key: 'rename', label: '重命名' },
      { key: 'del', label: '删除这个讨论', danger: true },
    ]);
    if (k === 'ctx') {
      const { parts } = await buildDiscussContext(d);
      const s = sheet({ title: '每条消息都会带上的资料' });
      for (const p of parts) s.body.append(el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer', fontSize: '14px' }, text: `${p.label} · ${p.chars} 字` }), el('pre', { class: 'raw', text: p.text })));
      s.foot.remove();
    } else if (k === 'go') go('play/' + encodeURIComponent(d.storyId));
    else if (k === 'pop') {
      while (d.messages.length && d.messages[d.messages.length - 1].role !== 'user') d.messages.pop();
      const u = d.messages.pop();
      if (u) { ta.value = u.content; ta.dispatchEvent(new Event('input')); }
      await saveDiscussion(d);
      draw();
    } else if (k === 'rename') {
      const v = await promptText({ title: '重命名', value: d.title, multiline: false });
      if (v?.trim()) { d.title = v.trim(); await saveDiscussion(d); header(); }
    } else if (k === 'del' && confirm('删除这个讨论？已经写回的修改不受影响。')) { await deleteDiscussion(d.id); go('discuss'); }
  }

  // 上次生成中途离开的：标记一下
  for (const m of d.messages) if (m.streaming) { delete m.streaming; m.error = m.error || '生成被中断了'; }
  header();
  draw();
  return () => { destroyed = true; ctrl?.abort(); };
}
