export const t = (key, values) => messenger.i18n.getMessage(key, values) || key;
export const language = () => messenger.i18n.getUILanguage();
export const errorText = error => {
  const value = error.code || error.message || String(error);
  return /^error[A-Z]\w+$/.test(value) ? t(value) : value;
};

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "className") node.className = value;
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}

export function localize(root = document) {
  document.documentElement.lang = language();
  for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
}

export const formatDate = (timestamp, timeZone) => new Intl.DateTimeFormat(language(), {
  dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {})
}).format(new Date(timestamp));

export function recurrenceText(rule) {
  if (rule.recurrence.interval === 1 && rule.recurrence.unit !== "none") {
    return t(rule.recurrence.unit === "minutes" ? "everyMinute" : `unit_${rule.recurrence.unit}`);
  }
  return t(`repeat_${rule.recurrence.unit}`, String(rule.recurrence.interval));
}

export async function request(message) {
  const response = await messenger.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(t(response?.error || "errorUnexpected"));
  return response;
}

export async function applyTheme() {
  const names = ["surface", "text", "border", "field", "field-text", "field-border", "field-focus", "field-focus-text", "field-focus-border", "button", "button-text",
    "button-border", "button-hover", "button-active", "accent", "accent-text", "accent-hover", "accent-active", "focus", "danger"];
  const root = document.documentElement;
  let windowId;
  try { windowId = (await messenger.windows.getCurrent()).id; }
  catch { return; } // Native system colors remain usable if the host is closing.
  let revision = 0;
  const apply = theme => {
    for (const name of names) {
      const color = theme?.[name];
      if (typeof color === "string" && CSS.supports("color", color)) root.style.setProperty(`--${name}`, color);
      else root.style.removeProperty(`--${name}`);
    }
    if (["light", "dark"].includes(theme?.scheme)) root.style.colorScheme = theme.scheme;
    else root.style.removeProperty("color-scheme");
  };
  const refresh = async () => {
    const requested = ++revision;
    try {
      const theme = await messenger.scheduleBridge.getTheme(windowId);
      if (requested === revision) apply(theme);
    } catch { /* System colors remain usable while a window closes. */ }
  };
  const changed = (id, theme) => { if (id === windowId) { revision++; apply(theme); } };
  const updated = info => { if (info.windowId === undefined || info.windowId === windowId) void refresh(); };
  messenger.scheduleBridge.onThemeChanged.addListener(changed);
  messenger.theme.onUpdated.addListener(updated);
  // Thunderbird removes API listeners with the extension page's context.
  window.addEventListener("unload", () => { revision++; }, { once: true });
  await refresh();
}
