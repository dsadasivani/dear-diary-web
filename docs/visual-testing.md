# Visual testing

The Living Memories visual contract is covered by `tests/e2e/visual.spec.ts` and Playwright snapshots.

## Matrix

Chromium snapshots run at the configured desktop, Pixel 7 mobile, and 900px tablet viewports. The matrix covers Today, journals, journal reader, editor, notes, search, insights, settings, and lock. All major routes are captured in light mode; the highest-risk composition, reader/editor, settings, and lock surfaces are also captured in dark mode.

The test fixes the clock, uses deterministic E2E repository data, disables animation, hides the caret, and waits for network/font stability. Firefox remains in behavioral and accessibility coverage but is excluded from pixel baselines to avoid platform rasterization noise.

## Commands

Generate or intentionally update baselines:

```powershell
npx.cmd playwright test tests/e2e/visual.spec.ts --project=chromium-desktop --project=chromium-mobile --project=chromium-tablet --update-snapshots
```

Verify committed baselines:

```powershell
npx.cmd playwright test tests/e2e/visual.spec.ts --project=chromium-desktop --project=chromium-mobile --project=chromium-tablet
```

Review every changed image. A passing diff is not permission to accept unintended hierarchy, clipping, low contrast, or unstable data. Keep changes to snapshots and their causal UI changes together.
