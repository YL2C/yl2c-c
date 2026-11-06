// 墨游 · 启动与页面切换

import { ensurePersist } from './db.js';
import { loadPrefs } from './state.js';
import * as library from './views/library.js';
import * as play from './views/play.js';
import * as settings from './views/settings.js';
import * as storyPage from './views/story.js';
import * as extrasPage from './views/extras.js';
import * as memoryPage from './views/memory.js';
import * as charsPage from './views/chars.js';
import * as discussPage from './views/discuss.js';
import { getCurrentStory, setCurrentStory } from './state.js';

const root = document.getElementById('app');
let cleanup = null;
let routeToken = 0;

async function route() {
  const token = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg, arg2] = h.split('/');
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} }
  cleanup = null;
  let mod = library;
  const params = {};
  if (name === 'play' && arg) { mod = play; params.id = decodeURIComponent(arg); }
  else if (name === 'discuss') { mod = discussPage; params.id = arg ? decodeURIComponent(arg) : ''; }
  else if (name === 'settings') { mod = settings; params.section = arg || ''; }
  else if (name === 'memory' && arg) { mod = memoryPage; params.id = decodeURIComponent(arg); }
  else if (name === 'chars' && arg) { mod = charsPage; params.id = decodeURIComponent(arg); }
  else if (name === 'extra' && arg) { mod = extrasPage; params.id = decodeURIComponent(arg); params.extraId = arg2 ? decodeURIComponent(arg2) : ''; }
  else if (name === 'story' && arg && arg2 === 'cards') { location.replace('#/chars/' + arg); return; }
  else if (name === 'story' && arg) { mod = storyPage; params.id = decodeURIComponent(arg); params.tab = arg2 || 'setting'; }
  // 进了哪个故事，底部的“游玩 / 角色 / 番外”就指向哪个故事
  if (params.id && ['play', 'chars', 'extra', 'memory', 'story'].includes(name)) setCurrentStory(params.id);
  const container = document.createElement('div');
  container.className = 'view-host';
  const c = await mod.render(container, params);
  if (token !== routeToken) { if (typeof c === 'function') c(); return; }
  root.replaceChildren(container, tabBar(name));
  root.classList.add('has-tabs');
  cleanup = c;
}

// 底部菜单（照老版）：故事 / 游玩 / 角色 / 番外 / 设置
const TABS = [
  { key: 'home', icon: '📚', label: '故事', to: () => '' },
  { key: 'play', icon: '📖', label: '游玩', story: true, to: (id) => 'play/' + encodeURIComponent(id) },
  { key: 'chars', icon: '👤', label: '角色', story: true, to: (id) => 'chars/' + encodeURIComponent(id) },
  { key: 'extra', icon: '🎴', label: '番外', story: true, to: (id) => 'extra/' + encodeURIComponent(id) },
  { key: 'discuss', icon: '💬', label: '讨论', to: () => 'discuss' },
  { key: 'settings', icon: '⚙️', label: '设置', to: () => 'settings' },
];
const TAB_OF = { '': 'home', play: 'play', memory: 'play', story: 'play', chars: 'chars', extra: 'extra', discuss: 'discuss', settings: 'settings' };
function tabBar(routeName) {
  const active = TAB_OF[routeName || ''] || '';
  const cur = getCurrentStory();
  const bar = document.createElement('nav');
  bar.id = 'tabbar';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab' + (t.key === active ? ' on' : '') + (t.story && !cur ? ' off' : '');
    b.dataset.tab = t.key;
    b.innerHTML = '<span class="ic"></span><span class="lb"></span>';
    b.firstChild.textContent = t.icon;
    b.lastChild.textContent = t.label;
    b.addEventListener('click', () => {
      const id = getCurrentStory();
      if (t.story && !id) { import('./util.js').then((u) => u.toast('先在“故事”里选一个故事')); return; }
      const target = '#/' + t.to(id);
      if (location.hash === target || (target === '#/' && !location.hash.replace(/^#\/?/, ''))) return;
      location.hash = target;
    });
    bar.append(b);
  }
  return bar;
}

// iPhone 键盘弹出时：把应用钉在“可见区域”上（高度 + 系统平移的偏移量），输入框不被挡住。
// 不再强行把页面滚回顶部——那会和系统“把输入框移到键盘上方”的动作打架。
let fullH = 0;
let lastW = 0;
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  const w = window.innerWidth;
  if (w !== lastW) { fullH = 0; lastW = w; } // 横竖屏切换时重新记录完整高度
  fullH = Math.max(fullH, h);
  const r = document.documentElement;
  r.style.setProperty('--app-h', Math.round(h) + 'px');
  r.style.setProperty('--vv-top', Math.round(top) + 'px');
  r.classList.toggle('kb', fullH - h > 140);
  keepFocusVisible();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitViewport);
  window.visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

// 弹出层里的输入框获得焦点后，把它滚到弹出层可见范围内
let focusTimer = 0;
function keepFocusVisible() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    const t = document.activeElement;
    if (!t || !t.closest) return;
    const box = t.closest('.sheet .sb');
    if (!box) return;
    const r = t.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
      box.scrollTop += r.top - b.top - Math.min(80, b.height / 4);
    }
  }, 250);
}
document.addEventListener('focusin', keepFocusVisible);

async function start() {
  fitViewport();
  await loadPrefs();
  window.addEventListener('hashchange', route);
  await route();
  ensurePersist();
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start().catch((e) => {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.style.padding = '24px';
  p.textContent = '墨游启动失败：' + (e?.message || e) + '。如果是在无痕模式下打开的，请换成普通模式。';
  root.append(p);
  console.error(e);
});
