use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAsset {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: String,
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub source_url: Option<String>,
    #[serde(default)] pub thumbnail_data_url: Option<String>,
    pub created_at: u64,
    #[serde(default)] pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetInput {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: String,
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub source_url: Option<String>,
    #[serde(default)] pub thumbnail_data_url: Option<String>,
    // 前端与 Excalidraw 均使用 dataURL；URL 缩写不能由 camelCase 规则正确推导。
    #[serde(rename = "dataURL")]
    pub data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetContent { pub asset: ProjectAsset, pub data_url: String }

fn valid(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') }
fn root(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    if !valid(project_id) { return Err("项目编号无效".into()); }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("project-assets").join(project_id);
    std::fs::create_dir_all(root.join("originals")).map_err(|e| e.to_string())?;
    Ok(root)
}
fn index_path(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> { Ok(root(app, project_id)?.join("assets.json")) }
fn read_index(app: &AppHandle, project_id: &str) -> Result<Vec<ProjectAsset>, String> {
    let path = index_path(app, project_id)?;
    if !path.exists() { return Ok(vec![]); }
    serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?).map_err(|_| "项目素材索引损坏".to_string())
}
fn write_index(app: &AppHandle, project_id: &str, values: &[ProjectAsset]) -> Result<(), String> {
    let path = index_path(app, project_id)?; let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(values).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}
fn extension(mime: &str) -> &'static str { match mime { "image/png" => "png", "image/webp" => "webp", "image/gif" => "gif", "image/bmp" => "bmp", "image/svg+xml" => "svg", _ => "jpg" } }
fn file_path(app: &AppHandle, project_id: &str, asset: &ProjectAsset) -> Result<std::path::PathBuf, String> { Ok(root(app, project_id)?.join("originals").join(format!("{}.{}", asset.id, extension(&asset.mime_type)))) }

pub fn list(app: &AppHandle, project_id: &str) -> Result<Vec<ProjectAsset>, String> { read_index(app, project_id) }
pub fn save(app: &AppHandle, project_id: &str, input: ProjectAssetInput) -> Result<ProjectAsset, String> {
    if !valid(&input.id) { return Err("素材编号无效".into()); }
    let (_, encoded) = input.data_url.split_once(',').ok_or("图片数据格式无效")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "图片数据解码失败")?;
    if bytes.is_empty() || bytes.len() > 80 * 1024 * 1024 { return Err("单张素材需小于 80MB".into()); }
    let mut index = read_index(app, project_id)?;
    let record = ProjectAsset { id: input.id, name: input.name.chars().take(180).collect(), mime_type: input.mime_type, kind: input.kind, tags: input.tags.into_iter().map(|v| v.chars().take(40).collect()).take(20).collect(), source_url: input.source_url.filter(|v| v.starts_with("http://") || v.starts_with("https://")), thumbnail_data_url: input.thumbnail_data_url, created_at: chrono::Utc::now().timestamp_millis().max(0) as u64, bytes: bytes.len() as u64 };
    std::fs::write(file_path(app, project_id, &record)?, bytes).map_err(|e| e.to_string())?;
    index.retain(|item| item.id != record.id); index.push(record.clone()); write_index(app, project_id, &index)?; Ok(record)
}
pub fn read(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<ProjectAssetContent, String> {
    if !valid(asset_id) { return Err("素材编号无效".into()); }
    let asset = read_index(app, project_id)?.into_iter().find(|item| item.id == asset_id).ok_or("找不到项目素材")?;
    let bytes = std::fs::read(file_path(app, project_id, &asset)?).map_err(|_| "素材原图不存在")?;
    Ok(ProjectAssetContent { data_url: format!("data:{};base64,{}", asset.mime_type, base64::engine::general_purpose::STANDARD.encode(bytes)), asset })
}
pub fn remove(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<(), String> {
    let mut index = read_index(app, project_id)?; let asset = index.iter().find(|item| item.id == asset_id).cloned(); index.retain(|item| item.id != asset_id); write_index(app, project_id, &index)?;
    if let Some(item) = asset { let path = file_path(app, project_id, &item)?; if path.exists() { std::fs::remove_file(path).map_err(|e| e.to_string())?; } } Ok(())
}
pub fn remove_all(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let path = root(app, project_id)?; if path.exists() { std::fs::remove_dir_all(path).map_err(|e| e.to_string())?; } Ok(())
}
