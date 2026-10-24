/* Keep the previous schedule available while an ordinary draft is edited. */
var DraftEditor = class {
  constructor(mailbox, window, previous) {
    Object.assign(this, { mailbox, window, previous });
    this.initialized = Promise.withResolvers();
    this.save = window.SaveAsDraft;
    this.canClose = window.ComposeCanClose;
    this.onClose = () => this.dispose();
    this.onSend = event => {
      const mode = Ci.nsIMsgCompDeliverMode;
      if ([mode.Now, mode.Later, mode.Background].includes(event.detail.msgType)) this.dispose();
    };
    this.saveWrapper = () => this.finish();
    this.closeWrapper = () => {
      if (window.gSendOperationInProgress || window.gSaveOperationInProgress) return this.canClose.call(window);
      void this.finish();
      return false;
    };
    window.SaveAsDraft = this.saveWrapper;
    window.ComposeCanClose = this.closeWrapper;
    window.addEventListener("unload", this.onClose, { once: true });
    window.addEventListener("compose-send-message", this.onSend);
  }
  t(key, values) { return this.mailbox.context.extension.localeData.localizeMessage(key, values); }
  dispose() {
    const { window } = this;
    this.disposed = true;
    if (!window.closed) {
      if (window.SaveAsDraft === this.saveWrapper) window.SaveAsDraft = this.save;
      if (window.ComposeCanClose === this.closeWrapper) window.ComposeCanClose = this.canClose;
      window.removeEventListener("unload", this.onClose);
      window.removeEventListener("compose-send-message", this.onSend);
    }
    this.mailbox.editing.delete(this.previous.id);
  }
  async saveOrdinary() {
    const { window } = this;
    for (const name of window.gMsgCompose.compFields.headerNames) {
      if (/^x-scheduled-send(?:-|$)/i.test(name)) window.gMsgCompose.compFields.deleteHeader(name);
    }
    const saved = Promise.withResolvers();
    const listener = {
      NotifyComposeFieldsReady() {}, NotifyComposeBodyReady() {},
      ComposeProcessDone(status) { if (!Components.isSuccessCode(status)) saved.reject(new ExtensionError("errorStorage")); },
      SaveInFolderDone() { saved.resolve(); }
    };
    window.gMsgCompose.RegisterStateListener(listener);
    const timeout = setTimeout(() => saved.reject(new ExtensionError("errorStorage")), 20000);
    try { await Promise.all([this.save.call(window), saved.promise]); }
    finally {
      clearTimeout(timeout);
      if (!window.closed) window.gMsgCompose.UnregisterStateListener(listener);
    }
  }
  async finish() {
    if (this.finishing || this.disposed) return;
    this.finishing = true;
    const { window, previous } = this;
    try {
      await this.initialized.promise;
      if (this.disposed || window.closed) return;
      const when = new Intl.DateTimeFormat(Services.locale.appLocaleAsBCP47, {
        dateStyle: "medium", timeStyle: "short", timeZone: previous.rule.timeZone
      }).format(new Date(previous.nextAt));
      let description = this.t("keepScheduleDescription", [when]);
      if (previous.nextAt <= Date.now()) description += "\n\n" + this.t("keepScheduleLate");
      if (previous.status !== "pending") description += "\n\n" + this.t("keepScheduleState", [this.t(`status_${previous.status}`)]);
      const prompt = Services.prompt;
      const choice = prompt.confirmEx(window, this.t("keepScheduleTitle"), description,
        prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 + prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_1
          + prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_2,
        this.t("saveKeepSchedule"), this.t("continueEditing"), this.t("saveWithoutSchedule"), null, {});
      if (choice === 0) {
        const tabId = this.mailbox.context.extension.tabManager.convert(window).id;
        const result = await this.mailbox.restoreEditor?.({ tabId, previous });
        if (!result?.ok) throw new ExtensionError(result?.error || "errorDisconnected");
      } else if (choice === 2) {
        await this.saveOrdinary();
        this.dispose();
        window.gContentChanged = false;
        window.gMsgCompose.bodyModified = false;
        window.gReceiptOptionChanged = false;
        window.gDSNOptionChanged = false;
        window.close();
      }
    } catch (error) {
      console.error("Scheduled Send draft finish failed", error);
      if (!window.closed) {
        const code = /\berror[A-Z]\w+/.exec(error.message)?.[0] || "errorUnexpected";
        Services.prompt.alert(window, this.t("keepScheduleTitle"), this.t(code));
      }
    } finally { this.finishing = false; }
  }
};
