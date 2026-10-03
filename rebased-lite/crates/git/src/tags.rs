//! The details of a tag: an annotated tag has its own message, tagger and date, and can be signed.

use crate::ops::safe;
use crate::{GitError, Repo, Result};
use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// False for a lightweight tag: a name for a commit, without a message.
    pub annotated: bool,
    /// The commit that the tag points to.
    pub commit: String,
    pub tagger: String,
    pub tagger_email: String,
    pub time: i64,
    pub subject: String,
    /// The message after the subject.
    pub body: String,
    /// The tag has a GPG, SSH or X.509 signature. Rebased Lite does not check it.
    pub signed: bool,
}

impl Repo {
    pub fn tag_info(&self, name: &str) -> Result<TagInfo> {
        let full = format!("refs/tags/{}", safe(name)?);
        let format = "--format=%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggername)%00%(taggeremail)%00%(taggerdate:unix)%00%(contents:subject)%00%(contents:body)%00%(contents:signature)%01";
        let out = self.git(&["for-each-ref", format, &full])?;
        let text = String::from_utf8_lossy(&out);
        let rec = text.split('\u{1}').next().unwrap_or("").trim_start_matches('\n');
        let f: Vec<&str> = rec.split('\0').collect();
        if f.len() < 9 {
            return Err(GitError(format!("There is no tag {name}")));
        }
        let annotated = f[0] == "tag";
        Ok(TagInfo {
            name: name.to_string(),
            annotated,
            commit: if annotated && !f[2].is_empty() { f[2] } else { f[1] }.to_string(),
            tagger: f[3].to_string(),
            tagger_email: f[4].trim_matches(|c| c == '<' || c == '>').to_string(),
            time: f[5].parse().unwrap_or(0),
            subject: if annotated { f[6].to_string() } else { String::new() },
            body: if annotated { f[7].trim_end().to_string() } else { String::new() },
            signed: !f[8].trim().is_empty(),
        })
    }
}
