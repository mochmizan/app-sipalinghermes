# monitoring — Mizan observability stack

## Purpose

Self-contained Prometheus/Grafana/Alertmanager stack for the Hermes app (`mizan-app`), deployed on a shared VPS (files at `/opt/mizan`, compose project `mizan-mon`, app served via nginx vhost + HTTPS via certbot). HARD RULE: zero interference with the friend's `fairshare` stack on that VPS — everything here is `mizan-` prefixed, on its own Docker network (`mizan-mon-net`), with all host ports bound to `127.0.0.1` only. nginx/certbot vhosts live only on the VPS (`/etc/nginx/sites-enabled/mizan-*`), never in this repo.

## Ownership

- `monitoring/AGENTS.md` — this contract
- `docker-compose.yml` — stack definition, compose project `mizan-mon`; host ports: 3002→app, 9090 Prometheus, 3001 Grafana (host 3000 belongs to fairshare), 9093 Alertmanager, 9100 node-exporter; `mizan-app` env: `PORT`, `POSTHOG_API_KEY`, and `HERMES_LLM_API_KEY` / `HERMES_LLM_BASE_URL` / `HERMES_LLM_MODEL` interpolated from `monitoring/.env` (default empty)
- `prometheus.yml` — scrape jobs: `prometheus`, `node`, `hermes-app` (`mizan-app:5173/metrics`), `alertmanager`; alerting → `mizan-alertmanager:9093`
- `alerts.yml` — exactly 3 rules: `InstanceDown`, `HermesAppDown`, `WaitinglistSpike`
- `alertmanager.yml` — all alerts → webhook `https://slackgateway.ssnai.org/v1/alerts/alertmanager` (native Alertmanager JSON, Bearer `ALERTMANAGER_API_KEY`); VPS renders `alertmanager.yml.rendered` with the real key from `.env`, key never in git (empty = fail closed, alerts queue but never deliver)
- `grafana/provisioning/` — Prometheus datasource (`uid: mizan-prom`, default) + dashboard provider; `grafana/dashboards/mizan-overview.json` — "Mizan Overview" (app metrics, host metrics, target health, agent runtime) plus a live PostHog row (Infinity datasource `uid: mizan-posthog` → Query API project 656630): event-volume timeseries (dashboard-range macros), waitinglist submits stat, top-events table, 7d waitinglist funnel table
- `.env.example` — GF_ADMIN_USER, GF_ADMIN_PASSWORD, POSTHOG_API_KEY, ALERTMANAGER_API_KEY, HERMES_LLM_API_KEY / HERMES_LLM_BASE_URL / HERMES_LLM_MODEL; copy to `.env` (gitignored) before deploy; override the Grafana password, keep `HERMES_LLM_API_KEY` blank in the example

## Local Contracts

- App metrics contract lives in root-owned `server.mjs` (`/metrics`, prom-client, counters `hermes_http_requests_total{method,route,status}`, `hermes_waitinglist_signups_total`, `hermes_logins_total`, `hermes_registrations_total`); this stack only scrapes it
- Hermes agent metrics contract lives in root-owned `agent-runtime.mjs` (same registry, injected prom-client): `hermes_agent_jobs_total{type,status}`, `hermes_agent_queue_depth`, `hermes_agent_llm_latency_seconds` (histogram), `hermes_agent_llm_errors_total{code}` (closed code set only); the Agent runtime dashboard row is driven by these names
- `HERMES_LLM_API_KEY` is a VPS-only secret: `/opt/mizan/monitoring/.env` (chmod 600), never in git or this repo; unset key = runtime status `unconfig` and chat 503 `llm_unconfigured` by design (no fallback model)
- Dashboard PromQL must reference datasource uid `mizan-prom`
- All container/volume/network names `mizan-` prefixed; compose file must never reference `fairshare_*` resources

## Work Guidance

- VPS deploy: `git archive HEAD` → tar to `/opt/mizan` (plus `dist/` — gitignored, build with `npm run build` locally and ship separately); `/opt/mizan/monitoring/.env` (chmod 600) holds GF_ADMIN_USER/PASSWORD, POSTHOG_API_KEY, ALERTMANAGER_API_KEY, and `HERMES_LLM_API_KEY` (+ optional `HERMES_LLM_BASE_URL` / `HERMES_LLM_MODEL`; defaults `https://kenari.id/v1` and `deepseek-v4-1-flash`)
- VPS Dockerfile notes: `npm ci --omit=dev --ignore-scripts` (skips better-sqlite3 node-gyp; linux-x64 prebuild ships in the npm tarball), `mkdir -p /app/data && chown node:node /app/data` above `USER node`, explicit `COPY` of root runtime files (`server.mjs`, `agent-runtime.mjs`, `app.js`, `styles.css`, `posthog-init.js` — missing COPYs once shipped an unstyled site)
- Daily DB backup (proven 2026-10-17): root crontab entry `30 3 * * * /opt/mizan/scripts/db-backup.sh >> /opt/mizan/backups/backup.log 2>&1` (VPS clock = CEST → 03:30 local); the script is VPS-only (`*.sh` is gitignored; local copy at `scripts/db-backup.sh`, scp it to `/opt/mizan/scripts/` on (re)deploy): online `better-sqlite3 .backup()` inside the mizan-app container → `/app/data/backups/hermes-YYYYMMDD-HHMMSS.sqlite`, `docker cp` to host `/opt/mizan/backups/`, `integrity_check` + user count against the copy, 14-backup host retention, in-container leftovers older than 1 day pruned; restore drill = `docker cp` a backup back as `hermes.sqlite` (stop app first) or open the copy readonly with better-sqlite3
- Public-launch state (live since 2026-10-17): `/opt/mizan/monitoring/.env` holds `HERMES_DEMO_ACCOUNTS=0` — non-admin demo users (`%@demo.hermes`) purged with their sessions/agents/children at every boot, the `Admin Hermes` row is preserved and (re-)seeded as the control-plane admin (`admin@demo.hermes` / mockup password — public in git history by design; rotate the password in DB if that ever stops being acceptable), `/api/auth/demo` answers `enabled:false`, the auth page demo block stays hidden; real registrants always land as user-role (bootstrap or promote further admins with a one-time `UPDATE users SET role='admin' WHERE email=?` inside the container); setting the env back to `1` and restarting re-seeds the beta demo accounts
- Grafana is live at `https://grafana-sipalinghermes.ssnai.org` (nginx vhost → 127.0.0.1:3001, certbot TLS); Alertmanager posts to `https://slackgateway.ssnai.org/v1/alerts/alertmanager` (native AM JSON, Bearer `ALERTMANAGER_API_KEY`) via a VPS-rendered config (`alertmanager.yml.rendered`, key never in git)

## Verification

- YAML validity: `docker compose -f monitoring/docker-compose.yml config` (validate locally if Docker Desktop exists, otherwise on the VPS)
- App scrape: boot app locally, `curl http://localhost:5173/metrics` shows `hermes_*` counters (see root verification notes); `hermes_agent_*` names appear once the runtime tick runs
- Grafana provisioning errors appear in `docker logs mizan-grafana` on first boot
- On the VPS: `docker compose ps` all Up; `curl -s 127.0.0.1:9090/api/v1/targets` all `up`; `curl -sk https://sipalinghermes.ssnai.org/api/health` → `ok:true`; `https://fairshare.ssnai.org` still 200; `bash /opt/mizan/scripts/db-backup.sh` → `integrity: ok` line in `/opt/mizan/backups/backup.log` and a fresh `hermes-*.sqlite` on the host

## Child DOX Index

(none)
