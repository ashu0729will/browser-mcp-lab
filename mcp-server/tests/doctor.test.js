// Behavioral test for `node mcp-server/index.js --doctor`.
// The doctor must always terminate, must only report a connection after an
// extension sends its `hello` frame, and must never hang on a lingering socket.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../index.js", import.meta.url));
const fakeFile = fileURLToPath(new URL("./fake-extension.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function runDoctor(port, waitMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverFile, "--doctor"], {
      env: { ...process.env, BSM_PORT: String(port), BSM_DOCTOR_WAIT_MS: String(waitMs), BSM_QUIET: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.resume();
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("doctor terminates and reports no client when nothing connects", { timeout: 20000 }, async () => {
  const port = await freePort();
  const started = Date.now();
  const { code, out } = await runDoctor(port, 400);
  assert.equal(code, 0, out);
  assert.match(out, /VERDICT: no-client-yet/, out);
  assert.ok(!/extension-connected/.test(out), out);
  assert.ok(Date.now() - started < 15000, "doctor must finish promptly");
});

test("doctor reports extension-connected only after an extension hello", { timeout: 20000 }, async () => {
  const port = await freePort();
  const fake = spawn(process.execPath, [fakeFile, `ws://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "inherit"] });
  try {
    const { code, out } = await runDoctor(port, 4000);
    assert.equal(code, 0, out);
    assert.match(out, /VERDICT: extension-connected/, out);
    assert.match(out, /fake-extension v0\.0\.0/, out);
  } finally {
    fake.kill();
  }
});

test("doctor does not accept a bare connection as the extension", { timeout: 20000 }, async () => {
  const port = await freePort();
  const doctor = runDoctor(port, 2000);
  await sleep(300);
  // A raw WebSocket that never sends `hello` — a stray local process, not an extension.
  const bare = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => {
    bare.addEventListener("open", resolve);
    bare.addEventListener("error", resolve);
  });
  const { code, out } = await doctor;
  bare.close();
  assert.equal(code, 0, out);
  assert.ok(!/extension-connected/.test(out), out);
  assert.match(out, /VERDICT: no-client-yet/, out);
});
