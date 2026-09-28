# Rebased Lite

Rebased Lite is a light, read-only git viewer. It draws the commit graph the same way as
Rebased (IntelliJ), and it compares files between any two commits. It does not use a JVM.

The design spec is in [`docs/rebased-lite/design-spec.md`](../docs/rebased-lite/design-spec.md).

## Features

- The commit graph of all branches, remotes and tags, with virtual scrolling and no commit limit.
- The IntelliJ graph rules: long-edge cuts with arrows, IntelliSort, and branch colors.
- Select one commit to compare it with its first parent. Select two commits (Ctrl or Cmd click)
  to compare them. The lower commit is the left side, as in IntelliJ.
- Compare one commit with the working tree.
- A Monaco diff, side by side or unified.

## Layout

| Path | Contents |
|---|---|
| `crates/graph` | The graph algorithms, ported from IntelliJ, with golden tests from IntelliJ test data |
| `crates/git` | Repository access through the git CLI |
| `crates/service` | App state and commands, shared by the app and the dev server |
| `crates/app` | The Tauri 2 desktop app |
| `crates/devserver` | An HTTP server for the UI in a browser, for development and UI tests |
| `ui` | The frontend (TypeScript, Vite, Monaco) |

## Build

You need Rust, Node.js 20 or later, and git. On Linux, Tauri also needs WebKitGTK
(`libwebkit2gtk-4.1-dev`).

```sh
npm --prefix ui install
npm --prefix ui run build
cargo build --release -p rebased-lite
./target/release/rebased-lite /path/to/repo
```

## Develop in a browser

```sh
cargo run -p rebased-devserver -- ui/dist 5174   # commands on 127.0.0.1:5174
npm --prefix ui run dev                            # UI on http://localhost:5173/?repo=/path/to/repo
```

## Test

```sh
cargo test
npm --prefix ui run typecheck
```

`cargo test -p rebased-graph` compares the graph output with the IntelliJ golden files.

## License

Apache-2.0. See `NOTICE` for the IntelliJ Community code that this project ports.
