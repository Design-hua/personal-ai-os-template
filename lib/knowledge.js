// lib/knowledge.js
// 「知识资料」——第二大脑的外部知识层（第 2 步）
//
// 定位（V1.0/V2.0 信息纪律）：
//   这里放的是【外部资料 + AI 综合分析】（如 57 篇得到大脑 AI 分析）。
//   它们是供参考、供召回的"别人的观点和方法"，信息层级固定为 AI分析，
//   永远不进入「我的档案」的已确认层，不能被当成用户本人的观点。
//
// 飞书多维表格「知识资料」字段：
//   标题(主)/主题领域/信息层级/核心摘要/核心观点/可复用知识/作者/来源日期/来源平台/条目key
//
// 条目key 幂等：如 getdao::ab12cd34ef56，重复同步跳过，不覆盖人工修改。

'use strict';

const crypto = require('crypto');

const TABLE_NAME = '知识资料';
const LAYER = 'AI分析';
const SOURCE = '得到大脑';

const DOMAIN_OPTIONS = ['投资与周期', 'AI与第二大脑', '学术与教育', '内容创作', '创业与变现', '认知与个人成长', '其他'];

const FIELD_DEFS = [
  { field_name: '标题', type: 1 },
  { field_name: '主题领域', type: 3, property: { options: DOMAIN_OPTIONS.map((name) => ({ name })) } },
  { field_name: '信息层级', type: 3, property: { options: [{ name: LAYER }] } },
  { field_name: '核心摘要', type: 1 },
  { field_name: '核心观点', type: 1 },
  { field_name: '可复用知识', type: 1 },
  { field_name: '作者', type: 1 },
  { field_name: '来源日期', type: 1 },
  { field_name: '来源平台', type: 1 },
  { field_name: '条目key', type: 1 },
];

// ---------- 中文友好的关键词相关性（确定性，无 AI 调用）----------
// 中文按相邻两字(bigram)，英文/数字按单词。供本模块召回，也导出给思考伙伴复用。
function gramsOf(s) {
  const t = String(s || '').toLowerCase();
  const cjk = t.match(/[一-鿿]+/g) || [];
  const words = t.match(/[a-z0-9][a-z0-9.+#-]*/g) || [];
  const g = [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) g.push(seg.slice(i, i + 2));
  }
  for (const w of words) if (w.length > 1) g.push(w);
  return g;
}

// query 与单段文本的命中 gram 数（去重计数，避免长文靠重复刷分）
function matchCount(queryGramSet, text) {
  const seen = new Set();
  let n = 0;
  for (const g of gramsOf(text)) {
    if (queryGramSet.has(g) && !seen.has(g)) { seen.add(g); n++; }
  }
  return n;
}

function createKnowledgeCenter(opts) {
  const o = opts || {};
  const cfg = {
    client: o.client || null,
    baseToken: o.baseToken || '',
    tableId: o.tableId || '',
  };

  async function ensureTable() {
    if (cfg.tableId) return { ok: true, tableId: cfg.tableId };
    if (!cfg.client || !cfg.baseToken) return { ok: false, error: '知识资料未配置（需飞书授权 + LARK_BASE_TOKEN）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === TABLE_NAME);
    if (hit) {
      cfg.tableId = hit.table_id;
      return { ok: true, tableId: cfg.tableId, existed: true };
    }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: TABLE_NAME, default_view_name: '全部资料', fields: FIELD_DEFS },
    });
    cfg.tableId = created.table_id || (created.table && created.table.table_id) || '';
    if (!cfg.tableId) throw new Error('创建「知识资料」表失败：未返回 table_id');
    return { ok: true, tableId: cfg.tableId, created: true };
  }

  function normalizeItem(it) {
    const x = it || {};
    return {
      key: String(x.key || '').slice(0, 120),
      title: String(x.title || '').slice(0, 200),
      domain: DOMAIN_OPTIONS.includes(x.domain) ? x.domain : '其他',
      summary: String(x.summary || '').slice(0, 1000),
      viewpoints: String(x.viewpoints || '').slice(0, 6000),
      knowledge: String(x.knowledge || '').slice(0, 3000),
      author: String(x.author || '').slice(0, 60),
      date: String(x.date || '').slice(0, 20),
    };
  }

  function toFields(x) {
    const f = {
      '标题': x.title,
      '主题领域': x.domain,
      '信息层级': LAYER,
    };
    if (x.summary) f['核心摘要'] = x.summary;
    if (x.viewpoints) f['核心观点'] = x.viewpoints;
    if (x.knowledge) f['可复用知识'] = x.knowledge;
    if (x.author) f['作者'] = x.author;
    if (x.date) f['来源日期'] = x.date;
    f['来源平台'] = x.source || SOURCE;
    if (x.key) f['条目key'] = x.key;
    return f;
  }

  /** 幂等同步：按条目key去重，已存在跳过。 */
  async function syncSeed(items) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const norm = (items || []).map(normalizeItem).filter((x) => x.title && x.key);
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
   * 保存一条自产研究资料（思考伙伴回答等 AI 研究产出），按条目key幂等。
   * 纪律：信息层级固定=AI分析、来源平台固定=自产研究——只进「知识资料」表，
   * 绝不进「我的档案」已确认层，召回时永远标注为外部/待验证观点。
   * @param {object} item { question, reply, title?, domain?, author?, key? }
   */
  async function saveResearch(item) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const x = item || {};
    const reply = String(x.reply || '').trim();
    if (!reply) return { ok: false, error: '研究内容为空，无法保存' };
    const question = String(x.question || '').trim();
    const key =
      String(x.key || '').trim() ||
      'selfresearch::' + crypto.createHash('sha1').update(reply).digest('hex').slice(0, 12);
    const title = String(x.title || (question ? `研究·${question}` : `研究·${reply.slice(0, 24)}`));
    const firstPara = (reply.split(/\n{2,}/)[0] || reply).trim();
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间
    const norm = normalizeItem({
      key,
      title,
      domain: x.domain,
      summary: firstPara,
      viewpoints: reply,
      author: String(x.author || '思考伙伴'),
      date,
    });
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    const exist = ((data && data.items) || []).find(
      (r) => String((r.fields && r.fields['条目key']) || '') === norm.key
    );
    if (exist) return { ok: true, duplicated: true, recordId: exist.record_id };
    const created = await cfg.client.batchCreateBitableRecords(cfg.baseToken, cfg.tableId, [
      { fields: toFields({ ...norm, source: '自产研究' }) },
    ]);
    const rec = (created && created[0]) || null;
    return { ok: true, created: true, recordId: (rec && rec.record_id) || '' };
  }

  function mapRecord(r) {
    const f = (r && r.fields) || {};
    return {
      recordId: r.record_id,
      title: String(f['标题'] || ''),
      domain: String(f['主题领域'] || ''),
      layer: String(f['信息层级'] || LAYER),
      summary: String(f['核心摘要'] || ''),
      viewpoints: String(f['核心观点'] || ''),
      knowledge: String(f['可复用知识'] || ''),
      author: String(f['作者'] || ''),
      date: String(f['来源日期'] || ''),
      source: String(f['来源平台'] || ''),
      key: String(f['条目key'] || ''),
    };
  }

  async function listKnowledge(filter) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const f = filter || {};
    const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { fetchAll: true });
    let items = ((data && data.items) || []).map(mapRecord);
    if (f.domain) items = items.filter((x) => x.domain === f.domain);
    if (f.keyword) {
      const kw = String(f.keyword).toLowerCase();
      items = items.filter((x) =>
        [x.title, x.summary, x.viewpoints, x.knowledge].some((s) => s.toLowerCase().includes(kw))
      );
    }
    if (f.max) items = items.slice(0, f.max);
    return { ok: true, items, total: items.length };
  }

  // 删除知识资料记录（飞书表物理删除，不可恢复）
  async function deleteKnowledge(recordId) {
    const st = await ensureTable();
    if (!st.ok) return st;
    if (!recordId) return { ok: false, error: '缺少 recordId' };
    await cfg.client.deleteBitableRecord(cfg.baseToken, cfg.tableId, recordId);
    return { ok: true, recordId };
  }

  /**
   * 按问题相关性召回资料（bigram 匹配，标题权重高）。
   * 多路召回：先整句召回；命中不足 max 时，把查询按标点/空白切成关键词片段（取最长的4段）
   * 逐段补召回，按标题去重合并——把被整句噪声淹没的高相关资料捞回来。纯本地计算，不增加 AI 调用。
   * @returns {ok, items:[{title,domain,date,author,score,summary,viewpoints,knowledge}]}
   */
  async function recall(query, opt) {
    const o2 = opt || {};
    const r = await listKnowledge(o2.domain ? { domain: o2.domain } : {});
    if (!r.ok) return r;
    const qset = new Set(gramsOf(query));
    if (!qset.size) return { ok: true, items: [], total: 0 };
    const want = o2.max || 6;
    const scored = r.items.map((x) => {
      const s =
        matchCount(qset, x.title) * 3 +
        matchCount(qset, x.summary) * 1 +
        matchCount(qset, x.knowledge) * 1 +
        matchCount(qset, x.viewpoints.slice(0, 1200)) * 1;
      return { ...x, score: s };
    });
    const pick = (x) => ({
      title: x.title, domain: x.domain, date: x.date, author: x.author, source: x.source || SOURCE,
      score: x.score,
      summary: x.summary.slice(0, 300),
      viewpoints: x.viewpoints.slice(0, 900),
      knowledge: x.knowledge.slice(0, 500),
    });
    // 第一路：整句召回。score≥2 才算相关——滤掉只命中单个噪声 bigram（如"的选""的是"）的误匹配
    let items = scored
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, want)
      .map(pick);
    // 第二路：整句结果不足时，用查询里最稀有的关键词（在资料标题中出现得少=区分度高）
    // 逐词补召回，按标题去重合并——只命中一个主题词的资料也能被捞回。纯本地计算，不增加 AI 调用。
    if (items.length < want) {
      const df = new Map();
      for (const g of qset) {
        let n = 0;
        for (const x of r.items) if (x.title.includes(g)) n++;
        if (n > 0) df.set(g, n);
      }
      const kws = [...df.entries()].sort((a, b) => a[1] - b[1]).slice(0, 4).map((e) => e[0]);
      const seen = new Set(items.map((x) => x.title));
      for (const kw of kws) {
        if (items.length >= want) break;
        const sub = scored
          .filter((x) => x.score > 0 && !seen.has(x.title) && (x.title.includes(kw) || x.summary.includes(kw) || x.knowledge.includes(kw)))
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        for (const x of sub) {
          seen.add(x.title);
          items.push(pick(x));
          if (items.length >= want) break;
        }
      }
    }
    return { ok: true, items, total: items.length };
  }

  async function getOverview() {
    const r = await listKnowledge({});
    if (!r.ok) return r;
    const byDomain = {};
    for (const it of r.items) byDomain[it.domain] = (byDomain[it.domain] || 0) + 1;
    return { ok: true, total: r.items.length, byDomain };
  }

  function isReady() {
    return Boolean(cfg.client && cfg.baseToken);
  }

  return {
    isReady,
    ensureTable,
    syncSeed,
    saveResearch,
    listKnowledge,
    deleteKnowledge,
    recall,
    getOverview,
    constants: { TABLE_NAME, LAYER, SOURCE, DOMAIN_OPTIONS },
  };
}

module.exports = { createKnowledgeCenter, gramsOf, matchCount, TABLE_NAME, LAYER, DOMAIN_OPTIONS };
