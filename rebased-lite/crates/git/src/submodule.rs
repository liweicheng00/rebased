//! Submodules and Git LFS.
//!
//! A submodule shows in a diff as the text "Subproject commit <oid>", as in IntelliJ. A Git LFS file
//! shows with its real content when the object is in the local LFS store. Otherwise the diff shows the
//! pointer and a note.

use crate::ops::{safe, OpResult};
use crate::{FileContent, GitError, Repo, Result};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    /// `git submodule init` and `update` did not run yet.
    Uninitialized,
    /// The checked-out commit is the recorded commit.
    Clean,
    /// The checked-out commit is not the recorded commit.
    OtherCommit,
    /// The submodule has a merge conflict in the superproject.
    Conflict,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    /// The commit that the superproject records in its index.
    pub recorded: String,
    /// The commit that is checked out in the submodule. None when it is not initialized.
    pub current: Option<String>,
    pub state: SubmoduleState,
    /// The submodule has local changes of its own.
    pub dirty: bool,
    pub url: Option<String>,
}

const LFS_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1";

/// The oid and the size of a Git LFS pointer file.
pub fn lfs_pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if !bytes.starts_with(LFS_PREFIX) || bytes.len() > 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let oid = text.lines().find_map(|l| l.strip_prefix("oid sha256:"))?.trim();
    let size = text.lines().find_map(|l| l.strip_prefix("size "))?.trim().parse().ok()?;
    (oid.len() == 64 && oid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| (oid.to_string(), size))
}

fn text_of(s: &str) -> String {
    String::from_utf8_lossy(s.as_bytes()).trim().to_string()
}

impl Repo {
    /// The submodules of the working tree, from `git submodule status`.
    pub fn submodules(&self) -> Result<Vec<Submodule>> {
        if !self.root.join(".gitmodules").exists() {
            return Ok(Vec::new());
        }
        let raw = String::from_utf8_lossy(&self.git(&["submodule", "status"])?).into_owned();
        let mut out = Vec::new();
        for line in raw.lines().filter(|l| l.len() > 42) {
            let (flag, rest) = line.split_at(1);
            let mut parts = rest.split(' ');
            let (Some(oid), Some(path)) = (parts.next(), parts.next()) else { continue };
            let state = match flag {
                "-" => SubmoduleState::Uninitialized,
                "+" => SubmoduleState::OtherCommit,
                "U" => SubmoduleState::Conflict,
                _ => SubmoduleState::Clean,
            };
            let sub = Repo { root: self.root.join(path) };
            let current = (state != SubmoduleState::Uninitialized).then(|| sub.resolve("HEAD")).flatten();
            let recorded = if state == SubmoduleState::OtherCommit {
                self.gitlink(None, path).unwrap_or_else(|| oid.to_string())
            } else {
                oid.to_string()
            };
            let dirty = current.is_some() && sub.git(&["status", "--porcelain", "--untracked-files=no"]).is_ok_and(|b| !b.is_empty());
            let url = self
                .git(&["config", "-f", ".gitmodules", "--get", &format!("submodule.{}.url", self.submodule_name(path))])
                .ok()
                .map(|b| text_of(&String::from_utf8_lossy(&b)))
                .filter(|s| !s.is_empty());
            out.push(Submodule { path: path.to_string(), recorded, current, state, dirty, url });
        }
        Ok(out)
    }

    fn submodule_name(&self, path: &str) -> String {
        let raw = self.git(&["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"]).unwrap_or_default();
        for line in String::from_utf8_lossy(&raw).lines() {
            if let Some((key, p)) = line.split_once(' ') {
                if p == path {
                    return key.trim_start_matches("submodule.").trim_end_matches(".path").to_string();
                }
            }
        }
        path.to_string()
    }

    /// The commit of a submodule in a commit, or in the index when `commit` is None. None when the path
    /// is not a submodule there.
    pub fn gitlink(&self, commit: Option<&str>, path: &str) -> Option<String> {
        let raw = match commit {
            Some(c) => self.git(&["ls-tree", "-z", c, "--", path]).ok()?,
            None => self.git(&["ls-files", "-s", "-z", "--", path]).ok()?,
        };
        let entry = raw.split(|&b| b == 0).next()?;
        let text = String::from_utf8_lossy(entry);
        let mut f = text.split_whitespace();
        if f.next()? != "160000" {
            return None;
        }
        // ls-tree: "<mode> commit <oid>"; ls-files: "<mode> <oid> <stage>".
        let second = f.next()?;
        Some(if second == "commit" { f.next()?.to_string() } else { second.to_string() })
    }

    /// Checks out the recorded commit of the submodules, and initializes them first. With no paths, all
    /// submodules. Nested submodules are updated too.
    pub fn update_submodules(&self, paths: &[String]) -> Result<OpResult> {
        let mut args = vec!["submodule", "update", "--init", "--recursive"];
        if !paths.is_empty() {
            args.push("--");
            for p in paths {
                args.push(safe(p)?);
            }
        }
        self.git_write(&args, &[]).map_err(|(out, e)| GitError(if out.is_empty() { e } else { format!("{e}\n{out}") }))?;
        Ok(OpResult::ok_msg(if paths.is_empty() {
            "Updated the submodules".to_string()
        } else {
            format!("Updated {} submodule{}", paths.len(), if paths.len() == 1 { "" } else { "s" })
        }))
    }

    /// The text that a diff shows for a submodule: the checked-out commit, as in `git diff`.
    pub(crate) fn submodule_content(&self, commit: Option<&str>, path: &str) -> Option<FileContent> {
        let text = match commit {
            Some(c) => format!("Subproject commit {}\n", self.gitlink(Some(c), path)?),
            None => {
                let dir = self.root.join(path);
                if !dir.join(".git").exists() {
                    // Not initialized: the recorded commit is all there is.
                    format!("Subproject commit {}\n", self.gitlink(None, path)?)
                } else {
                    let sub = Repo { root: dir };
                    let head = sub.resolve("HEAD")?;
                    let dirty = sub.git(&["status", "--porcelain"]).is_ok_and(|b| !b.is_empty());
                    format!("Subproject commit {head}{}\n", if dirty { "-dirty" } else { "" })
                }
            }
        };
        Some(FileContent { size: text.len(), text: Some(text), binary: false, missing: false, note: Some("Submodule".into()) })
    }

    /// The content of a Git LFS object from the local store, or None when it is not downloaded.
    pub(crate) fn lfs_object(&self, oid: &str) -> Option<Vec<u8>> {
        let custom = self.git(&["config", "--get", "lfs.storage"]).ok().map(|b| text_of(&String::from_utf8_lossy(&b))).filter(|s| !s.is_empty());
        let store = match custom {
            Some(s) if PathBuf::from(&s).is_absolute() => PathBuf::from(s).join("objects"),
            Some(s) => self.common_dir().join(s).join("objects"),
            None => self.common_dir().join("lfs").join("objects"),
        };
        std::fs::read(store.join(&oid[..2]).join(&oid[2..4]).join(oid)).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::lfs_pointer;

    #[test]
    fn pointers() {
        let oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
        let p = format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12345\n");
        assert_eq!(lfs_pointer(p.as_bytes()), Some((oid.to_string(), 12345)));
        assert_eq!(lfs_pointer(b"fn main() {}\n"), None);
        assert_eq!(lfs_pointer(b"version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 1\n"), None);
    }
}
