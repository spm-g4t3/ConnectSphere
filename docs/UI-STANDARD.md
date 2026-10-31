# ConnectSphere UI standard

How the common parts of ConnectSphere look and behave, so every role sees the same thing in the same way.

## Shared screens

This standard applies first to the screens every user sees:

- Login
- Navigation
- Dashboard shell
- Notification inbox
- "Not available to your role"

Role screens follow it as they are touched.

## Tokens

Defined once on `:root` in `frontend/src/index.css`.

- New CSS uses tokens, never literal colours, sizes or radii.
- The old names in `App.css` (`--ink`, `--muted`, `--line`, `--paper`, `--teal`, `--teal-dark`, `--shadow`) are aliases only. Do not use them in new rules.

| Token | Value | Use |
| --- | --- | --- |
| `--color-ink` | `#17242b` | Body text, headings |
| `--color-muted` | `#64757a` | Secondary text, labels |
| `--color-line` | `#d9e4e0` | Borders, dividers |
| `--color-paper` | `#ffffff` | Cards, nav, panels |
| `--color-page` | `#eef3f1` | Page background |
| `--color-accent` | `#087f7b` | Primary buttons, active nav, links |
| `--color-accent-dark` | `#075c5a` | Accent hover, section headings |
| `--color-accent-soft` | `#eef6f3` | Hover background |
| `--color-danger` | `#a43c32` | Error text |
| `--color-danger-soft` | `#fff0ee` | Error background |
| `--color-warning` | `#8a5a00` | Warning text |
| `--color-warning-soft` | `#fff6e5` | Warning background |
| `--color-success` | `#17684f` | Success text |
| `--color-success-soft` | `#e8f7f1` | Success background |
| `--shadow-card` | `0 18px 48px rgba(24, 61, 58, 0.09)` | Raised cards |
| `--space-1` … `--space-6` | `4px`, `8px`, `12px`, `16px`, `24px`, `32px` | Gaps, padding, margins |
| `--font-family` | `"Avenir Next", "Segoe UI", sans-serif` | All text |
| `--font-size-xs` | `0.72rem` | Badges, counts |
| `--font-size-sm` | `0.84rem` | Meta text |
| `--font-size-md` | `0.9rem` | Labels, dense lists |
| `--font-size-base` | `1rem` | Body text |
| `--font-size-h2` | `1.2rem` | Section headings |
| `--font-size-h1` | `clamp(2rem, 4vw, 3.25rem)` | Page title |
| `--radius-control` | `6px` | Buttons, inputs, notices |
| `--radius-card` | `8px` | Cards, panels |
| `--radius-pill` | `999px` | Status badges, count badges |

## Page titles

- Exactly one `<h1>` per page.
- Section headings are `<h2>`.

## Buttons

- Use `Button` from `src/components/ui/Button.jsx`.
- Variants: `primary`, `secondary`, `danger`, `link`.
- A back link is the `link` variant.

## Status

- Use `StatusBadge` from `src/components/ui/StatusBadge.jsx`. It renders the `.status-badge` class.

## Loading

- Use `LoadingText`. It shows exactly `Loading...` (three full stops, never the ellipsis character).

## Empty

- Use `EmptyState`. It says what is missing and what to do next.

## Errors

- Use `ErrorNotice` with a `Try again` button. Never "Retry" or other wording.

## Confirmations

- Use `ConfirmDialog` (a native `<dialog>`).
- Never `window.confirm`.
- Inline two-step confirms move to `ConfirmDialog` as their screens are updated.

## Dates and times

All displayed dates and times are Singapore time (`Asia/Singapore`).

- Format them only through `src/services/datetimeFormat.js`:
  - `formatVenueTimestamp` for one instant, with the zone note.
  - `formatVenuePeriod` for a start and end, with the zone note.
  - `formatVenueRange` for a start and end without the note, when several ranges share one line; end the line with `VENUE_TIME_NOTE` once.
- Never call `toLocaleString` or `toLocaleDateString` on a date directly.
- Form inputs are the exception: they take the device's time zone, are labelled with `deviceTimeZoneLabel()`, and are sent with `toOffsetIsoString`. The coordinator venue finder is the one form that takes Singapore time, sent with `toVenueOffsetIsoString`.

## Direction

Role screens will move toward the "ConnectSphere UI Prototype" design (Calm operations: IBM Plex Sans, no shadows, full-radius status lozenges, 44px touch targets), each in its own change. The tokens are where that change happens, so screens that use them follow automatically. Until then the app keeps today's look.
