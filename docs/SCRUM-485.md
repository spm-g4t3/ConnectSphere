# SCRUM-485 — Add the Event Coordinator Lead and Safety Officer Roles

**Story:** Add the Event Coordinator Lead and Safety Officer Roles — All Users
**Closing subtask:** SCRUM-513 (this document)
**Status as of 10 October 2026:** closed, with the gaps in section 4 recorded rather than hidden.
**Updated 11 October 2026:** dev merged in, bringing SCRUM-453 (the Attendee dashboard). Two AC6 tests and the counts below were updated; nothing else in this story changed.

This document is the record of what SCRUM-485 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks that chain end to end for two criteria.

The case-by-case mapping is `docs/test-cases/SCRUM-485.md`: 51 cases, each naming
the test that proves it, or saying plainly that a manual check does, or that
nothing does and why. This document cites it rather than repeating it.

**The short version, for anyone asked "what can these roles do?":** nothing yet,
on purpose. This story makes the two roles exist, recognised everywhere a role is
checked, each with its own landing screen and navigation, and refused by every
gate. What each role may *do* is granted by SCRUM-486, 487, 489 and 490 (D1).

---

## Subtasks and what each delivered

| Subtask | Delivered | Where |
|---|---|---|
| SCRUM-506 | The test cases, written before any code | `docs/test-cases/SCRUM-485.md` |
| SCRUM-507 | The two roles in the database and the domain module | `backend/db/migrations/039_coordinator_lead_and_safety_officer_roles.sql`, `backend/src/domain/userRole.js`, `backend/tests/domain/userRole.test.js` |
| SCRUM-508 | Proof that both roles are admitted by `requireAuth` and refused by every gate | `backend/tests/middleware/`, the refused-role tables in `backend/tests/routes/` and `frontend/tests/auth/`, `frontend/tests/auth/equipmentRouteGuard.test.jsx`. No source change |
| SCRUM-509 | A dashboard for each role | `EventCoordinatorLeadDashboard.jsx`, `SafetyOfficerDashboard.jsx`, two entries in `Dashboard.jsx`, `frontend/tests/components/Dashboard.test.jsx`, a coverage gate in `vite.config.js` |
| SCRUM-510 | One navigation link for each role | two entries in `Navigation.jsx`, `frontend/tests/components/Navigation.test.jsx` |
| SCRUM-511 | An account for each role | Made by hand in Supabase on 10 October, under AC7 as amended (D10). No repository change |
| SCRUM-512 | The remaining tests, and the case document audited against the code | `backend/tests/routes/auth.test.js`, `frontend/tests/components/LoginForm.test.jsx`, the test-case document |
| SCRUM-513 | This document | `docs/SCRUM-485.md` |

### Verification as of 10 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm test` in `backend`) | 4570 tests passing across 85 files (after merging dev on 11 October) |
| Frontend suite (`npm test` in `frontend`) | 1861 tests passing and 1 todo across 72 files (after merging dev; the todo is SCRUM-453's, waiting on SCRUM-495); coverage thresholds met, both new dashboards at 100% |
| SCRUM-485's own tests | 94 named `SCRUM485_…`. Backend 44: `userRole.test.js` 20, `requireRole.test.js` 14, `eventRequests.test.js` 6, `requireAuth.test.js` 2, `auth.test.js` 2. Frontend 50: `Dashboard.test.jsx` 22, `Navigation.test.jsx` 15, `equipmentRouteGuard.test.jsx` 9, `venueSearchRouteGuard.test.jsx` 2, `LoginForm.test.jsx` 2 |
| Extended tables | The two roles were added to 18 existing refused-role lists, feeding 23 parametrised tests, in `backend/tests/routes/` and `frontend/tests/auth/`. They run under their original names (test-case document, AC5-09 to AC5-15) |
| PGlite | `userRole.test.js` builds a real Postgres from 007 and every migration that adds a role, and proves what the enum accepts, in CI |
| Live database | 039 applied by hand. Profile counts by role taken before and after (AC6-07). Both accounts created and walked through by hand (AC7) |
| Test-case document | 51 cases: **42** proved by a named test, **7** manually (each dated), **2** not proved |

The layers prove different things, and the difference matters under questioning.
`requireRole.test.js` proves the gate refuses both roles; the route tables prove
the gate is mounted on the routes; PGlite proves the enum, not a reading of the
migration's text; and only a query proves anything about the live database, which
has drifted from the repository once already (D5).

---

## A note on the wording below

The acceptance criteria are quoted from the Jira ticket. **AC7 was amended in Jira
on 10 October** (D10); the amended text is quoted. **AC3 cites SCRUM-92 for login,
and that number appears nowhere in this repository.** The login and role-routing
code arrived in one untagged commit, `1436093`, on 20 September; `routes/auth.js`
names SCRUM-96 and SCRUM-105. Check SCRUM-92 against Jira before the examination
rather than assert the link.

---

## 1. Acceptance criteria

| AC | Criterion (quoted) | Status |
|---|---|---|
| AC1 | Two roles are added beside the existing ones: Event Coordinator Lead and Safety Officer. Every story uses these exact names. | **Partial**: the roles are added; the backlog review of the second sentence is not done |
| AC2 | A user holds exactly one role. This replaces SCRUM-327 AC4, "a user may also hold other roles", and agrees with SCRUM-434 AC7. | **Done** |
| AC3 | Login identifies the new roles (SCRUM-92) and sends each to its own dashboard … Until those stories are built, each dashboard is a screen that says what the role will do there. | **Done** |
| AC4 | Navigation shows each role only the links for its own screens. A role never sees another role's links. | **Done** |
| AC5 | The backend refuses every route the role is not allowed to use, and the role is accepted wherever roles are checked, including the database's list of valid roles. | **Partial**: every gate refuses both roles, but three routes have no gate at all, for any role (AC5-13) |
| AC6 | Existing users and roles are unchanged. | **Done** |
| AC7 | An account for each role exists in the shared Supabase project, created the same way as every existing role's account: an auth user, plus a profiles row with the role set at creation (AC8). The repository holds no account seed data, for any role, so there is nothing to add to. | **Amended and met** |
| AC8 | There is no screen for assigning roles. They are set when the account is created, as for the existing roles. Team decision, to confirm. | **Done**; confirmed by the team on 10 October |

**Tally:** 5 done, 1 amended and met (AC7), 2 partial (AC1, AC5).

### Evidence for each criterion

| AC | Code | Proved by |
|---|---|---|
| AC1 | `ROLE.EVENT_COORDINATOR_LEAD`, `ROLE.SAFETY_OFFICER` and their labels in `userRole.js`; the h1 of each dashboard | `SCRUM485_AC1_the_two_roles_are_spelled_as_the_enum_spells_them`, `SCRUM485_AC1_the_labels_are_the_exact_names_in_the_plural` (`userRole.test.js`); `SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard`, `SCRUM485_AC3_a_safety_officer_gets_the_safety_officer_dashboard` (`Dashboard.test.jsx`). The backlog review, AC1-05, is not done |
| AC2 | `profiles.id` is the primary key, with one `role` column (007); login and `requireAuth` each read one value | `SCRUM485_AC2_a_second_role_for_the_same_account_is_refused` (PGlite, 23505); `SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back` (`auth.test.js`); `SCRUM485_AC5_admits_%s_and_puts_the_exact_role_on_the_request` (`requireAuth.test.js`) |
| AC3 | `POST /api/auth/login` returns `profiles.role` unchanged; `LoginForm` navigates to `/dashboard`; `DASHBOARD_BY_ROLE` has `EVENT_COORDINATOR_LEAD` and `SAFETY_OFFICER` | Section 2 |
| AC4 | `NAV_LINKS_BY_ROLE` has one entry for each new role, Dashboard (since SCRUM-486, SCRUM-519, the Lead also has Unassigned Queue) | `SCRUM486_AC6_an_event_coordinator_lead_has_exactly_the_dashboard_unassigned_queue_and_assigned_events_links` (was `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_and_unassigned_queue_links` (renamed in SCRUM-486, 12 October: the Lead gained Assigned Events); before that `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_link`, renamed by SCRUM-519 when the link was added), `SCRUM485_AC4_a_safety_officer_has_exactly_the_dashboard_link`, `SCRUM485_AC4_%s_sees_no_link_from_any_other_role`, `SCRUM485_AC4_a_lead_sees_none_of_the_coordinators_links` (`Navigation.test.jsx`) |
| AC5 | 039; `requireAuth` (no role list); `createRequireRole` (`allowed.includes`) | Section 2 |
| AC6 | 039 appends and removes nothing; no existing entry in `ROLE`, `DASHBOARD_BY_ROLE` or `NAV_LINKS_BY_ROLE` changed | `SCRUM485_AC6_the_enum_holds_the_five_then_the_two_in_that_order`, `SCRUM485_AC6_the_five_existing_roles_and_their_labels_are_unchanged` (`userRole.test.js`); `SCRUM485_AC6_%s_still_gets_the_%s`, `SCRUM485_AC6_an_attendee_gets_the_attendee_dashboard_scrum485_left_it_as_scrum453_built_it` (`Dashboard.test.jsx`); `SCRUM485_AC6_%s_keeps_exactly_its_links`, `SCRUM485_AC6_an_attendee_keeps_the_links_scrum453_gave_it` (`Navigation.test.jsx`). The two Attendee cases pin what SCRUM-453 built, since 11 October; before then they pinned that the Attendee had no dashboard and no links; every existing test still passing; the live profile counts before and after (AC6-07) |
| AC7 | No code: an auth user and a `profiles` row per role, made in Supabase | AC7-01 (live check), AC7-03 and AC7-04 (walkthroughs, 10 October); AC7-02 by `SCRUM485_AC5_a_profile_can_hold_%s` and `SCRUM485_AC5_a_misspelt_role_is_refused_by_the_enum` (PGlite) |
| AC8 | Nothing: every `from('profiles')` in `backend/src` is a read, and App.jsx has no role screen | AC8-01 and AC8-02, reviews dated 10 October |

---

## 2. Traceability

Two criteria, chosen because each takes a different path:

- **AC5** — its two halves pull against each other, and how they were reconciled
  is a judgement (D2). It is also the criterion with the one open gap.
- **AC3** — the one that crosses every layer: the enum, login, the router and the
  screen.

### AC5 — refused where it is not allowed, recognised everywhere roles are checked

**Criterion:** "The backend refuses every route the role is not allowed to use,
and the role is accepted wherever roles are checked, including the database's
list of valid roles."

**How the two halves were read** (D2): *accepted* means **recognised**: the
database stores the role, `requireAuth` admits it, `isKnownRole` and `roleLabel`
know it. *Refuses every route the role is not allowed to use* means **permitted
nowhere yet**, because no story has granted either role anything.

**Test cases, recognised**

| Case | Test | Proves |
|---|---|---|
| AC5-01 | `SCRUM485_AC5_039_adds_the_two_values_and_nothing_else` | 039's statements, comments aside, are exactly the two `add value` lines |
| AC5-02 | `SCRUM485_AC5_running_039_again_changes_nothing` | `if not exists`: a second run is a no-op, on a real Postgres |
| AC5-03, AC5-04 | `SCRUM485_AC5_a_profile_can_hold_%s`, `SCRUM485_AC5_a_misspelt_role_is_refused_by_the_enum` | The built enum accepts both and refuses `event_coordinator_leader` with 22P02 |
| AC5-05 | `SCRUM15_AC2_the_javascript_roles_match_the_sql_enum`, `SCRUM485_AC5_the_parse_finds_039_and_reads_no_comment_as_a_role`, `SCRUM485_AC5_the_javascript_roles_are_exactly_what_the_built_enum_holds` | `ROLE` equals what the migrations declare, all of them, not 007 alone (D6) |
| AC5-06 | `SCRUM485_AC5_%s_is_a_known_role_with_its_own_label` | `isKnownRole` true, a label, never `'another role'` |
| AC5-07 | `SCRUM485_AC5_admits_%s_and_puts_the_exact_role_on_the_request` | `requireAuth` admits both, with the exact string |

**Test cases, refused**

| Case | Test | Proves |
|---|---|---|
| AC5-08 | `SCRUM485_AC5_the_coordinator_gate_refuses_%s` | `requireRole(ROLE.EVENT_COORDINATOR)` refuses `event_coordinator_lead`: 403, `next` not called, "restricted to Event Coordinators". The prefix is shared; the match is not |
| AC5-08 to AC5-12 | `SCRUM485_AC5_the_%s_gate_refuses_%s` | The same for every gate the routes build: Venue Staff, Technical Support, and the two two-role gates |
| AC5-09 | `SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing` (`eventRequests.test.js`) | Sampled on `GET /queue`, `GET /coordinators`, `POST /:id/start-review`, with nothing queued, so a query past the gate would fail |
| AC5-09 to AC5-12 | 18 refused-role lists, extended | The gates are mounted where they should be. Names in the test-case document |
| AC5-14, AC5-15 | `SCRUM485_AC5_sends_%s_to_unauthorized_from_venue_search`, `SCRUM485_AC5_sends_%s_from_%s_to_unauthorized`, and the extended guard tables | The screens agree: `ProtectedRoute` sends both roles to `/unauthorized` |
| AC5-13 | none | **Not proved.** Section 4 |

**Production code, top to bottom**

1. `profiles.role`, of type `user_role`: 007 created it with five values; 039
   appends `event_coordinator_lead` and `safety_officer`.
2. `requireAuth` (`middleware/requireAuth.js`) reads the caller's role from
   `profiles` on every request and sets `req.user.role` to it. It keeps no list
   of roles, so it needed no change to admit the new ones; it refuses only an
   account with no profile (403, "Your account has no role assigned").
3. `createRequireRole(...allowed)` (`middleware/requireRole.js`) answers
   `allowed.includes(req.user.role)`, an exact match, and refuses with 403
   naming the role that would work, before the handler and so before any query.
4. Every role-gated route builds its gate from that one factory: `coordinatorOnly`,
   `venueStaffOnly`, `technicalSupportOnly`, `internalReaders`, `activeReaders`.
   None names either new role, so both are refused everywhere a gate stands.
5. `domain/userRole.js`: `ROLE` and `ROLE_LABEL`, so a refusal reads "restricted
   to Event Coordinators" and `roleLabel` knows the two new roles.

**No source file changed for AC5.** The brief for SCRUM-508 said so in advance:
if the change needed `src/`, something was granting an ability. Nothing did.

**Likely follow-ups.** "Why can't the Lead see the review queue?" (D1). "Isn't
'accepted wherever roles are checked' violated by every 403?" (D2). "Did you test
every route?" No: per gate, with each gate sampled on its routes (D11). "Then why
is AC5 partial?" Three Organiser routes have no gate for anyone (section 4).

### AC3 — login sends each new role to its own dashboard

**Criterion:** "Login identifies the new roles (SCRUM-92) and sends each to its own
dashboard: the Lead to the unassigned queue and coordinator overview …, the
Safety Officer to the safety review list. Until those stories are built, each
dashboard is a screen that says what the role will do there."

**Test cases**

| Case | Test | Proves |
|---|---|---|
| AC3-01, AC3-02 | `SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back` (`auth.test.js`) | Login returns `user.role` as exactly `event_coordinator_lead` or `safety_officer` |
| AC3-03 | `SCRUM485_AC3_logging_in_as_%s_goes_to_the_dashboard` (`LoginForm.test.jsx`) | The real App, from `/login`: the form submits, the path becomes `/dashboard`, and the role's own h1 appears |
| AC3-04, AC3-05 | `SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard`, `SCRUM485_AC3_a_safety_officer_gets_the_safety_officer_dashboard` | Each role's page, its section headings and the story that will fill each |
| AC3-06 | `SCRUM485_AC3_%s_never_sees_no_dashboard_available` | The silent failure a misspelt key produces does not happen |
| AC3-07 | `SCRUM485_AC3_a_lead_does_not_get_the_coordinator_dashboard` | The Lead does not land on the Coordinator's page |
| AC3-08 | `SCRUM485_AC3_the_%s_dashboard_calls_no_service` | No HTTP call (mocked `apiClient`) and no stub service call |
| — | `SCRUM485_AC3_the_role_spelt_%j_reaches_the_%s_dashboard` | Six spellings, `'Safety Officer'` and `'safety-officer'` among them, reach the right page |
| AC7-03, AC7-04 | walkthroughs, 10 October | The same against the live project with the two real accounts |

Misspelling `SAFETY_OFFICER` as `SAFETY_OFFICERS` in `DASHBOARD_BY_ROLE` was tried
and fails six of these tests, then restored.

**Production code, top to bottom**

1. `POST /api/auth/login` (`routes/auth.js`, SCRUM-96): signs in, reads
   `profiles.role` with `.single()`, returns `{ user: { id, email, role } }`. No
   role list, so no change.
2. `AuthContext.login` stores that user in sessionStorage; `LoginForm` then
   `navigate("/dashboard")`, the same for every role. No change.
3. `/dashboard` in `App.jsx` is behind `ProtectedRoute` with no `allowedRoles`:
   any signed-in user. No change.
4. `Dashboard.jsx`: `DASHBOARD_BY_ROLE[normaliseRole(user.role)]`. `normaliseRole`
   uppercases and turns spaces and hyphens into underscores, so
   `event_coordinator_lead` becomes `EVENT_COORDINATOR_LEAD`. **The change:** two
   entries, keyed exactly that way.
5. `EventCoordinatorLeadDashboard` and `SafetyOfficerDashboard`: an h1 naming the
   role, a section per future feature, a sentence in each saying what will appear
   and which story builds it (D7).

**Manual verification:** done on 10 October (AC7-03, AC7-04). Each account lands
on its own dashboard with one nav link; a Lead opening `/review-queue` by URL sees
"Not available to your role".

**Likely follow-ups.** "Why does the Lead's page show nothing?" (D7). "What will
the unassigned queue hold?" Nothing as things stand (section 5, question 1).
"Where does SCRUM-92 come in?" Not traceable in the repository; see the note above.

---

## 3. Design decisions

Each is stated as the argument, because that is what will be asked for.

### D1. The Lead inherits nothing from Event Coordinator

**An Event Coordinator Lead can do nothing an Event Coordinator can.** That is
deliberate. Roughly twenty places match `event_coordinator` exactly: five SQL
files (014's booking notifications and coordinator backfill, 015's
`pick_event_coordinator` twice, 018's `reassign_event_request`, 033), nine uses of
`ROLE.EVENT_COORDINATOR` in `backend/src` (the `coordinatorOnly` gates among
them), five `allowedRoles` gates in `App.jsx`, and `RETIRED_SEARCH_ROLES` in
`VenueSearch.jsx`. None of them changed.

The ticket's own design decision is the reason: "This story only creates the
roles. What each role may do is stated in the story that gives it that ability,
so a permission is never defined in two places." SCRUM-486, 487, 489 and 490 each
grant a role what it needs, where the need is argued. Had this story let the Lead
through `coordinatorOnly`, it would have granted every coordinator ability at
once, deciding requests and handing events over included, before any story said
the Lead should have them. Then, when SCRUM-486 defined what a Lead may do, the
permission would exist in two places, and the second could not narrow the first.

It is also why the Lead is a role of its own rather than a flag on a coordinator:
"Lead" is not a kind of coordinator in the code, and no prefix matching could make
it one (`event_coordinator_lead` begins with `event_coordinator`, but every
comparison is of the whole value).

### D2. AC5's two halves: "recognised" and "permitted nowhere yet"

AC5 says the role is "accepted wherever roles are checked" and that the backend
"refuses every route the role is not allowed to use". Read the first literally,
as *admitted by every role check*, and both roles would pass every gate: exactly
the permission-in-two-places D1 rules out, and the opposite of the second half.
So the first half is read as **recognised**: the enum stores the role,
`requireAuth` admits it, `isKnownRole` and `roleLabel` know it, and a gate that
names it lets it through (`SCRUM485_AC5_a_gate_that_names_%s_lets_it_through`
proves the gate would, though no route builds one yet). The second half is read
as **permitted nowhere yet**. Both readings are tested, and they do not
conflict.

### D3. One role per account (AC2)

AC2 supersedes SCRUM-327 AC4, which in Jira read: "Only users holding the Event
Coordinator role can be assigned. A user may also hold other roles." Nothing in
the codebase ever assumed more than one: `profiles.id` is the primary key, there
is a single `role` column, no join table, and every reader takes one value
(`routes/auth.js` with `.single()`, `requireAuth`, `user.role` on the frontend).
So AC2 **records the schema rather than changing it**, and its proof is the
schema refusing a second row (23505). A Lead holding both the Lead and the
Coordinator role, which would have been one way to grant coordinator abilities,
is not possible.

### D4. A migration appends; it never edits 007

039 adds the two values with `alter type user_role add value if not exists`.
Three reasons not to edit 007 instead:

- **Migrations are append-only.** 001's header states the rule, and 007's own
  header says "To add a value later: alter type user_role add value 'x'".
- **Editing 007 would change nothing on the live database.** 007 creates the enum
  only `if not exists`. The live enum existed before 007 was written, so 007's
  create statement never ran there, and a value added to its list would never
  arrive.
- **The precedent is already live.** The live enum holds a sixth value 007 never
  declared, so `add value` has been applied to it before, successfully.

039 contains **only** the two statements. Postgres refuses to use an enum value
in the transaction that added it, and the SQL Editor runs a script as one
transaction, so an insert, a seed or a function naming the new values in the same
file would fail. 027 makes the same point for `booking_status`.
`SCRUM485_AC5_039_adds_the_two_values_and_nothing_else` pins it.

### D5. The dead `technical_support` stays, and is not a broken role

A query on 10 October found the live enum holding `technical_support` beside
`technical_support_staff`, and no profile using it. Every Technical Support user
holds `technical_support_staff`, which is what the code checks, so those routes
work. The "role-key mismatch" in `docs/SCRUM-327.md` and the headers of 014 and
015 describes a dead enum entry, not a broken role. It stays because Postgres
cannot drop an enum value without recreating the type, and recreating `user_role`
would mean redefining every function that names a role, for no change in
behaviour. 039's header records all of this so the next audit does not repeat
it. `ROLE` does not list it, and `isKnownRole('technical_support')` is false
(`SCRUM485_AC5_isKnownRole_refuses_%s`).

### D6. The JavaScript list is checked against every migration, not 007 alone

`userRole.test.js` used to read only 007's `create type` block and assert five
roles. After 039 that would have been wrong twice over, and a third role added
later would have been invisible to it. It now reads 007's created values plus
every `alter type user_role add value` in any migration, with comments stripped
first (007's own comment contains `add value 'x'`), and builds a PGlite database
from the same files to compare `ROLE` with what Postgres actually holds. Its
header records what it still cannot see: the live enum, which only a query
checks.

### D7. The placeholder dashboards are honest, not fake

AC3 asks, until the real features exist, for "a screen that says what the role
will do there". Each dashboard has the real section structure (Unassigned queue
and Coordinator overview; Safety review list), and each section holds one
sentence: what will appear there, and which story builds it. No invented rows,
counts or names, because a placeholder that looks like data is read as data. **No
API call** (`SCRUM485_AC3_the_%s_dashboard_calls_no_service`): there is no endpoint
behind either, and a call to one that does not exist would log errors at every
demo. **No link**, because App.jsx has no route for any section yet. The Lead's
page is not the Coordinator's page with a different title (D1).

### D8. One navigation link each, and why a link to an unbuilt route is worse than none

Each new role's nav is exactly Dashboard. A link to a route that does not exist
still renders, is clickable, and lands on the catch-all redirect back to
`/dashboard`: it promises a page and delivers another, with nothing to say why.
None is better. SCRUM-486 and 487 (the Lead) and SCRUM-490 (the Safety Officer)
add each link with its route, and the exact-count tests
(`SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_link`, `SCRUM485_AC4_a_safety_officer_has_exactly_the_dashboard_link`) make them update the expectation
when they do. They did: SCRUM-519 added the Lead's Unassigned Queue link with its route, and the Lead's case is now `SCRUM486_AC6_an_event_coordinator_lead_has_exactly_the_dashboard_unassigned_queue_and_assigned_events_links` (was `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_and_unassigned_queue_links` (renamed in SCRUM-486, 12 October: the Lead gained Assigned Events)).

The cross-role test reads every other role's links by **rendering** that role's
nav, not from `NAV_LINKS_BY_ROLE`: the map is not exported, because an object
export from a component file fails the project's
`react-refresh/only-export-components` rule. Reading what renders is the
stronger test in any case.

### D9. The plural labels, and AC1's "exact names"

`ROLE_LABEL` has `'Event Coordinator Leads'` and `'Safety Officers'`. AC1 asks for
the exact names, "Event Coordinator Lead" and "Safety Officer". The label's one use
is the 403 message "This action is restricted to …", which names a group, and
every existing label is plural in that form (`'Event Coordinators'`,
`'Event Organisers'`). So the names are exact, and the label is the name in the
form the message needs. Where the role is named on its own, on each dashboard's
h1, it is singular and exact.

### D10. AC7 amended rather than met by building a seed

**A process decision as much as a design one, and the one most likely to be
questioned.** AC7 first read: "Test accounts for both roles are added to the seed
data used for demos and tests." No account seed data exists in this repository or
ever has. The only seed is `backend/db/seeds/equipment.js`, and the check scripts
create accounts they delete again. Every demo account for the four existing roles
was made by hand in Supabase. So AC7 assumed something that did not exist.

There were two ways forward: build the project's first account seed inside a
story about adding two roles, or create the two accounts the way every other
role's was. The first would have put a new piece of infrastructure, with its own
questions (where credentials live, whether it runs against the shared project,
how it avoids duplicates), into a story that is about roles, and made these two
roles the only ones a seed could recreate. The second matches AC8 exactly: roles
"are set when the account is created, as for the existing roles". The team chose
the second and amended AC7 in Jira on 10 October to say what was actually done.

The amendment does not hide the underlying gap: nobody can rebuild the demo
database from the repository, for any role. That is the team's gap, recorded in
section 4, not this story's to close.

### D11. Proof per gate, not per route

Every role-gated route builds its gate from `createRequireRole`. So the proof that
both roles are refused on every `coordinatorOnly` route is one test of the gate,
`SCRUM485_AC5_the_coordinator_gate_refuses_%s`, and it covers a route added later
behind the same gate without anyone writing a new test. The route suites then
**sample** each gate, to prove it is mounted; existing refused-role tables were
extended with the two roles rather than duplicated. The consequence, stated
plainly: not every route has a route-level test with these roles. The test-case
document names which do.

---

## 4. Known gaps and follow-ups

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC1-05 not done | "Every story uses these exact names" is a rule about the backlog. No one has yet reviewed SCRUM-486, 487, 489, 490, 434 and 444 for the names | The team, at sprint review |
| AC5-13: three Organiser routes with no role gate | `POST /api/event-requests`, `PATCH /:id`, `POST /:id/submit` have no `requireRole`; `assertOrganiser` only checks a user id is present. Any signed-in user, the new roles included, creates and submits a request as its Organiser. True of Venue Staff and Technical Support today too | Its own ticket (open question 2). Gating them changes what existing roles can do, which runs into AC6 |
| `/events` reachable by any role | The Organiser's list and create form are behind login only, with no `allowedRoles`, so the same gap is open on the screen | With AC5-13 |
| Three placeholder pages reachable by any role | `/booking-requests`, `/tickets`, `/equipment` are login-only. They render only text and load nothing, so the harm is cosmetic, but a Lead can open Venue Staff's or Technical Support's page by URL, against AC4's spirit | Follow-up: an `allowedRoles` on each |
| `/review-queue` and `/my-events` untested for the new roles | Both share `/my-venue-requests`' gate, `["event_coordinator"]`, which is tested; neither has a guard test of its own. `/review-queue` was checked by hand (AC7-03) | Follow-up: two rows in a guard test |
| `normaliseRole` has no test of its own | AC1-03 is proved through Dashboard, Navigation and the guards, which all call it. A change to it would be caught there, but not named there | Follow-up: `frontend/tests/auth/normaliseRole.test.js` |
| The nav bar shows the raw role | `Navigation.jsx` renders `{user.name} ({user.role})`, and login returns no name, so a Lead sees "(event_coordinator_lead)": the enum value, not AC1's name. True of every role | Follow-up, with the long-standing missing name |
| The demo database cannot be rebuilt from the repository | Every role's demo account, these two included, exists only in Supabase. The team's gap, not this story's (D10) | The team |

### Technical debt, including what this story inherited

| Item | Detail |
|---|---|
| Migration-number collisions | Eight numbers are used by two files each: 005, 014, 015, 016, 017, 022, 023, 030. 039 adds none. The number alone does not give an order to apply files in |
| `technical_support` described as a live bug | `docs/SCRUM-327.md` and the headers of 014 and 015 still call it a role-key mismatch. A query on 10 October showed it is a dead enum value no profile uses (D5). 039's header records the correction; those three do not. 014 and 015 are applied and append-only, so they stay; `docs/SCRUM-327.md` can be corrected |
| SCRUM-327's AC4 recorded wrongly | `docs/SCRUM-327.md` reconstructs its AC4 as resubmission returning an event to its previous coordinator. Jira's AC4, which AC2 supersedes, is the one quoted in D3. That document says its AC3 and AC4 wording was inferred; it should now be corrected from Jira |
| "Token" in comments that mean the login response | `normaliseRole.js`, `Dashboard.jsx`, `Navigation.jsx` and `Navigation.test.jsx` say the role comes from a token or a JWT claim. It comes from the body of `POST /api/auth/login`, stored in sessionStorage. Harmless, but wrong under questioning |
| `Dashboard.jsx`'s signed-out branch is untested | Its "Loading..." return is the one line `Dashboard.test.jsx` does not reach (87.5% lines). The file is shared, so it is not gated |

### Process notes

Stated plainly, because it will be asked.

- **The cases came first.** SCRUM-506 (`f49c34c`) wrote all 51 cases before any
  code, each marked "not yet written".
- **SCRUM-507's tests came with the change**, in the same commit (`c9b6434`) as
  039 and `userRole.js`. The rewrite of `userRole.test.js` was the substance of
  that subtask, not an afterthought.
- **SCRUM-508's tests were written against gates that already existed.** No
  source changed. They are proofs of existing behaviour for two new inputs, which
  is what AC5's refusal half needed.
- **The dashboard and navigation tests were written after their components**, in
  SCRUM-509 (`eca287e`) and SCRUM-510 (`5ba2ea1`). They were checked for teeth
  afterwards: misspelling each new key fails them (six failures for the dashboard
  key, three for each nav key), and the keys were restored.
- **SCRUM-512's tests cover code that predates the story**: login, and
  `LoginForm`, which had no tests at all.
- **The case document was audited against the code** in SCRUM-512, and corrected
  where it had promised something the tests do not do (three planned test files
  never created, two lists of spellings that did not match, per-route claims that
  are per-gate). The test-case document records each.

---

## 5. Open questions for the team

Carried from the test-case document, with the first promoted because it is the
next story's first problem.

1. **Answered by SCRUM-486 (12 October 2026):** migration 052 relaxed the constraint
   and took the pick out of submission, in one file, as this question asked
   (`docs/SCRUM-486.md`, D1). As written at the time: **The Lead's unassigned queue can never hold anything.** Since SCRUM-330 every
   request is assigned a coordinator at submission (`submit_event_request`, 016),
   and a submission with no coordinator available is refused and stays a draft.
   So no request is ever submitted and unassigned. And the database forbids it:
   `017_require_assigned_coordinator.sql` adds the CHECK constraint
   `event_requests_assigned_when_submitted`, `status in ('draft', 'cancelled') or
   assigned_coordinator_id is not null`. SCRUM-486's first criterion, as the team
   has described it, removes the automatic pick so that the Lead assigns; that
   requires a submitted request with no coordinator, which is exactly what 017's
   constraint refuses. Before the queue SCRUM-486 builds can show a single row,
   that story needs a migration that changes the constraint (and a decision about
   015's selection rule and 016's call to it). **Write that into SCRUM-486 before
   it starts.**
2. **Should the Organiser's own routes be role-gated?** AC5-13, `/events` and the
   placeholder pages (section 4). Gating changes what existing roles can do.
3. **Answered by SCRUM-486 (12 October 2026): no.** The team decided on 11 October
   that the Lead supervises and is not assigned events (`docs/SCRUM-486.md`, D5). As
   written at the time: **Can the Lead also be assigned events?** Still open. The Week 7 brief says the
   Lead views "all coordinator assignments and active events under their
   supervision", which reads as supervision rather than a caseload, but that is an
   inference. It decides whether 015 may ever pick a Lead, and whether a Lead
   appears in SCRUM-486's picker. As of this story, a Lead is refused
   `GET /api/event-requests/coordinators` like any non-coordinator.
4. **AC8 still reads "Team decision, to confirm".** It was confirmed on 10 October;
   the ticket should say so.
5. **Were SCRUM-434 and SCRUM-444 updated?** The ticket's notes on scope say they
   are. Neither is in this repository, so nothing here checks it.

---

## Before the examination

- **Check SCRUM-92 in Jira** and record what it is, or drop the reference.
- **Do AC1-05**: read SCRUM-486, 487, 489, 490, 434 and 444 for the exact names.
- **Be ready for "why can't the Lead do anything?"** D1, in two sentences: this
  story creates the roles; the stories that need each ability grant it, so no
  permission is defined twice.
- **Be ready for "why did you change the AC?"** D10: AC7 assumed seed data that
  has never existed; the accounts were made the way every other role's was, which
  is what AC8 already says.
