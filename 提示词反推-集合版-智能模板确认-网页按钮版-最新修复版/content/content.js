/**
 * 提示词反推扩展 - Content Script
 * 在页面上注入悬浮按钮和结果面板
 */
(function () {
  'use strict';

  // 防止重复注入
  if (window.__PR_EXT_LOADED__) return;
  window.__PR_EXT_LOADED__ = true;

  // 版本戳（修改此文件时请同步更新，方便用户确认加载到的是哪一版）
  const VERSION = '1.8.0';
  console.log('%c[提示词反推 v' + VERSION + ']%c Content script 注入中...',
    'background:#3B82F6;color:#fff;padding:2px 6px;border-radius:3px;',
    'color:#3B82F6;font-weight:bold;');

  // ============ 全局错误捕获 ============
  // 把任何未捕获错误转为可读日志，避免 Chrome 显示无关键报错
  window.addEventListener('error', (e) => {
    if (e.filename && e.filename.includes('content/content.js')) {
      console.error('[提示词反推] 错误:', e.message, '位于', e.filename + ':' + e.lineno);
    }
  });

  // ============ 内联配置（不依赖外部 config.js） ============
  const DEFAULT_SETTINGS = {
    enabled: true,
    apiKey: '',
    apiBase: '',
    model: 'gpt-4o',
    customModel: '',
    promptTemplate: '请反推这张图片中的人物与自行车、电动自行车或滑板车等车辆的真实场景摄影提示词。重点描述人物动作与姿态、车辆外形与结构、人与车的关系、道路和环境、镜头视角、景别、构图、自然光与阴影、色彩、材质、运动感和真实摄影质感。不要臆测不可见细节，不要改变车辆品牌或结构。输出一段可直接用于图像生成的中文提示词。',
  };

  // 收藏夹配置（与 popup / config.js 保持一致）
  const MAX_FAVORITES = 15;
  const FAV_STORAGE_KEY = 'pr_favorites';
  const TEMPLATE_CONTENTS = {
    human_vehicle: DEFAULT_SETTINGS.promptTemplate,
    blender_3d: '请将图片反推为 Blender/Cycles 或 Eevee 风格的三维产品渲染提示词，描述几何结构、材质、灯光、相机、构图和真实渲染质感。',
    commercial_product: '请将图片反推为商业产品广告提示词，描述产品卖点、场景、构图、镜头、光线、材质、色彩、品牌质感与留白。',
    ecommerce_white: '请反推电商产品摄影提示词，描述产品外形、角度、材质、背景、棚拍光线、接触阴影和商品展示要求。',
    creative_art: '请将图片反推为创意艺术风格提示词，描述主体、艺术风格、媒介质感、构图、色彩、光影和氛围。',
  };

  const MODEL_LABELS = {
    'gpt-4o': 'GPT-4o', 'gpt-4o-mini': 'GPT-4o mini', 'gpt-4-turbo': 'GPT-4 Turbo',
    'o1-preview': 'o1-preview', 'claude-3-5-sonnet': 'Claude 3.5 Sonnet', 'claude-3-opus': 'Claude 3 Opus',
    'gemini-1.5-pro': 'Gemini 1.5 Pro', 'gemini-1.5-flash': 'Gemini 1.5 Flash',
    'doubao-pro-32k': '豆包 Pro 32K', 'doubao-pro-128k': '豆包 Pro 128K', 'doubao-lite-32k': '豆包 Lite 32K',
    'deepseek-chat': 'DeepSeek-V3', 'deepseek-reasoner': 'DeepSeek-R1',
    'qwen-max': '通义千问 Max', 'qwen-plus': '通义千问 Plus', 'wenxin-4': '文心一言 4.0',
    'moonshot-v1-32k': 'Kimi', 'glm-4': 'GLM-4', 'glm-4v': 'GLM-4V 视觉', 'mimo-v2.6-pro': '小米 MiMo-V2.6-Pro 视觉', 'mimo-v2.6-flash': '小米 MiMo-V2.6-Flash 视觉', 'mimo-v2.6-pro-ultraspeed': '小米 MiMo-V2.6-Pro-UltraSpeed 视觉', 'mimo-v2-flash': '小米 MiMo-V2-Flash 视觉（旧版）', 'mimo-v2.5-pro': '小米 MiMo-V2.5-Pro 视觉（旧版）', 'mimo-v2.5': '小米 MiMo-V2.5 视觉（旧版）', 'custom': '自定义模型',
  };

  // ============ 状态管理 ============
  const state = {
    enabled: true,
    apiKey: '',
    apiBase: '',
    model: 'gpt-4o',
    customModel: '',
    promptTemplate: '',
    lastTemplateId: '',
    lastTemplateLabel: '',
    currentImage: null,
    floatingBtn: null,
    overlay: null,
    isProcessing: false,
  };

  // SVG 图标
  const ICONS = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="white"/><circle cx="18" cy="6" r="1.5" fill="white" opacity="0.7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="white" stroke-width="2"/><path d="M5 15V5C5 3.9 5.9 3 7 3H15" stroke="white" stroke-width="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    toastCheck: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#10B981"/><path d="M8 12l3 3l5-5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" fill="none" class="pr-ext-spinner"><circle cx="12" cy="12" r="9" stroke="#E4E4E7" stroke-width="2.5"/><path d="M12 3a9 9 0 019 9" stroke="#3B82F6" stroke-width="2.5" stroke-linecap="round"/></svg>',
    // 书签图标（收藏）—— 描边版（未收藏）
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
    // 书签图标（收藏）—— 实心版（已收藏）
    bookmarkFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
    // 收藏成功 Toast 用的蓝色实心书签
    toastFav: '<svg viewBox="0 0 24 24" fill="none"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" fill="#3B82F6" stroke="#3B82F6" stroke-width="2" stroke-linejoin="round"/></svg>',
  };

  // 鼠标是否在悬浮按钮上
  let mouseOnBtn = false;
  // 隐藏按钮的延时定时器
  let hideTimer = null;

  // ============ 初始化 ============
  function init() {
    console.log('[提示词反推] Content script 已加载，正在初始化...');
    try {
      loadSettings();
      chrome.storage.onChanged.addListener(onSettingsChanged);
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mouseout', onMouseOut, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('resize', onScrollOrResize, true);

      // 接收来自 service worker 的消息（右键菜单触发）
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'trigger_reverse' && message.imageUrl) {
          handleTriggerReverse(message.imageUrl);
          sendResponse({ success: true });
        }
        return false; // 同步响应
      });

      // 醒目地告诉用户：扩展已生效
      console.log(
        '%c[提示词反推] ✅ 初始化成功 (v' + VERSION + ')' +
        '%c\n   · 把鼠标悬停在网页中任意 ≥80×80 的图片上，即可看到 ✨反推提示词 按钮' +
        '\n   · 点击扩展图标可配置 AI 模型、API Key、提示词模板' +
        '\n   · 当前页面: ' + (location.host || 'unknown'),
        'background:#10B981;color:#fff;padding:3px 8px;border-radius:3px;font-weight:bold;',
        'color:#374151;'
      );

      // 页面右下角显示可视化加载提示（3秒后消失）
      showLoadedBadge();
    } catch (err) {
      console.error('[提示词反推] ❌ 初始化失败:', err && err.message || err);
    }
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      chrome.storage.local.get(['apiKey', 'promptTemplate'], (localItems) => {
      state.enabled = items.enabled;
      state.apiKey = localItems.apiKey || items.apiKey || '';
      state.apiBase = items.apiBase;
      state.model = items.model;
      state.customModel = items.customModel;
      state.promptTemplate = localItems.promptTemplate || items.promptTemplate;
      });
    });
  }

  function onSettingsChanged(changes) {
    for (const [key, change] of Object.entries(changes)) {
      if (key in state) state[key] = change.newValue;
    }
    if (changes.enabled && !changes.enabled.newValue) {
      hideFloatingBtn();
      closeOverlay();
    }
  }

  // ============ 图片悬停检测 ============
  function onMouseOver(e) {
    if (!state.enabled || state.isProcessing) return;
    const img = e.target;

    // 检测 IMG 元素
    if (!isImageElement(img)) return;

    // 太小的图片不显示按钮
    if (img.offsetWidth < 80 || img.offsetHeight < 80) return;

    // 取消之前的隐藏定时器
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    state.currentImage = img;
    showFloatingBtn(img);
  }

  function onMouseOut(e) {
    const img = e.target;
    if (!isImageElement(img)) return;

    // 检查是否移到了悬浮按钮上
    const related = e.relatedTarget;
    if (related && state.floatingBtn && state.floatingBtn.contains(related)) return;

    if (state.currentImage === img) {
      // 延迟隐藏，给鼠标移到按钮上的时间
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!mouseOnBtn) hideFloatingBtn();
      }, 200);
    }
  }

  function onScrollOrResize() {
    if (state.overlay) return; // 有面板时不隐藏按钮位置
    hideFloatingBtn();
  }

  function isImageElement(el) {
    return el && el.tagName === 'IMG' && el.src && !el.src.startsWith('chrome-extension://');
  }

  // ============ 悬浮按钮 ============
  function showFloatingBtn(img) {
    hideFloatingBtn();
    const rect = img.getBoundingClientRect();

    const btn = document.createElement('div');
    btn.className = 'pr-ext-float-btn';
    btn.innerHTML = ICONS.sparkle + '<span>反推提示词</span>';

    // 使用 position: fixed + 视口坐标，避免被网站 body 的定位上下文影响
    const btnWidth = 130;
    const btnHeight = 36;
    const offset = 8;

    let top = rect.top - btnHeight - offset;
    let left = rect.right - btnWidth;

    // 如果图片顶部空间不够，按钮放在图片内部右上角
    if (top < 4) {
      top = rect.top + offset;
      left = rect.right - btnWidth - offset;
    }

    // 确保不超出右边界
    if (left + btnWidth > window.innerWidth - 4) {
      left = window.innerWidth - btnWidth - 4;
    }
    // 确保不超出左边界
    if (left < 4) {
      left = 4;
    }

    btn.style.top = top + 'px';
    btn.style.left = left + 'px';

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      hideFloatingBtn();
      handleReverse(img);
    });

    // 追踪鼠标是否在按钮上
    btn.addEventListener('mouseenter', () => {
      mouseOnBtn = true;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    btn.addEventListener('mouseleave', () => {
      mouseOnBtn = false;
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideFloatingBtn();
      }, 150);
    });

    document.body.appendChild(btn);
    state.floatingBtn = btn;

    // 延迟显示动画
    requestAnimationFrame(() => {
      btn.classList.add('pr-ext-visible');
    });
  }

  function hideFloatingBtn() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (state.floatingBtn && state.floatingBtn.parentNode) {
      state.floatingBtn.parentNode.removeChild(state.floatingBtn);
    }
    state.floatingBtn = null;
    state.currentImage = null;
    mouseOnBtn = false;
  }

  // ============ 处理反推 ============
  // 右键菜单触发：根据 imageUrl 找到页面上对应的 img 元素
  function handleTriggerReverse(imageUrl) {
    if (state.isProcessing) return;

    // 在页面上查找 src 匹配的图片
    const imgs = document.querySelectorAll('img');
    let targetImg = null;
    for (const img of imgs) {
      if (img.src === imageUrl) {
        targetImg = img;
        break;
      }
    }

    if (!targetImg) {
      showOverlay('error', '未在页面上找到对应的图片，请尝试用悬浮按钮反推');
      return;
    }

    handleReverse(targetImg);
  }

  async function handleReverse(img) {
    if (state.isProcessing) return;
    state.isProcessing = true;

    showOverlay('loading');

    try {
      // 获取图片 base64
      const imageData = await getImageBase64(img);
      const settings = {
        apiKey: state.apiKey,
        apiBase: state.apiBase,
        model: state.model,
        customModel: state.customModel,
        promptTemplate: state.promptTemplate,
      };
      const templateStorage = await new Promise((resolve) => chrome.storage.local.get(['pr_hidden_templates'], resolve));
      const allTemplateIds = ['human_vehicle', 'blender_3d', 'commercial_product', 'ecommerce_white', 'creative_art'];
      const customTemplateStorage = await new Promise((resolve) => chrome.storage.local.get(['pr_custom_templates'], resolve));
      const customTemplates = Array.isArray(customTemplateStorage.pr_custom_templates) ? customTemplateStorage.pr_custom_templates.filter((item) => item && item.id && item.label) : [];
      const templateCatalog = [...customTemplates.map((item) => ({ id: item.id, label: item.label })), ...allTemplateIds.map((id) => ({ id, label: ({ human_vehicle: '人车真实场景摄影', blender_3d: 'Blender 三维产品渲染', commercial_product: '商业产品广告', ecommerce_white: '电商白底产品图', creative_art: '创意艺术风格' })[id] }))];
      settings.templateCatalog = templateCatalog;
      settings.availableTemplateIds = templateCatalog.map((item) => item.id).filter((id) => !(templateStorage.pr_hidden_templates || []).includes(id));

      // 先识别模板，用户确认后才正式反推。
      const classify = await sendToBackground({
        action: 'classify_template',
        settings,
        image: { base64: imageData.base64, mimeType: imageData.mimeType, imageUrl: imageData.imageUrl || img.src },
      });
      if (!classify.success) throw new Error(classify.error || '模板识别失败');
      const labels = Object.fromEntries(templateCatalog.map((item) => [item.id, item.label]));
      const storage = templateStorage;
      const hiddenTemplates = Array.isArray(storage.pr_hidden_templates) ? storage.pr_hidden_templates : [];
      const templateIds = templateCatalog.map((item) => item.id).filter((id) => !hiddenTemplates.includes(id));
      if (!templateIds.length) throw new Error('没有可用的提示词模板，请在插件设置中恢复至少一个模板');
      const options = templateIds.map((id, index) => `${index + 1}. ${labels[id]}${id === classify.data.template ? '（模型推荐）' : ''}`).join('\n');
      const recommendedName = labels[classify.data.template] || classify.data.template;
      let selectedIndex = templateIds.indexOf(classify.data.template);
      if (selectedIndex < 0) selectedIndex = 0;
      const accepted = window.confirm(`模型判断本图片适合使用：${recommendedName}\n置信度：${Math.round((classify.data.confidence || 0) * 100)}%\n理由：${classify.data.reason || '模型未提供'}\n\n是否使用此模板？`);
      if (!accepted) {
        const answer = window.prompt(`请选择本次反推使用的模板（输入编号）：\n\n${options}`, String(selectedIndex + 1));
        selectedIndex = Number.parseInt(answer, 10) - 1;
      }
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= templateIds.length) { closeOverlay(); return; }
      // 设置页会把每个模板当前编辑内容保存到 local 的模板映射；网页按钮此前只读取
      // 内置默认内容，导致用户保存的人车模板被覆盖。这里优先读取对应模板的保存内容。
      const templateId = templateIds[selectedIndex];
      state.lastTemplateId = templateId;
      state.lastTemplateLabel = labels[templateId] || templateId;
      const savedTemplateStorage = await new Promise((resolve) => chrome.storage.local.get(['pr_prompt_template_map'], resolve));
      const savedTemplate = savedTemplateStorage.pr_prompt_template_map && savedTemplateStorage.pr_prompt_template_map[templateId];
      const selectedTemplate = savedTemplate || TEMPLATE_CONTENTS[templateId] || state.promptTemplate;

      // 发送到 service worker
      const result = await sendToBackground({
        action: 'reverse',
        imageBase64: imageData.base64,
        mimeType: imageData.mimeType,
        imageUrl: img.src,
        settings: { ...settings, promptTemplate: selectedTemplate },
      });

      if (result.success) {
        chrome.storage.local.get(['pr_reverse_history'], (items) => {
          const history = Array.isArray(items.pr_reverse_history) ? items.pr_reverse_history : [];
          history.push({ id: `history_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, prompt: result.data.prompt || '', createdAt: Date.now(), imageUrl: img.src });
          chrome.storage.local.set({ pr_reverse_history: history.filter((_, index) => index >= Math.max(0, history.length - 15)) });
        });
        showOverlay('result', result.data, img);
      } else {
        showOverlay('error', result.error);
      }
    } catch (err) {
      showOverlay('error', err.message || '未知错误');
    } finally {
      state.isProcessing = false;
    }
  }

  // 获取图片的 base64 数据
  async function getImageBase64(img) {
    // 1) 优先尝试同源图片的 canvas 转换
    try {
      // 跨域图片 canvas 会抛 SecurityError，需要 try-catch 包裹整段
      const canvas = document.createElement('canvas');
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      // 图片未加载完成
      if (!w || !h) {
        throw new Error('图片未加载完成');
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/png');
      // toDataURL 在 canvas 被污染时会抛 SecurityError
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        throw new Error('canvas 数据无效');
      }
      return {
        base64: dataUrl.split(',')[1],
        mimeType: 'image/png',
      };
    } catch (e) {
      // 2) 跨域或其他原因 canvas 不可用 —— 降级返回 URL，让 service worker 用 fetch 拉取
      console.warn('[提示词反推] canvas 转 base64 失败，将通过 URL 发送:', e && e.message);
      return {
        base64: null,
        mimeType: 'image/png',
        imageUrl: img.src,
      };
    }
  }

  // 发送消息到 service worker
  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || '';
          // 扩展重新加载后，已有网页中的旧 content script 会失去上下文。
          // 这不是 API 失败，提示用户刷新当前页面即可恢复，不再把 Chrome 原始报错直接展示给用户。
          if (/Extension context invalidated|message port closed/i.test(message)) {
            resolve({ success: false, error: '扩展刚刚更新，请刷新当前网页后再试（Ctrl+R）' });
          } else {
            resolve({ success: false, error: message });
          }
        } else {
          resolve(response || { success: false, error: '无响应' });
        }
      });
    });
  }

  // ============ 遮罩层 / 面板管理 ============
  function showOverlay(type, data, img) {
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pr-ext-overlay';
    state.overlay = overlay;

    if (type === 'loading') {
      overlay.innerHTML = `
        <div class="pr-ext-loading-card">
          ${ICONS.spinner}
          <div class="pr-ext-loading-title">正在分析图片...</div>
          <div class="pr-ext-loading-sub">调用 AI 模型反推提示词，请稍候</div>
          <div class="pr-ext-progress-track"><div class="pr-ext-progress-fill" id="pr-ext-progress"></div></div>
        </div>
      `;
      // 进度条动画
      setTimeout(() => {
        const fill = overlay.querySelector('#pr-ext-progress');
        if (fill) fill.style.width = '30%';
      }, 300);
      setTimeout(() => {
        const fill = overlay.querySelector('#pr-ext-progress');
        if (fill) fill.style.width = '60%';
      }, 1000);
    } else if (type === 'result') {
      overlay.innerHTML = buildResultPanel(data, img);
      bindResultEvents(overlay, data, img);
    } else if (type === 'error') {
      overlay.innerHTML = `
        <div class="pr-ext-result-panel">
          <div class="pr-ext-panel-header">
            <span class="pr-ext-panel-title">出错了</span>
            <button class="pr-ext-close-btn" id="pr-ext-close">${ICONS.close}</button>
          </div>
          <div class="pr-ext-prompt-section">
            <div class="pr-ext-prompt-container pr-ext-error">${escapeHtml(data)}</div>
          </div>
        </div>
      `;
      const closeBtn = overlay.querySelector('#pr-ext-close');
      if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    }

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlay();
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('pr-ext-visible'));
  }

  function buildResultPanel(data, img) {
    const modelLabel = MODEL_LABELS[state.model] || state.model;
    const prompt = data.prompt || '（未获取到提示词）';
    const tags = Array.isArray(data.tags) ? data.tags : (typeof data.tags === 'string' ? data.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : []);
    const elapsed = data.elapsed ? data.elapsed.toFixed(1) + 's' : '--';
    const imgSrc = img ? img.src : '';

    return `
      <div class="pr-ext-result-panel">
        <div class="pr-ext-panel-header">
          <span class="pr-ext-panel-title">提示词反推结果</span>
          <div class="pr-ext-header-actions">
            <button class="pr-ext-fav-btn" id="pr-ext-fav" title="收藏到收藏夹">${ICONS.bookmark}</button>
            <button class="pr-ext-close-btn" id="pr-ext-close">${ICONS.close}</button>
          </div>
        </div>
        ${imgSrc ? `<div class="pr-ext-thumb"><img src="${escapeAttr(imgSrc)}" alt="缩略图" /></div>` : ''}
        <div class="pr-ext-prompt-section">
          <div class="pr-ext-prompt-label">反推提示词</div>
          <div class="pr-ext-prompt-container" id="pr-ext-prompt-text">${escapeHtml(prompt)}</div>
          ${tags.length ? `<div class="pr-ext-tags-row">${tags.map(t => `<span class="pr-ext-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="pr-ext-meta-row">
            <span>模型: ${escapeHtml(modelLabel)}</span>
            <span>·</span>
            <span>耗时: ${elapsed}</span>
          </div>
        </div>
        <div class="pr-ext-action-bar">
          <button class="pr-ext-btn-copy" id="pr-ext-copy">${ICONS.copy}<span>一键复制</span></button>
          <button class="pr-ext-btn-copy" id="pr-ext-canvas">${ICONS.bookmark}<span>发送到画布</span></button>
          <button class="pr-ext-btn-copy" id="pr-ext-edit">${ICONS.refresh}<span>用于图片修改</span></button>
          <button class="pr-ext-btn-regen" id="pr-ext-regen">${ICONS.refresh}<span>重新生成</span></button>
        </div>
      </div>
    `;
  }

  function bindResultEvents(overlay, data, img) {
    const closeBtn = overlay.querySelector('#pr-ext-close');
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

    // === 收藏按钮 ===
    const favBtn = overlay.querySelector('#pr-ext-fav');
    if (favBtn) {
      const promptText = (data && data.prompt) || '';
      // 异步检查是否已收藏，更新初始状态
      isFavorited(promptText).then((fav) => {
        if (fav) setFavBtnActive(favBtn, true);
      });
      // 点击切换收藏
      favBtn.addEventListener('click', async () => {
        if (!promptText) return;
        const wasFav = favBtn.classList.contains('is-fav');
        if (wasFav) {
          // 取消收藏
          await removeFavorite(promptText);
          setFavBtnActive(favBtn, false);
          showFavToast(overlay, '已取消收藏', 'unfav');
        } else {
          // 检查容量上限
          const list = await getFavorites();
          if (list.length >= MAX_FAVORITES) {
            showFavToast(overlay, '收藏已满（上限 ' + MAX_FAVORITES + ' 条），请先删除部分', 'unfav');
            return;
          }
          const modelLabel = MODEL_LABELS[state.model] || state.model;
          const thumbUrl = img ? img.src : '';
          await addFavorite({
            prompt: promptText,
            thumbUrl: thumbUrl,
            model: state.model,
            modelLabel: modelLabel,
          });
          setFavBtnActive(favBtn, true);
          showFavToast(overlay, '已收藏到收藏夹', 'fav');
        }
      });
    }

    const copyBtn = overlay.querySelector('#pr-ext-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const promptText = data.prompt || '';
        await copyToClipboard(promptText);
        // 切换到已复制状态
        copyBtn.classList.add('pr-ext-copied');
        copyBtn.innerHTML = ICONS.check + '<span>已复制</span>';
        // 顶部添加 Toast
        const panel = overlay.querySelector('.pr-ext-result-panel');
        if (panel && !panel.querySelector('.pr-ext-toast-bar')) {
          const toast = document.createElement('div');
          toast.className = 'pr-ext-toast-bar';
          toast.innerHTML = ICONS.toastCheck + '<span>已复制到剪贴板</span>';
          panel.insertBefore(toast, panel.firstChild);
        }
        // 3秒后恢复
        setTimeout(() => {
          if (copyBtn && copyBtn.parentNode) {
            copyBtn.classList.remove('pr-ext-copied');
            copyBtn.innerHTML = ICONS.copy + '<span>一键复制</span>';
            const toast = panel.querySelector('.pr-ext-toast-bar');
            if (toast) toast.remove();
          }
        }, 3000);
      });
    }

    const editBtn = overlay.querySelector('#pr-ext-edit');
    if (editBtn) editBtn.addEventListener('click', () => {
      chrome.storage.local.set({ pr_pending_edit: { prompt: data.prompt || '', imageUrl: img ? img.src : '', source: 'reverse_result', preserveNonProduct: true, createdAt: Date.now() } }, () => showFavToast(overlay, '已发送到智能补全，打开插件继续修改', 'fav'));
    });

    const canvasBtn = overlay.querySelector('#pr-ext-canvas');
    if (canvasBtn) canvasBtn.addEventListener('click', async () => {
      if (!img?.src || !data?.prompt || canvasBtn.disabled) return;
      canvasBtn.disabled = true;
      canvasBtn.querySelector('span').textContent = '发送中…';
      const result = await sendToBackground({
        action: 'send_to_canvas',
        imageUrl: img.currentSrc || img.src,
        prompt: data.prompt,
        model: state.customModel && state.model === 'custom' ? state.customModel : state.model,
        templateId: state.lastTemplateId,
        templateLabel: state.lastTemplateLabel,
        sourceUrl: location.href,
      });
      if (result?.success) {
        canvasBtn.querySelector('span').textContent = '已发送';
        showFavToast(overlay, '已发送到桌面画布', 'fav');
      } else {
        canvasBtn.disabled = false;
        canvasBtn.querySelector('span').textContent = '发送到画布';
        showFavToast(overlay, result?.error || '发送失败，请确认桌面程序已启动', 'unfav');
      }
    });

    const regenBtn = overlay.querySelector('#pr-ext-regen');
    if (regenBtn) {
      regenBtn.addEventListener('click', () => {
        closeOverlay();
        if (img) handleReverse(img);
      });
    }
  }

  function closeOverlay() {
    if (state.overlay && state.overlay.parentNode) {
      // 关键修复：捕获当前 overlay 的引用，而不是在回调里读 state.overlay
      // 否则 showOverlay('result') 先调 closeOverlay() 再赋值 state.overlay = newOverlay，
      // 200ms 后旧定时器会把新结果面板误删（面板闪退 ~200ms 后消失）
      const overlayToRemove = state.overlay;
      overlayToRemove.classList.remove('pr-ext-visible');
      setTimeout(() => {
        if (overlayToRemove && overlayToRemove.parentNode) {
          overlayToRemove.parentNode.removeChild(overlayToRemove);
        }
        // 只有当 state.overlay 仍指向被移除的元素时才置空，
        // 避免把新赋值的 overlay 也清掉
        if (state.overlay === overlayToRemove) {
          state.overlay = null;
        }
      }, 200);
    } else {
      state.overlay = null;
    }
  }

  // ============ 收藏管理 ============
  // 读取收藏列表
  function getFavorites() {
    return new Promise((resolve) => {
      chrome.storage.local.get([FAV_STORAGE_KEY], (items) => {
        resolve(items[FAV_STORAGE_KEY] || []);
      });
    });
  }

  // 按 prompt 判断是否已收藏
  function isFavorited(prompt) {
    const key = (prompt || '').trim();
    if (!key) return Promise.resolve(false);
    return getFavorites().then((list) => list.some((f) => (f.prompt || '').trim() === key));
  }

  // 新增收藏（已存在同 prompt 则跳过）
  function addFavorite(item) {
    return getFavorites().then((list) => {
      const key = (item.prompt || '').trim();
      if (list.some((f) => (f.prompt || '').trim() === key)) return list;
      list.unshift({
        id: 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        prompt: item.prompt || '',
        thumbUrl: item.thumbUrl || '',
        model: item.model || '',
        modelLabel: item.modelLabel || '',
        createdAt: Date.now(),
      });
      return saveFavorites(list);
    });
  }

  // 按 prompt 移除收藏
  function removeFavorite(prompt) {
    const key = (prompt || '').trim();
    return getFavorites().then((list) => {
      const next = list.filter((f) => (f.prompt || '').trim() !== key);
      return saveFavorites(next);
    });
  }

  // 写入收藏列表
  function saveFavorites(list) {
    return new Promise((resolve) => {
      const obj = {};
      obj[FAV_STORAGE_KEY] = list;
      chrome.storage.local.set(obj, () => resolve(list));
    });
  }

  // 切换收藏按钮激活态
  function setFavBtnActive(btn, active) {
    if (!btn) return;
    if (active) {
      btn.classList.add('is-fav');
      btn.innerHTML = ICONS.bookmarkFill;
      btn.title = '已收藏，点击取消';
    } else {
      btn.classList.remove('is-fav');
      btn.innerHTML = ICONS.bookmark;
      btn.title = '收藏到收藏夹';
    }
  }

  // 顶部收藏 Toast（fav=蓝色收藏成功 / unfav=灰色取消或已满）
  function showFavToast(overlay, text, type) {
    const panel = overlay.querySelector('.pr-ext-result-panel');
    if (!panel) return;
    // 移除已有的 fav toast，避免堆叠
    const old = panel.querySelector('[data-fav-toast]');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'pr-ext-toast-bar ' + (type === 'fav' ? 'pr-ext-toast-fav' : 'pr-ext-toast-unfav');
    toast.setAttribute('data-fav-toast', '1');
    toast.innerHTML = (type === 'fav' ? ICONS.toastFav : ICONS.bookmark) + '<span>' + escapeHtml(text) + '</span>';
    panel.insertBefore(toast, panel.firstChild);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 2800);
  }

  // ============ 可视化加载提示 ============
  function showLoadedBadge() {
    const badge = document.createElement('div');
    badge.id = 'pr-ext-loaded-badge';
    badge.style.cssText = [
      'position: fixed !important',
      'bottom: 16px !important',
      'right: 16px !important',
      'background: #3B82F6 !important',
      'color: #fff !important',
      'padding: 8px 16px !important',
      'border-radius: 8px !important',
      'font-size: 13px !important',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important',
      'font-weight: 600 !important',
      'box-shadow: 0 4px 12px rgba(59,130,246,0.4) !important',
      'z-index: 2147483647 !important',
      'display: flex !important',
      'align-items: center !important',
      'gap: 6px !important',
      'opacity: 0 !important',
      'transform: translateY(10px) !important',
      'transition: opacity 0.3s ease, transform 0.3s ease !important',
      'pointer-events: none !important',
    ].join(';');
    badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="white"/></svg> 提示词反推 v' + VERSION + ' 已加载';
    document.body.appendChild(badge);

    requestAnimationFrame(() => {
      badge.style.opacity = '1';
      badge.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      badge.style.opacity = '0';
      badge.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 300);
    }, 3000);
  }

  // ============ 工具函数 ============
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (state.overlay) closeOverlay();
      hideFloatingBtn();
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        console.warn('[PR-Ext] 复制失败', err);
      }
      document.body.removeChild(textarea);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return (text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
