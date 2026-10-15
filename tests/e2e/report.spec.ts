import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Built by `npm run build` (drop mode, no embedded data).
const REPORT = pathToFileURL(fileURLToPath(new URL('../../dist/journey-change-log.html', import.meta.url))).href;
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

async function open(page: Page) {
  const requests: string[] = [], problems: string[] = [];
  page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', e => problems.push(e.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' }));
  await page.goto(REPORT);
  return { requests, problems };
}

test('own CSV → history first, launch count and edited-without-test count', async ({ page }) => {
  const { problems } = await open(page);
  await page.getByTestId('file-input').setInputFiles(fixture('own.csv'));
  await page.getByTestId('build-btn').click();
  await expect(page.locator('#p-history')).toBeVisible();
  await expect(page.getByTestId('lede')).toContainText(/\b34 запуск/);
  await page.locator('[data-tab="control"]').click();
  await expect(page.getByTestId('edited-count')).toHaveText('8');
  await expect(page.getByTestId('sandbox-alert')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('test campaigns are kept out of the headline until the user says otherwise', async ({ page }) => {
  const { problems } = await open(page);
  await page.getByTestId('file-input').setInputFiles([fixture('own.csv'), fixture('sandbox.csv')]);
  await page.getByTestId('build-btn').click();
  await expect(page.locator('[data-view="working"]')).toHaveText(/· 34$/);
  await expect(page.locator('[data-view="sandbox"]')).toHaveText(/· 2$/);
  await page.locator('[data-tab="control"]').click();
  await expect(page.getByTestId('sandbox-alert')).toContainText('UAT_test_journey');
  await expect(page.getByTestId('edited-count')).toHaveText('8');
  await page.locator('[data-tab="data"]').click();
  await page.getByLabel(/UAT_test_journey/).uncheck();
  await page.locator('[data-tab="control"]').click();
  await expect(page.getByTestId('edited-count')).toHaveText('10');
  await expect(page.getByTestId('sandbox-alert')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('a campaign marked as test by hand stays marked after switching BU', async ({ page }) => {
  const { problems } = await open(page);
  await page.getByTestId('file-input').setInputFiles([fixture('own.csv'), fixture('sandbox.csv')]);
  await page.getByLabel('BU sandbox.csv').fill('Lab');
  await page.getByTestId('build-btn').click();
  await page.locator('[data-tab="data"]').click();
  await page.getByTestId('sb-all').click();
  await page.getByLabel(/Welcome series/).check();
  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('[data-view="working"]')).toHaveText(/· 32$/);
  await expect(page.locator('[data-view="sandbox"]')).toHaveText(/· 4$/);
  await page.locator('#bu').selectOption('Lab');
  await expect(page.locator('[data-view="sandbox"]')).toHaveText(/· 2$/);
  await expect(page.locator('[data-view="working"]')).toHaveText(/· 0$/);
  await page.locator('#bu').selectOption('*');
  await expect(page.locator('[data-view="working"]')).toHaveText(/· 32$/);
  expect(problems).toEqual([]);
});

test('wrong file → named error instead of a blank page', async ({ page }) => {
  const { problems } = await open(page);
  await page.getByTestId('file-input').setInputFiles(fixture('setup-audit-trail.csv'));
  await page.getByTestId('build-btn').click();
  await expect(page.getByTestId('error')).toHaveAttribute('data-code', 'WRONG_FILE');
  await expect(page.getByTestId('lede')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('zero network requests and no CSP violations across all tabs, both languages', async ({ page }) => {
  const { requests, problems } = await open(page);
  await page.getByTestId('sample-btn').click();
  for (const lang of ['ru', 'en']) {
    await page.locator(`#lang-${lang}`).click();
    for (const tab of ['history', 'control', 'campaigns', 'team', 'data']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await expect(page.locator(`#p-${tab}`)).toBeVisible();
    }
  }
  expect(requests).toEqual([]);
  expect(problems.filter(p => /Content Security Policy|Refused/i.test(p))).toEqual([]);
  expect(problems).toEqual([]);
});
