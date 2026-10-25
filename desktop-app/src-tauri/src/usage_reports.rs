//! Shared-drive usage ledger. Each generation revision is an immutable file;
//! CSV reports are derived views, never the authoritative data.
use crate::sync;
use chrono::{DateTime, Local, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub model: Option<String>,
    pub quality: Option<String>,
    pub aspect: Option<String>,
    pub requested_size: Option<String>,
    pub task_id: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEvent { client_id: String, event: UsageEvent }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportRow {
    account_name: String,
    account_id: String,
    client_id: String,
    attempts: usize,
    success: usize,
    failed: usize,
    unknown: usize,
    cancelled: usize,
    pending: usize,
}

fn date_of(timestamp: i64) -> Result<String, String> {
    let utc = DateTime::<Utc>::from_timestamp_millis(timestamp).ok_or("生图时间无效")?;
    Ok(utc.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn validate(event: &UsageEvent) -> Result<String, String> {
    uuid::Uuid::parse_str(&event.id).map_err(|_| "生图记录编号无效")?;
    uuid::Uuid::parse_str(&event.account_id).map_err(|_| "账号编号无效")?;
    if event.revision == 0 || !["pending", "success", "failed", "cancelled", "unknown"].contains(&event.status.as_str()) { return Err("生图记录状态无效".into()); }
    if event.account_name.trim().is_empty() || event.account_name.chars().count() > 64 { return Err("账号名称无效".into()); }
    date_of(event.created_at)
}

fn write_event(root: &Path, client_id: &str, event: &UsageEvent) -> Result<String, String> {
    let day = validate(event)?;
    let dir = root.join("usage").join("events").join(&day).join(client_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let destination = dir.join(format!("{}-{}.json", event.id, event.revision));
    if destination.exists() { return Ok(day); }
    let temporary = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let stored = StoredEvent { client_id: client_id.to_string(), event: event.clone() };
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &stored).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if destination.exists() { return Ok(()); }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())
    })();
    if temporary.exists() { let _ = fs::remove_file(&temporary); }
    result.map(|_| day)
}

fn events_for(root: &Path, period: &str) -> Vec<StoredEvent> {
    let mut latest: HashMap<String, StoredEvent> = HashMap::new();
    let days = root.join("usage").join("events");
    let Ok(day_entries) = fs::read_dir(days) else { return vec![] };
    for day in day_entries.flatten() {
        let day_name = day.file_name().to_string_lossy().into_owned();
        if !day_name.starts_with(period) || (period.len() == 10 && day_name != period) { continue }
        let Ok(clients) = fs::read_dir(day.path()) else { continue };
        for client in clients.flatten() {
            let Ok(files) = fs::read_dir(client.path()) else { continue };
            for file in files.flatten() {
                if file.path().extension().and_then(|value| value.to_str()) != Some("json") { continue }
                let Ok(raw) = fs::read(file.path()) else { continue };
                let Ok(stored) = serde_json::from_slice::<StoredEvent>(&raw) else { continue };
                let key = format!("{}:{}", stored.client_id, stored.event.id);
                if latest.get(&key).map_or(true, |old| old.event.revision < stored.event.revision) { latest.insert(key, stored); }
            }
        }
    }
    latest.into_values().collect()
}

fn rows_for(root: &Path, period: &str) -> Vec<ReportRow> {
    let mut rows: HashMap<String, ReportRow> = HashMap::new();
    for stored in events_for(root, period) {
        let event = stored.event;
        let key = format!("{}:{}", stored.client_id, event.account_id);
        let row = rows.entry(key).or_insert_with(|| ReportRow { account_name: event.account_name.clone(), account_id: event.account_id.clone(), client_id: stored.client_id.clone(), attempts: 0, success: 0, failed: 0, unknown: 0, cancelled: 0, pending: 0 });
        row.account_name = event.account_name;
        row.attempts += 1;
        match event.status.as_str() { "success" => row.success += 1, "failed" => row.failed += 1, "unknown" => row.unknown += 1, "cancelled" => row.cancelled += 1, _ => row.pending += 1 }
    }
    let mut rows: Vec<_> = rows.into_values().collect();
    rows.sort_by(|a, b| b.success.cmp(&a.success).then(b.attempts.cmp(&a.attempts)).then(a.account_name.cmp(&b.account_name)));
    rows
}

fn csv_field(value: &str) -> String {
    let safe = if value.chars().next().is_some_and(|first| matches!(first, '=' | '+' | '-' | '@')) { format!("'{value}") } else { value.to_string() };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

fn write_report(root: &Path, period: &str) -> Result<PathBuf, String> {
    let category = if period.len() == 10 { "daily" } else { "monthly" };
    let dir = root.join("usage").join("reports").join(category);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let destination = dir.join(format!("{period}.csv"));
    let lock_file = OpenOptions::new().create(true).write(true).open(dir.join(format!("{period}.lock"))).map_err(|error| error.to_string())?;
    let start = Instant::now();
    loop {
        if lock_file.try_lock_exclusive().is_ok() { break }
        if start.elapsed() > Duration::from_secs(3) { return Err("共享盘日报正在由其他电脑更新，请稍后重试".into()) }
        thread::sleep(Duration::from_millis(100));
    }
    let result = (|| -> Result<PathBuf, String> {
        let rows = rows_for(root, period);
        let mut csv = String::from("\u{feff}日期,账号,设备编号,账号编号,请求次数,成功张数,失败张数,待核查,取消次数,进行中\r\n");
        for row in rows {
            csv.push_str(&format!("{},{},{},{},{},{},{},{},{},{}\r\n", csv_field(period), csv_field(&row.account_name), csv_field(&row.client_id), csv_field(&row.account_id), row.attempts, row.success, row.failed, row.unknown, row.cancelled, row.pending));
        }
        let temporary = dir.join(format!(".{period}-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, csv.as_bytes()).map_err(|error| error.to_string())?;
        if destination.exists() { fs::remove_file(&destination).map_err(|error| format!("请先关闭正在打开的共享盘报表：{error}"))?; }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(destination)
    })();
    let _ = FileExt::unlock(&lock_file);
    result
}

pub fn publish(state: &sync::ShareState, events: Vec<UsageEvent>) -> Result<Value, String> {
    let root = sync::current_path(state).ok_or("尚未连接提示词收藏夹共享盘")?;
    if !root.is_dir() { return Err("共享盘当前无法访问，生图记录将在本机等待补传".into()) }
    if events.len() > 5000 { return Err("待同步记录过多，请分批同步".into()) }
    let client_id = sync::client_id();
    let mut acknowledged = Vec::with_capacity(events.len());
    let mut days = HashSet::new();
    for event in events {
        let day = write_event(&root, &client_id, &event)?;
        days.insert(day);
        acknowledged.push(json!({ "id": event.id, "revision": event.revision }));
    }
    let mut periods = HashSet::new();
    for day in &days { periods.insert(day.clone()); periods.insert(day[..7].to_string()); }
    for period in periods { write_report(&root, &period)?; }
    Ok(json!({ "acknowledged": acknowledged, "reportFolder": root.join("usage/reports").to_string_lossy() }))
}

pub fn report(state: &sync::ShareState) -> Result<Value, String> {
    let root = sync::current_path(state).ok_or("尚未连接提示词收藏夹共享盘")?;
    if !root.is_dir() { return Err("共享盘当前无法访问".into()) }
    let day = Local::now().format("%Y-%m-%d").to_string();
    let month = Local::now().format("%Y-%m").to_string();
    Ok(json!({ "day": day, "month": month, "daily": rows_for(&root, &day), "monthly": rows_for(&root, &month), "dailyCsv": root.join("usage/reports/daily").join(format!("{day}.csv")).to_string_lossy(), "monthlyCsv": root.join("usage/reports/monthly").join(format!("{month}.csv")).to_string_lossy() }))
}
