import { type ApplicationController, type PlaybackEvent, type Snapshot } from '@ambiental/core';
import { FireworksScene } from './fireworks.js';

export interface PlayerViewHandle { destroy(): void; }

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12 8 5.2Z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>';
const stopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>';

export function mountPlayerView(container: HTMLElement, controller: ApplicationController): PlayerViewHandle {
  container.innerHTML = `<section class="player-stage" aria-labelledby="player-title">
    <canvas class="fireworks-canvas" aria-hidden="true" data-bursts="0"></canvas>
    <div class="player-vignette"></div>
    <header class="player-head">
      <div><p class="eyebrow">AMBIENTAL / LIVE FIELD</p><h1 id="player-title">Night signal</h1></div>
      <div class="player-meta" aria-label="Scenario composition"><span data-base-count>0 Base</span><span data-jumper-count>0 Jumper</span></div>
    </header>
    <div class="player-status-panel">
      <p class="player-state" data-player-state aria-live="polite">Caricamento scenario</p>
      <p class="player-scenario" data-player-scenario>In attesa</p>
      <p class="jumper-signal" data-jumper-signal aria-live="polite">I segnali Jumper illumineranno il cielo.</p>
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
  const jumperSignal = container.querySelector<HTMLElement>('[data-jumper-signal]')!;
  const baseCount = container.querySelector<HTMLElement>('[data-base-count]')!;
  const jumperCount = container.querySelector<HTMLElement>('[data-jumper-count]')!;
  let fireworks: FireworksScene | undefined;
  try { fireworks = new FireworksScene(canvas); } catch { canvas.dataset.renderer = 'unavailable'; }

  const render = (snapshot: Snapshot) => {
    const playing = snapshot.state === 'PLAYING';
    const paused = snapshot.state === 'PAUSED';
    const playable = Boolean(snapshot.scenario) && ['READY', 'STOPPED', 'PLAYING', 'PAUSED'].includes(snapshot.state);
    container.querySelector<HTMLElement>('.player-stage')!.dataset.state = snapshot.state;
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
  };

  const showJumper = (event: PlaybackEvent) => {
    const hash = [...event.jumperId].reduce((total, character) => total + character.charCodeAt(0), 0);
    fireworks?.burst((hash % 101) / 100);
    jumperSignal.textContent = `${event.jumperId} · nuovo segnale`;
  };

  const unsubscribeState = controller.subscribe(render);
  const unsubscribePlayback = controller.subscribePlayback(showJumper);
  toggle.addEventListener('click', () => {
    if (controller.snapshot.state === 'PLAYING' || controller.snapshot.state === 'PAUSED') void controller.togglePause();
    else void controller.start();
  });
  stop.addEventListener('click', () => controller.stop());

  return {
    destroy() {
      unsubscribeState();
      unsubscribePlayback();
      fireworks?.destroy();
      container.replaceChildren();
    },
  };
}
