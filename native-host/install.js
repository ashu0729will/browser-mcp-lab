// Registers the Browser MCP Lab native messaging host (per-user, no admin).
// - Writes host manifests (Firefox + Chromium) with the absolute bridge.bat path
// - Adds HKCU registry keys so Firefox / Chrome / Edge can find the host
// Run: node native-host/install.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GECKO_ID = "browser-mcp-lab@ashu0729will.local";
const HOST_NAME = "browser_mcp_lab";
const BAT = path.join(HOST_DIR, "bridge.bat");

function writeManifest(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  console.log("written:", file);
}

// Firefox manifest (matched by allowed_extensions)
const ffManifest = path.join(HOST_DIR, "browser_mcp_lab.firefox.json");
writeManifest(ffManifest, {
  name: HOST_NAME,
  description: "Browser MCP Lab native messaging bridge",
  path: BAT,
  type: "stdio",
  allowed_extensions: [GECKO_ID],
});

// Chromium manifest (matched by allowed_origins; fill the extension id after
// loading the unpacked extension, see chrome://extensions)
const CHROME_ID_FILE = path.join(HOST_DIR, "chrome-extension-id.txt");
let chromeOrigin = "chrome-extension://REPLACE_WITH_EXTENSION_ID/";
try {
  chromeOrigin = "chrome-extension://" + fs.readFileSync(CHROME_ID_FILE, "utf8").trim() + "/";
} catch {
  /* no id file yet — keep placeholder */
}
const chromeManifest = path.join(HOST_DIR, "browser_mcp_lab.chrome.json");
writeManifest(chromeManifest, {
  name: HOST_NAME,
  description: "Browser MCP Lab native messaging bridge",
  path: BAT,
  type: "stdio",
  allowed_origins: [chromeOrigin],
});

// registry keys (per-user)
const keys = [
  ["HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + HOST_NAME, ffManifest],
  ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME, chromeManifest],
  ["HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME, chromeManifest],
];
for (const [key, file] of keys) {
  try {
    execSync(`reg add "${key}" /ve /d "${file}" /f`, { stdio: "ignore" });
    console.log("registry ok:", key);
  } catch (e) {
    console.log("registry failed:", key, e.message.split("\n")[0]);
  }
}

console.log("\n安装完成。要在 Chromium 系浏览器启用原生通道：");
console.log(`1. 加载扩展后在 chrome://extensions / edge://extensions 复制扩展 ID`);
console.log(`2. 把 ID 写入 ${CHROME_ID_FILE}`);
console.log(`3. 重新运行 node native-host/install.js`);
