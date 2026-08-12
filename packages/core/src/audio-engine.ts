import type { ResolvedSource } from './resolver.js';
import type { Source } from './schema.js';

export const MAX_JUMPER_VOICES = 32;
export const ALLOWED_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type AudioRate = typeof ALLOWED_RATES[number];

type Voice = {
  element: HTMLAudioElement;
  busy: boolean;
  cleanup: (() => void) | undefined;
};

export class MediaElementAudioEngine {
  private bases: Voice[] = [];
  private jumpers: Voice[] = [];
  private rate: AudioRate = 1;

  constructor(private readonly createElement: () => HTMLAudioElement = () => new Audio()) {}

  async authorize(baseCount: number): Promise<void> {
    if (this.bases.length === baseCount && this.jumpers.length === MAX_JUMPER_VOICES) return;
    this.stop();
    const create = (): Voice => {
      const element = this.createElement();
      element.preload = 'auto';
      element.preservesPitch = false;
      (element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = false;
      return { element, busy: false, cleanup: undefined };
    };
    this.bases = Array.from({ length: baseCount }, create);
    this.jumpers = Array.from({ length: MAX_JUMPER_VOICES }, create);
    const silent = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    await Promise.all([...this.bases, ...this.jumpers].map(async ({ element }) => {
      element.src = silent;
      await element.play();
      element.pause();
    }));
  }

  async startBase(index: number, source: Source, resolved: ResolvedSource, volume: number): Promise<void> {
    const voice = this.bases[index];
    if (!voice) throw new Error('Unknown base slot');
    await this.play(voice, source, resolved, volume, true);
  }

  async trigger(source: Source, resolved: ResolvedSource, volume: number): Promise<boolean> {
    const voice = this.jumpers.find((candidate) => !candidate.busy);
    if (!voice) return false;
    await this.play(voice, source, resolved, volume, false);
    return true;
  }

  async setRate(rate: AudioRate): Promise<void> {
    if (!ALLOWED_RATES.includes(rate)) throw new Error('Unsupported rate');
    const previous = this.rate;
    const voices = [...this.bases, ...this.jumpers].filter((voice) => voice.busy);
    try {
      for (const { element } of voices) {
        element.playbackRate = rate;
        if (element.playbackRate !== rate) throw new Error('Rate rejected');
      }
      this.rate = rate;
    } catch (error) {
      for (const { element } of voices) element.playbackRate = previous;
      throw error;
    }
  }

  pause() {
    for (const { element, busy } of [...this.bases, ...this.jumpers]) if (busy) element.pause();
  }

  async resume() {
    await Promise.all([...this.bases, ...this.jumpers]
      .filter((voice) => voice.busy)
      .map(({ element }) => element.play()));
  }

  stop() {
    for (const voice of [...this.bases, ...this.jumpers]) {
      voice.cleanup?.();
      voice.cleanup = undefined;
      voice.busy = false;
      voice.element.pause();
      voice.element.loop = false;
      voice.element.removeAttribute('src');
      voice.element.load();
    }
  }

  private async play(voice: Voice, source: Source, resolved: ResolvedSource, volume: number, base: boolean) {
    voice.cleanup?.();
    voice.cleanup = undefined;
    voice.busy = true;
    const start = source.clip?.start_seconds ?? 0;
    const end = source.clip?.end_seconds;
    const element = voice.element;
    element.src = resolved.url;
    element.volume = volume;
    element.playbackRate = this.rate;
    element.currentTime = start;
    element.loop = base && end === undefined;

    const cleanup = () => {
      element.removeEventListener('timeupdate', monitor);
      element.removeEventListener('ended', ended);
      voice.cleanup = undefined;
    };
    const finish = () => {
      if (base) {
        element.currentTime = start;
        void element.play();
        return;
      }
      voice.busy = false;
      cleanup();
    };
    const monitor = () => {
      if (end !== undefined && element.currentTime >= end - 0.02) finish();
    };
    const ended = () => finish();

    element.addEventListener('timeupdate', monitor);
    element.addEventListener('ended', ended);
    voice.cleanup = cleanup;
    try {
      await element.play();
    } catch (error) {
      voice.busy = false;
      cleanup();
      throw error;
    }
  }
}
