import { parseScenario, ScenarioError, type RuntimePolicy, type Scenario, type ScenarioInput, type SourceInput } from '@ambiental/core';

export type SourceKind = 'embedded' | 'local-path' | 'youtube';
export interface SourceDraft { draftId: string; kind: SourceKind; outputKind: SourceKind; embeddedLocation: string; localPath: string; youtubeUrl: string; clipEnabled: boolean; clipStart: string; clipEnd: string; volumeEnabled: boolean; volumeMin: string; volumeMax: string; durationSeconds?: number | undefined; previewUrl?: string | undefined; waveform?: number[] | undefined; }
export interface BaseDraft { draftId: string; id: string; source: SourceDraft; }
export interface JumperDraft { draftId: string; id: string; meanIntervalSeconds: string; stddevSeconds: string; sources: SourceDraft[]; }
export interface ScenarioDraft { version: 1; name: string; audioRootEnabled: boolean; audioRoot: string; bases: BaseDraft[]; jumpers: JumperDraft[]; }
export interface DraftSourceEntry { source: SourceDraft; ownerKind: 'base' | 'jumper'; ownerId: string; }
export interface DraftValidation { candidate?: ScenarioInput; errors: Record<string, string>; summary: string; }

const id = () => crypto.randomUUID();
export const createSourceDraft = (): SourceDraft => ({ draftId: id(), kind: 'embedded', outputKind: 'embedded', embeddedLocation: '', localPath: '', youtubeUrl: '', clipEnabled: false, clipStart: '', clipEnd: '', volumeEnabled: false, volumeMin: '1', volumeMax: '1' });
export const createScenarioDraft = (): ScenarioDraft => ({ version: 1, name: '', audioRootEnabled: false, audioRoot: '', bases: [], jumpers: [] });
const has = (value: object, key: string) => Object.hasOwn(value, key);
function nextId(draft: ScenarioDraft, prefix: 'base' | 'jumper') {
  const used = new Set([...draft.bases, ...draft.jumpers].map((entry) => entry.id));
  for (let index = 1; ; index += 1) { const candidate = `${prefix}-${index}`; if (!used.has(candidate)) return candidate; }
}
export const createBaseDraft = (index = 1): BaseDraft => ({ draftId: id(), id: `base-${index}`, source: createSourceDraft() });
export const createJumperDraft = (index = 1): JumperDraft => ({ draftId: id(), id: `jumper-${index}`, meanIntervalSeconds: '15', stddevSeconds: '0', sources: [] });
export const addBaseDraft = (draft: ScenarioDraft): BaseDraft => ({ draftId: id(), id: nextId(draft, 'base'), source: createSourceDraft() });
export const addJumperDraft = (draft: ScenarioDraft): JumperDraft => ({ draftId: id(), id: nextId(draft, 'jumper'), meanIntervalSeconds: '15', stddevSeconds: '0', sources: [] });
export const cloneSourceDraft = (source: SourceDraft): SourceDraft => ({ ...source, draftId: id(), waveform: source.waveform ? [...source.waveform] : undefined });
export function isSourceDraftEmpty(source: SourceDraft): boolean {
  const value = source.kind === 'embedded' ? source.embeddedLocation : source.kind === 'local-path' ? source.localPath : source.youtubeUrl;
  return value.trim() === '';
}
export function listDraftSourceEntries(draft: ScenarioDraft): DraftSourceEntry[] {
  return [
    ...draft.bases.map((base) => ({ source: base.source, ownerKind: 'base' as const, ownerId: base.draftId })),
    ...draft.jumpers.flatMap((jumper) => jumper.sources.map((source) => ({ source, ownerKind: 'jumper' as const, ownerId: jumper.draftId }))),
  ];
}
export function availableOutputKinds(source: SourceDraft, runtime: RuntimePolicy): SourceKind[] {
  if (runtime === 'web') return ['embedded'];
  return source.kind === 'youtube' ? ['embedded', 'local-path', 'youtube'] : ['embedded', 'local-path'];
}
export function applyOutputPreset(draft: ScenarioDraft, kind: SourceKind, runtime: RuntimePolicy): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  for (const { source } of listDraftSourceEntries(draft)) {
    if (availableOutputKinds(source, runtime).includes(kind)) {
      source.outputKind = kind;
      applied += 1;
    } else {
      skipped += 1;
    }
  }
  return { applied, skipped };
}
export function buildOutputPlan(draft: ScenarioDraft): SourceKind[] {
  return listDraftSourceEntries(draft).map(({ source }) => source.outputKind);
}
function sourceToDraft(source: SourceInput, normalized: Scenario['bases'][number]['source']): SourceDraft {
  const location = normalized.location;
  const kind: SourceKind = location.startsWith('data:') ? 'embedded' : location.startsWith('https://') ? 'youtube' : 'local-path';
  const clip = normalized.clip; const volume = normalized.volume;
  return { draftId: id(), kind, outputKind: kind, embeddedLocation: kind === 'embedded' ? location : '', localPath: kind === 'local-path' ? location : '', youtubeUrl: kind === 'youtube' ? location : '', clipEnabled: has(source, 'clip'), clipStart: clip ? String(clip.start_seconds) : '', clipEnd: clip ? String(clip.end_seconds) : '', volumeEnabled: has(source, 'volume'), volumeMin: volume ? String(volume.min) : '1', volumeMax: volume ? String(volume.max) : '1' };
}
export function scenarioDocumentToDraft(document: ScenarioInput, normalized: Scenario): ScenarioDraft {
  const rawBases = document.bases ?? []; const rawJumpers = document.jumpers ?? [];
  return { version: 1, name: normalized.name, audioRootEnabled: has(document, 'audio_root'), audioRoot: normalized.audio_root ?? '', bases: normalized.bases.map((base, index) => ({ draftId: id(), id: base.id, source: sourceToDraft(rawBases[index]!.source, base.source) })), jumpers: normalized.jumpers.map((jumper, index) => ({ draftId: id(), id: jumper.id, meanIntervalSeconds: String(jumper.schedule.mean_interval_seconds), stddevSeconds: String(jumper.schedule.stddev_seconds), sources: jumper.sources.map((source, sourceIndex) => sourceToDraft(rawJumpers[index]!.sources[sourceIndex]!, source)) })) };
}
export function sourceCandidate(source: SourceDraft): SourceInput {
  const location = source.kind === 'embedded' ? source.embeddedLocation : source.kind === 'local-path' ? source.localPath : source.youtubeUrl;
  const candidate: SourceInput = { location };
  if (source.clipEnabled) candidate.clip = { start_seconds: Number(source.clipStart), end_seconds: Number(source.clipEnd) };
  if (source.volumeEnabled) candidate.volume = { min: Number(source.volumeMin), max: Number(source.volumeMax) };
  return candidate;
}
export function buildScenarioCandidate(draft: ScenarioDraft): ScenarioInput {
  const candidate: ScenarioInput = { version: 1, name: draft.name, bases: draft.bases.map((base) => ({ id: base.id, source: sourceCandidate(base.source) })), jumpers: draft.jumpers.map((jumper) => ({ id: jumper.id, sources: jumper.sources.map(sourceCandidate), schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: Number(jumper.meanIntervalSeconds), stddev_seconds: Number(jumper.stddevSeconds) } })) };
  if (draft.audioRootEnabled) candidate.audio_root = draft.audioRoot;
  return candidate;
}
export function validateScenarioDraft(draft: ScenarioDraft, runtime: RuntimePolicy): DraftValidation {
  const candidate = buildScenarioCandidate(draft); const errors: Record<string, string> = {};
  try { parseScenario(JSON.stringify(candidate), runtime); } catch (error) { if (error instanceof Error) { const pointer = error instanceof ScenarioError ? error.pointer : undefined; errors[pointer ?? 'scenario'] = error.message; } else errors.scenario = 'Invalid scenario'; }
  for (const source of [...draft.bases.map((base) => base.source), ...draft.jumpers.flatMap((jumper) => jumper.sources)]) if (source.clipEnabled && source.durationSeconds !== undefined && Number(source.clipStart) < source.durationSeconds && Number(source.clipEnd) > source.durationSeconds) errors[source.draftId] = 'Clip exceeds embedded audio duration';
  const summary = Object.values(errors)[0] ?? '';
  return summary ? { errors, summary } : { candidate, errors, summary };
}
