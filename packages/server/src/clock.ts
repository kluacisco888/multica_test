export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock for tests: starts at `start` and only moves when told to. */
export function fixedClock(start: Date | string) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(value: Date | string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
