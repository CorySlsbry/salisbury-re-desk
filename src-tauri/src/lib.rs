//! Salisbury RE Desk shell. Deliberately thin: window choreography (splash -> main), SQLite
//! migrations, scoped filesystem helpers, and the two managed sidecars (redesk-doc over
//! JSON-RPC stdio, llama-server over HTTP on 127.0.0.1). No console window is ever shown.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};

const MIGRATION_0001: &str = include_str!("../../migrations/0001_init.sql");
const MIGRATION_0002: &str = include_str!("../../migrations/0002_forms_library.sql");
const MIGRATION_0003: &str = include_str!("../../migrations/0003_daily_engine.sql");
const MIGRATION_0004: &str = include_str!("../../migrations/0004_google_and_fills.sql");
const MIGRATION_0005: &str = include_str!("../../migrations/0005_automations.sql");
const MIGRATION_0006: &str = include_str!("../../migrations/0006_google_drive_contacts.sql");
const MIGRATION_0007: &str = include_str!("../../migrations/0007_gmail_drafts.sql");
const MIGRATION_0008: &str = include_str!("../../migrations/0008_monitor.sql");
const MIGRATION_0009: &str = include_str!("../../migrations/0009_cma.sql");
const MIGRATION_0010: &str = include_str!("../../migrations/0010_crm_links.sql");
pub const LLAMA_PORT: u16 = 8093;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct Sidecars {
    doc: Mutex<Option<DocProc>>,
    llama: Mutex<Option<Child>>,
}
struct DocProc { child: Child, next_id: u64 }

#[derive(Serialize)]
pub struct AppPaths {
    root: String, db_url: String, clients: String, forms_state: String, forms_uar: String,
    templates: String, backups: String, models: String, resources: String,
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().document_dir().map_err(|e| e.to_string())?.join("Salisbury RE"))
}
/// Models live under the user profile root, NOT AppData: AppData\Local is virtualised per MSIX package on this
/// machine (the Claude desktop app's sandbox redirects it), and 2.5 GB has no business in a Drive-synced Documents.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().home_dir().map_err(|e| e.to_string())?.join(".salisbury-re").join("models"))
}
fn ensure_dir(p: &Path) -> Result<(), String> { fs::create_dir_all(p).map_err(|e| format!("{}: {}", p.display(), e)) }
fn db_url(root: &Path) -> String { format!("sqlite:{}", root.join("redesk.db").to_string_lossy().replace('\\', "/")) }

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(CREATE_NO_WINDOW); }
    cmd
}

/// Create the on-disk layout and return every path the frontend needs.
#[tauri::command]
fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let root = root_dir(&app)?;
    let models = models_dir(&app)?;
    for sub in ["Clients", "Forms/State", "Forms/UAR", "Forms/MLS", "Templates", "Backups"] { ensure_dir(&root.join(sub))?; }
    ensure_dir(&models)?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(AppPaths {
        root: root.to_string_lossy().into(), db_url: db_url(&root),
        clients: root.join("Clients").to_string_lossy().into(),
        forms_state: root.join("Forms").join("State").to_string_lossy().into(),
        forms_uar: root.join("Forms").join("UAR").to_string_lossy().into(),
        templates: root.join("Templates").to_string_lossy().into(),
        backups: root.join("Backups").to_string_lossy().into(),
        models: models.to_string_lossy().into(),
        resources: resources.to_string_lossy().into(),
    })
}

/// Create a client folder tree: <Clients>/<Last, First - Street, City>/<numbered subfolders>.
#[tauri::command]
fn create_client_folder(app: AppHandle, folder_name: String) -> Result<String, String> {
    let safe: String = folder_name.chars().map(|c| if "<>:\"/\\|?*".contains(c) { '-' } else { c }).collect();
    let base = root_dir(&app)?.join("Clients").join(safe.trim());
    for sub in ["00 Intake", "01 Agreements", "02 Disclosures", "03 Contract & Addenda",
                "04 Inspection & Appraisal", "05 Title & Closing", "06 Communications", "07 Broker Submissions"] {
        ensure_dir(&base.join(sub))?;
    }
    Ok(base.to_string_lossy().into())
}

/// Copy a file into the vault (never move). Returns (path, sha256, bytes). Name collisions get " (n)".
#[tauri::command]
fn file_into_vault(src: String, dest_dir: String, file_name: String) -> Result<(String, String, u64), String> {
    let dest_dir = PathBuf::from(dest_dir);
    ensure_dir(&dest_dir)?;
    let mut dest = dest_dir.join(&file_name);
    let mut n = 1;
    while dest.exists() {
        let stem = Path::new(&file_name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = Path::new(&file_name).extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        dest = dest_dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    let (sha, bytes) = sha256_of(&dest)?;
    Ok((dest.to_string_lossy().into(), sha, bytes))
}

#[tauri::command]
fn sha256_file(path: String) -> Result<(String, u64), String> { sha256_of(Path::new(&path)) }

fn sha256_of(p: &Path) -> Result<(String, u64), String> {
    let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() { ensure_dir(parent)?; }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<(String, u64, bool)>, String> {
    let mut out = vec![];
    for e in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let md = e.metadata().map_err(|e| e.to_string())?;
        out.push((e.path().to_string_lossy().into(), md.len(), md.is_dir()));
    }
    out.sort();
    Ok(out)
}


/// OAuth loopback: listen once on 127.0.0.1:port for Google's redirect and return the query string
/// ("code=...&state=..."). The webview cannot listen on a socket; this is the only network listener in the app.
#[tauri::command]
async fn oauth_listen(port: u16, timeout_secs: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("bind {}: {}", port, e))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).ok();
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = req.lines().next().unwrap_or("").to_string();
                    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let query = path.splitn(2, '?').nth(1).unwrap_or("").to_string();
                    let body = "<html><body style='font-family:Segoe UI;padding:40px'><h2>Salisbury RE Desk is connected to Google.</h2><p>You can close this tab and go back to the app.</p></body></html>";
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    stream.write_all(resp.as_bytes()).ok();
                    stream.flush().ok();
                    if query.contains("code=") || query.contains("error=") { return Ok(query); }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline { return Err("timed out waiting for Google".into()); }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }).await.map_err(|e| e.to_string())?
}

/// Secrets (Google refresh token, OAuth client secret) live OUTSIDE the Drive-synced data folder, encrypted with
/// Windows DPAPI for this user account: %USERPROFILE%\.salisbury-re\secrets\<name>.bin. Never in the SQLite DB.
fn secrets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().home_dir().map_err(|e| e.to_string())?.join(".salisbury-re").join("secrets");
    ensure_dir(&d)?;
    Ok(d)
}
fn secret_name_ok(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Err("bad secret name".into()); }
    Ok(())
}
#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    let mut inblob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if protect { CryptProtectData(&mut inblob, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        else { CryptUnprotectData(&mut inblob, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
    };
    if ok == 0 { return Err(if protect { "DPAPI protect failed" } else { "DPAPI unprotect failed (different Windows user, or the file was copied from another machine)" }.into()); }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(out.pbData as _); }
    Ok(bytes)
}
#[cfg(not(windows))]
fn dpapi(input: &[u8], _protect: bool) -> Result<Vec<u8>, String> { Ok(input.to_vec()) }

#[tauri::command]
fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    secret_name_ok(&name)?;
    let path = secrets_dir(&app)?.join(format!("{}.bin", name));
    if value.is_empty() { let _ = fs::remove_file(&path); return Ok(()); }
    fs::write(&path, dpapi(value.as_bytes(), true)?).map_err(|e| e.to_string())
}
#[tauri::command]
fn secret_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    secret_name_ok(&name)?;
    let path = secrets_dir(&app)?.join(format!("{}.bin", name));
    if !path.exists() { return Ok(None); }
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&dpapi(&raw, false)?).to_string()))
}

/// Off-Drive encrypted backup: DPAPI-protect a DB backup file into %USERPROFILE%\.salisbury-re\backups (keep 14).
#[derive(Serialize)]
pub struct OffdriveResult { dest: String, bytes: u64, kept: usize }
#[tauri::command]
fn backup_offdrive(app: AppHandle, src: String) -> Result<OffdriveResult, String> {
    let dir = app.path().home_dir().map_err(|e| e.to_string())?.join(".salisbury-re").join("backups");
    ensure_dir(&dir)?;
    let name = Path::new(&src).file_name().map(|s| s.to_string_lossy().to_string()).ok_or("bad src")?;
    let dest = dir.join(format!("{}.dpapi", name));
    if !dest.exists() {
        let raw = fs::read(&src).map_err(|e| e.to_string())?;
        fs::write(&dest, dpapi(&raw, true)?).map_err(|e| e.to_string())?;
    }
    let mut all: Vec<PathBuf> = fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "dpapi").unwrap_or(false)).collect();
    all.sort();
    while all.len() > 14 { let old = all.remove(0); let _ = fs::remove_file(old); }
    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(OffdriveResult { dest: dest.to_string_lossy().into(), bytes, kept: all.len() })
}

/// BitLocker status of the system drive via manage-bde (read-only). Standard users are often denied; say so.
#[derive(Serialize)]
pub struct BitlockerStatus { status: String, detail: String }
#[tauri::command]
fn bitlocker_status() -> Result<BitlockerStatus, String> {
    let mut cmd = Command::new("manage-bde");
    cmd.args(["-status", "C:"]).stdin(Stdio::null());
    let out = hidden(&mut cmd).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let line = text.lines().find(|l| l.contains("Protection Status")).unwrap_or("").trim().to_string();
    let status = if line.contains("Protection On") { "on" } else if line.contains("Protection Off") { "off" } else { "unknown" };
    Ok(BitlockerStatus { status: status.into(), detail: if status == "unknown" { text.lines().find(|l| l.contains("ERROR") || l.contains("denied")).unwrap_or("no status line").trim().to_string() } else { line } })
}

/// Download a file (state forms) to dest. Returns (sha256, bytes). HTTPS only.
#[tauri::command]
fn download_file(url: String, dest: String) -> Result<(String, u64), String> {
    if !url.starts_with("https://") { return Err("https only".into()); }
    let mut resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let mut bytes: Vec<u8> = Vec::new();
    resp.body_mut().as_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(&dest).parent() { ensure_dir(parent)?; }
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    sha256_of(Path::new(&dest))
}

/// Stream a large file (the model) to disk, emitting "download-progress" {url, done, total} every ~4 MB.
/// Run one prompt through Claude Code's headless mode on Cory's own subscription (no API key, no per-token bill).
/// Every built-in tool is disallowed, the working directory is an empty scratch folder, and our system prompt
/// replaces Claude Code's, so the model can only read the prompt and answer. Returns the CLI's result JSON.
#[tauri::command]
fn claude_run(app: AppHandle, prompt: String, system: String, model: String, schema_json: Option<String>, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let exe = which_claude(&app).ok_or_else(|| "Claude Code is not installed. Install it from claude.com/code, run `claude` once to sign in, then try again.".to_string())?;
    let cwd = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("claude-cwd");
    ensure_dir(&cwd)?;
    let safe_model = if ["haiku", "sonnet", "opus"].contains(&model.as_str()) || model.starts_with("claude-") { model.clone() } else { "haiku".to_string() };
    let mut cmd = Command::new(&exe);
    cmd.current_dir(&cwd)
        .args(["-p", "--output-format", "json", "--no-session-persistence", "--bare", "--permission-mode", "default", "--model", &safe_model, "--system-prompt", &system])
        .args(["--disallowedTools", "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "TodoWrite", "KillShell", "BashOutput", "Skill", "LS", "TaskOutput", "TaskStop"]);
    if let Some(s) = &schema_json { cmd.args(["--json-schema", s]); }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start Claude Code: {}", e))?;
    { let mut stdin = child.stdin.take().ok_or("no stdin")?; stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?; }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || { let mut s = String::new(); use std::io::Read; let _ = std::io::BufReader::new(stdout).read_to_string(&mut s); s });
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => { if std::time::Instant::now() > deadline { let _ = child.kill(); return Err(format!("Claude did not answer within {} s.", timeout_ms.unwrap_or(120_000) / 1000)); } std::thread::sleep(std::time::Duration::from_millis(100)); }
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = reader.join().unwrap_or_default();
    let json_start = out.find('{').unwrap_or(0);
    serde_json::from_str::<serde_json::Value>(&out[json_start..]).map_err(|e| format!("Claude Code returned something that was not JSON ({}): {}", e, out.chars().take(300).collect::<String>()))
}
fn which_claude(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let candidates = [home.join(".local").join("bin").join("claude.exe"), home.join(".local").join("bin").join("claude"), home.join("AppData").join("Roaming").join("npm").join("claude.cmd")];
    for c in candidates { if c.exists() { return Some(c); } }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) { for name in ["claude.exe", "claude.cmd", "claude"] { let p = dir.join(name); if p.exists() { return Some(p); } } }
    None
}

fn http_json(url: &str, query: &[(&str, &str)], ua: Option<&str>) -> Result<serde_json::Value, String> {
    let mut req = ureq::get(url);
    for (k, v) in query { req = req.query(*k, *v); }
    if let Some(u) = ua { req = req.header("User-Agent", u); }
    let mut resp = req.call().map_err(|e| e.to_string())?;
    let text = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Locate a street address for the CMA: Utah's statewide address points (authoritative, includes new subdivisions),
/// then the US Census geocoder, then OpenStreetMap. Called from Rust because none of them allow browser calls.
/// Only a property address ever leaves the machine. Returns (lat, lng, matched address, source) or None.
#[tauri::command]
fn geocode_lookup(address: String) -> Result<Option<(f64, f64, String, String)>, String> {
    let addr = address.trim().replace("  ", " ");
    if addr.is_empty() { return Ok(None); }
    let mut network_errors = 0;
    // 1. UGRC address points (ArcGIS feature service): match on house number + street, then narrow by zip / city.
    let parts: Vec<&str> = addr.split(',').map(|s| s.trim()).collect();
    let street = parts.first().copied().unwrap_or("").to_uppercase();
    let zip = addr.split_whitespace().rev().find(|t| t.len() == 5 && t.chars().all(|c| c.is_ascii_digit())).map(|s| s.to_string());
    if !street.is_empty() {
        let like = format!("{}%", street.replace('\'', "''"));
        let mut where_clause = format!("UPPER(FullAdd) LIKE '{}'", like);
        if let Some(z) = &zip { where_clause = format!("{} AND ZipCode = '{}'", where_clause, z); }
        match http_json(UGRC_ADDRESS_POINTS, &[("where", &where_clause), ("outFields", "FullAdd,City,ZipCode"), ("returnGeometry", "true"), ("outSR", "4326"), ("f", "json"), ("resultRecordCount", "3")], None) {
            Ok(v) => {
                if let Some(f) = v.pointer("/features/0") {
                    let lat = f.pointer("/geometry/y").and_then(|x| x.as_f64());
                    let lng = f.pointer("/geometry/x").and_then(|x| x.as_f64());
                    let full = f.pointer("/attributes/FullAdd").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let city = f.pointer("/attributes/City").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if let (Some(lat), Some(lng)) = (lat, lng) { return Ok(Some((lat, lng, format!("{}, {}", full, city).trim_end_matches(", ").to_string(), "ugrc".into()))); }
                }
            }
            Err(_) => network_errors += 1,
        }
    }
    // 2. US Census geocoder.
    match http_json("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress", &[("address", &addr), ("benchmark", "Public_AR_Current"), ("format", "json")], None) {
        Ok(v) => {
            if let Some(m) = v.pointer("/result/addressMatches/0") {
                let lat = m.pointer("/coordinates/y").and_then(|x| x.as_f64());
                let lng = m.pointer("/coordinates/x").and_then(|x| x.as_f64());
                let matched = m.get("matchedAddress").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if let (Some(lat), Some(lng)) = (lat, lng) { return Ok(Some((lat, lng, matched, "census".into()))); }
            }
        }
        Err(_) => network_errors += 1,
    }
    // 3. OpenStreetMap Nominatim: identify the app, one request per second, house- or street-level results only.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    match http_json("https://nominatim.openstreetmap.org/search", &[("q", &addr), ("format", "jsonv2"), ("limit", "1"), ("countrycodes", "us")], Some("SalisburyREDesk/0.1 (https://salisburyre.com)")) {
        Ok(v) => {
            if let Some(m) = v.get(0) {
                let rank = m.get("place_rank").and_then(|x| x.as_i64()).unwrap_or(0);
                let lat = m.get("lat").and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
                let lng = m.get("lon").and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
                let name = m.get("display_name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if rank >= 26 { if let (Some(lat), Some(lng)) = (lat, lng) { return Ok(Some((lat, lng, name, if rank >= 30 { "osm".into() } else { "osm-street".into() }))); } }
            }
        }
        Err(_) => network_errors += 1,
    }
    if network_errors >= 3 { return Err("No internet connection right now (none of the address services answered).".into()); }
    Ok(None)
}
/// UGRC "Utah Address Points" (statewide, county-maintained, public; found via the ArcGIS Online catalog 2026-09-08).
const UGRC_ADDRESS_POINTS: &str = "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahAddressPoints/FeatureServer/0/query";

#[tauri::command]
fn download_model(app: AppHandle, url: String, dest: String, expected_sha256: Option<String>) -> Result<(String, u64), String> {
    if !url.starts_with("https://") { return Err("https only".into()); }
    let dest_path = PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() { ensure_dir(parent)?; }
    let part = dest_path.with_extension("part");
    let mut resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut reader = resp.body_mut().as_reader();
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if done - last_emit >= (4 << 20) {
            last_emit = done;
            let _ = app.emit("download-progress", serde_json::json!({ "url": url, "done": done, "total": total }));
        }
    }
    drop(file);
    let sha = hex::encode(hasher.finalize());
    if let Some(exp) = expected_sha256 { if !exp.is_empty() && exp.to_lowercase() != sha { let _ = fs::remove_file(&part); return Err(format!("sha256 mismatch: got {}", sha)); } }
    fs::rename(&part, &dest_path).map_err(|e| e.to_string())?;
    let _ = app.emit("download-progress", serde_json::json!({ "url": url, "done": done, "total": done }));
    Ok((sha, done))
}

/* ---------------- sidecars ---------------- */

fn resource_bin(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    // Dev: src-tauri/resources/<rel>. Release: <resource_dir>/resources/<rel>.
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    for cand in [res.join("resources").join(rel), res.join(rel), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(rel)] {
        if cand.exists() { return Ok(cand); }
    }
    Err(format!("sidecar not found: {}", rel))
}

/// Start (or restart) the document engine. Idempotent.
#[tauri::command]
fn doc_start(app: AppHandle, st: State<Sidecars>) -> Result<String, String> {
    let mut guard = st.doc.lock().map_err(|e| e.to_string())?;
    if let Some(p) = guard.as_mut() {
        if p.child.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok("running".into()); }
    }
    let exe = resource_bin(&app, "doc/redesk-doc.exe")?;
    let mut cmd = Command::new(&exe);
    cmd.current_dir(exe.parent().unwrap()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let child = hidden(&mut cmd).spawn().map_err(|e| format!("spawn redesk-doc: {}", e))?;
    *guard = Some(DocProc { child, next_id: 1 });
    Ok("started".into())
}

/// One JSON-RPC round trip to the document engine. `method` + `params` in, `result` out.
#[tauri::command]
fn doc_call(app: AppHandle, st: State<Sidecars>, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    doc_start(app, st.clone())?;
    let mut guard = st.doc.lock().map_err(|e| e.to_string())?;
    let p = guard.as_mut().ok_or("doc engine not running")?;
    let id = p.next_id; p.next_id += 1;
    let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let stdin = p.child.stdin.as_mut().ok_or("no stdin")?;
    stdin.write_all(format!("{}\n", req).as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    let stdout = p.child.stdout.as_mut().ok_or("no stdout")?;
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).map_err(|e| e.to_string())?;
    if line.is_empty() { *guard = None; return Err("doc engine exited".into()); }
    let v: serde_json::Value = serde_json::from_str(&line).map_err(|e| format!("bad rpc line: {} :: {}", e, &line[..line.len().min(200)]))?;
    if let Some(err) = v.get("error") { return Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("doc error").to_string()); }
    Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

/// Start llama-server on 127.0.0.1:8093 with the given GGUF. Idempotent. Returns the base URL.
#[tauri::command]
fn llama_start(app: AppHandle, st: State<Sidecars>, model_path: String, gpu_layers: u32, threads: u32) -> Result<String, String> {
    let mut guard = st.llama.lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.as_mut() {
        if c.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok(format!("http://127.0.0.1:{}", LLAMA_PORT)); }
    }
    if !Path::new(&model_path).exists() { return Err(format!("model not found: {}", model_path)); }
    match resource_bin(&app, "llama/redesk-llm.exe") {
        Ok(exe) => {
            let mut cmd = Command::new(&exe);
            cmd.current_dir(exe.parent().unwrap())
                .args(["-m", &model_path, "--host", "127.0.0.1", "--port", &LLAMA_PORT.to_string(), "-c", "16384",
                       "-ngl", &gpu_layers.to_string(), "-t", &threads.to_string(), "--parallel", "2", "--jinja", "--no-webui"])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let child = hidden(&mut cmd).spawn().map_err(|e| format!("spawn redesk-llm: {}", e))?;
            *guard = Some(child);
            Ok(format!("llamacpp http://127.0.0.1:{}", LLAMA_PORT))
        }
        Err(_) => {
            // Fallback: Ollama, if installed (Norton quarantines the llama.cpp launcher on this machine).
            let ollama = app.path().local_data_dir().map_err(|e| e.to_string())?.join("Programs").join("Ollama").join("ollama.exe");
            if !ollama.exists() { return Err("sidecar not found: llama/redesk-llm.exe (and Ollama is not installed)".into()); }
            let mut cmd = Command::new(&ollama);
            cmd.args(["serve"]).env("OLLAMA_HOST", "127.0.0.1:11434").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            // If Ollama is already running the new process exits at bind time; the service is there either way.
            if let Ok(child) = hidden(&mut cmd).spawn() { *guard = Some(child); }
            Ok("ollama http://127.0.0.1:11434".into())
        }
    }
}

#[tauri::command]
fn sidecars_stop(st: State<Sidecars>) -> Result<(), String> {
    if let Ok(mut g) = st.doc.lock() { if let Some(p) = g.as_mut() { let _ = p.child.kill(); } *g = None; }
    if let Ok(mut g) = st.llama.lock() { if let Some(c) = g.as_mut() { let _ = c.kill(); } *g = None; }
    Ok(())
}

/* ---------------- windows ---------------- */

#[tauri::command]
fn app_ready(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") { main.show().map_err(|e| e.to_string())?; main.set_focus().ok(); }
    if let Some(splash) = app.get_webview_window("splash") { splash.close().map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn splash_progress(app: AppHandle, step: String, pct: u8) -> Result<(), String> {
    app.emit_to("splash", "progress", serde_json::json!({ "step": step, "pct": pct })).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sidecars::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let root = root_dir(app.handle()).map_err(std::io::Error::other)?;
            fs::create_dir_all(&root)?;
            let migrations = vec![
                Migration { version: 1, description: "init", sql: MIGRATION_0001, kind: MigrationKind::Up },
                Migration { version: 2, description: "forms library + packet template links", sql: MIGRATION_0002, kind: MigrationKind::Up },
                Migration { version: 3, description: "daily engine, leads, ideas, open houses, touches, posts", sql: MIGRATION_0003, kind: MigrationKind::Up },
                Migration { version: 4, description: "google calendar links, prefilled drafts", sql: MIGRATION_0004, kind: MigrationKind::Up },
                Migration { version: 5, description: "automations, showings, broker submission", sql: MIGRATION_0005, kind: MigrationKind::Up },
                Migration { version: 6, description: "google drive uploads, google contacts links", sql: MIGRATION_0006, kind: MigrationKind::Up },
                Migration { version: 7, description: "gmail drafts dedupe", sql: MIGRATION_0007, kind: MigrationKind::Up },
                Migration { version: 8, description: "monitor columns, agent lessons, at-risk and packet-gap views", sql: MIGRATION_0008, kind: MigrationKind::Up },
                Migration { version: 9, description: "cma: geocache, mls comps, saved cmas", sql: MIGRATION_0009, kind: MigrationKind::Up },
                Migration { version: 10, description: "salisburyre.com crm links and inbox", sql: MIGRATION_0010, kind: MigrationKind::Up },
            ];
            app.handle().plugin(tauri_plugin_sql::Builder::default().add_migrations(&db_url(&root), migrations).build())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(st) = window.app_handle().try_state::<Sidecars>() { let _ = sidecars_stop(st); }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            oauth_listen, secret_set, secret_get, backup_offdrive, bitlocker_status,
            app_paths, create_client_folder, file_into_vault, sha256_file, write_text, list_dir, download_file, download_model, geocode_lookup, claude_run,
            doc_start, doc_call, llama_start, sidecars_stop, app_ready, splash_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running Salisbury RE Desk");
}
