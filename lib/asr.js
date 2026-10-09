// lib/asr.js
// 语音转文字（ASR）：硅基流动 SenseVoiceSmall，OpenAI 兼容 /v1/audio/transcriptions 接口
// 零新增 npm 依赖：Node 18 内置 fetch / FormData / Blob
//
// 用途：
//   1. 工作台录音入口（MediaRecorder webm/mp4 → 转文字 → AI 整理）
//   2. 抖音等无字幕平台的音频转写（后续接入）

'use strict';

function createAsr(opts) {
  const cfg = {
    apiKey: opts.apiKey || '',
    baseUrl: opts.baseUrl || 'https://api.siliconflow.cn/v1',
    model: opts.model || 'FunAudioLLM/SenseVoiceSmall',
  };

  function isReady() {
    return Boolean(cfg.apiKey);
  }

  /**
   * 转写音频为文字
   * @param {Buffer} buffer 音频二进制
   * @param {string} filename 文件名（扩展名供服务端识别格式，如 recording.webm / recording.m4a）
   * @param {object} o { mimeType?: string, language?: string }
   * @returns {Promise<string>} 转写文本
   */
  async function transcribe(buffer, filename, o) {
    const opt = o || {};
    const mimeType = opt.mimeType || 'audio/webm';
    if (!cfg.apiKey) throw new Error('未配置 SILICONFLOW_API_KEY');
    if (!buffer || !buffer.length) throw new Error('音频内容为空');

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename || 'recording.webm');
    form.append('model', cfg.model);
    if (opt.language) form.append('language', opt.language);

    let resp;
    try {
      resp = await fetch(cfg.baseUrl + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.apiKey },
        body: form,
      });
    } catch (e) {
      throw new Error('ASR 网络请求失败: ' + e.message);
    }

    let json = {};
    try {
      json = await resp.json();
    } catch (e) {
      /* 非 JSON 响应，走下方统一报错 */
    }
    if (resp.status !== 200 || json.error) {
      const msg = (json.error && (json.error.message || json.error.code)) || json.message || ('HTTP ' + resp.status);
      throw new Error('ASR 转写失败: ' + msg);
    }
    return String(json.text || '');
  }

  return { isReady, transcribe };
}

module.exports = { createAsr };
