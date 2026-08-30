use crate::api::{HistoryMsg, WorkspaceFile};
use crate::client::Client;
use crate::config::Config;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Terminal;
use std::io::stdout;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

const MAX_FILE_BYTES: u64 = 512 * 1024; // per file cap for context
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024; // total context cap
const MAX_FILES: usize = 200;

pub enum UiEvent {
    Meta(String, String),      // model, status
    Token(String),
    Write { path: String, content: Option<String>, encoding: Option<String> },
    Delete(String),
    Rename(String, String),
    Warn(String),
    Error(String),
    Done(String),              // summary line
    End(String),               // stream closed cleanly
}

pub struct App {
    cfg: Config,
    log: Vec<String>,
    files: Vec<String>,
    history: Vec<HistoryMsg>,
    assistant_buf: String,
    last_user_msg: String,
    input: String,
    scroll: u16,
    busy: bool,
    in_dir: PathBuf,
    rx: mpsc::UnboundedReceiver<UiEvent>,
    tx: mpsc::UnboundedSender<UiEvent>,
    status: String,
}

impl App {
    fn new(cfg: Config) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let in_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let files = gather_workspace_files(&in_dir);
        let mut status = format!("logged in as {} — workspace agent", cfg.username);
        status.push_str(&format!(" ({} files in {})", files.len(), in_dir.display()));
        App {
            cfg,
            log: vec![
                "aib — terminal coding agent".to_string(),
                "type a message to edit files, or /help for commands".to_string(),
            ],
            files: files.iter().map(|f| f.path.clone()).collect(),
            history: Vec::new(),
            assistant_buf: String::new(),
            last_user_msg: String::new(),
            input: String::new(),
            scroll: 0,
            busy: false,
            in_dir,
            rx,
            tx,
            status,
        }
    }

    fn log(&mut self, s: impl Into<String>) {
        let s = s.into();
        self.log.push(s);
        if self.log.len() > 2000 {
            self.log.drain(..self.log.len() - 2000);
        }
    }

    fn add_file(&mut self, p: String) {
        if !self.files.iter().any(|f| f == &p) {
            self.files.push(p.clone());
        }
        self.log(format!("[wrote] {}", p));
    }

    fn submit(&mut self) {
        let msg = self.input.trim().to_string();
        if msg.is_empty() || self.busy {
            return;
        }

        if let Some(cmd) = msg.strip_prefix('/') {
            self.input.clear();
            self.handle_command(cmd);
            return;
        }

        self.input.clear();
        self.log(format!("> {}", msg));
        self.busy = true;
        self.assistant_buf.clear();
        self.last_user_msg = msg.clone();
        self.status = "working…".to_string();

        let base = self.cfg.base.clone();
        let token = self.cfg.token.clone();
        let model = self.cfg.model.clone();
        let in_dir = self.in_dir.clone();
        let history = self.history.clone();
        let tx = self.tx.clone();

        tokio::spawn(async move {
            let c = Client::new(&base, Some(token));
            let files = gather_workspace_files(&in_dir);
            let res = c
                .workspace_chat(&files, &history, &msg, &model, |ev| {
                    let ui = match ev {
                        crate::api::SseEvent::Meta(m) => UiEvent::Meta(
                            m.model.unwrap_or_default(),
                            String::new(),
                        ),
                        crate::api::SseEvent::Token(v) => {
                            if v.trim().is_empty() { return; }
                            UiEvent::Token(v)
                        }
                        crate::api::SseEvent::Write { path, content, encoding } => {
                            UiEvent::Write { path, content, encoding }
                        }
                        crate::api::SseEvent::Delete(p) => UiEvent::Delete(p),
                        crate::api::SseEvent::Rename(a, b) => UiEvent::Rename(a, b),
                        crate::api::SseEvent::Warn(m) => UiEvent::Warn(m),
                        crate::api::SseEvent::Error(m) => UiEvent::Error(m),
                        crate::api::SseEvent::Done(d) => {
                            let mut bits = Vec::new();
                            if !d.files.is_empty() { bits.push(format!("{} written", d.files.len())); }
                            if !d.edited.is_empty() { bits.push(format!("{} edited", d.edited.len())); }
                            if !d.deleted.is_empty() { bits.push(format!("{} removed", d.deleted.len())); }
                            if !d.renamed.is_empty() { bits.push(format!("{} renamed", d.renamed.len())); }
                            UiEvent::Done(bits.join(" · "))
                        }
                        _ => return,
                    };
                    let _ = tx.send(ui);
                })
                .await;
            match res {
                Ok(()) => { let _ = tx.send(UiEvent::End("done".to_string())); }
                Err(e) => { let _ = tx.send(UiEvent::Error(format!("{}", e))); }
            }
        });
    }

    fn handle_command(&mut self, cmd: &str) {
        let mut parts = cmd.splitn(2, ' ');
        let name = parts.next().unwrap_or("").to_lowercase();
        let arg = parts.next().unwrap_or("").trim().to_string();
        match name.as_str() {
            "help" => {
                self.log("commands: /help /model <m> /cd <dir> /ls /clear /refresh /history /logout /quit");
            }
            "model" => {
                if arg.is_empty() {
                    self.log(format!("model: {}", self.cfg.model));
                } else {
                    self.cfg.model = arg.clone();
                    let _ = crate::config::save(&self.cfg);
                    self.log(format!("model set: {}", arg));
                }
            }
            "cd" => {
                if arg.is_empty() {
                    self.log(format!("working dir: {}", self.in_dir.display()));
                } else {
                    let p = PathBuf::from(&arg);
                    if p.is_dir() {
                        self.in_dir = p;
                        self.files = gather_workspace_files(&self.in_dir).iter().map(|f| f.path.clone()).collect();
                        self.log(format!("working dir: {}", self.in_dir.display()));
                    } else {
                        self.log(format!("{}: not a directory", arg));
                    }
                }
            }
            "ls" => {
                if self.files.is_empty() {
                    self.log("no text files in workspace (binary/huge files are skipped)");
                } else {
                    for f in self.files.clone() {
                        self.log(format!("  {}", f));
                    }
                }
            }
            "clear" => {
                self.files.clear();
                self.log("file list cleared — files are re-scanned on next message");
            }
            "history" => {
                if self.history.is_empty() {
                    self.log("no history yet");
                } else {
                    self.log(format!("{} history messages", self.history.len()));
                    let start = self.history.len().saturating_sub(10);
                    let recent: Vec<(String, String)> = self.history[start..]
                        .iter()
                        .map(|m| (m.role.clone(), m.content.chars().take(80).collect()))
                        .collect();
                    for (role, text) in recent {
                        let label = if role == "user" { "you" } else { "aib" };
                        self.log(format!("  [{label}] {}", text));
                    }
                }
            }
            "refresh" => {
                self.busy = false;
                self.status = "ready".to_string();
                self.log("reset completed");
            }
            "logout" => {
                self.cfg.token.clear();
                self.cfg.username.clear();
                let _ = crate::config::save(&self.cfg);
                self.log("logged out. run `aib login` to sign in again.");
            }
            "quit" => { std::process::exit(0); }
            _ => self.log(format!("unknown command: /{name} — /help for options")),
        }
    }

    fn drain_events(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                UiEvent::Meta(model, _extra) => {
                    if !model.is_empty() {
                        self.config_model(&model);
                    }
                    self.status = format!("workspace agent · model {}", model);
                }
                UiEvent::Token(v) => {
                    self.assistant_buf.push_str(&v);
                    self.status.push('▊');
                }
                UiEvent::Write { path, content, encoding } => {
                    self.apply_write(&path, content, encoding);
                }
                UiEvent::Delete(p) => {
                    self.files.retain(|f| f != &p);
                    let _ = safe_join(&self.in_dir, &p).map(|target| { let _ = std::fs::remove_file(target); });
                    self.log(format!("[deleted] {}", p));
                }
                UiEvent::Rename(a, b) => {
                    for f in self.files.iter_mut() {
                        if f == &a { *f = b.clone(); }
                    }
                    if let (Ok(src), Ok(dst)) = (safe_join(&self.in_dir, &a), safe_join(&self.in_dir, &b)) {
                        if let Some(parent) = dst.parent() { let _ = std::fs::create_dir_all(parent); }
                        let _ = std::fs::rename(&src, &dst);
                    }
                    self.log(format!("[renamed] {} → {}", a, b));
                }
                UiEvent::Warn(m) => self.log(format!("[warn] {}", m)),
                UiEvent::Error(m) => {
                    self.log(format!("[error] {}", m));
                    self.busy = false;
                    self.status = "error — /refresh to continue".to_string();
                }
                UiEvent::Done(sum) => {
                    self.log(format!("[done] {}", sum));
                    self.push_history("user".into(), self.last_user_msg.clone());
                    self.push_history("assistant".into(), self.assistant_buf.clone());
                    self.busy = false;
                    self.status = "ready — edits applied to disk".to_string();
                    // re-scan so the file list matches disk
                    self.files = gather_workspace_files(&self.in_dir).iter().map(|f| f.path.clone()).collect();
                }
                UiEvent::End(_) => {
                    if self.busy {
                        self.status = "stream ended".to_string();
                        self.busy = false;
                    }
                }
            }
        }
    }

    fn config_model(&mut self, m: &str) {
        if self.cfg.model.is_empty() || !m.is_empty() {
            self.cfg.model = m.to_string();
        }
    }

    fn push_history(&mut self, role: String, content: String) {
        self.history.push(HistoryMsg { role, content });
        if self.history.len() > 100 {
            self.history.drain(..self.history.len() - 100);
        }
    }

    fn apply_write(&mut self, path: &str, content: Option<String>, encoding: Option<String>) {
        let Some(content) = content else {
            self.add_file(path.to_string());
            return;
        };
        let Ok(target) = safe_join(&self.in_dir, path) else { return; };
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let bytes = if encoding.as_deref() == Some("base64") || encoding.as_deref() == Some("data") {
            if let Some(idx) = content.find(";base64,") {
                b64decode(&content[idx + 8..])
            } else {
                b64decode(&content)
            }
        } else {
            None
        };
        let written = match bytes {
            Some(b) => std::fs::write(&target, b),
            None => std::fs::write(&target, content.as_bytes()),
        };
        if written.is_ok() {
            self.add_file(path.to_string());
        } else {
            self.log(format!("[error] failed to write {}: {}", path, written.unwrap_err()));
        }
    }
}

fn b64decode(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    B64.decode(s).ok()
}

/// Join a workspace-relative path to `root`, refusing escapes.
fn safe_join(root: &Path, rel: &str) -> std::io::Result<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsafe path"));
    }
    Ok(root.join(p))
}

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__", ".aib"];

fn is_binary(buf: &[u8]) -> bool {
    let n = buf.len().min(8000);
    buf[..n].iter().any(|&b| b == 0)
}

/// Walk the workspace, returning text files (with content) suitable as chat
/// context. Skips VCS dirs, generated dirs, binary files and oversized files.
fn gather_workspace_files(root: &Path) -> Vec<WorkspaceFile> {
    let mut out: Vec<WorkspaceFile> = Vec::new();
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_FILES || total >= MAX_TOTAL_BYTES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            if out.len() >= MAX_FILES || total >= MAX_TOTAL_BYTES {
                break;
            }
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().into_owned();
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().into_owned();
            if rel.is_empty() { continue; }
            let Ok(ft) = ent.file_type() else { continue };
            if ft.is_dir() {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(p);
            } else if ft.is_file() {
                if name.starts_with('.') || rel.contains("/.git/") { continue; }
                let Ok(meta) = ent.metadata() else { continue };
                if meta.len() == 0 || meta.len() > MAX_FILE_BYTES { continue; }
                total += meta.len();
                let Ok(bytes) = std::fs::read(&p) else { continue };
                if is_binary(&bytes) { continue; }
                let Ok(text) = String::from_utf8(bytes) else { continue };
                out.push(WorkspaceFile { path: rel, content: text });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Write an export to disk, guarding against path traversal.
pub fn materialize(exp: &crate::api::ExportResp, root: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(root)?;
    let mut n = 0usize;
    for f in &exp.files {
        let rel = Path::new(&f.path);
        if rel.is_absolute() || rel.components().any(|c| c == std::path::Component::ParentDir) {
            continue; // refuse to escape the output dir
        }
        let target = root.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = match f.content.as_deref() {
            None => Vec::new(),
            Some(s) => {
                if f.encoding.as_deref() == Some("base64") {
                    b64decode(s).unwrap_or_else(|| s.as_bytes().to_vec())
                } else {
                    s.as_bytes().to_vec()
                }
            }
        };
        std::fs::write(&target, content)?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ExportFile;

    fn tmpdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("aib-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn materialize_writes_nested_files() {
        let exp = crate::api::ExportResp {
            name: "t".to_string(),
            files: vec![
                ExportFile { path: "index.html".into(), content: Some("<h1>x</h1>".into()), encoding: None, updated_at: None },
                ExportFile { path: "src/app.js".into(), content: Some("console.log(1)".into()), encoding: Some("utf8".into()), updated_at: None },
                ExportFile { path: "pic.png".into(), content: Some("aGVsbG8=".into()), encoding: Some("base64".into()), updated_at: None },
            ],
        };
        let root = tmpdir();
        let n = materialize(&exp, &root).unwrap();
        assert_eq!(n, 3);
        assert_eq!(std::fs::read_to_string(root.join("index.html")).unwrap(), "<h1>x</h1>");
        assert_eq!(std::fs::read_to_string(root.join("src/app.js")).unwrap(), "console.log(1)");
        assert_eq!(std::fs::read_to_string(root.join("pic.png")).unwrap(), "hello");
    }

    #[test]
    fn materialize_blocks_path_traversal() {
        let exp = crate::api::ExportResp {
            name: "t".to_string(),
            files: vec![
                ExportFile { path: "../escape.txt".into(), content: Some("nope".into()), encoding: None, updated_at: None },
                ExportFile { path: "/abs.txt".into(), content: Some("nope".into()), encoding: None, updated_at: None },
                ExportFile { path: "ok.txt".into(), content: Some("yes".into()), encoding: None, updated_at: None },
            ],
        };
        let root = tmpdir();
        let n = materialize(&exp, &root).unwrap();
        assert_eq!(n, 1);
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        assert!(!Path::new("/abs.txt").exists());
        assert_eq!(std::fs::read_to_string(root.join("ok.txt")).unwrap(), "yes");
    }
}

pub async fn run(cfg: Config) {
    let mut app = App::new(cfg);

    enable_raw_mode().expect("raw mode");
    let mut stdout = stdout();
    execute!(stdout, EnterAlternateScreen).expect("alt screen");
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).expect("terminal");

    loop {
        terminal.draw(|f| ui(f, &mut app)).expect("draw");

        if event::poll(std::time::Duration::from_millis(50)).expect("poll") {
            if let Event::Key(k) = event::read().expect("read") {
                if handle_key(&mut app, k) {
                    break;
                }
            }
        }
        app.drain_events();
    }

    disable_raw_mode().expect("raw mode");
    execute!(terminal.backend_mut(), LeaveAlternateScreen).expect("leave alt");
    if !app.cfg.model.is_empty() {
        let _ = crate::config::save(&app.cfg);
    }
}

/// Returns true to quit.
fn handle_key(app: &mut App, k: KeyEvent) -> bool {
    match k.code {
        KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
            if app.busy {
                app.busy = false;
                app.status = "interrupted".to_string();
                false
            } else {
                true
            }
        }
        KeyCode::Enter => {
            app.submit();
            false
        }
        KeyCode::Backspace => {
            app.input.pop();
            false
        }
        KeyCode::Char(c) => {
            app.input.push(c);
            false
        }
        KeyCode::PageUp => {
            app.scroll = app.scroll.saturating_add(10);
            false
        }
        KeyCode::PageDown => {
            app.scroll = app.scroll.saturating_sub(10);
            false
        }
        _ => false,
    }
}

fn ui(f: &mut ratatui::Frame, app: &mut App) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(f.area());

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(75), Constraint::Percentage(25)])
        .split(areas[0]);

    // chat log
    let title = format!(" chat — {} ", if app.busy { "working…" } else { "ready" });
    let log_text: Vec<Line> = {
        let start = app.log.len().saturating_sub((app.scroll as usize) + 0);
        let _ = start;
        app.log.iter().map(|l| Line::from(Span::styled(
            l.clone(),
            if l.starts_with("> ") {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else if l.starts_with('[') {
                Style::default().fg(Color::Green)
            } else {
                Style::default()
            },
        ))).collect()
    };
    let log_par = Paragraph::new(log_text)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false })
        .scroll((app.scroll, 0));
    f.render_widget(log_par, main[0]);

    // file list
    let files_text: Vec<Line> = app.files.iter().map(|p| Line::from(Span::styled(
        p.clone(), Style::default().fg(Color::Yellow),
    ))).collect();
    let files_par = Paragraph::new(files_text)
        .block(Block::default().borders(Borders::ALL).title(" files "))
        .wrap(Wrap { trim: false });
    f.render_widget(files_par, main[1]);

    // input
    let input_par = Paragraph::new(app.input.as_str())
        .block(Block::default().borders(Borders::ALL).title(" prompt "))
        .style(if app.busy { Style::default().fg(Color::DarkGray) } else { Style::default() });
    f.render_widget(input_par, areas[1]);
    if !app.busy {
        f.set_cursor_position(cursor_pos(areas[1], &app.input));
    }

    // status bar
    let status = Line::from(vec![
        Span::raw(" "),
        Span::styled(&app.status, Style::default().fg(Color::Blue)),
        Span::raw(" · in:"),
        Span::styled(app.in_dir.display().to_string(), Style::default().fg(Color::Magenta)),
        Span::raw(" · /quit to exit "),
    ]);
    f.render_widget(Paragraph::new(status), areas[2]);
}

fn cursor_pos(area: Rect, input: &str) -> (u16, u16) {
    let col = area.x + 1 + input.chars().count() as u16;
    (col.min(area.right().saturating_sub(2)), area.y + 1)
}