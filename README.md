# Si Paling Hermes

Satu Hermes Agent untuk semua akun social media-mu: atur model AI, hubungkan
akun, perintah lewat live chat, lihat report dari satu dashboard.

## Jalankan lokal

```bash
npm ci
node server.mjs            # http://localhost:5173
```

| Halaman | URL |
|---|---|
| Landing | `/` |
| Auth (login/register) | `/auth/` |
| Dashboard user | `/dashboard/` |
| Admin control plane | `/admin/` |
| Waiting list VIP | `/lead-magnet/` |

Akun demo (satu klik di halaman auth): `user@demo.hermes` / `UserDemo123!`
dan `admin@demo.hermes` / `AdminDemo123!`.

## Env

| Var | Keterangan |
|---|---|
| `PORT` | default `5173` |
| `POSTHOG_API_KEY` | opsional — tanpa ini, analytics server dinonaktifkan diam-diam |
| `HERMES_LLM_API_KEY` | kunci provider LLM agent — secret, hanya lewat environment |
| `HERMES_LLM_BASE_URL` | default `https://kenari.id/v1` (OpenAI-compatible) |
| `HERMES_LLM_MODEL` | default `deepseek-v4-1-flash` |

Key browser (`posthog-init.js`) adalah publishable `phc_` key — terlihat di
view-source by design. Jangan taruh `phx_` personal key, password, atau token
apa pun di repo ini; semua secret lewat environment (lihat
`monitoring/.env.example` untuk stack monitoring).

## Hermes Agent

Setiap user otomatis dapat satu agent Hermes (provisioning idempotent saat
register / pertama kali membuka dashboard), state-nya di SQLite yang sama dengan
app (`agents`, `agent_accounts`, `agent_chat_messages`, `agent_jobs`,
`agent_events`).

- Live chat lewat LLM OpenAI-compatible yang dikonfigurasi via env: satu panggilan
  `POST {base}/chat/completions`, 12 pesan terakhir sebagai konteks, timeout 90s.
- Queue report mingguan (`scheduled_report`, kunci ISO week) plus "Run report"
  manual; job diklaim satu per satu tiap 5 detik, gagal 3x jadi dead-letter.
- Dashboard user dan panel admin (runtime, queue, audit, LLM) membaca API nyata:
  `/api/agent*` dan `/api/admin/agent*` dengan Bearer session token — tanpa angka
  palsu, empty state jujur.

Konfigurasi LLM (lihat `monitoring/.env.example` — container `mizan-app`
menerimanya dari `monitoring/.env`, pm2 dari environment proses):

| Var | Default | Keterangan |
|---|---|---|
| `HERMES_LLM_API_KEY` | — | wajib untuk chat; secret, jangan pernah di-commit |
| `HERMES_LLM_BASE_URL` | `https://kenari.id/v1` | endpoint OpenAI-compatible |
| `HERMES_LLM_MODEL` | `deepseek-v4-1-flash` | nama model |

Tanpa key, agent berstatus `unconfig` dan chat mengembalikan 503
`llm_unconfigured` by design — tidak ada fallback model.

## Monitoring

Lihat `monitoring/AGENTS.md` — stack Prometheus/Grafana/Alertmanager yang
self-contained (nama resource `mizan-*`, tidak mengganggu stack lain di VPS
yang sama).

## Catatan arsitektur

- Backend: Node `http` + SQLite (`data/`, gitignored) — tanpa framework.
- Runtime Hermes agent berjalan in-process di `server.mjs` (`agent-runtime.mjs`);
  kontrak lengkap ada di `agent-runtime.design.md`.
