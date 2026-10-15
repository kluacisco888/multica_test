import {
  statBucketLabel,
  WEEKDAY_NAMES,
  weekday,
  type FocusStatUnit,
  type StatBucket,
  type Statistics,
} from '@dida/shared';
import { useEffect, useId, useState, type ReactNode } from 'react';
import * as api from '../api.js';

/*
 * 统计 (spec 用户故事 102、103), laid out like the reference's 统计 → 总览:
 * a summary bar (任务 / 已完成 / 清单 / 使用天数), then white cards in two
 * columns (one on phones): 概览, 我的成就值 with its 7-day curve, the trends of
 * 已完成, 完成率, 番茄 and 专注时长 (each switchable between 日 / 周 / 月), the
 * 打卡完成率 trend and 本周打卡进展. Charts are inline SVG; each has a text
 * alternative (`aria-label`) listing its values.
 */

const UNIT_LABELS: Record<FocusStatUnit, string> = { day: '日', week: '周', month: '月' };

/** `0h50m` as in the reference 概览. */
function formatHoursMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Axis / bar label: `25m`, `1.5h`. */
function formatMinutesAxis(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

const percent = ({ done, planned }: { done: number; planned: number }) => (planned === 0 ? 0 : Math.round((done / planned) * 100));

export function StatisticsPane({ isMobile, onError }: { isMobile: boolean; onError: (error: unknown) => void }) {
  const [stats, setStats] = useState<Statistics | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchStatistics().then(
      (s) => {
        if (!cancelled) setStats(s);
      },
      (error: unknown) => {
        if (!cancelled) onError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onError]);

  return (
    <main className={`stats-pane ${isMobile ? 'stats-pane-mobile' : ''}`} aria-labelledby="stats-title">
      <header className="stats-header">
        <h1 id="stats-title" className="stats-title">
          统计
        </h1>
      </header>
      {!stats ? (
        <p className="stats-loading" role="status">
          正在加载…
        </p>
      ) : (
        <StatisticsBody stats={stats} />
      )}
    </main>
  );
}

function StatisticsBody({ stats }: { stats: Statistics }) {
  const { summary, overview, achievement, today } = stats;
  const { level } = achievement;
  return (
    <div className="stats-body">
      <section className="stats-summary" aria-label="总计">
        <dl className="stats-summary-items">
          {(
            [
              ['任务', summary.tasks],
              ['已完成', summary.completed],
              ['清单', summary.lists],
              ['使用天数', summary.days],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="stats-summary-item">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="stats-summary-level">
          当前等级 <span className="stats-summary-level-name">{level.name}</span>
          {level.next !== null && <> · 距离下一级还差 {level.next - achievement.score} 分</>}
        </p>
      </section>

      <div className="stats-grid">
        <StatCard title="概览">
          <dl className="stats-overview">
            {(
              [
                ['今日已完成', String(overview.todayCompleted)],
                ['今日番茄', String(overview.todayPomodoros)],
                ['今日专注时长', formatHoursMinutes(overview.todayFocusMs)],
                ['总已完成', String(overview.totalCompleted)],
                ['总番茄', String(overview.totalPomodoros)],
                ['总专注时长', formatHoursMinutes(overview.totalFocusMs)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="stats-overview-item">
                <dt>{label}</dt>
                <dd className="stats-figure">{value}</dd>
              </div>
            ))}
          </dl>
        </StatCard>

        <StatCard
          title="我的成就值"
          action={
            <p className="stats-achievement">
              <span className="stats-achievement-score" aria-label={`成就值 ${achievement.score}`}>
                {achievement.score}
              </span>
              <span className="stats-achievement-badge" title={`等级 ${level.level}`}>
                Lv.{level.level} {level.name}
              </span>
            </p>
          }
        >
          <TrendChart
            kind="area"
            name="成就值趋势"
            points={achievement.history.map((d) => ({ label: d.date === today ? '今天' : `${Number(d.date.slice(8))}日`, value: d.score }))}
            fitToData
          />
        </StatCard>

        <TrendCard stats={stats} title="最近已完成趋势" kind="area" value={(b) => b.completed} />
        <TrendCard stats={stats} title="最近完成率趋势" kind="bar" percent value={(b) => percent(b.completion)} />
        <TrendCard stats={stats} title="最近番茄数趋势" kind="area" value={(b) => b.pomodoros} />
        <TrendCard stats={stats} title="最近专注时长趋势" kind="bar" minutes value={(b) => b.focusMs / 60_000} />
        <TrendCard stats={stats} title="最近打卡完成率趋势" kind="bar" percent value={(b) => percent(b.habits)} />
        <HabitWeekCard week={stats.habitWeek} today={today} />
      </div>
    </div>
  );
}

function StatCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stats-card" aria-labelledby={id}>
      <header className="stats-card-header">
        <h2 id={id} className="stats-card-title">
          {title}
        </h2>
        {action}
      </header>
      <div className="stats-card-body">{children}</div>
    </section>
  );
}

function TrendCard({
  stats,
  title,
  kind,
  value,
  percent: isPercent = false,
  minutes = false,
}: {
  stats: Statistics;
  title: string;
  kind: 'area' | 'bar';
  value: (bucket: StatBucket) => number;
  percent?: boolean;
  minutes?: boolean;
}) {
  const [unit, setUnit] = useState<FocusStatUnit>('day');
  const selectId = useId();
  const points = stats.trends[unit].map((b) => ({ label: statBucketLabel(unit, b, stats.today), value: value(b) }));
  return (
    <StatCard
      title={title}
      action={
        <span className="stats-unit">
          <label htmlFor={selectId} className="visually-hidden">
            {title}的统计周期
          </label>
          <select id={selectId} className="stats-unit-select" value={unit} onChange={(e) => setUnit(e.target.value as FocusStatUnit)}>
            {(Object.keys(UNIT_LABELS) as FocusStatUnit[]).map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </span>
      }
    >
      <TrendChart kind={kind} name={title} points={points} percent={isPercent} minutes={minutes} />
    </StatCard>
  );
}

/* ---- charts ---- */

const W = 440;
const H = 230;
const PAD = { left: 40, right: 12, top: 12, bottom: 30 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Axis ticks from 0 (or from near the data with `fitToData`) to a round top. */
function axis(values: number[], { percent, minutes, fitToData }: { percent: boolean; minutes: boolean; fitToData: boolean }) {
  if (percent) return { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] };
  const hi = Math.max(...values, 0);
  const lo = fitToData ? Math.min(...values) : 0;
  const span = Math.max(hi - lo, minutes ? 5 : 4);
  const raw = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const min = Math.floor(lo / step) * step;
  const ticks = Array.from({ length: 6 }, (_, i) => min + i * step);
  return { min, max: ticks.at(-1)!, ticks };
}

/** Monotone cubic through the points (no overshoot below the data, like the reference curves). */
function smoothPath(xy: [number, number][]): string {
  if (xy.length < 2) return xy.length ? `M${xy[0]![0]},${xy[0]![1]}` : '';
  const n = xy.length;
  const dx = xy.slice(1).map((p, i) => p[0] - xy[i]![0]);
  const slope = xy.slice(1).map((p, i) => (p[1] - xy[i]![1]) / dx[i]!);
  const tangent = xy.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const a = slope[i - 1]!;
    const b = slope[i]!;
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${xy[0]![0]},${xy[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    const [x0, y0] = xy[i]!;
    const [x1, y1] = xy[i + 1]!;
    d += ` C${x0 + h},${y0 + tangent[i]! * h} ${x1 - h},${y1 - tangent[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

function TrendChart({
  kind,
  name,
  points,
  percent = false,
  minutes = false,
  fitToData = false,
}: {
  kind: 'area' | 'bar';
  name: string;
  points: { label: string; value: number }[];
  percent?: boolean;
  minutes?: boolean;
  fitToData?: boolean;
}) {
  const gradientId = useId();
  const { min, max, ticks } = axis(
    points.map((p) => p.value),
    { percent, minutes, fitToData },
  );
  const step = PLOT_W / points.length;
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + PLOT_H - ((v - min) / (max - min || 1)) * PLOT_H;
  const tickLabel = (v: number) => (percent ? `${v}%` : minutes ? formatMinutesAxis(v) : String(v));
  const valueLabel = (v: number) => (percent ? `${v}%` : minutes ? formatMinutesAxis(v) : String(Math.round(v)));
  const description = `${name}：${points.map((p) => `${p.label} ${valueLabel(p.value)}`).join('，')}`;
  const xy = points.map((p, i) => [x(i), y(p.value)] as [number, number]);
  const line = smoothPath(xy);
  const bottom = PAD.top + PLOT_H;

  return (
    <svg className="stats-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={description}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="stats-chart-fill-top" />
          <stop offset="1" className="stats-chart-fill-bottom" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line className="stats-chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="stats-chart-axis" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {tickLabel(t)}
          </text>
        </g>
      ))}
      {kind === 'bar' &&
        points.map((p, i) => (
          <g key={i}>
            <rect className="stats-chart-track" x={x(i) - 3} width={6} y={PAD.top} height={PLOT_H} rx={3} />
            {p.value > 0 && <rect className="stats-chart-bar" x={x(i) - 3} width={6} y={y(p.value)} height={bottom - y(p.value)} rx={3} />}
          </g>
        ))}
      {kind === 'area' && (
        <>
          <path className="stats-chart-area" d={`${line} L${xy.at(-1)![0]},${bottom} L${xy[0]![0]},${bottom} Z`} fill={`url(#${gradientId})`} />
          <path className="stats-chart-line" d={line} />
          {xy.map(([cx, cy], i) => (
            <circle key={i} className="stats-chart-dot" cx={cx} cy={cy} r={3} />
          ))}
        </>
      )}
      {points.map((p, i) => (
        <text key={i} className="stats-chart-axis" x={x(i)} y={H - 10} textAnchor="middle">
          {p.label}
        </text>
      ))}
    </svg>
  );
}

const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

function HabitWeekCard({ week, today }: { week: Statistics['habitWeek']; today: string }) {
  return (
    <StatCard title="本周打卡进展">
      <ol className="stats-habit-week">
        {week.map((d) => {
          const ratio = d.due === 0 ? 0 : d.done / d.due;
          const name = WEEKDAY_NAMES[weekday(d.date)]!;
          return (
            <li key={d.date} className={`stats-habit-day ${d.date === today ? 'stats-habit-today' : ''}`}>
              <svg viewBox="0 0 40 40" className="stats-habit-ring" role="img" aria-label={`${name}：${d.due === 0 ? '没有要打卡的习惯' : `完成 ${d.done}/${d.due}`}`}>
                <circle className="stats-habit-ring-track" cx="20" cy="20" r={RING_R} />
                {ratio > 0 && (
                  <circle
                    className="stats-habit-ring-done"
                    cx="20"
                    cy="20"
                    r={RING_R}
                    strokeDasharray={`${RING_C * ratio} ${RING_C}`}
                    transform="rotate(-90 20 20)"
                  />
                )}
              </svg>
              <span className="stats-habit-label" aria-hidden="true">
                {name.slice(1)}
              </span>
            </li>
          );
        })}
      </ol>
    </StatCard>
  );
}
