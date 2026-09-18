# ConnectSphere Frontend

Setup and startup instructions for running the frontend locally.

## Prerequisites

- Node.js installed
- The backend running (see backend's own README/setup) — the frontend needs it available at `http://localhost:5000` by default
- A test user set up in Supabase Auth, with a matching row in the `profiles` table (see "Test user setup" below)

## First-time setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a `.env` file** in this folder (same level as `package.json`):

   ```
   VITE_API_BASE_URL=http://localhost:5000/api
   ```

   Adjust the port if your backend runs somewhere else.

3. **Confirm your folder structure matches:**

   ```
   src/
     App.jsx
     main.jsx
     auth/
       AuthContext.jsx
       ProtectedRoute.jsx
     components/
       LoginForm.jsx
       Navigation.jsx
       Dashboard.jsx
       EventOrganiserDashboard.jsx
       EventCoordinatorDashboard.jsx
       VenueStaffDashboard.jsx
       TechnicalSupportDashboard.jsx
       VenueSearch.jsx
     services/
       apiClient.js
       venueService.js
       eventService.js
       supportService.js
   ```

## Running the app

1. **Start the backend first**, in its own terminal (from the `backend` folder):

   ```bash
   npm run dev
   ```

   Confirm you see `Server running on port 5000` with no errors.

2. **Start the frontend**, in a separate terminal (from this folder):

   ```bash
   npm run dev
   ```

   This prints a local URL, typically `http://localhost:5173`. Open it in your browser.

3. You should land on `/login` automatically (unauthenticated visits to `/` redirect there).

## Test user setup

Login goes through Supabase Auth, then looks up a role in the `profiles` table. You need both pieces in place:

1. In your Supabase project dashboard → **Authentication → Users**, create a user (or confirm one already exists).
2. In **Table Editor → profiles**, add a row with that user's `id` and a `role` value.
3. Log in with that user's email/password on the `/login` page.

If login fails with "Invalid email or password," the account doesn't exist yet or the password doesn't match. If it fails with "Unable to retrieve user role," the `profiles` row is missing.

## What works right now vs. what's still stubbed

**Working end-to-end:**
- Login / logout
- Role-based dashboard routing (once `profiles.role` is confirmed to match the role strings in `Dashboard.jsx`)

**Stubbed — renders but returns empty data, since no backend endpoint exists yet:**
- Venue search (`VenueSearch.jsx`)
- All dashboard data (My Events, Open Tickets, Pending Bookings, etc.)

These stubs live in `services/eventService.js`, `services/supportService.js`, and the extra functions in `services/venueService.js` — each logs a `console.warn` when called, so it's clear in the browser console what's still a placeholder.

## Troubleshooting

- **"Missing script: dev"** — you're not in the right folder, or `package.json` is missing the script. Confirm you're inside the `frontend` folder and `package.json` has a `"dev"` entry under `"scripts"`.
- **"Failed to resolve import ..."** — either a package isn't installed (`npm install axios react-router-dom`) or a file is genuinely missing/misnamed. Check the exact path in the error message.
- **Blank page / "No routes matched location"** — check `App.jsx` has a route for the path you're on; `/` should redirect automatically to `/login` or `/dashboard`.
- **Stale errors after fixing a file** — stop the dev server, delete `node_modules/.vite`, run `npm run dev` again, then hard refresh the browser (Ctrl+Shift+R).
