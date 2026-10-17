# Mizan Hermes Agent Runtime — design contract v2 (final)

Amended after two independent red-team reviews (session evidence). Deviations during
implementation must be reported back, not absorbed silently.

## Architecture

Owner: root `server.mjs` stays the DB owner and API gateway; all agent state lives in the
same SQLite DB. One process writes. The LLM is called over HTTP (async fetch) from inside
the app process. No second worker, no internal API, no cross-container SQLite. Chat is a
single awaited LLM call. Extraction later (separate VPS runtime) reuses schema + adapter.

## LLM provider resolution (inside agent-runtime.mjs)

- `HERMES_LLM_API_KEY` set → OpenAI-compatible external provider: base
  `HERMES_LLM_BASE_URL` (default `https://kenari.id/v1`), model `HERMES_LLM_MODEL`
  (default `deepseek-v4-1-flash`), Bearer key. A `kn-` key lives in VPS
  `/opt/mizan/monitoring/.env` (chmod 600) only — never in git or repo.
- No key configured → NO fallback model. Agent status computes `unconfig` each tick;
  chat returns 503 `llm_unconfigured`. (Zen free tier rejects non-OpenCode clients with
  403 FreeTierError, measured; kenari verified 200 from plain HTTP.)
- Error codes, closed set only: `llm_unconfigured | llm_unreachable | llm_timeout |
  llm_upstream`. Never surface raw provider error strings (they can echo request data).
- Call: POST `{base}/chat/completions`, Bearer, system = fixed persona + user policy,
  last 12 messages context, `max_tokens` 500, `AbortSignal.timeout(90_000)`, plus
  `res.on('close')` abort wiring (see chat API).

## SQLite tables (CURRENT_TIMESTAMP timestamps; better-sqlite3 sync; ONE process writes)

```
agents(id PK AI, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, model TEXT, system_prompt TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '{"conversations":true,"report":true}',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error','unconfig')),
  status_detail TEXT NOT NULL DEFAULT '', last_status_at TEXT, created_at TEXT)

agent_accounts(id PK AI, agent_id FK REFERENCES agents(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','threads','x','linkedin','facebook')),
  handle TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_oauth'
    CHECK (status IN ('pending_oauth','connected','error')),
  status_note TEXT NOT NULL DEFAULT '', created_at TEXT,
  UNIQUE(agent_id, platform, handle))

agent_chat_messages(id PK AI, agent_id FK REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','agent')), kind TEXT NOT NULL DEFAULT 'chat'
    CHECK (kind IN ('chat','report','system')),
  content TEXT NOT NULL, created_at TEXT)
  INDEX (agent_id, created_at)

agent_jobs(id PK AI, agent_id FK, type TEXT NOT NULL CHECK (type IN ('scheduled_report','manual_report')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  week_key TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE(agent_id, type, week_key)          -- week_key nonempty only for scheduled_report
  INDEX (status, id))

agent_events(id PK AI, agent_id FK NULL, actor TEXT NOT NULL DEFAULT 'system'
    CHECK (actor IN ('user','admin','system')),
  action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT)
  INDEX (agent_id, id), INDEX (id)
```

Job type semantics:
- `scheduled_report`: weekly. `week_key = strftime('%G-W%V','now')` (ISO year-week, NOT
  `%W`). Ensure step uses `INSERT OR IGNORE` so a done-out week never re-enqueues.
- `manual_report`: on demand, `week_key=''` (no UNIQUE), from user or admin action.

## installAgentRuntime (exact wiring surface)

```
const agentRuntime = installAgentRuntime({
  db, register, client,
  trackServer,
  http: { json, readJson, getUser },        // getUser(req) → session row or null (server.mjs owns auth)
});
agentRuntime.handle(req, res, url)          // returns true when routed (server falls through else)
agentRuntime.start()                        // owns setInterval(tick, 5000).unref() + running reaper
agentRuntime.stop()                         // clearInterval; wired to graceful shutdown
agentRuntime.routeLabels                    // route-label map merged into server.mjs 413-420 chain
```
Rules: module MUST NOT import prom-client (uses injected `client`); module owns its DDL,
prepared statements (with `db.transaction()` where multi-statement), timer, and reaper.
No `setInterval` outside the module. Sig: timer guard spans the WHOLE awaited run, not just
the claim.

## Provisioning (idempotent, automatic)

- Install-time backfill: for every user missing an agent row, `INSERT OR IGNORE`
  `agents` (name `Hermes <user.name>`, defaults). Then re-SELECT.
- Lazy ensure on every `/api/agent*` hit: same INSERT OR IGNORE + re-SELECT (two tabs
  racing cannot throw or duplicate thanks to UNIQUE(user_id)).
- Registration hook: after user INSERT succeeds, provision before response.

## Public API (Bearer like existing routes; role-admin gates mirror existing patterns)

```
GET   /api/agent            → {agent:{id,name,model,system_prompt,enabled,status,status_detail,
                             llm:{configured,model,provider_host}},   // NO key, NO base url
                             capabilities:[{key,enabled,supported,state,reason}],
                             accounts:[{id,platform,handle,status,status_note}], queue_depth}
                             // capabilities: conversations (chat live state), report (weekly
                             // recap), comments + schedule supported:false reason 'Belum
                             // tersedia di fase ini (butuh integrasi platform)'
PUT   /api/agent/config     {name?, system_prompt?(<=2000), capabilities?{report?}}
                             → MERGE with key whitelist, never replace the object
POST  /api/agent/toggle     {enabled:bool} → writes enabled AND status('paused'|'active');
                             audit action agent_toggled
POST  /api/agent/chat       {message} → 422 when empty or length>2000; persists the USER row
                             FIRST (so 503 never erases it), then calls LLM, then persists
                             agent reply (role:'agent', kind:'chat'); on LLM failure persists
                             system row (kind:'system') with the closed-set reason, returns
                             503 {code}; reply rows include {id} for the messages cursor
                             → {ok, reply:{id,role,kind,content,created_at}}
                             Rate limit: 20 msgs/min/user fixed window (approximate across
                             restarts), max 2 in-flight chat runs per user; 429 carries
                             Retry-After: 60; map pruned opportunistically
POST  /api/agent/connect    {platform,handle<=80} → INSERT + audit(event detail =
                             {platform, account_id} — NEVER handle); duplicate → 409 with
                             the existing account
DELETE /api/agent/accounts/:id → removes row + audit
GET   /api/agent/messages?after=<id>&limit=50 → cursor by message id (ascending),
                             default last 50; poll every 15s (tab visible)
POST  /api/agent/report     → enqueue manual_report (checks enabled + capabilities.report);
                             409 if one already queued/running
GET   /api/admin/agents     → LEFT JOIN users + one GROUP BY for queue depths (no N+1)
GET   /api/admin/agent-jobs → last 50
GET   /api/admin/agent-audit→ last 50
POST  /api/admin/agent-action {agent_id, action:'enable'|'disable'|'requeue_failed'|'run_report'}
```

## Runtime loop (module-owned timer; one claim at a time)

Each tick (5s, reentrancy guard spanning the awaited run):
1. Reaper: reclaim `running` rows `started_at` older than 5 min → `queued` (error text set).
   Also run once at install (covers pm2/Docker SIGKILL mid-call).
2. Ensure current-week scheduled_report jobs (`INSERT OR IGNORE`) for agents with
   `capabilities.report=1 AND enabled=1`; `unconfig` recomputed per tick (no key in env).
3. Claim 1 queued job via claim UPDATE ... WHERE status='queued' (then recheck
   `agents.enabled=1` before persisting results; if disabled mid-run, mark job still done
   but SKIP persisting chat payload... simpler: check belongs to enabled agent BEFORE the
   LLM call; if paused → status queued again).
4. scheduled/manual report: gather REAL per-agent numbers only (its own chat volume 7d,
   its own accounts status, waitinglist totals platform-wide is fine public data), ask LLM
   for a short Indonesian recap, persist one chat row kind:'report', status done.
   Failures: attempts+=1 in a db.transaction; attempts<3 → requeued with error (truncated
   200 chars); else failed (dead-letter visible in admin queue panel).
5. Status: success → `active`, status_detail=''; LLM/code errors → `error` + truncated
   detail; tick NEVER overwrites `paused`.

## Chat/HTTP timeout wiring (server.mjs)

- `server.requestTimeout = 120_000`, `server.headersTimeout = 65_000`.
- chat handler: AbortSignal.timeout(90s) on fetch; `res.on('close')` aborts the fetch;
  persist-guard uses `res.writableEnded` before writing.

## Metrics (same registry via injected client/register)

- `hermes_agent_jobs_total{type,status}` Counter
- `hermes_agent_queue_depth` Gauge (set in `finally` of each tick)
- `hermes_agent_llm_latency_seconds` Histogram (buckets 0.5,1,2,5,15,30,60,90)
- `hermes_agent_llm_errors_total{code}` Counter (closed code set only)

## trackServer events (NO PII, NO content)

`agent_registered` (decode: provisioning count), `agent_toggled {enabled:boolean}`,
`agent_chat_sent {message_length:int}`, `agent_llm_error {code:closed-set}`,
`agent_connected {platform}`, `agent_report_generated {kind:scheduled|manual}`.
NEVER: email, whatsapp, handle, message/prompt/report content.

## Wiring map

- `agent-runtime.mjs` (new): everything above; owned by root.
- `server.mjs`: import + install + one fall-through route block; route labels chain uses
  `agentRuntime.routeLabels`; `agentRuntime.start()` after DB init; `stop()` on signals.
- `app.js` + `dashboard/index.html`:
  - Bootstrap: GET /api/agent + GET /api/agent/messages on load; poll messages 15s; host
    for toggle/chat/connect/config/report endpoints via real API calls (Bearer session).
  - Every fake number is removed or rooted to live data: agent status pill + text
    (mirror of API state), accounts panel (agent_accounts; honest empty state), capability
    rows (API shape incl. comments/schedule 'Belum tersedia'), chat (real history, real
    replies, system rows styled distinctly), activity feed (agent_events for this agent),
    comments queue → honest empty informative state (no fake rows), metric panels → real
    counters (jobs done 7d, queue depth), sidebar badges (no fake '24'; live account count),
    'Restart runtime' button REMOVED (no real operation), 'Run report' button added,
    setting cards show real model/policy summary + honest BYOK note (per-user keys: not in
    this phase), dead sidebar anchors (live/schedule/automation content, TEST items) removed.
- `app.js` admin sections + `admin/index.html`:
  - Users & Agents table → GET /api/admin/agents (join, real status), per-row
    enable/disable/run-report actions via POST /api/admin/agent-action; fake rows deleted.
  - Runtime panel → real distribution from /api/admin/agents (counts by status).
  - Queues panel → GET /api/admin/agent-jobs real rows; dead-letter notes from error.
  - Audit table → GET /api/admin/agent-audit real rows (actor/action/target/time).
  - LLM panel → /api/admin/agents llm metadata (provider_host, model, configured boolean).
  - Platform health → real snapshot (agents count, queue depth, LLM configured); fake
    128/12/96% and correlation-ID-free fake audit rows deleted; capabilities panel rows
    driven by live capability data.
- `Dockerfile`: `COPY agent-runtime.mjs`.
- compose `mizan-mon`: mizan-app env gains `HERMES_LLM_BASE_URL`, `HERMES_LLM_API_KEY`,
  `HERMES_LLM_MODEL` (empty-dotted defaults ok, `${HERMES_LLM_API_KEY:-}`); no new service.
- `monitoring/.env.example`: the three vars documented (key_into_VPS.env only).
- Grafana `mizan-overview.json`: agent runtime row (queue depth stat, jobs counter,
  LLM latency avg/hist, LLM errors) via `mizan-prom`.

## Capability semantics (truth on the dashboard)

- conversations = live chat (agents.enabled) — real state, chat API exists.
- report = weekly recap job — real state, user can toggle + run now.
- comments, schedule = supported:false with honest reason (platform OAuth is an explicit
  non-goal this phase; the connect flow records `pending_oauth` with real note).
- Landing-page marketing copy stays untouched; dashboard shows operational truth only.

## Non-goals (explicit)

- Real social posting/OAuth (needs platform apps + secrets + review). Connect records the
  honest `pending_oauth` state.
- Per-user BYOK LLM keys (server-managed key now, env-driven swap).
- Fake metrics of any kind anywhere in the two dashboards.
