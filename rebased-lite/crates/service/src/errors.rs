//! The kinds of errors, so the front end can say what to do. Git reports errors as text, so the kind
//! comes from the text. The patterns are the messages of git, ssh and the backend.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The remote wants a user name, a password or a key, or refused them.
    Auth,
    /// The remote refused a push: it has commits that the branch does not have.
    Rejected,
    /// A merge, rebase, cherry-pick, revert or stash stopped at conflicts.
    Conflict,
    /// Another git process holds a lock file of the repository.
    Locked,
    /// The remote cannot be reached.
    Network,
    /// The repository, the revision or the file does not exist.
    NotFound,
    Other,
}

const PATTERNS: &[(ErrorKind, &[&str])] = &[
    (
        ErrorKind::Auth,
        &["authentication failed", "could not read username", "could not read password", "permission denied (publickey", "access denied", "terminal prompts disabled", "the requested url returned error: 401", "the requested url returned error: 403"],
    ),
    (ErrorKind::Rejected, &["[rejected]", "non-fast-forward", "fetch first", "stale info", "was rejected"]),
    (ErrorKind::Locked, &[".lock': file exists", "index.lock", "another git process seems to be running"]),
    (
        ErrorKind::Network,
        &["could not resolve host", "connection refused", "connection timed out", "network is unreachable", "failed to connect", "could not read from remote repository"],
    ),
    (ErrorKind::Conflict, &["conflict"]),
    (ErrorKind::NotFound, &["is not open", "does not exist", "not a git repository", "no repository is open", "unknown revision", "bad revision"]),
];

pub fn classify(message: &str) -> ErrorKind {
    let m = message.to_lowercase();
    PATTERNS.iter().find(|(_, words)| words.iter().any(|w| m.contains(w))).map_or(ErrorKind::Other, |(k, _)| *k)
}

/// The JSON of a failed command: the message and its kind.
pub fn error_json(message: &str) -> serde_json::Value {
    serde_json::json!({ "error": message, "kind": classify(message) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(classify("fatal: Authentication failed for 'https://x/'"), ErrorKind::Auth);
        assert_eq!(classify("git@host: Permission denied (publickey)."), ErrorKind::Auth);
        assert_eq!(classify(" ! [rejected]        main -> main (fetch first)"), ErrorKind::Rejected);
        assert_eq!(classify("fatal: Unable to create '/r/.git/index.lock': File exists."), ErrorKind::Locked);
        assert_eq!(classify("fatal: unable to access 'https://x/': Could not resolve host: x"), ErrorKind::Network);
        assert_eq!(classify("The merge stopped at conflicts in 2 file(s)"), ErrorKind::Conflict);
        assert_eq!(classify("/no/repo is not open"), ErrorKind::NotFound);
        assert_eq!(classify("something else"), ErrorKind::Other);
    }
}
