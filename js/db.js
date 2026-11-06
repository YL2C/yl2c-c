// 墨游 · 本机存储（IndexedDB）
// 和旧版不同：保存失败会直接提示，不会悄悄丢进度。

import { toast } from './util.js';

const DB_NAME = 'yl2c';
const DB_VER = 2;
export const SCHEMA = 1; // 存档格式版本，以后升级格式时据此迁移

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('connections')) db.createObjectStore('connections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stories')) db.createObjectStore('stories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('nodes')) {
        const s = db.createObjectStore('nodes', { keyPath: 'id' });
        s.createIndex('storyId', 'storyId', { unique: false });
      }
      if (!db.objectStoreNames.contains('extras')) {
        const s = db.createObjectStore('extras', { keyPath: 'id' }); // 番外，不进正史
        s.createIndex('storyId', 'storyId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => toast('请关闭其他打开着墨游的页面后再试');
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  }));
}

let lastWarn = 0;
function reportWriteError(e) {
  const now = Date.now();
  if (now - lastWarn < 4000) return;
  lastWarn = now;
  const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
  toast(quota ? '保存失败：设备存储空间不足。请先导出备份。' : '保存失败：' + (e?.message || e), 5000);
  console.error('[墨游] 保存失败', e);
}

export const db = {
  get: (store, key) => run(store, 'readonly', (os) => os.get(key)),
  all: (store) => run(store, 'readonly', (os) => os.getAll()),
  byStory: (storyId) => run('nodes', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  extrasOf: (storyId) => run('extras', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  async put(store, value, key) {
    try {
      return await run(store, 'readwrite', (os) => (key === undefined ? os.put(value) : os.put(value, key)));
    } catch (e) { reportWriteError(e); throw e; }
  },
  async putMany(store, values) {
    try {
      return await run(store, 'readwrite', (os) => { for (const v of values) os.put(v); });
    } catch (e) { reportWriteError(e); throw e; }
  },
  async del(store, key) {
    try { return await run(store, 'readwrite', (os) => os.delete(key)); }
    catch (e) { reportWriteError(e); throw e; }
  },
  async delStory(storyId) {
    const nodes = await db.byStory(storyId);
    await run('nodes', 'readwrite', (os) => { for (const n of nodes) os.delete(n.id); });
    const extras = await db.extrasOf(storyId);
    if (extras.length) await run('extras', 'readwrite', (os) => { for (const x of extras) os.delete(x.id); });
    await db.del('stories', storyId);
  },
  async kvGet(key, fallback) {
    const v = await run('kv', 'readonly', (os) => os.get(key));
    return v === undefined ? fallback : v;
  },
  kvSet: (key, value) => db.put('kv', value, key),
};

/** 向系统申请“持久存储”，降低被系统清理的可能 */
export async function ensurePersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage; info.quota = e.quota;
    }
  } catch {}
  return info;
}

/** 导出：默认不含 API 密钥 */
export async function exportAll({ includeKeys = false } = {}) {
  const [stories, nodes, extras, connections, defaultRules, prefs, modules, fwTemplates, fwBase, globalMemo] = await Promise.all([
    db.all('stories'), db.all('nodes'), db.all('extras'), db.all('connections'),
    db.kvGet('defaultRules', null), db.kvGet('prefs', null),
    db.kvGet('modules', null), db.kvGet('fwTemplates', null), db.kvGet('fwBase', null), db.kvGet('globalMemo', null),
  ]);
  return {
    app: 'yl2c', schema: SCHEMA, exportedAt: Date.now(),
    stories, nodes, extras, modules, fwTemplates, fwBase, globalMemo,
    connections: connections.map((c) => (includeKeys ? c : { ...c, apiKey: '' })),
    defaultRules, prefs,
  };
}

export async function exportStory(storyId) {
  const story = await db.get('stories', storyId);
  const nodes = await db.byStory(storyId);
  const extras = await db.extrasOf(storyId);
  return { app: 'yl2c', schema: SCHEMA, exportedAt: Date.now(), stories: [story], nodes, extras, connections: [] };
}

/** 导入：同 id 的故事会被覆盖；连接只补充不存在的（不覆盖本机已有密钥） */
export async function importData(data) {
  if (!data || (data.app !== 'moyu' && data.app !== 'yl2c')) throw new Error('这不是墨游的备份文件');
  if ((data.schema || 1) > SCHEMA) throw new Error('这个备份来自更新版本的墨游，请先更新');
  const stories = Array.isArray(data.stories) ? data.stories.filter(Boolean) : [];
  const nodes = Array.isArray(data.nodes) ? data.nodes.filter(Boolean) : [];
  for (const s of stories) {
    const old = await db.byStory(s.id);
    if (old.length) await run('nodes', 'readwrite', (os) => { for (const n of old) os.delete(n.id); });
  }
  if (stories.length) await db.putMany('stories', stories);
  if (nodes.length) await db.putMany('nodes', nodes);
  const extras = Array.isArray(data.extras) ? data.extras.filter(Boolean) : [];
  if (extras.length) await db.putMany('extras', extras);
  // 模块和番外模板：本机还没有的时候才用备份里的（不覆盖本机已经改过的）
  if (Array.isArray(data.modules) && !(await db.kvGet('modules', null))) await db.kvSet('modules', data.modules);
  if (Array.isArray(data.fwTemplates) && !(await db.kvGet('fwTemplates', null))) await db.kvSet('fwTemplates', data.fwTemplates);
  if (data.fwBase && !(await db.kvGet('fwBase', null))) await db.kvSet('fwBase', data.fwBase);
  if (data.globalMemo && !(await db.kvGet('globalMemo', null))) await db.kvSet('globalMemo', data.globalMemo);
  let addedConn = 0;
  if (Array.isArray(data.connections)) {
    const existing = new Set((await db.all('connections')).map((c) => c.id));
    const fresh = data.connections.filter((c) => c && !existing.has(c.id));
    if (fresh.length) { await db.putMany('connections', fresh); addedConn = fresh.length; }
  }
  if (data.defaultRules && !(await db.kvGet('defaultRules', null))) await db.kvSet('defaultRules', data.defaultRules);
  return { stories: stories.length, nodes: nodes.length, extras: extras.length, connections: addedConn };
}
