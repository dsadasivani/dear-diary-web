import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('fresh web launch opens the companion onboarding screen', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Dear Diary' })).toBeVisible();
  await expect(page.getByText('Link this browser as a trusted companion.')).toBeVisible();
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
});

test('@accessibility companion onboarding has no serious or critical axe violations', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();
  const blockingViolations = results.violations.filter(violation => (
    violation.impact === 'serious' || violation.impact === 'critical'
  ));
  expect(blockingViolations).toEqual([]);
});
