'use strict';

const deepseek = require('./deepseek');

const SYSTEM_PROMPT = '你是档案分析助手。判断用户输入是否包含"关于用户本人的新信息"。只返回JSON，不要其他内容。';

function buildUserPrompt(text) {
  return `判断以下输入是否包含"关于用户本人的新信息"。

【应该更新画像的内容】
- 决策（"我决定..."）
- 自我认知（"我发现我..."）
- 价值判断（"我认为..."）
- 长期目标（"我想..."）
- 能力/偏好（"我擅长..."）
- 明确取舍（"我选A不选B，因为..."）

【不应该更新的】
- 项目进展
- 日常思考
- 情绪、计划、提问
- 闲聊

只返回 JSON，格式：
{
  "shouldUpdate": true 或 false,
  "items": [
    {
      "content": "用第三人称描述这条事实，例如：用户决定春节去赤峰",
      "type": "MY_STATEMENT | MY_JUDGMENT | MY_GOAL | MY_HYPOTHESIS",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ]
}

类型说明：
- MY_STATEMENT：用户明确陈述的事实/决定
- MY_JUDGMENT：用户的价值判断
- MY_GOAL：用户的长期目标
- MY_HYPOTHESIS：用户的自我认知/假设

输入：
${text}`;
}

async function analyze(text, apiKey) {
  if (!text || !text.trim()) {
    return { shouldUpdate: false, items: [] };
  }
  let raw;
  try {
    raw = await deepseek.callDeepSeek([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(text) },
    ], apiKey);
  } catch (e) {
    // 失败不影响主流程
    return { shouldUpdate: false, items: [], error: e.message };
  }

  const match = raw && raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return { shouldUpdate: false, items: [] };
  }
  try {
    const obj = JSON.parse(match[0]);
    const shouldUpdate = obj.shouldUpdate === true;
    const items = Array.isArray(obj.items) ? obj.items : [];
    const validTypes = ['MY_STATEMENT', 'MY_JUDGMENT', 'MY_GOAL', 'MY_HYPOTHESIS'];
    const validConf = ['HIGH', 'MEDIUM', 'LOW'];
    const clean = items
      .filter((it) => it && it.content)
      .map((it) => ({
        content: String(it.content).slice(0, 300),
        type: validTypes.includes(it.type) ? it.type : 'MY_STATEMENT',
        confidence: validConf.includes(it.confidence) ? it.confidence : 'MEDIUM',
      }));
    return { shouldUpdate: shouldUpdate && clean.length > 0, items: clean };
  } catch (e) {
    return { shouldUpdate: false, items: [], error: e.message };
  }
}

module.exports = { analyze };
