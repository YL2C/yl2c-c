// 墨游 · 设置：连接、默认规则、阅读、备份

import { db, exportAll, importData, storageInfo } from '../db.js';
import { el, uid, toast, sheet, saveFile, pickFile, APP_VERSION } from '../util.js';
import { getConnections, getDefaultConnId, setDefaultConnId, getDefaultRules, getPrefs, setPrefs, connLabel, go, getModules, saveModules, MODULE_MODES, modulesFromMarkdown, modulesToMarkdown } from '../state.js';
import { FORMAT_LABEL, normalizeUrl, guessFormat, testConnection, listModels } from '../api.js';
import { DEFAULT_RULES } from '../prompt.js';
import { getMonthSpend, getBudget, setBudget, fmtTokens, CUR } from '../cost.js';
import { getTemplates, saveTemplates, getBase, saveBase, DEFAULT_BASE, builtinTemplates, newTemplate, SCOPES } from '../fanwai.js';

function sw(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, input, el('span'));
}

function seg(options, value, onpick) {
  const box = el('div', { class: 'seg' });
  for (const [v, label] of options) {
    const b = el('button', { class: v === value ? 'on' : '', onclick: () => { box.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onpick(v); } }, label);
    box.append(b);
  }
  return box;
}

/** 可搜索的模型选择框，返回选中的模型名（取消返回 null） */
function pickModel(list, current = '') {
  return new Promise((resolve) => {
    let picked = null;
    const s = sheet({ title: `选择模型（共 ${list.length} 个）`, onClose: () => resolve(picked) });
    const q = el('input', { type: 'text', placeholder: '搜索，例如 claude、gemini、deepseek', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const box = el('div', { class: 'menu-list' });
    const draw = () => {
      const k = q.value.trim().toLowerCase();
      const hits = list.filter((m) => !k || m.toLowerCase().includes(k));
      box.replaceChildren(...hits.slice(0, 400).map((m) => el('button', {
        style: { wordBreak: 'break-all' },
        onclick: () => { picked = m; s.close(); },
      }, m + (m === current ? '  ✓' : ''))));
      if (!hits.length) box.append(el('div', { class: 'hint', text: '没有匹配的模型' }));
    };
    q.addEventListener('input', draw);
    s.body.append(el('div', { class: 'field', style: { marginBottom: '6px' } }, q), box);
    s.foot.remove();
    draw();
  });
}

export async function render(root, { section }) {
  const wrap = el('div', { class: 'wrap' });
  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('div', { class: 'title', style: { paddingLeft: '6px', minHeight: '36px', display: 'flex', alignItems: 'center' } }, '设置')
    ),
    el('div', { class: 'scroll' }, wrap)
  ));

  async function draw() {
    wrap.replaceChildren();
    const conns = await getConnections();
    const defId = await getDefaultConnId();

    // ── 连接 ──
    wrap.append(el('div', { class: 'section-title', text: 'API 连接' }));
    if (!conns.length) wrap.append(el('div', { class: 'card hint', style: { marginTop: 0 }, text: '还没有连接。点下面添加：需要接口地址、密钥和模型名。' }));
    for (const c of conns) {
      const isDef = c.id === defId || (!defId && c === conns[0]);
      let url = '';
      try { url = normalizeUrl(guessFormat(c), c.baseUrl); } catch {}
      wrap.append(el('div', { class: 'card' },
        el('div', { style: { fontWeight: '600' } }, connLabel(c), isDef ? el('span', { class: 'badge', text: '默认' }) : null),
        el('div', { class: 'hint', style: { marginTop: '4px', wordBreak: 'break-all' } },
          `${FORMAT_LABEL[c.format || 'auto']} · ${c.model || '未填模型'}` + (c.priceIn !== '' && c.priceIn != null ? ` · ${CUR[c.currency || 'CNY']}${c.priceIn}/${c.priceOut ?? '?'} 每百万` : ''), el('br'), url),
        el('div', { class: 'row', style: { marginTop: '10px' } },
          el('button', { class: 'btn small', onclick: () => editConn(c) }, '编辑 / 测试'),
          isDef ? null : el('button', { class: 'btn small ghost', onclick: async () => { await setDefaultConnId(c.id); toast('已设为默认'); draw(); } }, '设为默认')
        )
      ));
    }
    wrap.append(el('button', { class: 'btn block', onclick: () => editConn(null) }, '＋ 添加连接'));

    // ── 默认规则 ──
    wrap.append(el('div', { class: 'section-title', text: '新故事的默认规则' }));
    const rules = el('textarea', { class: 'tall' });
    rules.value = await getDefaultRules();
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'field', style: { marginBottom: '8px' } }, rules),
      el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '10px' } }, '新建故事时会复制一份；已有的故事不受影响（在故事设定里单独改）。'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small primary', onclick: async () => { await db.kvSet('defaultRules', rules.value); toast('默认规则已保存'); } }, '保存'),
        el('button', { class: 'btn small ghost', onclick: () => { if (confirm('恢复成内置的通用规则？')) rules.value = DEFAULT_RULES; } }, '恢复内置'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small ghost', onclick: async () => { await saveFile('墨游_默认规则.txt', rules.value, 'text/plain'); } }, '导出文本'),
        el('button', { class: 'btn small ghost', onclick: async () => { const f = await pickFile('.txt,.md,text/plain'); if (f) { rules.value = f.text; toast('已读入，记得点保存'); } } }, '导入文本')
      )
    ));

    // ── 规则模块 ──
    const mods = await getModules();
    const modTitle = el('div', { class: 'section-title', id: 'sec-modules', text: '规则模块（所有故事共用，每个故事自己选启用哪些）' });
    wrap.append(modTitle);
    const modCard = el('div', { class: 'card' });
    if (!mods.length) modCard.append(el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '10px' } }, '模块是可以在多个故事之间复用的规则块，比如“文风”“弹幕写法”“成人场景”。可以一条条加，也可以导入一份 markdown：每个“## 标题”拆成一个模块。'));
    for (const m of mods) {
      modCard.append(el('div', { class: 'switch-row', style: { cursor: 'pointer' }, onclick: () => editModule(m) },
        el('div', { class: 'lbl' }, m.name, el('small', { text: `${MODULE_MODES[m.mode] || MODULE_MODES.always}${m.mode === 'keyword' && m.keywords ? '：' + m.keywords : ''} · ${m.text.length} 字${m.note?.trim() ? ' · 有备注' : ''}` })),
        el('span', { class: 'muted', text: '›' })));
    }
    modCard.append(el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn small primary', onclick: () => editModule(null) }, '＋ 新模块'),
      el('button', {
        class: 'btn small',
        onclick: async () => {
          const f = await pickFile('.md,.txt,text/plain,text/markdown');
          if (!f) return;
          const found = modulesFromMarkdown(f.text, f.name.replace(/\.(md|txt)$/i, ''));
          if (!found.length) { toast('文件里没有内容'); return; }
          if (!confirm(`拆出 ${found.length} 个模块：\n${found.map((x) => '· ' + x.name).slice(0, 20).join('\n')}${found.length > 20 ? '\n……' : ''}\n\n都按“一直发送”导入，之后可以逐个改。继续？`)) return;
          const list = await getModules();
          for (const x of found) list.push({ id: uid(), name: x.name, text: x.text, note: '', mode: 'always', keywords: '' });
          await saveModules(list);
          toast(`已导入 ${found.length} 个模块`);
          draw();
        },
      }, '导入 markdown'),
      mods.length ? el('button', { class: 'btn small ghost', onclick: async () => { await saveFile('墨游_规则模块.md', modulesToMarkdown(await getModules()), 'text/markdown'); } }, '导出') : null));
    wrap.append(modCard);

    // ── 番外 ──
    const tpls = await getTemplates();
    wrap.append(el('div', { class: 'section-title', id: 'sec-fanwai', text: '番外模板与通用要求' }));
    const fwCard = el('div', { class: 'card' });
    for (const t of tpls) {
      fwCard.append(el('div', { class: 'switch-row', style: { cursor: 'pointer' }, onclick: () => editTemplate(t) },
        el('div', { class: 'lbl' }, t.name, el('small', { text: `默认知情：${(SCOPES[t.scope] || '').split('：')[0]} · ${t.text.length} 字` })),
        el('span', { class: 'muted', text: '›' })));
    }
    fwCard.append(el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn small primary', onclick: () => editTemplate(null) }, '＋ 新模板'),
      el('button', { class: 'btn small', onclick: () => editBase() }, '番外通用要求'),
      el('button', {
        class: 'btn small',
        onclick: async () => {
          const f = await pickFile('.md,.txt,text/plain,text/markdown');
          if (!f) return;
          const found = modulesFromMarkdown(f.text, f.name.replace(/\.(md|txt)$/i, ''));
          if (!found.length) { toast('文件里没有内容'); return; }
          if (!confirm(`拆出 ${found.length} 个番外模板：\n${found.map((x) => '· ' + x.name).slice(0, 20).join('\n')}\n\n导入后可以逐个改知情范围。继续？`)) return;
          const list = await getTemplates();
          for (const x of found) list.push({ ...newTemplate(), name: x.name, text: x.text });
          await saveTemplates(list); toast(`已导入 ${found.length} 个模板`); draw();
        },
      }, '导入 markdown'),
      el('button', { class: 'btn small ghost', onclick: async () => { await saveFile('墨游_番外模板.md', modulesToMarkdown(await getTemplates()), 'text/markdown'); } }, '导出')));
    wrap.append(fwCard);

    // ── 阅读 ──
    const p = getPrefs();
    wrap.append(el('div', { class: 'section-title', text: '阅读' }));
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '字号'),
        seg([[15, '小'], [17, '中'], [19, '大'], [21, '特大']], p.fontSize, (v) => setPrefs({ fontSize: v }))),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '正文字体'),
        seg([['serif', '宋体'], ['sans', '黑体']], p.font, (v) => setPrefs({ font: v }))),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '段首缩进'), sw(p.indent, (v) => setPrefs({ indent: v }))),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '弹幕默认展开'), sw(p.danmuOpen, (v) => setPrefs({ danmuOpen: v })))
    ));

    // ── 花费 ──
    const month = await getMonthSpend();
    const budget = await getBudget();
    const bAmt = el('input', { type: 'number', min: '0', step: '1', placeholder: '不提醒', style: { flex: 1 } }); bAmt.value = budget.amount ?? '';
    const bCur = el('select', { style: { width: '110px', flex: 'none' } }); bCur.append(el('option', { value: 'CNY' }, '¥'), el('option', { value: 'USD' }, '$')); bCur.value = budget.currency || 'CNY';
    const spent = ['CNY', 'USD'].filter((k) => month[k] > 0).map((k) => CUR[k] + (month[k] < 0.01 ? Number(month[k].toPrecision(2)) : month[k].toFixed(2))).join(' + ') || (month.count ? '算不出金额（连接没填单价）' : '—');
    wrap.append(el('div', { class: 'section-title', text: '花费' }));
    wrap.append(el('div', { class: 'card' },
      el('div', { style: { fontWeight: '600' } }, `本月 ${spent}`),
      el('div', { class: 'hint', style: { marginTop: '2px' } }, `共 ${month.count} 次调用 · 输入 ${fmtTokens(month.input)} · 输出 ${fmtTokens(month.output)} token。金额按各连接填的单价（每百万 token）估算；每一笔明细在游玩页“⋯ → 花费”。`),
      el('div', { class: 'field', style: { marginTop: '12px', marginBottom: '8px' } }, el('label', { text: '每月提醒线（超过后每天提醒一次）' }),
        el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, bAmt, bCur)),
      el('button', { class: 'btn small primary', onclick: async () => { await setBudget({ amount: bAmt.value === '' ? '' : Number(bAmt.value), currency: bCur.value }); toast('提醒线已保存'); } }, '保存提醒线')
    ));

    // ── 备份 ──
    const info = await storageInfo();
    const used = info.usage != null ? `已用 ${(info.usage / 1048576).toFixed(1)} MB` : '';
    wrap.append(el('div', { class: 'section-title', text: '备份' }));
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('button', {
          class: 'btn small primary',
          onclick: async () => {
            const data = await exportAll();
            const d = new Date();
            await saveFile(`墨游_全部备份_${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.json`, JSON.stringify(data));
          },
        }, '导出全部'),
        el('button', {
          class: 'btn small',
          onclick: async () => {
            const f = await pickFile();
            if (!f) return;
            let data;
            try { data = JSON.parse(f.text); } catch { toast('文件格式不对'); return; }
            if (!confirm('导入后，同一个故事会被备份里的版本覆盖。继续？')) return;
            try {
              const r = await importData(data);
              toast(`已导入 ${r.stories} 个故事${r.connections ? `、${r.connections} 个连接（需要重新填密钥）` : ''}`);
              draw();
            } catch (e) { toast('导入失败：' + e.message, 4000); }
          },
        }, '导入备份')
      ),
      el('div', { class: 'hint' },
        '导出的文件不含 API 密钥，可以放心传到别的设备或发给朋友。',
        el('br'), [used, info.persisted === true ? '已开启持久存储' : info.persisted === false ? '系统未允许持久存储，记得常备份' : ''].filter(Boolean).join(' · '))
    ));

    // ── 关于 ──
    wrap.append(el('div', { class: 'section-title', text: '关于' }));
    wrap.append(el('div', { class: 'card hint', style: { marginTop: 0 } },
      `墨游 ${APP_VERSION}`, el('br'),
      '所有故事和密钥只存在这台设备的这个浏览器里，不经过任何服务器（除了你填的 API 地址）。',
      el('br'),
      'iPhone 上，Safari 里打开和主屏图标打开是两份不同的数据。加到主屏后，请一直从图标进入。'
    ));
  }

  // ───── 连接编辑 ─────
  async function editConn(existing) {
    const conns = await getConnections();
    const isNew = !existing;
    const c = existing ? { ...existing } : {
      id: uid(), name: '', format: 'auto', baseUrl: '', apiKey: '', model: '', maxTokens: 8000, mt8000: true, temperature: '', stream: true, createdAt: Date.now(),
    };
    const s = sheet({ title: isNew ? '添加连接' : '编辑连接' });

    const name = el('input', { type: 'text', placeholder: '随便起个名字，例：我的中转' }); name.value = c.name || '';
    const fmt = el('select');
    for (const [k, v] of Object.entries(FORMAT_LABEL)) fmt.append(el('option', { value: k }, v));
    fmt.value = c.format || 'auto';
    const base = el('input', { type: 'text', placeholder: 'https://你的中转站域名/v1', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    base.value = c.baseUrl || '';
    const urlHint = el('div', { class: 'hint', style: { wordBreak: 'break-all' } });
    const key = el('input', { type: 'password', placeholder: 'sk-…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off' });
    key.value = c.apiKey || '';
    key.style.flex = '1';
    const showKey = el('button', { class: 'btn small ghost', style: { whiteSpace: 'nowrap', flex: 'none' }, onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; showKey.textContent = key.type === 'password' ? '显示' : '隐藏'; } }, '显示');
    const dl = el('datalist', { id: 'models-' + c.id });
    const model = el('input', { type: 'text', placeholder: '例：claude-sonnet-4-6、deepseek-chat', list: dl.id, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    model.value = c.model || '';
    const maxT = el('input', { type: 'number', min: '256', step: '256' }); maxT.value = c.maxTokens ?? 8000;
    const temp = el('input', { type: 'number', min: '0', max: '2', step: '0.05', placeholder: '留空' }); temp.value = c.temperature ?? '';
    const streamSw = el('input', { type: 'checkbox' }); streamSw.checked = c.stream !== false;
    const priceIn = el('input', { type: 'number', min: '0', step: '0.01', placeholder: '不填' }); priceIn.value = c.priceIn ?? '';
    const priceOut = el('input', { type: 'number', min: '0', step: '0.01', placeholder: '不填' }); priceOut.value = c.priceOut ?? '';
    const priceCache = el('input', { type: 'number', min: '0', step: '0.01', placeholder: '同输入价' }); priceCache.value = c.priceCache ?? '';
    const currency = el('select'); currency.append(el('option', { value: 'CNY' }, '人民币 ¥'), el('option', { value: 'USD' }, '美元 $')); currency.value = c.currency || 'CNY';
    const log = el('div', { class: 'test-log' });

    const read = () => ({
      ...c, name: name.value.trim(), format: fmt.value, baseUrl: base.value.trim(), apiKey: key.value.trim(),
      model: model.value.trim(), maxTokens: Number(maxT.value) || 8000, mt8000: true, temperature: temp.value === '' ? '' : Number(temp.value),
      stream: streamSw.checked,
      priceIn: priceIn.value === '' ? '' : Number(priceIn.value),
      priceOut: priceOut.value === '' ? '' : Number(priceOut.value),
      priceCache: priceCache.value === '' ? '' : Number(priceCache.value),
      currency: currency.value,
    });
    const refreshUrl = () => {
      const cur = read();
      try {
        const f = guessFormat(cur);
        urlHint.textContent = `实际请求：${normalizeUrl(f, cur.baseUrl)}` + (cur.format === 'auto' ? `（按${FORMAT_LABEL[f]}格式猜测，测试时会自动确认）` : '');
      } catch (e) { urlHint.textContent = e.message; }
    };
    base.addEventListener('input', refreshUrl);
    fmt.addEventListener('change', refreshUrl);
    refreshUrl();

    // 模型列表：iPhone 上输入框自带的候选列表点不出来，所以拉到列表后弹一个可搜索的选择框
    let fetched = [];
    const setFetched = (list) => {
      fetched = list || [];
      dl.replaceChildren(...fetched.map((m) => el('option', { value: m })));
      getModels.textContent = fetched.length ? `选择模型（${fetched.length}）` : '获取模型列表';
    };
    const getModels = el('button', {
      class: 'btn small',
      onclick: async () => {
        if (!fetched.length) {
          getModels.disabled = true; getModels.textContent = '获取中…';
          try {
            setFetched(await listModels(read()));
            if (!fetched.length) toast('列表是空的，只能手动输入模型名');
          } catch (e) { toast('获取失败：' + e.message, 3500); setFetched([]); }
          getModels.disabled = false;
          if (!fetched.length) return;
        }
        const m = await pickModel(fetched, model.value.trim());
        if (m) { model.value = m; toast('已选择 ' + m); }
      },
    }, '获取模型列表');
    const refetch = el('button', { class: 'btn small ghost', onclick: () => { setFetched([]); getModels.click(); } }, '重新获取');

    const testBtn = el('button', {
      class: 'btn primary block',
      onclick: async () => {
        testBtn.disabled = true; testBtn.textContent = '测试中…';
        log.replaceChildren();
        const rows = new Map();
        const icon = { wait: '…', ok: '✓', bad: '✗', info: 'ℹ' };
        const r = await testConnection(read(), ({ id, state, text, detail }) => {
          let row = rows.get(id);
          if (!row) { row = el('div', { class: 's' }); rows.set(id, row); log.append(row); }
          row.replaceChildren(...[el('span', { class: state, text: icon[state] + ' ' }), text,
            detail ? el('pre', { class: 'raw', text: detail }) : null].filter(Boolean));
        });
        if (r.patch) Object.assign(c, r.patch);
        if (r.ok && r.format && fmt.value === 'auto') {
          fmt.value = r.format; refreshUrl();
          log.append(el('div', { class: 's ok', text: `已识别为「${FORMAT_LABEL[r.format]}」格式，保存后生效。` }));
        }
        if (r.models?.length) setFetched(r.models);
        testBtn.disabled = false; testBtn.textContent = '再测一次';
      },
    }, '测试连接');

    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '名称' }), name),
      el('div', { class: 'field' }, el('label', { text: '接口地址' }), base, urlHint,
        el('div', { class: 'hint', text: '中转站一般填到 /v1 为止。官方 Claude 留空并把格式选成“Claude 原生”。' })),
      el('div', { class: 'field' }, el('label', { text: '接口格式' }), fmt,
        el('div', { class: 'hint', text: '不确定就选“自动识别”，测试时会自己判断。' })),
      el('div', { class: 'field' }, el('label', { text: 'API 密钥' }), el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, key, showKey),
        el('div', { class: 'hint', text: '只存在这台设备上，导出备份时不会带出去。' })),
      el('div', { class: 'field' }, el('label', { text: '模型名' }), model, dl, el('div', { class: 'row', style: { marginTop: '6px' } }, getModels, refetch)),
      el('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '输出上限' }), maxT,
          el('div', { class: 'hint', text: '每轮最多写多少（单位是 token）。一章加弹幕和选项常要 5000 左右；开了思考的模型思考也算在里面，可以再调大。太小会写不到选项。' })),
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '温度' }), temp,
          el('div', { class: 'hint', text: '留空 = 模型默认。部分新模型不接受自定义温度。' }))
      ),
      el('div', { class: 'section-title', text: '价格（可选，用来算花费）' }),
      el('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '输入价' }), priceIn),
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '输出价' }), priceOut),
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '缓存命中价' }), priceCache)),
      el('div', { class: 'field' }, el('label', { text: '货币' }), currency,
        el('div', { class: 'hint', text: '单位都是“每百万 token”，照中转站或官方的价格表填。不填就只统计 token、不算钱。' })),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '流式输出', el('small', { text: '边写边显示。测试提示流式有问题时再关掉。' })),
        el('label', { class: 'switch' }, streamSw, el('span'))),
      el('div', { style: { marginTop: '12px' } }, testBtn),
      log
    );

    s.foot.append(...[
      isNew ? null : el('button', {
        class: 'btn danger', style: { marginRight: 'auto' },
        onclick: async () => {
          if (!confirm(`删除连接「${connLabel(c)}」？用它的故事会改用默认连接。`)) return;
          await db.del('connections', c.id);
          if ((await getDefaultConnId()) === c.id) await setDefaultConnId(null);
          s.close(); toast('已删除'); draw();
        },
      }, '删除'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const v = read();
          if (!v.apiKey || !v.model) { toast('密钥和模型名都要填'); return; }
          try {
            await db.put('connections', v);
            if (!conns.length || !(await getDefaultConnId())) await setDefaultConnId(v.id);
            toast('连接已保存');
            s.close();
            draw();
          } catch {}
        },
      }, '保存'),
    ].filter(Boolean));
  }

  // ───── 规则模块编辑 ─────
  async function editModule(existing) {
    const isNew = !existing;
    const m = existing ? { ...existing } : { id: uid(), name: '', text: '', note: '', mode: 'always', keywords: '' };
    const s = sheet({ title: isNew ? '新规则模块' : '编辑模块' });
    const name = el('input', { type: 'text', placeholder: '例：成人场景、弹幕写法、现代奢华' }); name.value = m.name;
    const mode = el('select');
    for (const [k, v] of Object.entries(MODULE_MODES)) mode.append(el('option', { value: k }, v));
    mode.value = m.mode || 'always';
    const kw = el('input', { type: 'text', placeholder: '用顿号分开，例：宴会、晚宴、酒会' }); kw.value = m.keywords || '';
    const kwField = el('div', { class: 'field' }, el('label', { text: '关键词' }), kw, el('div', { class: 'hint', text: '最近的剧情或你的输入里出现其中任何一个，这一轮就发送这个模块。' }));
    const text = el('textarea', { class: 'tall', placeholder: '发给模型的规则正文' }); text.value = m.text; text.style.minHeight = '34vh';
    const note = el('textarea', { placeholder: '为什么定这条、原话、例子……只给自己看，不发给模型，不花钱。' }); note.value = m.note || '';
    const syncKw = () => { kwField.style.display = mode.value === 'keyword' ? '' : 'none'; };
    mode.addEventListener('change', syncKw); syncKw();
    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '名字' }), name),
      el('div', { class: 'field' }, el('label', { text: '什么时候发送' }), mode,
        el('div', { class: 'hint', text: '“一直发送”：启用的故事每轮都带上。“手动开关”：在游玩页右上角打开才带上，适合成人场景这类情境规则。“关键词”：提到时才带上。' })),
      kwField,
      el('div', { class: 'field' }, el('label', { text: '规则正文（发给模型）' }), text),
      el('div', { class: 'field' }, el('label', { text: '备注（不发给模型）' }), note),
    );
    s.foot.append(...[
      isNew ? null : el('button', {
        class: 'btn danger', style: { marginRight: 'auto' },
        onclick: async () => {
          if (!confirm(`删除模块「${m.name}」？启用了它的故事会自动不再发送。`)) return;
          await saveModules((await getModules()).filter((x) => x.id !== m.id));
          s.close(); toast('已删除'); draw();
        },
      }, '删除'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          m.name = name.value.trim(); m.text = text.value; m.note = note.value; m.mode = mode.value; m.keywords = kw.value.trim();
          if (!m.name) { toast('起个名字'); return; }
          const list = await getModules();
          const i = list.findIndex((x) => x.id === m.id);
          if (i >= 0) list[i] = m; else list.push(m);
          await saveModules(list);
          s.close(); toast(isNew ? '模块已添加。记得在故事的“规则”里启用它' : '模块已保存'); draw();
        },
      }, '保存'),
    ].filter(Boolean));
  }

  // ───── 番外模板编辑 ─────
  async function editTemplate(existing) {
    const isNew = !existing;
    const t = existing ? { ...existing } : newTemplate();
    const s = sheet({ title: isNew ? '新番外模板' : '编辑番外模板' });
    const name = el('input', { type: 'text', placeholder: '例：追星论坛体、采访体·侧写' }); name.value = t.name;
    const scope = el('select');
    for (const [k, v] of Object.entries(SCOPES)) if (k !== 'follow') scope.append(el('option', { value: k }, v));
    scope.value = t.scope || 'all';
    const text = el('textarea', { class: 'tall', placeholder: '这种形式怎么写：格式、视角、要有哪些元素、要避免什么' }); text.value = t.text; text.style.minHeight = '36vh';
    const note = el('textarea', { placeholder: '备注，只给自己看，不发给模型' }); note.value = t.note || '';
    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '名字' }), name),
      el('div', { class: 'field' }, el('label', { text: '默认知情范围' }), scope, el('div', { class: 'hint', text: '写番外时可以临时改。' })),
      el('div', { class: 'field' }, el('label', { text: '写法要求（发给模型）' }), text),
      el('div', { class: 'field' }, el('label', { text: '备注（不发给模型）' }), note));
    s.foot.append(...[
      isNew ? null : el('button', {
        class: 'btn danger', style: { marginRight: 'auto' },
        onclick: async () => {
          if (!confirm(`删除模板「${t.name}」？已经写好的番外不受影响。`)) return;
          await saveTemplates((await getTemplates()).filter((x) => x.id !== t.id)); s.close(); toast('已删除'); draw();
        },
      }, '删除'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          t.name = name.value.trim(); t.scope = scope.value; t.text = text.value; t.note = note.value;
          if (!t.name) { toast('起个名字'); return; }
          const list = await getTemplates();
          const i = list.findIndex((x) => x.id === t.id);
          if (i >= 0) list[i] = t; else list.push(t);
          await saveTemplates(list); s.close(); toast('模板已保存'); draw();
        },
      }, '保存'),
    ].filter(Boolean));
  }

  async function editBase() {
    const s = sheet({ title: '番外通用要求' });
    const text = el('textarea', { class: 'tall' }); text.value = await getBase(); text.style.minHeight = '46vh';
    s.body.append(el('div', { class: 'field' }, text, el('div', { class: 'hint', text: '每篇番外都会带上，不管什么形式。可以把你的番外总纲贴在这里。' })));
    s.foot.append(
      el('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: () => { if (confirm('恢复成内置的通用要求？')) text.value = DEFAULT_BASE; } }, '恢复内置'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', { class: 'btn primary', onclick: async () => { await saveBase(text.value); s.close(); toast('已保存'); } }, '保存'));
  }

  await draw();
  if (section === 'new') editConn(null);
  if (section === 'fanwai') requestAnimationFrame(() => document.getElementById('sec-fanwai')?.scrollIntoView({ block: 'start' }));
  if (section === 'modules') requestAnimationFrame(() => document.getElementById('sec-modules')?.scrollIntoView({ block: 'start' }));
}
