import { type ApplicationController, type JumperScheduleField, type PlaybackEvent, type Snapshot } from '@ambiental/core';
import { FireworksScene } from './fireworks.js';
import { JumperImagePresenter } from './image-presenter.js';

export interface PlayerViewHandle { destroy(): void; }

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12 8 5.2Z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>';
const stopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>';

export function mountPlayerView(container: HTMLElement, controller: ApplicationController): PlayerViewHandle {
  container.innerHTML = `<section class="player-stage" aria-labelledby="player-title">
    <canvas class="fireworks-canvas" aria-hidden="true" data-bursts="0"></canvas>
    <figure class="jumper-image-stage" data-presentations="0" data-phase="hidden" aria-hidden="true" hidden><img alt=""></figure>
    <div class="player-vignette"></div>
    <div class="player-meta" aria-label="Scenario composition"><span data-base-count>0 Base</span><button type="button" class="jumper-meta-toggle" data-jumper-count aria-expanded="false" aria-controls="jumper-live-panel" disabled>0 Jumper</button></div>
    <aside class="jumper-live-panel" id="jumper-live-panel" aria-labelledby="jumper-live-title" hidden>
      <div class="jumper-live-head"><div><p class="eyebrow">Modulazione live</p><h2 id="jumper-live-title">Jumper</h2></div><button type="button" data-jumper-panel-close>Chiudi</button></div>
      <div class="jumper-live-list" data-jumper-live-list></div>
      <p class="jumper-live-note">Le variazioni sono temporanee e non modificano lo scenario.</p>
    </aside>
    <div class="player-status-panel">
      <p class="player-state" data-player-state aria-live="polite">Caricamento scenario</p>
      <h1 id="player-title" class="player-scenario" data-player-scenario>In attesa</h1>
    </div>
    <div class="transport" aria-label="Controlli riproduzione">
      <button type="button" class="transport-main" data-player-action="toggle" aria-label="Riproduci">${playIcon}</button>
      <button type="button" class="transport-stop" data-player-action="stop" aria-label="Stop" disabled>${stopIcon}</button>
    </div>
  </section>`;

  const canvas = container.querySelector<HTMLCanvasElement>('.fireworks-canvas')!;
  const toggle = container.querySelector<HTMLButtonElement>('[data-player-action="toggle"]')!;
  const stop = container.querySelector<HTMLButtonElement>('[data-player-action="stop"]')!;
  const stateLabel = container.querySelector<HTMLElement>('[data-player-state]')!;
  const scenarioLabel = container.querySelector<HTMLElement>('[data-player-scenario]')!;
  const baseCount = container.querySelector<HTMLElement>('[data-base-count]')!;
  const jumperCount = container.querySelector<HTMLButtonElement>('[data-jumper-count]')!;
  const jumperPanel = container.querySelector<HTMLElement>('#jumper-live-panel')!;
  const jumperList = container.querySelector<HTMLElement>('[data-jumper-live-list]')!;
  const jumperPanelClose = container.querySelector<HTMLButtonElement>('[data-jumper-panel-close]')!;
  const imageStage = container.querySelector<HTMLElement>('.jumper-image-stage')!;
  const imagePresenter = new JumperImagePresenter(imageStage, imageStage.querySelector<HTMLImageElement>('img')!);
  let fireworks: FireworksScene | undefined;
  try { fireworks = new FireworksScene(canvas); } catch { canvas.dataset.renderer = 'unavailable'; }
  let preloadedScenario: Snapshot['scenario'];

  const setJumperPanelOpen = (open: boolean) => {
    jumperPanel.hidden = !open;
    jumperCount.setAttribute('aria-expanded', String(open));
  };

  const stepFor = (seconds: number) => seconds < 0.1 ? 0.001 : seconds < 1 ? 0.01 : 0.1;

  const configureJumperSlider = (article: HTMLElement) => {
    const jumperId = article.dataset.jumperId!;
    const selector = article.querySelector<HTMLSelectElement>('[data-jumper-parameter]')!;
    const input = article.querySelector<HTMLInputElement>('[data-jumper-schedule-value]')!;
    const output = article.querySelector<HTMLOutputElement>('output')!;
    const label = article.querySelector<HTMLElement>('[data-jumper-value-label]')!;
    const scale = article.querySelector<HTMLElement>('.jumper-live-scale')!;
    const field = selector.value as JumperScheduleField;
    const schedule = controller.getJumperSchedule(jumperId);
    const step = stepFor(schedule.mean_interval_seconds);
    const value = schedule[field];
    if (field === 'mean_interval_seconds') {
      input.min = String((Math.floor(schedule.stddev_seconds / step) + 1) * step);
      input.max = String(Math.max(schedule.mean_interval_seconds * 4, Number(input.min) + step));
      label.textContent = 'Intervallo temporaneo';
      scale.innerHTML = '<span>Più frequente</span><span>Più raro</span>';
    } else {
      input.min = '0';
      input.max = String(Math.max(0, Math.floor((schedule.mean_interval_seconds - step) / step) * step));
      label.textContent = 'Deviazione temporanea';
      scale.innerHTML = '<span>Più regolare</span><span>Più variabile</span>';
    }
    input.step = String(step);
    input.value = String(value);
    input.dataset.scheduleField = field;
    input.setAttribute('aria-label', `${label.textContent} per ${jumperId}`);
    input.setAttribute('aria-valuetext', `${value.toFixed(2)} secondi`);
    output.textContent = `${value.toFixed(2)} s`;
  };

  const renderJumperControls = (snapshot: Snapshot) => {
    jumperList.replaceChildren();
    for (const jumper of snapshot.scenario?.jumpers ?? []) {
      const article = document.createElement('article');
      article.className = 'jumper-live-card';
      article.dataset.jumperId = jumper.id;
      const heading = document.createElement('h3');
      heading.textContent = jumper.id;
      const values = document.createElement('dl');
      values.innerHTML = `<div><dt>Intervallo programmato</dt><dd>${jumper.schedule.mean_interval_seconds.toFixed(2)} s</dd></div><div><dt>Deviazione programmata</dt><dd>${jumper.schedule.stddev_seconds.toFixed(2)} s</dd></div>`;
      const picker = document.createElement('label');
      picker.className = 'jumper-parameter-picker';
      picker.textContent = 'Parametro da modulare';
      const selector = document.createElement('select');
      selector.dataset.jumperParameter = jumper.id;
      selector.setAttribute('aria-label', `Parametro temporaneo per ${jumper.id}`);
      selector.innerHTML = '<option value="mean_interval_seconds">Intervallo medio</option><option value="stddev_seconds">Deviazione standard</option>';
      picker.append(selector);
      const slider = document.createElement('label');
      slider.className = 'jumper-value-slider';
      const sliderLabel = document.createElement('span');
      sliderLabel.dataset.jumperValueLabel = '';
      const readout = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.dataset.jumperScheduleValue = jumper.id;
      const scale = document.createElement('span');
      scale.className = 'jumper-live-scale';
      slider.append(sliderLabel, readout, input, scale);
      article.append(heading, values, picker, slider);
      jumperList.append(article);
      configureJumperSlider(article);
    }
  };

  const render = (snapshot: Snapshot) => {
    const playing = snapshot.state === 'PLAYING';
    const paused = snapshot.state === 'PAUSED';
    const playable = Boolean(snapshot.scenario) && ['READY', 'STOPPED', 'PLAYING', 'PAUSED'].includes(snapshot.state);
    container.querySelector<HTMLElement>('.player-stage')!.dataset.state = snapshot.state;
    if (snapshot.scenario !== preloadedScenario) {
      preloadedScenario = snapshot.scenario;
      imagePresenter.preload(snapshot.scenario?.jumpers.flatMap((jumper) => jumper.image ? [jumper.image] : []) ?? []);
      renderJumperControls(snapshot);
      setJumperPanelOpen(false);
    }
    if (!['PLAYING', 'PAUSED'].includes(snapshot.state)) imagePresenter.reset();
    toggle.innerHTML = playing ? pauseIcon : playIcon;
    toggle.setAttribute('aria-label', playing ? 'Pausa' : paused ? 'Riprendi' : 'Riproduci');
    toggle.disabled = !playable;
    stop.disabled = !playing && !paused;
    stateLabel.textContent = snapshot.error ?? ({
      LOADING: 'Preparazione del paesaggio sonoro',
      READY: 'Pronto alla riproduzione',
      PLAYING: 'Trasmissione attiva',
      PAUSED: 'Trasmissione in pausa',
      STOPPING: 'Arresto in corso',
      STOPPED: snapshot.scenario ? 'Riproduzione arrestata' : 'Nessuno scenario caricato',
      ERROR: 'Errore di riproduzione',
    } satisfies Record<Snapshot['state'], string>)[snapshot.state];
    scenarioLabel.textContent = snapshot.scenario?.name ?? 'Carica uno scenario dal menu';
    baseCount.textContent = `${snapshot.scenario?.bases.length ?? 0} Base`;
    jumperCount.textContent = `${snapshot.scenario?.jumpers.length ?? 0} Jumper`;
    jumperCount.disabled = !snapshot.scenario?.jumpers.length;
  };

  const showJumper = (event: PlaybackEvent) => {
    const image = controller.snapshot.scenario?.jumpers.find((jumper) => jumper.id === event.jumperId)?.image;
    if (event.type === 'jumper-will-start') {
      if (image) imagePresenter.show(image, event.playbackId, event.at);
    } else if (event.type === 'jumper-started') {
      if (image) imagePresenter.markAudioStarted(event.playbackId, event.at);
      else fireworks?.burst();
    } else if (image) {
      if (controller.snapshot.state === 'PAUSED') imagePresenter.reset();
      else imagePresenter.hide(event.playbackId, event.at);
    }
  };

  const unsubscribeState = controller.subscribe(render);
  const unsubscribePlayback = controller.subscribePlayback(showJumper);
  toggle.addEventListener('click', () => {
    if (controller.snapshot.state === 'PLAYING' || controller.snapshot.state === 'PAUSED') void controller.togglePause();
    else void controller.start();
  });
  stop.addEventListener('click', () => controller.stop());
  jumperCount.addEventListener('click', () => setJumperPanelOpen(jumperPanel.hidden));
  jumperPanelClose.addEventListener('click', () => {
    setJumperPanelOpen(false);
    jumperCount.focus();
  });
  jumperPanel.addEventListener('change', (event) => {
    const selector = event.target instanceof HTMLSelectElement ? event.target : undefined;
    if (!selector?.dataset.jumperParameter) return;
    const article = selector.closest<HTMLElement>('.jumper-live-card');
    if (article) configureJumperSlider(article);
  });
  jumperPanel.addEventListener('input', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : undefined;
    const jumperId = input?.dataset.jumperScheduleValue;
    const field = input?.dataset.scheduleField;
    if (!input || !jumperId || (field !== 'mean_interval_seconds' && field !== 'stddev_seconds')) return;
    const seconds = Number(input.value);
    controller.setJumperScheduleValue(jumperId, field, seconds);
    input.setAttribute('aria-valuetext', `${seconds.toFixed(2)} secondi`);
    const output = input.parentElement?.querySelector('output');
    if (output) output.textContent = `${seconds.toFixed(2)} s`;
  });
  const closeJumperPanel = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || jumperPanel.hidden) return;
    setJumperPanelOpen(false);
    jumperCount.focus();
  };
  document.addEventListener('keydown', closeJumperPanel);

  return {
    destroy() {
      unsubscribeState();
      unsubscribePlayback();
      fireworks?.destroy();
      imagePresenter.destroy();
      document.removeEventListener('keydown', closeJumperPanel);
      container.replaceChildren();
    },
  };
}
