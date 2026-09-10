# Building the submitted add-on

The add-on has no compilation step: `browser-extension/` holds the complete,
readable source of everything in the submitted package.

Reproduce the submitted archive byte for byte:

```bash
node tools/package-extension.js --out dist
```

Requires Node.js 22 or newer. There are no dependencies to install.

The script copies `browser-extension/` into
`dist/browser-session-mcp-firefox-<version>.zip` and applies exactly two manifest
edits for AMO:

1. `background.service_worker` is removed — Firefox ignores that key and runs
   `background.scripts` (the event page) instead.
2. `browser_specific_settings.gecko.data_collection_permissions` is added with
   `{"required": ["none"]}`, the declaration AMO requires for new add-ons.

The same script also emits the Chromium variant
(`browser-session-mcp-chrome-<version>.zip`), which keeps `service_worker` and
drops the Firefox-only keys. Both archives are written deterministically (entries
sorted, timestamps pinned), so rebuilding from this source produces identical
bytes — not just equivalent files.

Every other file in the archive is copied verbatim, including `service-worker.js`,
`popup.html`, `popup.js` and the icons.

The companion MCP server that the add-on talks to is a separate program and is
not part of the add-on; it lives in the same public repository, under
`mcp-server/` and `native-messaging-host/`.
