// lib/experience.js
// 经验复盘中心（板块二）：✅加分 / ❌减分 / 🟡中性观察 × 普通 / 🔥核心原则
//
// 飞书多维表格「经验复盘」：
//   经验内容（文本）/ 类型 / 级别 / 分类 / 话题簇（单选）/ 关联视频（文本）/ 来源（文本）
// 另：视频表加「值得模仿」数字列（1-5 星），作为冷启动阶段的数据锚点。
//
// 工作方式：
//   1. ensureTable() 按表名查找，不存在则自动建表
//   2. addExperience() 写入一条经验（手动记录 / 评价转经验 / 视频卡记经验）
//   3. classifyReview() 用 DeepSeek 把评价文本预填为类型/级别/分类（失败降级为默认值）
//   4. rateVideo() 给视频表写 1-5 星「值得模仿」评分

'use strict';

const deepseek = require('./deepseek');

const TABLE_NAME = '经验复盘';

const TYPE_OPTIONS = ['✅加分行为', '❌减分行为', '🟡中性观察'];
const LEVEL_OPTIONS = ['普通经验', '🔥核心原则'];
const CATEGORY_OPTIONS = ['选题', '标题', '开头钩子', '结构', '脚本文案', '拍摄呈现', '运营发布', '心态认知'];
const CLUSTER_OPTIONS = ['AI与第二大脑', '认知与决策', '搞钱与周期', '家庭与教育', '高校生存', '个人成长'];
const RATE_FIELD = '值得模仿';
const CONFIRM_FIELD = '确认状态';
const CONFIRM_YES = '✅我已确认';
const CONFIRM_PENDING = '🟡待我确认';
const CONFIRM_OPTIONS = [CONFIRM_YES, CONFIRM_PENDING];

const FIELD_DEFS = [
  { field_name: '经验内容', type: 1 },
  { field_name: '类型', type: 3, property: { options: TYPE_OPTIONS.map((name) => ({ name })) } },
  { field_name: '级别', type: 3, property: { options: LEVEL_OPTIONS.map((name) => ({ name })) } },
  { field_name: '分类', type: 3, property: { options: CATEGORY_OPTIONS.map((name) => ({ name })) } },
  { field_name: '话题簇', type: 3, property: { options: CLUSTER_OPTIONS.map((name) => ({ name })) } },
  { field_name: '关联视频', type: 1 },
  { field_name: '来源', type: 1 },
  // 用户亲手记/自己的评价 → ✅我已确认；AI 从妙记/录音/图片自动提炼 → 🟡待我确认
  { field_name: CONFIRM_FIELD, type: 3, property: { options: CONFIRM_OPTIONS.map((name) => ({ name })) } },
];

const CLASSIFY_SYSTEM = `把用户对短视频的评价归类为经验卡片。只返回严格 JSON，不要多余解释：
{"type":"✅加分行为|❌减分行为|🟡中性观察","level":"普通经验|🔥核心原则","category":"选题|标题|开头钩子|结构|脚本文案|拍摄呈现|运营发布|心态认知"}

判断依据：
- 用户表达不认同/指出错误/踩坑 → ❌减分行为；表达收获/认同/好方法 → ✅加分行为；中性陈述观察 → 🟡中性观察
- 原则性、可复用的大启发 → 🔥核心原则；一般记录 → 普通经验
- 分类看评价针对什么：选题判断→选题；标题写法→标题；前3秒留人→开头钩子；段落节奏→结构；口播文案→脚本文案；镜头/出镜表现→拍摄呈现；发布数据/标签→运营发布；认知心态→心态认知`;

function createExperienceCenter(opts) {
  const o = opts || {};
  const cfg = {
    client: o.client || null, // lib/lark.js 客户端
    baseToken: o.baseToken || '',
    apiKey: o.apiKey || '',
    expTableId: o.expTableId || '', // 留空自动按表名查找/创建
    videoTableId: o.videoTableId || '', // 视频表：评分写入用
  };

  async function ensureTable() {
    if (cfg.expTableId) return { ok: true, tableId: cfg.expTableId };
    if (!cfg.client || !cfg.baseToken) return { ok: false, error: '经验复盘未配置（需飞书授权 + LARK_BASE_TOKEN）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === TABLE_NAME);
    if (hit) {
      cfg.expTableId = hit.table_id;
      await ensureFields();
      return { ok: true, tableId: cfg.expTableId, existed: true };
    }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: TABLE_NAME, default_view_name: '全部经验', fields: FIELD_DEFS },
    });
    cfg.expTableId = (created && created.table_id) || '';
    if (!cfg.expTableId) throw new Error('创建「经验复盘」表失败：未返回 table_id');
    return { ok: true, tableId: cfg.expTableId, created: true };
  }

  // 老表补建新增字段（如「确认状态」）；已存在则忽略报错
  let fieldsEnsured = false;
  async function ensureFields() {
    if (fieldsEnsured || !cfg.expTableId) return;
    try {
      const have = new Set((await cfg.client.listBitableFields(cfg.baseToken, cfg.expTableId)).map((f) => f.field_name));
      for (const def of FIELD_DEFS) {
        if (!have.has(def.field_name)) {
          await cfg.client.createBitableField(cfg.baseToken, cfg.expTableId, def);
        }
      }
    } catch (e) { /* 字段补建失败不阻塞写入 */ }
    fieldsEnsured = true;
  }

  // DeepSeek 预填评价的类型/级别/分类；失败降级默认值
  async function classifyReview(text) {
    const fallback = { type: '🟡中性观察', level: '普通经验', category: '心态认知' };
    try {
      const raw = await deepseek.callDeepSeek(
        [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: String(text || '').slice(0, 800) },
        ],
        cfg.apiKey
      );
      const s = String(raw || '').replace(/```json|```/gi, '');
      const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
      return {
        type: TYPE_OPTIONS.includes(j.type) ? j.type : fallback.type,
        level: LEVEL_OPTIONS.includes(j.level) ? j.level : fallback.level,
        category: CATEGORY_OPTIONS.includes(j.category) ? j.category : fallback.category,
      };
    } catch (e) {
      return fallback;
    }
  }

  /**
   * 写入一条经验
   * @param {object} e { content, type, level, category, cluster, videoTitle, source, confirmed }
   *   confirmed: true=用户主动记录/自己的评价（默认✅我已确认）；false=AI自动提炼（🟡待我确认）
   */
  async function addExperience(e) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const fields = {
      经验内容: String((e && e.content) || '').slice(0, 1000),
      类型: TYPE_OPTIONS.includes(e.type) ? e.type : '🟡中性观察',
      级别: LEVEL_OPTIONS.includes(e.level) ? e.level : '普通经验',
      [CONFIRM_FIELD]: e.confirmed === false ? CONFIRM_PENDING : CONFIRM_YES,
    };
    if (e.category && CATEGORY_OPTIONS.includes(e.category)) fields['分类'] = e.category;
    if (e.cluster && CLUSTER_OPTIONS.includes(e.cluster)) fields['话题簇'] = e.cluster;
    if (e.videoTitle) fields['关联视频'] = String(e.videoTitle).slice(0, 200);
    fields['来源'] = String(e.source || '手动记录').slice(0, 30);
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, cfg.expTableId, fields);
    return { ok: true, recordId: rec && rec.record_id };
  }

  // 评价转经验：来自用户本人评价 → 直接视为已确认
  async function fromReview(review) {
    const r = review || {};
    const cls = await classifyReview(r.text);
    return addExperience({
      content: r.text,
      type: cls.type,
      level: cls.level,
      category: cls.category,
      cluster: r.cluster || '',
      videoTitle: r.videoTitle || '',
      source: '我的评价',
      confirmed: true,
    });
  }

  // 列出经验（支持类型/话题簇筛选，最新在前）
  async function listExperiences(filter) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const f = filter || {};
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.expTableId, { pageSize: 200 });
    const items = ((data && data.items) || [])
      .map((r) => ({
        recordId: r.record_id,
        content: String((r.fields && r.fields['经验内容']) || ''),
        type: String((r.fields && r.fields['类型']) || ''),
        level: String((r.fields && r.fields['级别']) || ''),
        category: String((r.fields && r.fields['分类']) || ''),
        cluster: String((r.fields && r.fields['话题簇']) || ''),
        videoTitle: String((r.fields && r.fields['关联视频']) || ''),
        source: String((r.fields && r.fields['来源']) || ''),
        confirmed: String((r.fields && r.fields[CONFIRM_FIELD]) || CONFIRM_YES),
      }))
      .filter((it) => (!f.type || it.type === f.type) && (!f.cluster || it.cluster === f.cluster) && (!f.confirmed || it.confirmed === f.confirmed));
    return { ok: true, items };
  }

  // 视频表「值得模仿」字段是否已补建（模块级只跑一次）
  let rateFieldReady = false;
  async function ensureRateField() {
    if (rateFieldReady) return;
    try {
      await cfg.client.createBitableField(cfg.baseToken, cfg.videoTableId, {
        field_name: RATE_FIELD,
        type: 2, // 数字
      });
    } catch (e) { /* 字段已存在等错误忽略 */ }
    rateFieldReady = true;
  }

  // 给视频打 1-5 星「值得模仿」分（按链接定位视频表记录）
  async function rateVideo(url, score) {
    if (!cfg.client || !cfg.baseToken || !cfg.videoTableId) {
      return { ok: false, error: '视频评分未配置（需 LARK_VIDEO_TABLE_ID）' };
    }
    await ensureRateField();
    const s = Math.max(0, Math.min(5, Number(score) || 0));
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.videoTableId, { pageSize: 200 });
    const hit = ((data && data.items) || []).find((r) => {
      const v = r.fields && r.fields['链接'];
      const link = typeof v === 'string' ? v : String((v && (v.link || v.text)) || '');
      return link.includes(String(url));
    });
    if (!hit) return { ok: false, error: '视频表中未找到该链接的记录' };
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.videoTableId, hit.record_id, {
      [RATE_FIELD]: s,
    });
    return { ok: true, score: s };
  }

  function isReady() {
    return Boolean(cfg.client && cfg.baseToken);
  }

  return { isReady, ensureTable, addExperience, fromReview, listExperiences, rateVideo, classifyReview };
}

module.exports = { createExperienceCenter, RATE_FIELD, CONFIRM_FIELD, CONFIRM_YES, CONFIRM_PENDING };
