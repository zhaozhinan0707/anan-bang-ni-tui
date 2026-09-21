# 提示词收藏夹 · Prompt Vault（M2 开发中 · 同步引擎 V1.1 已实现）

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

本项目以 MIT 许可证开源。请勿把 API Key、模型服务凭据、更新签名私钥或本机项目数据提交到仓库。

## 自动更新与发布

Windows 桌面端使用 GitHub Releases 免费分发更新，并对更新包进行签名校验。安装带自动更新功能的版本后，应用启动会自动检查新版本，也可以在顶部点击“检查更新”。发现新版本时会展示更新说明，并允许一键下载和安装。

维护者发布新版本时，在 `desktop-app` 目录运行：

```powershell
pnpm run publish:update -- -Version 1.1.1 -Notes "本次更新内容"
```

发布脚本会同步版本号、签名构建 Windows 安装包、生成 `latest.json`，并创建 GitHub Release。签名私钥仅保存在维护者电脑的 `%USERPROFILE%\.prompt-vault-updater` 中，不会进入公开仓库。

面向 AI 绘画设计师的提示词收集器：**Chrome 右键采集 → 桌面应用 1:1 卡片管理 → 共享盘团队同步**（V1 仅 Windows）。

```
prompt-vault/
├── chrome-extension/          # 采集端：Chrome 扩展（Manifest V3）
│   ├── manifest.json          # 权限：contextMenus / downloads / activeTab / storage
│   ├── background.js          # 右键菜单 → 提取提示词 → 写 staging 清单
│   ├── content.js             # 页面内响应提示词提取请求
│   ├── matchers.js            # ⭐ 来源抓取规则（Lovart / 哩布哩布 / 通用兜底，可扩展）
│   ├── save.html / save.js    # 未识别到提示词时的手动保存小窗
│   └── popup.html / popup.js  # 扩展气泡（使用说明 / 手动添加）
└── desktop-app/               # 管理端：Tauri 2 桌面应用
    ├── src/                   # 前端（纯静态，无构建；浏览器可直接打开预览）
    │   └── index.html         # 双模式：浏览器 localStorage 预览 / Tauri invoke 后端
    └── src-tauri/
        ├── Cargo.toml / tauri.conf.json / build.rs / capabilities/
        └── src/
            ├── main.rs        # 入口
            ├── lib.rs         # 命令层：卡片增删 / 同步 / 历史版本 / 冲突解决
            ├── storage.rs     # 本地 SQLite 权威副本（cards/categories/sync_state + outbox）
            ├── ingest.rs      # 扫描 Chrome 扩展 staging → 入库 → 入同步队列
            └── sync.rs        # ⭐ 共享盘同步引擎（CAS+锁 / watermark / outbox / tombstone）
```

## 一、Chrome 扩展：立即加载试用

1. 打开 Chrome → `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `chrome-extension/` 目录
4. 打开任意 AI 绘画网站（Lovart / 哩布哩布），在图片上**右键 → 「保存到提示词收藏夹」**

保存结果写入 **下载目录 `/PromptVault-staging/`**：
- `{uuid}.png`：原图
- `{uuid}.json`：清单（prompt、negativePrompt、sourceTool、category、params、createdAt …）

自动识别到提示词 → 直接保存（扩展图标闪烁 ✓）；识别不到 → 弹出小窗手动粘贴提示词后保存。

### 新增提示词来源（比如以后加了"可灵"）

编辑 `chrome-extension/matchers.js`，在 `PROMPT_MATCHERS` 数组末尾追加一个 matcher：

```js
{
  name: "可灵",
  extract() {
    // 用 DevTools 找到页面上提示词所在的元素，替换下面选择器
    const el = document.querySelector('[class*="prompt"]');
    const text = el && (el.textContent || "").trim();
    return text && isPromptLike(text) ? { prompt: text, params: { sourceTool: "可灵" } } : null;
  }
}
```

保存后在 `chrome://extensions/` 点「重新加载」即可生效。

## 二、桌面应用：两种方式查看

### 方式 A：浏览器预览（无需任何环境，立即看效果）

直接双击打开 `desktop-app/src/index.html`（或在浏览器打开）。此时走 **localStorage 模拟存储**：

- 快捷键 `Ctrl+Shift+P` 模拟扩展保存弹窗 → 保存的卡片进入本地库
- 「扫描入库」按钮为模拟（浏览器模式不读下载目录）
- 设置中的共享盘路径可填写，仅保存在 localStorage

### 方式 B：编译为真正的 Windows 桌面程序（Tauri）

需要环境（一次性安装）：
1. **Rust 工具链**：https://rustup.rs （默认即可，含 cargo/rustc）
2. **MSVC Build Tools**：https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/ → 勾选「使用 C++ 的桌面开发」
3. Node.js ≥ 18（已具备）

然后：

```bash
cd desktop-app
# 安装 tauri CLI（全局，可选）
npm install -g @tauri-apps/cli
# 开发模式（带热更新，适合边改边看）
npm run dev
# 或：发布安装包（NSIS 安装程序）
npm run build
```

编译成功后：
- 本地库在 `%LOCALAPPDATA%/com.promptvault.app/vault.db`，图片缓存在同目录 `images/`
- 工具栏「扫描入库」会**真实读取**下载目录 `PromptVault-staging/`，把扩展采集的卡片入库
- 设置里填写共享盘路径（如 `\\server\design\PromptVault` 或 `Z:\PromptVault`）后保存，即启用团队同步（路径留空则纯本地模式）
- 共享盘在线时每 8 秒自动同步一次；「立即同步」按钮可手动触发

## 三、采集桥接协议（扩展 → 桌面应用）

```
Chrome 扩展（无法直连 SMB）
   → 写 下载目录/PromptVault-staging/{uuid}.json + {uuid}.png
   → 桌面应用 ingest_staging() 扫描目录
   → 校验清单 → 插入本地 SQLite → 清单移入 processed/
```

清单字段（与 storage::Card 一一对应）：

```json
{
  "id": "uuid",
  "prompt": "…",
  "negativePrompt": "…",
  "sourceTool": "Lovart",
  "category": "国潮插画",
  "tags": [],
  "imageFile": "{uuid}.png",
  "params": {},
  "pageUrl": "https://…",
  "createdAt": "2026-08-14T21:00:00+08:00",
  "version": 1
}
```

## 四、共享盘同步（V1.1 已实现）

### 数据组织（共享盘目录结构）

```
{共享盘根}/PromptVault/            # 如 Z:\PromptVault 或 \\server\design\PromptVault
├── cards/{YYYYMM}/{cardId}/
│   ├── card.json                  # 卡片元数据（权威副本，含 version）
│   ├── image.jpg                  # 共享图（本地另存原图）
│   └── card.json.lock             # fs2 文件锁（短临界区并发控制）
├── changelog/{YYYYMM}.log         # 追加式变更日志（唯一权威信号源）
├── tombstones/{cardId}.tomb       # 软删除墓碑（30 天保留 → compact_tombstones 归档）
├── versions/{cardId}/v{n}.json    # 历史版本 + 冲突败者（供对比/回滚）
└── categories/category.json       # 分类定义（V1.1 暂由本地库管理）
```

### 同步机制

| 能力 | 实现 |
|------|------|
| 并发控制 | **CAS 写协议**：fs2 文件锁短临界区 → 锁内读远端 baseVersion → version=base+1 → tmp+rename 原子替换 → 读回校验；校验失败自动归档败者到 `versions/`，**绝不覆盖他人修改** |
| 变更传播 | 本地增/改/删先入 **outbox** → 在线时 CAS 推送并写 changelog → 各端从 **watermark** 增量消费 changelog（LWW：版本不高于本地则忽略） |
| 离线可用 | 本地 SQLite 全量缓存；断网仅积压 outbox，重连后 8 秒轮询自动补推 |
| 软删除 | 写 tombstone + changelog delete 广播 → 各端本地软删除 → 「最近删除」30 天可恢复 |
| 冲突处理 | 极端并发 → 我方版本归档 + 卡片打 ⚠ 冲突标 → 详情页对比后 `resolve_conflict("mine"/"theirs")` |
| 历史版本 | 每次更新前自动归档旧版 → `list_versions` / `restore_version` 回滚生成新版本推给团队 |
| 自动同步 | 启动后每 8 秒轮询（`sync_once`：先推 outbox 再拉 changelog），未配置路径时静默空转 |

### Tauri 命令一览

`get_cards` / `get_deleted` / `add_card` / `delete_card` / `restore_deleted` / `ingest_staging` / `set_share_path` / `get_sync_status` / `sync_now` / `list_versions` / `restore_version` / `resolve_conflict` / `create_category`

## 五、已知边界（V1.1）

- `matchers.js` 的 Lovart / 哩布哩布选择器为**启发式占位**，需按真实页面结构微调；
- 图片当前原样复制到共享盘（2048px 压缩在 F7.2 引入）；
- Tauri 侧 staging 采用手动「扫描入库」+ 同步轮询；notify 实时监听留待优化；
- 冲突对比 UI 为前端原型交互，已对接 `resolve_conflict` 命令。
