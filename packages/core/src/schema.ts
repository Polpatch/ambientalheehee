import { z } from 'zod';

export type RuntimePolicy = 'web' | 'desktop';
export type ScenarioErrorCode = 'JSON_SIZE' | 'JSON_SYNTAX' | 'SCHEMA' | 'POLICY' | 'SOURCE_SIZE' | 'SOURCE_FORMAT' | 'SOURCE_UNAVAILABLE' | 'TOOL_MISSING' | 'METADATA' | 'CLIP_RANGE' | 'PLAYBACK';
export class ScenarioError extends Error { constructor(public readonly code: ScenarioErrorCode, message: string, public readonly pointer?: string) { super(message); } }
const finite = z.number().finite();
const trimmed = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
export const ClipConfig = z.object({ start_seconds: finite, end_seconds: finite }).strict().refine((v) => v.start_seconds >= 0 && v.start_seconds < v.end_seconds, 'clip must satisfy 0 <= start < end');
export const VolumeConfig = z.object({ min: finite, max: finite }).strict().refine((v) => v.min >= 0 && v.min <= v.max && v.max <= 1, 'volume must satisfy 0 <= min <= max <= 1');
export const SourceConfig = z.object({ location: z.string(), clip: ClipConfig.optional(), volume: VolumeConfig.optional() }).strict().transform((value) => ({ ...value, location: value.location.startsWith('data:') ? value.location : value.location.trim(), volume: value.volume ?? { min: 1, max: 1 } }));
export const BaseConfig = z.object({ id: trimmed, source: SourceConfig }).strict();
export const ScheduleConfig = z.object({ algorithm: z.literal('increasing_gaussian'), mean_interval_seconds: finite, stddev_seconds: finite }).strict().refine((v) => v.mean_interval_seconds > 0 && v.stddev_seconds >= 0 && v.stddev_seconds < v.mean_interval_seconds, 'schedule requires mean > 0 and 0 <= stddev < mean');
export const JumperConfig = z.object({ id: trimmed, sources: z.array(SourceConfig).min(1), schedule: ScheduleConfig }).strict();
export const ScenarioConfig = z.object({ version: z.literal(1), name: trimmed, audio_root: trimmed.optional(), bases: z.array(BaseConfig).default([]), jumpers: z.array(JumperConfig).default([]) }).strict().superRefine((value, ctx) => {
  if (!value.bases.length && !value.jumpers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scenario needs a base or jumper' });
  const seen = new Set<string>();
  [...value.bases, ...value.jumpers].forEach((entry, i) => { if (seen.has(entry.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id: ${entry.id}`, path: [i < value.bases.length ? 'bases' : 'jumpers', i < value.bases.length ? i : i - value.bases.length, 'id'] }); seen.add(entry.id); });
});
export type Scenario = z.output<typeof ScenarioConfig>; export type Source = z.output<typeof SourceConfig>;
const dataUri = /^data:audio\/(wav|mpeg);base64,([A-Za-z0-9+/]*={0,2})$/;
export function inspectDataUri(value: string): { mime: 'audio/wav' | 'audio/mpeg'; bytes: Uint8Array } {
  const match = dataUri.exec(value); if (!match || (match[2]!.length % 4 !== 0) || /=/.test(match[2]!.slice(0, -2))) throw new ScenarioError('SOURCE_FORMAT', 'Expected canonical audio Data URI');
  const binary = atob(match[2]!);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.byteLength > 16 * 1024 * 1024) throw new ScenarioError('SOURCE_SIZE', 'Embedded source exceeds 16 MiB');
  return { mime: match[1] === 'wav' ? 'audio/wav' : 'audio/mpeg', bytes };
}
function allowed(location: string, policy: RuntimePolicy) { if (location.startsWith('data:')) return true; return policy === 'desktop' && (/^(?![a-zA-Z][\w+.-]*:).+/.test(location) || /^https:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/.test(location)); }
export function parseScenario(input: string, policy: RuntimePolicy): Scenario {
  if (new TextEncoder().encode(input).byteLength > 90 * 1024 * 1024) throw new ScenarioError('JSON_SIZE', 'Scenario exceeds 90 MiB');
  let parsed: unknown; try { parsed = JSON.parse(input); } catch { throw new ScenarioError('JSON_SYNTAX', 'Invalid JSON'); }
  const result = ScenarioConfig.safeParse(parsed); if (!result.success) throw new ScenarioError('SCHEMA', result.error.issues[0]?.message ?? 'Invalid scenario', result.error.issues[0]?.path.join('/'));
  for (const [pointer, source] of sources(result.data)) { if (!allowed(source.location, policy)) throw new ScenarioError('POLICY', `Source not allowed in ${policy}`, pointer); if (source.location.startsWith('data:')) inspectDataUri(source.location); }
  return Object.freeze(result.data);
}
export function* sources(scenario: Scenario): Generator<[string, Source]> { for (const [i, base] of scenario.bases.entries()) yield [`bases/${i}/source`, base.source]; for (const [i, jumper] of scenario.jumpers.entries()) for (const [j, source] of jumper.sources.entries()) yield [`jumpers/${i}/sources/${j}`, source]; }
export function hydrateCandidate(scenario: Scenario, durationFor: (source: Source) => Promise<number>): Promise<void> { return (async () => { for (const [pointer, source] of sources(scenario)) { const duration = await durationFor(source); if (!Number.isFinite(duration) || duration <= 0) throw new ScenarioError('METADATA', 'No finite duration', pointer); if (source.clip && source.clip.end_seconds > duration) throw new ScenarioError('CLIP_RANGE', 'Clip exceeds source duration', pointer); } })(); }
