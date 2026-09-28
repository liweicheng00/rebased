# Rebased Lite

Rebased Lite is a light, read-only git viewer. It draws the commit graph the same way as
Rebased (IntelliJ), and it compares files between any two commits. It does not use a JVM.

The design spec is in [`docs/rebased-lite/design-spec.md`](../docs/rebased-lite/design-spec.md).

## Features

- **Open**: a welcome screen, a native folder dialog, recent repositories, and `rebased-lite <path>` on the command line.
- **Branches panel**: local branches with ahead and behind counts, remote branches by remote, and tags.
  Click to go to the commit. Double-click, or use the filter button, to show only that branch.
- **Commit graph**: all branches, remotes and tags, with virtual scrolling and no commit limit.
  It uses the IntelliJ rules: long-edge cuts with arrows, IntelliSort, and branch colors.
  Click an arrow to go to the other end of the edge.
- **Filters**: text in the message, user, path, date and branch. A filtered graph joins the
  visible commits with dashed edges. Type a hash and press Enter to go to a commit.
- **Compare**: one commit against its parent, two commits (Ctrl or Cmd click; the lower commit
  is the left side, as in IntelliJ), a commit against the working tree, or a branch against the
  current branch.
- **Changes panel**: a directory tree or a flat list, with added, modified, deleted, renamed and copied files.
- **Commit details**: the full message, hash, author, committer, parents and refs.
- **Diff**: Monaco, side by side or unified, previous and next change, previous and next file,
  ignore whitespace, collapse unchanged regions, and single-side view for added or deleted files.
- **Other**: context menus, Refresh, Fetch, column choice and resize, resizable panels,
  light, dark or system theme, and a status bar.

Keyboard: `Ctrl/Cmd+O` open, `Ctrl/Cmd+R` or `F5` refresh, `Ctrl/Cmd+F` filter, `Ctrl/Cmd+1` branches
panel, arrow keys, Page Up, Page Down, Home and End in the log, `Shift` with arrows to select a range,
`Ctrl/Cmd+C` copy the hash, `F7` and `Shift+F7` next and previous change, `Alt+Down` and `Alt+Up` next
and previous file.

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

UI scenarios run in Chromium against the dev server:

```sh
ui/e2e/make-demo-repo.sh /tmp/demo
node ui/e2e/demo-repo.mjs /tmp/demo /tmp/shots        # a small repository with every case
node ui/e2e/large-repo.mjs /path/to/git.git /tmp/shots  # a large repository, for example git/git
```

Each scenario takes screenshots and fails when the page logs an error.

## License

Apache-2.0. See `NOTICE` for the IntelliJ Community code that this project ports.
