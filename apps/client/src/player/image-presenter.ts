export interface JumperImagePlacement { x: number; y: number; size: number; rotation: number; }

export class JumperImagePresenter {
  private hideTimer: number | undefined;
  private presentations = 0;
  private activePlaybackId: string | undefined;
  private preloadGeneration = 0;
  private readonly preloaded = new Map<string, HTMLImageElement>();

  constructor(
    private readonly stage: HTMLElement,
    private readonly image: HTMLImageElement,
    private readonly random: () => number = Math.random,
  ) {}

  preload(sources: readonly string[]) {
    const generation = ++this.preloadGeneration;
    const unique = [...new Set(sources)];
    for (const cached of this.preloaded.values()) cached.removeAttribute('src');
    this.preloaded.clear();
    this.stage.dataset.preloaded = '0';
    void Promise.all(unique.map(async (source) => {
      const cached = new Image();
      cached.decoding = 'async';
      cached.src = source;
      try { await cached.decode(); } catch { return; }
      if (generation === this.preloadGeneration) this.preloaded.set(source, cached);
    })).then(() => {
      if (generation === this.preloadGeneration) this.stage.dataset.preloaded = String(this.preloaded.size);
    });
  }

  show(source: string, playbackId: string, at: number) {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    const placement = this.nextPlacement();
    this.activePlaybackId = playbackId;
    this.stage.classList.remove('is-entering', 'is-exiting');
    this.stage.style.setProperty('--jumper-image-x', `${placement.x.toFixed(2)}%`);
    this.stage.style.setProperty('--jumper-image-y', `${placement.y.toFixed(2)}%`);
    this.stage.style.setProperty('--jumper-image-size', `${placement.size.toFixed(2)}vmin`);
    this.stage.style.setProperty('--jumper-image-rotation', `${placement.rotation.toFixed(2)}deg`);
    this.image.src = source;
    this.stage.hidden = false;
    void this.stage.offsetWidth;
    this.stage.classList.add('is-entering');
    this.stage.dataset.phase = 'entering';
    this.stage.dataset.playbackId = playbackId;
    this.stage.dataset.visualStartedAt = String(at);
    this.presentations += 1;
    this.stage.dataset.presentations = String(this.presentations);
    this.stage.dataset.placement = `${placement.x.toFixed(2)},${placement.y.toFixed(2)},${placement.size.toFixed(2)}`;
    const history = this.stage.dataset.placementHistory ? this.stage.dataset.placementHistory.split(';') : [];
    this.stage.dataset.placementHistory = [...history.slice(-7), this.stage.dataset.placement].join(';');
  }

  markAudioStarted(playbackId: string, at: number) {
    if (playbackId !== this.activePlaybackId) return;
    this.stage.dataset.audioStartedAt = String(at);
    this.stage.dataset.phase = 'active';
  }

  hide(playbackId: string, at: number) {
    if (playbackId !== this.activePlaybackId) return;
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.stage.classList.remove('is-entering');
    void this.stage.offsetWidth;
    this.stage.classList.add('is-exiting');
    this.stage.dataset.phase = 'exiting';
    this.stage.dataset.audioEndedAt = String(at);
    this.hideTimer = window.setTimeout(() => this.reset(), 520);
  }

  reset() {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.activePlaybackId = undefined;
    this.stage.classList.remove('is-entering', 'is-exiting');
    this.stage.hidden = true;
    this.stage.dataset.phase = 'hidden';
    this.image.removeAttribute('src');
  }

  destroy() {
    this.preloadGeneration += 1;
    for (const cached of this.preloaded.values()) cached.removeAttribute('src');
    this.preloaded.clear();
    this.reset();
  }

  private nextPlacement(): JumperImagePlacement {
    return {
      x: 18 + this.random() * 64,
      y: 20 + this.random() * 50,
      size: 16 + this.random() * 16,
      rotation: -3.5 + this.random() * 7,
    };
  }
}
