import { expect, test, type Page } from '@playwright/test';

const APP_PIN = '1234';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const enterPin = async (page: Page) => {
  for (const digit of APP_PIN) {
    await page.getByRole('button', { name: new RegExp(`^${digit}$`) }).click();
  }
};

const setupUnlockedApp = async (page: Page) => {
  await page.clock.setFixedTime(new Date('2026-07-19T04:00:00.000Z'));
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto('/?e2eApp=1');
  await page.getByRole('button', { name: /start private setup/i }).click();
  await enterPin(page);
  await page.getByRole('button', { name: /continue/i }).click();
  await enterPin(page);
  await page.getByRole('button', { name: /confirm pin/i }).click();
  await page.getByPlaceholder('Enter a memorable answer').fill('Blue');
  await page.getByRole('button', { name: /save recovery question/i }).click();
  const enterDiary = page.getByRole('button', { name: /enter dear diary/i });
  if ((await enterDiary.count()) && (await enterDiary.isVisible())) await enterDiary.click();
  await expect(page.getByTestId('nav-diaries')).toBeVisible({ timeout: 20_000 });
};

const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
};

const capture = async (page: Page, name: string) => {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
};

const openSearch = async (page: Page) => {
  await page.getByTestId('nav-search').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('main').getByRole('searchbox', { name: 'Search memories' }).first(),
  ).toBeVisible();
};

const openSettings = async (page: Page) => {
  const profileMenu = page.getByTestId('profile-menu-button');
  if ((await profileMenu.count()) && (await profileMenu.isVisible())) {
    await profileMenu.click();
    await page
      .getByRole('dialog', { name: 'Profile menu' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
  } else {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  }
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
};

const returnToRootNavigation = async (page: Page) => {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  if ((await back.count()) && (await back.isVisible())) await back.click();
};

const leaveReaderForRootNavigation = async (page: Page) => {
  const notesDestination = page.getByTestId('nav-notes');
  if (!(await notesDestination.isVisible())) {
    await page.getByRole('button', { name: /Back to journals|Back to library/ }).click();
    await expect(page.getByTestId('nav-notes')).toBeVisible();
  }
};

const lockApp = async (page: Page) => {
  const profileMenu = page.getByTestId('profile-menu-button');
  if ((await profileMenu.count()) && (await profileMenu.isVisible())) {
    await profileMenu.click();
    await page.getByTestId('lock-app-button').click();
    return;
  }
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
};

test('Living Memories responsive visual matrix', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium baselines cover the responsive visual matrix.');
  await setupUnlockedApp(page);

  await capture(page, 'home-light');

  await page.getByTestId('nav-diaries').click();
  await expect(
    page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first(),
  ).toBeVisible();
  await capture(page, 'journals-light');
  await page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first().click();
  await expect(page.getByTestId('entry-edit-button').first()).toBeVisible();
  await capture(page, 'reader-light');
  await page.getByTestId('entry-edit-button').first().click();
  await expect(page.getByTestId('entry-title-input')).toBeVisible();
  await capture(page, 'editor-light');
  await page
    .getByRole('button', { name: /close editor|my journal/i })
    .first()
    .click();
  await leaveReaderForRootNavigation(page);

  await page.getByTestId('nav-notes').click();
  await capture(page, 'notes-light');
  await openSearch(page);
  await capture(page, 'search-light');
  await openSettings(page);
  await capture(page, 'settings-light');
  await returnToRootNavigation(page);
  await page.getByTestId('nav-stats').click();
  await capture(page, 'insights-light');

  await page.evaluate(() => {
    window.localStorage.setItem('deardiary_theme', 'dark');
    document.documentElement.classList.add('dark');
  });
  await page.getByTestId('nav-home').click();
  await capture(page, 'home-dark');
  await page.getByTestId('nav-diaries').click();
  await expect(
    page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first(),
  ).toBeVisible();
  await page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first().click();
  await expect(page.getByTestId('entry-edit-button').first()).toBeVisible();
  await capture(page, 'reader-dark');
  await page.getByTestId('entry-edit-button').first().click();
  await expect(page.getByTestId('entry-title-input')).toBeVisible();
  await capture(page, 'editor-dark');
  await page
    .getByRole('button', { name: /close editor|my journal/i })
    .first()
    .click();
  await leaveReaderForRootNavigation(page);
  await page.getByTestId('nav-home').click();
  await openSettings(page);
  await capture(page, 'settings-dark');

  await returnToRootNavigation(page);
  await lockApp(page);
  await capture(page, 'lock-dark');
});
