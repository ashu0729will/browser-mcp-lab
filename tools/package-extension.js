// Packages browser-extension/ into store-ready zips (zero dependencies).
//
//   node tools/package-extension.js [--out <dir>]
//
// Two archives are produced from the same source tree:
//   - firefox: keeps background.scripts (event page) and adds the gecko
//     data_collection_permissions key AMO now requires; drops service_worker,
//     which Firefox ignores.
//   - chrome : keeps background.service_worker and drops the Firefox-only
//     browser_specific_settings / background.scripts keys.
// The zip writer is deterministic (sorted entries, fixed timestamps) so repeated
// runs on identical sources produce identical bytes.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "browser-extension");

// --- minimal deterministic zip writer --------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Fixed timestamp: 2026-01-01 00:00:00, so archives stay reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

// --- source collection ------------------------------------------------------
const FORBIDDEN = /(^|\/)(chrome-extension-id\.txt|.*\.log|.*\.zip|screenshots)$/;

function collect(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...collect(path.join(dir, entry.name), rel));
    else files.push({ name: rel, file: path.join(dir, entry.name) });
  }
  return files;
}

// --- store-specific manifest ------------------------------------------------
function buildManifest(base, target) {
  const manifest = JSON.parse(JSON.stringify(base));
  if (target === "firefox") {
    delete manifest.background.service_worker;
    if (!manifest.background.scripts?.length) throw new Error("firefox build needs background.scripts");
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id) throw new Error("firefox build needs a gecko id");
    // AMO requires an explicit data-collection declaration; this extension sends
    // nothing anywhere (loopback only).
    gecko.data_collection_permissions = { required: ["none"] };
  } else {
    delete manifest.browser_specific_settings;
    delete manifest.background.scripts;
    if (!manifest.background.service_worker) throw new Error("chrome build needs background.service_worker");
  }
  return manifest;
}

// --- verification -----------------------------------------------------------
const REQUIRED = [
  "manifest.json",
  "service-worker.js",
  "popup.html",
  "popup.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function verify(files, manifest) {
  const problems = [];
  const names = new Set(files.map((f) => f.name));
  for (const required of REQUIRED) if (!names.has(required)) problems.push(`missing ${required}`);
  for (const name of names) if (FORBIDDEN.test(name)) problems.push(`should not ship ${name}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    problems.push(`version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
  }
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");

  for (const [key, expected] of [["16", 16], ["48", 48], ["128", 128]]) {
    const entry = files.find((f) => f.name === `icons/icon${key}.png`);
    if (!entry) continue;
    const { width, height } = pngSize(fs.readFileSync(path.join(SOURCE, entry.name)));
    if (width !== expected || height !== expected) {
      problems.push(`icon${key}.png is ${width}x${height}, expected ${expected}x${expected}`);
    }
  }
  return problems;
}

// --- run --------------------------------------------------------------------
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(ROOT, "dist");
fs.mkdirSync(OUT, { recursive: true });

const baseManifest = JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
const sourceFiles = collect(SOURCE);
const version = baseManifest.version;

let failed = false;
const results = [];

for (const target of ["firefox", "chrome"]) {
  const manifest = buildManifest(baseManifest, target);
  const entries = sourceFiles.map((entry) =>
    entry.name === "manifest.json"
      ? { name: entry.name, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") }
      : { name: entry.name, data: fs.readFileSync(entry.file) },
  );

  const problems = verify(
    entries.map((e) => ({ name: e.name })),
    manifest,
  );
  const archive = zip(entries);
  const file = path.join(OUT, `browser-session-mcp-${target}-${version}.zip`);
  fs.writeFileSync(file, archive);

  const sha = crypto.createHash("sha256").update(archive).digest("hex").slice(0, 16);
  results.push({ target, file, archive, manifest, problems, sha });
  if (problems.length) failed = true;
}

for (const result of results) {
  const { target, file, archive, manifest, problems, sha } = result;
  const kb = (archive.length / 1024).toFixed(1);
  console.log(`\n=== ${target} ===`);
  console.log(`sha256      ${sha}…`);
  console.log(`file        ${file}`);
  console.log(`size        ${archive.length} bytes (${kb} KB)`);
  console.log(`version     ${manifest.version}   background: ${JSON.stringify(manifest.background)}`);
  console.log(
    `gecko       ${manifest.browser_specific_settings?.gecko ? `${manifest.browser_specific_settings.gecko.id}, data_collection=${JSON.stringify(manifest.browser_specific_settings.gecko.data_collection_permissions)}` : "(none — Chromium build)"}`,
  );
  console.log(`csp         ${manifest.content_security_policy.extension_pages}`);
  console.log(`permissions ${manifest.permissions.join(", ")}  host=${manifest.host_permissions.join(",")}`);
  const names = collect(SOURCE).map((f) => f.name);
  console.log(`contents    ${names.length} files: ${names.join(", ")}`);
  if (problems.length) {
    console.log(`PROBLEMS    ${problems.join("; ")}`);
  } else {
    console.log("checks      required files present, icon sizes ok, version matches package.json");
  }
}

console.log(failed ? "\nFAILED: fix the problems above" : "\nBoth packages built.");
process.exit(failed ? 1 : 0);
