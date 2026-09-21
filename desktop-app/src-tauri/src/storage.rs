//! 本地权威副本：SQLite 存储层（骨架）
//! 本地库路径：%LOCALAPPDATA%/com.promptvault.app/vault.db
//! 原则：本地 SQLite 为单机权威副本；共享盘只放独立小文件 + 追加式变更日志（见 sync.rs）。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub source_tool: String,
    pub category: String,
    pub tags: String, // JSON 数组字符串，如 ["国潮"]
    pub image_path: String, // 本地图片缓存路径 / 或 staging 文件名
    pub params: String, // JSON 字符串
    pub time: String,
    pub version: i64, // LWW 逻辑版本号
    #[serde(default)]
    pub deleted: bool, // 软删除标记（V1.1 共享盘同步）
    #[serde(default)]
    pub conflict: bool, // 冲突标记（双版本待人工合并）
    #[serde(default)]
    pub fav: bool, // 收藏标记
}

static DB_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static IMAGES_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 本地图片缓存目录（pull 端存放从共享盘拉取的图片，grid 展示用）
pub fn images_dir() -> Option<PathBuf> {
    IMAGES_DIR.get().map(PathBuf::from)
}

/// 初始化本地库（建表）。在 Tauri setup 阶段调用。
pub fn init(dir: &Path) -> rusqlite::Result<()> {
    let path = dir.join("vault.db");
    let _ = DB_PATH.set(path.to_string_lossy().into_owned());
    let _ = IMAGES_DIR.set(dir.join("images").to_string_lossy().into_owned());
    std::fs::create_dir_all(dir.join("images")).ok();
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cards (
            id              TEXT PRIMARY KEY,
            prompt          TEXT NOT NULL,
            negative_prompt TEXT DEFAULT '',
            source_tool     TEXT DEFAULT '',
            category        TEXT DEFAULT '',
            tags            TEXT DEFAULT '[]',
            image_path      TEXT DEFAULT '',
            params          TEXT DEFAULT '{}',
            time            TEXT DEFAULT '',
            version         INTEGER DEFAULT 1,
            deleted         INTEGER DEFAULT 0,
            conflict        INTEGER DEFAULT 0,
            fav             INTEGER DEFAULT 0,
            deleted_at      TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT UNIQUE NOT NULL,
            parent_id  INTEGER DEFAULT 0,
            version    INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT DEFAULT ''
        );",
    )?;
    // 可重复执行的 schema 迁移：只补缺列，不依赖 ALTER TABLE 重复报错。
    let cols = [
        ("deleted", "INTEGER NOT NULL DEFAULT 0"),
        ("conflict", "INTEGER NOT NULL DEFAULT 0"),
        ("fav", "INTEGER NOT NULL DEFAULT 0"),
        ("deleted_at", "TEXT NOT NULL DEFAULT ''"),
    ];
    for (name, decl) in cols {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cards') WHERE name=?1)",
            params![name], |r| r.get(0))?;
        if !exists {
            conn.execute(&format!("ALTER TABLE cards ADD COLUMN {name} {decl}"), [])?;
        }
    }
    // 旧版本曾把布尔列写成 TEXT；读取时统一归一化为 0/1，避免 InvalidType。
    conn.execute("UPDATE cards SET deleted = CASE WHEN CAST(deleted AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", [])?;
    conn.execute("UPDATE cards SET conflict = CASE WHEN CAST(conflict AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", [])?;
    conn.execute("UPDATE cards SET fav = CASE WHEN CAST(fav AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", [])?;
    conn.execute_batch("PRAGMA user_version = 2;")?;
    Ok(())
}

pub fn get_conn() -> rusqlite::Result<Connection> {
    let path = DB_PATH.get().expect("storage 未初始化（Tauri setup 未执行）");
    Connection::open(path)
}

/// 全量读取卡片（按创建时间倒序；不含已软删除的卡片）
pub fn list_cards() -> rusqlite::Result<Vec<Card>> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, prompt, negative_prompt, source_tool, category, tags, image_path, params, time, version, deleted, conflict, fav
         FROM cards WHERE deleted = 0 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], card_from_row)?;
    rows.collect()
}

/// 「最近删除」列表（30 天内可恢复，V1.1 F6.5）
pub fn list_deleted() -> rusqlite::Result<Vec<Card>> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, prompt, negative_prompt, source_tool, category, tags, image_path, params, time, version, deleted, conflict, fav
         FROM cards WHERE deleted = 1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], card_from_row)?;
    rows.collect()
}

fn card_from_row(r: &rusqlite::Row) -> rusqlite::Result<Card> {
    // 旧库中的布尔列可能仍声明为 TEXT；兼容读取后再由迁移逐步归一化。
    fn bool_col(r: &rusqlite::Row, idx: usize) -> bool {
        r.get::<_, i64>(idx).map(|v| v != 0).or_else(|_| {
            r.get::<_, String>(idx).map(|s| matches!(s.trim(), "1" | "true" | "TRUE"))
        }).unwrap_or(false)
    }
    Ok(Card {
        id: r.get(0)?,
        prompt: r.get(1)?,
        negative_prompt: r.get(2)?,
        source_tool: r.get(3)?,
        category: r.get(4)?,
        tags: r.get(5)?,
        image_path: r.get(6)?,
        params: r.get(7)?,
        time: r.get(8)?,
        version: r.get(9)?,
        deleted: bool_col(r, 10),
        conflict: bool_col(r, 11),
        // fav 兼容读取：旧迁移可能把列建成了 TEXT（存 "0"/"1"/""），
        // 直接用 i64 读空串会抛 InvalidType 导致整个 list_cards 失败，
        // 这里容错：INTEGER 直读，TEXT 则解析数字。
        fav: bool_col(r, 12),
    })
}

/// 按 id 读取单张卡片（含已删除，供恢复/同步用）
pub fn get_card(id: &str) -> Option<Card> {
    let conn = get_conn().ok()?;
    conn.query_row(
        "SELECT id, prompt, negative_prompt, source_tool, category, tags, image_path, params, time, version, deleted, conflict, fav
         FROM cards WHERE id = ?1",
        params![id],
        card_from_row,
    )
    .ok()
}

/// 插入/覆盖一张卡片（id 为主键，幂等）
pub fn insert_card(c: &Card) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO cards
         (id, prompt, negative_prompt, source_tool, category, tags, image_path, params, time, version, deleted, conflict, fav)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            c.id,
            c.prompt,
            c.negative_prompt,
            c.source_tool,
            c.category,
            c.tags,
            c.image_path,
            c.params,
            c.time,
            c.version,
            c.deleted as i64,
            c.conflict as i64,
            c.fav as i64
        ],
    )?;
    Ok(())
}

/// 切换收藏标记
pub fn set_fav(id: &str, fav: bool) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    conn.execute(
        "UPDATE cards SET fav = ?1 WHERE id = ?2",
        params![fav as i64, id],
    )?;
    Ok(())
}

/// 移动卡片到指定分类（空/"未分类" → uncat）
pub fn set_card_category(id: &str, category: &str) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    let cat = if category.trim().is_empty() { "uncat" } else { category.trim() };
    conn.execute(
        "UPDATE cards SET category = ?1 WHERE id = ?2",
        params![cat, id],
    )?;
    Ok(())
}

/// 读取本地图片字节（供剪贴板复制等），返回 (content_type 猜测, 字节)
pub fn read_image_bytes(id: &str) -> Option<(String, Vec<u8>)> {
    let card = get_card(id)?;
    let path = PathBuf::from(card.image_path);
    if !path.exists() { return None; }
    let bytes = std::fs::read(&path).ok()?;
    // 按扩展名/魔数猜测 content-type（图片缓存里可能是 .jpg 文件名但内容是 webp）
    let ct = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png".to_string() }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp".to_string() }
        else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { "image/jpeg".to_string() }
        else { "image/png".to_string() };
    Some((ct, bytes))
}

/// 软删除标记（tombstone 已写入共享盘后调用；deleted=false 恢复）。
/// 删除时记录 deleted_at（用于 30 天自动清空），恢复时清空。
pub fn mark_deleted(id: &str, deleted: bool) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    if deleted {
        conn.execute(
            "UPDATE cards SET deleted = 1, deleted_at = datetime('now','localtime') WHERE id = ?1",
            params![id],
        )?;
    } else {
        conn.execute(
            "UPDATE cards SET deleted = 0, deleted_at = '' WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// 永久删除卡片（「最近删除」视图的"彻底删除"）：
/// 删除数据库记录，返回被删卡片的 image_path 供调用方删除本地图片文件。
pub fn purge_card(id: &str) -> Option<String> {
    let card = get_card(id)?; // get_card 含已删除
    let conn = get_conn().ok()?;
    conn.execute("DELETE FROM cards WHERE id = ?1", params![id]).ok()?;
    Some(card.image_path)
}

/// 自动清空：删除「最近删除」中超过保留期（默认 30 天）的卡片。
/// 返回被删卡片的 image_path 列表（供调用方删除本地图片文件）。
pub fn purge_expired(days: i64) -> Vec<String> {
    let conn = match get_conn() { Ok(c) => c, Err(_) => return vec![] };
    let sql = format!(
        "SELECT image_path FROM cards WHERE deleted = 1 AND deleted_at != '' AND deleted_at < datetime('now','localtime','-{} days')",
        days
    );
    let mut stmt = match conn.prepare(&sql) { Ok(s) => s, Err(_) => return vec![] };
    let rows = match stmt.query_map([], |r| r.get::<_, String>(0)) { Ok(r) => r, Err(_) => return vec![] };
    let mut paths: Vec<String> = vec![];
    for p in rows.flatten() {
        if !p.is_empty() { paths.push(p); }
    }
    let _ = conn.execute(
        &format!(
            "DELETE FROM cards WHERE deleted = 1 AND deleted_at != '' AND deleted_at < datetime('now','localtime','-{} days')",
            days
        ),
        [],
    );
    paths
}

/// 冲突标记（V1.1：CAS 冲突后本地保留我方版本并打标，待人工合并）
pub fn set_conflict(id: &str, conflict: bool) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    conn.execute(
        "UPDATE cards SET conflict = ?1 WHERE id = ?2",
        params![conflict as i64, id],
    )?;
    Ok(())
}

/// 读取/写入同步状态（watermark / share path 等 key-value 存储）
pub fn get_sync_value(key: &str) -> Option<String> {
    let conn = get_conn().ok()?;
    conn.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_sync_value(key: &str, value: &str) -> rusqlite::Result<()> {
    let conn = get_conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/* ── Outbox：离线待推送队列（V1.1 同步） ──
 * 本地对卡片的每次增/改/删都先入 outbox（JSON 数组），
 * 共享盘在线时逐条 CAS 推送并移除；断网时积压，重连后统一补推。
 */

pub fn outbox_push(item: &serde_json::Value) -> rusqlite::Result<()> {
    let mut outbox = outbox_get();
    outbox.push(item.clone());
    outbox_set(&outbox)
}

pub fn outbox_get() -> Vec<serde_json::Value> {
    get_sync_value("outbox")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn outbox_set(outbox: &[serde_json::Value]) -> rusqlite::Result<()> {
    set_sync_value("outbox", &serde_json::to_string(outbox).unwrap_or_else(|_| "[]".into()))
}

/// 移除已成功推送的前 n 条
pub fn outbox_remove_first(n: usize) -> rusqlite::Result<()> {
    let mut outbox = outbox_get();
    if n >= outbox.len() {
        outbox.clear();
    } else {
        outbox.drain(0..n);
    }
    outbox_set(&outbox)
}

/* ── 分类 ── */

/// 新建分类（幂等）
pub fn create_category(name: &str) -> rusqlite::Result<()> {
    if name.is_empty() { return Ok(()); }
    let conn = get_conn()?;
    conn.execute(
        "INSERT OR IGNORE INTO categories (name) VALUES (?1)",
        params![name],
    )?;
    Ok(())
}

/// 列出所有分类名
pub fn list_categories() -> rusqlite::Result<Vec<String>> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare("SELECT name FROM categories ORDER BY id")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.flatten().collect())
}
