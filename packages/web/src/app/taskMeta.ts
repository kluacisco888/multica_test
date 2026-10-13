import { PRIORITIES, PRIORITY_LABELS, type Tag, type Task, type UpdateTaskRequest } from '@dida/shared';
import type { CSSProperties } from 'react';
import type { ContextMenuSection, MenuItem } from '../ui/controls.js';

/*
 * 优先级 and 标签 controls shared by the task row (right-click menu) and the
 * task detail (spec 用户故事 18、22).
 */

export function priorityItems(task: Task, onChange: (patch: UpdateTaskRequest) => void): MenuItem[] {
  return PRIORITIES.map((priority) => ({
    label: PRIORITY_LABELS[priority],
    icon: 'flag',
    className: `ui-priority-${priority}`,
    checked: task.priority === priority,
    onSelect: () => {
      if (task.priority !== priority) onChange({ priority });
    },
  }));
}

/** Toggle one 标签 on a task, keeping the order the others were added in. */
export function toggledTagIds(task: Task, tagId: string): string[] {
  return task.tagIds.includes(tagId) ? task.tagIds.filter((id) => id !== tagId) : [...task.tagIds, tagId];
}

export function tagItems(task: Task, tags: Tag[], onChange: (patch: UpdateTaskRequest) => void): MenuItem[] {
  return tags.map((tag) => ({
    label: tag.parentId ? `${tags.find((t) => t.id === tag.parentId)?.name ?? ''}/${tag.name}` : tag.name,
    icon: 'tag',
    checked: task.tagIds.includes(tag.id),
    onSelect: () => onChange({ tagIds: toggledTagIds(task, tag.id) }),
  }));
}

/** 放弃 / 取消放弃 and 删除 (spec 用户故事 28、29), shared by the right-click menu and the detail's more menu. */
export function taskActionItems(task: Task, onChange: (patch: UpdateTaskRequest) => void, onDelete: () => void): MenuItem[] {
  return [
    task.status === 'abandoned'
      ? { label: '取消放弃', icon: 'restore', onSelect: () => onChange({ status: 'open' }) }
      : { label: '放弃', icon: 'abandon', onSelect: () => onChange({ status: 'abandoned' }) },
    { label: '删除', icon: 'trash', danger: true, onSelect: onDelete },
  ];
}

export function taskContextSections(
  task: Task,
  tags: Tag[],
  onChange: (patch: UpdateTaskRequest) => void,
  onDelete: () => void,
): ContextMenuSection[] {
  const sections: ContextMenuSection[] = [{ label: '优先级', layout: 'row', items: priorityItems(task, onChange) }];
  if (tags.length > 0) sections.push({ label: '标签', multiple: true, items: tagItems(task, tags, onChange) });
  sections.push({ items: taskActionItems(task, onChange, onDelete) });
  return sections;
}

/** A task's live 标签 in the order they were added (ids of deleted 标签 are skipped). */
export function tagsOf(task: Task, tags: Tag[]): Tag[] {
  const byId = new Map(tags.map((t) => [t.id, t]));
  return task.tagIds.flatMap((id) => byId.get(id) ?? []);
}

/** Inline style for a 标签 chip: a light tint of the tag colour, like the reference. */
export function chipStyle(tag: Tag): CSSProperties | undefined {
  return tag.color ? ({ '--tag-color': tag.color } as CSSProperties) : undefined;
}
