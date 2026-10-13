import type { Task, TaskList } from '@dida/shared';
import { useState, type FormEvent } from 'react';
import { IconButton, MenuButton, TaskCheckbox } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

interface TaskListPaneProps {
  list: TaskList | null;
  tasks: Task[] | null;
  selectedTaskId: string | null;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onAddTask: (title: string) => Promise<boolean>;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  onEditList: (() => void) | null;
}

/** The middle column: list title, quick add, open tasks, then the 已完成 section (spec 用户故事 20、27、40、65). */
export function TaskListPane(props: TaskListPaneProps) {
  const { list, tasks } = props;
  const [showCompleted, setShowCompleted] = useState(true);
  const open = tasks?.filter((t) => t.status !== 'completed') ?? [];
  const completed = tasks?.filter((t) => t.status === 'completed') ?? [];

  return (
    <main className="list-pane" aria-busy={tasks === null}>
      <header className="list-pane-header">
        <IconButton
          icon="sidebar"
          label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
          aria-expanded={props.sidebarVisible}
          onClick={props.onToggleSidebar}
          className="list-pane-sidebar-toggle"
        />
        <h1 className="list-pane-title">{list?.name ?? ''}</h1>
        {props.onEditList && (
          <MenuButton label="清单更多操作" items={[{ label: '编辑清单', icon: 'edit', onSelect: props.onEditList }]} />
        )}
      </header>

      {list && <QuickAdd key={list.id} listName={list.name} onAdd={props.onAddTask} />}

      {tasks === null ? (
        <p className="list-pane-status" role="status">
          正在加载…
        </p>
      ) : (
        <>
          {open.length > 0 ? (
            <ul className="task-rows" aria-label="任务">
              {open.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  selected={task.id === props.selectedTaskId}
                  onSelectTask={props.onSelectTask}
                  onToggleTask={props.onToggleTask}
                />
              ))}
            </ul>
          ) : (
            completed.length === 0 && (
              <div className="list-pane-empty">
                <p className="list-pane-empty-title">没有任务</p>
                <p>在上方输入任务标题，按回车添加</p>
              </div>
            )
          )}
          {completed.length > 0 && (
            <section className="task-section" aria-labelledby="completed-heading">
              <h2 id="completed-heading" className="task-section-heading">
                <button
                  type="button"
                  className="task-section-toggle"
                  aria-expanded={showCompleted}
                  aria-controls="completed-tasks"
                  onClick={() => setShowCompleted((v) => !v)}
                >
                  <Icon name={showCompleted ? 'chevronDown' : 'chevronRight'} size={12} />
                  <span>已完成</span>
                  <span className="task-section-count">{completed.length}</span>
                </button>
              </h2>
              {showCompleted && (
                <ul id="completed-tasks" className="task-rows" aria-label="已完成的任务">
                  {completed.map((task) => (
                    <TaskRow
                  key={task.id}
                  task={task}
                  selected={task.id === props.selectedTaskId}
                  onSelectTask={props.onSelectTask}
                  onToggleTask={props.onToggleTask}
                />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function QuickAdd({ listName, onAdd }: { listName: string; onAdd: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    // Keep the text if saving failed so nothing typed is lost.
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <form className="quick-add" onSubmit={submit} aria-label="添加任务">
      <span className="quick-add-icon" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <input
        className="quick-add-input"
        aria-label="添加任务"
        placeholder={`添加任务至"${listName}"，回车即可保存`}
        value={title}
        maxLength={512}
        onChange={(e) => setTitle(e.target.value)}
        enterKeyHint="done"
      />
    </form>
  );
}

function TaskRow({
  task,
  selected,
  onSelectTask,
  onToggleTask,
}: { task: Task; selected: boolean } & Pick<TaskListPaneProps, 'onSelectTask' | 'onToggleTask'>) {
  const done = task.status === 'completed';
  return (
    <li className={`task-row ${selected ? 'task-row-selected' : ''} ${done ? 'task-row-done' : ''}`}>
      <TaskCheckbox checked={done} label={task.title} onChange={() => onToggleTask(task)} />
      <button type="button" className="task-row-title" aria-current={selected ? 'true' : undefined} onClick={() => onSelectTask(task.id)}>
        {task.title}
      </button>
      {task.description.trim() && (
        <span className="task-row-meta" title="有描述">
          <Icon name="list" size={14} />
          <span className="visually-hidden">有描述</span>
        </span>
      )}
    </li>
  );
}
