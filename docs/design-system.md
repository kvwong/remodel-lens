# Whim design system

The application and generated reports share foundations through `src/ui/design-system.css`. `src/ui/design-system.ts` loads it; `brandHead` embeds it into both documents, including standalone report exports. No network stylesheet is required.

## Ownership

- Shared theme tokens own light/dark colors, fonts, shadows, and motion timing. Use semantic variables such as `--surface`, `--text`, `--primary`, and `--warn`; do not redefine them in individual pages.
- Shared controls own `.btn`, primary/quiet/small variants, `.icon-btn`, and report `.share-btn` appearance. Page CSS may position controls or set responsive widths, but should not duplicate their base colors or interaction states.
- `src/detail-header.ts` owns structural header markup and responsive typography. Callers provide escaped title, back-link, metadata, action, and notice slots. Keep edit actions and download behavior in their respective views.
- Shared photo primitives own the overlapping stack, image presentation, and empty listing placeholder. Listing and report-row patterns retain their distinct responsive limits and hover behavior.
- Shared feedback primitives own notices, errors, save notifications, Undo toast surfaces, spinners, and tooltips. Async workflows and notification timing remain in the app.
- `src/app/motion.js` remains the shared animation runtime. Preserve reduced-motion behavior when adding transitions.

## Adding or changing a pattern

Start with the existing shared primitive. Add a named variant when multiple views need a different state; keep one-off arrangement in the page. New HTML components should use small render functions with escaped text and explicit markup slots, following `renderPageHeader`. Preserve native button, input, dialog, and link semantics.

Do not unify the Home reel and report inspector layouts: they have different purposes. Compose them from shared controls and tokens.

## Verification

Run `npm run check`, `npm test`, and `git diff --check`. Check listing, taste, and report detail pages at narrow and desktop widths, in both themes. Check keyboard focus and selected/disabled states. Verify standalone HTML exports embed the stylesheet and that report downloads, viewer behavior, and reduced motion still work.

This first pass centralizes foundations and existing visual primitives. Form-row components, dialog renderers, and a common notification controller remain future extractions.

## Layout grid

App and report shells share a 1360px maximum width, 24px desktop gutters and section gaps, and 16px gutters at 860px and below. Cards use 24px padding, switching to 16px at 600px and below. Each gutter accounts for its own safe area. Collection gaps use the shared 16px grid token. Header-to-content spacing stays fixed instead of being shifted to match a sidebar row. Specialized image grids may change column counts independently without changing the outer grid.
