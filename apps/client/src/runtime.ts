import type { RuntimePolicy, SourceInput } from '@ambiental/core';

export interface LocalAudioChoice { path: string; name: string; }
export interface SaveScenarioResult { canceled: boolean; path?: string; }
export interface PreparedAudio { url: string; durationSeconds: number; release(): Promise<void>; }
export interface MaterializationProgress { completed: number; total: number; message: string; }
export type SourceOutputKind = 'embedded' | 'local-path' | 'youtube';
export interface SaveScenarioOptions { outputKinds?: SourceOutputKind[]; onProgress?: (progress: MaterializationProgress) => void; }
export interface ClientRuntime {
  kind: RuntimePolicy;
  loadInitialScenario(): Promise<unknown>;
  chooseLocalAudio?(): Promise<LocalAudioChoice | null>;
  prepareAudio?(source: SourceInput): Promise<PreparedAudio>;
  saveScenario(json: string, suggestedName: string, options?: SaveScenarioOptions): Promise<SaveScenarioResult>;
}

interface AmbientalBridge {
  loadInitialScenario(): Promise<unknown>;
  chooseScenario(text: string): Promise<unknown>;
  resolveSource(index: number): Promise<unknown>;
  quit(): Promise<void>;
  chooseLocalAudio(): Promise<LocalAudioChoice | null>;
  prepareAudio(source: SourceInput): Promise<{ url: string; durationSeconds: number; token: string }>;
  releasePreparedAudio(token: string): Promise<void>;
  saveScenario(json: string, suggestedName: string, outputKinds?: SourceOutputKind[]): Promise<SaveScenarioResult>;
  onSaveProgress(listener: (progress: MaterializationProgress) => void): () => void;
}
declare global { interface Window { ambiental?: AmbientalBridge; } }

export class WebRuntime implements ClientRuntime {
  readonly kind = 'web' as const;
  constructor(private readonly initial: unknown) {}
  async loadInitialScenario() { return this.initial; }
  async saveScenario(json: string, suggestedName: string): Promise<SaveScenarioResult> {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(url);
    return { canceled: false };
  }
}
export class ElectronRuntime implements ClientRuntime {
  readonly kind = 'desktop' as const;
  constructor(private readonly bridge: AmbientalBridge) {}
  loadInitialScenario() { return this.bridge.loadInitialScenario(); }
  chooseLocalAudio() { return this.bridge.chooseLocalAudio(); }
  async prepareAudio(source: SourceInput): Promise<PreparedAudio> {
    const result = await this.bridge.prepareAudio(source);
    return { url: result.url, durationSeconds: result.durationSeconds, release: () => this.bridge.releasePreparedAudio(result.token) };
  }
  async saveScenario(json: string, suggestedName: string, options: SaveScenarioOptions = {}) {
    const unsubscribe = options.onProgress ? this.bridge.onSaveProgress(options.onProgress) : undefined;
    try { return await this.bridge.saveScenario(json, suggestedName, options.outputKinds); }
    finally { unsubscribe?.(); }
  }
}
export function createRuntime(initial: unknown): ClientRuntime { return window.ambiental ? new ElectronRuntime(window.ambiental) : new WebRuntime(initial); }
