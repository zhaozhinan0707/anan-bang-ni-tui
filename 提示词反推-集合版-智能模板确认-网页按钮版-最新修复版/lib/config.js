/**
 * 提示词反推扩展 - 共享配置
 * 被content script和popup共用
 */
const PR_PROMPT_TEMPLATES = [
  {
    id: 'human_vehicle',
    label: '人车真实场景摄影',
    content: '请反推这张图片中的人物与自行车、电动自行车或滑板车等车辆的真实场景摄影提示词。重点描述人物动作与姿态、车辆外形与结构、人与车的关系、道路和环境、镜头视角、景别、构图、自然光与阴影、色彩、材质、运动感和真实摄影质感。不要臆测不可见细节，不要改变车辆品牌或结构。输出一段可直接用于图像生成的中文提示词。',
  },
  {
    id: 'blender_3d',
    label: 'Blender 三维产品渲染',
    content: '请将图片反推为 Blender/Cycles 或 Eevee 风格的三维产品渲染提示词。重点描述产品几何形态、比例、结构分件、边缘倒角、材质节点、金属/塑料/玻璃/橡胶质感、粗糙度与反射、摄影棚或场景背景、三点布光、相机焦段、景深、构图、色彩、环境遮蔽、接触阴影、渲染质量与真实产品可视化效果。不得把三维渲染误写成真实摄影，输出一段可直接用于图像生成的中文提示词。',
  },
  { id: 'commercial_product', label: '商业产品广告', content: '请将图片反推为可直接用于商业产品广告的中文提示词，重点描述主体、产品卖点、场景、构图、镜头、光线、材质、色彩、品牌质感与画面留白，保持产品结构准确，避免添加不可见元素。' },
  { id: 'ecommerce_white', label: '电商白底产品图', content: '请反推这张图片的电商产品摄影提示词，重点描述产品外形、角度、比例、材质、白色或浅色背景、柔和棚拍光线、接触阴影、清晰度和商品展示要求，输出简洁准确的中文提示词。' },
  { id: 'creative_art', label: '创意艺术风格', content: '请将图片反推为创意艺术风格的中文生图提示词，完整描述主体、艺术风格、媒介质感、构图、色彩、光影、空间氛围和细节层次，同时保留画面的核心内容与视觉重点。' },
];

const PR_CONFIG = {
  // 默认设置
  DEFAULTS: {
    enabled: true,
    apiKey: '',
    apiBase: '',
    model: 'gpt-4o',
    customModel: '',
    promptTemplateId: 'human_vehicle',
    promptTemplate: PR_PROMPT_TEMPLATES[0].content,
  },

  // 模型列表 (value → 显示名)
  MODELS: [
    // 国际模型
    { group: '国际模型', value: 'gpt-4o',          label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
    { value: 'o1-preview',    label: 'o1-preview' },
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus',     label: 'Claude 3 Opus' },
    { value: 'gemini-1.5-pro',    label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash',  label: 'Gemini 1.5 Flash' },
    { value: 'gemini-2.5-flash',  label: 'Gemini 2.5 Flash（推荐）' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite（快速）' },
    // 国内模型
    { group: '国内模型', value: 'doubao-pro-32k',  label: '豆包 Pro 32K' },
    { value: 'doubao-pro-128k', label: '豆包 Pro 128K' },
    { value: 'doubao-lite-32k', label: '豆包 Lite 32K' },
    { value: 'deepseek-chat',    label: 'DeepSeek-V3' },
    { value: 'deepseek-reasoner',label: 'DeepSeek-R1' },
    { value: 'qwen-max',         label: '通义千问 Max' },
    { value: 'qwen-plus',        label: '通义千问 Plus' },
    { value: 'qwen3-vl-flash',   label: 'Qwen3-VL-Flash（快速/免费额度）' },
    { value: 'wenxin-4',         label: '文心一言 4.0' },
    { value: 'moonshot-v1-32k',  label: 'Kimi' },
    { value: 'glm-4',            label: 'GLM-4' },
    { value: 'glm-4v',           label: 'GLM-4V 视觉' },
    { value: 'mimo-v2-flash',    label: '小米 MiMo-V2-Flash 视觉' },
    { value: 'mimo-v2.5-pro',     label: '小米 MiMo-V2.5-Pro 视觉' },
    { value: 'mimo-v2.5',         label: '小米 MiMo-V2.5 视觉' },
    // 中转站
    { group: '中转站', value: 'custom', label: '自定义模型（中转站）' },
  ],

  // 模型 → 中文标签映射 (供结果面板元数据显示)
  MODEL_LABELS: {},

  // 支持视觉的模型 (不需要自动切换视觉版本)
  VISION_MODELS: new Set([
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo',
    'claude-3-5-sonnet', 'claude-3-opus',
    'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    'qwen3-vl-flash', 'glm-4v', 'mimo-v2-flash', 'mimo-v2.5-pro', 'mimo-v2.5', 'custom',
  ]),

  // 需要自动切换到视觉版本的模型映射
  VISION_REDIRECT: {
    'doubao-pro-32k':  'doubao-vision-pro',
    'doubao-pro-128k': 'doubao-vision-pro',
    'qwen-max':        'qwen-vl-max',
    'qwen-plus':       'qwen-vl-plus',
    'wenxin-4':        'ernie-4.0-vl',
  },

  // 各厂商默认 API 地址
  DEFAULT_API_BASES: {
    'gpt-4o':          'https://api.openai.com/v1',
    'gpt-4o-mini':     'https://api.openai.com/v1',
    'gpt-4-turbo':     'https://api.openai.com/v1',
    'o1-preview':      'https://api.openai.com/v1',
    'claude-3-5-sonnet': 'https://api.anthropic.com/v1',
    'claude-3-opus':     'https://api.anthropic.com/v1',
    'gemini-1.5-pro':    'https://generativelanguage.googleapis.com/v1beta',
    'gemini-1.5-flash':  'https://generativelanguage.googleapis.com/v1beta',
    'gemini-2.5-flash':  'https://generativelanguage.googleapis.com/v1beta',
    'gemini-2.5-flash-lite': 'https://generativelanguage.googleapis.com/v1beta',
    'doubao-pro-32k':    'https://ark.cn-beijing.volces.com/api/v3',
    'doubao-pro-128k':   'https://ark.cn-beijing.volces.com/api/v3',
    'doubao-lite-32k':   'https://ark.cn-beijing.volces.com/api/v3',
    'deepseek-chat':     'https://api.deepseek.com/v1',
    'deepseek-reasoner': 'https://api.deepseek.com/v1',
    'qwen-max':          'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'qwen-plus':         'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'qwen3-vl-flash':    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'wenxin-4':          'https://qianfan.baidubce.com/v2',
    'moonshot-v1-32k':   'https://api.moonshot.cn/v1',
    'glm-4':             'https://open.bigmodel.cn/api/paas/v4',
    'glm-4v':            'https://open.bigmodel.cn/api/paas/v4',
  },

  // 请求超时 (毫秒)
  REQUEST_TIMEOUT: 60000,

  // 图片最大尺寸 (超过则压缩)
  MAX_IMAGE_SIZE: 1920,
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,

  // 收藏夹配置
  MAX_FAVORITES: 15,           // 最多收藏条数
  FAVORITES_KEY: 'pr_favorites', // chrome.storage.local 的存储键名
  PROMPT_TEMPLATES: PR_PROMPT_TEMPLATES,
};

// 初始化 MODEL_LABELS
PR_CONFIG.MODELS.forEach(m => {
  PR_CONFIG.MODEL_LABELS[m.value] = m.label;
});

// 暴露到全局 (content script 和 popup 都需要)
if (typeof window !== 'undefined') {
  window.PR_CONFIG = PR_CONFIG;
}
if (typeof globalThis !== 'undefined') {
  globalThis.PR_CONFIG = PR_CONFIG;
}
