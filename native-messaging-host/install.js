// Registers the Browser Session MCP native messaging host (per-user, no admin).
// Writes machine-local Firefox/Chromium manifests and migrates legacy registry keys.
// Run: node native-messaging-host/install.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("This installer currently supports Windows only.");
  process.exit(1);
}

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GECKO_ID = "browser-session-mcp@ashu0729will.local";
const HOST_NAME = "browser_session_mcp";
const LEGACY_HOST_NAME = "browser_mcp_lab";
const BAT = path.join(HOST_DIR, "bridge.bat");
const CHROME_ID_FILE = path.join(HOST_DIR, "chrome-extension-id.txt");
const ffManifest = path.join(HOST_DIR, "browser_session_mcp.firefox.json");
const chromeManifest = path.join(HOST_DIR, "browser_session_mcp.chrome.json");

function writeManifest(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  console.log("manifest written:", file);
}

function readChromeOrigin() {
  try {
    const id = fs.readFileSync(CHROME_ID_FILE, "utf8").trim();
    if (!/^[a-p]{32}$/.test(id)) {
      throw new Error("expected a 32-character Chromium extension ID (letters a-p)");
    }
    return { origin: `chrome-extension://${id}/`, configured: true };
  } catch (error) {
    return {
      origin: "chrome-extension://REPLACE_WITH_EXTENSION_ID/",
      configured: false,
      reason: error?.message ?? String(error),
    };
  }
}

const chrome = readChromeOrigin();
writeManifest(ffManifest, {
  name: HOST_NAME,
  description: "Browser Session MCP native messaging bridge",
  path: BAT,
  type: "stdio",
  allowed_extensions: [GECKO_ID],
});
// Skip Chromium registration entirely when the extension ID is unknown: writing
// a placeholder origin would register a host that Chrome must reject, and the
// caller would never learn that the native transport is unusable.
if (chrome.configured) {
  writeManifest(chromeManifest, {
    name: HOST_NAME,
    description: "Browser Session MCP native messaging bridge",
    path: BAT,
    type: "stdio",
    allowed_origins: [chrome.origin],
  });
} else {
  try {
    fs.rmSync(chromeManifest, { force: true });
    fs.rmSync(path.join(HOST_DIR, "chrome-extension-id.txt.tmp"), { force: true });
  } catch {
    /* nothing to clean up */
  }
  console.error("Chromium extension ID missing — skipping Chrome / Edge registration.");
}

const registryRoots = [
  "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\",
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\",
];
const registrations = [[registryRoots[0] + HOST_NAME, ffManifest]];
if (chrome.configured) {
  registrations.push([registryRoots[1] + HOST_NAME, chromeManifest]);
  registrations.push([registryRoots[2] + HOST_NAME, chromeManifest]);
}

for (const [key, file] of registrations) {
  try {
    execFileSync("reg", ["add", key, "/ve", "/d", file, "/f"], { stdio: "ignore" });
    console.log("registry registered:", key);
  } catch (error) {
    console.error("registry registration failed:", key, error?.message ?? error);
    process.exitCode = 1;
  }
}

if (!chrome.configured) {
  // Remove stale Chromium registrations so the browser cannot find a host
  // whose allowed origin no longer matches.
  for (const root of [registryRoots[1], registryRoots[2]]) {
    try {
      execFileSync("reg", ["delete", root + HOST_NAME, "/f"], { stdio: "ignore" });
      console.log("stale Chromium registration removed:", root + HOST_NAME);
    } catch {
      /* key absent */
    }
  }
}

for (const root of registryRoots) {
  const legacyKey = root + LEGACY_HOST_NAME;
  try {
    execFileSync("reg", ["delete", legacyKey, "/f"], { stdio: "ignore" });
    console.log("legacy registry key removed:", legacyKey);
  } catch {
    /* key absent */
  }
}

console.log("\nNative messaging host installation complete.");
if (!chrome.configured) {
  console.log("Firefox is configured. To enable the native transport in Chrome / Edge:");
  console.log("1. Reload browser-extension/ and copy its ID from the extensions page.");
  console.log(`2. Write that ID to ${CHROME_ID_FILE}`);
  console.log("3. Run node native-messaging-host/install.js again.");
  if (chrome.reason && !chrome.reason.includes("ENOENT")) console.error("Current ID issue:", chrome.reason);
  // Distinct exit code: the Firefox host works, the Chromium host is not installed.
  process.exitCode = 2;
}
