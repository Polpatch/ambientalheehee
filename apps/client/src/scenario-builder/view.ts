import { inspectDataUri, inspectEmbeddedAudio, parseScenario } from '@ambiental/core';
import type { ClientRuntime, MaterializationProgress, SourceOutputKind } from '../runtime.js';
import { fileToEmbeddedDataUri } from './embedded-file.js';
import { fileToEmbeddedImageDataUri } from './embedded-image.js';
import {
  addBaseDraft,
  addJumperDraft,
  applyOutputPreset,
  availableOutputKinds,
  buildOutputPlan,
  cloneSourceDraft,
  createScenarioDraft,
  createSourceDraft,
  isSourceDraftEmpty,
  listDraftSourceEntries,
  scenarioDocumentToDraft,
  type DraftSourceEntry,
  type ScenarioDraft,
  type SourceDraft,
  type SourceKind,
  validateScenarioDraft,
} from './model.js';

export interface ScenarioBuilderHandle { destroy(): void; }
export interface ScenarioBuilderOptions { runtime: ClientRuntime; initialDocument: unknown; }
type InputKind = 'file' | 'data' | 'local' | 'youtube';
type Screen = 'editor' | 'finalize';
type Destination = { kind: 'base' | 'jumper'; draftId: string };
type MutableSource = { location: string; clip?: { start_seconds: number; end_seconds: number }; volume?: unknown };
type MutableScenario = { bases: Array<{ source: MutableSource }>; jumpers: Array<{ sources: MutableSource[] }> };

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scenario';
const emptyProgress = (): MaterializationProgress => ({ completed: 0, total: 0, message: '' });

async function cropEmbeddedSources(candidate: unknown, report: (progress: MaterializationProgress) => void) {
  const document = JSON.parse(JSON.stringify(candidate)) as MutableScenario;
  const sources = [...document.bases.map((base) => base.source), ...document.jumpers.flatMap((jumper) => jumper.sources)];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    if (source.clip && source.location.startsWith('data:')) {
      const data = inspectDataUri(source.location);
      const decoder = new AudioContext();
      const decodeBytes = new Uint8Array(data.bytes.byteLength);
      decodeBytes.set(data.bytes);
      const input = await decoder.decodeAudioData(decodeBytes.buffer);
      await decoder.close();
      const start = source.clip.start_seconds;
      const duration = source.clip.end_seconds - start;
      const sampleRate = 44100;
      const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
      const node = context.createBufferSource();
      node.buffer = input;
      node.connect(context.destination);
      node.start(0, start, duration);
      const rendered = await context.startRendering();
      const frames = rendered.length;
      const bytes = new Uint8Array(44 + frames * 4);
      const view = new DataView(bytes.buffer);
      bytes.set([82, 73, 70, 70], 0);
      view.setUint32(4, 36 + frames * 4, true);
      bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      bytes.set([100, 97, 116, 97], 36);
      view.setUint32(40, frames * 4, true);
      const left = rendered.getChannelData(0);
      const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
      for (let frame = 0; frame < frames; frame += 1) {
        view.setInt16(44 + frame * 4, Math.max(-1, Math.min(1, left[frame]!)) * 0x7fff, true);
        view.setInt16(46 + frame * 4, Math.max(-1, Math.min(1, right[frame]!)) * 0x7fff, true);
      }
      let base64 = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) base64 += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
      source.location = `data:audio/wav;base64,${btoa(base64)}`;
      delete source.clip;
    }
    report({ completed: index + 1, total: sources.length, message: `Materialized source ${index + 1}` });
  }
  return document;
}

export function mountScenarioBuilder(container: HTMLElement, { runtime, initialDocument }: ScenarioBuilderOptions): ScenarioBuilderHandle {
  let draft = initialDraft(initialDocument);
  let composer = createSourceDraft();
  let screen: Screen = 'editor';
  let inputKind: InputKind = 'file';
  let selectedDestination: Destination | undefined;
  let pendingFile: File | undefined;
  let preparedSourceKey: string | undefined;
  let preparedRelease: (() => Promise<void>) | undefined;
  let previewCurrentTime = 0;
  let preparingSource = false;
  let saving = false;
  let materializationProgress = emptyProgress();
  let pendingBaseReplacement: { baseDraftId: string; source: SourceDraft } | undefined;
  let status = '';
  let sourceStatus = '';
  let finalizeStatus = '';
  let validationErrors: Record<string, string> = {};
  let destroyed = false;
  let previewVersion = 0;

  function initialDraft(document: unknown) {
    try {
      const raw = JSON.parse(JSON.stringify(document));
      return scenarioDocumentToDraft(raw, parseScenario(JSON.stringify(raw), runtime.kind));
    } catch {
      return createScenarioDraft();
    }
  }

  function activeInputKey(): string | undefined {
    if (inputKind === 'file') return pendingFile ? `file:${pendingFile.name}:${pendingFile.size}:${pendingFile.lastModified}` : undefined;
    if (inputKind === 'local') return composer.localPath ? `local-path:${composer.localPath}` : undefined;
    if (inputKind === 'youtube') return composer.youtubeUrl ? `youtube:${composer.youtubeUrl}` : undefined;
    return composer.embeddedLocation ? `embedded:${composer.embeddedLocation}` : undefined;
  }

  function isInputReady() {
    if (inputKind === 'file') return Boolean(pendingFile);
    if (inputKind === 'local') return composer.localPath.trim().startsWith('/');
    if (inputKind === 'youtube') return composer.youtubeUrl.trim() !== '';
    return composer.embeddedLocation.trim() !== '';
  }

  function isPrepared() {
    return Boolean(preparedSourceKey && preparedSourceKey === activeInputKey() && composer.previewUrl && Number.isFinite(composer.durationSeconds));
  }

  function sourceLocation(source: SourceDraft) {
    return source.kind === 'embedded' ? source.embeddedLocation : source.kind === 'local-path' ? source.localPath : source.youtubeUrl;
  }

  function sourceTypeLabel(source: SourceDraft) {
    return source.kind === 'embedded' ? 'Embedded' : source.kind === 'local-path' ? 'File locale' : 'YouTube';
  }

  function selectedLabel() {
    if (!selectedDestination) return undefined;
    const owner = selectedDestination.kind === 'base'
      ? draft.bases.find((base) => base.draftId === selectedDestination!.draftId)
      : draft.jumpers.find((jumper) => jumper.draftId === selectedDestination!.draftId);
    return owner?.id;
  }

  function rangeError() {
    if (!isPrepared()) return '';
    const start = Number(composer.clipStart);
    const end = Number(composer.clipEnd);
    const duration = composer.durationSeconds ?? 0;
    if (!composer.clipEnabled || composer.clipStart.trim() === '' || composer.clipEnd.trim() === '') return 'Imposta inizio e fine del crop.';
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'I marker devono essere numeri finiti.';
    if (start < 0 || end > duration || start >= end) return `Usa un intervallo valido tra 0 e ${duration.toFixed(2)} s.`;
    return '';
  }

  function canAppend() {
    return isPrepared() && Boolean(selectedLabel()) && rangeError() === '';
  }

  function renderHeader() {
    return `<header class="builder-head" data-region="header">
      <div><p class="eyebrow">SCENARIO AUTHORING / V1</p><h1>Scenario editor</h1></div>
      <div class="toolbar" aria-label="Scenario actions">
        <button type="button" data-action="new">New</button>
        <label class="button">Load JSON<input data-action="load" type="file" accept="application/json" hidden></label>
        <button type="button" data-action="finalize" ${preparingSource || saving ? 'disabled' : ''}>Finalizza e salva</button>
      </div>
      <label class="scenario-name">Scenario name<input data-name value="${escape(draft.name)}" ${validationErrors.scenario ? 'aria-invalid="true"' : ''} required></label>
      <p class="validation" aria-live="polite">${escape(status)}</p>
    </header>`;
  }

  function renderSourceRegion() {
    const desktop = runtime.kind === 'desktop';
    const options = `<option value="file" ${inputKind === 'file' ? 'selected' : ''}>File WAV / MP3</option>
      ${desktop ? `<option value="local" ${inputKind === 'local' ? 'selected' : ''}>Path locale</option><option value="youtube" ${inputKind === 'youtube' ? 'selected' : ''}>URL YouTube</option>` : ''}
      <option value="data" ${inputKind === 'data' ? 'selected' : ''}>Data URI</option>`;
    const contextual = inputKind === 'file'
      ? `<label>File audio<input type="file" data-source-file accept="audio/wav,audio/mpeg,.wav,.mp3"><span class="file-name">${escape(pendingFile?.name ?? 'Nessun file selezionato')}</span></label>`
      : inputKind === 'data'
        ? `<label>Data URI<textarea data-field="embeddedLocation" placeholder="data:audio/wav;base64,…">${escape(composer.embeddedLocation)}</textarea></label>`
        : inputKind === 'local'
          ? `<label>Path assoluto<div class="split"><input data-field="localPath" value="${escape(composer.localPath)}" placeholder="/path/to/audio.wav"><button type="button" data-action="choose-local">Sfoglia…</button></div></label><p class="field-error">${composer.localPath.trim() && !composer.localPath.trim().startsWith('/') ? 'Su macOS il path deve iniziare con /.' : ''}</p>`
          : `<label>URL YouTube<input data-field="youtubeUrl" type="url" value="${escape(composer.youtubeUrl)}" placeholder="https://www.youtube.com/watch?v=…"></label>`;
    return `<section class="source-region panel" data-region="source" aria-labelledby="source-title">
      <div class="section-heading"><p class="eyebrow">01 / SOURCE</p><h2 id="source-title">Source</h2><p>Prepara una volta, poi ritaglia più volte.</p></div>
      <label>Tipo input<select data-input-kind>${options}</select></label>
      <div class="source-input">${contextual}</div>
      <button type="button" data-action="prepare-source" ${!isInputReady() || preparingSource ? 'disabled' : ''}>${preparingSource ? 'Preparazione…' : 'Prepara audio'}</button>
      <p class="source-status" aria-live="polite">${escape(sourceStatus || (isPrepared() ? `Pronto · ${(composer.durationSeconds ?? 0).toFixed(2)} s` : ''))}</p>
    </section>`;
  }

  function compactSource(source: SourceDraft, ownerKind: 'base' | 'jumper', ownerId: string) {
    const crop = source.clipEnabled ? `${source.clipStart || '—'}–${source.clipEnd || '—'} s` : 'sorgente intera';
    const volume = source.volumeEnabled ? `${source.volumeMin}–${source.volumeMax}` : '1';
    return `<li class="assigned-source"><span><strong>crop ${escape(crop)}</strong><small>${escape(sourceTypeLabel(source))} · vol ${escape(volume)}</small></span><button type="button" data-action="remove-crop" data-owner-kind="${ownerKind}" data-owner-id="${ownerId}" data-source-id="${source.draftId}">Rimuovi crop</button></li>`;
  }

  function renderManagerRegion() {
    const bases = draft.bases.map((base) => {
      const selected = selectedDestination?.kind === 'base' && selectedDestination.draftId === base.draftId;
      const empty = isSourceDraftEmpty(base.source);
      const error = validationErrors[base.draftId] ?? '';
      return `<article class="destination-card ${selected ? 'selected' : ''} ${error && empty ? 'invalid' : ''}" data-owner-id="${base.draftId}">
        <div class="destination-title"><label><input type="radio" name="destination" data-destination="base" value="${base.draftId}" ${selected ? 'checked' : ''}><span>Base</span></label><span class="count">${empty ? 0 : 1} crop</span></div>
        <label>ID<input data-base-id="${base.draftId}" value="${escape(base.id)}" ${error ? 'aria-invalid="true"' : ''}></label>
        ${empty ? '<p class="empty-source">Nessun crop assegnato.</p>' : `<ol class="assigned-list">${compactSource(base.source, 'base', base.draftId)}</ol>`}
        <p class="card-error" aria-live="polite">${escape(error)}</p>
        <button type="button" class="danger" data-action="remove-base" data-id="${base.draftId}">Elimina</button>
      </article>`;
    }).join('');
    const jumpers = draft.jumpers.map((jumper) => {
      const selected = selectedDestination?.kind === 'jumper' && selectedDestination.draftId === jumper.draftId;
      const error = validationErrors[jumper.draftId] ?? '';
      return `<article class="destination-card ${selected ? 'selected' : ''} ${error && jumper.sources.length === 0 ? 'invalid' : ''}" data-owner-id="${jumper.draftId}">
        <div class="destination-title"><label><input type="radio" name="destination" data-destination="jumper" value="${jumper.draftId}" ${selected ? 'checked' : ''}><span>Jumper</span></label><span class="count">${jumper.sources.length} crop</span></div>
        <label>ID<input data-jumper-id="${jumper.draftId}" value="${escape(jumper.id)}" ${error ? 'aria-invalid="true"' : ''}></label>
        <div class="schedule-grid"><label>Mean (s)<input data-jumper="mean" data-id="${jumper.draftId}" type="number" min=".01" step=".01" value="${escape(jumper.meanIntervalSeconds)}"></label><label>Deviation (s)<input data-jumper="stddev" data-id="${jumper.draftId}" type="number" min="0" step=".01" value="${escape(jumper.stddevSeconds)}"></label></div>
        <div class="jumper-image-control">
          ${jumper.imageDataUri ? `<img src="${escape(jumper.imageDataUri)}" alt="Visual di ${escape(jumper.id)}"><button type="button" data-action="remove-jumper-image" data-id="${jumper.draftId}">Rimuovi immagine</button>` : `<label>Visual Jumper<input data-jumper-image="${jumper.draftId}" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"><small>PNG, JPEG o WebP · massimo 8 MiB</small></label>`}
        </div>
        <p class="algorithm">Algorithm · increasing_gaussian</p>
        ${jumper.sources.length ? `<ol class="assigned-list">${jumper.sources.map((source) => compactSource(source, 'jumper', jumper.draftId)).join('')}</ol>` : '<p class="empty-source">Nessun crop assegnato.</p>'}
        <p class="card-error" aria-live="polite">${escape(error)}</p>
        <button type="button" class="danger" data-action="remove-jumper" data-id="${jumper.draftId}">Elimina</button>
      </article>`;
    }).join('');
    return `<section class="manager-region panel" data-region="manager" aria-labelledby="manager-title">
      <div class="section-heading"><p class="eyebrow">02 / DESTINATIONS</p><h2 id="manager-title">Basi e Jumper</h2><p>Seleziona dove aggiungere il prossimo crop.</p></div>
      <section class="manager-group" aria-labelledby="bases-title"><div class="manager-toolbar"><h3 id="bases-title">Basi</h3><button type="button" data-action="add-base">Nuova Base</button></div>${bases || '<p class="muted">Nessuna Base.</p>'}</section>
      <section class="manager-group" aria-labelledby="jumpers-title"><div class="manager-toolbar"><h3 id="jumpers-title">Jumper</h3><button type="button" data-action="add-jumper">Nuovo Jumper</button></div>${jumpers || '<p class="muted">Nessun Jumper.</p>'}</section>
    </section>`;
  }

  function renderWorkspaceRegion() {
    const prepared = isPrepared();
    const destination = selectedLabel();
    const error = rangeError();
    const volumeFields = composer.volumeEnabled ? `<div class="volume-range"><label>Min<input data-field="volumeMin" type="number" min="0" step=".05" value="${escape(composer.volumeMin)}"></label><label>Max<input data-field="volumeMax" type="number" min="0" step=".05" value="${escape(composer.volumeMax)}"></label></div>` : '';
    const content = prepared
      ? `<div class="preview-stage"><audio controls src="${escape(composer.previewUrl!)}"></audio><canvas class="waveform" width="960" height="144" aria-label="Waveform interattiva"></canvas></div>
        <div class="crop-controls"><div class="marker-actions"><button type="button" data-action="mark-start">Imposta inizio</button><button type="button" data-action="mark-end">Imposta fine</button></div><div class="marker-values"><label>Start (s)<input data-field="clipStart" type="number" min="0" step=".01" value="${escape(composer.clipStart)}"></label><label>End (s)<input data-field="clipEnd" type="number" min="0" step=".01" value="${escape(composer.clipEnd)}"></label></div><label class="check"><input data-field="volumeEnabled" type="checkbox" ${composer.volumeEnabled ? 'checked' : ''}>Volume variabile</label>${volumeFields}</div>`
      : '<div class="workspace-placeholder"><span>∿</span><p>Prepara una sorgente per vedere waveform e strumenti crop.</p></div>';
    return `<section class="crop-region panel" data-region="crop" aria-labelledby="crop-title">
      <div class="crop-heading"><div><p class="eyebrow">03 / CROP</p><h2 id="crop-title">Waveform e marker</h2></div><p class="duration">${prepared ? `${(composer.durationSeconds ?? 0).toFixed(2)} s` : ''}</p></div>
      ${content}
      <div class="append-bar"><p class="range-error" aria-live="polite">${escape(error)}</p><button type="button" data-action="append-crop" ${canAppend() ? '' : 'disabled'}>${destination ? `Aggiungi crop a ${escape(destination)}` : 'Seleziona una destinazione'}</button></div>
    </section>`;
  }

  function renderEditorScreen() {
    screen = 'editor';
    container.innerHTML = `<div class="builder-shell"><div data-editor-surface>${renderHeader()}<main class="editor-workspace">${renderSourceRegion()}${renderManagerRegion()}${renderWorkspaceRegion()}</main></div></div>`;
    activateWorkspace();
  }

  function ownerName(entry: DraftSourceEntry) {
    return entry.ownerKind === 'base'
      ? draft.bases.find((base) => base.draftId === entry.ownerId)?.id ?? 'Base'
      : draft.jumpers.find((jumper) => jumper.draftId === entry.ownerId)?.id ?? 'Jumper';
  }

  function renderFinalizeScreen(focusTitle = false) {
    const entries = listDraftSourceEntries(draft);
    const allYoutube = entries.length > 0 && entries.every(({ source }) => source.kind === 'youtube');
    const rows = entries.map((entry, index) => {
      const kinds = availableOutputKinds(entry.source, runtime.kind);
      const occurrence = entries.slice(0, index + 1).filter((candidate) => candidate.ownerId === entry.ownerId).length;
      const label = `${ownerName(entry)} · crop ${occurrence}`;
      const output = runtime.kind === 'web'
        ? '<span class="output-readonly">Embedded</span>'
        : `<label>Output<select data-output-source="${entry.source.draftId}">${kinds.map((kind) => `<option value="${kind}" ${entry.source.outputKind === kind ? 'selected' : ''}>${kind === 'embedded' ? 'Embedded' : kind === 'local-path' ? 'WAV' : 'Link YouTube'}</option>`).join('')}</select></label>`;
      return `<li class="output-row"><span><strong>${escape(label)}</strong><small>${escape(sourceTypeLabel(entry.source))} · ${entry.source.clipStart}–${entry.source.clipEnd} s</small></span>${output}</li>`;
    }).join('');
    const progress = saving ? `<div class="materialization-overlay" role="dialog" aria-modal="true" aria-labelledby="materialization-title"><div><p class="eyebrow">MATERIALIZATION</p><h2 id="materialization-title">Creazione scenario</h2><progress max="${Math.max(1, materializationProgress.total)}" value="${materializationProgress.completed}"></progress><p class="progress-percent">${materializationProgress.total ? Math.round(materializationProgress.completed / materializationProgress.total * 100) : 0}%</p><p aria-live="assertive">${escape(materializationProgress.message)}</p></div></div>` : '';
    container.innerHTML = `<div class="builder-shell finalize-shell"><main class="finalize-screen">
      <header class="finalize-head"><p class="eyebrow">FINAL CHECK</p><h1 tabindex="-1" data-finalize-title>Finalizza scenario</h1><p>${escape(draft.name)} · ${draft.bases.length} Basi · ${draft.jumpers.length} Jumper · ${entries.length} crop</p></header>
      <section class="preset-panel" aria-labelledby="preset-title"><h2 id="preset-title">Preset globale</h2><div class="preset-actions"><button type="button" data-action="apply-preset" data-kind="embedded">Incorpora tutti</button>${runtime.kind === 'desktop' ? '<button type="button" data-action="apply-preset" data-kind="local-path">Crea WAV per tutti</button>' : ''}${runtime.kind === 'desktop' && allYoutube ? '<button type="button" data-action="apply-preset" data-kind="youtube">Mantieni link YouTube</button>' : ''}</div><p class="preset-status" aria-live="polite">${escape(finalizeStatus)}</p></section>
      <section class="output-panel" aria-labelledby="output-title"><h2 id="output-title">Piano output</h2><ol class="output-list">${rows}</ol></section>
      <footer class="finalize-actions"><button type="button" data-action="back-editor" ${saving ? 'disabled' : ''}>Indietro</button><button type="button" data-action="save-final" ${saving ? 'disabled' : ''}>Crea e salva JSON</button></footer>
    </main>${progress}</div>`;
    if (focusTitle) queueMicrotask(() => container.querySelector<HTMLElement>('[data-finalize-title]')?.focus());
  }

  function replaceRegion(name: 'header' | 'source' | 'manager' | 'crop', html: string) {
    const current = container.querySelector<HTMLElement>(`[data-region="${name}"]`);
    if (!current) return;
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    current.replaceWith(template.content.firstElementChild!);
  }

  function refreshHeader() { if (screen === 'editor') replaceRegion('header', renderHeader()); }
  function refreshSource() { if (screen === 'editor') replaceRegion('source', renderSourceRegion()); }
  function refreshManager() { if (screen === 'editor') replaceRegion('manager', renderManagerRegion()); }
  function refreshWorkspace() { if (screen === 'editor') { replaceRegion('crop', renderWorkspaceRegion()); activateWorkspace(); } }

  function clearPreparedState() {
    composer.previewUrl = undefined;
    composer.durationSeconds = undefined;
    composer.waveform = undefined;
    composer.clipEnabled = false;
    composer.clipStart = '';
    composer.clipEnd = '';
    preparedSourceKey = undefined;
    previewCurrentTime = 0;
  }

  async function invalidatePrepared() {
    previewVersion += 1;
    const release = preparedRelease;
    preparedRelease = undefined;
    clearPreparedState();
    if (release) await release().catch(() => {});
  }

  function invalidateIfMismatched() {
    if (preparedSourceKey && preparedSourceKey !== activeInputKey()) {
      void invalidatePrepared();
      refreshWorkspace();
    }
  }

  function paintWaveform() {
    const canvas = container.querySelector<HTMLCanvasElement>('.waveform');
    const audio = container.querySelector<HTMLAudioElement>('.crop-region audio');
    if (!canvas || !audio || !composer.waveform) return;
    const pen = canvas.getContext('2d');
    if (!pen) return;
    const width = canvas.width;
    const height = canvas.height;
    pen.fillStyle = '#08121b';
    pen.fillRect(0, 0, width, height);
    const start = Number(composer.clipStart);
    const end = Number(composer.clipEnd);
    const duration = composer.durationSeconds ?? audio.duration;
    if (composer.clipEnabled && Number.isFinite(start) && Number.isFinite(end) && duration > 0 && start < end) {
      pen.fillStyle = 'rgba(231, 166, 75, .18)';
      pen.fillRect(start / duration * width, 0, (end - start) / duration * width, height);
    }
    pen.strokeStyle = '#e7a64b';
    pen.lineWidth = 1.5;
    pen.beginPath();
    composer.waveform.forEach((peak, x) => {
      const center = height / 2;
      const amplitude = peak * height * .43;
      pen.moveTo(x, center - amplitude);
      pen.lineTo(x, center + amplitude);
    });
    pen.stroke();
    const line = (seconds: number, color: string, lineWidth: number) => {
      if (!Number.isFinite(seconds) || !duration) return;
      const x = Math.max(0, Math.min(width, seconds / duration * width));
      pen.strokeStyle = color;
      pen.lineWidth = lineWidth;
      pen.beginPath();
      pen.moveTo(x, 0);
      pen.lineTo(x, height);
      pen.stroke();
    };
    line(start, '#72d6c9', 2);
    line(end, '#ffb4a8', 2);
    line(audio.currentTime, '#f8ecd0', 1);
  }

  async function drawWaveform(audio: HTMLAudioElement) {
    if (!audio.src || composer.waveform) { paintWaveform(); return; }
    try {
      const bytes = await fetch(audio.src).then((response) => response.arrayBuffer());
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes);
      await context.close();
      const samples = buffer.getChannelData(0);
      const width = 960;
      const step = Math.max(1, Math.floor(samples.length / width));
      composer.waveform = Array.from({ length: width }, (_, x) => {
        let peak = 0;
        const limit = Math.min(samples.length, (x + 1) * step);
        for (let index = x * step; index < limit; index += 1) peak = Math.max(peak, Math.abs(samples[index]!));
        return peak;
      });
      paintWaveform();
    } catch (error) {
      sourceStatus = error instanceof Error ? `Waveform non disponibile: ${error.message}` : 'Waveform non disponibile';
      refreshSource();
    }
  }

  function activateWorkspace() {
    const audio = container.querySelector<HTMLAudioElement>('.crop-region audio');
    const canvas = container.querySelector<HTMLCanvasElement>('.waveform');
    if (!audio || !canvas) return;
    const restore = () => {
      if (Number.isFinite(previewCurrentTime)) audio.currentTime = Math.min(previewCurrentTime, Number.isFinite(audio.duration) ? audio.duration : previewCurrentTime);
      paintWaveform();
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) restore(); else audio.addEventListener('loadedmetadata', restore, { once: true });
    audio.addEventListener('timeupdate', () => { previewCurrentTime = audio.currentTime; paintWaveform(); });
    audio.addEventListener('seeked', paintWaveform);
    canvas.addEventListener('pointerdown', (event) => {
      if (!audio.duration) return;
      const bounds = canvas.getBoundingClientRect();
      audio.currentTime = audio.duration * Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      previewCurrentTime = audio.currentTime;
      paintWaveform();
    });
    void drawWaveform(audio);
  }

  function syncWorkspaceControls() {
    const append = container.querySelector<HTMLButtonElement>('[data-action="append-crop"]');
    if (append) {
      const destination = selectedLabel();
      append.textContent = destination ? `Aggiungi crop a ${destination}` : 'Seleziona una destinazione';
      append.disabled = !canAppend();
    }
    const error = container.querySelector<HTMLElement>('.range-error');
    if (error) error.textContent = rangeError();
    const start = container.querySelector<HTMLInputElement>('[data-field="clipStart"]');
    const end = container.querySelector<HTMLInputElement>('[data-field="clipEnd"]');
    if (start && document.activeElement !== start) start.value = composer.clipStart;
    if (end && document.activeElement !== end) end.value = composer.clipEnd;
    paintWaveform();
  }
  function syncSourceControls() {
    const prepare = container.querySelector<HTMLButtonElement>('[data-action="prepare-source"]');
    if (prepare) prepare.disabled = !isInputReady() || preparingSource;
    const liveStatus = container.querySelector<HTMLElement>('.source-status');
    if (liveStatus) liveStatus.textContent = sourceStatus;
    const pathError = container.querySelector<HTMLElement>('.source-region .field-error');
    if (pathError) pathError.textContent = composer.localPath.trim() && !composer.localPath.trim().startsWith('/') ? 'Su macOS il path deve iniziare con /.' : '';
  }


  async function prepareSource() {
    if (!isInputReady() || preparingSource) return;
    const key = activeInputKey();
    if (!key) return;
    const version = ++previewVersion;
    const release = preparedRelease;
    preparedRelease = undefined;
    clearPreparedState();
    preparingSource = true;
    sourceStatus = '';
    refreshHeader(); refreshSource(); refreshWorkspace();
    if (release) await release().catch(() => {});
    try {
      let preview: { url: string; durationSeconds: number; release?: () => Promise<void> };
      if (inputKind === 'file') {
        const result = await fileToEmbeddedDataUri(pendingFile!);
        composer.kind = 'embedded';
        composer.embeddedLocation = result.location;
        preview = { url: result.location, durationSeconds: result.durationSeconds };
      } else if (inputKind === 'data') {
        const data = inspectDataUri(composer.embeddedLocation);
        const inspection = inspectEmbeddedAudio(data.bytes, data.mime);
        composer.kind = 'embedded';
        preview = { url: composer.embeddedLocation, durationSeconds: inspection.durationSeconds };
      } else {
        if (!runtime.prepareAudio) throw new Error('Preview desktop non disponibile');
        composer.kind = inputKind === 'local' ? 'local-path' : 'youtube';
        const result = await runtime.prepareAudio({ location: sourceLocation(composer) });
        preview = result;
      }
      if (destroyed || version !== previewVersion || key !== activeInputKey()) {
        await preview.release?.().catch(() => {});
        return;
      }
      composer.previewUrl = preview.url;
      composer.durationSeconds = preview.durationSeconds;
      composer.waveform = undefined;
      preparedRelease = preview.release;
      preparedSourceKey = key;
      previewCurrentTime = 0;
      sourceStatus = '';
    } catch (error) {
      sourceStatus = error instanceof Error ? error.message : 'Impossibile preparare l’audio';
    } finally {
      if (version === previewVersion && !destroyed) {
        preparingSource = false;
        refreshHeader(); refreshSource(); refreshWorkspace();
      }
    }
  }

  function resetAppendMarkers() {
    composer.clipEnabled = false;
    composer.clipStart = '';
    composer.clipEnd = '';
  }

  function appendCrop() {
    if (!selectedDestination || !canAppend()) return;
    const snapshot = cloneSourceDraft(composer);
    if (selectedDestination.kind === 'jumper') {
      const jumper = draft.jumpers.find((item) => item.draftId === selectedDestination!.draftId);
      if (!jumper) return;
      jumper.sources.push(snapshot);
      resetAppendMarkers();
      validationErrors = {};
      refreshManager(); syncWorkspaceControls();
      return;
    }
    const base = draft.bases.find((item) => item.draftId === selectedDestination!.draftId);
    if (!base) return;
    if (isSourceDraftEmpty(base.source)) {
      base.source = snapshot;
      resetAppendMarkers();
      validationErrors = {};
      refreshManager(); syncWorkspaceControls();
      return;
    }
    pendingBaseReplacement = { baseDraftId: base.draftId, source: snapshot };
    showReplacementDialog();
  }

  function showReplacementDialog() {
    const shell = container.querySelector('.builder-shell');
    const surface = container.querySelector<HTMLElement>('[data-editor-surface]');
    if (!shell || !surface || !pendingBaseReplacement) return;
    surface.inert = true;
    shell.insertAdjacentHTML('beforeend', `<div class="dialog-backdrop"><section class="replacement-dialog" role="alertdialog" aria-modal="true" aria-labelledby="replacement-title" aria-describedby="replacement-description"><p class="eyebrow">BASE OCCUPATA</p><h2 id="replacement-title">Sostituire il crop?</h2><p id="replacement-description">La Base contiene già un crop. La sostituzione avverrà solo dopo conferma.</p><div class="dialog-actions"><button type="button" data-action="cancel-replacement">Annulla</button><button type="button" data-action="confirm-replacement">Sostituisci</button></div></section></div>`);
    queueMicrotask(() => container.querySelector<HTMLButtonElement>('[data-action="cancel-replacement"]')?.focus());
  }

  function closeReplacement(returnFocus = true) {
    pendingBaseReplacement = undefined;
    container.querySelector('.dialog-backdrop')?.remove();
    const surface = container.querySelector<HTMLElement>('[data-editor-surface]');
    if (surface) surface.inert = false;
    if (returnFocus) queueMicrotask(() => container.querySelector<HTMLButtonElement>('[data-action="append-crop"]')?.focus());
  }

  function confirmReplacement() {
    const replacement = pendingBaseReplacement;
    if (!replacement) return;
    const base = draft.bases.find((item) => item.draftId === replacement.baseDraftId);
    if (base) base.source = replacement.source;
    closeReplacement(false);
    resetAppendMarkers();
    validationErrors = {};
    refreshManager(); syncWorkspaceControls();
    queueMicrotask(() => container.querySelector<HTMLButtonElement>('[data-action="append-crop"]')?.focus());
  }

  function errorOwner(pointer: string) {
    if (draft.bases.some((base) => base.draftId === pointer) || draft.jumpers.some((jumper) => jumper.draftId === pointer)) return pointer;
    const parts = pointer.replace(/^\//, '').split('/');
    if (parts[0] === 'bases' && Number.isInteger(Number(parts[1]))) return draft.bases[Number(parts[1])]?.draftId;
    if (parts[0] === 'jumpers' && Number.isInteger(Number(parts[1]))) return draft.jumpers[Number(parts[1])]?.draftId;
    return undefined;
  }

  function enterFinalize() {
    const validation = validateScenarioDraft(draft, runtime.kind);
    if (!validation.candidate) {
      validationErrors = {};
      let firstOwner: string | undefined;
      for (const [pointer, message] of Object.entries(validation.errors)) {
        const owner = errorOwner(pointer);
        if (owner) { validationErrors[owner] = message; firstOwner ??= owner; }
        else validationErrors.scenario = message;
      }
      status = validation.summary;
      refreshHeader(); refreshManager();
      queueMicrotask(() => {
        if (firstOwner) {
          const card = container.querySelector<HTMLElement>(`[data-owner-id="${CSS.escape(firstOwner)}"]`);
          card?.scrollIntoView({ block: 'nearest' });
          card?.querySelector<HTMLElement>('input,button')?.focus();
        } else container.querySelector<HTMLInputElement>('[data-name]')?.focus();
      });
      return;
    }
    const audio = container.querySelector<HTMLAudioElement>('.crop-region audio');
    if (audio) previewCurrentTime = audio.currentTime;
    validationErrors = {};
    status = '';
    finalizeStatus = '';
    screen = 'finalize';
    renderFinalizeScreen(true);
  }

  function backToEditor() {
    screen = 'editor';
    renderEditorScreen();
    queueMicrotask(() => container.querySelector<HTMLButtonElement>('[data-action="finalize"]')?.focus());
  }

  async function saveFinal() {
    if (saving) return;
    const validation = validateScenarioDraft(draft, runtime.kind);
    if (!validation.candidate) { finalizeStatus = validation.summary; renderFinalizeScreen(); return; }
    const total = listDraftSourceEntries(draft).length;
    materializationProgress = { completed: 0, total, message: 'Preparing sources' };
    saving = true;
    finalizeStatus = '';
    renderFinalizeScreen();
    try {
      const document = runtime.kind === 'web'
        ? await cropEmbeddedSources(validation.candidate, (progress) => { materializationProgress = progress; renderFinalizeScreen(); })
        : validation.candidate;
      parseScenario(JSON.stringify(document), runtime.kind);
      const result = await runtime.saveScenario(`${JSON.stringify(document, null, 2)}\n`, `${slug(draft.name)}.json`, {
        outputKinds: buildOutputPlan(draft),
        onProgress: (progress) => { materializationProgress = progress; renderFinalizeScreen(); },
      });
      saving = false;
      materializationProgress = emptyProgress();
      if (result.canceled) {
        finalizeStatus = 'Salvataggio annullato. Il piano output è invariato.';
        renderFinalizeScreen();
        return;
      }
      status = 'Scenario salvato.';
      screen = 'editor';
      renderEditorScreen();
    } catch (error) {
      saving = false;
      materializationProgress = emptyProgress();
      finalizeStatus = error instanceof Error ? error.message : 'Impossibile salvare il JSON';
      renderFinalizeScreen();
    }
  }

  function resetRendererState(nextDraft: ScenarioDraft) {
    const release = preparedRelease;
    previewVersion += 1;
    preparedRelease = undefined;
    draft = nextDraft;
    composer = createSourceDraft();
    screen = 'editor';
    inputKind = 'file';
    pendingFile = undefined;
    preparedSourceKey = undefined;
    previewCurrentTime = 0;
    selectedDestination = undefined;
    pendingBaseReplacement = undefined;
    preparingSource = false;
    saving = false;
    materializationProgress = emptyProgress();
    status = '';
    sourceStatus = '';
    finalizeStatus = '';
    validationErrors = {};
    void release?.().catch(() => {});
    renderEditorScreen();
  }

  async function loadDocument(file: File) {
    try {
      const document = JSON.parse(await file.text());
      const normalized = parseScenario(JSON.stringify(document), runtime.kind);
      resetRendererState(scenarioDocumentToDraft(document, normalized));
    } catch (error) {
      status = error instanceof Error ? error.message : 'Impossibile caricare il JSON';
      refreshHeader();
    }
  }
  async function setJumperImage(draftId: string, file: File) {
    const jumper = draft.jumpers.find((item) => item.draftId === draftId);
    if (!jumper) return;
    try {
      jumper.imageDataUri = await fileToEmbeddedImageDataUri(file);
      delete validationErrors[draftId];
    } catch (error) {
      validationErrors[draftId] = error instanceof Error ? error.message : 'Impossibile incorporare l’immagine';
    }
    refreshManager();
  }


  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (target.dataset.name !== undefined) { draft.name = target.value; validationErrors = {}; status = ''; return; }
    if (target.dataset.baseId) { const base = draft.bases.find((item) => item.draftId === target.dataset.baseId); if (base) base.id = target.value; validationErrors = {}; return; }
    if (target.dataset.jumperId) { const jumper = draft.jumpers.find((item) => item.draftId === target.dataset.jumperId); if (jumper) jumper.id = target.value; validationErrors = {}; return; }
    const jumper = target.dataset.jumper ? draft.jumpers.find((item) => item.draftId === target.dataset.id) : undefined;
    if (jumper) { target.dataset.jumper === 'mean' ? jumper.meanIntervalSeconds = target.value : jumper.stddevSeconds = target.value; validationErrors = {}; return; }
    const field = target.dataset.field as keyof SourceDraft | undefined;
    if (!field) return;
    const value = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
    (composer as unknown as Record<string, string | boolean>)[field] = value;
    if (field === 'localPath') composer.kind = 'local-path';
    if (field === 'youtubeUrl') composer.kind = 'youtube';
    if (field === 'embeddedLocation') composer.kind = 'embedded';
    if (field === 'clipStart' || field === 'clipEnd') composer.clipEnabled = true;
    if (field === 'embeddedLocation' || field === 'localPath' || field === 'youtubeUrl') {
      sourceStatus = '';
      invalidateIfMismatched();
      syncSourceControls();
    }
    if (field === 'volumeEnabled') refreshWorkspace(); else syncWorkspaceControls();
  });

  container.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target instanceof HTMLInputElement && target.files?.[0] && target.dataset.action === 'load') { void loadDocument(target.files[0]); return; }
    if (target instanceof HTMLInputElement && target.files?.[0] && target.dataset.jumperImage) {
      void setJumperImage(target.dataset.jumperImage, target.files[0]);
      return;
    }
    if (target instanceof HTMLInputElement && target.files?.[0] && target.dataset.sourceFile !== undefined) {
      pendingFile = target.files[0];
      sourceStatus = '';
      invalidateIfMismatched();
      refreshSource(); refreshWorkspace();
      return;
    }
    if (target.dataset.inputKind !== undefined) {
      inputKind = target.value as InputKind;
      sourceStatus = '';
      void invalidatePrepared();
      refreshSource(); refreshWorkspace();
      return;
    }
    if (target.dataset.destination) {
      selectedDestination = { kind: target.dataset.destination as Destination['kind'], draftId: target.value };
      refreshManager(); syncWorkspaceControls();
      return;
    }
    if (target.dataset.outputSource) {
      const entry = listDraftSourceEntries(draft).find(({ source }) => source.draftId === target.dataset.outputSource);
      if (entry) entry.source.outputKind = target.value as SourceOutputKind;
      finalizeStatus = '';
    }
  });

  container.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'new') { resetRendererState(createScenarioDraft()); return; }
    if (action === 'finalize') { enterFinalize(); return; }
    if (action === 'prepare-source') { void prepareSource(); return; }
    if (action === 'choose-local') { void runtime.chooseLocalAudio?.().then((choice) => { if (!choice) return; composer.localPath = choice.path; composer.kind = 'local-path'; sourceStatus = ''; invalidateIfMismatched(); refreshSource(); refreshWorkspace(); }); return; }
    if (action === 'add-base') { const base = addBaseDraft(draft); draft.bases.push(base); selectedDestination = { kind: 'base', draftId: base.draftId }; validationErrors = {}; refreshManager(); syncWorkspaceControls(); return; }
    if (action === 'add-jumper') { const jumper = addJumperDraft(draft); draft.jumpers.push(jumper); selectedDestination = { kind: 'jumper', draftId: jumper.draftId }; validationErrors = {}; refreshManager(); syncWorkspaceControls(); return; }
    if (action === 'remove-base') { draft.bases = draft.bases.filter((item) => item.draftId !== button.dataset.id); if (selectedDestination?.kind === 'base' && selectedDestination.draftId === button.dataset.id) selectedDestination = undefined; refreshManager(); syncWorkspaceControls(); return; }
    if (action === 'remove-jumper') { draft.jumpers = draft.jumpers.filter((item) => item.draftId !== button.dataset.id); if (selectedDestination?.kind === 'jumper' && selectedDestination.draftId === button.dataset.id) selectedDestination = undefined; refreshManager(); syncWorkspaceControls(); return; }
    if (action === 'remove-jumper-image') { const jumper = draft.jumpers.find((item) => item.draftId === button.dataset.id); if (jumper) jumper.imageDataUri = ''; refreshManager(); return; }
    if (action === 'remove-crop') {
      if (button.dataset.ownerKind === 'base') { const base = draft.bases.find((item) => item.draftId === button.dataset.ownerId); if (base && !isSourceDraftEmpty(base.source)) base.source = createSourceDraft(); }
      if (button.dataset.ownerKind === 'jumper') { const jumper = draft.jumpers.find((item) => item.draftId === button.dataset.ownerId); if (jumper) jumper.sources = jumper.sources.filter((source) => source.draftId !== button.dataset.sourceId); }
      refreshManager(); return;
    }
    if (action === 'mark-start' || action === 'mark-end') {
      const audio = container.querySelector<HTMLAudioElement>('.crop-region audio');
      if (!audio || !Number.isFinite(audio.currentTime)) return;
      composer.clipEnabled = true;
      if (action === 'mark-start') composer.clipStart = audio.currentTime.toFixed(2); else composer.clipEnd = audio.currentTime.toFixed(2);
      syncWorkspaceControls();
      return;
    }
    if (action === 'append-crop') { appendCrop(); return; }
    if (action === 'cancel-replacement') { closeReplacement(); return; }
    if (action === 'confirm-replacement') { confirmReplacement(); return; }
    if (action === 'back-editor') { backToEditor(); return; }
    if (action === 'apply-preset') {
      const result = applyOutputPreset(draft, button.dataset.kind as SourceKind, runtime.kind);
      finalizeStatus = result.skipped ? `${result.applied} applicati · ${result.skipped} non compatibili` : `${result.applied} output aggiornati`;
      renderFinalizeScreen();
      return;
    }
    if (action === 'save-final') { void saveFinal(); }
  });

  container.addEventListener('keydown', (event) => {
    const dialog = container.querySelector<HTMLElement>('.replacement-dialog');
    if (!dialog) return;
    if (event.key === 'Escape') { event.preventDefault(); closeReplacement(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  renderEditorScreen();
  return {
    destroy() {
      destroyed = true;
      previewVersion += 1;
      const release = preparedRelease;
      preparedRelease = undefined;
      void release?.().catch(() => {});
      container.replaceChildren();
    },
  };
}
