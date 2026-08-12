import { describe, expect, it } from 'vitest';
import { MediaElementAudioEngine } from './audio-engine.js';
import type { ResolvedSource } from './resolver.js';
import type { Source } from './schema.js';

class FakeAudioElement extends EventTarget {
  src = '';
  preload = '';
  preservesPitch = true;
  webkitPreservesPitch = true;
  busy = false;
  currentTime = 0;
  readyState = 4;
  duration = 10;
  volume = 1;
  playbackRate = 1;
  loop = false;
  paused = true;
  playCount = 0;

  async play() { this.paused = false; this.playCount += 1; }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

const source = (location: string, clip?: { start_seconds: number; end_seconds: number }): Source => ({
  location,
  ...(clip ? { clip } : {}),
  volume: { min: 1, max: 1 },
});

const resolved = (location: string, release: () => void): ResolvedSource => ({
  id: location,
  url: `blob:${location}`,
  mime: 'audio/wav',
  durationSeconds: 10,
  release,
});

describe('MediaElementAudioEngine', () => {
  it('reuses a resolved Jumper source after its first playback', async () => {
    const elements: FakeAudioElement[] = [];
    const engine = new MediaElementAudioEngine(() => {
      const element = new FakeAudioElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    });
    await engine.authorize(0);
    let releases = 0;
    const item = source('jumper.wav');
    const media = resolved(item.location, () => { releases += 1; });

    let endings = 0;
    expect(await engine.trigger(item, media, 1, { ended: () => { endings += 1; } })).toBe(true);
    const voice = elements[0]!;
    voice.dispatchEvent(new Event('ended'));
    expect(endings).toBe(1);
    expect(await engine.trigger(item, media, 1, { ended: () => { endings += 1; } })).toBe(true);

    expect(releases).toBe(0);
    expect(voice.playCount).toBe(3);
  });

  it('stops a clipped Jumper and reports completion at its crop end', async () => {
    const elements: FakeAudioElement[] = [];
    const engine = new MediaElementAudioEngine(() => {
      const element = new FakeAudioElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    });
    await engine.authorize(0);
    const item = source('clip.wav', { start_seconds: 2, end_seconds: 4 });
    let endings = 0;
    await engine.trigger(item, resolved(item.location, () => {}), 1, { ended: () => { endings += 1; } });
    const voice = elements[0]!;
    voice.currentTime = 4;
    voice.dispatchEvent(new Event('timeupdate'));

    expect(voice.paused).toBe(true);
    expect(endings).toBe(1);
    voice.dispatchEvent(new Event('ended'));
    expect(endings).toBe(1);
  });

  it('loops a full Base and restarts a clipped Base at its crop start', async () => {
    const elements: FakeAudioElement[] = [];
    const engine = new MediaElementAudioEngine(() => {
      const element = new FakeAudioElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    });
    await engine.authorize(2);
    const full = source('base-full.wav');
    const clipped = source('base-clip.wav', { start_seconds: 2, end_seconds: 4 });
    await engine.startBase(0, full, resolved(full.location, () => {}), 1);
    await engine.startBase(1, clipped, resolved(clipped.location, () => {}), 1);

    expect(elements[0]!.loop).toBe(true);
    elements[1]!.currentTime = 4;
    elements[1]!.dispatchEvent(new Event('timeupdate'));
    expect(elements[1]!.currentTime).toBe(2);
    expect(elements[1]!.playCount).toBe(3);
  });
});
