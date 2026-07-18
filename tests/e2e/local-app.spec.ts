import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const APP_PIN = '1234';

test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

const enterPin = async (page: Page, pin: string) => {
  for (const digit of pin) {
    await page.getByRole('button', { name: new RegExp(`^${digit}$`) }).click();
  }
};

const createFirstPin = async (page: Page) => {
  await page.getByRole('button', { name: /start private setup/i }).click();
  await expect(page.getByRole('button', { name: /^1$/ })).toBeVisible();
  await enterPin(page, APP_PIN);
  await page.getByRole('button', { name: /continue/i }).click();
  await enterPin(page, APP_PIN);
  await page.getByRole('button', { name: /confirm pin/i }).click();

  await expect(page.getByPlaceholder('Enter a memorable answer')).toBeVisible();
  await page.getByPlaceholder('Enter a memorable answer').fill('Blue');
  const saveRecoveryButton = page.getByRole('button', { name: /save recovery question/i });
  await expect(saveRecoveryButton).toBeEnabled();
  await saveRecoveryButton.click();
  const enterDiaryButton = page.getByRole('button', { name: /enter dear diary/i });
  if (await enterDiaryButton.count() && await enterDiaryButton.isVisible()) {
    await enterDiaryButton.click();
  }
};

const unlockWithPin = async (page: Page) => {
  const tapToUnlock = page.getByRole('button', { name: /tap to unlock/i });
  if (await tapToUnlock.count() && await tapToUnlock.first().isVisible()) {
    await expect(tapToUnlock.first()).toBeEnabled();
    await page.waitForTimeout(500);
    await tapToUnlock.first().tap({ force: true });
  }
  await expect(page.getByRole('button', { name: /^1$/ })).toBeVisible();
  await enterPin(page, APP_PIN);
  await page.getByRole('button', { name: /unlock diary/i }).click();
};

const setupUnlockedLocalApp = async (page: Page) => {
  await page.goto('/?e2eApp=1');
  await createFirstPin(page);
  await expect(page.getByTestId('nav-search')).toBeVisible({ timeout: 20_000 });
};

const openSearch = async (page: Page) => {
  await page.getByTestId('nav-search').focus();
  await page.keyboard.press('Enter');
  await expect(searchInput(page)).toBeVisible();
};

const searchInput = (page: Page): Locator =>
  page.locator('main').getByPlaceholder(/Search thoughts|Search keywords/).first();

const fillEditor = async (editor: Locator, text: string) => {
  await editor.scrollIntoViewIfNeeded();
  await editor.fill(text);
};

const lockFromProfileMenu = async (page: Page) => {
  const profileMenuButton = page.getByTestId('profile-menu-button');
  if (await profileMenuButton.count() && await profileMenuButton.isVisible()) {
    await profileMenuButton.click();
  }
  await page.getByTestId('lock-app-button').click();
};

const openSettings = async (page: Page) => {
  const profileMenuButton = page.getByTestId('profile-menu-button');
  if (await profileMenuButton.count() && await profileMenuButton.isVisible()) {
    await profileMenuButton.click();
    await page.getByRole('dialog', { name: 'Profile menu' }).getByRole('button', { name: 'Settings', exact: true }).click();
    return;
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
};

const openNoteForEditing = async (page: Page, title: string) => {
  const noteCard = page.getByTestId('note-card').filter({ hasText: title }).first();
  await expect(noteCard).toBeVisible();
  const editButton = noteCard.getByTestId('note-edit-button');
  if (await editButton.count()) {
    await editButton.click();
  } else {
    await noteCard.click();
  }
  await expect(page.getByTestId('note-title-input')).toBeVisible();
};

const deleteNoteByTitle = async (page: Page, title: string) => {
  const noteCard = page.getByTestId('note-card').filter({ hasText: title }).first();
  await expect(noteCard).toBeVisible();
  const cardDeleteButton = noteCard.getByTestId('note-delete-button');
  if (await cardDeleteButton.count()) {
    await cardDeleteButton.click();
    await noteCard.getByTestId('note-confirm-delete-button').click();
    return;
  }
  await noteCard.click();
  await page.getByTestId('note-delete-button').first().click();
  await page.getByTestId('note-confirm-delete-button').first().click();
};

test('test-mode local app creates a PIN and excludes locked diary content from search', async ({ page }) => {
  await setupUnlockedLocalApp(page);
  await openSearch(page);

  await searchInput(page).fill('ordinary visible memory');
  await expect(page.getByText('E2E Public Picnic').first()).toBeVisible();

  await searchInput(page).fill('secret locked diary body');
  await expect(page.getByText('No results found')).toBeVisible();
  await expect(page.getByText('E2E Private Keyword')).toHaveCount(0);
});

test('local app persists IndexedDB state, supports keyboard navigation, shows offline state, and locks manually', async ({ page, context }, testInfo) => {
  await setupUnlockedLocalApp(page);

  if (testInfo.project.name.includes('mobile')) {
    await openSearch(page);
    await searchInput(page).fill('ordinary visible memory');
    await expect(page.getByText('E2E Public Picnic').first()).toBeVisible();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Offline. Synced changes are paused.')).toBeVisible();

    await lockFromProfileMenu(page);
    await expect(page.getByRole('button', { name: /tap to unlock/i }).or(page.getByRole('button', { name: /^1$/ }))).toBeVisible();
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByRole('button', { name: /tap to unlock/i }).or(page.getByRole('button', { name: /^1$/ }))).toBeVisible();
    await expect(page.getByText('E2E Private Keyword')).toHaveCount(0);
    return;
  }

  await page.reload();
  await unlockWithPin(page);
  await openSearch(page);
  await searchInput(page).fill('ordinary visible memory');
  await expect(page.getByText('E2E Public Picnic').first()).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('Offline. Synced changes are paused.')).toBeVisible();

  await lockFromProfileMenu(page);
  await expect(page.getByRole('button', { name: /tap to unlock/i }).or(page.getByRole('button', { name: /^1$/ }))).toBeVisible();
  await expect(page.getByText('E2E Private Keyword')).toHaveCount(0);
});

test('local app creates, edits, and deletes a quick note through the UI', async ({ page }, testInfo) => {
  await setupUnlockedLocalApp(page);
  await page.getByTestId('nav-notes').click();
  const newNoteButton = page.getByTestId('new-note-button');
  await expect(newNoteButton).toBeVisible();
  await newNoteButton.click();
  if (testInfo.project.name.includes('mobile')) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  }

  const noteTitle = 'E2E UI note created body';
  const updatedTitle = 'E2E UI note updated';
  await fillEditor(page.getByTestId('quick-note-editor').first(), noteTitle);
  await page.getByRole('button', { name: /save note/i }).click();
  await expect(page.getByText(noteTitle)).toBeVisible();
  if (testInfo.project.name.includes('mobile')) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  }

  await openNoteForEditing(page, noteTitle);
  await page.getByTestId('note-title-input').fill(updatedTitle);
  await fillEditor(page.getByTestId('note-edit-editor'), 'Updated note body from browser CRUD.');
  const saveChangesButton = page.getByRole('button', { name: /save changes/i });
  await expect(saveChangesButton).toBeEnabled();
  await saveChangesButton.click();
  await expect(page.getByTestId('note-title-input')).toHaveCount(0);
  await expect(page.getByText(updatedTitle)).toBeVisible();

  await deleteNoteByTitle(page, updatedTitle);
  await expect(page.getByText(updatedTitle)).toHaveCount(0);
});

test('local app creates a journal without requiring appearance customization', async ({ page }, testInfo) => {
  await setupUnlockedLocalApp(page);
  await page.getByTestId('nav-diaries').click();
  await page.getByRole('button', { name: 'New Journal', exact: true }).click();
  if (testInfo.project.name.includes('mobile')) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  }

  await expect(page.getByRole('button', { name: /Customize appearance \(optional\)/i })).toBeVisible();
  await page.getByPlaceholder('e.g., Evening Reflections').fill('E2E Minimal Journal');
  await page.getByRole('button', { name: 'Create Journal', exact: true }).click();

  await expect(page.getByTestId('diary-card').filter({ hasText: 'E2E Minimal Journal' }).first()).toBeVisible();
  if (testInfo.project.name.includes('mobile')) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  }
});

test('local app creates, edits, and deletes a diary entry through the UI', async ({ page }) => {
  await setupUnlockedLocalApp(page);
  await page.getByTestId('nav-diaries').click();
  await page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first().click();
  await page.getByTestId('diary-new-entry-button').first().click();

  const entryTitle = 'E2E UI entry created';
  const updatedTitle = 'E2E UI entry updated';
  await page.getByTestId('entry-title-input').fill(entryTitle);
  await fillEditor(page.getByTestId('entry-body-editor'), 'Created entry body from Playwright.');
  await page.getByRole('button', { name: /close editor|my journal/i }).first().click();
  await expect(page.getByRole('dialog', { name: /leave this entry/i })).toBeVisible();
  await page.getByRole('button', { name: /save and leave/i }).click();
  await expect(page.getByText(entryTitle).first()).toBeVisible();

  await page.getByTestId('entry-edit-button').first().click();
  await page.getByTestId('entry-title-input').fill(updatedTitle);
  await fillEditor(page.getByTestId('entry-body-editor'), 'Updated entry body from Playwright.');
  await expect(page.getByRole('status').filter({ hasText: /unsaved changes/i }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /saved at/i }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /close editor|my journal/i }).first().click();
  await expect(page.getByText(updatedTitle).first()).toBeVisible();

  await page.getByTestId('entry-edit-button').first().click();
  await page.getByTestId('entry-delete-button').first().click();
  await page.getByTestId('entry-confirm-delete-button').first().click();
  await expect(page.getByText(updatedTitle)).toHaveCount(0);
});

test('local app renders sanitized content and archive availability without executable payloads', async ({ page }) => {
  await setupUnlockedLocalApp(page);
  await openSearch(page);

  await searchInput(page).fill('sanitized visible marker');
  await expect(page.getByText('E2E Sanitizer Probe').first()).toBeVisible();
  await expect(page.getByText('sanitized visible marker').first()).toBeVisible();
  await expect(page.getByText(/__e2eXss|javascript:|onerror|srcdoc/i)).toHaveCount(0);
  const xssFlag = await page.evaluate(() => (window as typeof window & { __e2eXss?: number }).__e2eXss);
  expect(xssFlag).toBeUndefined();

  await expect(page.getByText(/Some older memories are not downloaded/)).toBeVisible();
});

test('settings uses responsive section navigation and isolates section content', async ({ page }) => {
  await setupUnlockedLocalApp(page);
  await openSettings(page);

  const sectionNavigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sectionNavigation).toBeVisible();
  await sectionNavigation.getByRole('button', { name: /Appearance/ }).click();
  await expect(page.getByText('Application Theme')).toBeVisible();
  await expect(page.getByText('Daily Writing Reminder')).not.toBeVisible();
  await expect(page.getByText('Custom Tags')).not.toBeVisible();

  const isMobile = (page.viewportSize()?.width || 0) < 768;
  if (isMobile) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await expect(sectionNavigation).toBeVisible();
  }

  await sectionNavigation.getByRole('button', { name: /Data & Storage/ }).click();
  await expect(page.getByText('Cloud storage', { exact: true })).toBeVisible();
  await expect(page.getByText('Local availability', { exact: true })).toBeVisible();
  await expect(page.getByText('Local sync queue')).not.toBeVisible();
});

test('@accessibility authenticated primary destinations have no serious or critical axe violations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupUnlockedLocalApp(page);

  const destinations = [
    { name: 'Today', open: async () => undefined },
    { name: 'Journals', open: async () => page.getByTestId('nav-diaries').click() },
    { name: 'New Journal', open: async () => page.getByRole('button', { name: 'New Journal' }).click() },
    { name: 'Notes', open: async () => page.getByTestId('nav-notes').click() },
    { name: 'Insights', open: async () => page.getByTestId('nav-stats').click() },
    { name: 'Search', open: async () => openSearch(page) },
    { name: 'Settings', open: async () => openSettings(page) },
  ];

  const expectCurrentScreenAccessible = async (name: string) => {
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical');
    expect(blocking, `${name}: ${blocking.map(violation => violation.id).join(', ')}`).toEqual([]);
  };

  for (const destination of destinations) {
    await destination.open();
    await expectCurrentScreenAccessible(destination.name);
    if (destination.name === 'New Journal') {
      await page.getByRole('button', { name: 'Back to journals' }).click();
    }
  }

  const settingsBack = page.getByRole('button', { name: 'Back', exact: true });
  if (await settingsBack.count() && await settingsBack.isVisible()) {
    await settingsBack.click();
  }
  await page.getByTestId('nav-diaries').click();
  await page.getByTestId('diary-card').filter({ hasText: 'E2E Open Diary' }).first().click();
  await expectCurrentScreenAccessible('Journal reader');
  await page.getByTestId('diary-new-entry-button').first().click();
  await expectCurrentScreenAccessible('Entry editor');
});
