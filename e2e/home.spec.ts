import { expect, test } from '@playwright/test';

// CI runs this suite against previews and, after each deploy, production.
// Tests only read. A fresh stage may not have every feed's first snapshot yet,
// so nothing here waits for a particular feed.

test('the globe renders with the layer panel and live freshness', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const catalog = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/catalog');
  await page.goto('/');
  expect((await catalog).ok()).toBe(true);

  await expect(page.getByRole('heading', { name: 'Atlas' })).toBeVisible();
  await expect(page.getByTestId('globe').locator('canvas')).toBeVisible();
  const layers = page.getByRole('complementary', { name: 'Layers' });
  await Promise.all(
    ['Aircraft', 'Satellites', 'Earthquakes', 'Clouds', 'Weather radar'].map((name) =>
      expect(layers.getByText(name, { exact: true })).toBeVisible(),
    ),
  );
  expect(errors).toEqual([]);
});

test('a layer can be turned on and stays on after a reload', async ({ page }) => {
  await page.goto('/');
  const fires = page.getByRole('switch', { name: 'Fire detections' });
  await expect(fires).not.toBeChecked();
  await fires.click();
  await expect(fires).toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Fire detections' })).toBeChecked();
});

test('search opens from the keyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('globe').locator('canvas')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByPlaceholder('Callsign, satellite name or NORAD id, place…')).toBeFocused();
});

test('the API describes every feed', async ({ request }) => {
  const res = await request.get('/api/catalog');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { feeds: Array<{ id: string }> };
  expect(body.feeds.map((f) => f.id)).toEqual([
    'satellites',
    'earthquakes',
    'fires',
    'events',
    'radar',
    'ships',
    'airports',
    'transitFeeds',
    'bikeSystems',
    'lightning',
  ]);
});
