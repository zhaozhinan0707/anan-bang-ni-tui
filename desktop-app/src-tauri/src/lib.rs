//! 提示词收藏夹 · Tauri 桌面应用入口与命令层
//! 前端（../src/index.html）通过 window.__TAURI__.core.invoke 调用下列命令。

mod ingest;
mod storage;
mod sync;
mod ai;
mod image_service;
mod skills;
mod assets;

use serde_json::json;
use tauri::Manager;

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let value = url.trim();
    if value.len() > 4096 || value.chars().any(char::is_control) || !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err("外部链接格式无效".into());
    }
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe").arg(value).spawn().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(value).spawn().map_err(|error| error.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(value).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sync::ShareState(std::sync::Mutex::new(None)))
        .setup(|app| {
            // 初始化本地 SQLite 权威副本
            let data_dir = app.path().app_data_dir().expect("无法定位应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            storage::init(&data_dir).expect("本地库初始化失败");
            let ai_state = ai::init(data_dir);
            ai::start_bridge(ai_state.clone());
            app.manage(ai_state);
            app.manage(image_service::init(app.path().app_data_dir().expect("无法定位应用数据目录")));
            app.manage(skills::init(app.path().app_data_dir().expect("无法定位应用数据目录")));

            // 启动共享盘 8 秒轮询同步（未配置路径时静默空转）
            sync::start_sync_loop(app.handle().clone());

            // 恢复上次保存的共享盘路径（SQLite 持久化，重启不丢）
            {
                let state = app.state::<sync::ShareState>();
                if sync::restore_saved_path(&state) {
                    let _ = sync::sync_once(&state); // 恢复后立即首轮同步
                }
            }

            // 一次性修复（V1.2）：历史上被 sync_from_folders 覆盖到共享盘绝对路径的 image_path，
            // 启动时把它们从共享盘复制回本地 $APPDATA/images/，路径改回缓存文件名（保证前端 convertFileSrc 可加载）
            {
                let state = app.state::<sync::ShareState>();
                let n = sync::repair_local_image_paths(&state);
                if n > 0 { eprintln!("[repair] recovered {} cards' local image paths", n); }
            }

            // 启动 3 秒后自动扫描一次扩展 staging（采集入库），用户无需手动点按钮
            let app2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let n = ingest::run(&app2);
                if n > 0 {
                    let state = app2.state::<sync::ShareState>();
                    let _ = sync::sync_once(&state);
                }
            });
            // 之后每 5 秒轮询 staging（保证 Chrome 扩展写入后自动入库，无需重启桌面）
            let app3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let n = ingest::run(&app3);
                    if n > 0 {
                        let state = app3.state::<sync::ShareState>();
                        let _ = sync::sync_once(&state);
                    }
                }
            });
            // 「最近删除」30 天自动清空：启动时跑一次，之后每小时跑一次
            let app4 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let paths = storage::purge_expired(30);
                    for p in paths {
                        let _ = std::fs::remove_file(p);
                    }
                    // 每小时检查一次
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    let _ = app4; // 保持 handle 存活
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_cards,
            get_deleted,
            add_card,
            create_card_manual,
            upload_card,
            get_shared_ids,
            delete_card,
            restore_deleted,
            purge_card,
            toggle_fav,
            set_card_category,
            get_card_image,
            ingest_staging,
            set_staging_dir,
            get_staging_dir,
            set_share_path,
            get_sync_status,
            sync_now,
            list_versions,
            restore_version,
            resolve_conflict,
            create_category,
            get_categories,
            scan_shared
            ,run_acceptance_tests
            ,read_dropped_images
            ,get_ai_config_status
            ,set_ai_config
            ,reverse_image_prompt
            ,take_canvas_import
            ,backup_canvas_project
            ,list_canvas_backups
            ,read_canvas_backup
            ,delete_canvas_backup
            ,export_canvas_project
            ,save_canvas_scene
            ,read_canvas_scene
            ,delete_canvas_scene
            ,get_image_service_status
            ,save_image_service_config
            ,set_image_download_directory
            ,select_download_directory
            ,test_image_service
            ,submit_generation
            ,get_generation_status
            ,cancel_generation
            ,download_generation_result
            ,save_generation_original
            ,prompt_assistant
            ,list_skills
            ,save_skill
            ,delete_skill
            ,import_skills
            ,export_skills
            ,run_skill
            ,list_project_assets
            ,save_project_asset
            ,read_project_asset
            ,delete_project_asset
            ,delete_project_assets
            ,open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

#[tauri::command]
fn list_project_assets(project_id: String, app: tauri::AppHandle) -> Result<Vec<assets::ProjectAsset>, String> { assets::list(&app, &project_id) }
#[tauri::command]
fn save_project_asset(project_id: String, asset: assets::ProjectAssetInput, app: tauri::AppHandle) -> Result<assets::ProjectAsset, String> { assets::save(&app, &project_id, asset) }
#[tauri::command]
fn read_project_asset(project_id: String, asset_id: String, app: tauri::AppHandle) -> Result<assets::ProjectAssetContent, String> { assets::read(&app, &project_id, &asset_id) }
#[tauri::command]
fn delete_project_asset(project_id: String, asset_id: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> { assets::remove(&app, &project_id, &asset_id)?; Ok(json!({"ok":true})) }
#[tauri::command]
fn delete_project_assets(project_id: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> { assets::remove_all(&app, &project_id)?; Ok(json!({"ok":true})) }

/// 返回模型同步状态，不返回 API Key。
#[tauri::command]
fn get_ai_config_status(state: tauri::State<ai::AiState>) -> ai::AiStatus {
    ai::status(&state)
}

/// 允许桌面端设置页或本机桥接写入一份与 Chrome 插件字段一致的配置。
#[tauri::command]
fn set_ai_config(config: ai::AiConfig, state: tauri::State<ai::AiState>) -> serde_json::Value {
    ai::set_config(&state, config);
    json!({ "ok": true })
}

#[tauri::command]
fn get_image_service_status(state: tauri::State<image_service::ImageServiceState>) -> serde_json::Value { image_service::status(&state) }
#[tauri::command]
fn save_image_service_config(config: image_service::ImageServiceConfig, state: tauri::State<image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::save(&state, config) }
#[tauri::command]
fn set_image_download_directory(download_directory: String, state: tauri::State<image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::set_download_directory(&state, download_directory) }
/// 使用系统原生目录选择器。取消选择时返回 null，不改动现有设置。
#[tauri::command]
fn select_download_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择 Prompt Vault 原图下载目录'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Write-Output $d.SelectedPath }";
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", script]).output().map_err(|error| format!("无法打开目录选择器：{error}"))?;
        if !output.status.success() { return Err("目录选择器未能启动".into()); }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!path.is_empty()).then_some(path));
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}
#[tauri::command]
async fn test_image_service(state: tauri::State<'_, image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::test(&state).await }
#[tauri::command]
async fn submit_generation(request: image_service::GenerationRequest, state: tauri::State<'_, image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::submit(&state, request).await }
#[tauri::command]
async fn get_generation_status(task_id: String, model: Option<String>, state: tauri::State<'_, image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::task_action(&state, task_id, false, model).await }
#[tauri::command]
async fn cancel_generation(task_id: String, state: tauri::State<'_, image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::task_action(&state, task_id, true, None).await }
#[tauri::command]
async fn download_generation_result(source: String, state: tauri::State<'_, image_service::ImageServiceState>) -> Result<serde_json::Value, String> { image_service::download(&state, source).await }

/// 将服务端返回的生成原图直接写入用户下载目录，不经过画布预览的缩放或转码。
#[tauri::command]
async fn save_generation_original(source: String, state: tauri::State<'_, image_service::ImageServiceState>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let result = image_service::download(&state, source).await?;
    let data_url = result.get("dataUrl").and_then(serde_json::Value::as_str).ok_or("图像服务没有返回图片数据")?;
    let (head, encoded) = data_url.split_once(',').ok_or("原图数据格式不正确")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "原图数据解码失败")?;
    let extension = if head.starts_with("data:image/png") { "png" } else if head.starts_with("data:image/webp") { "webp" } else if head.starts_with("data:image/gif") { "gif" } else { "jpg" };
    let configured = image_service::download_directory(&state);
    let folder = if configured.is_empty() {
        app.path().download_dir().or_else(|_| app.path().desktop_dir()).map_err(|error| format!("无法定位下载目录：{error}"))?.join("PromptVault 原图")
    } else { std::path::PathBuf::from(configured) };
    std::fs::create_dir_all(&folder).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let path = folder.join(format!("prompt-vault-{}.{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), extension));
    std::fs::write(&path, bytes).map_err(|error| format!("原图写入失败：{error}"))?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}
#[tauri::command]
async fn prompt_assistant(message: String, context_prompt: Option<String>, image_data_url: Option<String>, state: tauri::State<'_, ai::AiState>) -> Result<ai::AssistantResult, String> { ai::assistant(&state, message, context_prompt, image_data_url).await }

#[tauri::command]
fn list_skills(state: tauri::State<skills::SkillState>) -> Vec<skills::SkillDefinition> { skills::list(&state) }
#[tauri::command]
fn save_skill(skill: skills::SkillDefinition, state: tauri::State<skills::SkillState>) -> Result<skills::SkillDefinition, String> { skills::save(&state, skill) }
#[tauri::command]
fn delete_skill(id: String, state: tauri::State<skills::SkillState>) -> Result<serde_json::Value, String> { skills::remove(&state, &id)?; Ok(json!({"ok":true})) }
#[tauri::command]
fn import_skills(data: String, state: tauri::State<skills::SkillState>) -> Result<serde_json::Value, String> { Ok(json!({"ok":true,"count":skills::import(&state, &data)?})) }
#[tauri::command]
fn export_skills(ids: Vec<String>, state: tauri::State<skills::SkillState>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let data = skills::export(&state, &ids)?;
    let root = app.path().desktop_dir().map_err(|error| error.to_string())?.join("提示词"); std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(format!("PromptVault-Skills-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, data).map_err(|error| error.to_string())?;
    Ok(json!({"ok":true,"path":path.to_string_lossy()}))
}
#[tauri::command]
async fn run_skill(request: skills::SkillRunRequest, skills_state: tauri::State<'_, skills::SkillState>, ai_state: tauri::State<'_, ai::AiState>) -> Result<skills::SkillRunResult, String> { skills::run(&skills_state, &ai_state, request).await }

/// 画布选图后直接调用当前已同步的视觉模型。
#[tauri::command]
async fn reverse_image_prompt(image_data_url: String, template_id: Option<String>, original_prompt: Option<String>, instruction: Option<String>, state: tauri::State<'_, ai::AiState>) -> Result<ai::ReversePromptResult, String> {
    ai::reverse(&state, image_data_url, template_id, original_prompt, instruction).await
}

/// 取出插件发送给画布的下一条图片与反推结果。
#[tauri::command]
fn take_canvas_import(state: tauri::State<ai::AiState>) -> Option<ai::CanvasImport> {
    ai::take_canvas_import(&state)
}

/// 每个项目最多保留十份自动备份，备份位于应用数据目录，不覆盖当前项目。
#[tauri::command]
fn backup_canvas_project(project_name: String, data: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if data.is_empty() || data.len() > 600_000_000 { return Err("备份数据为空或超过 600MB；请拆分项目后再备份".into()); }
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?.join("canvas-backups");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let safe_name: String = project_name.chars().map(|ch| if r#"\\/:*?\"<>|"#.contains(ch) { '_' } else { ch }).take(48).collect();
    let path = root.join(format!("{}-{}.prompt-canvas.json", if safe_name.is_empty() { "未命名项目" } else { &safe_name }, chrono::Utc::now().format("%Y%m%d-%H%M%S")));
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, data).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    let mut backups: Vec<_> = std::fs::read_dir(&root).map_err(|error| error.to_string())?.flatten().filter_map(|entry| {
        let metadata = entry.metadata().ok()?;
        Some((metadata.modified().ok()?, entry.path()))
    }).collect();
    backups.sort_by_key(|item| std::cmp::Reverse(item.0));
    for (_, old) in backups.into_iter().skip(10) { let _ = std::fs::remove_file(old); }
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

/// 将当前画布项目直接导出到桌面的“提示词”目录，避免 WebView 拦截网页下载。
#[tauri::command]
fn export_canvas_project(project_name: String, data: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if data.is_empty() || data.len() > 600_000_000 { return Err("项目数据为空或超过 600MB；请拆分项目后再导出".into()); }
    let root = app.path().desktop_dir().map_err(|error| error.to_string())?.join("提示词");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let safe_name: String = project_name.chars().map(|ch| if r#"\\/:*?\"<>|"#.contains(ch) { '_' } else { ch }).take(64).collect();
    let path = root.join(format!("{}_{}.prompt-canvas.json", if safe_name.is_empty() { "画布项目" } else { &safe_name }, chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, data).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

fn canvas_scene_path(app: &tauri::AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    if project_id.is_empty() || !project_id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') { return Err("项目编号无效".into()); }
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?.join("canvas-projects");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join(format!("{project_id}.json")))
}

#[tauri::command]
fn save_canvas_scene(project_id: String, data: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if data.is_empty() || data.len() > 600_000_000 { return Err("项目数据为空或超过 600MB".into()); }
    let path = canvas_scene_path(&app, &project_id)?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, data).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn read_canvas_scene(project_id: String, app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = canvas_scene_path(&app, &project_id)?;
    if !path.exists() { return Ok(None); }
    std::fs::read_to_string(path).map(Some).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_canvas_scene(project_id: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = canvas_scene_path(&app, &project_id)?;
    if path.exists() { std::fs::remove_file(path).map_err(|error| error.to_string())?; }
    Ok(json!({ "ok": true }))
}

fn canvas_backup_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("canvas-backups"))
}

#[tauri::command]
fn list_canvas_backups(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let root = canvas_backup_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut items: Vec<_> = std::fs::read_dir(root).map_err(|error| error.to_string())?.flatten().filter_map(|entry| {
        let path = entry.path();
        if path.extension()?.to_str()? != "json" { return None; }
        let metadata = entry.metadata().ok()?;
        let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
        Some(json!({ "name": path.file_name()?.to_string_lossy(), "size": metadata.len(), "modifiedAt": modified }))
    }).collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.get("modifiedAt").and_then(|value| value.as_u64()).unwrap_or(0)));
    Ok(items)
}

fn safe_backup_path(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || !name.ends_with(".prompt-canvas.json") { return Err("备份文件名无效".into()); }
    Ok(canvas_backup_root(app)?.join(name))
}

#[tauri::command]
fn read_canvas_backup(name: String, app: tauri::AppHandle) -> Result<String, String> {
    std::fs::read_to_string(safe_backup_path(&app, &name)?).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_canvas_backup(name: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    std::fs::remove_file(safe_backup_path(&app, &name)?).map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true }))
}

/// 读取用户刚拖入窗口的本地图片，返回 data URL 给前端画布。
/// 仅接受常见图片格式，且单文件限制 30MB，避免意外导入超大文件。
#[tauri::command]
fn read_dropped_images(paths: Vec<String>) -> Vec<serde_json::Value> {
    use base64::Engine;
    const MAX_BYTES: u64 = 30 * 1024 * 1024;
    paths.into_iter().filter_map(|raw| {
        let path = std::path::PathBuf::from(&raw);
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
            "gif" => "image/gif", "bmp" => "image/bmp", "svg" => "image/svg+xml", _ => return None,
        };
        let meta = std::fs::metadata(&path).ok()?;
        if meta.len() == 0 || meta.len() > MAX_BYTES { return None; }
        let bytes = std::fs::read(&path).ok()?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Some(json!({ "name": name, "mimeType": mime, "dataUrl": format!("data:{};base64,{}", mime, encoded) }))
    }).collect()
}
/// 桌面端内置验收：不修改用户数据，只在临时目录/内存 SQLite 中验证关键协议。
#[tauri::command]
fn run_acceptance_tests() -> serde_json::Value {
    use std::fs;
    let root = std::env::temp_dir().join(format!("prompt-vault-accept-{}", uuid::Uuid::new_v4()));
    let _ = fs::create_dir_all(&root);
    let mut results = Vec::new();
    let json = root.join("sample.json");
    let ready = root.join("sample.ready");
    let no_ready_pass = fs::write(&json, r#"{"id":"sample","prompt":"test","imageFile":""}"#).is_ok() && !ready.exists();
    results.push(json!({"name":"无 ready 不消费","ok":no_ready_pass,"detail":"未提交的清单不会被桌面端读取"}));
    let ready_pass = fs::write(&ready, "sample").is_ok() && ready.exists();
    results.push(json!({"name":"ready 提交协议","ok":ready_pass,"detail":"清单完成后才提交"}));
    let failed = root.join("failed");
    let failed_pass = fs::create_dir_all(&failed).is_ok()
        && fs::write(failed.join("bad.json"), "JSON 格式错误").is_ok()
        && failed.join("bad.json").exists();
    results.push(json!({"name":"失败队列","ok":failed_pass,"detail":"错误清单有独立失败目录"}));
    let sqlite_pass = rusqlite::Connection::open_in_memory().and_then(|c| {
        c.execute_batch("CREATE TABLE cards (deleted TEXT, conflict TEXT, fav TEXT); INSERT INTO cards VALUES ('','true','1');")?;
        let row: (String,String,String) = c.query_row("SELECT deleted, conflict, fav FROM cards", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        Ok(row.1 == "true" && row.2 == "1")
    }).unwrap_or(false);
    results.push(json!({"name":"SQLite 兼容读取","ok":sqlite_pass,"detail":"旧版 TEXT 布尔字段可读取"}));
    let all_ok = results.iter().all(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    let _ = fs::remove_dir_all(&root);
    json!({"ok":all_ok,"results":results})
}

/* ── 卡片 ── */

/// 返回所有非删除卡片，每张卡片的 image_path 已拼成 $APPDATA\images\xxx 绝对路径
/// （前端 convertFileSrc 的 assetProtocol.scope 只放行绝对路径，相对名会被拒/解析错）
#[tauri::command]
fn get_cards() -> Vec<storage::Card> {
    let cards = storage::list_cards().unwrap_or_default();
    let images_dir = storage::images_dir();
    cards.into_iter().map(|mut c| {
        absolutize_image_path(&mut c, images_dir.as_deref());
        c
    }).collect()
}

/// 「最近删除」列表同样把 image_path 拼成绝对路径
#[tauri::command]
fn get_deleted() -> Vec<storage::Card> {
    let cards = storage::list_deleted().unwrap_or_default();
    let images_dir = storage::images_dir();
    cards.into_iter().map(|mut c| {
        absolutize_image_path(&mut c, images_dir.as_deref());
        c
    }).collect()
}

/// 把 card.image_path 是相对文件名（无 \ 无 /）的，拼成 $APPDATA\images\<filename> 绝对路径；
/// DB 里保持相对名（跨机器兼容），只在前端读取时临时拼接。
fn absolutize_image_path(c: &mut storage::Card, images_dir: Option<&std::path::Path>) {
    if c.image_path.is_empty() { return; }
    if c.image_path.contains('\\') || c.image_path.contains('/') { return; } // 已经是绝对路径
    if let Some(dir) = images_dir {
        c.image_path = dir.join(&c.image_path).to_string_lossy().into_owned();
    }
}

/// 新增/更新卡片：仅写入本地库（不再自动推送，用户通过「上传到共享盘」按钮手动控制）
#[tauri::command]
fn add_card(card: storage::Card, _state: tauri::State<sync::ShareState>) -> storage::Card {
    let _ = storage::insert_card(&card);
    card
}

/// 手动录入卡片：前端传图片 base64（data URL 或纯 base64）+ 提示词。
/// 程序把图片解码写入本地 $APPDATA/images/{uuid}.{ext}，构造卡片入库并返回。
#[tauri::command]
fn create_card_manual(
    image_base64: String,
    image_ext: String,
    prompt: String,
    negative_prompt: String,
    category: String,
    tags: String,
) -> serde_json::Value {
    use base64::Engine;
    // 兼容 data URL（data:image/png;base64,xxx）或纯 base64
    let b64 = image_base64
        .split(',')
        .last()
        .unwrap_or("")
        .trim()
        .to_string();
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(b) if !b.is_empty() => b,
        _ => return json!({ "ok": false, "reason": "图片数据解码失败" }),
    };
    let Some(cache) = storage::images_dir() else {
        return json!({ "ok": false, "reason": "无法定位图片缓存目录" });
    };
    let _ = std::fs::create_dir_all(&cache);

    let id = uuid::Uuid::new_v4().to_string();
    let ext = {
        let e = image_ext.trim().to_lowercase();
        if matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") { e } else { "png".into() }
    };
    let fname = format!("{id}.{ext}");
    let dest = cache.join(&fname);
    if std::fs::write(&dest, &bytes).is_err() {
        return json!({ "ok": false, "reason": "图片写入失败" });
    }

    let cat = if category.trim().is_empty() { "未分类".into() } else { category.trim().to_string() };
    let card = storage::Card {
        id: id.clone(),
        prompt,
        negative_prompt,
        source_tool: "手动录入".into(),
        category: cat.clone(),
        tags: if tags.trim().is_empty() { "[]".into() } else { tags },
        image_path: fname, // DB 存相对名，读取时 get_cards 拼成绝对路径
        params: "{}".into(),
        time: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        version: 1,
        deleted: false,
        conflict: false,
        fav: false,
    };
    if storage::insert_card(&card).is_err() {
        return json!({ "ok": false, "reason": "卡片入库失败" });
    }
    if !cat.is_empty() && cat != "未分类" {
        let _ = storage::create_category(&cat);
    }
    json!({ "ok": true, "card": card })
}

/// 手动上传单张卡片到共享盘
#[tauri::command]
fn upload_card(card_id: String, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    sync::upload_card(&state, &card_id)
}

/// 返回已上传到共享盘的卡片 id 列表
#[tauri::command]
fn get_shared_ids(state: tauri::State<sync::ShareState>) -> Vec<String> {
    sync::list_shared_ids(&state)
}

/// 软删除（团队广播，30 天可恢复）
#[tauri::command]
fn delete_card(card_id: String, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let ok = sync::soft_delete(&state, &card_id);
    json!({ "ok": ok })
}

/// 从「最近删除」恢复
#[tauri::command]
fn restore_deleted(card_id: String, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let ok = sync::restore_deleted(&card_id);
    if ok { let _ = sync::sync_once(&state); }
    json!({ "ok": ok })
}

/// 彻底删除（「最近删除」视图）：删数据库记录 + 删本地图片文件
#[tauri::command]
fn purge_card(card_id: String) -> serde_json::Value {
    let removed_image = storage::purge_card(&card_id);
    let mut removed_path = String::new();
    if let Some(p) = &removed_image {
        if !p.is_empty() {
            removed_path = p.clone();
            let _ = std::fs::remove_file(p);
        }
    }
    json!({ "ok": true, "removedImage": removed_path })
}

/// 切换收藏标记（爱心变红反馈）
#[tauri::command]
fn toggle_fav(card_id: String, fav: bool) -> serde_json::Value {
    let ok = storage::set_fav(&card_id, fav).is_ok();
    json!({ "ok": ok, "fav": fav })
}

/// 移动卡片到指定分类（若移动到新分类名，自动建分类）
#[tauri::command]
fn set_card_category(card_id: String, category: String) -> serde_json::Value {
    let ok = storage::set_card_category(&card_id, &category).is_ok();
    if ok && !category.trim().is_empty() && category.trim() != "uncat" {
        let _ = storage::create_category(category.trim());
    }
    json!({ "ok": ok })
}

/// 读取卡片图片，返回 data URL（供前端复制到剪贴板）
#[tauri::command]
fn get_card_image(card_id: String) -> serde_json::Value {
    use base64::Engine;
    match storage::read_image_bytes(&card_id) {
        Some((ct, bytes)) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            json!({ "ok": true, "contentType": ct, "dataUrl": format!("data:{};base64,{}", ct, b64) })
        }
        None => json!({ "ok": false })
    }
}

/* ── 采集桥接：扫描 Chrome 扩展 staging ── */

#[tauri::command]
fn ingest_staging(app: tauri::AppHandle, state: tauri::State<sync::ShareState>) -> usize {
    let n = ingest::run(&app);
    if n > 0 { let _ = sync::sync_once(&state); }
    n
}

/* ── 采集暂存目录（设置页可配置收藏存放位置） ── */

#[tauri::command]
fn set_staging_dir(path: String) -> serde_json::Value {
    ingest::set_staging_dir(path.clone());
    json!({ "ok": true, "path": path })
}

#[tauri::command]
fn get_staging_dir(app: tauri::AppHandle) -> serde_json::Value {
    ingest::staging_status(&app)
}

/* ── 共享盘同步（V1.1） ── */

#[tauri::command]
fn set_share_path(path: String, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    sync::set_path(&state, path.clone());
    let _ = sync::sync_once(&state); // 配置后立即尝试首轮同步
    json!({ "ok": true, "path": path })
}

#[tauri::command]
fn get_sync_status(state: tauri::State<sync::ShareState>) -> serde_json::Value {
    sync::status(&state)
}

/// 手动触发一次同步（设置页「立即同步」按钮）
#[tauri::command]
fn sync_now(state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let (pushed, pulled, online) = sync::sync_once(&state);
    json!({ "pushed": pushed, "pulled": pulled, "online": online })
}

/* ── 历史版本与冲突（V1.1 F6.9） ── */

#[tauri::command]
fn list_versions(card_id: String, state: tauri::State<sync::ShareState>) -> Vec<serde_json::Value> {
    sync::list_versions(&state, &card_id)
}

#[tauri::command]
fn restore_version(card_id: String, version: i64, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let ok = sync::restore_version(&state, &card_id, version);
    if ok { let _ = sync::sync_once(&state); }
    json!({ "ok": ok })
}

/// 解决冲突：keep = "mine" | "theirs"
#[tauri::command]
fn resolve_conflict(card_id: String, keep: String, state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let ok = sync::resolve_conflict(&state, &card_id, &keep);
    if ok { let _ = sync::sync_once(&state); }
    json!({ "ok": ok, "keep": keep })
}

/* ── 分类 ── */

#[tauri::command]
fn create_category(name: String) -> serde_json::Value {
    let ok = storage::create_category(&name).is_ok();
    json!({ "ok": ok })
}

/// 列出所有分类名
#[tauri::command]
fn get_categories() -> Vec<String> {
    storage::list_categories().unwrap_or_default()
}

/// 手动触发一次共享盘文件夹扫描（导入分类 + 卡片）
#[tauri::command]
fn scan_shared(state: tauri::State<sync::ShareState>) -> serde_json::Value {
    let imported = sync::sync_from_folders(&state);
    json!({ "ok": true, "imported": imported })
}


