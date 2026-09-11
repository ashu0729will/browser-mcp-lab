import fs from "node:fs";
import path from "node:path";

export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function outputDir(root, args = process.argv.slice(2)) {
  if (!args.length) return path.join(root, "dist");
  if (args.length !== 2 || args[0] !== "--out" || !args[1].trim() || args[1].startsWith("--")) {
    throw new Error("Usage: --out <directory> (directory is required when --out is supplied)");
  }
  return path.resolve(args[1]);
}

const forbidden = /(^|\/)(?:.*\.(?:log|zip|pem|key|p12|pfx)|chrome-extension-id\.txt|.*host.*manifest.*\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|node_modules|dist|screenshots)$/i;

// Check every component: neither file nor parent directory may be a symlink.
export function readSafe(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes(":") || name.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".")) || /[*?]/.test(name)) {
    throw new Error(`Unsafe or non-explicit package path: ${name}`);
  }
  if (forbidden.test(name)) throw new Error(`Forbidden package path: ${name}`);
  let current = root;
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink forbidden: ${current}`);
  const parts = name.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Not a regular package path: ${name}`);
  }
  const data = fs.readFileSync(current);
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}/.test(data.toString("utf8"))) throw new Error(`Secret material forbidden: ${name}`);
  return data;
}

export function extensionInputs(root) {
  const source = path.join(root, "browser-extension");
  const base = JSON.parse(readSafe(root, "browser-extension/manifest.json"));
  const pkg = JSON.parse(readSafe(root, "package.json"));
  if (base.version !== pkg.version) throw new Error(`version mismatch: manifest ${base.version} vs package.json ${pkg.version}`);
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(base.version)) throw new Error("Invalid extension version");
  if (base.manifest_version !== 3) throw new Error("manifest_version must be 3");
  const names = new Set(["manifest.json", "service-worker.js", "popup.html", "popup.js", "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]);
  const add = value => { if (value) names.add(value); };
  const icons = value => { if (typeof value === "string") add(value); else Object.values(value || {}).forEach(add); };
  add(base.background?.service_worker);
  (base.background?.scripts || []).forEach(add);
  add(base.background?.page);
  icons(base.icons);
  for (const key of ["action", "browser_action", "page_action", "sidebar_action"]) {
    add(base[key]?.default_popup); add(base[key]?.default_panel); icons(base[key]?.default_icon);
  }
  add(base.options_page); add(base.options_ui?.page); add(base.devtools_page);
  Object.values(base.chrome_url_overrides || {}).forEach(add);
  for (const script of base.content_scripts || []) [...(script.js || []), ...(script.css || [])].forEach(add);
  for (const resource of base.web_accessible_resources || []) (resource.resources || []).forEach(add);
  const extra = pkg.browserSessionPackaging?.extensionFiles || [];
  if (!Array.isArray(extra) || extra.some(v => typeof v !== "string")) throw new Error("browserSessionPackaging.extensionFiles must be an array of explicit paths");
  extra.forEach(add);
  const entries = [...names].sort(compare).map(name => ({ name, data: readSafe(source, name) }));
  for (const size of [16, 48, 128]) {
    const data = entries.find(e => e.name === `icons/icon${size}.png`).data;
    if (data.length < 24 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size) throw new Error(`Invalid icon${size}.png dimensions or signature`);
  }
  return { base, entries };
}

export function browserManifest(base, target) {
  const manifest = structuredClone(base);
  if (target === "firefox") {
    if (!manifest.background?.scripts?.length) throw new Error("firefox build needs background.scripts");
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id) throw new Error("firefox build needs a gecko id");
    if (!gecko.data_collection_permissions || typeof gecko.data_collection_permissions !== "object" || Array.isArray(gecko.data_collection_permissions)) throw new Error("Configure browser_specific_settings.gecko.data_collection_permissions in the source manifest before building Firefox");
    delete manifest.background.service_worker;
  } else {
    if (!manifest.background?.service_worker) throw new Error("chrome build needs background.service_worker");
    delete manifest.background.scripts;
    delete manifest.browser_specific_settings;
  }
  return manifest;
}

// Explicit extension inputs plus all build tooling; never walk the repository.
export function sourceInputs(root) {
  const { base, entries } = extensionInputs(root);
  browserManifest(base, "firefox");
  browserManifest(base, "chrome");
  const names = entries.map(entry => `browser-extension/${entry.name}`);
  const walk = dir => {
    if (fs.lstatSync(path.join(root, dir)).isSymbolicLink()) throw new Error(`Symlink forbidden: ${dir}`);
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden: ${name}`);
      if (entry.name.startsWith(".") || /^(?:node_modules|dist|screenshots)$/.test(entry.name) || /(?:\.log|\.zip|chrome-extension-id\.txt|host.*manifest.*\.json)$/i.test(entry.name)) continue;
      if (entry.isDirectory()) walk(name);
      else names.push(name);
    }
  };
  walk("tools");
  names.push("package.json", "BUILD.md", "LICENSE");
  for (const name of ["package-lock.json", "PRIVACY.md", "README.md", "CONTRIBUTING.md"]) {
    if (fs.existsSync(path.join(root, name))) names.push(name);
  }
  return { base, entries: names.sort(compare).map(name => ({ name, data: readSafe(root, name) })) };
}
