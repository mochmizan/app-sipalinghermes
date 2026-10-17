# auth — AGENTS.md

## Purpose

- Login/register workspace access UI at `/auth/` backed by `/api/auth/*`
- Entry gate for `user` and `admin` roles via `?mode=login|register`

## Ownership

- Owns `auth/index.html` only
- Shared behavior (`[data-auth-tab]`, `[data-auth-form]`, `[data-demo-login]`, session persist `hermes-session-token`) lives in root `app.js` — do not duplicate it here

## Local Contracts

- Register posts `{name, whatsapp, email, password}` to `POST /api/auth/register`; login posts `{identity, password}` to `POST /api/auth/login`
- Both return `{token, user, redirect}`; persist token then follow `redirect` (`/dashboard/` user, `/admin/` admin)
- Demo accounts: `user@demo.hermes` / `UserDemo123!`, `admin@demo.hermes` / `AdminDemo123!`, seeded by `server.mjs` only while `HERMES_DEMO_ACCOUNTS` is not `'0'` (`'0'` purges non-admin demo users at boot; the `Admin Hermes` row is preserved and (re-)seeded as the control-plane admin — the admin mockup login keeps resolving)
- Demo credentials are fetched at runtime from `GET /api/auth/demo` (`enabled` + `accounts` only when the flag is on) — never bundled in `app.js`; `#demo-accounts` ships `hidden` and is revealed only when the server confirms the flag, otherwise it stays hidden with inert buttons (`Akun demo tidak tersedia.`)
- `POST /api/auth/login` answers 429 `{code:'too_many_attempts'}` with `Retry-After` when rate limited (server-side IP + identity buckets; register and the waitinglist POST run the same 429 shape on their own per-IP flood buckets) — surface the server message, never retry in a loop
- New signups are funneled to `/lead-magnet/` (Early Access Batch 1 banner) — keep that upsell link
- `data-demo-forgot` is a demo stub (toast only); no reset backend exists

## Work Guidance

## Verification

- `npm run build` (vite build includes `auth/index.html` input)
- Manual: `node server.mjs`, then login with both demo accounts and confirm role redirects
- Flag: `GET /api/auth/demo` reflects `HERMES_DEMO_ACCOUNTS`; with `HERMES_DEMO_ACCOUNTS=0` `/auth/` shows no sample-access block, the user demo login returns the generic 401, and the admin mockup login stays valid (bootstrap account)

## Child DOX Index

- No children
