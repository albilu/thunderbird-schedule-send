# Gmail draft editing verification

Checked on 2026-10-24. **Documentation verified; live Gmail web-editor test still pending.**

## Confirmed by Google

- A Gmail draft is a stable container. Updating it replaces the underlying Gmail message resource; that message's Gmail API ID changes. [Create and send draft emails](https://developers.google.com/workspace/gmail/api/guides/drafts)
- The Gmail draft resource has an immutable `id`. [Draft resource reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts)
- Gmail's IMAP `X-GM-MSGID` corresponds to its Gmail API message ID. It is not the RFC `Message-ID` mail header. [Gmail IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions)

These facts do **not** prove whether Gmail's web editor preserves the RFC `Message-ID` and `X-Scheduled-Send` headers when saving an IMAP-created draft. The extension uses those headers, not Gmail's draft resource ID. It already supports IMAP UID replacement when those headers survive.

No Gmail account was connected in the available tools, and the browser automation service could not start its configured browser. No authenticated Gmail draft was created, modified or sent during this investigation.

## Required live check

1. Use a disposable Gmail draft with a unique test subject and body. Record its raw RFC `Message-ID` and `X-Scheduled-Send` headers after the initial IMAP upload, plus its IMAP UID and Gmail message ID.
2. Keep the originating scheduler disabled while testing, so nothing is delivered.
3. Open that exact draft in Gmail's web editor, change the body, and close the editor to save. Wait for the save to complete.
4. Refresh Drafts via IMAP and read the updated raw message. Compare the two RFC headers independently of the IMAP UID and Gmail API message ID. Also confirm that the edited body and attachments survived.
5. If both required RFC headers survive, the extension can recognize the updated draft. If either is absent or changed, the existing schedule must stop. Repeat for a subject or recipient edit before claiming general web-editor compatibility.

An API `drafts.update` request with chosen MIME headers is not a substitute for step 3: it verifies what the API caller supplied, rather than what Gmail's web editor preserves. Never identify a replacement only by subject or recipients; different drafts can share them.

The local IMAP integration tests cover preserved headers, removed scheduling metadata and a foreign owner. They establish the extension's behavior for those inputs, not Gmail's choice of input.
