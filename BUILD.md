# Building the submitted add-on

Requires Node.js 22 or newer; no dependency installation or compilation.
From the repository root (or the extracted reviewer source ZIP), run:

```sh
node tools/package-extension.js --out dist
node tools/package-source.js --out dist
node --test tools/tests/packaging.test.js
```

Omitting `--out` uses `dist`; supplying `--out` without a directory is an error.
The extension command validates both variants before writing either ZIP:

- `browser-session-mcp-firefox-<version>.zip`: removes
  `background.service_worker`, keeps `background.scripts` and inherits the source
  `browser_specific_settings.gecko.data_collection_permissions` unchanged.
  Missing data-collection declarations are errors; the build never invents one.
- `browser-session-mcp-chrome-<version>.zip`: keeps the service worker, removes
  `background.scripts` and `browser_specific_settings`.

Both ZIPs have `manifest.json` at their root. Other files are copied verbatim.
Inputs are the required extension files, explicit manifest resource paths and
any explicit `browserSessionPackaging.extensionFiles` in root `package.json`
(use that list for imported modules or HTML assets not named in the manifest).
Wildcards, traversal, symlinks, secret filenames and recognizable private keys
or access tokens are rejected. This is a safety check, not a general secret audit.
Version mismatch, missing files or invalid icon dimensions also fail before any
ZIP is written; existing outputs are not deleted on validation failure.

ZIP entries use locale-independent sorting and the fixed timestamp
2026-01-01 00:00:00. Rebuild with the same Node.js/zlib version for byte-identical
compression; source file modification times do not affect output.

`browser-session-mcp-source-<version>.zip` contains the original extension
inputs, all build tools/tests, root package metadata, BUILD.md, LICENSE and
PRIVACY.md when present. It excludes repository/private metadata (`.pi`, `.git`),
local host manifests, extension IDs, logs, dependencies and generated ZIPs.
The separate MCP server and native host are not needed to rebuild the add-on.
Tests use `PI_SCRATCH_DIR` or the operating system temporary directory and clean
up their fixtures. Packaging itself creates no temporary files.
