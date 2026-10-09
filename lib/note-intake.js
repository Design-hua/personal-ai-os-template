// lib/note-intake.js
// 语音/妙记笔记收录：妙记链接 → 拉文字稿 → DeepSeek 整理 → 待办入今日计划 + 全量同步飞书表格
//
// 同步策略（2026-09-30 用户确认）：完整文字稿+摘要全量写入飞书多维表格「妙记笔记」，
// 与视频灵感收录同库（LARK_BASE_TOKEN）；表格自动创建，妙记 token 查重防重复。
// 本地 07_行为与决策/04_语音笔记/ 仍保留一份 md 归档（几 KB 级，作为兜底）。
//
// 文字稿来源（一期）：飞书妙记 transcript API
//   GET /open-apis/minutes/v1/minutes/:minute_token/transcript（返回 txt 二进制流）
//   需权限「导出妙记转写的文字内容」

'use strict';

const fs = require('fs');
const path = require('path');
const deepseek = require('./deepseek');
const storage = require('./storage');

const TODO_FILE = '07_行为与决策/今日计划.json';

// ---------- 妙记链接识别 ----------

// 妙记 URL：https://xxx.feishu.cn/minutes/obcnxxxxxxxxxxxxxxxxxxxx
// minute_token 固定 24 字符，以 obcn 开头
const MINUTE_URL_RE = /https?:\/\/[^\s，。、；？！,'"》）)】\]》]*\/minutes\/(obcn[a-zA-Z0-9]{20})/i;
const MINUTE_TOKEN_RE = /(obcn[a-zA-Z0-9]{20})/;

function parseMinuteUrl(text) {
  const t = String(text || '');
  const m = t.match(MINUTE_URL_RE);
  if (m) return { token: m[1], url: m[0] };
  // 纯 token（用户只贴了 obcn...）
  const m2 = t.match(MINUTE_TOKEN_RE);
  if (m2) return { token: m2[1], url: '' };
  return null;
}

// ---------- 工具 ----------

function extractJson(text) {
  const s = String(text || '').replace(/```json|```/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function displayNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function readTodos(dataRoot) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(dataRoot, TODO_FILE), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeTodos(dataRoot, todos) {
  const filePath = path.join(dataRoot, TODO_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), 'utf8');
}

// ---------- DeepSeek 整理 ----------

const ORGANIZE_SYSTEM = `你是语音笔记整理助手。用户会给你一段语音转写的文字稿（可能带说话人标记和时间戳）。
请先判断素材类型，再按对应形态整理成结构化笔记。输出严格 JSON，不要 markdown 代码块，不要多余解释。

第一步，判断「素材类型」，四选一：
- "会议/访谈"：多人讨论、工作会议、对谈采访（有明确的事项分派或共识）
- "课程讲座"：知识讲解、课程、读书分享、干货输出（主要在传递知识）
- "口播/播客"：面向观众的短视频口播、播客单集（有钩子和表达设计）
- "随手记录"：用户自己的随想、备忘、灵感碎念

JSON key 固定为：
{"素材类型":"会议/访谈|课程讲座|口播/播客|随手记录","会议类型":"决策会|工作同步|访谈采访|其他|","参会人":["..."],"relatedProject":"","title":"...","summary":"...","todos":[{"text":"...","priority":"P0|P1|P2","due":"","owner":"我"}],"insights":["..."],"decisions":[{"decision":"...","basis":"..."}],"openQuestions":["..."],"experiences":[{"content":"...","type":"✅加分行为|❌减分行为|🟡中性观察","level":"普通经验|🔥核心原则","category":"选题|标题|开头钩子|结构|脚本文案|拍摄呈现|运营发布|心态认知"}]}

各字段要求：
- title：笔记标题（不超过 20 字）。从内容概括，不要用"语音笔记""未命名"
- 会议类型：仅当素材类型为"会议/访谈"时细分——
  · 决策会：为某个要不要做/怎么做的事拍了板（或本该拍板）
  · 工作同步：进展通报、任务分派、例行沟通
  · 访谈采访：向某人提问取材、对谈了解情况
  · 其他：不好归类的多人谈话。非会议/访谈素材此 key 留空字符串
- 参会人：仅会议/访谈填写。从说话人标记和称呼中提取参会者（姓名或可辨认的角色，如"张主任""老丈人""主持人"）；完全无法辨认返回空数组。不得编造姓名
- relatedProject：如果讨论明显围绕某个具体项目/事情（如"黄金矿渣""第二大脑""评职称"），写一个不超过 10 字的项目关键词；没有留空字符串
- summary：按素材类型用不同形态，不要千篇一律：
  · 决策会 → 决策纪要：① 要决定的事 ② 最终结论/谁拍的板 ③ 尚存分歧 ④ 下一步（3-6 句）
  · 工作同步 → 会议纪要：讨论了什么议题、各自进展、达成的共识、下一步方向（3-6 句）
  · 访谈采访 → 访谈纪要：受访者核心观点、关键事实案例、可用的素材金句（3-6 句）
  · 课程讲座 → 知识大纲：先一句核心论点，再用"1./2./3."列出主讲人的分点论据和关键概念，还原知识结构
  · 口播/播客 → 创作拆解：开头用了什么钩子、核心观点是什么、怎么组织表达、收尾怎么引导
  · 随手记录 → 简洁摘要：记下了什么事、想法或结论（2-4 句）
- todos：可执行待办，严格控制——
  · 只有"会议/访谈"里明确分派/承诺的动作，或任何类型中说话人明确说"要去做、记得做、答应做"的具体动作才提取
  · 课程讲座里的知识点、方法论、"应该如何"的道理一律不进 todos（它们进 insights）
  · 不提取已经做完的、单纯的想法感受。每条不超过 30 字。没有就返回空数组
  · due：该动作的时间承诺原文（如"本周五""10月底前""下周例会"）；没有明确时间留空字符串，禁止推算具体日期
  · owner：承诺去做的人，默认"我"；若是别人答应的，写其称呼（如"王老师"）
- insights：3-5 条关键要点/金句/决策点/值得记住的观点。课程讲座尤其要把核心知识点放这里。每条一句话
- decisions：仅会议/访谈填写。会议中【已经明确达成】的结论或拍板，每条含 decision（决定内容，一句话）和 basis（依据/前提，简述）；还在讨论没定的不要放，放 openQuestions。最多 3 条，没有就空数组
- openQuestions：仅会议/访谈填写。讨论了但没有结论、需要后续拍板或验证的事项。最多 3 条，没有就空数组
- experiences：从文字稿中提炼"可复用的方法论/做事原则/踩坑教训"，沉淀进个人经验库。门槛要高——只收录以后真能指导行动的通用方法、原则、教训；一次性事项、普通信息、纯感受不要。通常 0-2 条，没有就返回空数组。
  · content：一句话讲清这条经验，写成脱离上下文也能看懂、可直接复用的判断或做法（30-60字）
  · type：值得效仿的好做法→✅加分行为；要避免的错误/踩坑→❌减分行为；客观规律/中性观察→🟡中性观察
  · level：能长期复用的底层原则→🔥核心原则；具体场景经验→普通经验
  · category：内容创作相关按环节归类（选题/标题/开头钩子/结构/脚本文案/拍摄呈现/运营发布）；通用认知、做事方法、心态类一律填"心态认知"

硬性要求：
1. 全部内容必须基于文字稿原文，禁止编造文字稿里没有的信息
2. 文字稿不清楚的地方就写"文字稿未涉及"，不要脑补
3. 外部作者/主讲人的观点是别人的，不要当成用户自己的经验写进 experiences
4. todos 里的优先级：P0=有明确时间/紧迫/影响大；P1=常规推进；P2=随手小事`;

function buildUserMsg(transcript, source) {
  return `【来源】${source}
【文字稿】
${transcript}`;
}

async function organizeWithDeepSeek(transcript, source, apiKey) {
  const raw = await deepseek.callDeepSeek(
    [
      { role: 'system', content: ORGANIZE_SYSTEM },
      { role: 'user', content: buildUserMsg(transcript, source) },
    ],
    apiKey
  );
  const parsed = extractJson(raw);
  if (!parsed) throw new Error('AI 整理结果不是合法 JSON');
  // experiences 规范化：只要有内容的条目，最多 2 条（高门槛，防经验表被灌水）
  const VALID_TYPES = ['✅加分行为', '❌减分行为', '🟡中性观察'];
  const VALID_LEVELS = ['普通经验', '🔥核心原则'];
  const VALID_CATS = ['选题', '标题', '开头钩子', '结构', '脚本文案', '拍摄呈现', '运营发布', '心态认知'];
  const experiences = (Array.isArray(parsed.experiences) ? parsed.experiences : [])
    .map((x) => ({
      content: String((x && x.content) || '').trim(),
      type: VALID_TYPES.includes(x && x.type) ? x.type : '🟡中性观察',
      level: VALID_LEVELS.includes(x && x.level) ? x.level : '普通经验',
      category: VALID_CATS.includes(x && x.category) ? x.category : '心态认知',
    }))
    .filter((x) => x.content)
    .slice(0, 2);
  // todos 规范化：保留 due/owner（会议承诺时间与责任人）
  const todos = (Array.isArray(parsed.todos) ? parsed.todos : [])
    .map((t) => ({
      text: String((t && t.text) || '').trim(),
      priority: t && ['P0', 'P1', 'P2'].includes(t.priority) ? t.priority : 'P2',
      due: t && t.due ? String(t.due).trim().slice(0, 20) : '',
      owner: t && t.owner ? String(t.owner).trim().slice(0, 20) : '我',
    }))
    .filter((t) => t.text)
    .slice(0, 10);
  // decisions/openQuestions：只在会议/访谈素材里出现，高门槛防误报
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map((x) => ({
      decision: String((x && x.decision) || '').trim(),
      basis: String((x && x.basis) || '').trim(),
    }))
    .filter((x) => x.decision)
    .slice(0, 3);
  const openQuestions = (Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const MEETING_TYPES = ['决策会', '工作同步', '访谈采访', '其他'];
  const meetingType = parsed['素材类型'] === '会议/访谈' && MEETING_TYPES.includes(parsed['会议类型'])
    ? parsed['会议类型'] : '';
  const attendees = (Array.isArray(parsed['参会人']) ? parsed['参会人'] : [])
    .map((s) => String(s || '').trim()).filter((s) => s && s !== '我').slice(0, 12);
  const relatedProject = String(parsed.relatedProject || '').trim().slice(0, 20);
  return {
    materialType: String(parsed['素材类型'] || '').slice(0, 12),
    meetingType,
    attendees,
    relatedProject,
    title: String(parsed.title || '语音笔记').slice(0, 50),
    summary: String(parsed.summary || ''),
    todos,
    insights: Array.isArray(parsed.insights) ? parsed.insights : [],
    decisions,
    openQuestions,
    experiences,
  };
}

// ---------- 入库 ----------

function saveTodos(dataRoot, todos) {
  if (!todos || todos.length === 0) return { added: 0 };
  const existing = readTodos(dataRoot);
  const now = Date.now();
  const display = displayNow();
  let added = 0;
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    const text = typeof t.text === 'string' ? t.text.trim().slice(0, 60) : '';
    if (!text) continue;
    let priority = 'P2';
    if (t.priority === 'P0' || t.priority === 'P1' || t.priority === 'P2') priority = t.priority;
    const row = {
      id: now + i,
      text,
      priority,
      done: false,
      createdAt: display,
      source: 'note',
    };
    if (t.due) row.due = String(t.due).slice(0, 20);
    if (t.owner && t.owner !== '我') row.owner = String(t.owner).slice(0, 20);
    existing.push(row);
    added++;
    if (added >= 10) break;
  }
  if (added > 0) writeTodos(dataRoot, existing);
  return { added };
}

function saveNote(dataRoot, title, transcript, organized, sourceUrl) {
  const lines = [];
  lines.push(`# 语音笔记 · ${organized.title}`);
  lines.push('');
  lines.push(`## 时间`);
  lines.push(displayNow());
  lines.push('');
  lines.push(`## 摘要`);
  lines.push(organized.summary || '（无）');
  lines.push('');
  if (organized.insights && organized.insights.length > 0) {
    lines.push(`## 要点`);
    for (const ins of organized.insights) {
      lines.push(`- ${ins}`);
    }
    lines.push('');
  }
  if (sourceUrl) {
    lines.push(`## 来源`);
    lines.push(sourceUrl);
    lines.push('');
  }
  lines.push(`## 原始文字稿`);
  lines.push('```');
  lines.push(transcript);
  lines.push('```');
  const content = lines.join('\n');
  return storage.saveRecord(dataRoot, '语音笔记', organized.title, content, '');
}

// ---------- 飞书多维表格同步（全量：文字稿+摘要） ----------

const NOTE_TABLE_NAME = '妙记笔记';
// 字段名可用环境变量覆盖（与视频收录同风格）
const NOTE_FIELD_DEFAULTS = {
  title: '标题',
  summary: '摘要',
  insights: '要点',
  todos: '待办',
  transcript: '正文',
  url: '链接',
  time: '收录时间',
  source: '来源',
  meetingType: '会议类型',
  attendees: '参会人',
  decisions: '会议决定与待决',
  relatedTo: '关联项目',
};

function textOfFieldValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOfFieldValue).join('');
  if (typeof v === 'object') return String(v.text || v.name || v.link || '');
  return String(v);
}

function buildNoteFieldValue(organized, transcript, sourceUrl, sourceLabel, F) {
  const fields = {
    [F.title]: organized.title || '（无标题）',
    [F.summary]: organized.summary || '',
    [F.insights]: (organized.insights || []).map((s) => `• ${s}`).join('\n'),
    [F.todos]: (organized.todos || [])
      .map((t) => {
        let line = `[${t.priority || 'P2'}] ${t.text || ''}`.trim();
        const tail = [t.owner && t.owner !== '我' ? `负责人:${t.owner}` : '', t.due ? `截止:${t.due}` : ''].filter(Boolean).join('｜');
        if (tail) line += `（${tail}）`;
        return line;
      })
      .join('\n'),
    [F.transcript]: transcript || '',
    [F.time]: displayNow(),
    [F.source]: sourceLabel,
  };
  // 会议增强字段（非会议素材多为空，缺列时由 ensureNoteFields 自动补）
  if (organized.meetingType) fields[F.meetingType] = organized.meetingType;
  if (Array.isArray(organized.attendees) && organized.attendees.length) {
    fields[F.attendees] = organized.attendees.join('、');
  }
  if (organized.relatedProject) fields[F.relatedTo] = organized.relatedProject;
  const decLines = (organized.decisions || [])
    .map((d) => `✅ 决定：${d.decision}${d.basis ? `（依据：${d.basis}）` : ''}`);
  const openLines = (organized.openQuestions || []).map((q) => `❓ 待决：${q}`);
  const decText = decLines.concat(openLines).join('\n');
  if (decText) fields[F.decisions] = decText.slice(0, 4000);
  if (sourceUrl) fields[F.url] = { text: sourceUrl, link: sourceUrl }; // URL 类型字段对象写法
  return fields;
}

function createNoteIntake(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    client: o.client || null, // lib/lark.js 客户端
    dataRoot: o.dataRoot || '',
    baseToken: o.baseToken || '', // 多维表格 App token（与视频收录同库）
    tableId: o.tableId || '',     // LARK_NOTE_TABLE_ID；留空则按表名自动查找/创建
  };
  // 字段名覆盖（只覆盖非空值）
  const F = Object.assign({}, NOTE_FIELD_DEFAULTS);
  const supplied = o.fields || {};
  for (const k of Object.keys(supplied)) {
    if (supplied[k]) F[k] = String(supplied[k]);
  }

  function isReady() {
    return Boolean(cfg.client && cfg.dataRoot && cfg.apiKey);
  }

  // ---------- 表格解析与字段补建 ----------

  let tableResolvePromise = null;

  // 定位「妙记笔记」表：env 指定 > 按名查找 > 自动创建。结果进程内缓存。
  function resolveNoteTable() {
    if (tableResolvePromise) return tableResolvePromise;
    tableResolvePromise = (async () => {
      if (!cfg.client || !cfg.baseToken) {
        return { ok: false, warning: '未配置 LARK_BASE_TOKEN' };
      }
      if (cfg.tableId) return { ok: true, tableId: cfg.tableId };
      try {
        const tables = await cfg.client.listBitableTables(cfg.baseToken);
        const hit = tables.find((t) => t && t.name === NOTE_TABLE_NAME);
        if (hit && hit.table_id) return { ok: true, tableId: hit.table_id };
        // 不存在则创建（含全部初始字段）
        const created = await cfg.client.createBitableTable(cfg.baseToken, {
          table: {
            name: NOTE_TABLE_NAME,
            default_view_name: '笔记',
            fields: [
              { field_name: F.title, type: 1 },
              { field_name: F.summary, type: 1 },
              { field_name: F.insights, type: 1 },
              { field_name: F.todos, type: 1 },
              { field_name: F.transcript, type: 1 },
              { field_name: F.url, type: 15 },
              { field_name: F.time, type: 1 },
              { field_name: F.source, type: 1 },
              { field_name: F.meetingType, type: 1 },
              { field_name: F.attendees, type: 1 },
              { field_name: F.decisions, type: 1 },
              { field_name: F.relatedTo, type: 1 },
            ],
          },
        });
        if (created && created.table_id) return { ok: true, tableId: created.table_id };
        return { ok: false, warning: '建表响应缺少 table_id' };
      } catch (e) {
        tableResolvePromise = null; // 允许下次重试（网络/授权恢复后）
        return { ok: false, warning: e.message };
      }
    })();
    return tableResolvePromise;
  }

  // 指定表缺少列时补建（用户手动指 tableId 的场景）；失败只告警不阻塞
  async function ensureNoteFields(tableId) {
    const defs = [
      { name: F.title, type: 1 },
      { name: F.summary, type: 1 },
      { name: F.insights, type: 1 },
      { name: F.todos, type: 1 },
      { name: F.transcript, type: 1 },
      { name: F.url, type: 15 },
      { name: F.time, type: 1 },
      { name: F.source, type: 1 },
      { name: F.meetingType, type: 1 },
      { name: F.attendees, type: 1 },
      { name: F.decisions, type: 1 },
      { name: F.relatedTo, type: 1 },
    ];
    try {
      const items = await cfg.client.listBitableFields(cfg.baseToken, tableId);
      const existing = new Set(items.map((f) => f.field_name));
      for (const def of defs) {
        if (existing.has(def.name)) continue;
        try {
          await cfg.client.createBitableField(cfg.baseToken, tableId, {
            field_name: def.name,
            type: def.type,
          });
        } catch (e) {
          /* 单列失败不阻塞 */
        }
      }
    } catch (e) {
      /* 读字段失败不阻塞，写记录时按实际报错提示 */
    }
  }

  // 按妙记链接/token 查重（妙记 token 稳定，重复收录走更新）
  async function findRecordByUrl(tableId, urlKey) {
    if (!urlKey) return null;
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, {
        pageSize: 500,
        pageToken,
      });
      const items = data.items || [];
      for (const rec of items) {
        const v = rec.fields ? rec.fields[F.url] : '';
        if (textOfFieldValue(v).includes(urlKey)) return rec;
      }
      if (!data.has_more) break;
      pageToken = data.page_token || '';
    }
    return null;
  }

  /**
   * 全量同步一条笔记到飞书表格。失败返回 { synced:false, warning }，不抛错不阻塞主流程。
   */
  async function syncToBitable(organized, transcript, sourceUrl, sourceLabel) {
    const t = await resolveNoteTable();
    if (!t.ok) return { synced: false, warning: t.warning };
    const tableId = t.tableId;
    await ensureNoteFields(tableId);

    const urlKey = sourceUrl || sourceLabel; // 纯 token 场景也可查重
    const fields = buildNoteFieldValue(organized, transcript, sourceUrl, sourceLabel, F);
    try {
      const existing = await findRecordByUrl(tableId, urlKey).catch(() => null);
      if (existing && existing.record_id) {
        await cfg.client.updateBitableRecord(cfg.baseToken, tableId, existing.record_id, fields);
      } else {
        await cfg.client.createBitableRecord(cfg.baseToken, tableId, fields);
      }
      return { synced: true, tableId, url: sourceUrl };
    } catch (e1) {
      // 回退：链接字段若是文本类型，对象写法会失败 → 改纯字符串重试一次
      try {
        const fb = { ...fields };
        if (sourceUrl) fb[F.url] = sourceUrl;
        const existing2 = await findRecordByUrl(tableId, urlKey).catch(() => null);
        if (existing2 && existing2.record_id) {
          await cfg.client.updateBitableRecord(cfg.baseToken, tableId, existing2.record_id, fb);
        } else {
          await cfg.client.createBitableRecord(cfg.baseToken, tableId, fb);
        }
        return { synced: true, tableId, url: sourceUrl };
      } catch (e2) {
        return { synced: false, warning: e2.message };
      }
    }
  }

  /**
   * collect(text, { wait })
   * 识别妙记链接 → 拉文字稿 → AI 整理 → 待办入今日计划 + 正文存本地
   */
  async function collect(text, options) {
    const opt = options || {};
    const parsed = parseMinuteUrl(text);
    if (!parsed) return { handled: false };

    if (!isReady()) {
      return {
        handled: true,
        mode: 'note',
        token: parsed.token,
        queued: false,
        reply:
          '识别到妙记链接，但笔记收录功能未启用。\n' +
          '请检查飞书授权状态与 DEEPSEEK_API_KEY 配置。',
      };
    }

    // 1. 拉文字稿
    let transcript;
    try {
      transcript = await cfg.client.getMinuteTranscript(parsed.token, {
        needSpeaker: true,
      });
    } catch (e) {
      return {
        handled: true,
        mode: 'note',
        token: parsed.token,
        queued: false,
        error: e.message,
        reply: `⚠️ 获取妙记文字稿失败：${e.message}\n` +
          '可能原因：飞书应用未开通「导出妙记转写的文字内容」权限，或该妙记未转写完成。\n' +
          '请到飞书应用后台开通权限后重新授权。',
      };
    }

    if (!transcript || !transcript.trim()) {
      return {
        handled: true,
        mode: 'note',
        token: parsed.token,
        queued: false,
        reply: '⚠️ 该妙记文字稿为空，可能还在转写中，请稍后再试。',
      };
    }

    const source = parsed.url
      ? `飞书妙记 ${parsed.url}`
      : `飞书妙记 ${parsed.token}`;

    // 2. AI 整理
    let organized;
    try {
      organized = await organizeWithDeepSeek(transcript, source, cfg.apiKey);
    } catch (e) {
      return {
        handled: true,
        mode: 'note',
        token: parsed.token,
        queued: false,
        error: e.message,
        reply: `⚠️ AI 整理失败：${e.message}`,
      };
    }

    // 3. 入库（本地归档 + 待办）
    let todoResult = { added: 0 };
    let saved = null;
    try {
      todoResult = saveTodos(cfg.dataRoot, organized.todos);
      saved = saveNote(cfg.dataRoot, organized.title, transcript, organized, parsed.url);
    } catch (e) {
      return {
        handled: true,
        mode: 'note',
        token: parsed.token,
        queued: false,
        error: e.message,
        reply: `⚠️ 保存笔记失败：${e.message}`,
      };
    }

    // 4. 全量同步飞书表格（失败不阻塞，回执带提示）
    const sync = await syncToBitable(organized, transcript, parsed.url, '妙记');
    const syncLine = sync.synced
      ? `已全量同步至飞书表格「妙记笔记」。`
      : `⚠️ 飞书表格同步失败：${sync.warning}（本地已存档，不影响使用）`;

    const todoLine = todoResult.added > 0
      ? `已提取 ${todoResult.added} 条待办并加入今日计划。`
      : '未从文字稿中提取到待办事项。';

    const reply = [
      `✅ 已整理妙记笔记：《${organized.title}》`,
      `摘要：${(organized.summary || '').slice(0, 120)}${organized.summary && organized.summary.length > 120 ? '…' : ''}`,
      todoLine,
      syncLine,
      `本地归档：${saved ? saved.dir + '/' + saved.file : ''}`,
    ].join('\n');

    return {
      handled: true,
      mode: 'note',
      token: parsed.token,
      queued: false,
      title: organized.title,
      summary: organized.summary,
      todos: organized.todos,
      insights: organized.insights,
      experiences: organized.experiences || [],
      meetingType: organized.meetingType,
      attendees: organized.attendees,
      decisions: organized.decisions,
      openQuestions: organized.openQuestions,
      relatedProject: organized.relatedProject,
      todoAdded: todoResult.added,
      saved: saved ? { dir: saved.dir, file: saved.file, path: saved.path } : null,
      reply,
    };
  }

  return {
    parseMinuteUrl,
    isReady,
    collect,
    /**
     * 获取「妙记笔记」多维表格直达链接（表不存在时会自动创建，失败返回 warning）
     * @returns {Promise<{ok:boolean, url?:string, tableId?:string, warning?:string}>}
     */
    async getTableLink() {
      const t = await resolveNoteTable();
      if (!t.ok) return { ok: false, warning: t.warning || '妙记表不可用' };
      return {
        ok: true,
        tableId: t.tableId,
        url: `https://feishu.cn/base/${cfg.baseToken}?table=${t.tableId}`,
      };
    },
    /**
     * 整理任意文字稿并入库（工作台录音入口复用）
     * @param {string} transcript 文字稿
     * @param {string} source 来源标签（如「工作台录音」「飞书妙记 https://...」）
     * @param {string} sourceUrl 可选，来源链接写入笔记
     * @returns {object} { title, summary, todos, insights, todoAdded, saved, reply }
     */
    async organize(transcript, source, sourceUrl) {
      const text = String(transcript || '');
      if (!text.trim()) throw new Error('文字稿为空');

      // AI 整理
      let organized;
      try {
        organized = await organizeWithDeepSeek(text, source, cfg.apiKey);
      } catch (e) {
        throw new Error('AI 整理失败：' + e.message);
      }

      // 入库（本地归档 + 待办）
      let todoResult = { added: 0 };
      let saved = null;
      try {
        todoResult = saveTodos(cfg.dataRoot, organized.todos);
        saved = saveNote(cfg.dataRoot, organized.title, text, organized, sourceUrl || '');
      } catch (e) {
        throw new Error('保存笔记失败：' + e.message);
      }

      // 全量同步飞书表格（失败不阻塞，回执带提示）
      const sync = await syncToBitable(organized, text, sourceUrl || '', source);
      const syncLine = sync.synced
        ? `已全量同步至飞书表格「妙记笔记」。`
        : `⚠️ 飞书表格同步失败：${sync.warning}（本地已存档，不影响使用）`;

      const todoLine = todoResult.added > 0
        ? `已提取 ${todoResult.added} 条待办并加入今日计划。`
        : '未从文字稿中提取到待办事项。';

      const reply = [
        `✅ 已整理笔记：《${organized.title}》`,
        `摘要：${(organized.summary || '').slice(0, 120)}${organized.summary && organized.summary.length > 120 ? '…' : ''}`,
        todoLine,
        syncLine,
        `本地归档：${saved ? saved.dir + '/' + saved.file : ''}`,
      ].join('\n');

      return {
        title: organized.title,
        summary: organized.summary,
        todos: organized.todos,
        insights: organized.insights,
        experiences: organized.experiences || [],
        meetingType: organized.meetingType,
        attendees: organized.attendees,
        decisions: organized.decisions,
        openQuestions: organized.openQuestions,
        relatedProject: organized.relatedProject,
        todoAdded: todoResult.added,
        saved: saved ? { dir: saved.dir, file: saved.file, path: saved.path } : null,
        reply,
      };
    },
    /**
     * 读历史妙记笔记（会前简报召回用）。表不可用或失败时返回空数组，不抛错。
     * @param {{keyword?:string, limit?:number}} opts
     * @returns {Promise<Array<{recordId,title,summary,insights,meetingType,attendees,relatedTo,time}>>}
     */
    async listNotes(opts) {
      const kw = String((opts && opts.keyword) || '').trim().toLowerCase();
      const limit = Math.min(20, Math.max(1, Number((opts && opts.limit) || 8)));
      const t = await resolveNoteTable();
      if (!t.ok) return [];
      await ensureNoteFields(t.tableId); // 顺带补齐会议增强列（旧表升级；失败不阻塞读取）
      const data = await cfg.client.listBitableRecords(cfg.baseToken, t.tableId, { pageSize: 100 });
      const text = (v) => textOfFieldValue(v);
      let rows = (data.items || []).map((r) => {
        const f = r.fields || {};
        return {
          recordId: r.record_id,
          title: text(f[F.title]),
          summary: text(f[F.summary]),
          insights: text(f[F.insights]),
          meetingType: text(f[F.meetingType]),
          attendees: text(f[F.attendees]),
          relatedTo: text(f[F.relatedTo]),
          time: text(f[F.time]),
        };
      }).filter((n) => n.title || n.summary);
      // 本地过滤+按收录时间倒序（list 接口不过滤；妙记表数据量小）
      if (kw) {
        rows = rows.filter((n) => `${n.title} ${n.summary} ${n.insights} ${n.relatedTo}`.toLowerCase().includes(kw));
      }
      rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));
      return rows.slice(0, limit);
    },
    // 暴露给测试
    _organizeWithDeepSeek: organizeWithDeepSeek,
    _saveTodos: saveTodos,
    _saveNote: saveNote,
  };
}

module.exports = { createNoteIntake, parseMinuteUrl };
