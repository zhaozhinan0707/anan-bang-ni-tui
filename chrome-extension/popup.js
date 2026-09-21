/**
 * popup 逻辑：扫描当前页面图片 → 网格点选 → 打开保存窗口（预填提示词）。
 * 另提供「右键接管」开关（默认关，避免与网站原生右键冲突）。
 */
(async () => {
  const scanBtn = document.getElementById("scanBtn");
  const grid = document.getElementById("grid");
  const status = document.getElementById("status");
  const switchEl = document.getElementById("rightclickSwitch");

  // 恢复右键接管开关状态
  const { pv_rightclick_enabled } = await chrome.storage.local.get("pv_rightclick_enabled");
  switchEl.classList.toggle("on", !!pv_rightclick_enabled);

  switchEl.addEventListener("click", async () => {
    const on = !switchEl.classList.contains("on");
    switchEl.classList.toggle("on", on);
    await chrome.storage.local.set({ pv_rightclick_enabled: on });
    // 通知当前页面 content script 绑定/解绑右键接管
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "PV_SET_RIGHTCLICK", enabled: on });
      } catch (_) {}
    }
    status.textContent = on
      ? "右键接管已开启：在图片上右键会弹出「保存到提示词收藏夹」菜单（会覆盖网站原生右键）"
      : "右键接管已关闭：不影响网站原生右键，需要时点「扫描当前页面图片」保存。";
  });

  // 手动添加提示词（打开保存窗口）
  document.getElementById("manual").addEventListener("click", () => {
    chrome.storage.local.set({ pendingSave: { srcUrl: "", pageUrl: "" } });
    chrome.windows.create({
      url: chrome.runtime.getURL("save.html"),
      type: "popup",
      width: 520,
      height: 660
    });
    window.close();
  });

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = "正在扫描…";
    grid.innerHTML = "";
    status.textContent = "正在读取当前页面图片…";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      status.textContent = "无法获取当前标签页，请刷新页面后重试。";
      scanBtn.disabled = false; scanBtn.textContent = "🔍 扫描当前页面图片";
      return;
    }
    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "PV_SCAN_PAGE_IMAGES" });
    } catch (_) {
      // content script 未注入（如新开的 about:blank / 商店页）
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["matchers.js", "content.js"]
        });
        res = await chrome.tabs.sendMessage(tab.id, { type: "PV_SCAN_PAGE_IMAGES" });
      } catch (e2) {
        status.textContent = "无法访问当前页面（浏览器限制）。请刷新页面后重试。";
      }
    }

    scanBtn.disabled = false;
    scanBtn.textContent = "🔍 扫描当前页面图片";

    if (!res || !res.ok || !res.images || !res.images.length) {
      status.textContent = "没有扫描到图片。请确认当前页面有图片，或刷新页面后重试。";
      grid.innerHTML = '<div class="empty">未找到图片</div>';
      return;
    }

    const imgs = res.images;
    status.textContent = `扫描到 ${imgs.length} 张图片，点击要保存的图：`;
    grid.innerHTML = "";
    imgs.forEach((it, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.title = (it.prompt || it.alt || it.url || "").slice(0, 120);
      cell.innerHTML = `<img loading="lazy" src="${it.thumb}" alt="" onerror="this.style.visibility='hidden'">
        ${it.prompt ? '<span class="dot" title="已识别到提示词"></span>' : ""}
        ${it.prompt ? `<span class="tag">${it.prompt.slice(0, 18)}</span>` : ""}`;
      cell.addEventListener("click", async () => {
        // 点选：把该图信息交给保存窗口（预填识别到的提示词）
        await chrome.storage.local.set({
          pendingSave: {
            srcUrl: it.url,
            pageUrl: res.pageUrl || (tab && tab.url) || "",
            prompt: it.prompt || "",
            negativePrompt: "",
            sourceTool: it.sourceTool || "手动",
            category: ""
          }
        });
        chrome.windows.create({
          url: chrome.runtime.getURL("save.html"),
          type: "popup",
          width: 520,
          height: 660
        });
        window.close();
      });
      grid.appendChild(cell);
    });
  });
})();
