// 墨游 · 把模型回复拆成：标题 / 正文 / 弹幕 / 选项
// 宽松解析：模型偶尔不按格式写，也尽量拆对；拆不出来就整段当正文。

function clean(line) {
  return line.replace(/^[\s>#*_~`]+/, '').replace(/[\s*_~`]+$/, '');
}

// 标记行：【弹幕】/[弹幕]/弹幕：/弹幕（独占一行）；选项同理（允许“参考选项”“行动选项”）
const MARKERS = {
  danmu: [
    /^[【\[(（]\s*[^】\])）]{0,6}?弹\s*幕[^】\])）]{0,6}[】\])）]\s*[:：]?\s*(.*)$/,
    /^(?:实时|直播间?)?\s*弹\s*幕\s*(?:区|评论|实况|飘过)?\s*[:：]\s*(.*)$/,
    /^(?:实时|直播间?)?\s*弹\s*幕\s*(?:区|评论|实况|飘过)?\s*()$/,
  ],
  options: [
    // 【选项】【参考选项】【可选行动】【抉择时刻】【你的选择】【下一步行动】……
    /^[【\[(（]\s*[^】\])）]{0,6}?(?:选\s*项|选\s*择|行\s*动|抉\s*择|下一步)[^】\])）]{0,6}[】\])）]\s*[:：]?\s*(.*)$/,
    /^(?:参考|行动|可选|你的|接下来的?)?\s*选\s*[项择]\s*[:：]\s*(.*)$/,
    /^(?:参考|行动|可选|你的|接下来的?)?\s*选\s*[项择]\s*()$/,
    /^(?:可选行动|行动建议|你可以|接下来你可以|你可以选择|接下来你要怎么做[？?]?|你会怎么做[？?]?)\s*[:：]?\s*()$/,
    /^(?:可选行动|行动建议|你可以|接下来你可以|你可以选择)\s*[:：]\s*(.*)$/,
  ],
};
const SEP_RE = /^[-—=*_·~\s]{3,}$/;
// 像一条选项的行：A. / 1、/ ① / 选项A：/ “A 走过去” / ▶ 走过去
const OPT_LINE = /^\s*(?:(?:[-*•·➤▶►→]\s*)?\**\s*(?:选\s*[项择]\s*)?(?:(?:[A-Ea-e]|[1-5]|[一二三四五])\s*\**\s*[.、．:：)）]|[①②③④⑤]|[A-E]\s+(?=[\u4e00-\u9fff“"「（(]))|[➤▶►→]\s*)\s*\S/;

/** 是标记行就返回 { rest }（同一行标记后面跟着的内容），否则 null */
function isMarker(cleaned, type) {
  for (const re of MARKERS[type]) {
    const m = cleaned.match(re);
    if (m) return { rest: (m[1] || '').trim() };
  }
  return null;
}

function stripOptionPrefix(s) {
  return s.replace(/^\s*(?:[-*•·➤▶►→]\s*)?\**\s*(?:选\s*[项择]\s*)?(?:[A-Ea-e]|[1-6]|[一二三四五六])\s*\**\s*[.、．:：)）\]】]\s*\**\s*/, '')
    .replace(/^\s*[①②③④⑤⑥]\s*[.、．:：)）]?\s*/, '')
    .replace(/^\s*[➤▶►→]\s*/, '')
    .replace(/^\s*(?:选\s*[项择]\s*)?(?:[A-Ea-e])\s+(?=[\u4e00-\u9fff“"「（(])/, '')
    .replace(/^\s*[(（【\[]\s*(?:[A-Ea-e]|[1-6])\s*[)）】\]]\s*/, '')
    .trim();
}

function parseDanmuLine(s) {
  const t = s.replace(/^\s*[-*•·]\s*/, '').trim();
  if (!t) return null;
  const m = t.match(/^([^：:\n]{1,16})[：:]\s*(.+)$/);
  if (m) return { name: m[1].replace(/^【|】$/g, '').trim(), text: m[2].trim() };
  return { name: '', text: t };
}

export function parseReply(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  let state = 'body';
  const body = [];
  const danmu = [];
  const options = [];
  let title = '';

  // 从第 i 行起，连着至少两行像选项（中间可以有空行）
  const optRun = (i) => {
    let n = 0;
    for (let j = i; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (OPT_LINE.test(lines[j])) n++; else break;
    }
    return n >= 2;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const c = clean(line);
    if (state !== 'danmu') {
      const dm = isMarker(c, 'danmu');
      if (dm) { state = 'danmu'; if (dm.rest) { const d = parseDanmuLine(dm.rest); if (d) danmu.push(d); } continue; }
    }
    if (state !== 'options') {
      const op = isMarker(c, 'options');
      if (op) { state = 'options'; if (op.rest) options.push(stripOptionPrefix(op.rest)); continue; }
    }
    if (state === 'body') { body.push(line); continue; }
    if (!c || SEP_RE.test(c)) continue;
    // 弹幕后面直接跟着 A/B/C、没写“选项”标记：从这里开始算选项
    if (state === 'danmu' && OPT_LINE.test(line) && optRun(li)) state = 'options';
    if (state === 'danmu') { const d = parseDanmuLine(c); if (d) danmu.push(d); }
    else if (state === 'options') { const o = stripOptionPrefix(c); if (o) options.push(o); }
  }

  // 标题：第一行非空，且是 # 开头、或【】《》包着、或很短的一行
  while (body.length && !body[0].trim()) body.shift();
  if (body.length) {
    const first = body[0].trim();
    const md = first.match(/^#{1,4}\s*(.+?)\s*#*$/);
    const br = clean(first).match(/^[【《]([^】》]{1,30})[】》]$/);
    if (md) { title = md[1]; body.shift(); }
    else if (br) { title = br[1]; body.shift(); }
  }
  title = title.replace(/^\*+|\*+$/g, '').replace(/^第\s*[0-9一二三四五六七八九十百千]+\s*[章回节]\s*[：:·\s]*/, '').trim();

  // 去掉正文末尾的分隔线
  const trimTail = () => { while (body.length && (!body[body.length - 1].trim() || SEP_RE.test(clean(body[body.length - 1])))) body.pop(); };
  trimTail();

  // 模型没写“选项”标记，但正文最后是连着的 A/B/C（或 1/2/3）几行：当成选项
  if (!options.length) {
    const tail = [];
    for (let i = body.length - 1; i >= 0; i--) {
      const l = body[i];
      if (!l.trim()) { if (tail.length) continue; else continue; }
      if (OPT_LINE.test(clean(l)) || OPT_LINE.test(l)) tail.unshift(i);
      else break;
    }
    if (tail.length >= 2) {
      for (const i of tail) { const o = stripOptionPrefix(clean(body[i])); if (o) options.push(o); }
      body.splice(tail[0]);
      trimTail();
    }
  }

  const bodyText = body.join('\n').trim();
  return { title, body: bodyText, danmu: danmu.slice(0, 30), options: options.slice(0, 6) };
}

/** 正文分段：有空行按空行分，没有空行按单个换行分 */
export function paragraphs(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const byBlank = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const parts = byBlank.length > 1 ? byBlank : t.split('\n').map((p) => p.trim()).filter(Boolean);
  // 去掉 markdown 粗体斜体记号，保留文字
  return parts.map((p) => p.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').replace(/^#{1,4}\s+/, ''));
}

/** 发给模型的旧轮次：只留标题和正文，去掉弹幕和选项 */
export function forContext(raw) {
  const p = parseReply(raw);
  const head = p.title ? `# ${p.title}\n` : '';
  return (head + p.body).trim() || String(raw || '').trim();
}
