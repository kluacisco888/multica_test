import {
  addDays,
  PRIORITIES,
  PRIORITY_LABELS,
  todayIn,
  type BatchAction,
  type Tag,
  type Task,
  type TaskList,
} from '@dida/shared';
import { useId, useState, type FormEvent } from 'react';
import { Button, Dialog, MenuButton, type ContextMenuSection, type MenuItem } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';

/*
 * 批量操作 (spec 用户故事 34), like the reference: with two or more tasks
 * selected the detail column becomes 「已选择 N 项」 with 设置日期 / 优先级 /
 * 清单 / 标签 and the 完成 / 置顶 / 放弃 / 删除 buttons; on a phone a toolbar
 * floats at the bottom of the list. The right-click menu of a selected task
 * offers the same actions (`batchContextSections`).
 */

export interface BatchContext {
  /** The selected tasks, in display order. */
  tasks: Task[];
  lists: TaskList[];
  tags: Tag[];
  timeZone: string;
  now: Date;
  onAction: (action: BatchAction) => void;
  /** 选择日期…: ask for a date. */
  onPickDate: () => void;
}

const allDay = (dueDate: string) => ({ allDay: true as const, startDate: null, dueDate });

export function dateItems(ctx: BatchContext): MenuItem[] {
  const today = todayIn(ctx.now, ctx.timeZone);
  const set = (dueDate: string) => ctx.onAction({ op: 'dates', dates: allDay(dueDate) });
  return [
    { label: '今天', icon: 'today', onSelect: () => set(today) },
    { label: '明天', icon: 'tomorrow', onSelect: () => set(addDays(today, 1)) },
    { label: '下周', icon: 'week', onSelect: () => set(addDays(today, 7)) },
    { label: '选择日期…', icon: 'calendar', onSelect: ctx.onPickDate },
    { label: '清除日期', icon: 'close', onSelect: () => ctx.onAction({ op: 'dates', dates: null }) },
  ];
}

export function priorityItems(ctx: BatchContext): MenuItem[] {
  return PRIORITIES.map((priority) => ({
    label: PRIORITY_LABELS[priority],
    icon: 'flag',
    className: `ui-priority-${priority}`,
    checked: ctx.tasks.every((t) => t.priority === priority),
    onSelect: () => ctx.onAction({ op: 'priority', priority }),
  }));
}

/** 移动到: every 清单 that is not archived. */
export function moveItems(ctx: BatchContext): MenuItem[] {
  return ctx.lists
    .filter((l) => l.archivedAt === null)
    .map((list) => ({
      label: list.name,
      icon: list.isInbox ? 'inbox' : 'list',
      checked: ctx.tasks.every((t) => t.listId === list.id),
      onSelect: () => ctx.onAction({ op: 'move', listId: list.id }),
    }));
}

/** 标签: checked when every selected task has it; choosing it removes it from all, or adds it to all. */
export function tagItems(ctx: BatchContext): MenuItem[] {
  return ctx.tags.map((tag) => {
    const all = ctx.tasks.every((t) => t.tagIds.includes(tag.id));
    return {
      label: tag.parentId ? `${ctx.tags.find((t) => t.id === tag.parentId)?.name ?? ''}/${tag.name}` : tag.name,
      icon: 'tag',
      checked: all,
      onSelect: () => ctx.onAction(all ? { op: 'tags', remove: [tag.id] } : { op: 'tags', add: [tag.id] }),
    };
  });
}

const allPinned = (tasks: Task[]) => tasks.length > 0 && tasks.every((t) => t.pinOrder !== null);
/** Only top-level tasks can be pinned. */
const pinnable = (tasks: Task[]) => tasks.every((t) => t.parentId === null);

export function actionItems(ctx: BatchContext, onDelete: () => void): MenuItem[] {
  const pinned = allPinned(ctx.tasks);
  return [
    {
      label: pinned ? '取消置顶' : '置顶',
      icon: 'pin',
      disabled: !pinnable(ctx.tasks),
      onSelect: () => ctx.onAction({ op: 'pin', pinned: !pinned }),
    },
    { label: '完成', icon: 'check', onSelect: () => ctx.onAction({ op: 'complete' }) },
    { label: '放弃', icon: 'abandon', onSelect: () => ctx.onAction({ op: 'abandon' }) },
    { label: '删除', icon: 'trash', danger: true, onSelect: onDelete },
  ];
}

/** The right-click menu of a selected task while several are selected (the reference's batch menu). */
export function batchContextSections(ctx: BatchContext, onDelete: () => void): ContextMenuSection[] {
  const sections: ContextMenuSection[] = [
    { label: '日期', layout: 'row', items: dateItems(ctx) },
    { label: '优先级', layout: 'row', items: priorityItems(ctx) },
    { label: '移动到', items: moveItems(ctx) },
  ];
  if (ctx.tags.length > 0) sections.push({ label: '标签', multiple: true, items: tagItems(ctx) });
  sections.push({ items: actionItems(ctx, onDelete) });
  return sections;
}

/** 「已选择 N 项」 in the detail column (desktop). */
export function BatchPanel({ ctx, onCancel, onDelete }: { ctx: BatchContext; onCancel: () => void; onDelete: () => void }) {
  const headingId = useId();
  const listName = (() => {
    const ids = new Set(ctx.tasks.map((t) => t.listId));
    return ids.size === 1 ? (ctx.lists.find((l) => ids.has(l.id))?.name ?? '清单') : '多个清单';
  })();
  const actions = actionItems(ctx, onDelete);
  return (
    <aside className="detail batch-panel" aria-labelledby={headingId}>
      <header className="batch-panel-header">
        <h2 id={headingId} className="batch-panel-title" aria-live="polite">
          已选择 <span className="batch-panel-count">{ctx.tasks.length}</span> 项
        </h2>
        <button type="button" className="batch-panel-cancel" onClick={onCancel}>
          取消
        </button>
      </header>
      <div className="batch-panel-fields">
        <BatchField label="设置日期" icon="calendar" items={dateItems(ctx)} />
        <BatchField label="优先级" icon="flag" items={priorityItems(ctx)} />
        <BatchField label={listName} menuLabel={`${listName}：移动到清单`} icon="move" items={moveItems(ctx)} accent />
        <BatchField label="标签" icon="tag" items={tagItems(ctx)} multiple disabled={ctx.tags.length === 0} />
      </div>
      <div className="batch-panel-actions">
        {actions.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`batch-panel-action ${item.danger ? 'batch-panel-action-danger' : ''}`}
            disabled={item.disabled}
            onClick={item.onSelect}
          >
            {item.icon && <Icon name={item.icon} size={20} />}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function BatchField({
  label,
  menuLabel,
  icon,
  items,
  multiple,
  disabled,
  accent,
}: {
  label: string;
  menuLabel?: string;
  icon: IconName;
  items: MenuItem[];
  multiple?: boolean;
  disabled?: boolean;
  accent?: boolean;
}) {
  if (disabled) {
    return (
      <div className="batch-panel-field batch-panel-field-disabled">
        <Icon name={icon} size={16} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <MenuButton
      label={menuLabel ?? label}
      items={items}
      multiple={multiple ?? false}
      align="start"
      className="batch-panel-field-anchor"
      triggerClassName={`batch-panel-field ${accent ? 'batch-panel-field-accent' : ''}`}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </MenuButton>
  );
}

/** The phone toolbar at the bottom of the list (the reference's floating bar). */
export function BatchToolbar({ ctx, onCancel, onDelete }: { ctx: BatchContext; onCancel: () => void; onDelete: () => void }) {
  const actions = actionItems(ctx, onDelete);
  const deleteItem = actions.find((a) => a.label === '删除');
  return (
    <div className="batch-toolbar" role="toolbar" aria-label={`批量操作：已选择 ${ctx.tasks.length} 项`}>
      <span className="batch-toolbar-count" aria-live="polite">
        {ctx.tasks.length}
      </span>
      <MenuButton label="设置日期" icon="calendar" items={dateItems(ctx)} align="start" />
      <MenuButton label="优先级" icon="flag" items={priorityItems(ctx)} align="start" />
      <MenuButton label="移动到清单" icon="move" items={moveItems(ctx)} />
      {ctx.tags.length > 0 && <MenuButton label="标签" icon="tag" items={tagItems(ctx)} multiple />}
      {deleteItem && (
        <button type="button" className="ui-icon-button" aria-label="删除" title="删除" onClick={deleteItem.onSelect}>
          <Icon name="trash" />
        </button>
      )}
      <MenuButton
        label="更多批量操作"
        items={[...actions.filter((a) => a.label !== '删除'), { label: '取消选择', icon: 'close', onSelect: onCancel }]}
      />
    </div>
  );
}

/** 选择日期…: one all-day 截止日期 for every selected task. */
export function BatchDateDialog({ initial, onCancel, onSave }: { initial: string; onCancel: () => void; onSave: (date: string) => void }) {
  const [value, setValue] = useState(initial);
  const inputId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) onSave(value);
  }
  return (
    <Dialog title="设置日期" onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={inputId}>截止日期</label>
          <input id={inputId} type="date" value={value} required autoFocus onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="ui-dialog-footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="submit" variant="primary">
            确定
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
