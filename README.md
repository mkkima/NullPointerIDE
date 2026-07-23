# NullPointer IDE

A focused, native code editor built with Tauri 2, TypeScript, Vite, and CodeMirror 6.

## Highlights

- Native folder picker and a Rust filesystem boundary: the UI can only read or write files inside the opened project.
- Fast startup: no frontend framework, lazy-loaded language support, and a single CodeMirror instance.
- Tabs with independent undo history, dirty-state protection, quick open, project tree, and keyboard-first controls.
- Multi-repository Source Control with branch state, staged and working changes, stage/unstage, commits, and a compact history graph.
- External-change detection, binary/oversized-file guards, bounded directory traversal, and safe path validation.

## Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.77.2+
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

The selected project directory is canonicalized in Rust and stored as application state. Every file command resolves its target relative to that root and rejects traversal, symlink escapes, absolute paths, binary files, oversized reads, invalid names, and conflicting external writes. Tauri's content-security policy is enabled and the app exposes only the dialog permissions it needs.

Git commands run directly without shell interpolation. Repository and file paths are validated against the open workspace before any staging or commit operation.
