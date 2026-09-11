import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { zip } from "../lib/zip.js";
import { readSafe } from "../lib/packaging.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "packaging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.cpSync(path.join(repository, "tools"), path.join(root, "tools"), { recursive: true });
  fs.mkdirSync(path.join(root, "browser-extension/icons"), { recursive: true });
  const manifest = { manifest_version: 3, version: "0.4.0", background: { service_worker: "service-worker.js", scripts: ["service-worker.js"] }, browser_specific_settings: { gecko: { id: "test@example.org", data_collection_permissions: { required: ["websiteContent"], optional: ["technicalAndInteraction"] } } } };
  save(root, "browser-extension/manifest.json", JSON.stringify(manifest));
  save(root, "package.json", JSON.stringify({ version: "0.4.0" }));
  for (const name of ["service-worker.js", "popup.html", "popup.js"]) save(root, `browser-extension/${name}`, "test\n");
  for (const size of [16, 48, 128]) {
    const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(size, 16); png.writeUInt32BE(size, 20);
    save(root, `browser-extension/icons/icon${size}.png`, png);
  }
  for (const name of ["BUILD.md", "LICENSE", "PRIVACY.md"]) save(root, name, name);
  return { root, manifest };
}
function save(root, name, data) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); }
function run(root, script, args = ["--out", path.join(root, "dist")]) { return spawnSync(process.execPath, [path.join(root, "tools", script), ...args], { cwd: root, encoding: "utf8" }); }
function success(result) { assert.equal(result.status, 0, result.stderr); }
function crc(data) {
  let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function unpack(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const start = cursor, entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(local + 10), 0);
    assert.equal(buffer.readUInt16LE(local + 12), 23585);
    assert.equal(buffer.readUInt16LE(cursor + 14), 23585);
    assert.equal(buffer.readUInt16LE(local + 6), 0x0800);
    assert.equal(buffer.subarray(local + 30, local + 30 + nameLength).toString(), name);
    const method = buffer.readUInt16LE(cursor + 10);
    assert.equal(buffer.readUInt16LE(local + 8), method);
    const size = buffer.readUInt32LE(cursor + 20);
    assert.equal(buffer.readUInt32LE(local + 18), size);
    const body = buffer.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(data.length, buffer.readUInt32LE(cursor + 24));
    assert.equal(crc(data), buffer.readUInt32LE(cursor + 16));
    assert.equal(crc(data), buffer.readUInt32LE(local + 14));
    assert.ok(!entries.has(name)); entries.set(name, data);
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(cursor - start, buffer.readUInt32LE(end + 12));
  assert.deepEqual([...entries.keys()], [...entries.keys()].sort());
  return entries;
}
const archive = (root, kind) => fs.readFileSync(path.join(root, "dist", `browser-session-mcp-${kind}-0.4.0.zip`));

test("browser variants, root manifests, ZIP records/CRC and deterministic rebuild", t => {
  const { root, manifest } = fixture(t);
  success(run(root, "package-extension.js"));
  for (const kind of ["firefox", "chrome"]) {
    const bytes = archive(root, kind), files = unpack(bytes);
    const built = JSON.parse(files.get("manifest.json"));
    assert.ok(!files.has("browser-extension/manifest.json"));
    if (kind === "firefox") {
      assert.equal(built.background.service_worker, undefined);
      assert.deepEqual(built.background.scripts, manifest.background.scripts);
      assert.deepEqual(built.browser_specific_settings, manifest.browser_specific_settings);
    } else {
      assert.equal(built.background.scripts, undefined);
      assert.equal(built.background.service_worker, "service-worker.js");
      assert.equal(built.browser_specific_settings, undefined);
    }
    fs.utimesSync(path.join(root, "browser-extension/popup.js"), new Date(), new Date());
    success(run(root, "package-extension.js")); assert.deepEqual(archive(root, kind), bytes);
  }
});

test("ZIP sorts inputs and validates paths; known CRC vector", () => {
  const entries = [{ name: "z", data: Buffer.from("123456789") }, { name: "a", data: Buffer.from("a".repeat(200)) }];
  const bytes = zip(entries); unpack(bytes);
  assert.equal(crc(entries[0].data), 0xcbf43926);
  assert.deepEqual(bytes, zip([...entries].reverse()));
  assert.throws(() => zip([{ name: "../bad", data: Buffer.alloc(0) }]), /Unsafe/);
  assert.throws(() => zip([entries[0], entries[0]]), /duplicate/);
});

test("both CLIs reject missing --out value without artifacts", t => {
  const { root } = fixture(t);
  for (const script of ["package-extension.js", "package-source.js"]) {
    for (const args of [["--out"], ["--out", "--bad"], ["--out", ""]]) {
      const result = run(root, script, args); assert.notEqual(result.status, 0); assert.match(result.stderr, /directory is required/);
      assert.ok(!fs.existsSync(path.join(root, "dist")));
    }
  }
});

test("validation failure never writes either archive", t => {
  let root, manifest;
  const cases = [
    () => { delete manifest.browser_specific_settings.gecko.data_collection_permissions; save(root, "browser-extension/manifest.json", JSON.stringify(manifest)); },
    () => save(root, "package.json", '{"version":"0.0.0"}'),
    () => fs.unlinkSync(path.join(root, "browser-extension/popup.js")),
  ];
  for (const change of cases) {
    ({ root, manifest } = fixture(t));
    change();
    for (const script of ["package-extension.js", "package-source.js"]) {
      const result = run(root, script); assert.notEqual(result.status, 0); assert.ok(!fs.existsSync(path.join(root, "dist")));
    }
  }
});

test("secrets and linked input directories are rejected", t => {
  const { root } = fixture(t);
  save(root, "browser-extension/secret.key", "private");
  assert.throws(() => readSafe(root, "browser-extension/secret.key"), /Forbidden/);
  save(root, "browser-extension/popup.js", ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  assert.notEqual(run(root, "package-extension.js").status, 0);
  assert.ok(!fs.existsSync(path.join(root, "dist")));
  fs.renameSync(path.join(root, "browser-extension/icons"), path.join(root, "real-icons"));
  fs.symlinkSync(path.join(root, "real-icons"), path.join(root, "browser-extension/icons"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readSafe(root, "browser-extension/icons/icon16.png"), /regular package path/);
});

test("source contains rebuild inputs/privacy, excludes local material, reproduces all ZIPs", t => {
  const { root } = fixture(t);
  for (const name of [".pi/session.json", ".git/config", "browser-extension/chrome-extension-id.txt", "browser-extension/native-host-manifest.json", "browser-extension/debug.log", "tools/.pi/session.json", "tools/debug.log"]) save(root, name, "local");
  success(run(root, "package-extension.js")); success(run(root, "package-source.js"));
  const source = archive(root, "source"), entries = unpack(source);
  for (const name of ["BUILD.md", "LICENSE", "PRIVACY.md", "package.json", "tools/package.json", "tools/lib/zip.js", "tools/tests/packaging.test.js", "browser-extension/manifest.json"]) assert.ok(entries.has(name), name);
  assert.ok(![...entries.keys()].some(name => /\.pi|\.git|chrome-extension-id|host-manifest|\.log$/.test(name)));
  const rebuilt = path.join(root, "rebuilt");
  for (const [name, data] of entries) save(rebuilt, name, data);
  success(run(rebuilt, "package-extension.js")); success(run(rebuilt, "package-source.js"));
  for (const kind of ["firefox", "chrome", "source"]) assert.deepEqual(archive(rebuilt, kind), archive(root, kind));
});

test("text inputs are line-ending normalized so a CRLF checkout rebuilds identically", t => {
  const { root } = fixture(t);
  success(run(root, "package-extension.js"));
  const lf = new Map(["chrome", "firefox"].map((kind) => [kind, archive(root, kind)]));
  // Simulate a Windows clone with core.autocrlf=true rewriting the working tree.
  for (const name of ["service-worker.js", "popup.html", "popup.js"]) {
    const file = path.join(root, "browser-extension", name);
    save(root, `browser-extension/${name}`, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  }
  success(run(root, "package-extension.js"));
  for (const kind of ["chrome", "firefox"]) {
    assert.ok(archive(root, kind).equals(lf.get(kind)), `${kind} archive must not depend on checkout line endings`);
  }
});
