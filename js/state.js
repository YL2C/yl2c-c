// 墨游 · 共享状态：阅读偏好、连接、默认规则、页面跳转

import { db } from './db.js';
import { DEFAULT_RULES } from './prompt.js';

export const DEFAULT_PREFS = { fontSize: 17, font: 'serif', indent: true, danmuOpen: true };
let prefs = { ...DEFAULT_PREFS };

export async function loadPrefs() {
  prefs = { ...DEFAULT_PREFS, ...((await db.kvGet('prefs', null)) || {}) };
  applyPrefs();
  return prefs;
}
export function getPrefs() { return prefs; }
export async function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  applyPrefs();
  await db.kvSet('prefs', prefs);
}
export function applyPrefs() {
  const r = document.documentElement;
  r.style.setProperty('--read-size', prefs.fontSize + 'px');
  r.dataset.font = prefs.font;
  r.dataset.indent = prefs.indent ? 'on' : 'off';
}

export async function getDefaultRules() {
  const v = await db.kvGet('defaultRules', null);
  return v == null ? DEFAULT_RULES : v;
}

export async function getConnections() {
  const list = await db.all('connections');
  // 旧版默认输出上限 4000：中文一章加弹幕选项经常写不完（尤其开了思考的模型），统一调到 8000
  for (const c of list) {
    if (!c.mt8000) {
      if (c.maxTokens == null || Number(c.maxTokens) === 4000) c.maxTokens = 8000;
      c.mt8000 = true;
      db.put('connections', c).catch(() => {});
    }
  }
  return list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export async function getDefaultConnId() { return db.kvGet('defaultConn', null); }
export async function setDefaultConnId(id) { return db.kvSet('defaultConn', id); }

/** 故事用的连接：故事自己选的 → 默认连接 → 第一个 */
export async function resolveConnection(story) {
  const list = await getConnections();
  if (!list.length) return null;
  const own = story?.connectionId && list.find((c) => c.id === story.connectionId);
  if (own) return own;
  const d = await getDefaultConnId();
  return list.find((c) => c.id === d) || list[0];
}

export function connLabel(c) {
  if (!c) return '未连接';
  return c.name?.trim() || c.model || '未命名连接';
}

// 当前故事：底部菜单的“游玩 / 角色 / 番外”指向它
let currentStory = null;
try { currentStory = localStorage.getItem('yl2c.curStory') || null; } catch {}
export function getCurrentStory() { return currentStory; }
export function setCurrentStory(id) {
  currentStory = id || null;
  try { if (id) localStorage.setItem('yl2c.curStory', id); else localStorage.removeItem('yl2c.curStory'); } catch {}
}

export function go(path = '') {
  const h = '#/' + path;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = h;
}

// ───── 规则模块库（全局，所有故事共用；每个故事自己选启用哪些） ─────
export const MODULE_MODES = { always: '一直发送', manual: '手动开关（情境）', keyword: '出现关键词时发送' };

export async function getModules() {
  const list = (await db.kvGet('modules', null)) || [];
  return Array.isArray(list) ? list : [];
}
export async function saveModules(list) { return db.kvSet('modules', list); }

/** 把 markdown 按“## 标题”拆成模块；没有 ## 的话整份当一个模块 */
export function modulesFromMarkdown(md, fallbackName = '导入的规则') {
  const text = String(md || '').replace(/\r/g, '');
  const parts = text.split(/^##\s+/m);
  const out = [];
  if (parts.length <= 1) {
    const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
    if (body) out.push({ name: fallbackName, text: body });
    return out;
  }
  const head = parts[0].replace(/^---[\s\S]*?---\n/, '').replace(/^#\s+.*$/m, '').trim();
  if (head) out.push({ name: fallbackName + '（开头）', text: head });
  for (const p of parts.slice(1)) {
    const nl = p.indexOf('\n');
    const name = (nl < 0 ? p : p.slice(0, nl)).trim();
    const body = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    if (name && body) out.push({ name, text: body });
  }
  return out;
}

export function modulesToMarkdown(list) {
  return list.map((m) => `## ${m.name}\n${m.text.trim()}\n`).join('\n');
}

// ───── 全局备忘：所有故事每轮都带上（讨论页里写入） ─────
export async function getGlobalMemo() { return (await db.kvGet('globalMemo', '')) || ''; }
export async function setGlobalMemo(text) { return db.kvSet('globalMemo', String(text || '')); }
