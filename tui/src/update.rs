// Self-update for the `aib` terminal client.
//
// Releases are published to a rolling GitHub tag (e.g. `aib-latest`) whose
// version is embedded by the build. The updater queries GitHub for the latest
// release, compares versions semver-style, and if a newer build exists it
// downloads the asset for THIS platform and atomically replaces the running
// binary (Unix: rename over live binary; Windows: spawn a small .bat swap).
//
// Checks are throttled to once per ~24h so an interactive launch stays fast.

use std::path::PathBuf;

pub const REPO: &str = "wigmastrrrrrrrrjr/aibuilder";
pub const ASSET_PREFIX: &str = "aib-";

// Compile-time platform slug matching install.sh's asset names.
#[cfg(target_os = "android")]
const TARGET: &str = "aarch64-linux-android";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET: &str = "aarch64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-pc-windows-msvc";

const EXT: &str = if cfg!(target_os = "windows") { ".exe" } else { "" };

fn memo_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("aib")
        .join("update-check.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Memo {
    last: std::time::SystemTime,
}

fn last_checked() -> Option<std::time::SystemTime> {
    let p = memo_path();
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Memo>(&s).ok())
        .map(|m| m.last)
}

fn save_checked() {
    let p = memo_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let m = Memo { last: std::time::SystemTime::now() };
    let _ = std::fs::write(p, serde_json::to_string(&m).unwrap_or_default());
}

fn throttle_ok() -> bool {
    const DAY: u64 = 24 * 60 * 60;
    match last_checked() {
        Some(t) => t.elapsed().map(|d| d.as_secs() >= DAY).unwrap_or(true),
        None => true,
    }
}

/// Parse a version like `0.1.0`, `v1.2.3`, or `1.2.3-beta` into comparable ints.
fn parse_ver(s: &str) -> Option<(u64, u64, u64)> {
    let v = s.trim().trim_start_matches('v');
    // ignore pre-release suffix after first '-'
    let core = v.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let maj: u64 = parts.next()?.parse().ok()?;
    let min: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let pat: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((maj, min, pat))
}

/// Return the highest semantic-version release tag (e.g. "v1.2.3").
/// Queries the full releases list because the rolling `aib-latest` tag has no
/// semver and GitHub's `releases/latest` would otherwise resolve to it.
async fn latest_release(client: &reqwest::Client) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{REPO}/releases?per_page=100&sort=created&direction=desc"
    );
    let r = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: GitHub request failed: {e}");
            return None;
        }
    };
    if !r.status().is_success() {
        eprintln!("error: GitHub returned HTTP {}", r.status());
        return None;
    }
    let v: serde_json::Value = match r.json().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error: bad GitHub response: {e}");
            return None;
        }
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => {
            eprintln!("error: unexpected GitHub response shape");
            return None;
        }
    };
    let mut best: Option<(u64, u64, u64, String, String)> = None;
    for rel in arr {
        let tag = match rel.get("tag_name").and_then(|x| x.as_str()) {
            Some(t) => t,
            None => continue,
        };
        let Some(ver) = parse_ver(tag) else { continue };
        let html = rel.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let is_better = match &best {
            Some(b) => ver > (b.0, b.1, b.2),
            None => true,
        };
        if is_better {
            best = Some((ver.0, ver.1, ver.2, tag.to_string(), html));
        }
    }
    best.map(|(_, _, _, tag, html)| (tag, html))
}

/// Find, in a release asset list, the asset name for the current platform.
fn pick_asset(assets: &serde_json::Value) -> Option<String> {
    let arr = assets.as_array()?;
    let want = format!("{ASSET_PREFIX}{TARGET}{EXT}");
    arr.iter()
        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
        .find(|n| *n == want)
        .map(|n| n.to_string())
}

async fn download_asset(
    client: &reqwest::Client,
    tag: &str,
    asset: &str,
    dest: &PathBuf,
) -> Result<(), String> {
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/{asset}");
    let r = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("download failed: HTTP {}", r.status()));
    }
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 100_000 {
        return Err("downloaded file looks too small to be a release binary".to_string());
    }
    // Optional: check the response Content-Length matches the asset on GitHub.

    std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot locate self: {e}"))
}

/// Swap the new binary into place over the running one.
fn commit_new(tmp: &PathBuf, target: &PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Unix: atomically replace even an executing file via rename.
        std::fs::rename(tmp, target).map_err(|e| format!("replace failed: {e}"))
    }
    #[cfg(windows)]
    {
        // Windows cannot overwrite a running .exe: spawn a cmd helper that
        // waits briefly, replaces it, and finishes the swap.
        use std::process::Command;
        let script = target.with_extension("bat");
        let script_body = format!(
            "timeout /t 1 /nobreak >nul\r\n"
            "del /f \"{target}\"\r\n"
            "move /y \"{tmp}\" \"{target}\"\r\n"
            "del /f \"%~f0\"\r\n"
        );
        std::fs::write(&script, script_body)
            .map_err(|e| format!("cannot write swap script: {e}"))?;
        Command::new("cmd")
            .args(["/c", script.to_str().unwrap_or("")])
            .spawn()
            .map_err(|e| format!("cannot spawn swap script: {e}"))?;
        Ok(())
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("aib-updater/{}", crate::VERSION))
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("http client")
}

/// Called on startup. Non-blocking and silent unless an update is available.
pub async fn maybe_check() {
    if !throttle_ok() {
        return; // checked recently
    }
    save_checked();

    let client = http();
    match latest_release(&client).await {
        Some((tag, _html)) => {
            let latest = match parse_ver(&tag) {
                Some(v) => v,
                None => return, // rolling tags without versions: no-op
            };
            let current = parse_ver(crate::VERSION).unwrap_or((0, 0, 0));
            if latest <= current {
                return; // we're current or ahead
            }
            eprintln!(
                "\n\u{1b}[1;36mAn update is available: aib {}\u{1b}[0m (you have {})",
                tag.trim_start_matches('v'),
                crate::VERSION
            );
            eprint!("Update now? [y/N] ");
            use std::io::Write;
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line).is_err() {
                eprintln!("\n(skipping update)");
                return;
            }
            let trimmed = line.trim();
            if trimmed.eq_ignore_ascii_case("y") || trimmed.eq_ignore_ascii_case("yes") {
                set_to().await;
            } else {
                eprintln!("(skipping update)");
            }
        }
        None => { /* offline — stay silent */ }
    }
}

/// `aib update` — force-check and update without the daily throttle.
pub async fn set_to() {
    let client = http();
    let target = match current_exe() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return;
        }
    };

    let Some((tag, _html)) = latest_release(&client).await else {
        eprintln!(
            "no versioned aib release found on GitHub yet (only rolling 'aib-latest'; \
             publish a vX.Y.Z release to enable auto-update)"
        );
        return;
    };
    // We just recheck the same release anyway; only act if there's a change.
    let latest = match parse_ver(&tag) {
        Some(v) => v,
        None => {
            eprintln!("error: release tag '{tag}' has no semantic version");
            return;
        }
    };
    let current = parse_ver(crate::VERSION).unwrap_or((0, 0, 0));
    if latest <= current {
        eprintln!("aib is already up to date ({}).", crate::VERSION);
        return;
    }

    // Fetch the release assets to find the platform asset name.
    let url = format!("https://api.github.com/repos/{REPO}/releases/tags/{}", tag);
    let r = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => {
            eprintln!("error: could not fetch release asset list");
            return;
        }
    };
    let v: serde_json::Value = match r.json().await {
        Ok(v) => v,
        Err(_) => {
            eprintln!("error: bad release metadata");
            return;
        }
    };
    let Some(asset) = pick_asset(v.get("assets").unwrap_or(&serde_json::Value::Null)) else {
        eprintln!(
            "error: no asset for platform '{}{}' in release {tag}",
            ASSET_PREFIX,
            TARGET.to_string() + EXT
        );
        return;
    };

    let tmp = target.with_extension("aib-new");
    eprintln!("downloading {} ...", asset);
    if let Err(e) = download_asset(&client, &tag, &asset, &tmp).await {
        eprintln!("error: {e}");
        return;
    }
    if let Err(e) = commit_new(&tmp, &target) {
        eprintln!("error: {e}");
        return;
    }
    eprintln!("updated aib to {}. Restart to use it.", tag.trim_start_matches('v'));
}
