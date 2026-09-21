/**
 * 提示词反推扩展 - Popup 设置逻辑
 */
(function () {
  'use strict';

  // DOM 元素引用
  const $ = (id) => document.getElementById(id);
  const dom = {
    toggleEnabled: $('toggle-enabled'),
    apiKey: $('api-key'),
    apiBase: $('api-base'),
    modelSelect: $('model-select'),
    customModelWrapper: $('custom-model-wrapper'),
    customModel: $('custom-model'),
    promptTemplate: $('prompt-template'),
    promptTemplateSelect: $('prompt-template-select'),
    btnSave: $('btn-save'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    apiProfileSelect: $('api-profile-select'), btnProfileApply: $('btn-profile-apply'), btnProfileSave: $('btn-profile-save'), btnProfileClear: $('btn-profile-clear'),
    // 收藏夹相关
    tabItems: document.querySelectorAll('.tab-item'),
    tabContents: document.querySelectorAll('.tab-content'),
    favTabBadge: $('fav-tab-badge'),
    historyTabBadge: $('history-tab-badge'), historyCount: $('history-count'), historyList: $('history-list'), historyEmpty: $('history-empty'), historyFooter: $('history-footer'), btnClearHistory: $('btn-clear-history'),
    favCount: $('fav-count'),
    capacityFill: $('capacity-fill'),
    capacityWarn: $('capacity-warn'),
    favList: $('fav-list'),
    favEmpty: $('fav-empty'),
    favFooter: $('fav-footer'),
    btnClearFav: $('btn-clear-fav'),
    enhanceInput: $('enhance-input'), enhanceRequest: $('enhance-request'), enhancePreserve: $('enhance-preserve'),
    preserveToggle: $('preserve-toggle'), preserveWrap: $('preserve-wrap'), imageRoleHint: $('image-role-hint'),
    btnEnhance: $('btn-enhance'), btnHistory: $('btn-history'), enhanceStatus: $('enhance-status'),
    enhanceProgress: $('enhance-progress'), enhanceProgressStage: $('enhance-progress-stage'), enhanceProgressTime: $('enhance-progress-time'), enhanceProgressFill: $('enhance-progress-fill'),
    btnCancelEnhance: $('btn-cancel-enhance'),
    enhanceResult: $('enhance-result'), enhanceFull: $('enhance-full-prompt'), enhanceEnglish: '',
    enhanceSections: null, enhanceNegative: null, enhanceExplanation: null,
    enhanceInstruction: $('enhance-instruction'), btnRefine: $('btn-refine'), btnCopyFull: $('btn-copy-full'),
    btnCopyEn: null, btnSaveVersion: $('btn-save-version'), enhanceHistory: $('enhance-history'),
    imageDropZone: $('image-drop-zone'), imageFileInput: $('image-file-input'), imagePreviewList: $('image-preview-list'),
    scanPage: $('btn-scan-page'), collectorStatus: $('collector-status'), collectorGrid: $('collector-grid'),
  };

  // 收藏夹配置
  const FAV_KEY = PR_CONFIG.FAVORITES_KEY;
  const FAV_MAX = PR_CONFIG.MAX_FAVORITES;
  const HISTORY_KEY = 'pr_reverse_history';
  const HISTORY_MAX = 15;
  const ENHANCE_DRAFT_KEY = 'pr_prompt_draft';
  const ENHANCE_TASK_KEY = 'pr_enhance_task';
  const ACTIVE_TAB_KEY = 'pr_active_tab';
  const API_PROFILES_KEY = 'pr_api_profiles';
  const TEMPLATE_MAP_KEY = 'pr_prompt_template_map';
  const CUSTOM_TEMPLATES_KEY = 'pr_custom_templates';
  const HIDDEN_TEMPLATES_KEY = 'pr_hidden_templates';
  let clearConfirmTimer = null;
  let currentDocument = null;
  let lockedSections = new Set();
  let referenceImages = [];
  let draggedReferenceImageId = '';
  let progressTimer = null;
  let taskPollTimer = null;
  let taskExpiryRequested = false;
  let importedBasePrompt = '';
  let lastPendingEditAt = 0;

  // ============ 初始化 ============
  function init() {
    populateModelSelect();
    loadSettings();
    bindEvents();
    loadApiProfiles();
    bindTabs();
    chrome.storage.local.get([ACTIVE_TAB_KEY], (items) => switchTab(items[ACTIVE_TAB_KEY] || 'settings'));
    bindFavCardEvents(); // 收藏卡片事件委托（只绑一次）
    if (dom.btnClearFav) dom.btnClearFav.addEventListener('click', clearAllFav);
    if (dom.btnClearHistory) dom.btnClearHistory.addEventListener('click', () => { if (window.confirm('确定清空全部反推历史吗？')) chrome.storage.local.set({ [HISTORY_KEY]: [] }, loadHistory); });
    bindEnhanceEvents();
    bindCollectorEvents();
    loadFavorites();
    loadHistory();
    loadEnhanceDraft();
    loadPendingEdit();
    // 监听收藏数据变化（content script 收藏/取消时 popup 同步刷新）
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  // 填充模型下拉列表
  function populateModelSelect() {
    let currentGroup = '';
    PR_CONFIG.MODELS.forEach((m) => {
      if (m.group && m.group !== currentGroup) {
        currentGroup = m.group;
        const optgroup = document.createElement('optgroup');
        optgroup.label = m.group;
        dom.modelSelect.appendChild(optgroup);
      }
      const option = document.createElement('option');
      option.value = m.value;
      option.textContent = m.label;
      // 将 option 添加到当前的 optgroup 或 select
      const lastChild = dom.modelSelect.lastElementChild;
      if (lastChild && lastChild.tagName === 'OPTGROUP') {
        lastChild.appendChild(option);
      } else {
        dom.modelSelect.appendChild(option);
      }
    });
  }

  // 加载已保存的设置
  function loadSettings() {
    chrome.storage.sync.get(PR_CONFIG.DEFAULTS, (items) => {
      chrome.storage.local.get(['apiKey', 'promptTemplateId', 'promptTemplate', TEMPLATE_MAP_KEY, CUSTOM_TEMPLATES_KEY, HIDDEN_TEMPLATES_KEY], (localItems) => {
      // 启用开关
      if (items.enabled) {
        dom.toggleEnabled.classList.remove('off');
      } else {
        dom.toggleEnabled.classList.add('off');
      }

      dom.apiKey.value = localItems.apiKey || items.apiKey || '';
      dom.apiBase.value = items.apiBase || '';
      dom.modelSelect.value = items.model || 'gpt-4o';
      dom.customModel.value = items.customModel || '';
      const templateId = localItems.promptTemplateId || items.promptTemplateId;
      renderTemplateOptions(localItems[CUSTOM_TEMPLATES_KEY] || [], templateId, localItems[HIDDEN_TEMPLATES_KEY] || []);
      const templateMap = localItems[TEMPLATE_MAP_KEY] || {};
      dom.promptTemplate.value = templateMap[templateId] || localItems.promptTemplate || items.promptTemplate || '';
      setPromptTemplateSelection(templateId, dom.promptTemplate.value);

      // 显示/隐藏自定义模型字段
      toggleCustomModel(items.model);
      const settings = { ...items, apiKey: dom.apiKey.value, promptTemplateId: templateId, promptTemplate: dom.promptTemplate.value };
      checkConfigStatus(settings);
      // 仅同步给正在运行的桌面端本机接口；不会上传至第三方。
      syncConfigToDesktop(settings);
      });
    });
  }

  // 绑定事件
  function bindEvents() {
    // 启用开关
    dom.toggleEnabled.addEventListener('click', () => {
      dom.toggleEnabled.classList.toggle('off');
    });

    // 模型选择变化
    dom.modelSelect.addEventListener('change', () => {
      toggleCustomModel(dom.modelSelect.value);
    });

    // 保存设置
    dom.btnSave.addEventListener('click', saveSettings);
    dom.btnCancelEnhance.addEventListener('click', cancelEnhancement);
    $('btn-visual-search').addEventListener('click', async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id) { await chrome.runtime.sendMessage({ type: 'start-selection-from-popup', tabId: tab.id }); window.close(); } });
    $('btn-add-template').addEventListener('click', addCustomTemplate);
    $('btn-remove-template').addEventListener('click', removeCurrentTemplate);
    dom.promptTemplateSelect.addEventListener('change', () => {
      const previousId = dom.promptTemplateSelect.dataset.currentId || dom.promptTemplateSelect.value;
      const previousValue = dom.promptTemplate.value.trim();
      const template = getTemplate(dom.promptTemplateSelect.value);
      if (template) {
        chrome.storage.local.get([TEMPLATE_MAP_KEY], (items) => {
          const map = items[TEMPLATE_MAP_KEY] || {};
          if (previousId && previousValue) map[previousId] = previousValue;
          dom.promptTemplate.value = map[template.id] || template.content;
          map[template.id] = dom.promptTemplate.value;
          dom.promptTemplateSelect.dataset.currentId = template.id;
          dom.promptTemplate.classList.remove('expanded');
          chrome.storage.local.set({ [TEMPLATE_MAP_KEY]: map }, saveSettings);
        });
      }
    });
    dom.promptTemplate.addEventListener('blur', saveSettings);
    dom.btnProfileSave.addEventListener('click', saveCurrentApiProfile);
    dom.btnProfileApply.addEventListener('click', applyApiProfile);
    dom.btnProfileClear.addEventListener('click', clearApiProfile);
    document.querySelectorAll('[data-toggle-textarea]').forEach((button) => {
      button.addEventListener('click', () => {
        const textarea = document.getElementById(button.dataset.toggleTextarea);
        if (!textarea) return;
        const expanded = textarea.classList.toggle('expanded');
        button.textContent = expanded ? '收起' : '展开';
        if (expanded) textarea.scrollIntoView({ block: 'nearest' });
      });
    });
  }

  let customTemplates = [];
  let hiddenTemplates = [];
  function getTemplate(id) { return [...PR_CONFIG.PROMPT_TEMPLATES, ...customTemplates].find((item) => item.id === id && !hiddenTemplates.includes(item.id)); }
  function renderTemplateOptions(customs, selectedId, hidden = hiddenTemplates) {
    customTemplates = Array.isArray(customs) ? customs : [];
    hiddenTemplates = Array.isArray(hidden) ? hidden : [];
    dom.promptTemplateSelect.innerHTML = '';
    [...PR_CONFIG.PROMPT_TEMPLATES, ...customTemplates].filter((item) => !hiddenTemplates.includes(item.id)).forEach((item) => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; dom.promptTemplateSelect.appendChild(option);
    });
    const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = '自定义模板'; dom.promptTemplateSelect.appendChild(custom);
    const first = dom.promptTemplateSelect.options[0];
    dom.promptTemplateSelect.value = getTemplate(selectedId) ? selectedId : (first ? first.value : 'custom');
  }
  function addCustomTemplate() {
    const label = window.prompt('请输入新模板名称');
    if (!label || !label.trim()) return;
    const id = `custom_${Date.now()}`;
    const item = { id, label: label.trim(), content: '' };
    customTemplates.push(item);
    chrome.storage.local.set({ [CUSTOM_TEMPLATES_KEY]: customTemplates }, () => {
      renderTemplateOptions(customTemplates, id);
      dom.promptTemplate.value = '';
      dom.promptTemplate.focus();
    });
  }
  function removeCurrentTemplate() {
    const id = dom.promptTemplateSelect.value;
    const template = getTemplate(id);
    if (!template) return;
    if (dom.promptTemplateSelect.options.length <= 1) return window.alert('至少保留一个提示词模板');
    if (!window.confirm(`确定删除模板“${template.label}”吗？`)) return;
    const nextId = [...dom.promptTemplateSelect.options].find((option) => option.value !== id)?.value;
    const isBuiltIn = PR_CONFIG.PROMPT_TEMPLATES.some((item) => item.id === id);
    if (isBuiltIn) hiddenTemplates.push(id); else customTemplates = customTemplates.filter((item) => item.id !== id);
    chrome.storage.local.set({ [CUSTOM_TEMPLATES_KEY]: customTemplates, [HIDDEN_TEMPLATES_KEY]: hiddenTemplates }, () => {
      renderTemplateOptions(customTemplates, nextId, hiddenTemplates);
      dom.promptTemplateSelect.dispatchEvent(new Event('change'));
    });
  }

  function currentSettingsFromForm() {
    return { enabled: !dom.toggleEnabled.classList.contains('off'), apiKey: dom.apiKey.value.trim(), apiBase: dom.apiBase.value.trim(), model: dom.modelSelect.value, customModel: dom.customModel.value.trim(), promptTemplateId: dom.promptTemplateSelect.value, promptTemplate: dom.promptTemplate.value.trim() };
  }

  async function syncConfigToDesktop(settings) {
    try {
      const local = await chrome.storage.local.get([TEMPLATE_MAP_KEY, CUSTOM_TEMPLATES_KEY, HIDDEN_TEMPLATES_KEY]);
      const templateMap = local[TEMPLATE_MAP_KEY] || {};
      const hidden = new Set(local[HIDDEN_TEMPLATES_KEY] || []);
      const templates = [...PR_CONFIG.PROMPT_TEMPLATES, ...(local[CUSTOM_TEMPLATES_KEY] || [])]
        .filter((item) => item && !hidden.has(item.id))
        .map((item) => ({ id: item.id, label: item.label, content: templateMap[item.id] || item.content || '' }));
      if (!templates.some((item) => item.id === settings.promptTemplateId)) {
        templates.push({ id: settings.promptTemplateId || 'custom', label: '当前自定义模板', content: settings.promptTemplate || '' });
      }
      await fetch('http://127.0.0.1:47777/api/ai-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, promptTemplates: templates }),
      });
    } catch (_) {
      // 未启动桌面端时静默跳过；下次打开或保存设置会自动重试。
    }
  }

  function setPromptTemplateSelection(templateId, value) {
    const matched = PR_CONFIG.PROMPT_TEMPLATES.find((item) => item.id === templateId || item.content === value);
    dom.promptTemplateSelect.value = matched ? matched.id : 'custom';
    dom.promptTemplateSelect.dataset.currentId = dom.promptTemplateSelect.value;
  }

  function loadApiProfiles() {
    chrome.storage.local.get([API_PROFILES_KEY], (items) => renderApiProfiles(Array.isArray(items[API_PROFILES_KEY]) ? items[API_PROFILES_KEY] : []));
  }

  function renderApiProfiles(profiles) {
    [...dom.apiProfileSelect.options].forEach((option, index) => {
      const profile = profiles[index];
      option.textContent = profile ? `${index + 1}. ${profile.name || profile.model || '已保存配置'}` : `常用配置 ${index + 1}（未保存）`;
    });
  }

  function saveCurrentApiProfile() {
    const index = Number(dom.apiProfileSelect.value || 0);
    const settings = currentSettingsFromForm();
    const modelLabel = PR_CONFIG.MODEL_LABELS[settings.model] || settings.customModel || settings.model;
    const host = (() => { try { return new URL(settings.apiBase).hostname; } catch (_) { return settings.apiBase === 'local' ? '本地' : ''; } })();
    const localHost = host === '127.0.0.1' || host === 'localhost';
    // API 配置槽位只保存连接信息，提示词模板是独立设置，不随模型切换。
    const { promptTemplateId, promptTemplate, ...apiSettings } = settings;
    const profile = { ...apiSettings, name: `${modelLabel}${host ? ` · ${localHost ? '本地' : host}` : ''}`, savedAt: Date.now() };
    chrome.storage.local.get([API_PROFILES_KEY], (items) => {
      const profiles = Array.isArray(items[API_PROFILES_KEY]) ? items[API_PROFILES_KEY].slice(0, 5) : [];
      profiles[index] = profile;
      chrome.storage.local.set({ [API_PROFILES_KEY]: profiles }, () => { renderApiProfiles(profiles); showToast(`已保存到常用配置 ${index + 1}`); });
    });
  }

  function applyApiProfile() {
    const index = Number(dom.apiProfileSelect.value || 0);
    chrome.storage.local.get([API_PROFILES_KEY], (items) => {
      const profile = (Array.isArray(items[API_PROFILES_KEY]) ? items[API_PROFILES_KEY] : [])[index];
      if (!profile) return showToast('这个配置槽位还没有保存');
      dom.apiKey.value = profile.apiKey || ''; dom.apiBase.value = profile.apiBase || ''; dom.modelSelect.value = profile.model || 'custom'; dom.customModel.value = profile.customModel || '';
      toggleCustomModel(dom.modelSelect.value); saveSettings(); showToast(`已切换到常用配置 ${index + 1}`);
    });
  }

  function clearApiProfile() {
    const index = Number(dom.apiProfileSelect.value || 0);
    chrome.storage.local.get([API_PROFILES_KEY], (items) => {
      const profiles = Array.isArray(items[API_PROFILES_KEY]) ? items[API_PROFILES_KEY] : [];
      profiles[index] = null;
      chrome.storage.local.set({ [API_PROFILES_KEY]: profiles }, () => { renderApiProfiles(profiles); showToast(`已清除常用配置 ${index + 1}`); });
    });
  }

  // 显示/隐藏自定义模型字段
  function toggleCustomModel(modelValue) {
    if (modelValue === 'custom') {
      dom.customModelWrapper.style.display = '';
    } else {
      dom.customModelWrapper.style.display = 'none';
    }
  }

  // 保存设置
  function saveSettings() {
    const settings = currentSettingsFromForm();

    const { apiKey, promptTemplateId, promptTemplate, ...syncSettings } = settings;
    chrome.storage.local.get([TEMPLATE_MAP_KEY], (items) => {
      const map = items[TEMPLATE_MAP_KEY] || {};
      if (promptTemplateId) map[promptTemplateId] = promptTemplate;
      chrome.storage.local.set({ apiKey, promptTemplateId, promptTemplate, [TEMPLATE_MAP_KEY]: map });
    });
    // 同步存储保留一份兼容副本；本机模板以 local 版本为准。
    syncSettings.promptTemplateId = promptTemplateId;
    syncSettings.promptTemplate = promptTemplate;
    chrome.storage.sync.set(syncSettings, () => {
      // 按钮反馈
      dom.btnSave.classList.add('saved');
      dom.btnSave.textContent = '已保存';
      setTimeout(() => {
        dom.btnSave.classList.remove('saved');
        dom.btnSave.textContent = '保存设置';
      }, 2000);
      checkConfigStatus(settings);
      syncConfigToDesktop(settings);
    });
  }

  // 检查配置有效性（扩展直连 AI，无需后端）
  function checkConfigStatus(settings) {
    const currentSettings = settings || {
      apiKey: dom.apiKey.value.trim(), apiBase: dom.apiBase.value.trim(), model: dom.modelSelect.value, customModel: dom.customModel.value.trim(),
    };
    dom.statusDot.className = 'status-dot';
    dom.statusText.textContent = '检测中...';

    chrome.runtime.sendMessage(
      { action: 'checkConfig', settings: currentSettings },
      (response) => {
        if (response && response.success) {
          dom.statusDot.className = 'status-dot online';
          dom.statusText.textContent = (response.message || '配置有效，可直接使用') + ' ✅';
        } else {
          dom.statusDot.className = 'status-dot offline';
          dom.statusText.textContent = (response && response.message) || '配置不可用';
        }
      }
    );
  }

  // ============ Tab 切换 ============
  function bindTabs() {
    dom.tabItems.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
  }

  function switchTab(name) {
    dom.tabItems.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    dom.tabContents.forEach((c) => c.classList.toggle('active', c.id === 'tab-' + name));
    if (name === 'favorites') loadFavorites();
    if (name === 'enhance') loadEnhanceHistory();
    if (name === 'collector') dom.collectorStatus.textContent = '点击扫描，列出当前页面可见图片。';
    chrome.storage.local.set({ [ACTIVE_TAB_KEY]: name });
  }

  // ============ 图片采集到桌面收藏夹 ============
  function bindCollectorEvents() {
    if (!dom.scanPage) return;
    dom.scanPage.addEventListener('click', scanCurrentPage);
  }

  async function scanCurrentPage() {
    dom.scanPage.disabled = true;
    dom.scanPage.textContent = '扫描中…';
    dom.collectorGrid.innerHTML = '';
    dom.collectorStatus.textContent = '正在读取当前页面图片…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('无法获取当前页面');
      let response;
      try { response = await chrome.tabs.sendMessage(tab.id, { type: 'PV_SCAN_PAGE_IMAGES' }); }
      catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/matchers.js', 'content/vault-collector.js'] });
        response = await chrome.tabs.sendMessage(tab.id, { type: 'PV_SCAN_PAGE_IMAGES' });
      }
      if (!response || !response.ok || !response.images || !response.images.length) throw new Error('没有扫描到图片，请刷新页面后重试');
      dom.collectorStatus.textContent = `扫描到 ${response.images.length} 张图片，点击图片录入收藏夹`;
      response.images.forEach((item) => {
        const card = document.createElement('button');
        card.type = 'button'; card.className = 'collector-card';
        const img = document.createElement('img');
        img.src = item.thumb || item.url;
        img.alt = item.alt || '';
        img.loading = 'lazy';
        img.decoding = 'async';
        const label = document.createElement('span'); label.textContent = item.prompt ? `已识别提示词 · ${item.prompt.slice(0, 22)}` : '点击手动粘贴提示词';
        card.append(img, label);
        card.addEventListener('click', () => openCollectorSave({ srcUrl: item.url, pageUrl: response.pageUrl || tab.url || '', prompt: item.prompt || '', sourceTool: item.sourceTool || '手动' }));
        dom.collectorGrid.appendChild(card);
      });
    } catch (error) { dom.collectorStatus.textContent = error.message || '扫描失败，请刷新页面后重试'; }
    dom.scanPage.disabled = false; dom.scanPage.textContent = '扫描当前页面';
  }

  function openCollectorSave(info) {
    chrome.storage.local.set({ pendingSave: info || {} }, () => {
      chrome.windows.create({ url: chrome.runtime.getURL('save.html'), type: 'popup', width: 520, height: 660 });
      window.close();
    });
  }

  // ============ 智能补全 ============
  function bindEnhanceEvents() {
    dom.btnEnhance.addEventListener('click', () => requestEnhancement(false));
    dom.btnRefine.addEventListener('click', () => requestEnhancement(true));
    dom.btnHistory.addEventListener('click', () => {
      dom.enhanceHistory.style.display = dom.enhanceHistory.style.display === 'none' ? '' : 'none';
      loadEnhanceHistory();
    });
    dom.btnCopyFull.addEventListener('click', () => copyText(dom.enhanceFull.value).then(() => setEnhanceStatus('已复制完整提示词', 'success')));
    dom.btnSaveVersion.addEventListener('click', saveEnhanceVersion);
    dom.enhanceFull.addEventListener('input', () => { if (currentDocument) { currentDocument.fullPrompt = dom.enhanceFull.value; saveEnhanceDraft(); } });
    dom.enhanceInput.addEventListener('input', () => {
      if (resetEnhanceSessionIfEmpty()) return;
      saveEnhanceDraft();
    });
    dom.enhanceRequest.addEventListener('input', () => {
      if (resetEnhanceSessionIfEmpty()) return;
      saveEnhanceDraft();
    });
    dom.enhancePreserve.addEventListener('input', () => {
      if (resetEnhanceSessionIfEmpty()) return;
      saveEnhanceDraft();
    });
    dom.preserveToggle.addEventListener('click', () => setPreserveExpanded(dom.preserveWrap.hidden));
    dom.imageDropZone.addEventListener('click', () => dom.imageFileInput.click());
    dom.imageFileInput.addEventListener('change', (e) => addReferenceFiles(e.target.files));
    dom.imageDropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.imageDropZone.classList.add('dragging'); });
    dom.imageDropZone.addEventListener('dragleave', () => dom.imageDropZone.classList.remove('dragging'));
    dom.imageDropZone.addEventListener('drop', (e) => { e.preventDefault(); dom.imageDropZone.classList.remove('dragging'); addReferenceFiles(e.dataTransfer.files); });
  }

  function setEnhanceStatus(text, type) { dom.enhanceStatus.textContent = text || ''; dom.enhanceStatus.className = 'enhance-status ' + (type || ''); }

  function setPreserveExpanded(expanded) {
    dom.preserveWrap.hidden = !expanded;
    dom.preserveToggle.classList.toggle('open', expanded);
    dom.preserveToggle.setAttribute('aria-expanded', String(expanded));
  }

  function clearEnhanceDerivedState() {
    currentDocument = null;
    importedBasePrompt = '';
    lockedSections = new Set();
    if (dom.enhanceInstruction) dom.enhanceInstruction.value = '';
    if (dom.enhanceFull) dom.enhanceFull.value = '';
    if (dom.enhanceResult) dom.enhanceResult.style.display = 'none';
  }

  function resetEnhanceSessionIfEmpty() {
    if (dom.enhanceInput.value.trim() || dom.enhanceRequest.value.trim() || dom.enhancePreserve.value.trim() || referenceImages.length) return false;
    clearEnhanceDerivedState();
    chrome.runtime.sendMessage({ action: 'cancel_enhance_task' }, () => void chrome.runtime.lastError);
    stopEnhanceProgress();
    chrome.storage.local.remove([ENHANCE_DRAFT_KEY]);
    setEnhanceStatus('已清空，下一次生成将作为全新任务', 'success');
    return true;
  }

  function enhancementOptions() {
    return {
      promptTemplateId: dom.promptTemplateSelect ? dom.promptTemplateSelect.value : '',
      promptTemplate: dom.promptTemplate ? dom.promptTemplate.value.trim() : '',
      editMode: importedBasePrompt ? 'targeted_edit' : '',
      basePrompt: importedBasePrompt,
    };
  }

  function isProductReplacementInstruction(text) {
    const value = String(text || '');
    const marker = value.match(/(?:换成|替换成|改成|换为|替换为)/);
    if (!marker) return false;
    const products = ['电动滑板车', '电动自行车', '电助力自行车', '滑板车', '自行车', '摩托车', '越野车', '商务车', '跑车', '轿车', '汽车'];
    const before = value.slice(0, marker.index);
    const after = value.slice(marker.index + marker[0].length);
    return products.some((name) => before.includes(name)) && products.some((name) => after.includes(name));
  }

  async function addReferenceFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    if (referenceImages.length + files.length > 8) return setEnhanceStatus('最多上传 8 张图片', 'error');
    try {
      // 空白界面上传第一张图代表开始新任务，绝不能继承旧草稿中的母稿或结构化结果。
      if (!referenceImages.length && !dom.enhanceInput.value.trim() && !dom.enhanceRequest.value.trim()) clearEnhanceDerivedState();
      for (const file of files) referenceImages.push(await compressReferenceImage(file));
      renderReferenceImages(); saveEnhanceDraft();
    } catch (e) { setEnhanceStatus('图片处理失败：' + e.message, 'error'); }
    dom.imageFileInput.value = '';
  }

  function compressReferenceImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取图片'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('图片格式不受支持'));
        image.onload = () => {
          let scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
          let canvas = document.createElement('canvas');
          let dataUrl = '';
          const preserveAlpha = file.type === 'image/png';
          // 最多允许 8 张草稿图，单张控制在约 600KB 内，避免撑满 chrome.storage.local。
          for (let attempt = 0; attempt < 8; attempt++) {
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            dataUrl = preserveAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', attempt === 0 ? 0.76 : 0.62);
            if (dataUrl.length <= 600_000) break;
            scale *= 0.68;
          }
          if (dataUrl.length > 600_000) return reject(new Error('图片压缩后仍然过大，请换一张尺寸更小的图片'));
          resolve({ id: String(Date.now()) + Math.random().toString(16).slice(2), name: file.name, mimeType: preserveAlpha ? 'image/png' : 'image/jpeg', dataUrl, width: canvas.width, height: canvas.height, compressed: scale < 1 || dataUrl.length < file.size });
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderReferenceImages() {
    if (!Array.isArray(referenceImages)) referenceImages = [];
    const safeImages = Array.isArray(referenceImages) ? referenceImages.filter((image) => image && image.dataUrl) : [];
    referenceImages = safeImages;
    dom.imagePreviewList.innerHTML = safeImages.map((image, index) => `<div class="image-preview-card" draggable="true" data-image-id="${image.id}" title="拖动可调整图片顺序"><img src="${image.dataUrl}" alt="${index === 0 ? '底图' : `参考图 ${index + 1}`}"><span class="image-role-badge ${index === 0 ? 'base' : ''}">${index === 0 ? '底图' : `参考 ${index + 1}`}</span><button class="image-preview-remove" data-remove-image="${image.id}" title="删除">×</button><div class="image-preview-name">${escapeHtml(image.name)}</div><div class="image-preview-order"><button data-move-image="${image.id}" data-direction="up" title="向前移动" ${index === 0 ? 'disabled' : ''}>←</button><button data-move-image="${image.id}" data-direction="down" title="向后移动" ${index === safeImages.length - 1 ? 'disabled' : ''}>→</button></div></div>`).join('');
    dom.imagePreviewList.querySelectorAll('[data-remove-image]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); referenceImages = referenceImages.filter((image) => image.id !== button.dataset.removeImage); renderReferenceImages(); if (!resetEnhanceSessionIfEmpty()) saveEnhanceDraft(); }));
    dom.imagePreviewList.querySelectorAll('[data-move-image]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); const index = referenceImages.findIndex((image) => image.id === button.dataset.moveImage); const next = button.dataset.direction === 'up' ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= referenceImages.length) return; [referenceImages[index], referenceImages[next]] = [referenceImages[next], referenceImages[index]]; renderReferenceImages(); saveEnhanceDraft(); }));
    dom.imagePreviewList.querySelectorAll('[data-image-id]').forEach((card) => {
      card.addEventListener('dragstart', (event) => { draggedReferenceImageId = card.dataset.imageId; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragover', (event) => { event.preventDefault(); if (card.dataset.imageId !== draggedReferenceImageId) card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (event) => { event.preventDefault(); const from = referenceImages.findIndex((image) => image.id === draggedReferenceImageId); const to = referenceImages.findIndex((image) => image.id === card.dataset.imageId); if (from >= 0 && to >= 0 && from !== to) { const [moved] = referenceImages.splice(from, 1); referenceImages.splice(to, 0, moved); renderReferenceImages(); saveEnhanceDraft(); } });
      card.addEventListener('dragend', () => { draggedReferenceImageId = ''; dom.imagePreviewList.querySelectorAll('.image-preview-card').forEach((item) => item.classList.remove('dragging', 'drag-over')); });
    });
    dom.imageRoleHint.classList.toggle('visible', safeImages.length > 0);
    dom.btnEnhance.textContent = referenceImages.length ? '生成修改提示词' : '生成提示词';
  }

  function requestEnhancement(refine) {
    if (!Array.isArray(referenceImages)) referenceImages = [];
    const input = dom.enhanceInput.value.trim();
    const request = dom.enhanceRequest.value.trim();
    const instruction = dom.enhanceInstruction.value.trim();
    if (!input && !request && !currentDocument && !referenceImages.length) return setEnhanceStatus('请上传图片、填写原版提示词或修改需求', 'error');
    if (refine && !instruction) return setEnhanceStatus('请填写这次想优化的方向', 'error');
    executeEnhancement(refine);
  }

  function classifyBeforeEnhance() {
    setEnhanceStatus('正在识别图片并推荐提示词模板…');
    normalizeReferenceImage(referenceImages[0]).then(image => getAllSettings(settings => {
      chrome.storage.local.get(['pr_hidden_templates'], (hiddenItems) => {
        const allTemplateIds = ['human_vehicle', 'blender_3d', 'commercial_product', 'ecommerce_white', 'creative_art'];
        chrome.storage.local.get([CUSTOM_TEMPLATES_KEY], (customItems) => {
        const customTemplateList = Array.isArray(customItems[CUSTOM_TEMPLATES_KEY]) ? customItems[CUSTOM_TEMPLATES_KEY].filter((item) => item && item.id && item.label) : [];
        const labels = { human_vehicle:'人车真实场景摄影', blender_3d:'Blender 三维产品渲染', commercial_product:'商业产品广告', ecommerce_white:'电商白底产品图', creative_art:'创意艺术风格' };
        const templateCatalog = [...allTemplateIds.map((id) => ({ id, label: labels[id] })), ...customTemplateList.map((item) => ({ id: item.id, label: item.label }))];
        settings.templateCatalog = templateCatalog;
        settings.availableTemplateIds = templateCatalog.map((item) => item.id).filter((id) => !(hiddenItems.pr_hidden_templates || []).includes(id));
        chrome.runtime.sendMessage({ action: 'classify_template', settings, image: { base64: image.dataUrl.split(',')[1], mimeType: image.mimeType || 'image/jpeg' } }, async response => {
        if (chrome.runtime.lastError || !response?.success) return setEnhanceStatus(response?.error || '模板识别失败，请手动选择模板', 'error');
        const d = response.data;
        const hiddenItems = await new Promise((resolve) => chrome.storage.local.get(['pr_hidden_templates'], resolve));
        const hiddenTemplates = Array.isArray(hiddenItems.pr_hidden_templates) ? hiddenItems.pr_hidden_templates : [];
        const templateIds = templateCatalog.map((item) => item.id).filter((id) => !hiddenTemplates.includes(id));
        if (!templateIds.length) return setEnhanceStatus('没有可用的提示词模板，请在设置中恢复至少一个模板', 'error');
        const options = templateIds.map((id, index) => `${index + 1}. ${labels[id]}${id === d.template ? '（模型推荐）' : ''}`).join('\n');
        const recommendedName = labels[d.template] || d.template;
        let selectedIndex = templateIds.indexOf(d.template);
        if (selectedIndex < 0) selectedIndex = 0;
        const accepted = window.confirm(`模型判断本图片适合使用：${recommendedName}\n置信度：${Math.round((d.confidence || 0) * 100)}%\n理由：${d.reason || '模型未提供'}\n\n是否使用此模板？`);
        if (!accepted) {
          const answer = window.prompt(`请选择本次反推使用的模板（输入编号）：\n\n${options}`, String(selectedIndex + 1));
          selectedIndex = Number.parseInt(answer, 10) - 1;
        }
        if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= templateIds.length) return setEnhanceStatus('未选择模板');
        dom.promptTemplateSelect.value = templateIds[selectedIndex];
        dom.promptTemplateSelect.dispatchEvent(new Event('change'));
        setTimeout(() => executeEnhancement(false), 120);
        });
        });
      });
    })).catch(() => setEnhanceStatus('图片无法读取，请重新上传', 'error'));
  }

  function executeEnhancement(refine) {
    const input = dom.enhanceInput.value.trim();
    const request = dom.enhanceRequest.value.trim();
    const preserveInstruction = dom.enhancePreserve.value.trim();
    const instruction = dom.enhanceInstruction.value.trim();
    setEnhanceStatus('正在准备并发送模型请求…');
    startEnhanceProgress(Date.now());
    dom.btnEnhance.disabled = true; dom.btnRefine.disabled = true;
    getAllSettings((settings) => {
      try {
        const action = referenceImages.length ? 'optimize_prompt_with_images' : 'optimize_prompt';
        const basePrompt = input || importedBasePrompt;
        const taskInstruction = refine ? instruction : (request || (basePrompt ? '保留原版提示词的核心内容，结合参考图片进行必要补全。' : '请分析这些参考图片，保留主要主体，补全可用于图片编辑的视觉提示词，并指出适合修改的环境、光线、材质和风格。'));
        const imagePreparation = Promise.all((Array.isArray(referenceImages) ? referenceImages : []).map(normalizeReferenceImage));
        imagePreparation.then((preparedImages) => {
          referenceImages = preparedImages;
          const images = preparedImages.filter((image) => image && typeof image.dataUrl === 'string' && image.dataUrl.includes(',')).map((image) => ({ name: image.name || 'reference', mimeType: 'image/jpeg', base64: image.dataUrl.split(',')[1] }));
          setEnhanceStatus('请求已发送，正在等待模型返回…');
          const requestOptions = enhancementOptions();
          requestOptions.basePrompt = basePrompt;
          if (basePrompt && taskInstruction) requestOptions.editMode = isProductReplacementInstruction(taskInstruction) ? 'replace_product_only' : 'targeted_edit';
          chrome.runtime.sendMessage({ action, images, input, instruction: taskInstruction, preserveInstruction, options: requestOptions, currentDocument: refine ? currentDocument : null, lockedSections: [...lockedSections], settings }, (response) => {
            dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false;
            if (chrome.runtime.lastError || !response || !response.success) { stopEnhanceProgress(); return setEnhanceStatus((response && response.error) || chrome.runtime.lastError?.message || '生成失败', 'error'); }
            if (response.background) return;
            currentDocument = response.data; dom.enhanceEnglish = response.data.fullPromptEnglish || '';
            renderEnhancement(response.data); saveEnhanceDraft(); finishEnhanceProgress(); setEnhanceStatus('生成完成', 'success');
          });
        }).catch((error) => {
          dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false; stopEnhanceProgress();
          setEnhanceStatus(`图片准备失败：${error.message || '请删除后重新上传 JPG/PNG'}`, 'error');
        });
      } catch (error) {
        dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false; stopEnhanceProgress();
        setEnhanceStatus(`请求发送前失败：${error.message || '未知错误'}`, 'error');
      }
    });
  }

  function getAllSettings(callback) {
    chrome.storage.sync.get(PR_CONFIG.DEFAULTS, (syncSettings) => {
      chrome.storage.local.get(['apiKey'], (localSettings) => callback({ ...syncSettings, apiKey: localSettings.apiKey || syncSettings.apiKey || '' }));
    });
  }

  function restoreEnhanceTask(minCompletedAt) {
    chrome.runtime.sendMessage({ action: 'get_enhance_task' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.task) return;
      const task = response.task;
      if (task.status === 'running') {
        switchTab('enhance');
        setEnhanceStatus('已恢复后台任务，仍在生成中…');
        startEnhanceProgress(task.startedAt || Date.now());
        if (Date.now() - Number(task.startedAt || 0) > 185000) expireEnhancement(task);
        return;
      }
      if (task.status === 'failed') {
        stopEnhanceProgress();
        setEnhanceStatus(task.error || '上次生成失败', 'error');
        return;
      }
      if (task.status === 'cancelled') {
        stopEnhanceProgress();
        setEnhanceStatus('上次生成已取消', 'error');
        return;
      }
      if (task.status === 'completed' && task.data && Number(task.completedAt || 0) > Number(minCompletedAt || 0)) {
        currentDocument = task.data;
        dom.enhanceEnglish = task.data.fullPromptEnglish || '';
        renderEnhancement(task.data);
        saveEnhanceDraft();
        finishEnhanceProgress();
        setEnhanceStatus('已恢复后台完成的生成结果', 'success');
      }
    });
  }

  function startEnhanceProgress(startedAt) {
    stopEnhanceProgress();
    const start = Number(startedAt) || Date.now();
    dom.enhanceProgress.style.display = '';
    dom.btnEnhance.disabled = true; dom.btnRefine.disabled = true;
    const update = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      let stage = '正在理解修改要求';
      if (seconds >= 8) stage = '正在分析参考图片';
      if (seconds >= 25) stage = '正在重写视觉提示词';
      if (seconds >= 55) stage = '正在整理结构化结果';
      const progress = Math.min(92, Math.round(5 + 87 * (1 - Math.exp(-seconds / 42))));
      dom.enhanceProgressStage.textContent = stage;
      dom.enhanceProgressTime.textContent = `${seconds} 秒`;
      dom.enhanceProgressFill.style.width = `${progress}%`;
    };
    update();
    progressTimer = setInterval(update, 1000);
    taskPollTimer = setInterval(() => pollEnhanceTask(start), 1500);
  }

  function cancelEnhancement() {
    chrome.runtime.sendMessage({ action: 'cancel_enhance_task' }, () => {
      stopEnhanceProgress();
      dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false;
      setEnhanceStatus('已取消生成', 'error');
    });
  }

  function pollEnhanceTask(startedAt) {
    chrome.runtime.sendMessage({ action: 'get_enhance_task' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.task) return;
      const task = response.task;
      if (Number(task.startedAt || 0) < Number(startedAt || 0) - 1000) return;
      if (['running', 'restarting'].includes(task.status) && Date.now() - Number(task.startedAt || 0) > 185000) {
        expireEnhancement(task);
        return;
      }
      if (task.status === 'failed') {
        stopEnhanceProgress();
        dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false;
        setEnhanceStatus(task.error || '生成失败', 'error');
      } else if (task.status === 'completed' && task.data) {
        currentDocument = task.data; dom.enhanceEnglish = task.data.fullPromptEnglish || '';
        renderEnhancement(task.data); saveEnhanceDraft(); finishEnhanceProgress();
        dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false;
        setEnhanceStatus('生成完成', 'success');
      } else if (task.status === 'running' && task.phase) {
        dom.enhanceProgressStage.textContent = task.phase;
      }
    });
  }

  function expireEnhancement(task) {
    if (taskExpiryRequested) return;
    taskExpiryRequested = true;
    chrome.runtime.sendMessage({ action: 'expire_enhance_task', taskId: task.id }, (response) => {
      taskExpiryRequested = false;
      stopEnhanceProgress();
      dom.btnEnhance.disabled = false; dom.btnRefine.disabled = false;
      const fallback = '模型接口超过 180 秒没有返回。请检查 API 配置、网络或模型的多图能力后重试。';
      setEnhanceStatus((response && response.error) || fallback, 'error');
    });
  }

  function stopEnhanceProgress() {
    if (progressTimer) clearInterval(progressTimer);
    if (taskPollTimer) clearInterval(taskPollTimer);
    progressTimer = null; taskPollTimer = null;
    if (dom.enhanceProgress) dom.enhanceProgress.style.display = 'none';
  }

  function finishEnhanceProgress() {
    if (dom.enhanceProgressFill) dom.enhanceProgressFill.style.width = '100%';
    if (dom.enhanceProgressStage) dom.enhanceProgressStage.textContent = '生成完成';
    if (progressTimer) clearInterval(progressTimer);
    if (taskPollTimer) clearInterval(taskPollTimer);
    progressTimer = null; taskPollTimer = null;
    setTimeout(() => { if (dom.enhanceProgress) dom.enhanceProgress.style.display = 'none'; }, 900);
  }

  const SECTION_LABELS = { subject: '主体', environment: '环境', composition: '构图', camera: '镜头', lighting: '光线', color: '色彩', material: '材质', atmosphere: '氛围', style: '风格', details: '细节' };
  function renderEnhancement(doc) {
    dom.enhanceResult.style.display = '';
    dom.enhanceFull.value = doc.fullPrompt || '';
  }
  function syncFullPrompt() { if (!currentDocument) return; const values = Object.keys(SECTION_LABELS).map((k) => currentDocument.sections?.[k]).filter(Boolean); currentDocument.fullPrompt = values.join('，'); dom.enhanceFull.value = currentDocument.fullPrompt; }
  function saveEnhanceDraft() {
    const draft = {
      sourceInput: dom.enhanceInput.value,
      editRequest: dom.enhanceRequest.value,
      preserveInstruction: dom.enhancePreserve.value,
      images: referenceImages,
      document: currentDocument,
      lockedSections: [...lockedSections],
      options: enhancementOptions(),
      importedBasePrompt,
      savedAt: Date.now(),
    };
    chrome.storage.local.set({ [ENHANCE_DRAFT_KEY]: draft }, () => {
      if (!chrome.runtime.lastError) return;
      // 容量不足时至少保住文字、结果和锁定状态。
      chrome.storage.local.set({ [ENHANCE_DRAFT_KEY]: { ...draft, images: [] } }, () => {
        setEnhanceStatus('图片草稿超过本地容量，已保留文字结果；下次需要重新上传图片', 'error');
      });
    });
  }
  function loadEnhanceDraft() {
    chrome.storage.local.get([ENHANCE_DRAFT_KEY], (items) => {
      const draft = items[ENHANCE_DRAFT_KEY];
      if (!draft) { restoreEnhanceTask(0); return; }
      if (draft.sourceInput) dom.enhanceInput.value = draft.sourceInput;
      if (draft.editRequest) dom.enhanceRequest.value = draft.editRequest;
      if (draft.preserveInstruction) { dom.enhancePreserve.value = draft.preserveInstruction; setPreserveExpanded(true); }
      importedBasePrompt = String(draft.importedBasePrompt || draft.options?.basePrompt || '');
      referenceImages = Array.isArray(draft.images) ? draft.images.filter((image) => image && image.dataUrl) : [];
      renderReferenceImages();
      if (draft.options) {
      }
      if (draft.document) {
        currentDocument = draft.document;
        dom.enhanceEnglish = currentDocument.fullPromptEnglish || '';
        lockedSections = new Set(draft.lockedSections || []);
        renderEnhancement(currentDocument);
        setEnhanceStatus('已恢复上次未完成的优化', 'success');
      }
      restoreEnhanceTask(draft.savedAt || 0);
    });
  }
  function loadPendingEdit(pendingValue) {
    const consume = (pending) => {
      if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) return;
      if (Number(pending.createdAt || 0) <= lastPendingEditAt) return;
      lastPendingEditAt = Number(pending.createdAt || Date.now());
      chrome.runtime.sendMessage({ action: 'cancel_enhance_task' });
      stopEnhanceProgress();
      switchTab('enhance');
      currentDocument = null;
      lockedSections = new Set();
      referenceImages = [];
      renderReferenceImages();
      if (dom.enhanceResult) dom.enhanceResult.style.display = 'none';
      if (dom.enhanceInstruction) dom.enhanceInstruction.value = '';
      importedBasePrompt = pending.source === 'reverse_result' && pending.preserveNonProduct ? String(pending.prompt || '') : '';
      dom.enhanceInput.value = pending.prompt || '';
      dom.enhanceRequest.value = '';
      dom.enhancePreserve.value = '';
      setPreserveExpanded(false);
      setEnhanceStatus('已接收网页反推结果，请添加替换要求或参考产品图', 'success');
      if (!pending.imageUrl) { saveEnhanceDraft(); chrome.storage.local.remove(['pr_pending_edit']); return; }
      chrome.runtime.sendMessage({ action: 'fetchImage', imageUrl: pending.imageUrl }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          saveEnhanceDraft();
          return setEnhanceStatus(`提示词已载入，但网页图片读取失败：${(response && response.error) || chrome.runtime.lastError?.message || '请手动上传图片'}`, 'error');
        }
        normalizeReferenceImage({ id: String(Date.now()), name: '网页参考图', mimeType: response.data.mimeType || 'image/jpeg', dataUrl: `data:${response.data.mimeType || 'image/jpeg'};base64,${response.data.base64}` }).then((image) => {
          referenceImages = [image]; renderReferenceImages(); saveEnhanceDraft();
        }).catch(() => setEnhanceStatus('网页图片格式不受本地模型支持，请重新上传 JPG 或 PNG', 'error'));
      });
      chrome.storage.local.remove(['pr_pending_edit']);
    };
    if (pendingValue) consume(pendingValue);
    else chrome.storage.local.get(['pr_pending_edit'], (items) => consume(items.pr_pending_edit));
  }

  function normalizeReferenceImage(item) {
    if (!item || !item.dataUrl) return Promise.reject(new Error('缺少图片数据'));
    return new Promise((resolve, reject) => {
      const image = new Image(); image.onerror = () => reject(new Error('图片格式无法转换'));
      image.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0);
        resolve({ ...item, mimeType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.82), compressed: true });
      };
      image.src = item.dataUrl;
    });
  }
  async function saveEnhanceVersion() {
    if (!currentDocument) return setEnhanceStatus('暂无可保存的结果', 'error');
    const historyImages = await Promise.all(referenceImages.map(createHistoryThumbnail));
    chrome.storage.local.get(['pr_prompt_history'], (items) => { const history = Array.isArray(items.pr_prompt_history) ? items.pr_prompt_history : []; history.unshift({ id: String(Date.now()), createdAt: Date.now(), sourceInput: dom.enhanceInput.value.trim(), editRequest: dom.enhanceRequest.value.trim(), preserveInstruction: dom.enhancePreserve.value.trim(), document: currentDocument, images: historyImages, model: currentDocument.metadata?.model || '', options: enhancementOptions() }); chrome.storage.local.set({ pr_prompt_history: history.slice(0, 20) }, () => { if (chrome.runtime.lastError) setEnhanceStatus('版本保存失败，本地空间可能已满', 'error'); else setEnhanceStatus('版本已保存（参考图以缩略图保存）', 'success'); }); });
  }
  function createHistoryThumbnail(item) {
    return new Promise((resolve) => {
      if (!item || !item.dataUrl) return resolve(item);
      const image = new Image();
      image.onerror = () => resolve(item);
      image.onload = () => {
        const scale = Math.min(1, 420 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve({ ...item, mimeType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.62), width: canvas.width, height: canvas.height, compressed: true, historyThumbnail: true });
      };
      image.src = item.dataUrl;
    });
  }
  function loadEnhanceHistory() {
    chrome.storage.local.get(['pr_prompt_history'], (items) => { const history = items.pr_prompt_history || []; dom.enhanceHistory.innerHTML = history.length ? history.map((item) => `<div class="history-item"><span class="history-title">${escapeHtml(item.sourceInput || '未命名提示词')}</span><span class="history-time">${new Date(item.createdAt).toLocaleDateString()}</span><button class="btn-secondary" data-history-load="${item.id}">恢复</button><button class="btn-secondary" data-history-delete="${item.id}">删除</button></div>`).join('') : '<div class="field-hint">还没有保存的版本</div>'; dom.enhanceHistory.querySelectorAll('[data-history-load]').forEach((b) => b.addEventListener('click', () => restoreHistory(b.dataset.historyLoad))); dom.enhanceHistory.querySelectorAll('[data-history-delete]').forEach((b) => b.addEventListener('click', () => deleteHistory(b.dataset.historyDelete))); });
  }
 function restoreHistory(id) { chrome.storage.local.get(['pr_prompt_history'], (items) => { const history = Array.isArray(items.pr_prompt_history) ? items.pr_prompt_history : []; const item = history.find((x) => x && x.id === id); if (!item || !item.document || typeof item.document !== 'object') return setEnhanceStatus('该历史版本数据不完整，无法恢复', 'error'); dom.enhanceInput.value = item.sourceInput || ''; dom.enhanceRequest.value = item.editRequest || ''; dom.enhancePreserve.value = item.preserveInstruction || ''; setPreserveExpanded(Boolean(dom.enhancePreserve.value)); referenceImages = Array.isArray(item.images) ? item.images.filter((image) => image && image.dataUrl) : []; currentDocument = JSON.parse(JSON.stringify(item.document)); lockedSections = new Set(); dom.enhanceResult.style.display = ''; dom.enhanceEnglish = currentDocument.fullPromptEnglish || ''; renderReferenceImages(); renderEnhancement(currentDocument); saveEnhanceDraft(); setEnhanceStatus('已恢复历史版本', 'success'); }); }
  function deleteHistory(id) { chrome.storage.local.get(['pr_prompt_history'], (items) => { chrome.storage.local.set({ pr_prompt_history: (items.pr_prompt_history || []).filter((x) => x.id !== id) }, loadEnhanceHistory); }); }

  // ============ 收藏数据同步 ============
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[FAV_KEY]) {
      const list = changes[FAV_KEY].newValue || [];
      const favTabActive = document.getElementById('tab-favorites').classList.contains('active');
      if (favTabActive) renderFavorites(list); else updateBadge(list.length);
    }
    if (changes[HISTORY_KEY]) renderHistory(changes[HISTORY_KEY].newValue || []);
    if (changes.pr_pending_edit && changes.pr_pending_edit.newValue) loadPendingEdit(changes.pr_pending_edit.newValue);
  }

  function loadHistory() { chrome.storage.local.get([HISTORY_KEY], (items) => renderHistory(items[HISTORY_KEY] || [])); }
  function renderHistory(list) {
    const records = Array.isArray(list) ? list : [];
    dom.historyCount.textContent = records.length;
    dom.historyTabBadge.textContent = records.length;
    dom.historyTabBadge.style.display = records.length ? '' : 'none';
    dom.historyList.style.display = records.length ? '' : 'none';
    dom.historyEmpty.style.display = records.length ? 'none' : '';
    dom.historyFooter.style.display = records.length ? '' : 'none';
    dom.historyList.innerHTML = records.map((item) => '<div class="fav-card" data-history-id="' + escapeAttr(item.id || '') + '"><div class="fav-body"><p class="fav-prompt">' + escapeHtml(item.prompt || '') + '</p><div class="fav-meta"><span>反推结果</span><span class="fav-meta-dot">·</span><span>' + formatTime(item.createdAt) + '</span></div></div><div class="fav-actions"><button class="fav-action-btn" data-history-act="copy">' + ICONS.copy + '</button><button class="fav-action-btn danger" data-history-act="del">' + ICONS.trash + '</button></div></div>').join('');
  }
  dom.historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-action-btn'); const card = btn && btn.closest('.fav-card'); if (!card) return;
    chrome.storage.local.get([HISTORY_KEY], (items) => { const list = items[HISTORY_KEY] || []; const item = list.find((x) => x.id === card.dataset.historyId); if (!item) return;
      if (btn.dataset.historyAct === 'copy') copyText(item.prompt || '').then(() => showPopupToast('已复制提示词'));
      else if (window.confirm('删除这条历史记录吗？')) chrome.storage.local.set({ [HISTORY_KEY]: list.filter((x) => x.id !== item.id) });
    });
  });

  // ============ 收藏夹渲染 ============
  function loadFavorites() {
    chrome.storage.local.get([FAV_KEY], (items) => {
      renderFavorites(items[FAV_KEY] || []);
    });
  }

  function renderFavorites(list) {
    const count = list.length;
    // 计数 + 进度条
    dom.favCount.textContent = count;
    updateBadge(count);
    const pct = FAV_MAX > 0 ? (count / FAV_MAX) * 100 : 0;
    dom.capacityFill.style.width = pct + '%';
    dom.capacityFill.classList.remove('warn', 'full');
    if (count >= FAV_MAX) dom.capacityFill.classList.add('full');
    else if (count >= 12) dom.capacityFill.classList.add('warn');
    // 满状态预警 + 底部清空栏
    const isFull = count >= FAV_MAX;
    dom.capacityWarn.style.display = isFull ? '' : 'none';
    dom.favFooter.style.display = isFull ? '' : 'none';
    resetClearBtn();
    // 空状态切换
    dom.favEmpty.style.display = count === 0 ? '' : 'none';
    dom.favList.style.display = count === 0 ? 'none' : '';
    // 渲染卡片
    dom.favList.innerHTML = list.map(buildFavCard).join('');
  }

  function updateBadge(count) {
    dom.favTabBadge.textContent = count;
    dom.favTabBadge.style.display = count > 0 ? '' : 'none';
    dom.favTabBadge.classList.toggle('full', count >= FAV_MAX);
  }

  function buildFavCard(f) {
    const timeText = formatTime(f.createdAt);
    const modelLabel = escapeHtml(f.modelLabel || f.model || '未知模型');
    const prompt = escapeHtml(f.prompt || '');
    const thumb = f.thumbUrl
      ? '<img src="' + escapeAttr(f.thumbUrl) + '" alt="" onerror="this.style.display=\'none\'">'
      : '';
    return '' +
      '<div class="fav-card" data-id="' + escapeAttr(f.id || '') + '">' +
        '<div class="fav-thumb">' + thumb + '</div>' +
        '<div class="fav-body">' +
          '<p class="fav-prompt">' + prompt + '</p>' +
          '<div class="fav-meta">' +
            '<span class="fav-meta-model">' + modelLabel + '</span>' +
            '<span class="fav-meta-dot">·</span>' +
            '<span>' + timeText + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="fav-actions">' +
          '<button class="fav-action-btn" data-act="copy" title="复制提示词">' + ICONS.copy + '</button>' +
          '<button class="fav-action-btn danger" data-act="del" title="删除">' + ICONS.trash + '</button>' +
        '</div>' +
      '</div>';
  }

  // 卡片操作（事件委托）
  function bindFavCardEvents() {
    dom.favList.addEventListener('click', onFavListClick);
  }

  function onFavListClick(e) {
    const btn = e.target.closest('.fav-action-btn');
    if (!btn) return;
    const card = btn.closest('.fav-card');
    if (!card) return;
    const id = card.dataset.id;
    if (btn.dataset.act === 'copy') {
      const promptEl = card.querySelector('.fav-prompt');
      copyText(promptEl ? promptEl.textContent : '').then(() => {
        btn.classList.add('copied');
        btn.innerHTML = ICONS.check;
        showPopupToast('已复制提示词');
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = ICONS.copy;
        }, 1500);
      });
    } else if (btn.dataset.act === 'del') {
      removeFav(id);
    }
  }

  function removeFav(id) {
    chrome.storage.local.get([FAV_KEY], (items) => {
      const list = items[FAV_KEY] || [];
      const next = list.filter((f) => f.id !== id);
      const obj = {};
      obj[FAV_KEY] = next;
      chrome.storage.local.set(obj, () => {
        renderFavorites(next);
        showPopupToast('已删除');
      });
    });
  }

  // 清空收藏（二次确认，避免误触）
  function clearAllFav() {
    if (dom.btnClearFav.dataset.confirm === '1') {
      const obj = {};
      obj[FAV_KEY] = [];
      chrome.storage.local.set(obj, () => {
        renderFavorites([]);
        resetClearBtn();
        showPopupToast('已清空全部收藏');
      });
    } else {
      dom.btnClearFav.dataset.confirm = '1';
      dom.btnClearFav.innerHTML = ICONS.warn + '<span>确认清空？</span>';
      dom.btnClearFav.style.background = '#FEE2E2';
      dom.btnClearFav.style.borderColor = '#FECACA';
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = setTimeout(resetClearBtn, 3000);
    }
  }

  function resetClearBtn() {
    if (!dom.btnClearFav) return;
    dom.btnClearFav.dataset.confirm = '';
    dom.btnClearFav.innerHTML = ICONS.trash + '<span>清空收藏</span>';
    dom.btnClearFav.style.background = '';
    dom.btnClearFav.style.borderColor = '';
  }

  // ============ 工具函数 ============
  function formatTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '小时前';
    const day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 7) return day + '天前';
    const wk = Math.floor(day / 7);
    if (wk < 5) return wk + '周前';
    const mo = Math.floor(day / 30);
    if (mo < 12) return mo + '个月前';
    return Math.floor(day / 365) + '年前';
  }

  function copyText(text) {
    return new Promise((resolve) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve).catch(() => {
          fallbackCopy(text);
          resolve();
        });
      } else {
        fallbackCopy(text);
        resolve();
      }
    });
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function showPopupToast(msg) {
    let toast = document.querySelector('.popup-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'popup-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 1800);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // SVG 图标
  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5C5 3.9 5.9 3 7 3H15"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  // 启动
  init();
})();
