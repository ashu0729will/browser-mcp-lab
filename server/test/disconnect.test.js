// Test: when the extension disconnects (browser closed), the server must exit
// within the grace period, releasing the port.
// Run: node server/test/disconnect.test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9789;
const GRACE_MS = 1500;

const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    BML_PORT: String(PORT),
    BML_EXIT_ON_DISCONNECT: "1",
    BML_DISCONNECT_GRACE_MS: String(GRACE_MS),
    BML_KEEPALIVE_MS: "0",
    BML_QUIET: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let serverExited = false;
let exitCode = null;
server.on("exit", (code) => {
  serverExited = true;
  exitCode = code;
});

const fake = spawn(process.execPath, [path.join(HERE, "fake-extension.js"), `ws://127.0.0.1:${PORT}`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
};

await sleep(1000); // extension pairs with the server
check("server still alive while extension connected", !serverExited);

fake.kill(); // browser "closes"
const started = Date.now();
await sleep(GRACE_MS + 3500); // grace + margin

check("server exited after disconnect grace", serverExited);
check(`exit code 0 (got ${exitCode})`, exitCode === 0);
console.log(`   (disconnect -> exit took ~${Math.max(0, Date.now() - started - GRACE_MS)}ms after grace ended)`);

// port must be free now
const { isPortInUse } = await import("../websocket.js");
check("port released (nothing listening)", !(await isPortInUse(PORT)));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
