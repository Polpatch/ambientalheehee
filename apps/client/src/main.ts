import defaultScenario from '@ambiental/core/default-scenario' with { type: 'json' };
import {
  ApplicationController,
  EmbeddedDataResolver,
  MediaElementAudioEngine,
  parseScenario,
  SourceResolverRegistry,
  type AudioRate,
  type AudioSourceResolver,
  type RuntimePolicy,
  type Source,
} from '@ambiental/core';
import { createRuntime, type PreparedAudio } from './runtime.js';
import { mountScenarioBuilder, type ScenarioBuilderHandle } from './scenario-builder/view.js';
import { mountPlayerView, type PlayerViewHandle } from './player/view.js';
import './style.css';

class DesktopAudioResolver implements AudioSourceResolver {
  constructor(private readonly resolveDesktop: (source: Source) => Promise<PreparedAudio>) {}
  supports(_source: Source, policy: RuntimePolicy) { return policy === 'desktop'; }
  async resolve(source: Source) {
    const result = await this.resolveDesktop(source);
    return { id: source.location, url: result.url, mime: 'audio/mpeg', durationSeconds: result.durationSeconds, release: result.release };
  }
}

const runtime = createRuntime(defaultScenario);
const desktopResolvers = runtime.prepareAudio ? [new DesktopAudioResolver(runtime.prepareAudio.bind(runtime))] : [];
const controller = new ApplicationController(
  runtime.kind,
  new SourceResolverRegistry([new EmbeddedDataResolver(), ...desktopResolvers]),
  new MediaElementAudioEngine(),
);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <button id="menu-toggle" class="menu-toggle" aria-label="Apri menu" aria-controls="app-menu" aria-expanded="false"><span></span><span></span><span></span></button>
  <aside id="app-menu" class="drawer" aria-label="Menu applicazione" hidden>
    <div class="drawer-head"><p class="eyebrow">AMBIENTAL</p><h2>Control room</h2></div>
    <nav class="drawer-nav" aria-label="Viste">
      <button type="button" data-view="player">Player</button>
      <button type="button" data-view="builder">Editor scenario</button>
    </nav>
    <section class="drawer-section" aria-labelledby="scenario-loader-title">
      <h3 id="scenario-loader-title">Scenario in riproduzione</h3>
      <label class="scenario-loader">Carica JSON<input data-scenario-file type="file" accept="application/json"></label>
      <p class="drawer-status" data-drawer-status aria-live="polite"></p>
    </section>
    <section class="drawer-section" aria-labelledby="playback-settings-title">
      <h3 id="playback-settings-title">Velocità</h3>
      <label>Playback rate<select data-playback-rate><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
    </section>
  </aside>
  <div id="menu-backdrop" class="backdrop" hidden></div>
  <main id="main-view"></main>`;

const app = document.querySelector<HTMLElement>('#main-view')!;
const menu = document.querySelector<HTMLElement>('#app-menu')!;
const toggle = document.querySelector<HTMLButtonElement>('#menu-toggle')!;
const backdrop = document.querySelector<HTMLElement>('#menu-backdrop')!;
const drawerStatus = menu.querySelector<HTMLElement>('[data-drawer-status]')!;
let view: 'player' | 'builder' = 'player';
let builder: ScenarioBuilderHandle | undefined;
let player: PlayerViewHandle | undefined;
let currentDocument: unknown = defaultScenario;

function closeMenu(returnFocus = true) {
  menu.hidden = true;
  backdrop.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (returnFocus) toggle.focus();
}

function openMenu() {
  menu.hidden = false;
  backdrop.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLButtonElement>('[data-view]')?.focus();
}

function renderPlayer() {
  builder?.destroy();
  builder = undefined;
  player?.destroy();
  app.dataset.view = 'player';
  app.innerHTML = '<div class="player-host"></div>';
  player = mountPlayerView(app.querySelector<HTMLElement>('.player-host')!, controller);
}

function renderBuilder() {
  player?.destroy();
  player = undefined;
  controller.stop();
  builder?.destroy();
  app.dataset.view = 'builder';
  app.innerHTML = '<section class="builder-host"></section>';
  builder = mountScenarioBuilder(app.querySelector<HTMLElement>('.builder-host')!, { runtime, initialDocument: currentDocument });
}

function selectView(next: typeof view) {
  view = next;
  closeMenu(false);
  if (view === 'builder') renderBuilder(); else renderPlayer();
}

async function loadScenarioFile(file: File) {
  try {
    const document = JSON.parse(await file.text());
    const scenario = parseScenario(JSON.stringify(document), runtime.kind);
    await controller.load(scenario);
    currentDocument = document;
    drawerStatus.textContent = `Caricato · ${scenario.name}`;
    if (view !== 'player') { view = 'player'; renderPlayer(); }
    closeMenu();
  } catch (error) {
    drawerStatus.textContent = error instanceof Error ? error.message : 'Scenario non valido';
  }
}

toggle.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
backdrop.addEventListener('click', () => closeMenu());
menu.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement && target.dataset.view) selectView(target.dataset.view as typeof view);
});
menu.querySelector<HTMLInputElement>('[data-scenario-file]')!.addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void loadScenarioFile(file);
});
menu.querySelector<HTMLSelectElement>('[data-playback-rate]')!.addEventListener('change', (event) => {
  void controller.setRate(Number((event.target as HTMLSelectElement).value) as AudioRate);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) { closeMenu(); return; }
  if (event.key !== 'Tab' || menu.hidden) return;
  const controls = Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])'));
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
window.addEventListener('beforeunload', () => { void controller.shutdown(); });

renderPlayer();
void runtime.loadInitialScenario().then(async (document) => {
  currentDocument = document;
  await controller.load(parseScenario(JSON.stringify(document), runtime.kind));
}).catch((error: unknown) => { drawerStatus.textContent = error instanceof Error ? error.message : 'Impossibile caricare lo scenario iniziale'; });
