// Hermes agent runtime (design contract v2). server.mjs stays the DB owner and API
// gateway: this module receives `db`, the prom-client registry pair, `trackServer`,
// and the server's http helpers, and owns its own DDL, prepared statements, timer,
// and reaper. It never imports prom-client, and it never reads a secret from
// anywhere but the process environment (this repo is public — no keys in code).
//
// Degraded states are honest: with no HERMES_LLM_API_KEY the agent status computes
// `unconfig` and chat returns 503 `llm_unconfigured`. There is no canned reply and
// no fallback model.

const DEFAULT_BASE_URL = 'https://kenari.id/v1';
const DEFAULT_MODEL = 'deepseek-v4-1-flash';
const DEFAULT_CAPABILITIES = { conversations: true, report: true };
// Only capabilities that are real in this phase may be written by the client.
const CAPABILITY_WHITELIST = ['report'];
const PLATFORMS = ['instagram', 'tiktok', 'threads', 'x', 'linkedin', 'facebook'];
const UNSUPPORTED_REASON = 'Belum tersedia di fase ini (butuh integrasi platform)';
const PENDING_OAUTH_NOTE = 'Menunggu OAuth platform. Integrasi platform belum aktif di fase ini.';
const FAILURE_NOTES = {
  llm_unconfigured: 'Runtime LLM belum dikonfigurasi di server.',
  llm_unreachable: 'Provider LLM tidak dapat dihubungi.',
  llm_timeout: 'Provider LLM melewati batas waktu.',
  llm_upstream: 'Provider LLM mengembalikan respons yang tidak valid.'
};
const MAX_NAME = 120;
const MAX_SYSTEM_PROMPT = 2000;
const MAX_MESSAGE = 2000;
const MAX_HANDLE = 80;
const MAX_LIST_LIMIT = 200;
const CHAT_WINDOW_MS = 60_000;
const CHAT_WINDOW_LIMIT = 20;
const CHAT_INFLIGHT_LIMIT = 2;
const CHAT_CONTEXT_MESSAGES = 12;
const LLM_MAX_TOKENS = 500;
const LLM_TIMEOUT_MS = 90_000;
const TICK_MS = 5_000;
const REAP_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const DETAIL_MAX = 200;
const CONTENT_MAX = 4000;

const PERSONA = [
  'Kamu adalah Hermes, agen media sosial otonom untuk pelaku UMKM dan kreator Indonesia.',
  'Kamu membantu pemilik akun: ide konten, caption, hashtag, jadwal, ringkasan aktivitas, dan status agen — selalu jujur sesuai aturan di bawah.',
  'Jawab pertanyaan pemilik akun secara langsung dulu; informasi tentang status agen hanya relevan jika ditanyakan atau benar-benar perlu.',
  'Jawab dalam Bahasa Indonesia yang ringkas, jelas, dan praktis.'
].join(' ');
const USER_POLICY = [
  'Aturan wajib:',
  '1. Jangan pernah mengarang angka, hasil, atau aksi platform yang belum benar-benar terjadi.',
  '2. Kalau data tidak tersedia, katakan datanya belum tersedia.',
  '3. Jangan meminta atau mengulang data pribadi (email, nomor WhatsApp, handle akun).',
  '4. Jawab maksimal 200 kata kecuali diminta lain.'
].join('\n');

export default function installAgentRuntime({ db, register, client, trackServer, http }) {
  const { json, readJson, getUser } = http;

  // ---- schema (owned by this module; one process writes) --------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      model TEXT,
      system_prompt TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '{"conversations":true,"report":true}',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'unconfig')),
      status_detail TEXT NOT NULL DEFAULT '',
      last_status_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agent_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'threads', 'x', 'linkedin', 'facebook')),
      handle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_oauth' CHECK (status IN ('pending_oauth', 'connected', 'error')),
      status_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(agent_id, platform, handle)
    );
    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'report', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_agent ON agent_chat_messages(agent_id, created_at);
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('scheduled_report', 'manual_report')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      week_key TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status, id);
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      actor TEXT NOT NULL DEFAULT 'system' CHECK (actor IN ('user', 'admin', 'system')),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_events_id ON agent_events(id);
  `);
  // week_key is nonempty (and therefore unique per agent+type) ONLY for
  // scheduled_report, so manual_report rows stay repeatable.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_week ON agent_jobs(agent_id, type, week_key) WHERE week_key <> ''");

  // ---- provider resolution (env only, no key ever leaves this module) -------
  const llmApiKey = process.env.HERMES_LLM_API_KEY || '';
  const llmBaseUrl = (process.env.HERMES_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const llmModel = process.env.HERMES_LLM_MODEL || DEFAULT_MODEL;
  const llmConfigured = Boolean(llmApiKey);
  let llmProviderHost = '';
  try { llmProviderHost = new URL(llmBaseUrl).host; } catch { llmProviderHost = ''; }
  const llmMetadata = () => ({ configured: llmConfigured, model: llmModel, provider_host: llmProviderHost });

  // ---- metrics (injected client/register; metrics never break the API) ------
  const guardMetric = (build) => {
    try { return build(); } catch { return { inc() {}, set() {}, observe() {} }; }
  };
  const jobsTotal = guardMetric(() => new client.Counter({
    name: 'hermes_agent_jobs_total',
    help: 'Agent jobs that left running state, by job type and resulting status.',
    labelNames: ['type', 'status'],
    registers: [register]
  }));
  const queueDepthGauge = guardMetric(() => new client.Gauge({
    name: 'hermes_agent_queue_depth',
    help: 'Agent jobs currently queued (set on every tick).',
    registers: [register]
  }));
  const llmLatency = guardMetric(() => new client.Histogram({
    name: 'hermes_agent_llm_latency_seconds',
    help: 'LLM chat-completions round-trip duration for calls that got a response.',
    buckets: [0.5, 1, 2, 5, 15, 30, 60, 90],
    registers: [register]
  }));
  const llmErrors = guardMetric(() => new client.Counter({
    name: 'hermes_agent_llm_errors_total',
    help: 'LLM failures by closed error code.',
    labelNames: ['code'],
    registers: [register]
  }));
  const observeLatency = (seconds) => { try { llmLatency.observe(seconds); } catch { /* metrics only */ } };
  const incJobs = (type, status) => { try { jobsTotal.inc({ type, status }); } catch { /* metrics only */ } };
  const incLlmError = (code) => { try { llmErrors.inc({ code }); } catch { /* metrics only */ } };

  // ---- prepared statements (better-sqlite3 is synchronous) ------------------
  const stmt = db.prepare.bind(db);
  const insertAgentForUser = stmt('INSERT OR IGNORE INTO agents (user_id, name, model, capabilities) VALUES (?, ?, ?, ?)');
  const backfillAgents = stmt("INSERT OR IGNORE INTO agents (user_id, name, model, capabilities) SELECT id, 'Hermes ' || name, ?, ? FROM users");
  const selectAgentByUser = stmt('SELECT id, user_id, name, model, system_prompt, capabilities, enabled, status, status_detail, last_status_at, created_at FROM agents WHERE user_id = ?');
  const selectAgentById = stmt('SELECT id, user_id, name, model, system_prompt, capabilities, enabled, status, status_detail, last_status_at, created_at FROM agents WHERE id = ?');
  const selectAgentsForSweep = stmt('SELECT id, status FROM agents');
  const selectEnabledAgents = stmt('SELECT id, capabilities FROM agents WHERE enabled = 1');
  const selectAgentsDetailed = stmt(`
    SELECT agents.id, agents.user_id, users.name AS user_name, users.email AS user_email, agents.name, agents.model,
           agents.enabled, agents.status, agents.status_detail, agents.last_status_at, agents.created_at
    FROM agents LEFT JOIN users ON users.id = agents.user_id ORDER BY agents.id`);
  const updateAgentConfig = stmt('UPDATE agents SET name = COALESCE(?, name), system_prompt = COALESCE(?, system_prompt), capabilities = COALESCE(?, capabilities), last_status_at = CURRENT_TIMESTAMP WHERE id = ?');
  const updateAgentToggle = stmt("UPDATE agents SET enabled = ?, status = ?, status_detail = '', last_status_at = CURRENT_TIMESTAMP WHERE id = ?");
  const updateAgentStatus = stmt("UPDATE agents SET status = ?, status_detail = ?, last_status_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'paused'");

  const insertAccount = stmt('INSERT INTO agent_accounts (agent_id, platform, handle, status, status_note) VALUES (?, ?, ?, ?, ?)');
  const selectAccountsByAgent = stmt('SELECT id, platform, handle, status, status_note, created_at FROM agent_accounts WHERE agent_id = ? ORDER BY id');
  const selectAccountByKey = stmt('SELECT id, platform, handle, status, status_note, created_at FROM agent_accounts WHERE agent_id = ? AND platform = ? AND handle = ?');
  const selectAccountById = stmt('SELECT id, platform, handle, status, status_note FROM agent_accounts WHERE id = ? AND agent_id = ?');
  const deleteAccountById = stmt('DELETE FROM agent_accounts WHERE id = ? AND agent_id = ?');

  const insertMessage = stmt('INSERT INTO agent_chat_messages (agent_id, role, kind, content) VALUES (?, ?, ?, ?)');
  const selectMessageById = stmt('SELECT id, role, kind, content, created_at FROM agent_chat_messages WHERE id = ?');
  const selectMessagesRecent = stmt('SELECT id, role, kind, content, created_at FROM agent_chat_messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?');
  const selectMessagesAfter = stmt('SELECT id, role, kind, content, created_at FROM agent_chat_messages WHERE agent_id = ? AND id > ? ORDER BY id ASC LIMIT ?');
  const selectChatContext = stmt("SELECT role, content FROM agent_chat_messages WHERE agent_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT ?");
  const countUserMessages7d = stmt("SELECT COUNT(*) AS count FROM agent_chat_messages WHERE agent_id = ? AND role = 'user' AND created_at >= datetime('now', '-7 days')");

  const insertScheduledJob = stmt("INSERT OR IGNORE INTO agent_jobs (agent_id, type, status, week_key) VALUES (?, 'scheduled_report', 'queued', ?)");
  const insertManualJob = stmt("INSERT INTO agent_jobs (agent_id, type, status, week_key) VALUES (?, 'manual_report', 'queued', '')");
  const selectActiveJob = stmt("SELECT id, type, status FROM agent_jobs WHERE agent_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1");
  const selectWeekJobAgents = stmt("SELECT agent_id FROM agent_jobs WHERE type = 'scheduled_report' AND week_key = ?");
  const selectNextQueued = stmt("SELECT id FROM agent_jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
  const claimQueuedJob = stmt("UPDATE agent_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'");
  const selectJobById = stmt('SELECT id, agent_id, type, status, week_key, attempts FROM agent_jobs WHERE id = ?');
  const selectJobAttempts = stmt('SELECT attempts FROM agent_jobs WHERE id = ?');
  const incrementJobAttempts = stmt('UPDATE agent_jobs SET attempts = attempts + 1 WHERE id = ?');
  const requeueJob = stmt('UPDATE agent_jobs SET status = \'queued\', started_at = NULL, error = ? WHERE id = ?');
  const failJobRow = stmt("UPDATE agent_jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?");
  const completeJobRow = stmt("UPDATE agent_jobs SET status = 'done', finished_at = CURRENT_TIMESTAMP, result = ?, error = NULL WHERE id = ?");
  const releaseJobRow = stmt("UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE id = ?");
  const reapStuckRows = stmt(`UPDATE agent_jobs SET status = 'queued', started_at = NULL, error = ? WHERE status = 'running' AND started_at IS NOT NULL AND started_at < datetime('now', '-${REAP_MINUTES} minutes')`);
  const requeueFailedRows = stmt("UPDATE agent_jobs SET status = 'queued', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE agent_id = ? AND status = 'failed'");
  const countQueued = stmt("SELECT COUNT(*) AS count FROM agent_jobs WHERE status = 'queued'");
  const countQueuedForAgent = stmt("SELECT COUNT(*) AS count FROM agent_jobs WHERE agent_id = ? AND status = 'queued'");
  const countQueuedByAgent = stmt("SELECT agent_id, COUNT(*) AS count FROM agent_jobs WHERE status = 'queued' GROUP BY agent_id");
  const countMessagesByAgent = stmt('SELECT agent_id, COUNT(*) AS count FROM agent_chat_messages GROUP BY agent_id');
  const countAccountsByAgent = stmt('SELECT agent_id, COUNT(*) AS count FROM agent_accounts GROUP BY agent_id');
  const listJobs = stmt(`
    SELECT agent_jobs.id, agent_jobs.agent_id, agents.name AS agent_name, agent_jobs.type, agent_jobs.status, agent_jobs.week_key,
           agent_jobs.attempts, agent_jobs.error, agent_jobs.created_at, agent_jobs.started_at, agent_jobs.finished_at
    FROM agent_jobs LEFT JOIN agents ON agents.id = agent_jobs.agent_id ORDER BY agent_jobs.id DESC LIMIT 50`);

  const insertEvent = stmt('INSERT INTO agent_events (agent_id, actor, action, detail) VALUES (?, ?, ?, ?)');
  const selectAgentEvents = stmt('SELECT id, actor, action, detail, created_at FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT 10');
  const listEvents = stmt(`
    SELECT agent_events.id, agent_events.agent_id, agents.name AS agent_name, agent_events.actor, agent_events.action,
           agent_events.detail, agent_events.created_at
    FROM agent_events LEFT JOIN agents ON agents.id = agent_events.agent_id ORDER BY agent_events.id DESC LIMIT 50`);

  const selectUserName = stmt('SELECT id, name FROM users WHERE id = ?');
  const selectWeekKey = stmt("SELECT strftime('%G-W%V','now') AS week_key");
  let countWaitingList = null;
  try { countWaitingList = stmt('SELECT COUNT(*) AS count FROM waitinglist'); } catch { countWaitingList = null; }

  // ---- helpers -------------------------------------------------------------
  const truncate = (value, max = DETAIL_MAX) => String(value == null ? '' : value).slice(0, max);

  const parseCapabilities = (raw) => {
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}') || {}; } catch { parsed = {}; }
    return {
      conversations: 'conversations' in parsed ? parsed.conversations === true : DEFAULT_CAPABILITIES.conversations,
      report: 'report' in parsed ? parsed.report === true : DEFAULT_CAPABILITIES.report
    };
  };

  const ensureAgentForUser = (userId) => {
    const existing = selectAgentByUser.get(userId);
    if (existing) return existing;
    const user = selectUserName.get(userId);
    const name = user && user.name ? `Hermes ${user.name}` : 'Hermes Agent';
    insertAgentForUser.run(userId, truncate(name, MAX_NAME), llmModel, JSON.stringify(DEFAULT_CAPABILITIES));
    return selectAgentByUser.get(userId);
  };

  const backfillAll = () => {
    const result = backfillAgents.run(llmModel, JSON.stringify(DEFAULT_CAPABILITIES));
    const created = result && result.changes ? result.changes : 0;
    if (created > 0) trackServer('agent-runtime', 'agent_registered', { count: created });
    return created;
  };

  const logEvent = (agentId, actor, action, detail = {}) => {
    try { insertEvent.run(agentId, actor, action, JSON.stringify(detail)); } catch { /* audit must not break the action */ }
  };

  const publicMessage = (row) => ({ id: row.id, role: row.role, kind: row.kind, content: row.content, created_at: row.created_at });

  const persistMessage = (agentId, role, kind, content) => {
    const result = insertMessage.run(agentId, role, kind, truncate(content, 20_000));
    return selectMessageById.get(result.lastInsertRowid);
  };

  const capabilityList = (agent) => {
    const caps = parseCapabilities(agent.capabilities);
    const enabled = agent.enabled === 1;
    return [
      {
        key: 'conversations',
        enabled,
        supported: true,
        state: enabled ? 'aktif' : 'nonaktif',
        reason: enabled ? '' : 'Agent dinonaktifkan.'
      },
      {
        key: 'report',
        enabled: caps.report,
        supported: true,
        state: caps.report && enabled ? 'aktif' : 'nonaktif',
        reason: caps.report ? (enabled ? '' : 'Agent dinonaktifkan.') : 'Laporan mingguan dimatikan.'
      },
      { key: 'comments', enabled: false, supported: false, state: 'belum_tersedia', reason: UNSUPPORTED_REASON },
      { key: 'schedule', enabled: false, supported: false, state: 'belum_tersedia', reason: UNSUPPORTED_REASON }
    ];
  };

  const agentSnapshot = (agent) => ({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      system_prompt: agent.system_prompt,
      enabled: agent.enabled === 1,
      status: agent.status,
      status_detail: agent.status_detail,
      last_status_at: agent.last_status_at,
      created_at: agent.created_at,
      llm: llmMetadata()
    },
    capabilities: capabilityList(agent),
    accounts: selectAccountsByAgent.all(agent.id).map((row) => ({
      id: row.id, platform: row.platform, handle: row.handle, status: row.status, status_note: row.status_note
    })),
    events: selectAgentEvents.all(agent.id).map((row) => ({
      id: row.id, actor: row.actor, action: row.action, detail: row.detail, created_at: row.created_at
    })),
    queue_depth: countQueuedForAgent.get(agent.id).count
  });

  // "paused" is written by a human (toggle/admin) and is never overwritten here.
  const applyAgentOutcome = (agentId, code) => {
    if (!code) { updateAgentStatus.run('active', '', agentId); return; }
    const status = code === 'llm_unconfigured' ? 'unconfig' : 'error';
    updateAgentStatus.run(status, truncate(code), agentId);
  };

  const readBody = async (req, res) => {
    try { return { ok: true, body: await readJson(req) }; }
    catch { json(res, 400, { ok: false, message: 'Invalid JSON' }); return { ok: false }; }
  };

  const requireUser = (req, res) => {
    const session = getUser(req);
    if (!session) { json(res, 401, { ok: false, message: 'Session tidak ditemukan.' }); return null; }
    return session;
  };

  const requireAdmin = (req, res) => {
    const session = getUser(req);
    if (!session || session.role !== 'admin') { json(res, 403, { ok: false, message: 'Hanya admin yang memiliki izin akses.' }); return null; }
    return session;
  };

  const chatWindows = new Map();
  const chatInflight = new Map();

  const acquireChatSlot = (userId) => {
    const now = Date.now();
    if (chatWindows.size > 500) {
      for (const [key, value] of chatWindows) if (now - value.start >= CHAT_WINDOW_MS * 2) chatWindows.delete(key);
    }
    const window = chatWindows.get(userId);
    if (!window || now - window.start >= CHAT_WINDOW_MS) chatWindows.set(userId, { start: now, count: 1 });
    else if (window.count >= CHAT_WINDOW_LIMIT) return { ok: false, code: 'rate_limited' };
    else window.count += 1;
    const inflight = chatInflight.get(userId) || 0;
    if (inflight >= CHAT_INFLIGHT_LIMIT) return { ok: false, code: 'chat_busy' };
    chatInflight.set(userId, inflight + 1);
    return { ok: true };
  };

  const releaseChatSlot = (userId) => {
    const inflight = chatInflight.get(userId) || 0;
    if (inflight <= 1) chatInflight.delete(userId);
    else chatInflight.set(userId, inflight - 1);
  };

  // ---- LLM adapter (closed error-code set; no provider strings surface) -----
  const systemPromptFor = (agent) => {
    const own = String(agent.system_prompt || '').trim();
    return own ? `${PERSONA}\n\n${USER_POLICY}\n\nInstruksi tambahan dari pemilik agen:\n${truncate(own, MAX_SYSTEM_PROMPT)}` : `${PERSONA}\n\n${USER_POLICY}`;
  };

  const buildChatContext = (agentId) => {
    const rows = selectChatContext.all(agentId, CHAT_CONTEXT_MESSAGES);
    rows.reverse();
    return rows.map((row) => ({ role: row.role === 'user' ? 'user' : 'assistant', content: truncate(row.content, CONTENT_MAX) }));
  };

  const callLlm = async (messages, systemPrompt, signal) => {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(`${llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmApiKey}` },
        body: JSON.stringify({
          model: llmModel,
          max_tokens: LLM_MAX_TOKENS,
          messages: [{ role: 'system', content: systemPrompt }, ...messages]
        }),
        signal
      });
    } catch (error) {
      const aborted = Boolean(error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
      return { ok: false, code: aborted ? 'llm_timeout' : 'llm_unreachable' };
    }
    observeLatency((Date.now() - startedAt) / 1000);
    try {
      const payload = await response.json();
      const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
      const content = choice && choice.message ? String(choice.message.content || '').trim() : '';
      if (!response.ok || !content) return { ok: false, code: 'llm_upstream' };
      return { ok: true, content: truncate(content, CONTENT_MAX) };
    } catch {
      return { ok: false, code: signal && signal.aborted ? 'llm_timeout' : 'llm_upstream' };
    }
  };

  const recordLlmFailure = (code, distinctId) => {
    incLlmError(code);
    trackServer(String(distinctId), 'agent_llm_error', { code });
  };

  // ---- runtime loop (module-owned timer, one claim at a time) --------------
  const gatherAgentMetrics = (agentId) => {
    const accounts = selectAccountsByAgent.all(agentId).map((row) => ({ platform: row.platform, status: row.status }));
    let waitinglistTotal = 0;
    if (countWaitingList) { try { waitinglistTotal = countWaitingList.get().count; } catch { waitinglistTotal = 0; } }
    return {
      chat_messages_7d: countUserMessages7d.get(agentId).count,
      accounts_total: accounts.length,
      accounts,
      waitinglist_total: waitinglistTotal
    };
  };

  const buildReportPrompt = (agent, job, metrics) => [
    `Buat ${job.type === 'scheduled_report' ? 'laporan mingguan' : 'laporan atas permintaan'} singkat (maksimal 150 kata) dalam Bahasa Indonesia untuk agen "${truncate(agent.name, MAX_NAME)}".`,
    'Gunakan HANYA angka dan fakta berikut, jangan menambah data lain:',
    JSON.stringify(metrics),
    'Sertakan: aktivitas chat 7 hari terakhir, status akun platform, dan konteks total antrean waiting list platform.',
    'Kalau suatu bagian kosong, tulis bahwa datanya belum ada. Jangan mengarang hasil atau performa.'
  ].join('\n');

  const failJob = db.transaction((jobId, code) => {
    incrementJobAttempts.run(jobId);
    const row = selectJobAttempts.get(jobId);
    const attempts = row ? row.attempts : MAX_ATTEMPTS;
    const detail = truncate(code);
    if (attempts < MAX_ATTEMPTS) { requeueJob.run(detail, jobId); return { attempts, status: 'queued' }; }
    failJobRow.run(detail, jobId);
    return { attempts, status: 'failed' };
  });

  const claimNextJob = db.transaction(() => {
    const candidate = selectNextQueued.get();
    if (!candidate) return null;
    if (!claimQueuedJob.run(candidate.id).changes) return null;
    return selectJobById.get(candidate.id);
  });

  const reapStuckJobs = () => {
    const result = reapStuckRows.run('reclaimed: proses sebelumnya mati di tengah jalan');
    return result && result.changes ? result.changes : 0;
  };

  const ensureWeeklyJobs = () => {
    const weekKey = selectWeekKey.get().week_key;
    const done = new Set(selectWeekJobAgents.all(weekKey).map((row) => row.agent_id));
    let created = 0;
    for (const agent of selectEnabledAgents.all()) {
      if (done.has(agent.id) || !parseCapabilities(agent.capabilities).report) continue;
      const result = insertScheduledJob.run(agent.id, weekKey);
      if (result && result.changes) created += 1;
    }
    return created;
  };

  const sweepAgentStatus = () => {
    for (const agent of selectAgentsForSweep.all()) {
      if (agent.status === 'paused') continue;
      if (!llmConfigured) {
        if (agent.status !== 'unconfig') updateAgentStatus.run('unconfig', 'llm_unconfigured', agent.id);
        continue;
      }
      if (agent.status === 'unconfig') updateAgentStatus.run('active', '', agent.id);
    }
  };

  const runReportJob = async (job, agent) => {
    const metrics = gatherAgentMetrics(agent.id);
    const result = await callLlm([{ role: 'user', content: buildReportPrompt(agent, job, metrics) }], systemPromptFor(agent), AbortSignal.timeout(LLM_TIMEOUT_MS));
    if (!result.ok) return { ok: false, code: result.code };
    // A pause that lands mid-call must not write the report payload.
    const fresh = selectAgentById.get(agent.id);
    if (!fresh || fresh.enabled !== 1) {
      completeJobRow.run(JSON.stringify({ skipped: 'agent_disabled_midrun', week_key: job.week_key }), job.id);
      return { ok: true, skipped: true };
    }
    const row = persistMessage(agent.id, 'agent', 'report', result.content);
    completeJobRow.run(JSON.stringify({
      kind: job.type === 'scheduled_report' ? 'scheduled' : 'manual',
      week_key: job.week_key,
      metrics,
      message_id: row.id
    }), job.id);
    return { ok: true };
  };

  const runClaimedJob = async (job) => {
    const agent = selectAgentById.get(job.agent_id);
    if (!agent || agent.enabled !== 1) { releaseJobRow.run(job.id); return; }
    const kind = job.type === 'scheduled_report' ? 'scheduled' : 'manual';
    if (!llmConfigured) {
      const failed = failJob(job.id, 'llm_unconfigured');
      incJobs(job.type, failed.status);
      recordLlmFailure('llm_unconfigured', agent.user_id);
      logEvent(agent.id, 'system', 'agent_report_failed', { kind, job_id: job.id, code: 'llm_unconfigured', attempts: failed.attempts });
      applyAgentOutcome(agent.id, 'llm_unconfigured');
      return;
    }
    const outcome = await runReportJob(job, agent);
    if (outcome.ok) {
      incJobs(job.type, 'done');
      applyAgentOutcome(agent.id, '');
      logEvent(agent.id, 'system', 'agent_report_ready', { kind, job_id: job.id, skipped: Boolean(outcome.skipped) });
      trackServer(String(agent.user_id), 'agent_report_generated', { kind });
      return;
    }
    const failed = failJob(job.id, outcome.code);
    incJobs(job.type, failed.status);
    recordLlmFailure(outcome.code, agent.user_id);
    logEvent(agent.id, 'system', 'agent_report_failed', { kind, job_id: job.id, code: outcome.code, attempts: failed.attempts });
    applyAgentOutcome(agent.id, outcome.code);
  };

  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      reapStuckJobs();
      ensureWeeklyJobs();
      sweepAgentStatus();
      const job = claimNextJob();
      if (job) await runClaimedJob(job);
    } catch { /* a tick must never take the process down */ }
    finally {
      try { queueDepthGauge.set(countQueued.get().count); } catch { /* metrics only */ }
      tickRunning = false;
    }
  };

  // ---- user API -----------------------------------------------------------
  const handleAgentGet = (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    json(res, 200, agentSnapshot(agent));
    return true;
  };

  const handleAgentConfig = async (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    const parsed = await readBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body || {};
    const fields = [];
    let name = null;
    let systemPrompt = null;
    let capabilities = null;
    if (body.name !== undefined) {
      name = truncate(String(body.name).trim(), MAX_NAME);
      if (!name) { json(res, 422, { ok: false, message: 'Nama agen wajib diisi.' }); return true; }
      fields.push('name');
    }
    if (body.system_prompt !== undefined) {
      systemPrompt = String(body.system_prompt);
      if (systemPrompt.length > MAX_SYSTEM_PROMPT) { json(res, 422, { ok: false, message: `system_prompt maksimal ${MAX_SYSTEM_PROMPT} karakter.` }); return true; }
      fields.push('system_prompt');
    }
    if (body.capabilities !== undefined) {
      if (typeof body.capabilities !== 'object' || body.capabilities === null || Array.isArray(body.capabilities)) {
        json(res, 422, { ok: false, message: 'capabilities harus berupa objek.' });
        return true;
      }
      const merged = Object.assign({}, parseCapabilities(agent.capabilities));
      for (const key of CAPABILITY_WHITELIST) {
        if (key in body.capabilities) merged[key] = body.capabilities[key] === true;
      }
      capabilities = JSON.stringify(merged);
      fields.push('capabilities');
    }
    if (fields.length) {
      updateAgentConfig.run(name, systemPrompt, capabilities, agent.id);
      logEvent(agent.id, session.role === 'admin' ? 'admin' : 'user', 'agent_config_updated', { fields });
    }
    json(res, 200, agentSnapshot(selectAgentById.get(agent.id)));
    return true;
  };

  const handleAgentToggle = async (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    const parsed = await readBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body || {};
    if (typeof body.enabled !== 'boolean') { json(res, 422, { ok: false, message: 'Field enabled harus boolean.' }); return true; }
    const enabled = body.enabled ? 1 : 0;
    updateAgentToggle.run(enabled, enabled ? 'active' : 'paused', agent.id);
    logEvent(agent.id, session.role === 'admin' ? 'admin' : 'user', 'agent_toggled', { enabled: body.enabled });
    trackServer(String(session.id), 'agent_toggled', { enabled: body.enabled });
    json(res, 200, agentSnapshot(selectAgentById.get(agent.id)));
    return true;
  };

  const handleAgentChat = async (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    if (!agent.enabled) {
      json(res, 503, { ok: false, code: 'agent_paused', message: 'Agent sedang dimatikan. Nyalakan agent untuk chat.' });
      return true;
    }
    const parsed = await readBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body || {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE) {
      json(res, 422, { ok: false, message: `Pesan wajib diisi dan maksimal ${MAX_MESSAGE} karakter.` });
      return true;
    }
    const slot = acquireChatSlot(session.id);
    if (!slot.ok) {
      res.setHeader('Retry-After', '60');
      json(res, 429, {
        ok: false,
        code: slot.code,
        message: slot.code === 'chat_busy' ? 'Masih ada 2 permintaan chat berjalan. Coba lagi sebentar.' : 'Batas 20 pesan per menit tercapai.'
      });
      return true;
    }
    try {
      // The user row is persisted before the LLM call so a 503 never erases it.
      const userRow = persistMessage(agent.id, 'user', 'chat', message);
      trackServer(String(session.id), 'agent_chat_sent', { message_length: message.length });
      if (!llmConfigured) {
        persistMessage(agent.id, 'agent', 'system', FAILURE_NOTES.llm_unconfigured);
        recordLlmFailure('llm_unconfigured', session.id);
        applyAgentOutcome(agent.id, 'llm_unconfigured');
        if (!res.writableEnded) json(res, 503, { ok: false, code: 'llm_unconfigured', message: FAILURE_NOTES.llm_unconfigured, message_row: publicMessage(userRow) });
        return true;
      }
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on('close', onClose);
      let outcome;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]);
        outcome = await callLlm(buildChatContext(agent.id), systemPromptFor(agent), signal);
      } finally {
        res.off('close', onClose);
      }
      if (outcome.ok) {
        const reply = persistMessage(agent.id, 'agent', 'chat', outcome.content);
        applyAgentOutcome(agent.id, '');
        if (!res.writableEnded) json(res, 200, { ok: true, reply: publicMessage(reply), message: publicMessage(userRow) });
        return true;
      }
      persistMessage(agent.id, 'agent', 'system', FAILURE_NOTES[outcome.code] || FAILURE_NOTES.llm_upstream);
      recordLlmFailure(outcome.code, session.id);
      logEvent(agent.id, 'system', 'agent_chat_error', { code: outcome.code });
      applyAgentOutcome(agent.id, outcome.code);
      if (!res.writableEnded) {
        json(res, 503, { ok: false, code: outcome.code, message: FAILURE_NOTES[outcome.code] || FAILURE_NOTES.llm_upstream, message_row: publicMessage(userRow) });
      }
      return true;
    } finally {
      releaseChatSlot(session.id);
    }
  };

  const handleAgentConnect = async (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    const parsed = await readBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body || {};
    const platform = String(body.platform || '').trim().toLowerCase();
    const handle = String(body.handle || '').trim();
    if (!PLATFORMS.includes(platform)) { json(res, 422, { ok: false, message: `Platform harus salah satu dari: ${PLATFORMS.join(', ')}.` }); return true; }
    if (!handle) { json(res, 422, { ok: false, message: 'Handle akun wajib diisi.' }); return true; }
    if (handle.length > MAX_HANDLE) { json(res, 422, { ok: false, message: `Handle akun maksimal ${MAX_HANDLE} karakter.` }); return true; }
    const existing = selectAccountByKey.get(agent.id, platform, handle);
    if (existing) {
      json(res, 409, {
        ok: false,
        message: 'Akun platform ini sudah tercatat.',
        account: { id: existing.id, platform: existing.platform, handle: existing.handle, status: existing.status, status_note: existing.status_note }
      });
      return true;
    }
    const result = insertAccount.run(agent.id, platform, handle, 'pending_oauth', PENDING_OAUTH_NOTE);
    // Audit carries platform + account id only — never the handle (no PII in events).
    logEvent(agent.id, session.role === 'admin' ? 'admin' : 'user', 'agent_connected', { platform, account_id: Number(result.lastInsertRowid) });
    trackServer(String(session.id), 'agent_connected', { platform });
    const account = selectAccountByKey.get(agent.id, platform, handle);
    json(res, 201, { ok: true, account: { id: account.id, platform: account.platform, handle: account.handle, status: account.status, status_note: account.status_note } });
    return true;
  };

  const handleAccountDelete = (req, res, accountId) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    const account = selectAccountById.get(accountId, agent.id);
    if (!account) { json(res, 404, { ok: false, message: 'Akun platform tidak ditemukan.' }); return true; }
    deleteAccountById.run(accountId, agent.id);
    logEvent(agent.id, session.role === 'admin' ? 'admin' : 'user', 'agent_account_removed', { platform: account.platform, account_id: account.id });
    json(res, 200, { ok: true, removed: account.id });
    return true;
  };

  const handleMessagesGet = (req, res, url) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    const parsedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_LIST_LIMIT) : 50;
    const parsedAfter = Number.parseInt(url.searchParams.get('after') || '', 10);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;
    const rows = after
      ? selectMessagesAfter.all(agent.id, after, limit)
      : selectMessagesRecent.all(agent.id, limit).reverse();
    const messages = rows.map(publicMessage);
    json(res, 200, { ok: true, messages, cursor: messages.length ? messages[messages.length - 1].id : after });
    return true;
  };

  const enqueueReport = (agent, res, actorRole) => {
    if (agent.enabled !== 1) { json(res, 409, { ok: false, message: 'Agent sedang dinonaktifkan.' }); return true; }
    if (!parseCapabilities(agent.capabilities).report) { json(res, 409, { ok: false, message: 'Fitur laporan mingguan sedang dimatikan.' }); return true; }
    const active = selectActiveJob.get(agent.id);
    if (active) { json(res, 409, { ok: false, message: 'Sudah ada laporan yang menunggu atau sedang diproses.' }); return true; }
    const result = insertManualJob.run(agent.id);
    const job = selectJobById.get(result.lastInsertRowid);
    logEvent(agent.id, actorRole, 'agent_report_enqueued', { kind: 'manual', job_id: job.id });
    json(res, 201, { ok: true, job: { id: job.id, type: job.type, status: job.status, week_key: job.week_key } });
    return true;
  };

  const handleReportPost = (req, res) => {
    const session = requireUser(req, res);
    if (!session) return true;
    const agent = ensureAgentForUser(session.id);
    return enqueueReport(agent, res, session.role === 'admin' ? 'admin' : 'user');
  };

  // ---- admin API ----------------------------------------------------------
  const handleAdminAgents = (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return true;
    const agents = selectAgentsDetailed.all();
    const queued = new Map(countQueuedByAgent.all().map((row) => [row.agent_id, row.count]));
    const messages = new Map(countMessagesByAgent.all().map((row) => [row.agent_id, row.count]));
    const accounts = new Map(countAccountsByAgent.all().map((row) => [row.agent_id, row.count]));
    const totals = { total: agents.length, active: 0, paused: 0, error: 0, unconfig: 0, queue_depth: 0 };
    const rows = agents.map((row) => {
      const queueDepth = queued.get(row.id) || 0;
      totals[row.status] = (totals[row.status] || 0) + 1;
      totals.queue_depth += queueDepth;
      return {
        id: row.id,
        user_id: row.user_id,
        user_name: row.user_name,
        user_email: row.user_email,
        name: row.name,
        model: row.model,
        enabled: row.enabled === 1,
        status: row.status,
        status_detail: row.status_detail,
        last_status_at: row.last_status_at,
        created_at: row.created_at,
        queue_depth: queueDepth,
        messages: messages.get(row.id) || 0,
        accounts: accounts.get(row.id) || 0
      };
    });
    json(res, 200, { ok: true, llm: llmMetadata(), totals, agents: rows });
    return true;
  };

  const handleAdminJobs = (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return true;
    json(res, 200, { ok: true, jobs: listJobs.all() });
    return true;
  };

  const handleAdminAudit = (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return true;
    json(res, 200, { ok: true, events: listEvents.all() });
    return true;
  };

  const handleAdminAction = async (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return true;
    const parsed = await readBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body || {};
    const agentId = Number.parseInt(body.agent_id, 10);
    if (!Number.isFinite(agentId)) { json(res, 422, { ok: false, message: 'agent_id wajib berupa angka.' }); return true; }
    const agent = selectAgentById.get(agentId);
    if (!agent) { json(res, 404, { ok: false, message: 'Agent tidak ditemukan.' }); return true; }
    const action = String(body.action || '');
    if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable' ? 1 : 0;
      updateAgentToggle.run(enabled, enabled ? 'active' : 'paused', agent.id);
      logEvent(agent.id, 'admin', 'agent_admin_action', { action });
      trackServer(String(session.id), 'agent_toggled', { enabled: Boolean(enabled) });
      json(res, 200, { ok: true, action, agent_id: agent.id, enabled: Boolean(enabled) });
      return true;
    }
    if (action === 'requeue_failed') {
      const result = requeueFailedRows.run(agent.id);
      const requeued = result && result.changes ? result.changes : 0;
      logEvent(agent.id, 'admin', 'agent_admin_action', { action, requeued });
      json(res, 200, { ok: true, action, agent_id: agent.id, requeued });
      return true;
    }
    if (action === 'run_report') {
      return enqueueReport(agent, res, 'admin');
    }
    json(res, 422, { ok: false, message: "action harus salah satu dari: enable, disable, requeue_failed, run_report." });
    return true;
  };

  // ---- routing ------------------------------------------------------------
  const isAgentPath = (pathname) => pathname === '/api/agent'
    || pathname.startsWith('/api/agent/')
    || pathname.startsWith('/api/admin/agent');

  async function dispatch(req, res, url) {
    const method = req.method;
    const pathname = url.pathname;
    const accountMatch = /^\/api\/agent\/accounts\/(\d+)$/.exec(pathname);

    if (method === 'GET' && pathname === '/api/agent') return handleAgentGet(req, res);
    if (method === 'PUT' && pathname === '/api/agent/config') return handleAgentConfig(req, res);
    if (method === 'POST' && pathname === '/api/agent/toggle') return handleAgentToggle(req, res);
    if (method === 'POST' && pathname === '/api/agent/chat') return handleAgentChat(req, res);
    if (method === 'POST' && pathname === '/api/agent/connect') return handleAgentConnect(req, res);
    if (method === 'GET' && pathname === '/api/agent/messages') return handleMessagesGet(req, res, url);
    if (method === 'POST' && pathname === '/api/agent/report') return handleReportPost(req, res);
    if (method === 'DELETE' && accountMatch) return handleAccountDelete(req, res, Number(accountMatch[1]));

    if (method === 'GET' && pathname === '/api/admin/agents') return handleAdminAgents(req, res);
    if (method === 'GET' && pathname === '/api/admin/agent-jobs') return handleAdminJobs(req, res);
    if (method === 'GET' && pathname === '/api/admin/agent-audit') return handleAdminAudit(req, res);
    if (method === 'POST' && pathname === '/api/admin/agent-action') return handleAdminAction(req, res);

    return false;
  }

  // Returns true when the request was handled; false lets server.mjs fall through
  // to its own 404 for unknown agent paths.
  async function handle(req, res, url) {
    if (!isAgentPath(url.pathname)) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.end();
      return true;
    }
    try {
      return await dispatch(req, res, url);
    } catch {
      if (!res.writableEnded) json(res, 500, { ok: false, message: 'Permintaan agent gagal diproses.' });
      return true;
    }
  }

  const routeLabels = {
    '/api/agent': '/api/agent',
    '/api/agent/config': '/api/agent/config',
    '/api/agent/toggle': '/api/agent/toggle',
    '/api/agent/chat': '/api/agent/chat',
    '/api/agent/connect': '/api/agent/connect',
    '/api/agent/messages': '/api/agent/messages',
    '/api/agent/report': '/api/agent/report',
    '/api/agent/accounts/:id': '/api/agent/accounts/:id',
    '/api/admin/agents': '/api/admin/agents',
    '/api/admin/agent-jobs': '/api/admin/agent-jobs',
    '/api/admin/agent-audit': '/api/admin/agent-audit',
    '/api/admin/agent-action': '/api/admin/agent-action'
  };

  let timer = null;
  const start = () => {
    if (timer) return;
    reapStuckJobs();
    try { queueDepthGauge.set(countQueued.get().count); } catch { /* metrics only */ }
    timer = setInterval(tick, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  // Install-time work: backfill every existing user, then reclaim jobs left
  // `running` by a previous process that was killed mid-call.
  backfillAll();
  reapStuckJobs();
  try { queueDepthGauge.set(countQueued.get().count); } catch { /* metrics only */ }

  return { handle, start, stop, routeLabels, ensureForUser: ensureAgentForUser };
}
