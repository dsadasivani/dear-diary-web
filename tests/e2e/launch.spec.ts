import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('fresh web launch opens the companion onboarding screen', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Dear Diary' })).toBeVisible();
  await expect(page.getByText('Your diary starts on your phone.')).toBeVisible();
  await expect(page.getByRole('link', { name: /get it on google play/i })).toHaveAttribute(
    'href',
    'https://play.google.com/store/apps/details?id=com.deardiary.app',
  );
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
});

test('@accessibility companion onboarding has no serious or critical axe violations', async ({
  page,
}) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();
  const blockingViolations = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blockingViolations).toEqual([]);
});
