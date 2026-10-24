/* A deliberately narrow bridge to Thunderbird's native compose services.
 * No remote code, arbitrary file paths, preferences, or commands are exposed.
 * Thunderbird 153 is the first supported/tested release of these interfaces.
 */
var { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
var { MsgHdrProcessor } = ChromeUtils.importESModule("resource:///modules/ExtensionMessages.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
var { MessageSend } = ChromeUtils.importESModule("resource:///modules/MessageSend.sys.mjs");
var { XPCOMUtils } = ChromeUtils.importESModule("resource://gre/modules/XPCOMUtils.sys.mjs");
var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
XPCOMUtils.defineLazyGlobalGetters(this, ["DOMParser"]);

var COMPOSE_URL = "chrome://messenger/content/messengercompose/messengercompose.xhtml";
var MAX_BYTES = 50 * 1024 * 1024;

function fileAt(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

async function embedImages(window, html) {
  // Parse a detached clone; never change the user's editor. Read only resources
  // already referenced by this composition, never arbitrary caller-supplied URLs.
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const cache = new Map();
  let total = 0;
  for (const image of doc.querySelectorAll("img[src], [background]")) {
    const attribute = image.hasAttribute("src") ? "src" : "background";
    const src = image.getAttribute(attribute);
    if (!src || src.startsWith("data:")) continue;
    if (/^https?:/i.test(src)) {
      // Keep explicitly linked web images linked. Never fetch tracking URLs.
      image.setAttribute("moz-do-not-send", "true");
      continue;
    }
    if (!/^(file|mailbox|imap|imaps|news|snews):/i.test(src)) throw new ExtensionError("errorInlineImage");
    const original = [...window.GetCurrentEditor().document.images].find(node => node.getAttribute("src") === src);
    if (!original?.complete || !original.naturalWidth || original.getAttribute("moz-do-not-send") === "true") {
      throw new ExtensionError("errorBlockedContent");
    }
    if (!cache.has(src)) {
      cache.set(src, await new Promise((resolve, reject) => {
        NetUtil.asyncFetch({ uri: src, loadUsingSystemPrincipal: true }, (stream, status, request) => {
          try {
            if (!Components.isSuccessCode(status)) throw new ExtensionError("errorInlineImage");
            const size = stream.available();
            total += size;
            if (total > MAX_BYTES) throw new ExtensionError("errorTooLarge");
            const bytes = NetUtil.readInputStreamToString(stream, size);
            const type = request.QueryInterface(Ci.nsIChannel).contentType;
            if (!type.startsWith("image/")) throw new ExtensionError("errorInlineImage");
            resolve(`data:${type};base64,${window.btoa(bytes)}`);
          } catch (error) { reject(error); } finally { stream.close(); }
        });
      }));
    }
    image.setAttribute(attribute, cache.get(src));
    image.removeAttribute("moz-do-not-send");
  }
  // A transient local URL in CSS/srcset would not survive closing the editor.
  if (/(?:file|mailbox|imap|imaps|cid|blob):/i.test(doc.documentElement.outerHTML.replaceAll(/<a\b[^>]*>/gi, ""))) {
    throw new ExtensionError("errorInlineImage");
  }
  return doc.documentElement.outerHTML;
}

var scheduleBridge = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    this.windows = new Map();
    this.locked = new Set();
    this.listenerId = `${context.extension.id}-schedule-position`;
    const composeWindow = tabId => {
      const window = context.extension.tabManager.get(tabId).nativeTab;
      if (!window?.gMsgCompose || window.closed) throw new ExtensionError("errorCompose");
      return window;
    };
    const scope = { MailServices, MailUtils, MsgHdrProcessor, ExtensionError, MessageSend,
      IOUtils, PathUtils, Services, ChromeUtils, Components, Cc, Ci, fileAt, console, setTimeout, clearTimeout };
    this.resourceAlias = `${ExtensionCommon.makeWidgetId(context.extension.id)}-helpers`;
    this.resources = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    this.resources.setSubstitution(this.resourceAlias, context.extension.rootURI);
    for (const file of ["draft-mime.js", "draft-editor.js", "drafts.js"]) {
      Services.scriptloader.loadSubScript(`resource://${this.resourceAlias}/experiments/scheduleBridge/${file}`, scope);
    }
    const mime = scope.DraftMime;
    const mailbox = this.mailbox = new scope.DraftMailbox(context);
    const queueMessageID = id => `scheduled-send-${id}@scheduled-send.invalid`;
    const stageMessage = async (payload, job) => {
      if (Services.io.offline) throw new ExtensionError("errorOffline");
      const { details, native, attachments } = payload;
      if (details.selectedEncryptionTechnology?.encryptBody || details.selectedEncryptionTechnology?.signMessage || details.attachPublicPGPKey) {
        throw new ExtensionError("errorEncryption");
      }
      const identity = MailServices.accounts.getIdentity(details.identityId);
      const account = [...MailServices.accounts.accounts].find(a => [...a.identities].some(i => i.key === details.identityId));
      if (!identity || !account) throw new ExtensionError("errorIdentity");
      if (!native.to && !native.cc && !native.bcc) throw new ExtensionError("errorRecipients");
      if (native.newsgroups) throw new ExtensionError("errorNewsgroups");
      const directory = PathUtils.join(PathUtils.tempDir, `scheduled-send-${Services.uuid.generateUUID().toString().slice(1, -1)}`);
      await IOUtils.makeDirectory(directory, { permissions: 0o700 });
      let messageFile = null;
      const compose = Cc["@mozilla.org/messengercompose/compose;1"].createInstance(Ci.nsIMsgCompose);
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener", "nsIMsgCopyServiceListener"]),
        onStartSending() {}, onProgress() {}, onStatus() {}, onGetDraftFolderURI() {},
        onSendNotPerformed() {}, onTransportSecurityError() {},
        onStartCopy() {}, onStopCopy() {}, setMessageKey() {},
        getMessageId() { return queueMessageID(job.id); },
        onStopSending(id, status, message, file) {
          if (Components.isSuccessCode(status)) messageFile = file;
        }
      };
      try {
        const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
        const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
        params.type = Ci.nsIMsgCompType.New;
        params.identity = identity;
        params.composeFields = fields;
        compose.initialize(params);
        for (const name of ["from", "to", "cc", "bcc", "replyTo", "followupTo", "references", "fcc", "fcc2", "contentLanguage"]) {
          if (native[name]) fields[name] = native[name];
        }
        fields.subject = details.subject;
        fields.body = details.isPlainText ? details.plainTextBody : details.body;
        const formats = Ci.nsIMsgCompSendFormat;
        const plain = details.isPlainText || details.deliveryFormat === "plaintext";
        fields.forcePlainText = plain;
        fields.useMultipartAlternative = !plain && details.deliveryFormat !== "html";
        fields.deliveryFormat = plain ? formats.PlainText : fields.useMultipartAlternative ? formats.Both : formats.HTML;
        fields.returnReceipt = Boolean(details.returnReceipt);
        fields.DSN = Boolean(details.deliveryStatusNotification);
        fields.attachVCard = Boolean(details.attachVCard);
        fields.priority = details.priority || "normal";
        for (const header of details.customHeaders || []) {
          if (/^X-[A-Za-z0-9-]+$/i.test(header.name) && !/[\r\n]/.test(header.value)) fields.setHeader(header.name, header.value);
        }
        let size = 0;
        for (const [index, attachment] of attachments.entries()) {
          const bytes = new Uint8Array(ChromeUtils.base64URLDecode(attachment.base64.replaceAll("+", "-").replaceAll("/", "_"), { padding: "ignore" }));
          size += bytes.length;
          if (size > MAX_BYTES) throw new ExtensionError("errorTooLarge");
          const path = PathUtils.join(directory, String(index));
          await IOUtils.write(path, bytes, { permissions: 0o600 });
          const nativeAttachment = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
          nativeAttachment.url = Services.io.newFileURI(fileAt(path)).spec;
          nativeAttachment.name = attachment.name;
          nativeAttachment.contentType = attachment.type || "application/octet-stream";
          fields.addAttachment(nativeAttachment);
        }
        if (details.attachVCard && identity.escapedVCard) {
          const card = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
          card.name = `${identity.email.split("@")[0].replaceAll(".", "_") || "vcard"}.vcf`;
          card.contentType = "text/vcard";
          card.url = `data:text/vcard;charset=utf-8,${identity.escapedVCard}`;
          fields.addAttachment(card);
        }
        if (Services.io.offline) throw new ExtensionError("errorOffline");
        // MessageSend accepts a detached editor adapter. Its native MIME
        // builder then collects data images into multipart/related and
        // rewrites the HTML CIDs together, without opening a compose window.
        const document = details.isPlainText ? null : new DOMParser().parseFromString(details.body, "text/html");
        const editor = document ? { document, outputToString: () => document.documentElement.outerHTML } : null;
        fields.messageId = `<${queueMessageID(job.id)}>`;
        fields.setRawHeader("Date", new Date(job.nextAt || job.createdAt).toUTCString());
        await new MessageSend().createAndSendMessage(
          editor, identity, account.key, fields, false, true,
          Ci.nsIMsgSend.nsMsgSaveAsDraft, null,
          details.isPlainText ? "text/plain" : "text/html", fields.body,
          null, null, listener, null, null, Ci.nsIMsgCompType.New
        );
        if (!messageFile) throw new ExtensionError("errorStorage");
        const bytes = await IOUtils.read(messageFile.path);
        let raw = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        }
        const draftId = queueMessageID(job.id);
        raw = mime.rewrite(raw, { job, messageId: draftId, date: job.nextAt });
        return mailbox.append(job, raw, draftId, mime.token(job));
      } catch (error) {
        console.error("Scheduled Send draft creation failed", error);
        throw new ExtensionError(error.message || String(error));
      } finally {
        if (messageFile) await IOUtils.remove(messageFile.path).catch(console.error);
        await IOUtils.remove(directory, { recursive: true }).catch(console.error);
      }
    };
    return {
      scheduleBridge: {
        start: async owner => {
          if (this.started) return;
          this.started = true;
          mailbox.start(owner);
          for (const [status, color] of Object.entries({pending: "#1373d9", paused: "#777777", review: "#b45309", sending: "#1373d9", sent: "#238636", cancelled: "#777777"})) {
            MailServices.tags.addTagForKey(`scheduledsend-${status}`, context.extension.localeData.localizeMessage(`status_${status}`), color, "");
          }
          const id = `${ExtensionCommon.makeWidgetId(context.extension.id)}-composeAction-toolbarbutton`;
          ExtensionSupport.registerWindowListener(this.listenerId, {
            chromeURLs: [COMPOSE_URL],
            onLoadWindow: window => {
              mailbox.onCompose(window);
              const record = {};
              const position = () => {
                const send = window.document.getElementById("button-send");
                const button = window.document.getElementById(id);
                if (!send || !button?.isConnected || !send.parentNode?.contains(button)) return;
                record.button = button;
                record.parent = button.parentNode;
                record.next = button.nextSibling;
                send.after(button);
                record.observer?.disconnect();
              };
              record.observer = new window.MutationObserver(position);
              this.windows.set(window, record);
              record.observer.observe(window.document.documentElement, { childList: true, subtree: true });
              position();
            },
            onUnloadWindow: window => {
              this.windows.get(window)?.observer.disconnect();
              this.windows.delete(window);
              this.locked.delete(window);
            }
          });
        },
        isOnline: async () => !Services.io.offline,
        capture: async tabId => {
          const window = composeWindow(tabId);
          if (window.gWindowLocked || window.gSendOperationInProgress || window.gSaveOperationInProgress) throw new ExtensionError("errorComposeBusy");
          if (window.gSendEncrypted || window.gSendSigned || window.gAttachMyPublicPGPKey) throw new ExtensionError("errorEncryption");
          if (window.document.getElementById("blockedContentOptions")?.value) throw new ExtensionError("errorBlockedContent");
          if (!window.defaultController.isCommandEnabled("cmd_sendNow") && !window.defaultController.isCommandEnabled("cmd_sendLater")) throw new ExtensionError("errorRecipients");
          window.ToggleWindowLock(true);
          this.locked.add(window);
          try {
            const fields = window.GetComposeDetails();
            // Resolve mailing lists now, so a list edited later cannot silently
            // change the recipients of an already-authorized scheduled message.
            window.gMsgCompose.expandMailingLists();
            const native = {};
            for (const name of ["from", "to", "cc", "bcc", "replyTo", "followupTo", "newsgroups", "references", "fcc", "fcc2", "contentLanguage"]) {
              native[name] = fields[name] || "";
            }
            const recipients = [native.to, native.cc, native.bcc].filter(Boolean).join(",");
            const addresses = MailServices.headerParser.parseEncodedHeader(recipients, null);
            if (!addresses.length || addresses.some(address => !/^[^@\s]+@[^@\s]+$/.test(address.email))) throw new ExtensionError("errorRecipients");
            const body = window.IsHTMLEditor()
              ? await embedImages(window, window.GetCurrentEditor().outputToString("text/html", Ci.nsIDocumentEncoder.OutputRaw))
              : null;
            return { native, body };
          } catch (error) {
            this.locked.delete(window);
            window.ToggleWindowLock(false);
            throw error;
          }
        },
        release: async (tabId, close) => {
          const window = composeWindow(tabId);
          if (!this.locked.delete(window)) return;
          window.ToggleWindowLock(false);
          if (close) {
            // The server draft and local delivery journal are both committed.
            // Replace an existing/auto-saved ordinary draft, as Thunderbird does.
            if (window.gMsgCompose.compFields.draftId) window.RemoveDraft();
            window.gContentChanged = false;
            window.gMsgCompose.bodyModified = false;
            window.gReceiptOptionChanged = false;
            window.gDSNOptionChanged = false;
            window.close();
          }
        },
        deliver: async job => mailbox.deliver(job),
        stage: async (job, payload) => {
          if (job.owner !== mailbox.owner) throw new ExtensionError("errorAction");
          mailbox.folder(job.identityId);
          const draft = await stageMessage(payload, job);
          mailbox.watch({ ...job, draft });
          return draft;
        },
        hasDraft: async (job, refresh) => mailbox.has(job, refresh),
        watchDraft: async job => mailbox.watch(job),
        draftsFolder: async identityId => {
          const id = identityId || MailServices.accounts.defaultAccount?.defaultIdentity?.key;
          return context.extension.folderManager.convert(mailbox.folder(id));
        },
        queuedId: async messageId => {
          const header = context.extension.messageManager.get(messageId);
          return mailbox.jobForHeader(header)?.id || null;
        },
        updateDraft: async job => mailbox.update(job),
        removeDraft: async job => mailbox.remove(job),
        cancelDraft: async job => mailbox.cancel(job),
        editDraft: async job => {
          const current = await mailbox.read(job);
          if (!current) throw new ExtensionError("errorQueueRemoved");
          mailbox.editIntents.set(job.id, { ...job, status: job.previousStatus || job.status });
          MailServices.compose.OpenComposeWindow(null, current.header, current.header.folder.getUriForMsg(current.header),
            Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity(job.identityId), null, null);
        },
        removeLegacy: async id => {
          const root = MailServices.accounts.localFoldersServer?.rootFolder;
          const walk = folder => {
            for (const child of folder.subFolders) {
              if (child.getStringProperty("scheduledSendOwner") === context.extension.id) {
                const header = child.msgDatabase.getMsgHdrForMessageID(`scheduled-send-${id}@scheduled-send.local`);
                if (header) child.deleteMessages([header], null, true, false, null, false);
              }
              walk(child);
            }
          };
          if (root) walk(root);
        },
        onRestoreEdited: new ExtensionCommon.EventManager({
          context, name: "scheduleBridge.onRestoreEdited",
          register: fire => {
            mailbox.restoreEditor = details => fire.async(details);
            return () => { mailbox.restoreEditor = null; };
          }
        }).api(),
        onQueueChanged: new ExtensionCommon.EventManager({
          context, name: "scheduleBridge.onQueueChanged",
          register: fire => {
            const listener = ids => fire.async(ids);
            mailbox.listeners.add(listener);
            return () => mailbox.listeners.delete(listener);
          }
        }).api()
      }
    };
  }
  onShutdown() {
    this.mailbox?.stop();
    if (this.resourceAlias) this.resources.setSubstitution(this.resourceAlias, null);
    if (this.started) ExtensionSupport.unregisterWindowListener(this.listenerId);
    for (const [window, record] of this.windows || []) {
      record.observer.disconnect();
      if (!window.closed && record.button?.isConnected && record.parent?.isConnected) {
        record.parent.insertBefore(record.button, record.next?.parentNode === record.parent ? record.next : null);
      }
    }
    for (const window of this.locked || []) {
      if (!window.closed) window.ToggleWindowLock(false);
    }
    this.windows?.clear();
    this.locked?.clear();
  }
};
