// lib/extract-todos.js
// 从用户输入中提取可执行的待办事项
// 调 DeepSeek，返回 { todos: [{ text, priority }] }
// 失败返回空数组，不影响主流程

const deepseek = require('./deepseek.js');

const SYSTEM_PROMPT = `你是待办提取助手。从用户的输入里提取"可执行的待办事项"，并判断每条是否适合派发给 AI 执行。

【应该提取】
- 明确要做的动作（"完成 X"、"写 X"、"读 X 第 N 章"、"联系 X"）
- 含时间或步骤的执行项
- 用户说要做的具体事

【不应该提取】
- 已经做完的（"我做了 X"）
- 单纯的想法/感受（"我觉得 X 很重要"）
- 没有动作的描述（"X 是 Y 的"）
- 对话回应（"好的"、"嗯"）

【aiSuitable 判断：这条任务能否派发给 AI 直接执行】
适合 AI（aiSuitable: true）= 纯文本创作/分析/整理类，不需要真实世界操作：
- 写文案/脚本/笔记/总结/翻译/改稿/列清单
- 分析数据/拆解内容/给建议/做对比
- 整理已有信息成结构化输出

不适合 AI（aiSuitable: false）= 需要真实世界操作或线下执行：
- 打电话、发消息、见人、买东西、去某地
- 需要账号登录/操作 App/线下跑腿

【instruction】aiSuitable=true 时给出可直接执行的 AI 指令（把口语化待办转成明确的任务描述，≤80字）；aiSuitable=false 时填空字符串。

优先级判断：
- P0 重要：含明确时间、影响重大、紧迫
- P1 一般：常规推进项
- P2 随手：零碎小事

只返回严格 JSON，不要其他内容：
{ "todos": [{ "text": "待办内容（不超过 30 字）", "priority": "P0|P1|P2", "aiSuitable": true|false, "instruction": "..." }] }

没有待办就返回 { "todos": [] }`;

/**
 * 从用户输入中提取待办（含 AI 可执行性判断）
 * @param {string} text 用户原文
 * @param {string} apiKey DeepSeek API Key
 * @returns {Promise<{todos: Array<{text: string, priority: 'P0'|'P1'|'P2', aiSuitable: boolean, instruction: string}>}>}
 */
async function extractTodos(text, apiKey) {
  if (!text || !text.trim()) return { todos: [] };
  if (!apiKey || apiKey.length < 10) return { todos: [] };

  const raw = await deepseek.callDeepSeek(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    apiKey
  );

  // 容错：尝试从 raw 里抠出 JSON
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { todos: [] };
    try { parsed = JSON.parse(m[0]); } catch (e2) { return { todos: [] }; }
  }

  const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
  // 清洗
  const clean = [];
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue;
    const text = typeof t.text === 'string' ? t.text.trim() : '';
    if (!text || text.length > 60) continue;
    let priority = 'P2';
    if (t.priority === 'P0' || t.priority === 'P1' || t.priority === 'P2') priority = t.priority;
    const aiSuitable = t.aiSuitable === true;
    const instruction = aiSuitable && typeof t.instruction === 'string' ? t.instruction.trim().slice(0, 200) : '';
    clean.push({ text, priority, aiSuitable, instruction });
    if (clean.length >= 10) break;  // 单次最多 10 条
  }
  return { todos: clean };
}

module.exports = { extractTodos };
