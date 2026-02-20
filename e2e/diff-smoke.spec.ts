import { expect, test, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

test.describe('changes diff smoke', () => {
  test('renders inline + and - diff markers in Electron', async () => {
    const entryPath = path.resolve(__dirname, '../dist/main/main/entry.js');
    if (!existsSync(entryPath)) {
      throw new Error(`Missing Electron entry at ${entryPath}. Run 'pnpm run build' first.`);
    }

    const app = await electron.launch({
      args: [entryPath, '--e2e-diff-smoke'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TELEMETRY_ENABLED: '0',
        EMDASH_DISABLE_NATIVE_DB: '1',
      },
    });

    try {
      const page = await app.firstWindow();
      await page.getByTestId('e2e-diff-smoke-ready').waitFor({ state: 'visible', timeout: 20_000 });
      await expect(page.locator('[role="dialog"]')).toBeVisible();

      const addSigns = page.locator('.diff-line-sign-add');
      const delSigns = page.locator('.diff-line-sign-del');

      await expect
        .poll(async () => addSigns.count(), { timeout: 20_000, message: 'expected + markers' })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => delSigns.count(), { timeout: 20_000, message: 'expected - markers' })
        .toBeGreaterThan(0);

      const addContent = await addSigns
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content.replace(/['"]/g, ''));
      const delContent = await delSigns
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content.replace(/['"]/g, ''));

      expect(addContent).toBe('+');
      expect(delContent).toBe('-');
    } finally {
      await app.close();
    }
  });
});
