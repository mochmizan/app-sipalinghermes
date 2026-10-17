# verify-hermes — full-stack verification pass for Si Paling Hermes

Purpose: run a complete honest-state verification of this app (landing, auth, dashboard, admin, API, DB, metrics, analytics) on a local boot. Every moment of the run must produce either live data or an explicit honest degraded state. Zero mocks allowed.

## Preconditions

- Run from the repo root.
- Optional: LLM key via env (`HERMES_LLM_API_KEY`, `HERMES_LLM_BASE_URL`, `HERMES_LLM_MODEL`) — enables the live-chat leg. Never write keys to files inside the repo; inject via process env only.
- `POSTHOG_API_KEY` should be empty locally unless the analytics-capture leg is being tested; analytics events are asserted at deploy/prod stage through the Grafana PostHog row instead.

## Phase 1 — doctor (no server)

1. `node --check server.mjs && node --check agent-runtime.mjs && node --check app.js`
2. `npm run build` — must succeed.
3. Grep proofs (all must be clean):
   - no `agentation` references in `Dockerfile`, `package.json`, `package-lock.json`, any `index.html`
   - no fake literals `cor_24`, `1,284+`, `216`, `Nadia Sa`, `Rizky`, `Dimas Setiawan`, `Cindy Lestari`, `Hendra Wijaya`, `Maya Anggraini`, `Farhan Bachtiar` in marketing HTML
   - no `1280 + count` inflation pattern in `server.mjs`
   - `public/app.js`, `public/styles.css`, `public/posthog-init.js` byte-match root copies
4. DDL sanity: partial unique index exists in `agent-runtime.mjs` (`WHERE week_key <> ''`).

## Phase 2 — launch

Boot the server on port 5199 (background process):

```
$env:PORT='5199'; $env:POSTHOG_API_KEY=''; $env:HERMES_LLM_API_KEY='<key if testing live chat>'; node server.mjs
```

Then:

1. `GET /api/health` → 200, `{"ok":true,...}`
2. Playwright/browser: open `http://127.0.0.1:5199/` — landing renders, zero console errors.

## Phase 3 — feature drive (atomic checks, each with evidence)

Feature → required evidence:

1. **Auth** — demo-user login via real form → redirect `/dashboard/`; session token present. Admin demo login separately lands on `/admin/`.
2. **Dashboard bootstrap** — sidebar real name = logged-in user's name; `[data-agent-state]` reflects DB `agents.status` (ON/Siap or OFF); capabilities: conversations+report active, comments+schedule show "Belum tersedia di fase ini"; zero fake numbers.
3. **Toggle off/on** — click toggle → API `GET /api/agent` runs behind it; state flips in DB and DOM after POST resolves; toast confirms.
4. **Chat gate while off** — with agent disabled, `POST /api/agent/chat` → 503 `{"code":"agent_paused"}`; no user row persisted for the refused message.
5. **Live chat (key present)** — chat succeeds 200; reply bubble appears in DOM; reply text is real LLM output in Bahasa Indonesia (no canned string); user row + agent row both persisted.
6. **Connect account** — submit platform+handle → row appears with honest "Menunggu OAuth" state; duplicate → 409 with human message; disconnect via ✕ (confirm dialog) → row gone.
7. **Policy editor** — change system_prompt in Setting → save → re-GET shows persisted prompt.
8. **Run report** — `POST /api/agent/report` 201; duplicate 409; within ~15s a report bubble lands in chat with real data (chat volume this week, account counts).
9. **Admin panels** — `/admin/` shows: agents table (both provisioned agents, live status), runtime distribution, queue (jobs incl. failed/dead-letter), audit trail (mirrors earlier actions, no PII in details), LLM metadata, capability facts, queue depth + latency metrics.
10. **Admin actions** — disable (confirm dialog) → API reflects paused; enable → active, `status_detail` cleared; run report → new job appears.
11. **Metrics** — `GET /metrics` shows `hermes_agent_jobs_total`, `hermes_agent_queue_depth`, `hermes_agent_llm_latency_seconds_*` with counts matching LLM calls made this session.
12. **DB ground truth** — read `data/hermes.sqlite`: sessions/agents/messages/jobs counts consistent with UI; `agent_events.details` contains zero PII (`email`, `whatsapp`, `08x`, handles).
13. **Console hygiene** — zero JS errors on landing/auth/dashboard/admin (browser-logged 40x from negative-path tests don't count).

## Phase 4 — cleanup (must leave zero residue)

1. Kill the listener process on 5199 (`Get-NetTCPConnection -LocalPort 5199`).
2. Delete any temp boot scripts created outside the repo's tracked files.
3. Evidence: commit transcripts (API bodies, DOM asserts, DB counts, metrics output) stay in the session record; nothing in the repo.
4. `git status --short` afterwards shows no unexpected new files.

## Pass/fail

PASS = every feature produced live-or-explicitly-honest behavior with captured evidence, and cleanup left zero repo residue. Any canned reply, fake number, or silent failure = FAIL.

## Feature map (domain source of truth)

- Runtime contract: `agent-runtime.design.md` (v2), implementing module `agent-runtime.mjs`
- Dashboard behavior: `dashboard/AGENTS.md`; Admin: `admin/AGENTS.md`; Funnel: `lead-magnet/AGENTS.md`
- Metrics/analytics: root `AGENTS.md` (metric names, capture sites, PII rule)
