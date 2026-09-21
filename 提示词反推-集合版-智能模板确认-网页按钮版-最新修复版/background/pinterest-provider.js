class ProviderError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ProviderError'; this.code = code; this.details = details; }
}
function classifyResponse(status) {
  if (status === 401) return new ProviderError('AUTH_REQUIRED', '请先在 Chrome 中登录 Pinterest。');
  if (status === 403) return new ProviderError('ACCESS_DENIED', 'Pinterest 拒绝了请求；已停止自动重试。');
  if (status === 429) return new ProviderError('RATE_LIMITED', 'Pinterest 请求过于频繁，请稍后再试。');
  if (status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', 'Pinterest 服务暂时不可用。');
  return new ProviderError('REQUEST_FAILED', `Pinterest 请求失败（HTTP ${status}）。`);
}


function firstImage(images = {}) {
  const candidate = images.orig || images['736x'] || images['474x'] || images['236x'] || Object.values(images).find(Boolean);
  if (typeof candidate === 'string') return { url: candidate };
  if (candidate?.url) return { ...candidate, url: upgradePinterestImageUrl(candidate.url) };
  if (candidate?.images) return firstImage(candidate.images);
  return undefined;
}

function upgradePinterestImageUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/\/(?:236x|474x|564x|600x|736x|750x|originals)\//, '/originals/');
}
function resultArray(payload) {
  const data = payload?.resource_response?.data ?? payload?.resource?.response?.data ?? payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.pins)) return data.pins;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.data)) return data.data;
  const found = [];
  walk(data, (value) => {
    if (value && typeof value === 'object' && (value.id || value.pin_id || value.pinId) && imageSource(value)) found.push(value);
  });
  return found;
}

function imageSource(value) {
  return value.images || value.image || value.image_url || value.imageUrl || value.grid_image || value.gridImage || value.image_large_url || value.image_medium_url || value.image_square_url || value.story_pin_data?.pages;
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit, seen));
  else Object.values(value).forEach((item) => walk(item, visit, seen));
}
function parsePinterestResponse(payload) {
  const seen = new Set(); const results = [];
  for (const item of resultArray(payload)) {
    const pin = item?.pin || item; const pinId = String(pin?.id || pin?.pin_id || pin?.pinId || '');
    const images = typeof pin?.images === 'string' ? { orig: { url: pin.images } } : (pin?.images || {
      orig: pin?.image_large_url ? { url: pin.image_large_url, width: pin.image_large_size_pixels?.[0], height: pin.image_large_size_pixels?.[1] } : undefined,
      '474x': pin?.image_medium_url ? { url: pin.image_medium_url, width: pin.image_medium_size_pixels?.[0], height: pin.image_medium_size_pixels?.[1] } : undefined,
      '236x': pin?.image_square_url ? { url: pin.image_square_url, width: pin.image_square_size_pixels?.[0], height: pin.image_square_size_pixels?.[1] } : undefined
    });
    const image = firstImage(images) || firstImage({ orig: { url: pin?.image_url || pin?.imageUrl || pin?.grid_image } });
    if (!pinId || !image?.url || seen.has(pinId)) continue;
    seen.add(pinId);
    results.push({ pinId, title: pin.title || pin.grid_title || '', description: pin.description || '', imageUrl: image.url,
      thumbnailUrl: upgradePinterestImageUrl(images?.['236x']?.url || image.url), pinterestUrl: `https://www.pinterest.com/pin/${pinId}/`,
      sourceUrl: pin.link || '', author: pin.pinner?.full_name || pin.pinner?.username || '', width: image.width, height: image.height });
  }
  return { provider: 'pinterest', results, cursor: payload?.resource_response?.bookmark || payload?.resource_response?.data?.bookmark || payload?.data?.bookmark || payload?.bookmark || undefined };
}

function summarizePinterestResponse(payload) {
  const summary = [];
  walk(payload, (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value).slice(0, 30);
      if (keys.some((key) => /pin|image|result|bookmark|resource|data/i.test(key))) {
        summary.push({ keys, arrayLengths: Object.fromEntries(keys.filter((key) => Array.isArray(value[key])).map((key) => [key, value[key].length])) });
      }
    }
  });
  return summary.slice(0, 20);
}





const SOURCE_URL = '/lens-search/';

class PinterestProvider {
  constructor() { this.lastSearch = null; }

  async search(image, options = {}) {
    const session = await getPinterestTab(); const tab = session.tab;
    const imageDataUrl = await blobToDataUrl(image.blob);
    const crop = normalizeCrop(options.crop);
    try {
      const response = await runInPinterest(tab.id, pinterestLensRequest, [{ imageDataUrl, crop }]);
      this.lastSearch = session.temporary ? null : { tabId: tab.id, uploadUrl: response.uploadUrl, crop };
      return parsePage(response.search);
    } finally { if (session.temporary && tab.id) chrome.tabs.remove(tab.id).catch(() => {}); }
  }

  async nextPage(cursor) {
    if (!cursor || !this.lastSearch) throw new ProviderError('NO_PAGINATION_CONTEXT', '当前搜索没有可用的下一页。');
    const { tabId, uploadUrl, crop } = this.lastSearch;
    const response = await runInPinterest(tabId, pinterestLensNextPage, [{ uploadUrl, crop, cursor }]);
    return parsePage(response);
  }
}

function parsePage(payload) {
  const page = parsePinterestResponse(payload);
  if (!page.results.length) throw new ProviderError('EMPTY_OR_CHANGED_RESPONSE', 'Pinterest 已响应，但没有解析到相似图片；接口结构可能发生变化。', { responseShape: summarizePinterestResponse(payload) });
  return page;
}

async function getPinterestTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.pinterest.com/*'] });
  const preferred = tabs.find((tab) => tab.url?.includes('/lens-search/')) || tabs[0];
  if (preferred?.id) return { tab: preferred, temporary: false };
  const tab = await chrome.tabs.create({ url: 'https://www.pinterest.com/lens-search/', active: false });
  await waitForTab(tab.id);
  return { tab, temporary: true };
}

async function waitForTab(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Pinterest 页面加载超时。')), 15000);
    const listener = (id, info) => id === tabId && info.status === 'complete' && finish();
    function finish(error) {
      clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runInPinterest(tabId, func, args) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    if (!result?.ok) throw new ProviderError(result?.code || 'PINTEREST_REQUEST_FAILED', result?.message || 'Pinterest 请求失败。', result?.details);
    return result.data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('PINTEREST_TAB_UNAVAILABLE', '无法在 Pinterest 登录页面中发起搜索，请打开 Pinterest 并确认已经登录。', { cause: error.message });
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
}

function normalizeCrop(crop) {
  if (!crop) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: clamp(crop.x), y: clamp(crop.y), w: clamp(crop.width ?? crop.w, 0.01), h: clamp(crop.height ?? crop.h, 0.01) };
}
function clamp(value, minimum = 0) { return Math.max(minimum, Math.min(1, Number(value) || 0)); }

// Runs in Pinterest's page context. Session credentials never leave that page.
async function pinterestLensRequest({ imageDataUrl, crop }) {
  try {
    const image = dataUrlToBlob(imageDataUrl);
    const form = new FormData();
    form.append('image', image, 'visual-search.png');
    for (const [key, value] of Object.entries({ x: crop.x, y: crop.y, w: crop.w, h: crop.h, crop_source: 5, source_type: 1 })) form.append(key, String(value));
    const uploadPayload = await (await request('/upload-lens-image/', { method: 'POST', body: form })).json();
    const uploadUrl = findUploadUrl(uploadPayload);
    if (!uploadUrl) return fail('UPLOAD_RESPONSE_CHANGED', 'Pinterest 上传成功，但响应中没有找到图片地址。');
    const search = await searchLens(uploadUrl, crop);
    return { ok: true, data: { uploadUrl, search } };
  } catch (error) { return fail(error.code || 'PINTEREST_REQUEST_FAILED', error.message, error.details); }

  async function searchLens(uploadUrl, crop, cursor) {
    const data = { options: { url: '/v3/visual_search/lens/search/', data: { url: uploadUrl, x: crop.x, y: crop.y, w: crop.w, h: crop.h, crop_source: 5, source_type: 1 } }, context: {} };
    if (cursor) data.options.bookmarks = [cursor];
    const body = new URLSearchParams({ data: JSON.stringify(data), source_url: '/lens-search/' });
    return (await request('/resource/ApiResource/get/', { method: 'POST', body })).json();
  }
  async function request(path, init) {
    const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    const headers = { 'X-Requested-With': 'XMLHttpRequest' }; if (csrf) headers['X-CSRFToken'] = decodeURIComponent(csrf);
    const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) }, credentials: 'include' });
    if (!response.ok) {
      const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : 'PINTEREST_HTTP_ERROR';
      const error = new Error(`Pinterest 请求失败（HTTP ${response.status}）。`); error.code = code; error.details = { status: response.status }; throw error;
    }
    return response;
  }
  function findUploadUrl(value, seen = new Set()) {
    if (typeof value === 'string' && (value.startsWith('s3://pinterest-media-upload/') || value.includes('pinterest-media-upload'))) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) return null; seen.add(value);
    for (const child of Object.values(value)) { const found = findUploadUrl(child, seen); if (found) return found; }
    return null;
  }
  function dataUrlToBlob(value) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value || '');
    if (!match) { const error = new Error('扩展传入的图片数据无效。'); error.code = 'INVALID_IMAGE_DATA'; throw error; }
    const mimeType = match[1] || 'application/octet-stream';
    const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  }
  function fail(code, message, details) { return { ok: false, code, message, details }; }
}

async function pinterestLensNextPage({ uploadUrl, crop, cursor }) {
  try {
    const data = { options: { url: '/v3/visual_search/lens/search/', bookmarks: [cursor], data: { url: uploadUrl, x: crop.x, y: crop.y, w: crop.w, h: crop.h, crop_source: 5, source_type: 1 } }, context: {} };
    const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    const headers = { 'X-Requested-With': 'XMLHttpRequest' }; if (csrf) headers['X-CSRFToken'] = decodeURIComponent(csrf);
    const response = await fetch('/resource/ApiResource/get/', { method: 'POST', credentials: 'include', headers, body: new URLSearchParams({ data: JSON.stringify(data), source_url: '/lens-search/' }) });
    if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, message: `Pinterest 翻页失败（HTTP ${response.status}）。` };
    return { ok: true, data: await response.json() };
  } catch (error) { return { ok: false, code: 'PINTEREST_REQUEST_FAILED', message: error.message }; }
}

