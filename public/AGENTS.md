# public — AGENTS.md

## Purpose

- Static-serving mirror used by Vite build and `server.mjs` static handler

## Ownership

- Owns `public/app.js`, `public/posthog-init.js`, `public/styles.css`, `public/assets/fonts/`
- Sync-only copy: sources of truth are root `app.js`, root `posthog-init.js`, root `styles.css`, root `assets/fonts/` — verified byte-identical (SHA256) at DOX init

## Local Contracts

- Never edit files under `public/` independently; edit the root source then copy over it verbatim
- After any change to root `app.js`, `posthog-init.js`, `styles.css`, or `assets/fonts/`, re-copy to the matching `public/` path and re-verify hashes match
- Do not add files under `public/` that have no root source; new static inputs go at root first

## Work Guidance

## Verification

- `npm run build`
- Manual hash check: `Get-FileHash app.js, public/app.js` and `Get-FileHash styles.css, public/styles.css` and `Get-FileHash posthog-init.js, public/posthog-init.js` must match

## Child DOX Index

- No children
