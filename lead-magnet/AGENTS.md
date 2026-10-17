# lead-magnet — AGENTS.md

## Purpose

- VIP waiting-list funnel at `/lead-magnet/` (also served as `/waiting-list`): pitch copy, waitinglist form, VIP ticket boarding pass, referral share, FAQ

## Ownership

- Owns `lead-magnet/index.html` including its inline `<script>` (pill selectors, mobile menu, smooth scroll, FAQ accordion, stats fetch, form submit) — this page does not use root `app.js`

## Local Contracts

- Form `#waitinglist-form` posts `{name, email, whatsapp, role_category, target_platform, notes}` to `POST /api/waitinglist`; success swaps `#waitinglist-form-card` for `#ticket-wrapper`
- Stats bar (`#stat-total-queue`, `#badge-slots`, `#stat-slots-left`) reads `GET /api/waitinglist/stats`; their initial HTML values must be neutral placeholders (`—`), never a number — the live fetch overwrites on success and on failure stays empty rather than lying
- Marquee strip (`wl-marquee`) is a feature showcase only — zero invented user names or activity claims ("Nadia S. baru saja mengamankan slot" was removed as fabricated social proof); no fake user count anywhere on this page (the `1,280+` hero claim was removed)
- Ticket fallback is `—`; `#VIP-····` marks the unloaded ticket state only
- Ticket fields (`#ticket-queue-number`, `#ticket-user-name`, `#ticket-referral-code`, `#share-link-display`, `#btn-share-whatsapp`, `#btn-copy-ref`) and download link `#btn-download-playbook` (`/api/lead-magnet/download`) must keep their IDs
- Category pills (`#category-pills`, single-select) vs platform pills (`#platform-pills`, multi-select) have different toggle semantics — preserve them
- Queue numbers (`#VIP-XXXX`) and referral codes (`HERMES-XXXXXX`) are issued by `server.mjs`

## Work Guidance

- Inline script defines a guarded `track()` helper (PostHog optional, CDN-block safe) and fires: `playbook_download`, `whatsapp_shared`, `waitinglist_submit_success` (props: `alreadyRegistered`, `role_category`, `target_platform`, `queueNumber` — never email/phone), `waitinglist_submit_error`, `referral_copied`
- Keep all captures inside try/guard; never send PII (email, whatsapp, notes) as event properties

## Verification

- `npm run build` (vite build includes `lead-magnet/index.html` input)
- Manual: `node server.mjs`, submit the form once with a fresh email and once with the same email (already-registered path), confirm ticket + download link
- PostHog events: submit form + copy referral, confirm `waitinglist_submit_success` / `referral_copied` in PostHog
- Full-stack verification pass incl. this page: `.cursor/skills/verify-hermes/SKILL.md`

## Child DOX Index

- No children
