# Ambientalheehee

Console audio ambientale per macOS e browser statico. Uno scenario JSON definisce **basi** in loop e **jumper** programmati; il dominio TypeScript, lo scheduler e il motore `HTMLMediaElement` sono condivisi dal renderer web e desktop.

> **Stato del repository:** workspace iniziale funzionante con validazione degli scenari, audio inline WAV/MP3, renderer Vite, provider desktop e workflow CI. L'interfaccia web è il percorso verificato end-to-end. Il packaging Electron/macOS è predisposto, ma richiede il completamento della configurazione del bundle Electron prima di essere usato come release firmata.

## Indice

- [Prerequisiti](#prerequisiti)
- [Installazione](#installazione)
- [Comandi](#comandi)
- [Uso web](#uso-web)
- [Scenari](#scenari)
- [Audio Data URI](#audio-data-uri)
- [Desktop macOS e CLI](#desktop-macos-e-cli)
- [Build e distribuzione](#build-e-distribuzione)
- [Test e verifica](#test-e-verifica)
- [Architettura](#architettura)
- [Risoluzione problemi](#risoluzione-problemi)

## Prerequisiti

### Obbligatori

| Strumento | Versione richiesta | Scopo |
| --- | --- | --- |
| macOS | arm64 per il packaging desktop | target della prima release |
| Node.js | `22.x` | runtime e build |
| npm | `>=10` | workspace e lockfile |

Verifica:

```sh
node --version
npm --version
```

Il progetto usa un unico `package-lock.json` nella radice. Eseguire sempre `npm ci` dalla radice, mai dalle singole workspace.

### Condizionali: fonti locali e YouTube desktop

L'audio **inline** Data URI non richiede altri binari. Le fonti locali e YouTube della versione desktop richiedono invece:

```sh
brew install ffmpeg yt-dlp deno
```

Il comando installa `ffmpeg` e `ffprobe`. Verifica:

```sh
ffprobe --version
yt-dlp --version
ffmpeg --version
deno --version
```

Il desktop cerca i tool, in quest'ordine: variabili d'ambiente, `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`.

| Tool | Necessario per |
| --- | --- |
| `ffprobe` | file locali e YouTube |
| `yt-dlp` | YouTube |
| `ffmpeg` | transcodifica YouTube |
| Deno | prerequisito dichiarato per YouTube |

Override supportati:

```sh
export AMBIENTALHEEHEE_FFPROBE=/percorso/a/ffprobe
export AMBIENTALHEEHEE_YTDLP=/percorso/a/yt-dlp
export AMBIENTALHEEHEE_FFMPEG=/percorso/a/ffmpeg
```

I binari esterni non vengono inclusi nel pacchetto, né installati o aggiornati dall'applicazione.

## Installazione

```sh
git clone <URL-del-repository> ambientalheehee
cd ambientalheehee
npm ci
npm run generate:default
```

`generate:default` crea deterministicamente:

- `assets/source/default-white-noise.wav` — rumore bianco mono PCM16/44.1 kHz, 5 secondi;
- `assets/source/default-chime.wav` — chime mono PCM16/44.1 kHz, 1,5 secondi;
- `packages/core/assets/default-scenario.json` — scenario predefinito con Data URI.

Non modificare manualmente questi output. Verifica assenza di drift:

```sh
npm run generate:default:check
```

## Comandi

| Comando | Descrizione |
| --- | --- |
| `npm run dev:web` | avvia Vite per il renderer web |
| `npm run dev:desktop` | tenta l'avvio Electron in sviluppo |
| `npm run cli -- [SCENARIO]` | entry point CLI workspace |
| `npm test` | test Vitest |
| `npm run test:e2e` | entry point Playwright; richiede test/configurazione Playwright |
| `npm run build` | controlla gli asset e compila tutte le workspace |
| `npm run build:pages` | genera `apps/client/dist/web` |
| `npm run package:mac:unsigned` | package macOS arm64 non firmato |
| `npm run make:mac:release` | entry point per release macOS |
| `npm run generate:default` | rigenera WAV e scenario predefiniti |
| `npm run generate:default:check` | fallisce se gli artefatti generati differiscono |

## Uso web

Avvia il client:

```sh
npm run dev:web
```

Apri l'URL indicato da Vite. Il browser non effettua autoplay: premere **Start** per autorizzare gli elementi audio. I controlli disponibili sono Start, Pause/Resume, Stop e rate `0.5`, `0.75`, `1`, `1.25`, `1.5`, `2`.

Il campo **Scenario JSON** carica un file locale nel browser. La build web accetta soltanto audio inline Data URI WAV/MP3: rifiuta file path, `file://`, URL HTTP(S), YouTube e fetch remoto.

### GitHub Pages

```sh
npm run build:pages
```

L'output pubblicabile è esclusivamente:

```text
apps/client/dist/web/
```

Il workflow `.github/workflows/pages.yml` esegue `npm ci`, test, build Pages e rifiuta artefatti oltre 25 MiB prima del deploy. La base Vite deriva da `GITHUB_REPOSITORY`, quindi il sito è compatibile con `https://<owner>.github.io/<repo>/`.

## Scenari

Un file scenario è JSON strict con versione `1`:

```json
{
  "version": 1,
  "name": "Forest",
  "audio_root": "sounds",
  "bases": [
    {
      "id": "rain",
      "source": {
        "location": "data:audio/wav;base64,...",
        "clip": {"start_seconds": 10, "end_seconds": 70},
        "volume": {"min": 0.35, "max": 0.35}
      }
    }
  ],
  "jumpers": [
    {
      "id": "bird",
      "sources": [{
        "location": "data:audio/mpeg;base64,...",
        "clip": {"start_seconds": 4, "end_seconds": 7},
        "volume": {"min": 0.25, "max": 0.55}
      }],
      "schedule": {
        "algorithm": "increasing_gaussian",
        "mean_interval_seconds": 30,
        "stddev_seconds": 8
      }
    }
  ]
}
```

### Regole di validazione

- Ogni oggetto è strict: chiavi sconosciute falliscono.
- `version` deve essere `1`.
- `name`, ID, path e URL normali vengono trim-mati e non possono essere vuoti. Le Data URI non vengono alterate.
- Deve esistere almeno una base o un jumper; gli ID sono globalmente univoci.
- Un jumper ha almeno una sorgente.
- `clip` è opzionale; quando presente richiede `0 <= start_seconds < end_seconds`. La durata reale è verificata durante hydration.
- `volume` è opzionale e diventa `{ "min": 1, "max": 1 }`; richiede `0 <= min <= max <= 1`.
- L'unico algoritmo iniziale è `increasing_gaussian`; richiede `mean_interval_seconds > 0` e `0 <= stddev_seconds < mean_interval_seconds`.
- La dimensione del JSON è limitata a 90 MiB.

### Semantica di playback

- Più basi e jumper possono sovrapporsi.
- Una base senza clip usa il loop nativo; una base con clip ricomincia dal punto iniziale.
- Un jumper sceglie una sorgente e un volume nel range configurato; il pool globale è limitato a 32 voci.
- I deadline del jumper sono assoluti e start-to-start: durata, rate e saturazione del pool non modificano la schedulazione.
- Pause congela audio e deadline; Resume riprende dagli intervalli residui senza burst.
- Il rate modifica playback rate e pitch; non modifica le deadline.

## Audio Data URI

Sono accettate **esattamente** queste forme, senza parametri o whitespace:

```text
data:audio/wav;base64,<base64-canonico>
data:audio/mpeg;base64,<base64-canonico>
```

Limiti:

| Limite | Valore |
| --- | --- |
| sorgente embedded | 16 MiB binari |
| scenario embedded complessivo | 64 MiB previsto dal contratto di release |
| JSON scenario | 90 MiB |

Il parser verifica Base64 canonico e firma/formato: WAV deve essere RIFF/WAVE PCM supportato; MP3 deve contenere frame MPEG Layer III coerenti. Un MIME che non coincide con la firma del contenuto viene rifiutato.

Per convertire un file in Data URI:

```sh
base64 -i suono.wav | tr -d '\n' | sed 's|^|data:audio/wav;base64,|'
```

Per MP3 sostituire `audio/wav` con `audio/mpeg`.

## Desktop macOS e CLI

La parte Electron usa un renderer isolato (`nodeIntegration: false`, `contextIsolation: true`, sandbox) e protocollo `ambiental:`:

- `ambiental://bundle/` serve il bundle del client;
- `ambiental://media/<token>` espone soltanto una sorgente concessa dal processo main;
- le risposte media dichiarano supporto per un Range singolo (`200`, `206`, `416`); multi-range viene rifiutato;
- il renderer non passa path o argv arbitrari al main; richiede fonti per indice di scenario;
- tray: Open, Hide, Quit.

Il launcher distribuibile è `bin/ambientalheehee`:

```sh
ambientalheehee [SCENARIO] [-d|--detach] [--log-level DEBUG|INFO|WARNING|ERROR]
```

Cerca `Ambientalheehee.app` vicino al launcher, poi in `/Applications`. Se non la trova esce con codice `2`.

> Il parser CLI, il detach e la release firmata/notarizzata sono contratti pianificati; non presentarli come disponibili finché il packaging Electron non è completato e verificato su una `.app` reale.

### Fonti desktop

| Tipo | Policy |
| --- | --- |
| Data URI WAV/MP3 | supportata senza tool esterni |
| file locale WAV/MP3 | richiede `ffprobe` |
| URL YouTube HTTPS singolo | richiede `yt-dlp`, `ffmpeg`, `ffprobe`, Deno |

YouTube accetta URL di singoli video `youtube.com/watch?v=`, `youtube.com/shorts/`, `youtube.com/embed/` e `youtu.be/`; playlist e URL non riconosciuti vengono rifiutati. L'app non aggira autenticazione, DRM, geoblocking o termini del servizio.

## Build e distribuzione

```sh
npm run build
npm run build:pages
npm run package:mac:unsigned
```

`package:mac:unsigned` è destinato al QA locale. Una release macOS richiede Developer ID, hardened runtime, notarizzazione e stapling; le credenziali devono restare fuori dal repository.

La workflow `.github/workflows/macos.yml` verifica su macOS arm64: installazione, test, build e package non firmato. La workflow Pages è separata e pubblica solo la directory web statica.

## Test e verifica

Verifica completa attuale:

```sh
npm run generate:default:check
npm test
npm run build
npm run build:pages
```

I test correnti coprono il contratto dello schema: scenario web inline valido, rifiuto di path locale nel web, Data URI non canonica e schedule con deviazione zero.

Playwright è incluso nelle dipendenze. Quando verranno aggiunti test E2E:

```sh
npx playwright install
npm run test:e2e
```

## Architettura

```text
packages/core
  schema / policy / inspect audio / resolver registry
  controller / scheduler / HTMLMediaElement engine
          │
          ├── apps/client   Vite: build web e desktop dallo stesso renderer
          └── apps/desktop  Electron main + preload + provider locali/YouTube
```

| Area | Responsabilità |
| --- | --- |
| `packages/core` | codice browser-safe condiviso; non deve importare Electron, `node:*`, filesystem o processi |
| `apps/client` | renderer UI Vite, runtime web inline-only |
| `apps/desktop` | Electron main/preload, tray, protocollo, provider e tool di sistema |
| `assets/source` | WAV generati deterministicamente |
| `.github/workflows` | deploy Pages e verifica macOS |

## Risoluzione problemi

### `npm ci` fallisce

Usare Node 22 e npm 10 dalla radice:

```sh
node --version
npm --version
rm -rf node_modules
npm ci
```

Non rigenerare `package-lock.json` senza una modifica intenzionale delle dipendenze.

### Scenario rifiutato nel browser

Controllare che tutte le sorgenti siano Data URI identiche al formato ammesso e che non esistano chiavi JSON sconosciute. Il browser non accetta path locali né YouTube.

### Nessun audio dopo Start

Il gesto **Start** è obbligatorio per la policy autoplay. Verificare che il volume del sistema/browser non sia in mute e che la Data URI rappresenti WAV PCM o MP3 validi e seekable.

### Una fonte desktop locale/YouTube fallisce

Verificare i tool richiesti e la loro visibilità dal processo Electron:

```sh
command -v ffprobe
command -v yt-dlp
command -v ffmpeg
command -v deno
```

Se un tool è installato fuori dal `PATH`, impostare il relativo override `AMBIENTALHEEHEE_*` prima di avviare l'app.

### Il launcher non trova l'app

Copiare `bin/ambientalheehee` in una directory del `PATH` solo dopo aver copiato `Ambientalheehee.app` accanto ad esso oppure in `/Applications`.

## Licenza

Vedi [LICENSE](LICENSE).
