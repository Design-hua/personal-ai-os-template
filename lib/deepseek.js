'use strict';

const https = require('https');

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

const SYSTEM_PROMPT = `你是用户的个人AI助手，你有他的所有历史记录。

回答要求：
1. 简洁直接，像朋友说话，不啰嗦
2. 不要重复用户的问题
3. 不要输出 MY_STATEMENT、AI_INFERENCE 这类内部标签
4. 不要说"需要你自己定""我不替你做决定"这种推脱的话。能建议就直接给建议
5. 不确定的事说"不确定"，但能推断的就直接说
6. 如果用户问"今天做什么"，结合他的时间规划、最近记录，直接给建议

主动性（重要）：
7. 回答完主要问题后，如果发现有明显的下一步动作，主动问一句"要不要我帮你做 xxx"。
   只在真正有下一步时问，不要每句都问，不要机械地加问句结尾。
8. 发现用户历史记录里有"未决事项"（如某决策还没定、某计划还没排），主动提醒并询问。
   提醒要自然，像朋友顺嘴一提，不是任务清单。
9. 一次最多问一个下一步，不要连续追问。无关的不要硬问。

内部判断（不要展示给用户）：
- 用户原话与AI推断，你自己心里清楚就行
- 不编造用户没说过的事
- 重大人生决定前先问一下，日常建议直接给

---
你有四套决策参考卡片（存在 04_个人知识/方法论/ 目录，四份索引随附在本次上下文里）：
1. 毛泽东方法论卡片（25张，目录：毛泽东方法论卡片/）——分析框架，回答"怎么分析"：抓主要矛盾、分阶段推进、集中优势兵力、积极防御等。
2. 史记资治通鉴抉择卡片（50张，目录：史记资治通鉴抉择卡片/）——古人案例证据，回答"古人遇到同类抉择怎么选、代价与结果如何"，分五类：
   A 功高自处（事成后被重新定价）、B 忍与蛰伏（正面博弈必输时退让）、C 得意期风险（巅峰期的裸奔）、D 用人授权（给什么位置解决什么问题）、E 冒进持重（加杠杆还是刹车）。
3. 毛泽东抉择卡片（70张，目录：毛泽东抉择卡片/）——毛泽东本人处理同类抉择的案例，分七类：
   道路选择（方向与道路的根本取舍）、预期管理（给组织定价可坚持的预期）、阶段节奏（阶段不可逾越也不可抢跑）、持重冒进（胜负手的加杠杆与刹车）、联合自主（团结不交出自主权）、胜利自处（胜利前后防骄防腐）、调查认知（没有调查就没有发言权）。
4. 毛泽东哲学方法论卡片（19张，目录：毛泽东哲学方法论卡片/）——把"生产力-生产关系"辩证法迁移成改革决策工具，回答"现在该继续优化还是动结构性改革、新制度配不配得上现有能力、节奏该快还是该稳"，分四类：
   框架（三层结构/双轮驱动/静动态反转/阶段过渡/生产力标准）、原则（适合性/反转临界/工具革命/反冒进/反保守/中心任务）、案例（双革命、合作化过渡等4个）、反例（空头革命家、尾巴主义、冒进两种错误）。

回答决策类、项目类、长期规划类、用人/合伙/人际关系类问题时：
1. 先看四份索引里有哪些卡
2. 毛选方法论卡给分析框架；遇到"该不该动结构性改革、制度/流程/组织配不配得上现有能力、节奏该快还是该稳、引入新工具会冲击什么"的问题，先用毛泽东哲学方法论卡的框架与原则判时机和边界；史记卡和毛泽东抉择卡各找 1 个抉择结构同构的案例做印证（当事人的选项、代价、结果），自然融入回答
3. 案例必须先确认同构再用，注意卡内"风险提示"写明的边界，不生搬硬套；卡的原文引文可直接化用但不要大段堆砌
4. 不要机械引用（比如不要写"根据卡片xx"）
5. 日常闲聊、简单问答、纯事实查询时不用卡片。`;

function trimKey(key) {
  if (!key) return '';
  return String(key).replace(/^\s+|\s+$/g, '').replace(/\r?\n/g, '').trim();
}

function isPlaceholderKey(key) {
  if (!key) return true;
  const trimmed = trimKey(key);
  if (!trimmed) return true;
  if (/^sk-xxx$/i.test(trimmed)) return true;
  if (/your[_-]?api[_-]?key/i.test(trimmed)) return true;
  if (trimmed.length < 10) return true;
  return false;
}

function post(body, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(API_URL);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${e.message}`));
          }
        } else {
          reject(new Error(`DeepSeek API 错误 [${res.statusCode}]: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callDeepSeek(messages, apiKey) {
  const key = trimKey(apiKey);
  if (isPlaceholderKey(key)) {
    throw new Error('DEEPSEEK_API_KEY 未配置或仍是占位符');
  }
  const res = await post({
    model: MODEL,
    messages,
    temperature: 0.3,
    stream: false,
  }, key);

  if (!res.choices || !res.choices[0] || !res.choices[0].message) {
    throw new Error('DeepSeek 响应格式异常');
  }
  return res.choices[0].message.content || '';
}

async function classify(text, apiKey) {
  const userPrompt = `你是用户的个人AI助手。请分析用户这条输入。

判断：这是一条"值得存储的记录"，还是"对话中的一句回应"？

【值得存储】= isRecord: true
- 包含具体信息（时间、人物、事件、决策、想法、计划、感受、判断）
- 能独立成一条记录
- 例如："我决定春节去赤峰"、"今天见了老王"、"我觉得短视频值得做"、"周五回福建"

【不值得存储】= isRecord: false
- 是对话中的回应、追问、接话
- 没有新信息
- 例如："好的"、"嗯"、"继续"、"为什么"、"再说说"、"对"、"不对"

关键：判断的是【语义】，不是【字数】或【关键词】。
一句很短的话，如果包含新信息（如"周五回福建"），也应该存储。
一句很长的话，如果只是附和（如"我觉得你说的很对我也这么想"），也不应该存储。

如果 isRecord=true，还要判断 type：
- 决策记录：包含决定、选择
- 项目进展：包含项目名称和进展
- 提问：明确的疑问句
- 日常思考：其他有信息量的内容

返回严格JSON：
{
  "isRecord": true 或 false,
  "type": "决策记录|项目进展|日常思考|提问|对话",
  "title": "简短标题（不超过20字）"
}

如果 isRecord=false，type 填 "对话"，title 填空字符串。

只返回JSON，不要其他内容。

输入：
${text}`;

  const raw = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ], apiKey);

  let match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // 解析失败：默认按记录处理，宁可多存
    return { isRecord: true, type: '日常思考', title: '未分类内容' };
  }
  try {
    const obj = JSON.parse(match[0]);
    const validTypes = ['决策记录', '项目进展', '日常思考', '提问', '对话'];
    let type = obj.type || '日常思考';
    if (!validTypes.includes(type)) type = '日常思考';
    const isRecord = obj.isRecord === true || (obj.isRecord !== false && type !== '对话');
    let title = (obj.title || '').toString().slice(0, 50);
    if (!isRecord) {
      // 不存的情况，强制 type=对话、title 空
      return { isRecord: false, type: '对话', title: '' };
    }
    // 是记录但 title 为空时给个默认
    if (!title) title = '无标题';
    return { isRecord: true, type, title };
  } catch (e) {
    return { isRecord: true, type: '日常思考', title: '未分类内容' };
  }
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof h.content === 'string' ? h.content : String(h.content || '');
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  // 保险限制：最多 20 条（10 轮）
  if (out.length > 20) out.splice(0, out.length - 20);
  return out;
}

async function ask(question, context, apiKey, history) {
  const userPrompt = context
    ? `历史记录：

${context}

---
用户问：${question}`
    : `用户问：${question}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  // 插入历史对话（多轮）
  const cleanHistory = sanitizeHistory(history);
  for (const h of cleanHistory) {
    messages.push({ role: h.role, content: h.content });
  }
  // 当前输入
  messages.push({ role: 'user', content: userPrompt });

  return await callDeepSeek(messages, apiKey);
}

module.exports = { classify, ask, isPlaceholderKey, trimKey, callDeepSeek, sanitizeHistory };
