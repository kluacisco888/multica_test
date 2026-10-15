import type { SVGProps } from 'react';

/*
 * Our own line icon set (ADR-0001: no official artwork). 24×24 viewBox,
 * 1.75 stroke, `currentColor`. Icons are decorative by default (aria-hidden);
 * the control around them carries the accessible name.
 */

const paths = {
  /** 置顶: an arrow up to a bar (our own shape). */
  pin: (
    <>
      <path d="M6 4.5h12" />
      <path d="M12 8.5 6.5 14H10v5.5h4V14h3.5Z" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5 6.2 6.3A1.8 1.8 0 0 1 7.9 5h8.2a1.8 1.8 0 0 1 1.7 1.3L20 13.5" />
      <path d="M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5h-4.5a3.5 3.5 0 0 1-7 0Z" />
    </>
  ),
  list: (
    <>
      <path d="M5 7h14M5 12h14M5 17h14" />
    </>
  ),
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.3l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />,
  folderPlus: (
    <>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.3l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  chevronRight: <path d="m10 7 5 5-5 5" />,
  chevronDown: <path d="m7 10 5 5 5-5" />,
  /** 今天 in the narrow 日历 header (the reference's hollow dot). */
  todayDot: <circle cx="12" cy="12" r="4.5" />,
  chevronLeft: <path d="m14 7-5 5 5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  sidebar: (
    <>
      <path d="M4 6.5h16M10 12h10M4 17.5h16" />
      <path d="m4 10 2.5 2L4 14" />
    </>
  ),
  check: <path d="m6 12.5 4 4 8-9" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  trash: (
    <>
      <path d="M5 7h14M10 4h4M7 7l.8 11.2A1.5 1.5 0 0 0 9.3 19.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7" />
    </>
  ),
  /** 清空回收站 */
  sweep: (
    <>
      <path d="M14.5 3.5 11 10" />
      <path d="M7.5 10.5h8.2a1 1 0 0 1 .97 1.24L15.5 16.5h-9l-.95-4.76a1 1 0 0 1 .98-1.24Z" />
      <path d="M6.5 16.5 6 20.5M10.5 16.5v4M14.5 16.5l.5 4" />
    </>
  ),
  /** 归档 */
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4" />
    </>
  ),
  /** 还原 */
  restore: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" />,
  /** 放弃 */
  abandon: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  edit: <path d="m14.5 6 3.5 3.5L9 18.5H5.5V15Z" />,
  arrowUp: <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />,
  arrowDown: <path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" />,
  task: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  logout: (
    <>
      <path d="M14 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H14" />
      <path d="M10 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="9" r="3" />
      <path d="M3.5 18.5a6 6 0 0 1 12 0" />
      <path d="M15 6.2a3 3 0 0 1 0 5.6M17.5 13.6a6 6 0 0 1 3 4.9" />
    </>
  ),
  move: (
    <>
      <path d="M4 7h10M4 12h7M4 17h7" />
      <path d="M15 14h6M18.5 11.5 21 14l-2.5 2.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  /** 四象限: four rounded petals, like the reference's rail entry. */
  matrix: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="3.5" />
      <rect x="13" y="4" width="7" height="7" rx="3.5" />
      <rect x="4" y="13" width="7" height="7" rx="3.5" />
      <rect x="13" y="13" width="7" height="7" rx="3.5" />
    </>
  ),
  /** 倒数日 in the rail: a calendar page with a star, like the reference. */
  countdown: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8.5 3.5v4M15.5 3.5v4" />
      <path d="m12 9.6 1.15 2.33 2.57.37-1.86 1.81.44 2.56L12 15.46l-2.3 1.21.44-2.56-1.86-1.81 2.57-.37Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.75" />
      <path d="M10.3 4.2h3.4l.5 2.1 1.6.9 2.1-.6 1.7 2.9-1.6 1.5v1.9l1.6 1.5-1.7 2.9-2.1-.6-1.6.9-.5 2.1h-3.4l-.5-2.1-1.6-.9-2.1.6-1.7-2.9 1.6-1.5v-1.9L4.4 9.5l1.7-2.9 2.1.6 1.6-.9Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5Z" />
      <path d="M10 20.5h4" />
    </>
  ),
  /** 提醒: an alarm clock, like the reference's task rows. */
  alarm: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 9.5V13l2.25 1.5M4.5 5.5l2.5-2M19.5 5.5l-2.5-2" />
    </>
  ),
  send: <path d="M20 4 3.5 10.5l6.5 3 3 6.5Zm-10 9.5L20 4" />,
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  /* 检查清单 mode: a ticked box and two lines. */
  checklist: (
    <>
      <rect x="4" y="5" width="6" height="6" rx="1.2" />
      <path d="m5.6 8 1.2 1.2 2-2.2M13 8h7M4 16.5h2M9 16.5h11" />
    </>
  ),
  /* 描述 mode: text lines. */
  text: <path d="M5 6.5h14M5 11h14M5 15.5h9" />,
  indent: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="m4 9 3 3-3 3" />
    </>
  ),
  outdent: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M7 9 4 12l3 3" />
    </>
  ),
  /* 子任务: a parent line with a child branching off. */
  subtask: (
    <>
      <path d="M5 5v9a2 2 0 0 0 2 2h4" />
      <rect x="13" y="13" width="7" height="6" rx="1.2" />
      <path d="M9 6.5h11" />
    </>
  ),
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.75} />,
  /** 附件 */
  attachment: <path d="m19.5 11.5-7.4 7.4a4.5 4.5 0 0 1-6.4-6.4l7.8-7.8a3 3 0 0 1 4.25 4.25l-7.8 7.8a1.5 1.5 0 0 1-2.12-2.12l7.1-7.1" />,
  /** 评论 */
  comment: (
    <>
      <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17h0A1.5 1.5 0 0 1 4 15.5v-9A1.5 1.5 0 0 1 5.5 5Z" />
      <path d="M8 10h8M8 13h5" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5Z" />
      <path d="M13.5 3.5v5h5" />
    </>
  ),
  download: <path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14" />,
  /** 优先级 */
  flag: (
    <>
      <path d="M6 20.5V4.5" />
      <path d="M6 5h11.5l-2.5 4.25L17.5 13.5H6" fill="currentColor" fillOpacity={0.15} />
    </>
  ),
  /** 重复 */
  repeat: (
    <>
      <path d="M17 3.5 19.5 6 17 8.5" />
      <path d="M4.5 11.5V10a4 4 0 0 1 4-4h11" />
      <path d="M7 20.5 4.5 18 7 15.5" />
      <path d="M19.5 12.5V14a4 4 0 0 1-4 4h-11" />
    </>
  ),
    /** 标签 */
  tag: (
    <>
      <path d="M4.5 5.9V11a1.5 1.5 0 0 0 .44 1.06l7 7a1.5 1.5 0 0 0 2.12 0l5-5a1.5 1.5 0 0 0 0-2.12l-7-7A1.5 1.5 0 0 0 11 4.5H5.9a1.4 1.4 0 0 0-1.4 1.4Z" />
      <circle cx="8.6" cy="8.6" r="1.3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </>
  ),
  /** 排序 / 分组: up and down arrows like the reference's ⇅. */
  /** 外观: a paint roller, like the reference's 设置 entry. */
  palette: (
    <>
      <rect x="4.5" y="4" width="13" height="5" rx="1.5" />
      <path d="M17.5 6.5h1.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-7v2.5" />
      <rect x="10.5" y="14" width="3" height="6" rx="1" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14.5h8" />
    </>
  ),
  sort: <path d="M8 4.5v15M4.5 8 8 4.5 11.5 8M16 19.5v-15M12.5 16l3.5 3.5 3.5-3.5" />,
  /** 过滤器 */
  filter: <path d="M4.5 5.5h15l-5.75 7v5.25l-3.5 1.75v-7Z" />,
  /** 智能清单 今天: a calendar page. */
  today: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2.5" />
      <path d="M4 9.5h16M8.5 3.5v3M15.5 3.5v3M10 13h2.25v4.5" />
    </>
  ),
  /** 明天: a sunrise. */
  tomorrow: (
    <>
      <path d="M7.5 15.5a4.5 4.5 0 0 1 9 0M4 18.5h16M12 5.5v3M5.6 9.1l1.8 1.8M18.4 9.1l-1.8 1.8" />
    </>
  ),
  /** 最近 7 天 */
  week: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2.5" />
      <path d="M4 9.5h16M8.5 3.5v3M15.5 3.5v3M9.5 13H14l-2.5 4.5" />
    </>
  ),
  /** 已完成 */
  doneAll: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8 12.25 2.75 2.75L16 9.5" />
    </>
  ),
  /** 不重要的: a flag drawn down to the baseline. */
  lowPriority: (
    <>
      <path d="M6 20.5V4.5M6 5h11.5l-2.5 4.25L17.5 13.5H6" />
      <path d="M14 18h6" />
    </>
  ),
  /** 番茄专注: a target, like the reference rail icon. */
  focus: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </>
  ),
  habit: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  grid: (
    <>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </>
  ),
  /** 统计: a small bar chart. */
  chart: (
    <>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 16v-4M12 16V7.5M16.5 16v-6" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
