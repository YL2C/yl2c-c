// 墨游 · 接口层
// 支持两种格式：OpenAI 兼容（绝大多数中转站、DeepSeek、OpenRouter 等）和 Claude 原生。
// 设计要点（针对旧版的问题）：
//  - 不强塞参数：温度留空就不发；新模型自动改用 max_completion_tokens；不强制 JSON 输出
//  - 流式输出，可停止；中途断开时把已收到的部分交还给界面保存
//  - 回复内容为空、被拦截、被截断，和网络错误分开报告
//  - 所有错误都翻译成中文并附修法，原始返回保留在 detail 里方便排查

export const FORMAT_LABEL = { auto: '自动识别', openai: 'OpenAI 兼容', anthropic: 'Claude 原生' };

export class ApiError extends Error {
  constructor(kind, message, { hint = '', status = 0, detail = '', url = '', partial = '' } = {}) {
    super(message);
    this.kind = kind;
    this.hint = hint;
    this.status = status;
    this.detail = detail;
    this.url = url;
    this.partial = partial;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, hint: this.hint, status: this.status, detail: this.detail, url: this.url };
  }
}

// ───────────── 地址 ─────────────

export function guessFormat(conn) {
  if (conn.format && conn.format !== 'auto') return conn.format;
  return /anthropic|claude/i.test(conn.baseUrl || '') && !/openai/i.test(conn.baseUrl || '') ? 'anthropic' : 'openai';
}

export function normalizeUrl(format, base) {
  let u = String(base || '').trim().replace(/\s+/g, '');
  if (!u) u = format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(u); } catch {
    throw new ApiError('bad_url', '接口地址格式不对', { hint: '地址应该像 https://example.com/v1 这样。' });
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (format === 'anthropic') {
    if (/\/messages$/i.test(path)) return u;
    if (/\/v\d+$/i.test(path)) return u + '/messages';
    return u + '/v1/messages';
  }
  if (/\/chat\/completions$/i.test(path)) return u;
  if (!path) return u + '/v1/chat/completions';
  return u + '/chat/completions';
}

export function modelsUrl(format, base) {
  const u = normalizeUrl(format, base);
  return format === 'anthropic' ? u.replace(/\/messages$/i, '/models') : u.replace(/\/chat\/completions$/i, '/models');
}

function isOfficialAnthropic(url) {
  try { return new URL(url).hostname === 'api.anthropic.com'; } catch { return false; }
}

function headersFor(format, conn, url, json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (format === 'anthropic') {
    h['x-api-key'] = conn.apiKey;
    h['anthropic-version'] = '2023-06-01';
    if (isOfficialAnthropic(url)) h['anthropic-dangerous-direct-browser-access'] = 'true';
    else h['Authorization'] = 'Bearer ' + conn.apiKey; // 有的中转只认这种
  } else {
    h['Authorization'] = 'Bearer ' + conn.apiKey;
  }
  return h;
}

// ───────────── 请求体 ─────────────

function usesCompletionTokens(model) {
  return /^(o\d|gpt-5)/i.test(String(model || '').replace(/^.*\//, ''));
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 合并相邻同角色消息，保证第一条是 user（部分接口要求） */
export function tidyMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '（故事从这里继续）' });
  return out;
}

function buildBody(format, conn, { system, messages, stream, maxTokens }) {
  const mt = num(maxTokens) || num(conn.maxTokens) || 8000;
  const temp = num(conn.temperature);
  const msgs = tidyMessages(messages);
  if (format === 'anthropic') {
    const b = { model: conn.model, max_tokens: mt, messages: msgs };
    if (system) b.system = system;
    if (temp != null) b.temperature = temp;
    if (stream) b.stream = true;
    return b;
  }
  const b = { model: conn.model, messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs };
  b[usesCompletionTokens(conn.model) ? 'max_completion_tokens' : 'max_tokens'] = mt;
  if (temp != null) b.temperature = temp;
  if (stream) {
    b.stream = true;
    // 让流式也返回用量（算花费用）；个别接口不认这个参数，会自动退回
    if (conn.usageOpt !== false) b.stream_options = { include_usage: true };
  }
  return b;
}

// ───────────── 错误翻译 ─────────────

function errText(raw) {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const e = j.error ?? j;
    if (typeof e === 'string') return e;
    return e.message || e.msg || j.message || raw;
  } catch { return raw; }
}

const QUOTA_RE = /(insufficient|quota|balance|credit|billing|余额|额度|欠费|用尽)/i;

function httpError(status, raw, url) {
  const msg = errText(raw);
  const detail = `HTTP ${status}\n${String(raw || '').slice(0, 1500)}`;
  const o = { status, detail, url };
  if (status === 401 || status === 403) {
    if (QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { ...o, hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。' });
    return new ApiError('auth', '密钥无效或没有权限', { ...o, hint: '检查密钥有没有复制完整、有没有过期。中转站的密钥只能配它自己的地址。' });
  }
  if (status === 402 || QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { ...o, hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。' });
  if (status === 404) {
    if (/model/i.test(msg)) return new ApiError('model', '找不到这个模型', { ...o, hint: '模型名可能拼错了，或者这个接口没有这个模型。可以在连接设置里点“获取模型列表”。' });
    return new ApiError('notfound', '地址不对（404）', { ...o, hint: `实际请求的地址是 ${url} 。检查地址结尾（中转站一般是 /v1），或者把接口格式改成“自动识别”。` });
  }
  if (status === 405) return new ApiError('notfound', '地址不对（这个地址不接受这种请求）', { ...o, hint: '可能选错了接口格式，试试“自动识别”。' });
  if (status === 413) return new ApiError('toolong', '内容太长，接口拒收', { ...o, hint: '故事太长了，超出了接口能接收的大小。' });
  if (status === 429) return new ApiError('ratelimit', '请求太频繁', { ...o, hint: '等几秒再试。如果一直这样，可能是额度用完了，去后台看看。' });
  if (status === 529) return new ApiError('overloaded', '模型服务繁忙', { ...o, hint: '官方服务器忙，过一会儿再试。' });
  if (status >= 500) {
    const hint = status === 502 || status === 503 || status === 504
      ? '上游服务暂时不可用或超时，通常过一会儿就好。'
      : '通常是对方临时故障，稍后重试。';
    return new ApiError('server', `接口那边出错了（${status}）`, { ...o, hint });
  }
  // 400 / 422 等：尽量猜出是哪个参数
  if (/stream_options|include_usage/i.test(msg)) return new ApiError('no_stream_options', '这个接口不支持返回用量', { ...o, hint: '会自动改成不要用量再试一次，花费改按字数估算。' });
  if (/model/i.test(msg) && /(not ?found|not exist|does not exist|invalid|unknown|not supported|无可用渠道|不存在|不支持)/i.test(msg)) {
    return new ApiError('model', '模型名不对，或这个接口没有这个模型', { ...o, hint: '在连接设置里点“获取模型列表”核对一下。' });
  }
  if (/temperature/i.test(msg)) return new ApiError('badreq', '这个模型不接受自定义温度', { ...o, hint: '在连接设置里把“温度”留空。' });
  if (/max_tokens|max_completion_tokens|max_output/i.test(msg)) return new ApiError('badreq', '输出上限设置不被接受', { ...o, hint: '把连接设置里的“输出上限”调小一点（例如 4000）再试。' });
  if (/(context|prompt is too long|too many tokens|maximum.*tokens|上下文|超出)/i.test(msg)) return new ApiError('toolong', '内容超出模型能接收的长度', { ...o, hint: '故事太长了。之后的版本会自动整理前情；现在可以先换个上下文更长的模型。' });
  if (/stream/i.test(msg)) return new ApiError('badreq', '这个接口不支持流式输出', { ...o, hint: '在连接设置里关掉“流式输出”。' });
  return new ApiError('badreq', `请求被拒绝（${status}）`, { ...o, hint: '下面是接口返回的原文。看不懂可以复制给我。' });
}

function networkError(url, e) {
  if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:/i.test(url)) {
    return new ApiError('mixed', '这个页面是 https，浏览器不允许它调用 http 地址', {
      url, detail: String(e?.message || e || ''),
      hint: '给接口配上 https（域名 + 证书），或者换成 https 的地址。',
    });
  }
  return new ApiError('network', '连不上接口', {
    url, detail: String(e?.message || e || ''),
    hint: '可能是：① 网络或代理问题；② 这个接口不允许网页直接调用（跨域限制）——酒馆能连不代表这里能连，因为酒馆是服务器去连的；③ 域名写错了。连接测试一直这样的话多半是②，可以用自己的服务器转发。',
  });
}

function streamError(errObj, partial) {
  const e = errObj?.error ?? errObj ?? {};
  const msg = typeof e === 'string' ? e : (e.message || JSON.stringify(e));
  const type = (e && e.type) || '';
  if (/overloaded/i.test(type + msg)) return new ApiError('overloaded', '模型服务繁忙', { hint: '过一会儿再试。已收到的部分会保留。', detail: msg, partial });
  if (QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。', detail: msg, partial });
  return new ApiError('server', '生成到一半出错了', { hint: '可以点“续写”接着写，或者重试。', detail: msg, partial });
}

function emptyError(finish, sawThinking) {
  const f = String(finish || '');
  if (/refusal/i.test(f)) return new ApiError('refusal', '模型拒绝了这次请求', { hint: '这轮内容被模型拒绝了。可以换个说法、换个模型，或者重试。', detail: `结束原因：${f}` });
  if (/content_filter|safety|blocked|prohibited/i.test(f)) return new ApiError('blocked', '内容被安全策略拦截', { hint: '这家接口拦下了这轮内容。可以换个说法或换个模型。', detail: `结束原因：${f}` });
  if (/length|max_tokens/i.test(f) && sawThinking) return new ApiError('empty', '输出上限被思考过程用完了', { hint: '在连接设置里把“输出上限”调大（例如 8000 以上）。', detail: `结束原因：${f}` });
  return new ApiError('empty', '模型返回了空内容', {
    hint: '常见原因：内容被安全策略拦截；或者开了思考的模型把输出上限用完了（把“输出上限”调大）。',
    detail: f ? `结束原因：${f}` : '没有收到任何正文',
  });
}

// ───────────── 解析回复 ─────────────

function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function parseNonStream(format, j) {
  if (j && j.error) throw streamError(j, '');
  if (format === 'anthropic') {
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const thinking = (j.content || []).some((b) => b.type === 'thinking');
    return { text, finish: j.stop_reason, usage: j.usage || null, thinking };
  }
  const ch = j.choices?.[0];
  const text = partsText(ch?.message?.content);
  return { text, finish: ch?.finish_reason, usage: j.usage || null, thinking: !!(ch?.message?.reasoning_content || ch?.message?.reasoning) };
}

// ───────────── 发请求 ─────────────

function linkAbort(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl;
}

function checkConn(conn) {
  if (!conn) throw new ApiError('no_conn', '这个故事还没有选择连接', { hint: '在设置里添加一个 API 连接。' });
  if (!conn.apiKey) throw new ApiError('no_key', '还没有填 API 密钥', { hint: '在设置 → 连接里填写密钥。' });
  if (!conn.model) throw new ApiError('no_model', '还没有填模型名', { hint: '在设置 → 连接里填写模型名，或点“获取模型列表”。' });
}

/**
 * 流式生成。
 * onText(delta, full) 每收到一段正文调用；onThinking() 收到思考内容时调用。
 * 返回 { text, finish, usage, truncated, flagged }。
 * 出错时抛 ApiError，已收到的正文在 err.partial 里。
 */
export async function streamChat(conn, { system, messages, maxTokens, signal, onText = () => {}, onThinking = () => {}, firstByteMs = 150000, idleMs = 90000 }) {
  checkConn(conn);
  const format = guessFormat(conn);
  const url = normalizeUrl(format, conn.baseUrl);
  const wantStream = conn.stream !== false;
  const body = buildBody(format, conn, { system, messages, stream: wantStream, maxTokens });
  const ctrl = linkAbort(signal);
  let timer = null;
  let timedOut = false;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort('idle'); }, ms); };

  let text = '';
  let finish = null;
  let usage = null;
  let sawThinking = false;
  const fail = (e) => { if (e instanceof ApiError && !e.partial) e.partial = text; return e; };
  const abortedErr = () => (timedOut
    ? new ApiError('timeout', '长时间没有响应', { hint: '网络太慢或接口卡住了。已收到的部分会保留，可以续写或重试。', partial: text, url })
    : new ApiError('aborted', '已停止', { partial: text, url }));

  arm(firstByteMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: headersFor(format, conn, url), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw abortedErr();
    throw networkError(url, e);
  }

  try {
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw httpError(res.status, raw, url);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
      const raw = await res.text().catch(() => '');
      throw new ApiError('html', '接口返回了网页，而不是数据', { url, detail: raw.slice(0, 800), hint: '地址可能填成了中转站的网页地址。API 地址通常以 /v1 结尾。' });
    }
    if (!wantStream || (ct.includes('json') && !ct.includes('event-stream'))) {
      const raw = await res.text();
      let j;
      try { j = JSON.parse(raw); } catch { throw new ApiError('badresp', '接口返回的内容看不懂', { url, detail: raw.slice(0, 800), hint: '可能是地址填错了，或者中转站出了问题。' }); }
      const r = parseNonStream(format, j);
      text = r.text || '';
      finish = r.finish; usage = r.usage; sawThinking = r.thinking;
      if (text) onText(text, text);
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let rawHead = '';
      let sawData = false;
      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') return;
        sawData = true;
        let j;
        try { j = JSON.parse(d); } catch { return; }
        if (j.error || j.type === 'error') throw streamError(j, text);
        if (format === 'anthropic') {
          if (j.type === 'content_block_delta') {
            if (j.delta?.type === 'text_delta' && j.delta.text) { text += j.delta.text; onText(j.delta.text, text); }
            else if (j.delta?.type === 'thinking_delta') { sawThinking = true; onThinking(); }
          } else if (j.type === 'content_block_start' && j.content_block?.type === 'thinking') {
            sawThinking = true; onThinking();
          } else if (j.type === 'message_delta') {
            if (j.delta?.stop_reason) finish = j.delta.stop_reason;
            if (j.usage) usage = { ...(usage || {}), ...j.usage };
          } else if (j.type === 'message_start' && j.message?.usage) {
            usage = { ...j.message.usage };
          }
          // 也兼容少数把 Claude 格式转成 OpenAI 块的中转
          if (j.choices) handleOpenAI(j);
        } else {
          handleOpenAI(j);
        }
      };
      const handleOpenAI = (j) => {
        const ch = j.choices?.[0];
        if (ch) {
          const delta = ch.delta || ch.message || {};
          const piece = partsText(delta.content);
          if (piece) { text += piece; onText(piece, text); }
          if (delta.reasoning_content || delta.reasoning) { sawThinking = true; onThinking(); }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
        if (j.usage) usage = j.usage;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm(idleMs);
        const chunk = dec.decode(value, { stream: true });
        if (rawHead.length < 2000) rawHead += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          handle(line);
        }
      }
      if (buf.trim()) handle(buf.trim());
      if (!sawData && rawHead.trim()) {
        // 声称流式、实际一次性返回 JSON 的接口
        try {
          const r = parseNonStream(format, JSON.parse(rawHead));
          text = r.text || ''; finish = r.finish; usage = r.usage; sawThinking = r.thinking;
          if (text) onText(text, text);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          throw new ApiError('badresp', '接口返回的内容看不懂', { url, detail: rawHead.slice(0, 800), hint: '可能是地址填错了，或者中转站的流式输出有问题，可以在连接设置里关掉“流式输出”。' });
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ApiError) throw fail(e);
    if (ctrl.signal.aborted) throw abortedErr();
    const ne = new ApiError('network', '连接中途断开了', { url, detail: String(e?.message || e), partial: text, hint: '常见于切走应用、网络切换。已收到的部分已保留，可以点“续写”。' });
    throw ne;
  }
  clearTimeout(timer);

  if (!text.trim()) throw emptyError(finish, sawThinking);
  const f = String(finish || '');
  return {
    text,
    finish,
    usage,
    truncated: /^(length|max_tokens)$/i.test(f),
    flagged: /content_filter|refusal|safety/i.test(f),
  };
}

/** 自动重试：只对“还没收到任何正文”的网络/限流/服务端错误重试一次 */
export async function streamWithRetry(conn, opts, { retries = 1, onRetry = () => {}, onConnPatch = () => {} } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await streamChat(conn, opts);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'no_stream_options' && conn.usageOpt !== false) {
        conn = { ...conn, usageOpt: false };
        onConnPatch({ usageOpt: false });
        continue;
      }
      const retriable = e instanceof ApiError && ['network', 'ratelimit', 'server', 'overloaded'].includes(e.kind) && !e.partial;
      if (!retriable || attempt >= retries || opts.signal?.aborted) throw e;
      attempt++;
      onRetry(e, attempt);
      await new Promise((r) => setTimeout(r, e.kind === 'ratelimit' ? 4000 : 2000));
      if (opts.signal?.aborted) throw new ApiError('aborted', '已停止');
    }
  }
}

export async function listModels(conn) {
  const format = guessFormat(conn);
  const url = modelsUrl(format, conn.baseUrl);
  let res;
  try {
    res = await fetch(url, { headers: headersFor(format, conn, url, false) });
  } catch (e) { throw networkError(url, e); }
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw httpError(res.status, raw, url);
  let j;
  try { j = JSON.parse(raw); } catch { throw new ApiError('badresp', '模型列表看不懂', { url, detail: raw.slice(0, 500) }); }
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

// ───────────── 连接测试 ─────────────

const PING = [{ role: 'user', content: '请只回复四个字：连接成功' }];

/**
 * 逐步测试连接。onStep({id, state:'wait'|'ok'|'bad'|'info', text, detail})
 * 返回 { ok, format, models }
 */
export async function testConnection(conn, onStep = () => {}) {
  const step = (id, state, text, detail = '') => onStep({ id, state, text, detail });
  if (!conn.apiKey) { step('pre', 'bad', '还没有填 API 密钥'); return { ok: false }; }
  if (!conn.model) { step('pre', 'bad', '还没有填模型名'); return { ok: false }; }

  const candidates = conn.format && conn.format !== 'auto'
    ? [conn.format]
    : (guessFormat(conn) === 'anthropic' ? ['anthropic', 'openai'] : ['openai', 'anthropic']);

  let chosen = null;
  let patch = {};
  for (const fmt of candidates) {
    let url;
    try { url = normalizeUrl(fmt, conn.baseUrl); } catch (e) { step('url', 'bad', e.message, e.hint); return { ok: false }; }
    const c = { ...conn, format: fmt, stream: false };
    const sid = 'req-' + fmt;
    step(sid, 'wait', `用「${FORMAT_LABEL[fmt]}」格式请求：${url}`);
    const t0 = performance.now();
    try {
      const r = await streamChat(c, { messages: PING, maxTokens: 400, firstByteMs: 60000 });
      const ms = Math.round(performance.now() - t0);
      step(sid, 'ok', `「${FORMAT_LABEL[fmt]}」格式可用，普通请求成功（${(ms / 1000).toFixed(1)} 秒）：模型回复「${r.text.trim().slice(0, 40)}」`);
      chosen = fmt;
      break;
    } catch (e) {
      const tryNext = candidates.length > 1 && fmt === candidates[0] && ['notfound', 'html', 'badresp'].includes(e.kind);
      step(sid, 'bad', `${e.message}${tryNext ? '，换另一种格式再试' : ''}`, [e.hint, e.detail].filter(Boolean).join('\n'));
      if (!tryNext) return { ok: false };
    }
  }
  if (!chosen) return { ok: false };

  // 流式
  if (conn.stream !== false) {
    step('stream', 'wait', '测试流式输出…');
    const t0 = performance.now();
    let first = 0;
    let pieces = 0;
    try {
      let gotUsage = false;
      await streamWithRetry({ ...conn, format: chosen, stream: true }, {
        messages: PING, maxTokens: 400, firstByteMs: 60000,
        onText: () => { pieces++; if (!first) first = performance.now() - t0; },
      }, { retries: 0, onConnPatch: (p) => { patch = { ...patch, ...p }; } }).then((r) => { gotUsage = !!r.usage; });
      step('stream', 'ok', `流式正常：收到 ${pieces} 段，首字 ${(first / 1000).toFixed(1)} 秒`);
      step('usage', gotUsage ? 'ok' : 'info', gotUsage ? '接口会返回用量，花费按真实数字算' : '接口不返回用量，花费会按字数粗估');
    } catch (e) {
      step('stream', 'bad', `流式失败：${e.message}`, `普通请求是通的，说明是这个接口的流式输出有问题。可以在下面关掉“流式输出”再用。\n${e.detail || ''}`);
    }
  } else {
    step('stream', 'info', '流式输出已关闭，跳过');
  }

  // 模型列表（不影响结果）
  let models = [];
  try {
    models = await listModels({ ...conn, format: chosen });
    const has = models.includes(conn.model);
    step('models', has ? 'ok' : 'info', has ? `模型列表里有「${conn.model}」（共 ${models.length} 个）` : `获取到 ${models.length} 个模型，但列表里没有「${conn.model}」——如果上面能用就不用管`);
  } catch (e) {
    step('models', 'info', `模型列表获取失败（不影响使用）：${e.message}`);
  }
  return { ok: true, format: chosen, models, patch };
}
