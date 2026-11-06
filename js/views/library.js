// 墨游 · 故事列表

import { db, exportStory } from '../db.js';
import { el, ago, menu, saveFile, toast } from '../util.js';
import { getConnections, go, getCurrentStory, setCurrentStory } from '../state.js';
import { openStoryEditor } from './story-edit.js';

export async function render(root) {
  const [stories, conns] = await Promise.all([db.all('stories'), getConnections()]);
  stories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const list = el('div');
  const wrap = el('div', { class: 'wrap' });

  if (!conns.length) {
    wrap.append(el('div', { class: 'card notice' },
      el('div', { style: { fontWeight: '600', marginBottom: '6px' } }, '第一步：添加一个 API 连接'),
      el('div', { class: 'hint', style: { marginTop: 0 } }, '填好接口地址、密钥和模型名，测试通过就能开始玩。'),
      el('div', { class: 'row', style: { marginTop: '10px' } },
        el('button', { class: 'btn primary small', onclick: () => go('settings/new') }, '去添加'))
    ));
  }

  wrap.append(
    el('button', {
      class: 'btn primary block', style: { margin: '4px 0 16px' },
      onclick: async () => {
        const s = await openStoryEditor(null);
        if (s) go('play/' + encodeURIComponent(s.id));
      },
    }, '＋ 新故事'),
    list
  );

  if (!stories.length) {
    list.append(el('div', { class: 'empty' }, '还没有故事。', el('br'), '点上面的按钮，写下世界和角色就能开始。'));
  }

  for (const s of stories) {
    const more = el('button', {
      class: 'icon-btn', 'aria-label': '更多',
      onclick: async (e) => {
        e.stopPropagation();
        const k = await menu(s.title, [
          { key: 'chars', label: '角色' },
          { key: 'edit', label: '世界设定与规则' },
          { key: 'export', label: '导出这个故事', hint: '存成文件，可以传到别的设备或发给朋友（不含密钥）' },
          { key: 'del', label: '删除', danger: true },
        ]);
        if (k === 'edit') go(`story/${encodeURIComponent(s.id)}`);
        else if (k === 'chars') go(`chars/${encodeURIComponent(s.id)}`);
        else if (k === 'export') {
          const data = await exportStory(s.id);
          const d = new Date();
          await saveFile(`墨游_${s.title}_${d.getMonth() + 1}月${d.getDate()}日.json`, JSON.stringify(data, null, 1));
        } else if (k === 'del') {
          if (confirm(`删除「${s.title}」？删除后无法恢复，建议先导出。`)) {
            await db.delStory(s.id);
            if (getCurrentStory() === s.id) setCurrentStory(null);
            toast('已删除');
            go('');
          }
        }
      },
    }, '⋯');
    const meta = s.chapters ? `第 ${s.chapters} 章${s.lastTitle ? ' · ' + s.lastTitle : ''}` : '还没开始';
    list.append(el('div', {
      class: 'card story-card',
      onclick: () => go('play/' + encodeURIComponent(s.id)),
    },
      el('div', { class: 't' }, el('span', { text: s.title || '未命名故事' }), more),
      el('div', { class: 'm', text: meta }),
      el('div', { class: 'd', text: ago(s.updatedAt) })
    ));
  }

  wrap.append(el('div', { class: 'hint', style: { textAlign: 'center', marginTop: '20px' } },
    '故事只存在这台设备的这个浏览器里。记得不时在设置里导出备份。'));

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('div', { class: 'title', style: { paddingLeft: '6px', minHeight: '36px', display: 'flex', alignItems: 'center' } }, '墨游')
    ),
    el('div', { class: 'scroll' }, wrap)
  ));
}
