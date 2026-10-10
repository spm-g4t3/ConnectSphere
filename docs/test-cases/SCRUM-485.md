# SCRUM-485 — Test Cases

**Story:** Add the Event Coordinator Lead and Safety Officer Roles — All Users
**Subtask:** SCRUM-506 (this document)
**Schema:** `039_coordinator_lead_and_safety_officer_roles.sql`, adding two values to the `user_role` enum from `007_user_roles.sql` (applied to the live database)
**Written:** 10 October 2026, before the code (SCRUM-506).
**Updated:** 10 October 2026 (SCRUM-512): every case now names the test that proves it, read from the test files, or says plainly that a manual check proves it, or that nothing does and why.

This document is the written layer between SCRUM-485's acceptance criteria and the
Vitest files that implement them. Deliverable #3 requires test cases
traceable from user stories and acceptance criteria to tests; the chain is
**user story → acceptance criteria → test case → test class → code**, and it is
walked for a randomly chosen feature in the Week 13 Q&A.

---

## How case IDs relate to test names

As in `docs/test-cases/SCRUM-19.md`: each case has a short stable ID (`AC5-08`),
and an **Implemented by** column naming every test that proves it, read from
the test files, not invented. Tests written for this story are named
`SCRUM485_ACn_…`, so each traces back to its criterion by name alone. Where an
older table of refused roles was extended with the two new roles rather than
duplicated (SCRUM-508), its rows run under that table's original name, which
is the name given.

A case no test proves says so, in bold, and says why: **manual** (a walkthrough
or a review, with its date) or **not proved**.

`%s` in a name is a parameterised test (`it.each`); one name covers several
rows.

| Short | File |
|---|---|
| role | `backend/tests/domain/userRole.test.js`. Holds the migration-text and PGlite cases too: the plan put those in two new files, but SCRUM-507 could edit only this one, so they live here |
| reqauth | `backend/tests/middleware/requireAuth.test.js` |
| reqrole | `backend/tests/middleware/requireRole.test.js` |
| auth | `backend/tests/routes/auth.test.js` |
| booking, equip, avail, review-r, event-equip, events, venues | `backend/tests/routes/` `bookingRequests`, `equipment`, `equipmentAvailability`, `equipmentReview`, `eventEquipment`, `eventRequests`, `venues` `.test.js` |
| dash | `frontend/tests/components/Dashboard.test.jsx` |
| nav | `frontend/tests/components/Navigation.test.jsx` |
| login | `frontend/tests/components/LoginForm.test.jsx` |
| guard | `frontend/tests/auth/`: `myVenueRequestsRoute`, `venueCalendarRoute`, `venueCatalogueRouteGuard`, `venueSearchRouteGuard`, `equipmentRouteGuard` `.test.jsx` |

The plan named a `normaliseRole.test.js`. It was never written; AC1-03 says what
proves that case instead.

---

## The story

> **USER STORY:** As a user holding the Event Coordinator Lead or Safety Officer
> role, I want to log in and land on a screen for my responsibilities, so that I
> only see and do what my role allows.

### Acceptance criteria

Quoted from the ticket.

1. Two roles are added beside the existing ones: Event Coordinator Lead and
   Safety Officer. Every story uses these exact names.
2. A user holds exactly one role. This replaces SCRUM-327 AC4, "a user may also
   hold other roles", and agrees with SCRUM-434 AC7.
3. Login identifies the new roles (SCRUM-92) and sends each to its own
   dashboard: the Lead to the unassigned queue and coordinator overview (stories
   on assigning coordinators and viewing every coordinator's events), the Safety
   Officer to the safety review list. Until those stories are built, each
   dashboard is a screen that says what the role will do there.
4. Navigation shows each role only the links for its own screens. A role never
   sees another role's links.
5. The backend refuses every route the role is not allowed to use, and the role
   is accepted wherever roles are checked, including the database's list of
   valid roles.
6. Existing users and roles are unchanged.
7. Test accounts for both roles are added to the seed data used for demos and
   tests.
8. There is no screen for assigning roles. They are set when the account is
   created, as for the existing roles. Team decision, to confirm.

### Design decisions, from the ticket

> This story only creates the roles. What each role may do is stated in the
> story that gives it that ability, so a permission is never defined in two
> places.
>
> One role per account. Whether the Lead can also be assigned events is an open
> question.

### Notes on scope, from the ticket

> SCRUM-444 and SCRUM-434 are updated to cover the two roles.

Neither ticket is in this repository, so nothing here checks that they were.

### An uncertainty about AC3

AC3 cites **SCRUM-92** for login. That number appears nowhere in this
repository: no commit message, branch, file or comment. The login and
role-routing code (`AuthContext.jsx`, `LoginForm.jsx`, `ProtectedRoute.jsx`,
`Dashboard.jsx`, `Navigation.jsx`, `backend/src/routes/auth.js`) all arrived in
one untagged commit, `1436093`, on 20 September 2026. `auth.js` names SCRUM-96
(login) and SCRUM-105 (logout) in its header. SCRUM-92 may be the parent of
those, or the role-routing work in `1436093`, but **this document does not
assert the link.** Check it against Jira before the examination.

---

## Facts established on 10 October 2026

Recorded because the cases rest on them, and because two of them correct older
documents.

**The live `user_role` enum holds six values**, read by a query against the
Supabase project:

`event_organiser`, `event_coordinator`, `venue_staff`, `technical_support`,
`technical_support_staff`, `attendee`.

**Profile counts:** `event_coordinator` 2; one each of `event_organiser`,
`venue_staff`, `technical_support_staff` and `attendee`. **No profile uses
`technical_support`.**

What follows from that:

- **`technical_support` is a dead value.** The "role-key mismatch" recorded in
  `docs/SCRUM-327.md` and in the headers of 014 and 015 is stale: it describes a
  dead enum entry, not a broken role. Every Technical Support user holds
  `technical_support_staff`, which is what `ROLE.TECHNICAL_SUPPORT_STAFF`,
  `App.jsx`, `Dashboard.jsx` and `Navigation.jsx` key on. Technical Support
  routes work.
- **007 never ran against the live database.** It declares five values and
  creates the enum only `if not exists`; the live enum already existed. So the
  repository does not describe the live vocabulary exactly, and nothing in it
  can.
- **`userRole.test.js` cannot see that drift.** It compares the JavaScript list
  with 007's *file text*, not with the live enum.
- **`alter type user_role add value` has already been applied to this database
  successfully.** That is the only way a sixth value could have arrived. It is
  the precedent the new migration follows.

**After the story, also on 10 October:** migration 039 was applied to the live
database, and two accounts were created by hand in Supabase, one per new role:
`lead@connectsphere.com` (profile role `event_coordinator_lead`, full name
"Event Coordinator Lead Test") and `safety@connectsphere.com` (`safety_officer`,
"Safety Officer Test"). There is still no account seed script; see AC7.

**The two new roles are spelled `event_coordinator_lead` and `safety_officer`,**
lowercase snake_case like every live value. `normaliseRole` turns them into
`EVENT_COORDINATOR_LEAD` and `SAFETY_OFFICER`. Neither can be confused with
`event_coordinator`, because nothing in the codebase does prefix matching:
`requireRole` uses `allowed.includes(role)`, `ProtectedRoute` compares whole
normalised keys, and the SQL uses `=`.

---

## Design decisions the cases rest on

Each is stated as the argument, because that is what is asked for.

**One role per account (AC2).** AC2 supersedes SCRUM-327 AC4, which read: "Only
users holding the Event Coordinator role can be assigned. A user may also hold
other roles." Nothing in the codebase ever assumed multiple roles. `profiles.id`
is the primary key, there is a single `role` column, there is no join table, and
every reader takes one value: `routes/auth.js` (`.select('role').single()`),
`requireAuth` (`req.user.role`), and on the frontend `user.role`. So AC2 records
the model rather than changing it, and its cases pin what is already true.
(`docs/SCRUM-327.md` records its AC4 differently, as resubmission returning an
event to its previous coordinator. That document says its AC3 and AC4 wording is
inferred, not quoted. The wording above is the ticket's.)

**No role-assignment screen (AC8).** Confirmed by the team on 10 October. The
Week 7 customer brief says nothing about how roles are created, so this fills a
silence rather than contradicting the customer. Roles are set when the account is
created, by inserting the `profiles` row, as the check scripts already do for
every existing role (`supabase.auth.admin.createUser`, then
`profiles.insert({ id, role, full_name })`). No application code writes
`profiles.role`: every `from('profiles')` call in `backend/src` is a read.

**The Lead inherits nothing from Event Coordinator.** This is the decision an
examiner is most likely to push on, so plainly: **after SCRUM-485, an Event
Coordinator Lead cannot do anything an Event Coordinator can.** Roughly twenty
places match `event_coordinator` exactly:

- five SQL functions: 014's booking notifications and coordinator backfill, 015's
  `pick_event_coordinator`, 018's `reassign_event_request`, and 033;
- nine uses of `ROLE.EVENT_COORDINATOR` in `backend/src`, the `coordinatorOnly`
  gates among them;
- five `allowedRoles` gates in `App.jsx`;
- `RETIRED_SEARCH_ROLES` in `VenueSearch.jsx`.

None of them changes here. SCRUM-485 creates the roles; SCRUM-486, 487, 489 and
490 each grant a role what it needs, in the story that needs it. That is the
ticket's own design decision: a permission is never defined in two places. If
485 let the Lead through `coordinatorOnly`, it would be granting every
coordinator ability at once, including assignment and deciding requests, before
any story has said the Lead should have them. The refusal cases in AC5 pin that
nothing leaked.

**Whether the Lead can also be assigned events: open.** The Week 7 customer brief
says the Lead views "all coordinator assignments and active events under their
supervision". That reads as supervising coordinators rather than holding a
caseload, but it is an inference, not a statement. It decides whether the Lead
appears in SCRUM-486's assignment picker, and whether 015's selection rule should
ever pick one. Nothing here decides it; AC5-09 pins that, as of 485, the Lead is
refused `GET /api/event-requests/coordinators` like any other non-coordinator.

**A migration adds the values; it never edits 007.** Migrations are append-only
(001's header states the rule; 007's says "To add a value later: alter type
user_role add value 'x'"). The new migration runs `alter type user_role add value
if not exists` once per role, following the precedent that already put a sixth
value on the live enum. `if not exists` makes it safe to run twice. A new enum
value cannot be used in the transaction that adds it, so **the migration contains
only the two `add value` statements and nothing else**: no seed, no insert, no
function that names the new values. Nothing is removed either. Postgres cannot
drop an enum value without recreating the type, so the dead `technical_support`
stays.

**The JavaScript list follows every migration, not just 007.** `userRole.test.js`
today reads only 007's `create type user_role as enum (…)` block and asserts
`toHaveLength(5)`. After 039, both are wrong: the list has seven values, and 039
is invisible to a test that reads one file. So AC5-05 changes what the test reads
(007's created values plus every later `alter type user_role add value`) rather
than just the number. The JavaScript list then has seven values, while the live
enum has eight, the eighth being the dead `technical_support`. The test still
cannot see the live database; that limit is recorded under *What cannot be
tested*.

**Each new role gets a real dashboard and a real link, so a misspelling fails
loudly.** On the frontend an unknown role fails silently.
`NAV_LINKS_BY_ROLE[normaliseRole(user.role)] || []` gives an empty nav, and
`Dashboard.jsx` shows "No dashboard available for your role. Please contact
support." Neither throws. A role key misspelt in either map would look exactly
like a user with no role. So AC3 and AC4 pin each new role to a named dashboard
and to a link set **by exact count**. `Navigation.test.jsx` today asserts the
count only for the Organiser; AC6-04 extends that to the four other roles that
have links, so a link leaking from one role's set into another's fails a test.

**Until the abilities exist, each role's screen is a placeholder and its nav is
one link.** AC3 asks for a screen "that says what the role will do there".
Following the ticket's design decision, 485 adds no link to a page that does not
exist yet. The links for the unassigned queue, the coordinator overview and the
safety review list belong to the stories that build those pages. So each new
role's nav is exactly `Dashboard`, and the placeholder makes no API call. When
SCRUM-486, 487 and 490 land, those cases are updated in the same change, and the
count case is what forces the update.

### Shorthand for preconditions

- **LEAD** — a signed-in user whose profile role is `event_coordinator_lead`.
- **SAFETY** — a signed-in user whose profile role is `safety_officer`.
- **BOTH** — the case is run for LEAD and for SAFETY.
- **THE FOUR** — the existing roles with a dashboard: `event_organiser`,
  `event_coordinator`, `venue_staff`, `technical_support_staff`. `attendee` has
  none today, which AC6-06 pins.
- **Refused, nothing queried** — 403 from `requireRole`, and the fake Supabase
  client records no call.

---

## AC1 — two roles, with these exact names

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | — | Read `ROLE` in `domain/userRole.js` | `ROLE.EVENT_COORDINATOR_LEAD === 'event_coordinator_lead'` and `ROLE.SAFETY_OFFICER === 'safety_officer'` | role `SCRUM485_AC1_the_two_roles_are_spelled_as_the_enum_spells_them` |
| AC1-02 | — | Read `ROLE_LABEL` | `'Event Coordinator Leads'` and `'Safety Officers'`: the exact names, in the plural every existing label uses for a "restricted to …" message (`'Event Coordinators'`, `'Event Organisers'`) | role `SCRUM485_AC1_the_labels_are_the_exact_names_in_the_plural` |
| AC1-03 | — | `normaliseRole('event_coordinator_lead')`, `normaliseRole('safety_officer')` | `'EVENT_COORDINATOR_LEAD'` and `'SAFETY_OFFICER'`; neither equals `'EVENT_COORDINATOR'` | Proved through the code that uses `normaliseRole`, not by a test of it alone (no `normaliseRole.test.js` exists): dash `SCRUM485_AC3_the_role_spelt_%j_reaches_the_%s_dashboard`, `SCRUM485_AC3_a_lead_does_not_get_the_coordinator_dashboard`; nav `SCRUM485_AC4_the_role_spelt_%j_reaches_the_same_single_link`; guard `SCRUM485_AC5_sends_%s_to_unauthorized_from_venue_search`. A Lead reaching the Lead's dashboard and refused the Coordinator's pages is only possible if the key is `EVENT_COORDINATOR_LEAD` and not `EVENT_COORDINATOR` |
| AC1-04 | BOTH | Open `/dashboard` | The heading names the role exactly: "Event Coordinator Lead", "Safety Officer" | dash `SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard`, `SCRUM485_AC3_a_safety_officer_gets_the_safety_officer_dashboard` (each asserts the exact h1) |
| AC1-05 | Every story touching these roles | Read its title, ACs and docs | Uses "Event Coordinator Lead" and "Safety Officer", never a variant ("Coordinator Lead", "Lead Coordinator", "Safety Inspector") | **Not proved.** A rule about the backlog, so a review at sprint review, not a test. Not yet performed |

AC1-05 is AC1's second sentence, "Every story uses these exact names". It is a
rule about the backlog, not about the code, so it is checked at review rather
than by a test.

---

## AC2 — exactly one role per account

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | PGlite with 007 and 039; a user with a `profiles` row | Insert a second `profiles` row for the same id, with another role | 23505 (primary key); the first row unchanged | role `SCRUM485_AC2_a_second_role_for_the_same_account_is_refused` (PGlite) |
| AC2-02 | A profile with role `event_coordinator_lead` | `POST /api/auth/login` | `user.role` is the single string `'event_coordinator_lead'`, not a list | auth `SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back` (asserts `user.role` is the one string, for both roles) |
| AC2-03 | A profile with either new role | A request through `requireAuth` | `req.user.role` is that one string | reqauth `SCRUM485_AC5_admits_%s_and_puts_the_exact_role_on_the_request` |

Holding the Lead role is not also holding the Coordinator role. That is proved
by AC5-08 and AC5-09, not repeated here.

---

## AC3 — login sends each role to its own dashboard

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | A profile with role `event_coordinator_lead` | `POST /api/auth/login` with valid credentials | 200; `user.role` is `'event_coordinator_lead'` | auth `SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back` |
| AC3-02 | A profile with role `safety_officer` | The same | 200; `user.role` is `'safety_officer'` | auth `SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back` |
| AC3-03 | BOTH | Log in through `LoginForm` | Navigates to `/dashboard`, as every role does | login `SCRUM485_AC3_logging_in_as_%s_goes_to_the_dashboard`: the real App, from `/login` to `/dashboard` and that role's own h1 |
| AC3-04 | LEAD | Open `/dashboard` | The Lead's dashboard: says the role will see the unassigned queue and the coordinator overview here, once those stories are built | dash `SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard` |
| AC3-05 | SAFETY | Open `/dashboard` | The Safety Officer's dashboard: says the role will see the safety review list here, once that story is built | dash `SCRUM485_AC3_a_safety_officer_gets_the_safety_officer_dashboard` |
| AC3-06 | BOTH | Open `/dashboard` | Never "No dashboard available for your role" | dash `SCRUM485_AC3_%s_never_sees_no_dashboard_available` |
| AC3-07 | LEAD | Open `/dashboard` | Not the Coordinator's dashboard: `EventCoordinatorDashboard` is not rendered, and no coordinator service (queue, my events) is called | dash `SCRUM485_AC3_a_lead_does_not_get_the_coordinator_dashboard` (the Coordinator's page is not rendered); `SCRUM485_AC3_the_%s_dashboard_calls_no_service` (no service of any kind is called) |
| AC3-08 | BOTH | Open `/dashboard` | The placeholder makes no API call | dash `SCRUM485_AC3_the_%s_dashboard_calls_no_service` (asserted on a mocked `apiClient` and `supportService`); also `SCRUM485_AC3_the_%s_dashboard_has_no_link_to_a_page_that_does_not_exist` |

AC3-06 is the silent-failure case: a role key misspelt in `DASHBOARD_BY_ROLE`
renders the "no dashboard" message and throws nothing. AC3-04, AC3-05, AC3-07 and
AC3-08 describe placeholders and change when SCRUM-486, 487 and 490 build the
real screens.

---

## AC4 — each role sees only its own links

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | LEAD | Render `Navigation` | Exactly one link: Dashboard → `/dashboard` | nav `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_link` |
| AC4-02 | SAFETY | Render `Navigation` | Exactly one link: Dashboard → `/dashboard` | nav `SCRUM485_AC4_a_safety_officer_has_exactly_the_dashboard_link` |
| AC4-03 | LEAD | Render `Navigation` | None of the Coordinator's links: My Events, Venue Requests, Review Queue, Find a Venue | nav `SCRUM485_AC4_a_lead_sees_none_of_the_coordinators_links` |
| AC4-04 | BOTH | Render `Navigation` | No link label or target from any other role's set appears. Every other role's links are read by rendering that role's nav, not typed out, so a link added to any role later is checked too | nav `SCRUM485_AC4_%s_sees_no_link_from_any_other_role` |
| AC4-05 | BOTH, the role spelt `'Safety Officer'`, `'safety officer'`, `'event-coordinator-lead'`, `'EVENT_COORDINATOR_LEAD'` | Render `Navigation` | The same single link: `normaliseRole` absorbs case, spaces and hyphens, as the existing American-spelling test shows for the Organiser | nav `SCRUM485_AC4_the_role_spelt_%j_reaches_the_same_single_link` |
| AC4-06 | A misspelt role, `'saftey_officer'` | Render `Navigation` | An empty nav, and no error. Pins the failure mode so it is documented; AC4-01 and AC4-02 are what catch a misspelling in the code | nav `SCRUM485_AC4_an_unknown_role_renders_an_empty_nav_and_throws_nothing` |

AC4-01 and AC4-02 are pinned by count, so a link leaking into either set fails
them. They change when SCRUM-486, 487 and 490 add each role's real links.

---

## AC5 — the backend refuses what the role may not use, and the role is recognised everywhere roles are checked

### The role is recognised

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | — | Read migration 039 | Two `alter type user_role add value if not exists` statements, for `'event_coordinator_lead'` and `'safety_officer'`, and nothing else | role `SCRUM485_AC5_039_adds_the_two_values_and_nothing_else` |
| AC5-02 | PGlite with 007 | Apply 039, then apply it again | No error the second time; the enum unchanged by the second run | role `SCRUM485_AC5_running_039_again_changes_nothing` (PGlite) |
| AC5-03 | PGlite with 007 and 039 | Insert a `profiles` row with each new role | Accepted | role `SCRUM485_AC5_a_profile_can_hold_%s` (PGlite) |
| AC5-04 | PGlite with 007 and 039 | Insert a `profiles` row with role `'event_coordinator_leader'` | Refused, 22P02 (invalid enum value) | role `SCRUM485_AC5_a_misspelt_role_is_refused_by_the_enum` (PGlite) |
| AC5-05 | — | Compare `ROLE` with the migrations | `ROLE`'s values equal 007's `create type` values plus every `alter type user_role add value` in a later migration: seven. Replaces `toHaveLength(5)` and the read of 007 alone, so a new migration is never invisible to the test | role `SCRUM15_AC2_the_javascript_roles_match_the_sql_enum` (now reads every migration), `SCRUM485_AC5_the_parse_finds_039_and_reads_no_comment_as_a_role`, `SCRUM485_AC5_the_javascript_roles_are_exactly_what_the_built_enum_holds`, `SCRUM485_AC1_there_are_exactly_seven_roles_and_no_duplicates` (replaced `SCRUM15_AC2_there_are_exactly_five_roles_and_no_duplicates`) |
| AC5-06 | — | `isKnownRole`, `roleLabel` for each new role | `true`; the label from AC1-02, never `'another role'` | role `SCRUM485_AC5_%s_is_a_known_role_with_its_own_label`; and `SCRUM485_AC5_isKnownRole_refuses_%s` for near misses and the dead `technical_support` |
| AC5-07 | A profile with either new role | A request through `requireAuth` | Passes, `req.user.role` set; not the 403 "Your account has no role assigned" | reqauth `SCRUM485_AC5_admits_%s_and_puts_the_exact_role_on_the_request` |

### The role is refused where it is not allowed

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-08 | `requireRole(ROLE.EVENT_COORDINATOR)` | A caller with role `event_coordinator_lead` | 403 "This action is restricted to Event Coordinators"; `next` not called. Exact match: `includes`, no prefix | reqrole `SCRUM485_AC5_the_coordinator_gate_refuses_%s`; and `SCRUM485_AC5_a_refusal_names_the_role_that_would_work_not_%s` |
| AC5-09 | BOTH | Every `coordinatorOnly` route: on `/api/event-requests`, `GET /queue`, `/mine`, `/coordinators`, `/:id/review`, `/:id/assignments/review`, `/:id/change-requests/review`, `POST /:id/start-review`, `/:id/decision`, `/:id/clarification`, `/:id/clarification/close`, `/:id/reassign`, `/change-requests/:changeRequestId/decision`; on `/api/booking-requests`, `GET /mine`, `POST /`, `POST /:id/withdraw`; every route on `/api/event-requests/:id/equipment` | Refused, nothing queried | Per gate, not per route: reqrole `SCRUM485_AC5_the_coordinator_gate_refuses_%s` is the proof, since every route listed shares the one gate. Sampled on routes: events `SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing` (`GET /queue`, `GET /coordinators`, `POST /:id/start-review`); booking `SCRUM252_refuses_%s_with_403_and_never_queries`, `SCRUM253_refuses_%s_with_403_and_never_queries`, `SCRUM255_refuses_%s_with_403_and_never_queries`; event-equip `SCRUM21_AC1_refuses_%s_who_%s_with_403_and_reaches_nothing` |
| AC5-10 | BOTH | Every `venueStaffOnly` route on `/api/venues`, among them `GET /` (the full catalogue) and `GET /:id/history` | Refused, nothing queried | reqrole `SCRUM485_AC5_the_%s_gate_refuses_%s` (Venue Staff); venues `SCRUM17_AC4_%s_answers_403_with_no_query` (`GET /:id/history`), `SCRUM484_AC2_POST_with_setup_from_a_non_venue_staff_role_is_refused (%s)` (`POST /`). `GET /` itself is not sampled |
| AC5-11 | BOTH | Every `technicalSupportOnly` route: `/api/equipment` (`GET /`, `POST /`, `/:id/history`, `/:id/retire`, `/:id/reinstate`, `/:id/condition`, `PATCH /:id`), `/api/equipment/availability`, and every route on `/api/event-requests/:id/equipment-review` | Refused, nothing queried | reqrole `SCRUM485_AC5_the_%s_gate_refuses_%s` (Technical Support Staff); equip `SCRUM275_AC1_refuses_%s_on_create_with_403_and_changes_nothing`, `SCRUM275_AC1_refuses_%s_on_edit_with_403_and_changes_nothing`, `SCRUM275_AC8_refuses_%s_on_the_history_with_403`, `SCRUM275_AC1_refuses_%s_on_recording_damage_with_403_and_changes_nothing`, `SCRUM275_AC1_refuses_%s_on_retire_with_403_and_changes_nothing`, `SCRUM275_AC1_refuses_%s_on_reinstate_with_403_and_changes_nothing`; avail `SCRUM23_AC1_refuses_%s_with_403_and_runs_no_check`; review-r `N14_AC1_refuses_%s_who_%s_with_403_and_reaches_nothing`. `GET /api/equipment` itself is not sampled |
| AC5-12 | BOTH | The two-role gates: `internalReaders` (`/api/venues/:id/bookings`, `/blocks`, `/calendar`), `activeReaders` (`/api/equipment/active`), `coordinatorsOnly` (`/api/venues/event-search`) | Refused, nothing queried | reqrole `SCRUM485_AC5_the_%s_gate_refuses_%s` (both two-role gates); venues `SCRUM17_AC2_%s_gets_403_with_no_query` (blocks), `SCRUM178_AC6_%s_gets_403_with_no_query` (calendar, bookings), `SCRUM178_AC6_%s_with_includeRetired_gets_403_with_no_query`, `SCRUM20_AC1_%s_is_refused_with_403_before_the_service` (event search); equip `SCRUM275_AC1_refuses_%s_on_the_active_list_with_403` |
| AC5-13 | BOTH | `POST /api/event-requests` (create a request), `PATCH /:id`, `POST /:id/submit` | Refused, nothing queried. **Needs a decision first: see open question 2.** No role gate protects these today; any signed-in user passes | **Not proved, deliberately.** No role gate protects these routes today, for any role, so the expected 403 would fail. Gating them changes what existing roles can do (AC6), so it waits on open question 2 and its own ticket |
| AC5-14 | LEAD | Open each coordinator-gated page: `/review-queue`, `/my-events`, `/my-venue-requests`, `/venue-search`, `/venues/:venueId/calendar` | Redirected to `/unauthorized`. `ProtectedRoute` normalises both sides, and `EVENT_COORDINATOR_LEAD` is not `EVENT_COORDINATOR` | guard `SCRUM255_sends_%s_to_unauthorized_and_never_mounts_the_list` (`/my-venue-requests`), `SCRUM178_AC6_%s_is_sent_to_unauthorized_and_never_mounts_the_calendar`, `SCRUM485_AC5_sends_%s_to_unauthorized_from_venue_search`. `/review-queue` and `/my-events` share `/my-venue-requests`' gate, `["event_coordinator"]`, but have no test of their own; `/review-queue` was checked by hand (AC7-03) |
| AC5-15 | BOTH | Open each Venue Staff and Technical Support page: `/venue-catalogue`, `/equipment-catalogue`, `/equipment-review/:eventId`, `/equipment-availability` | Redirected to `/unauthorized` | guard `sends %s to /unauthorized` (`venueCatalogueRouteGuard`, `/venue-catalogue`), `SCRUM485_AC5_sends_%s_from_%s_to_unauthorized` (all three equipment pages, with `SCRUM485_AC5_technical_support_staff_still_opens_%s` as the control) |

AC5's two halves pull in different directions, and the cases resolve it one way.
"Accepted wherever roles are checked" is read as *recognised*: the enum stores
the role, `requireAuth` admits it, `isKnownRole` and `roleLabel` know it.
"Refuses every route the role is not allowed to use" is read as *permitted
nowhere yet*, because no story has granted these roles anything. Read the other
way, "accepted wherever roles are checked" would put both roles through every
gate, which is exactly the permission-in-two-places the ticket rules out.

AC5-09 to AC5-12 are proved per gate, not per route. Every route file builds
its gates from one factory, `createRequireRole`, so requireRole's own test of a
gate (`SCRUM485_AC5_the_%s_gate_refuses_%s`) is the proof for every route behind
it, a route added later included. The route-level tests sample each gate, one or
more routes apiece, to prove the gate is actually mounted. The lists in the
expected-result column are the routes on 10 October; not every one of them has
a route-level test, and the Implemented-by column says which do.

---

## AC6 — existing users and roles are unchanged

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | PGlite with 007 and 039 | Read the enum's values in order | 007's five first, in 007's order, then the two new ones; nothing removed or renamed | role `SCRUM485_AC6_the_enum_holds_the_five_then_the_two_in_that_order` (PGlite) |
| AC6-02 | — | Read `ROLE` and `ROLE_LABEL` | The five existing keys, values and labels exactly as before | role `SCRUM485_AC6_the_five_existing_roles_and_their_labels_are_unchanged` |
| AC6-03 | THE FOUR | Open `/dashboard` | Each gets the same dashboard as before: Organiser, Coordinator, Venue Staff, Technical Support | dash `SCRUM485_AC6_%s_still_gets_the_%s`. The four existing dashboards are stubs in that file: it proves Dashboard.jsx chooses the same page for each role, not those pages' content |
| AC6-04 | THE FOUR | Render `Navigation` | Each role's links exactly as today, by href and **by count**: Organiser 2, Coordinator 5, Venue Staff 3, Technical Support 5. Extends the Organiser-only count to every role that has links | nav `SCRUM485_AC6_%s_keeps_exactly_its_links`; and `SCRUM485_AC6_an_attendee_still_has_no_links` |
| AC6-05 | The existing route and guard suites | Run them | Every existing role-gate test passes unchanged. Lists of refused roles gain the two new roles; none loses one | Every existing test still passes, and the refused-role tables named in AC5-09 to AC5-15 each gained the two roles. Tables built from `Object.values(ROLE)` needed nothing: venues `SCRUM493_AC1_every_role_but_venue_staff_is_covered`, notifications `SCRUM17_AC3_a_%s_can_read_their_own_inbox` |
| AC6-06 | A signed-in `attendee` | Open `/dashboard` | Still "No dashboard available for your role", as today. Attendee has no dashboard, and this story does not give it one | dash `SCRUM485_AC6_an_attendee_still_has_no_dashboard` |
| AC6-07 | The live database, before and after 039 | Count profiles by role | Identical before and after: `event_coordinator` 2, and one each of `event_organiser`, `venue_staff`, `technical_support_staff`, `attendee` | **Not proved.** The counts before 039 are recorded above (10 October). No count was taken after 039 and the two new accounts, so nothing shows the existing profiles unchanged. The expected after-figures are the same five rows plus one `event_coordinator_lead` and one `safety_officer` |

AC6-04 to AC6-06 are the regression half of AC6; the Week 7 change guide names
regression tests as a deliverable. AC6-06 pins existing behaviour that is
arguably a gap, so that "unchanged" means what it says.

---

## AC7 — test accounts for both roles in the seed data

**There is no account seed data today.** The repository's only seed is
`backend/db/seeds/equipment.js`, which seeds equipment. The check scripts create
throwaway accounts and delete them when they finish; the demo accounts exist
only in the live Supabase project, made by hand. So AC7 cannot be met by adding
to a list. It needs a seed for accounts. The cases assume one script that creates
one account per new role, the same way the check scripts create accounts.

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | The live project without the two accounts | Run the account seed | One auth user and one `profiles` row per new role, with the role spelled as in AC1-01 | **Not proved: no seed script was built** (SCRUM-511). The two accounts exist, made by hand on 10 October: `lead@connectsphere.com` and `safety@connectsphere.com` (see *Facts*). So AC7 is partly met: the accounts are there for demos, but the seed data AC7 asks for is not |
| AC7-02 | The two accounts already seeded | Run the seed again | No duplicate, no error, nothing else changed | **Not proved.** There is no seed to run twice |
| AC7-03 | The seeded Lead account | Log in through the screen | Lands on the Lead's dashboard (AC3-04) | **Manual**, 10 October: logged in as `lead@connectsphere.com`; landed on the Lead's dashboard with one nav link, Dashboard; opening `/review-queue` by URL showed "Not available to your role" |
| AC7-04 | The seeded Safety Officer account | Log in through the screen | Lands on the Safety Officer's dashboard (AC3-05) | **Manual**, 10 October: logged in as `safety@connectsphere.com`; landed on the Safety Officer's dashboard with one nav link, Dashboard |
| AC7-05 | The seed's source | Read it | No password or secret in the repository; credentials come from the environment, as `SUPABASE_SECRET_KEY` does | **Manual (review)**, 10 October. There is no seed source to read. No credential for either account is in the repository: the two emails appear only as strings in auth and login, with a placeholder password |

AC7 is the one criterion this story only partly meets: the accounts exist, the
seed data does not. A seed script would write to the shared database, so even
when SCRUM-511 builds one it is run deliberately, not in CI.

---

## AC8 — no screen for assigning roles

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | `backend/src` | Read every use of `profiles` | Every one is a read; no route or service writes `profiles.role` | **Manual (review)**, 10 October: the six uses of `from('profiles')` in `backend/src` (requireAuth.js, routes/auth.js, equipmentReviewService.js, three in eventRequestService.js) are all `.select(…)` |
| AC8-02 | `frontend/src/App.jsx` | Read the routes | No route to a role-management screen | **Manual (review)**, 10 October: no route in App.jsx leads to a role, profile, user or account screen |

How a role *is* set is AC7-01: the `profiles` insert at account creation, refused
by the enum if misspelt (AC5-04). These cases are negative on purpose. AC8 says
the screen is not built, and nothing in this story builds one.

---

## What cannot be tested as written

- **The live enum, from the test suite.** `userRole.test.js` reads migration
  files, so it proves the JavaScript list matches what the repository declares,
  not what the live database holds. The live database has drifted once already
  (`technical_support`). Only a query, AC6-07's kind, can check the live enum.
- **AC1's rule for other stories** (AC1-05). It is about the backlog.
- **AC7 in CI.** A seed writes to the shared Supabase project. There is no seed
  yet in any case.
- **AC6-07 from the suite.** Profile counts are a fact about the live database;
  only a query before and after shows them.
- **Anything another story grants.** By design: no case here says what a Lead or
  Safety Officer *can* do, only that they are recognised and refused.

---

## Open questions for the team

1. **Can the Lead also be assigned events?** The ticket leaves it open. The Week 7
   brief reads as supervision, not a caseload, but that is an inference. It
   decides SCRUM-486's picker and whether 015's selection rule may pick a Lead.
2. **Should the Organiser's own routes be role-gated?** `POST /api/event-requests`,
   `PATCH /:id` and `POST /:id/submit` have no `requireRole`; any signed-in user
   creates a request as its Organiser. `assertOrganiser` checks only that a user
   id is present. That is true today of Venue Staff and Technical Support too, and
   the frontend's `/events` page has no `allowedRoles` either. AC5 says the backend
   refuses every route the role may not use, which these routes do not. Gating
   them is a small change, but it also stops the existing non-organiser roles,
   which touches AC6. AC5-13 is written for the gate and waits on this decision.

   **Wider than the three API routes.** SCRUM-508's audit found the same gap on
   the screen: `/events` (the Organiser's list and create form) is behind login
   only, with no `allowedRoles`, so any role, the new ones included, can open
   it and create a request through it. And the three placeholder pages,
   `/booking-requests`, `/tickets` and `/equipment`, are reachable by any
   signed-in role. Those render only text and load nothing, so the harm is
   cosmetic, but showing Venue Staff's or Technical Support's page to a Lead
   is against AC4's spirit.
3. **Is the role assignment decision confirmed?** AC8 says "Team decision, to
   confirm". The team confirmed it on 10 October; the ticket should be updated
   to say so.
4. **Should the dead `technical_support` value be recorded in a migration?**
   Answered: 039's header now records that it is dead and why it stays.
5. **What is the Lead's "unassigned queue" of?** Since SCRUM-330 every request is
   assigned a coordinator the moment it is submitted, and a submission with no
   coordinator available is refused and stays a draft. So no request is ever
   unassigned, and the queue the Lead's dashboard promises would always be
   empty. SCRUM-486 has to decide what it holds, or change assignment.

---

## Case ownership

| Cases | Subtask |
|---|---|
| This document | SCRUM-506 (written), SCRUM-512 (updated) |
| AC1-01, AC1-02, AC2-01, AC5-01 to AC5-06, AC6-01, AC6-02: migration 039, `userRole.js`, `userRole.test.js` | SCRUM-507 |
| AC2-03, AC5-07 to AC5-15, AC6-05: the middleware tests and the refused-role tables | SCRUM-508 |
| AC1-04, AC3-04 to AC3-08, AC6-03, AC6-06: the two dashboards | SCRUM-509 |
| AC4-01 to AC4-06, AC6-04: navigation | SCRUM-510 |
| AC7: the seed script | SCRUM-511 (not built) |
| AC2-02, AC3-01 to AC3-03, and this audit | SCRUM-512 |
| What each role may do | SCRUM-486, 487, 489 and 490, not this story |

**Tally:** 51 cases, counted from the tables.

| | Cases |
|---|---|
| Proved by a named test | 41 |
| Proved manually: a walkthrough (AC7-03, AC7-04) or a review (AC7-05, AC8-01, AC8-02), each dated 10 October | 5 |
| Not proved: AC1-05 (a backlog review, not yet done), AC5-13 (deferred to open question 2), AC6-07 (no count after 039), AC7-01 and AC7-02 (no seed script) | 5 |

| AC | Cases | By a test | Manually | Not proved |
|---|---|---|---|---|
| AC1 | 5 | 4 | 0 | 1 |
| AC2 | 3 | 3 | 0 | 0 |
| AC3 | 8 | 8 | 0 | 0 |
| AC4 | 6 | 6 | 0 | 0 |
| AC5 | 15 | 14 | 0 | 1 |
| AC6 | 7 | 6 | 0 | 1 |
| AC7 | 5 | 0 | 3 | 2 |
| AC8 | 2 | 0 | 2 | 0 |

Two of the 41 lean on more than one kind of evidence, and say so in their row:
AC1-03 is proved through the code that calls `normaliseRole` rather than by a
test of it alone, and AC5-14's `/review-queue` and `/my-events` share a tested
gate but have no test of their own.
