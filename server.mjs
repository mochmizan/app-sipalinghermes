import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { PostHog } from 'posthog-node';
import client from 'prom-client';
import installAgentRuntime from './agent-runtime.mjs';

// Prometheus metrics. Metrics must NEVER break the API: every increment and the
// registry itself are wrapped defensively. Route labels are fixed, low-cardinality
// strings only — never raw URLs.
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpRequestsTotal = new client.Counter({
  name: 'hermes_http_requests_total',
  help: 'Total HTTP requests by method, fixed route label, and status class.',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});
const waitinglistSignupsTotal = new client.Counter({
  name: 'hermes_waitinglist_signups_total',
  help: 'Total new waitinglist signups (excludes already-registered hits).',
  registers: [register]
});
const loginsTotal = new client.Counter({
  name: 'hermes_logins_total',
  help: 'Total successful logins.',
  registers: [register]
});
const registrationsTotal = new client.Counter({
  name: 'hermes_registrations_total',
  help: 'Total successful registrations.',
  registers: [register]
});
const incMetric = (counter, labels = {}) => { try { counter.inc(labels); } catch { /* metrics must never break the API */ } };
const trackRequest = (method, route, res) => incMetric(httpRequestsTotal, { method, route, status: String(res.statusCode) });

async function metricsBody() {
  try { return await register.metrics(); } catch { return '# metrics unavailable\n'; }
}
const metricsContentType = (() => { try { return register.contentType; } catch { return 'text/plain; version=0.0.4'; } })();

// PostHog server-side client. Key comes from POSTHOG_API_KEY only — never baked
// in (this repo is public). Empty key = analytics silently disabled. The browser
// key in posthog-init.js is a publishable `phc_` key (view-source visible by
// design); rotate it in PostHog if it ever needs revoking. Events carry NO PII.
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';
let posthog = null;
try {
  if (POSTHOG_API_KEY) posthog = new PostHog(POSTHOG_API_KEY, { host: 'https://us.i.posthog.com' });
} catch { posthog = null; /* analytics must never break the API */ }
const trackServer = (distinctId, event, props = {}) => {
  try { if (posthog) posthog.capture({ distinctId, event, properties: props }); } catch { /* analytics must never break the API */ }
};

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5173);
const databaseDirectory = resolve(root, 'data');
mkdirSync(databaseDirectory, { recursive: true });
const db = new Database(resolve(databaseDirectory, 'hermes.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    whatsapp TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS waitinglist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    whatsapp TEXT NOT NULL,
    role_category TEXT NOT NULL DEFAULT 'creator',
    target_platform TEXT NOT NULL DEFAULT 'instagram',
    referral_code TEXT UNIQUE NOT NULL,
    notes TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_waitinglist_email ON waitinglist(email);
  CREATE INDEX IF NOT EXISTS idx_waitinglist_created_at ON waitinglist(created_at);
`);

const seedUsers = [
  { name: 'Nadia Demo', whatsapp: '080000000001', email: 'user@demo.hermes', password: 'UserDemo123!', role: 'user' },
  { name: 'Admin Hermes', whatsapp: '080000000002', email: 'admin@demo.hermes', password: 'AdminDemo123!', role: 'admin' }
];
// Demo accounts are a beta convenience: HERMES_DEMO_ACCOUNTS=0 (public launch)
// disables user-demo seeding and purges the non-admin @demo.hermes users at boot.
// The Admin Hermes row is never purged and is (re-)seeded so the admin control
// plane stays loggable with the mockup credentials even in this off state.
const DEMO_ENABLED = String(process.env.HERMES_DEMO_ACCOUNTS ?? '1').trim() !== '0';
if (DEMO_ENABLED) {
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (name, whatsapp, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  for (const user of seedUsers) insertUser.run(user.name, user.whatsapp, user.email, bcrypt.hashSync(user.password, 12), user.role);
} else {
  const purgeDemoUsers = db.transaction(() => {
    const demoUsers = db.prepare("SELECT id FROM users WHERE lower(email) LIKE '%@demo.hermes' AND role <> 'admin'").all();
    if (demoUsers.length === 0) return { users: 0, sessions: 0, agents: 0, agentChildren: 0 };
    const ids = demoUsers.map((row) => row.id);
    const agentIds = db.prepare(`SELECT id FROM agents WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((row) => row.id);
    let agentChildren = 0;
    if (agentIds.length > 0) {
      const placeholders = agentIds.map(() => '?').join(',');
      for (const table of ['agent_accounts', 'agent_chat_messages', 'agent_jobs', 'agent_events']) {
        agentChildren += db.prepare(`DELETE FROM ${table} WHERE agent_id IN (${placeholders})`).run(...agentIds).changes;
      }
    }
    const agents = db.prepare(`DELETE FROM agents WHERE user_id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    const sessions = db.prepare(`DELETE FROM sessions WHERE user_id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    const users = db.prepare(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    return { users, sessions, agents, agentChildren };
  });
  let purged = { users: 0, sessions: 0, agents: 0, agentChildren: 0 };
  try {
    purged = purgeDemoUsers();
  } catch (error) {
    console.log('Demo account purge failed:', error.message);
  }
  // Admin bootstrap: the purge above never touches role='admin', so this is an
  // idempotent identity check. The cost-12 hash is only computed when the row
  // is actually missing, keeping the common no-op path cheap.
  try {
    const adminExists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND lower(email) = 'admin@demo.hermes'").get();
    if (!adminExists) {
      db.prepare("INSERT OR IGNORE INTO users (name, whatsapp, email, password_hash, role) VALUES ('Admin Hermes', '080000000002', 'admin@demo.hermes', ?, 'admin')")
        .run(bcrypt.hashSync('AdminDemo123!', 12));
    }
  } catch (error) {
    console.log('Demo admin bootstrap failed:', error.message);
  }
  console.log(`Demo accounts disabled (HERMES_DEMO_ACCOUNTS=0): purged ${purged.users} non-admin demo users, ${purged.sessions} sessions, ${purged.agents} agents, ${purged.agentChildren} agent records (admin bootstrap preserved).`);
}

const seedWaitingList = [
  { name: 'Contoh UMKM', email: 'umkm@contoh.test', whatsapp: '080000000011', role_category: 'umkm', target_platform: 'instagram,whatsapp', referral_code: 'HERMES-VIP01' },
  { name: 'Contoh Agensi', email: 'agensi@contoh.test', whatsapp: '080000000012', role_category: 'agency', target_platform: 'instagram,tiktok', referral_code: 'HERMES-VIP02' },
  { name: 'Contoh Kreator', email: 'kreator@contoh.test', whatsapp: '080000000013', role_category: 'creator', target_platform: 'tiktok,threads', referral_code: 'HERMES-VIP03' }
];
const insertWaitingSeed = db.prepare('INSERT OR IGNORE INTO waitinglist (name, email, whatsapp, role_category, target_platform, referral_code) VALUES (?, ?, ?, ?, ?, ?)');
for (const entry of seedWaitingList) insertWaitingSeed.run(entry.name, entry.email, entry.whatsapp, entry.role_category, entry.target_platform, entry.referral_code);

const queries = {
  findUserByIdentity: db.prepare('SELECT id, name, whatsapp, email, password_hash, role FROM users WHERE lower(name) = lower(?) OR lower(email) = lower(?) OR whatsapp = ? LIMIT 1'),
  findUserById: db.prepare('SELECT id, name, whatsapp, email, role, created_at FROM users WHERE id = ?'),
  findUserByEmailOrWhatsApp: db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) OR whatsapp = ? LIMIT 1'),
  insertUser: db.prepare('INSERT INTO users (name, whatsapp, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
  findSession: db.prepare('SELECT users.id, users.name, users.whatsapp, users.email, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?'),
  countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
  countAdmins: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"),
  insertWaitingList: db.prepare('INSERT INTO waitinglist (name, email, whatsapp, role_category, target_platform, referral_code, notes, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  findWaitingListByEmail: db.prepare('SELECT id, name, email, whatsapp, role_category, target_platform, referral_code, created_at FROM waitinglist WHERE lower(email) = lower(?) LIMIT 1'),
  findWaitingListById: db.prepare('SELECT id, name, email, whatsapp, role_category, target_platform, referral_code, created_at FROM waitinglist WHERE id = ?'),
  countWaitingList: db.prepare('SELECT COUNT(*) AS count FROM waitinglist'),
  listWaitingList: db.prepare('SELECT id, name, email, whatsapp, role_category, target_platform, referral_code, created_at FROM waitinglist ORDER BY id DESC LIMIT ? OFFSET ?')
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function publicUser(user) {
  return { id: user.id, name: user.name, whatsapp: user.whatsapp, email: user.email, role: user.role };
}

function createSession(userId) {
  const token = cryptoRandomToken();
  queries.insertSession.run(token, userId);
  return token;
}

function cryptoRandomToken() {
  return randomBytes(32).toString('hex');
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function getBearer(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

// Hermes agent runtime: owns agent state, chat, report jobs, and the LLM adapter.
// It shares this process's SQLite handle and prom-client registry (one writer).
const agentRuntime = installAgentRuntime({
  db,
  register,
  client,
  trackServer,
  http: {
    json,
    readJson,
    getUser: (req) => queries.findSession.get(getBearer(req)) || null
  }
});

// ---- API rate limiting (in-memory sliding windows) --------------------------
// Login IP bucket: every login attempt (success or failure), 10 per 5 min, key =
// X-Real-IP (set by nginx) when the peer is local, else the socket address.
// Login identity bucket: failed logins only, 5 per 15 min, key = trimmed
// lowercased identity. Register and waiting-list each get one per-IP flood
// bucket: 5 per 10 min counting success + failure. Every bucket returns 429
// with the same generic message (no bucket or endpoint details).
const rateWindows = new Map();
const RATE_LIMITS = {
  ip: { max: 10, ms: 5 * 60_000 },
  identity: { max: 5, ms: 15 * 60_000 },
  register: { max: 5, ms: 10 * 60_000 },
  waitinglist: { max: 5, ms: 10 * 60_000 }
};
const pruneRateWindows = (key, windowMs) => {
  const timestamps = rateWindows.get(key);
  if (!timestamps) return [];
  const cutoff = Date.now() - windowMs;
  const alive = timestamps.filter((time) => time > cutoff);
  if (alive.length === 0) rateWindows.delete(key); else rateWindows.set(key, alive);
  return alive;
};
const createRateLimiter = (kind, countOnHit) => {
  // Keys are namespaced per bucket so two buckets can never share a window in
  // the shared Map (e.g. an IP string and an identity string).
  const scoped = (key) => `${kind}:${key}`;
  return {
    // countOnHit=false → check is read-only; failures are recorded via fail().
    hit(key) {
      const now = Date.now();
      const { max, ms } = RATE_LIMITS[kind];
      const timestamps = pruneRateWindows(scoped(key), ms);
      if (timestamps.length >= max) {
        return { limited: true, retryAfter: Math.max(1, Math.ceil((timestamps[0] + ms - now) / 1000)) };
      }
      if (countOnHit) {
        timestamps.push(now);
        rateWindows.set(scoped(key), timestamps);
        if (timestamps.length > 40) pruneRateWindows(scoped(key), ms);
      }
      return { limited: false, retryAfter: 0 };
    },
    fail(key) {
      const { ms } = RATE_LIMITS[kind];
      const timestamps = pruneRateWindows(scoped(key), ms);
      timestamps.push(Date.now());
      rateWindows.set(scoped(key), timestamps);
      if (timestamps.length > 40) pruneRateWindows(scoped(key), ms);
      return { limited: false, retryAfter: 0 };
    }
  };
};
const loginIpLimiter = createRateLimiter('ip', true);
const loginIdentityLimiter = createRateLimiter('identity', false);
// Register + waiting-list count successful attempts too: they exist to stop a
// flood, not to police credentials.
const registerIpLimiter = createRateLimiter('register', true);
const waitinglistIpLimiter = createRateLimiter('waitinglist', true);
const clientIpFor = (req) => {
  const peer = String(req.socket.remoteAddress || '');
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1' || peer === 'localhost';
  if (local) {
    const forwarded = req.headers['x-real-ip'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return String(value).trim().slice(0, 45);
  }
  return peer.slice(0, 45);
};
// One generic 429 for every limited bucket: no bucket name, no endpoint hint
// (and no signal about whether the request would otherwise have succeeded).
const sendRateLimited = (res, retryAfter) => {
  res.setHeader('Retry-After', String(retryAfter));
  json(res, 429, { ok: false, code: 'too_many_attempts', message: 'Terlalu banyak percobaan. Coba lagi nanti.' });
};
// Periodic sweep so abandoned windows cannot grow unbounded. Unref'd: must not
// keep the process alive on shutdown.
setInterval(() => {
  const cutoff = Date.now() - 20 * 60_000;
  for (const [key, timestamps] of rateWindows) {
    if (!timestamps.some((time) => time > cutoff)) rateWindows.delete(key);
  }
}, 60_000).unref();

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.end();
    return true;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const database = db.prepare('SELECT 1 AS ok').get();
    json(res, 200, { ok: database.ok === 1, service: 'si-paling-hermes-api', database: 'sqlite', users: queries.countUsers.get().count, admins: queries.countAdmins.get().count });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const session = queries.findSession.get(getBearer(req));
    if (!session) { json(res, 401, { ok: false, message: 'Session tidak ditemukan.' }); return true; }
    json(res, 200, { ok: true, user: publicUser(session) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    // Flood guard: counted and short-circuited BEFORE the body read, bcrypt, or
    // any DB work (same generic 429 as login).
    const registerLimit = registerIpLimiter.hit(clientIpFor(req));
    if (registerLimit.limited) {
      sendRateLimited(res, registerLimit.retryAfter);
      return true;
    }
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const whatsapp = String(body.whatsapp || '').replace(/[^\d+]/g, '');
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!name || !whatsapp || !email || password.length < 8) { json(res, 422, { ok: false, message: 'Nama, nomor WhatsApp, email, dan password minimal 8 karakter wajib diisi.' }); return true; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { json(res, 422, { ok: false, message: 'Format email tidak valid.' }); return true; }
      if (queries.findUserByEmailOrWhatsApp.get(email, whatsapp)) { json(res, 409, { ok: false, message: 'Email atau nomor WhatsApp sudah terdaftar.' }); return true; }
      const result = queries.insertUser.run(name, whatsapp, email, bcrypt.hashSync(password, 12), 'user');
      const user = queries.findUserById.get(result.lastInsertRowid);
      const token = createSession(user.id);
      // Agent provisioning for the new workspace happens before the response.
      try { agentRuntime.ensureForUser(user.id); } catch { /* provisioning must not fail registration */ }
      trackServer(String(user.id), 'user_registered', { role: user.role });
      incMetric(registrationsTotal);
      json(res, 201, { ok: true, token, user: publicUser(user), redirect: '/dashboard/' });
    } catch (error) {
      json(res, 400, { ok: false, message: error.message === 'Invalid JSON' ? error.message : 'Registrasi gagal diproses.' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/demo') {
    json(res, 200, DEMO_ENABLED
      ? { ok: true, enabled: true, accounts: { user: { identity: 'user@demo.hermes', password: 'UserDemo123!' }, admin: { identity: 'admin@demo.hermes', password: 'AdminDemo123!' } } }
      : { ok: true, enabled: false });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    // Short-circuit BEFORE any bcrypt or DB work; generic response either way.
    const clientIp = clientIpFor(req);
    const ipLimit = loginIpLimiter.hit(clientIp);
    if (ipLimit.limited) {
      sendRateLimited(res, ipLimit.retryAfter);
      return true;
    }
    let identity = '';
    let password = '';
    try {
      const body = await readJson(req);
      identity = String(body.identity || '').trim().slice(0, 120).toLowerCase();
      password = String(body.password || '');
    } catch {
      json(res, 400, { ok: false, message: 'Login gagal diproses.' });
      return true;
    }
    const identityLimit = loginIdentityLimiter.hit(identity);
    if (identityLimit.limited) {
      sendRateLimited(res, identityLimit.retryAfter);
      return true;
    }
    try {
      const user = queries.findUserByIdentity.get(identity, identity, identity.replace(/[^\d+]/g, ''));
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        loginIdentityLimiter.fail(identity);
        json(res, 401, { ok: false, message: 'Identitas atau password tidak cocok.' });
        return true;
      }
      const token = createSession(user.id);
      trackServer(String(user.id), 'user_login', { role: user.role });
      incMetric(loginsTotal);
      json(res, 200, { ok: true, token, user: publicUser(user), redirect: user.role === 'admin' ? '/admin/' : '/dashboard/' });
    } catch {
      json(res, 400, { ok: false, message: 'Login gagal diproses.' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/waitinglist') {
    // Flood guard: counted and short-circuited BEFORE the body read and any DB
    // work. Duplicate-email semantics below are unchanged.
    const waitinglistLimit = waitinglistIpLimiter.hit(clientIpFor(req));
    if (waitinglistLimit.limited) {
      sendRateLimited(res, waitinglistLimit.retryAfter);
      return true;
    }
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const whatsapp = String(body.whatsapp || '').replace(/[^\d+]/g, '');
      const roleCategory = String(body.role_category || 'creator').slice(0, 50);
      const targetPlatform = String(body.target_platform || 'instagram').slice(0, 100);
      const notes = String(body.notes || '').slice(0, 500);

      if (!name || !email || !whatsapp) {
        json(res, 422, { ok: false, message: 'Nama lengkap, email aktif, dan nomor WhatsApp wajib diisi.' });
        return true;
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        json(res, 422, { ok: false, message: 'Format email tidak valid.' });
        return true;
      }
      if (whatsapp.length < 8) {
        json(res, 422, { ok: false, message: 'Nomor WhatsApp minimal 8 digit.' });
        return true;
      }

      const existing = queries.findWaitingListByEmail.get(email);
      if (existing) {
        const queueNumber = `#VIP-${String(1280 + existing.id).padStart(4, '0')}`;
        json(res, 200, {
          ok: true,
          alreadyRegistered: true,
          message: `Halo ${existing.name}! Kamu sudah terdaftar di antrean ${queueNumber}. E-Book Blueprint Hermes siap diunduh.`,
          queueNumber,
          referralCode: existing.referral_code,
          downloadUrl: '/api/lead-magnet/download',
          entry: {
            name: existing.name,
            email: existing.email,
            queueNumber,
            referralCode: existing.referral_code
          }
        });
        return true;
      }

      const referralCode = `HERMES-${randomBytes(3).toString('hex').toUpperCase()}`;
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      const ua = req.headers['user-agent'] || '';

      const result = queries.insertWaitingList.run(
        name, email, whatsapp, roleCategory, targetPlatform, referralCode, notes,
        String(ip).slice(0, 100), String(ua).slice(0, 255)
      );
      const newEntry = queries.findWaitingListById.get(result.lastInsertRowid);
      const queueNumber = `#VIP-${String(1280 + newEntry.id).padStart(4, '0')}`;

      // New entry only (already-registered path returns earlier). No PII in props.
      trackServer(`waitinglist-${newEntry.id}`, 'waitinglist_signup', {
        role_category: roleCategory,
        target_platform: targetPlatform,
        queueNumber
      });

      incMetric(waitinglistSignupsTotal);
      json(res, 201, {
        ok: true,
        alreadyRegistered: false,
        message: 'Selamat! Kamu resmi terdaftar di Antrean VIP Batch 1. E-Book Blueprint siap diunduh.',
        queueNumber,
        referralCode,
        downloadUrl: '/api/lead-magnet/download',
        entry: {
          id: newEntry.id,
          name: newEntry.name,
          email: newEntry.email,
          queueNumber,
          referralCode
        }
      });
    } catch (err) {
      json(res, 400, { ok: false, message: err.message === 'Invalid JSON' ? err.message : 'Gagal memproses pendaftaran waiting list.' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/waitinglist/stats') {
    const count = queries.countWaitingList.get().count;
    json(res, 200, {
      ok: true,
      totalCount: count,
      batch: 'Batch 1 (Early Access)',
      targetLimit: 1500,
      slotsLeft: Math.max(0, 1500 - count)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/waitinglist') {
    const session = queries.findSession.get(getBearer(req));
    if (!session || session.role !== 'admin') {
      json(res, 403, { ok: false, message: 'Hanya admin yang memiliki izin akses.' });
      return true;
    }
    const entries = queries.listWaitingList.all(100, 0);
    const count = queries.countWaitingList.get().count;
    json(res, 200, { ok: true, total: count, entries });
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/lead-magnet/download') {
    try {
      const guidePath = resolve(root, 'assets/lead-magnet/the-hermes-playbook.html');
      const guideContent = await readFile(guidePath);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="The-Autonomous-Hermes-Playbook.html"');
      if (req.method === 'HEAD') { res.end(); return true; }
      res.end(guideContent);
    } catch {
      json(res, 404, { ok: false, message: 'File panduan blueprint tidak ditemukan.' });
    }
    return true;
  }

  json(res, 404, { ok: false, message: 'API route tidak ditemukan.' });
  return true;
}

function staticFilePath(pathname) {
  let relative = decodeURIComponent(pathname || '/');
  if (relative === '/waiting-list' || relative === '/waiting-list/') {
    relative = '/lead-magnet/index.html';
  } else if (relative === '/' || extname(relative) === '') {
    relative = `${relative.replace(/\/?$/, '/') }index.html`;
  }
  const candidate = resolve(root, `.${relative}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

// Cloudflare caches /app.js, /styles.css and /posthog-init.js for hours at the
// edge and in browsers (it overrides the origin's no-cache for these types),
// so a deploy would otherwise leave stale assets everywhere for up to 4h.
// HTML is never edge-cached, so each HTML page is served with versioned
// asset URLs (?v=<content hash>) — any content change produces a fresh URL
// that bypasses both cache layers without needing CDN-side purges.
let assetVersion = null;
function assetVersionParam() {
  if (!assetVersion) {
    const hash = createHash('sha1');
    for (const asset of ['app.js', 'styles.css', 'posthog-init.js']) {
      try { hash.update(readFileSync(resolve(root, asset))); } catch { /* missing asset = shorter hash input, still stable */ }
    }
    assetVersion = hash.digest('hex').slice(0, 12);
  }
  return assetVersion;
}
function injectAssetVersions(content) {
  const v = assetVersionParam();
  return String(content)
    .replaceAll('href="/styles.css"', `href="/styles.css?v=${v}"`)
    .replaceAll('src="/posthog-init.js"', `src="/posthog-init.js?v=${v}"`)
    .replaceAll('src="/app.js"', `src="/app.js?v=${v}"`);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

async function serveStatic(req, res, url) {
  const filePath = staticFilePath(url.pathname);
  if (!filePath) { res.statusCode = 403; res.end('Forbidden'); return; }
  try {
    let content = await readFile(filePath);
    // Inject the browser PostHog key at serve time so the repo stays secret-free.
    // Missing key = placeholder survives = snippet stays inert, page unaffected.
    if (url.pathname === '/posthog-init.js') {
      const key = process.env.POSTHOG_API_KEY || '';
      content = Buffer.from(String(content).split('__POSTHOG_PROJECT_KEY__').join(key));
    }
    if (extname(filePath) === '.html') content = Buffer.from(injectAssetVersions(content));
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[extname(filePath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/metrics') {
    res.statusCode = 200;
    res.setHeader('Content-Type', metricsContentType);
    res.end(await metricsBody());
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // Fixed route labels only (low cardinality) — never raw URLs.
    const route = agentRuntime.routeLabels[url.pathname]
      || (url.pathname.startsWith('/api/agent/accounts/') ? agentRuntime.routeLabels['/api/agent/accounts/:id'] : '')
      || (url.pathname === '/api/health' ? '/api/health'
      : url.pathname === '/api/waitinglist/stats' ? '/api/waitinglist/stats'
      : url.pathname === '/api/admin/waitinglist' ? '/api/admin/waitinglist'
      : url.pathname === '/api/lead-magnet/download' ? '/api/lead-magnet/download'
      : url.pathname === '/api/auth/demo' ? '/api/auth/demo'
      : url.pathname === '/api/auth/register' ? '/api/auth/register'
      : url.pathname === '/api/auth/login' ? '/api/auth/login'
      : url.pathname === '/api/waitinglist' ? '/api/waitinglist'
      : '/api/other');
    res.on('finish', () => trackRequest(req.method, route, res));
    // Agent routes are handled by the runtime first; false falls through to the
    // existing 404 below.
    if ((url.pathname.startsWith('/api/agent') || url.pathname.startsWith('/api/admin/agent'))
      && await agentRuntime.handle(req, res, url)) return;
    try { await handleApi(req, res, url); } catch (error) { json(res, 500, { ok: false, message: error.message }); }
    return;
  }
  await serveStatic(req, res, url);
});
server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.listen(port, '0.0.0.0', () => console.log(`Si Paling Hermes app + API running at http://localhost:${port}`));

agentRuntime.start();
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  agentRuntime.stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
