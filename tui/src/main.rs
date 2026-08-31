mod api;
mod client;
mod config;
mod tui;
mod update;

use client::Client;

const USAGE: &str = "aib — terminal client for the aibuilder API

USAGE:
  aib                          start the interactive terminal REPL
  aib login                    log in (stores session in ~/.config/aib/config.json)
  aib projects                 list your projects
  aib export <project-id>      write every project file into ./<name>
  aib update                   check for and install a newer aib build

OPTIONS:
  --base <url>   API base (default https://aibuilderapi.csomeone301.workers.dev)
";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V" || a == "version") {
        println!("aib {} (aibuilder terminal client)", VERSION);
        return;
    }
    let mut base = client::DEFAULT_BASE.to_string();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--base" && i + 1 < args.len() {
            base = args[i + 1].clone();
            i += 2;
        } else {
            i += 1;
        }
    }

    let mut cfg = config::load();
    if cfg.base.is_empty() {
        cfg.base = base.clone();
    }

    let sub = args.iter().map(|s| s.as_str())
        .find(|a| *a != "--base" && !a.starts_with("--"))
        .map(str::to_string);

    // Full self-update / explicit update command: check immediately.
    if sub.as_deref() == Some("update") {
        update::set_to().await;
        return;
    }

    // Background-friendly: silent, throttled one-per-day check on startup.
    // Skipped entirely for the version/login/projects/export one-shot commands.
    if sub.is_none() || sub.as_deref() == Some("login") {
        update::maybe_check().await;
    }

    match sub.as_deref() {
        Some("login") | None if cfg.token.is_empty() => {
            if sub.is_none() && !cfg.token.is_empty() {
                // already logged in — straight to REPL
                tui::run(cfg).await;
                return;
            }
            do_login(&base, &mut cfg).await;
            tui::run(cfg).await;
        }
        Some("login") => {
            do_login(&base, &mut cfg).await;
        }
        Some("projects") => {
            let c = Client::new(&base, Some(cfg.token.clone()));
            match c.list_projects().await {
                Ok(ps) => {
                    for p in ps {
                        println!("{}  {}", p.id, p.name);
                    }
                }
                Err(e) => { eprintln!("error: {}", e); std::process::exit(1); }
            }
        }
        Some("export") => {
            let pid = args.iter().skip(1).find(|a| !a.starts_with("--") && a.as_str() != "export");
            let Some(pid) = pid else { eprintln!("usage: aib export <project-id>"); std::process::exit(1); };
            let c = Client::new(&base, Some(cfg.token.clone()));
            match c.export(pid).await {
                Ok(exp) => {
                    let root = std::path::PathBuf::from(format!("./{}", exp.name));
                    match tui::materialize(&exp, &root) {
                        Ok(written) => println!("exported {} files into ./{}", written, exp.name),
                        Err(e) => { eprintln!("write error: {}", e); std::process::exit(1); }
                    }
                }
                Err(e) => { eprintln!("error: {}", e); std::process::exit(1); }
            }
        }
        Some(other) => {
            eprintln!("unknown command: {}", other);
            eprintln!("{}", USAGE);
            std::process::exit(2);
        }
        None => {
            // token set but bare `aib` — handled above by the guard
            tui::run(cfg).await;
        }
    }
}

async fn do_login(base: &str, cfg: &mut config::Config) {
    let c = Client::new(base, None);
    let mut user = String::new();
    let mut pass = String::new();
    print!("username: ");
    std::io::Write::flush(&mut std::io::stdout()).expect("flush");
    std::io::stdin().read_line(&mut user).expect("read");
    print!("password: ");
    std::io::Write::flush(&mut std::io::stdout()).expect("flush");
    std::io::stdin().read_line(&mut pass).expect("read");
    let user = user.trim().to_string();
    let pass = pass.trim_end_matches(['\n', '\r']).to_string();

    match c.login(&user, &pass).await {
        Ok(r) => {
            if r.tfa_required == Some(true) {
                eprintln!("2FA is required for this account — sign in through the web app instead.");
                std::process::exit(1);
            }
            if let Some(err) = r.error {
                eprintln!("login failed: {}", err);
                std::process::exit(1);
            }
            let token = r.token.unwrap_or_default();
            if token.is_empty() {
                eprintln!("login failed: server returned no session token.");
                std::process::exit(1);
            }
            cfg.token = token;
            cfg.username = r.username.unwrap_or(user);
            cfg.base = base.to_string();
            if let Err(e) = config::save(cfg) {
                eprintln!("warning: could not save config: {}", e);
            }
            println!("logged in as {}", cfg.username);
        }
        Err(e) => {
            eprintln!("login failed: {}", e);
            std::process::exit(1);
        }
    }
}