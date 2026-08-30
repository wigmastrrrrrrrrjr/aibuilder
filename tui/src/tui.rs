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
use tokio::sync::mpsc;

pub enum UiEvent {
    Meta(String, String),      // projectId, model
    Token(String),
    File(String),
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
    input: String,
    scroll: u16,
    busy: bool,
    out_dir: PathBuf,
    rx: mpsc::UnboundedReceiver<UiEvent>,
    tx: mpsc::UnboundedSender<UiEvent>,
    status: String,
}

impl App {
    fn new(cfg: Config) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let out_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut status = format!("logged in as {}", cfg.username);
        if cfg.project_id.is_empty() {
            status.push_str(" — no project yet (just chat! a new project is created for you)");
        } else {
            status.push_str(&format!(" — project {}", cfg.project_id));
        }
        App {
            cfg,
            log: vec![
                "aib — terminal app builder".to_string(),
                "type a message to build, or /help for commands".to_string(),
            ],
            files: Vec::new(),
            input: String::new(),
            scroll: 0,
            busy: false,
            out_dir,
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
        self.status = "working…".to_string();

        let base = self.cfg.base.clone();
        let token = self.cfg.token.clone();
        let pid = self.cfg.project_id.clone();
        let model = self.cfg.model.clone();
        let tx = self.tx.clone();

        tokio::spawn(async move {
            let c = Client::new(&base, Some(token));
            let res = c
                .chat(&pid, &msg, &model, |ev| {
                    let ui = match ev {
                        crate::api::SseEvent::Meta(m) => {
                            UiEvent::Meta(m.project_id.unwrap_or_default(), m.model.unwrap_or_default())
                        }
                        crate::api::SseEvent::Token(v) => {
                            if v.trim().is_empty() { return; }
                            UiEvent::Token(v)
                        }
                        crate::api::SseEvent::FileCow(p) => UiEvent::File(p),
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
                            UiEvent::Done(bits.join(" · ").to_string())
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
                self.log("commands: /help /new <name> /model <m> /out <dir> /ls /refresh /logout /quit");
            }
            "new" => {
                let name = if arg.is_empty() { "New app".to_string() } else { arg };
                self.cfg.project_id.clear();
                self.log(format!("new project: {} (created on next message)", name));
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
            "out" => {
                if arg.is_empty() {
                    self.log(format!("output dir: {}", self.out_dir.display()));
                } else {
                    self.out_dir = PathBuf::from(arg);
                    self.log(format!("output dir: {}", self.out_dir.display()));
                }
            }
            "ls" => {
                if self.files.is_empty() {
                    self.log("no files yet");
                } else {
                    let lines: Vec<String> = self.files.iter().map(|f| f.clone()).collect();
                    for f in lines {
                        self.log(format!("  {}", f));
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
                self.cfg.project_id.clear();
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
                UiEvent::Meta(pid, model) => {
                    if !pid.is_empty() {
                        self.cfg.project_id = pid.clone();
                        let _ = crate::config::save(&self.cfg);
                    }
                    if !model.is_empty() {
                        self.config_model(&model);
                    }
                    self.status = format!("project {} · {}", pid, model);
                }
                UiEvent::Token(_v) => self.status.push_str("▊"),
                UiEvent::File(p) => self.add_file(p),
                UiEvent::Delete(p) => {
                    self.files.retain(|f| f != &p);
                    self.log(format!("[deleted] {}", p));
                }
                UiEvent::Rename(a, b) => {
                    for f in self.files.iter_mut() {
                        if f == &a { *f = b.clone(); }
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
                    self.busy = false;
                    self.status = "ready — files written below".to_string();
                    self.materialize_after_turn();
                }
                UiEvent::End(_) => {
                    if self.busy {
                        // stream closed without a done event
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

    fn materialize_after_turn(&mut self) {
        let pid = self.cfg.project_id.clone();
        let base = self.cfg.base.clone();
        let token = self.cfg.token.clone();
        let out_dir = self.out_dir.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let c = Client::new(&base, Some(token));
            match c.export(&pid).await {
                Ok(exp) => match materialize(&exp, &out_dir) {
                    Ok(n) => {
                        let _ = tx.send(UiEvent::Error(format!(
                            "exported {} files into {}",
                            n,
                            out_dir.display()
                        )));
                    }
                    Err(e) => {
                        let _ = tx.send(UiEvent::Error(format!("export failed: {}", e)));
                    }
                },
                Err(e) => {
                    let _ = tx.send(UiEvent::Error(format!("export failed: {}", e)));
                }
            }
        });
    }
}

fn b64decode(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    B64.decode(s).ok()
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
    if !app.cfg.project_id.is_empty() {
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
        Span::raw(" · out:"),
        Span::styled(app.out_dir.display().to_string(), Style::default().fg(Color::Magenta)),
        Span::raw(" · /quit to exit "),
    ]);
    f.render_widget(Paragraph::new(status), areas[2]);
}

fn cursor_pos(area: Rect, input: &str) -> (u16, u16) {
    let col = area.x + 1 + input.chars().count() as u16;
    (col.min(area.right().saturating_sub(2)), area.y + 1)
}