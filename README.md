# ConnectSphere

Event planning and venue booking for **ConnectSphere Event Services**, a regional events company operating across Southeast Asia.

ConnectSphere replaces email, spreadsheets and shared calendars with one platform. An event request is tracked from submission through review, venue booking, equipment, a safety check and attendee registration, so that:

- a venue or piece of equipment is never double-booked,
- setup and turnaround time between events is respected,
- every change reaches the people it affects, and
- there is a record of who changed what, and when.

## Contents

- [Roles](#roles)
- [Tech stack and architecture](#tech-stack-and-architecture)
- [Getting started](#getting-started)
- [Project structure](#project-structure)

## Roles

| Role | Who | Responsibilities |
|---|---|---|
| Event Organiser | External client | Drafts and submits event requests; after submission, changes go through the Coordinator |
| Event Coordinator Lead | Internal | Assigns and reassigns coordinators from the unassigned queue; sees all active events |
| Event Coordinator | Internal | Reviews, clarifies, approves or rejects; books venues; requests equipment; confirms, cancels and completes assigned events |
| Venue Staff | Internal | Venue catalogue, venue blocks, tentative holds and booking decisions |
| Technical Support Staff | Internal | Equipment catalogue, availability, request review and reservations |
| Safety Officer | Internal | Operational safety check before an event is confirmed |
| Attendee | External | Browses open events, registers, joins waiting lists and withdraws |

## Tech stack and architecture

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, React Router, Axios |
| Backend | Node.js 22, Express 5 |
| Database and auth | Supabase (PostgreSQL, Supabase Auth) |
| Tests | Vitest, Testing Library, Supertest, PGlite (in-process Postgres) |

```
React (Vite)  ──►  Express API  ──►  Supabase (Postgres + Auth)
```

- **The frontend never talks to Supabase.** All sign-in and data access go through the Express API (`/api/auth/login`, `/logout`, `/refresh`, then `Authorization: Bearer <token>` on every request).
- **Only the API holds the Supabase secret key.** It verifies the caller's token and enforces authorisation.
- **Authorisation is checked twice.** Routes gate on role (`requireRole`), and the SQL functions check the caller again, so the database refuses an action whoever calls it.
- **Background jobs run inside the API process** every minute: expiring venue holds, promoting waiting lists, and announcing when registration opens or closes.

## Getting started

### Prerequisites

- Node.js 22+ and npm 10+
- A Supabase project (URL and secret key)

### Install

```bash
git clone https://github.com/spm-g4t3/ConnectSphere.git
cd ConnectSphere
npm run install:all      # root, backend and frontend
```

### Configure

Create `backend/.env`:

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Server-only key. Never commit it or expose it to the frontend |
| `PORT` | No | API port (default `5000`) |
| `VENUE_HOLD_EXPIRY_JOB`, `WAITLIST_PROMOTION_JOB`, `REGISTRATION_WINDOW_JOB` | No | Set to `off` to disable that background job |
| `VENUE_HOLD_REMINDER_HOURS` | No | How long before a hold expires the coordinator is reminded |

The frontend needs no `.env`. It calls `http://localhost:5000/api` unless `VITE_API_BASE_URL` is set.

`.env` files are gitignored. Never commit real credentials.

### Run

```bash
npm run dev
```

This starts the API on **http://localhost:5000** and the client on **http://localhost:5173**, with output labelled `backend` / `frontend`. If either one fails, both stop.

| Command (from the repo root) | Does |
|---|---|
| `npm run dev` | Both servers |
| `npm run dev:backend` | API only |
| `npm run dev:frontend` | Client only |
| `npm test` | Backend then frontend test suites |
| `npm run install:all` | Install all three packages |

## Project structure

```
ConnectSphere/
├── backend/
│   ├── src/
│   │   ├── routes/       # Express routers, one per area; role gates live here
│   │   ├── services/     # Business logic; calls SQL functions via Supabase RPC
│   │   ├── domain/       # Status and role vocabularies (must match the SQL enums)
│   │   ├── validation/   # Request validation
│   │   ├── middleware/   # requireAuth, requireRole, final-event guard
│   │   ├── jobs/         # Once-a-minute background jobs
│   │   └── app.js        # Entry point
│   ├── db/
│   │   ├── baseline/     # Full schema snapshot (01–09)
│   │   ├── migrations/   # Changes since the baseline, numbered from 010
│   │   └── seeds/        # Demo data scripts
│   ├── scripts/          # Live database checks (*:check)
│   └── tests/            # Mirrors src/, plus db/ tests on PGlite
├── frontend/
│   ├── src/
│   │   ├── components/   # Screens and panels
│   │   ├── services/     # API client and per-area service calls
│   │   ├── auth/         # Session handling
│   │   └── notifications/
│   └── tests/
├── docs/                 # Requirements and design notes
└── package.json          # Root scripts that run both apps
```
