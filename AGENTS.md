# AGENTS.md

Thunderbird MailExtension (Manifest V2) for scheduled/recurring send via IMAP Drafts. No runtime npm dependencies; no bundler. Source ships as-is inside the XPI.

## Commands

- `npm run check` — fast static validation (run first). Checks JS syntax via `node --check`, JSON validity, en/fr locale key parity + `$N` substitution parity, that every `t("key")` / `data-i18n="key"` / `errorXxx` string exists in `_locales/en/messages.json`, that referenced packaged paths exist, and that `extension/manifest.json` version equals `package.json` version.
- `npm test` — Node unit tests: `node --test tests/*.test.mjs`. Single file: `node --test tests/engine.test.mjs`.
- `npm run build` — `python3 scripts/package.py` writes a deterministic (fixed timestamps, sorted entries) `dist/thunderbird-scheduled-send-{version}.xpi` containing only `extension/`.
- `npm run test:thunderbird` — native integration tests; see below.

Order for verification: `npm run check` → `npm test` → `npm run build`. CI (`.github/workflows/check.yml`) runs exactly that.

## Toolchain

- Node >= 22 (`"type": "module"`, `.mjs` sources) and Python 3. No `npm install` step exists — `package.json` has no deps; do not add any without checking with the user.
- The XPI is built by Python, not Node. Don't try to replace it with a JS bundler.

## Versioning and releases

- Version lives in BOTH `extension/manifest.json` and `package.json`; `npm run check` fails if they differ. Bump both together.
- Release tags must be `v{manifest.version}` exactly; the release workflow asserts this.

## Thunderbird integration tests (`npm run test:thunderbird`)

- Linux-only. Require a real Thunderbird binary (README documents 153+ as the tested floor; `manifest.json` `strict_min_version` is lower — do not lower the README floor without native retesting), `Xvfb`, and optionally `xfwm4` + ImageMagick (screenshots).
- Uses a disposable profile plus loopback IMAP/SMTP fixtures (`tests/imap_fixture.py`, in-file SMTP server). Never touches the user's real profile and never relays mail externally. Don't point it at real accounts.
- Env vars: `THUNDERBIRD_BINARY` (pick executable), `SCHEDULE_TEST_LOCALE=fr` (run French UI), `SCHEDULE_TEST_RESULTS` (output dir, default `test-results/<locale>/`).
- `test-results/` and `dist/` are gitignored build/test outputs.

## Code layout (what's where)

- `extension/lib/` — pure, testable logic: `schedule.mjs` (calendar/DST/recurrence), `engine.mjs` (state machine), `store.mjs` + `draft-store.mjs` (journal + server-draft persistence). Unit tests import from here; keep these free of `browser.*` / DOM dependencies so `node --test` can load them.
- `extension/background/background.mjs` — WebExtension glue: alarms, commands, native-delivery adapter.
- `extension/experiments/scheduleBridge/` — Thunderbird experiment API (privileged native code: toolbar button, Drafts folder access, MIME delivery). Schema in `schema.json`, implementation loaded via `manifest.experiment_apis`. This is NOT a WebExtension context — it uses `Services.*`, `Cc/Ci`, etc.
- `extension/popup/` (compose dropdown), `extension/message/` (per-message "Manage schedule"), `extension/lib/rule-form.mjs` (shared editor UI).
- `extension/_locales/{en,fr}/messages.json` — only these two locales; both must always have identical keys.

## Conventions that will bite you

- **i18n parity is enforced.** Adding a `t("newKey")`, `data-i18n="newKey"`, or a string literal matching `error[A-Z]...` anywhere under `extension/` without adding `newKey` to BOTH locale files fails `npm run check`. `$1`/`$2` placeholders must match between en and fr.
- **Architecture/state machine invariants** (delivery markers `sending` → `sent`/`review`, `X-Scheduled-Send` header, IMAP Drafts as source of truth) are documented in `README.md` § Architecture — read before changing `engine.mjs`, `draft-store.mjs`, or the experiments layer.
- Gmail draft-edit behavior is explicitly unverified; see `docs/gmail-drafts.md` before claiming web-edit support.
