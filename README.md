# Scheduled Send for Thunderbird

[![Check and package](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/check.yml/badge.svg)](https://github.com/albilu/thunderbird-schedule-send/actions/workflows/check.yml)

Schedule and repeat emails in Thunderbird using your account’s synchronized IMAP Drafts. Includes a dropdown beside **Send**, delivery windows and weekday rules, native theme colors, and complete English and French translations.

## Features

- Send at a specific date/time or after a delay in minutes.
- Presets for **5, 10 and 30 minutes**.
- Repeat every X minutes, days, months or years.
- Limit delivery to a time window, including windows crossing midnight.
- Select the weekdays on which messages may be sent.
- Preview the next delivery before scheduling.
- Manage queued mail in the account’s **Drafts** folder, with native message previews, attachments, search and status tags.
- Pause, resume, reschedule, edit or cancel from each message’s **Manage schedule** button.
- Preserve attachments, HTML/plain text, embedded images, reply headers and Bcc recipients.

## Install

The current compatibility floor is **Thunderbird 153**; native integration has been validated on **153.4.0**. This is a tested-version limit, not a confirmed minimum required by every API. Earlier releases need native compatibility testing before lowering it. Build with Python 3:

```sh
python3 scripts/package.py
```

In Thunderbird, select **Add-ons and Themes → Extensions → gear menu → Install Add-on From File**, then choose the generated `.xpi` in `dist/`. Tagged releases also publish the installable XPI and its SHA-256 checksum on the [Releases page](https://github.com/albilu/thunderbird-schedule-send/releases).

For development, use **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on** and select `extension/manifest.json`.

## Usage

1. Compose a message and add its recipients and attachments.
2. Click **Schedule send** beside **Send**.
3. Choose a delay or date/time. Presets select a delay; they do not immediately schedule or send.
4. Optionally choose a repeat interval and expand **Delivery rules** for hours and weekdays.
5. Check the preview and click **Schedule**. The message is saved to server Drafts before the compose window closes.

Open your email account’s **Drafts** folder. Scheduled drafts have a colored **Scheduled** tag and their next delivery time in the Date field. Select one and click **Manage schedule** in its message header to pause, resume, reschedule, edit or cancel. The **Scheduled** toolbar button opens the current account’s configured Drafts folder in the current mail tab. The compose popup’s **Open Drafts** shortcut uses the sender’s Drafts folder. There is no separate queue page or custom mail folder.

Use **Edit draft**, or open the draft normally, to change its recipients, body or attachments. Delivery stops while you edit. When you explicitly save or close the draft, a popup offers **Save and keep schedule**, **Save without schedule**, or **Continue editing**. Keeping the schedule saves the edited contents and closes the editor, preserving the original time, recurrence and delivery rules. Previously paused schedules stay paused; schedules needing review still need review. If the original time has passed, the popup explains that delivery can occur at the next permitted time, possibly immediately. Automatic draft saves do not restore delivery or open the popup.

**Cancel schedule** keeps an ordinary editable draft. Moving or deleting the draft cancels future sends. A send already in progress cannot be recalled. One-time drafts are removed after successful delivery; recurring drafts remain, with an updated schedule. If Thunderbird or the add-on is restarted during editing, the saved draft stays unscheduled; schedule it again when ready.

**Drafts must be stored on an IMAP server.** The extension uses the sender identity’s configured Drafts folder (Account Settings → Copies & Folders), including the provider’s normal Drafts folder. It does not create a separate folder or silently fall back to Local Folders. Scheduling requires a connection so the draft can be confirmed on the server before the compose window closes.

The draft’s contents and schedule headers synchronize with the account. Other Thunderbird instances and webmail can access the draft, but **only the originating Thunderbird profile sends it**. There is no ownership-transfer feature. Delivery reads the current synchronized message, never the old private snapshot. If another mail client replaces the draft or removes its scheduling header, the original schedule stops; changes that preserve the draft’s identity and metadata are read from the current server copy. Webmail does not provide the add-on’s scheduling controls.

Gmail documents that updating a draft replaces its underlying **Gmail message resource**, while the Gmail draft resource has a stable ID. Those API IDs are distinct from the RFC `Message-ID` header used here. Google's documentation does not establish whether the Gmail web editor preserves that header and `X-Scheduled-Send`. Live Gmail web-edit behavior remains unverified; see the [verification notes](docs/gmail-drafts.md).

Existing local schedules are migrated to the sender’s server Drafts folder. The original contents are retained until the server copy is confirmed. If the account is offline or still configured for local drafts, migration pauses the schedule; correct the settings and reload the add-on to retry. Existing unrelated mail is untouched.

## Scheduling rules

- **Thunderbird must be open, online and able to access the sender’s SMTP account.** No remote scheduling service runs when Thunderbird is closed.
- The queue and attachment contents survive restarts and add-on reloads. Disabling the add-on stops scheduling; uninstalling it may remove its data. Drafts synchronize through IMAP; the sending profile’s delivery journal stays local.
- A next-delivery alarm and a one-minute recovery check drive delivery. Sleep, connection availability and server latency may delay a send; the extension does not wake the computer.
- Late messages wait for the next permitted time. A late recurring message sends once, then skips missed occurrences rather than sending a backlog. Repeats continue until paused or cancelled.
- The local system time zone is recorded with the schedule. Changing the system zone pauses schedules until they are rescheduled in the new zone.
- Minute repeats measure elapsed time. Calendar repeats retain the original wall time and date anchor: January 31 → February’s last day → March 31; February 29 uses February 28 in other years.
- Input during a nonexistent spring daylight-saving hour is rejected. Calendar repeats in that missing hour move forward by the gap; later repeats return to the original wall time. Ambiguous autumn times use the first occurrence.
- Windows include their start and exclude their end. **22:00–05:00** is supported. Allowed weekdays refer to the actual delivery date, including after midnight. Equal start/end times are rejected; disable the window to allow all hours.
- Failed or interrupted sends enter **Needs review** and are never automatically retried. Check Sent and your mail server before retrying, since the server may already have accepted the message. A confirmed send with a failed Sent-folder copy is recorded as sent.

## Message handling and limits

Server drafts contain the recipients, body, attachments, embedded images, reply references and scheduling metadata. Original attachment files need not remain available. Web-linked images stay linked and are not fetched by this extension. Scheduling replaces the composition’s existing draft after the scheduled server draft has been saved, leaving one draft with its existing tags plus the schedule status tag. Schedule changes and cancellation preserve the user’s tags.

This release supports ordinary email up to **50 MB**, including body and attachments. Encrypted or digitally signed messages, automatic public-key attachments, newsgroup posts and unsupported embedded resources are rejected before scheduling, leaving the composition open. Security settings are never silently removed. Thunderbird’s blocked-content protection is respected; review its notice before scheduling a message with blocked resources.

Background delivery uses Thunderbird’s native MIME/SMTP services and account configuration. Interactive checks such as spellchecking, forgotten-attachment prompts and other extensions’ `compose.onBeforeSend` hooks do not run at delivery time. Review the message before scheduling. Background delivery does not update the original reply’s read/replied UI flag.

Cancelling clears the scheduling information and leaves an ordinary draft. Confirmed delivery removes a one-time draft, unless its Sent-folder copy failed, in which case the draft is retained for recovery. Completed/cancelled schedules retain a small local delivery journal. Drafts remain readable when the add-on is disabled. Back up the Thunderbird profile before uninstalling if you need to preserve the journal and sending-profile identity.

## Privacy and permissions

There is no telemetry, remote code, analytics, external application server or runtime dependency. Drafts are uploaded to the selected IMAP account and delivered through its configured SMTP account. Storage is not separately encrypted by this add-on.

The `scheduleBridge` experiment positions the native button, opens account Drafts, uses Thunderbird’s application icon for notifications, locks a composition while capturing it, reads embedded resources referenced by that composition, closes it after a durable save, reads and saves scheduled server drafts, observes draft editing/deletion, and invokes native background delivery. Thunderbird grants experiments full application access. The bridge exposes no arbitrary file paths or commands.

Standard permissions cover the current composition and sender identity, mail-folder navigation, selected-message identification, alarms, durable storage, notifications and theme colors. The `messagesRead` permission supports the native message controls. Only explicitly scheduled drafts owned by this profile are sent. The extension does not schedule ordinary drafts or claim another profile’s messages.

## Development and validation

Node.js 22+ and Python 3 are sufficient; no npm dependencies need installation.

```sh
npm run check
npm test
npm run build
```

The checks validate JavaScript syntax, packaged paths, manifest/version consistency and English/French translation parity. Calendar and state-machine tests cover DST, leap years, month-end anchors, constraints, missed repeats, offline handling, concurrent alarms, native-folder cancellation and interruption recovery. Packaging is deterministic and includes only `extension/`.

Native Linux integration tests use Thunderbird 153+, Xvfb, and optionally `xfwm4` and ImageMagick for screenshots:

```sh
npm run test:thunderbird
SCHEDULE_TEST_LOCALE=fr npm run test:thunderbird
```

Tests create a disposable profile and virtual display, and run loopback-only IMAP and SMTP fixtures. They verify server-side storage, replacement of tagged drafts without duplicates, tag preservation, account-specific toolbar navigation, native notification icons, native draft editing, the save/close confirmation choices, restoring schedules with edited content, cancellation, metadata, MIME delivery and migration. They never open your real profile or deliver email externally. These fixtures do not replace testing against live Gmail or Yahoo accounts. Logs, results and screenshots are written under `test-results/`. Set `THUNDERBIRD_BINARY` to select a different executable.

## CI and releases

Branch pushes and pull requests run syntax and translation checks, the unit tests, and packaging on GitHub Actions. Each successful run uploads the XPI and its SHA-256 checksum as an artifact, retained for 14 days. The native Thunderbird integration tests above run separately in a desktop environment.

To publish a release, update the version in both `extension/manifest.json` and `package.json`, run the checks and native tests, then commit and push the changes. Create and push the matching version tag:

```sh
release_tag="v$(node -p "require('./package.json').version")"
git tag -a "$release_tag" -m "Release $release_tag"
git push origin "$release_tag"
```

The **Release** workflow validates that the tag matches the package version, runs the same checks and build, verifies the checksum, and publishes a GitHub Release with the XPI, checksum and generated release notes. It uses GitHub’s built-in token; no additional release secret is required.

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

The scheduled MIME message is saved in the sender’s IMAP Drafts folder before its local delivery journal commits. A versioned `X-Scheduled-Send` header carries the schedule and the originating profile UUID. IndexedDB retains metadata and delivery state; it does not retain a second message body or attachment payload after migration. Before sending, the extension refreshes the folder and verifies the draft’s identity and ownership, then delivers the current MIME content. Internal scheduling headers and Bcc are stripped from the outgoing message while Bcc envelope recipients are preserved.

Before transport begins, the engine commits a `sending` marker. Success becomes `sent` and removes a one-time draft, or advances a recurring schedule. Ambiguous delivery becomes `review`; startup also converts leftover `sending` records to `review`. This avoids automatic duplicates. Exactly-once delivery cannot be guaranteed across a process crash and an external SMTP server.

## References

- [Thunderbird Compose API](https://webextension-api.thunderbird.net/en/mv2/compose.html)
- [Thunderbird Compose Action API](https://webextension-api.thunderbird.net/en/mv2/composeAction.html)
- [Thunderbird extension experiments](https://developer.thunderbird.net/add-ons/mailextensions/experiments)
- [Send Later](https://github.com/Extended-Thunder/send-later), the alternative mentioned in the original project brief. This project does not bundle its code.
