// 墨游 · 小工具

export const APP_VERSION = '0.7.0';

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 建一个元素：el('div', {class:'x', onclick:fn}, '文字', childEl) */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

let toastTimer = null;
export function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function ago(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function approxTokens(chars) {
  // 中文大约一字一个 token 上下，只作粗估
  return Math.round(chars * 1.0);
}

/** 底部弹出层。返回 { close, body, foot } */
export function sheet({ title = '', onClose } = {}) {
  const body = el('div', { class: 'sb' });
  const foot = el('div', { class: 'sf' });
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'sh' },
      el('div', { class: 't', text: title }),
      el('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: () => close() }, '✕')
    ),
    body, foot
  );
  const backdrop = el('div', { class: 'sheet-backdrop' }, panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    onClose && onClose();
  }
  return { close, body, foot, panel };
}

/** 简单的选择菜单，返回被点的 key（或 null） */
export function menu(title, items) {
  return new Promise((resolve) => {
    let picked = null;
    const s = sheet({ title, onClose: () => resolve(picked) });
    const list = el('div', { class: 'menu-list' });
    for (const it of items) {
      if (!it) continue;
      list.append(el('button', {
        class: it.danger ? 'danger' : '',
        onclick: () => { picked = it.key; s.close(); },
      }, it.label, it.hint ? el('small', { text: it.hint }) : null));
    }
    s.body.append(list);
    s.foot.remove();
  });
}

/** 一行或多行文字输入，返回字符串（取消返回 null） */
export function promptText({ title, value = '', placeholder = '', hint = '', okText = '确定', multiline = true }) {
  return new Promise((resolve) => {
    let result = null;
    const s = sheet({ title, onClose: () => resolve(result) });
    const input = multiline
      ? el('textarea', { placeholder, style: { minHeight: '120px' } })
      : el('input', { type: 'text', placeholder });
    input.value = value;
    s.body.append(el('div', { class: 'field' }, input, hint ? el('div', { class: 'hint', text: hint }) : null));
    s.foot.append(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', { class: 'btn primary', onclick: () => { result = input.value; s.close(); } }, okText)
    );
    setTimeout(() => input.focus(), 60);
  });
}

/** 保存文件：iOS 上优先走分享面板（可存到“文件”或隔空投送），其他情况直接下载 */
export async function saveFile(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: filename });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return true;
}

export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const inp = el('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: String(r.result || '') });
      r.onerror = () => resolve(null);
      r.readAsText(f, 'utf-8');
    });
    document.body.append(inp);
    inp.click();
  });
}

export function autoGrow(ta, max = 0.38) {
  const fit = () => {
    ta.style.height = 'auto';
    const limit = Math.round(window.innerHeight * max);
    ta.style.height = Math.min(ta.scrollHeight + 2, limit) + 'px';
  };
  ta.addEventListener('input', fit);
  fit();
  return fit;
}

export function insertAtCursor(ta, before, after = '') {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  const v = ta.value;
  ta.value = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
  const pos = s + before.length + (e - s);
  ta.focus();
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
}
