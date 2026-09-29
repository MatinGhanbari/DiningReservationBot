import type { Clock } from '../domain/ports';

/** Wall-clock time. The only place in the codebase allowed to call `new Date()`. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock frozen at a fixed instant, for tests. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}
