import {
  SMART_LIST_NAMES,
  sidebarOutline,
  type Filter,
  type SmartListId,
  type CurrentUser,
  type DropPosition,
  type Folder,
  type SidebarItemRef,
  type SidebarOutlineEntry,
  type SidebarResponse,
  type Tag,
  type TaskList,
} from '@dida/shared';
import { useState, type DragEvent, type ReactNode } from 'react';
import { MenuButton, IconButton, type MenuItem } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';

interface SidebarProps {
  sidebar: SidebarResponse | null;
  /** 标签 in display order (parents followed by their children). */
  tags: Tag[];
  currentListId: string | null;
  currentTagId: string | null;
  isDrawer: boolean;
  user: CurrentUser;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
  onOpenList: (listId: string) => void;
  onAddList: (folderId: string | null) => void;
  onAddFolder: () => void;
  onEditList: (list: TaskList) => void;
  onDeleteList: (list: TaskList) => void;
  /** 归档 / 取消归档 a 清单. */
  onArchiveList: (list: TaskList, archived: boolean) => void;
  /** The 回收站 is on screen. */
  trashActive: boolean;
  onOpenTrash: () => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onToggleFolder: (folder: Folder) => void;
  onMove: (dragged: SidebarItemRef, target: SidebarItemRef, position: DropPosition) => void;
  onOpenTag: (tagId: string) => void;
  onAddTag: (parentId: string | null) => void;
  onEditTag: (tag: Tag) => void;
  onDeleteTag: (tag: Tag) => void;
  /** 智能清单 shown above / below the 收件箱 (hidden ones left out). */
  hiddenSmartLists: readonly SmartListId[];
  smartCounts: Record<string, number>;
  currentSmartId: SmartListId | null;
  onOpenSmart: (id: SmartListId) => void;
  onHideSmart: (id: SmartListId) => void;
  filters: Filter[];
  currentFilterId: string | null;
  onOpenFilter: (filterId: string) => void;
  onAddFilter: () => void;
  onEditFilter: (filter: Filter) => void;
  onDeleteFilter: (filter: Filter) => void;
  onOpenSearch: () => void;
}

/** Order of the built-in rows, like the reference: date lists, then 收件箱, then the rest. */
const SMART_BEFORE_INBOX: readonly SmartListId[] = ['today', 'tomorrow', 'week'];
const SMART_AFTER_INBOX: readonly SmartListId[] = ['completed', 'notImportant'];
const SMART_ICONS: Record<SmartListId, IconName> = {
  today: 'today',
  tomorrow: 'tomorrow',
  week: 'week',
  completed: 'doneAll',
  notImportant: 'lowPriority',
};

type DropHint = { key: string; position: DropPosition } | null;

const refKey = (ref: SidebarItemRef) => `${ref.kind}:${ref.id}`;

/** The sidebar without archived 清单: what the tree, drag-and-drop and 上移 / 下移 work on. */
export function activeSidebar(sidebar: SidebarResponse): SidebarResponse {
  return { ...sidebar, lists: sidebar.lists.filter((l) => l.archivedAt === null) };
}

/**
 * 侧栏 (spec 用户故事 12–16、29): 收件箱, then 清单 and 文件夹 in the user's order, the
 * collapsed 已归档的清单 group, 标签, and the 回收站 at the bottom like the reference.
 * Items can be dragged (mouse) or moved with the 上移 / 下移 menu entries (keyboard, touch).
 */
export function Sidebar(props: SidebarProps) {
  const { sidebar, currentListId } = props;
  const [dragged, setDragged] = useState<SidebarItemRef | null>(null);
  const [hint, setHint] = useState<DropHint>(null);
  /** Collapsed parent 标签 (kept for the session only). */
  const [collapsedTags, setCollapsedTags] = useState<ReadonlySet<string>>(new Set());
  /** 已归档的清单 group, collapsed by default like the reference. */
  const [archivedOpen, setArchivedOpen] = useState(false);

  if (!sidebar) {
    return (
      <nav className={`sidebar ${props.isDrawer ? 'sidebar-drawer' : ''}`} aria-label="侧栏" aria-busy="true">
        <p className="sidebar-loading" role="status">
          正在加载…
        </p>
      </nav>
    );
  }

  const inbox = sidebar.lists.find((l) => l.isInbox);
  const listsById = new Map(sidebar.lists.map((l) => [l.id, l]));
  const foldersById = new Map(sidebar.folders.map((f) => [f.id, f]));
  // Archived 清单 leave the tree (and its drag / 上移 / 下移 order) for the 已归档的清单 group.
  const outline = sidebarOutline(activeSidebar(sidebar));
  const archivedLists = sidebar.lists.filter((l) => l.archivedAt !== null).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const count = (listId: string) => sidebar.openTaskCounts[listId] ?? 0;

  /** Entries sharing a level with `entry`, in order (for 上移 / 下移). */
  function siblingsOf(entry: SidebarOutlineEntry): SidebarOutlineEntry[] {
    const level = entry.kind === 'list' ? entry.folderId : null;
    return outline.filter((e) => (e.kind === 'list' ? e.folderId : null) === level);
  }

  function stepItems(entry: SidebarOutlineEntry): MenuItem[] {
    const siblings = siblingsOf(entry);
    const index = siblings.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
    const prev = siblings[index - 1];
    const next = siblings[index + 1];
    const ref: SidebarItemRef = { kind: entry.kind, id: entry.id };
    return [
      { label: '上移', icon: 'arrowUp', disabled: !prev, onSelect: () => prev && props.onMove(ref, prev, 'before') },
      { label: '下移', icon: 'arrowDown', disabled: !next, onSelect: () => next && props.onMove(ref, next, 'after') },
    ];
  }

  function dropPosition(event: DragEvent<HTMLElement>, kind: 'list' | 'folder'): DropPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    if (kind === 'folder' && dragged?.kind === 'list') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  }

  function dragProps(ref: SidebarItemRef) {
    const key = refKey(ref);
    return {
      draggable: true,
      'data-drop': hint?.key === key ? hint.position : undefined,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', key);
        setDragged(ref);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!dragged || refKey(dragged) === key) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const position = dropPosition(event, ref.kind);
        if (hint?.key !== key || hint.position !== position) setHint({ key, position });
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && hint?.key === key) setHint(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (dragged && refKey(dragged) !== key) props.onMove(dragged, ref, dropPosition(event, ref.kind));
        setDragged(null);
        setHint(null);
      },
      onDragEnd: () => {
        setDragged(null);
        setHint(null);
      },
    };
  }

  function listRow(list: TaskList, entry: SidebarOutlineEntry): ReactNode {
    const active = list.id === currentListId;
    const n = count(list.id);
    return (
      <li key={list.id} className={`sidebar-row ${list.folderId ? 'sidebar-row-child' : ''}`} {...dragProps({ kind: 'list', id: list.id })}>
        <a
          href={`/lists/${list.id}`}
          className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          draggable={false}
          onClick={(e) => {
            e.preventDefault();
            props.onOpenList(list.id);
          }}
        >
          <span className="sidebar-item-icon">{list.icon ? <span className="sidebar-emoji">{list.icon}</span> : <Icon name="list" />}</span>
          <span className="sidebar-item-name">{list.name}</span>
          {list.color && <span className="sidebar-color-dot" style={{ background: list.color }} aria-hidden="true" />}
          {n > 0 && (
            <span className="sidebar-count" aria-label={`${n} 个未完成`}>
              {n}
            </span>
          )}
        </a>
        <MenuButton
          className="sidebar-row-menu"
          label={`清单操作：${list.name}`}
          items={[
            { label: '编辑', icon: 'edit', onSelect: () => props.onEditList(list) },
            ...stepItems(entry),
            { label: '归档', icon: 'archive', onSelect: () => props.onArchiveList(list, true) },
            { label: '删除', icon: 'trash', danger: true, onSelect: () => props.onDeleteList(list) },
          ]}
        />
      </li>
    );
  }

  function archivedRow(list: TaskList): ReactNode {
    const active = list.id === currentListId;
    return (
      <li key={list.id} className="sidebar-row sidebar-row-child">
        <a
          href={`/lists/${list.id}`}
          className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            props.onOpenList(list.id);
          }}
        >
          <span className="sidebar-item-icon">{list.icon ? <span className="sidebar-emoji">{list.icon}</span> : <Icon name="list" />}</span>
          <span className="sidebar-item-name">{list.name}</span>
        </a>
        <MenuButton
          className="sidebar-row-menu"
          label={`清单操作：${list.name}`}
          items={[
            { label: '取消归档', icon: 'archive', onSelect: () => props.onArchiveList(list, false) },
            { label: '删除', icon: 'trash', danger: true, onSelect: () => props.onDeleteList(list) },
          ]}
        />
      </li>
    );
  }

  function folderRow(folder: Folder, entry: SidebarOutlineEntry): ReactNode {
    const children = outline.filter((e) => e.kind === 'list' && e.folderId === folder.id);
    const total = children.reduce((sum, c) => sum + count(c.id), 0);
    return (
      <li key={folder.id} className="sidebar-folder">
        <div className="sidebar-row" {...dragProps({ kind: 'folder', id: folder.id })}>
          <button
            type="button"
            className="sidebar-item sidebar-folder-toggle"
            aria-expanded={!folder.collapsed}
            onClick={() => props.onToggleFolder(folder)}
          >
            <span className="sidebar-chevron">
              <Icon name={folder.collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
            </span>
            <span className="sidebar-item-icon">
              <Icon name="folder" />
            </span>
            <span className="sidebar-item-name">{folder.name}</span>
            {total > 0 && folder.collapsed && (
              <span className="sidebar-count" aria-label={`${total} 个未完成`}>
                {total}
              </span>
            )}
          </button>
          <MenuButton
            className="sidebar-row-menu"
            label={`文件夹操作：${folder.name}`}
            items={[
              { label: '在此新建清单', icon: 'plus', onSelect: () => props.onAddList(folder.id) },
              { label: '重命名', icon: 'edit', onSelect: () => props.onRenameFolder(folder) },
              ...stepItems(entry),
              { label: '删除', icon: 'trash', danger: true, onSelect: () => props.onDeleteFolder(folder) },
            ]}
          />
        </div>
        {!folder.collapsed && children.length > 0 && (
          <ul className="sidebar-tree" aria-label={folder.name}>
            {children.map((child) => {
              const list = listsById.get(child.id);
              return list ? listRow(list, child) : null;
            })}
          </ul>
        )}
      </li>
    );
  }

  const topLevel = outline.filter((e) => e.kind === 'folder' || e.folderId === null);

  function toggleTag(tagId: string) {
    setCollapsedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function tagRow(tag: Tag): ReactNode {
    const active = tag.id === props.currentTagId;
    const children = props.tags.filter((t) => t.parentId === tag.id);
    const collapsed = collapsedTags.has(tag.id);
    return (
      <li key={tag.id}>
        <div className={`sidebar-row ${tag.parentId ? 'sidebar-row-child' : ''}`}>
          {children.length > 0 && (
            <button
              type="button"
              className="sidebar-chevron sidebar-tag-chevron"
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? '展开' : '收起'}子标签：${tag.name}`}
              onClick={() => toggleTag(tag.id)}
            >
              <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
            </button>
          )}
          <a
            href={`/tags/${tag.id}`}
            className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              props.onOpenTag(tag.id);
            }}
          >
            <span className="sidebar-item-icon">
              <Icon name="tag" />
            </span>
            <span className="sidebar-item-name">{tag.name}</span>
            {tag.color && <span className="sidebar-color-dot" style={{ background: tag.color }} aria-hidden="true" />}
          </a>
          <MenuButton
            className="sidebar-row-menu"
            label={`标签操作：${tag.name}`}
            items={[
              ...(tag.parentId === null ? [{ label: '添加子标签', icon: 'plus' as const, onSelect: () => props.onAddTag(tag.id) }] : []),
              { label: '编辑', icon: 'edit', onSelect: () => props.onEditTag(tag) },
              { label: '删除', icon: 'trash', danger: true, onSelect: () => props.onDeleteTag(tag) },
            ]}
          />
        </div>
        {children.length > 0 && !collapsed && (
          <ul className="sidebar-tree" aria-label={`${tag.name}的子标签`}>
            {children.map(tagRow)}
          </ul>
        )}
      </li>
    );
  }

  function smartRow(id: SmartListId): ReactNode {
    if (props.hiddenSmartLists.includes(id)) return null;
    const active = id === props.currentSmartId;
    const n = props.smartCounts[id] ?? 0;
    const name = SMART_LIST_NAMES[id];
    return (
      <li key={id} className="sidebar-row">
        <a
          href={`/smart/${id}`}
          className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            props.onOpenSmart(id);
          }}
        >
          <span className="sidebar-item-icon">
            <Icon name={SMART_ICONS[id]} />
          </span>
          <span className="sidebar-item-name">{name}</span>
          {n > 0 && (
            <span className="sidebar-count" aria-label={`${n} 个未完成`}>
              {n}
            </span>
          )}
        </a>
        <MenuButton
          className="sidebar-row-menu"
          label={`智能清单操作：${name}`}
          items={[{ label: '隐藏', icon: 'close', onSelect: () => props.onHideSmart(id) }]}
        />
      </li>
    );
  }

  function filterRow(filter: Filter): ReactNode {
    const active = filter.id === props.currentFilterId;
    return (
      <li key={filter.id} className="sidebar-row">
        <a
          href={`/filters/${filter.id}`}
          className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            props.onOpenFilter(filter.id);
          }}
        >
          <span className="sidebar-item-icon">
            <Icon name="filter" />
          </span>
          <span className="sidebar-item-name">{filter.name}</span>
        </a>
        <MenuButton
          className="sidebar-row-menu"
          label={`过滤器操作：${filter.name}`}
          items={[
            { label: '编辑', icon: 'edit', onSelect: () => props.onEditFilter(filter) },
            { label: '删除', icon: 'trash', danger: true, onSelect: () => props.onDeleteFilter(filter) },
          ]}
        />
      </li>
    );
  }

  const tagIds = new Set(props.tags.map((t) => t.id));
  const topTags = props.tags.filter((t) => t.parentId === null || !tagIds.has(t.parentId));

  return (
    <nav className={`sidebar ${props.isDrawer ? 'sidebar-drawer' : ''}`} aria-label="侧栏">
      {props.isDrawer && (
        <div className="sidebar-drawer-head">
          <button type="button" className="sidebar-account" aria-label={`账户：${props.user.username}`} onClick={props.onOpenAccount}>
            <span className="rail-avatar rail-avatar-small" aria-hidden="true">
              {props.user.username.slice(0, 1).toUpperCase()}
            </span>
            <span>{props.user.username}</span>
          </button>
          <span className="sidebar-drawer-actions">
            <IconButton icon="search" label="搜索" onClick={props.onOpenSearch} />
            <IconButton icon="settings" label="设置" onClick={props.onOpenSettings} />
            <IconButton icon="close" label="关闭侧栏" onClick={props.onClose} />
          </span>
        </div>
      )}
      <ul className="sidebar-tree sidebar-smart" aria-label="智能清单">
        {SMART_BEFORE_INBOX.map(smartRow)}
        {inbox && (
          <li className="sidebar-row">
            <a
              href="/"
              className={`sidebar-item ${inbox.id === currentListId ? 'sidebar-item-active' : ''}`}
              aria-current={inbox.id === currentListId ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                props.onOpenList(inbox.id);
              }}
            >
              <span className="sidebar-item-icon">
                <Icon name="inbox" />
              </span>
              <span className="sidebar-item-name">{inbox.name}</span>
              {count(inbox.id) > 0 && (
                <span className="sidebar-count" aria-label={`${count(inbox.id)} 个未完成`}>
                  {count(inbox.id)}
                </span>
              )}
            </a>
          </li>
        )}
        {SMART_AFTER_INBOX.map(smartRow)}
        {/* 回收站 sits with the 智能清单, after 已完成 / 不重要的. */}
        <li className="sidebar-row">
          <a
            href="/trash"
            className={`sidebar-item ${props.trashActive ? 'sidebar-item-active' : ''}`}
            aria-current={props.trashActive ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              props.onOpenTrash();
            }}
          >
            <span className="sidebar-item-icon">
              <Icon name="trash" />
            </span>
            <span className="sidebar-item-name">回收站</span>
          </a>
        </li>
      </ul>
      <hr className="sidebar-divider" />
      <div className="sidebar-section-head">
        <h2 className="sidebar-section-title">清单</h2>
        <div className="sidebar-section-actions">
          <IconButton icon="folderPlus" label="添加文件夹" size={16} onClick={props.onAddFolder} />
          <IconButton icon="plus" label="添加清单" size={16} onClick={() => props.onAddList(null)} />
        </div>
      </div>
      {topLevel.length === 0 && archivedLists.length === 0 ? (
        <p className="sidebar-hint">用清单把任务分门别类，点击上方 + 新建一个清单</p>
      ) : (
        <ul className="sidebar-tree" aria-label="清单">
          {topLevel.map((entry) => {
            if (entry.kind === 'folder') {
              const folder = foldersById.get(entry.id);
              return folder ? folderRow(folder, entry) : null;
            }
            const list = listsById.get(entry.id);
            return list ? listRow(list, entry) : null;
          })}
          {archivedLists.length > 0 && (
            <li className="sidebar-folder">
              <div className="sidebar-row">
                <button
                  type="button"
                  className="sidebar-item sidebar-folder-toggle"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((v) => !v)}
                >
                  <span className="sidebar-chevron">
                    <Icon name={archivedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                  </span>
                  <span className="sidebar-item-icon">
                    <Icon name="archive" />
                  </span>
                  <span className="sidebar-item-name">已归档的清单</span>
                </button>
              </div>
              {archivedOpen && (
                <ul className="sidebar-tree" aria-label="已归档的清单">
                  {archivedLists.map(archivedRow)}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
      <hr className="sidebar-divider" />
      <div className="sidebar-section-head">
        <h2 className="sidebar-section-title">过滤器</h2>
        <div className="sidebar-section-actions">
          <IconButton icon="plus" label="添加过滤器" size={16} onClick={props.onAddFilter} />
        </div>
      </div>
      {props.filters.length === 0 ? (
        <p className="sidebar-hint">根据清单、时间、优先级、标签等过滤出特定的任务</p>
      ) : (
        <ul className="sidebar-tree" aria-label="过滤器">
          {props.filters.map(filterRow)}
        </ul>
      )}
      <hr className="sidebar-divider" />
      <div className="sidebar-section-head">
        <h2 className="sidebar-section-title">标签</h2>
        <div className="sidebar-section-actions">
          <IconButton icon="plus" label="添加标签" size={16} onClick={() => props.onAddTag(null)} />
        </div>
      </div>
      {topTags.length === 0 ? (
        <p className="sidebar-hint">用标签给任务做跨清单的分类，点击上方 + 新建一个标签</p>
      ) : (
        <ul className="sidebar-tree" aria-label="标签">
          {topTags.map(tagRow)}
        </ul>
      )}
    </nav>
  );
}
