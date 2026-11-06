// 墨游 · 故事设定：世界设定 / 规则（角色在底部菜单的“角色”里）

import { db } from '../db.js';
import { el, toast } from '../util.js';
import { getConnections, connLabel, getModules, MODULE_MODES, go, setCurrentStory } from '../state.js';
import { DEFAULT_RULES } from '../prompt.js';

function sw(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, input, el('span'));
}

export async function render(root, { id, tab = 'setting' }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
  story.cards = story.cards || [];
  story.modules = story.modules || {};

  let saveTimer = 0;
  const savedHint = el('span', { class: 'muted', style: { fontSize: '12px' } });
  const saveNow = async () => {
    story.updatedAt = Date.now();
    try { await db.put('stories', story); savedHint.textContent = '已保存'; setTimeout(() => { savedHint.textContent = ''; }, 1500); } catch {}
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); };

  const body = el('div', { class: 'wrap' });
  const tabs = el('div', { class: 'seg', style: { display: 'flex', margin: '4px 0 14px' } });
  const TABS = [['setting', '世界设定'], ['rules', '规则']];
  for (const [k, label] of TABS) {
    tabs.append(el('button', { class: k === tab ? 'on' : '', style: { flex: 1 }, onclick: () => go(`story/${encodeURIComponent(id)}/${k}`) }, label));
  }

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: async () => { clearTimeout(saveTimer); await saveNow(); go('play/' + encodeURIComponent(id)); } }, '‹'),
      el('div', { class: 'title' }, '故事设定', el('div', { class: 'sub', text: story.title || '未命名故事' })),
      savedHint
    ),
    el('div', { class: 'scroll' }, el('div', { class: 'wrap', style: { paddingBottom: 0 } }, tabs), body)
  ));

  // ───── 设定 ─────
  async function drawSetting() {
    const conns = await getConnections();
    const title = el('input', { type: 'text', oninput: () => { story.title = title.value.trim() || '未命名故事'; saveSoon(); } });
    title.value = story.title || '';
    const connSel = el('select', { onchange: () => { story.connectionId = connSel.value || null; saveSoon(); } });
    connSel.append(el('option', { value: '' }, '跟随默认连接'));
    for (const c of conns) connSel.append(el('option', { value: c.id }, `${connLabel(c)}（${c.model || '未填模型'}）`));
    connSel.value = story.connectionId || '';
    const world = el('textarea', { class: 'tall', placeholder: '世界观、主角是谁、开局处境……角色的详细人设建议写进底部“角色”里的角色卡。', oninput: () => { story.world = world.value; saveSoon(); } });
    world.value = story.world || '';
    world.style.minHeight = '40vh';
    const opening = el('textarea', { placeholder: '可以不填。例：从新婚夜他“醒过来”的那一刻开始。', oninput: () => { story.opening = opening.value; saveSoon(); } });
    opening.value = story.opening || '';
    body.append(
      el('div', { class: 'field' }, el('label', { text: '故事名' }), title),
      el('div', { class: 'field' }, el('label', { text: '使用的连接' }), connSel),
      el('div', { class: 'field' }, el('label', { text: '世界设定' }), world),
      el('div', { class: 'field' }, el('label', { text: '开场（可选）' }), opening),
      el('div', { class: 'card' },
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '弹幕', el('small', { text: '读者实况评论，显示在正文下面' })), sw(story.danmu !== false, (v) => { story.danmu = v; saveSoon(); })),
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '参考选项', el('small', { text: '每轮给 3 个方向不同的行动建议' })), sw(story.options !== false, (v) => { story.options = v; saveSoon(); }))),
      el('div', { class: 'hint', text: '改动会自动保存，下一轮生效。' })
    );
  }

  // ───── 规则 ─────
  async function drawRules() {
    const rules = el('textarea', { class: 'tall', oninput: () => { story.rules = rules.value; saveSoon(); } });
    rules.value = story.rules ?? '';
    rules.style.minHeight = '36vh';
    body.append(
      el('div', { class: 'field' }, el('label', { text: '这个故事自己的规则' }), rules,
        el('div', { class: 'hint' }, '只对这个故事生效。',
          el('a', { href: 'javascript:void 0', onclick: () => { if (confirm('用内置的通用规则替换当前内容？')) { rules.value = DEFAULT_RULES; story.rules = DEFAULT_RULES; saveSoon(); } } }, '恢复内置规则'))),
    );
    const mods = await getModules();
    body.append(el('div', { class: 'section-title', text: '启用的规则模块' }));
    if (!mods.length) {
      body.append(el('div', { class: 'card hint', style: { marginTop: 0 } }, '还没有规则模块。模块是可以在多个故事之间复用的规则块，比如“文风”“弹幕写法”“成人场景”。',
        el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'btn small', onclick: () => go('settings/modules') }, '去添加模块'))));
      return;
    }
    const box = el('div', { class: 'card' });
    for (const m of mods) {
      box.append(el('div', { class: 'switch-row' },
        el('div', { class: 'lbl' }, m.name, el('small', { text: `${MODULE_MODES[m.mode] || MODULE_MODES.always}${m.mode === 'keyword' && m.keywords ? '：' + m.keywords : ''} · ${m.text.length} 字` })),
        sw(!!story.modules[m.id], (v) => { story.modules[m.id] = v; saveSoon(); })));
    }
    body.append(box,
      el('div', { class: 'hint' }, '“手动开关”的模块启用后，要在游玩页右上角“⋯”里打开才会发送，比如进入成人场景前再开。'),
      el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'btn small ghost', onclick: () => go('settings/modules') }, '管理规则模块')));
  }

  function redraw() {
    body.replaceChildren();
    if (tab === 'rules') drawRules();
    else drawSetting();
  }
  redraw();
  return () => { clearTimeout(saveTimer); saveNow(); };
}
