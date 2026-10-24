# Scheduled Send for Thunderbird

A Thunderbird extension for scheduling email, with a dropdown beside **Send**, native theme colors, and complete English and French translations.

## Features

- Send at a specific date/time or after a delay in minutes.
- Presets for **5, 10 and 30 minutes**.
- Repeat every X minutes, days, months or years.
- Limit delivery to a time window, including windows crossing midnight.
- Select the weekdays on which messages may be sent.
- Preview the next delivery before scheduling.
- Manage the persistent queue: pause, resume, reschedule, open an editable copy, cancel, and view history.
- Preserve attachments, HTML/plain text, embedded images, reply headers and Bcc recipients.

## Install

Requires **Thunderbird 153 or later**. Build with Python 3:

```sh
python3 scripts/package.py
```

In Thunderbird, select **Add-ons and Themes → Extensions → gear menu → Install Add-on From File**, then choose `dist/thunderbird-scheduled-send-0.1.0.xpi`.

For development, use **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on** and select `extension/manifest.json`.

## Usage

1. Compose a message and add its recipients and attachments.
2. Click **Schedule send** beside **Send**.
3. Choose a delay or date/time. Presets select a delay; they do not immediately schedule or send.
4. Optionally choose a repeat interval and expand **Delivery rules** for hours and weekdays.
5. Check the preview and click **Schedule**. A durable message snapshot is saved before the compose window closes.

Open **Scheduled messages** from the main toolbar button, the popup, or the add-on preferences. **Open a copy** pauses the original schedule and opens an editable copy. Cancel the old paused schedule if you schedule the new copy. Restored copies start a new conversation; original scheduled replies retain their reply headers.

## Scheduling rules

- **Thunderbird must be open, online and able to access the sender’s SMTP account.** No remote scheduling service runs when Thunderbird is closed.
- The queue and attachment contents survive restarts and add-on reloads. Disabling the add-on stops scheduling; uninstalling it may remove its data. Queues are local to one Thunderbird profile and do not synchronize between devices.
- A next-delivery alarm and a one-minute recovery check drive delivery. Sleep, connection availability and server latency may delay a send; the extension does not wake the computer.
- Late messages wait for the next permitted time. A late recurring message sends once, then skips missed occurrences rather than sending a backlog. Repeats continue until paused or cancelled.
- The local system time zone is recorded with the schedule. Changing the system zone pauses schedules until they are rescheduled in the new zone.
- Minute repeats measure elapsed time. Calendar repeats retain the original wall time and date anchor: January 31 → February’s last day → March 31; February 29 uses February 28 in other years.
- Input during a nonexistent spring daylight-saving hour is rejected. Calendar repeats in that missing hour move forward by the gap; later repeats return to the original wall time. Ambiguous autumn times use the first occurrence.
- Windows include their start and exclude their end. **22:00–05:00** is supported. Allowed weekdays refer to the actual delivery date, including after midnight. Equal start/end times are rejected; disable the window to allow all hours.
- Failed or interrupted sends enter **Needs review** and are never automatically retried. Check Sent and your mail server before retrying, since the server may already have accepted the message. A confirmed send with a failed Sent-folder copy is recorded as sent.

## Message handling and limits

Snapshots contain the sender identity, recipients, message body, attachments, embedded images, reply references and composition settings. Original attachment files need not remain available. Web-linked images stay linked and are not fetched by this extension. Existing source drafts are retained; editing them does not change scheduled snapshots.

This release supports ordinary email up to **50 MB**, including body and attachments. Encrypted or digitally signed messages, automatic public-key attachments, newsgroup posts and unsupported embedded resources are rejected before scheduling, leaving the composition open. Security settings are never silently removed. Thunderbird’s blocked-content protection is respected; review its notice before scheduling a message with blocked resources.

Background delivery uses Thunderbird’s native MIME/SMTP services and account configuration. Interactive checks such as spellchecking, forgotten-attachment prompts and other extensions’ `compose.onBeforeSend` hooks do not run at delivery time. Review the message before scheduling. Background delivery does not update the original reply’s read/replied UI flag.

Cancelling removes stored message contents and prevents future occurrences; it cannot recall mail already sent. Completed/cancelled entries keep only queue metadata until removed from history. Back up the Thunderbird profile before uninstalling if you need to preserve queued messages.

## Privacy and permissions

There is no telemetry, remote code, analytics, external application server or runtime dependency. Message data stays in the Thunderbird profile until sent through the selected SMTP account. Storage is not separately encrypted by this add-on.

The `scheduleBridge` experiment positions the native button, locks a composition while capturing it, reads embedded resources referenced by that composition, closes it after a durable save, and invokes native background delivery. Thunderbird grants experiments full application access. The bridge exposes no arbitrary file paths or commands.

Standard permissions cover the current composition and sender identity, alarms, durable storage, notifications and theme colors. The extension does not scan existing mail folders.

## Development and validation

Node.js 22+ and Python 3 are sufficient; no npm dependencies need installation.

```sh
npm run check
npm test
npm run build
```

The checks validate JavaScript syntax, packaged paths, manifest/version consistency and English/French translation parity. Calendar and state-machine tests cover DST, leap years, month-end anchors, constraints, missed repeats, offline handling, concurrent alarms and interruption recovery. Packaging is deterministic and includes only `extension/`.

Native Linux integration tests use Thunderbird 153+, Xvfb, and optionally `xfwm4` and ImageMagick for screenshots:

```sh
npm run test:thunderbird
SCHEDULE_TEST_LOCALE=fr npm run test:thunderbird
```

Tests create a disposable profile and virtual display, and capture messages on a loopback-only SMTP server. They never open your real profile or deliver email externally. Logs, results and screenshots are written under `test-results/`. Set `THUNDERBIRD_BINARY` to select a different executable.

## Architecture

| Component | Responsibility |
| --- | --- |
| `extension/lib/schedule.mjs` | Calendar validation, recurrence anchors and delivery windows |
| `extension/lib/engine.mjs` | Serialized state machine, offline handling and recovery |
| `extension/lib/store.mjs` | Atomic IndexedDB metadata and message/attachment storage |
| `extension/background/` | Capture, commands, alarms and native-delivery adapter |
| `extension/experiments/scheduleBridge/` | Native toolbar and mail integration |
| `extension/popup/`, `extension/queue/` | Scheduling dropdown and management tab |
| `extension/lib/rule-form.mjs` | Shared schedule editor and live preview |
| `extension/_locales/` | English and French UI strings |
| `tests/` | Unit tests and real Thunderbird/SMTP integration |

Before transport begins, the engine commits a `sending` marker. Success becomes `sent` and removes a one-time payload, or advances a recurring schedule. Ambiguous delivery becomes `review`; startup also converts leftover `sending` records to `review`. This avoids automatic duplicates. Exactly-once delivery cannot be guaranteed across a process crash and an external SMTP server.

## References

- [Thunderbird Compose API](https://webextension-api.thunderbird.net/en/mv2/compose.html)
- [Thunderbird Compose Action API](https://webextension-api.thunderbird.net/en/mv2/composeAction.html)
- [Thunderbird extension experiments](https://developer.thunderbird.net/add-ons/mailextensions/experiments)
- [Send Later](https://github.com/Extended-Thunder/send-later), the alternative mentioned in the original project brief. This project does not bundle its code.
