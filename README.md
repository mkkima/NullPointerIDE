# NullPointer IDE

A focused, native code editor built with Tauri 2, TypeScript, Vite, and CodeMirror 6.

## Highlights

- Native folder picker and a Rust filesystem boundary: the UI can only read or write files inside the opened project.
- Fast startup: no frontend framework, lazy-loaded language support, and a single CodeMirror instance.
- Tabs with independent undo history, dirty-state protection, quick open, project tree, and keyboard-first controls.
- Multi-repository Source Control with branch state, staged and working changes, stage/unstage, commits, and a compact history graph.
- Signed automatic updates, release history, and safe version rollback.
- External-change detection, binary/oversized-file guards, bounded directory traversal, and safe path validation.

## Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.85+
- The [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

## Development

```bash
npm install
npm run tauri dev
```

The npm wrapper runs `tauri dev --no-dev-server`, so the app loads generated frontend assets through Tauri's asset protocol without opening a TCP port. To rebuild frontend assets continuously while the app is open, run `npm run dev` in a second terminal.

Useful checks:

```bash
npm run check
npm run test
npm run tauri build
```

## Automatic updates

Every successful push to `main` runs frontend and Rust tests, generates an internal
version from the GitHub Actions run number, and publishes Windows x64 and macOS
Apple Silicon builds in one GitHub Release. `latest.json` contains signed updater
bundles for installed builds, while `portable-latest.json` points to the signed
Windows portable executable. Production builds check for updates on startup and
every 30 minutes. The **Updates** section can disable automatic checks, refresh
the GitHub release history, show release notes, install a newer version, or roll
back to an older signed build. Rolling back disables automatic updates so the
selected version is not immediately replaced.

Only releases that contain the compatible update manifest can be installed.
Updates and rollbacks are downloaded and verified by Tauri against the embedded
public key before any installer or portable replacement starts.

The updater public key is committed in `src-tauri/tauri.conf.json`. The private key
must never be committed; its local recovery copy is stored at
`%USERPROFILE%\.tauri\nullpointer-ide.key`, and GitHub Actions reads it from the
`TAURI_SIGNING_PRIVATE_KEY` repository secret.

### Windows portable

Each GitHub Release also contains
`NullPointer_<version>_windows_x64_portable.zip`. Extract the archive and run
`NullPointer.exe`; no installation or administrator access is required. Keep
`portable.flag` next to the executable to store WebView2 data, preferences,
cache, and Research state in the adjacent `data` folder.

Portable builds use a dedicated signed update feed instead of the NSIS
installer. NullPointer downloads and verifies the new portable executable,
starts a temporary helper, replaces the executable only after the application
has closed, preserves `data/`, and restarts. If the new executable does not
confirm a healthy startup, the helper restores and relaunches the previous
version automatically. Manual ZIP replacement remains available as a fallback;
preserve the existing `data/` directory when doing so.

### macOS Apple Silicon

Download the `.dmg` asset from the latest GitHub Release, open it, and drag
`NullPointer.app` into `Applications`. The build targets Apple Silicon Macs only
and is ad-hoc signed with `APPLE_SIGNING_IDENTITY=-`, so it does not require a
paid Apple Developer account.

Because the app is not Apple-notarized, Gatekeeper can block the first launch.
Control-click `NullPointer.app`, choose **Open**, or allow it from **System
Settings → Privacy & Security**. This ad-hoc signature is separate from the Tauri
updater signature: downloaded updates are still verified against the embedded
public updater key.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + O` | Open folder |
| `Ctrl/Cmd + P` | Quick open |
| `Ctrl/Cmd + S` | Save active file |
| `Ctrl/Cmd + W` | Close active tab |
| `Ctrl/Cmd + N` | Create file |
| `Ctrl/Cmd + B` | Toggle explorer |

## Security model

The selected project directory is canonicalized in Rust and stored as application state. Every file command resolves its target relative to that root and rejects traversal, symlink escapes, absolute paths, binary files, oversized reads, invalid names, and conflicting external writes. Tauri's content-security policy is enabled and the app exposes only the dialog, updater, and process permissions it needs.

Git commands run directly without shell interpolation. Repository and file paths are validated against the open workspace before any staging or commit operation.
