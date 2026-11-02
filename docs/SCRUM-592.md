# SCRUM-592 — Find a Venue Does Not Search Venue Names

**Type:** Bug, Sprint 4, linked to SCRUM-20. Tracked on SCRUM-592 itself; SCRUM-20
and SCRUM-111 stay Done (Week 7 guide).
**Reported:** "Unable to search as an Event Coordinator." On Find a Venue
(`/venue-search`), "meeting" and "meeting room" answered "No active venues match
your search", although the shared project has an active venue named "Meeting room"
(location "Singapore", capacity 200; confirmed by query on 2 November 2026).
**Status as of 2 November 2026:** fixed and tested; AC1 to AC4 met. No migration.
Not yet committed.
**Test cases:** `docs/test-cases/SCRUM-592.md`.

**The short version:** the search box sent `location`, which only ever matched the
location column. It now sends a new parameter, `q`, matched against the name or the
location. Everything typed is matched literally:
- `%`, `_` and `\` are escaped for LIKE, and the value is quoted for PostgREST's
  `or=(...)` list;
- every row the database returns is re-checked with `includes()`, which also makes
  `*` literal (PostgREST turns `*` into `%`, D3).

The box and Min capacity now have accessible names.

---

## 1. Root cause

The box was a location filter, end to end (line numbers at `737b3ed`):

| Step | Where | What it did |
|---|---|---|
| The box | `frontend/src/components/VenueSearch.jsx:302-303` | `placeholder="Location"`, bound to `filters.location`; seeded from `?location=` (`:125`, `:258`) |
| The request | `frontend/src/services/venueService.js:60` | sent as `?location=` |
| The route | `backend/src/routes/venues.js:119-123` | `parseSearchFilters` passed `location` through |
| Validation | `backend/src/validation/venueValidation.js:552` | trimmed it as `location` |
| The query | `backend/src/services/venueService.js:559` | `query.ilike('location', '%' + text + '%')` |

The name was never searched. On the same line, `%` and `_` went into the pattern
unescaped, so they were wildcards: `_` matched every venue.

## 2. Acceptance criteria

Written by the team for this bug.

| AC | Met | Proved by |
|---|---|---|
| AC1: text in the box returns active venues whose name or location contains it, ignoring case ("meeting", "MEETING ROOM" and "singapore" all find "Meeting room") | Yes | AC1-01 to AC1-07; live: all three find it, and `location: 'meeting'` does not |
| AC2: characters are matched literally. `%`, `_` and `\` are not wildcards; a comma, parenthesis, period, colon or double quote neither errors (no 500) nor changes what else is filtered | Yes, `*` included (D3) | AC2-01 to AC2-12; live: every probe returns exactly the venues containing that character, `*` included |
| AC3: the other filters are unchanged: min capacity, the From/To window (SCRUM-130, SCRUM-484), Include retired (SCRUM-185), and a blank box means no text filter | Yes | AC3-01 to AC3-06; the SCRUM-130 and SCRUM-185 suites pass with only the text key renamed (§5); live: minCapacity 201 excludes "Meeting room" and 200 includes it |
| AC4: the box says what it searches: placeholder "Venue name or location" | Yes, and as its accessible name (D5) | AC4-01, AC4-02 |

## 3. Design decisions

### D1. A new parameter, `q`, rather than widening `location`

`GET /venues/search?q=` matches the name or the location. `?location=` keeps
exactly its meaning (the location only) and is still accepted. Both may be sent;
they are ANDed.

*Rejected: widening `location` to search names too.* `location` means "location
only" on the event-requirements search as well (`findVenuesForEvent`, SCRUM-141).
An API parameter called `location` that also matches names misleads whoever reads
it next. And it would change, unannounced, behaviour that SCRUM-111's tests and
docs assert. The argument is also in the `searchVenues` comment.

### D2. Escaping in two layers, in one pure helper

`backend/src/http/likePattern.js` exports `toIlikePattern(text)` and
`anyColumnContains(columns, text)`. It sits beside `pgErrors.js`, the other pure
PostgREST-facing helper. `domain/` holds business vocabularies and rules, and this
is transport syntax. It is new and owned by this bug, so it is gated at 100% in
`backend/vitest.config.js`.

| Layer | Why | Rule |
|---|---|---|
| 1. LIKE | `%` and `_` are wildcards, and `\` is LIKE's default escape character | each gets a `\` in front; then wrapped in `%...%` |
| 2. PostgREST `or=(...)` | commas, parentheses, periods and colons are list syntax | the value is wrapped in `"..."`, and inside it `"` and `\` get a `\` in front, so layer 1's backslashes are doubled |

A plain `.ilike('location', ...)` is one query parameter whose value PostgREST
reads verbatim, so it needs layer 1 only. The value inside `.or()` needs both.
Exact strings produced:

| Typed | `.or()` filter sent |
|---|---|
| `meeting` | `name.ilike."%meeting%",location.ilike."%meeting%"` |
| `a,b` | `name.ilike."%a,b%",location.ilike."%a,b%"` |
| `50%_"x\.` | `name.ilike."%50\\%\\_\"x\\\\.%",location.ilike."%50\\%\\_\"x\\\\.%"` |

The unit tests prove the string built. Only the real PostgREST can prove how it is
read, so `npm run venue-search:check` does that (§6).

The existing `location` filter gets layer 1 too, so AC2 holds for it. For anyone
calling `?location=` directly, `%` and `_` are now literal there as well.

*Rejected: two queries, one per column, merged in JavaScript.* Two round trips
instead of one, the dated search run on a merged list, and name order becomes the
merge's job. *Rejected: a new SQL function.* It needs a migration number for a
one-line filter, and it would repeat the retired and capacity rules in SQL.

### D3. `*` is made literal by re-checking each row in JavaScript — **decided with Calven, 2 November 2026 (fix-up)**

PostgREST rewrites every `*` in a like pattern as `%` before Postgres sees it, and
no escape survives that: `\*` would become `\%`, a literal percent sign. The live
check proved it: before this decision, `q: '*'` returned 16 of 16 active venues,
and none contains a `*`. So the database can over-match, and the server re-checks
every row with an operation that has no wildcards at all.

In `searchVenues`, when `q` is set, the rows from the venues query are kept only if
the lowercased name or location `includes()` the lowercased `q`
(`backend/src/services/venueService.js`, between the query and
`findAvailableVenueIds`):

- **The ilike stays, as the database's pre-filter.** It still does the narrowing
  in the database, so the whole table is never fetched. The query and
  `likePattern.js` are unchanged.
- **The re-check is exact for every character.** So it backs up the `%`, `_` and
  `\` escaping as well, rather than replacing it.
- **It runs before availability.** So `available_venue_ids` is asked only about
  rows that really match (`SCRUM592_AC2_rows_the_database_over_matched_are_dropped_before_availability`).
- **Case:** ilike and `toLowerCase()` agree for ASCII, which is all the live data
  holds. For other scripts their case folding may differ; nothing is built for that.
- **Scope: `q` only.** `?location=*` still over-matches, because it has no
  re-check. That is the remaining, accepted behaviour of a parameter no screen
  sends any more, and the bug's scope keeps `location` unchanged.

*Rejected: the regex operators (`match`, `imatch`) for `q`.* A second escaping
scheme beside LIKE's, in which every regex metacharacter becomes a trap.
*Rejected: moving `location` to regex too.* It changes `location`'s meaning and its
existing tests, which the bug's scope rules out. *Rejected: recording `*` as a known
limit* (the first choice in brief 1). It leaves a gap in the final sprint.

### D4. The page sends `q` only

The box is bound to `q`, seeded from `?q=` on first render, and `?q=` triggers the
auto-search as `?location=` did. `?location=` is no longer read: grep finds no
`/venue-search?location=` link anywhere in `frontend/src`. The links in
`Navigation.jsx:47` and `CoordinatorRequestDetail.jsx:1099` carry no query.
`searchActiveVenues` still sends `location` when given (documented, harmless).
`EventVenueFinder.jsx:261` calls `searchActiveVenues()` with no filters, so it is
unaffected; its suite passes unchanged.

### D5. Both inputs get an accessible name

A placeholder is not an accessible name, so before this a screen reader announced
the box as an unlabelled text field. The text box has
`aria-label="Venue name or location"` and Min capacity has
`aria-label="Min capacity"`; both keep their placeholders.
`docs/UI-STANDARD.md` says nothing about field labels, so there was nothing to
reconcile. Proved by `SCRUM592_AC4_the_box_has_an_accessible_name`.

## 4. Left as they are

| Item | Why |
|---|---|
| (a) `?location=*` over-matches | D3: `location` has no re-check, and no screen sends it any more |
| (b) `equipmentService.js:225` has its own LIKE escape | Another story's file, and no bug reports it |
| (c) NUL in the text | Postgres text cannot hold `\0`. Probed live: `q: 'a\u0000b'` resolved with 0 venues, without an error. No fix built |

## 5. Tests changed by design

Renamed (old → new), all in `frontend/tests/components/VenueSearch.test.jsx`:

| Old | New |
|---|---|
| `a dateless search sends exactly location and minCapacity, with no date keys` | `SCRUM592_AC1_a_dateless_search_sends_exactly_q_and_minCapacity_with_no_date_keys` |
| `a search with nothing filled in sends undefined location and minCapacity only` | `SCRUM592_AC3_a_search_with_nothing_filled_in_sends_undefined_q_and_minCapacity_only` |
| `?location seeds the field and searches once on mount` | `SCRUM592_AC1_q_in_the_url_seeds_the_box_and_searches_once_on_mount` (now `?q=hall`) |

Updated and not renamed: their subject is another story's (the window, the
minCapacity seed, Include retired). Only the box's placeholder, the `location` key
(now `q`) or the seeding URL (`?location=` → `?q=`) changed. Each assertion is as
strict as before:

- `VenueSearch.test.jsx`:
  - `?minCapacity seeds the field and searches once on mount`
  - `SCRUM17_AC2_sends_the_window_as_offset_ISO_naming_the_entered_instants`
  - `SCRUM17_AC2_resets_both_dates_and_their_errors_without_searching`
  - `SCRUM17_AC2_leaves_the_note_until_the_next_successful_search`
  - `SCRUM178_AC1_ticking_and_searching_sends_includeRetired_true_and_no_dates`
  - `SCRUM178_AC1_staff_ticking_and_searching_sends_includeRetired_true`
  - `SCRUM178_AC1_an_unticked_box_sends_no_flag_at_all`
  - `SCRUM178_AC1_ticking_the_box_after_a_url_auto_search_does_not_search_again`
  - `SCRUM178_AC1_pre_ticks_the_box_and_searches_once_for_a_coordinator`
  - `SCRUM178_AC1_pre_ticks_the_box_for_venue_staff_alongside_other_url_filters`
  - `SCRUM178_AC1_an_organisers_url_search_never_carries_the_flag`
- `frontend/tests/flows/venueCalendarFlow.test.jsx`:
  `SCRUM178_AC1_AC2_AC4_coordinator_opens_calendar_from_venue_search_and_navigates`
  (it arrives at `?q=Level`).

The backend `location` tests are unchanged and pass, because `location` did not
change and `SCIS` has nothing to escape. `tests/fixtures/supabaseStubs.js` gains `or`
in its builder methods, built like the others.

In the fix-up (D3), the helper's `SCRUM592_AC2_leaves_an_asterisk_as_typed_the_known_limit`
was renamed to `SCRUM592_AC2_leaves_an_asterisk_in_the_pattern_for_the_post_filter`.
Its assertion is unchanged: the pattern still leaves `*` alone, and the re-check
handles it. No existing SCRUM-592 service test needed new fixture rows: the only
one that returns rows (the dated search) returns "Meeting room" for `q: 'meeting'`,
which the re-check keeps.

## 6. Verification

| Evidence | Result |
|---|---|
| Backend `npm run test:coverage` | 10,368 passed, 17 skipped, 2 todo (250 files); every gate met; `likePattern.js` 100% |
| Frontend `npm run test:coverage` | 5,162 passed, 1 failed (216 files); no coverage gate reported a failure. The failure is `SCRUM583_AC1_no_screen_adds_its_own_expiry_wording` (`tests/flows/scrum583ExpiredSessionFlow.test.jsx:60`), a timing race outside this bug. It reads the page text as soon as the URL is `/login`, without waiting for the login page to render. It passes alone (19 of 19 in its file), and passed in brief 1's full run |
| Frontend `npm run lint`, `npm run build` | Lint 0 errors (25 warnings, none new: `VenueSearch.jsx`'s one warning is the same at `737b3ed`). Build passes |
| `npm run venue-search:check` against the shared project (read-only) | All 23 checks pass, plus one printed note (below) |

Teeth checks, each broken in memory and restored from memory (1 to 3 in brief 1,
4 in the fix-up):

1. `searchVenues` back to `query.ilike('location', ...)` for the text fails 8:
   - the 6 SCRUM-592 service tests that send `q`;
   - the 2 route tests that pass `q` through.
2. The LIKE escape removed fails 10:
   - the 8 helper escape tests;
   - `SCRUM592_AC2_q_is_escaped_for_LIKE_and_for_the_or_list`;
   - `SCRUM592_AC2_location_is_escaped_for_LIKE_too`.
3. The `or=(...)` quoting removed fails 19: every helper and service test that
   checks a filter string built by `.or()`.
4. The `includes()` re-check removed (D3) fails exactly the 2 tests written for it:
   - `SCRUM592_AC2_an_asterisk_matches_only_venues_that_contain_one`;
   - `SCRUM592_AC2_rows_the_database_over_matched_are_dropped_before_availability`.

Live check output (2 November 2026, after the fix-up):

```
Venue search text check (SCRUM-592)

  ok    "Meeting room" is active at "Singapore", capacity 200
  ok    the unfiltered search returns it  (16 active venues)
  ok    q "meeting" includes "Meeting room"  (1 found)
  ok    q "MEETING ROOM" includes "Meeting room"  (1 found)
  ok    q "singapore" includes "Meeting room"  (2 found)
  ok    location "meeting" does not include "Meeting room" (location only, as before)  (0 found)
  ok    q "_" returns only venues whose name or location contains it  (0 of 16 returned, 0 expected)
  ok    q "%" returns only venues whose name or location contains it  (0 of 16 returned, 0 expected)
  ok    q "*" returns only venues whose name or location contains it  (0 of 16 returned, 0 expected)
  ok    q "a,b" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "(x)" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "a.b" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "x:y" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "\"" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "\\" resolves, and returns exactly the venues containing it  (0 returned, 0 expected)
  ok    q "(", found in the live data, returns exactly the venues containing it  (2 returned, 2 expected)
  ok    q ")", found in the live data, returns exactly the venues containing it  (2 returned, 2 expected)
  ok    q ",", found in the live data, returns exactly the venues containing it  (12 returned, 12 expected)
  ok    q "-", found in the live data, returns exactly the venues containing it  (2 returned, 2 expected)
  ok    location "_" returns only venues whose location contains it  (0 returned, 0 expected)
  ok    location "%" returns only venues whose location contains it  (0 returned, 0 expected)
  note  q "a\u0000b" resolved with 0 venue(s)
  ok    q "meeting" with minCapacity 201 excludes it
  ok    q "meeting" with minCapacity 200 includes it

All checks passed. Read-only: nothing was written.
```

Each text search is compared with the answer worked out in JavaScript from the
full active list, so an exact match means nothing was widened, narrowed or dropped.
`(`, `)`, `,` and `-` appear in live names or locations, so those probes show a
quoted, escaped value being read as the character itself. The first run in brief 1
failed on `*` (16 of 16 returned, 0 expected); D3's re-check makes it 0 of 16. The
NUL line is a printed note, not a check (§4).

## 7. Deploy

No migration. Redeploy the API and the frontend.
