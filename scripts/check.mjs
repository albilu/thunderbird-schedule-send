import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
const paths = await files(resolve(root, "extension"));
const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const en = await json("extension/_locales/en/messages.json");
const fr = await json("extension/_locales/fr/messages.json");
assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort(), "Both locales must have identical keys");
for (const [key, entry] of Object.entries(en)) {
  assert(entry.message.length && fr[key].message.length, `Empty translation: ${key}`);
  assert.deepEqual(entry.message.match(/\$\d/g), fr[key].message.match(/\$\d/g), `Substitutions differ: ${key}`);
}
for (const path of paths) {
  const source = await readFile(path, "utf8");
  if (/\.(?:mjs|js)$/.test(path)) execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
  if (path.endsWith(".json")) JSON.parse(source);
  if (path.includes("/_locales/")) continue;
  for (const match of source.matchAll(/(?:data-i18n(?:-title)?="|\bt\(")([A-Za-z][A-Za-z0-9_]*)(?:"|__)/g)) {
    assert(en[match[1]], `Missing translation ${match[1]} in ${path}`);
  }
  for (const match of source.matchAll(/["'](error[A-Z][A-Za-z]+)["']/g)) assert(en[match[1]], `Missing error translation ${match[1]}`);
}
const manifest = await json("extension/manifest.json");
const pkg = await json("package.json");
assert.equal(manifest.version, pkg.version);
for (const value of [manifest.background.page, manifest.compose_action.default_popup, manifest.options_ui.page,
  ...Object.values(manifest.icons), manifest.experiment_apis.scheduleBridge.schema, manifest.experiment_apis.scheduleBridge.parent.script]) {
  assert(paths.includes(resolve(root, "extension", value)), `Missing packaged file: ${value}`);
}
console.log(`Checked ${paths.length} extension files; ${Object.keys(en).length} matching English/French translations; JavaScript syntax and manifest valid.`);
