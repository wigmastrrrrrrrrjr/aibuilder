use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct LoginResp {
    pub token: Option<String>,
    pub username: Option<String>,
    #[serde(rename = "tfaRequired")]
    pub tfa_required: Option<bool>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportFile {
    pub path: String,
    pub content: Option<String>,
    pub encoding: Option<String>,
    #[serde(rename = "updated_at")]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportResp {
    pub name: String,
    pub files: Vec<ExportFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMeta {
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub model: Option<String>,
}

/// Raw SSE wire event parsed out of `data: {...}` lines.
#[derive(Debug, Clone)]
pub enum SseEvent {
    Meta(ChatMeta),
    Token(String),
    FileCow(String),     // file/edit/asset/subagent handled the same: a written path
    Delete(String),
    Rename(String, String),
    Name(String),
    Warn(String),
    Error(String),
    Done(DoneInfo),
    Other(serde_json::Value),
}

#[derive(Debug, Clone, Default)]
pub struct DoneInfo {
    pub files: Vec<String>,
    pub edited: Vec<String>,
    pub deleted: Vec<String>,
    pub renamed: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_token_event() {
        let ev = crate::client::parse_event(&json!({ "type": "token", "v": "hello" }));
        match ev {
            Some(SseEvent::Token(v)) => assert_eq!(v, "hello"),
            other => panic!("expected token, got {:?}", other.map(|_| "other")),
        }
    }

    #[test]
    fn parses_meta_with_project() {
        let ev = crate::client::parse_event(&json!({
            "type": "meta", "projectId": "abc123", "model": "gemma4:31b"
        }));
        match ev {
            Some(SseEvent::Meta(m)) => {
                assert_eq!(m.project_id.as_deref(), Some("abc123"));
                assert_eq!(m.model.as_deref(), Some("gemma4:31b"));
            }
            other => panic!("expected meta, got {:?}", other.map(|_| "other")),
        }
    }

    #[test]
    fn file_edit_asset_subagent_are_writes() {
        for t in ["file", "edit", "asset", "subagent"] {
            let ev = crate::client::parse_event(&json!({ "type": t, "path": "src/x.js" }));
            match ev {
                Some(SseEvent::FileCow(p)) => assert_eq!(p, "src/x.js"),
                other => panic!("{t}: expected FileCow, got {:?}", other.map(|_| "other")),
            }
        }
    }

    #[test]
    fn done_collects_counts() {
        let ev = crate::client::parse_event(&json!({
            "type": "done",
            "files": ["a.html"], "edited": ["b.js"], "deleted": ["c.txt"], "renamed": ["d"]
        }));
        match ev {
            Some(SseEvent::Done(d)) => {
                assert_eq!(d.files, vec!["a.html"]);
                assert_eq!(d.edited, vec!["b.js"]);
                assert_eq!(d.deleted, vec!["c.txt"]);
                assert_eq!(d.renamed, vec!["d"]);
            }
            other => panic!("expected done, got {:?}", other.map(|_| "other")),
        }
    }
}