# Living Memories design system

Dear Diary uses a semantic, light-first visual system with a deliberate dark counterpart. The product should feel emotionally warm and tactile without sacrificing clarity, contrast, or data density.

## Colour roles

Components consume semantic custom properties from `src/index.css`; they must not introduce feature-specific hex values. The core roles are canvas, surface, elevated/subtle surface, primary/secondary/tertiary accents, text hierarchy, borders, focus, and functional states. Dark mode changes the role values rather than inverting pixels.

Legacy `brand-*` variables are migration aliases only. New work uses `--color-*` roles. Text placed on an accent must use its matching `--color-on-*` role. Mood and journal colours are selected from the controlled palette or mapped to its nearest accent by `AmbientThemeProvider`.

## Typography

The system interface stack is the default. Serif is reserved for editorial moments: journal prose, reflective narrative, and occasional emotional display copy. Page titles, section labels, buttons, navigation, settings, and analytics metadata remain sans-serif.

Use the shared type roles: `type-display`, `type-page-title`, `type-section-title`, `type-card-title`, `type-supporting`, and `type-metadata`. Numeric analytics use tabular numerals.

## Shape, spacing, and depth

Controls use compact radii, cards use medium radii, and sheets/modals use larger radii. A 44px minimum target applies to every interactive control. Page gutters and section spacing come from the shared `--space-*` tokens.

Depth has four levels: flat, subtle, floating, and modal. Glass is limited to navigation, sticky bars, and overlays; reading surfaces remain opaque. Avoid stacking shadows on nested cards.

## Component rules

- Use shared buttons, fields, segmented controls, menus, bottom sheets, state notices, skeletons, and empty states.
- Selected navigation is a capsule or filled surface, not colour-only text.
- Journal covers retain tactile object proportions and may use a shared-element transition into the reader.
- Loading, empty, offline, locked, error, and retry states are designed product states, never raw messages.
- New imagery must be local, user-owned, or safely cached; the built-in fallback lives in `public/journal-memory-fallback.svg`.

## Accessibility

All interaction must remain keyboard operable with visible focus, semantic names, predictable focus restoration, and reduced-motion support. Do not rely on colour alone. Check both themes at 200% zoom and with long labels before merging.
