import { type AudioRate, MediaElementAudioEngine } from './audio-engine.js';
import { type RuntimePolicy, type Scenario, type Source, hydrateCandidate } from './schema.js';
import { type Clock, type Random, browserClock, JumperScheduler } from './scheduler.js';
import type { ResolvedSource, SourceResolverRegistry } from './resolver.js';

export type ApplicationState = 'LOADING' | 'READY' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'STOPPED' | 'ERROR';
export interface Snapshot { state: ApplicationState; scenario?: Scenario; rate: AudioRate; error?: string; }
export interface JumperWillStartEvent { type: 'jumper-will-start'; playbackId: string; jumperId: string; sourceLocation: string; at: number; }
export interface JumperStartedEvent { type: 'jumper-started'; playbackId: string; jumperId: string; sourceLocation: string; at: number; }
export interface JumperEndedEvent { type: 'jumper-ended'; playbackId: string; jumperId: string; sourceLocation: string; at: number; }
export type PlaybackEvent = JumperWillStartEvent | JumperStartedEvent | JumperEndedEvent;
export type JumperScheduleField = 'mean_interval_seconds' | 'stddev_seconds';

export class RandomSourceSelector {
  private readonly bags = new Map<string, Source[]>();
  private readonly previous = new Map<string, Source>();

  constructor(private readonly rng: Random) {}

  clear() {
    this.bags.clear();
    this.previous.clear();
  }

  next(jumper: Scenario['jumpers'][number]): Source {
    let bag = this.bags.get(jumper.id);
    if (!bag?.length) {
      bag = [...jumper.sources];
      for (let index = bag.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(this.rng.next() * (index + 1));
        [bag[index], bag[swapIndex]] = [bag[swapIndex]!, bag[index]!];
      }
      const last = this.previous.get(jumper.id);
      if (last && bag.length > 1 && bag[0] === last) [bag[0], bag[1]] = [bag[1]!, bag[0]!];
      this.bags.set(jumper.id, bag);
    }
    const source = bag.shift();
    if (!source) throw new Error(`Jumper ${jumper.id} has no sources`);
    this.previous.set(jumper.id, source);
    return source;
  }
}

export class ApplicationController {
  private state: ApplicationState = 'STOPPED';
  private active: Scenario | undefined;
  private generation = 0;
  private abort: AbortController | undefined;
  private resolved = new Map<string, ResolvedSource>();
  private scheduler: JumperScheduler | undefined;
  private rate: AudioRate = 1;
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private readonly playbackListeners = new Set<(event: PlaybackEvent) => void>();
  private readonly sourceSelector: RandomSourceSelector;
  private playbackGeneration = 0;
  private playbackSequence = 0;
  private readonly pendingStarts = new Map<number, () => void>();
  private readonly jumperScheduleOverrides = new Map<string, Scenario['jumpers'][number]['schedule']>();

  constructor(
    private readonly runtime: RuntimePolicy,
    private readonly resolvers: SourceResolverRegistry,
    private readonly engine: MediaElementAudioEngine,
    private readonly rng: Random = { next: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000 },
    private readonly clock: Clock = browserClock,
  ) {
    this.sourceSelector = new RandomSourceSelector(rng);
  }

  subscribe(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  subscribePlayback(listener: (event: PlaybackEvent) => void) {
    this.playbackListeners.add(listener);
    return () => this.playbackListeners.delete(listener);
  }
  getJumperSchedule(jumperId: string) {
    const jumper = this.active?.jumpers.find((item) => item.id === jumperId);
    if (!jumper) throw new Error(`Unknown Jumper ${jumperId}`);
    return this.jumperScheduleOverrides.get(jumperId) ?? jumper.schedule;
  }

  setJumperScheduleValue(jumperId: string, field: JumperScheduleField, seconds: number) {
    const jumper = this.active?.jumpers.find((item) => item.id === jumperId);
    if (!jumper) throw new Error(`Unknown Jumper ${jumperId}`);
    const schedule = { ...this.getJumperSchedule(jumperId), [field]: seconds };
    if (!Number.isFinite(seconds)
      || schedule.mean_interval_seconds <= 0
      || schedule.stddev_seconds < 0
      || schedule.stddev_seconds >= schedule.mean_interval_seconds) {
      throw new Error('Temporary Jumper schedule requires mean > 0 and 0 <= stddev < mean');
    }
    this.jumperScheduleOverrides.set(jumperId, schedule);
    this.scheduler?.update(jumperId, schedule);
  }


  get snapshot(): Snapshot {
    return Object.freeze(this.active ? { state: this.state, scenario: this.active, rate: this.rate } : { state: this.state, rate: this.rate });
  }

  async load(candidate: Scenario): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.abort?.abort();
    this.haltPlayback();
    this.jumperScheduleOverrides.clear();
    this.release();
    this.active = undefined;
    this.abort = new AbortController();
    this.state = 'LOADING';
    this.publish();
    const sources = [...candidate.bases.map((base) => base.source), ...candidate.jumpers.flatMap((jumper) => jumper.sources)];
    const unique = [...new Set(sources.map((source) => source.location))];
    const nextResolved = new Map<string, ResolvedSource>();
    try {
      for (const location of unique) {
        const source = sources.find((item) => item.location === location)!;
        nextResolved.set(location, await this.resolvers.resolve(source, this.runtime, { id: location, signal: this.abort.signal }));
      }
      await hydrateCandidate(candidate, async (source) => nextResolved.get(source.location)?.durationSeconds ?? NaN);
      if (generation !== this.generation) {
        for (const source of nextResolved.values()) source.release();
        return;
      }
      this.resolved = nextResolved;
      this.active = candidate;
      this.state = 'READY';
      this.publish();
    } catch (error) {
      for (const source of nextResolved.values()) source.release();
      if (generation !== this.generation) return;
      this.state = 'ERROR';
      this.publish(error instanceof Error ? error.message : 'Loading failed');
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.active || (this.state !== 'READY' && this.state !== 'STOPPED')) return;
    await this.engine.authorize(this.active.bases.length);
    await Promise.all(this.active.bases.map((base, index) => this.engine.startBase(index, base.source, this.source(base.source), sample(base.source, this.rng))));
    this.sourceSelector.clear();
    const playbackGeneration = ++this.playbackGeneration;
    this.scheduler = new JumperScheduler(this.clock, (id) => { void this.triggerJumper(id, playbackGeneration); });
    for (const jumper of this.active.jumpers) this.scheduler.add(jumper.id, this.schedule(jumper), this.rng);
    this.scheduler.start();
    this.state = 'PLAYING';
    this.publish();
  }

  async togglePause(): Promise<void> {
    if (this.state === 'PLAYING') {
      this.engine.pause();
      this.scheduler?.pause();
      this.state = 'PAUSED';
      this.cancelPendingStarts();
    } else if (this.state === 'PAUSED') {
      await this.engine.resume();
      this.scheduler?.start();
      this.state = 'PLAYING';
    }
    this.publish();
  }

  async setRate(rate: AudioRate) {
    await this.engine.setRate(rate);
    this.rate = rate;
    this.publish();
  }

  stop() {
    if (!this.active) return;
    this.state = 'STOPPING';
    this.publish();
    this.haltPlayback();
    this.state = 'STOPPED';
    this.publish();
  }

  async shutdown() {
    this.generation += 1;
    this.abort?.abort();
    this.haltPlayback();
    this.jumperScheduleOverrides.clear();
    this.release();
    this.active = undefined;
    this.state = 'STOPPED';
    this.publish();
  }

  private async triggerJumper(id: string, playbackGeneration: number) {
    const jumper = this.active?.jumpers.find((item) => item.id === id);
    if (!jumper || this.state !== 'PLAYING' || playbackGeneration !== this.playbackGeneration) return;
    const source = this.sourceSelector.next(jumper);
    const playbackId = `${playbackGeneration}:${++this.playbackSequence}`;
    const event = { playbackId, jumperId: jumper.id, sourceLocation: source.location };
    let announced = false;
    let ended = false;
    const emitEnded = () => {
      if (!announced || ended) return;
      ended = true;
      if (playbackGeneration === this.playbackGeneration) this.emitPlayback({ type: 'jumper-ended', ...event, at: this.clock.now() });
    };
    try {
      const started = await this.engine.trigger(source, this.source(source), sample(source, this.rng), {
        beforeStart: async () => {
          if (playbackGeneration !== this.playbackGeneration || this.state !== 'PLAYING') return false;
          announced = true;
          this.emitPlayback({ type: 'jumper-will-start', ...event, at: this.clock.now() });
          const ready = await this.waitForVisualLead();
          if (!ready || playbackGeneration !== this.playbackGeneration || this.state !== 'PLAYING') emitEnded();
          return ready && playbackGeneration === this.playbackGeneration && this.state === 'PLAYING';
        },
        ended: emitEnded,
      });
      if (started && playbackGeneration === this.playbackGeneration) this.emitPlayback({ type: 'jumper-started', ...event, at: this.clock.now() });
      else emitEnded();
    } catch (error) {
      emitEnded();
      if (playbackGeneration === this.playbackGeneration && this.state === 'PLAYING') this.publish(error instanceof Error ? error.message : `Could not play Jumper ${id}`);
    }
  }

  private waitForVisualLead() {
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.set(80, () => {
        this.pendingStarts.delete(timer);
        resolve(true);
      });
      this.pendingStarts.set(timer, () => {
        this.clock.clear(timer);
        resolve(false);
      });
    });
  }

  private cancelPendingStarts() {
    const cancel = [...this.pendingStarts.values()];
    this.pendingStarts.clear();
    for (const run of cancel) run();
  }

  private haltPlayback() {
    this.playbackGeneration += 1;
    this.scheduler?.stop();
    this.cancelPendingStarts();
    this.scheduler = undefined;
    this.engine.stop();
    this.sourceSelector.clear();
  }
  private schedule(jumper: Scenario['jumpers'][number]) {
    return this.jumperScheduleOverrides.get(jumper.id) ?? jumper.schedule;
  }


  private source(source: Source) {
    const resolved = this.resolved.get(source.location);
    if (!resolved) throw new Error('Unresolved source');
    return resolved;
  }

  private release() {
    for (const source of this.resolved.values()) source.release();
    this.resolved.clear();
  }

  private publish(error?: string) {
    const snapshot = error === undefined ? this.snapshot : { ...this.snapshot, error };
    for (const listener of this.listeners) listener(snapshot);
  }

  private emitPlayback(event: PlaybackEvent) {
    for (const listener of this.playbackListeners) listener(event);
  }
}

function sample(source: Source, rng: Random) {
  return source.volume.min + rng.next() * (source.volume.max - source.volume.min);
}
