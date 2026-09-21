/**
 * 手动保存窗口逻辑：读取待保存信息 → 用户补充 → 回传后台写 staging。
 */
(async () => {
  const pending = await chrome.storage.local.get("pendingSave");
  const info = (pending && pending.pendingSave) || {};

  // 展示图片预览（同源策略下可能无法显示，属于预期；图片仍会由后台下载）
  if (info.srcUrl) {
    const img = document.createElement("img");
    img.src = info.srcUrl;
    img.onload = () => {
      const thumb = document.getElementById("thumb");
      thumb.innerHTML = "";
      thumb.appendChild(img);
    };
  } else {
    document.getElementById("tip").style.display = "block";
  }

  // 预填扫描/右键已识别到的内容（扫描页面点选保存时会带 prompt / source / category）
  if (info.prompt) document.getElementById("prompt").value = info.prompt;
  if (info.negativePrompt) document.getElementById("negative").value = info.negativePrompt;
  if (info.sourceTool) document.getElementById("source").value = info.sourceTool;
  if (info.category) document.getElementById("category").value = info.category;

  document.getElementById("cancel").addEventListener("click", () => window.close());
  document.getElementById("save").addEventListener("click", async () => {
    const prompt = document.getElementById("prompt").value.trim();
    if (!prompt) {
      document.getElementById("prompt").focus();
      return;
    }
    const payload = {
      srcUrl: info.srcUrl || "",
      pageUrl: info.pageUrl || "",
      prompt,
      negativePrompt: document.getElementById("negative").value.trim(),
      sourceTool: document.getElementById("source").value.trim() || "手动",
      category: document.getElementById("category").value.trim(),
      tags: [],
      params: {}
    };
    const res = await chrome.runtime.sendMessage({ type: "PV_MANUAL_SAVE", payload });
    if (res && res.ok) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#1d9e75;font-size:14px;font-weight:500">已保存 ✓<div style="font-size:12px;color:#8f959e;margin-top:8px">清单已写入 PromptVault-staging，桌面应用将自动入库</div></div>';
      setTimeout(() => window.close(), 1200);
    }
  });
})();
