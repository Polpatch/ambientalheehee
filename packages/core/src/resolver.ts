import { inspectEmbeddedAudio } from './audio-inspection.js';
import { inspectDataUri, type RuntimePolicy, type Source } from './schema.js';
export interface ResolvedSource { id: string; url: string; mime: string; durationSeconds: number; release(): void; }
export interface AudioSourceResolver { supports(source: Source, runtime: RuntimePolicy): boolean; resolve(source: Source, context: { signal: AbortSignal; id: string }): Promise<ResolvedSource>; }
export class SourceResolverRegistry {
  constructor(private readonly resolvers: readonly AudioSourceResolver[]) {}
  async resolve(source: Source, runtime: RuntimePolicy, context: { signal: AbortSignal; id: string }): Promise<ResolvedSource> { const resolver = this.resolvers.find((candidate) => candidate.supports(source, runtime)); if (!resolver) throw new Error(`No resolver for ${source.location}`); return resolver.resolve(source, context); }
}
export class EmbeddedDataResolver implements AudioSourceResolver {
  supports(source: Source) { return source.location.startsWith('data:'); }
  async resolve(source: Source, context: { signal: AbortSignal; id: string }): Promise<ResolvedSource> { if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError'); const { mime, bytes } = inspectDataUri(source.location); const inspection = inspectEmbeddedAudio(bytes, mime); const blobBytes = new Uint8Array(bytes.byteLength); blobBytes.set(bytes); const url = URL.createObjectURL(new Blob([blobBytes.buffer], { type: mime })); const audio = new Audio(); audio.preload = 'metadata'; audio.src = url; try { await new Promise<void>((resolve, reject) => { const abort = () => reject(new DOMException('Aborted', 'AbortError')); context.signal.addEventListener('abort', abort, { once: true }); audio.onloadedmetadata = () => { context.signal.removeEventListener('abort', abort); resolve(); }; audio.onerror = () => reject(new Error('Audio metadata unavailable')); }); if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !audio.seekable.length) throw new Error('Audio is not seekable'); return { id: context.id, url, mime, durationSeconds: inspection.durationSeconds, release: () => { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); } }; } catch (error) { URL.revokeObjectURL(url); throw error; } }
}
