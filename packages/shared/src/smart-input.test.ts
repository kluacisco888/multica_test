import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMART_INPUT_SETTINGS,
  parseSmartInput,
  smartCreateRequest,
  smartInputSettingsSchema,
  type SmartParseContext,
} from './smart-input.js';

/*
 * 智能识别解析器 (spec 用户故事 51–58, Q45). Fixed "now": 2026-10-14 08:00 in
 * Asia/Shanghai, a Wednesday (工作日).
 */

const NOW = new Date('2026-10-14T00:00:00.000Z');
const TZ = 'Asia/Shanghai';
const LIST_WORK = '00000000-0000-4000-8000-0000000000a1';
const LIST_HOME = '00000000-0000-4000-8000-0000000000a2';

const ctx = (extra: Partial<SmartParseContext> = {}): SmartParseContext => ({
  now: NOW,
  timeZone: TZ,
  fuzzyTimes: DEFAULT_SMART_INPUT_SETTINGS,
  lists: [
    { id: LIST_WORK, name: '工作' },
    { id: LIST_HOME, name: '家庭 事务' },
  ],
  ...extra,
});

/** Instant of a Shanghai wall-clock time. */
const sh = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();
const timed = (date: string, time: string) => ({ allDay: false as const, startAt: null, dueAt: sh(date, time) });
const allDay = (date: string) => ({ allDay: true as const, startDate: null, dueDate: date });

describe('智能识别: spec 用户故事 51–54 (Q45)', () => {
  it('51 每天上午背单词 → 每天重复、10:00、标题“背单词”', () => {
    const r = parseSmartInput('每天上午背单词', ctx());
    expect(r.title).toBe('背单词');
    expect(r.repeat).toEqual({ freq: 'daily' });
    expect(r.dates).toEqual(timed('2026-10-14', '10:00'));
    expect(r.reminders).toEqual([]);
  });

  it('52 明天上午提醒我去取快递 → 明天 10:00、准时提醒、标题“去取快递”', () => {
    const r = parseSmartInput('明天上午提醒我去取快递', ctx());
    expect(r.title).toBe('去取快递');
    expect(r.dates).toEqual(timed('2026-10-15', '10:00'));
    expect(r.reminders).toEqual([{ type: 'before', minutes: 0 }]);
    expect(r.repeat).toBeNull();
  });

  it('53 下周三下午3点开会 → 下周三 15:00（具体钟点优先于模糊时间）', () => {
    const r = parseSmartInput('下周三下午3点开会', ctx());
    expect(r.title).toBe('开会');
    expect(r.dates).toEqual(timed('2026-10-21', '15:00'));
  });

  it('54 每个工作日晚上跑步 → 按工作日重复、20:00', () => {
    const r = parseSmartInput('每个工作日晚上跑步', ctx());
    expect(r.title).toBe('跑步');
    expect(r.repeat).toEqual({ freq: 'workday' });
    expect(r.dates).toEqual(timed('2026-10-14', '20:00'));
  });
});

describe('智能识别: positions of the recognised parts', () => {
  it('returns each part with its place in the original text', () => {
    const text = '明天上午提醒我去取快递';
    const r = parseSmartInput(text, ctx());
    expect(r.tokens.map((t) => [t.kind, t.text, t.start, t.end])).toEqual([
      ['date', '明天', 0, 2],
      ['time', '上午', 2, 4],
      ['reminder', '提醒我', 4, 7],
    ]);
    for (const t of r.tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it('keeps one 下午3点 token for a period with a clock time', () => {
    const r = parseSmartInput('下周三下午3点开会', ctx());
    expect(r.tokens.map((t) => [t.kind, t.text])).toEqual([
      ['date', '下周三'],
      ['time', '下午3点'],
    ]);
  });
});

describe('智能识别: dates', () => {
  it.each([
    ['今天写周报', '2026-10-14'],
    ['明天写周报', '2026-10-15'],
    ['后天写周报', '2026-10-16'],
    ['大后天写周报', '2026-10-17'],
    ['周五写周报', '2026-10-16'],
    ['周三写周报', '2026-10-14'],
    ['周一写周报', '2026-10-19'],
    ['星期日写周报', '2026-10-18'],
    ['本周一写周报', '2026-10-12'],
    ['下周一写周报', '2026-10-19'],
    ['下周日写周报', '2026-10-25'],
    ['下下周二写周报', '2026-10-27'],
    ['10月20日写周报', '2026-10-20'],
    ['3月1号写周报', '2027-03-01'],
    ['2027年1月5日写周报', '2027-01-05'],
    ['20号写周报', '2026-10-20'],
    ['3号写周报', '2026-11-03'],
    ['3天后写周报', '2026-10-17'],
  ])('%s → %s, 全天', (text, date) => {
    const r = parseSmartInput(text, ctx());
    expect(r.dates).toEqual(allDay(date));
    expect(r.title).toBe('写周报');
  });

  it('ignores impossible dates', () => {
    const r = parseSmartInput('2月30日写周报', ctx());
    expect(r.dates).toBeNull();
    expect(r.title).toBe('2月30日写周报');
  });

  it('uses the first date when several are written', () => {
    const r = parseSmartInput('明天或后天打电话', ctx());
    expect(r.dates).toEqual(allDay('2026-10-15'));
    expect(r.tokens.map((t) => t.text)).toEqual(['明天']);
    expect(r.title).toBe('或后天打电话');
  });
});

describe('智能识别: times', () => {
  it.each([
    ['明天下午开会', '14:00'],
    ['明天晚上开会', '20:00'],
    ['明天早上开会', '10:00'],
    ['明天中午开会', '12:00'],
    ['明天下午3点开会', '15:00'],
    ['明天下午3点半开会', '15:30'],
    ['明天晚上8点15分开会', '20:15'],
    ['明天上午九点开会', '09:00'],
    ['明天下午两点一刻开会', '14:15'],
    ['明天9点开会', '09:00'],
    ['明天15:40开会', '15:40'],
    ['明天 9:05 开会', '09:05'],
  ])('%s → %s', (text, time) => {
    const r = parseSmartInput(text, ctx());
    expect(r.dates).toEqual(timed('2026-10-15', time));
    expect(r.title).toBe('开会');
  });

  it('uses the 模糊时间 settings', () => {
    const r = parseSmartInput('明天上午开会', ctx({ fuzzyTimes: { morning: '08:30', afternoon: '15:00', evening: '21:00' } }));
    expect(r.dates).toEqual(timed('2026-10-15', '08:30'));
    expect(parseSmartInput('明天晚上开会', ctx({ fuzzyTimes: { morning: '08:30', afternoon: '15:00', evening: '21:00' } })).dates).toEqual(
      timed('2026-10-15', '21:00'),
    );
  });

  it('a time without a date is today, or tomorrow once it has passed', () => {
    expect(parseSmartInput('下午3点开会', ctx()).dates).toEqual(timed('2026-10-14', '15:00'));
    expect(parseSmartInput('7点开会', ctx()).dates).toEqual(timed('2026-10-15', '07:00'));
  });

  it('今晚 is today in the evening', () => {
    const r = parseSmartInput('今晚看电影', ctx());
    expect(r.dates).toEqual(timed('2026-10-14', '20:00'));
    expect(r.title).toBe('看电影');
  });

  it('does not take a bare Chinese number + 点 for a time', () => {
    const r = parseSmartInput('快一点写完', ctx());
    expect(r.tokens).toEqual([]);
    expect(r.dates).toBeNull();
  });
});

describe('智能识别: 重复规则', () => {
  it.each([
    ['每天跑步', { freq: 'daily' }, '2026-10-14'],
    ['每日跑步', { freq: 'daily' }, '2026-10-14'],
    ['每3天跑步', { freq: 'daily', interval: 3 }, '2026-10-14'],
    ['每周跑步', { freq: 'weekly' }, '2026-10-14'],
    ['每周五跑步', { freq: 'weekly', weekdays: [5] }, '2026-10-16'],
    ['每周一、三跑步', { freq: 'weekly', weekdays: [1, 3] }, '2026-10-14'],
    ['每周二和周四跑步', { freq: 'weekly', weekdays: [2, 4] }, '2026-10-15'],
    ['每2周跑步', { freq: 'weekly', interval: 2 }, '2026-10-14'],
    ['每个周末跑步', { freq: 'weekly', weekdays: [0, 6] }, '2026-10-17'],
    ['每工作日跑步', { freq: 'workday' }, '2026-10-14'],
    ['每个休息日跑步', { freq: 'restday' }, '2026-10-17'],
    ['每月跑步', { freq: 'monthly' }, '2026-10-14'],
    ['每月10号跑步', { freq: 'monthly', monthDay: 10 }, '2026-11-10'],
    ['每个月20日跑步', { freq: 'monthly', monthDay: 20 }, '2026-10-20'],
    ['每年跑步', { freq: 'yearly' }, '2026-10-14'],
    ['每年3月8日跑步', { freq: 'yearly', month: 3, monthDay: 8 }, '2027-03-08'],
  ])('%s', (text, repeat, date) => {
    const r = parseSmartInput(text, ctx());
    expect(r.repeat).toEqual(repeat);
    expect(r.dates).toEqual(allDay(date));
    expect(r.title).toBe('跑步');
  });

  it('starts 每个工作日 on the next 工作日 of the calendar', () => {
    // A 法定假日 week: the 14th–16th are off, the next 工作日 is the 19th.
    const off = new Set(['2026-10-14', '2026-10-15', '2026-10-16']);
    const r = parseSmartInput('每个工作日打卡', ctx({ isWorkday: (d) => !off.has(d) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) }));
    expect(r.dates).toEqual(allDay('2026-10-19'));
  });

  it('keeps an explicit date as the first instance', () => {
    const r = parseSmartInput('下周一开始每天跑步', ctx());
    expect(r.repeat).toEqual({ freq: 'daily' });
    expect(r.dates).toEqual(allDay('2026-10-19'));
    expect(r.title).toBe('开始跑步');
  });
});

describe('智能识别: 提醒', () => {
  it('提醒我 on a 全天 task reminds on the day', () => {
    const r = parseSmartInput('明天提醒我交电费', ctx());
    expect(r.dates).toEqual(allDay('2026-10-15'));
    expect(r.reminders).toEqual([{ type: 'day', daysBefore: 0, time: null }]);
    expect(r.title).toBe('交电费');
  });

  it('提醒我 without a date is today', () => {
    const r = parseSmartInput('提醒我交电费', ctx());
    expect(r.dates).toEqual(allDay('2026-10-14'));
    expect(r.reminders).toEqual([{ type: 'day', daysBefore: 0, time: null }]);
  });

  it.each([
    ['明天下午3点开会 *提前30分钟', [{ type: 'before', minutes: 30 }]],
    ['明天下午3点开会 *提前1小时', [{ type: 'before', minutes: 60 }]],
    ['明天下午3点开会 *提前1天', [{ type: 'before', minutes: 1440 }]],
    ['明天下午3点开会 ＊提前5分钟', [{ type: 'before', minutes: 5 }]],
  ])('%s', (text, reminders) => {
    const r = parseSmartInput(text, ctx());
    expect(r.reminders).toEqual(reminders);
    expect(r.title).toBe('开会');
  });

  it('*提前1天 on a 全天 task reminds the day before', () => {
    expect(parseSmartInput('明天交电费 *提前1天', ctx()).reminders).toEqual([{ type: 'day', daysBefore: 1, time: null }]);
  });

  it('drops a minutes reminder a 全天 task cannot have', () => {
    const r = parseSmartInput('明天交电费 *提前30分钟', ctx());
    expect(r.reminders).toEqual([]);
  });

  it('combines 提醒我 and *提前', () => {
    const r = parseSmartInput('明天下午3点提醒我开会 *提前30分钟', ctx());
    expect(r.reminders).toEqual([
      { type: 'before', minutes: 30 },
      { type: 'before', minutes: 0 },
    ]);
  });
});

describe('智能识别: #标签, ~清单, !优先级', () => {
  it('#标签 ends at a space; several are allowed', () => {
    const r = parseSmartInput('买牛奶 #购物 #家里', ctx());
    expect(r.tagNames).toEqual(['购物', '家里']);
    expect(r.title).toBe('买牛奶');
    expect(r.tokens.map((t) => [t.kind, t.text])).toEqual([
      ['tag', '#购物'],
      ['tag', '#家里'],
    ]);
  });

  it('a lone # is not a 标签', () => {
    expect(parseSmartInput('第 # 号', ctx()).tokens).toEqual([]);
  });

  it('~清单 matches the user’s 清单 names, the longest first', () => {
    const r = parseSmartInput('交周报 ~工作', ctx());
    expect(r.listId).toBe(LIST_WORK);
    expect(r.title).toBe('交周报');
    const spaced = parseSmartInput('修水管 ~家庭 事务', ctx());
    expect(spaced.listId).toBe(LIST_HOME);
    expect(spaced.title).toBe('修水管');
  });

  it('~ with an unknown 清单 stays text', () => {
    const r = parseSmartInput('交周报 ~学习', ctx());
    expect(r.listId).toBeNull();
    expect(r.title).toBe('交周报 ~学习');
  });

  it.each([
    ['!高', 'high'],
    ['!中', 'medium'],
    ['!低', 'low'],
    ['！高', 'high'],
  ] as const)('%s → %s', (mark, priority) => {
    const r = parseSmartInput(`交周报 ${mark}`, ctx());
    expect(r.priority).toBe(priority);
    expect(r.title).toBe('交周报');
  });

  it('everything at once', () => {
    const r = parseSmartInput('明天下午3点 交周报 #工作 ~工作 !高 *提前30分钟', ctx());
    expect(r).toMatchObject({
      title: '交周报',
      dates: timed('2026-10-15', '15:00'),
      tagNames: ['工作'],
      listId: LIST_WORK,
      priority: 'high',
      reminders: [{ type: 'before', minutes: 30 }],
    });
  });
});

describe('智能识别: title, 保留识别文字 and 取消识别', () => {
  it('collapses the spaces left behind', () => {
    expect(parseSmartInput('交 明天 周报', ctx()).title).toBe('交 周报');
  });

  it('keeps the whole text when nothing else is left', () => {
    const r = parseSmartInput('明天', ctx());
    expect(r.title).toBe('明天');
    expect(r.dates).toEqual(allDay('2026-10-15'));
  });

  it('保留识别文字 keeps the text in the title', () => {
    const r = parseSmartInput('明天上午提醒我去取快递 #生活', ctx({ keepText: true }));
    expect(r.title).toBe('明天上午提醒我去取快递 #生活');
    expect(r.dates).toEqual(timed('2026-10-15', '10:00'));
    expect(r.tagNames).toEqual(['生活']);
  });

  it('a cancelled part stays text and sets nothing', () => {
    const r = parseSmartInput('明天上午提醒我去取快递', ctx({ ignored: ['上午'] }));
    expect(r.tokens.map((t) => t.text)).toEqual(['明天', '提醒我']);
    expect(r.dates).toEqual(allDay('2026-10-15'));
    expect(r.title).toBe('上午去取快递');
  });

  it('a cancelled phrase is not recognised in pieces', () => {
    const r = parseSmartInput('下周三开会', ctx({ ignored: ['下周三'] }));
    expect(r.tokens).toEqual([]);
    expect(r.title).toBe('下周三开会');
  });

  it('plain text gives an empty result', () => {
    expect(parseSmartInput('  买牛奶  ', ctx())).toEqual({
      tokens: [],
      title: '买牛奶',
      dates: null,
      repeat: null,
      reminders: [],
      priority: null,
      tagNames: [],
      listId: null,
    });
  });
});

describe('智能识别 settings', () => {
  it('defaults: on, text removed, 上午 10:00 / 下午 14:00 / 晚上 20:00', () => {
    expect(smartInputSettingsSchema.parse({})).toEqual({
      enabled: true,
      keepText: false,
      morning: '10:00',
      afternoon: '14:00',
      evening: '20:00',
    });
  });

  it('rejects a broken time', () => {
    expect(smartInputSettingsSchema.safeParse({ morning: '25:00' }).success).toBe(false);
  });
});

describe('智能识别: the new task', () => {
  const TAG_A = '00000000-0000-4000-8000-0000000000f1';
  const TAG_B = '00000000-0000-4000-8000-0000000000f2';

  it('puts what was recognised on top of what the view adds', () => {
    const parsed = parseSmartInput('明天上午提醒我交周报 ~工作 !高 #周报', ctx());
    const request = smartCreateRequest({ tagIds: [TAG_A], dates: allDay('2026-10-14') }, parsed, [TAG_B]);
    expect(request).toEqual({
      title: '交周报',
      listId: LIST_WORK,
      dates: timed('2026-10-15', '10:00'),
      reminders: [{ type: 'before', minutes: 0 }],
      priority: 'high',
      tagIds: [TAG_A, TAG_B],
    });
  });

  it('keeps the view’s own 清单, date and 优先级 when nothing overrides them', () => {
    const parsed = parseSmartInput('交周报 #周报', ctx());
    expect(smartCreateRequest({ listId: LIST_HOME, priority: 'low' }, parsed, [TAG_A])).toEqual({
      title: '交周报',
      listId: LIST_HOME,
      priority: 'low',
      tagIds: [TAG_A],
    });
  });

  it('adds a 重复规则 with its first date', () => {
    const request = smartCreateRequest({}, parseSmartInput('每个工作日晚上跑步', ctx()), []);
    expect(request).toEqual({ title: '跑步', dates: timed('2026-10-14', '20:00'), repeat: { freq: 'workday' } });
  });
});
