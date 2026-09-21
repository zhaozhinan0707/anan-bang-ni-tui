const taskId = new URLSearchParams(location.search).get('task');
const title = document.getElementById('title'); const summary = document.getElementById('summary');
const details = document.getElementById('details'); const results = document.getElementById('results'); const next = document.getElementById('next');
let cursor;
poll();
async function poll() {
  const stored = await chrome.storage.local.get(`visualSearch:${taskId}`); const task = stored[`visualSearch:${taskId}`];
  if (!task) return renderError('TASK_NOT_FOUND', '搜索任务不存在或已过期。');
  if (task.status === 'preparing') { title.textContent = '正在获取图片…'; return setTimeout(poll, 300); }
  if (task.status === 'searching') { title.textContent = '正在搜索 Pinterest…'; renderCapture(task.capture); return setTimeout(poll, 500); }
  if (task.status === 'failed') return renderError('SEARCH_FAILED', task.error || '搜索失败');
  title.textContent = '找到相似灵感'; summary.textContent = `共 ${task.results.length} 个结果 · 左键打开 Pinterest Pin；右键选择“发送图片到 Prompt Vault 画布”`; renderResults(task.results); cursor = task.cursor; next.hidden = !cursor;
}
function renderCapture(capture) { if (capture) details.textContent = `图片：${capture.width}×${capture.height} · ${capture.mimeType} · ${capture.captureMethod}`; }
function renderError(code = 'UNEXPECTED', message = '未知错误', capture, errorDetails = {}) {
  title.textContent = '暂时无法搜索'; summary.textContent = message; details.classList.add('error');
  const extra = code === 'AUTH_REQUIRED' || code === 'FORBIDDEN' ? '请打开 Pinterest，确认账号处于登录状态后再试。' : '扩展不会自动重试 401、403 或 429。';
  const diagnostic = taskDiagnostic(code, errorDetails);
  details.innerHTML = `<strong>${escapeHtml(code)}</strong><p>${escapeHtml(extra)}</p>${capture ? `<p>图片采集已成功：${capture.width}×${capture.height}，${capture.captureMethod}</p>` : ''}${diagnostic}`;
}
function taskDiagnostic(code, errorDetails) {
  if (code !== 'EMPTY_OR_CHANGED_RESPONSE') return '';
  const shape = errorDetails?.responseShape;
  if (!shape) return '<p>当前正在收集返回字段摘要，以便自动适配 Pinterest 的实际结构。</p>';
  return `<details><summary>返回结构摘要</summary><pre>${escapeHtml(JSON.stringify(shape, null, 2))}</pre></details>`;
}
function renderResults(items, append = false) {
  const html = items.map((item) => `<article class="card"><a href="${safeUrl(item.pinterestUrl)}" target="_blank" rel="noreferrer"><img src="${safeUrl(item.imageUrl || item.thumbnailUrl)}" alt="" loading="lazy"></a><div><h2>${escapeHtml(item.title || 'Pinterest Pin')}</h2><p>${escapeHtml(item.author || '')}</p><a href="${safeUrl(item.pinterestUrl)}" target="_blank" rel="noreferrer">打开 Pin →</a></div></article>`).join('');
  if (append) results.insertAdjacentHTML('beforeend', html); else results.innerHTML = html;
}
next.onclick = async () => { next.disabled = true; const response = await chrome.runtime.sendMessage({ type: 'next-page', cursor }); next.disabled = false; if (!response.ok) return renderError(response.code, response.message); renderResults(response.page.results, true); cursor = response.page.cursor; next.hidden = !cursor; };
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } }
