(() => {
  if (window.__inspirationPickerLoaded) return;
  window.__inspirationPickerLoaded = true;

  let active = false;
  let highlighted = null;
  const style = document.createElement('style');
  style.textContent = '.inspiration-pickable{outline:2px solid #7c3aed!important;outline-offset:3px;cursor:crosshair!important}';

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'start-selection') start();
  });

  function start() {
    if (active) return;
    active = true;
    document.documentElement.appendChild(style);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  function stop() {
    active = false;
    highlighted?.classList.remove('inspiration-pickable');
    highlighted = null;
    style.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  }

  function candidateAt(target) {
    return target.closest?.('img,canvas') || findBackgroundElement(target);
  }

  function findBackgroundElement(target) {
    let node = target;
    while (node && node !== document.documentElement) {
      if (getComputedStyle(node).backgroundImage !== 'none') return node;
      node = node.parentElement;
    }
    return null;
  }

  function onMove(event) {
    const candidate = candidateAt(event.target);
    highlighted?.classList.remove('inspiration-pickable');
    highlighted = candidate;
    highlighted?.classList.add('inspiration-pickable');
  }

  function onClick(event) {
    const candidate = candidateAt(event.target);
    if (!candidate) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = candidate.getBoundingClientRect();
    const sourceImageUrl = candidate instanceof HTMLImageElement ? candidate.currentSrc || candidate.src : undefined;
    const payload = {
      sourcePageUrl: location.href,
      sourceImageUrl,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
    };
    stop();
    chrome.runtime.sendMessage({ type: 'visual-search', payload }).then((result) => {
      if (!result?.ok) alert(`搜索任务创建失败：${result?.error || '未知错误'}`);
    });
  }

  function onKeydown(event) {
    if (event.key === 'Escape') stop();
  }
})();


