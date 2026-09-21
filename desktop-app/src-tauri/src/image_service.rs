use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageServiceConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub mode: String,
    pub generate_path: String,
    pub edit_path: String,
    pub status_path: String,
    pub cancel_path: String,
    pub default_size: String,
    pub download_directory: String,
}

#[derive(Clone)]
pub struct ImageServiceState { config: Arc<Mutex<ImageServiceConfig>>, path: PathBuf }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRequest { pub prompt: String, pub size: Option<String>, pub aspect_ratio: Option<String>, pub image_size: Option<String>, pub count: Option<u8>, pub model: Option<String>, pub image_data_url: Option<String>, pub reference_images: Option<Vec<String>> }

pub fn init(data_dir: PathBuf) -> ImageServiceState {
    let path = data_dir.join("image-service.json");
    let config = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    ImageServiceState { config: Arc::new(Mutex::new(config)), path }
}

fn clean(mut config: ImageServiceConfig) -> ImageServiceConfig {
    config.base_url = config.base_url.trim().trim_end_matches('/').to_string();
    config.model = config.model.trim().to_string();
    config.mode = if config.mode.trim().is_empty() { "openai".into() } else { config.mode.trim().into() };
    config.generate_path = if config.generate_path.trim().is_empty() { "/images/generations".into() } else { config.generate_path.trim().into() };
    config.edit_path = if config.edit_path.trim().is_empty() { "/images/edits".into() } else { config.edit_path.trim().into() };
    config.status_path = config.status_path.trim().to_string();
    config.cancel_path = config.cancel_path.trim().to_string();
    config.default_size = if config.default_size.trim().is_empty() { "1024x1024".into() } else { config.default_size.trim().into() };
    config.download_directory = config.download_directory.trim().to_string();
    config
}

pub fn save(state: &ImageServiceState, config: ImageServiceConfig) -> Result<Value, String> {
    let previous_key = state.config.lock().map(|x| x.api_key.clone()).unwrap_or_default();
    let mut config = clean(config);
    if config.api_key.trim().is_empty() { config.api_key = previous_key; }
    if config.base_url.is_empty() { return Err("请填写中转站地址".into()); }
    let raw = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let temporary = state.path.with_extension("tmp");
    std::fs::write(&temporary, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &state.path).map_err(|e| e.to_string())?;
    if let Ok(mut current) = state.config.lock() { *current = config.clone(); }
    Ok(status_from(&config))
}

fn status_from(config: &ImageServiceConfig) -> Value { json!({"configured": !config.base_url.is_empty() && !config.model.is_empty(), "baseUrl": config.base_url, "model": config.model, "mode": config.mode, "generatePath": config.generate_path, "editPath": config.edit_path, "statusPath": config.status_path, "cancelPath": config.cancel_path, "defaultSize": config.default_size, "downloadDirectory": config.download_directory, "hasApiKey": !config.api_key.is_empty()}) }
pub fn status(state: &ImageServiceState) -> Value { state.config.lock().map(|x| status_from(&x)).unwrap_or_else(|_| json!({"configured":false})) }
pub fn download_directory(state: &ImageServiceState) -> String { state.config.lock().map(|x| x.download_directory.clone()).unwrap_or_default() }
pub fn set_download_directory(state: &ImageServiceState, directory: String) -> Result<Value, String> {
    let mut config = state.config.lock().map_err(|_| "图像服务配置不可用")?.clone();
    config.download_directory = directory.trim().to_string();
    let raw = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let temporary = state.path.with_extension("tmp");
    std::fs::write(&temporary, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &state.path).map_err(|e| e.to_string())?;
    if let Ok(mut current) = state.config.lock() { *current = config.clone(); }
    Ok(status_from(&config))
}
fn config(state: &ImageServiceState) -> Result<ImageServiceConfig, String> { state.config.lock().map(|x| x.clone()).map_err(|_| "图像服务配置不可用".into()) }
fn url(base: &str, path: &str) -> String { if path.starts_with("http://") || path.starts_with("https://") { path.into() } else { format!("{}{}{}", base, if path.starts_with('/') { "" } else { "/" }, path) } }
fn client() -> Result<reqwest::Client, String> { reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string()) }
fn auth(request: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder { if key.is_empty() { request } else { request.bearer_auth(key) } }

fn same_origin(left: &str, right: &str) -> bool {
    let Ok(left) = reqwest::Url::parse(left) else { return false };
    let Ok(right) = reqwest::Url::parse(right) else { return false };
    left.scheme() == right.scheme() && left.host_str() == right.host_str() && left.port_or_known_default() == right.port_or_known_default()
}

fn xunke_nano(base: &str, model: &str) -> bool {
    reqwest::Url::parse(base).ok().is_some_and(|u| u.scheme() == "https" && u.host_str() == Some("api.xunkecloud.cn")) && model.starts_with("nano-banana")
}

fn service_error(body: &Value) -> String {
    body.pointer("/error/message")
        .or_else(|| body.pointer("/error/code"))
        .or_else(|| body.get("message"))
        .or_else(|| body.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or("服务端未说明原因")
        .to_string()
}

fn request_failure(action: &str, endpoint: &str, error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() { "请求超时" } else if error.is_connect() { "无法建立网络连接" } else { "请求发送失败" };
    let cause = std::error::Error::source(error).map(|value| format!("；底层原因：{value}")).unwrap_or_default();
    format!("{action}{kind}：{endpoint}{cause}")
}

fn nano_payload(input: &GenerationRequest, model: &str) -> Value {
    let mut images = input.reference_images.clone().unwrap_or_default();
    if images.is_empty() { if let Some(image) = input.image_data_url.as_ref().filter(|s| !s.is_empty()) { images.push(image.clone()); } }
    json!({"model":model,"prompt":input.prompt,"image":images,"aspect_ratio":input.aspect_ratio.as_deref().unwrap_or("16:9"),"picType":"png"})
}

#[cfg(test)]
mod nano_tests {
    use super::*;
    #[test]
    fn documented_request_uses_image_array() {
        let input: GenerationRequest = serde_json::from_value(json!({"prompt":"scene","imageDataUrl":"original","referenceImages":["product-a","product-b"],"aspectRatio":"16:9"})).unwrap();
        let body = nano_payload(&input, "nano-banana-pro_2k");
        assert_eq!(body["image"], json!(["product-a", "product-b"]));
        assert_eq!(body["picType"], "png");
        assert!(body.get("reference_images").is_none());
        assert!(body.get("size").is_none());
    }
    #[test]
    fn documented_async_response_and_final_response() {
        let submitted = parse_result(&json!({"code":"success","data":{"id":"img_123","status":"submitted"}}), "nano");
        assert_eq!(submitted["taskId"], "img_123");
        assert_eq!(submitted["status"], "submitted");
        let done = parse_result(&json!({"data":[{"b64_json":"","url":"https://example.org/image.png"}]}), "nano");
        assert_eq!(done["imageUrl"], "https://example.org/image.png");
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some("image/jpeg") }
    else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { Some("image/webp") }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some("image/gif") }
    else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") { Some("image/avif") }
    else { None }
}

fn image_data_url(bytes: Vec<u8>) -> Result<Value, String> {
    if bytes.len() > 30_000_000 { return Err("生成图片超过 30MB".into()); }
    let mime = image_mime(&bytes).ok_or("图像服务返回了 HTTP 200，但内容不是 PNG、JPEG、WebP、GIF 或 AVIF 图片")?;
    Ok(json!({"dataUrl":format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes))}))
}

fn normalize_inline_image(value: &str) -> String {
    let value = value.trim();
    if value.starts_with("data:image/") || value.starts_with("http://") || value.starts_with("https://") { value.to_string() }
    else { format!("data:image/png;base64,{value}") }
}

pub async fn test(state: &ImageServiceState) -> Result<Value, String> {
    let c = config(state)?; if c.base_url.is_empty() { return Err("请先填写中转站地址".into()); }
    let response = auth(client()?.get(&c.base_url), &c.api_key).send().await.map_err(|e| format!("连接失败：{e}"))?;
    Ok(json!({"ok": response.status().is_success() || response.status().as_u16() == 404, "status": response.status().as_u16()}))
}

fn parse_result(body: &Value, model: &str) -> Value {
    let task_id = body.pointer("/data/id").or_else(|| body.pointer("/task_id")).or_else(|| body.pointer("/id")).and_then(Value::as_str).unwrap_or_default();
    let mut image_urls: Vec<String> = body.get("data").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| {
        if let Some(b64) = item.get("b64_json").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) { Some(normalize_inline_image(b64)) }
        else { item.get("url").and_then(Value::as_str).map(str::to_string) }
    }).collect()).unwrap_or_default();
    if image_urls.is_empty() { image_urls = body.get("output").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(); }
    if image_urls.is_empty() { if let Some(value) = body.get("image_url").and_then(Value::as_str) { image_urls.push(value.to_string()); } }
    let image_url = image_urls.first().cloned().unwrap_or_default();
    let status = body.pointer("/data/status").or_else(|| body.get("status")).and_then(Value::as_str).unwrap_or(if image_url.is_empty() { "queued" } else { "completed" });
    json!({"taskId":task_id,"status":status,"imageUrl":image_url,"imageUrls":image_urls,"model":model})
}

pub async fn submit(state: &ImageServiceState, input: GenerationRequest) -> Result<Value, String> {
    let c = config(state)?; if c.base_url.is_empty() || c.model.is_empty() { return Err("请先完成图像服务设置".into()); }
    if input.prompt.trim().is_empty() { return Err("提示词不能为空".into()); }
    let model = input.model.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&c.model).to_string();
    if xunke_nano(&c.base_url, &model) {
        let endpoint = "https://api.xunkecloud.cn/v1/images/task";
        let response = auth(client()?.post(endpoint).json(&nano_payload(&input, &model)), &c.api_key).send().await.map_err(|_| "迅客任务提交未取得响应；不要重复提交，请先核对服务端任务记录".to_string())?;
        let code = response.status();
        let raw = response.text().await.map_err(|_| format!("迅客任务接口读取失败（HTTP {code}）"))?;
        if code.as_u16() == 413 { return Err("迅客任务提交失败（HTTP 413）：参考图请求体过大。请更新应用后重试；新版会自动压缩仅用于上传的参考副本，原图不会被改动。".into()); }
        let body: Value = serde_json::from_str(&raw).map_err(|_| format!("迅客任务接口返回非 JSON（HTTP {code}）：{}", raw.chars().take(160).collect::<String>()))?;
        if !code.is_success() || body.get("code").and_then(Value::as_str).is_some_and(|v| v != "success") {
            let reason = service_error(&body);
            if code.as_u16() == 401 { return Err(format!("迅客任务提交被拒绝（HTTP 401）：{reason}。请在图像服务设置中重新填写有效 API Key，并确认该 Key 有 {model} 模型权限")); }
            return Err(format!("迅客任务提交失败（HTTP {code}）：{reason}"));
        }
        let result = parse_result(&body, &model);
        if result["taskId"] == "" && result["imageUrl"] == "" { return Err("迅客未返回任务编号或图片；不要自动重复提交".into()); }
        return Ok(result);
    }
    let count = input.count.unwrap_or(1).clamp(1, 4);
    let editing = input.image_data_url.as_ref().is_some_and(|x| !x.is_empty());
    let path = if editing { &c.edit_path } else { &c.generate_path };
    let size = input.size.unwrap_or(c.default_size.clone());
    let request = if editing {
        let data_url = input.image_data_url.as_deref().unwrap_or_default();
        let (header, encoded) = data_url.split_once(',').ok_or("参考图片数据格式不正确")?;
        let mime = header.strip_prefix("data:").and_then(|value| value.split(';').next()).unwrap_or("image/jpeg");
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "参考图片解码失败")?;
        if bytes.len() > 12_000_000 { return Err("参考图片超过 12MB，请压缩后重试".into()); }
        let extension = if mime.contains("png") { "png" } else if mime.contains("webp") { "webp" } else { "jpg" };
        let part = reqwest::multipart::Part::bytes(bytes).file_name(format!("product.{extension}")).mime_str(mime).map_err(|e| e.to_string())?;
        let mut form = reqwest::multipart::Form::new().text("model", model.clone()).text("prompt", input.prompt.clone()).text("size", size).text("response_format", "url").part("image", part);
        if let Some(value) = input.aspect_ratio { form = form.text("aspect_ratio", value); }
        if let Some(value) = input.image_size { form = form.text("image_size", value); }
        auth(client()?.post(url(&c.base_url, path)).multipart(form), &c.api_key)
    } else {
        let payload = json!({"model":model,"prompt":input.prompt,"size":size,"n":count,"aspect_ratio":input.aspect_ratio,"image_size":input.image_size,"reference_images":input.reference_images.unwrap_or_default(),"response_format":"url"});
        auth(client()?.post(url(&c.base_url, path)).json(&payload), &c.api_key)
    };
    let response = request.send().await.map_err(|e| if e.is_timeout() { "生成等待超时：图像服务在 5 分钟内没有返回结果，请稍后重试；本次不会自动重复提交".into() } else if e.is_connect() { format!("无法连接图像服务（20 秒连接超时）：{e}") } else { format!("图像请求发送失败：{e}") })?;
    let code = response.status(); let raw = response.text().await.map_err(|e| format!("读取图像服务响应失败：{e}"))?;
    let body: Value = serde_json::from_str(&raw).map_err(|_| format!("中转站返回内容无法识别（HTTP {code}）"))?;
    if !code.is_success() { return Err(format!("图像服务请求失败（{code}）：{}", body.pointer("/error/message").and_then(Value::as_str).unwrap_or("请检查配置"))); }
    Ok(parse_result(&body, &model))
}

pub async fn task_action(state: &ImageServiceState, task_id: String, cancel: bool, model: Option<String>) -> Result<Value, String> {
    let c = config(state)?; if task_id.trim().is_empty() { return Err("缺少任务编号".into()); }
    let model = model.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&c.model).to_string();
    let nano = xunke_nano(&c.base_url, &model);
    let pattern = if nano && !cancel { "https://api.xunkecloud.cn/v1/images/task/{taskId}" } else if cancel { &c.cancel_path } else { &c.status_path };
    if !task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Err("任务编号格式无效".into()); }
    if pattern.is_empty() { return Err(if cancel { "未配置取消任务路径" } else { "未配置任务查询路径" }.into()); }
    let endpoint = url(&c.base_url, &pattern.replace("{taskId}", &task_id));
    let mut response = None;
    for attempt in 1..=3 {
        let request = if cancel { client()?.post(&endpoint) } else { client()?.get(&endpoint) };
        match auth(request, &c.api_key).send().await {
            Ok(value) => { response = Some(value); break; }
            Err(error) if !cancel && attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                tokio::time::sleep(Duration::from_millis(700 * attempt)).await;
            }
            Err(error) => return Err(request_failure(if cancel { "取消任务" } else { "查询任务" }, &endpoint, &error)),
        }
    }
    let response = response.ok_or_else(|| format!("查询任务连续 3 次无法连接：{endpoint}"))?;
    let code = response.status(); let raw = response.text().await.map_err(|_| "任务接口读取失败".to_string())?;
    let body: Value = serde_json::from_str(&raw).map_err(|_| format!("任务接口返回非 JSON（HTTP {code}）：{}", raw.chars().take(160).collect::<String>()))?;
    if !code.is_success() {
        let reason = service_error(&body);
        if code.as_u16() == 401 { return Err(format!("任务查询被拒绝（HTTP 401）：{reason}。请重新保存有效 API Key，并确认其具备 {model} 的任务查询权限")); }
        return Err(format!("任务请求失败（HTTP {code}）：{reason}"));
    }
    Ok(parse_result(&body, &model))
}

pub async fn download(state: &ImageServiceState, source: String) -> Result<Value, String> {
    let c = config(state)?;
    if source.starts_with("data:image/") {
        let (_, encoded) = source.split_once(',').ok_or("生成结果的内联图片格式不正确")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|_| "生成结果的 Base64 图片无法解码")?;
        return image_data_url(bytes);
    }
    if !source.starts_with("http://") && !source.starts_with("https://") {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(source.trim()) { return image_data_url(bytes); }
        return Err("图像服务返回了无效的图片地址".into());
    }
    if source.len() > 20_000_000 && !source.starts_with("http") { return Err("生成图片数据过大".into()); }
    let request = client()?.get(&source);
    let response = if same_origin(&source, &c.base_url) { auth(request, &c.api_key) } else { request }.send().await.map_err(|e| format!("下载生成图片失败：{e}"))?;
    let code = response.status();
    if !code.is_success() { return Err(format!("下载生成图片失败（{code}）")); }
    let bytes = response.bytes().await.map_err(|e| format!("读取生成图片失败：{e}"))?.to_vec();
    if image_mime(&bytes).is_some() { return image_data_url(bytes); }
    if let Ok(body) = serde_json::from_slice::<Value>(&bytes) {
        let nested = body.pointer("/data/0/url").or_else(|| body.pointer("/url")).or_else(|| body.pointer("/image_url")).and_then(Value::as_str);
        if let Some(nested_url) = nested {
            let nested_request = client()?.get(nested_url);
            let nested_response = if same_origin(nested_url, &c.base_url) { auth(nested_request, &c.api_key) } else { nested_request }.send().await.map_err(|e| format!("下载二次图片地址失败：{e}"))?;
            let nested_code = nested_response.status();
            if !nested_code.is_success() { return Err(format!("下载二次图片地址失败（{nested_code}）")); }
            return image_data_url(nested_response.bytes().await.map_err(|e| e.to_string())?.to_vec());
        }
        if let Some(b64) = body.pointer("/data/0/b64_json").or_else(|| body.pointer("/b64_json")).and_then(Value::as_str) {
            return image_data_url(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "图像服务返回的 Base64 图片无法解码")?);
        }
        let message = body.pointer("/error/message").or_else(|| body.pointer("/message")).and_then(Value::as_str).unwrap_or("返回的 JSON 中没有图片地址");
        return Err(format!("图像下载接口未返回图片：{message}"));
    }
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(120)]).replace(['\r', '\n'], " ");
    Err(format!("图像地址返回的不是有效图片（内容开头：{preview}）"))
}
