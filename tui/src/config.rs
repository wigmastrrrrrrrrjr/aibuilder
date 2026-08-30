use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub base: String,
    pub token: String,
    pub username: String,
    pub project_id: String,
    pub model: String,
}

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("aib")
        .join("config.json")
}

pub fn load() -> Config {
    let p = config_path();
    if let Ok(data) = std::fs::read_to_string(&p) {
        if let Ok(mut c) = serde_json::from_str::<Config>(&data) {
            if c.base.is_empty() {
                c.base = crate::client::DEFAULT_BASE.to_string();
            }
            return c;
        }
    }
    Config {
        base: crate::client::DEFAULT_BASE.to_string(),
        ..Default::default()
    }
}

pub fn save(c: &Config) -> std::io::Result<()> {
    let p = config_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(c).unwrap_or_else(|_| "{}".to_string()))
}