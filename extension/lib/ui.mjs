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
  const apply = theme => {
    const colors = theme?.colors || {};
    const mapping = { "--surface": "popup", "--text": "popup_text", "--border": "popup_border",
      "--accent": "button_background_active", "--accent-text": "button_text_active" };
    for (const [property, key] of Object.entries(mapping)) {
      if (colors[key]) document.documentElement.style.setProperty(property, colors[key]);
      else document.documentElement.style.removeProperty(property);
    }
    const scheme = theme?.properties?.color_scheme;
    if (scheme === "dark" || scheme === "light") document.documentElement.style.colorScheme = scheme;
    else if (colors.popup) {
      const probe = el("span", { style: `color: ${colors.popup}` });
      document.body.append(probe);
      const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number);
      probe.remove();
      if (channels?.length >= 3) document.documentElement.style.colorScheme = (channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < 128) ? "dark" : "light";
    } else document.documentElement.style.removeProperty("color-scheme");
  };
  try { apply(await messenger.theme.getCurrent()); } catch { /* System colors remain usable. */ }
  messenger.theme.onUpdated.addListener(info => apply(info.theme));
}
