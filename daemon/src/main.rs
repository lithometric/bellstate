//! bellstated — machine-global state daemon for bellstate.
//!
//! Owns a single JSON key/value store per namespace and serves it to any
//! number of Node/Electron processes over a Unix domain socket (named pipe
//! on Windows). Protocol is newline-delimited JSON, version 1:
//!
//!   request:  {"id":1,"op":"set","key":"counter","value":42,"ifRev":7}
//!   response: {"id":1,"ok":true,"rev":8}
//!   event:    {"ev":"change","key":"counter","value":42,"rev":8}
//!
//! Every key carries the global revision at which it last changed, which
//! makes writes compare-and-settable (`ifRev`). Mutations are appended to a
//! write-ahead log and periodically compacted into a snapshot, so state
//! survives even a SIGKILL with at most a few milliseconds of loss.
//!
//! Values whose serialized form exceeds LARGE_THRESHOLD are transferred in
//! chunks (bset/bchunk/bcommit up, bget down) so one huge write never
//! head-of-line-blocks small operations, and change events for them carry
//! only metadata — replicas fetch the payload lazily in the background.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch, Mutex};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_V: u64 = 1;

/// Serialized values above this are "large": chunked transfer, lazy broadcast.
const LARGE_THRESHOLD: usize = 512 * 1024;
/// Raw bytes per download chunk (b64 inflates by 4/3 on the wire).
const CHUNK_RAW: usize = 512 * 1024;
/// Per-connection outbound queue depth; overflow evicts the slow client.
const CONN_QUEUE: usize = 8192;
/// TTL sweep cadence.
const SWEEP_MS: u64 = 500;
/// Per-channel cap on retained pulse history.
const STREAM_KEEP_MAX: usize = 256;
/// Max distinct channels retaining history (oldest evicted past this).
const STREAM_CHANNELS_MAX: usize = 512;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Config

struct Config {
    namespace: String,
    socket_path: String,
    data_file: PathBuf,
    wal_file: PathBuf,
    pid_file: PathBuf,
    idle_timeout_secs: u64,
    max_value: usize,
    max_frame: usize,
    wal_max: u64,
    fsync: bool,
}

fn runtime_dir() -> PathBuf {
    let base = dirs::runtime_dir().unwrap_or_else(std::env::temp_dir);
    base.join("bellstate")
}

fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("bellstate")
}

fn default_socket_path(namespace: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\bellstate-{namespace}")
    } else {
        runtime_dir()
            .join(format!("{namespace}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

fn parse_args() -> Config {
    let mut namespace = String::from("default");
    let mut socket: Option<String> = None;
    let mut data_file: Option<PathBuf> = None;
    let mut idle_timeout_secs: u64 = 0;
    let mut max_value_mb: u64 = 64;
    let mut wal_max_mb: u64 = 4;
    let mut fsync = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--namespace" | "-n" => namespace = args.next().unwrap_or_else(|| usage()),
            "--socket" | "-s" => socket = Some(args.next().unwrap_or_else(|| usage())),
            "--data-file" | "-d" => {
                data_file = Some(PathBuf::from(args.next().unwrap_or_else(|| usage())))
            }
            "--idle-timeout" => {
                idle_timeout_secs = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage())
            }
            "--max-value-mb" => {
                max_value_mb = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage())
            }
            "--wal-max-mb" => {
                wal_max_mb = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage())
            }
            "--fsync" => fsync = true,
            "--version" | "-V" => {
                println!("bellstated {VERSION} (protocol v{PROTOCOL_V})");
                process::exit(0);
            }
            "--help" | "-h" => usage(),
            other => {
                eprintln!("bellstated: unknown argument {other}");
                usage();
            }
        }
    }

    let socket_path = socket.unwrap_or_else(|| default_socket_path(&namespace));
    let data_file = data_file.unwrap_or_else(|| data_dir().join(format!("{namespace}.json")));
    let wal_file = data_file.with_extension("wal");
    let pid_file = runtime_dir().join(format!("{namespace}.pid"));
    let max_value = (max_value_mb as usize) * 1024 * 1024;

    Config {
        namespace,
        socket_path,
        data_file,
        wal_file,
        pid_file,
        idle_timeout_secs,
        max_value,
        // A frame must fit one chunk (b64-inflated) or one small value + envelope.
        max_frame: (CHUNK_RAW * 4 / 3) + 64 * 1024,
        wal_max: wal_max_mb * 1024 * 1024,
        fsync,
    }
}

fn usage() -> ! {
    eprintln!(
        "Usage: bellstated [--namespace NAME] [--socket PATH] [--data-file PATH]\n                  [--idle-timeout SECS] [--max-value-mb MB] [--wal-max-mb MB] [--fsync]"
    );
    process::exit(2);
}

fn ensure_private_dir(dir: &PathBuf) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

// ---------------------------------------------------------------------------
// State

struct Entry {
    value: Value,
    /// Global revision at which this key was last modified (CAS anchor).
    rev: u64,
    /// Serialized size in bytes.
    size: usize,
    /// Cached serialization, kept only for large values (serves bget chunks).
    json: Option<Arc<String>>,
    /// Connection that owns this key; the key dies with the connection.
    ephemeral_owner: Option<u64>,
    /// Absolute expiry in epoch ms (TTL keys).
    expires_at_ms: Option<u64>,
}

impl Entry {
    fn is_large(&self) -> bool {
        self.size > LARGE_THRESHOLD
    }
}

#[derive(Default)]
struct SubSpec {
    all: bool,
    exact: HashSet<String>,
    prefixes: Vec<String>,
}

impl SubSpec {
    fn matches(&self, key: &str) -> bool {
        self.all
            || self.exact.contains(key)
            || self.prefixes.iter().any(|p| key.starts_with(p.as_str()))
    }
    fn add_pattern(&mut self, pat: &str) {
        if pat == "*" {
            self.all = true;
        } else if let Some(prefix) = pat.strip_suffix('*') {
            self.prefixes.push(prefix.to_string());
        } else {
            self.exact.insert(pat.to_string());
        }
    }
}

struct ConnHandle {
    tx: mpsc::Sender<String>,
    /// Dropping this (by removing the handle) tells the writer task to exit,
    /// which closes the socket — our slow-client eviction mechanism.
    _kill: watch::Sender<bool>,
    spec: SubSpec,
}

struct PendingBlob {
    key: String,
    if_rev: Option<u64>,
    ttl_ms: Option<u64>,
    ephemeral: bool,
    size: usize,
    buf: Vec<u8>,
}

enum WalCmd {
    Append(String),
}

struct Shared {
    state: BTreeMap<String, Entry>,
    rev: u64,
    conns: HashMap<u64, ConnHandle>,
    clients: usize,
    idle_since: Option<Instant>,
    blobs: HashMap<(u64, u64), PendingBlob>,
    next_blob_token: u64,
    wal_tx: mpsc::UnboundedSender<WalCmd>,
    start_ms: u64,
    /// Bounded in-memory pulse history per channel (never persisted).
    streams: HashMap<String, VecDeque<Value>>,
    stream_order: VecDeque<String>,
}

/// Outcome of applying a `set`-shaped mutation.
enum SetOutcome {
    Ok(u64),
    /// CAS failure: current key rev + current value (None if large or absent).
    Conflict { rev: u64, value: Option<Value>, large: bool },
}

impl Shared {
    /// Deliver an event line to every connection whose subscription matches
    /// any of `keys` (empty slice = all subscribers). Called under the lock;
    /// uses try_send and evicts connections whose queue is full.
    fn emit(&mut self, keys: &[&str], line: &str) {
        let mut dead: Vec<u64> = Vec::new();
        for (id, conn) in self.conns.iter() {
            let interested = if keys.is_empty() {
                conn.spec.all
                    || !conn.spec.exact.is_empty()
                    || !conn.spec.prefixes.is_empty()
            } else {
                keys.iter().any(|k| conn.spec.matches(k))
            };
            if !interested {
                continue;
            }
            if conn.tx.try_send(line.to_string()).is_err() {
                dead.push(*id);
            }
        }
        for id in dead {
            eprintln!("bellstated: evicting slow client (conn {id})");
            self.conns.remove(&id);
        }
    }

    /// Push a response line to one connection under the lock, preserving
    /// ordering relative to events. Returns false if the client is gone.
    fn respond(&mut self, conn_id: u64, line: String) -> bool {
        match self.conns.get(&conn_id) {
            Some(conn) => {
                if conn.tx.try_send(line).is_err() {
                    self.conns.remove(&conn_id);
                    false
                } else {
                    true
                }
            }
            None => false,
        }
    }

    fn wal(&self, line: String) {
        let _ = self.wal_tx.send(WalCmd::Append(line));
    }

    fn apply_set(
        &mut self,
        key: &str,
        value: Value,
        json: Option<Arc<String>>,
        size: usize,
        if_rev: Option<u64>,
        ttl_ms: Option<u64>,
        ephemeral_owner: Option<u64>,
    ) -> SetOutcome {
        let cur_rev = self.state.get(key).map(|e| e.rev).unwrap_or(0);
        if let Some(expected) = if_rev {
            if expected != cur_rev {
                let (value, large) = match self.state.get(key) {
                    Some(e) if e.is_large() => (None, true),
                    Some(e) => (Some(e.value.clone()), false),
                    None => (None, false),
                };
                return SetOutcome::Conflict { rev: cur_rev, value, large };
            }
        }

        self.rev += 1;
        let rev = self.rev;
        let expires_at_ms = ttl_ms.map(|t| now_ms() + t);
        let large = size > LARGE_THRESHOLD;

        if ephemeral_owner.is_none() {
            let mut record = json!({"r": rev, "o": "s", "k": key, "v": value});
            if let Some(x) = expires_at_ms {
                record["x"] = json!(x);
            }
            self.wal(record.to_string());
        }

        let mut event = json!({"ev": "change", "key": key, "rev": rev});
        if large {
            event["large"] = json!({"size": size});
        } else {
            event["value"] = value.clone();
        }
        if ephemeral_owner.is_some() {
            event["eph"] = json!(true);
        }
        self.emit(&[key], &event.to_string());

        self.state.insert(
            key.to_string(),
            Entry { value, rev, size, json, ephemeral_owner, expires_at_ms },
        );
        SetOutcome::Ok(rev)
    }

    fn apply_del(&mut self, key: &str, reason: Option<&str>) -> Option<u64> {
        let entry = self.state.remove(key)?;
        self.rev += 1;
        let rev = self.rev;
        if entry.ephemeral_owner.is_none() {
            self.wal(json!({"r": rev, "o": "d", "k": key}).to_string());
        }
        let mut event = json!({"ev": "change", "key": key, "deleted": true, "rev": rev});
        if let Some(r) = reason {
            event[r] = json!(true);
        }
        self.emit(&[key], &event.to_string());
        Some(rev)
    }
}

// ---------------------------------------------------------------------------
// Persistence: snapshot + WAL

fn load_state(cfg: &Config) -> (BTreeMap<String, Entry>, u64) {
    let mut state = BTreeMap::new();
    let mut rev: u64 = 0;

    if let Ok(text) = std::fs::read_to_string(&cfg.data_file) {
        if let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(&text) {
            rev = doc.get("rev").and_then(Value::as_u64).unwrap_or(0);
            let fmt2 = doc.get("fmt").and_then(Value::as_u64) == Some(2);
            if let Some(obj) = doc.get("state").and_then(Value::as_object) {
                for (k, v) in obj {
                    let (value, key_rev, expires) = if fmt2 {
                        let value = v.get("v").cloned().unwrap_or(Value::Null);
                        let r = v.get("r").and_then(Value::as_u64).unwrap_or(rev);
                        let x = v.get("x").and_then(Value::as_u64);
                        (value, r, x)
                    } else {
                        (v.clone(), rev, None)
                    };
                    insert_loaded(&mut state, k, value, key_rev, expires);
                }
            }
        } else {
            eprintln!(
                "bellstated: {} is not valid state, starting empty",
                cfg.data_file.display()
            );
        }
    }

    // Replay the WAL past the snapshot. A truncated tail line (crash mid-
    // append) ends the replay — everything before it is intact.
    if let Ok(text) = std::fs::read_to_string(&cfg.wal_file) {
        let mut replayed = 0u64;
        for line in text.lines() {
            let Ok(rec) = serde_json::from_str::<Value>(line) else { break };
            let Some(r) = rec.get("r").and_then(Value::as_u64) else { break };
            if r <= rev {
                continue;
            }
            match rec.get("o").and_then(Value::as_str) {
                Some("s") => {
                    let k = rec.get("k").and_then(Value::as_str).unwrap_or_default();
                    let v = rec.get("v").cloned().unwrap_or(Value::Null);
                    let x = rec.get("x").and_then(Value::as_u64);
                    insert_loaded(&mut state, k, v, r, x);
                }
                Some("d") => {
                    if let Some(k) = rec.get("k").and_then(Value::as_str) {
                        state.remove(k);
                    }
                }
                Some("c") => state.clear(),
                Some("m") => {
                    if let Some(entries) = rec.get("e").and_then(Value::as_object) {
                        for (k, v) in entries {
                            insert_loaded(&mut state, k, v.clone(), r, None);
                        }
                    }
                    if let Some(dels) = rec.get("d").and_then(Value::as_array) {
                        for k in dels.iter().filter_map(Value::as_str) {
                            state.remove(k);
                        }
                    }
                }
                _ => break,
            }
            rev = r;
            replayed += 1;
        }
        if replayed > 0 {
            eprintln!("bellstated: replayed {replayed} WAL record(s)");
        }
    }

    // Drop keys that expired while the daemon was down.
    let now = now_ms();
    state.retain(|_, e| e.expires_at_ms.map(|x| x > now).unwrap_or(true));

    (state, rev)
}

fn insert_loaded(
    state: &mut BTreeMap<String, Entry>,
    key: &str,
    value: Value,
    rev: u64,
    expires_at_ms: Option<u64>,
) {
    let serialized = value.to_string();
    let size = serialized.len();
    let json = if size > LARGE_THRESHOLD { Some(Arc::new(serialized)) } else { None };
    state.insert(
        key.to_string(),
        Entry { value, rev, size, json, ephemeral_owner: None, expires_at_ms },
    );
}

/// Serialize a snapshot document (fmt 2). Ephemeral keys are skipped — they
/// cannot outlive their connection, so they never touch disk.
fn snapshot_doc(state: &BTreeMap<String, Entry>, rev: u64) -> Value {
    let mut obj = Map::new();
    for (k, e) in state {
        if e.ephemeral_owner.is_some() {
            continue;
        }
        let mut entry = json!({"v": e.value, "r": e.rev});
        if let Some(x) = e.expires_at_ms {
            entry["x"] = json!(x);
        }
        obj.insert(k.clone(), entry);
    }
    json!({"fmt": 2, "rev": rev, "state": Value::Object(obj)})
}

fn write_snapshot(cfg: &Config, state: &BTreeMap<String, Entry>, rev: u64) {
    if let Some(parent) = cfg.data_file.parent() {
        ensure_private_dir(&parent.to_path_buf());
    }
    let doc = snapshot_doc(state, rev);
    let tmp = cfg.data_file.with_extension("json.tmp");
    let payload = match serde_json::to_vec(&doc) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bellstated: failed to serialize snapshot: {e}");
            return;
        }
    };
    if std::fs::write(&tmp, payload).is_ok() {
        let _ = std::fs::rename(&tmp, &cfg.data_file);
    }
}

async fn wal_loop(
    mut rx: mpsc::UnboundedReceiver<WalCmd>,
    cfg: Arc<Config>,
    shared: Arc<Mutex<Shared>>,
    wal_bytes: Arc<AtomicU64>,
) {
    if let Some(parent) = cfg.wal_file.parent() {
        ensure_private_dir(&parent.to_path_buf());
    }
    let open = || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&cfg.wal_file)
    };
    let Ok(mut file) = open() else {
        eprintln!("bellstated: cannot open WAL at {}", cfg.wal_file.display());
        return;
    };
    wal_bytes.store(
        std::fs::metadata(&cfg.wal_file).map(|m| m.len()).unwrap_or(0),
        Ordering::Relaxed,
    );

    while let Some(cmd) = rx.recv().await {
        // Batch whatever is already queued into one write + flush.
        let mut batch = Vec::new();
        let WalCmd::Append(line) = cmd;
        batch.push(line);
        while batch.len() < 256 {
            match rx.try_recv() {
                Ok(WalCmd::Append(line)) => batch.push(line),
                Err(_) => break,
            }
        }
        let mut buf = String::new();
        for line in &batch {
            buf.push_str(line);
            buf.push('\n');
        }
        if file.write_all(buf.as_bytes()).is_err() {
            eprintln!("bellstated: WAL write failed");
            continue;
        }
        let _ = file.flush();
        if cfg.fsync {
            let _ = file.sync_data();
        }
        let total = wal_bytes.fetch_add(buf.len() as u64, Ordering::Relaxed) + buf.len() as u64;

        if total > cfg.wal_max {
            // Compact: snapshot current state, then truncate the WAL.
            let (state_rev, doc_state);
            {
                let s = shared.lock().await;
                state_rev = s.rev;
                doc_state = snapshot_doc(&s.state, s.rev);
            }
            let tmp = cfg.data_file.with_extension("json.tmp");
            if let Ok(payload) = serde_json::to_vec(&doc_state) {
                if std::fs::write(&tmp, payload).is_ok()
                    && std::fs::rename(&tmp, &cfg.data_file).is_ok()
                {
                    let _ = std::fs::remove_file(&cfg.wal_file);
                    if let Ok(f) = open() {
                        file = f;
                        wal_bytes.store(0, Ordering::Relaxed);
                        eprintln!(
                            "bellstated: compacted WAL into snapshot at rev {state_rev}"
                        );
                    }
                }
            }
        }
    }
}

fn cleanup_and_exit(cfg: &Config, shared: &Shared, code: i32) -> ! {
    write_snapshot(cfg, &shared.state, shared.rev);
    let _ = std::fs::remove_file(&cfg.wal_file);
    #[cfg(unix)]
    let _ = std::fs::remove_file(&cfg.socket_path);
    let _ = std::fs::remove_file(&cfg.pid_file);
    process::exit(code);
}

// ---------------------------------------------------------------------------
// Request handling

enum Action {
    /// Response already enqueued (or client gone); keep reading.
    Continue,
    /// Stream a large value back as chunks after releasing the lock.
    Chunks { id: Value, json: Arc<String>, rev: u64 },
    /// Client asked us to exit.
    Shutdown,
    /// Protocol violation; close this connection.
    Close,
}

/// Figma-style per-property merge: patch fields overwrite, `null` deletes a
/// field, nested objects merge recursively, everything else replaces.
fn deep_merge(base: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (k, v) in patch {
        match v {
            Value::Null => {
                base.remove(k);
            }
            Value::Object(patch_obj) => {
                if let Some(Value::Object(base_obj)) = base.get_mut(k) {
                    deep_merge(base_obj, patch_obj);
                } else {
                    base.insert(k.clone(), v.clone());
                }
            }
            _ => {
                base.insert(k.clone(), v.clone());
            }
        }
    }
}

fn err_line(id: &Value, msg: &str) -> String {
    json!({"id": id, "ok": false, "error": msg}).to_string()
}

fn conflict_line(id: &Value, rev: u64, value: Option<Value>, large: bool) -> String {
    let mut resp = json!({"id": id, "ok": false, "error": "conflict", "rev": rev});
    match value {
        Some(v) => resp["value"] = v,
        None => resp["value"] = Value::Null,
    }
    if large {
        resp["large"] = json!(true);
    }
    resp.to_string()
}

fn handle_request(
    shared: &mut Shared,
    cfg: &Config,
    line: &str,
    conn_id: u64,
    wal_bytes: &AtomicU64,
) -> Action {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            shared.respond(conn_id, json!({"ok": false, "error": "invalid json"}).to_string());
            return Action::Continue;
        }
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    let key = req.get("key").and_then(Value::as_str).map(str::to_string);
    let if_rev = req.get("ifRev").and_then(Value::as_u64);
    let ttl_ms = req.get("ttl").and_then(Value::as_u64);
    let ephemeral = req.get("ephemeral").and_then(Value::as_bool).unwrap_or(false);

    macro_rules! respond {
        ($line:expr) => {{
            shared.respond(conn_id, $line);
            return Action::Continue;
        }};
    }
    macro_rules! need_key {
        () => {
            match key {
                Some(ref k) => k.clone(),
                None => respond!(err_line(&id, "missing key")),
            }
        };
    }

    match op {
        "hello" => {
            let v = req.get("v").and_then(Value::as_u64).unwrap_or(0);
            if v != PROTOCOL_V {
                respond!(json!({
                    "id": id, "ok": false,
                    "error": format!("unsupported protocol version {v} (daemon speaks v{PROTOCOL_V})"),
                    "v": PROTOCOL_V, "version": VERSION
                })
                .to_string());
            }
            respond!(json!({
                "id": id, "ok": true, "v": PROTOCOL_V,
                "rev": shared.rev, "version": VERSION
            })
            .to_string());
        }

        "ping" => respond!(json!({
            "id": id, "ok": true, "pong": true,
            "rev": shared.rev, "v": PROTOCOL_V, "version": VERSION
        })
        .to_string()),

        "stats" => {
            let bytes: usize = shared.state.values().map(|e| e.size).sum();
            respond!(json!({
                "id": id, "ok": true,
                "clients": shared.clients,
                "keys": shared.state.len(),
                "rev": shared.rev,
                "bytes": bytes,
                "walBytes": wal_bytes.load(Ordering::Relaxed),
                "uptimeMs": now_ms().saturating_sub(shared.start_ms),
                "v": PROTOCOL_V,
                "version": VERSION
            })
            .to_string());
        }

        "snapshot" => {
            let mut small = Map::new();
            let mut large = Map::new();
            for (k, e) in &shared.state {
                if e.is_large() {
                    large.insert(k.clone(), json!({"size": e.size, "r": e.rev}));
                } else {
                    small.insert(k.clone(), json!({"v": e.value, "r": e.rev}));
                }
            }
            respond!(json!({
                "id": id, "ok": true, "rev": shared.rev,
                "state": Value::Object(small),
                "large": Value::Object(large)
            })
            .to_string());
        }

        "keys" => {
            let prefix = req.get("prefix").and_then(Value::as_str).unwrap_or("");
            let keys: Vec<&String> = shared
                .state
                .keys()
                .filter(|k| k.starts_with(prefix))
                .collect();
            respond!(json!({"id": id, "ok": true, "keys": keys, "rev": shared.rev}).to_string());
        }

        "get" => {
            let k = need_key!();
            match shared.state.get(&k) {
                Some(e) if e.is_large() => respond!(json!({
                    "id": id, "ok": true, "large": {"size": e.size}, "rev": e.rev
                })
                .to_string()),
                Some(e) => respond!(json!({
                    "id": id, "ok": true, "value": e.value, "rev": e.rev
                })
                .to_string()),
                None => respond!(json!({
                    "id": id, "ok": true, "value": null, "rev": 0
                })
                .to_string()),
            }
        }

        "set" => {
            let k = need_key!();
            let value = req.get("value").cloned().unwrap_or(Value::Null);
            let serialized = value.to_string();
            let size = serialized.len();
            if size > cfg.max_value {
                respond!(err_line(&id, "value too large"));
            }
            let json_cache =
                if size > LARGE_THRESHOLD { Some(Arc::new(serialized)) } else { None };
            let owner = if ephemeral { Some(conn_id) } else { None };
            match shared.apply_set(&k, value, json_cache, size, if_rev, ttl_ms, owner) {
                SetOutcome::Ok(rev) => {
                    respond!(json!({"id": id, "ok": true, "rev": rev}).to_string())
                }
                SetOutcome::Conflict { rev, value, large } => {
                    respond!(conflict_line(&id, rev, value, large))
                }
            }
        }

        // Atomic per-property merge (last-writer-wins per field): concurrent
        // merges to different fields of the same key never conflict.
        "merge" => {
            let k = need_key!();
            let Some(patch) = req.get("value").and_then(Value::as_object).cloned() else {
                respond!(err_line(&id, "merge requires an object value"));
            };
            if let Some(e) = shared.state.get(&k) {
                if e.is_large() {
                    respond!(err_line(&id, "cannot merge into a large value; use set"));
                }
            }
            let mut base = match shared.state.get(&k).map(|e| e.value.clone()) {
                Some(Value::Object(obj)) => obj,
                _ => Map::new(),
            };
            deep_merge(&mut base, &patch);
            let merged = Value::Object(base);
            let serialized = merged.to_string();
            let size = serialized.len();
            if size > cfg.max_value {
                respond!(err_line(&id, "merged value too large"));
            }
            let json_cache =
                if size > LARGE_THRESHOLD { Some(Arc::new(serialized)) } else { None };
            match shared.apply_set(&k, merged.clone(), json_cache, size, if_rev, ttl_ms, None) {
                SetOutcome::Ok(rev) => respond!(json!({
                    "id": id, "ok": true, "rev": rev, "value": merged
                })
                .to_string()),
                SetOutcome::Conflict { rev, value, large } => {
                    respond!(conflict_line(&id, rev, value, large))
                }
            }
        }

        "del" => {
            let k = need_key!();
            let existed = shared.apply_del(&k, None).is_some();
            respond!(json!({
                "id": id, "ok": true, "existed": existed, "rev": shared.rev
            })
            .to_string());
        }

        "incr" => {
            let k = need_key!();
            let by = req.get("by").cloned().unwrap_or(json!(1));
            let cur = shared.state.get(&k).map(|e| e.value.clone()).unwrap_or(Value::Null);
            let next = match (cur.as_i64(), by.as_i64()) {
                (Some(c), Some(b)) => json!(c + b),
                _ => {
                    let c = cur.as_f64().unwrap_or(0.0);
                    let b = by.as_f64().unwrap_or(1.0);
                    match serde_json::Number::from_f64(c + b) {
                        Some(n) => Value::Number(n),
                        None => respond!(err_line(&id, "incr result is not a finite number")),
                    }
                }
            };
            let next = if cur.is_null() && next.is_number() && by.as_i64().is_some() {
                // missing key + integer by → integer result starting from 0
                json!(by.as_i64().unwrap())
            } else {
                next
            };
            let size = next.to_string().len();
            match shared.apply_set(&k, next.clone(), None, size, None, ttl_ms, None) {
                SetOutcome::Ok(rev) => respond!(json!({
                    "id": id, "ok": true, "value": next, "rev": rev
                })
                .to_string()),
                SetOutcome::Conflict { .. } => unreachable!("incr never passes ifRev"),
            }
        }

        "mset" => {
            let entries = req
                .get("entries")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let dels: Vec<String> = req
                .get("del")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if entries.is_empty() && dels.is_empty() {
                respond!(err_line(&id, "mset requires entries and/or del"));
            }
            for (k, v) in &entries {
                let size = v.to_string().len();
                if size > LARGE_THRESHOLD {
                    respond!(err_line(
                        &id,
                        &format!("value for '{k}' too large for mset; use set")
                    ));
                }
            }
            shared.rev += 1;
            let rev = shared.rev;
            shared.wal(
                json!({"r": rev, "o": "m", "e": entries, "d": dels}).to_string(),
            );
            for (k, v) in &entries {
                let size = v.to_string().len();
                shared.state.insert(
                    k.clone(),
                    Entry {
                        value: v.clone(),
                        rev,
                        size,
                        json: None,
                        ephemeral_owner: None,
                        expires_at_ms: None,
                    },
                );
            }
            for k in &dels {
                shared.state.remove(k);
            }
            let keys: Vec<&str> = entries
                .keys()
                .map(String::as_str)
                .chain(dels.iter().map(String::as_str))
                .collect();
            let event = json!({
                "ev": "mchange", "entries": entries, "del": dels, "rev": rev
            })
            .to_string();
            shared.emit(&keys, &event);
            respond!(json!({"id": id, "ok": true, "rev": rev}).to_string());
        }

        "clear" => {
            shared.state.clear();
            shared.rev += 1;
            let rev = shared.rev;
            shared.wal(json!({"r": rev, "o": "c"}).to_string());
            shared.emit(&[], &json!({"ev": "clear", "rev": rev}).to_string());
            respond!(json!({"id": id, "ok": true, "rev": rev}).to_string());
        }

        "sub" => {
            let handle = match shared.conns.get_mut(&conn_id) {
                Some(h) => h,
                None => return Action::Close,
            };
            match req.get("match") {
                None => handle.spec.all = true,
                Some(Value::String(p)) => handle.spec.add_pattern(p),
                Some(Value::Array(pats)) => {
                    for p in pats.iter().filter_map(Value::as_str) {
                        handle.spec.add_pattern(p);
                    }
                }
                Some(_) => respond!(err_line(&id, "match must be a string or array")),
            }
            respond!(json!({"id": id, "ok": true, "rev": shared.rev}).to_string());
        }

        "unsub" => {
            if let Some(h) = shared.conns.get_mut(&conn_id) {
                h.spec = SubSpec::default();
            }
            respond!(json!({"id": id, "ok": true}).to_string());
        }

        // -- chunked upload ------------------------------------------------
        "bset" => {
            let k = need_key!();
            let size = req.get("size").and_then(Value::as_u64).unwrap_or(0) as usize;
            if size == 0 || size > cfg.max_value {
                respond!(err_line(&id, "invalid or too-large blob size"));
            }
            // Fast-fail CAS check; re-checked at commit.
            if let Some(expected) = if_rev {
                let cur = shared.state.get(&k).map(|e| e.rev).unwrap_or(0);
                if expected != cur {
                    respond!(conflict_line(&id, cur, None, true));
                }
            }
            shared.next_blob_token += 1;
            let token = shared.next_blob_token;
            shared.blobs.insert(
                (conn_id, token),
                PendingBlob {
                    key: k,
                    if_rev,
                    ttl_ms,
                    ephemeral,
                    size,
                    buf: Vec::with_capacity(size.min(4 * 1024 * 1024)),
                },
            );
            respond!(json!({"id": id, "ok": true, "token": token}).to_string());
        }

        "bchunk" => {
            let token = req.get("token").and_then(Value::as_u64).unwrap_or(0);
            let data = req.get("data").and_then(Value::as_str).unwrap_or("");
            let Some(blob) = shared.blobs.get_mut(&(conn_id, token)) else {
                respond!(err_line(&id, "unknown blob token"));
            };
            match B64.decode(data) {
                Ok(bytes) => {
                    if blob.buf.len() + bytes.len() > blob.size {
                        shared.blobs.remove(&(conn_id, token));
                        respond!(err_line(&id, "blob overflow"));
                    }
                    blob.buf.extend_from_slice(&bytes);
                    respond!(json!({"id": id, "ok": true}).to_string());
                }
                Err(_) => {
                    shared.blobs.remove(&(conn_id, token));
                    respond!(err_line(&id, "invalid base64"));
                }
            }
        }

        "bcommit" => {
            let token = req.get("token").and_then(Value::as_u64).unwrap_or(0);
            let Some(blob) = shared.blobs.remove(&(conn_id, token)) else {
                respond!(err_line(&id, "unknown blob token"));
            };
            if blob.buf.len() != blob.size {
                respond!(err_line(&id, "blob incomplete"));
            }
            let text = match String::from_utf8(blob.buf) {
                Ok(t) => t,
                Err(_) => respond!(err_line(&id, "blob is not utf-8")),
            };
            let value: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => respond!(err_line(&id, "blob is not valid json")),
            };
            let size = text.len();
            let json_cache =
                if size > LARGE_THRESHOLD { Some(Arc::new(text)) } else { None };
            let owner = if blob.ephemeral { Some(conn_id) } else { None };
            match shared.apply_set(
                &blob.key, value, json_cache, size, blob.if_rev, blob.ttl_ms, owner,
            ) {
                SetOutcome::Ok(rev) => {
                    respond!(json!({"id": id, "ok": true, "rev": rev}).to_string())
                }
                SetOutcome::Conflict { rev, value, large } => {
                    respond!(conflict_line(&id, rev, value, large))
                }
            }
        }

        // -- chunked download ----------------------------------------------
        "bget" => {
            let k = need_key!();
            match shared.state.get(&k) {
                Some(e) if e.is_large() => {
                    let json = match &e.json {
                        Some(j) => j.clone(),
                        None => Arc::new(e.value.to_string()),
                    };
                    Action::Chunks { id, json, rev: e.rev }
                }
                Some(e) => respond!(json!({
                    "id": id, "ok": true, "value": e.value, "rev": e.rev, "done": true
                })
                .to_string()),
                None => respond!(json!({
                    "id": id, "ok": true, "value": null, "rev": 0, "done": true
                })
                .to_string()),
            }
        }

        // Transient lane: fire-and-forget fan-out for high-frequency data
        // (cursors, drag motion). No revision, no WAL, no state, no ack —
        // the daemon only relays. Lost pulses cost nothing; the next one
        // arrives milliseconds later.
        "pulse" => {
            let ch = req.get("ch").and_then(Value::as_str).unwrap_or("");
            if !ch.is_empty() {
                let value = req.get("value").cloned().unwrap_or(Value::Null);
                let event = json!({"ev": "pulse", "ch": ch, "value": value}).to_string();
                shared.emit(&[ch], &event);
                // Optional bounded history (a "stream"): keep the last N
                // pulses in memory so a late joiner can backfill. Never
                // persisted — history dies with the daemon, by design.
                let keep = req.get("keep").and_then(Value::as_u64).unwrap_or(0) as usize;
                if keep > 0 {
                    let keep = keep.min(STREAM_KEEP_MAX);
                    if !shared.streams.contains_key(ch) {
                        if shared.streams.len() >= STREAM_CHANNELS_MAX {
                            if let Some(oldest) = shared.stream_order.pop_front() {
                                shared.streams.remove(&oldest);
                            }
                        }
                        shared.stream_order.push_back(ch.to_string());
                    }
                    let buf = shared.streams.entry(ch.to_string()).or_default();
                    buf.push_back(value);
                    while buf.len() > keep {
                        buf.pop_front();
                    }
                }
            }
            if !id.is_null() {
                shared.respond(conn_id, json!({"id": id, "ok": true}).to_string());
            }
            Action::Continue
        }

        // Read back a stream's retained history (most recent last).
        "hist" => {
            let ch = req.get("ch").and_then(Value::as_str).unwrap_or("");
            let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let values: Vec<Value> = shared
                .streams
                .get(ch)
                .map(|buf| buf.iter().rev().take(limit).rev().cloned().collect())
                .unwrap_or_default();
            respond!(json!({"id": id, "ok": true, "values": values}).to_string());
        }

        "shutdown" => {
            shared.respond(conn_id, json!({"id": id, "ok": true, "bye": true}).to_string());
            Action::Shutdown
        }

        _ => {
            shared.respond(conn_id, err_line(&id, "unknown op"));
            Action::Continue
        }
    }
}

// ---------------------------------------------------------------------------
// Connection serving

async fn serve_conn<S>(
    stream: S,
    shared: Arc<Mutex<Shared>>,
    cfg: Arc<Config>,
    wal_bytes: Arc<AtomicU64>,
    conn_id: u64,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<String>(CONN_QUEUE);
    let (kill_tx, mut kill_rx) = watch::channel(false);

    {
        let mut s = shared.lock().await;
        s.clients += 1;
        s.idle_since = None;
        s.conns.insert(
            conn_id,
            ConnHandle { tx: tx.clone(), _kill: kill_tx, spec: SubSpec::default() },
        );
    }

    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                changed = kill_rx.changed() => {
                    // Either an explicit kill or the handle was dropped
                    // (slow-client eviction): stop writing, closing the socket.
                    if changed.is_err() || *kill_rx.borrow() {
                        break;
                    }
                }
                msg = rx.recv() => match msg {
                    Some(line) => {
                        if writer.write_all(line.as_bytes()).await.is_err()
                            || writer.write_all(b"\n").await.is_err()
                        {
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
    });

    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    'read: loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > cfg.max_frame {
            let _ = tx
                .send(json!({"ok": false, "error": "frame too large"}).to_string())
                .await;
            break;
        }

        let action = {
            let mut s = shared.lock().await;
            handle_request(&mut s, &cfg, &line, conn_id, &wal_bytes)
        };

        match action {
            Action::Continue => {}
            Action::Close => break,
            Action::Chunks { id, json, rev } => {
                // Stream outside the lock; the value is an immutable Arc, so
                // concurrent writes to the store don't block on us.
                let bytes = json.as_bytes();
                let total = bytes.len().div_ceil(CHUNK_RAW);
                for (seq, chunk) in bytes.chunks(CHUNK_RAW).enumerate() {
                    let frame = json!({
                        "id": id, "seq": seq, "data": B64.encode(chunk), "more": true
                    })
                    .to_string();
                    if tx.send(frame).await.is_err() {
                        break 'read;
                    }
                }
                let done = json!({
                    "id": id, "ok": true, "done": true, "rev": rev, "chunks": total
                })
                .to_string();
                if tx.send(done).await.is_err() {
                    break;
                }
            }
            Action::Shutdown => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let s = shared.lock().await;
                cleanup_and_exit(&cfg, &s, 0);
            }
        }
    }

    // Disconnect: drop this connection's ephemeral keys and pending blobs.
    {
        let mut s = shared.lock().await;
        s.conns.remove(&conn_id);
        s.blobs.retain(|(cid, _), _| *cid != conn_id);
        s.clients = s.clients.saturating_sub(1);
        if s.clients == 0 {
            s.idle_since = Some(Instant::now());
        }
        let owned: Vec<String> = s
            .state
            .iter()
            .filter(|(_, e)| e.ephemeral_owner == Some(conn_id))
            .map(|(k, _)| k.clone())
            .collect();
        for k in owned {
            s.apply_del(&k, Some("eph"));
        }
    }
    drop(tx);
    let _ = write_task.await;
}

// ---------------------------------------------------------------------------
// Background tasks

async fn sweep_loop(shared: Arc<Mutex<Shared>>) {
    loop {
        tokio::time::sleep(Duration::from_millis(SWEEP_MS)).await;
        let mut s = shared.lock().await;
        let now = now_ms();
        let expired: Vec<String> = s
            .state
            .iter()
            .filter(|(_, e)| e.expires_at_ms.map(|x| x <= now).unwrap_or(false))
            .map(|(k, _)| k.clone())
            .collect();
        for k in expired {
            s.apply_del(&k, Some("expired"));
        }
    }
}

async fn idle_loop(cfg: Arc<Config>, shared: Arc<Mutex<Shared>>) {
    if cfg.idle_timeout_secs == 0 {
        return;
    }
    let timeout = Duration::from_secs(cfg.idle_timeout_secs);
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let s = shared.lock().await;
        if let Some(since) = s.idle_since {
            if s.clients == 0 && since.elapsed() >= timeout {
                eprintln!("bellstated: idle for {}s, exiting", cfg.idle_timeout_secs);
                cleanup_and_exit(&cfg, &s, 0);
            }
        }
    }
}

async fn signal_loop(cfg: Arc<Config>, shared: Arc<Mutex<Shared>>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    let s = shared.lock().await;
    cleanup_and_exit(&cfg, &s, 0);
}

// ---------------------------------------------------------------------------
// Accept loops

#[cfg(unix)]
async fn accept_loop(
    cfg: Arc<Config>,
    shared: Arc<Mutex<Shared>>,
    wal_bytes: Arc<AtomicU64>,
) -> std::io::Result<()> {
    use tokio::net::{UnixListener, UnixStream};

    let path = PathBuf::from(&cfg.socket_path);
    if path.exists() {
        match UnixStream::connect(&path).await {
            Ok(_) => {
                eprintln!(
                    "bellstated: already running for namespace '{}' at {}",
                    cfg.namespace, cfg.socket_path
                );
                process::exit(0);
            }
            Err(_) => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    if let Some(parent) = path.parent() {
        ensure_private_dir(&parent.to_path_buf());
    }
    let listener = UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    eprintln!(
        "bellstated {} (protocol v{}) listening on {} (namespace '{}')",
        VERSION, PROTOCOL_V, cfg.socket_path, cfg.namespace
    );

    let mut next_conn: u64 = 1;
    loop {
        let (stream, _) = listener.accept().await?;
        let conn_id = next_conn;
        next_conn += 1;
        tokio::spawn(serve_conn(
            stream,
            shared.clone(),
            cfg.clone(),
            wal_bytes.clone(),
            conn_id,
        ));
    }
}

#[cfg(windows)]
async fn accept_loop(
    cfg: Arc<Config>,
    shared: Arc<Mutex<Shared>>,
    wal_bytes: Arc<AtomicU64>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = cfg.socket_path.clone();
    let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "bellstated: already running for namespace '{}' at {}",
                cfg.namespace, name
            );
            process::exit(0);
        }
    };
    eprintln!(
        "bellstated {} (protocol v{}) listening on {} (namespace '{}')",
        VERSION, PROTOCOL_V, name, cfg.namespace
    );

    let mut next_conn: u64 = 1;
    loop {
        server.connect().await?;
        let stream = server;
        server = ServerOptions::new().create(&name)?;
        let conn_id = next_conn;
        next_conn += 1;
        tokio::spawn(serve_conn(
            stream,
            shared.clone(),
            cfg.clone(),
            wal_bytes.clone(),
            conn_id,
        ));
    }
}

// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Arc::new(parse_args());

    let (state, rev) = load_state(&cfg);
    let (wal_tx, wal_rx) = mpsc::unbounded_channel::<WalCmd>();
    let shared = Arc::new(Mutex::new(Shared {
        state,
        rev,
        conns: HashMap::new(),
        clients: 0,
        idle_since: Some(Instant::now()),
        blobs: HashMap::new(),
        next_blob_token: 0,
        wal_tx,
        start_ms: now_ms(),
        streams: HashMap::new(),
        stream_order: VecDeque::new(),
    }));
    let wal_bytes = Arc::new(AtomicU64::new(0));

    ensure_private_dir(&runtime_dir());
    let _ = std::fs::write(&cfg.pid_file, process::id().to_string());

    tokio::spawn(wal_loop(wal_rx, cfg.clone(), shared.clone(), wal_bytes.clone()));
    tokio::spawn(sweep_loop(shared.clone()));
    tokio::spawn(idle_loop(cfg.clone(), shared.clone()));
    tokio::spawn(signal_loop(cfg.clone(), shared.clone()));

    accept_loop(cfg, shared, wal_bytes).await
}
