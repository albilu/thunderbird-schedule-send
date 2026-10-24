# thunderbird-schedule-send

[![Check and package](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/check.yml/badge.svg)](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/check.yml) [![Release](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/release.yml/badge.svg)](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/release.yml) [![Latest release](https://img.shields.io/github/v/release/albilu/thunderbird-schedule-send)](https://github.com/albilu/thunderbird-schedule-send/releases/latest) [![Thunderbird](https://img.shields.io/badge/Thunderbird-128+-blue.svg)](#requirements)

**Schedule and repeat emails in Thunderbird, stored as ordinary drafts in your account's synchronized IMAP Drafts folder.**

A dependency-free Thunderbird MailExtension plus a small Experiment API. A dropdown beside **Send** captures the composition, saves it to server Drafts with its schedule, and native delivery happens later through your own SMTP account. No queue page, no custom folder, no external service.

## Why?

Thunderbird has no built-in send-later. Because each scheduled message lives in your real Drafts folder with native previews, attachments, search and tags, you can inspect, edit, pause or cancel it with the mail UI you already know — from the **Manage schedule** button in the message header.

## Features

- **One-time or delayed send** — pick a date/time or a delay in minutes, with **5, 10 and 30 minute** presets and a live next-delivery preview.
- **Recurrence** — repeat every X minutes, days, months or years, with calendar-anchored dates (Jan 31 → Feb's last day → Mar 31).
- **Delivery rules** — restrict sending to a time window (including windows crossing midnight, e.g. 22:00–05:00) and to selected weekdays.
- **Native Drafts management** — scheduled drafts carry a colored **Scheduled** tag and their next delivery time in the Date column; pause, resume, reschedule, edit or cancel from the message header.
- **Safe editing** — editing a draft pauses delivery; on save/close you choose **Save and keep schedule**, **Save without schedule**, or **Continue editing**.
- **Faithful messages** — attachments, HTML/plain text, embedded images, reply headers and Bcc recipients are preserved; up to 50 MB.
- **Crash-safe delivery** — a `sending` marker plus **Needs review** state prevents silent duplicates after interruption; failed sends are never auto-retried.
- **Native look and feel** — popups, fields and buttons follow Thunderbird's resolved colors, including light/dark themes, custom themes and accent changes, updating while open.
- **English and French** — follows Thunderbird's interface language.

## Requirements

- **Thunderbird 128+** — native integration verified on **128.0** and **153.4.0** on Linux, with both English and French add-on locales.
- **IMAP-stored drafts** — the sender identity's Drafts folder (Account Settings → Copies & Folders) must be on an IMAP server. There is no silent fallback to Local Folders, and scheduling requires a connection.
- The Experiment API requires Thunderbird's **full, unrestricted access** permission prompt on install and upgrade.
- Build from source needs **Node.js 22+** and **Python 3**; no npm or pip packages to install.

## Install

Download `thunderbird-scheduled-send-<version>.xpi` (with its SHA-256 checksum) from the [Releases page](https://github.com/albilu/thunderbird-schedule-send/releases).

In Thunderbird, open **Add-ons and Themes → Extensions → gear menu → Install Add-on From File…** and select the `.xpi`.

## Usage

1. Compose a message with recipients and attachments.
2. Click **Schedule send** beside **Send**.
3. Choose a delay or date/time; presets select a delay without scheduling yet.
4. Optionally set a repeat interval and expand **Delivery rules** for hours and weekdays.
5. Check the preview and click **Schedule**. The draft is confirmed on the server before the compose window closes.

Open the account's **Drafts** folder to manage queued mail — the **Scheduled** toolbar button jumps straight to the current account's Drafts folder. **Cancel schedule** keeps an ordinary editable draft; moving or deleting the draft cancels future sends. One-time drafts are removed after successful delivery; recurring drafts stay with an updated schedule.

Draft contents and schedule headers synchronize through IMAP, so other clients can read the draft — but **only the originating Thunderbird profile sends it**. Delivery reads the current server copy; if another client replaces the draft or strips the `X-Scheduled-Send` header, the schedule stops. Gmail web-edit behavior is unverified — see [docs/gmail-drafts.md](docs/gmail-drafts.md).

### Scheduling rules worth knowing

- **Thunderbird must be open and online**; nothing runs while it is closed, and the extension does not wake the computer.
- Late one-time messages wait for the next permitted time; late recurring messages send once and skip missed occurrences.
- The system time zone is recorded with the schedule; changing it pauses schedules until rescheduled.
- DST: nonexistent spring hours are rejected on input and skipped forward on repeats; ambiguous autumn times use the first occurrence.
- Windows include their start and exclude their end; equal start/end is rejected.
- Encrypted or signed messages, newsgroup posts and unsupported embedded resources are refused before scheduling — security settings are never silently removed. Interactive checks (spellcheck, forgotten-attachment prompts, other extensions' `compose.onBeforeSend` hooks) do not run at delivery time, so review before scheduling.
- A confirmed send whose Sent-folder copy failed is still recorded as sent, and the draft is retained for recovery.

## Privacy

No telemetry, analytics, remote code or external application server. Drafts are uploaded only to the selected IMAP account and delivered through its configured SMTP account. The `scheduleBridge` experiment is limited to the toolbar button, Drafts access, composition capture, and native delivery — it exposes no arbitrary file paths or commands. Disabling the add-on stops scheduling while drafts stay readable; back up the profile before uninstalling to keep the local delivery journal.

## Development

For quick iteration, use **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…** with `extension/manifest.json`, and reload after edits.

```sh
npm run check               # syntax, locales parity, manifest/version and path checks
npm test                    # unit tests (calendar/DST, state machine, MIME, delivery)
npm run build               # deterministic XPI into dist/
npm run test:thunderbird    # real Thunderbird suite (Linux; needs Xvfb, optional xfwm4 + ImageMagick)
SCHEDULE_TEST_LOCALE=fr npm run test:thunderbird   # French UI run
python3 scripts/package.py  # package only, no checks
```

The native suite runs a disposable profile with loopback-only IMAP/SMTP fixtures — it never touches your real profile or relays mail — and is not part of CI. Logs and screenshots land in `test-results/`; set `THUNDERBIRD_BINARY` to pick another executable and `SCHEDULE_TEST_RESULTS` to keep each version's results in a separate directory.

Translations live in `extension/_locales/{en,fr}/messages.json` with identical keys and matching `$N` placeholders; `npm run check` enforces parity. Releases are tagged `v<version>` matching `extension/manifest.json` and `package.json`; the Release workflow rebuilds, verifies the checksum, and publishes the XPI with generated notes.

## Architecture

| Component | Responsibility |
| --- | --- |
| `extension/lib/schedule.mjs` | Calendar validation, recurrence anchors and delivery windows |
| `extension/lib/engine.mjs` | Serialized state machine, offline handling and recovery |
| `extension/lib/store.mjs`, `draft-store.mjs` | Local delivery journal, server-draft persistence and migration |
| `extension/background/` | Capture, commands, alarms and native-delivery adapter |
| `extension/experiments/scheduleBridge/` | Native toolbar and mail integration |
| `extension/popup/`, `extension/message/` | Scheduling dropdown and per-message controls |
| `extension/lib/rule-form.mjs` | Shared schedule editor and live preview |
| `extension/_locales/` | English and French UI strings |
| `tests/` | Unit tests and real Thunderbird/IMAP/SMTP integration |

The scheduled MIME message is saved to IMAP Drafts before the local journal commits; a versioned `X-Scheduled-Send` header carries the schedule and originating profile UUID. Before sending, the folder is refreshed and the draft's identity and ownership re-verified, then the current MIME content is delivered with internal headers and the Bcc header stripped (Bcc envelope recipients preserved). A `sending` marker committed before transport becomes `sent` on success or `review` on ambiguity, so duplicates are never automatic — exactly-once delivery cannot be guaranteed across a process crash and an external SMTP server.
