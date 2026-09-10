// Builds the source archive AMO asks for when a submission is produced with a
// build/generation tool: the add-on source plus the tooling and the build
// instructions, so a reviewer can rebuild the submitted package byte for byte.
//
//   node tools/package-source.js [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { zip } from "./lib/zip.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only what is needed to rebuild the add-on. The companion MCP server is a
// separate program: it lives in the repository but is not part of the add-on.
const INCLUDE_DIRS = ["browser-extension", "tools"];
const INCLUDE_FILES = ["BUILD.md", "CONTRIBUTING.md", "README.md", "LICENSE", "package.json"];
const SKIP = /(^|\/)(node_modules|dist|\.git|screenshots|\.zcode)(\/|$)/;

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (SKIP.test(rel)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else out.push({ name: rel, file: abs });
  }
  return out;
}

const outIndex = process.argv.indexOf("--out");
const OUT = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(ROOT, "dist");
fs.mkdirSync(OUT, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const listed = [];
for (const dir of INCLUDE_DIRS) listed.push(...walk(path.join(ROOT, dir), dir));
for (const file of INCLUDE_FILES) {
  if (fs.existsSync(path.join(ROOT, file))) listed.push({ name: file, file: path.join(ROOT, file) });
}

const entries = listed
  .filter((entry) => !SKIP.test(entry.name))
  .map((entry) => ({ name: entry.name, data: fs.readFileSync(entry.file) }));

const archive = zip(entries);
const target = path.join(OUT, `browser-session-mcp-source-${version}.zip`);
fs.writeFileSync(target, archive);

const sha = crypto.createHash("sha256").update(archive).digest("hex");
console.log(`source archive  ${target}`);
console.log(`size            ${archive.length} bytes (${(archive.length / 1024).toFixed(1)} KB)`);
console.log(`sha256          ${sha}`);
console.log(`files           ${entries.length}`);
for (const entry of entries) console.log(`  ${entry.name}`);
console.log(
  "\nReviewers rebuild the add-on with:  node tools/package-extension.js --out dist\n" +
    "That reads browser-extension/ and writes the Firefox and Chromium archives,",
);
