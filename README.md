# ConnectSphere

Event planning and venue booking system for **ConnectSphere Event Services**, a regional organisation providing professional event planning and venue services across Southeast Asia.

ConnectSphere coordinates events across its own venues and equipment inventory. This system replaces the current mix of email, spreadsheets and shared calendars with a single platform, so that an event request can be tracked from initial submission through review, venue booking, equipment reservation and attendee registration — without the same venue being double-booked or a last-minute change failing to reach the people it affects.

**Repository:** https://github.com/spm-g4t3/ConnectSphere

> **Status:** early development. The application scaffold is not yet in place; see [Getting started](#getting-started).

## User roles

| Role | Internal / External | Responsibility |
|---|---|---|
| Event Organiser | External | Client representative who submits an event and its requirements |
| Event Coordinator | Internal | Owns planning for an assigned event; main internal point of contact |
| Venue Staff | Internal | Venue information, availability, and booking decisions |
| Technical Support Staff | Internal | Equipment, reservations, and technical support |
| Attendee | External | Registers for and attends an event |

Access to information and functionality depends on a user's role *and* their relationship to a given event.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite, JavaScript) |
| Backend | Node.js + Express (JavaScript) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |

## Architecture

Requests flow in one direction:

```
React  ──►  Express  ──►  Supabase
```

The frontend never queries the database directly. All data access goes through the Express API, which is the only tier that holds the Supabase service-role key and the only place authorisation rules are enforced.

**Authentication boundary.** Supabase Auth is the exception to the flow above: the frontend uses `supabase-js` *solely* to sign in and obtain a JWT. That token is then sent as a `Bearer` header on every request to Express, which verifies it and derives the caller's role and event relationships from it. The frontend holds only the anon key and a session token; it never holds credentials that could bypass the API.

## Repository layout

```
ConnectSphere/
├── frontend/    # React (Vite, JS) — client application
├── backend/     # Node.js + Express (JS) — API server
└── package.json # dev scripts that run both together
```

## Getting started

**Prerequisites:** Node.js 22+ and npm 10+.

```bash
git clone https://github.com/spm-g4t3/ConnectSphere.git
cd ConnectSphere
npm run install:all      # installs root, backend and frontend
```

Copy `backend/.env.example` to `backend/.env` and fill in the real values. Real `.env` files are gitignored and must never be committed. The frontend needs no `.env`: it defaults to `http://localhost:5000/api`, and `VITE_API_BASE_URL` overrides that if you need it to.

Then, from the repository root:

```bash
npm run dev
```

That starts both servers at once — the API on **http://localhost:5000** and the client on **http://localhost:5173** — with each line of output labelled `backend` or `frontend`. Ctrl+C stops both, and if either exits with a failure the other is stopped too, so you never end up talking to half a system.

| Command | Runs |
|---|---|
| `npm run dev` | Both servers together. The usual one. |
| `npm run dev:backend` | The API alone, on port 5000. |
| `npm run dev:frontend` | The client alone, on port 5173. |
| `npm run install:all` | Installs dependencies in all three packages. |
| `npm test` | The backend unit suite, same as CI runs. |

Each package can still be driven on its own from inside its own directory; the root scripts are a convenience, not a new layer.

## Development workflow

### Branches

| Branch | Purpose |
|---|---|
| `main` | The shippable increment. Updated only at a sprint boundary, by merging `dev`. Tagged per release (`v0.1.0-sprint1`). |
| `dev` | Default branch and integration target. All feature work merges here during the sprint. |
| `feature/SCRUM-<id>-<slug>` | One branch per user story, cut from `dev`. |

Also in use: `bugfix/SCRUM-<id>-<slug>`, and `hotfix/<slug>` cut from `main` for a broken release.

**One branch per user story, not per person.** Each branch maps to exactly one backlog item, so any requirement can be traced to its commits, its pull request, and its tests.

```bash
git checkout dev
git pull
git checkout -b feature/SCRUM-14-track-event-request-status
```

### Commits

Conventional Commits, prefixed with the Jira ticket:

```
feat(SCRUM-14): add event status badge component
fix(SCRUM-14): handle unknown status values
test(SCRUM-14): cover status transition edge cases
```

### Pull requests

- Feature branch → `dev`. One teammate approval required. **Squash merge**, so each story becomes a single commit on `dev`.
- `dev` → `main` at the end of each sprint. **Merge commit**, so sprint boundaries stay visible in history.
- Describe what changed and link the Jira ticket. Note how you verified it.

### Definition of Done

A story is done when its acceptance criteria are met, it has tests, it has been reviewed and merged to `dev`, and the Jira ticket has been moved to Done.

## Testing

| Command | What it proves | Needs credentials |
|---|---|---|
| `npm test` | The unit suite. Run on every pull request by CI. | No |
| `npm run db:check` | The migrations were applied and the seed data landed. | Yes |
| `npm run venue:check` | The venue service end to end: the transactional RPCs, the schema constraints, the audit trigger and retirement, against a real database. | Yes |
| `npm run routes:check` | The event request routes end to end: a real Supabase token through the auth middleware, ownership scoping against row level security, and a status change reaching the client. | Yes |
| `npm run venue-routes:check` | The venue catalogue routes end to end, one block per SCRUM-15 acceptance criterion: creation, an authorised change reaching the search, retirement leaving the search while its bookings survive, and the audit trail naming the editing user. | Yes |

Run them all from `backend/`.

Test files live in `backend/tests/`, mirroring `backend/src/`. Each `describe` block is named after the acceptance criterion it proves, so a requirement traces to the test that covers it without a separate document to keep in step.

Tests that would otherwise reach Supabase replace the client with a mock, which is what lets the suite run in CI with no `.env`. The one exception is deliberate: `backend/tests/config/supabaseClient.test.js` re-imports the real module to prove it refuses a half-configured environment.

### Why the migrations have no unit tests

`backend/db/migrations/` is DDL that only Postgres can execute. Testing it means running it, which needs a live database and a secret key — and that key bypasses row level security entirely, so it does not belong in CI. The two check scripts above are the proof instead, run by hand before opening a pull request. `backend/tests/domain/eventRequestStatus.test.js` covers the one part that can be checked statically: it reads the status enum out of `001_event_requests.sql` and asserts the JavaScript vocabulary still matches it.
