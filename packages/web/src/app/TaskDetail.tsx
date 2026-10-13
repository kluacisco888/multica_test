import {
  compareSortKeys,
  INBOX_NAME,
  PRIORITY_LABELS,
  planIndent,
  planOutdent,
  type NotificationChannel,
  type Tag,
  type Task,
  type TaskList,
  type UpdateTaskRequest,
} from '@dida/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { TaskDateButton } from './DatePicker.js';
import { IconButton, MenuButton, TaskCheckbox } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { Markdown } from '../ui/Markdown.js';
import { ChecklistEditor } from './ChecklistEditor.js';
import { TaskAttachments } from './TaskAttachments.js';
import { TaskComments } from './TaskComments.js';
import { chipStyle, priorityItems, tagItems, tagsOf, taskActionItems } from './taskMeta.js';

interface TaskDetailProps {
  task: Task | null;
  /** All tasks of the current 清单 (for the parent link and the 子任务 list). */
  tasks: Task[];
  lists: TaskList[];
  /** Every 标签 in display order. */
  tags: Tag[];
  /** Shown as the author of 评论. */
  userName: string;
  isMobile: boolean;
  timeZone: string;
  /** 全天提醒时间 setting. */
  allDayReminderTime: string;
  /** The user's 通知渠道, for the 提醒 发送到 choice. */
  channels: NotificationChannel[];
  now: Date;
  onBack: () => void;
  onChange: (task: Task, patch: UpdateTaskRequest) => Promise<Task | null>;
  onSelectTask: (taskId: string) => void;
  onAddSubtask: (parent: Task, title: string) => Promise<boolean>;
  onIndent: (task: Task, outdent: boolean) => boolean;
  /** 删除: into the 回收站. */
  onDelete: (task: Task) => void;
  /** False in a 标签 view, where 缩进 is not offered. */
  indentable: boolean;
  onError: (error: unknown) => void;
}

/** Right-hand pane (desktop) or full page (mobile) for one 任务 (spec 用户故事 18、21、22、23–27、31、35–37). */
export function TaskDetail({
  task,
  tasks,
  lists,
  tags,
  userName,
  isMobile,
  timeZone,
  allDayReminderTime,
  channels,
  now,
  onBack,
  onChange,
  onSelectTask,
  onAddSubtask,
  onIndent,
  onDelete,
  indentable,
  onError,
}: TaskDetailProps) {
  const addSubtaskRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const focusComposerOnOpen = useRef(false);
  useEffect(() => {
    if (composerOpen && focusComposerOnOpen.current) {
      focusComposerOnOpen.current = false;
      composerRef.current?.focus();
    }
  }, [composerOpen]);
  if (!task) {
    return (
      <aside className="detail detail-empty" aria-label="任务详情">
        <EmptyIllustration />
        <p>点击任务标题查看详情</p>
      </aside>
    );
  }
  const list = lists.find((l) => l.id === task.listId);
  const done = task.status !== 'open';
  const abandoned = task.status === 'abandoned';
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
  const children = tasks
    .filter((t) => t.parentId === task.id)
    .sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id));
  const canIndent = indentable && !done && planIndent(tasks, task.id, (t) => t.status === 'open').kind !== 'none';
  const canOutdent = indentable && !done && planOutdent(tasks, task.id).kind !== 'none';
  const checklist = task.kind === 'checklist';
  const change = (patch: UpdateTaskRequest) => void onChange(task, patch);
  const taskTags = tagsOf(task, tags);

  return (
    <aside className="detail" aria-label="任务详情">
      <header className="detail-header">
        {isMobile && <IconButton icon="chevronLeft" label="返回列表" onClick={onBack} />}
        <TaskCheckbox
          checked={done}
          abandoned={abandoned}
          label={task.title}
          priority={task.priority}
          onChange={() => change({ status: done ? 'open' : 'completed' })}
        />
        <span className="detail-header-divider" aria-hidden="true" />
        <TaskDateButton
          dates={task.dates}
          repeat={task.repeat}
          reminders={{ reminders: task.reminders, reminderChannelIds: task.reminderChannelIds }}
          allDayTime={allDayReminderTime}
          channels={channels}
          timeZone={timeZone}
          now={now}
          isMobile={isMobile}
          onSave={(dates, repeat, extra) => void onChange(task, dates ? { dates, repeat, ...extra } : { dates: null })}
        />
        <span className="detail-status">{abandoned ? '已放弃' : done ? '已完成' : ''}</span>
        <MenuButton
          label={`优先级：${PRIORITY_LABELS[task.priority]}`}
          icon="flag"
          className="detail-priority"
          triggerClassName={`ui-priority-${task.priority}`}
          items={priorityItems(task, change)}
        />
      </header>
      <div className="detail-body">
        {parent && (
          <button type="button" className="detail-parent" aria-label={`父任务：${parent.title}`} onClick={() => onSelectTask(parent.id)}>
            <Icon name="subtask" size={14} />
            <span className="detail-parent-title">{parent.title}</span>
          </button>
        )}
        <TitleEditor task={task} onSave={(title) => onChange(task, { title })} />
        <div className="detail-tags">
          {taskTags.length > 0 && (
            <ul className="detail-tag-list" aria-label="标签">
              {taskTags.map((tag) => (
                <li key={tag.id} className="tag-chip" style={chipStyle(tag)}>
                  <span>{tag.name}</span>
                  <button
                    type="button"
                    className="tag-chip-remove"
                    aria-label={`移除标签：${tag.name}`}
                    title="移除标签"
                    onClick={() => change({ tagIds: task.tagIds.filter((id) => id !== tag.id) })}
                  >
                    <Icon name="close" size={10} strokeWidth={2.5} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tags.length > 0 && (
            <MenuButton label="设置标签" align="start" className="detail-tag-add" multiple items={tagItems(task, tags, change)}>
              <Icon name="tag" size={14} />
              {taskTags.length === 0 && <span>标签</span>}
            </MenuButton>
          )}
        </div>
        {checklist ? (
          <ChecklistEditor key={`${task.id}-${task.kind}`} taskId={task.id} onError={onError} />
        ) : (
          <DescriptionEditor key={`${task.id}-${task.kind}`} task={task} onSave={(description) => onChange(task, { description })} />
        )}
        <TaskAttachments taskId={task.id} inputRef={fileInputRef} onError={onError} />
        <Subtasks
          parent={task}
          tasks={tasks}
          childTasks={children}
          inputRef={addSubtaskRef}
          onSelectTask={onSelectTask}
          onToggle={(child) => void onChange(child, { status: child.status !== 'open' ? 'open' : 'completed' })}
          onAdd={(title) => onAddSubtask(task, title)}
        />
        <TaskComments
          taskId={task.id}
          userName={userName}
          timeZone={timeZone}
          composerOpen={composerOpen}
          composerRef={composerRef}
          onError={onError}
        />
      </div>
      <footer className="detail-footer">
        <MenuButton
          label={`所属清单：${list?.name ?? INBOX_NAME}`}
          align="start"
          className="detail-move"
          // An archived 清单 is no place to move a task to (unless it is already there).
          items={lists.filter((l) => l.archivedAt === null || l.id === task.listId).map((l) => ({
            label: l.name,
            icon: l.isInbox ? 'inbox' : 'list',
            checked: l.id === task.listId,
            onSelect: () => {
              if (l.id !== task.listId) void onChange(task, { listId: l.id });
            },
          }))}
        >
          <Icon name={list?.isInbox ? 'inbox' : 'list'} size={16} />
          <span>{list?.name ?? INBOX_NAME}</span>
          <Icon name="chevronDown" size={12} />
        </MenuButton>
        <span className="detail-footer-spacer" />
        <IconButton
          icon="comment"
          label="评论"
          onClick={() => {
            if (composerOpen) composerRef.current?.focus();
            else {
              focusComposerOnOpen.current = true;
              setComposerOpen(true);
            }
          }}
        />
        <IconButton
          icon={checklist ? 'text' : 'checklist'}
          label={checklist ? '切换为描述' : '切换为检查清单'}
          onClick={() => void onChange(task, { kind: checklist ? 'text' : 'checklist' })}
        />
        <MenuButton
          label="任务更多操作"
          items={[
            { label: '添加子任务', icon: 'subtask', onSelect: () => addSubtaskRef.current?.focus() },
            { label: '上传附件', icon: 'attachment', onSelect: () => fileInputRef.current?.click() },
            { label: '缩进（Tab）', icon: 'indent', disabled: !canIndent, onSelect: () => onIndent(task, false) },
            { label: '取消缩进（Shift+Tab）', icon: 'outdent', disabled: !canOutdent, onSelect: () => onIndent(task, true) },
            ...taskActionItems(task, change, () => onDelete(task)),
          ]}
        />
      </footer>
    </aside>
  );
}

/** Grow a textarea to fit its content. */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

function TitleEditor({ task, onSave }: { task: Task; onSave: (title: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(task.title);
  const ref = useAutoHeight(draft);

  function commit() {
    const title = draft.replace(/\s+/g, ' ').trim();
    if (!title) {
      setDraft(task.title); // a task always keeps a title
      return;
    }
    if (title !== task.title) void onSave(title);
  }

  return (
    <textarea
      ref={ref}
      className={`detail-title ${task.status !== 'open' ? 'detail-title-done' : ''}`}
      aria-label="任务标题"
      rows={1}
      maxLength={512}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(task.title);
        }
      }}
    />
  );
}

function DescriptionEditor({ task, onSave }: { task: Task; onSave: (description: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(task.description === '');
  const [draft, setDraft] = useState(task.description);
  const ref = useAutoHeight(draft);
  const focusOnEdit = useRef(false);

  useEffect(() => {
    if (editing && focusOnEdit.current) {
      focusOnEdit.current = false;
      ref.current?.focus();
    }
  }, [editing, ref]);

  function startEditing() {
    focusOnEdit.current = true;
    setEditing(true);
  }

  async function commit() {
    if (draft !== task.description) await onSave(draft);
    if (draft.trim()) setEditing(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(task.description);
      if (task.description.trim()) setEditing(false);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="detail-description-input"
        aria-label="描述"
        placeholder="描述（支持 Markdown）"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
      />
    );
  }

  return (
    <div className="detail-description">
      <div
        className="detail-description-view"
        role="region"
        aria-label="描述"
        onClick={(e) => {
          // Links in the rendered Markdown open normally; anywhere else starts editing.
          if (!(e.target as HTMLElement).closest('a')) startEditing();
        }}
      >
        <Markdown source={task.description} />
      </div>
      <IconButton icon="edit" label="编辑描述" size={16} className="detail-description-edit" onClick={startEditing} />
    </div>
  );
}

/** The 子任务 of the open task, one level, plus an input to add one (spec 用户故事 35). */
function Subtasks({
  parent,
  tasks,
  childTasks,
  inputRef,
  onSelectTask,
  onToggle,
  onAdd,
}: {
  parent: Task;
  tasks: Task[];
  childTasks: Task[];
  inputRef: RefObject<HTMLInputElement | null>;
  onSelectTask: (taskId: string) => void;
  onToggle: (task: Task) => void;
  onAdd: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // Count 子任务 at every level below, like the list shows them.
  const below = countBelow(tasks, parent.id);
  const doneBelow = countBelow(tasks, parent.id, (t) => t.status === 'completed'); // 放弃 never counts as done

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <section className="subtasks" aria-label="子任务">
      {childTasks.length > 0 && (
        <>
          <h2 className="subtasks-heading">
            子任务 <span className="subtasks-count">{`${doneBelow}/${below}`}</span>
          </h2>
          <ul className="subtasks-list" aria-label="子任务列表">
            {childTasks.map((child) => (
              <li key={child.id} className={`subtask-row ${child.status !== 'open' ? 'subtask-row-done' : ''}`}>
                <TaskCheckbox
                  checked={child.status !== 'open'}
                  abandoned={child.status === 'abandoned'}
                  label={child.title}
                  onChange={() => onToggle(child)}
                />
                <button type="button" className="subtask-title" onClick={() => onSelectTask(child.id)}>
                  {child.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form className="subtask-add" onSubmit={submit} aria-label="添加子任务">
        <span className="subtask-add-icon" aria-hidden="true">
          <Icon name="plus" size={14} />
        </span>
        <input
          ref={inputRef}
          className="subtask-add-input"
          aria-label="添加子任务"
          placeholder="添加子任务"
          value={title}
          maxLength={512}
          onChange={(e) => setTitle(e.target.value)}
          enterKeyHint="done"
        />
      </form>
    </section>
  );
}

function countBelow(tasks: Task[], id: string, match: (t: Task) => boolean = () => true): number {
  const kids = tasks.filter((t) => t.parentId === id);
  return kids.reduce((n, k) => n + (match(k) ? 1 : 0) + countBelow(tasks, k.id, match), 0);
}

/** Simple own line drawing for the empty detail pane. */
function EmptyIllustration() {
  return (
    <svg className="detail-empty-art" width="160" height="120" viewBox="0 0 160 120" fill="none" aria-hidden="true">
      <rect x="28" y="18" width="104" height="84" rx="10" stroke="currentColor" strokeWidth="2" />
      <path d="M46 44h50M46 60h68M46 76h40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="m104 38 6 6 12-14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
