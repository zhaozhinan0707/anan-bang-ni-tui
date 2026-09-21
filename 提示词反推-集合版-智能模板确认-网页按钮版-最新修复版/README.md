# 提示词反推 - Chrome/Edge 浏览器扩展

> 在任意网页图片上悬浮按钮，一键调用 AI 反推中文提示词，支持 GPT / Claude / Gemini / 豆包 / DeepSeek / 通义千问 / GLM 等 20+ 模型和中转站。
>
> **纯前端扩展**：扩展直接调用 AI API，无需任何后端服务，安装即用的。

## 项目结构

```
prompt-reverse-extension/
├── manifest.json              # Chrome 扩展清单 (Manifest V3)
├── lib/
│   └── config.js              # 共享配置 (模型列表、默认设置)
├── content/
│   ├── content.js             # 内容脚本 (悬浮按钮 + 结果面板)
│   └── content.css            # 注入样式
├── background/
│   └── service-worker.js      # 后台 Service Worker (AI 直连调用 + 消息中转 + 图片获取)
├── popup/
│   ├── popup.html             # 设置弹窗 HTML
│   ├── popup.css              # 弹窗样式
│   └── popup.js               # 弹窗逻辑 (设置存储 + 配置检测)
├── icons/                     # 扩展图标 (运行 generate_icons.py 生成)
└── generate_icons.py          # 图标生成脚本 (可选)
```

## 安装步骤

### 第一步：生成图标（如 icons 目录为空）

```bash
cd prompt-reverse-extension
python generate_icons.py
```

> 需要 Pillow 库：`pip install Pillow`
>
> ⚠️ 项目已带 `pyproject.toml`，Python 编译缓存（`__pycache__`）会自动输出到 `%LOCALAPPDATA%\pycache-prompt-reverse-extension\`。
> Chrome 扩展加载时**禁止任何下划线开头的文件/目录**，如果碰到 `Cannot load extension with file or directory name "__pycache__"`，删除项目里的 `__pycache__` 文件夹即可。

### 第二步：加载 Chrome 扩展

1. 打开 Chrome 或 Edge，地址栏输入 `chrome://extensions/`
2. 右上角开启 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择 `prompt-reverse-extension` 目录
5. 扩展图标出现在浏览器工具栏

### 第三步：配置 API Key

1. 点击浏览器工具栏的扩展图标
2. 填写 **API Key**（必填，保存在本地浏览器，不上传任何服务器）
3. 选择 **AI 模型**
4. 点击 **「保存设置」**

> 无需启动任何后端服务 —— 扩展会直接调用你选择的 AI 接口。

## 使用方法

1. 打开任意网页（如 Pinterest、Eagle、Behance 等图片网站）
2. 鼠标悬停在图片上 → 右上角出现蓝色 **「反推提示词」** 按钮
3. 点击按钮 → 显示加载动画 → AI 分析图片
4. 结果面板显示 **中文提示词** + 标签 + 元数据
5. 点击 **「一键复制」** → 提示词复制到剪贴板
6. 可点击 **「重新生成」** 重新分析

## 支持的模型

### 国际模型
| 模型 | 视觉能力 | 说明 |
|------|---------|------|
| GPT-4o | ✅ | OpenAI 最强多模态模型 |
| GPT-4o mini | ✅ | 性价比最高的 GPT 模型 |
| GPT-4 Turbo | ✅ | GPT-4 视觉版本 |
| o1-preview | ❌ | 纯文本推理模型（不支持图片） |
| Claude 3.5 Sonnet | ✅ | Anthropic 最新模型 |
| Claude 3 Opus | ✅ | Anthropic 最强模型 |
| Gemini 1.5 Pro | ✅ | Google 最强多模态模型 |
| Gemini 1.5 Flash | ✅ | Google 快速模型 |

### 国内模型
| 模型 | 视觉能力 | 说明 |
|------|---------|------|
| 豆包 Pro 32K | 自动切换 | 字节跳动，自动使用 doubao-vision-pro |
| 豆包 Pro 128K | 自动切换 | 长上下文版本 |
| 豆包 Lite 32K | ❌ | 轻量版（不支持图片） |
| DeepSeek-V3 | ❌ | 深度求索（不支持图片） |
| DeepSeek-R1 | ❌ | 推理模型（不支持图片） |
| 通义千问 Max | 自动切换 | 阿里，自动使用 qwen-vl-max |
| 通义千问 Plus | 自动切换 | 自动使用 qwen-vl-plus |
| 文心一言 4.0 | 自动切换 | 百度，自动使用 ERNIE-4.0-VL |
| Kimi | ❌ | 月之暗面（不支持图片） |
| GLM-4 | ❌ | 智谱（不支持图片） |
| GLM-4V | ✅ | 智谱视觉模型 |

### 中转站
| 选项 | 说明 |
|------|------|
| 自定义模型 | 填写 API Base URL + 自定义模型名称，走 OpenAI 兼容格式 |

## 中转站配置

1. 在扩展设置中填写 **API Base URL**（如 `https://api.your-proxy.com/v1`）
2. 选择 **AI 模型** → **自定义模型（中转站）**
3. 在 **自定义模型名称** 中填写模型 ID（如 `gpt-4o-2024-08-06`）
4. 填写 **API Key**
5. 保存设置

中转站统一使用 OpenAI 兼容格式请求，兼容所有支持该格式的代理服务。

## 提示词模板

在设置中可填写 **提示词模板**（自定义输出要求），例如：

- `请生成英文提示词，适合 Midjourney`
- `只分析色彩和光影，输出 Stable Diffusion 格式`
- `请输出适合电商主图的清新风格提示词`

自定义模板会作为**最高优先级指令**合并进系统提示词，覆盖默认的中文 JSON 格式要求。留空则使用默认的「中文 + JSON 格式」输出。

## 架构说明

```
用户浏览图片
    ↓
Content Script 检测到图片 hover
    ↓
显示悬浮按钮 (右上角，不遮挡图片)
    ↓
用户点击按钮
    ↓
Content Script 获取图片 base64 (canvas 或 service worker 代理跨域图片)
    ↓
发送消息到 Service Worker
    ↓
Service Worker 直接调用 AI API (OpenAI/Claude/Gemini/国内模型/中转站)
    ↓
AI 返回 JSON (prompt + tags + params + description)
    ↓
Service Worker 返回结果到 Content Script
    ↓
显示结果面板 (中文提示词 + 一键复制)
```

> 整个过程**不经过任何本地或远程后端**，API Key 仅保存在你的浏览器本地存储（chrome.storage.sync）。

## 常见问题

### Q: 点击按钮后显示「请填写 API Key 后使用」
A: 在扩展弹出设置中填写你的 AI 服务 API Key 并保存即可。

### Q: 显示「API Key 无效或已过期 (401)」
A: 检查 API Key 是否正确，是否已过期，是否有足够的余额。

### Q: 显示「模型不支持图片分析」
A: 部分模型（如 DeepSeek-V3、Kimi、GLM-4、豆包 Lite）是纯文本模型，不支持图片输入。请切换到支持视觉的模型（如 GPT-4o、Claude 3.5 Sonnet、GLM-4V），或选择会自动切换视觉版本的模型（豆包 Pro、通义千问 Max/Plus、文心一言 4.0）。

### Q: 悬浮按钮不出现
A: 1) 检查扩展是否已启用；2) 图片是否太小（宽高需 > 80px）；3) 刷新页面重试。

### Q: CORS / 跨域错误
A: 扩展的 Service Worker 不受网页 CORS 限制，可正常请求 AI 接口。如遇个别接口跨域问题，可在设置中填写中转站 API Base URL。

### Q: 如何修改系统提示词 / 提示词模板
A: 在扩展弹出设置中填写「提示词模板」即可自定义输出要求；高级用户也可编辑 `background/service-worker.js` 中的 `SYSTEM_PROMPT_BASE` 与 `DEFAULT_OUTPUT_INSTRUCTIONS`。

## 技术栈

- **前端**：Chrome Extension Manifest V3、原生 JS、CSS
- **AI 接口**：OpenAI Chat Completions API、Anthropic Messages API、Google Gemini API（以及兼容 OpenAI 格式的国内模型 / 中转站）
- **部署形态**：纯前端扩展，无后端依赖
