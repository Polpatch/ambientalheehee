import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const chimePath = join(process.cwd(), 'assets/source/default-chime.wav');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function fastScenario() {
  const bytes = await readFile(chimePath);
  const location = `data:audio/wav;base64,${bytes.toString('base64')}`;
  return {
    version: 1,
    name: 'Firework field',
    bases: [{ id: 'night-bed', source: { location } }],
    jumpers: [
      { id: 'birds', sources: [{ location }, { location, clip: { start_seconds: 0.1, end_seconds: 0.4 } }], schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: 0.08, stddev_seconds: 0 } },
      { id: 'wind', sources: [{ location, clip: { start_seconds: 0.2, end_seconds: 0.5 } }], schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: 0.11, stddev_seconds: 0 } },
    ],
  };
}

async function loadScenario(page: Page, scenario: object, name: string) {
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.locator('[data-scenario-file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(scenario)) });
  await expect(page.locator('#app-menu')).toBeHidden();
}

test('loads scenarios from the drawer and visualizes repeated Jumper playback', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('.player-stage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Riproduci' })).toBeEnabled();

  const menu = page.getByRole('button', { name: 'Apri menu' });
  await menu.click();
  await expect(page.locator('[data-scenario-file]')).toBeVisible();
  await page.locator('[data-scenario-file]').setInputFiles({
    name: 'firework-field.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(await fastScenario())),
  });
  await expect(page.locator('#app-menu')).toBeHidden();
  await expect(page.locator('[data-player-scenario]')).toHaveText('Firework field');
  await expect(page.locator('[data-base-count]')).toHaveText('1 Base');
  await expect(page.locator('[data-jumper-count]')).toHaveText('2 Jumper');
  const jumperControls = page.locator('#jumper-live-panel');
  const jumperButton = page.getByRole('button', { name: '2 Jumper' });
  await jumperButton.click();
  await expect(jumperButton).toHaveAttribute('aria-expanded', 'true');
  await expect(jumperControls).toBeVisible();
  await expect(jumperControls.locator('.jumper-live-card')).toHaveCount(2);
  await expect(jumperControls).toContainText('birds');
  await expect(jumperControls).toContainText('Intervallo programmato');
  await expect(jumperControls).toContainText('Deviazione');
  await expect(jumperControls).toContainText('Le variazioni sono temporanee');
  const birdsParameter = jumperControls.locator('[data-jumper-parameter="birds"]');
  const birdsSlider = jumperControls.locator('[data-jumper-schedule-value="birds"]');
  await expect(birdsParameter).toHaveValue('mean_interval_seconds');
  await expect(birdsSlider).toHaveValue('0.08');
  await birdsParameter.selectOption('stddev_seconds');
  await expect(birdsSlider).toHaveAttribute('aria-label', 'Deviazione temporanea per birds');
  await expect(birdsSlider).toHaveValue('0');
  await birdsSlider.evaluate((input: HTMLInputElement) => {
    input.value = '0.02';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(birdsSlider).toHaveAttribute('aria-valuetext', '0.02 secondi');
  await expect(birdsSlider.locator('xpath=..').locator('output')).toHaveText('0.02 s');
  await birdsParameter.selectOption('mean_interval_seconds');
  await birdsSlider.evaluate((input: HTMLInputElement) => {
    input.value = '0.2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(birdsSlider).toHaveAttribute('aria-valuetext', '0.20 secondi');
  await page.keyboard.press('Escape');
  await expect(jumperControls).toBeHidden();
  await expect(jumperButton).toBeFocused();

  await page.getByRole('button', { name: 'Riproduci' }).click();
  await expect(page.getByRole('button', { name: 'Pausa' })).toBeVisible();
  await expect.poll(() => page.locator('.fireworks-canvas').getAttribute('data-bursts')).toMatch(/^[3-9]|[1-9]\d+$/);
  const origins = (await page.locator('.fireworks-canvas').getAttribute('data-burst-origins'))!.split(',');
  expect(new Set(origins).size).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Pausa' }).click();
  await expect(page.getByRole('button', { name: 'Riprendi' })).toBeVisible();
  const pausedBursts = await page.locator('.fireworks-canvas').getAttribute('data-bursts');
  await page.waitForTimeout(350);
  await expect(page.locator('.fireworks-canvas')).toHaveAttribute('data-bursts', pausedBursts!);

  await page.getByRole('button', { name: 'Riprendi' }).click();
  await expect.poll(async () => Number(await page.locator('.fireworks-canvas').getAttribute('data-bursts'))).toBeGreaterThan(Number(pausedBursts));
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('[data-player-state]')).toHaveText('Riproduzione arrestata');
  await expect(page.getByRole('button', { name: 'Riproduci' })).toBeEnabled();
  await expect(page.getByText('Night signal', { exact: true })).toHaveCount(0);
  await expect(page.getByText('AMBIENTAL / LIVE FIELD', { exact: true })).toHaveCount(0);
  await expect(page.getByText('I segnali Jumper illumineranno il cielo.', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Riproduci' }).click();
  await expect(page.getByRole('button', { name: 'Pausa' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.player-stage')!.getBoundingClientRect();
    const canvas = document.querySelector<HTMLCanvasElement>('.fireworks-canvas')!.getBoundingClientRect();
    const play = document.querySelector<HTMLElement>('.transport-main')!.getBoundingClientRect();
    const stop = document.querySelector<HTMLElement>('.transport-stop')!.getBoundingClientRect();
    const title = document.querySelector<HTMLElement>('[data-player-scenario]')!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>('[data-player-state]')!;
    const menuButton = document.querySelector<HTMLElement>('.menu-toggle')!.getBoundingClientRect();
    return {
      fullScreen: stage.width === innerWidth && stage.height === innerHeight && canvas.width === stage.width && canvas.height === stage.height,
      playCentered: Math.abs(play.x + play.width / 2 - innerWidth / 2) < 40,
      stopRightAndSmaller: stop.x > play.x + play.width / 2 && stop.width < play.width,
      menuTopLeft: menuButton.left < 32 && menuButton.top < 32,
      titleAboveControls: title.left <= 32 && title.bottom < play.top,
      stateAboveTitle: status.getBoundingClientRect().bottom < title.top,
      titleLargerThanState: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('[data-player-scenario]')!).fontSize) > Number.parseFloat(getComputedStyle(status).fontSize) * 4,
      stateFontSize: getComputedStyle(status).fontSize,
      overflow: document.documentElement.scrollWidth === document.documentElement.clientWidth,
    };
  });
  expect(layout).toEqual({ fullScreen: true, playCentered: true, stopRightAndSmaller: true, menuTopLeft: true, titleAboveControls: true, stateAboveTitle: true, titleLargerThanState: true, stateFontSize: '11.25px', overflow: true });
});

test('crossfades a Jumper image without launching a firework', async ({ page }) => {
  const scenario = await fastScenario();
  const imageOnly = { ...scenario, name: 'Image field', bases: [], jumpers: [{ ...scenario.jumpers[0]!, image: png, sources: [scenario.jumpers[0]!.sources[1]!], schedule: { ...scenario.jumpers[0]!.schedule, mean_interval_seconds: 0.8 } }] };
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Riproduci' })).toBeEnabled();
  await loadScenario(page, imageOnly, 'image-field.json');
  await expect(page.locator('[data-player-scenario]')).toHaveText('Image field');
  await expect(page.locator('.jumper-image-stage')).toHaveAttribute('data-preloaded', '1');
  await page.getByRole('button', { name: 'Riproduci' }).click();
  await expect.poll(async () => Number(await page.locator('.jumper-image-stage').getAttribute('data-presentations'))).toBeGreaterThan(0);
  const visualStartedAt = Number(await page.locator('.jumper-image-stage').getAttribute('data-visual-started-at'));
  await expect(page.locator('.jumper-image-stage')).toHaveAttribute('data-phase', 'active');
  const audioStartedAt = Number(await page.locator('.jumper-image-stage').getAttribute('data-audio-started-at'));
  expect(audioStartedAt - visualStartedAt).toBeGreaterThanOrEqual(60);
  expect(audioStartedAt - visualStartedAt).toBeLessThan(180);
  await expect(page.locator('.jumper-image-stage')).toHaveAttribute('data-phase', 'exiting');
  const audioEndedAt = Number(await page.locator('.jumper-image-stage').getAttribute('data-audio-ended-at'));
  expect(audioEndedAt).toBeGreaterThan(audioStartedAt);
  await expect.poll(async () => Number(await page.locator('.jumper-image-stage').getAttribute('data-presentations'))).toBeGreaterThan(2);
  await expect(page.locator('.jumper-image-stage img')).toHaveAttribute('src', png);
  await expect(page.locator('.fireworks-canvas')).toHaveAttribute('data-bursts', '0');
  const presentation = await page.locator('.jumper-image-stage').evaluate((stage) => {
    const history = stage.dataset.placementHistory?.split(';') ?? [];
    const sizes = history.map((placement) => Number(placement.split(',')[2]));
    const stageBox = stage.getBoundingClientRect();
    const playerBox = document.querySelector<HTMLElement>('.player-stage')!.getBoundingClientRect();
    const imageStyle = getComputedStyle(stage.querySelector('img')!);
    return {
      distinctPlacements: new Set(history).size,
      distinctSizes: new Set(sizes).size,
      sizeRange: sizes.every((size) => size >= 16 && size <= 32),
      compact: stageBox.width <= playerBox.width * 0.34 && stageBox.height <= playerBox.height * 0.34,
      insideViewport: stageBox.left >= 0 && stageBox.top >= 0 && stageBox.right <= innerWidth && stageBox.bottom <= innerHeight,
      feathered: (imageStyle.maskImage.includes('radial-gradient') || imageStyle.webkitMaskImage.includes('radial-gradient')) && (imageStyle.maskImage.includes('55%') || imageStyle.webkitMaskImage.includes('55%')),
    };
  });
  expect(presentation.distinctPlacements).toBeGreaterThan(1);
  expect(presentation.distinctSizes).toBeGreaterThan(1);
  expect(presentation.sizeRange).toBe(true);
  expect(presentation).toMatchObject({ compact: true, insideViewport: true, feathered: true });
  await page.getByRole('button', { name: 'Stop' }).click();
});
