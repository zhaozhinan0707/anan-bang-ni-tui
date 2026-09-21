//! 采集桥接：扫描 Chrome 扩展写入的 staging 目录并入库
//! staging 位置：下载目录 / PromptVault-staging/{uuid}.json + {uuid}.png
//! 处理成功 → 清单与提交标记移动到 processed/；不可恢复失败 → failed/ 并记录原因。

use crate::storage;
use crate::sync;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// 定位 staging 目录（Chrome 扩展写入位置）
/// 优先级：① 用户在设置中手动配置的路径 ② 自动探测（系统下载目录 /
/// Documents\Downloads / Downloads 兜底）——因为 Chrome 的「下载目录」可被自定义。
pub fn staging_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    // ① 手动配置优先
    if let Some(cfg) = storage::get_sync_value("staging_dir") {
        if !cfg.trim().is_empty() {
            let p = PathBuf::from(cfg.trim());
            if p.exists() { return Some(p); }
        }
    }
    // ② 自动探测
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().download_dir() {
        candidates.push(d.join("PromptVault-staging"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(
            PathBuf::from(&home).join("Documents").join("Downloads").join("PromptVault-staging"),
        );
        candidates.push(PathBuf::from(&home).join("Downloads").join("PromptVault-staging"));
    }
    candidates.into_iter().find(|c| c.exists())
}

/// 设置暂存目录（设置页配置项，用户可手动指定收藏存放位置）
pub fn set_staging_dir(path: String) {
    let trimmed = path.trim().to_string();
    let _ = storage::set_sync_value("staging_dir", &trimmed);
}

/// 查询暂存目录状态（配置值 + 当前生效路径）
pub fn staging_status(app: &tauri::AppHandle) -> serde_json::Value {
    let configured = storage::get_sync_value("staging_dir").unwrap_or_default();
    let effective = staging_dir(app)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    serde_json::json!({ "configured": configured, "effective": effective })
}

/// 扫描一次 staging 目录，将未处理的清单入库，返回入库数量
pub fn run(app: &tauri::AppHandle) -> usize {
    let Some(staging) = staging_dir(app) else { return 0 };
    let Ok(entries) = fs::read_dir(&staging) else { return 0 };

    let processed = staging.join("processed");
    let failed = staging.join("failed");
    let _ = fs::create_dir_all(&processed);
    let _ = fs::create_dir_all(&failed);

    let mut count = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "json") {
            continue;
        }
        // ready 是新版扩展写完 JSON 后的提交标记，避免读到半截下载文件。
        let mut ready = path.with_extension("ready");
        // Chrome 可能把 text/plain 的 .ready 改名为 .ready.txt，旧版集合插件
        // 还会直接生成同 id 的 .txt 标记；三种格式都兼容。
        if !ready.exists() {
            let ready_txt = path.with_extension("ready.txt");
            if ready_txt.exists() { ready = ready_txt; }
            else {
                let legacy_txt = path.with_extension("txt");
                if legacy_txt.exists() { ready = legacy_txt; }
            }
        }
        // 兼容旧版扩展：没有 ready 时，只消费稳定存在超过 3 秒的 JSON。
        // 这样升级桌面端后，旧插件已经写入的卡片不会被永久卡住。
        let has_ready = ready.exists();
        if !has_ready {
            let stable = fs::metadata(&path).and_then(|m| m.modified()).ok()
                .and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() >= 3).unwrap_or(false);
            if !stable { continue; }
        }
        let fail = |reason: &str| {
            let name = path.file_name().unwrap_or_default();
            let _ = fs::rename(&path, failed.join(name));
            if has_ready { let _ = fs::rename(&ready, failed.join(ready.file_name().unwrap_or_default())); }
            let _ = fs::write(failed.join(format!("{}.error.txt", name.to_string_lossy())), reason);
        };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { fail("JSON 格式错误"); continue };

        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let prompt = v.get("prompt").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            fail("缺少 id");
            continue;
        }
        // 注意：prompt 允许为空（V1.1 F6.6：手动补词支持空入库），用户后续在详情页补全

        // 图片：在 staging 里找该 id 对应的任意图片（兼容 png/jpg/jpeg/webp/gif），
        // 扩展可能因 content-type 不同把 imageFile 写成 .webp/.jpg/.png
        let img_name = v.get("imageFile").and_then(|x| x.as_str()).unwrap_or("");
        let mut staging_img = staging.join(img_name);
        if !staging_img.exists() {
            for ext in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".PNG", ".JPG", ".WEBP"] {
                let p = staging.join(format!("{id}{ext}"));
                if p.exists() { staging_img = p; break; }
            }
        }
        let mut image_path = String::new();
        if staging_img.exists() {
            if let Some(cache) = storage::images_dir() {
                let _ = fs::create_dir_all(&cache);
                let dest = cache.join(format!("{id}.jpg"));
                if fs::copy(&staging_img, &dest).is_ok() {
                    image_path = dest.to_string_lossy().into_owned();
                }
            }
            if image_path.is_empty() {
                image_path = staging_img.to_string_lossy().into_owned();
            }
        }

        // Chrome 会先后写入图片和 JSON。若此时图片还没完成下载，暂不移动 JSON，
        // 留给下一轮轮询继续尝试，避免生成“只有提示词、没有图片”的残缺卡片。
        if !img_name.is_empty() && image_path.is_empty() {
            continue;
        }

        let card = storage::Card {
            id,
            prompt,
            negative_prompt: v.get("negativePrompt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            source_tool: v.get("sourceTool").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            category: v.get("category").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            tags: v.get("tags").map(|x| x.to_string()).unwrap_or_else(|| "[]".into()),
            image_path,
            params: v.get("params").map(|x| x.to_string()).unwrap_or_else(|| "{}".into()),
            time: v.get("createdAt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            version: v.get("version").and_then(|x| x.as_i64()).unwrap_or(1),
            deleted: false,
            conflict: false,
            fav: false,
        };

        if storage::insert_card(&card).is_ok() {
            // 采集入库即进入团队同步队列（在线立即推送，离线积压重连补推）
            sync::enqueue_local_change("upsert", &card.id);
            let fname = path.file_name().unwrap_or_default();
            let _ = fs::rename(&path, processed.join(fname));
            if has_ready { let _ = fs::rename(&ready, processed.join(ready.file_name().unwrap_or_default())); }
            count += 1;
        }
    }
    count
}
