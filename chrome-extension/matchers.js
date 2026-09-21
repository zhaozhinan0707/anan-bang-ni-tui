/**
 * 提示词来源抓取规则（可扩展）
 * ------------------------------------------------------------------
 * 新增来源：在 PROMPT_MATCHERS 数组中追加一个 matcher 对象即可。
 * matcher.extract() 返回 null（未命中）或：
 *   { prompt: string, negativePrompt?: string, params?: object, sourceTool?: string }
 *
 * 提示：各站点的 DOM 选择器需要按真实页面结构微调。
 * 建议打开目标页面后，在 DevTools 中检查提示词所在元素，更新下方的 selector / 提取逻辑。
 */
const PROMPT_MATCHERS = [
  {
    name: "Lovart",
    extract() {
      if (!/lovart/i.test(location.hostname)) return null;
      // 常见结构示例：图片详情页中存在包含完整提示词的元素。
      const candidates = [
        document.querySelector("[data-prompt], [data-prompt-text], [data-testid*='prompt' i]"),
        document.querySelector("textarea[placeholder*='prompt' i], textarea[placeholder*='提示词']"),
        document.querySelector('[class*="prompt"]'),
        document.querySelector('[class*="Prompt"]')
      ];
      for (const el of candidates) {
        if (!el) continue;
        const text = (el.value || el.getAttribute("data-prompt") || el.textContent || "").trim();
        if (text && isPromptLike(text)) {
          return { prompt: text, negativePrompt: labeledValue("负面提示词|Negative Prompt"), params: readParams(), sourceTool: "Lovart" };
        }
      }
      return null;
    }
  },
  {
    name: "哩布哩布 LiblibAI",
    extract() {
      if (!/liblib/i.test(location.hostname)) return null;
      // TODO: 按哩布哩布（LiblibAI）真实页面结构补充选择器。
      // 常见结构示例：作品详情页有"提示词 / 参数"区块，或图片信息 JSON。
      const candidates = [
        document.querySelector("[data-prompt], [data-prompt-text], [data-testid*='prompt' i]"),
        document.querySelector('[class*="prompt"]'),
        document.querySelector('[class*="Prompt"]'),
        document.querySelector('[class*="info"] code'),
        document.querySelector("textarea.prompt")
      ];
      for (const el of candidates) {
        if (!el) continue;
        const text = (el.textContent || el.value || "").trim();
        if (text && isPromptLike(text)) {
          return { prompt: text, negativePrompt: labeledValue("负面提示词|Negative Prompt"), params: readParams(), sourceTool: "哩布哩布" };
        }
      }
      return null;
    }
  },
  {
    name: "花瓣网 Huaban",
    extract() {
      if (!/huaban\.com/i.test(location.hostname) && !/hb\.aicdn/i.test(location.hostname)) return null;
      // 花瓣：图片旁的描述文本（.pin-description / 描述区块），多为中文标题描述
      const candidates = [
        document.querySelector(".pin-description"),
        document.querySelector('[class*="description"]'),
        document.querySelector('[class*="Description"]'),
        document.querySelector('[data-description]'),
        document.querySelector(".pin-name"),
        document.querySelector('[class*="title"] span')
      ];
      for (const el of candidates) {
        if (!el) continue;
        const text = (el.textContent || el.getAttribute("data-description") || "").trim();
        if (text && text.length >= 4 && text.length < 2000) {
          return { prompt: text, params: { sourceTool: "花瓣网" } };
        }
      }
      // 兜底：当前页标题附近（详情页 description meta）
      const meta = document.querySelector('meta[name="description"]');
      if (meta) {
        const t = (meta.getAttribute("content") || "").trim();
        if (t && t.length >= 4 && t.length < 2000) return { prompt: t, params: { sourceTool: "花瓣网" } };
      }
      return null;
    }
  },
  {
    name: "Pinterest",
    extract() {
      if (!/pinterest/i.test(location.hostname) && !/pinimg/i.test(location.hostname)) return null;
      // Pinterest：pin 卡片的描述/标题（英文或中文）
      const candidates = [
        document.querySelector('[data-test-id="pin-description"]'),
        document.querySelector('[data-test-id="main-feed-news-feed"] [data-test-id="pinrep-render"]'),
        document.querySelector('[data-test-id="non-story-pin-embed"] [data-test-id="richPinInformation"]'),
        document.querySelector('[data-test-id="pin-title"]'),
        document.querySelector('[class*="description"]'),
        document.querySelector('[class*="Description"]'),
        document.querySelector('meta[name="description"]')
      ];
      for (const el of candidates) {
        if (!el) continue;
        const text = (el.textContent || el.getAttribute("content") || "").trim();
        if (text && text.length >= 4 && text.length < 2000) {
          return { prompt: text, params: { sourceTool: "Pinterest" } };
        }
      }
      return null;
    }
  },
  {
    name: "通用启发式",
    extract() {
      // 兜底：在页面代码块 / 文本域中找一段"看起来像提示词"的文本。
      const elements = Array.from(
        document.querySelectorAll("code, pre, textarea, [class*='prompt'], [class*='Prompt']")
      ).slice(0, 30);
      for (const el of elements) {
        const text = (el.value !== undefined ? el.value : el.textContent || "").trim();
        if (text && isPromptLike(text) && text.length >= 8) {
          return { prompt: text, params: { sourceTool: "手动识别" } };
        }
      }
      return null;
    }
  }
];

function labeledValue(labelPattern) {
  const re = new RegExp(`^(?:${labelPattern})$`, "i");
  for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,span,div,label")) {
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("").trim();
    if (!own || !re.test(own)) continue;
    const next = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
    const value = next && (next.value || next.textContent || "").trim();
    if (value && value.length < 4000) return value;
  }
  return "";
}

function readParams() {
  const params = {};
  for (const label of ["尺寸|Size", "采样器|Sampler", "Steps", "CFG", "Seed"]) {
    const value = labeledValue(label);
    if (value) params[label.split("|")[0]] = value;
  }
  return params;
}

/** 启发式判断：是否像一条 AI 绘画提示词 / 图片描述（中英文混合均可）。
 *  放宽了对 ASCII 比例的要求——花瓣网、Pinterest 的标题描述常是纯中文，
 *  只要长度足够、词数够、且不是明显导航/按钮短句，就接受（用户可事后编辑）。 */
function isPromptLike(text) {
  if (!text || text.length < 8 || text.length > 4000) return false;
  // 排除明显导航 / 按钮 / 无意义短句
  const t = text.trim();
  if (/^(查看更多|加载更多|立即下载|保存|分享|收藏|下载|登录|注册|下一页|上一页|全部|更多|取消|确定|复制|关闭|点赞|评论|转发|关注|添加|提交|知道了|明白了|稍后再说|跳过|跳过广告)$/.test(t)) return false;
  const words = text.split(/[\s,，。.!?！？、;；:：·]/).filter(Boolean);
  if (words.length < 2) return false;
  const ascii = words.filter(w => /^[A-Za-z0-9_\-.,()":'/]+$/.test(w)).length;
  // 英文提示词（原来规则）或含中文的描述/标题都算
  if (ascii / words.length > 0.5) return true;
  if (/[\u4e00-\u9fa5]/.test(text) && text.length >= 8) return true;
  return false;
}
