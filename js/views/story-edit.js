// 墨游 · 新建 / 编辑故事设定

import { db } from '../db.js';
import { el, sheet, toast, uid } from '../util.js';
import { getConnections, getDefaultRules, connLabel } from '../state.js';
import { DEFAULT_RULES } from '../prompt.js';

function switchRow(label, sub, checked) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  const row = el('div', { class: 'switch-row' },
    el('div', { class: 'lbl' }, label, sub ? el('small', { text: sub }) : null),
    el('label', { class: 'switch' }, input, el('span'))
  );
  return { row, input };
}

/** 打开设定编辑。返回保存后的故事；取消返回 null */
export function openStoryEditor(existing, prefill = null) {
  return new Promise(async (resolve) => {
    let saved = null;
    const isNew = !existing;
    const story = existing ? { ...existing } : {
      id: uid(), title: '', world: '', rules: await getDefaultRules(), opening: '',
      danmu: true, options: true, connectionId: null, headId: null,
      createdAt: Date.now(), updatedAt: Date.now(), schema: 1,
    };
    if (!existing && prefill) {
      for (const k of ['title', 'world', 'opening']) if (prefill[k]) story[k] = prefill[k];
      if (prefill.rulesExtra?.trim()) story.rules = (story.rules || '').trim() + '\n\n' + prefill.rulesExtra.trim();
    }
    const conns = await getConnections();
    const s = sheet({ title: isNew ? '新故事' : '故事设定', onClose: () => resolve(saved) });

    const title = el('input', { type: 'text', placeholder: '例：霜骨' });
    title.value = story.title || '';

    const connSel = el('select');
    connSel.append(el('option', { value: '' }, '跟随默认连接'));
    for (const c of conns) connSel.append(el('option', { value: c.id }, `${connLabel(c)}（${c.model || '未填模型'}）`));
    connSel.value = story.connectionId || '';

    const world = el('textarea', { class: 'tall', placeholder: '世界观、主角是谁、登场角色和他们的人设、开局处境……写得越具体，角色越不容易走样。' });
    world.value = story.world || '';

    const rules = el('textarea', { class: 'tall' });
    rules.value = story.rules ?? '';

    const opening = el('textarea', { placeholder: '可以不填。例：从新婚夜他“醒过来”的那一刻开始。' });
    opening.value = story.opening || '';

    const dm = switchRow('弹幕', '读者实况评论，显示在正文下面', story.danmu !== false);
    const op = switchRow('参考选项', '每轮给 3 个方向不同的行动建议', story.options !== false);

    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '故事名' }), title),
      el('div', { class: 'field' }, el('label', { text: '使用的连接' }), connSel,
        conns.length ? null : el('div', { class: 'hint', text: '还没有连接，先去设置里添加一个。' })),
      el('div', { class: 'field' }, el('label', { text: '世界与角色设定' }), world),
      el('div', { class: 'field' }, el('label', { text: '开场（可选）' }), opening),
      el('div', { class: 'field' },
        el('label', { text: '规则' }), rules,
        el('div', { class: 'hint' },
          '这份规则只属于这个故事；新故事会复制设置里的“默认规则”。',
          el('br'),
          el('a', { href: 'javascript:void 0', onclick: () => { if (confirm('用内置的通用规则替换当前内容？')) rules.value = DEFAULT_RULES; } }, '恢复内置规则')
        )
      ),
      el('div', { class: 'card' }, dm.row, op.row),
    );
    s.foot.append(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          story.title = title.value.trim() || '未命名故事';
          story.connectionId = connSel.value || null;
          story.world = world.value;
          story.rules = rules.value;
          story.opening = opening.value;
          story.danmu = dm.input.checked;
          story.options = op.input.checked;
          story.updatedAt = Date.now();
          try {
            await db.put('stories', story);
            saved = story;
            toast(isNew ? '故事已创建' : '设定已保存');
            s.close();
          } catch {}
        },
      }, isNew ? '创建' : '保存')
    );
    if (isNew) setTimeout(() => title.focus(), 80);
  });
}
