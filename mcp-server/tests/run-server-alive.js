// Keeps the Browser Session MCP server alive independent of the parent's stdin state.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(HERE, "..", "index.js")], {
  stdio: ["pipe", "inherit", "inherit"],
});
child.on("exit", (code) => {
  console.log(`[wrapper] MCP server exited (${code})`);
  process.exit(code ?? 0);
});
// Hold the child's stdin open forever; the server exits only via its own
// disconnect-grace logic or a signal to this wrapper.
setInterval(() => {}, 1 << 30);
