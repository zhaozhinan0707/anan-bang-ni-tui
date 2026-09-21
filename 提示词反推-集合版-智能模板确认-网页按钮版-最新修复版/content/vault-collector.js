/**
 * content script（方案 A：捕获阶段接管右键 + 浮动菜单）
 *
 * 背景：Lovart / 哩布哩布等站点在图片上 preventDefault() 屏蔽了浏览器原生右键
 * 菜单，导致扩展注册的 chrome.contextMenus 项无法显示。因此这里在 document
 * 捕获阶段（先于页面一切 handler）接管 contextmenu 事件，注入自定义浮动菜单
 * （closed Shadow DOM 隔离样式），保证任何屏蔽下都能弹出「保存到阿男帮你推」。
 */
(() => {
  if (window.__PROMPT_VAULT_CONTENT__) return; // 防重复注入
  window.__PROMPT_VAULT_CONTENT__ = true;

  let menuHost = null;   // 右键菜单
  let toastHost = null;  // 保存成功提示

  /* ══════════ 右键接管（capture 阶段，默认关闭，popup 可开关） ══════════ */

  // 默认不劫持右键：与网站原生右键保存不冲突；仅当用户开启「右键接管」时
  // 才拦截（用于哩布哩布 / Lovart 等屏蔽原生右键的站点）。
  chrome.storage.local.get("pv_rightclick_enabled", ({ pv_rightclick_enabled }) => {
    if (pv_rightclick_enabled) enableRightclickCapture();
  });

  function enableRightclickCapture() {
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("click", () => closeMenu(), false);
    window.addEventListener("scroll", () => closeMenu(), true);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, true);
  }
  function onContextMenu(e) {
    const img = findImageTarget(e);
    if (!img) return; // 非图片右键：放行原生菜单
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, img);
  }

  function closeMenu() {
    if (menuHost) { menuHost.remove(); menuHost = null; }
  }

  /* ══════════ 目标识别：图片 / 背景图容器 ══════════ */

  function findImageTarget(e) {
    let t = e.target;
    if (t instanceof HTMLImageElement) return t;
    if (t && t.closest) {
      const img = t.closest("img");
      if (img) return img;
    }
    // 背景图容器（CSS background-image）
    let el = t;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      if (el && el.style && /url\(/.test(el.style.backgroundImage || "")) return el;
    }
    return null;
  }

  /** 提取图片真实 URL：AI 绘画站点常用懒加载（data-src / data-original / data-url），
 *  此时 src/currentSrc 还是占位图，所以必须先查懒加载属性 + srcset 选最大尺寸 */
  function imageUrlOf(img) {
    if (img.tagName === "IMG") {
      const candidates = [
        img.getAttribute("data-src"),
        img.getAttribute("data-original"),
        img.getAttribute("data-url"),
        img.getAttribute("data-image"),
        img.getAttribute("data-lazy-src"),
        img.getAttribute("data-actualsrc"),
        img.currentSrc,
        img.src
      ].filter(Boolean);
      // srcset 选分辨率最大的真实 URL（避免拿到缩略图）
      if (img.srcset) {
        const sources = [...img.srcset.matchAll(/(\S+)\s+(\d+)w/g)].map(m => ({ url: m[1], w: parseInt(m[2]) }));
        if (sources.length) candidates.push(sources.sort((a, b) => b.w - a.w)[0].url);
      }
      // 排除明显占位（data:base64 / blob: / 1x1 像素）
      return candidates.find(u => u && /^https?:/.test(u) && !/data:|blob:|placeholder/i.test(u)) || "";
    }
    const m = (img.style && img.style.backgroundImage || "").match(/url\(["']?([^"')]+)["']?\)/);
    if (m && m[1]) return m[1];
    return "";
  }

  /* ══════════ 提示词提取：图片附近优先 → 全局 matcher 兜底 ══════════ */

  /** 全局 matcher 兜底（依赖 matchers.js 的 PROMPT_MATCHERS 全局变量） */
  function extractPrompt() {
    for (const matcher of PROMPT_MATCHERS) {
      try {
        const r = matcher.extract();
        if (r && r.prompt) {
          return {
            prompt: r.prompt,
            negativePrompt: r.negativePrompt || "",
            params: r.params || {},
            sourceTool: r.sourceTool || matcher.name
          };
        }
      } catch (e) {
        console.warn("[PromptVault] matcher failed:", matcher.name, e);
      }
    }
    return null;
  }

  async function collectFor(img) {
    const imgUrl = imageUrlOf(img);
    const nearby = extractPromptNearImage(img);
    const global = extractPrompt();
    const hit = nearby || global;
    return {
      imageUrl: imgUrl,
      prompt: hit ? hit.prompt : "",
      negativePrompt: hit ? hit.negativePrompt || "" : "",
      params: hit ? hit.params || {} : {},
      sourceTool: hit ? hit.sourceTool || "" : detectSource(),
      pageUrl: location.href
    };
  }

  /** 从图片向上找最近容器内的提示词（哩布哩布/ Lovart 生成图旁通常有提示词区块） */
  function extractPromptNearImage(img) {
    // 0) img 自身属性（alt / title / aria-label），很多站点把提示词放在这里
    for (const attr of ["alt", "title", "aria-label"]) {
      const t = (img.getAttribute(attr) || "").trim();
      if (t && t.length >= 8 && t.length < 4000 && isPromptLike(t)) {
        return { prompt: t, sourceTool: detectSource() };
      }
    }
    // 0.5) 页面上 textarea / contenteditable 的 value（生成器的提示词输入框）
    const ta = findPageTextareaPrompt();
    if (ta) return { prompt: ta, sourceTool: detectSource() };
    let el = img;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      // 1) 容器内找 prompt 相关子元素
      const found = findPromptChild(el);
      if (found) return found;
      // 2) 容器自身文本（短文本，避免抓到大段正文）
      const txt = (el.textContent || "").trim();
      if (txt.length > 8 && txt.length < 600 && isPromptLike(txt)) {
        return { prompt: txt, sourceTool: detectSource() };
      }
    }
    return null;
  }

  function findPromptChild(container) {
    const selectors = [
      "[data-prompt]", "[data-prompt-text]", "[class*='prompt']", "[class*='Prompt']",
      "[class*='prompt-text']", "textarea", "code", "pre"
    ];
    for (const sel of selectors) {
      const els = container.querySelectorAll(sel);
      for (const el of Array.from(els).slice(0, 5)) {
        const text = (el.value !== undefined ? el.value : el.textContent || "").trim();
        if (text && text.length > 8 && text.length < 4000 && isPromptLike(text)) {
          return { prompt: text, sourceTool: detectSource() };
        }
      }
    }
    return null;
  }

  function detectSource() {
    const h = location.hostname;
    if (/liblib/i.test(h)) return "哩布哩布";
    if (/lovart/i.test(h)) return "Lovart";
    if (/huaban/i.test(h) || /hb\.aicdn/i.test(h)) return "花瓣网";
    if (/pinterest/i.test(h) || /pinimg/i.test(h)) return "Pinterest";
    return "手动";
  }

  /** 在页面 textarea / contenteditable / prompt 输入框里找提示词（生成器的输入面板） */
  function findPageTextareaPrompt() {
    // 1) 优先找明显的提示词输入框（textarea / input）
    const textareas = document.querySelectorAll('textarea, input[type="text"]');
    for (const el of textareas) {
      const val = (el.value !== undefined ? el.value : el.textContent || "").trim();
      if (val && val.length >= 8 && val.length < 4000 && isPromptLike(val)) return val;
    }
    // 2) contenteditable 富文本编辑器（哩布哩布生成器可能用 div + contenteditable）
    const editables = document.querySelectorAll('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    for (const el of editables) {
      const val = (el.textContent || "").trim();
      if (val && val.length >= 8 && val.length < 4000 && isPromptLike(val)) return val;
    }
    // 3) 找"提示词"小标题紧邻的文本容器（哩布哩布/Lovart 详情面板结构：标题 + 文本 + 复制按钮）
    const headerHits = findByHeaderPrompt();
    if (headerHits) return headerHits;
    // 4) 兜底：页面上唯一的最像 prompt 的文本节点（避开导航/footer/按钮）
    const main = document.querySelector("main, [role='main'], .container, #app") || document.body;
    const candidates = Array.from(main.querySelectorAll("p, div, span"))
      .filter(el => !el.querySelector("*"))  // 叶子节点
      .filter(el => el.offsetParent !== null) // 可见
      .map(el => (el.textContent || "").trim())
      .filter(t => t.length >= 8 && t.length < 4000 && isPromptLike(t));
    // 取最长的（通常最详细的就是 prompt）
    if (candidates.length) candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || null;
  }

  /** 找「提示词/Prompt」标题后紧邻的文本节点（AI 站点通用结构：详情面板的标题 + 文本 + 复制按钮） */
  function findByHeaderPrompt() {
    const headerRe = /^(提示词|Prompt|PROMPT|正向提示词|Prompt Text|Positive Prompt)$/i;
    const candidates = document.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, span, div, p, label");
    for (const h of candidates) {
      // 跳过深嵌套（textContent 会含很多内容，限定自身文本短）
      const direct = Array.from(h.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("").trim();
      if (!direct || direct.length > 30 || !headerRe.test(direct)) continue;
      // 候选 1：下一个兄弟元素
      let sib = h.nextElementSibling;
      while (sib) {
        const v = (sib.textContent || "").trim();
        if (v && v.length >= 8 && v.length < 4000 && isPromptLike(v)) return v;
        // 兄弟内部最像 prompt 的子元素
        const inner = sib.querySelector("p, div, span");
        if (inner) {
          const iv = (inner.textContent || "").trim();
          if (iv && iv.length >= 8 && iv.length < 4000 && isPromptLike(iv)) return iv;
        }
        sib = sib.nextElementSibling;
      }
      // 候选 2：父元素的下一个兄弟
      const parentNext = h.parentElement && h.parentElement.nextElementSibling;
      if (parentNext) {
        const v = (parentNext.textContent || "").trim();
        if (v && v.length >= 8 && v.length < 4000 && isPromptLike(v)) return v;
      }
    }
    return null;
  }

  /* ══════════ 浮动菜单（closed Shadow DOM） ══════════ */

  function showMenu(x, y, img) {
    closeMenu();
    const payload = collectFor(img); // 先异步收集，菜单先展示

    const host = document.createElement("div");
    host.id = "pv-menu-host";
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pv-menu{position:fixed;min-width:220px;background:#fff;border:1px solid #e6e6f0;
          border-radius:10px;box-shadow:0 12px 32px rgba(30,30,80,.18);padding:6px;
          font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none}
        .pv-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;
          cursor:pointer;color:#2b2b3a;font-weight:500}
        .pv-item:hover{background:#f0edff;color:#5b4ce8}
        .pv-item .ic{width:16px;height:16px;flex:none;border-radius:4px;
          background:linear-gradient(135deg,#6C5CE7,#9B59E8);position:relative}
        .pv-item .ic::after{content:"";position:absolute;inset:4px;border:1.5px solid #fff;
          border-radius:2px}
        .pv-item.sub{font-weight:400;color:#6b6b80;font-size:12px;border-top:1px solid #f0f0f6;
          margin-top:4px;padding-top:9px}
        .pv-hint{padding:6px 10px 2px;color:#9a9ab0;font-size:11px;overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap;max-width:240px}
        .pv-loading{display:flex;align-items:center;gap:8px;padding:8px 10px;color:#5b4ce8}
        .pv-spin{width:14px;height:14px;border:2px solid #d9d4ff;border-top-color:#5b4ce8;
          border-radius:50%;animation:pvspin .8s linear infinite}
        @keyframes pvspin{to{transform:rotate(360deg)}}
      </style>
      <div class="pv-menu" id="menu" style="left:${Math.min(x, innerWidth - 250)}px;top:${Math.min(y, innerHeight - 150)}px">
        <div class="pv-item" data-act="save"><span class="ic"></span>保存到阿男帮你推</div>
        <div class="pv-item sub" data-act="manual">✎ 手动粘贴提示词…</div>
        <div class="pv-hint" id="hint">正在读取提示词…</div>
      </div>`;

    document.body.appendChild(host);
    menuHost = host;

    const itemSave = shadow.querySelector('[data-act="save"]');
    const itemManual = shadow.querySelector('[data-act="manual"]');
    const hint = shadow.querySelector("#hint");

    // 提示词异步收集，成功后更新 hint
    payload.then((p) => {
      hint.textContent = p.prompt
        ? `${p.sourceTool} · 已识别提示词（${p.prompt.length} 字）`
        : `${p.sourceTool} · 未识别到提示词，可手动粘贴`;
    }).catch(() => { hint.textContent = "读取提示词失败，可手动粘贴"; });

    itemSave.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const p = await payload;
      if (!p.imageUrl) { toast("未找到图片地址"); closeMenu(); return; }
      // 自动识别结果先确认，避免把标题或按钮误存为提示词。
      if (p.prompt) {
        const preview = p.prompt.length > 220 ? p.prompt.slice(0, 220) + "…" : p.prompt;
        if (!window.confirm(`已识别到提示词：\n\n${preview}\n\n确认保存？`)) {
          closeMenu();
          chrome.runtime.sendMessage({ type: "PV_OPEN_MANUAL" });
          return;
        }
      }
      // 兜底：页面上下文 fetch 转 dataURL（防 CDN 防盗链）
      try { p.imageDataUrl = await imgToDataUrl(p.imageUrl); } catch (_) { /* 走 background */ }
      closeMenu();
      // 保存中反馈
      showLoadingToast("正在保存到收藏夹…");
      const res = await chrome.runtime.sendMessage({ type: "PV_SAVE_FROM_CONTEXT", payload: p });
      hideToast();
      if (res && res.ok && res.imageSaved) {
        toast(res.promptFound ? "✓ 已保存（提示词 + 图片）" : "✓ 已保存（未识别提示词）");
      } else if (res && res.ok && !res.imageSaved) {
        // ⭐ 图片下载失败 → 进入手动粘贴补图
        showManualPasteHint(p);
      } else {
        toast("保存失败，请重试");
      }
    });

    itemManual.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeMenu();
      chrome.runtime.sendMessage({ type: "PV_OPEN_MANUAL" });
    });
  }

  /** 页面上下文抓图 → dataURL（带 cookie/referer；跨域无 CORS 时抛错走 downloads 直下） */
  async function imgToDataUrl(url) {
    const res = await fetch(url, { credentials: "include", mode: "cors" });
    if (!res.ok) throw new Error("fetch failed " + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ══════════ 手动补图兜底（图片自动下载失败时启动 Ctrl+V 监听） ══════════ */

  let pasteHandler = null;
  function showManualPasteHint(payload) {
    toast("⚠ 自动下载失败 → 在该图右键 → 复制图片 → 然后按 Ctrl+V", 5000);
    if (pasteHandler) document.removeEventListener("paste", pasteHandler, true);
    pasteHandler = async (ev) => {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (!it.type || !it.type.startsWith("image/")) continue;
        const file = it.getAsFile();
        if (!file) continue;
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener("paste", pasteHandler, true);
        pasteHandler = null;
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(file);
        });
        payload.imageDataUrl = dataUrl;
        showLoadingToast("正在补图保存…");
        const res = await chrome.runtime.sendMessage({ type: "PV_SAVE_FROM_CONTEXT", payload });
        hideToast();
        toast(res && res.ok && res.imageSaved ? "✓ 已通过剪贴板补图保存" : "补图失败，请重试");
        break;
      }
    };
    document.addEventListener("paste", pasteHandler, true);
  }

  /* ══════════ 轻量 toast（closed Shadow DOM） ══════════ */

  let toastTimer = null;
  function toast(text) {
    if (toastHost) toastHost.remove();
    const host = document.createElement("div");
    host.id = "pv-toast-host";
    host.style.cssText = "all:initial;position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pv-toast{padding:10px 18px;background:#2b2b3a;color:#fff;border-radius:999px;
          font:13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
          box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:nowrap;animation:pvin .18s ease}
        @keyframes pvin{from{opacity:0;transform:translateY(-6px)}to{opacity:1}}
      </style><div class="pv-toast"></div>`;
    shadow.firstElementChild.textContent = text;
    document.body.appendChild(host);
    toastHost = host;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastHost) toastHost.remove(); toastHost = null; }, 2200);
  }

  function showLoadingToast(text) {
    if (toastHost) toastHost.remove();
    const host = document.createElement("div");
    host.id = "pv-toast-host";
    host.style.cssText = "all:initial;position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pv-toast{display:flex;align-items:center;gap:8px;padding:10px 18px;background:#2b2b3a;
          color:#fff;border-radius:999px;font:13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
          box-shadow:0 8px 24px rgba(0,0,0,.25)}
        .pv-spin{width:13px;height:13px;border:2px solid #777;border-top-color:#fff;border-radius:50%;animation:pvspin .8s linear infinite}
        @keyframes pvspin{to{transform:rotate(360deg)}}
      </style><div class="pv-toast"><span class="pv-spin"></span><span></span></div>`;
    shadow.querySelector("span:last-child").textContent = text;
    document.body.appendChild(host);
    toastHost = host;
  }
  function hideToast() { if (toastHost) { toastHost.remove(); toastHost = null; } }

  /* ══════════ 兼容：响应后台的提示词提取请求（右键原生菜单路径仍可用） ══════════ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "PV_GET_PROMPT") {
      sendResponse(extractPrompt());
      return true;
    }
    if (msg && msg.type === "PV_SCAN_PAGE_IMAGES") {
      sendResponse(scanPageImages());
      return true;
    }
    if (msg && msg.type === "PV_SET_RIGHTCLICK") {
      // popup 开关右键接管：开启 → 立即绑定；关闭 → 移除监听并关闭菜单
      const enabled = !!msg.enabled;
      if (enabled) {
        enableRightclickCapture();
      } else {
        document.removeEventListener("contextmenu", onContextMenu, true);
        closeMenu();
      }
      sendResponse({ ok: true, enabled });
      return true;
    }
    return true;
  });

  /* ══════════ 扫描当前页面所有图片（popup「扫描页面」入口） ══════════ */

  /**
   * 收集页面可见图片：返回 [{ url, thumb, prompt, alt, sourceTool }]。
   * - url：真实大图（懒加载 data-src / srcset 最大）
   * - thumb：缩略图（懒加载小图或 src，无则同 url）
   * - prompt：该图附近提取的提示词/描述（可能为空，用户可在保存窗口编辑）
   * 去重 + 跳过 data:/blob: 占位 + 上限 MAX 张，避免超长卡顿。
   */
  function scanPageImages() {
    const MAX = 150;
    const seen = new Set();
    const out = [];
    // 有些站点把提示词放在页面级侧栏/详情面板，而不是图片节点附近。
    // 先提取一次页面级结果，作为每张图片的兜底，避免扫描结果只有文件名。
    const pagePrompt = extractPrompt();
    // 1) 所有 img（可见性过滤：offsetParent 或 rect 宽高 > 0）
    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      if (out.length >= MAX) break;
      const url = imageUrlOf(img);
      if (!url || !/^https?:/.test(url) || seen.has(url)) continue;
      // 可见性：宽高 > 0
      const r = img.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) continue;
      const nearby = extractPromptNearImage(img);
      seen.add(url);
      out.push({
        url,
        thumb: img.currentSrc && /^https?:/.test(img.currentSrc) ? img.currentSrc : url,
        prompt: nearby ? nearby.prompt : (pagePrompt ? pagePrompt.prompt : ""),
        alt: (img.getAttribute("alt") || img.getAttribute("title") || "").trim(),
        sourceTool: nearby ? (nearby.sourceTool || detectSource()) : (pagePrompt ? (pagePrompt.sourceTool || detectSource()) : detectSource())
      });
    }
    // 2) 常见图片容器内的背景图（Pinterest / 花瓣常用 div background-image）
    if (out.length < MAX) {
      const containers = Array.from(
        document.querySelectorAll('[class*="img"], [class*="Img"], [class*="pin"], [class*="Pin"], [data-test-id*="pin"], [data-test-id*="Pin"]')
      ).slice(0, 300);
      for (const el of containers) {
        if (out.length >= MAX) break;
        const bg = (el.style && el.style.backgroundImage || "").match(/url\(["']?([^"')]+)["']?\)/);
        if (!bg || !bg[1] || !/^https?:/.test(bg[1]) || seen.has(bg[1])) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.height < 12) continue;
        seen.add(bg[1]);
        out.push({
          url: bg[1],
          thumb: bg[1],
          prompt: pagePrompt ? pagePrompt.prompt : "",
          alt: "",
          sourceTool: pagePrompt ? (pagePrompt.sourceTool || detectSource()) : detectSource()
        });
      }
    }
    return { ok: true, count: out.length, images: out, pageUrl: location.href };
  }
})();
