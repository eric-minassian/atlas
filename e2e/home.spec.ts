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
  // From space: global layers draw; city-scale ones wait in the catalog until you zoom in. Found by
  // switch, since a layer's name can also be another layer's filter (Earthquakes in Disaster alerts).
  const inView = layers.getByRole('region', { name: 'In view' });
  await Promise.all(
    ['Satellites', 'Clouds', 'Weather radar'].map((name) =>
      expect(inView.getByRole('switch', { name, exact: true })).toBeVisible(),
    ),
  );
  const all = layers.getByRole('region', { name: 'All layers' });
  await all.getByRole('button', { name: /^Air/ }).click();
  const aircraft = all.getByRole('listitem').filter({ hasText: 'Aircraft' });
  await expect(aircraft.getByText('Zoom in')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a layer can be turned on and stays on after a reload', async ({ page }) => {
  await page.goto('/');
  const catalog = page.getByRole('region', { name: 'All layers' });
  // Categories remember whether they're open; this one starts closed.
  await catalog.getByRole('button', { name: /^Hazards/ }).click();
  const fires = catalog.getByRole('switch', { name: 'Fire detections' });
  await expect(fires).not.toBeChecked();
  await fires.click();
  await expect(fires).toBeChecked();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'All layers' }).getByRole('switch', { name: 'Fire detections' }),
  ).toBeChecked();
});

test('the base map switches to Photorealistic 3D and back', async ({ page }) => {
  await page.goto('/');
  const basemap = page.getByRole('group', { name: 'Base map' });
  // Only deployments with a Cesium ion token offer it.
  if ((await basemap.count()) === 0) return;
  await basemap.getByRole('radio', { name: 'Photorealistic 3D' }).click();
  await expect(basemap.getByRole('radio', { name: 'Photorealistic 3D' })).toBeChecked();
  await basemap.getByRole('radio', { name: 'Satellite' }).click();
  await expect(basemap.getByRole('radio', { name: 'Satellite' })).toBeChecked();
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
    'metars',
    'buoys',
    'airQuality',
    'disasters',
    'tsunamis',
    'weatherAlerts',
    'firePerimeters',
    'volcanoes',
    'aurora',
    'rivers',
  ]);
});
