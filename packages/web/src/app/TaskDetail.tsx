import { INBOX_NAME, type Task, type TaskList, type UpdateTaskRequest } from '@dida/shared';
import { TaskDateButton } from './DatePicker.js';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton, MenuButton, TaskCheckbox } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { Markdown } from '../ui/Markdown.js';

interface TaskDetailProps {
  task: Task | null;
  lists: TaskList[];
  isMobile: boolean;
  timeZone: string;
  now: Date;
  onBack: () => void;
  onChange: (task: Task, patch: UpdateTaskRequest) => Promise<Task | null>;
}

/** Right-hand pane (desktop) or full page (mobile) for one 任务 (spec 用户故事 21、23–27、31). */
export function TaskDetail({ task, lists, isMobile, timeZone, now, onBack, onChange }: TaskDetailProps) {
  if (!task) {
    return (
      <aside className="detail detail-empty" aria-label="任务详情">
        <EmptyIllustration />
        <p>点击任务标题查看详情</p>
      </aside>
    );
  }
  const list = lists.find((l) => l.id === task.listId);
  const done = task.status === 'completed';

  return (
    <aside className="detail" aria-label="任务详情">
      <header className="detail-header">
        {isMobile && <IconButton icon="chevronLeft" label="返回列表" onClick={onBack} />}
        <TaskCheckbox
          checked={done}
          label={task.title}
          onChange={() => void onChange(task, { status: done ? 'open' : 'completed' })}
        />
        <span className="detail-header-divider" aria-hidden="true" />
        <TaskDateButton
          dates={task.dates}
          timeZone={timeZone}
          now={now}
          isMobile={isMobile}
          onSave={(dates) => void onChange(task, { dates })}
        />
        <span className="detail-status">{done ? '已完成' : ''}</span>
      </header>
      <div className="detail-body">
        <TitleEditor task={task} onSave={(title) => onChange(task, { title })} />
        <DescriptionEditor task={task} onSave={(description) => onChange(task, { description })} />
      </div>
      <footer className="detail-footer">
        <MenuButton
          label={`所属清单：${list?.name ?? INBOX_NAME}`}
          align="start"
          className="detail-move"
          items={lists.map((l) => ({
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
      className={`detail-title ${task.status === 'completed' ? 'detail-title-done' : ''}`}
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
