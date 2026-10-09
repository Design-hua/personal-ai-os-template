// lib/vision.js
// 图片识别：硅基流动视觉模型（Qwen3-VL），OpenAI 兼容 /v1/chat/completions
// 零新增 npm 依赖：Node 18 内置 fetch
//
// 用途：
//   1. 工作台聊天框发图片 → 识别文字/内容
//   2. 抖音完整链路 → 一次识别多张关键帧（recognizeMany）

'use strict';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createVision(opts) {
  const cfg = {
    apiKey: opts.apiKey || '',
    baseUrl: opts.baseUrl || 'https://api.siliconflow.cn/v1',
    model: opts.model || 'Qwen/Qwen3-VL-32B-Instruct',
  };

  function isReady() {
    return Boolean(cfg.apiKey);
  }

  const DEFAULT_PROMPT = '请仔细识别这张图片里的所有文字内容，按原文顺序逐行输出，保留标点和换行。如果图片中主要不是文字（如照片、截图、图表），请用简洁的中文描述图片内容（2-4 句）。只输出识别结果或描述，不要加任何解释。';

  // 统一调用：4xx（请求本身有错）立即报错；5xx/上游抖动/网络错误自动重试 3 次
  async function postVision(body) {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      let resp;
      try {
        resp = await fetch(cfg.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body),
        });
      } catch (e) {
        last = '视觉识别网络请求失败: ' + e.message;
        await sleep(900 * (attempt + 1));
        continue;
      }
      let json = null;
      try { json = await resp.json(); } catch (e) { /* 非 JSON */ }
      if (resp.status === 200 && json && json.choices) {
        const c = json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        return String(c || '').trim();
      }
      const msg = (json && json.error && (json.error.message || json.error.code)) || (json && json.message) || ('HTTP ' + resp.status);
      last = '视觉识别失败: ' + msg;
      // 5xx 或上游"Unknown error/过载/超时"才重试；400/401/404 等请求错误直接失败
      const retriable = resp.status >= 500 || /Unknown error|50507|overloaded|timeout|rate.?limit|temporar/i.test(String(msg));
      if (!retriable) break;
      await sleep(900 * (attempt + 1));
    }
    throw new Error(last || '视觉识别失败');
  }

  /**
   * 识别单张图片
   * @param {string} base64 图片 base64（可带 data: 前缀，也可不带）
   * @param {string} [mimeType] 可选，默认 image/jpeg
   * @param {string} [customPrompt] 提供时替代默认提示词
   */
  async function recognize(base64, mimeType, customPrompt) {
    if (!cfg.apiKey) throw new Error('未配置 SILICONFLOW_API_KEY');
    if (!base64) throw new Error('图片内容为空');
    const clean = base64.replace(/^data:image\/[a-zA-Z0-9.+_-]+;base64,/, '');
    const mime = mimeType || 'image/jpeg';
    return postVision({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: (customPrompt && String(customPrompt).trim()) || DEFAULT_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${clean}` } },
          ],
        },
      ],
      temperature: 0.1,
      stream: false,
    });
  }

  /**
   * 一次识别多张图（如视频按时间轴抽的关键帧），模型按顺序逐张输出，省请求、可跨帧理解。
   * @param {Array<{base64:string, mimeType?:string}>} images
   * @param {string} customPrompt
   * @returns {Promise<string>}
   */
  async function recognizeMany(images, customPrompt) {
    if (!cfg.apiKey) throw new Error('未配置 SILICONFLOW_API_KEY');
    const list = Array.isArray(images) ? images.filter((x) => x && x.base64) : [];
    if (!list.length) throw new Error('图片内容为空');

    const content = [
      { type: 'text', text: (customPrompt && String(customPrompt).trim()) || DEFAULT_PROMPT },
    ];
    for (const im of list) {
      const clean = String(im.base64).replace(/^data:image\/[a-zA-Z0-9.+_-]+;base64,/, '');
      const mime = im.mimeType || 'image/jpeg';
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${clean}` } });
    }

    return postVision({
      model: cfg.model,
      messages: [{ role: 'user', content }],
      temperature: 0.1,
      stream: false,
    });
  }

  return { isReady, recognize, recognizeMany };
}

module.exports = { createVision };
