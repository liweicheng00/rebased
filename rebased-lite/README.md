# Rebased Lite

Rebased Lite is a light, read-only git viewer. It draws the commit graph the same way as
Rebased (IntelliJ), and it compares files between any two commits. It does not use a JVM.

The design spec is in [`docs/rebased-lite/design-spec.md`](../docs/rebased-lite/design-spec.md).

## Features

- **Open**: a welcome screen, a native folder dialog, recent repositories, and `rebased-lite <path>` on the command line.
- **Branches panel**: recent branches (from the HEAD reflog), local branches with ahead and behind
  counts, remote branches by remote, tags, and worktrees. Click to go to the commit.
  Double-click a branch to check it out. Use the filter button to show only that branch.
- **Branch switcher**: the current branch in the toolbar opens a searchable list. Recent branches
  come first.
- **Commit graph**: all branches, remotes and tags, with virtual scrolling and no commit limit.
  It uses the IntelliJ rules: long-edge cuts with arrows, IntelliSort, and branch colors.
  Click an arrow to go to the other end of the edge.
- **Collapse linear branches**: the ⊟ and ⊞ buttons collapse and expand all linear branches, as
  in IntelliJ. Click a dotted edge to expand one branch. The context menu collapses one branch.
- **Filters**: text in the message, user, path, date and branch. A filtered graph joins the
  visible commits with dashed edges. Type a hash and press Enter to go to a commit.
- **Compare**: one commit against its parent, two commits (Ctrl or Cmd click; the lower commit
  is the left side, as in IntelliJ), a commit against the working tree, or a branch against the
  current branch.
- **Changes panel**: a directory tree or a flat list, with added, modified, deleted, renamed and copied files.
  Select several files with Ctrl or Cmd and Shift. For the files of a commit: Revert Selected
  Changes, Cherry-Pick Selected Changes (both change only the working tree, and fall back to a
  three-way merge) and Get from Revision.
- **Commit details**: the full message, hash, author, committer, parents and refs.
- **Diff**: Monaco, side by side or unified, previous and next change, previous and next file,
  ignore whitespace, collapse unchanged regions, and single-side view for added or deleted files.
- **Write operations**: check out a branch or a revision, new branch, new tag, rename, delete,
  merge, rebase, cherry-pick, revert, reset (soft, mixed, keep or hard), edit a commit message,
  squash, drop, and interactive rebase. Squash, drop, edit and interactive rebase run in memory:
  a conflict stops them before a file or a ref changes. An interactive rebase with an Edit step
  runs `git rebase -i` instead: it stops at that commit, you change the files, amend in the
  Commit tab, and continue. A banner shows a merge, rebase, cherry-pick or revert in progress, with its
  conflicting files and the Mark Resolved, Abort and Continue actions.
- **Undo**: the notification after an operation has an Undo button, and `Ctrl/Cmd+Z` (outside a
  text field) undoes the last operation. Undo works for checkout, new branch, new tag, rename,
  delete of a branch or a tag (an annotated tag keeps its message), merge, rebase, cherry-pick,
  revert, update, reset, the rewrites, commit, and drop of a stash. Undo stops when HEAD moved
  after the operation.
- **Local History**: the app keeps versions of the files that change in the working tree, as in
  IntelliJ. It also keeps the content before Rollback, delete of unversioned files, Get from
  Revision, Apply Changes, a hard reset, a stash and a resolve. The 🕘 Local History button shows
  the recent versions of all files; "Show Local History" in the Commit tab shows one file. Revert
  writes a version back, and first keeps the current content. The store is in the git directory,
  in `rebased-lite/local-history`. It keeps 5 days and at most 200 MB, and skips files larger
  than 2 MB and changes of more than 200 files at one time (for example a checkout).
- **Changelists and commit**: the Commit tab (`Ctrl/Cmd+K`) groups the local changes into named
  changelists, as in IntelliJ. New changes go to the active changelist. Move files with the context
  menu or with drag and drop. The checked files go into the commit; the other local changes and the
  staged content of other files stay as they are. Each changelist keeps its draft commit message.
  The panel also has Amend, Rollback, Add to Git, delete of unversioned files, and Undo of the last
  commit (the changes become local changes again). The changelists of a worktree are stored in its
  git directory, in `rebased-lite/changelists.json`.
- **Commit extras**: Sign-off adds "Signed-off-by" with your name, as `git commit -s`. The 🕘
  button (or `Ctrl/Cmd+M` in the message field) lists the last 30 commit messages. "Edit Author…" in
  the context menu of one or more commits of the current branch changes their author; the author
  date stays, and the commits get new hashes.
- **Commit message checks**: below the message field, a warning shows when the subject is longer
  than 72 characters, when the line after the subject is not blank, or when a body line is longer
  than 72 characters. A commit with warnings asks first. Settings → Commit changes the limits.
  An empty message field gets the file of `commit.template`, and a message that is only the
  template asks first. Comment lines (#) do not count and do not go into the commit.
- **Compare Branches**: "Compare Branches…" and "Compare with the Working Tree…" in the context menu
  of a branch or a tag open a window. It lists the commits of each side that the other side does not
  have, and the changed files with their diff. The files can be compared tip to tip, or from the
  common ancestor to the right side. ⇄ swaps the sides. Double-click a commit to show it in the log.
- **Favorite branches**: the ☆ of a branch or a tag marks it as a favorite. Favorites come first in
  each group, and the ★ button next to the search field shows only the favorites and the current
  branch. At first, main and master are favorites. The current branch has the ◉ icon.
- **Partial changelists**: the changes (hunks) of one file can be in different changelists, as in
  IntelliJ. Right-click a changed line in the diff and choose "Move Change to Another Changelist".
  Such a file shows in each changelist with a count, for example 1/2. The diff marks the changes of
  the other changelists. A commit of a changelist takes only its changes. Rollback of such a row
  rolls back only its changes. New changes of the file go to the changelist that holds the file.
  The assignment is stored in `changelists.json` and survives a restart.
- **Partial commit**: the diff of a local file has a check box for each change. Unchecked changes
  stay local; the file check box then shows a partial file. Such a commit is built in a temporary
  index with `git commit-tree`. With "Ignore whitespace" on,
  whitespace-only changes have no check box and stay local in a partial file.
- **File history and annotate**: Show History (from the changes panels or the 🕘 button of the
  diff) lists the commits that changed a file, across renames, with the change of the file in each
  commit. Annotate shows the commit, author and date of each line in the gutter (git blame), with
  an age color. It works for commits, local changes (uncommitted lines are marked) and history.
  Click an annotation to go to its commit.
- **Conflicts and the merge window**: a conflict from a merge, rebase, cherry-pick, revert, update
  or stash opens the Conflicts dialog (Accept Yours, Accept Theirs, Merge…). The merge window
  shows yours, the result and theirs side by side, aligned and scrolled together. Apply (» «) or
  ignore (✕) each change, append the second side of a conflict, or apply all non-conflicting
  changes at once. The result stays editable. A binary file or a deleted side takes one whole side.
- **Stash**: the Stash tab lists the stashes. Select one to see its files and diffs, with its
  unversioned files. Apply, pop, apply with the staged state, new branch from a stash, and drop.
  Stash all local changes, the selected files, or one changelist. A conflict from apply or pop
  shows in the conflict banner.
- **Push and Update**: the push dialog lists the outgoing commits and lets you choose the remote,
  the remote branch, force push with lease, tags, and the tracked branch. A new branch shows
  "New". A rejected push offers Update. Update fetches the tracked branch and merges or rebases,
  with the local changes stashed and restored. The Commit tab has "Commit and Push". The branch
  menu pushes any local branch.
- **Remotes**: the Fetch menu fetches all remotes or one remote, and opens Manage Remotes: add,
  edit (name, URL, push URL), fetch and remove a remote. The group of a remote in the Branches tab
  has the same actions in its context menu. A local branch can set, change or stop its tracked
  branch. A remote branch can be deleted on the remote. A tag can be pushed to a remote or deleted
  there; the local tag stays.
- **Passwords and passphrases**: when git or ssh needs a user name, a password, an SSH key
  passphrase or a host key confirmation, a dialog asks for it (the app is the `GIT_ASKPASS` and
  `SSH_ASKPASS` program). "Remember" keeps the answer until the app closes; a git credential
  helper or an SSH agent keeps it longer. The SSH prompt needs OpenSSH 8.4 or newer.
- **Signing and hooks**: commits that the app writes itself (squash, drop, reword, reorder, and
  partial commits) are signed when `commit.gpgsign` is on, with `user.signingkey` and
  `gpg.format`. A partial commit runs the pre-commit hook with the content of the commit, the
  commit-msg hook, and the post-commit hook. The in-memory rewrites run no hooks, like
  `git rebase`.
- **Auto refresh**: the app watches the working tree and the git directory. A file edited in
  another program, a commit or a branch made in a terminal, and a fetch show up within about a
  second. The diff of a local file follows the file and keeps its scroll position. Files that git
  ignores do not cause a refresh. On Linux the app watches each directory that git does not
  ignore; when the inotify limit is reached, the app refreshes when its window gets the focus.
- **Submodules**: the Branches tab lists the submodules with their state (not initialized, other
  commit, modified). Update initializes a submodule and checks out its recorded commit; Open as
  Repository opens it. A submodule change shows in the diff as "Subproject commit <hash>", as in
  `git diff`. Rollback of a submodule checks out its recorded commit. After a checkout, merge,
  rebase, reset or update that changes a recorded commit, a notification offers Update Submodules.
  The watcher does not watch inside a submodule.
- **Git LFS**: the diff of a commit shows the real content of an LFS file when the object is in the
  local LFS store. Otherwise it shows the pointer with a note. A partial commit runs the clean
  filters of the path, so an LFS file goes in as its pointer. Git runs the LFS filters for all other
  operations.
- **Tabs**: several repositories are open at one time, one per tab. Open adds a tab; a repository
  that is open already shows its tab. Each tab keeps its log filter and its selected commit. Close a
  tab with its ✕ or a middle click. `Ctrl/Cmd+PageDown` and `Ctrl/Cmd+PageUp` go to the next and
  previous tab. The tabs come back at the next start; only the active tab loads then, the others
  load on first use. The tab bar shows when two or more repositories are open.
- **Worktrees**: list, add (on a new or an existing branch), open, remove and prune.
- **Settings** (⚙, or `Ctrl+Alt+S`; `Cmd+,` on macOS): theme, the default Update mode, auto
  refresh, auto fetch every N minutes, the git executable (with a Test button that shows its
  version), the diff font size and family, the diff options, the Local History limits, and the
  keymap. In the keymap, click a key and press the new one; an action can have several keys. A key
  that two actions use is marked red. The settings are stored in the browser storage of the app.
  The keys in the commit message field and in dialogs stay fixed.
- **Other**: context menus, Refresh, Fetch, column choice and resize, resizable panels,
  light, dark or system theme, and a status bar.

Keyboard (the defaults; change them in Settings → Keymap): `Ctrl/Cmd+O` open, `Ctrl/Cmd+K` commit, `Ctrl/Cmd+Shift+K` push, `Ctrl/Cmd+T` update,
`Ctrl/Cmd+Enter` commit from the message field, `Ctrl/Cmd+Alt+K` commit and push, `Ctrl/Cmd+R` or `F5` refresh, `Ctrl/Cmd+F` filter, `Ctrl/Cmd+1` branches
panel, arrow keys, Page Up, Page Down, Home and End in the log, `Shift` with arrows to select a range,
`Ctrl/Cmd+C` copy the hash, `Ctrl/Cmd+Z` undo the last operation, `Ctrl/Cmd+PageDown` and `Ctrl/Cmd+PageUp` next and previous tab, `F7` and `Shift+F7` next and previous change, `Alt+Down` and `Alt+Up` next
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
npm --prefix ui test          # line diff and three-way merge chunks
```

`cargo test -p rebased-graph` compares the graph output with the IntelliJ golden files.

UI scenarios run in Chromium against the dev server. One script runs all of them on fresh demo
repositories:

```sh
ui/e2e/run-all.sh /tmp/e2e                      # the demo scenarios
ui/e2e/run-all.sh /tmp/e2e /path/to/git.git     # also the large-repository scenarios
```

The scenarios are `demo-repo`, `write-ops`, `changelists`, `push-update`, `stash`, `merge-tool`,
`history`, `partial-commit`, `file-actions`, `rebase-edit`, `auto-refresh`, `credentials`, `large-repo` and `collapse`. Each file says how to run it alone.

Each scenario takes screenshots and fails when the page logs an error.

## License

Apache-2.0. See `NOTICE` for the IntelliJ Community code that this project ports.
