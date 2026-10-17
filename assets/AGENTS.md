# assets — AGENTS.md

## Purpose

- Static binary/text assets: brand fonts and the downloadable lead-magnet playbook

## Ownership

- Owns `assets/fonts/` (`Herokid-*.woff2`, 4 files) and `assets/lead-magnet/the-hermes-playbook.html`
- `public/assets/` must stay byte-identical (see `public/AGENTS.md`); only `assets/fonts/` is mirrored — the playbook is read from root `assets/` by `server.mjs` and is not mirrored

## Local Contracts

- `assets/lead-magnet/the-hermes-playbook.html` is served by `GET /api/lead-magnet/download` in `server.mjs` as attachment `The-Autonomous-Hermes-Playbook.html`; the lead-magnet page also links it directly via `/assets/lead-magnet/the-hermes-playbook.html` for in-browser reading — keep both paths working
- Fonts are referenced by `styles.css`; do not rename files without updating the stylesheet
- Playbook is self-contained inline-`<style>` HTML; keep it dependency-free so the download works standalone

## Work Guidance

## Verification

- Manual: `node server.mjs`, then `GET /api/lead-magnet/download` returns the playbook HTML as attachment

## Child DOX Index

- No children
