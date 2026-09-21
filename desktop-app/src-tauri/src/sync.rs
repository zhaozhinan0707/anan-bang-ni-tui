//! 共享盘多人实时同步引擎（V1.1）
//!
//! 架构要点（详见 PRD 第 7 章）：
//!  - 共享盘目录结构：
//!      cards/{YYYYMM}/{cardId}/card.json   卡片元数据（权威副本）
//!      cards/{YYYYMM}/{cardId}/image.jpg   压缩图（本地保留原图，共享盘存压缩版）
//!      changelog/{YYYYMM}.log              追加式变更日志（唯一权威信号源）
//!      tombstones/{cardId}.tomb            软删除墓碑（30 天保留，之后压缩归档）
//!      versions/{cardId}/v{n}.json         历史版本（含冲突败者，供对比/回滚）
//!      categories/category.json            分类定义（V1.1 暂由本地库管理）
//!  - 并发控制：fs2 短临界区文件锁（每卡一个 .lock）+ CAS 读回校验 + 败者自动归档
//!  - 变更传播：本地一切增改删先入本地 outbox → 在线时 CAS 推送并写 changelog
//!              → 各端从 watermark 增量消费 changelog 应用远端变更（LWW）
//!  - 离线可用：本地 SQLite 为单机权威副本；断网仅积压 outbox，重连自动补推
//!
//! ⚠️ 明确不推荐：把 SQLite 数据库文件直接放共享盘多人并发写 —— SMB 网络锁不可靠，
//!    多进程写同一库文件会损坏。因此共享盘只放「每卡独立小文件 + 追加式日志」。

use crate::storage;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// 共享盘根路径（设置页配置，未配置 = 纯本地模式）
pub struct ShareState(pub Mutex<Option<PathBuf>>);

/* ══════════════════ 基础：路径 / 客户端 ID / 目录初始化 ══════════════════ */

pub fn set_path(state: &ShareState, path: String) {
    let trimmed = path.trim().to_string();
    *state.0.lock().unwrap() = if trimmed.is_empty() { None } else { Some(PathBuf::from(&trimmed)) };
    // 持久化到 SQLite：程序重启后自动恢复共享盘配置（同事装完只填一次）
    if trimmed.is_empty() {
        let _ = storage::set_sync_value("share_path", "");
    } else {
        let _ = storage::set_sync_value("share_path", &trimmed);
    }
    // 路径变化即重置上次同步时间，下次 sync_once 立即全量回放（watermark 自动续跑）
    if trimmed.is_empty() { return; }
    let _ = storage::set_sync_value("last_sync", "");
}

/// 从 SQLite 恢复上次保存的共享盘路径（启动时调用，保证重启后团队同步配置不丢）
pub fn restore_saved_path(state: &ShareState) -> bool {
    let saved = storage::get_sync_value("share_path").unwrap_or_default();
    if saved.trim().is_empty() { return false; }
    *state.0.lock().unwrap() = Some(PathBuf::from(saved.trim()));
    true
}

pub fn current_path(state: &ShareState) -> Option<PathBuf> {
    state.0.lock().unwrap().clone()
}

/// 客户端唯一 ID：首次运行生成并持久化，changelog 用它溯源"谁改的"
pub fn client_id() -> String {
    if let Some(id) = storage::get_sync_value("client_id") {
        if !id.is_empty() { return id; }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = storage::set_sync_value("client_id", &id);
    id
}

/// 初始化共享盘目录骨架（幂等）
fn ensure_layout(root: &Path) -> std::io::Result<()> {
    for sub in ["cards", "changelog", "tombstones", "versions", "categories"] {
        fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}

/// 卡片的月份分片：按卡片 time 字段取 YYYYMM，缺省用当前月
fn card_shard(card: &storage::Card) -> String {
    if card.time.len() >= 7 {
        let t = card.time.replace(['-', ':', 'T', ' '], "");
        let t: String = t.chars().take(8).collect();
        if let Ok(dt) = chrono::NaiveDate::parse_from_str(&t, "%Y%m%d") {
            return dt.format("%Y%m").to_string();
        }
    }
    chrono::Local::now().format("%Y%m").to_string()
}

/// 定位卡片目录：优先按 shard 找，找不到则全盘扫描兜底（小团队目录少，成本可忽略）
fn find_card_dir(root: &Path, card_id: &str, shard_hint: Option<&str>) -> Option<PathBuf> {
    if let Some(s) = shard_hint {
        let p = root.join("cards").join(s).join(card_id);
        if p.join("card.json").exists() { return Some(p); }
    }
    let cards = root.join("cards");
    for shard in fs::read_dir(&cards).ok()?.flatten() {
        let p = shard.path().join(card_id);
        if p.join("card.json").exists() { return Some(p); }
    }
    None
}

/* ══════════════════ 变更日志（权威信号源） ══════════════════ */

/// 追加一条变更日志。append 模式天然并发安全，但为稳妥仍加 fs2 文件锁短临界区
/// （Windows SMB 上 LockFileEx 经 SMB 协议协调，基本可靠）。
pub fn append_changelog(root: &Path, op: &str, card_id: &str, version: i64, shard: &str) -> std::io::Result<()> {
    let dir = root.join("changelog");
    fs::create_dir_all(&dir)?;
    let month = chrono::Local::now().format("%Y%m").to_string();
    let path = dir.join(format!("{month}.log"));

    let entry = json!({
        "op": op,
        "cardId": card_id,
        "version": version,
        "shard": shard,
        "clientId": client_id(),
        "ts": chrono::Local::now().to_rfc3339()
    });

    // 短临界区文件锁，避免两个客户端同时 append 导致半行交错
    let lock_path = dir.join(format!("{month}.lock"));
    let lock = OpenOptions::new().create(true).append(true).open(&lock_path)?;
    let lock_guard = lock_exclusive(&lock, Duration::from_secs(3));
    let result = (|| {
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(f, "{}", entry)?;
        f.flush()?;
        Ok(())
    })();
    drop(lock_guard);
    result
}

/// 文件锁守卫：drop 时显式解锁（fs2 在 Windows 上锁与句柄绑定，必须显式 unlock）
struct LockGuard(fs::File);

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

/// fs2 独占锁（带超时）。成功返回持有锁的守卫；超时后降级为无锁继续（极端兜底，
/// 后续 CAS 读回校验仍能发现冲突并归档，不会静默丢数据）。
fn lock_exclusive(file: &fs::File, timeout: Duration) -> LockGuard {
    let start = Instant::now();
    loop {
        match fs2::FileExt::try_lock_exclusive(file) {
            Ok(()) => return LockGuard(file.try_clone().expect("clone lock file")),
            Err(_) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return LockGuard(file.try_clone().expect("lock timeout, proceed")),
        }
    }
}

/* ══════════════════ CAS 写协议（推送到共享盘） ══════════════════ */

/// CAS 写入结果
pub enum CasOutcome {
    /// 已写入共享盘（card.version 已被提升为远端最新版本）
    Applied,
    /// 冲突：远端已有更高版本（他人抢先修改）。我方版本已归档到 versions/，不覆盖远端。
    Conflict { archived_path: String },
    /// 共享盘不可用（断网/未配置），操作未执行
    Unavailable,
}

/// CAS 写协议核心：
///   1. 打开 cards/{shard}/{cardId}/card.json.lock 并独占锁定（短临界区）
///   2. 锁内读取远端 baseVersion
///   3. 新 version = baseVersion + 1，写 card.json.tmp-{clientId} → rename 原子替换
///   4. 读回校验：读回的 version 必须等于刚写的 version，否则判定冲突
///   5. 冲突时：我方内容归档到 versions/{cardId}/v{n}.json，远端保持不动
fn cas_write_card(root: &Path, card: &mut storage::Card, local_image: Option<&Path>) -> CasOutcome {
    let _ = ensure_layout(root);

    let shard = card_shard(card);
    let dir = root.join("cards").join(&shard).join(&card.id);
    let _ = fs::create_dir_all(&dir);

    let json_path = dir.join("card.json");
    let lock_path = dir.join("card.json.lock");
    let lock_file = match OpenOptions::new().create(true).append(true).open(&lock_path) {
        Ok(f) => f,
        Err(_) => return CasOutcome::Unavailable, // 共享盘不可写
    };
    let guard = lock_exclusive(&lock_file, Duration::from_secs(5));

    // 锁内：读远端 base
    let base_version = read_remote_version(root, &card.id, Some(&shard));

    // 新版本号 = 远端最新 + 1（绝不回退）
    let new_version = base_version.max(card.version) + 1;
    card.version = new_version;

    let content = match serde_json::to_string_pretty(card) {
        Ok(c) => c,
        Err(_) => { drop(guard); return CasOutcome::Conflict { archived_path: String::new() }; }
    };

    // tmp + rename 原子替换
    let tmp = dir.join(format!("card.json.tmp-{}", client_id().split('-').next().unwrap_or("x")));
    let write_ok = fs::write(&tmp, &content).is_ok()
        && fs::rename(&tmp, &json_path).is_ok();

    drop(guard); // 释放锁

    if !write_ok {
        let _ = fs::remove_file(&tmp);
        return CasOutcome::Unavailable;
    }

    // 读回校验：version 一致 → 成功；否则说明被覆盖（锁外兜底），归档我方为败者
    match read_remote_version(root, &card.id, Some(&shard)) {
        v if v == new_version => {
            // 推送图片（本地原图 → 共享盘压缩图，V1.1 先原样复制，压缩在 F7.2 引入）
            if let Some(src) = local_image {
                if src.exists() {
                    let _ = fs::copy(src, dir.join("image.jpg"));
                }
            }
            let _ = append_changelog(root, "upsert", &card.id, new_version, &shard);
            CasOutcome::Applied
        }
        _ => {
            let archive = archive_version(root, card);
            CasOutcome::Conflict { archived_path: archive }
        }
    }
}

/// 读取共享盘上某卡片的当前 version（无则 0）
fn read_remote_version(root: &Path, card_id: &str, shard: Option<&str>) -> i64 {
    let Some(dir) = find_card_dir(root, card_id, shard) else { return 0 };
    let Ok(text) = fs::read_to_string(dir.join("card.json")) else { return 0 };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("version").and_then(|x| x.as_i64()))
        .unwrap_or(0)
}

/// 读取共享盘上卡片完整内容（pull 端用）
fn read_remote_card(root: &Path, card_id: &str, shard: Option<&str>) -> Option<storage::Card> {
    let dir = find_card_dir(root, card_id, shard)?;
    let text = fs::read_to_string(dir.join("card.json")).ok()?;
    serde_json::from_str::<storage::Card>(&text).ok()
}

/// 归档一个版本到 versions/{cardId}/v{n}.json（历史版本 / 冲突败者共用）
fn archive_version(root: &Path, card: &storage::Card) -> String {
    let dir = root.join("versions").join(&card.id);
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("v{}.json", card.version));
    let wrapped = json!({
        "archivedAt": chrono::Local::now().to_rfc3339(),
        "archivedBy": client_id(),
        "card": card
    });
    if fs::write(&path, serde_json::to_string_pretty(&wrapped).unwrap_or_default()).is_ok() {
        path.to_string_lossy().into_owned()
    } else {
        String::new()
    }
}

/* ══════════════════ Outbox：本地变更先入队，在线再推送 ══════════════════ */

/// 本地变更入队（upsert / delete）。无论在线离线都先写本地库，再入 outbox。
pub fn enqueue_local_change(op: &str, card_id: &str) {
    let item = json!({ "op": op, "cardId": card_id, "ts": chrono::Local::now().to_rfc3339() });
    // 同一张卡片只保留最后一次变更，避免重复扫描/连续编辑造成队列膨胀。
    let mut outbox = storage::outbox_get();
    outbox.retain(|old| old.get("cardId").and_then(|v| v.as_str()) != Some(card_id));
    outbox.push(item);
    let _ = storage::outbox_set(&outbox);
}

/// 推送 outbox 中所有可推送的变更（在线时真实写共享盘，失败则保留待下次）
fn flush_outbox(root: &Path) -> (usize, usize) {
    let outbox = storage::outbox_get();
    let mut pushed = 0usize;
    let mut kept = 0usize;
    for item in &outbox {
        let op = item.get("op").and_then(|x| x.as_str()).unwrap_or("");
        let card_id = item.get("cardId").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if card_id.is_empty() { pushed += 1; continue; }

        let ok = match op {
            "upsert" => {
                if let Some(mut card) = storage::get_card(&card_id) {
                    // 本地图片路径 → 解析真实文件（绝对路径或 staging 相对文件名）
                    let img = resolve_local_image(&card.image_path);
                    match cas_write_card(root, &mut card, img.as_deref()) {
                        CasOutcome::Applied => {
                            // 推送后 version 已提升，回写本地保持一致
                            let _ = storage::insert_card(&card);
                            true
                        }
                        CasOutcome::Conflict { archived_path } => {
                            // 我方版本已被归档，本地打冲突标记，等待人工合并
                            let _ = storage::set_conflict(&card_id, true);
                            eprintln!("[sync] conflict on {card_id}, archived: {archived_path}");
                            true // 事件已处理（归档），从 outbox 移除
                        }
                        CasOutcome::Unavailable => false, // 共享盘不可用，保留待重试
                    }
                } else { true } // 卡片已被本地删除，丢弃该事件
            }
            "delete" => {
                // 写 tombstone（若尚未写）并广播 delete 事件
                if write_tombstone(root, &card_id) && append_changelog(root, "delete", &card_id, 0, "").is_ok() {
                    true
                } else { false }
            }
            _ => true, // 未知操作，丢弃
        };

        if ok { pushed += 1; } else { kept += 1; break; } // 遇不可用立即停止，避免空转
    }
    if pushed > 0 { let _ = storage::outbox_remove_first(pushed); }
    (pushed, kept)
}

/// 解析本地图片真实路径：绝对路径直接用；相对文件名则查下载目录 staging 或本地缓存
fn resolve_local_image(image_path: &str) -> Option<PathBuf> {
    if image_path.is_empty() { return None; }
    let p = PathBuf::from(image_path);
    if p.is_absolute() && p.exists() { return Some(p); }
    // staging 相对名：下载目录/PromptVault-staging/{name}
    if let Some(dl) = dirs_download_dir() {
        let staged = dl.join("PromptVault-staging").join(&p);
        if staged.exists() { return Some(staged); }
    }
    // 本地缓存：images/{name}
    if let Some(cache) = storage::images_dir() {
        let cached = cache.join(&p);
        if cached.exists() { return Some(cached); }
    }
    None
}

/// 系统下载目录（Windows: %USERPROFILE%/Downloads）
fn dirs_download_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|h| h.join("Downloads"))
}

/* ══════════════════ Tombstone：软删除传播 ══════════════════ */

/// 写 tombstones/{cardId}.tomb（幂等：已存在则跳过）。返回是否成功/已存在。
fn write_tombstone(root: &Path, card_id: &str) -> bool {
    let path = root.join("tombstones").join(format!("{card_id}.tomb"));
    if path.exists() { return true; }
    let _ = fs::create_dir_all(root.join("tombstones"));
    let card = storage::get_card(card_id);
    let tomb = json!({
        "cardId": card_id,
        "deletedBy": client_id(),
        "deletedAt": chrono::Local::now().to_rfc3339(),
        "card": card
    });
    fs::write(&path, serde_json::to_string_pretty(&tomb).unwrap_or_default()).is_ok()
}

/// 30 天保留期压缩：把过期 tombstone 移入 tombstones/archive（V1.2 再做自动清理，此处提供入口）
#[allow(dead_code)]
pub fn compact_tombstones(root: &Path) -> usize {
    let mut archived = 0usize;
    let dir = root.join("tombstones");
    let Ok(entries) = fs::read_dir(&dir) else { return 0 };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("tomb") { continue; }
        let Ok(text) = fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(ts) = v.get("deletedAt").and_then(|x| x.as_str()).map(String::from) else { continue };
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&ts) {
            if dt + chrono::Duration::days(30) < chrono::Local::now() {
                let _ = fs::create_dir_all(dir.join("archive"));
                let fname = p.file_name().unwrap_or_default();
                let _ = fs::rename(&p, dir.join("archive").join(fname));
                archived += 1;
            }
        }
    }
    archived
}

/* ══════════════════ Pull：watermark 增量消费 changelog ══════════════════ */

/// 从 watermark 开始消费 changelog，应用远端变更（LWW：版本不高于本地则忽略）。
/// 返回处理的事件数。
/// 文件夹分类模式不再使用（保留旧引擎备查）。
#[allow(dead_code)]
pub fn pull_changelog(root: &Path) -> usize {
    let month = chrono::Local::now().format("%Y%m").to_string();
    let log_path = root.join("changelog").join(format!("{month}.log"));
    if !log_path.exists() { return 0; }

    // watermark = 已处理的「行数」（追加式日志，行数即进度）
    let wm_key = format!("watermark/{month}");
    let start: usize = storage::get_sync_value(&wm_key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let f = match fs::File::open(&log_path) { Ok(f) => f, Err(_) => return 0 };
    let reader = BufReader::new(f);
    let mut processed = 0usize;

    for (idx, line) in reader.lines().enumerate() {
        if idx < start { continue; } // 跳过已处理行（enumerate 从 0 开始，watermark=行号）
        let Ok(line) = line else { break };
        if line.trim().is_empty() { processed += 1; continue; }
        let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };

        let card_id = ev.get("cardId").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let ev_client = ev.get("clientId").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let shard: Option<&str> = ev.get("shard").and_then(|x| x.as_str());

        match ev.get("op").and_then(|x| x.as_str()) {
            Some("upsert") => {
                // 自己写的事件：本地已是该版本，跳过
                if ev_client == client_id() { processed += 1; continue; }
                if let Some(remote) = read_remote_card(root, &card_id, shard) {
                    let local_v = storage::get_card(&card_id).map(|c| c.version).unwrap_or(0);
                    if remote.version > local_v {
                        apply_remote_card(root, &remote, shard);
                    }
                }
            }
            Some("delete") => {
                if ev_client == client_id() { processed += 1; continue; }
                // 远端 tombstone 存在 → 本地软删除
                if root.join("tombstones").join(format!("{card_id}.tomb")).exists() {
                    let _ = storage::mark_deleted(&card_id, true);
                }
            }
            _ => {}
        }
        processed += 1;
    }

    // 推进 watermark（= 已读到最后一行 +1）
    let new_wm = start + processed;
    if new_wm > start {
        let _ = storage::set_sync_value(&wm_key, &new_wm.to_string());
        let _ = storage::set_sync_value("last_sync", &chrono::Local::now().to_rfc3339());
    }
    processed
}

/// 应用远端卡片到本地：复制图片到本地缓存并入库（清冲突标记，远端权威）
fn apply_remote_card(root: &Path, remote: &storage::Card, shard: Option<&str>) {
    let mut card = remote.clone();
    // 远端图片 → 本地缓存 images/{cardId}.jpg
    if let Some(dir) = find_card_dir(root, &card.id, shard) {
        let src = dir.join("image.jpg");
        if src.exists() {
            if let Some(cache_dir) = storage::images_dir() {
                let _ = fs::create_dir_all(&cache_dir);
                let dest = cache_dir.join(format!("{}.jpg", card.id));
                if fs::copy(&src, &dest).is_ok() {
                    card.image_path = dest.to_string_lossy().into_owned();
                }
            }
        }
    }
    card.conflict = false; // 远端版本应用后视为已解决
    let _ = storage::insert_card(&card);
}

/* ══════════════════ 文件夹分类模式（共享盘 = 文件夹分类存储） ══════════════════ */

/// 系统保留目录（旧同步骨架，扫描时跳过）
const SYS_DIRS: [&str; 5] = ["cards", "changelog", "tombstones", "versions", "categories"];

/// 扫描共享盘根目录：每个子文件夹 = 一个分类，文件夹内图片 + 同名 .txt = 卡片。
/// 返回 (分类名列表, 卡片列表)。
fn scan_shared_folders(root: &Path) -> (Vec<String>, Vec<storage::Card>) {
    let mut cats: Vec<String> = vec![];
    let mut cards: Vec<storage::Card> = vec![];

    let Ok(entries) = fs::read_dir(root) else { return (cats, cards) };
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() { continue; }
        let cat_name = entry.file_name().to_string_lossy().into_owned();
        if cat_name.starts_with('.') || SYS_DIRS.contains(&cat_name.as_str()) { continue; }
        cats.push(cat_name.clone());

        let Ok(files) = fs::read_dir(&dir_path) else { continue };
        for f in files.flatten() {
            let fp = f.path();
            if !fp.is_file() { continue; }
            let ext = fp.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") { continue; }
            let stem = fp.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if stem.is_empty() { continue; }
            // 同名 txt = 提示词
            let txt_path = fp.with_extension("txt");
            let prompt = fs::read_to_string(&txt_path).unwrap_or_default().trim().to_string();
            cards.push(storage::Card {
                id: stem.clone(),
                prompt,
                negative_prompt: String::new(),
                source_tool: "共享盘".into(),
                category: cat_name.clone(),
                tags: "[]".into(),
                image_path: fp.to_string_lossy().into_owned(),
                params: "{}".into(),
                time: String::new(),
                version: 1,
                deleted: false,
                conflict: false,
                fav: false,
            });
        }
    }
    (cats, cards)
}

/// 从共享盘文件夹同步：自动建分类 + 导入卡片（增量：图片路径变化才更新）。
/// 返回导入数量。
pub fn sync_from_folders(state: &ShareState) -> usize {
    let Some(root) = current_path(state) else { return 0 };
    if !root.exists() { return 0; }
    let (cats, cards) = scan_shared_folders(&root);
    for c in &cats {
        let _ = storage::create_category(c);
    }
    let mut imported = 0usize;
    for card in cards {
        match storage::get_card(&card.id) {
            // 本地无该 id：从共享盘导入（共享盘是唯一来源）
            // → 图片复制到本地 $APPDATA/images/ 缓存，image_path 用缓存文件名
            //   （前端 convertFileSrc 的 assetProtocol.scope 只放行 $APPDATA/**，
            //     直接存共享盘 SMB 绝对路径会导致图片加载失败）
            None => {
                let mut local_card = card.clone();
                if !card.image_path.is_empty() {
                    let src = PathBuf::from(&card.image_path);
                    if src.exists() {
                        if let Some(cache) = storage::images_dir() {
                            let _ = fs::create_dir_all(&cache);
                            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
                            let dest = cache.join(format!("{}.{}", card.id, ext));
                            if dest.exists() || fs::copy(&src, &dest).is_ok() {
                                local_card.image_path = dest.file_name().unwrap().to_string_lossy().into_owned();
                            }
                        }
                    }
                }
                let _ = storage::insert_card(&local_card);
                imported += 1;
            }
            // 本地已有且图片路径一致：未变化，跳过
            Some(existing) if existing.image_path == card.image_path => {}
            // 本地已有但图片路径不一致（本地是相对名/缓存路径，共享盘是绝对路径）
            // → 保留本地的 image_path（指向 $APPDATA/images/，convertFileSrc 范围内），
            //   其它字段（prompt / category / version / time）从共享盘同步
            Some(existing) => {
                let mut merged = card.clone();
                merged.image_path = existing.image_path.clone();
                let _ = storage::insert_card(&merged);
                imported += 1;
            }
        }
    }
    imported
}

/// 一次性修复（V1.2）：历史上因 sync_from_folders 覆盖导致 image_path = 共享盘 SMB 绝对路径的卡片，
/// 从共享盘把图片复制回本地 $APPDATA/images/，image_path 改回缓存文件名（确保 convertFileSrc 能加载）。
/// 启动时跑一次即可——以后 sync_from_folders 不会再覆盖本地缓存路径。
pub fn repair_local_image_paths(state: &ShareState) -> usize {
    let Ok(cards) = storage::list_cards() else { return 0 };
    let Some(cache) = storage::images_dir() else { return 0 };
    let _ = fs::create_dir_all(&cache);
    let Some(root) = current_path(state) else { return 0 };
    if !root.exists() { return 0; }
    let mut fixed = 0usize;
    for card in cards {
        if card.image_path.is_empty() { continue; }
        let p = PathBuf::from(&card.image_path);
        // 已经在本地缓存下（$APPDATA/images/...）→ 跳过
        if p.starts_with(&cache) { continue; }
        // 否则：从共享盘复制图片回本地缓存，image_path 改回缓存文件名
        let cat = if card.category.trim().is_empty() { "未分类".to_string() } else { card.category.trim().to_string() };
        for ext in ["jpg", "jpeg", "png", "webp", "gif"] {
            let shared_img = root.join(&cat).join(format!("{}.{}", card.id, ext));
            if shared_img.exists() {
                let dest = cache.join(format!("{}.{}", card.id, ext));
                if !dest.exists() {
                    let _ = fs::copy(&shared_img, &dest);
                }
                if dest.exists() {
                    let mut c = card;
                    c.image_path = dest.file_name().unwrap().to_string_lossy().into_owned();
                    let _ = storage::insert_card(&c);
                    fixed += 1;
                }
                break;
            }
        }
    }
    fixed
}

/// 手动上传单张卡片到共享盘：写入「分类文件夹/图片 + 同名 txt」。
/// 返回结构化结果供前端展示。
pub fn upload_card(state: &ShareState, card_id: &str) -> Value {
    let Some(root) = current_path(state) else {
        return json!({ "ok": false, "reason": "共享盘未配置" });
    };
    if !root.exists() {
        return json!({ "ok": false, "reason": "共享盘路径不存在" });
    }
    let Some(card) = storage::get_card(card_id) else {
        return json!({ "ok": false, "reason": "卡片不存在" });
    };

    let cat = if card.category.trim().is_empty() { "未分类" } else { card.category.trim() };
    let dir = root.join(cat);
    if fs::create_dir_all(&dir).is_err() {
        return json!({ "ok": false, "reason": "共享盘不可写，请检查网络或路径" });
    }

    // 图片 → 分类文件夹/{id}.{ext}
    let img = resolve_local_image(&card.image_path);
    let ext = img.as_ref()
        .and_then(|p| p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()))
        .unwrap_or_else(|| "png".into());
    let dest_img = dir.join(format!("{}.{}", card.id, ext));
    if let Some(src) = img {
        if src.exists() { let _ = fs::copy(&src, &dest_img); }
    }

    // 提示词 → 分类文件夹/{id}.txt
    let dest_txt = dir.join(format!("{}.txt", card.id));
    let _ = fs::write(&dest_txt, &card.prompt);

    // 分类入库（保证侧栏有该分类）
    let _ = storage::create_category(cat);

    json!({ "ok": true, "category": cat, "path": dest_img.to_string_lossy().into_owned() })
}

/// 批量返回已上传到共享盘的卡片 id 列表（前端据此渲染「已上传」标记）
pub fn list_shared_ids(state: &ShareState) -> Vec<String> {
    let Some(root) = current_path(state) else { return vec![] };
    let (_, cards) = scan_shared_folders(&root);
    cards.into_iter().map(|c| c.id).collect()
}

/* ══════════════════ 删除 / 历史版本 / 冲突处理（命令层） ══════════════════ */

/// 本地软删除（文件夹分类模式：仅本地标记，30 天可恢复）
pub fn soft_delete(_state: &ShareState, card_id: &str) -> bool {
    let _ = storage::mark_deleted(card_id, true);
    true
}

/// 从「最近删除」恢复
pub fn restore_deleted(card_id: &str) -> bool {
    let Some(mut card) = storage::get_card(card_id) else { return false };
    if !card.deleted { return true; }
    card.deleted = false;
    let _ = storage::insert_card(&card);
    true
}

/// 列出某卡片的历史版本（versions/{cardId}/v*.json）
pub fn list_versions(state: &ShareState, card_id: &str) -> Vec<Value> {
    let Some(root) = current_path(state) else { return vec![] };
    let dir = root.join("versions").join(card_id);
    let Ok(entries) = fs::read_dir(&dir) else { return vec![] };
    let mut versions: Vec<Value> = entries.flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let text = fs::read_to_string(e.path()).ok()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            let ver = v.get("card").and_then(|c| c.get("version")).and_then(|x| x.as_i64()).unwrap_or(0);
            Some(json!({
                "version": ver,
                "archivedAt": v.get("archivedAt").and_then(|x| x.as_str()).unwrap_or(""),
                "archivedBy": v.get("archivedBy").and_then(|x| x.as_str()).unwrap_or(""),
                "prompt": v.get("card").and_then(|c| c.get("prompt")).and_then(|x| x.as_str()).unwrap_or("").chars().take(60).collect::<String>(),
                "file": e.path().file_name().and_then(|x| x.to_str()).unwrap_or("").to_string()
            }))
        })
        .collect();
    versions.sort_by_key(|v| v.get("version").and_then(|x| x.as_i64()).unwrap_or(0));
    versions
}

/// 回滚到指定历史版本（生成新版本推送给团队，可追溯）
pub fn restore_version(state: &ShareState, card_id: &str, version: i64) -> bool {
    let Some(root) = current_path(state) else { return false };
    let path = root.join("versions").join(card_id).join(format!("v{version}.json"));
    let Ok(text) = fs::read_to_string(&path) else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(mut card) = serde_json::from_value::<storage::Card>(v.get("card").cloned().unwrap_or_default()).ok() else { return false };

    card.version = 0; // 让 CAS 重新分配（= 远端当前 + 1）
    card.deleted = false;
    card.conflict = false;
    let _ = storage::insert_card(&card);
    enqueue_local_change("upsert", card_id);
    if current_path(state).is_some() { let _ = flush_outbox(&root); }
    true
}

/// 人工解决冲突（V1.1：卡片详情页左右分栏对比后选择保留哪版）
/// keep = "mine"  保留本地冲突版，推送给团队
/// keep = "theirs" 采用远端版（丢弃本地冲突版）
pub fn resolve_conflict(state: &ShareState, card_id: &str, keep: &str) -> bool {
    let Some(mut card) = storage::get_card(card_id) else { return false };
    match keep {
        "mine" => {
            card.version = 0; // 重新 CAS 提升
            card.conflict = false;
            let _ = storage::insert_card(&card);
            enqueue_local_change("upsert", card_id);
        }
        "theirs" => {
            // 重新从远端拉取覆盖本地
            if let Some(root) = current_path(state) {
                if let Some(remote) = read_remote_card(&root, card_id, None) {
                    apply_remote_card(&root, &remote, None);
                    return true;
                }
            }
            return false;
        }
        _ => return false,
    }
    if let Some(root) = current_path(state) {
        let _ = flush_outbox(&root);
    }
    true
}

/* ══════════════════ 主入口：sync_once + 轮询 ══════════════════ */

/// 单次同步（文件夹分类模式）：扫描共享盘文件夹 → 自动建分类 + 导入卡片。
/// 返回 (导入数, 0, 是否在线)。
pub fn sync_once(state: &ShareState) -> (usize, usize, bool) {
    let Some(root) = current_path(state) else { return (0, 0, false) };
    if !root.exists() { return (0, 0, false) }
    let imported = sync_from_folders(state);
    (imported, 0, true)
}

/// 8 秒轮询循环（由 Tauri setup 启动；共享盘未配置时静默空转）
/// 通过 AppHandle 每轮重新获取 State，规避 State 借用无法跨 'static 异步任务的问题。
pub fn start_sync_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            let state = app.state::<ShareState>();
            // 同步 IO 在异步任务中短阻塞（量小，可接受）
            let _ = sync_once(&state);
        }
    });
}

/// 供前端展示的同步状态
pub fn status(state: &ShareState) -> Value {
    let p = current_path(state);
    let pending_cards = storage::outbox_get().into_iter()
        .filter_map(|item| item.get("cardId").and_then(|v| v.as_str()).map(str::to_owned))
        .collect::<std::collections::HashSet<_>>();
    json!({
        "connected": p.is_some(),
        "path": p.map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        "clientId": client_id(),
        // UI 展示卡片数，而不是图片/提示词等底层变更事件数。
        "outbox": pending_cards.len(),
        "lastSync": storage::get_sync_value("last_sync").unwrap_or_default()
    })
}
