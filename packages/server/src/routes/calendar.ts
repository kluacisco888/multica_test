import type { FastifyInstance } from 'fastify';
import { addDays, calendarDayLabel, calendarRangeSchema, daysBetween, type CalendarDay, type CalendarDaysResponse } from '@dida/shared';
import { solarFestivals, solarToLunar } from '@dida/shared/lunar';
import { sendValidationError } from '../http-errors.js';

/*
 * 日历视图 (spec 用户故事 70): what each day cell shows besides tasks: 农历,
 * 节日 (传统 and 公历), 节气, and the 休 (法定假日) / 班 (调休补班) badge. Both come from the
 * same sources as the rest of the app (EURO-10): `@dida/shared/lunar` and the
 * 工作日日历 of `app.holidays`, so the calendar always agrees with 重复任务.
 * Public data, but like every /api route it needs a session.
 */
export function calendarRoutes(app: FastifyInstance) {
  app.get('/api/calendar/days', async (request, reply) => {
    const query = calendarRangeSchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { from, to } = query.data;
    const workdays = await app.holidays.calendar();
    const days: CalendarDay[] = [];
    for (let i = 0; i <= daysBetween(from, to); i++) {
      const date = addDays(from, i);
      const lunar = solarToLunar(date);
      const info = workdays.dayInfo(date);
      const day = {
        date,
        lunarMonthName: lunar.monthName,
        lunarDayName: lunar.dayName,
        lunarDay: lunar.day,
        festivals: [...lunar.festivals, ...solarFestivals(date)],
        solarTerm: lunar.solarTerm,
        mark: info.isHoliday ? ('holiday' as const) : info.isMakeupWorkday ? ('makeup_workday' as const) : null,
        holidayName: info.holidayName,
      };
      days.push({ ...day, ...calendarDayLabel(day) });
    }
    const response: CalendarDaysResponse = { days };
    return response;
  });
}
