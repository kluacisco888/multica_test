import { describeTaskDates, TRASH_RETENTION_DAYS, type TaskList, type TrashedTask } from '@dida/shared';
import { IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

interface TrashPaneProps {
  /** null while loading. */
  tasks: TrashedTask[] | null;
  lists: TaskList[];
  sidebarVisible: boolean;
  timeZone: string;
  now: Date;
  onToggleSidebar: () => void;
  onRestore: (task: TrashedTask) => void;
  onPurge: (task: TrashedTask) => void;
  onEmpty: () => void;
}

/**
 * The 回收站 smart list (spec 用户故事 29、30): deleted tasks, most recently
 * deleted first, each with 还原 and 彻底删除; 清空回收站 in the header. Like the
 * reference there is no quick add, and the rows cannot be ticked.
 */
export function TrashPane(props: TrashPaneProps) {
  const { tasks } = props;
  const listName = (task: TrashedTask) => props.lists.find((l) => l.id === task.listId)?.name;

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
        <h1 className="list-pane-title">回收站</h1>
        <IconButton icon="sweep" label="清空回收站" disabled={!tasks || tasks.length === 0} onClick={props.onEmpty} />
      </header>

      {tasks === null ? (
        <p className="list-pane-status" role="status">
          正在加载…
        </p>
      ) : tasks.length === 0 ? (
        <div className="list-pane-empty">
          <p className="list-pane-empty-title">回收站是空的</p>
          <p>{`删除的任务会在这里保留 ${TRASH_RETENTION_DAYS} 天，之后自动清理`}</p>
        </div>
      ) : (
        <ul className="task-rows trash-rows" aria-label="回收站里的任务">
          {tasks.map((task) => {
            const date = task.dates ? describeTaskDates(task.dates, { now: props.now, timeZone: props.timeZone }) : null;
            const list = listName(task);
            return (
              <li key={task.id} className="task-item">
                <div className="task-row trash-row">
                  <span className="task-row-expand" aria-hidden="true" />
                  <span className={`ui-task-checkbox ui-priority-${task.priority} trash-row-box`} aria-hidden="true">
                    {task.status === 'completed' && <Icon name="check" size={12} strokeWidth={2.5} />}
                    {task.status === 'abandoned' && <Icon name="close" size={10} strokeWidth={2.5} />}
                  </span>
                  <span className="task-row-title trash-row-title">{task.title}</span>
                  {list && <span className="task-row-list">{list}</span>}
                  {task.kind === 'checklist' ? (
                    <span className="task-row-meta" title="检查清单">
                      <Icon name="checklist" size={14} />
                      <span className="visually-hidden">检查清单</span>
                    </span>
                  ) : (
                    task.description.trim() && (
                      <span className="task-row-meta" title="有描述">
                        <Icon name="list" size={14} />
                        <span className="visually-hidden">有描述</span>
                      </span>
                    )
                  )}
                  {date && <span className={`task-row-date ${date.overdue && task.status === 'open' ? 'date-overdue' : ''}`}>{date.text}</span>}
                  <MenuButton
                    className="trash-row-menu"
                    label={`回收站操作：${task.title}`}
                    items={[
                      { label: '还原', icon: 'restore', onSelect: () => props.onRestore(task) },
                      { label: '彻底删除', icon: 'trash', danger: true, onSelect: () => props.onPurge(task) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
