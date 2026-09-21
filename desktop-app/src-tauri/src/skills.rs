use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{Arc, Mutex}};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrainingExample {
    #[serde(default)] pub project_id: String,
    #[serde(default)] pub project_name: String,
    #[serde(default)] pub summary: String,
    #[serde(default)] pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub category: String,
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub requires: Vec<String>,
    #[serde(default)] pub instruction: String,
    #[serde(default)] pub output_type: String,
    #[serde(default)] pub favorite: bool,
    #[serde(default)] pub built_in: bool,
    #[serde(default = "version_one")] pub version: u32,
    #[serde(default)] pub last_used_at: i64,
    #[serde(default)] pub updated_at: i64,
    /// Project-level examples are textual, deliberately excluding image Base64 data.
    /// They provide reusable workflow guidance without bloating the local Skill file.
    #[serde(default)] pub training_examples: Vec<SkillTrainingExample>,
}

fn version_one() -> u32 { 1 }

#[derive(Clone)]
pub struct SkillState { pub items: Arc<Mutex<Vec<SkillDefinition>>>, pub path: PathBuf }

fn now() -> i64 { chrono::Utc::now().timestamp_millis() }

fn built_in(id: &str, name: &str, description: &str, category: &str, requires: &[&str], instruction: &str, output_type: &str, tags: &[&str]) -> SkillDefinition {
    SkillDefinition { id: id.into(), name: name.into(), description: description.into(), category: category.into(), requires: requires.iter().map(|v| (*v).into()).collect(), instruction: instruction.into(), output_type: output_type.into(), tags: tags.iter().map(|v| (*v).into()).collect(), favorite: false, built_in: true, version: 1, last_used_at: 0, updated_at: now(), training_examples: vec![] }
}

fn defaults() -> Vec<SkillDefinition> { vec![
    built_in("image-composition", "图片反推与构图拆解", "拆解画面主体、构图、镜头、光线与可复用提示词。", "视觉分析", &["image"], "根据当前图片，先提炼主体、构图、镜头、光影、色彩和材质，再输出一段可直接用于生图的完整中文提示词。", "prompt", &["反推", "构图", "摄影"]),
    built_in("product-scene", "产品白底图场景融合", "把白底产品图与场景提示词组合为稳定的生图方案。", "产品生图", &["image", "text"], "以当前产品参考图为唯一产品外观依据，结合当前提示词设计真实商业场景。严格保持产品结构、比例、材质和配色，输出完整中文生图提示词。", "prompt", &["白底图", "融合", "产品一致性"]),
    built_in("product-consistency", "产品一致性检查", "检查产品图与提示词是否可能造成结构漂移。", "产品生图", &["image", "text"], "检查当前产品参考图和提示词中的结构、颜色、材质、部件和镜头描述是否一致。列出高风险冲突，并给出一版可直接替换的修正提示词。", "analysis", &["一致性", "修复", "产品"]),
    built_in("scene-rewrite", "场景改图提示词", "基于已有提示词写出可控的场景改图版本。", "提示词改写", &["text"], "保留当前提示词中明确的产品身份和主体结构，重写为适合场景改图的完整中文提示词。强化需要保持与需要修改的边界，不要解释。", "prompt", &["改图", "场景"]),
    built_in("ad-optimizer", "电商广告提示词优化", "将产品描述整理为商业广告级生图提示词。", "提示词改写", &["text"], "将当前内容优化成高转化商业产品广告中文提示词，补全卖点、场景、构图、镜头、光线、材质、留白和品牌质感；不得虚构产品结构。", "prompt", &["电商", "广告", "优化"]),
    built_in("competitor-review", "竞品视觉拆解", "从参考图提炼可借鉴的视觉策略与差异化方向。", "视觉分析", &["image"], "分析当前竞品参考图的视觉定位、构图、色彩、光影、材质、产品呈现和转化意图，并给出三条可执行但不照抄的创作方向。", "analysis", &["竞品", "拆解"]),
    built_in("lens-keywords", "以图搜图关键词", "为当前图片生成适合 Pinterest 搜索的关键词与方向。", "灵感采集", &["image"], "根据当前图片生成中英文 Pinterest 以图搜图辅助关键词：主体、风格、场景、镜头和材质各给出高相关短词，并附三组搜索组合。", "analysis", &["以图搜图", "Pinterest", "灵感"]),
    built_in("generation-review", "生图结果复盘", "比较生成结果与提示词，给出下一版优化方案。", "生成复盘", &["image", "text"], "对照当前生成结果图片与提示词，指出主体、构图、产品一致性、光影、材质和商业质感的偏差；输出按优先级排序的修改建议及一版下一轮完整提示词。", "analysis", &["复盘", "迭代", "生图"]),
] }

pub fn init(data_dir: PathBuf) -> SkillState {
    let path = data_dir.join("skills.json");
    let items = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_else(defaults);
    let state = SkillState { items: Arc::new(Mutex::new(items)), path };
    persist(&state);
    state
}

fn persist(state: &SkillState) {
    if let Ok(items) = state.items.lock() { if let Ok(raw) = serde_json::to_vec_pretty(&*items) { let temp = state.path.with_extension("tmp"); if std::fs::write(&temp, raw).is_ok() { let _ = std::fs::rename(temp, &state.path); } } }
}

pub fn list(state: &SkillState) -> Vec<SkillDefinition> { let mut items = state.items.lock().map(|x| x.clone()).unwrap_or_default(); items.sort_by_key(|item| (!item.favorite, std::cmp::Reverse(item.last_used_at), item.name.clone())); items }

pub fn save(state: &SkillState, mut input: SkillDefinition) -> Result<SkillDefinition, String> {
    input.name = input.name.trim().to_string(); input.instruction = input.instruction.trim().to_string();
    if input.name.is_empty() || input.name.len() > 80 { return Err("Skill 名称不能为空且不能超过 80 字".into()); }
    if input.instruction.is_empty() || input.instruction.len() > 12_000 { return Err("Skill 执行指令不能为空且不能超过 12000 字".into()); }
    input.id = if input.id.trim().is_empty() { uuid::Uuid::new_v4().to_string() } else { input.id.trim().to_string() };
    input.category = if input.category.trim().is_empty() { "自建 Skill".into() } else { input.category.trim().to_string() };
    input.output_type = if input.output_type.trim().is_empty() { "prompt".into() } else { input.output_type.trim().to_string() };
    input.requires.retain(|value| matches!(value.as_str(), "image" | "text" | "node" | "product"));
    input.tags = input.tags.into_iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).take(12).collect();
    input.training_examples = input.training_examples.into_iter().filter_map(|mut example| {
        example.project_name = example.project_name.trim().to_string();
        example.summary = example.summary.trim().to_string();
        (!example.project_name.is_empty() && !example.summary.is_empty()).then_some(example)
    }).take(20).collect();
    input.updated_at = now();
    let mut items = state.items.lock().map_err(|_| "Skill 库暂时不可用")?;
    if let Some(index) = items.iter().position(|item| item.id == input.id) { input.version = items[index].version.saturating_add(1); input.built_in = items[index].built_in; items[index] = input.clone(); }
    else { input.version = 1; input.built_in = false; items.push(input.clone()); }
    drop(items); persist(state); Ok(input)
}

pub fn remove(state: &SkillState, id: &str) -> Result<(), String> { let mut items = state.items.lock().map_err(|_| "Skill 库暂时不可用")?; let before = items.len(); items.retain(|item| item.id != id); if before == items.len() { return Err("未找到要删除的 Skill".into()); } drop(items); persist(state); Ok(()) }
pub fn touch(state: &SkillState, id: &str) { if let Ok(mut items) = state.items.lock() { if let Some(item) = items.iter_mut().find(|item| item.id == id) { item.last_used_at = now(); } } persist(state); }
pub fn import(state: &SkillState, raw: &str) -> Result<usize, String> { let mut input: Vec<SkillDefinition> = serde_json::from_str(raw).or_else(|_| serde_json::from_str::<SkillDefinition>(raw).map(|item| vec![item])).map_err(|_| "Skill 导入文件格式无效")?; let mut items = state.items.lock().map_err(|_| "Skill 库暂时不可用")?; let mut added = 0; for mut item in input.drain(..).take(100) { if item.name.trim().is_empty() || item.instruction.trim().is_empty() { continue; } item.id = uuid::Uuid::new_v4().to_string(); item.built_in = false; item.favorite = false; item.version = 1; item.updated_at = now(); if items.iter().any(|current| current.name == item.name) { item.name = format!("{}（导入）", item.name); } items.push(item); added += 1; } drop(items); persist(state); Ok(added) }
pub fn export(state: &SkillState, ids: &[String]) -> Result<String, String> { let items = state.items.lock().map_err(|_| "Skill 库暂时不可用")?; let chosen: Vec<_> = items.iter().filter(|item| ids.is_empty() || ids.contains(&item.id)).cloned().collect(); serde_json::to_string_pretty(&chosen).map_err(|error| error.to_string()) }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunRequest { pub skill_id: String, #[serde(default)] pub context_prompt: Option<String>, #[serde(default)] pub image_data_url: Option<String>, #[serde(default)] pub context_summary: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunResult { pub text: String, pub model: String, pub skill: SkillDefinition }

pub async fn run(state: &SkillState, ai_state: &crate::ai::AiState, request: SkillRunRequest) -> Result<SkillRunResult, String> {
    let skill = state.items.lock().ok().and_then(|items| items.iter().find(|item| item.id == request.skill_id).cloned()).ok_or("未找到该 Skill")?;
    let context = request.context_prompt.unwrap_or_default();
    // Bound example payload so a large project library cannot slow down or exceed
    // the configured model context. The complete local example remains preserved.
    let examples = skill.training_examples.iter().rev().take(5).enumerate().map(|(index, example)| format!("### 训练项目 {}：{}\n{}", index + 1, example.project_name, example.summary.chars().take(2_500).collect::<String>())).collect::<Vec<_>>().join("\n\n");
    let message = format!("执行 Skill「{}」。\n\n## Skill 工作指令（必须遵守）\n{}\n\n## 已确认的项目训练案例\n{}\n\n## 当前上下文摘要\n{}\n\n请直接完成 Skill 要求。输出类型：{}。", skill.name, skill.instruction, if examples.is_empty() { "无" } else { &examples }, if request.context_summary.trim().is_empty() { "未提供额外摘要" } else { request.context_summary.trim() }, skill.output_type);
    let result = crate::ai::assistant(ai_state, message, (!context.trim().is_empty()).then_some(context), request.image_data_url).await?;
    touch(state, &skill.id);
    Ok(SkillRunResult { text: result.text, model: result.model, skill })
}
