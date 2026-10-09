// lib/profile.js
// 「我的档案」——Skill 01 认识我 的在线层
//
// 严格执行《个人AI操作系统》原则：
//   1. 信息层级不混淆：每条档案必须带 信息层级（已验证事实/我的确认判断/我的陈述/我的经历/我的假设/AI推断）
//   2. AI 推断必须标记：AI 产出只能以「🟡待我确认」进入，永远不能直接冒充我的观点
//   3. 我的观点需要确认：只有「✅我已确认」的条目才进入稳定个人知识层，供 AI 召回
//   4. 保留历史变化：过时/被替代的条目标状态，不删除
//
// 飞书多维表格「我的档案」字段：
//   内容(主) / 领域 / 信息层级 / 条目类型 / 确认状态 / 来源文件 / 来源时间 / 条目key / 备注
//
// 条目key 是幂等同步的唯一标识（如 facts::sec8 / cog01::MY_JUDGMENT::3），重复同步不建行。

'use strict';

const TABLE_NAME = '我的档案';

const DOMAIN_OPTIONS = [
  '核心原则', '已确认事实',
  '学术与研究', '国际教育业务', '黄金项目', '投资研究',
  'AI与第二大脑', '家庭与儿子', '个人认知与世界观', '我的身份与背景', '其他碎片',
];
const LAYER_OPTIONS = ['已验证事实', '我的确认判断', '我的陈述', '我的经历', '我的假设', 'AI推断'];
const KIND_OPTIONS = ['事实', '核心原则', '判断', '陈述', '经历', '假设', '目标', '项目', '关注主题', 'AI推断'];
const STATUS_CONFIRMED = '✅我已确认';
const STATUS_PENDING = '🟡待我确认';
const STATUS_OPTIONS = [STATUS_CONFIRMED, STATUS_PENDING, '⌛已过时', '🔁被新判断替代'];

const FIELD_DEFS = [
  { field_name: '内容', type: 1 },
  { field_name: '领域', type: 3, property: { options: DOMAIN_OPTIONS.map((name) => ({ name })) } },
  { field_name: '信息层级', type: 3, property: { options: LAYER_OPTIONS.map((name) => ({ name })) } },
  { field_name: '条目类型', type: 3, property: { options: KIND_OPTIONS.map((name) => ({ name })) } },
  { field_name: '确认状态', type: 3, property: { options: STATUS_OPTIONS.map((name) => ({ name })) } },
  { field_name: '来源文件', type: 1 },
  { field_name: '来源时间', type: 1 },
  { field_name: '条目key', type: 1 },
  { field_name: '备注', type: 1 },
];

function createProfileCenter(opts) {
  const o = opts || {};
  const cfg = {
    client: o.client || null,
    baseToken: o.baseToken || '',
    tableId: o.tableId || '',
  };

  async function ensureTable() {
    if (cfg.tableId) return { ok: true, tableId: cfg.tableId };
    if (!cfg.client || !cfg.baseToken) return { ok: false, error: '我的档案未配置（需飞书授权 + LARK_BASE_TOKEN）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === TABLE_NAME);
    if (hit) {
      cfg.tableId = hit.table_id;
      return { ok: true, tableId: cfg.tableId, existed: true };
    }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: TABLE_NAME, default_view_name: '全部档案', fields: FIELD_DEFS },
    });
    cfg.tableId = created.table_id || (created.table && created.table.table_id) || '';
    if (!cfg.tableId) throw new Error('创建「我的档案」表失败：未返回 table_id');
    return { ok: true, tableId: cfg.tableId, created: true };
  }

  function normalizeItem(it) {
    const x = it || {};
    return {
      key: String(x.key || '').slice(0, 120),
      content: String(x.content || '').slice(0, 5000),
      domain: DOMAIN_OPTIONS.includes(x.domain) ? x.domain : '其他碎片',
      layer: LAYER_OPTIONS.includes(x.layer) ? x.layer : '我的陈述',
      kind: KIND_OPTIONS.includes(x.kind) ? x.kind : '陈述',
      status: STATUS_OPTIONS.includes(x.status) ? x.status : STATUS_PENDING,
      sourceFile: String(x.sourceFile || '').slice(0, 120),
      sourceTime: String(x.sourceTime || '').slice(0, 40),
      note: String(x.note || '').slice(0, 500),
    };
  }

  function toFields(x) {
    const f = {
      '内容': x.content,
      '领域': x.domain,
      '信息层级': x.layer,
      '条目类型': x.kind,
      '确认状态': x.status,
    };
    if (x.sourceFile) f['来源文件'] = x.sourceFile;
    if (x.sourceTime) f['来源时间'] = x.sourceTime;
    if (x.key) f['条目key'] = x.key;
    if (x.note) f['备注'] = x.note;
    return f;
  }

  /**
   * 幂等同步种子档案：按「条目key」去重，已存在的 key 跳过（不覆盖用户在飞书里做的确认/修改）。
   * @returns {object} { ok, total, inserted, skipped }
   */
  async function syncSeed(items) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const norm = (items || []).map(normalizeItem).filter((x) => x.content && x.key);
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    const existKeys = new Set(
      ((data && data.items) || []).map((r) => String((r.fields && r.fields['条目key']) || ''))
    );
    const fresh = norm.filter((x) => !existKeys.has(x.key));
    if (fresh.length) {
      await cfg.client.batchCreateBitableRecords(
        cfg.baseToken,
        cfg.tableId,
        fresh.map((x) => ({ fields: toFields(x) }))
      );
    }
    return { ok: true, total: norm.length, inserted: fresh.length, skipped: norm.length - fresh.length };
  }

  /**
   * 写入一条 AI 推断/新档案。AI 来源一律强制 🟡待我确认 + 层级 AI推断，防止冒充用户观点。
   */
  async function addItem(raw) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const x = normalizeItem(raw);
    if (!x.content) return { ok: false, error: '内容为空' };
    if (!x.key) x.key = 'manual::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, toFields(x));
    return { ok: true, recordId: rec && rec.record_id };
  }

  // AI 推断专用入口：无论调用方传什么，层级/状态都钉死
  async function addInference(raw) {
    return addItem({ ...(raw || {}), layer: 'AI推断', kind: (raw && raw.kind) || 'AI推断', status: STATUS_PENDING });
  }

  function mapRecord(r) {
    const f = (r && r.fields) || {};
    return {
      recordId: r.record_id,
      content: String(f['内容'] || ''),
      domain: String(f['领域'] || ''),
      layer: String(f['信息层级'] || ''),
      kind: String(f['条目类型'] || ''),
      status: String(f['确认状态'] || ''),
      sourceFile: String(f['来源文件'] || ''),
      sourceTime: String(f['来源时间'] || ''),
      key: String(f['条目key'] || ''),
      note: String(f['备注'] || ''),
    };
  }

  // 列档案（可按状态/领域过滤）
  async function listProfiles(filter) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const f = filter || {};
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    let items = ((data && data.items) || []).map(mapRecord);
    if (f.status) items = items.filter((x) => x.status === f.status);
    if (f.domain) items = items.filter((x) => x.domain === f.domain);
    if (f.layer) items = items.filter((x) => x.layer === f.layer);
    if (f.keyword) {
      const kw = String(f.keyword).toLowerCase();
      items = items.filter((x) => x.content.toLowerCase().includes(kw));
    }
    return { ok: true, items, total: items.length };
  }

  /**
   * 供 AI（思考伙伴/写作室）召回的稳定个人知识层：仅 ✅我已确认。
   * 返回按领域聚合的纯文本摘要；AI 推断和待确认条目不进入，避免污染认知模型。
   */
  async function getConfirmedDigest(opts2) {
    const opt = opts2 || {};
    const r = await listProfiles({ status: STATUS_CONFIRMED });
    if (!r.ok) return r;
    const groups = new Map();
    for (const it of r.items) {
      if (!groups.has(it.domain)) groups.set(it.domain, []);
      groups.get(it.domain).push(it);
    }
    const parts = [];
    for (const [domain, list] of groups) {
      const lines = list.slice(0, opt.perDomain || 60).map((x) => {
        const tag = x.kind && x.kind !== '陈述' && x.kind !== '事实' ? `[${x.kind}] ` : '';
        return `- ${tag}${x.content}`;
      });
      parts.push(`## ${domain}（${list.length}条）\n${lines.join('\n')}`);
    }
    return {
      ok: true,
      count: r.items.length,
      text: parts.join('\n\n'),
      pendingCount: (await listProfiles({ status: STATUS_PENDING })).total,
    };
  }

  // 用户在工作台/飞书确认、否定、标记过时
  async function setStatus(recordId, status, note) {
    const st = await ensureTable();
    if (!st.ok) return st;
    if (!STATUS_OPTIONS.includes(status)) return { ok: false, error: '非法状态' };
    const fields = { '确认状态': status };
    if (note !== undefined) fields['备注'] = String(note).slice(0, 500);
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, fields);
    return { ok: true, recordId, status };
  }

  function isReady() {
    return Boolean(cfg.client && cfg.baseToken);
  }

  return {
    isReady,
    ensureTable,
    syncSeed,
    addItem,
    addInference,
    listProfiles,
    getConfirmedDigest,
    setStatus,
    constants: { TABLE_NAME, STATUS_CONFIRMED, STATUS_PENDING, DOMAIN_OPTIONS, LAYER_OPTIONS, STATUS_OPTIONS },
  };
}

module.exports = { createProfileCenter };
