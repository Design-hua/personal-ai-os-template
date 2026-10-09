// lib/decide.js
// 蓝图第 4 步：Skill 05｜项目尽调与决策（决策卡）+ Skill 06｜长期项目推进（项目卡）
//
// 严格遵循《个人AI操作系统 V2.0》安全边界：
//   - AI 的尽调/倾向/规划永远是"AI 分析"，不等于用户的决定（决策卡默认 🟡待我拍板）
//   - 只有用户本人能把决策改成 ✅决定做 / ⛔决定不做，AI 不替他拍板
//   - 不把临时兴趣自动升级为长期目标（项目卡默认 🌱规划中，是否推进由用户定）
//   - 证据不足就标"不足"，不假装确定
//   - 召回的个人上下文只用 ✅已确认 的档案/经验；外部知识资料标注为别人观点
//
// 飞书两张表：「决策卡」「项目卡」。

'use strict';

const deepseek = require('./deepseek');
const { gramsOf, matchCount } = require('./knowledge');
const { CONFIRM_YES } = require('./experience');

const DOMAIN_OPTIONS = ['投资与周期', '创业与变现', 'AI与第二大脑', '学术与教育', '内容创作', '家庭与个人', '其他'];

// ---------- 通用 ----------

function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayStr() {
  return nowStr().slice(0, 10);
}

function extractJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

function normDomain(v) {
  return DOMAIN_OPTIONS.includes(v) ? v : '其他';
}

// 收集分层个人上下文（只召回已确认），供决策/项目 AI 使用
async function collectContext(deps, query) {
  const { profileCenter, knowledgeCenter, experienceCenter } = deps;
  const [profile, knowledge, experiences] = await Promise.all([
    (async () => {
      if (!profileCenter || typeof profileCenter.getConfirmedDigest !== 'function') return { text: '', count: 0 };
      try { const d = await profileCenter.getConfirmedDigest(); return { text: String(d.text || '').slice(0, 3000), count: d.count || 0 }; }
      catch (e) { return { text: '', count: 0 }; }
    })(),
    (async () => {
      if (!knowledgeCenter || typeof knowledgeCenter.recall !== 'function' || !query) return [];
      try { const r = await knowledgeCenter.recall(query, { max: 5 }); return (r && r.items) || []; }
      catch (e) { return []; }
    })(),
    (async () => {
      if (!experienceCenter || typeof experienceCenter.listExperiences !== 'function') return [];
      try {
        const r = await experienceCenter.listExperiences({ confirmed: CONFIRM_YES });
        const items = (r && r.items) || [];
        if (!query) return items.filter((x) => x.level === '🔥核心原则').slice(0, 8);
        const qset = new Set(gramsOf(query));
        const hit = items.map((x) => ({
          ...x,
          score: matchCount(qset, `${x.content || ''} ${x.category || ''} ${x.cluster || ''}`),
        })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
        return (hit.length ? hit : items.filter((x) => x.level === '🔥核心原则')).slice(0, 8);
      } catch (e) { return []; }
    })(),
  ]);

  const parts = [];
  if (profile.text) parts.push(`【我的档案·已确认（用户本人确认的事实和原则，最高优先级个人情境）】\n${profile.text}`);
  if (experiences.length) {
    parts.push('【我确认的经验（他自己验证过的做法）】\n' +
      experiences.map((e) => {
        const tag = e.type === '❌减分行为' ? '（避坑）' : e.level === '🔥核心原则' ? '（核心原则）' : '';
        return `· ${tag} ${String(e.content || '').slice(0, 200)}`;
      }).join('\n'));
  }
  if (knowledge.length) {
    parts.push('【知识资料·外部AI分析（别人的观点，未经他验证，仅供参考，不能当事实）】\n' +
      knowledge.map((k) => {
        const body = k.viewpoints || k.summary || k.knowledge || '';
        return `·《${k.title}》〔${k.domain}〕：${String(body).slice(0, 500)}`;
      }).join('\n'));
  }
  return { profileCount: profile.count, knowledge, experiences, text: parts.join('\n\n') };
}

// ============================================================
// Skill 05：决策卡
// ============================================================

const DECISION_TABLE = '决策卡';
const D_STATUS = { PENDING: '🟡待我拍板', DO: '✅决定做', DONT: '⛔决定不做', HOLD: '⏸暂缓' };

const DECISION_FIELDS = [
  { field_name: '决策事项', type: 1 },
  { field_name: '状态', type: 3, property: { options: Object.values(D_STATUS).map((name) => ({ name })) } },
  { field_name: '领域', type: 3, property: { options: DOMAIN_OPTIONS.map((name) => ({ name })) } },
  { field_name: '已知事实', type: 1 },
  { field_name: '我的既有判断', type: 1 },
  { field_name: '十维尽调', type: 1 },
  { field_name: '最大未知', type: 1 },
  { field_name: '可验证路径', type: 1 },
  { field_name: '可选方案', type: 1 },
  { field_name: 'AI倾向', type: 1 },
  { field_name: '我的最终决定', type: 1 },
  { field_name: '决定日期', type: 1 },
  { field_name: '计划复盘日期', type: 1 },
  { field_name: '复盘结论', type: 1 },
  { field_name: '创建时间', type: 1 },
];

const DECISION_SYSTEM = `你是用户的"重大决策尽调伙伴"。他会给一个"要不要做X"的决策问题，并附上他已确认的档案、经验和外部知识资料。
你要做的是帮他把这事儿查清楚、想周全，但绝不替他拍板。

严格输出 JSON（不要 markdown、不要解释），key 固定：
{"领域":"投资与周期|创业与变现|AI与第二大脑|学术与教育|内容创作|家庭与个人|其他",
"已知事实":["..."],"我的既有判断":["..."],
"十维尽调":{"项目":"","团队":"","商业模式":"","数据":"","风险":"","最小验证":"","最坏损失":"","资源":"","投入":"","退出条件":""},
"最大未知":["..."],"可验证路径":["..."],
"可选方案":[{"方案":"","取舍":""}],"AI倾向":"","AI倾向置信度":"低|中|高","证据充分度":"不足|部分|充分"}

填写铁律：
1. 「已知事实」只能来自：他【我的档案·已确认】里确认过的内容、他【我确认的经验】、以及他这次问题里亲口陈述的情况。拿不准的不要写成事实。
2. 「我的既有判断」只摘录他档案/经验里与本决策直接相关的原则和过往判断；没有就空数组。
3. 「十维尽调」逐项分析：项目(是什么/机会本质)、团队(谁来干/能力与信任)、商业模式(怎么成立/怎么回报)、数据(有哪些硬数据,缺什么)、风险(最可能怎么失败)、最小验证(最低成本先验证什么)、最坏损失(最坏会亏多少钱/时间/关系,能否承受)、资源(他有什么没什么)、投入(要投多少钱时间精力)、退出条件(出现什么信号就撤)。引用外部资料观点时在句末标"(外部观点,需核实)"。
4. 「最大未知」列出真正决定成败、目前却没答案的关键问题。
5. 「可验证路径」给 2-4 步最低成本、能在拍板前消除最大未知的验证动作。
6. 「可选方案」给 2-4 个真实可选项(含"暂缓/不做"),每个写清取舍,不替他选。
7. 「AI倾向」说清如果是你会偏向哪个方案以及理由,但必须明确这只是 AI 观点;证据不足时倾向写"先做最小验证再决定",置信度给"低",证据充分度如实标。
8. 涉及投资/健康/重大人生选择,风险和最坏损失要写充分,语气克制。
9. 全程不得编造档案、数据、案例;信息缺失就在对应处写"目前无依据"。`;

function createDecisionCenter(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    client: o.client || null,
    baseToken: o.baseToken || '',
    tableId: o.tableId || '',
    deps: {
      profileCenter: o.profileCenter || null,
      knowledgeCenter: o.knowledgeCenter || null,
      experienceCenter: o.experienceCenter || null,
    },
  };

  async function ensureTable() {
    if (cfg.tableId) return { ok: true, tableId: cfg.tableId };
    if (!cfg.client || !cfg.baseToken) return { ok: false, error: '决策卡未配置（需飞书授权 + LARK_BASE_TOKEN）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === DECISION_TABLE);
    if (hit) { cfg.tableId = hit.table_id; return { ok: true, tableId: cfg.tableId, existed: true }; }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: DECISION_TABLE, default_view_name: '全部决策', fields: DECISION_FIELDS },
    });
    cfg.tableId = created.table_id || (created.table && created.table.table_id) || '';
    if (!cfg.tableId) throw new Error('创建「决策卡」表失败');
    return { ok: true, tableId: cfg.tableId, created: true };
  }

  // 只做尽调分析，不落表
  async function analyze(question) {
    if (!cfg.apiKey) return { ok: false, error: '决策尽调未启用：需配置 DEEPSEEK_API_KEY' };
    const q = String(question || '').trim();
    if (!q) return { ok: false, error: '请先说清要决策什么' };
    const ctx = await collectContext(cfg.deps, q);
    const userMsg =
      (ctx.text || '（他的第二大脑里暂无与本决策相关的档案/经验/资料，以下只基于他这次的描述，证据充分度从严。）') +
      `\n\n他现在要决策的问题：${q}\n当前日期：${todayStr()}`;
    const raw = await deepseek.callDeepSeek(
      [{ role: 'system', content: DECISION_SYSTEM }, { role: 'user', content: userMsg }],
      cfg.apiKey
    );
    const a = extractJson(raw);
    if (!a) throw new Error('AI 尽调结果不是合法 JSON');
    return { ok: true, analysis: a, used: { profileConfirmed: ctx.profileCount, knowledge: ctx.knowledge.length, experiences: ctx.experiences.length } };
  }

  function tenDimText(a) {
    const d = a['十维尽调'] || {};
    const labels = [
      ['项目', '项目'], ['团队', '团队'], ['商业模式', '商业模式'], ['数据', '数据'], ['风险', '风险'],
      ['最小验证', '最小验证'], ['最坏损失', '最坏损失'], ['资源', '资源'], ['投入', '投入'], ['退出条件', '退出条件'],
    ];
    return labels.map(([k, label]) => `■ ${label}：${String(d[k] || '目前无依据').trim() || '目前无依据'}`).join('\n');
  }
  const listText = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n') : '');
  const optionsText = (arr) => Array.isArray(arr)
    ? arr.filter((x) => x && x['方案']).map((x, i) => `${i + 1}. ${x['方案']}｜取舍：${x['取舍'] || '—'}`).join('\n')
    : '';

  function toFields(question, a) {
    const aiLean = `${a.AI倾向 || ''}（AI倾向置信度：${a.AI倾向置信度 || '低'}；证据充分度：${a.证据充分度 || '不足'}）\n注：这是 AI 观点，不是你的决定。`;
    return {
      '决策事项': String(question).slice(0, 200),
      '状态': D_STATUS.PENDING,
      '领域': normDomain(a['领域']),
      '已知事实': listText(a['已知事实']).slice(0, 4000),
      '我的既有判断': listText(a['我的既有判断']).slice(0, 4000),
      '十维尽调': tenDimText(a).slice(0, 8000),
      '最大未知': listText(a['最大未知']).slice(0, 2000),
      '可验证路径': listText(a['可验证路径']).slice(0, 2000),
      '可选方案': optionsText(a['可选方案']).slice(0, 3000),
      'AI倾向': aiLean.slice(0, 2000),
      '创建时间': nowStr(),
    };
  }

  function mapRecord(r) {
    const f = (r && r.fields) || {};
    const g = (k) => String(f[k] || '');
    return {
      recordId: r.record_id,
      question: g('决策事项'), status: g('状态'), domain: g('领域'),
      facts: g('已知事实'), ownJudgments: g('我的既有判断'), dueDiligence: g('十维尽调'),
      unknowns: g('最大未知'), verifyPath: g('可验证路径'), options: g('可选方案'), aiLean: g('AI倾向'),
      finalDecision: g('我的最终决定'), decidedAt: g('决定日期'), reviewAt: g('计划复盘日期'), review: g('复盘结论'),
      createdAt: g('创建时间'),
    };
  }

  // 尽调 + 建一张 🟡待我拍板 卡（AI 不替用户决定）
  async function createFromQuestion(question) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const r = await analyze(question);
    if (!r.ok) return r;
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, toFields(question, r.analysis));
    return { ok: true, recordId: rec && rec.record_id, analysis: r.analysis, used: r.used, status: D_STATUS.PENDING };
  }

  // 会议上本人已拍板的决定（用户点按钮二次确认后调用）：直接建 ✅决定做 卡，不做 AI 十维尽调
  async function createConfirmedDecision(p) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const question = String((p && p.question) || '').trim();
    const decision = String((p && p.decision) || '').trim();
    if (!question) return { ok: false, error: '决策事项为空' };
    const basis = String((p && p.basis) || '').trim();
    const source = String((p && p.source) || '').slice(0, 120);
    const facts = [
      basis ? `会议上明确的依据：${basis}` : '',
      source ? `来源：${source}` : '',
      `[${todayStr()}] 会议现场已拍板，经本人在工作台二次确认后入库（未经 AI 尽调）。`,
    ].filter(Boolean).join('\n');
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, {
      '决策事项': question.slice(0, 200),
      '状态': D_STATUS.DO,
      '已知事实': facts.slice(0, 4000),
      '我的最终决定': (decision || question).slice(0, 4000),
      '决定日期': todayStr(),
      '创建时间': nowStr(),
    });
    return { ok: true, recordId: rec && rec.record_id, status: D_STATUS.DO };
  }

  async function listDecisions(filter) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const f = filter || {};
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    let items = ((data && data.items) || []).map(mapRecord);
    if (f.status) items = items.filter((x) => x.status === f.status);
    return { ok: true, items, total: items.length };
  }

  // 用户拍板：只有这里能把状态改成 做/不做/暂缓，并写最终决定
  async function decide(recordId, p) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const allowed = [D_STATUS.DO, D_STATUS.DONT, D_STATUS.HOLD];
    const status = allowed.includes(p.status) ? p.status : D_STATUS.HOLD;
    const fields = {
      '状态': status,
      '我的最终决定': String(p.decision != null ? p.decision : '').slice(0, 4000),
      '决定日期': todayStr(),
    };
    if (p.reviewAt) fields['计划复盘日期'] = String(p.reviewAt).slice(0, 20);
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, fields);
    return { ok: true, recordId, status };
  }

  // 事后复盘回填（决策日志：当时决定对不对、为什么）
  async function review(recordId, conclusion) {
    const st = await ensureTable();
    if (!st.ok) return st;
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, {
      '复盘结论': `[${todayStr()}] ${String(conclusion || '').slice(0, 4000)}`,
    });
    return { ok: true, recordId };
  }

  // 删除决策卡（飞书表记录物理删除，不可恢复）
  async function deleteDecision(recordId) {
    const st = await ensureTable();
    if (!st.ok) return st;
    if (!recordId) return { ok: false, error: '缺少 recordId' };
    await cfg.client.deleteBitableRecord(cfg.baseToken, cfg.tableId, recordId);
    return { ok: true, recordId };
  }

  function isReady() { return Boolean(cfg.client && cfg.baseToken); }

  return { isReady, ensureTable, analyze, createFromQuestion, createConfirmedDecision, listDecisions, decide, review, deleteDecision, constants: { TABLE_NAME: DECISION_TABLE, STATUS: D_STATUS, DOMAIN_OPTIONS } };
}

// ============================================================
// Skill 06：项目卡（长期项目推进）
// ============================================================

const PROJECT_TABLE = '项目卡';
const P_STATUS = { PLAN: '🌱规划中', DOING: '🚀推进中', PAUSE: '⏸暂停', DONE: '✅已完成', EXIT: '🚪已退出' };
const CYCLE = { FAST: '快反馈(按周)', MID: '中周期(按月)', LONG: '长周期(按季/年)' };
const TIMELINE_KEEP = 20;

const PROJECT_FIELDS = [
  { field_name: '项目名称', type: 1 },
  { field_name: '状态', type: 3, property: { options: Object.values(P_STATUS).map((name) => ({ name })) } },
  { field_name: '周期类型', type: 3, property: { options: Object.values(CYCLE).map((name) => ({ name })) } },
  { field_name: '领域', type: 3, property: { options: DOMAIN_OPTIONS.map((name) => ({ name })) } },
  { field_name: '目标与成功标准', type: 1 },
  { field_name: '阶段指标与里程碑', type: 1 },
  { field_name: '当前下一步', type: 1 },
  { field_name: '阻塞与风险', type: 1 },
  { field_name: '继续/退出条件', type: 1 },
  { field_name: '关联决策', type: 1 },
  { field_name: '最近进展', type: 1 },
  { field_name: '推进时间线', type: 1 },
  { field_name: 'AI阶段判断', type: 1 },
  { field_name: '最近推进日期', type: 1 },
  { field_name: '创建时间', type: 1 },
];

const PLAN_SYSTEM = `你是用户的项目规划助手。他给一个项目的初步想法，你结合他【已确认的档案/经验】帮他把项目卡的规划字段拟成草案。
这些是 AI 草案，不代表他已承诺推进；不要把一时兴趣写成既定目标。
严格输出 JSON（不要 markdown）：
{"周期类型":"快反馈(按周)|中周期(按月)|长周期(按季/年)","领域":"投资与周期|创业与变现|AI与第二大脑|学术与教育|内容创作|家庭与个人|其他",
"目标与成功标准":"","阶段指标与里程碑":"","当前下一步":"","阻塞与风险":"","继续/退出条件":""}
要求：
1. 目标要具体可检验；里程碑按所选周期拆 3-5 个阶段。
2. 「当前下一步」只给一个最小、本周/近期就能动手的动作。
3. 「继续/退出条件」必须写清：出现什么信号说明值得加码，出现什么信号该暂停或退出。
4. 结合他档案里的原则（如不投钱、边界、长期主义），冲突处明确指出。不编造档案里没有的资源或数据。`;

const ADVISE_SYSTEM = `你是用户的长期项目推进教练。给你一张项目卡现状和他刚记录的进展（可能为空），结合他【已确认的档案/经验】和外部资料，做一次推进判断。
严格输出 JSON（不要 markdown）：
{"更新后的下一步":"","阶段判断":"加码推进|按计划推进|维持观望|预警:考虑收缩|预警:触及退出条件","判断理由":"","阻塞破解":"","本周期复盘要点":"","是否触及退出条件":"否|是:..."}
要求：
1. 只给判断和建议，绝不替他更改项目状态（加码/暂停/退出必须他本人决定）。
2. 「更新后的下一步」给一个具体、可立即执行的动作。
3. 若进展触及他预设的退出条件，明确在"是否触及退出条件"指出，并给理由，但仍由他决定是否真的退出。
4. 按项目周期类型把握节奏：快反馈看周动作，中周期看月度指标，长周期看季度趋势，不要因短期波动喊退出。
5. 外部资料观点标注"(外部观点)"；不编造数据。`;

// 里程碑 → 可执行任务拆解（对标 spec-to-implementation：每条任务 1-2 天可完成、带可检验的验收标准）
const BREAKDOWN_SYSTEM = `你是用户的项目执行拆解助手。给你一张项目卡（目标/里程碑/下一步/风险），把近期该做的工作拆成 5-8 条具体任务。
严格输出 JSON（不要 markdown）：
{"tasks":[{"task":"任务内容（不超过40字）","criteria":"验收标准：做到什么程度算完成，要有可检验的产出物或判据","priority":"P0|P1|P2","aiSuitable":true|false}]}
要求：
1. 优先拆"当前下一步"相关动作，再按里程碑顺序往后拆；每条任务 1-2 天能完成，不拆成"推进X"这类无法验收的话。
2. 验收标准必须可检验（产出物、数量、明确判据），如"产出一份不超过10页的XX文档初稿"。
3. aiSuitable=true 仅限纯文本创作/分析/整理类（AI 能直接完成）；需真实世界操作（见人/操作App/线下）一律 false。
4. 依据只来自项目卡和他的档案/经验，不编造资源或数据。`;

function createProjectCenter(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    client: o.client || null,
    baseToken: o.baseToken || '',
    tableId: o.tableId || '',
    deps: {
      profileCenter: o.profileCenter || null,
      knowledgeCenter: o.knowledgeCenter || null,
      experienceCenter: o.experienceCenter || null,
    },
  };

  async function ensureTable() {
    if (cfg.tableId) return { ok: true, tableId: cfg.tableId };
    if (!cfg.client || !cfg.baseToken) return { ok: false, error: '项目卡未配置（需飞书授权 + LARK_BASE_TOKEN）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === PROJECT_TABLE);
    if (hit) { cfg.tableId = hit.table_id; return { ok: true, tableId: cfg.tableId, existed: true }; }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: PROJECT_TABLE, default_view_name: '全部项目', fields: PROJECT_FIELDS },
    });
    cfg.tableId = created.table_id || (created.table && created.table.table_id) || '';
    if (!cfg.tableId) throw new Error('创建「项目卡」表失败');
    return { ok: true, tableId: cfg.tableId, created: true };
  }

  function mapRecord(r) {
    const f = (r && r.fields) || {};
    const g = (k) => String(f[k] || '');
    return {
      recordId: r.record_id,
      name: g('项目名称'), status: g('状态'), cycle: g('周期类型'), domain: g('领域'),
      goal: g('目标与成功标准'), milestones: g('阶段指标与里程碑'), nextStep: g('当前下一步'),
      blockers: g('阻塞与风险'), exitRule: g('继续/退出条件'), relatedDecision: g('关联决策'),
      latest: g('最近进展'), timeline: g('推进时间线'), aiJudge: g('AI阶段判断'),
      lastProgressAt: g('最近推进日期'), createdAt: g('创建时间'),
    };
  }

  async function listProjects(filter) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const f = filter || {};
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    let items = ((data && data.items) || []).map(mapRecord);
    if (f.status) items = items.filter((x) => x.status === f.status);
    if (f.keyword) items = items.filter((x) => x.name.includes(f.keyword));
    return { ok: true, items, total: items.length };
  }

  async function getProject(recordId) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    const rec = (data && data.items || []).find((x) => x.record_id === recordId);
    if (!rec) return { ok: false, error: '未找到该项目卡' };
    return { ok: true, item: mapRecord(rec) };
  }

  // 新建项目：AI 可补全规划草案；状态始终 🌱规划中（不自动升级为推进中）
  async function createProject(p) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const param = p || {};
    const name = String(param.name || '').trim();
    if (!name) return { ok: false, error: '项目名称不能为空' };

    let plan = null;
    if (param.autoPlan !== false && cfg.apiKey) {
      try {
        const ctx = await collectContext(cfg.deps, name);
        const raw = await deepseek.callDeepSeek(
          [{ role: 'system', content: PLAN_SYSTEM },
           { role: 'user', content: (ctx.text || '（暂无相关档案）') + `\n\n项目初步想法：${name}\n补充说明：${param.brief || '（无）'}\n当前日期：${todayStr()}` }],
          cfg.apiKey
        );
        plan = extractJson(raw);
      } catch (e) { plan = null; }
    }

    const fields = {
      '项目名称': name.slice(0, 200),
      '状态': P_STATUS.PLAN,
      '周期类型': plan && Object.values(CYCLE).includes(plan['周期类型']) ? plan['周期类型'] : CYCLE.MID,
      '领域': normDomain(plan && plan['领域']),
      '目标与成功标准': String((plan && plan['目标与成功标准']) || '').slice(0, 3000),
      '阶段指标与里程碑': String((plan && plan['阶段指标与里程碑']) || '').slice(0, 4000),
      '当前下一步': String((plan && plan['当前下一步']) || '').slice(0, 1000),
      '阻塞与风险': String((plan && plan['阻塞与风险']) || '').slice(0, 2000),
      '继续/退出条件': String((plan && plan['继续/退出条件']) || '').slice(0, 2000),
      '关联决策': String(param.relatedDecision || '').slice(0, 200),
      '创建时间': nowStr(),
      '最近推进日期': todayStr(),
    };
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, fields);
    return { ok: true, recordId: rec && rec.record_id, status: P_STATUS.PLAN, planned: Boolean(plan) };
  }

  // 用户手动改状态/周期（AI 不调用这个）
  async function setStatus(recordId, p) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const fields = {};
    if (p.status && Object.values(P_STATUS).includes(p.status)) fields['状态'] = p.status;
    if (p.cycle && Object.values(CYCLE).includes(p.cycle)) fields['周期类型'] = p.cycle;
    if (!Object.keys(fields).length) return { ok: false, error: '没有可更新的状态' };
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, fields);
    return { ok: true, recordId, ...fields };
  }

  function projectSnapshot(it) {
    return [
      `项目：${it.name}（状态 ${it.status}，周期 ${it.cycle}）`,
      `目标与成功标准：${it.goal || '—'}`,
      `阶段指标与里程碑：${it.milestones || '—'}`,
      `当前下一步：${it.nextStep || '—'}`,
      `阻塞与风险：${it.blockers || '—'}`,
      `继续/退出条件：${it.exitRule || '—'}`,
      `最近进展：${it.latest || '—'}`,
    ].join('\n');
  }

  // 计算一次推进建议（不落表），供 addProgress / adviseProject 复用
  async function computeAdvise(it, progressNote) {
    if (!cfg.apiKey) return { ok: false, error: '项目推进建议未启用：需配置 DEEPSEEK_API_KEY' };
    const ctx = await collectContext(cfg.deps, `${it.name} ${progressNote || ''}`);
    const raw = await deepseek.callDeepSeek(
      [{ role: 'system', content: ADVISE_SYSTEM },
       { role: 'user', content:
          (ctx.text || '（暂无相关档案/资料）') +
          `\n\n【项目卡现状】\n${projectSnapshot(it)}` +
          `\n\n【刚记录的进展】\n${progressNote || '（本次无新进展，只做周期性体检）'}` +
          `\n当前日期：${todayStr()}` }],
      cfg.apiKey
    );
    const a = extractJson(raw);
    if (!a) throw new Error('AI 推进建议不是合法 JSON');
    return { ok: true, advise: a };
  }

  // 记录一次进展：追加时间线 + 更新最近进展；wantAdvise 时同时给 AI 推进判断（只更新 AI 字段，不动状态）
  async function addProgress(recordId, note, wantAdvise) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const got = await getProject(recordId);
    if (!got.ok) return got;
    const it = got.item;
    const n = String(note || '').trim();
    if (!n && !wantAdvise) return { ok: false, error: '进展内容为空' };

    const entry = `[${todayStr()}] ${n || '（周期体检）'}`;
    const timeline = [entry, ...String(it.timeline || '').split('\n').filter(Boolean)].slice(0, TIMELINE_KEEP).join('\n');
    const fields = { '推进时间线': timeline };
    if (n) { fields['最近进展'] = n.slice(0, 2000); fields['最近推进日期'] = todayStr(); }

    let advise = null;
    if (wantAdvise) {
      try {
        const r = await computeAdvise(it, n);
        if (r.ok) {
          advise = r.advise;
          if (advise['更新后的下一步']) fields['当前下一步'] = String(advise['更新后的下一步']).slice(0, 1000);
          const judge = `${advise['阶段判断'] || ''}\n理由：${advise['判断理由'] || '—'}\n阻塞破解：${advise['阻塞破解'] || '—'}\n复盘要点：${advise['本周期复盘要点'] || '—'}\n退出条件：${advise['是否触及退出条件'] || '—'}\n（${todayStr()} AI 建议，是否调整由你决定）`;
          fields['AI阶段判断'] = judge.slice(0, 3000);
        }
      } catch (e) { advise = { _error: e.message }; }
    }

    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, fields);
    return { ok: true, recordId, timelineEntries: timeline.split('\n').length, advise };
  }

  // 只做一次推进体检并返回（不改任何字段）
  async function adviseProject(recordId) {
    const got = await getProject(recordId);
    if (!got.ok) return got;
    return computeAdvise(got.item, '');
  }

  // 里程碑 → 带验收标准的任务清单（只出候选，不落表；用户确认后由任务中心批量写入）
  async function breakdownTasks(recordId) {
    if (!cfg.apiKey) return { ok: false, error: '任务拆解未启用：需配置 DEEPSEEK_API_KEY' };
    const got = await getProject(recordId);
    if (!got.ok) return got;
    const it = got.item;
    const ctx = await collectContext(cfg.deps, it.name);
    const raw = await deepseek.callDeepSeek(
      [{ role: 'system', content: BREAKDOWN_SYSTEM },
       { role: 'user', content:
          (ctx.text || '（暂无相关档案）') +
          `\n\n【项目卡现状】\n${projectSnapshot(it)}` +
          `\n当前日期：${todayStr()}` }],
      cfg.apiKey
    );
    const a = extractJson(raw);
    const list = (a && Array.isArray(a.tasks) ? a.tasks : [])
      .map((t) => ({
        task: String(t.task || '').trim().slice(0, 60),
        criteria: String(t.criteria || '').trim().slice(0, 300),
        priority: ['P0', 'P1', 'P2'].includes(t.priority) ? t.priority : 'P2',
        aiSuitable: t.aiSuitable === true,
      }))
      .filter((t) => t.task)
      .slice(0, 8);
    if (!list.length) throw new Error('AI 拆解结果不是合法任务清单');
    return { ok: true, projectName: it.name, recordId, tasks: list };
  }

  // 决策转立项：把已拍板（✅决定做）决策卡的尽调结论预填进项目卡，不要求用户重新描述
  // decision 为 decisionCenter.mapRecord 的条目
  async function createProjectFromDecision(decision) {
    const d = decision || {};
    if (!d.question) return { ok: false, error: '决策卡内容为空' };
    const brief = [
      `这张项目卡来自已拍板的决策卡《${d.question}》${d.decidedAt ? `（决定日期：${d.decidedAt}）` : ''}。`,
      d.facts ? `\n【已知事实】\n${d.facts}` : '',
      d.options ? `\n【拍板时的可选方案】\n${d.options}` : '',
      d.unknowns ? `\n【拍板时的最大未知】\n${d.unknowns}` : '',
      d.verifyPath ? `\n【拍板前的验证路径】\n${d.verifyPath}` : '',
      d.finalDecision ? `\n【他的最终决定】\n${d.finalDecision}` : '',
      '\n规划时以他的最终决定和已知事实为准；最大未知转成早期验证动作或风险预案。',
    ].join('');
    const r = await createProject({
      name: d.question,
      brief,
      autoPlan: true,
      relatedDecision: d.question,
    });
    if (r.ok) r.fromDecision = d.question;
    return r;
  }

  function isReady() { return Boolean(cfg.client && cfg.baseToken); }

  return {
    isReady, ensureTable, listProjects, getProject, createProject, createProjectFromDecision, breakdownTasks, setStatus, addProgress, adviseProject,
    constants: { TABLE_NAME: PROJECT_TABLE, STATUS: P_STATUS, CYCLE },
  };
}

module.exports = { createDecisionCenter, createProjectCenter, DOMAIN_OPTIONS };
