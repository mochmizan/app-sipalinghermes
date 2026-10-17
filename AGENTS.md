# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

- Durable behavior: all future implementation work runs on subagents using model `kenari/glm-5-3-flash` unless the user overrides it

## Child DOX Index

Owned by root (no child doc): `server.mjs` (Node http API + SQLite `data/hermes.sqlite` + static file server (HTML pages are served with versioned asset URLs `?v=<12-hex content hash>` of `app.js` / `styles.css` / `posthog-init.js` — Cloudflare overrides the origin's `no-cache` for those asset types with a 4h browser+edge TTL, so versioned URLs are the only cache-safe deploy mechanism; HTML itself stays non-edge-cached `DYNAMIC`); `/metrics` prom-client endpoint (default process metrics + counters `hermes_http_requests_total{method,route,status}` with fixed low-cardinality route labels, `hermes_waitinglist_signups_total`, `hermes_logins_total`, `hermes_registrations_total`; all metric increments try/catch-guarded), auth routes `POST /api/auth/register` / `POST /api/auth/login` / `GET /api/auth/demo` with in-memory rate limiting (sliding windows: login IP bucket 10 attempts per 5 min counting success + failure, key = sanitized `X-Real-IP` when the peer is loopback else the socket address; login identity bucket 5 FAILED logins per 15 min, key = trimmed lowercased identity; register POST and waitinglist POST each get a per-IP flood bucket 5 attempts per 10 min counting success + failure, checked before the body read; 429 + `Retry-After` seconds with one generic `too_many_attempts` message, short-circuiting before DB/bcrypt; buckets namespaced, lazily pruned, 60s unref'd sweep drops windows older than 20 min) and the `HERMES_DEMO_ACCOUNTS` flag (`'0'` = public launch: skips demo-user seeding and purges the non-admin `%@demo.hermes` users in one transaction — sessions, agent children, agents, users — with a counts-only boot line, and (re-)seeds the `Admin Hermes` row so the admin control plane keeps its admin under the mockup credentials; `GET /api/auth/demo` then returns `enabled:false` with no `accounts` key), installs + wires the Hermes agent runtime (`agent-runtime.mjs`: DB owner and gateway for agent state in the same SQLite DB, tables `agents` / `agent_accounts` / `agent_chat_messages` / `agent_jobs` / `agent_events`, agent metrics `hermes_agent_*` on the same registry, routes `/api/agent*` + `/api/admin/agent*`), server-side PostHog via `posthog-node`, `POSTHOG_API_KEY`, capture sites `user_registered` / `user_login` / `waitinglist_signup` / `agent_*`, no PII in props), `agent-runtime.mjs` (root-owned Hermes agent runtime: LLM provider resolution from `HERMES_LLM_API_KEY` / `HERMES_LLM_BASE_URL` (default `https://kenari.id/v1`) / `HERMES_LLM_MODEL` (default `deepseek-v4-1-flash`), OpenAI-compatible chat completions; unset key = agent status `unconfig` + chat 503 `llm_unconfigured`, closed error-code set, no fallback model; idempotent provisioning — install-time backfill of every existing user + lazy ensure on each `/api/agent*` hit + register hook — resolved from the user's name (`Hermes <user.name>`), Bearer-gated `/api/agent*` + role-admin `/api/admin/agent*`, module-owned 5s job tick + running reaper (5 min, also at install), metrics via injected prom-client `hermes_agent_jobs_total{type,status}` / `hermes_agent_queue_depth` / `hermes_agent_llm_latency_seconds` (buckets 0.5–90) / `hermes_agent_llm_errors_total{code}`, exports `routeLabels` merged into the server route-label chain), `GET /api/waitinglist/stats` returns honest counts only (`totalCount` = real `COUNT(*)`, no fake base; `slotsLeft = max(0, 1500 - count)`), chat is gated on `agents.enabled` (503 `agent_paused` while off, no row persisted), `Dockerfile` (node:22-bookworm-slim, `npm ci --omit=dev` — better-sqlite3 linux prebuilds, no toolchain — runs as `node` user, explicit `COPY` of `server.mjs`, `agent-runtime.mjs`, `app.js`, `styles.css`, `posthog-init.js`, page dirs, EXPOSE 5173, CMD node server.mjs, POSTHOG_API_KEY env-only), `app.js` (shared frontend JS; guarded `track()` PostHog helper + auth/admin events; the auth region resolves demo credentials from `GET /api/auth/demo` at runtime — never bundled — and reveals `#demo-accounts` only when the server confirms the flag, else the block stays hidden with inert buttons; two delimited live regions — `// --- Hermes agent runtime (dashboard) ---` calling `/api/agent*` with `agent_chat_sent` / `agent_toggled` / `agent_connected` / `agent_report_requested`, and `// --- Hermes agent runtime (admin) ---` (guarded by `#runtime`) rendering `GET /api/admin/agents` / `/api/admin/agent-jobs` / `/api/admin/agent-audit` plus `POST /api/admin/agent-action` with `agent_admin_action {action}`, 20s refresh while the tab is visible, honest empty/error states, `Sesi berakhir` state with no redirect on 401/403; the legacy waiting-list + Repliz blocks above are still handled by this same file); no PII, CDN-block safe), `posthog-init.js` (web autocapture init, placeholder `__POSTHOG_PROJECT_KEY__` injected by `server.mjs` from `POSTHOG_API_KEY` at serve time, mirrored to `public/`), `styles.css` (global stylesheet), `index.html` (landing page), `vite.config.js` (multi-page build inputs), `ecosystem.config.cjs` (pm2 `sipalinghermes-app`, `PORT 5173`, `POSTHOG_API_KEY` env), `package.json` / `package-lock.json` (scripts `start`, `dev`, `dev:frontend`, `build`, `preview`; deps `bcryptjs`, `better-sqlite3@13` (ships `prebuilds/win32-x64.node` in the npm tarball; loads on Node 26 without node-gyp — no VC++ toolset needed), `posthog-node`, `prom-client`), devDep `vite`), `README.md`, `data/` (runtime SQLite, gitignored), `.cursor/skills/verify-hermes/` (full-stack verification skill: doctor → launch → feature drive with live-or-honest evidence → zero-residue cleanup).

- `auth/AGENTS.md` — login/register workspace access UI, flag-gated demo accounts (`GET /api/auth/demo`), session redirect
- `dashboard/AGENTS.md` — user workspace: live Hermes agent status, capability list, chat, accounts, settings from `/api/agent*` (Bearer session token, 15s message poll, honest empty states, zero fake numbers)
- `admin/AGENTS.md` — admin control plane: waiting-list leads table, Repliz key UI, live users & agents table (enable/disable/run-report), runtime distribution, queue/dead-letter, audit, LLM metadata, capability + settings panels derived from `/api/admin/agent*`, `role=admin` gate, zero fake numbers
- `lead-magnet/AGENTS.md` — VIP waiting-list funnel: waitinglist form, ticket boarding pass, referral share, `/api/waitinglist` + stats integration
- `assets/AGENTS.md` — fonts (`assets/fonts/`) and downloadable playbook (`assets/lead-magnet/the-hermes-playbook.html`) served by `/api/lead-magnet/download`
- `public/AGENTS.md` — byte-identical mirror of root `app.js`, `styles.css`, `assets/fonts/` for Vite/static serving; sync-only, never edit independently
- `monitoring/AGENTS.md` — mizan- monitoring stack (Prometheus/Grafana/Alertmanager/node-exporter + app container, compose `mizan-mon`): own network, loopback-only ports, 3 alert rules, Slack-gateway webhook (fails closed without ALERTMANAGER_API_KEY), provisioned Mizan Overview dashboard with live PostHog row (Infinity → Query API) + `hermes_agent_*` "Agent runtime" row; `HERMES_LLM_*` env passed to `mizan-app` from VPS `monitoring/.env` only (key never in git)
