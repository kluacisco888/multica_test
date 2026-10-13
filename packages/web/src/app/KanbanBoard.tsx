import {
  describeRepeatFrequency,
  describeTaskDates,
  dueDayOf,
  keyBetween,
  NEW_COLUMN_NAME,
  PRIORITY_LABELS,
  type Board,
  type BoardColumn,
  type KanbanColumn,
  type Tag,
  type Task,
  type TaskSection,
} from '@dida/shared';
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { IconButton, MenuButton, TaskCheckbox, type MenuItem } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { chipStyle, tagsOf } from './taskMeta.js';

/** What a 清单 board can do; absent on 智能清单 / 过滤器 boards (their columns are automatic). */
export interface ManualBoardActions {
  /** Add a task to a column (null: 未分组). */
  onAddTask: (columnId: string | null, title: string) => Promise<boolean>;
  /** Add a 分栏 with this sort key (null: at the right end). */
  onAddColumn: (name: string, sortOrder: string | null) => Promise<boolean>;
  onRenameColumn: (column: KanbanColumn, name: string) => Promise<boolean>;
  onReorderColumn: (column: KanbanColumn, sortOrder: string) => void;
  onDeleteColumn: (column: KanbanColumn) => void;
  /** A card dropped into a column (null: 未分组), in front of `beforeId` (null: at the end). */
  onDropTask: (taskId: string, columnId: string | null, beforeId: string | null) => void;
}

interface KanbanBoardProps {
  board: Board;
  tags: Tag[];
  selectedTaskId: string | null;
  timeZone: string;
  now: Date;
  /** The task's 清单 name on cross-清单 boards. */
  listName: (task: Task) => string | undefined;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  onOpenMenu: (task: Task, x: number, y: number, opener: HTMLElement | null) => void;
  manual: ManualBoardActions | null;
}

type Editor = { kind: 'new-column'; sortOrder: string | null; afterKey: string | null } | { kind: 'rename'; columnId: string } | null;
type DropHint = { columnKey: string; beforeId: string | null } | null;
const START = '#start';

/**
 * 看板视图 (spec 用户故事 66、67), laid out like the reference: fixed-width
 * columns side by side (scrolling sideways), heading with the open count, a
 * + to add a task and a ··· menu, cards with checkbox, title and dates, and
 * “+ 新分组” after the last column. Cards are dragged between columns with the
 * mouse; the card menu's 移动到分组 does the same from the keyboard or on touch.
 */
export function KanbanBoard(props: KanbanBoardProps) {
  const { board, manual } = props;
  const [editor, setEditor] = useState<Editor>(null);
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [hint, setHint] = useState<DropHint>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const realColumns = board.columns.flatMap((c) => (c.column ? [c.column] : []));

  /** Sort key for a new 分栏 right of `column` (left when `side` is -1); null column: the right end. */
  function keyBeside(column: KanbanColumn | null, side: -1 | 1): string | null {
    if (!column) return null;
    const i = realColumns.findIndex((c) => c.id === column.id);
    const left = side === 1 ? column.sortOrder : (realColumns[i - 1]?.sortOrder ?? null);
    const right = side === 1 ? (realColumns[i + 1]?.sortOrder ?? null) : column.sortOrder;
    return keyBetween(left, right);
  }

  function reorder(column: KanbanColumn, step: -1 | 1) {
    const i = realColumns.findIndex((c) => c.id === column.id);
    const j = i + step;
    if (j < 0 || j >= realColumns.length) return;
    // Past the neighbour: between it and the one after it.
    const neighbour = realColumns[j] as KanbanColumn;
    const beyond = realColumns[j + step]?.sortOrder ?? null;
    manual?.onReorderColumn(column, step === 1 ? keyBetween(neighbour.sortOrder, beyond) : keyBetween(beyond, neighbour.sortOrder));
  }

  function columnMenu(boardColumn: BoardColumn): MenuItem[] {
    const column = boardColumn.column;
    if (!column) return [{ label: '添加分组', icon: 'plus', onSelect: () => setEditor({ kind: 'new-column', sortOrder: keyBetween(null, realColumns[0]?.sortOrder ?? null), afterKey: boardColumn.key }) }];
    const i = realColumns.findIndex((c) => c.id === column.id);
    return [
      { label: '重命名', icon: 'edit', onSelect: () => setEditor({ kind: 'rename', columnId: column.id }) },
      { label: '在左侧添加分组', icon: 'plus', onSelect: () => setEditor({ kind: 'new-column', sortOrder: keyBeside(column, -1), afterKey: previousKey(boardColumn.key) }) },
      { label: '在右侧添加分组', icon: 'plus', onSelect: () => setEditor({ kind: 'new-column', sortOrder: keyBeside(column, 1), afterKey: boardColumn.key }) },
      { label: '向左移动', icon: 'chevronLeft', disabled: i <= 0, onSelect: () => reorder(column, -1) },
      { label: '向右移动', icon: 'chevronRight', disabled: i >= realColumns.length - 1, onSelect: () => reorder(column, 1) },
      { label: '删除分组', icon: 'trash', danger: true, onSelect: () => manual?.onDeleteColumn(column) },
    ];
  }

  /** Slot a new-分栏 form appears after: the column left of `key`, or the start. */
  function previousKey(key: string): string {
    const i = board.columns.findIndex((c) => c.key === key);
    return board.columns[i - 1]?.key ?? START;
  }

  // ---- Drag and drop (mouse); the card menu offers the same move. ----
  function onDragOver(event: DragEvent<HTMLElement>, column: BoardColumn) {
    if (!dragged || !manual) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    let beforeId: string | null = null;
    if (card && card.dataset.cardOpen === 'true') {
      const rect = card.getBoundingClientRect();
      const lower = event.clientY > rect.top + rect.height / 2;
      beforeId = lower ? (card.dataset.nextOpenId ?? null) || null : (card.dataset.cardId as string);
    }
    if (hint?.columnKey !== column.key || hint.beforeId !== beforeId) setHint({ columnKey: column.key, beforeId });
  }

  function onDrop(event: DragEvent<HTMLElement>, column: BoardColumn) {
    if (!dragged || !manual) return;
    event.preventDefault();
    const beforeId = hint?.columnKey === column.key ? hint.beforeId : null;
    manual.onDropTask(dragged, column.column?.id ?? null, beforeId === dragged ? null : beforeId);
    setDragged(null);
    setHint(null);
  }

  const newColumnForm = (afterKey: string | null) =>
    manual && editor?.kind === 'new-column' && editor.afterKey === afterKey ? (
      <div className="kanban-column kanban-column-new" key="new-column">
        <ColumnNameForm
          label="新分组名称"
          initial=""
          onSubmit={async (name) => {
            if (await manual.onAddColumn(name, editor.sortOrder)) setEditor(null);
          }}
          onCancel={() => setEditor(null)}
        />
      </div>
    ) : null;

  return (
    <div className={`kanban ${board.kind === 'auto' ? 'kanban-auto' : ''}`} role="region" aria-label="看板">
      {newColumnForm(START)}
      {board.columns.map((column) => {
        const headingId = `kanban-${column.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
        const renaming = editor?.kind === 'rename' && editor.columnId === column.column?.id;
        const openCards = column.sections.filter((s) => !s.completed).flatMap((s) => s.tasks);
        return (
          <div key={column.key} className="kanban-column-slot">
            <section
              className={`kanban-column ${hint?.columnKey === column.key ? 'kanban-column-drop' : ''}`}
              aria-label={column.title}
              onDragOver={(e) => onDragOver(e, column)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint((h) => (h?.columnKey === column.key ? null : h));
              }}
              onDrop={(e) => onDrop(e, column)}
            >
              <header className="kanban-column-header">
                {renaming && column.column ? (
                  <ColumnNameForm
                    label="分组名称"
                    initial={column.title}
                    onSubmit={async (name) => {
                      if (name === column.title || (column.column && (await manual?.onRenameColumn(column.column, name)))) setEditor(null);
                    }}
                    onCancel={() => setEditor(null)}
                  />
                ) : (
                  <h2 id={headingId} className="kanban-column-title">
                    <span className="kanban-column-name">{column.title}</span>
                    <span className="kanban-column-count">{column.count}</span>
                  </h2>
                )}
                {manual && !renaming && (
                  <>
                    <IconButton
                      icon="plus"
                      size={16}
                      label={`在「${column.title}」中添加任务`}
                      className="kanban-column-action"
                      onClick={() => setAddingIn(column.key)}
                    />
                    <MenuButton label={`分组「${column.title}」更多操作`} items={columnMenu(column)} className="kanban-column-action" />
                  </>
                )}
              </header>
              {manual && addingIn === column.key && (
                <CardAddForm
                  columnTitle={column.title}
                  onAdd={(title) => manual.onAddTask(column.column?.id ?? null, title)}
                  onClose={() => setAddingIn(null)}
                />
              )}
              <div className="kanban-column-body">
                {column.sections.map((section) => {
                  const sectionKey = `${column.key}/${section.key}`;
                  const isCollapsed = collapsed.has(sectionKey);
                  const cards = (
                    <ul className="kanban-cards" aria-label={section.title ? `${column.title} · ${section.title}` : `${column.title}的任务`}>
                      {section.tasks.map((task) => {
                        const index = openCards.findIndex((t) => t.id === task.id);
                        return (
                          <KanbanCard
                            key={task.id}
                            task={task}
                            nextOpenId={index >= 0 ? (openCards[index + 1]?.id ?? '') : ''}
                            dropBefore={hint?.columnKey === column.key && hint.beforeId === task.id}
                            draggable={manual !== null}
                            onDragStart={() => setDragged(task.id)}
                            onDragEnd={() => {
                              setDragged(null);
                              setHint(null);
                            }}
                            {...props}
                          />
                        );
                      })}
                    </ul>
                  );
                  if (!section.title) return <div key={section.key}>{cards}</div>;
                  return (
                    <SectionBlock
                      key={section.key}
                      id={`${headingId}-${section.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                      section={section}
                      collapsed={isCollapsed}
                      onToggle={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(sectionKey)) next.delete(sectionKey);
                          else next.add(sectionKey);
                          return next;
                        })
                      }
                    >
                      {cards}
                    </SectionBlock>
                  );
                })}
                {hint?.columnKey === column.key && hint.beforeId === null && <div className="kanban-drop-end" aria-hidden="true" />}
              </div>
            </section>
            {newColumnForm(column.key)}
          </div>
        );
      })}
      {manual && (
        <div className="kanban-column-slot">
          {editor?.kind === 'new-column' && editor.afterKey === null && editor.sortOrder === null ? (
            newColumnForm(null)
          ) : (
            <button type="button" className="kanban-add-column" onClick={() => setEditor({ kind: 'new-column', sortOrder: null, afterKey: null })}>
              <Icon name="plus" size={16} />
              <span>{NEW_COLUMN_NAME}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SectionBlock({
  id,
  section,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  section: TaskSection;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="kanban-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="kanban-section-heading">
        <button type="button" className="kanban-section-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          <span className={section.overdue ? 'kanban-section-overdue' : undefined}>{section.title}</span>
          <span className="kanban-section-count">{section.tasks.length}</span>
        </button>
      </h3>
      {!collapsed && <div id={id}>{children}</div>}
    </section>
  );
}

function KanbanCard({
  task,
  nextOpenId,
  dropBefore,
  draggable,
  onDragStart,
  onDragEnd,
  tags,
  selectedTaskId,
  timeZone,
  now,
  listName,
  onSelectTask,
  onToggleTask,
  onOpenMenu,
}: KanbanBoardProps & {
  task: Task;
  nextOpenId: string;
  dropBefore: boolean;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const titleRef = useRef<HTMLButtonElement>(null);
  const done = task.status !== 'open';
  const selected = task.id === selectedTaskId;
  const date = task.dates ? describeTaskDates(task.dates, { now, timeZone }) : null;
  const overdue = date?.overdue === true && !done;
  const repeatText = task.dates && task.repeat ? describeRepeatFrequency(task.repeat, dueDayOf(task.dates)) : null;
  const taskTags = tagsOf(task, tags);
  const list = listName(task);
  const hasMeta = date || repeatText || taskTags.length > 0 || list || task.kind === 'checklist' || task.description.trim();

  function onContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    onOpenMenu(task, event.clientX, event.clientY, titleRef.current);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onOpenMenu(task, rect.left + 24, rect.bottom, e.currentTarget);
    }
  }

  return (
    <li
      className={`kanban-card ${selected ? 'kanban-card-selected' : ''} ${done ? 'kanban-card-done' : ''} ${dropBefore ? 'kanban-card-drop-before' : ''}`}
      data-card-id={task.id}
      data-card-open={String(!done)}
      data-next-open-id={nextOpenId}
      draggable={draggable && !done}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
    >
      <div className="kanban-card-main">
        <TaskCheckbox
          checked={done}
          abandoned={task.status === 'abandoned'}
          label={task.title}
          priority={task.priority}
          onChange={() => onToggleTask(task)}
        />
        <button
          ref={titleRef}
          type="button"
          className="kanban-card-title"
          data-task-id={task.id}
          aria-current={selected ? 'true' : undefined}
          aria-description={task.priority !== 'none' ? PRIORITY_LABELS[task.priority] : undefined}
          onClick={() => onSelectTask(task.id)}
          onKeyDown={onKeyDown}
        >
          {task.title}
        </button>
      </div>
      {hasMeta && (
        <div className="kanban-card-meta">
          {date && (
            <span className={`kanban-card-date ${overdue ? 'date-overdue' : ''}`}>
              {date.text}
              {overdue && <span className="visually-hidden">，已过期</span>}
            </span>
          )}
          {task.kind === 'checklist' ? (
            <span className="kanban-card-icon" title="检查清单">
              <Icon name="checklist" size={13} />
              <span className="visually-hidden">检查清单</span>
            </span>
          ) : (
            task.description.trim() && (
              <span className="kanban-card-icon" title="有描述">
                <Icon name="list" size={13} />
                <span className="visually-hidden">有描述</span>
              </span>
            )
          )}
          {repeatText && (
            <span className="kanban-card-icon" title={repeatText}>
              <Icon name="repeat" size={13} />
              <span className="visually-hidden">{`重复：${repeatText}`}</span>
            </span>
          )}
          {list && <span className="kanban-card-list">{list}</span>}
          {taskTags.length > 0 && (
            <ul className="kanban-card-tags" aria-label="标签">
              {taskTags.map((tag) => (
                <li key={tag.id} className="tag-chip" style={chipStyle(tag)}>
                  {tag.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Inline 分栏 name editor: Enter saves, Esc cancels, leaving it empty cancels. */
function ColumnNameForm({
  label,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current) return;
    const trimmed = name.trim();
    if (!trimmed) return onCancel();
    busy.current = true;
    await onSubmit(trimmed);
    busy.current = false;
  }

  return (
    <form className="kanban-name-form" onSubmit={(e) => void submit(e)}>
      <input
        ref={inputRef}
        className="kanban-name-input"
        aria-label={label}
        placeholder="请输入分组名称，回车可创建完成"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => void submit()}
      />
    </form>
  );
}

/** Quick add at the top of a column; stays open for the next task, Esc closes it. */
function CardAddForm({ columnTitle, onAdd, onClose }: { columnTitle: string; onAdd: (title: string) => Promise<boolean>; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <form className="kanban-card-add" onSubmit={(e) => void submit(e)}>
      <input
        className="kanban-card-add-input"
        aria-label={`添加任务到「${columnTitle}」`}
        placeholder="添加任务，回车即可保存"
        value={title}
        maxLength={512}
        autoFocus
        enterKeyHint="done"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (!title.trim()) onClose();
        }}
      />
    </form>
  );
}
