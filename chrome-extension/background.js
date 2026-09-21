/**
 * background service worker（MV3）
 * 职责：注册右键菜单 → 提取提示词 → 写 staging 清单（图片 + json）到下载目录。
 *
 * staging 桥接协议（桌面应用监听同一目录入库）：
 *   下载目录/PromptVault-staging/{uuid}.png  原图
 *   下载目录/PromptVault-staging/{uuid}.json 清单（含 prompt 与元数据）
 */
const STAGING_DIR = "PromptVault-staging";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "save-prompt",
      title: "保存到阿男帮你推",
      contexts: ["image"]
    });
    chrome.contextMenus.create({ id: "send-to-canvas", title: "发送图片到阿男帮你推画布", contexts: ["image"] });
  });
});

/* 点击右键菜单 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "send-to-canvas") {
    const imageDataUrl = await fetchImageDataUrl(info.srcUrl || "");
    if (!imageDataUrl) { setBadge("!"); return; }
    const sourceUrl = info.linkUrl || await resolveImagePageUrl(tab && tab.id, info.srcUrl) || (tab && tab.url ? tab.url : "");
    try {
      const response = await fetch("http://127.0.0.1:47777/api/canvas-import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: crypto.randomUUID(), imageDataUrl, prompt: "", model: "", templateId: "", templateLabel: "", sourceUrl, createdAt: Date.now() })
      });
      setBadge(response.ok ? "✓" : "!");
    } catch (_) { setBadge("!"); }
    return;
  }
  if (info.menuItemId !== "save-prompt") return;
  const srcUrl = info.srcUrl || "";

  // 1. 尝试从页面自动提取提示词
  const page = await tryExtractPrompt(tab && tab.id);
  if (page && page.prompt) {
    await writeStaging({
      srcUrl,
      pageUrl: tab && tab.url ? tab.url : "",
      prompt: page.prompt,
      negativePrompt: page.negativePrompt || "",
      params: page.params || {},
      sourceTool: page.sourceTool || "手动"
    });
    setBadge("✓");
    return;
  }

  // 2. 未识别到 → 打开手动保存小窗
  chrome.storage.local.set({ pendingSave: { srcUrl, pageUrl: tab && tab.url ? tab.url : "" } });
  chrome.windows.create({
    url: chrome.runtime.getURL("save.html"),
    type: "popup",
    width: 520,
    height: 660
  });
});

async function resolveImagePageUrl(tabId, imageUrl) {
  if (!tabId || !imageUrl) return "";
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "PV_GET_IMAGE_SOURCE_URL", imageUrl });
    return result && /^https?:\/\//i.test(result.url || "") ? result.url : "";
  } catch (_) { return ""; }
}

async function tryExtractPrompt(tabId) {
  if (!tabId) return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PV_GET_PROMPT" });
    return res && res.prompt ? res : null;
  } catch (e) {
    return null; // 页面不响应（如 PDF、商店页等）
  }
}

/** 写入 staging：图片三重兜底（content fetch → background 跨域 fetch → URL 直下）；
 *  imageFile 扩展名按真实 content-type 推（webp/jpg/png），避免 ingest 用错误名找不到图 */
async function writeStaging({ srcUrl, imageDataUrl, pageUrl, prompt, negativePrompt, params, sourceTool }) {
  const id = crypto.randomUUID();

  // 图片下载（不立即写 manifest，先确定 content-type）
  let finalImageUrl = imageDataUrl || "";
  if (!finalImageUrl && srcUrl) finalImageUrl = await fetchImageDataUrl(srcUrl);
  let imageSaved = false;
  let contentType = "image/png";
  if (finalImageUrl) {
    const m = finalImageUrl.match(/^data:([^;]+);/);
    if (m) contentType = m[1];
    imageSaved = await downloadToVerified(`${STAGING_DIR}/${id}.png`, finalImageUrl);
  } else if (srcUrl) {
    // 先 HEAD 拿 content-type（部分 CDN 的图片直链是 webp）
    try {
      const head = await fetch(srcUrl, { method: "HEAD", redirect: "follow" });
      const ct = head.headers.get("content-type");
      if (ct) contentType = ct.split(";")[0].trim();
    } catch (_) {}
    imageSaved = await downloadToVerified(`${STAGING_DIR}/${id}.png`, srcUrl);
  }
  // 真实扩展名（如果 downloads.download 实际写入的是 webp 但 manifest 写 .png，ingest 找不到）
  // 下载保存的文件名固定是 .png（chromium 不允许自定义下载扩展名），所以这里按 content-type
  // 在 manifest 里写正确扩展名，ingest 兼容查找
  const ext = contentType.includes("webp") ? "webp"
            : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg"
            : contentType.includes("gif") ? "gif"
            : "png";

  const manifest = {
    id,
    prompt: prompt || "",
    negativePrompt: negativePrompt || "",
    sourceTool: sourceTool || "手动",
    category: "",
    tags: [],
    // 无图卡片必须明确写空，否则桌面端会一直等待一个不存在的图片文件。
    imageFile: imageSaved ? `${id}.${ext}` : "",
    params: params || {},
    pageUrl: pageUrl || "",
    createdAt: new Date().toISOString(),
    version: 1
  };

  const dataUrl = "data:application/json;base64," + btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
  const manifestSaved = await downloadToVerified(`${STAGING_DIR}/${id}.json`, dataUrl);
  // Chrome downloads API 不能把临时下载文件原子 rename；用 ready 提交标记
  // 实现消费者侧的原子提交：桌面端只处理同时存在的 .json + .ready。
  const readyUrl = "data:text/plain;base64," + btoa(id);
  const readySaved = manifestSaved && await downloadToVerified(`${STAGING_DIR}/${id}.ready.txt`, readyUrl);
  return { id, imageSaved, manifestSaved, readySaved };
}

/** background 跨域 fetch 转 dataURL（service worker 拥有 <all_urls> host_permissions，
 *  fetch 不受 Referer/CORS 限制，可绕过多数 CDN 防盗链）。双策略重试，避开 referer/cookie 防盗链。 */
async function fetchImageDataUrl(url) {
  const opts = [
    { redirect: "follow", credentials: "omit",    headers: { "Accept": "image/*,*/*" } },
    { redirect: "follow", credentials: "include", headers: { "Accept": "image/*,*/*" } }
  ];
  for (const o of opts) {
    try {
      const res = await fetch(url, o);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "image/png";
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 200) continue; // 太小的可能是错误页/占位图
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return `data:${ct};base64,${btoa(bin)}`;
    } catch (e) { /* try next */ }
  }
  return null;
}

/**
 * 下载封装（带真实落盘校验）：downloads.download 的 callback 只在 API 层失败时
 * 报 lastError，网络错误/防盗链会"创建下载但下载失败"，因此额外监听 onChanged：
 * state=complete → 成功；interrupted / error → 失败；30 秒超时 → 失败。
 */
function downloadToVerified(filename, url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id === undefined) return finish(false);
        const onChanged = (delta) => {
          if (delta.id !== id) return;
          if (delta.state && delta.state.current === "complete") finish(true);
          else if (delta.state && delta.state.current === "interrupted") finish(false);
          else if (delta.error) finish(false);
        };
        chrome.downloads.onChanged.addListener(onChanged);
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          finish(false);
        }, 30000);
      });
    } catch (e) { finish(false); }
  });
}

/* 手动保存窗口回传 + 浮动菜单保存（方案 A） */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "PV_MANUAL_SAVE") {
    writeStaging(msg.payload).then((result) => {
      setBadge("✓");
      sendResponse({ ok: !!result.manifestSaved && !!result.readySaved, imageSaved: !!result.imageSaved });
    });
    return true; // async response
  }
  if (msg && msg.type === "PV_SAVE_FROM_CONTEXT") {
    const p = msg.payload || {};
    (async () => {
      // 提示词缺失时，尝试再向页面提取一次（浮动菜单可能没识别到）
      let prompt = p.prompt || "";
      let negative = p.negativePrompt || "";
      let params = p.params || {};
      let tool = p.sourceTool || "手动";
      if (!prompt && sender && sender.tab) {
        const page = await tryExtractPrompt(sender.tab.id);
        if (page && page.prompt) {
          prompt = page.prompt;
          negative = page.negativePrompt || "";
          params = page.params || {};
          tool = page.sourceTool || tool;
        }
      }
      const result = await writeStaging({
        srcUrl: p.imageUrl || "",
        imageDataUrl: p.imageDataUrl || "",
        pageUrl: p.pageUrl || (sender.tab ? sender.tab.url : ""),
        prompt,
        negativePrompt: negative,
        params,
        sourceTool: tool
      });
      setBadge("✓");
      sendResponse({
        ok: true,
        promptFound: !!prompt,
        imageSaved: !!result.imageSaved,
        cardId: result.id
      });
    })();
    return true; // async response
  }
  if (msg && msg.type === "PV_OPEN_MANUAL") {
    chrome.storage.local.set({ pendingSave: { srcUrl: "", pageUrl: "" } });
    chrome.windows.create({
      url: chrome.runtime.getURL("save.html"),
      type: "popup",
      width: 520,
      height: 660
    });
    sendResponse({ ok: true });
    return true;
  }
});

function setBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: "#3370ff" });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}
