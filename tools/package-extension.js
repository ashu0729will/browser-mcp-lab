// Validate both browser variants before creating any output archive.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./lib/zip.js";
import { outputDir, extensionInputs, browserManifest } from "./lib/packaging.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const out = outputDir(root);
  const { base, entries } = extensionInputs(root);
  const results = ["firefox", "chrome"].map(target => {
    const manifest = browserManifest(base, target);
    return {
      name: `browser-session-mcp-${target}-${base.version}.zip`,
      data: zip(entries.map(entry => entry.name === "manifest.json"
        ? { name: entry.name, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) } : entry)),
    };
  });
  fs.mkdirSync(out, { recursive: true });
  for (const result of results) {
    fs.writeFileSync(path.join(out, result.name), result.data);
    console.log(`${result.name}: ${result.data.length} bytes`);
  }
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
