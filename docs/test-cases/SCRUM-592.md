# SCRUM-592 — Test Cases

**Bug:** Find a Venue does not search venue names — Event Coordinator
**Schema:** none (a supabase-js query change; no migration)
**Status:** every case proved (2 November 2026). The review is `docs/SCRUM-592.md`.

> "Unable to search as an Event Coordinator." Searching "meeting" or "meeting room"
> on Find a Venue answered "No active venues match your search", although an active
> venue named "Meeting room" exists.

1. **AC1:** Text in the Find a Venue box returns active venues whose name or
   location contains it, ignoring case. ("meeting", "MEETING ROOM" and "singapore"
   all find "Meeting room".)
2. **AC2:** Characters are matched literally. `%`, `_` and `\` are not wildcards;
   a comma, parenthesis, period, colon or double quote neither errors (no 500) nor
   changes what else is filtered. `*` too, by the re-check (review D3).
3. **AC3:** The other filters behave as before: min capacity, the From/To window
   (SCRUM-130, SCRUM-484), Include retired (SCRUM-185), and a blank box means no
   text filter.
4. **AC4:** The box says what it searches: placeholder "Venue name or location".

## Layers

| Short | File |
|---|---|
| helper | `backend/tests/http/likePattern.test.js` |
| service | `backend/tests/services/venueService.test.js` (supabase mocked; asserts the builder calls) |
| validation | `backend/tests/validation/venueValidation.test.js` |
| route | `backend/tests/routes/venues.test.js` (supertest; real service, mocked client) |
| fe-service | `frontend/tests/services/venueService.search.test.js` |
| page | `frontend/tests/components/VenueSearch.test.jsx` |
| live | `backend/scripts/check-venue-search-text.js`, `npm run venue-search:check` (read-only, the shared project) |

## Rules the cases depend on

- **Mocked layers prove the string, not how it is read.** The helper, service and
  route cases assert the exact filter string. Only the live layer shows how
  PostgREST reads it.
- **The live oracle.** Each live text search is compared with the venues whose name
  or location contains the text, ignoring case, worked out in JavaScript from the
  full active list. "Exactly" means the same ids in the same (name) order.
- **The re-check.** After the ilike, `searchVenues` keeps a row only if its
  lowercased name or location `includes()` the lowercased `q`, before
  availability. The mocked service cases can therefore return rows that do not
  match, to stand for what the database over-matched.
- **The live fixture.** One active venue: "Meeting room", "Singapore", capacity
  200. If it changes, the preflight names what it expected.

`%s` names are `it.each`; the variants are in brackets.

## Cases

| ID | AC | Layer | Set-up → expected | Test |
|---|---|---|---|---|
| AC1-01 | AC1 | helper | `meeting room` → `%meeting room%`; one column → no separator | `SCRUM592_AC1_plain_text_is_wrapped_for_contains`, `SCRUM592_AC1_a_single_column_has_no_separator` |
| AC1-02 | AC1 | helper | `meeting` → `name.ilike."%meeting%",location.ilike."%meeting%"` | `SCRUM592_AC1_matches_each_column_with_one_quoted_value` |
| AC1-03 (trap) | AC1 | service | `q: 'meeting'` → one `.or()` with that string, and no `ilike('location', …)` | `SCRUM592_AC1_q_filters_name_or_location_in_one_or_and_never_location_alone` |
| AC1-04 | AC1 | service, validation | `'  MEETING ROOM '` is trimmed, its case kept, and matched by ilike; q is kept beside location and capacity | `SCRUM592_AC1_q_is_trimmed_and_its_case_is_left_to_ilike`, `SCRUM592_AC1_trims_q_and_keeps_it_beside_location_and_capacity` |
| AC1-05 | AC1 | route | `?q=meeting%20room` reaches the `.or()` | `SCRUM592_AC1_passes_q_through_to_a_name_or_location_filter` |
| AC1-06 | AC1 | fe-service, page | Typing in the box sends `{ q, minCapacity }`, and `q` is sent as `q` | `SCRUM592_AC1_a_dateless_search_sends_exactly_q_and_minCapacity_with_no_date_keys`, `SCRUM592_AC1_q_is_sent_as_q_beside_the_other_filters` |
| AC1-07 | AC1 | page | `?q=hall` seeds the box and searches once; `?location=Level` neither seeds nor searches | `SCRUM592_AC1_q_in_the_url_seeds_the_box_and_searches_once_on_mount`, `SCRUM592_AC1_location_in_the_url_neither_seeds_nor_searches` |
| AC1-08 | AC1 | live | `meeting`, `MEETING ROOM`, `singapore` each include "Meeting room"; `location: 'meeting'` does not | live checks 3 to 6 |
| AC2-01 | AC2 | helper | `%` → `%\%%`, `_` → `%\_%`, `\` → `%\\%`; `50%_"x\.` → `%50\%\_"x\\.%` | `SCRUM592_AC2_escapes_%s` (a_percent_sign, an_underscore, a_backslash), `SCRUM592_AC2_escapes_a_mix_in_one_pass` |
| AC2-02 | AC2 | helper | `"`, `,`, `(`, `)`, `.`, `:` pass through LIKE untouched | `SCRUM592_AC2_leaves_%s_alone_since_LIKE_gives_it_no_meaning` (a_double_quote, a_comma, parentheses, a_period, a_colon) |
| AC2-03 | AC2 | helper | Inside the quotes: `,`, `()`, `.`, `:` are quoted; `"`, `\`, `%`, `_` get their backslashes; the mix → `"%50\\%\\_\"x\\\\.%"` | `SCRUM592_AC2_quotes_%s_so_it_is_not_list_syntax`, `SCRUM592_AC2_escapes_%s_inside_the_quotes`, `SCRUM592_AC2_escapes_a_mix_through_both_layers` |
| AC2-04 | AC2 | service | The mix reaches `.or()` escaped through both layers; `location: '50%_\'` reaches `ilike` as `%50\%\_\\%` | `SCRUM592_AC2_q_is_escaped_for_LIKE_and_for_the_or_list`, `SCRUM592_AC2_location_is_escaped_for_LIKE_too` |
| AC2-05 | AC2 | validation | q keeps every character; the service escapes them | `SCRUM592_AC2_keeps_every_character_of_q_for_the_service_to_escape` |
| AC2-06 (trap) | AC2 | validation, service, route | A repeated `?q=a&q=b` (an array) or a number → 400 `{ field: 'q', message: 'must be text' }`, before any query | `SCRUM592_AC2_rejects_a_q_that_is_%s_naming_q`, `SCRUM592_AC2_q_that_is_%s_is_refused_before_any_network_call` (an_array, a_number), `SCRUM592_AC2_a_repeated_q_answers_400_naming_q` |
| AC2-07 | AC2 | route | `?q=a%2Cb%20(x)` decodes into one quoted value | `SCRUM592_AC2_a_url_encoded_comma_and_parentheses_stay_inside_the_quoted_value` |
| AC2-08 (trap) | AC2 | live | `_` and `%` (as q and as location) return exactly the venues containing them: 0 of 16, where `_` used to match all | live checks 7, 8, 20, 21 |
| AC2-09 | AC2 | live | `a,b`, `(x)`, `a.b`, `x:y`, `"`, `\` each resolve and return exactly the venues containing them; `(`, `)`, `,`, `-`, found in live names and locations, return 2, 2, 12 and 2 venues, exactly | live checks 10 to 19 |
| AC2-10 | AC2 | helper | `*` is left as typed in the pattern: PostgREST reads it as `%` and no escape survives, so the re-check handles it (D3) | `SCRUM592_AC2_leaves_an_asterisk_in_the_pattern_for_the_post_filter` (renamed; was `…_leaves_an_asterisk_as_typed_the_known_limit`) |
| AC2-11 (trap) | AC2 | service | The database answers `Room 3*` and `Hall A` for `q: '*'` → only `Room 3*` | `SCRUM592_AC2_an_asterisk_matches_only_venues_that_contain_one` |
| AC2-12 (trap) | AC2 | service, live | A dated `q: '*'` search: the row without a `*` is dropped before `available_venue_ids`, which is asked only about the real match; live, `q: '*'` returns 0 of 16, as many as contain a `*` | `SCRUM592_AC2_rows_the_database_over_matched_are_dropped_before_availability`; live check 9 |
| AC3-01 | AC3 | service | q, location and minCapacity all apply (`.or`, `ilike`, `gte`) | `SCRUM592_AC3_q_location_and_minCapacity_all_apply` |
| AC3-02 (trap) | AC3 | service, route, validation | A blank, whitespace or null q sends exactly the default query's builder calls | `SCRUM592_AC3_q_that_is_%s_sends_exactly_the_default_query` (an_empty_string, whitespace_only, null), `SCRUM592_AC3_a_blank_q_searches_exactly_as_no_q`, `SCRUM592_AC3_drops_a_q_that_is_%s_rather_than_failing_the_search` |
| AC3-03 | AC3 | service | A dated search with q asks `available_venue_ids` only about the venues q matched | `SCRUM592_AC3_a_dated_search_asks_availability_only_about_the_venues_q_matched` |
| AC3-04 | AC3 | service | q with includeRetired keeps the retired branch (`retired_at` selected, no `is`) | `SCRUM592_AC3_q_with_includeRetired_keeps_the_retired_branch` |
| AC3-05 | AC3 | fe-service, page | A blank or absent q sends no `q` key; an empty form sends `{ q: undefined, minCapacity: undefined }`; `location` is still sent when given | `SCRUM592_AC3_a_blank_or_absent_q_sends_no_q_key`, `SCRUM592_AC3_a_search_with_nothing_filled_in_sends_undefined_q_and_minCapacity_only`, `SCRUM592_AC3_location_is_still_sent_when_given` |
| AC3-06 | AC3 | live | `q: 'meeting'` with minCapacity 201 excludes "Meeting room"; with 200, includes it | live checks 22, 23 |
| AC4-01 | AC4 | page | The box's placeholder is "Venue name or location", and there is no "Location" box | `SCRUM592_AC4_the_box_says_it_searches_the_venue_name_or_location` |
| AC4-02 | AC4 | page | The box is a textbox named "Venue name or location", and Min capacity a spinbutton named "Min capacity" (aria-labels, D5) | `SCRUM592_AC4_the_box_has_an_accessible_name` |

## Regression: the filters AC3 keeps

These suites run with only the text key renamed. Their assertions are as strict as
before (review §5):

| Filter | Tests |
|---|---|
| The window (SCRUM-130, SCRUM-484) | the `SCRUM17_AC2_*` service, route and page tests |
| Include retired (SCRUM-185) | the `SCRUM178_AC1_*` service, route and page tests, and `venueCalendarFlow.test.jsx` |
| Location (SCRUM-111) | `filters by location, case-insensitively and as a substring`, `SCRUM15_AC2_passes_a_location_filter_through`, and the validation `location` cases, unchanged |

## Teeth checks (each broken in memory and restored)

| Break | Fails |
|---|---|
| `searchVenues` sends the text as `ilike('location', …)` again | 8: AC1-03, AC1-04 (service), AC2-04 (q), AC3-01, AC3-03, AC3-04, AC1-05, AC2-07 |
| No LIKE escape | 10: AC2-01 (4), AC2-03's four escapes, AC2-04 (2) |
| No quoting for the `or=(...)` list | 19: every case that checks a filter string built by `.or()` |
| No `includes()` re-check (fix-up) | 2: AC2-11, AC2-12 |
| (live) brief 1's design, before D3's re-check | `*`: 16 of 16 returned, 0 expected |
