import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, selectTask, toggleGroup } from './task-selection.js';

/* 多选, checked against the reference (EURO-22 参照图): click 爸5万, Ctrl+click Speaking, Shift+click Xd10000 → 8 tasks. */

const order = ['置顶', '爸5万', '甲状腺', 'Speaking', '申购', '研究', '9月25日', '房贷', 'Xd10000', '问一下'];

describe('selectTask', () => {
  it('reproduces the reference: click, Ctrl+click, then Shift+click from the first click', () => {
    let s = selectTask(order, EMPTY_SELECTION, '爸5万', 'single');
    expect(s).toEqual({ ids: ['爸5万'], anchor: '爸5万' });
    s = selectTask(order, s, 'Speaking', 'toggle');
    expect(s.ids).toEqual(['爸5万', 'Speaking']);
    s = selectTask(order, s, 'Xd10000', 'range');
    expect(s.ids).toEqual(['爸5万', '甲状腺', 'Speaking', '申购', '研究', '9月25日', '房贷', 'Xd10000']);
    expect(s.ids).toHaveLength(8);
  });

  it('Ctrl / Cmd + click removes a selected task and keeps display order', () => {
    let s = selectTask(order, EMPTY_SELECTION, '房贷', 'single');
    s = selectTask(order, s, '甲状腺', 'toggle');
    expect(s.ids).toEqual(['甲状腺', '房贷']);
    s = selectTask(order, s, '房贷', 'toggle');
    expect(s).toEqual({ ids: ['甲状腺'], anchor: '房贷' });
  });

  it('Shift + click upwards, and without an anchor', () => {
    const s = selectTask(order, selectTask(order, EMPTY_SELECTION, '申购', 'single'), '甲状腺', 'range');
    expect(s.ids).toEqual(['甲状腺', 'Speaking', '申购']);
    expect(selectTask(order, EMPTY_SELECTION, '研究', 'range')).toEqual({ ids: ['研究'], anchor: '研究' });
    // The anchor left the view (deleted, other list): start over from the click.
    expect(selectTask(order, { ids: ['gone'], anchor: 'gone' }, '研究', 'range')).toEqual({ ids: ['研究'], anchor: '研究' });
  });

  it('a Ctrl + click on an empty selection sets the anchor', () => {
    const s = selectTask(order, EMPTY_SELECTION, 'Speaking', 'toggle');
    expect(s).toEqual({ ids: ['Speaking'], anchor: 'Speaking' });
  });
});

describe('toggleGroup (全选 / 取消全选 of a group)', () => {
  it('selects the whole group, then unselects it', () => {
    const start = { ids: ['爸5万'], anchor: '爸5万' };
    const all = toggleGroup(order, start, ['研究', '9月25日']);
    expect(all.ids).toEqual(['爸5万', '研究', '9月25日']);
    expect(toggleGroup(order, all, ['研究', '9月25日']).ids).toEqual(['爸5万']);
  });
});
