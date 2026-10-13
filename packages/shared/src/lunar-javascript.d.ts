// Minimal typings for the parts of lunar-javascript@1.7.7 used by `lunar.ts`
// (the package ships no types). Leap months are negative month numbers.
declare module 'lunar-javascript' {
  interface Solar {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    getLunar(): Lunar;
    toYmd(): string;
  }
  interface Lunar {
    getYear(): number;
    /** Negative for a leap month (闰月). */
    getMonth(): number;
    getDay(): number;
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getYearInGanZhi(): string;
    getYearShengXiao(): string;
    /** Name of the 节气 starting on this day, or ''. */
    getJieQi(): string;
    getFestivals(): string[];
    getSolar(): Solar;
  }
  interface LunarMonth {
    getDayCount(): number;
  }
  interface LunarYear {
    /** 0 when the year has no leap month. */
    getLeapMonth(): number;
    getMonth(month: number): LunarMonth | null;
  }
  const lib: {
    Solar: { fromYmd(year: number, month: number, day: number): Solar };
    Lunar: { fromYmd(year: number, month: number, day: number): Lunar };
    LunarYear: { fromYear(year: number): LunarYear };
  };
  export default lib;
}
