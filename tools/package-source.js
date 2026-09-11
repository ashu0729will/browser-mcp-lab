// Zero-dependency reviewer source archive; validate everything before writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./lib/zip.js";
import { outputDir, sourceInputs } from "./lib/packaging.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const out = outputDir(root);
  const { base, entries } = sourceInputs(root);
  const archive = zip(entries);
  const name = `browser-session-mcp-source-${base.version}.zip`;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), archive);
  console.log(`${name}: ${archive.length} bytes, ${entries.length} files`);
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
