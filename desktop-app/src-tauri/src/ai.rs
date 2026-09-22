//! 本机 AI 配置桥接与图像反推。
//!
//! Chrome 扩展将它自己的设置 POST 到 127.0.0.1；桌面端只在本机持久化该设置，
//! 再由 Rust 发起模型请求，避免在画布前端保存第二套密钥。

use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, io::{Read, Write}, net::TcpListener, path::PathBuf, sync::{Arc, Mutex}, time::Duration};

const BRIDGE_PORT: u16 = 47777;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: String,
    pub label: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub enabled: Option<bool>,
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    pub custom_model: String,
    pub prompt_template_id: String,
    pub prompt_template: String,
    #[serde(default)]
    pub prompt_templates: Vec<PromptTemplate>,
    pub updated_at: Option<i64>,
}

#[derive(Clone)]
pub struct AiState {
    pub config: Arc<Mutex<AiConfig>>,
    pub canvas_imports: Arc<Mutex<VecDeque<CanvasImport>>>,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasImport {
    pub id: String,
    pub image_data_url: String,
    pub prompt: String,
    pub model: String,
    pub template_id: String,
    pub template_label: String,
    pub source_url: String,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
    pub model: String,
    pub api_base: String,
    pub updated_at: Option<i64>,
    pub prompt_template_id: String,
    pub prompt_templates: Vec<PromptTemplate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReversePromptResult {
    pub prompt: String,
    pub model: String,
    pub template_id: String,
    pub template_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResult { pub text: String, pub model: String, pub is_prompt: bool }

fn text_from_value(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() { return text.to_string(); }
    value.as_array().map(|items| items.iter().filter_map(|item| item.as_str().or_else(|| item.get("text").and_then(|x| x.as_str())).or_else(|| item.get("content").and_then(|x| x.as_str()))).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn openai_text(body: &serde_json::Value) -> String {
    let message = body.pointer("/choices/0/message");
    let content = message.and_then(|x| x.get("content")).map(text_from_value).unwrap_or_default();
    if !content.trim().is_empty() { return content; }
    message.and_then(|x| x.get("reasoning_content")).map(text_from_value).unwrap_or_default()
}

fn built_in_templates() -> Vec<PromptTemplate> {
    vec![
        PromptTemplate { id: "human_vehicle".into(), label: "人车真实场景摄影".into(), content: "请反推图片中人物与自行车、电动自行车或滑板车等车辆的真实场景摄影提示词，描述人物动作、车辆结构、人与车关系、环境、镜头、构图、自然光、材质与真实摄影质感。不要臆测不可见细节，输出一段中文提示词。".into() },
        PromptTemplate { id: "blender_3d".into(), label: "Blender 三维产品渲染".into(), content: "请将图片反推为 Blender/Cycles 或 Eevee 风格三维产品渲染提示词，描述产品结构、材质、灯光、相机、背景、构图与真实可视化效果。输出一段中文提示词。".into() },
        PromptTemplate { id: "commercial_product".into(), label: "商业产品广告".into(), content: "请反推为商业产品广告中文提示词，描述主体、卖点、场景、构图、镜头、光线、材质、色彩、品牌质感与留白，保持产品结构准确。".into() },
        PromptTemplate { id: "ecommerce_white".into(), label: "电商白底产品图".into(), content: "请反推为电商白底产品摄影提示词，描述产品外形、角度、比例、材质、浅色背景、棚拍光线、接触阴影和展示要求。".into() },
        PromptTemplate { id: "creative_art".into(), label: "创意艺术风格".into(), content: "请反推为创意艺术风格中文生图提示词，描述主体、风格、媒介质感、构图、色彩、光影、空间氛围和细节层次。".into() },
    ]
}

pub fn init(data_dir: PathBuf) -> AiState {
    let path = data_dir.join("ai-config.json");
    let config = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    AiState { config: Arc::new(Mutex::new(config)), canvas_imports: Arc::new(Mutex::new(VecDeque::new())), path }
}

pub fn enqueue_canvas_import(state: &AiState, item: CanvasImport) -> Result<(), String> {
    if item.id.trim().is_empty() { return Err("缺少任务编号".into()); }
    if !item.image_data_url.starts_with("data:image/") { return Err("图片数据格式错误".into()); }
    if item.image_data_url.len() > 24_000_000 { return Err("图片过大，请缩小后重试".into()); }
    if item.prompt.len() > 80_000 { return Err("提示词内容过长".into()); }
    let mut queue = state.canvas_imports.lock().map_err(|_| "画布接收队列不可用")?;
    if queue.iter().any(|queued| queued.id == item.id) { return Ok(()); }
    while queue.len() >= 20 { queue.pop_front(); }
    queue.push_back(item);
    Ok(())
}

pub fn take_canvas_import(state: &AiState) -> Option<CanvasImport> {
    state.canvas_imports.lock().ok()?.pop_front()
}

fn save(state: &AiState, config: &AiConfig) {
    if let Ok(raw) = serde_json::to_vec(config) {
        let tmp = state.path.with_extension("tmp");
        if std::fs::write(&tmp, raw).is_ok() {
            let _ = std::fs::rename(&tmp, &state.path);
        }
    }
}

pub fn set_config(state: &AiState, mut config: AiConfig) {
    config.api_key = config.api_key.trim().to_string();
    config.api_base = config.api_base.trim().trim_end_matches('/').to_string();
    config.model = config.model.trim().to_string();
    config.custom_model = config.custom_model.trim().to_string();
    config.prompt_template = config.prompt_template.trim().to_string();
    config.updated_at = Some(chrono::Utc::now().timestamp_millis());
    if let Ok(mut current) = state.config.lock() { *current = config.clone(); }
    save(state, &config);
}

pub fn status(state: &AiState) -> AiStatus {
    let config = state.config.lock().map(|x| x.clone()).unwrap_or_default();
    AiStatus {
        configured: !config.model.is_empty() && (!config.api_key.is_empty() || is_local(&config.api_base)),
        model: config.model,
        api_base: config.api_base,
        updated_at: config.updated_at,
        prompt_template_id: config.prompt_template_id,
        prompt_templates: if config.prompt_templates.is_empty() { built_in_templates() } else { config.prompt_templates },
    }
}

/// 在独立线程中运行一个极小的 loopback-only HTTP bridge。
pub fn start_bridge(state: AiState) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", BRIDGE_PORT)) else {
            eprintln!("[ai bridge] 端口 {BRIDGE_PORT} 被占用，插件设置无法自动同步");
            return;
        };
        for stream in listener.incoming().flatten() {
            handle_http(stream, &state);
        }
    });
}

fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str, origin: Option<&str>) {
    let cors = origin.filter(|value| value.starts_with("chrome-extension://")).map(|value| format!("Access-Control-Allow-Origin: {value}\r\n")).unwrap_or_default();
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n{cors}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle_http(mut stream: std::net::TcpStream, state: &AiState) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let request = String::from_utf8_lossy(&raw);
    let mut parts = request.splitn(2, "\r\n\r\n");
    let head = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default();
    let first = head.lines().next().unwrap_or_default();
    let origin = head.lines().find_map(|line| line.strip_prefix("Origin: ").or_else(|| line.strip_prefix("origin: ")));
    if origin.is_some_and(|value| !value.starts_with("chrome-extension://")) { return respond(&mut stream, "403 Forbidden", r#"{"ok":false}"#, None); }
    if first.starts_with("OPTIONS ") { return respond(&mut stream, "204 No Content", "", origin); }
    if first.starts_with("GET /api/ai-config") { return respond(&mut stream, "200 OK", &serde_json::to_string(&status(state)).unwrap_or_else(|_| "{}".into()), origin); }
    if first.starts_with("POST /api/ai-config") {
        match serde_json::from_str::<AiConfig>(body) {
            Ok(config) => { set_config(state, config); return respond(&mut stream, "200 OK", r#"{"ok":true}"#, origin); }
            Err(_) => return respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"配置格式错误"}"#, origin),
        }
    }
    if first.starts_with("POST /api/canvas-import") {
        return match serde_json::from_str::<CanvasImport>(body) {
            Ok(item) => match enqueue_canvas_import(state, item) {
                Ok(()) => respond(&mut stream, "200 OK", r#"{"ok":true}"#, origin),
                Err(error) => respond(&mut stream, "400 Bad Request", &serde_json::json!({"ok":false,"error":error}).to_string(), origin),
            },
            Err(_) => respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"发送内容格式错误"}"#, origin),
        };
    }
    respond(&mut stream, "404 Not Found", r#"{"ok":false}"#, origin)
}

fn is_local(base: &str) -> bool {
    let base = base.trim().to_ascii_lowercase();
    base == "local" || base == "localhost" || base.starts_with("http://127.0.0.1") || base.starts_with("http://localhost")
}

fn provider(model: &str) -> &'static str {
    if model.starts_with("claude-") { "anthropic" }
    else if model.starts_with("gemini-") { "google" }
    else { "openai" }
}

fn default_base(model: &str) -> &'static str {
    match model {
        "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" => "https://api.openai.com/v1",
        "claude-3-5-sonnet" | "claude-3-opus" => "https://api.anthropic.com/v1",
        m if m.starts_with("gemini-") => "https://generativelanguage.googleapis.com/v1beta",
        "doubao-pro-32k" | "doubao-pro-128k" | "doubao-lite-32k" => "https://ark.cn-beijing.volces.com/api/v3",
        "deepseek-chat" | "deepseek-reasoner" => "https://api.deepseek.com/v1",
        "qwen-max" | "qwen-plus" | "qwen3-vl-flash" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "moonshot-v1-32k" => "https://api.moonshot.cn/v1",
        "glm-4" | "glm-4v" => "https://open.bigmodel.cn/api/paas/v4",
        "mimo-v2.6-pro" | "mimo-v2.6-flash" | "mimo-v2.6-pro-ultraspeed" |
        "mimo-v2-flash" | "mimo-v2.5-pro" | "mimo-v2.5" => "https://token-plan-cn.xiaomimimo.com/v1",
        _ => "",
    }
}

fn real_model(config: &AiConfig) -> String {
    match config.model.as_str() {
        "custom" => config.custom_model.clone(),
        "doubao-pro-32k" | "doubao-pro-128k" => "doubao-vision-pro".into(),
        "qwen-max" => "qwen-vl-max".into(),
        "qwen-plus" => "qwen-vl-plus".into(),
        "wenxin-4" => "ernie-4.0-vl".into(),
        _ => config.model.clone(),
    }
}

fn supports_vision(model: &str) -> bool {
    matches!(model,
        "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" |
        "claude-3-5-sonnet" | "claude-3-opus" |
        "gemini-1.5-pro" | "gemini-1.5-flash" | "gemini-2.5-flash" | "gemini-2.5-flash-lite" |
        "doubao-pro-32k" | "doubao-pro-128k" | "qwen-max" | "qwen-plus" | "qwen3-vl-flash" | "wenxin-4" | "glm-4v" |
        "mimo-v2.6-pro" | "mimo-v2.6-flash" | "mimo-v2.6-pro-ultraspeed" |
        "mimo-v2-flash" | "mimo-v2.5-pro" | "mimo-v2.5" | "custom"
    )
}

fn openai_compatible_payload(model: &str, messages: serde_json::Value, max_tokens: u64, temperature: f64) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": false
    });
    if model.starts_with("mimo-") {
        payload["thinking"] = serde_json::json!({"type": "disabled"});
        payload["max_completion_tokens"] = serde_json::json!(max_tokens);
        if let Some(object) = payload.as_object_mut() { object.remove("max_tokens"); }
    }
    payload
}

fn strip_data_url(data_url: &str) -> Result<(String, String), String> {
    let (prefix, data) = data_url.split_once(',').ok_or("图片数据格式错误")?;
    if !prefix.starts_with("data:image/") { return Err("仅支持图片文件".into()); }
    let mime = prefix.trim_start_matches("data:").split(';').next().unwrap_or("image/png").to_string();
    if data.len() > 16_000_000 { return Err("图片过大，请缩小后重试".into()); }
    Ok((mime, data.to_string()))
}

fn reverse_system_prompt(template: &str) -> String {
    // 与 Chrome 插件的 SYSTEM_PROMPT_BASE 保持同一套视觉分析维度。
    // 模板本身（包括自定义字数、风格与输出要求）来自插件同步，放在末尾以获得最高优先级。
    let base = r#"你是一位专业的 AI 图像分析师和提示词工程师，精通从图片中提取视觉特征并生成高质量的 AI 绘图提示词。你的分析结果将直接用于 Midjourney、Stable Diffusion、DALL-E 等 AI 绘图工具。

## 核心任务
仔细分析用户提供的图片，从多个维度提取视觉信息，生成一段结构化、精准的提示词。

## 分析维度（按优先级排序）
1. 主体内容：主要对象、人物、车辆、姿态、动作、数量，以及主体与环境的空间关系。
2. 艺术风格：摄影、三维渲染、插画等真实风格倾向，以及时代感、地域感和整体视觉气质。
3. 构图方式：构图法则、机位、视角、景别、画面比例、主体占比、裁切和空间分配。
4. 色彩方案：主色、辅助色、点缀色、综合色调、对比度、饱和度以及高光和阴影的色彩倾向。
5. 光影效果：光源类型、方向、软硬、明暗层次、高光、轮廓光、接触阴影和环境光。
6. 质感材质：金属、玻璃、织物、木材、石材、皮肤、塑料、橡胶等表面质感和反射粗糙度。
7. 氛围情绪：整体氛围、情感基调、叙事感，以及雾气、粒子、倒影等可见环境元素。
8. 技术参数：仅在画面有依据时描述镜头焦段、景深、摄影质感、渲染器、后期和成像特点。
9. 细节特征：独特视觉元素、图案、纹理、文字、标识和最影响画面相似度的关键细节。

必须准确反映图片实际内容，不臆测不可见细节；按视觉显著性排序，优先说明画面为什么呈现当前构图和视觉效果。"#;
    let fallback = "请基于参考图片写一段可直接用于图像生成的中文提示词。准确描述主体、构图、镜头、光线、色彩、材质、场景和关键空间关系；不要臆测不可见内容。末尾加入针对性的画面约束。";
    format!(
        "{base}\n\n## 当前插件同步模板（最高优先级）\n{}\n\n严格执行以上模板的字数、结构和内容要求。输出前自行检查是否达到模板要求；不得擅自缩写或提前结束。不要标题、分析过程、解释、项目符号、Markdown 或 JSON，只输出模板要求的最终完整中文提示词。",
        if template.trim().is_empty() { fallback } else { template }
    )
}

pub async fn reverse(state: &AiState, image_data_url: String, template_id: Option<String>, original_prompt: Option<String>, instruction: Option<String>) -> Result<ReversePromptResult, String> {
    let config = state.config.lock().map(|x| x.clone()).unwrap_or_default();
    if config.model.is_empty() { return Err("尚未同步模型配置。请打开 Chrome 的提示词反推插件设置一次。".into()); }
    if !supports_vision(&config.model) { return Err(format!("模型 {} 不支持图片反推，请在插件设置中切换到 GLM-4V 或其他视觉模型。", config.model)); }
    let model = real_model(&config);
    if model.is_empty() { return Err("自定义模型名称为空，请在插件设置中补充。".into()); }
    let base = if config.api_base.is_empty() { default_base(&config.model).to_string() } else if config.api_base.eq_ignore_ascii_case("local") { "http://127.0.0.1:8080/v1".into() } else { config.api_base.trim_end_matches('/').to_string() };
    if base.is_empty() { return Err("未配置 API Base URL。请在插件设置中保存一次配置。".into()); }
    if config.api_key.is_empty() && !is_local(&base) { return Err("未配置 API Key。请在提示词反推插件设置中填写后保存。".into()); }
    let (mime, b64) = strip_data_url(&image_data_url)?;
    let templates = if config.prompt_templates.is_empty() { built_in_templates() } else { config.prompt_templates.clone() };
    let selected_template = template_id.as_deref().and_then(|id| templates.iter().find(|item| item.id == id));
    let active_template = selected_template.map(|item| item.content.as_str()).unwrap_or(&config.prompt_template);
    let used_template_id = selected_template.map(|item| item.id.clone()).unwrap_or_else(|| config.prompt_template_id.clone());
    let used_template_label = selected_template.map(|item| item.label.clone()).unwrap_or_else(|| if config.prompt_template_id.is_empty() { "默认视觉反推模板".into() } else { format!("模板 {}", config.prompt_template_id) });
    let mut system = reverse_system_prompt(active_template);
    if let Some(note) = instruction.filter(|value| !value.trim().is_empty()) {
        let original = original_prompt.unwrap_or_default();
        system.push_str(&format!("\n\n这是一次提示词修改。原版提示词：{original}\n用户修改要求：{note}\n请以参考图为事实依据，输出修改后的完整中文提示词；不要解释修改过程。"));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().map_err(|e| e.to_string())?;
    let kind = provider(&config.model);
    let response = if kind == "anthropic" {
        let actual = match model.as_str() { "claude-3-5-sonnet" => "claude-3-5-sonnet-20241022", "claude-3-opus" => "claude-3-opus-20240229", _ => &model };
        client.post(format!("{base}/messages")).header("x-api-key", &config.api_key).header("anthropic-version", "2023-06-01").json(&serde_json::json!({"model":actual,"max_tokens":2048,"system":system,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":mime,"data":b64}},{"type":"text","text":"请反推这张参考图。"}]}]})).send().await.map_err(|e| format!("模型请求失败：{e}"))?
    } else if kind == "google" {
        client.post(format!("{base}/models/{model}:generateContent?key={}", config.api_key)).json(&serde_json::json!({"contents":[{"parts":[{"text":format!("{system}\n\n请反推这张参考图。")},{"inline_data":{"mime_type":mime,"data":b64}}]}],"generationConfig":{"maxOutputTokens":8192,"temperature":0.45}})).send().await.map_err(|e| format!("模型请求失败：{e}"))?
    } else {
        let messages = serde_json::json!([{"role":"system","content":system},{"role":"user","content":[{"type":"text","text":"请反推这张参考图。"},{"type":"image_url","image_url":{"url":format!("data:{mime};base64,{b64}"),"detail":"high"}}]}]);
        let payload = openai_compatible_payload(&model, messages, 2048, 0.45);
        client.post(format!("{base}/chat/completions")).bearer_auth(if config.api_key.is_empty() { "local" } else { &config.api_key }).json(&payload).send().await.map_err(|e| format!("模型请求失败：{e}"))?
    };
    let code = response.status();
    let body: serde_json::Value = response.json().await.map_err(|_| "模型返回了无法识别的内容".to_string())?;
    if !code.is_success() {
        let message = body.pointer("/error/message").and_then(|x| x.as_str()).unwrap_or("请检查模型配置与额度");
        return Err(format!("模型请求失败（{code}）：{message}"));
    }
    let prompt = if kind == "anthropic" {
        body.get("content").and_then(|x| x.as_array()).and_then(|items| items.iter().find_map(|x| x.get("text").and_then(|v| v.as_str()))).unwrap_or_default().to_string()
    } else if kind == "google" {
        body.pointer("/candidates/0/content/parts").and_then(|x| x.as_array()).map(|parts| parts.iter().filter_map(|x| x.get("text").and_then(|v| v.as_str())).collect::<Vec<_>>().join("")).unwrap_or_default()
    } else {
        openai_text(&body)
    };
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        let finish = body.pointer("/choices/0/finish_reason").and_then(|x| x.as_str()).unwrap_or("未知");
        return Err(if finish == "length" { "模型输出额度已耗尽，请缩短原提示词或重试。".into() } else { format!("模型返回成功，但正文为空（结束原因：{finish}）。请重试或检查中转站响应格式。") });
    }
    Ok(ReversePromptResult { prompt, model, template_id: used_template_id, template_label: used_template_label })
}

pub async fn assistant(state: &AiState, message: String, context_prompt: Option<String>, image_data_url: Option<String>) -> Result<AssistantResult, String> {
    if message.trim().is_empty() { return Err("请输入提示词相关要求".into()); }
    let config = state.config.lock().map(|x| x.clone()).unwrap_or_default();
    let model = real_model(&config); if model.is_empty() { return Err("尚未同步 mimo 模型配置".into()); }
    let base = if config.api_base.is_empty() { default_base(&config.model).to_string() } else if config.api_base.eq_ignore_ascii_case("local") { "http://127.0.0.1:8080/v1".into() } else { config.api_base.trim_end_matches('/').to_string() };
    if base.is_empty() { return Err("未配置 API Base URL".into()); }
    let system = "你是提示词全链路助手，只处理图片分析、提示词反推、提示词修改、版本比较与完整提示词整理。回答使用中文。用户要求产出提示词时，只给出可直接使用的完整提示词；其他情况简洁说明。";
    let context = context_prompt.filter(|x| !x.trim().is_empty()).map(|x| format!("\n\n当前提示词上下文：\n{x}")).unwrap_or_default();
    let mut content = vec![serde_json::json!({"type":"text","text":format!("{}{}", message.trim(), context)})];
    if let Some(data) = image_data_url.filter(|x| x.starts_with("data:image/")) { content.push(serde_json::json!({"type":"image_url","image_url":{"url":data,"detail":"high"}})); }
    let messages = serde_json::json!([{"role":"system","content":system},{"role":"user","content":content}]);
    let payload = openai_compatible_payload(&model, messages, 2048, 0.4);
    let response = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string())?.post(format!("{base}/chat/completions")).bearer_auth(if config.api_key.is_empty() { "local" } else { &config.api_key }).json(&payload).send().await.map_err(|e| format!("提示词助手请求失败：{e}"))?;
    let code = response.status(); let body: serde_json::Value = response.json().await.map_err(|_| "模型返回内容无法识别".to_string())?;
    if !code.is_success() { return Err(format!("提示词助手请求失败（{code}）：{}", body.pointer("/error/message").and_then(|x| x.as_str()).unwrap_or("请检查插件模型配置"))); }
    let text = openai_text(&body).trim().to_string(); if text.is_empty() { return Err("模型没有返回可用内容".into()); }
    let lower = message.to_lowercase(); let is_prompt = ["提示词","反推","修改","整理","优化"].iter().any(|key| lower.contains(key));
    Ok(AssistantResult { text, model, is_prompt })
}
