# Design language

Rules for keeping every phase visually consistent. Tokens live in
`src/styles/globals.css`; shared building blocks in `src/components/`.

## Principles
- **Instrument, not web dashboard.** Docked regions separated by hairlines and
  whitespace. No floating cards, gradients, glows or glassmorphism.
- **Colour means something.** Neutral graphite carries the UI. Hue is reserved for
  meaning, following glass-cockpit conventions:

  | Colour | Token | Meaning |
  |---|---|---|
  | Cyan | `accent` | Interactive or user-selectable (primary action, selection, focus, links) |
  | Green | `ok` | Active, normal |
  | Amber | `warn` | Caution, transitional (starting, restarting) |
  | Red | `fault` | Warning, failure, destructive action |
  | Magenta | — (Phase 5) | Targets and setpoints |

- **Numbers are instruments.** Measured values use IBM Plex Mono with tabular
  figures (`num` utility), in bright `fg`. Units and labels are muted (`fg-subtle`,
  `fg-muted`). Word values such as a state stay in the sans face.
- **Honest UI.** No placeholder screens or dummy buttons. Unbuilt sections are
  visible but disabled, with the roadmap phase that delivers them.
- **Sentence case** for titles, labels and buttons. No uppercase eyebrow labels.

## Typography
IBM Plex Sans (UI) and IBM Plex Mono (values), bundled offline. Scale: 11.5 px
(status bar), 12–12.5 px (table headers, labels, secondary), 13 px (body,
navigation), 14 px (dialog titles), 15 px (page titles).

## Layout
- Window chrome (sidebar, status bar) uses `chrome`, one step darker than the work
  area `bg`. Dialogs use `raised`.
- Page content is capped at 1600 px and centred. 3D viewports (Phase 2+) are never
  capped.
- `main` is a size container. Page grids respond to its width (`@min-[880px]:…`) and
  each `Section` is its own container, so tables drop secondary columns when they
  run short of space. Window media queries are only used for the sidebar.
- Sidebar: 212 px, or a 52 px icon rail below 1180 CSS px or when the user
  collapses it. Zoom counts, because breakpoints are in CSS px.
- Tables bleed 12 px past their section (`Table`, `EmptyState`) so row highlights
  have room while text stays aligned with section titles.

## Sizing targets (covered by the e2e suite)
Minimum window 880×560 DIP (fits a 1366×768 laptop at 125 % scaling). The layout
must have no horizontal overflow from 880×560 to 2560×1440, and at 150 % and 200 %
in-app zoom.

## Motion
120–140 ms fades and scale-ins for overlays only, behind `motion-safe:`. Status
lamps pulse while the engine is in a transitional state.
