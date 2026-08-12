import { expect, test, type Page } from '@playwright/test';
import { inspectDataUri, inspectEmbeddedAudio } from '../packages/core/src/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngDataUri = `data:image/png;base64,${pngBase64}`;
const pngBuffer = Buffer.from(pngBase64, 'base64');
const chime = join(process.cwd(), 'assets/source/default-chime.wav');

async function openBuilder(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('button', { name: 'Editor scenario' }).click();
  await expect(page.getByRole('heading', { name: 'Scenario editor' })).toBeVisible();
  await page.getByRole('button', { name: 'New' }).click();
}

async function prepareChime(page: Page) {
  await page.locator('input[data-source-file]').setInputFiles(chime);
  const prepare = page.getByRole('button', { name: 'Prepara audio' });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  const audio = page.locator('.crop-region audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.locator('canvas.waveform').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 !== 3 && value !== 0);
  })).toBe(true);
}

async function setCrop(page: Page, start: number, end: number) {
  const audio = page.locator('.crop-region audio');
  await audio.evaluate((element: HTMLAudioElement, time) => { element.currentTime = time; }, start);
  await page.getByRole('button', { name: 'Imposta inizio' }).click();
  await audio.evaluate((element: HTMLAudioElement, time) => { element.currentTime = time; }, end);
  await page.getByRole('button', { name: 'Imposta fine' }).click();
}

test('reuses one prepared source for two crops and materializes web output', async ({ page }) => {
  await openBuilder(page);
  await page.getByLabel('Scenario name').fill('Night walk');
  await page.getByRole('button', { name: 'Nuovo Jumper' }).click();
  await page.locator('input[data-jumper-image]').setInputFiles({ name: 'birds.png', mimeType: 'image/png', buffer: pngBuffer });
  await expect(page.locator('.jumper-image-control img')).toHaveAttribute('src', pngDataUri);
  await prepareChime(page);

  const audio = page.locator('.crop-region audio');
  const originalSource = await audio.getAttribute('src');
  await setCrop(page, 0.25, 1);
  await page.getByRole('button', { name: 'Aggiungi crop a jumper-1' }).click();
  await expect(page.locator('.destination-card.selected .assigned-source')).toHaveCount(1);
  await expect(audio).toHaveAttribute('src', originalSource!);
  await expect(page.getByLabel('Start (s)')).toHaveValue('');
  await expect(page.getByLabel('End (s)')).toHaveValue('');
  await expect(page.locator('canvas.waveform')).toBeVisible();

  await setCrop(page, 0.1, 0.5);
  await page.getByRole('button', { name: 'Aggiungi crop a jumper-1' }).click();
  await expect(page.locator('.destination-card.selected .assigned-source')).toHaveCount(2);
  await audio.evaluate((element: HTMLAudioElement) => { element.currentTime = 0.4; });

  await page.getByRole('button', { name: 'Finalizza e salva' }).click();
  await expect(page.getByRole('heading', { name: 'Finalizza scenario' })).toBeFocused();
  await expect(page.locator('[data-region="source"]')).toHaveCount(0);
  await expect(page.locator('.output-row strong')).toHaveText(['jumper-1 · crop 1', 'jumper-1 · crop 2']);
  await expect(page.locator('.output-readonly')).toHaveText(['Embedded', 'Embedded']);

  await page.getByRole('button', { name: 'Indietro' }).click();
  await expect(page.getByLabel('Scenario name')).toHaveValue('Night walk');
  await expect(page.locator('.destination-card.selected .assigned-source')).toHaveCount(2);
  await expect(audio).toHaveAttribute('src', originalSource!);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(0.4, 2);
  await expect(page.getByRole('button', { name: 'Finalizza e salva' })).toBeFocused();

  await page.getByRole('button', { name: 'Finalizza e salva' }).click();
  await page.getByRole('button', { name: 'Incorpora tutti' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Crea e salva JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('night-walk.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  const document = JSON.parse(await readFile(path!, 'utf8')) as { jumpers: Array<{ image?: string; sources: Array<{ location: string; clip?: unknown }> }> };
  expect(document.jumpers).toHaveLength(1);
  expect(document.jumpers[0]!.sources).toHaveLength(2);
  expect(document.jumpers[0]!.image).toBe(pngDataUri);
  const sources = document.jumpers[0]!.sources;
  expect(sources[0]!.location).not.toBe(sources[1]!.location);
  expect(sources.every((source) => !Object.hasOwn(source, 'clip'))).toBe(true);
  const durations = sources.map((source) => {
    const data = inspectDataUri(source.location);
    return inspectEmbeddedAudio(data.bytes, data.mime).durationSeconds;
  });
  expect(durations[0]).toBeCloseTo(0.75, 1);
  expect(durations[1]).toBeCloseTo(0.4, 1);
});

test('routes crops to the selected destination and confirms Base replacement', async ({ page }) => {
  await openBuilder(page);
  await page.getByRole('button', { name: 'Nuovo Jumper' }).click();
  await page.getByRole('button', { name: 'Nuovo Jumper' }).click();
  await prepareChime(page);
  await setCrop(page, 0.25, 1);
  await page.getByRole('button', { name: 'Aggiungi crop a jumper-2' }).click();

  const jumperOne = page.locator('.destination-card').filter({ has: page.locator('input[value="jumper-1"]') });
  const jumperTwo = page.locator('.destination-card').filter({ has: page.locator('input[value="jumper-2"]') });
  await expect(jumperOne.locator('.assigned-source')).toHaveCount(0);
  await expect(jumperTwo.locator('.assigned-source')).toHaveCount(1);

  await page.getByRole('button', { name: 'Nuova Base' }).click();
  await setCrop(page, 0.1, 0.5);
  await page.getByRole('button', { name: 'Aggiungi crop a base-1' }).click();
  const base = page.locator('.destination-card').filter({ has: page.locator('input[value="base-1"]') });
  await expect(base.locator('.assigned-source strong')).toHaveText('crop 0.10–0.50 s');

  await setCrop(page, 0.2, 0.6);
  await page.getByRole('button', { name: 'Aggiungi crop a base-1' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Annulla' })).toBeFocused();
  await page.getByRole('button', { name: 'Annulla' }).click();
  await expect(base.locator('.assigned-source strong')).toHaveText('crop 0.10–0.50 s');

  await page.getByRole('button', { name: 'Aggiungi crop a base-1' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Aggiungi crop a base-1' })).toBeFocused();
  await expect(base.locator('.assigned-source strong')).toHaveText('crop 0.10–0.50 s');

  await page.getByRole('button', { name: 'Aggiungi crop a base-1' }).click();
  await page.getByRole('button', { name: 'Sostituisci' }).click();
  await expect(base.locator('.assigned-source strong')).toHaveText('crop 0.20–0.60 s');
  await expect(page.getByLabel('Start (s)')).toHaveValue('');
  await expect(page.getByLabel('End (s)')).toHaveValue('');
});

test('keeps desktop finalization choices after a canceled save', async ({ page }) => {
  const embedded = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  await page.addInitScript((location) => {
    (window as typeof window & { ambiental: unknown }).ambiental = {
      loadInitialScenario: async () => ({ version: 1, name: 'Cancel smoke', bases: [{ id: 'base-1', source: { location } }], jumpers: [] }),
      chooseScenario: async () => ({}),
      resolveSource: async () => ({}),
      quit: async () => {},
      chooseLocalAudio: async () => null,
      prepareAudio: async () => ({ token: 'preview', url: location, durationSeconds: 1 }),
      releasePreparedAudio: async () => {},
      saveScenario: async () => ({ canceled: true }),
      onSaveProgress: () => () => {},
    };
  }, embedded);
  await page.goto('/');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('button', { name: 'Editor scenario' }).click();
  await page.getByRole('button', { name: 'Finalizza e salva' }).click();
  await page.getByRole('button', { name: 'Crea WAV per tutti' }).click();
  await expect(page.locator('.output-row select')).toHaveValue('local-path');
  await page.getByRole('button', { name: 'Crea e salva JSON' }).click();
  await expect(page.getByRole('heading', { name: 'Finalizza scenario' })).toBeVisible();
  await expect(page.locator('.output-row select')).toHaveValue('local-path');
  await expect(page.locator('.preset-status')).toContainText('annullato');
  await expect(page.locator('.materialization-overlay')).toHaveCount(0);
});

test('keeps independent desktop scroll regions and stacks cleanly on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBuilder(page);
  for (let index = 0; index < 8; index += 1) await page.getByRole('button', { name: 'Nuovo Jumper' }).click();
  const desktop = await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>('.source-region')!;
    const manager = document.querySelector<HTMLElement>('.manager-region')!;
    const crop = document.querySelector<HTMLElement>('.crop-region')!;
    const sourceBox = source.getBoundingClientRect();
    const managerBox = manager.getBoundingClientRect();
    const cropBox = crop.getBoundingClientRect();
    const sourceTop = sourceBox.top;
    manager.scrollTop = 120;
    return {
      sourceLeft: sourceBox.left < managerBox.left,
      cropBelow: cropBox.top >= Math.max(sourceBox.bottom, managerBox.bottom) - 1,
      cropSpans: cropBox.left <= sourceBox.left + 1 && cropBox.right >= managerBox.right - 1,
      sourceOverflow: getComputedStyle(source).overflowY,
      managerOverflow: getComputedStyle(manager).overflowY,
      managerScrollable: manager.scrollHeight > manager.clientHeight && manager.scrollTop > 0,
      sourceStationary: source.getBoundingClientRect().top === sourceTop,
    };
  });
  expect(desktop).toEqual({ sourceLeft: true, cropBelow: true, cropSpans: true, sourceOverflow: 'auto', managerOverflow: 'auto', managerScrollable: true, sourceStationary: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>('.source-region')!.getBoundingClientRect();
    const manager = document.querySelector<HTMLElement>('.manager-region')!.getBoundingClientRect();
    const crop = document.querySelector<HTMLElement>('.crop-region')!.getBoundingClientRect();
    const targets = Array.from(document.querySelectorAll<HTMLElement>('button,select,input:not([type=radio]):not([type=checkbox]),textarea,.destination-title label')).filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return {
      ordered: source.top < manager.top && manager.top < crop.top,
      minTarget: Math.min(...targets.map((element) => element.getBoundingClientRect().height)),
      noHorizontalOverflow: document.documentElement.scrollWidth === document.documentElement.clientWidth,
    };
  });
  expect(mobile.ordered).toBe(true);
  expect(mobile.minTarget).toBeGreaterThanOrEqual(44);
  expect(mobile.noHorizontalOverflow).toBe(true);
});

test('closes drawer with Escape at narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Apri menu' });
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#app-menu')).toBeHidden();
  await expect(menu).toBeFocused();
});
