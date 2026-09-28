#!/usr/bin/env bash
# Builds the demo repository for e2e/demo-repo.mjs: branches, merges, tags, a rename, a binary file,
# a branch ahead of its upstream, a branch behind it, and uncommitted changes.
set -euo pipefail
dir=${1:?usage: make-demo-repo.sh <dir>}
rm -rf "$dir" "$dir-origin"
mkdir -p "$dir-origin" && cd "$dir-origin"
git init -q -b main && git config user.name "Ada Lovelace" && git config user.email ada@example.com
c() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qam "$2" ${3:+--author="$3"}; }
printf 'fn main() {\n    println!("hello");\n}\n' > main.rs; printf '# Demo\n\nA demo repository.\n' > README.md; git add .; c 2026-09-01T10:00 "Initial commit"
printf 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n' > math.rs; git add math.rs; c 2026-09-02T10:00 "Add math module"
git tag v0.1.0
git checkout -qb feature/parser
printf 'pub fn parse(s: &str) -> Vec<&str> {\n    s.split_whitespace().collect()\n}\n' > parser.rs; git add parser.rs; c 2026-09-03T11:00 "Add a whitespace parser" "Grace Hopper <grace@example.com>"
printf "pub fn parse(s: &str) -> Vec<&str> {\n    s.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect()\n}\n" > parser.rs; c 2026-09-04T11:00 "Parser: split on commas too" "Grace Hopper <grace@example.com>"
git checkout -q main; printf 'fn main() {\n    println!("hello, world");\n}\n' > main.rs; c 2026-09-03T15:00 "Greet the world"
git checkout -qb fix/readme; printf '# Demo\n\nA demo repository for Rebased Lite.\n\n## Build\n\n    cargo build\n' > README.md; c 2026-09-05T09:00 "Document the build" "Linus T <linus@example.com>"
git checkout -q main; GIT_AUTHOR_DATE=2026-09-06T10:00 GIT_COMMITTER_DATE=2026-09-06T10:00 git merge -q --no-ff feature/parser -m "Merge branch 'feature/parser'"
git mv math.rs arith.rs; sed -i.bak 's/a + b/a.wrapping_add(b)/' arith.rs && rm arith.rs.bak; c 2026-09-07T10:00 "Rename math to arith and use wrapping add"
GIT_AUTHOR_DATE=2026-09-07T12:00 GIT_COMMITTER_DATE=2026-09-07T12:00 git merge -q --no-ff fix/readme -m "Merge branch 'fix/readme'"
git tag -a v0.2.0 -m "Release 0.2.0"
git checkout -qb feature/cli; printf 'pub fn run(args: &[String]) {\n    for a in args { println!("{a}"); }\n}\n' > cli.rs; git add cli.rs; c 2026-09-08T12:00 "Add a CLI entry point" "Grace Hopper <grace@example.com>"
git checkout -q main; head -c 3000 /dev/urandom > logo.bin; git add logo.bin; c 2026-09-09T10:00 "Add a binary logo"
git clone -q "$dir-origin" "$dir" && cd "$dir"
git config user.name "Ada Lovelace" && git config user.email ada@example.com
git checkout -q -b feature/cli origin/feature/cli
echo '    // local change not pushed' >> cli.rs; GIT_AUTHOR_DATE=2026-09-09T12:00 GIT_COMMITTER_DATE=2026-09-09T12:00 git commit -qam "Print arguments one per line"
git checkout -q main
echo 'fn helper() {}' >> main.rs; echo notes > NOTES.txt
cd "$dir-origin" && echo "- upstream note" >> README.md && c 2026-09-10T10:00 "Update README upstream"
cd "$dir" && git fetch -q
echo "demo repository: $dir"
