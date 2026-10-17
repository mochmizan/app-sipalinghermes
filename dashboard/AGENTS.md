# dashboard — AGENTS.md

## Purpose

- User workspace at `/dashboard/` for one Hermes agent: status, accounts, capability, live chat, honest comments placeholder, activity, settings editor

## Ownership

- Owns `dashboard/index.html` plus the delimited dashboard region of root `app.js` (`// --- Hermes agent runtime (dashboard) ---` … immediately before `// Admin Waiting List Leads Loader`)
- Never edits inside the admin region of `app.js` (owned by `admin/AGENTS.md`), `server.mjs`, or `agent-runtime.mjs`
- Guarded by `body[data-required-role="user"]` check in root `app.js` (`/api/auth/me`); unauthenticated or wrong role redirects to `/auth/?mode=login`

## Local Contracts

- Live runtime only (contract: root `agent-runtime.design.md`): panels bootstrap from `GET /api/agent` (status, capabilities, accounts, queue depth) and `GET /api/agent/messages` (chat history), both with `Authorization: Bearer <session token>`; no demo state, zero fake numbers
- Message poll: `GET /api/agent/messages?after=<last id>&limit=50` every 15s while the tab is visible; system rows (`kind:"system"`, closed-set LLM error reason) styled distinctly from `user`/`agent` rows
- Actions in root `app.js` call real endpoints: `POST /api/agent/toggle`, `POST /api/agent/chat` (surface 429 + Retry-After), `POST /api/agent/connect` (409 shows the existing account), `DELETE /api/agent/accounts/:id`, `PUT /api/agent/config`, `POST /api/agent/report` (409 while a report is queued/running)
- Honest states: empty accounts/chat/comments panels show informative empty states, never placeholder rows; `comments` and `schedule` capabilities render `supported:false` with the API-supplied reason; status pill mirrors API `status` (`active`/`paused`/`error`/`unconfig`) and `status_detail`
- Panels and anchors that must stay in sync: `#comments` (honest empty state, `.data-table`), `#conversations` (`[data-chat-list]`), `#account-integrated` (`.platform-list`), `#setting`
- Sidebar agent badge shows the real connected-account count; the demo "Restart runtime" control is removed in favour of "Run report"; no dead sidebar anchors (live/schedule/automation, TEST items)
- Activity panel (`Aktivitas runtime`) renders the 5 newest `agent.events` rows from `GET /api/agent`; when the API reports no events it falls back to the agent's own chat thread (report/system/chat rows)
- Setting editor (`[data-config-form]`): name ≤60, policy ≤2000, report capability checkbox → `PUT /api/agent/config` (merge); inputs are filled once from the API and never re-filled while the user types
- PostHog discipline: only `agent_chat_sent {message_length}`, `agent_toggled {enabled}`, `agent_connected {platform}`, `agent_report_requested` are captured, all through the guarded `track()`; never message content, handle, email, or role
- Sidebar user block and topbar LLM tag read the session (`localStorage hermes-account`) and `agent.llm` — no hardcoded name, no "BYOK aktif" claim (per-user BYOK is a non-goal this phase)

## Work Guidance

- Keep every dashboard runtime change inside the delimited region in `app.js`; the admin region is appended after it and must not be touched here
- All API calls go through the region's local `request()` helper (Bearer session token, `.catch`/throw surfaces the API's own message); honest Indonesian error copy beats silent failure — never fake a row or a number to fill a panel
- Mirrors: `app.js` → `public/app.js` must stay byte-identical (`Copy-Item app.js public\app.js`), then `npm run build`

## Verification

- `node --check app.js` and `npm run build` (vite build includes `dashboard/index.html` input)
- Manual: `node server.mjs`, login as `user@demo.hermes`, confirm the dashboard bootstraps from `/api/agent`, chat posts to `/api/agent/chat`, and empty panels show honest empty states
- HTTP-only probe for the client's read contract (401 without token, snapshot keys, `?after=` cursor, 422/409/429 paths) is enough without a browser

## Child DOX Index

- No children
