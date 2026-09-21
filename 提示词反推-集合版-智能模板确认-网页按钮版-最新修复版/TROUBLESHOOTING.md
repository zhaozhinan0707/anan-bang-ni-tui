# 故障排查 - 安装后看不到悬浮按钮 / 出现 UIManager 报错

> 适用版本：v1.0.2 及以后

## 现象 A：开发者工具显示 `[PromptReverse] UIManager not loaded`

**原因**：你看到的是 Chrome 缓存里 **旧版本 content.js** 报错的残留记录。当前版本（v1.0.2）已经移除了 `UIManager` 模块，但 Chrome 扩展更新后，content script 不会自动注入新版本到已经打开的页面。

**解决步骤**（3 步，**必须全部完成**）：

1. 打开 `chrome://extensions/`
2. 找到"提示词反推"，点击右下角的 **🔄 刷新按钮**（仅当修改了扩展文件后才需要重新加载；如果只是配置或第一次安装，这一步会更新清单）
3. **必须刷新所有正在浏览的网页** —— content script 只在页面加载时注入，不刷新不会生效

完成后再悬停到图片上，按钮应该立刻出现。

---

## 现象 B：刷新扩展后还是看不到悬浮按钮

按照下面的清单逐项检查：

| # | 检查项 | 怎么验证 |
|---|---|---|
| 1 | 扩展已启用 | `chrome://extensions/` → 提示词反推是蓝色「已启用」状态 |
| 2 | 已刷新网页 | 在图片上悬停之前网页需要重新加载（F5 / Cmd+R） |
| 3 | 控制台有加载日志 | F12 → Console，过滤 `[提示词反推]`，应看到：`[提示词反推 v1.0.2] Content script 注入中...` |
| 4 | 控制台有「✅ 初始化成功」绿色横幅 | 这是扩展生效的最终标志 |
| 5 | 图片尺寸 ≥ 80×80 px | 太小的图标、装饰图、表情包不会触发 |
| 6 | 图片 src 是 http(s) | `chrome-extension://` 协议会被脚本主动跳过 |
| 7 | 扩展设置页「启用」开关是开 | 点扩展图标 → 顶部开关 |

### 控制台首条日志的含义

打开 F12 → Console，按下面的特征找日志：

```
✅ 正确：[提示词反推 v1.0.2] Content script 注入中...
✅ 正确：[提示词反推] ✅ 初始化成功 (v1.0.2) ...
✅ 正确：[提示词反推] 把鼠标悬停在网页中任意 ≥80×80 的图片上，即可看到 ✨反推提示词 按钮
❌ 错误：[提示词反推] PR_CONFIG 未定义，扩展初始化失败。请前往 chrome://extensions/ 刷新本扩展并刷新当前页面。
```

最后一行意味着 `lib/config.js` 没加载成功 —— 大多数情况是 manifest 里 content scripts 顺序错了。当前 manifest 是：

```json
"content_scripts": [{
  "js": ["lib/config.js", "content/content.js"],   ← 顺序必须如此
}]
```

---

## 现象 C：按钮出来了，点击后一直转圈或报错

说明扩展本身是好的，但反推失败。按照错误信息排查：

### 错误：服务器未启动 / connection refused

**原因**：Python 后端没运行。

**解决**：
```bash
cd F:\workbuddycoding\deliverables\prompt-reverse-extension\server
C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pip install -r requirements.txt
C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe app.py
```

看到 `Running on http://127.0.0.1:5000` 即启动成功。

### 错误：canvas 数据无效 / SecurityError

说明图片跨域，扩展会自动降级到「通过 service worker 代理下载图片」，无需处理。

### 错误：401 Unauthorized / API Key 无效

在扩展图标 → 设置里填入正确的 API Key。

### 错误：该模型不支持图像输入

代码会在后台自动切换视觉版本（豆包 → doubao-vision-pro 等）。如果仍然报错，在设置里手动勾选带 "VL/视觉/Vision" 后缀的模型。

---

## 终极排查：完全重装

如果以上都无效：

1. `chrome://extensions/` → 移除「提示词反推」
2. 删除扩展目录（整个 `prompt-reverse-extension/` 文件夹）
3. 重新解压/复制
4. `chrome://extensions/` → 打开「开发者模式」→ 加载已解压的扩展程序 → 选择 `prompt-reverse-extension/` 目录
5. **重要**：刷新所有网页
6. 打开测试页面 `prompt-reverse-extension/test-page.html` 验证

---

## 自诊断脚本

打开任意网页，按 F12，在 Console 粘贴运行：

```javascript
// 自检扩展是否生效
console.log('--- 自检 ---');
console.log('1. window.PR_CONFIG:', typeof window.PR_CONFIG);
console.log('2. window.__PR_EXT_LOADED__:', window.__PR_EXT_LOADED__);
console.log('3. 当前页面图片数:', document.images.length);
console.log('4. 最大图片:', Array.from(document.images).reduce((max, img) => 
  img.naturalWidth * img.naturalHeight > (max?.naturalWidth * max?.naturalHeight || 0) ? img : max, null)?.src);
```

期望输出：
1. `object` ✅
2. `true` ✅
3. 大于 0
4. 有 URL ✅

如果 1 或 2 不符合预期 → 扩展未生效，请按"完全重装"步骤操作。
