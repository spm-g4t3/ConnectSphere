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
└── backend/     # Node.js + Express (JS) — API server
```

## Getting started

**Prerequisites:** Node.js 22+ and npm 10+.

Full install and run instructions will be added here once the application scaffold lands. Environment variables will be documented in an `.env.example` in each of `frontend/` and `backend/`; real `.env` files are gitignored and must never be committed.

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
