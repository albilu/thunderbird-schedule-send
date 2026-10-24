/* Resolve colors in the owning Thunderbird window, where its theme CSS lives. */
var NativeTheme = class {
  constructor(context) {
    this.context = context;
    this.windows = new Map();
    this.listeners = new Set();
    this.changed = () => { for (const record of this.windows.values()) record.refresh(); };
    Services.obs.addObserver(this.changed, "look-and-feel-changed");
    Services.prefs.addObserver("mail.appearance.", this.changed);
  }
  read(window) {
    const root = window.document.documentElement;
    const probe = window.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;";
    root.append(probe);
    try {
      const resolve = value => {
        probe.style.backgroundColor = value;
        return window.getComputedStyle(probe).backgroundColor;
      };
      return {
        // Popup and field variables were renamed after Thunderbird 128.
        surface: resolve("var(--panel-background-color, var(--arrowpanel-background, var(--color-surface-subtle, Canvas)))"),
        text: resolve("var(--panel-text-color, var(--arrowpanel-color, var(--color-text-base, CanvasText)))"),
        border: resolve("var(--panel-border-color, var(--arrowpanel-border-color, var(--color-surface-border-intense, ButtonBorder)))"),
        field: resolve("var(--toolbar-field-background-color, Field)"),
        "field-text": resolve("var(--toolbar-field-text-color, var(--toolbar-field-color, FieldText))"),
        "field-border": resolve("var(--toolbar-field-border-color, var(--button-border-color, ButtonBorder))"),
        "field-focus": resolve("var(--toolbar-field-background-color-focus, var(--toolbar-field-focus-background-color, var(--toolbar-field-background-color, Field)))"),
        "field-focus-text": resolve("var(--toolbar-field-text-color-focus, var(--toolbar-field-focus-color, var(--toolbar-field-text-color, var(--toolbar-field-color, FieldText))))"),
        "field-focus-border": resolve("var(--toolbar-field-border-color-focus, var(--toolbar-field-focus-border-color, Highlight))"),
        button: resolve("var(--button-background-color, ButtonFace)"),
        "button-text": resolve("var(--button-text-color, ButtonText)"),
        "button-border": resolve("var(--button-border-color, ButtonBorder)"),
        "button-hover": resolve("var(--button-hover-background-color, ButtonFace)"),
        "button-active": resolve("var(--button-active-background-color, ButtonFace)"),
        accent: resolve("var(--button-primary-background-color, var(--selected-item-color, AccentColor))"),
        "accent-text": resolve("var(--button-primary-text-color, var(--selected-item-text-color, AccentColorText))"),
        "accent-hover": resolve("var(--button-primary-hover-background-color, AccentColor)"),
        "accent-active": resolve("var(--button-primary-active-background-color, AccentColor)"),
        focus: resolve("var(--focus-outline-color, var(--selected-item-color, Highlight))"),
        danger: resolve("light-dark(var(--color-red-70, #b3261e), var(--color-red-30, #ff9a91))"),
        scheme: resolve("light-dark(black, white)") === "rgb(255, 255, 255)" ? "dark" : "light"
      };
    } finally { probe.remove(); }
  }
  get(windowId) {
    const window = this.context.extension.windowManager.get(windowId).window;
    if (!this.windows.has(windowId)) {
      const record = { window };
      record.refresh = () => {
        window.clearTimeout(record.timer);
        record.timer = window.setTimeout(() => {
          if (window.closed || !this.windows.has(windowId)) return;
          const theme = this.read(window);
          const signature = JSON.stringify(theme);
          if (signature === record.signature) return;
          record.signature = signature;
          for (const fire of this.listeners) fire.async(windowId, theme);
        }, 0);
      };
      record.observer = new window.MutationObserver(record.refresh);
      record.observer.observe(window.document.documentElement, { attributes: true });
      record.media = ["(prefers-color-scheme: dark)", "(forced-colors: active)", "(prefers-contrast: more)"]
        .map(query => window.matchMedia(query));
      for (const media of record.media) media.addEventListener("change", record.refresh);
      record.unload = () => this.remove(windowId);
      window.addEventListener("unload", record.unload, { once: true });
      this.windows.set(windowId, record);
    }
    const theme = this.read(window);
    this.windows.get(windowId).signature ??= JSON.stringify(theme);
    return theme;
  }
  remove(windowId) {
    const record = this.windows.get(windowId);
    if (!record) return;
    record.observer.disconnect();
    record.window.clearTimeout(record.timer);
    record.window.removeEventListener("unload", record.unload);
    for (const media of record.media) media.removeEventListener("change", record.refresh);
    this.windows.delete(windowId);
  }
  stop() {
    Services.obs.removeObserver(this.changed, "look-and-feel-changed");
    Services.prefs.removeObserver("mail.appearance.", this.changed);
    for (const id of this.windows.keys()) this.remove(id);
    this.listeners.clear();
  }
};
