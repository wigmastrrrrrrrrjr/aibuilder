use crate::api::{self, SseEvent};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::Value;

pub const DEFAULT_BASE: &str = "https://aibuilderapi.csomeone301.workers.dev";

pub struct Client {
    pub base: String,
    pub token: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum ApiError {
    Http { status: u16, message: String },
    Network(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http { status, message } => write!(f, "HTTP {}: {}", status, message),
            ApiError::Network(m) => write!(f, "network error: {}", m),
        }
    }
}

impl Client {
    pub fn new(base: &str, token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("aib-terminal/0.1")
            .build()
            .expect("http client");
        Client { base: base.trim_end_matches('/').to_string(), token, http }
    }

    fn headers(&self, json: bool) -> HeaderMap {
        let mut h = HeaderMap::new();
        if json {
            h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        if let Some(t) = &self.token {
            if let Ok(hv) = HeaderValue::from_str(t) {
                h.insert("x-ab-sess", hv);
            }
        }
        h
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<api::LoginResp, ApiError> {
        let body = serde_json::json!({ "username": username, "password": password });
        let r = self.http.post(format!("{}/api/auth/login", self.base))
            .headers(self.headers(true))
            .body(body.to_string())
            .send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status >= 300 {
            return Err(ApiError::Http {
                status,
                message: parsed.get("error").and_then(|v| v.as_str()).unwrap_or(&text).to_string(),
            });
        }
        serde_json::from_value(parsed).map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn create_project(&self, name: &str) -> Result<api::Project, ApiError> {
        let body = serde_json::json!({ "name": name });
        let r = self.http.post(format!("{}/api/projects", self.base))
            .headers(self.headers(true))
            .body(body.to_string())
            .send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        if status >= 300 {
            return Err(ApiError::Http { status, message: text });
        }
        serde_json::from_str(&text).map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn export(&self, pid: &str) -> Result<api::ExportResp, ApiError> {
        let r = self.http.get(format!("{}/api/projects/{}/export", self.base, pid))
            .headers(self.headers(false))
            .send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        if status >= 300 {
            return Err(ApiError::Http { status, message: text });
        }
        serde_json::from_str(&text).map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn list_projects(&self) -> Result<Vec<api::Project>, ApiError> {
        let r = self.http.get(format!("{}/api/projects", self.base))
            .headers(self.headers(false))
            .send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        if status >= 300 {
            return Err(ApiError::Http { status, message: text });
        }
        serde_json::from_str(&text).map_err(|e| ApiError::Network(e.to_string()))
    }

    /// POST /api/chat and emit parsed SSE events as they arrive.
    pub async fn chat(
        &self,
        pid: &str,
        message: &str,
        model: &str,
        mut on_event: impl FnMut(SseEvent),
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "projectId": pid,
            "message": message,
            "model": model,
        });
        let mut res = self.http.post(format!("{}/api/chat", self.base))
            .headers(self.headers(true))
            .body(body.to_string())
            .send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = res.status().as_u16();
        if status >= 300 {
            let text = res.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            return Err(ApiError::Http {
                status,
                message: parsed.get("error").and_then(|v| v.as_str()).unwrap_or(&text).to_string(),
            });
        }

        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ApiError::Network(e.to_string()))?;
            buf.extend_from_slice(&chunk);
            // SSE events are separated by blank lines (\n\n). Hunt for complete events.
            let mut consumed = 0usize;
            loop {
                let text = String::from_utf8_lossy(&buf[consumed..]);
                if let Some(rel) = text.find("\n\n") {
                    let line = text[..rel].trim();
                    consumed += rel + 2;
                    if let Some(data) = line.strip_prefix("data:") {
                        if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                            if let Some(ev) = parse_event(&v) {
                                on_event(ev);
                            }
                        }
                    }
                } else {
                    break;
                }
            }
            if consumed > 0 {
                buf.drain(..consumed);
            }
        }
        Ok(())
    }
}

pub(crate) fn parse_event(v: &Value) -> Option<SseEvent> {
    let t = v.get("type").and_then(|x| x.as_str())?;
    match t {
        "meta" => Some(SseEvent::Meta(serde_json::from_value(v.clone()).ok()?)),
        "token" => Some(SseEvent::Token(v.get("v").and_then(|x| x.as_str()).unwrap_or("").to_string())),
        "file" | "edit" | "asset" | "subagent" => Some(SseEvent::FileCow(
            v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )),
        "delete" => Some(SseEvent::Delete(v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string())),
        "rename" => Some(SseEvent::Rename(
            v.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            v.get("to").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )),
        "name" => Some(SseEvent::Name(v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string())),
        "warn" => Some(SseEvent::Warn(v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string())),
        "error" => Some(SseEvent::Error(v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string())),
        "done" => Some(SseEvent::Done(parse_done(v))),
        _ => Some(SseEvent::Other(v.clone())),
    }
}

fn parse_done(v: &Value) -> api::DoneInfo {
    let list = |k: &str| -> Vec<String> {
        v.get(k).and_then(|x| x.as_array()).map(|a| {
            a.iter().filter_map(|i| i.as_str().map(|s| s.to_string())).collect()
        }).unwrap_or_default()
    };
    api::DoneInfo {
        files: list("files"),
        edited: list("edited"),
        deleted: list("deleted"),
        renamed: list("renamed"),
    }
}