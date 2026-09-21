importScripts('vault-bridge.js', 'pinterest-provider.js');

/**
 * 提示词反推扩展 - Service Worker (Background)
 * 直接调用 AI API（OpenAI/Anthropic/Google/国内模型/中转站），无需本地后端
 * 完全自包含，不依赖 importScripts / 外部文件
 */

// ==================== 默认设置（扩展直连 AI，无后端） ====================
const DEFAULT_SETTINGS = {
  enabled: true,
  apiKey: '',
  apiBase: '',
  model: 'gpt-4o',
  customModel: '',
  promptTemplate: '请反推这张图片中的人物与自行车、电动自行车或滑板车等车辆的真实场景摄影提示词。重点描述人物动作与姿态、车辆外形与结构、人与车的关系、道路和环境、镜头视角、景别、构图、自然光与阴影、色彩、材质、运动感和真实摄影质感。不要臆测不可见细节，不要改变车辆品牌或结构。输出一段可直接用于图像生成的中文提示词。',
};

// ==================== 系统提示词 - 基础部分（角色 + 分析能力，始终包含） ====================
const SYSTEM_PROMPT_BASE = `你是一位专业的 AI 图像分析师和提示词工程师，精通从图片中提取视觉特征并生成高质量的 AI 绘图提示词。你的分析结果将直接用于 Midjourney、Stable Diffusion、DALL-E 等 AI 绘图工具。

## 核心任务
仔细分析用户提供的图片，从多个维度提取视觉信息，生成一段结构化、精准的提示词。

## 分析维度（按优先级排序）

### 1. 主体内容（Subject）
- 画面中的主要对象、人物、动物、建筑或场景
- 主体姿态、动作、表情、数量
- 主体与环境的空间关系

### 2. 艺术风格（Style）
- 整体风格倾向：插画 / 摄影 / 3D 渲染 / 油画 / 水彩 / 概念艺术 / 赛博朋克 / 极简主义等
- 参考风格：如有明显的艺术家风格特征（如宫崎骏、莫奈、赛博朋克风等）请指出
- 时代感与地域感：复古 / 未来 / 东方 / 西方等

### 3. 构图方式（Composition）
- 构图法则：三分法 / 黄金分割 / 对称 / 居中 / 对角线
- 视角：平视 / 俯视 / 仰视 / 鸟瞰 / 虫眼视角
- 景别：远景 / 全景 / 中景 / 近景 / 特写 / 微距
- 画面比例与空间分配

### 4. 色彩方案（Color）
- 主色调与辅助色（用具体颜色名称描述，如「群青蓝」「珊瑚橙」）
- 色彩情绪：温暖 / 冷峻 / 神秘 / 活泼 / 忧郁 / 梦幻
- 色彩关系：高对比 / 低对比 / 互补色 / 类比色 / 单色调
- 渐变与色彩过渡方式

### 5. 光影效果（Lighting）
- 光源类型：自然光 / 人造光 / 混合光
- 光线方向：顺光 / 逆光 / 侧光 / 顶光 / 底光
- 光线质感：硬光 / 软光 / 体积光 / 丁达尔效应
- 阴影特征：柔和阴影 / 硬边阴影 / 环境光遮蔽 / 接触阴影

### 6. 质感材质（Material & Texture）
- 表面质感：金属 / 玻璃 / 布料 / 木材 / 石材 / 皮肤 / 塑料
- 特殊质感：虹彩 / 磨砂 / 透明 / 半透明 / 发光 / 自发光
- 材质细节：反光率 / 粗糙度 / 凹凸感

### 7. 氛围情绪（Mood & Atmosphere）
- 整体氛围词（如「宁静而神秘」「紧张而充满张力」）
- 情感基调与叙事感
- 环境氛围元素（雾气 / 粒子 / 光斑 / 倒影等）

### 8. 技术参数（Technical）
- 渲染器/引擎：Octane / Unreal Engine / Cycles / Redshift（仅 3D 渲染类）
- 分辨率与质量：4K / 8K / 超高清 / 细节丰富
- 摄影参数（仅摄影类）：镜头焦距 / 光圈 / 快门 / ISO 感觉
- 后期处理：HDR / 调色风格 / 颗粒感

### 9. 细节特征（Details）
- 画面中独特的视觉元素、图案、纹理
- 值得注意的装饰性细节
- 文字、标识、符号（如有）`;

// ==================== 默认输出指令（仅在用户未自定义模板时使用） ====================
const DEFAULT_OUTPUT_INSTRUCTIONS = `
## 输出格式

请严格按照以下 JSON 格式输出，不要输出任何其他内容：

\`\`\`json
{
  "prompt": "完整的中文提示词，用逗号分隔各个描述要素，顺序为：主体内容 → 艺术风格 → 构图 → 色彩 → 光影 → 质感 → 氛围 → 技术参数。可直接用于 AI 绘图工具",
  "tags": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "params": {
    "aspect_ratio": "16:9 或 1:1 或 9:16 或 3:4 或 4:3",
    "style_strength": "低 / 中 / 高",
    "negative_prompt": "建议排除的元素，如：模糊，低质量，变形"
  },
  "description": "一句话简要描述图片内容（20字以内）"
}
\`\`\`

## 质量要求

1. **语言**：提示词必须为中文，技术术语可保留英文（如 Octane、8K、HDR）
2. **精准性**：描述必须准确反映图片实际内容，不臆测不可见的细节
3. **可操作性**：提示词应可直接粘贴到 Midjourney/SD 中使用，无需二次编辑
4. **完整性**：覆盖所有可辨识的视觉维度，但不冗余
5. **排序**：按视觉显著性排序，最突出的特征放前面
6. **简洁性**：每个描述要素简洁有力，避免「这张图片展示了」之类的引导语
7. **标签精炼**：tags 选取 3-5 个最能概括图片核心特征的关键词

## 特殊情况处理

- **抽象/艺术图片**：侧重描述色彩、纹理、情绪和艺术手法，不强求具象主体
- **文字密集图片（如海报/UI）**：描述排版、字体风格、信息层级，不转述文字内容
- **低分辨率/模糊图片**：描述可辨识的大致特征，标注「低分辨率」
- **含人物图片**：描述人物特征（年龄感、姿态、服饰风格），不描述具体面孔细节
- **多主体图片**：描述主体间的关系和空间布局`;

// 完整系统提示词（= 基础 + 默认输出指令）
const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE + "\n" + DEFAULT_OUTPUT_INSTRUCTIONS;

// 默认用户提示词模板
const DEFAULT_USER_TEMPLATE = DEFAULT_SETTINGS.promptTemplate;

// ==================== 模型配置 ====================
// 模型 → API 提供商映射
const MODEL_PROVIDERS = {
  // OpenAI
  "gpt-4o":         { provider: "openai",    vision: true },
  "gpt-4o-mini":    { provider: "openai",    vision: true },
  "gpt-4-turbo":    { provider: "openai",    vision: true },
  "o1-preview":     { provider: "openai",    vision: false },
  // Anthropic
  "claude-3-5-sonnet": { provider: "anthropic", vision: true, real_model: "claude-3-5-sonnet-20241022" },
  "claude-3-opus":     { provider: "anthropic", vision: true, real_model: "claude-3-opus-20240229" },
  // Google
  "gemini-1.5-pro":   { provider: "google",  vision: true },
  "gemini-1.5-flash": { provider: "google",  vision: true },
  "gemini-2.5-flash": { provider: "google", vision: true },
  "gemini-2.5-flash-lite": { provider: "google", vision: true },
  // 字节跳动 - 豆包
  "doubao-pro-32k":     { provider: "doubao",  vision: false, vision_model: "doubao-vision-pro" },
  "doubao-pro-128k":    { provider: "doubao",  vision: false, vision_model: "doubao-vision-pro" },
  "doubao-lite-32k":    { provider: "doubao",  vision: false },
  // 深度求索
  "deepseek-chat":      { provider: "deepseek", vision: false },
  "deepseek-reasoner":  { provider: "deepseek", vision: false },
  // 阿里 - 通义千问
  "qwen-max":    { provider: "qwen", vision: false, vision_model: "qwen-vl-max" },
  "qwen-plus":   { provider: "qwen", vision: false, vision_model: "qwen-vl-plus" },
  "qwen3-vl-flash": { provider: "qwen", vision: true },
  // 百度 - 文心一言
  "wenxin-4":    { provider: "wenxin", vision: false, vision_model: "ernie-4.0-vl" },
  // 月之暗面 - Kimi
  "moonshot-v1-32k": { provider: "moonshot", vision: false },
  // 智谱 - GLM
  "glm-4":  { provider: "glm", vision: false },
  "glm-4v": { provider: "glm", vision: true },
  // 小米 MiMo：OpenAI 兼容接口，支持多模态消息
  "mimo-v2-flash": { provider: "mimo", vision: true },
  "mimo-v2.5-pro": { provider: "mimo", vision: true },
  "mimo-v2.5": { provider: "mimo", vision: true },
  // 中转站自定义
  "custom":  { provider: "custom", vision: true },
};

// 各提供商默认 API 地址
const PROVIDER_BASES = {
  openai:    "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google:    "https://generativelanguage.googleapis.com/v1beta",
  doubao:    "https://ark.cn-beijing.volces.com/api/v3",
  deepseek:  "https://api.deepseek.com/v1",
  qwen:      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  wenxin:    "https://qianfan.baidubce.com/v2",
  moonshot:  "https://api.moonshot.cn/v1",
  glm:       "https://open.bigmodel.cn/api/paas/v4",
  mimo:      "https://token-plan-cn.xiaomimimo.com/v1",
  custom:    "",  // 由用户通过 apiBase 参数指定
};

// 请求超时 (毫秒)
const REQUEST_TIMEOUT = 60000;
// 最大重试次数
const MAX_RETRIES = 2;
// 智能补全是短文本交互，使用更低输出上限和更短超时，减少等待感
const PROMPT_OPTIMIZE_TIMEOUT = 120000;
const VISION_PROMPT_OPTIMIZE_TIMEOUT = 90000;
const LOCAL_PROMPT_OPTIMIZE_TIMEOUT = 180000;
// 当前接入的兼容接口上限为 2048；所有优化/反推分支共用此安全值。
const PROMPT_OPTIMIZE_MAX_TOKENS = 2048;
const EDIT_INSTRUCTION_TIMEOUT = 30000;
const ENHANCE_TASK_MAX_RUNTIME = 180000;
const ENHANCE_TASK_KEY = 'pr_enhance_task';
const ACTIVE_ENHANCE_CONTROLLERS = new Set();
const CANCELLED_ENHANCE_TASKS = new Set();
const EDIT_INSTRUCTION_CACHE = new Map();

// ==================== 右键菜单 ====================
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set(DEFAULT_SETTINGS);
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'reverse-prompt',
      title: '✨ 反推提示词',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'save-prompt',
      title: '保存到阿男帮你推',
      contexts: ['image'],
    });
    chrome.contextMenus.create({ id: 'visual-search', title: '以图搜图（Pinterest Lens）', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'send-search-result-to-canvas', title: '发送图片到阿男帮你推画布', contexts: ['image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'send-search-result-to-canvas' && info.srcUrl) {
    // 搜索结果页的图片被 Pin 链接包裹时，info.linkUrl 就是该图对应的详情页。
    sendSearchResultToCanvas(info.srcUrl, info.linkUrl || info.pageUrl || tab?.url || '')
      .catch((error) => console.warn('[CanvasBridge] 搜索结果发送失败', error));
    return;
  }
  if (info.menuItemId === 'visual-search' && info.srcUrl) {
    createVisualSearchTask({ sourceImageUrl: info.srcUrl, sourcePageUrl: info.pageUrl || tab?.url || '', rect: null }, tab).catch((error) => console.warn('[ImageSearch]', error));
    return;
  }
  if (info.menuItemId === 'save-prompt') {
    const srcUrl = info.srcUrl || '';
    if (!srcUrl) return;
    tryExtractPromptForVault(tab && tab.id).then((page) => {
      if (page && page.prompt) {
        return writeStaging({ srcUrl, pageUrl: tab && tab.url ? tab.url : '', prompt: page.prompt, negativePrompt: page.negativePrompt || '', params: page.params || {}, sourceTool: page.sourceTool || '手动' });
      }
      return chrome.storage.local.set({ pendingSave: { srcUrl, pageUrl: tab && tab.url ? tab.url : '' } }).then(() => chrome.windows.create({ url: chrome.runtime.getURL('save.html'), type: 'popup', width: 520, height: 660 }));
    }).catch((error) => console.warn('[PromptVault] 右键保存失败', error));
    return;
  }
  if (info.menuItemId !== 'reverse-prompt' || !info.srcUrl) return;
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {
    action: 'trigger_reverse',
    imageUrl: info.srcUrl,
  }).catch(() => {
    console.log('[ServiceWorker] Content script not available on this tab');
  });
});

async function tryExtractPromptForVault(tabId) {
  if (!tabId) return null;
  try { return await chrome.tabs.sendMessage(tabId, { type: 'PV_GET_PROMPT' }); } catch (_) { return null; }
}

console.log('[ServiceWorker] 提示词反推扩展已初始化（AI 直连模式，无需后端）');

const visualSearchProvider = new PinterestProvider();
async function createVisualSearchTask(payload, tab) {
  const id = crypto.randomUUID();
  const task = { id, status: 'preparing', createdAt: Date.now(), results: [] };
  await chrome.storage.local.set({ [`visualSearch:${id}`]: task });
  chrome.tabs.create({ url: chrome.runtime.getURL(`search/results.html?task=${id}`), active: true });
  try {
    let blob;
    const sourceImageUrl = String(payload.sourceImageUrl || '').trim();
    // 某些网页会给 img 设置空白、blob: 或站内临时地址；这些 URL 不能由扩展后台读取。
    // 此时按选区截图，避免把空字符串交给 fetch 后报“没有 host 权限”。
    if (/^https?:\/\//i.test(sourceImageUrl)) {
      const response = await fetch(sourceImageUrl);
      if (!response.ok) throw new Error(`无法获取图片（${response.status}）`);
      blob = await response.blob();
    } else if (tab?.id) {
      const capture = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      blob = await (await fetch(capture)).blob();
    } else throw new Error('未找到可搜索的图片，请在网页中重新选择图片。');
    task.status = 'searching'; await chrome.storage.local.set({ [`visualSearch:${id}`]: task });
    const page = await visualSearchProvider.search({ blob });
    task.status = 'completed'; task.results = page.results; task.cursor = page.cursor;
  } catch (error) { task.status = 'failed'; task.error = error.message || String(error); }
  await chrome.storage.local.set({ [`visualSearch:${id}`]: task });
  return { ok: task.status !== 'failed', taskId: id, error: task.error };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'start-selection' || message.type === 'start-selection-from-popup') {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) startImageSelection(tabId).catch(() => {});
    sendResponse({ ok: true }); return;
  }
  if (message.type === 'visual-search') { createVisualSearchTask(message.payload || {}, sender.tab).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message })); return true; }
  if (message.type === 'get-visual-search-task') { chrome.storage.local.get(`visualSearch:${message.taskId}`).then((data) => sendResponse(data[`visualSearch:${message.taskId}`] || null)); return true; }
});

chrome.action.onClicked.addListener(() => {
  if (chrome.sidePanel) chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch((err) => console.warn('[ServiceWorker] 打开侧边栏失败:', err));
});
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-image-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) startImageSelection(tab.id);
});
async function startImageSelection(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'start-selection' }); }
  catch (_) { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/image-search-picker.js'] }); await chrome.tabs.sendMessage(tabId, { type: 'start-selection' }); }
}

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'send_to_canvas') {
    sendReverseResultToCanvas(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message || '发送到画布失败' }));
    return true;
  }
  if (message.action === 'reverse') {
    handleReverseRequest(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message || '处理失败' });
      });
    return true; // 异步响应
  }

  if (message.action === 'optimize_prompt') {
    runPersistedEnhancement(message, false)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message || '提示词优化失败' }));
    return true;
  }

  if (message.action === 'optimize_prompt_with_images') {
    runPersistedEnhancement(message, true)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message || '图片修改提示词失败' }));
    return true;
  }

  if (message.action === 'classify_template') {
    classifyTemplate(message.settings, message.image)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message || '模板识别失败' }));
    return true;
  }

  if (message.action === 'get_enhance_task') {
    chrome.storage.local.get([ENHANCE_TASK_KEY], (items) => {
      sendResponse({ success: true, task: items[ENHANCE_TASK_KEY] || null });
    });
    return true;
  }

  if (message.action === 'cancel_enhance_task') {
    cancelEnhancementTask().then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message || '取消失败' }));
    return true;
  }

  if (message.action === 'expire_enhance_task') {
    expireEnhancementTask(message.taskId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message || '终止超时任务失败' }));
    return true;
  }

  if (message.action === 'resume_enhance_task') {
    resumePersistedEnhancement()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || '恢复任务失败' }));
    return true;
  }

  if (message.action === 'fetchImage') {
    fetchImageAsBase64(message.imageUrl)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'checkConfig') {
    checkConfig(message.settings || {}).then(sendResponse).catch((err) => {
      sendResponse({ success: false, configured: false, message: err.message || '配置检测失败' });
    });
    return true;
  }
});

async function canvasBlobToDataUrl(blob) {
  let output = blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const maxSide = 2400;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (ratio < 1 || blob.size > 4 * 1024 * 1024) {
      const width = Math.max(1, Math.round(bitmap.width * ratio));
      const height = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    }
    bitmap.close?.();
  } catch (error) {
    console.warn('[CanvasBridge] 图片压缩跳过', error);
  }
  if (output.size > 16 * 1024 * 1024) throw new Error('图片仍然过大，请换一张较小图片后再发送');
  const bytes = new Uint8Array(await output.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${output.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

async function sendReverseResultToCanvas(message) {
  if (!message.imageUrl || !message.prompt) throw new Error('缺少图片或提示词');
  let blob;
  try {
    const response = await fetch(message.imageUrl);
    if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
    blob = await response.blob();
  } catch (error) {
    throw new Error(`无法读取当前图片：${error.message || error}`);
  }
  if (!blob.type.startsWith('image/')) throw new Error('当前内容不是可发送的图片');
  const payload = {
    id: crypto.randomUUID(),
    imageDataUrl: await canvasBlobToDataUrl(blob),
    prompt: String(message.prompt).trim(),
    model: String(message.model || '插件当前模型'),
    templateId: String(message.templateId || ''),
    templateLabel: String(message.templateLabel || '插件当前模板'),
    sourceUrl: String(message.sourceUrl || ''),
    createdAt: Date.now(),
  };
  let response;
  try {
    response = await fetch('http://127.0.0.1:47777/api/canvas-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (_) {
    throw new Error('桌面程序未启动或版本过旧，请先安装并打开最新版阿男帮你推');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `桌面端拒绝接收（${response.status}）`);
}

async function sendSearchResultToCanvas(imageUrl, sourceUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('当前内容不是可发送的图片');
  const payload = {
    id: crypto.randomUUID(),
    imageDataUrl: await canvasBlobToDataUrl(blob),
    prompt: '', model: '', templateId: '', templateLabel: '',
    sourceUrl: String(sourceUrl || ''),
    createdAt: Date.now(),
  };
  const bridge = await fetch('http://127.0.0.1:47777/api/canvas-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await bridge.json().catch(() => ({}));
  if (!bridge.ok || !result.ok) throw new Error(result.error || `桌面端拒绝接收（${bridge.status}）`);
}

async function runPersistedEnhancement(message, withImages) {
  const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  CANCELLED_ENHANCE_TASKS.delete(taskId);
  const requestKey = `pr_enhance_request_${taskId}`;
  await chrome.storage.session.set({ [requestKey]: message });
  await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: { id: taskId, status: 'running', phase: '准备任务', startedAt, withImages, requestKey } });
  try {
    await updateEnhanceTaskPhase(taskId, '正在调用模型');
    const work = withImages
      ? optimizePromptWithImages(message).then((data) => ({ success: true, data }))
      : handleOptimizePromptRequest(message);
    let taskTimeout;
    const response = await Promise.race([
      work,
      new Promise((_, reject) => {
        taskTimeout = setTimeout(() => reject(new Error('模型接口超过 180 秒没有返回。可能原因：接口无响应、网络异常，或当前模型不支持多图请求。请检查 API 配置后重试。')), ENHANCE_TASK_MAX_RUNTIME);
      }),
    ]).finally(() => clearTimeout(taskTimeout));
    if (!response.success) throw new Error(response.error || '提示词优化失败');
    if (CANCELLED_ENHANCE_TASKS.has(taskId)) return { success: false, error: '已取消生成' };
    await saveEnhanceTaskIfCurrent(taskId, { id: taskId, status: 'completed', phase: '生成完成', startedAt, completedAt: Date.now(), data: response.data });
    return response;
  } catch (error) {
    const messageText = error.message || '提示词优化失败';
    if (CANCELLED_ENHANCE_TASKS.has(taskId)) return { success: false, error: '已取消生成' };
    await saveEnhanceTaskIfCurrent(taskId, { id: taskId, status: 'failed', phase: '生成失败', startedAt, completedAt: Date.now(), error: messageText });
    throw error;
  }
}

async function resumePersistedEnhancement() {
  const items = await chrome.storage.local.get([ENHANCE_TASK_KEY]);
  const task = items[ENHANCE_TASK_KEY];
  if (!task || !['running', 'failed'].includes(task.status)) {
    return { success: false, error: '没有可恢复的后台任务' };
  }
  const sessionItems = task.requestKey ? await chrome.storage.session.get([task.requestKey]) : {};
  const request = sessionItems[task.requestKey] || task.request;
  if (!request) return { success: false, error: '任务数据已过期，请重新提交' };
  // 用新任务 ID 接管旧任务，旧执行即使稍后返回也不会覆盖新结果。
  await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: { ...task, status: 'restarting', restartedAt: Date.now() } });
  runPersistedEnhancement(request, Boolean(task.withImages)).catch((err) => console.error('[Enhance] 恢复任务失败:', err));
  return { success: true, background: true };
}

async function cancelEnhancementTask() {
  const items = await chrome.storage.local.get([ENHANCE_TASK_KEY]);
  const task = items[ENHANCE_TASK_KEY];
  if (!task || task.status !== 'running') return { success: true, cancelled: false, message: '当前没有正在生成的任务' };
  CANCELLED_ENHANCE_TASKS.add(task.id);
  ACTIVE_ENHANCE_CONTROLLERS.forEach((controller) => controller.abort());
  await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: { ...task, status: 'cancelled', completedAt: Date.now(), error: '用户取消了生成' } });
  return { success: true, cancelled: true };
}

async function expireEnhancementTask(taskId) {
  const items = await chrome.storage.local.get([ENHANCE_TASK_KEY]);
  const task = items[ENHANCE_TASK_KEY];
  if (!task || (taskId && task.id !== taskId) || !['running', 'restarting'].includes(task.status)) {
    return { success: true, expired: false };
  }
  CANCELLED_ENHANCE_TASKS.add(task.id);
  ACTIVE_ENHANCE_CONTROLLERS.forEach((controller) => controller.abort());
  const error = '模型接口超过 180 秒没有返回。可能原因：接口无响应、网络异常，或当前模型不支持多图请求。请检查 API 配置后重试。';
  await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: { ...task, status: 'failed', phase: '任务超时', completedAt: Date.now(), error } });
  return { success: true, expired: true, error };
}

async function saveEnhanceTaskIfCurrent(taskId, task) {
  const items = await chrome.storage.local.get([ENHANCE_TASK_KEY]);
  if (items[ENHANCE_TASK_KEY] && items[ENHANCE_TASK_KEY].id === taskId) {
    await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: task });
  }
}

async function updateEnhanceTaskPhase(taskId, phase) {
  const items = await chrome.storage.local.get([ENHANCE_TASK_KEY]);
  const task = items[ENHANCE_TASK_KEY];
  if (task && task.id === taskId && task.status === 'running') {
    await chrome.storage.local.set({ [ENHANCE_TASK_KEY]: { ...task, phase } });
  }
}

async function checkConfig(settings) {
  const { apiKey, apiBase, model, customModel } = settings;
  const config = MODEL_PROVIDERS[model] || MODEL_PROVIDERS.custom;
  const base = resolveApiBase(apiBase, config.provider);
  const localMode = isLocalApiBase(base);
  if (!apiKey && !localMode) return { success: false, configured: false, message: '未填写 API Key' };
  if (!base) return { success: false, configured: false, message: '未填写 API Base URL' };
  if (localMode) {
    const response = await fetch(`${base}/models`);
    if (!response.ok) throw new Error(`本地模型服务不可用 (${response.status})`);
    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    const expected = resolveRealModel(config, model, customModel);
    return { success: true, configured: true, message: `本地模型已连接${expected ? `：${expected}` : ''}`, models };
  }
  return { success: true, configured: true, message: '配置已保存；首次请求时验证模型权限' };
}

// ============ 处理纯文本提示词补全请求 ============
async function handleOptimizePromptRequest(message) {
  try {
    const data = await optimizePrompt(message.settings || {}, message);
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message || '提示词优化失败' };
  }
}

async function optimizePrompt(settings, request) {
  const { apiKey, apiBase, model, customModel } = settings;
  const localMode = isLocalApiBase(apiBase);
  if (!apiKey && !localMode) throw new Error('未配置 API Key，请在插件设置中填写');
  const config = MODEL_PROVIDERS[model] || MODEL_PROVIDERS.custom;
  const provider = config.provider;
  const base = resolveApiBase(apiBase, provider);
  if (!base) throw new Error('未配置 API Base URL，请在设置中填写中转站地址');
  if (/\/(chat\/completions|messages|generateContent)(\/|$)/.test(base)) throw new Error(`API Base URL 填写过长：请删除末尾的接口路径，只保留版本地址。\n当前：${base}`);
  if (/\/(chat\/completions|messages|completions|generateContent)(\/|$)/.test(base)) throw new Error('API Base URL 只填写到域名+版本号，不要包含 /chat/completions');
  const realModel = resolveRealModel(config, model, customModel);
  const systemPrompt = buildPromptOptimizationSystemPrompt(request.options || {});
  const userMessage = buildPromptOptimizationUserMessage(request);
  const startTime = Date.now();
  let rawText;
  if (provider === 'anthropic') rawText = await callTextAnthropic(base, apiKey, realModel, systemPrompt, userMessage);
  else if (provider === 'google') rawText = await callTextGoogle(base, apiKey, realModel, systemPrompt, userMessage);
  else rawText = await callTextOpenAICompatible(provider, base, apiKey, realModel, systemPrompt, userMessage);
  const result = parseStructuredPromptResponse(rawText);
  // 防止模型把二次优化指令原样拼接到结果末尾；提示词中应使用视觉化改写。
  if (request.instruction && request.instruction.trim() && result.fullPrompt.includes(request.instruction.trim())) {
    const instruction = request.instruction.trim();
    const visualized = await rewriteOptimizationInstruction(settings, realModel, provider, base, apiKey, instruction);
    if (visualized && visualized !== instruction) {
      result.fullPrompt = result.fullPrompt.split(instruction).join(visualized);
      Object.keys(result.sections || {}).forEach((key) => {
        result.sections[key] = String(result.sections[key] || '').split(instruction).join(visualized);
      });
    }
  }
  finalizeStructuredDocument(result, request.currentDocument, request.lockedSections);
  result.metadata = { ...(result.metadata || {}), ...(request.options || {}), model: realModel };
  result.elapsed = (Date.now() - startTime) / 1000;
  return result;
}

async function optimizePromptWithImages(request) {
  request = request || {};
  request.images = safeImageList(request.images);
  const settings = request.settings || {};
  const { apiKey, apiBase, model, customModel } = settings;
  const localMode = isLocalApiBase(apiBase);
  if (!apiKey && !localMode) throw new Error('未配置 API Key，请在插件设置中填写');
  const config = MODEL_PROVIDERS[model] || MODEL_PROVIDERS.custom;
  const provider = config.provider;
  if (!config.vision && !config.vision_model) throw new Error(`模型 ${model} 不支持图片分析，请切换到 GLM-4V 或其他视觉模型`);
  const base = resolveApiBase(apiBase, provider);
  if (!base) throw new Error('未配置 API Base URL，请在设置中填写中转站地址');
  if (/(\/chat\/completions|\/messages|\/generateContent)(\/|$)/.test(base)) throw new Error(`API Base URL 填写过长：请删除末尾的接口路径，只保留版本地址。\n当前：${base}`);
  if (!request.images || !request.images.length) throw new Error('请至少上传 1 张参考图片');
  if (request.images.length > 8) throw new Error('最多支持 8 张参考图片');
  // 发送前压缩视觉输入，原图仅保存在页面/收藏数据中，不会被覆盖。
  request.images = await Promise.all(request.images.map((image) => compressVisionImage(image, 1280)));
  const totalImageChars = request.images.reduce((sum, image) => sum + image.base64.length, 0);
  if (totalImageChars > 16_000_000) throw new Error('参考图片总大小过大，请减少图片数量或使用更小的图片后重试');
  const realModel = resolveRealModel(config, model, customModel);
  const systemPrompt = buildMultiImageSystemPrompt(request.options || {});
  const safeImages = safeImageList(request.images);
  const originalInstruction = request.instruction || request.input || '';
  const productReplacement = detectProductReplacement(originalInstruction);
  // 多图流程直接让视觉模型理解修改要求，避免额外调用一次文本模型造成明显延迟。
  const visualTarget = originalInstruction || '保持第一张图主体和构图，准确描述当前画面的最终视觉状态。';
  const userMessage = JSON.stringify({ originalInstruction, visualTarget, preserveInstruction: request.preserveInstruction || '', productReplacement, mandatoryAudit: productReplacement ? `最终全文不得出现旧产品词“${productReplacement.source}”及其同类词，所有主体必须统一为“${productReplacement.target}”` : '', images: safeImages.map((image, index) => ({ index: index + 1, role: index === 0 ? 'base_image' : 'supplemental_reference', name: image.name || `reference-${index + 1}` })), currentDocument: request.currentDocument || null, lockedSections: request.lockedSections || [] });
  let rawText;
  if (provider === 'anthropic') rawText = await callMultiImageAnthropic(base, apiKey, realModel, systemPrompt, userMessage, safeImages);
  else if (provider === 'google') rawText = await callMultiImageGoogle(base, apiKey, realModel, systemPrompt, userMessage, safeImages);
  else rawText = await callMultiImageOpenAI(base, apiKey, realModel, systemPrompt, userMessage, safeImages);
  rawText = enforceProductReplacement(rawText, productReplacement);
  const result = parseStructuredPromptResponse(rawText);
  finalizeStructuredDocument(result, request.currentDocument, request.lockedSections);
  result.metadata = { ...(result.metadata || {}), ...(request.options || {}), imageCount: request.images.length, model: realModel };
  return result;
}

function detectProductReplacement(instruction) {
  const text = String(instruction || '');
  const marker = text.match(/(?:换成|替换成|改成|换为|替换为)/);
  if (!marker) return null;
  const splitAt = marker.index;
  const before = text.slice(0, splitAt);
  const after = text.slice(splitAt + marker[0].length);
  const products = ['电动滑板车', '电动自行车', '电助力自行车', '山地自行车', '滑板车', '自行车', '摩托车', '越野车', '商务车', '面包车', '跑车', '轿车', '汽车'];
  const source = products.find((name) => before.includes(name));
  const target = products.find((name) => after.includes(name));
  return source && target && source !== target ? { source, target } : null;
}

function enforceProductReplacement(text, replacement) {
  if (!replacement) return text;
  const aliasGroups = {
    汽车: ['电动汽车', '燃油汽车', '乘用车', '小轿车', '轿车', '汽车'],
    轿车: ['电动汽车', '燃油汽车', '乘用车', '小轿车', '轿车', '汽车'],
    自行车: ['电动自行车', '电助力自行车', '山地自行车', '公路自行车', '自行车'],
    滑板车: ['电动滑板车', '滑板车'],
  };
  const aliases = aliasGroups[replacement.source] || [replacement.source];
  return aliases
    .sort((a, b) => b.length - a.length)
    .reduce((result, oldName) => result.split(oldName).join(replacement.target), String(text || ''));
}

async function compressVisionImage(image, maxSide) {
  try {
    const source = await createImageBitmap(await (await fetch(`data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`)).blob());
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    if (scale === 1) { source.close(); return image; }
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    source.close();
    return { ...image, base64: btoa(binary), mimeType: 'image/jpeg' };
  } catch (_) {
    return image;
  }
}

function resolveApiBase(apiBase, provider) {
  const value = String(apiBase || '').trim();
  if (!value) return PROVIDER_BASES[provider] || '';
  // 本地 llama.cpp 配置容错：用户可能按“local”或“local/chat/completions”填写。
  // 统一映射到本地 OpenAI 兼容接口，避免生成 local/chat/completions 这种无效 URL。
  if (/^(local|localhost)(\/v1)?(\/chat\/completions)?\/?$/i.test(value)) {
    return 'http://127.0.0.1:8080/v1';
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error('API Base URL 填写错误：当前填写的内容不像网址，可能把 API Key 填到了 API Base URL。请清空 API Base URL，或填写完整网址，例如 https://open.bigmodel.cn/api/paas/v4');
  }
  // 兼容用户误填完整接口地址：内部请求会统一追加一次端点。
  // 例如 http://127.0.0.1:8080/v1/chat/completions -> http://127.0.0.1:8080/v1
  return value
    .replace(/\/(chat\/completions|messages|generateContent|completions)\/?$/i, '')
    .replace(/\/+$/, '');
}

function isLocalApiBase(apiBase) {
  return /^(local|localhost)(\/|$)/i.test(String(apiBase || '').trim()) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(apiBase || '').trim());
}

function buildOpenAIImagePart(image, base) {
  const imageUrl = `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`;
  // llama.cpp 的 OpenAI 多模态兼容接口只需要 url，detail=high 在部分版本会触发 400。
  return isLocalApiBase(base)
    ? { type: 'image_url', image_url: { url: imageUrl } }
    : { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } };
}

function safeImageList(images) {
  return Array.isArray(images) ? images.filter((image) => image && typeof image.base64 === 'string' && image.base64.length > 0) : [];
}

function buildMultiImageSystemPrompt(options) {
  const templateId = String(options.promptTemplateId || '');
  const savedTemplate = String(options.promptTemplate || '').trim();
  const isRender = templateId === 'blender_3d';
  const structure = isRender
    ? '按以下优先级在一整段中自然组织：渲染类型与视觉方向 → 摄像机视角、透视、产品占比与留白 → 产品整体轮廓、体块比例、关键几何及部件连接和遮挡 → 各主要部件对应的材质、粗糙度、反射、透明度与边缘处理 → 主光、辅光、轮廓光、高光形状、阴影落点和接触阴影 → 地面、背景、环境反射与空间层次 → 主色、点缀色、曝光和对比度 → 可见的物理渲染、景深效果 → 核心锁定与针对性负面约束。'
    : '按以下优先级在一整段中自然组织：摄影类型与整体气质 → 机位高度、相机方向、景别、焦段感与透视 → 主体位置、画面占比、朝向、裁切、构图法则、前中后景和负空间 → 人物外观、服装、姿态、视线与四肢动作 → 车辆类型、颜色、轮廓和关键可见结构 → 人与车辆的手脚接触、左右关系、前后位置及互相遮挡 → 道路、建筑、植物和地面材质等场景层次 → 光线方向、软硬、高光与阴影 → 综合色彩、对比度、饱和度、景深和成像质感 → 核心锁定与针对性负面约束。';
  const templateRule = savedTemplate
    ? `\n用户当前保存并选中的模板如下，必须把其中的具体要求融合进结果，不得忽略：\n${savedTemplate}`
    : '';
  const protectedEditRule = options.editMode === 'replace_product_only' && String(options.basePrompt || '').trim()
    ? `\n\n当前任务来自网页图片反推结果，执行严格的“仅替换产品”模式。以下原始提示词是受保护母稿：\n【受保护母稿开始】\n${String(options.basePrompt).trim()}\n【受保护母稿结束】\n只允许改写其中描述原产品自身的词句，包括产品类别、外形、结构、颜色、材质和产品特有细节；根据参考图片把这些内容替换为新产品描述。人物、动作、姿态、手脚位置、构图、机位、焦段、透视、景别、道路、建筑、植物、天气、光线、阴影、色彩关系、氛围、景深和画质描述必须沿用母稿，不得主动润色、扩写、删减、换序或改写。若新产品与人物存在接触，只做保证握持、骑乘、脚踏和落地关系成立所必需的最小调整。最终输出完整母稿的修改版，而不是只输出产品片段。此规则优先级高于下方模板要求。`
    : options.editMode === 'targeted_edit' && String(options.basePrompt || '').trim()
      ? `\n\n当前任务来自网页图片反推结果，执行“按指令局部修改”模式。以下原始提示词是受保护母稿：\n【受保护母稿开始】\n${String(options.basePrompt).trim()}\n【受保护母稿结束】\n必须准确执行用户这一次明确提出的修改。只修改用户点名的视觉维度：如果要求场景变成雪山，就重写环境、地面、天气以及为使雪山场景成立所必需的综合色彩与自然光描述，并清除与原场景冲突的树林、草地、城市或道路环境词；如果要求修改光线、构图、人物或风格，则只修改对应部分。用户没有点名的主体身份、产品结构、人物动作、机位、构图和其他细节必须尽量沿用母稿。不得因为“保护母稿”而忽略用户的新指令；新指令与母稿冲突时，以新指令为准。最终输出修改后的完整提示词。`
      : '';
  return `你是专业的视觉提示词工程师。第一张图片默认决定最终画面的构图、环境、机位、光线和空间关系；第 2–8 张图片只提供用户明确要求替换或参考的主体外观、结构、材质或其他视觉信息，不得把补充参考图的背景擅自带入第一张图。若用户明确指定某张参考图的用途，以用户指令为准。把用户的修改命令落实为“修改完成后的最终画面”，不要复述“替换、改成、去掉、增加”等操作过程。

${structure}

总控规则：
1. 优先写最影响画面相似度的视觉关系，再写局部细节；同一特征只写一次，避免近义词堆叠。
2. 只写图片中可观察到、用户明确要求或可合理判断的信息；不得猜测品牌、型号、地点、人物身份及不可见结构。
3. 涉及人物、车辆和产品时，必须准确写清左右、前后、朝向、比例、接触、遮挡和落地关系，避免只堆砌风格词。
4. 不默认添加广角、浅景深、电影感、胶片感、HDR、8K、渲染器名称；只有图片确有证据或用户模板明确要求时才写。
5. 段尾自然融入一句核心锁定，锁定 5–8 个决定相似度的要素；随后融入与当前画面直接相关的负面约束，但不要另起“负面提示词”标题。
6. 输出前内部检查主体是否正确替换、第一张图构图是否保留、参考图背景是否被误带入、空间关系是否一致、是否存在重复和矛盾。
7. preserveInstruction 是用户明确指定的“必须保留项”。除修改需求直接点名改变的目标外，逐项保持这些特征，不得擅自重写、删除或用参考图覆盖；若二者直接冲突，仅对冲突目标执行修改需求，其余保留项继续有效。
8. 最终只输出一整段可复制提示词；普通补全约 800–1200 中文字，严格局部编辑模式保持母稿原有长度，不得为凑字数扩写。不要标题、分析、解释、项目符号、Markdown、JSON、英文提示词、分段结构、参数建议或修改说明。${protectedEditRule}${templateRule}`;
}

async function compileImageEditInstruction(provider, base, apiKey, model, instruction) {
  const cacheKey = `${provider}|${model}|${instruction.trim()}`;
  if (EDIT_INSTRUCTION_CACHE.has(cacheKey)) return EDIT_INSTRUCTION_CACHE.get(cacheKey);
  const system = `你是视觉修改指令编译器。把用户的操作命令转换为“修改完成后的最终画面状态”。\n规则：\n- 不复述命令，不解释。\n- 禁止使用：减少、增加、不要、去掉、改成、换成、往前、往后、优化。\n- 必须描述主体姿态、空间关系、可见程度、位置、密度或光学效果。\n- 保留用户没有要求改变的主体特征。\n- 输出一段具体中文视觉描述，不输出 JSON。\n示例：用户说“减少后面扬尘，不要翘头，重心往前”；输出“前后轮稳定贴地，车身姿态接近水平，骑手躯干适度前倾，身体重心落在车辆中前部，后轮仅带起低矮稀薄的贴地尘雾，尘雾透明度低且不遮挡主体轮廓。”`;
  const user = `用户修改命令：${instruction}\n请输出最终画面状态：`;
  try {
    let result;
    if (provider === 'anthropic') {
      const data = await requestPromptOptimize(`${base}/messages`, { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, { model, max_tokens: 180, system, messages: [{ role: 'user', content: user }] }, EDIT_INSTRUCTION_TIMEOUT);
      result = (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    } else if (provider === 'google') {
      const data = await requestPromptOptimize(`${base}/models/${model}:generateContent?key=${apiKey}`, { 'Content-Type': 'application/json' }, { contents: [{ parts: [{ text: `${system}\n\n${user}` }] }], generationConfig: { maxOutputTokens: 180, temperature: 0.25 } }, EDIT_INSTRUCTION_TIMEOUT);
      result = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
    } else {
      const data = await requestPromptOptimize(`${base}/chat/completions`, { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'local'}` }, { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 180, temperature: 0.25, stream: false }, EDIT_INSTRUCTION_TIMEOUT);
      result = data.choices?.[0]?.message?.content || '';
    }
    result = String(result || instruction).trim();
    if (EDIT_INSTRUCTION_CACHE.size >= 30) EDIT_INSTRUCTION_CACHE.delete(EDIT_INSTRUCTION_CACHE.keys().next().value);
    EDIT_INSTRUCTION_CACHE.set(cacheKey, result);
    return result;
  } catch (_) {
    return instruction;
  }
}

function needsInstructionCompilation(instruction) {
  return /(减少|增加|不要|去掉|删除|改成|换成|替换|降低|提高|往前|往后|保留|参考|让|变得|更有|加强|减弱)/.test(String(instruction || ''));
}

async function callMultiImageOpenAI(base, apiKey, model, systemPrompt, userMessage, images) {
  const safeImages = safeImageList(images);
  // 多模态修改请求必须把“修改指令”和图片放在同一个 user content 中。
  // 旧逻辑只传图片、把指令塞进 system，容易被本地 Qwen/llama.cpp 当成普通反推。
  const content = [{ type: 'text', text: userMessage }].concat(safeImages.map((image) => buildOpenAIImagePart(image, base)));
  const maxTokens = /bigmodel\.cn/i.test(base) || /^glm-/i.test(model) ? 2048 : PROMPT_OPTIMIZE_MAX_TOKENS;
  const payload = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }], max_tokens: maxTokens, temperature: 0.55, stream: false };
  if (base.includes('xiaomimimo.com')) {
    payload.thinking = { type: 'disabled' };
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  const data = await requestPromptOptimize(`${base}/chat/completions`, { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'local'}` }, payload);
  return extractOpenAICompletion(data);
}

async function callMultiImageAnthropic(base, apiKey, model, systemPrompt, userMessage, images) {
  const safeImages = safeImageList(images);
  const content = [{ type: 'text', text: userMessage }].concat(safeImages.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType || 'image/jpeg', data: image.base64 } })));
  const data = await requestPromptOptimize(`${base}/messages`, { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, { model, max_tokens: PROMPT_OPTIMIZE_MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content }] });
  if (data.stop_reason === 'max_tokens') throw new Error('模型输出达到长度上限，未生成完整提示词，请缩短原提示词或减少细节后重试');
  try { return (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join(''); } catch (_) { throw new Error('Claude 返回格式异常'); }
}

async function callMultiImageGoogle(base, apiKey, model, systemPrompt, userMessage, images) {
  const safeImages = safeImageList(images);
  const parts = [{ text: systemPrompt + '\n\n用户任务：' + userMessage }].concat(safeImages.map((image) => ({ inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.base64 } })));
  const data = await requestPromptOptimize(`${base}/models/${model}:generateContent?key=${apiKey}`, { 'Content-Type': 'application/json' }, { contents: [{ parts }], generationConfig: { maxOutputTokens: PROMPT_OPTIMIZE_MAX_TOKENS, temperature: 0.55, topP: 0.85 } });
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('模型输出达到长度上限，未生成完整提示词，请缩短原提示词或减少细节后重试');
  try { return (data.candidates[0].content.parts || []).map((part) => part.text).join(''); } catch (_) { throw new Error('Gemini 返回格式异常'); }
}

function extractOpenAICompletion(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice || !choice.message || typeof choice.message.content !== 'string') throw new Error('AI 返回格式异常');
  if (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens') {
    throw new Error('模型输出达到长度上限，未生成完整提示词。插件已阻止展示残缺结果，请重试');
  }
  return choice.message.content;
}

async function rewriteOptimizationInstruction(settings, model, provider, base, apiKey, instruction) {
  // 只在模型原样复制指令时做一次轻量视觉化改写，避免常规请求增加额外耗时。
  const prompt = `把下面这句用户修改要求改写成一句具体、可用于 AI 绘图提示词的视觉描述。不要解释，不要保留原句，不要添加无关内容。\n用户要求：${instruction}`;
  try {
    let raw;
    if (provider === 'anthropic') raw = await callTextAnthropic(base, apiKey, model, '你是视觉提示词编辑器。只输出改写后的短语。', prompt);
    else if (provider === 'google') raw = await callTextGoogle(base, apiKey, model, '你是视觉提示词编辑器。只输出改写后的短语。', prompt);
    else raw = await callTextOpenAICompatible(provider, base, apiKey, model, '你是视觉提示词编辑器。只输出改写后的短语。', prompt);
    return String(raw || '').replace(/^['"“”]|['"“”]$/g, '').trim();
  } catch (_) { return ''; }
}

function buildPromptOptimizationSystemPrompt(options) {
  const language = options.outputLanguage === 'en' ? 'English' : 'Chinese';
  return `你是一位专业的视觉提示词工程师。请把用户的模糊创意补全成可直接用于图像生成的完整提示词。\n\n输出语言：${language}\n图像类型：${options.imageType || '通用'}\n目标平台：${options.targetTool || '通用图像模型'}\n画幅比例：${options.aspectRatio || '1:1'}\n风格偏好：${options.style || '由你根据输入合理补全'}\n\n规则：\n1. 首次生成时扩展 input；二次优化时以 currentDocument 为基础，按 instruction 修改。\n2. instruction 是编辑命令，除非明确要求添加，否则不要把命令原文当成画面元素。\n3. 保留主体身份、轮廓、比例和用户未要求改变的细节。\n4. preserve_instruction 是用户指定的必须保留项。除编辑命令直接要求改变的目标外，逐项保留；若二者冲突，仅以编辑命令覆盖冲突目标。\n5. 只输出最终的完整提示词，不要输出英文提示词、分段结构、负面提示词、参数建议、修改说明或 JSON。\n6. 提示词应具体、完整、可直接用于图像生成，使用${language === 'Chinese' ? '中文' : '英文'}。`;
}

function buildOutputLanguageGuard(options) {
  if (options.outputLanguage === 'en') {
    return '\n\n语言校验：所有可见字段必须使用英文；不要输出中文。fullPromptEnglish 与 fullPrompt 都必须是英文。';
  }
  return '\n\n语言校验：这是中文输出任务。fullPrompt、negativePrompt、explanation 以及 sections 的每个字段必须使用简体中文；只有 fullPromptEnglish 字段允许使用英文。绝对不要把 fullPromptEnglish、英文 JSON 片段或字段名拼进 fullPrompt。输出前请检查 fullPrompt 中是否含有连续英文句子，若有必须翻译成中文。';
}

function buildPromptOptimizationUserMessage(request) {
  return JSON.stringify({
    task: request.currentDocument ? 'EDIT_CURRENT_PROMPT' : 'EXPAND_BLURRY_IDEA',
    original_input: request.input || '',
    edit_instruction: request.instruction || '',
    preserve_instruction: request.preserveInstruction || '',
    previous_result: request.currentDocument || null,
    locked_sections: request.lockedSections || [],
    important: 'edit_instruction 是编辑命令，不要把它原样追加到输出；请真正改写 previous_result。',
  });
}

async function callTextOpenAICompatible(provider, base, apiKey, model, systemPrompt, userMessage) {
  const maxTokens = provider === 'glm' || /bigmodel\.cn/i.test(base) || /^glm-/i.test(model) ? 2048 : PROMPT_OPTIMIZE_MAX_TOKENS;
  const payload = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], max_tokens: maxTokens, temperature: 0.55, top_p: 0.85, stream: false };
  if (provider === 'mimo') {
    payload.thinking = { type: 'disabled' };
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  const data = await requestPromptOptimize(`${base}/chat/completions`, { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, payload);
  return extractOpenAICompletion(data);
}

async function callTextAnthropic(base, apiKey, model, systemPrompt, userMessage) {
  const data = await requestPromptOptimize(`${base}/messages`, { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, { model, max_tokens: PROMPT_OPTIMIZE_MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] });
  try { return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); } catch (e) { throw new Error('Claude 返回格式异常'); }
}

async function callTextGoogle(base, apiKey, model, systemPrompt, userMessage) {
  const data = await requestPromptOptimize(`${base}/models/${model}:generateContent?key=${apiKey}`, { 'Content-Type': 'application/json' }, { contents: [{ parts: [{ text: systemPrompt + '\n\n用户输入：' + userMessage }] }], generationConfig: { maxOutputTokens: PROMPT_OPTIMIZE_MAX_TOKENS, temperature: 0.55, topP: 0.85 } });
  try { return (data.candidates[0].content.parts || []).map((p) => p.text).join(''); } catch (e) { throw new Error('Gemini 返回格式异常'); }
}

async function requestPromptOptimize(url, headers, payload, timeoutOverride) {
  let lastError = null;
  const requestTimeout = timeoutOverride || (isLocalApiBase(url) ? LOCAL_PROMPT_OPTIMIZE_TIMEOUT : (url.includes('/chat/completions') ? VISION_PROMPT_OPTIMIZE_TIMEOUT : PROMPT_OPTIMIZE_TIMEOUT));
  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    ACTIVE_ENHANCE_CONTROLLERS.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      if (resp.status >= 500 && attempt === 0) { await sleep(400); continue; }
      if (resp.status !== 200) {
        const errMsg = await extractError(resp);
        if (resp.status === 401) throw new Error(`API Key 无效或已过期 (401): ${errMsg}`);
        if (resp.status === 429) throw new Error(`请求频率超限 (429)，请稍后重试: ${errMsg}`);
        throw new Error(`API 请求失败 (${resp.status}): ${errMsg}`);
      }
      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`智能补全请求超时（${Math.round(requestTimeout / 1000)} 秒）：${url}\n请检查模型服务状态或切换更快的模型`);
      if (e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) throw new Error(`无法连接到 API 服务器：${url}\n可能原因：API Base URL 填写错误、接口不支持浏览器跨域，或当前网络无法访问该地址`);
      lastError = e;
      if (attempt === 1) throw e;
    } finally { clearTimeout(timer); ACTIVE_ENHANCE_CONTROLLERS.delete(controller); }
  }
  throw lastError || new Error('智能补全请求失败');
}

function parseStructuredPromptResponse(rawText) {
  const parsed = parseResponse(rawText);
  const loose = extractLoosePromptFields(rawText);
  if (loose.fullPrompt && (!parsed.fullPrompt || parsed.description === 'AI 返回格式非 JSON，已提取原始文本')) parsed.fullPrompt = loose.fullPrompt;
  if (loose.fullPromptEnglish && !parsed.fullPromptEnglish) parsed.fullPromptEnglish = loose.fullPromptEnglish;
  if (typeof parsed.fullPrompt === 'string') parsed.fullPrompt = parsed.fullPrompt.replace(/\s*[,{]?\s*["']fullPromptEnglish["']\s*:[\s\S]*$/i, '').trim();
  const sections = parsed.sections || {};
  const keys = ['subject', 'environment', 'composition', 'camera', 'lighting', 'color', 'material', 'atmosphere', 'style', 'details'];
  const normalized = {}; keys.forEach((key) => { normalized[key] = typeof sections[key] === 'string' ? sections[key] : ''; });
  const fallbackPrompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
  if (!keys.some((key) => normalized[key]) && (loose.fullPrompt || fallbackPrompt)) normalized.details = loose.fullPrompt || fallbackPrompt;
  return { fullPrompt: parsed.fullPrompt || fallbackPrompt || keys.map((k) => normalized[k]).filter(Boolean).join('，'), fullPromptEnglish: parsed.fullPromptEnglish || '', negativePrompt: parsed.negativePrompt || parsed.params?.negative_prompt || '', explanation: parsed.explanation || parsed.description || '', sections: normalized, metadata: parsed.metadata || {} };
}

function extractLoosePromptFields(rawText) {
  const text = String(rawText || '');
  const fullPromptMatch = text.match(/["']fullPrompt["']\s*:\s*["']([\s\S]*?)["']\s*,\s*["'](?:fullPromptEnglish|negativePrompt|explanation|sections|metadata)["']/i);
  const englishMatch = text.match(/["']fullPromptEnglish["']\s*:\s*["']([\s\S]*?)["']\s*(?:,|})/i);
  return {
    fullPrompt: fullPromptMatch ? fullPromptMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '',
    fullPromptEnglish: englishMatch ? englishMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '',
  };
}

function finalizeStructuredDocument(result, currentDocument, lockedSections) {
  if (!result.sections || typeof result.sections !== 'object') result.sections = {};
  const locked = Array.isArray(lockedSections) ? lockedSections : [];
  const previousSections = currentDocument && currentDocument.sections && typeof currentDocument.sections === 'object'
    ? currentDocument.sections
    : {};
  locked.forEach((key) => {
    if (typeof previousSections[key] === 'string') result.sections[key] = previousSections[key];
  });
  const orderedKeys = ['subject', 'environment', 'composition', 'camera', 'lighting', 'color', 'material', 'atmosphere', 'style', 'details'];
  const sectionValues = orderedKeys.map((key) => result.sections[key]).filter((value) => typeof value === 'string' && value.trim());
  // 有结构化模块时，以模块为唯一事实来源，确保完整提示词与卡片一致。
  // 模型只返回普通文本时保留 fullPrompt，避免把结果清空。
  if (sectionValues.length) result.fullPrompt = sectionValues.join('，');
}

// ============ 处理反推请求（直连 AI） ============
async function handleReverseRequest(message) {
  const { imageBase64, mimeType, imageUrl, settings } = message;

  let finalBase64 = imageBase64;
  // 如果 content script 无法获取 base64（CORS），由 service worker 获取
  if (!finalBase64 && imageUrl) {
    try {
      const imgData = await fetchImageAsBase64(imageUrl);
      finalBase64 = imgData.base64;
    } catch (e) {
      return { success: false, error: '无法获取图片数据：' + e.message };
    }
  }

  if (!finalBase64) {
    return { success: false, error: '无法获取图片数据，可能是跨域限制' };
  }

  try {
    const data = await reversePrompt(settings, finalBase64, mimeType);
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============ AI 模型路由 + 调用 ============
async function reversePrompt(settings, imageBase64, mimeType) {
  const { apiKey, apiBase, model, customModel, promptTemplate } = settings;

  if (!apiKey && !isLocalApiBase(apiBase)) {
    throw new Error('未配置 API Key，请在插件设置中填写');
  }

  const config = MODEL_PROVIDERS[model] || MODEL_PROVIDERS['custom'];
  const provider = config.provider;

  // 确定 API Base URL
  const base = resolveApiBase(apiBase, provider);
  if (!base) {
    throw new Error('未配置 API Base URL，请在设置中填写中转站地址');
  }

  // 前置校验：base 是否已包含端点后缀（最常见的 405 拼错）
  if (/\/(chat\/completions|messages|completions|generateContent)(\/|$)/.test(base)) {
    throw new Error(
      `API Base URL 末尾已经包含端点路径，请改成只到域名+版本号：\n` +
      `   当前: ${apiBase}\n` +
      `   应改为: ${base.replace(/\/(chat\/completions|messages|completions|generateContent)(\/|$).*/, '')}`
    );
  }
  // 智谱 v4 多写 /v1 检测
  if (base.includes('/api/paas/v4/v1')) {
    throw new Error(
      `智谱 GLM v4 API 已自带 /v4，不需要再加 /v1。请把 API Base 改为：\n` +
      `   https://open.bigmodel.cn/api/paas/v4`
    );
  }

  // 解析实际调用模型 ID（含视觉版本自动切换）
  const realModel = resolveRealModel(config, model, customModel);

  // 构建系统提示词（用户自定义模板优先）
  const systemPrompt = buildSystemPrompt(promptTemplate);

  // 检查视觉能力
  if (!config.vision && !config.vision_model) {
    throw new Error(
      `模型 ${model} 不支持图片分析，` +
      (realModel !== model ? `已自动切换到视觉版本 ${realModel}` : '请切换到支持视觉的模型')
    );
  }

  const safeMime = mimeType || 'image/png';
  const startTime = Date.now();

  let rawText;
  if (provider === 'anthropic') {
    rawText = await callAnthropic(base, apiKey, realModel, systemPrompt, imageBase64, safeMime);
  } else if (provider === 'google') {
    rawText = await callGoogle(base, apiKey, realModel, systemPrompt, imageBase64, safeMime);
  } else {
    // OpenAI 兼容格式：OpenAI / 豆包 / DeepSeek / 通义 / 文心 / Kimi / GLM / 中转站
    rawText = await callOpenAICompatible(provider, base, apiKey, realModel, systemPrompt, imageBase64, safeMime);
  }

  const result = parseResponse(rawText);
  result.model = realModel;
  result.elapsed = (Date.now() - startTime) / 1000;
  return result;
}

async function classifyTemplate(settings, image) {
  // 网页图片可能因跨域无法在 content script 中转成 base64；此时沿用正式反推流程，
  // 由 service worker 根据图片 URL 下载后再进行模板识别。
  let finalImage = image;
  if ((!finalImage || !finalImage.base64) && finalImage && finalImage.imageUrl) {
    try {
      const fetched = await fetchImageAsBase64(finalImage.imageUrl);
      finalImage = { ...finalImage, ...fetched };
    } catch (error) {
      throw new Error('无法获取图片数据：' + (error.message || '跨域图片下载失败'));
    }
  }
  if (!finalImage || !finalImage.base64) throw new Error('没有可识别的图片');
  const { apiKey, apiBase, model, customModel } = settings || {};
  if (!apiKey && !isLocalApiBase(apiBase)) throw new Error('未配置 API Key');
  const config = MODEL_PROVIDERS[model] || MODEL_PROVIDERS.custom;
  const provider = config.provider;
  const base = resolveApiBase(apiBase, provider);
  const realModel = resolveRealModel(config, model, customModel);
  const allTemplateIds = ['human_vehicle', 'blender_3d', 'commercial_product', 'ecommerce_white', 'creative_art'];
  const customCatalog = Array.isArray(settings?.templateCatalog) ? settings.templateCatalog.filter((item) => item && typeof item.id === 'string' && typeof item.label === 'string' && item.id.startsWith('custom_')) : [];
  const templateCatalog = [...allTemplateIds.map((id) => ({ id, label: ({ human_vehicle: '人车真实场景摄影', blender_3d: 'Blender 三维产品渲染', commercial_product: '商业产品广告', ecommerce_white: '电商白底产品图', creative_art: '创意艺术风格' })[id] })), ...customCatalog];
  const catalogIds = templateCatalog.map((item) => item.id);
  const availableTemplateIds = Array.isArray(settings.availableTemplateIds)
    ? settings.availableTemplateIds.filter((id) => catalogIds.includes(id))
    : catalogIds;
  const allowedTemplates = availableTemplateIds.length ? availableTemplateIds : ['human_vehicle'];
  const candidateText = templateCatalog.filter((item) => allowedTemplates.includes(item.id)).map((item) => `${item.id}（${item.label}）`).join('、');
  const system = `你是图片类型分类器。只返回严格JSON，不要Markdown。template只能是 ${candidateText} 中的模板ID之一。必须从这些当前可用模板中选择，不能推荐列表之外的模板。`;
  const user = '判断这张图片最适合使用哪套提示词反推模板。返回：{"template":"...","confidence":0到1,"reason":"简短中文理由"}。';
  let raw;
  if (provider === 'anthropic') raw = await callAnthropic(base, apiKey, realModel, system + '\n' + user, finalImage.base64, finalImage.mimeType || 'image/jpeg');
  else if (provider === 'google') raw = await callGoogle(base, apiKey, realModel, system + '\n' + user, finalImage.base64, finalImage.mimeType || 'image/jpeg');
  else raw = await callOpenAICompatible(provider, base, apiKey, realModel, system + '\n' + user, finalImage.base64, finalImage.mimeType || 'image/jpeg');
  const parsed = JSON.parse(String(raw).replace(/^```json\s*|```$/g, '').trim());
  if (!allowedTemplates.includes(parsed.template)) throw new Error('模型返回了未知模板');
  return { template: parsed.template, confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)), reason: String(parsed.reason || '') };
}

// 解析实际调用的模型 ID（视觉版本自动切换）
function resolveRealModel(config, model, customModel) {
  if (model === 'custom' && customModel) return customModel;
  if (!config.vision && config.vision_model) return config.vision_model;
  if (config.real_model) return config.real_model;
  return model;
}

// 构建系统提示词：用户自定义模板 → BASE + 用户模板；默认 → 完整 SYSTEM_PROMPT
function buildSystemPrompt(promptTemplate) {
  const isCustom = promptTemplate && promptTemplate.trim() &&
    promptTemplate.trim() !== DEFAULT_USER_TEMPLATE.trim();
  if (isCustom) {
    return SYSTEM_PROMPT_BASE +
      '\n\n## 用户自定义输出要求（优先级最高，覆盖以上所有输出格式和质量要求）\n' +
      promptTemplate;
  }
  return SYSTEM_PROMPT;
}

// ============ OpenAI 兼容格式 ============
async function callOpenAICompatible(provider, base, apiKey, model, systemPrompt, imageBase64, mimeType) {
  const url = `${base}/chat/completions`;
  const normalizedApiKey = normalizeApiKey(apiKey);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${normalizedApiKey}`,
  };
  // 通义千问需要额外 header
  if (provider === 'qwen') {
    headers['X-DashScope-SSE'] = 'disable';
  }
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: buildOpenAIImagePart({ base64: imageBase64, mimeType }, base).image_url,
          },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0.7,
    top_p: 0.9,
    stream: false,
  };
  // MiMo 默认可能启用深度思考。图片提示词反推以视觉理解和模板要求为主，
  // 关闭思考链可显著减少等待时间，同时保留最终答案质量。
  if (provider === 'mimo') {
    payload.thinking = { type: 'disabled' };
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }

  const data = await requestWithRetry(url, headers, payload);
  return extractOpenAICompletion(data);
}

// ============ Anthropic Claude 格式 ============
async function callAnthropic(base, apiKey, model, systemPrompt, imageBase64, mimeType) {
  const url = `${base}/messages`;
  const normalizedApiKey = normalizeApiKey(apiKey);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': normalizedApiKey,
    'anthropic-version': '2023-06-01',
  };
  const payload = {
    model,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  };

  const data = await requestWithRetry(url, headers, payload);
  try {
    const blocks = data.content || [];
    return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (e) {
    throw new Error('Claude 返回格式异常: ' + JSON.stringify(data).slice(0, 500));
  }
}

// ============ Google Gemini 格式 ============
async function callGoogle(base, apiKey, model, systemPrompt, imageBase64, mimeType) {
  const url = `${base}/models/${model}:generateContent?key=${apiKey}`;
  const headers = { 'Content-Type': 'application/json' };
  const payload = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 2000,
      temperature: 0.7,
      topP: 0.9,
    },
  };

  const data = await requestWithRetry(url, headers, payload);
  try {
    const candidates = data.candidates || [];
    if (!candidates.length) {
      throw new Error('Gemini 返回空结果: ' + JSON.stringify(data).slice(0, 500));
    }
    const parts = (candidates[0].content && candidates[0].content.parts) || [];
    return parts.map((p) => p.text).join('');
  } catch (e) {
    throw new Error('Gemini 返回格式异常: ' + JSON.stringify(data).slice(0, 500));
  }
}

// ============ 请求重试 ============
async function requestWithRetry(url, headers, payload) {
  let lastError = null;
  const requestTimeout = isLocalApiBase(url) ? LOCAL_PROMPT_OPTIMIZE_TIMEOUT : (url.includes('/chat/completions') ? VISION_PROMPT_OPTIMIZE_TIMEOUT : REQUEST_TIMEOUT);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      validateRequestHeaders(headers);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 5xx 错误重试
      if (resp.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      // 4xx 错误直接返回（不重试）
      if (resp.status !== 200) {
        const errMsg = await extractError(resp);
        // 405 特殊处理：把完整 URL 暴露给用户，便于排查 base 拼接错误
        if (resp.status === 405) {
          const hint = diagnose405(url);
          throw new Error(`API 请求失败 (405): 该 URL 不接受 POST 请求\n   → 实际请求: ${url}\n   → 服务器返回: ${errMsg || '(无内容)'}\n${hint}`);
        }
        if (resp.status === 401) throw new Error(`API Key 无效或已过期 (401): ${errMsg}`);
        if (resp.status === 429) throw new Error(`请求频率超限 (429)，请稍后重试: ${errMsg}`);
        if (resp.status === 404) throw new Error(`模型不存在或无权访问 (404): ${errMsg}`);
        throw new Error(`API 请求失败 (${resp.status}): ${errMsg}`);
      }

      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        lastError = new Error(`请求超时（${requestTimeout / 1000}s），请检查网络或更换模型`);
        if (attempt < MAX_RETRIES) { await sleep(2000); continue; }
        throw lastError;
      }
      if (e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) {
        lastError = new Error(`无法连接到 API 服务器: ${e.message}`);
        if (attempt < MAX_RETRIES) { await sleep(2000); continue; }
        throw lastError;
      }
      // 其他错误（如 4xx 抛出的）直接抛出，不重试
      throw e;
    }
  }
  throw lastError || new Error('请求失败，未知错误');
}

// Fetch 要求请求头值只能包含 Latin-1 字符。API Key 通常应为 ASCII；
// 粘贴时常见的首尾空格/换行可以清理，但中文等字符必须提示用户重新配置。
function normalizeApiKey(apiKey) {
  return String(apiKey || '').trim();
}

function validateRequestHeaders(headers) {
  for (const [name, value] of Object.entries(headers || {})) {
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) > 255) {
        throw new Error(`请求头 ${name} 含有中文或其他非法字符，请在插件设置中重新粘贴 API Key（不要包含中文、引号或换行）`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractError(resp) {
  try {
    const data = await resp.json();
    if (data.error) {
      if (typeof data.error === 'string') return data.error;
      if (data.error.message) return data.error.message;
    }
    return JSON.stringify(data).slice(0, 300);
  } catch (e) {
    try {
      const text = await resp.text();
      return text.slice(0, 300);
    } catch (_) {
      return '';
    }
  }
}

// 405 智能诊断：自动检测常见的 base 拼接错误
function diagnose405(url) {
  const hints = [];

  // 情况 1：base 重复了 /chat/completions
  if (url.includes('/chat/completions/chat/completions') ||
      url.includes('/messages/messages') ||
      url.includes('/completions/completions') ||
      url.includes('/generateContent/generateContent')) {
    hints.push('💡 你的 API Base 末尾已经包含 /chat/completions（或其他端点路径），代码又拼了一次。请把 base 改成只到域名+版本号，如：');
    hints.push('   • 智谱 GLM: https://open.bigmodel.cn/api/paas/v4');
    hints.push('   • OpenAI:  https://api.openai.com/v1');
    hints.push('   • 豆包:    https://ark.cn-beijing.volces.com/api/v3');
    hints.push('   • 通义:    https://dashscope.aliyuncs.com/compatible-mode/v1');
    return '\n' + hints.join('\n');
  }

  // 情况 2：智谱 v4 多写了 /v1
  if (url.includes('/api/paas/v4/v1/') || url.includes('/api/paas/v4/v1')) {
    hints.push('💡 智谱 GLM v4 API 已经自带 /v4，不需要再加 /v1。请把 base 改为：');
    hints.push('   https://open.bigmodel.cn/api/paas/v4');
    return '\n' + hints.join('\n');
  }

  // 情况 3：base 是非 API 域名（图片/网页）
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host.includes('bigmodel.cn') && !url.includes('/api/paas/')) {
      hints.push('💡 检测到 URL 不含 /api/paas/ 路径，请检查 API Base 是否填写正确');
      hints.push('   智谱官方: https://open.bigmodel.cn/api/paas/v4');
      return '\n' + hints.join('\n');
    }
  } catch (_) { /* ignore */ }

  // 情况 4：base 是 Anthropic 路径但 model 不是 Claude
  if (url.includes('anthropic.com') && !url.endsWith('/v1/messages')) {
    hints.push('💡 检测到 Anthropic 域名，请确认模型选择了 Claude 系列');
    return '\n' + hints.join('\n');
  }

  // 情况 5：base 是 Google 路径但 model 不是 Gemini
  if (url.includes('generativelanguage.googleapis.com') && !url.includes(':generateContent')) {
    hints.push('💡 Google Gemini 用专用 endpoint（:generateContent），与 OpenAI 格式不兼容');
    return '\n' + hints.join('\n');
  }

  // 通用提示
  hints.push('💡 405 通常是「base 拼错了」。检查项：');
  hints.push('   1. base 不要包含 /chat/completions、/messages 等端点后缀');
  hints.push('   2. base 不要包含 /v1（智谱 v4 自带 /v4）');
  hints.push('   3. base 是域名+版本号即可（如 https://xxx.com/v1）');
  hints.push('   4. 也可以「留空」让扩展用模型对应的官方默认地址');
  return '\n' + hints.join('\n');
}

// ============ 解析 AI 返回的 JSON ============
function parseResponse(rawText) {
  if (!rawText) {
    return { prompt: '', tags: [], params: {}, description: 'AI 返回为空' };
  }
  // 尝试直接解析
  try {
    return JSON.parse(rawText);
  } catch (e) { /* ignore */ }

  // 尝试从 markdown 代码块中提取
  const jsonMatch = rawText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) { /* ignore */ }
  }

  // 尝试从文本中提取第一个 JSON 对象
  const braceStart = rawText.indexOf('{');
  const braceEnd = rawText.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(rawText.slice(braceStart, braceEnd + 1));
    } catch (e) { /* ignore */ }
  }

  // 解析失败，把整个文本作为 prompt 返回
  return {
    prompt: rawText.trim(),
    tags: [],
    params: {},
    description: 'AI 返回格式非 JSON，已提取原始文本',
  };
}

// ============ 获取图片 base64（处理跨域图片） ============
async function fetchImageAsBase64(url) {
  // data: URL 直接处理
  if (url.startsWith('data:')) {
    const match = url.match(/^data:(.+?);base64,(.*)$/);
    if (match) {
      return { base64: match[2], mimeType: match[1] };
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`获取图片失败: ${response.status}`);
  }

  const blob = await response.blob();
  const base64 = await blobToBase64(blob);
  return {
    base64,
    mimeType: blob.type || 'image/png',
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
