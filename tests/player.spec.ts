import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const chimePath = join(process.cwd(), 'assets/source/default-chime.wav');

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

  await page.getByRole('button', { name: 'Riproduci' }).click();
  await expect(page.getByRole('button', { name: 'Pausa' })).toBeVisible();
  await expect.poll(() => page.locator('.fireworks-canvas').getAttribute('data-bursts')).toMatch(/^[3-9]|[1-9]\d+$/);
  await expect(page.locator('[data-jumper-signal]')).toContainText(/birds|wind/);

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

  await page.getByRole('button', { name: 'Riproduci' }).click();
  await expect(page.getByRole('button', { name: 'Pausa' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.player-stage')!.getBoundingClientRect();
    const canvas = document.querySelector<HTMLCanvasElement>('.fireworks-canvas')!.getBoundingClientRect();
    const play = document.querySelector<HTMLElement>('.transport-main')!.getBoundingClientRect();
    const stop = document.querySelector<HTMLElement>('.transport-stop')!.getBoundingClientRect();
    const menuButton = document.querySelector<HTMLElement>('.menu-toggle')!.getBoundingClientRect();
    return {
      fullScreen: stage.width === innerWidth && stage.height === innerHeight && canvas.width === stage.width && canvas.height === stage.height,
      playCentered: Math.abs(play.x + play.width / 2 - innerWidth / 2) < 40,
      stopRightAndSmaller: stop.x > play.x + play.width / 2 && stop.width < play.width,
      menuTopLeft: menuButton.left < 32 && menuButton.top < 32,
      overflow: document.documentElement.scrollWidth === document.documentElement.clientWidth,
    };
  });
  expect(layout).toEqual({ fullScreen: true, playCentered: true, stopRightAndSmaller: true, menuTopLeft: true, overflow: true });
});
