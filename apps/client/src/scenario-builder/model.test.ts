import { describe, expect, it } from 'vitest';
import { parseScenario } from '@ambiental/core';
import {
  addBaseDraft,
  addJumperDraft,
  applyOutputPreset,
  availableOutputKinds,
  buildOutputPlan,
  buildScenarioCandidate,
  cloneSourceDraft,
  createBaseDraft,
  createJumperDraft,
  createScenarioDraft,
  createSourceDraft,
  isSourceDraftEmpty,
  listDraftSourceEntries,
  scenarioDocumentToDraft,
  validateScenarioDraft,
} from './model.js';

const wav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const embedded = () => { const source = createSourceDraft(); source.embeddedLocation = wav; return source; };
const youtube = () => { const source = createSourceDraft(); source.kind = 'youtube'; source.youtubeUrl = 'https://youtu.be/example'; return source; };

describe('scenario draft model', () => {
  it('creates empty Base and Jumper containers', () => {
    expect(isSourceDraftEmpty(createBaseDraft().source)).toBe(true);
    expect(createJumperDraft().sources).toEqual([]);
  });

  it('adds containers with unique IDs without preassigning a source', () => {
    const draft = createScenarioDraft();
    draft.bases.push(createBaseDraft(1));
    draft.jumpers.push(createJumperDraft(1));
    const base = addBaseDraft(draft);
    draft.bases.push(base);
    const jumper = addJumperDraft(draft);
    expect(base.id).toBe('base-2');
    expect(isSourceDraftEmpty(base.source)).toBe(true);
    expect(jumper.id).toBe('jumper-2');
    expect(jumper.sources).toEqual([]);
  });

  it('clones source data under a fresh draft ID', () => {
    const source = embedded();
    source.waveform = [0.1, 0.5];
    const clone = cloneSourceDraft(source);
    expect(clone).toMatchObject({ embeddedLocation: wav, waveform: [0.1, 0.5] });
    expect(clone.draftId).not.toBe(source.draftId);
    expect(clone.waveform).not.toBe(source.waveform);
  });

  it('lists sources in Base then Jumper source order', () => {
    const draft = createScenarioDraft();
    const base = createBaseDraft(); base.source = embedded(); draft.bases.push(base);
    const jumper = createJumperDraft(); const first = embedded(); const second = youtube(); jumper.sources.push(first, second); draft.jumpers.push(jumper);
    expect(listDraftSourceEntries(draft)).toEqual([
      { source: base.source, ownerKind: 'base', ownerId: base.draftId },
      { source: first, ownerKind: 'jumper', ownerId: jumper.draftId },
      { source: second, ownerKind: 'jumper', ownerId: jumper.draftId },
    ]);
  });

  it('limits output kinds by runtime and source input', () => {
    expect(availableOutputKinds(embedded(), 'web')).toEqual(['embedded']);
    expect(availableOutputKinds(embedded(), 'desktop')).toEqual(['embedded', 'local-path']);
    expect(availableOutputKinds(youtube(), 'desktop')).toEqual(['embedded', 'local-path', 'youtube']);
  });

  it('applies YouTube preset only to compatible inputs and builds a positional plan', () => {
    const draft = createScenarioDraft();
    const base = createBaseDraft(); base.source = embedded(); draft.bases.push(base);
    const jumper = createJumperDraft(); jumper.sources.push(youtube(), embedded()); draft.jumpers.push(jumper);
    expect(applyOutputPreset(draft, 'youtube', 'desktop')).toEqual({ applied: 1, skipped: 2 });
    expect(buildOutputPlan(draft)).toEqual(['embedded', 'youtube', 'embedded']);
  });

  it('allows a scenario with only a populated jumper', () => {
    const draft = createScenarioDraft(); draft.name = 'Night';
    const jumper = createJumperDraft(); jumper.sources.push(embedded()); draft.jumpers.push(jumper);
    expect(validateScenarioDraft(draft, 'web').summary).toBe('');
  });

  it('blocks empty Base and Jumper containers', () => {
    const baseDraft = createScenarioDraft(); baseDraft.name = 'Night'; baseDraft.bases.push(createBaseDraft());
    const jumperDraft = createScenarioDraft(); jumperDraft.name = 'Night'; jumperDraft.jumpers.push(createJumperDraft());
    expect(validateScenarioDraft(baseDraft, 'web').summary).not.toBe('');
    expect(validateScenarioDraft(jumperDraft, 'web').summary).not.toBe('');
  });

  it('retains source ordering and desktop representations', () => {
    const draft = createScenarioDraft(); draft.name = 'Night';
    const jumper = createJumperDraft(); const local = createSourceDraft(); local.kind = 'local-path'; local.localPath = 'a.wav'; jumper.sources.push(local, youtube()); draft.jumpers.push(jumper);
    const candidate = buildScenarioCandidate(draft);
    expect(candidate.jumpers?.[0]?.sources.map((source) => source.location)).toEqual(['a.wav', 'https://youtu.be/example']);
    expect(validateScenarioDraft(draft, 'desktop').summary).toBe('');
    expect(validateScenarioDraft(draft, 'web').summary).not.toBe('');
  });

  it('preserves optional field omission when importing and exporting', () => {
    const document = { version: 1 as const, name: 'Night', bases: [{ id: 'base', source: { location: wav } }], jumpers: [] };
    const draft = scenarioDocumentToDraft(document, parseScenario(JSON.stringify(document), 'web'));
    const candidate = buildScenarioCandidate(draft);
    expect(Object.hasOwn(candidate, 'audio_root')).toBe(false);
    expect(Object.hasOwn(candidate.bases?.[0]!.source ?? {}, 'clip')).toBe(false);
    expect(Object.hasOwn(candidate.bases?.[0]!.source ?? {}, 'volume')).toBe(false);
  });
});
