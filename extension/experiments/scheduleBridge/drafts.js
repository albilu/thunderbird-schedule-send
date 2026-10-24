/* Account Drafts integration. Only the originating profile owns delivery. */
var DraftMailbox = class {
  constructor(context) {
    this.context = context;
    this.jobs = new Map();
    this.editing = new Map();
    this.editIntents = new Map();
    this.taggedEditors = new Map();
    this.internalDeletes = new Set();
    this.listeners = new Set();
  }
  start(owner) {
    this.owner = owner;
    const ownedIds = headers => [...headers].map(h => this.jobForHeader(h))
      .filter(j => j && !this.internalDeletes.has(j.draft.messageId)).map(j => j.id);
    this.observer = {
      // An IMAP edit can replace a UID while preserving Message-ID. Refresh
      // before deciding whether the scheduled draft was actually removed.
      msgsDeleted: headers => {
        const ids = ownedIds(headers);
        if (ids.length) this.emit(Services.io.offline ? ids : []);
      },
      msgsMoveCopyCompleted: (move, headers) => {
        const ids = move ? ownedIds(headers) : [];
        if (ids.length) this.emit(ids);
      },
      folderDeleted: () => this.emit([])
    };
    MailServices.mfn.addListener(this.observer,
      MailServices.mfn.msgsDeleted | MailServices.mfn.msgsMoveCopyCompleted | MailServices.mfn.folderDeleted);
  }
  stop() {
    if (this.observer) MailServices.mfn.removeListener(this.observer);
    for (const editor of this.editing.values()) editor.dispose();
    for (const dispose of this.taggedEditors.values()) dispose();
    this.listeners.clear();
    this.editIntents.clear();
  }
  emit(ids) { for (const listener of this.listeners) listener(ids); }
  jobForHeader(header) {
    const job = header && this.jobs.get(header.messageId);
    return job?.draft.folderURI === header?.folder?.URI ? job : null;
  }
  watch(job) {
    if (job.owner !== this.owner || !job.draft) return;
    const previous = [...this.jobs.values()].find(j => j.id === job.id && j.draft.messageId !== job.draft.messageId);
    this.jobs.set(job.draft.messageId, job);
    if (!previous) return;
    // IMAP replaces a message when its schedule headers change. Keep the same
    // logical draft selected in any mail tab that was displaying the old copy.
    try {
      const header = this.header(job);
      for (const window of Services.wm.getEnumerator("mail:3pane")) {
        for (const tab of window.document.getElementById("tabmail").tabInfo) {
          const pane = tab.chromeBrowser?.contentWindow;
          const selected = pane?.gDBView?.getSelectedMsgHdrs();
          if (selected?.length !== 1 || this.jobForHeader(selected[0])?.id !== job.id || selected[0].messageId !== previous.draft.messageId) continue;
          const index = pane.gViewWrapper.getViewIndexForMsgHdr(header);
          if (index !== 0xffffffff) pane.threadTree.selectedIndices = [index];
        }
      }
    } catch (error) { console.error("Scheduled Send draft selection failed", error); }
  }
  folder(identityId, uri) {
    const identity = MailServices.accounts.getIdentity(identityId);
    if (!identity) throw new ExtensionError("errorIdentity");
    const configuredURI = uri || identity.draftsFolderURI;
    if (!configuredURI?.startsWith("imap:")) throw new ExtensionError("errorServerDrafts");
    const folder = MailUtils.getOrCreateFolder(configuredURI);
    if (!folder || folder.server.type !== "imap") throw new ExtensionError("errorServerDrafts");
    return folder;
  }
  header(job) {
    if (!job.draft || job.owner !== this.owner) return null;
    return this.folder(job.identityId, job.draft.folderURI).msgDatabase.getMsgHdrForMessageID(job.draft.messageId);
  }
  composeHeader(window) {
    const uri = window.gMsgCompose?.compFields.draftId?.replace(/\?.*/, "");
    if (!uri) return null;
    const native = Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);
    const header = native.msgHdrFromURI(uri);
    if (!header?.folder) throw new ExtensionError("errorStorage");
    if (!header.folder.getFlag(Ci.nsMsgFolderFlags.Drafts) && window.gMsgCompose.type !== Ci.nsIMsgCompType.Draft) return null;
    return header;
  }
  userKeywords(header) {
    return header.getStringProperty("keywords").split(/\s+/).filter(k => k && !k.startsWith("scheduledsend-")).join(" ");
  }
  preserveEditorTags(window, header) {
    if (!header || this.taggedEditors.has(window)) return;
    let keywords = this.userKeywords(header);
    let saving = false;
    // Native draft saves replace the IMAP message without copying its tags.
    // Remember user tags before each save and apply them to its replacement,
    // including automatic saves made before the user clicks Schedule.
    const remember = event => {
      const mode = Ci.nsIMsgCompDeliverMode;
      saving = [mode.SaveAsDraft, mode.AutoSaveAsDraft].includes(event.detail.msgType);
      if (!saving) return;
      try {
        const source = this.composeHeader(window);
        if (source) keywords = this.userKeywords(source);
      } catch (error) { console.error("Scheduled Send source tags unavailable", error); }
    };
    const listener = {
      NotifyComposeFieldsReady() {}, NotifyComposeBodyReady() {}, ComposeProcessDone() {},
      SaveInFolderDone: folderURI => {
        if (!saving) return;
        saving = false;
        if (!keywords) return;
        try {
          // draftId still points to the old message during this callback.
          // The completed native copy holds the new message's actual key.
          const folder = MailUtils.getExistingFolder(folderURI);
          const key = window.gMsgCompose.messageSend?.messageKey;
          if (!folder || key == null || key === 0xffffffff) throw new ExtensionError("errorStorage");
          folder.addKeywordsToMessages([folder.GetMessageHeader(key)], keywords);
        } catch (error) { console.error("Scheduled Send draft tag preservation failed", error); }
      }
    };
    const dispose = () => {
      window.removeEventListener("compose-send-message", remember);
      window.removeEventListener("unload", dispose);
      if (!window.closed) window.gMsgCompose?.UnregisterStateListener(listener);
      this.taggedEditors.delete(window);
    };
    this.taggedEditors.set(window, dispose);
    window.gMsgCompose.RegisterStateListener(listener);
    window.addEventListener("compose-send-message", remember);
    window.addEventListener("unload", dispose, { once: true });
  }
  async refresh(folder) {
    // Use a listener attached to this specific IMAP operation. The folder's
    // shared update listener can be replaced by Thunderbird's own UI refresh.
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new ExtensionError("errorOffline")), 20000);
        MailServices.imap.selectFolder(folder, {
          OnStartRunningUrl() {},
          OnStopRunningUrl(url, status) {
            if (Components.isSuccessCode(status)) resolve();
            else reject(new ExtensionError("errorOffline"));
          }
        }, null);
      });
    } finally { clearTimeout(timeout); }
  }
  async read(job, refresh = true, allowEditing = false) {
    if (job.owner !== this.owner || !job.draft || (!allowEditing && this.editing.has(job.id))) return null;
    const folder = this.folder(job.identityId, job.draft.folderURI);
    if (refresh) {
      if (Services.io.offline) throw new ExtensionError("errorOffline");
      await this.refresh(folder);
    }
    const header = this.header(job);
    if (!header || (header.flags & Ci.nsMsgMessageFlags.IMAPDeleted)) return null;
    const raw = await new MsgHdrProcessor(header).getOriginalMessage();
    const schedule = DraftMime.schedule(raw);
    if (schedule?.id !== job.id || schedule.owner !== this.owner) return null;
    return { header, raw, schedule };
  }
  async has(job, refresh) {
    this.watch(job);
    if (!job.draft || job.owner !== this.owner || this.editing.has(job.id)) return false;
    // Offline IMAP caches may be incomplete. Deletion events still cancel jobs.
    if (Services.io.offline) return true;
    return Boolean(await this.read(job, refresh));
  }
  async append(job, raw, messageId, token, keywords = "") {
    if (Services.io.offline) throw new ExtensionError("errorOffline");
    const folder = this.folder(job.identityId, job.draft?.folderURI);
    folder.setFlag(Ci.nsMsgFolderFlags.Drafts);
    await this.refresh(folder);
    // A deterministic initial Message-ID makes an interrupted migration retryable.
    if (folder.msgDatabase.getMsgHdrForMessageID(messageId)) {
      return { folderURI: folder.URI, messageId, token };
    }
    const path = PathUtils.join(PathUtils.tempDir, `scheduled-draft-${Services.uuid.generateUUID()}.eml`);
    await IOUtils.write(path, Uint8Array.from(raw, c => c.charCodeAt(0) & 255), { permissions: 0o600 });
    const added = Promise.withResolvers();
    const observer = { msgAdded(header) {
      if (header.folder.URI === folder.URI && header.messageId === messageId) added.resolve();
    } };
    MailServices.mfn.addListener(observer, MailServices.mfn.msgAdded);
    let timeout;
    try {
      await new Promise((resolve, reject) => MailServices.copy.copyFileMessage(fileAt(path), folder, null, true,
        Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Draft,
        [keywords, token ? `scheduledsend-${job.status}` : ""].filter(Boolean).join(" "), {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
          onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() { return ""; },
          onStopCopy(status) {
            if (Components.isSuccessCode(status)) resolve();
            else reject(new ExtensionError("errorStorage"));
          }
        }, null));
      await this.refresh(folder);
      if (!folder.msgDatabase.getMsgHdrForMessageID(messageId)) {
        await Promise.race([added.promise, new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new ExtensionError("errorStorage")), 15000);
        })]);
      }
      return { folderURI: folder.URI, messageId, token };
    } finally {
      MailServices.mfn.removeListener(observer);
      if (timeout) clearTimeout(timeout);
      await IOUtils.remove(path).catch(console.error);
    }
  }
  async remove(job) {
    const header = this.header(job);
    if (header) await this.removeHeader(header);
    this.jobs.delete(job.draft.messageId);
  }
  async removeHeader(header) {
    this.internalDeletes.add(header.messageId);
    try {
      await new Promise((resolve, reject) => header.folder.deleteMessages([header], null, true, false, {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
        onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() { return ""; },
        onStopCopy(status) {
          if (Components.isSuccessCode(status)) resolve();
          else reject(new ExtensionError("errorStorage"));
        }
      }, false));
    } finally { this.internalDeletes.delete(header.messageId); }
  }
  highlight(job) {
    const header = this.header(job);
    if (!header) return;
    const key = `scheduledsend-${job.status}`;
    const old = header.getStringProperty("keywords").split(" ").filter(k => k.startsWith("scheduledsend-") && k !== key);
    if (old.length) header.folder.removeKeywordsFromMessages([header], old.join(" "));
    if (!header.getStringProperty("keywords").split(" ").includes(key)) header.folder.addKeywordsToMessages([header], key);
  }
  async update(job) {
    this.watch(job);
    this.highlight(job);
    if (job.status === "sending" || job.draft.token === DraftMime.token(job) || Services.io.offline) return null;
    const current = await this.read(job);
    if (!current) return null;
    const messageId = `scheduled-send-${Services.uuid.generateUUID().toString().slice(1, -1)}@scheduled-send.invalid`;
    const raw = DraftMime.rewrite(current.raw, { job, messageId, date: job.nextAt || Date.now() });
    return this.append(job, raw, messageId, DraftMime.token(job), this.userKeywords(current.header));
  }
  onCompose(window) {
    const detect = () => {
      try {
        const header = this.composeHeader(window);
        this.preserveEditorTags(window, header);
        const job = this.jobForHeader(header);
        if (!job || !["pending", "paused", "review"].includes(job.status) || this.editing.has(job.id)) return;
        const previous = this.editIntents.get(job.id) || job;
        this.editIntents.delete(job.id);
        this.editing.set(job.id, new DraftEditor(this, window, previous));
        // Immediately block delivery; the background commits the cancellation.
        this.emit([job.id]);
      } catch (error) { console.error("Scheduled Send draft editing detection failed", error); }
    };
    window.addEventListener("compose-editor-ready", detect, { once: true });
    if (window.composeEditorReady) detect();
  }
  async cancel(job) {
    const editor = this.editing.get(job.id);
    if (editor && !editor.window.closed) {
      this.internalDeletes.add(job.draft.messageId);
      try {
        await editor.saveOrdinary();
        if (!Services.io.offline) {
          await this.refresh(this.folder(job.identityId, job.draft.folderURI));
          await this.remove(job);
        }
        this.jobs.delete(job.draft.messageId);
        this.internalDeletes.delete(job.draft.messageId);
      } finally { editor.initialized.resolve(); }
      return;
    }
    const current = await this.read(job, true, true);
    if (!current) return;
    const messageId = `draft-${Services.uuid.generateUUID().toString().slice(1, -1)}@scheduled-send.invalid`;
    await this.append(job, DraftMime.rewrite(current.raw, { messageId, date: Date.now() }), messageId, null, this.userKeywords(current.header));
    await this.remove(job);
  }
  async deliver(job) {
    const current = await this.read(job);
    if (!current) throw new ExtensionError("errorQueueRemoved");
    if (/encrypted|multipart\/signed|pkcs7/i.test(DraftMime.get(current.raw, "content-type"))) throw new ExtensionError("errorEncryption");
    const identity = MailServices.accounts.getIdentity(job.identityId);
    const account = [...MailServices.accounts.accounts].find(a => [...a.identities].some(i => i.key === job.identityId));
    if (!identity || !account) throw new ExtensionError("errorIdentity");
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    for (const name of ["from", "to", "cc", "bcc", "reply-to", "references", "subject"]) {
      const value = DraftMime.get(current.raw, name);
      if (value) fields.setRawHeader(name, value);
    }
    if (!fields.to && !fields.cc && !fields.bcc) throw new ExtensionError("errorRecipients");
    if (DraftMime.get(current.raw, "newsgroups")) throw new ExtensionError("errorNewsgroups");
    fields.fcc = DraftMime.get(current.raw, "fcc") || identity.fccFolderURI;
    fields.DSN = /(?:^|;)\s*DSN=1(?:;|$)/i.test(DraftMime.get(current.raw, "x-mozilla-draft-info"));
    const messageId = Cc["@mozilla.org/messengercompose/computils;1"].createInstance(Ci.nsIMsgCompUtils)
      .msgGenerateMessageId(identity, identity.email.split("@")[1]);
    fields.messageId = messageId;
    const raw = DraftMime.rewrite(current.raw, { messageId: messageId.replace(/^<|>$/g, ""), date: Date.now(), delivery: true });
    const path = PathUtils.join(PathUtils.tempDir, `scheduled-delivery-${Services.uuid.generateUUID()}.eml`);
    await IOUtils.write(path, Uint8Array.from(raw, c => c.charCodeAt(0) & 255), { permissions: 0o600 });
    let accepted = false;
    try {
      if (Services.io.offline) throw new ExtensionError("errorOffline");
      if (this.editing.has(job.id) || !this.header(job)) throw new ExtensionError("errorQueueRemoved");
      await new MessageSend().sendMessageFile(identity, account.key, fields, fileAt(path), false, false,
        Ci.nsIMsgSend.nsMsgDeliverNow, null, {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener", "nsIMsgCopyServiceListener"]),
          onStartSending() {}, onProgress() {}, onStatus() {}, onGetDraftFolderURI() {},
          onSendNotPerformed() {}, onTransportSecurityError() {}, onStartCopy() {}, onStopCopy() {}, setMessageKey() {},
          getMessageId() { return messageId; },
          onStopSending(id, status) { if (Components.isSuccessCode(status)) accepted = true; }
        }, null);
      return { messageId };
    } catch (error) {
      if (accepted) return { messageId, warning: "errorSentCopy" };
      throw error;
    } finally { await IOUtils.remove(path).catch(console.error); }
  }
};
