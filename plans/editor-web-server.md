# Editor Web Server — Implementation Plan

## Goal

A Node HTTP server that serves the editor UI and owns a `ts/data/` directory of `.sl` rule files. The editor tracks whether it is **attached** (synced with a server file) or **detached** (unsaved scratch state).

---

## Modes

### Attached
- Editor content is associated with a named file on the server.
- URL parameter `?file=<name>` is kept in sync with the current filename.
- Auto-saves whenever content becomes valid (debounced PUT).
- `ctrl-s` force-saves even if invalid.
- `ctrl-]/[` cycles to next/prev file (only if valid and synced).

### Detached
- Editor is not associated with any server file.
- URL parameter `?file=<name>` is the *intended* filename for the next save (optional).
- No auto-save.
- `ctrl-s` saves to a new file:
  - Use URL param as filename if present and valid.
  - Otherwise use `<unix-timestamp>.sl`.
  - Server rejects if the name already exists (no overwrite).
  - On success: switch to attached mode, update URL param.
- `ctrl-]/[` does nothing (not synced).

---

## Initial Load

On page load, read `?file=` URL parameter:
- If present: `GET /api/file/<name>`
  - Success → load content, enter attached mode
  - 404 → open empty editor in detached mode (keep URL param as intended save name)
- If absent: open empty editor in detached mode (no URL param)

---

## Server (`src/server.ts`)

Use Node's built-in `http` module. Data directory: `ts/data/` (default), overridable via `--data <dir>` and `--port <port>` CLI args.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | serve `index.html` |
| `GET`  | `/src/*.js` | serve compiled JS from `dist/` |
| `GET`  | `/api/files` | `{ files: string[] }` — sorted `.sl` filenames |
| `GET`  | `/api/file/:name` | `{ content: string }` — 404 if not found |
| `PUT`  | `/api/file/:name` | overwrite existing file; 404 if not found |
| `POST` | `/api/file/:name` | create new file; 409 if already exists |

The PUT/POST split enforces the "no accidental overwrite" rule for detached saves.

---

## Client (`src/web.ts`)

### State

```
mode: "attached" | "detached"
currentFile: string | null   // null in detached with no intended name
fileList: string[]
pendingSync: boolean         // valid but not yet PUT (attached mode only)
debounceTimer: ...
```

### Sync indicator

| Condition | Symbol | Color |
|-----------|--------|-------|
| detached | `∅` | dim |
| attached, invalid | `✗` | red |
| attached, valid, pending | `~` | yellow |
| attached, valid, synced | `·` | dim |

### `ctrl-s`

- **Attached**: PUT current content unconditionally (even if invalid); clear pending.
- **Detached**: POST to `/api/file/<name>` where name = URL param or `<timestamp>.sl`.
  - On 409: show error "file already exists".
  - On success: enter attached mode, update URL param, update file list.

### `cycleFile(dir)`

Guard: `mode === "attached" && !pendingSync && isValid(content)`.  
Load next file, update URL param.

### URL param management

Use `history.replaceState` to update `?file=` without a page reload:
- On attach: `replaceState({}, "", "?file=" + encodeURIComponent(name))`
- On detach (if applicable): `replaceState({}, "", location.pathname)`

---

## Build

Two tsconfig targets (existing):
- `tsconfig.json` — Node/server files → `dist/`
- `tsconfig.browser.json` — `src/web.ts` → `dist/`

Scripts:
```
"build": "tsc && tsc -p tsconfig.browser.json",
"serve": "npm run build && node dist/server.js"
```

---

## File layout

```
ts/
  src/
    web.ts       — editor UI + sync logic
    server.ts    — HTTP server
    ...
  index.html     — #file-name, #sync-status in header
  data/
    example.sl
```

---

## Implementation order

1. Add POST endpoint to server (409 on existing file)
2. Add `?file=` URL param read on startup + attached/detached init
3. Implement `ctrl-s` (both modes)
4. Update auto-save to only fire in attached mode
5. Update `cycleFile` guard to use `pendingSync`
6. Update sync indicator for the new states
7. Update `history.replaceState` calls on file transitions
