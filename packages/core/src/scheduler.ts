import type { Scenario } from './schema.js';

export interface Random { next(): number; }
export interface Clock { now(): number; set(delay: number, run: () => void): number; clear(id: number): void; }
export const browserClock: Clock = { now: () => performance.now(), set: (delay, run) => window.setTimeout(run, delay), clear: (id) => clearTimeout(id) };

export class IncreasingGaussianSchedule {
  constructor(private readonly mean: number, private readonly stddev: number) {}

  nextDelay(rng: Random) {
    if (!this.stddev) return this.mean * 1000;
    let value = -1;
    while (value <= 0) {
      const u = Math.max(rng.next(), Number.MIN_VALUE);
      const v = rng.next();
      value = this.mean + this.stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    return value * 1000;
  }
}

type Schedule = Scenario['jumpers'][number]['schedule'];
type Entry = { id: string; strategy: IncreasingGaussianSchedule; rng: Random; deadline: number; timer: number | undefined; remaining: number | undefined };

export class JumperScheduler {
  private readonly entries = new Map<string, Entry>();
  private paused = false;

  constructor(private readonly clock: Clock, private readonly trigger: (id: string) => void) {}

  add(id: string, schedule: Schedule, rng: Random) {
    this.entries.set(id, { id, strategy: this.strategy(schedule), rng, deadline: this.clock.now(), timer: undefined, remaining: undefined });
  }

  update(id: string, schedule: Schedule) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer !== undefined) this.clock.clear(entry.timer);
    entry.timer = undefined;
    entry.remaining = undefined;
    entry.strategy = this.strategy(schedule);
    if (this.paused) return;
    entry.deadline = this.clock.now() + entry.strategy.nextDelay(entry.rng);
    this.arm(entry);
  }

  start() {
    this.paused = false;
    for (const entry of this.entries.values()) {
      entry.deadline = this.clock.now() + (entry.remaining ?? entry.strategy.nextDelay(entry.rng));
      entry.remaining = undefined;
      this.arm(entry);
    }
  }

  pause() {
    this.paused = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clock.clear(entry.timer);
      entry.timer = undefined;
      entry.remaining = Math.max(0, entry.deadline - this.clock.now());
    }
  }

  stop() {
    for (const entry of this.entries.values()) if (entry.timer !== undefined) this.clock.clear(entry.timer);
    this.entries.clear();
  }

  private strategy(schedule: Schedule) {
    return new IncreasingGaussianSchedule(schedule.mean_interval_seconds, schedule.stddev_seconds);
  }

  private arm(entry: Entry) {
    entry.timer = this.clock.set(Math.max(0, entry.deadline - this.clock.now()), () => {
      if (this.paused) return;
      this.trigger(entry.id);
      entry.deadline = this.clock.now() + entry.strategy.nextDelay(entry.rng);
      this.arm(entry);
    });
  }
}
