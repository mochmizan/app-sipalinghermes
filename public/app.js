(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // PostHog is optional: /posthog-init.js may fail to load (CDN blocked). Never crash.
  const track = (event, props) => {
    try { window.posthog?.capture(event, props); } catch { /* analytics unavailable */ }
  };
  const requiredRole = document.body.dataset.requiredRole;
  if (requiredRole) {
    const sessionToken = localStorage.getItem('hermes-session-token');
    if (!sessionToken) {
      try { window.posthog?.reset(); } catch { /* noop */ }
      window.location.replace('/auth/?mode=login');
    } else {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${sessionToken}` } })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('Session expired')))
        .then((result) => {
          if (!result.user || result.user.role !== requiredRole) window.location.replace('/auth/?mode=login');
        })
        .catch(() => {
          try { window.posthog?.reset(); } catch { /* noop */ }
          window.location.replace('/auth/?mode=login');
        });
    }
  }

  document.querySelectorAll('.reveal').forEach((el) => {
    if (reducedMotion) {
      el.classList.add('is-visible');
      return;
    }
    const observer = new IntersectionObserver((entries, current) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          current.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px' });
    observer.observe(el);
  });

  const siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    const updateHeader = () => siteHeader.classList.toggle('is-scrolled', window.scrollY > 12);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  const menuToggle = document.querySelector('.menu-toggle');
  const mobilePanel = document.querySelector('.mobile-panel');
  const mobileBackdrop = document.querySelector('.mobile-panel-backdrop');
  if (menuToggle && mobilePanel) {
    const setMenuOpen = (open) => {
      mobilePanel.classList.toggle('open', open);
      if (mobileBackdrop) mobileBackdrop.classList.toggle('open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('mobile-menu-open', open);
    };
    menuToggle.addEventListener('click', () => {
      const isOpen = mobilePanel.classList.contains('open');
      setMenuOpen(!isOpen);
    });
    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', () => setMenuOpen(false));
    }
    mobilePanel.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
      setMenuOpen(false);
    }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobilePanel.classList.contains('open')) {
        setMenuOpen(false);
      }
    });
  }

  const modalBackdrop = document.querySelector('.modal-backdrop');
  const modal = document.querySelector('.modal');
  const openModal = (mode = 'agent') => {
    if (!modalBackdrop) {
      window.location.href = '/lead-magnet/';
      return;
    }
    modalBackdrop.classList.add('open');
    modalBackdrop.setAttribute('aria-hidden', 'false');
    track('modal_open', { mode });
    const title = modal.querySelector('[data-modal-title]');
    const copy = modal.querySelector('[data-modal-copy]');
    const submit = modal.querySelector('[data-modal-submit]');
    if (mode === 'login') {
      title.textContent = 'Masuk ke dashboard.';
      copy.textContent = 'Prototype lokal: masuk untuk melihat ringkasan agent dan koneksi social media-mu.';
      submit.textContent = 'Masuk demo';
    } else {
      title.textContent = 'Mulai buat agent-mu.';
      copy.textContent = 'Pilih titik awal. Detail konfigurasi bisa kamu atur setelah agent dibuat.';
      submit.textContent = 'Buat agent demo';
    }
    const firstInput = modal.querySelector('input:not([type=hidden])');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  };
  const closeModal = () => {
    if (!modalBackdrop) return;
    modalBackdrop.classList.remove('open');
    modalBackdrop.setAttribute('aria-hidden', 'true');
  };
  document.querySelectorAll('[data-open-modal]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.openModal)));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
  modalBackdrop?.addEventListener('click', (event) => { if (event.target === modalBackdrop) closeModal(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

  const agentForm = document.querySelector('[data-agent-form]');
  agentForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(agentForm);
    const name = data.get('name') || 'Agent baru';
    localStorage.setItem('hermes-demo-agent', JSON.stringify({ name, template: data.get('template') || 'personal' }));
    track('agent_demo_created');
    closeModal();
    showToast('Agent demo dibuat. Membuka dashboard…');
    setTimeout(() => { window.location.href = '/dashboard/'; }, 550);
  });

  document.querySelectorAll('.faq-question').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.faq-item');
      const answer = item.querySelector('.faq-answer');
      const opening = !item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach((other) => {
        if (other !== item) {
          other.classList.remove('open');
          other.querySelector('.faq-answer').style.height = '0px';
          other.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
        }
      });
      item.classList.toggle('open', opening);
      button.setAttribute('aria-expanded', String(opening));
      answer.style.height = opening ? `${answer.scrollHeight}px` : '0px';
    });
  });

  // Legacy demo handlers are gone: the dashboard talks to /api/agent* directly (see the Hermes
  // agent runtime section below). Only the mobile sidebar toggle remains a page behaviour; any
  // other leftover hook stays inert instead of simulating work.
  document.querySelectorAll('[data-demo-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.demoAction === 'sidebar') {
        document.querySelector('.app-sidebar')?.classList.toggle('open');
        return;
      }
      showToast('Aksi ini belum tersedia pada runtime nyata.');
    });
  });

  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(window.__hermesToast);
    window.__hermesToast = setTimeout(() => toast.classList.remove('show'), 3200);
  }
  document.querySelectorAll('.data-table').forEach((table) => {
    const labels = [...table.querySelectorAll('thead th')].map((header) => header.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((row) => {
      row.querySelectorAll('td').forEach((cell, index) => {
        if (labels[index]) cell.dataset.label = labels[index];
      });
    });
  });
  const authTabs = document.querySelectorAll('[data-auth-tab]');
  const authForms = document.querySelectorAll('[data-auth-form]');
  if (authTabs.length && authForms.length) {
    const params = new URLSearchParams(window.location.search);
    const initialMode = params.get('mode') === 'register' ? 'register' : 'login';
    const authTitle = document.querySelector('[data-auth-title]');
    const authCopy = document.querySelector('[data-auth-copy]');
    const setAuthMode = (mode) => {
      authTabs.forEach((tab) => {
        const active = tab.dataset.authTab === mode;
        if (tab.classList.contains('auth-tab')) {
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        }
      });
      authForms.forEach((form) => { form.hidden = form.dataset.authForm !== mode; });
      if (authTitle) authTitle.textContent = mode === 'register' ? 'Buat workspace pertamamu.' : 'Selamat datang kembali.';
      if (authCopy) authCopy.textContent = mode === 'register'
        ? 'Isi nama, nomor WhatsApp, email, dan password untuk membuat akses workspace.'
        : 'Gunakan nama, email, atau nomor WhatsApp yang terdaftar untuk masuk.';
      const url = new URL(window.location.href);
      url.searchParams.set('mode', mode);
      window.history.replaceState({}, '', url);
    };
    authTabs.forEach((tab) => tab.addEventListener('click', () => {
      track('auth_tab_switch', { mode: tab.dataset.authTab });
      setAuthMode(tab.dataset.authTab);
    }));
    setAuthMode(initialMode);

    const API_BASE = window.HERMES_API_BASE || '/api';
    const requestAuth = async (path, payload) => {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({ message: 'Respons server tidak valid.' }));
      if (!response.ok) throw new Error(result.message || 'Permintaan auth gagal.');
      return result;
    };

    const persistSession = (result) => {
      localStorage.setItem('hermes-session-token', result.token);
      localStorage.setItem('hermes-account', JSON.stringify(result.user));
      localStorage.setItem('hermes-demo-agent', JSON.stringify({ name: `Hermes ${result.user.name}`, template: 'personal' }));
      try {
        // Never send email/whatsapp as identify props.
        window.posthog?.identify(String(result.user.id), { name: result.user.name, role: result.user.role });
      } catch { /* analytics unavailable */ }
      showToast('Berhasil. Membuka workspace…');
      setTimeout(() => { window.location.href = result.redirect; }, 550);
    };

    const registerForm = document.querySelector('[data-auth-form="register"]');
    registerForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(registerForm);
      const password = String(data.get('password') || '');
      const confirmation = String(data.get('passwordConfirm') || '');
      if (password !== confirmation) {
        showToast('Password dan ulangi password harus sama.');
        registerForm.querySelector('[name="passwordConfirm"]').focus();
        return;
      }
      try {
        const result = await requestAuth('/auth/register', {
          name: String(data.get('name') || '').trim(),
          whatsapp: String(data.get('whatsapp') || '').trim(),
          email: String(data.get('email') || '').trim(),
          password
        });
        persistSession(result);
        track('register_success', { role: result.user?.role });
      } catch (error) {
        track('auth_error', { flow: 'register', message: error.message });
        showToast(error.message);
      }
    });

    const loginForm = document.querySelector('[data-auth-form="login"]');
    loginForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(loginForm);
      const identity = String(data.get('identity') || '').trim();
      const password = String(data.get('password') || '');
      if (!identity || password.length < 8) {
        showToast('Isi identitas dan password minimal 8 karakter.');
        return;
      }
      try {
        const result = await requestAuth('/auth/login', { identity, password });
        persistSession(result);
        track('login_success', { role: result.user?.role });
      } catch (error) {
        track('auth_error', { flow: 'login', message: error.message });
        showToast(error.message);
      }
    });

    // Demo credentials come from GET /api/auth/demo only — never bundled here.
    // The block in auth/index.html ships hidden and is revealed only when the
    // server confirms demo accounts are enabled.
    const demoBlock = document.querySelector('#demo-accounts');
    (async () => {
      let demoAccounts = null;
      try {
        const response = await fetch(`${API_BASE}/auth/demo`);
        const data = await response.json().catch(() => null);
        if (response.ok && data?.ok && data.enabled && data.accounts) demoAccounts = data.accounts;
      } catch { /* demo info is optional; block stays hidden */ }
      if (demoAccounts) {
        demoBlock?.removeAttribute('hidden');
        document.querySelectorAll('[data-demo-login]').forEach((button) => {
          button.addEventListener('click', () => {
            const account = demoAccounts?.[button.dataset.demoLogin];
            if (!account || !loginForm) return;
            track('demo_login_click', { account: button.dataset.demoLogin });
            setAuthMode('login');
            loginForm.querySelector('[name="identity"]').value = account.identity;
            loginForm.querySelector('[name="password"]').value = account.password;
            loginForm.requestSubmit();
          });
        });
      } else {
        // Flag off or fetch failed: the block stays hidden and the buttons stay
        // inert — never fall back to bundled credentials.
        demoBlock?.setAttribute('hidden', '');
        document.querySelectorAll('[data-demo-login]').forEach((button) => {
          button.addEventListener('click', () => showToast('Akun demo tidak tersedia.'));
        });
      }
    })();

    document.querySelector('[data-demo-forgot]')?.addEventListener('click', (event) => {
      event.preventDefault();
      showToast('Reset password akan tersedia saat backend autentikasi terhubung.');
    });
  }

  // --- Hermes agent runtime (dashboard) ---
  // Live wiring for /dashboard/: every value below is read from /api/agent* with the Bearer session
  // token. No demo state, no fake numbers, honest empty states. Admin sections stay below untouched.
  const chatListEl = document.querySelector('[data-chat-list]');
  if (chatListEl) {
    const API = window.HERMES_API_BASE || '/api';
    const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', threads: 'Threads', x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };
    const ACCOUNT_STATES = { connected: 'Connected', pending_oauth: 'Menunggu OAuth', error: 'Error' };
    const CAPABILITY_COPY = {
      conversations: ['Conversations', 'Chat langsung dengan agent'],
      report: ['Report', 'Rekap mingguan otomatis'],
      comments: ['Comments', 'Balasan komentar platform'],
      schedule: ['Schedule', 'Penjadwalan konten']
    };
    const CAPABILITY_ACCENTS = ['', 'background:var(--pink-alt)', 'background:var(--green)', 'background:#f1f1f1'];
    const AGENT_STATES = { active: 'ON / Siap', paused: 'OFF', error: 'ON / Error', unconfig: 'LLM belum dikonfigurasi' };
    const STATUS_LABELS = { active: 'Aktif', paused: 'Paused', error: 'Error', unconfig: 'Unconfig' };
    // Closed-set runtime error codes only (contract) — never raw provider text.
    const ERROR_COPY = {
      llm_unconfigured: 'LLM belum dikonfigurasi di server.',
      llm_unreachable: 'Provider LLM tidak bisa dihubungi.',
      llm_timeout: 'Permintaan ke LLM melewati batas waktu.',
      llm_upstream: 'Provider LLM menolak permintaan.',
      rate_limited: 'Terlalu banyak pesan dalam satu menit.',
      message_empty: 'Pesan tidak boleh kosong.',
      message_too_long: 'Pesan maksimal 2000 karakter.',
      report_disabled: 'Capability report sedang nonaktif.',
      report_already_queued: 'Report untuk agent ini sudah ada di queue.'
    };

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    const request = async (path, options = {}) => {
      const sessionToken = localStorage.getItem('hermes-session-token');
      const authHeaders = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { ...(options.body ? { ...authHeaders, 'Content-Type': 'application/json' } : authHeaders), ...(options.headers || {}) }
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Prefer the runtime's own message, then the closed-set code map, then the HTTP status.
        const error = new Error(body?.message || ERROR_COPY[body?.code] || `Permintaan gagal (HTTP ${response.status}).`);
        error.status = response.status;
        error.body = body;
        error.retryAfter = Number(response.headers.get('Retry-After') || 0);
        throw error;
      }
      return body;
    };
    const toastError = (error) => showToast(error.retryAfter > 0 ? `${error.message} Coba lagi dalam ${error.retryAfter} detik.` : error.message);
    const setText = (selector, text) => {
      const el = document.querySelector(selector);
      if (el) el.textContent = text;
    };
    const parseTime = (value) => {
      const raw = String(value || '').trim().replace(' ', 'T');
      if (!raw) return null;
      const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const relativeTime = (value) => {
      const date = parseTime(value);
      if (!date) return '';
      const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
      if (minutes < 1) return 'baru saja';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
    };

    // Sidebar user block mirrors the real session written by the auth flow (localStorage only).
    let sessionAccount = null;
    try { sessionAccount = JSON.parse(localStorage.getItem('hermes-account') || 'null'); } catch { sessionAccount = null; }
    const sessionName = String(sessionAccount?.name || '').trim();
    setText('[data-session-name]', sessionName || 'Workspace aktif');
    setText('[data-session-role]', sessionAccount?.role === 'admin' ? 'Admin workspace' : 'Personal workspace');
    setText('[data-session-avatar]', (sessionName.charAt(0) || 'H').toUpperCase());

    let agentPayload = null;
    let lastMessageId = 0;
    let activityIds = [];
    let activityItems = [];
    let configFormLoaded = false;
    let chatPending = false;

    const renderAgent = (payload) => {
      const agent = payload?.agent || {};
      const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
      const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
      const llm = agent.llm || {};
      const status = String(agent.status || (agent.enabled ? 'active' : 'paused'));

      setText('[data-agent-name]', String(agent.name || '').trim() || 'Hermes agent');
      setText('[data-agent-id-tag]', agent.id ? `runtime #${agent.id}` : 'runtime');
      setText('[data-agent-state]', AGENT_STATES[status] || 'ON / Siap');
      setText('[data-agent-message]', String(agent.status_detail || '').trim()
        || (agent.enabled ? 'Agent aktif sesuai policy yang kamu atur.' : 'Agent berhenti memproses pekerjaan baru. Konfigurasi dan data tetap tersimpan.'));

      const statusBox = document.querySelector('[data-agent-status]');
      if (statusBox) {
        statusBox.setAttribute('style', {
          active: '',
          paused: 'background:var(--pink);color:var(--warning)',
          error: 'background:var(--pink);color:var(--danger)'
        }[status] ?? 'background:#f1f1f1;color:var(--warning)');
        const dot = statusBox.querySelector('i');
        if (dot) dot.setAttribute('style', status === 'active' ? '' : 'background:currentColor');
      }

      const toggle = document.querySelector('[data-agent-action="toggle"]');
      if (toggle) {
        toggle.dataset.enabled = String(Boolean(agent.enabled));
        toggle.textContent = agent.enabled ? 'Matikan agent' : 'Nyalakan agent';
      }

      const llmTag = document.querySelector('[data-llm-tag]');
      if (llmTag) {
        llmTag.className = llm.configured ? 'tag' : 'tag warning';
        llmTag.textContent = llm.configured ? `LLM: ${llm.model || 'aktif'}` : 'LLM belum dikonfigurasi';
      }
      setText('[data-llm-note]', llm.configured
        ? `Model: ${llm.model || '-'}${llm.provider_host ? ` · ${llm.provider_host}` : ''}`
        : 'Model: belum dikonfigurasi');

      setText('[data-queue-depth]', Number.isFinite(Number(payload?.queue_depth)) ? String(payload.queue_depth) : '—');
      setText('[data-queue-note]', `Akun terhubung: ${accounts.length}`);
      setText('[data-status-metric]', STATUS_LABELS[status] || '—');
      const ready = capabilities.filter((capability) => capability.enabled && capability.supported !== false).map((capability) => (CAPABILITY_COPY[capability.key] || [capability.key])[0]);
      setText('[data-capability-summary]', ready.length ? `Capability siap: ${ready.join(', ')}` : 'Belum ada capability siap.');

      const accountList = document.querySelector('[data-account-list]');
      if (accountList) {
        accountList.innerHTML = accounts.length
          ? accounts.map((account) => `<div class="account-row"><span class="platform-dot">◎</span><span class="account-info"><strong>${escapeHtml(account.handle)}</strong><span>${escapeHtml(PLATFORM_LABELS[account.platform] || account.platform)} · ${escapeHtml(account.status_note || 'credential dikelola server-side')}</span></span><span class="account-state">${escapeHtml(ACCOUNT_STATES[account.status] || account.status)}</span></div>`).join('')
          : '<p class="panel-note">Belum ada akun terhubung. Hubungkan akun untuk mencatatnya pada agent ini.</p>';
      }
      setText('[data-account-note]', accounts.length ? `${accounts.length} akun tercatat pada agent ini.` : 'Belum ada akun tercatat pada agent ini.');
      setText('[data-account-count]', `${accounts.length} akun`);
      const badge = document.querySelector('[data-account-badge]');
      if (badge) {
        badge.textContent = String(accounts.length);
        badge.hidden = accounts.length === 0;
      }

      const platformList = document.querySelector('[data-account-platforms]');
      if (platformList) {
        platformList.innerHTML = accounts.length
          ? accounts.map((account) => `<div class="platform"><div><div class="platform-name">${escapeHtml(PLATFORM_LABELS[account.platform] || account.platform)}</div><div class="platform-flow">${escapeHtml(account.handle)}${account.status_note ? ` · ${escapeHtml(account.status_note)}` : ''}</div></div><div style="display:flex;align-items:center;gap:8px"><span class="platform-status${account.status === 'connected' ? '' : ' pending'}">${escapeHtml(ACCOUNT_STATES[account.status] || account.status)}</span><button class="icon-button" type="button" data-agent-action="disconnect" data-account-id="${escapeHtml(account.id)}" aria-label="Hapus akun">✕</button></div></div>`).join('')
          : '<p class="panel-note">Belum ada akun terhubung.</p>';
      }

      const capabilityList = document.querySelector('[data-capability-list]');
      if (capabilityList) {
        capabilityList.innerHTML = capabilities.length
          ? capabilities.map((capability, index) => {
            const [label, description] = CAPABILITY_COPY[capability.key] || [capability.key, 'Capability runtime'];
            const supported = capability.supported !== false;
            const state = supported
              ? (String(capability.state || '').trim() || (capability.enabled ? 'Aktif' : 'Nonaktif'))
              : String(capability.reason || capability.state || 'Belum tersedia');
            return `<div class="capability-row"><span class="feature-icon" style="${CAPABILITY_ACCENTS[index % CAPABILITY_ACCENTS.length]}">${supported ? '✓' : '◌'}</span><span><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span></span><span class="capability-state${supported ? '' : ' locked'}" title="${escapeHtml(state)}">${escapeHtml(state)}</span></div>`;
          }).join('')
          : '<p class="panel-note">Capability belum tersedia dari runtime.</p>';
      }

      renderEvents(Array.isArray(payload?.events) ? payload.events : []);
    };

    const renderConfigForm = (payload) => {
      const agent = payload?.agent || {};
      const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
      const report = capabilities.find((capability) => capability.key === 'report');
      const policy = String(agent.system_prompt || '');
      const llm = agent.llm || {};
      setText('[data-setting-agent]', `${String(agent.name || '').trim() || 'Agent'} · policy ${policy ? `terisi ${policy.length} karakter` : 'belum diatur'} · report ${report?.enabled ? 'aktif' : 'nonaktif'}`);
      setText('[data-setting-llm]', llm.configured
        ? `${llm.model || '-'}${llm.provider_host ? ` via ${llm.provider_host}` : ''} · key dikelola server (BYOK per-user belum tersedia pada fase ini)`
        : 'Belum dikonfigurasi di server. Chat tidak tersedia sampai key LLM dipasang.');

      const form = document.querySelector('[data-config-form]');
      if (!form || configFormLoaded) return;
      form.elements.name.value = String(agent.name || '');
      form.elements.system_prompt.value = policy;
      if (report) {
        form.elements.report.checked = Boolean(report.enabled);
        form.elements.report.disabled = report.supported === false;
      }
      configFormLoaded = true;
    };

    // Activity source: real agent_events rows from GET /api/agent (payload.events). When the
    // runtime reports no events yet, fall back to the agent's own chat thread (report/system rows).
    const EVENT_LABELS = {
      agent_report_ready: 'Laporan agent siap',
      agent_report_enqueued: 'Report masuk queue',
      agent_report_failed: 'Report gagal diproses',
      agent_config_updated: 'Konfigurasi diperbarui',
      agent_toggled: 'Status agent diubah',
      agent_chat_error: 'Chat gagal diproses',
      agent_connected: 'Akun ditambahkan',
      agent_account_removed: 'Akun dihapus',
      agent_admin_action: 'Tindakan admin'
    };
    let hasAgentEvents = false;
    const parseDetail = (value) => {
      try { return JSON.parse(String(value || '{}')) || {}; } catch { return {}; }
    };
    const eventSnippet = (event) => {
      const detail = parseDetail(event.detail);
      const platform = detail.platform ? (PLATFORM_LABELS[detail.platform] || detail.platform) : '';
      if (event.action === 'agent_toggled') return detail.enabled ? 'Agent diaktifkan untuk pekerjaan baru.' : 'Agent dimatikan untuk pekerjaan baru.';
      if (event.action === 'agent_connected') return `${platform || 'Platform'} dicatat dengan status menunggu OAuth.`;
      if (event.action === 'agent_account_removed') return `${platform || 'Akun'} dihapus dari agent.`;
      if (event.action === 'agent_config_updated') return `Field: ${(detail.fields || []).join(', ') || '-'}`;
      if (event.action === 'agent_report_ready') return `Report ${detail.kind || 'manual'} job #${detail.job_id ?? '-'} selesai.`;
      if (event.action === 'agent_report_enqueued') return `Report ${detail.kind || 'manual'} job #${detail.job_id ?? '-'} masuk queue.`;
      if (event.action === 'agent_report_failed') return `Report ${detail.kind || 'manual'} gagal (${detail.code || 'error'}).`;
      if (event.action === 'agent_chat_error') return `Percakapan gagal diproses (${detail.code || 'error'}).`;
      if (event.action === 'agent_admin_action') return `Aksi admin: ${detail.action || '-'}.`;
      return String(event.action || '').replace(/_/g, ' ');
    };
    const renderActivityList = (rows) => {
      const holder = document.querySelector('[data-activity-list]');
      if (!holder) return;
      holder.innerHTML = rows.length
        ? rows.map((row) => `<div class="activity"><i class="activity-dot"></i><div><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.snippet || '-')}</span></div><time>${escapeHtml(relativeTime(row.created_at))}</time></div>`).join('')
        : '<p class="panel-note">Belum ada aktivitas. Percakapan dan laporan agent akan tampil di sini.</p>';
    };
    const renderEvents = (events) => {
      hasAgentEvents = events.length > 0;
      if (!hasAgentEvents) return;
      renderActivityList(events.slice(0, 5).map((event) => ({
        label: EVENT_LABELS[event.action] || String(event.action || 'Aktivitas agent').replace(/_/g, ' '),
        snippet: eventSnippet(event),
        created_at: event.created_at
      })));
    };
    const collectActivity = (messages) => {
      if (hasAgentEvents) return;
      messages.forEach((message) => {
        if (activityIds.includes(message.id)) return;
        activityIds.push(message.id);
        activityItems.push(message);
      });
      activityItems.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
      activityItems = activityItems.slice(0, 5);
      activityIds = activityItems.map((message) => message.id);
      renderActivityList(activityItems.map((message) => {
        const text = String(message.content || '').replace(/\s+/g, ' ').trim();
        return {
          label: message.kind === 'report' ? 'Laporan agent dibuat' : message.kind === 'system' ? 'Catatan sistem agent' : message.role === 'user' ? 'Perintah dikirim' : 'Balasan agent',
          snippet: text.length > 90 ? `${text.slice(0, 90)}…` : text,
          created_at: message.created_at
        };
      }));
    };

    const setChatPlaceholder = (text) => {
      if (chatListEl.querySelector('.bubble')) return;
      chatListEl.innerHTML = `<p class="panel-note" data-chat-placeholder>${escapeHtml(text)}</p>`;
    };
    const scrollChat = () => {
      const panel = chatListEl.closest('.chat-panel');
      if (panel) panel.scrollTop = panel.scrollHeight;
    };
    const messageBubble = (message) => {
      const bubble = document.createElement('div');
      bubble.className = `bubble${message.role === 'user' ? ' user' : ''}`;
      if (message.kind === 'system') bubble.setAttribute('style', 'background:#f1f1f1;color:var(--warning)');
      else if (message.kind === 'report') bubble.setAttribute('style', 'background:rgba(195,237,206,.55)');
      const label = message.kind === 'report' ? 'Laporan mingguan' : message.kind === 'system' ? 'Sistem' : '';
      if (label) {
        const strong = document.createElement('strong');
        strong.textContent = `${label} · `;
        bubble.appendChild(strong);
      }
      bubble.appendChild(document.createTextNode(String(message.content || '')));
      const stamp = parseTime(message.created_at);
      if (stamp) bubble.title = stamp.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return bubble;
    };
    const appendMessages = (messages) => {
      chatListEl.querySelector('[data-chat-placeholder]')?.remove();
      messages.forEach((message) => {
        chatListEl.appendChild(messageBubble(message));
        lastMessageId = Math.max(lastMessageId, Number(message.id) || 0);
      });
      scrollChat();
    };

    const refreshAgent = async () => {
      try {
        const payload = await request('/agent');
        agentPayload = { ...(agentPayload || {}), ...(payload || {}) };
        renderAgent(agentPayload);
        renderConfigForm(agentPayload);
      } catch (error) {
        setText('[data-agent-state]', 'Tidak tersedia');
        setText('[data-agent-message]', `Gagal memuat status agent: ${error.message}`);
        const llmTag = document.querySelector('[data-llm-tag]');
        if (llmTag) { llmTag.className = 'tag neutral'; llmTag.textContent = 'LLM: tidak diketahui'; }
        const accountList = document.querySelector('[data-account-list]');
        if (accountList) accountList.innerHTML = `<p class="panel-note">${escapeHtml(`Gagal memuat akun: ${error.message}`)}</p>`;
        const capabilityList = document.querySelector('[data-capability-list]');
        if (capabilityList) capabilityList.innerHTML = `<p class="panel-note">${escapeHtml(`Gagal memuat capability: ${error.message}`)}</p>`;
      }
    };

    const refreshMessages = async () => {
      try {
        const payload = await request(`/agent/messages${lastMessageId ? `?after=${lastMessageId}&limit=50` : '?limit=50'}`);
        const messages = Array.isArray(payload) ? payload : (Array.isArray(payload?.messages) ? payload.messages : []);
        if (!messages.length) {
          if (!lastMessageId) {
            setChatPlaceholder('Belum ada percakapan. Kirim perintah pertama untuk agent-mu.');
            if (!hasAgentEvents) renderActivityList([]);
          }
          return;
        }
        appendMessages(messages);
        collectActivity(messages);
        // A report/system row arriving through the poll means server-side state changed too.
        if (messages.some((message) => message.kind === 'report' || message.kind === 'system')) refreshAgent();
      } catch (error) {
        if (!lastMessageId) setChatPlaceholder(`Gagal memuat percakapan: ${error.message}`);
      }
    };

    document.querySelector('[data-agent-action="toggle"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!agentPayload?.agent) { showToast('Status agent belum termuat.'); return; }
      const enabled = button.dataset.enabled !== 'true';
      button.disabled = true;
      try {
        const payload = await request('/agent/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
        track('agent_toggled', { enabled });
        showToast(enabled ? 'Agent dinyalakan kembali.' : 'Agent dimatikan untuk pekerjaan baru.');
        if (payload?.agent) {
          agentPayload = { ...(agentPayload || {}), ...payload };
          renderAgent(agentPayload);
          renderConfigForm(agentPayload);
        } else {
          await refreshAgent();
        }
      } catch (error) {
        toastError(error);
      } finally {
        button.disabled = false;
      }
    });

    document.querySelector('[data-agent-action="report"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await request('/agent/report', { method: 'POST' });
        track('agent_report_requested');
        showToast('Permintaan report masuk queue. Hasilnya muncul di thread chat agent.');
        await refreshAgent();
      } catch (error) {
        showToast(error.status === 409 ? (error.body?.message || ERROR_COPY.report_already_queued) : (error.retryAfter > 0 ? `${error.message} Coba lagi dalam ${error.retryAfter} detik.` : error.message));
      } finally {
        button.disabled = false;
      }
    });

    const chatForm = document.querySelector('[data-chat-form]');
    chatForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.querySelector('[data-chat-input]');
      const message = String(input?.value || '').trim();
      if (!message) { showToast('Tulis pesan dulu.'); return; }
      if (message.length > 2000) { showToast(ERROR_COPY.message_too_long); return; }
      if (chatPending) return;
      chatPending = true;
      const button = chatForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await request('/agent/chat', { method: 'POST', body: JSON.stringify({ message }) });
        track('agent_chat_sent', { message_length: message.length });
        input.value = '';
        await refreshMessages();
      } catch (error) {
        toastError(error);
        // A failed run still persists a system row with the closed-set reason — show it.
        await refreshMessages();
      } finally {
        chatPending = false;
        if (button) button.disabled = false;
      }
    });

    const connectForm = document.querySelector('[data-connect-form]');
    connectForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const platform = connectForm.elements.platform.value;
      const handle = connectForm.elements.handle.value.trim();
      if (!handle) { showToast('Isi handle akun dulu.'); return; }
      const button = connectForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await request('/agent/connect', { method: 'POST', body: JSON.stringify({ platform, handle }) });
        track('agent_connected', { platform }); // platform only — never the handle
        showToast(`Akun ${handle} tercatat dengan status menunggu OAuth.`);
        connectForm.elements.handle.value = '';
        await refreshAgent();
      } catch (error) {
        if (error.status === 409) {
          const existing = error.body?.account;
          showToast(existing
            ? `Akun ${existing.handle} (${PLATFORM_LABELS[existing.platform] || existing.platform}) sudah terhubung.`
            : (error.body?.message || 'Akun ini sudah terhubung pada agent-mu.'));
        } else {
          toastError(error);
        }
      } finally {
        if (button) button.disabled = false;
      }
    });

    document.querySelector('[data-account-platforms]')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-agent-action="disconnect"]');
      if (!button) return;
      if (!window.confirm('Hapus akun ini dari agent?')) return;
      button.disabled = true;
      try {
        await request(`/agent/accounts/${encodeURIComponent(button.dataset.accountId)}`, { method: 'DELETE' });
        showToast('Akun dihapus dari agent.');
        await refreshAgent();
      } catch (error) {
        toastError(error);
        button.disabled = false;
      }
    });

    const configForm = document.querySelector('[data-config-form]');
    configForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = String(configForm.elements.name.value || '').trim().slice(0, 60);
      if (!name) { showToast('Nama agent tidak boleh kosong.'); return; }
      const button = configForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await request('/agent/config', {
          method: 'PUT',
          body: JSON.stringify({
            name,
            system_prompt: String(configForm.elements.system_prompt.value || '').slice(0, 2000),
            capabilities: { report: Boolean(configForm.elements.report.checked) }
          })
        });
        showToast('Konfigurasi agent tersimpan.');
        configFormLoaded = false;
        await refreshAgent();
      } catch (error) {
        toastError(error);
      } finally {
        if (button) button.disabled = false;
      }
    });

    // 15s message poll, only while the tab is visible (cursor by last message id).
    window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshMessages();
    }, 15000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshMessages();
    });

    refreshAgent();
    refreshMessages();
  }

  // Admin Waiting List Leads Loader
  const adminWlBody = document.getElementById('admin-wl-table-body');
  if (adminWlBody) {
    const escapeHtml = (str) => String(str || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    const loadAdminWaitingList = () => {
      const token = localStorage.getItem('hermes-session-token');
      fetch('/api/admin/waitinglist', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error('Gagal memuat waiting list')))
        .then((data) => {
          if (data && data.entries) {
            const badge = document.getElementById('admin-wl-badge');
            if (badge) badge.textContent = String(data.total || data.entries.length);
            track('leads_loaded', { total: data.total || data.entries.length });
            if (!data.entries.length) {
              adminWlBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;color:var(--muted)">Belum ada data antrean.</td></tr>';
              return;
            }
            adminWlBody.innerHTML = data.entries.map((e) => `
              <tr>
                <td><strong>${escapeHtml(e.name)}</strong></td>
                <td>${escapeHtml(e.email)}</td>
                <td>${escapeHtml(e.whatsapp)}</td>
                <td><span class="tag neutral">${escapeHtml(e.role_category || '-')}</span></td>
                <td>${escapeHtml(e.target_platform || '-')}</td>
                <td><code>${escapeHtml(e.referral_code || '-')}</code></td>
                <td><small style="color:var(--muted)">${new Date(e.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></td>
              </tr>
            `).join('');
          }
        })
        .catch((err) => {
          adminWlBody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:16px;color:var(--danger)">${err.message}</td></tr>`;
        });
    };
    loadAdminWaitingList();
    document.getElementById('btn-admin-export-wl')?.addEventListener('click', () => {
      track('leads_refresh');
      showToast('Memperbarui data leads…');
      loadAdminWaitingList();
    });

    // Repliz API Key Manual Management in Admin Dashboard
    const replizKeyInput = document.getElementById('input-repliz-key');
    const replizWsInput = document.getElementById('input-repliz-workspace');
    const replizBadge = document.getElementById('repliz-badge-status');
    const replizSub = document.getElementById('repliz-info-sub');
    const replizState = document.getElementById('repliz-info-state');
    const btnToggleVis = document.getElementById('btn-toggle-repliz-vis');
    const btnSaveRepliz = document.getElementById('btn-save-repliz');
    const btnClearRepliz = document.getElementById('btn-clear-repliz');

    if (replizKeyInput) {
      const updateReplizUI = (hasKey) => {
        if (hasKey) {
          if (replizBadge) { replizBadge.textContent = 'Tersimpan (Siap)'; replizBadge.className = 'tag'; replizBadge.style.background = 'var(--green)'; replizBadge.style.color = 'var(--green-strong)'; }
          if (replizSub) replizSub.textContent = 'API Key aktif terpasang secara manual';
          if (replizState) { replizState.textContent = 'Healthy'; replizState.style.color = 'var(--green-strong)'; }
        } else {
          if (replizBadge) { replizBadge.textContent = 'Kosong (Belum Diatur)'; replizBadge.className = 'tag neutral'; replizBadge.style.background = ''; replizBadge.style.color = ''; }
          if (replizSub) replizSub.textContent = 'Belum ada API Key aktif (kredensial kosong)';
          if (replizState) { replizState.textContent = 'Standby (Kosong)'; replizState.style.color = 'var(--warning)'; }
        }
      };

      const savedKey = localStorage.getItem('hermes_repliz_api_key') || '';
      const savedWs = localStorage.getItem('hermes_repliz_workspace') || '';
      replizKeyInput.value = savedKey;
      if (replizWsInput) replizWsInput.value = savedWs;
      updateReplizUI(Boolean(savedKey));

      btnToggleVis?.addEventListener('click', () => {
        const isPwd = replizKeyInput.type === 'password';
        replizKeyInput.type = isPwd ? 'text' : 'password';
        btnToggleVis.textContent = isPwd ? 'Sembunyikan' : 'Lihat';
      });

      btnSaveRepliz?.addEventListener('click', () => {
        const val = replizKeyInput.value.trim();
        const wsVal = replizWsInput?.value.trim() || '';
        if (!val) {
          localStorage.removeItem('hermes_repliz_api_key');
          localStorage.removeItem('hermes_repliz_workspace');
          updateReplizUI(false);
          track('repliz_key_cleared');
          showToast('Kredensial API Repliz dikosongkan.');
          return;
        }
        localStorage.setItem('hermes_repliz_api_key', val);
        if (wsVal) localStorage.setItem('hermes_repliz_workspace', wsVal);
        updateReplizUI(true);
        track('repliz_key_saved');
        showToast('Kredensial API Repliz berhasil disimpan secara manual.');
      });

      btnClearRepliz?.addEventListener('click', () => {
        replizKeyInput.value = '';
        if (replizWsInput) replizWsInput.value = '';
        localStorage.removeItem('hermes_repliz_api_key');
        localStorage.removeItem('hermes_repliz_workspace');
        updateReplizUI(false);
        track('repliz_key_cleared');
        showToast('Kredensial API Repliz telah dikosongkan.');
      });
    }
  }

  // --- Hermes agent runtime (admin) ---
  // Live wiring for /admin/: every panel below reads GET /api/admin/agents | /api/admin/agent-jobs |
  // /api/admin/agent-audit with the Bearer session token (the server enforces role=admin), and the
  // only writes are POST /api/admin/agent-action. No demo snapshots, no fabricated ids, no fake
  // numbers: empty or failing responses render honest states. The waiting-list and Repliz blocks
  // above are untouched.
  if (document.getElementById('runtime')) {
    const API = window.HERMES_API_BASE || '/api';
    const SESSION_COPY = 'Sesi berakhir. Masuk ulang untuk melanjutkan.';
    // Desired/actual status → tag class (active=success, paused/unconfig=neutral, error=warning).
    const STATUS_META = {
      active: { label: 'ON / Siap', cls: 'tag' },
      paused: { label: 'OFF', cls: 'tag neutral' },
      error: { label: 'ON / Error', cls: 'tag warning' },
      unconfig: { label: 'LLM belum dikonfigurasi', cls: 'tag neutral' }
    };
    const RUNTIME_ROWS = [
      { key: 'active', icon: 'ON', label: 'ON / Siap', accent: '' },
      { key: 'paused', icon: 'OFF', label: 'OFF', accent: 'background:var(--pink)' },
      { key: 'error', icon: '!', label: 'Error', accent: 'background:var(--pink-alt)' },
      { key: 'unconfig', icon: 'LLM', label: 'Unconfig', accent: 'background:#f1f1f1' }
    ];
    const JOB_TYPES = { scheduled_report: 'Report terjadwal', manual_report: 'Report manual' };
    const JOB_STATES = {
      queued: { label: 'Menunggu', cls: 'tag neutral', style: '' },
      running: { label: 'Berjalan', cls: 'tag', style: '' },
      done: { label: 'Selesai', cls: 'tag', style: '' },
      failed: { label: 'Gagal', cls: 'tag warning', style: 'color:var(--danger)' }
    };
    // Contract wording for capabilities that have no platform integration in this phase.
    const UNSUPPORTED_REASON = 'Belum tersedia di fase ini (butuh integrasi platform)';

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    const clip = (value, max = 80) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const parseTime = (value) => {
      const raw = String(value || '').trim().replace(' ', 'T');
      if (!raw) return null;
      const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const relativeTime = (value) => {
      const date = parseTime(value);
      if (!date) return '';
      const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
      if (minutes < 1) return 'baru saja';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
    };
    const stamp = (value) => {
      const date = parseTime(value);
      return date ? date.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
    };
    const emptyRow = (colspan, message, color = 'var(--muted)') => `<tr><td colspan="${colspan}" style="text-align:center;padding:16px;color:${color}">${escapeHtml(message)}</td></tr>`;
    const request = async (path, options = {}) => {
      const token = localStorage.getItem('hermes-session-token');
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Surface the runtime's own message; fall back to the HTTP status, never to invented copy.
        const error = new Error(body?.message || `Permintaan gagal (HTTP ${response.status}).`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    };

    let sessionExpired = false;
    let agentsPayload = null;
    let lastJobs = [];

    const markSessionExpired = () => {
      if (sessionExpired) return;
      sessionExpired = true;
      showToast(SESSION_COPY);
      setText('admin-metric-agents', '—');
      setText('admin-metric-queue', '—');
      setText('admin-metric-agents-trend', SESSION_COPY);
      setText('admin-metric-queue-trend', SESSION_COPY);
      setText('admin-health-note', SESSION_COPY);
      const bodies = { 'admin-agents-body': 6, 'admin-jobs-body': 7, 'admin-audit-body': 6 };
      Object.keys(bodies).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = emptyRow(bodies[id], SESSION_COPY, 'var(--danger)');
      });
      ['admin-runtime-list', 'admin-capabilities-list', 'admin-llm-list'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<p class="panel-note" style="color:var(--danger)">${escapeHtml(SESSION_COPY)}</p>`;
      });
    };
    const failRow = (id, colspan, message) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = emptyRow(colspan, message, 'var(--danger)');
    };

    const renderAgents = (payload) => {
      const rows = Array.isArray(payload?.agents) ? payload.agents : [];
      const badge = document.getElementById('admin-agents-badge');
      if (badge) { badge.textContent = String(rows.length); badge.hidden = rows.length === 0; }
      const tag = document.getElementById('admin-agents-tag');
      if (tag) { tag.className = 'tag neutral'; tag.textContent = `${rows.length} agent`; }
      const body = document.getElementById('admin-agents-body');
      if (!body) return;
      if (!rows.length) {
        body.innerHTML = emptyRow(6, 'Belum ada agent terdaftar. Baris agent dibuat otomatis saat user mendaftar.');
        return;
      }
      body.innerHTML = rows.map((agent) => {
        const meta = STATUS_META[agent.status] || { label: String(agent.status || 'tidak diketahui'), cls: 'tag neutral' };
        const detail = agent.status === 'error' ? clip(agent.status_detail, 80) : '';
        const userName = String(agent.user_name || '').trim() || `user #${agent.user_id ?? '-'}`;
        const queueDepth = Number.isFinite(Number(agent.queue_depth)) ? Number(agent.queue_depth) : 0;
        const lastAt = agent.last_status_at || agent.created_at;
        const agentId = escapeHtml(agent.id ?? '');
        const agentName = escapeHtml(agent.name || '');
        const held = `data-agent-id="${agentId}" data-agent-name="${agentName}"`;
        return `<tr>
          <td data-label="User"><strong>${escapeHtml(userName)}</strong><br /><small style="color:var(--muted)">user #${escapeHtml(agent.user_id ?? '-')}</small></td>
          <td data-label="Agent">${escapeHtml(agent.name || '-')}<br /><small style="color:var(--muted)">agent #${agentId || '-'}${agent.model ? ` · ${escapeHtml(agent.model)}` : ''}</small></td>
          <td data-label="Desired / actual"><span class="${meta.cls}">${escapeHtml(meta.label)}</span>${detail ? `<br /><small style="color:var(--danger)" title="${escapeHtml(clip(agent.status_detail, 200))}">${escapeHtml(detail)}</small>` : ''}</td>
          <td data-label="Antrean">${escapeHtml(queueDepth)}</td>
          <td data-label="Last event"><small style="color:var(--muted)" title="${escapeHtml(stamp(lastAt))}">${escapeHtml(relativeTime(lastAt) || '-')}</small></td>
          <td data-label="Aksi"><div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end"><button class="pill pill-light" type="button" style="min-height:30px;padding:5px 10px;font-size:10px" data-admin-action="${agent.enabled ? 'disable' : 'enable'}" ${held}>${agent.enabled ? 'Matikan' : 'Nyalakan'}</button><button class="pill pill-light" type="button" style="min-height:30px;padding:5px 10px;font-size:10px" data-admin-action="run_report" ${held}>Run report</button></div></td>
        </tr>`;
      }).join('');
    };

    const renderRuntime = (payload) => {
      const totals = payload?.totals || {};
      const list = document.getElementById('admin-runtime-list');
      const total = Number(totals.total) || 0;
      if (list) {
        list.innerHTML = RUNTIME_ROWS.map((row) => {
          const count = Number(totals[row.key]) || 0;
          const percent = total ? Math.round((count / total) * 100) : 0;
          return `<div class="capability-row"><span class="feature-icon" style="${row.accent}">${escapeHtml(row.icon)}</span><span><strong>${escapeHtml(row.label)}</strong><span>${count} runtime</span></span><span class="capability-state${row.key === 'active' ? '' : ' locked'}">${percent}%</span></div>`;
        }).join('');
      }
      const tag = document.getElementById('admin-health-tag');
      const llm = payload?.llm || {};
      if (tag) {
        tag.className = llm.configured ? 'tag' : 'tag warning';
        tag.textContent = llm.configured ? 'LLM terkonfigurasi' : 'LLM belum dikonfigurasi';
      }
      const errors = Number(totals.error) || 0;
      const queueDepth = Number(totals.queue_depth) || 0;
      setText('admin-metric-agents', String(total));
      setText('admin-metric-agents-trend', `${Number(totals.active) || 0} aktif · ${Number(totals.paused) || 0} nonaktif · ${Number(totals.unconfig) || 0} tanpa LLM`);
      setText('admin-metric-queue', String(queueDepth));
      setText('admin-metric-queue-trend', errors ? `${errors} agent perlu perhatian` : 'Tidak ada agent error');
      setText('admin-health-note', `Snapshot live ${new Date().toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${total} agent · ${queueDepth} job queued`);
      const state = document.getElementById('admin-system-state');
      if (state) {
        state.setAttribute('style', errors === 0 ? '' : 'background:var(--pink);color:var(--warning)');
        const dot = state.querySelector('i');
        if (dot) dot.setAttribute('style', errors === 0 ? '' : 'background:currentColor');
        const label = state.querySelector('span');
        if (label) label.textContent = errors ? `${errors} agent error dari ${total} agent` : `${total} agent tanpa error`;
      }
    };

    const renderJobs = (payload) => {
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      lastJobs = jobs;
      const failed = jobs.filter((job) => job.status === 'failed').length;
      const queued = jobs.filter((job) => job.status === 'queued').length;
      const tag = document.getElementById('admin-queues-tag');
      if (tag) {
        tag.className = failed ? 'tag warning' : 'tag neutral';
        tag.textContent = failed ? `${failed} dead-letter` : 'Tidak ada dead-letter';
      }
      const badge = document.getElementById('admin-queues-badge');
      if (badge) { badge.textContent = String(queued); badge.hidden = queued === 0; }
      const body = document.getElementById('admin-jobs-body');
      if (!body) return;
      if (!jobs.length) {
        body.innerHTML = emptyRow(7, 'Antrean kosong');
        return;
      }
      body.innerHTML = jobs.map((job) => {
        const state = JOB_STATES[job.status] || { label: String(job.status || '-'), cls: 'tag neutral', style: '' };
        const error = clip(job.error, 90);
        const requeue = `<button class="pill pill-light" type="button" style="min-height:30px;padding:5px 10px;font-size:10px;margin-top:6px" data-admin-action="requeue_failed" data-agent-id="${escapeHtml(job.agent_id ?? '')}" data-agent-name="${escapeHtml(job.agent_name || '')}">Requeue</button>`;
        return `<tr>
          <td data-label="Job">#${escapeHtml(job.id ?? '-')}<br /><small style="color:var(--muted)">${escapeHtml(job.agent_name || `agent #${job.agent_id ?? '-'}`)}</small></td>
          <td data-label="Tipe">${escapeHtml(JOB_TYPES[job.type] || job.type || '-')}${job.week_key ? `<br /><small style="color:var(--muted)">${escapeHtml(job.week_key)}</small>` : ''}</td>
          <td data-label="Status"><span class="${state.cls}"${state.style ? ` style="${state.style}"` : ''}>${escapeHtml(state.label)}</span></td>
          <td data-label="Attempts">${escapeHtml(job.attempts ?? 0)}</td>
          <td data-label="Dibuat"><small style="color:var(--muted)" title="${escapeHtml(stamp(job.created_at))}">${escapeHtml(relativeTime(job.created_at) || '-')}</small></td>
          <td data-label="Selesai"><small style="color:var(--muted)" title="${escapeHtml(stamp(job.finished_at))}">${job.finished_at ? escapeHtml(relativeTime(job.finished_at)) : '-'}</small></td>
          <td data-label="Catatan">${error ? `<small style="color:${job.status === 'failed' ? 'var(--danger)' : 'var(--warning)'}" title="${escapeHtml(clip(job.error, 200))}">${escapeHtml(error)}</small>` : '<small style="color:var(--muted)">-</small>'}${job.status === 'failed' ? `<br />${requeue}` : ''}</td>
        </tr>`;
      }).join('');
    };

    const renderAudit = (payload) => {
      const events = Array.isArray(payload?.events) ? payload.events : [];
      const body = document.getElementById('admin-audit-body');
      if (!body) return;
      if (!events.length) {
        body.innerHTML = emptyRow(6, 'Belum ada audit event.');
        return;
      }
      body.innerHTML = events.map((event) => {
        const target = event.agent_name || (event.agent_id ? `agent #${event.agent_id}` : 'platform');
        const detail = clip(event.detail, 70);
        return `<tr>
          <td data-label="Event">#${escapeHtml(event.id ?? '-')}</td>
          <td data-label="Aktor">${escapeHtml(event.actor || '-')}</td>
          <td data-label="Aksi">${escapeHtml(event.action || '-')}</td>
          <td data-label="Target">${escapeHtml(target)}</td>
          <td data-label="Detail"><small style="color:var(--muted)" title="${escapeHtml(clip(event.detail, 200))}">${escapeHtml(detail || '-')}</small></td>
          <td data-label="Waktu"><small style="color:var(--muted)" title="${escapeHtml(stamp(event.created_at))}">${escapeHtml(relativeTime(event.created_at) || '-')}</small></td>
        </tr>`;
      }).join('');
    };

    const renderLlm = (payload) => {
      const list = document.getElementById('admin-llm-list');
      if (!list) return;
      const llm = payload?.llm || {};
      const configured = Boolean(llm.configured);
      const total = Array.isArray(payload?.agents) ? payload.agents.length : 0;
      const rows = [
        { name: 'Provider server-managed', flow: `Host: ${llm.provider_host || 'tidak diketahui'} · key tidak pernah dikirim ke dashboard`, state: configured ? 'Terkonfigurasi' : 'Tanpa key', pending: !configured },
        { name: 'Model aktif', flow: llm.model || 'belum disetel dari env', state: configured ? 'Aktif' : 'Menunggu key', pending: !configured },
        { name: 'Agent memakai provider ini', flow: `${configured ? total : 0} dari ${total} agent · status unconfig dihitung ulang tiap tick saat key tidak ada`, state: configured ? 'Aktif' : 'Tidak ada', pending: !configured }
      ];
      list.innerHTML = rows.map((row) => `<div class="platform"><div><p class="platform-name">${escapeHtml(row.name)}</p><p class="platform-flow">${escapeHtml(row.flow)}</p></div><span class="platform-status${row.pending ? ' pending' : ''}">${escapeHtml(row.state)}</span></div>`).join('');
    };

    const renderCapabilities = () => {
      const list = document.getElementById('admin-capabilities-list');
      if (!list) return;
      const agents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : [];
      const enabled = agents.filter((agent) => agent.enabled).length;
      const reportJobs = lastJobs.filter((job) => String(job.type || '').includes('report'));
      const reportDone = reportJobs.filter((job) => job.status === 'done').length;
      const rows = [
        { name: 'Conversations', flow: `Chat langsung dengan agent · ${enabled} dari ${agents.length} agent aktif`, state: 'Siap', pending: false },
        { name: 'Report', flow: `Rekap mingguan dan report manual · ${reportJobs.length} job report tercatat, ${reportDone} selesai`, state: 'Siap', pending: false },
        { name: 'Comments', flow: `Balasan komentar platform · ${UNSUPPORTED_REASON}`, state: 'Belum tersedia', pending: true },
        { name: 'Schedule', flow: `Penjadwalan konten · ${UNSUPPORTED_REASON}`, state: 'Belum tersedia', pending: true }
      ];
      list.innerHTML = rows.map((row) => `<div class="platform"><div><p class="platform-name">${escapeHtml(row.name)}</p><p class="platform-flow">${escapeHtml(row.flow)}</p></div><span class="platform-status${row.pending ? ' pending' : ''}">${escapeHtml(row.state)}</span></div>`).join('');
    };

    const loadAgents = async () => {
      if (sessionExpired) return;
      try {
        const payload = await request('/admin/agents');
        agentsPayload = payload;
        renderAgents(payload);
        renderRuntime(payload);
        renderLlm(payload);
        renderCapabilities();
      } catch (error) {
        if (error.status === 401) { markSessionExpired(); return; }
        setText('admin-health-note', `Gagal memuat runtime: ${error.message}`);
        setText('admin-metric-agents', '—');
        setText('admin-metric-agents-trend', `Gagal memuat: ${error.message}`);
        failRow('admin-agents-body', 6, `Gagal memuat agent runtime: ${error.message}`);
      }
    };
    const loadJobs = async () => {
      if (sessionExpired) return;
      try {
        const payload = await request('/admin/agent-jobs');
        renderJobs(payload);
        renderCapabilities();
      } catch (error) {
        if (error.status === 401) { markSessionExpired(); return; }
        failRow('admin-jobs-body', 7, `Gagal memuat antrean job: ${error.message}`);
      }
    };
    const loadAudit = async () => {
      if (sessionExpired) return;
      try {
        renderAudit(await request('/admin/agent-audit'));
      } catch (error) {
        if (error.status === 401) { markSessionExpired(); return; }
        failRow('admin-audit-body', 6, `Gagal memuat audit log: ${error.message}`);
      }
    };
    const refreshAll = () => { loadAgents(); loadJobs(); loadAudit(); };

    const actionToast = (action, name, payload) => {
      if (action === 'run_report') return `Report untuk ${name} masuk antrean${payload?.job?.id ? ` (job #${payload.job.id})` : ''}.`;
      if (action === 'enable') return `${name} diaktifkan kembali.`;
      if (action === 'disable') return `${name} dimatikan untuk pekerjaan baru.`;
      if (action === 'requeue_failed') return `${Number(payload?.requeued) || 0} job gagal dikembalikan ke antrean (attempts direset).`;
      return `Aksi ${action} diterima runtime.`;
    };
    const runAction = async (button) => {
      const action = String(button.dataset.adminAction || '');
      const agentId = Number.parseInt(button.dataset.agentId, 10);
      const agentName = button.dataset.agentName || `agent #${button.dataset.agentId || '-'}`;
      if (!Number.isFinite(agentId)) { showToast('Aksi admin tanpa agent_id yang valid.'); return; }
      if (action === 'disable' && !window.confirm(`Matikan ${agentName}? Job baru berhenti diproses sampai agent dinyalakan kembali.`)) return;
      button.disabled = true;
      try {
        const payload = await request('/admin/agent-action', { method: 'POST', body: JSON.stringify({ agent_id: agentId, action }) });
        // Analytics: the action name only — never user ids, agent ids, emails, handles, or content.
        track('agent_admin_action', { action });
        showToast(actionToast(action, agentName, payload));
        await Promise.all([loadAgents(), loadJobs(), loadAudit()]);
      } catch (error) {
        if (error.status === 401) { markSessionExpired(); return; }
        showToast(`Aksi ${action} gagal: ${error.message}`);
      } finally {
        button.disabled = false;
      }
    };
    document.getElementById('admin-agents-body')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-admin-action]');
      if (button) runAction(button);
    });
    document.getElementById('admin-jobs-body')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-admin-action]');
      if (!button) return;
      if (!window.confirm(`Kembalikan job gagal ke antrean untuk ${button.dataset.agentName || 'agent ini'}?`)) return;
      runAction(button);
    });

    document.getElementById('admin-health-refresh')?.addEventListener('click', () => {
      showToast('Memuat ulang snapshot runtime…');
      refreshAll();
    });
    document.getElementById('admin-agents-refresh')?.addEventListener('click', () => {
      showToast('Memuat ulang daftar agent…');
      loadAgents();
    });
    document.getElementById('admin-audit-refresh')?.addEventListener('click', loadAudit);

    // 20s refresh of the runtime snapshot while the tab is visible: no redirect on 401, the panels
    // switch to the honest 'Sesi berakhir' state instead.
    window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll();
    }, 20000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshAll();
    });

    refreshAll();
  }
})();

