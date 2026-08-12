import { describe, expect, it } from 'vitest';
import { ApplicationController, RandomSourceSelector, type PlaybackEvent } from './controller.js';
import { MediaElementAudioEngine } from './audio-engine.js';
import { SourceResolverRegistry, type AudioSourceResolver } from './resolver.js';
import type { Clock, Random } from './scheduler.js';
import type { Scenario, Source } from './schema.js';

class SequenceRandom implements Random {
  private index = 0;
  constructor(private readonly values: number[]) {}
  next() { const value = this.values[this.index % this.values.length]!; this.index += 1; return value; }
}

class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  now() { return this.time; }
  set(delay: number, run: () => void) { const id = this.nextId++; this.timers.set(id, { at: this.time + delay, run }); return id; }
  clear(id: number) { this.timers.delete(id); }
  runNext() {
    const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
    if (!next) throw new Error('No scheduled timer');
    this.timers.delete(next[0]);
    this.time = next[1].at;
    next[1].run();
  }
  get size() { return this.timers.size; }
  get nextDelay() {
    const next = [...this.timers.values()].sort((left, right) => left.at - right.at)[0];
    return next ? next.at - this.time : undefined;
  }
}

class FakeAudioElement extends EventTarget {
  src = '';
  preload = '';
  preservesPitch = true;
  webkitPreservesPitch = true;
  currentTime = 0;
  readyState = 4;
  volume = 1;
  playbackRate = 1;
  loop = false;
  async play() {}
  pause() {}
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

const makeSource = (location: string): Source => ({ location, volume: { min: 1, max: 1 } });
const makeJumper = (id: string, locations: string[]): Scenario['jumpers'][number] => ({
  id,
  sources: locations.map(makeSource),
  schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: 1, stddev_seconds: 0 },
});

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe('RandomSourceSelector', () => {
  it('draws a shuffled fair bag instead of insertion order', () => {
    const selector = new RandomSourceSelector(new SequenceRandom([0, 0]));
    const jumper = makeJumper('birds', ['a.wav', 'b.wav', 'c.wav']);
    expect([selector.next(jumper).location, selector.next(jumper).location, selector.next(jumper).location]).toEqual(['b.wav', 'c.wav', 'a.wav']);
  });
});

describe('ApplicationController playback orchestration', () => {
  it('re-arms every Jumper independently and emits each randomized start', async () => {
    let releases = 0;
    const resolver: AudioSourceResolver = {
      supports: () => true,
      resolve: async (source, context) => ({ id: context.id, url: source.location, mime: 'audio/wav', durationSeconds: 10, release: () => { releases += 1; } }),
    };
    const elements: FakeAudioElement[] = [];
    const engine = new MediaElementAudioEngine(() => {
      const element = new FakeAudioElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    });
    const clock = new FakeClock();
    const rng = new SequenceRandom([0, 0, 0.5, 0.5, 0.5, 0.5]);
    const controller = new ApplicationController('web', new SourceResolverRegistry([resolver]), engine, rng, clock);
    const scenario: Scenario = {
      version: 1,
      name: 'Independent jumpers',
      bases: [],
      jumpers: [makeJumper('birds', ['a.wav', 'b.wav', 'c.wav']), makeJumper('wind', ['wind.wav'])],
    };
    const events: PlaybackEvent[] = [];
    controller.subscribePlayback((event) => events.push(event));
    await controller.load(scenario);
    await controller.start();

    expect(clock.size).toBe(2);
    for (let index = 0; index < 12; index += 1) { clock.runNext(); await flush(); }

    const starts = events.filter((event) => event.type === 'jumper-started');
    expect(starts.filter((event) => event.jumperId === 'birds').map((event) => event.sourceLocation)).toEqual(['b.wav', 'c.wav', 'a.wav']);
    expect(starts.filter((event) => event.jumperId === 'wind')).toHaveLength(3);
    for (const started of starts) {
      const pending = events.find((event) => event.type === 'jumper-will-start' && event.playbackId === started.playbackId)!;
      expect(started.at - pending.at).toBe(80);
    }
    elements[0]!.dispatchEvent(new Event('ended'));
    const firstStart = starts[0]!;
    expect(events).toContainEqual({ type: 'jumper-ended', playbackId: firstStart.playbackId, jumperId: firstStart.jumperId, sourceLocation: firstStart.sourceLocation, at: clock.now() });
    expect(clock.size).toBe(2);
    expect(releases).toBe(0);

    controller.stop();
    expect(controller.snapshot.state).toBe('STOPPED');
    expect(controller.snapshot.scenario?.name).toBe('Independent jumpers');
    await controller.start();
    expect(controller.snapshot.state).toBe('PLAYING');
    await controller.shutdown();
    expect(releases).toBe(4);
  });

  it('applies temporary Jumper schedule values without mutating the loaded scenario', async () => {
    const resolver: AudioSourceResolver = {
      supports: () => true,
      resolve: async (source, context) => ({ id: context.id, url: source.location, mime: 'audio/wav', durationSeconds: 10, release: () => {} }),
    };
    const clock = new FakeClock();
    const controller = new ApplicationController(
      'web',
      new SourceResolverRegistry([resolver]),
      new MediaElementAudioEngine(() => new FakeAudioElement() as unknown as HTMLAudioElement),
      new SequenceRandom([0.5]),
      clock,
    );
    const scenario: Scenario = { version: 1, name: 'Live intervals', bases: [], jumpers: [makeJumper('birds', ['birds.wav'])] };

    await controller.load(scenario);
    controller.setJumperScheduleValue('birds', 'mean_interval_seconds', 0.5);
    expect(controller.getJumperSchedule('birds')).toMatchObject({ mean_interval_seconds: 0.5, stddev_seconds: 0 });
    expect(controller.snapshot.scenario?.jumpers[0]?.schedule).toMatchObject({ mean_interval_seconds: 1, stddev_seconds: 0 });
    await controller.start();
    expect(clock.nextDelay).toBe(500);

    controller.setJumperScheduleValue('birds', 'mean_interval_seconds', 0.2);
    expect(clock.nextDelay).toBe(200);
    controller.setJumperScheduleValue('birds', 'stddev_seconds', 0.05);
    expect(controller.getJumperSchedule('birds')).toMatchObject({ mean_interval_seconds: 0.2, stddev_seconds: 0.05 });
    expect(clock.nextDelay).toBeGreaterThan(0);
    expect(clock.nextDelay).not.toBe(200);
    expect(() => controller.setJumperScheduleValue('birds', 'stddev_seconds', 0.2)).toThrow('Temporary Jumper schedule requires mean > 0 and 0 <= stddev < mean');

    await controller.load(scenario);
    expect(controller.getJumperSchedule('birds')).toEqual(scenario.jumpers[0]?.schedule);
  });
});
