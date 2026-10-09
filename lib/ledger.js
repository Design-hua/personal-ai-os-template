// 记账中心：飞书多维表格「记账」
// 字段：日期(5) / 项目(3单选) / 人数(2) / 单价(2) / 金额(2) / 收支(3单选) / 备注(1) / 来源(3单选)
// 课时收入场景：金额 = 人数 × 单价；普通收支：人数/单价留空，直接填金额
'use strict';

const deepseek = require('./deepseek');

const TABLE_NAME = '记账';
const PROJECT_OPTIONS = ['明诚', '青苗', '柠檬'];
const IO_OPTIONS = ['收入', '支出'];
const SOURCE_OPTIONS = ['💬聊天', '📸截图', '✋手动'];

// 单价规则（用户拍板 2026-10-07）：
//   支出（付老师课时费）：明诚/青苗 90 元/人，柠檬 100 元/人 —— 按实际上课人数
//   收入（收学校课时费）：明诚 161、青苗 168、柠檬 180 元/人 —— 按全勤名单人数
const EXPENSE_PRICES = { 明诚: 90, 青苗: 90, 柠檬: 100 };
const INCOME_PRICES = { 明诚: 161, 青苗: 168, 柠檬: 180 };
function expensePriceOf(project) { return EXPENSE_PRICES[project] || 90; }
function incomePriceOf(project) { return INCOME_PRICES[project] || 161; }

const FIELD_DEFS = [
  { field_name: '日期', type: 5 },
  { field_name: '项目', type: 3, property: { options: PROJECT_OPTIONS.map((name) => ({ name })) } },
  { field_name: '人数', type: 2 },
  { field_name: '单价', type: 2 },
  { field_name: '金额', type: 2 },
  { field_name: '收支', type: 3, property: { options: IO_OPTIONS.map((name) => ({ name })) } },
  { field_name: '备注', type: 1 },
  { field_name: '来源', type: 3, property: { options: SOURCE_OPTIONS.map((name) => ({ name })) } },
];

function createLedgerCenter(cfg) {
  const client = cfg.client;

  let tableIdPromise = null;
  async function ensureTable() {
    if (cfg.ledgerTableId) return cfg.ledgerTableId;
    if (tableIdPromise) return tableIdPromise;
    tableIdPromise = (async () => {
      const tables = await client.listBitableTables(cfg.baseToken);
      const found = (tables || []).find((t) => t.name === TABLE_NAME);
      if (found) {
        const have = new Set((await client.listBitableFields(cfg.baseToken, found.table_id)).map((f) => f.field_name));
        for (const def of FIELD_DEFS) {
          if (!have.has(def.field_name)) {
            await client.createBitableField(cfg.baseToken, found.table_id, def).catch(() => {});
          }
        }
        return found.table_id;
      }
      const created = await client.createBitableTable(cfg.baseToken, {
        table: { name: TABLE_NAME, default_view_name: '全部账目', fields: FIELD_DEFS },
      });
      return created.table_id;
    })();
    return tableIdPromise;
  }

  function toTs(date) {
    if (typeof date === 'number') return date;
    return new Date(String(date).slice(0, 10) + 'T00:00:00+08:00').getTime();
  }

  function mapRecord(r) {
    const f = r.fields || {};
    return {
      recordId: r.record_id,
      date: f['日期'] || '',
      project: f['项目'] || '',
      headcount: f['人数'] ?? '',
      unitPrice: f['单价'] ?? '',
      amount: f['金额'] ?? 0,
      io: f['收支'] || '',
      note: f['备注'] || '',
      source: f['来源'] || '',
    };
  }

  // { date:'YYYY-MM-DD', project, headcount, unitPrice, amount, io:'收入'|'支出', note, source }
  // 课时模式：给 headcount+unitPrice，金额自动算；普通模式：直接给 amount
  async function addRecord(e) {
    const tid = await ensureTable();
    let amount = Number(e.amount) || 0;
    if (!amount && e.headcount && e.unitPrice) amount = Number(e.headcount) * Number(e.unitPrice);
    const fields = {
      日期: toTs(e.date),
      收支: IO_OPTIONS.includes(e.io) ? e.io : '收入',
      金额: amount,
      来源: SOURCE_OPTIONS.includes(e.source) ? e.source : '✋手动',
      备注: String(e.note || '').slice(0, 200),
    };
    if (e.project) fields['项目'] = String(e.project); // 单选：新选项飞书会自动创建
    if (e.headcount !== undefined && e.headcount !== '') fields['人数'] = Number(e.headcount);
    if (e.unitPrice !== undefined && e.unitPrice !== '') fields['单价'] = Number(e.unitPrice);
    const r = await client.createBitableRecord(cfg.baseToken, tid, fields);
    listCache = { at: 0, items: null };
    return { ok: true, recordId: r.record_id, amount };
  }

  // 30s 读缓存：工作台反复打开不重复拉飞书；增删记录立即失效
  let listCache = { at: 0, items: null };
  let listRefreshing = false;
  async function refreshListCache() {
    if (listRefreshing) return;
    listRefreshing = true;
    try {
      const tid = await ensureTable();
      const resp = await client.listBitableRecords(cfg.baseToken, tid, { pageSize: 500 });
      listCache = { at: Date.now(), items: (resp.items || []).map(mapRecord) };
    } catch (e) { /* 拉取失败保留旧缓存 */ }
    finally { listRefreshing = false; }
  }

  async function listRecords({ limit = 500 } = {}) {
    if (limit >= 500 && listCache.items) {
      if (Date.now() - listCache.at >= 30000) refreshListCache(); // 缓存过期 → 旧数据秒回 + 后台刷新（SWR）
      return listCache.items;
    }
    const tid = await ensureTable();
    const resp = await client.listBitableRecords(cfg.baseToken, tid, { pageSize: Math.min(limit, 500) });
    const items = (resp.items || []).map(mapRecord);
    if (limit >= 500) listCache = { at: Date.now(), items };
    return items;
  }

  async function deleteRecord(recordId) {
    const tid = await ensureTable();
    await client.deleteBitableRecord(cfg.baseToken, tid, recordId);
    listCache = { at: 0, items: null };
    return { ok: true, recordId };
  }

  // 汇总：按收支/项目分组求和
  async function summary() {
    const items = await listRecords();
    const byProject = {};
    let income = 0, expense = 0;
    for (const it of items) {
      const amt = Number(it.amount) || 0;
      if (it.io === '支出') expense += amt; else income += amt;
      const k = it.project || '未分类';
      byProject[k] = (byProject[k] || 0) + (it.io === '支出' ? -amt : amt);
    }
    return { ok: true, count: items.length, income, expense, net: income - expense, byProject };
  }

  // 从文本解析课时账候选（AI）。文本可以是聊天文字，也可以是截图识别结果
  // io: '支出'=按实际上课人数×老师价（默认）；'收入'=按全勤名单人数×收费价
  // 返回 [{ project, headcount, unitPrice, amount, date, note }]，一条都没解析出返回 []
  async function parseLedgerFromText(text, io = '支出') {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const today = now.toISOString().slice(0, 10);
    const prompt = `从下面内容提取课时收入记录。今天是 ${today}（本周一=${mondayOf(today)}）。校历锚点：第1周周一=2026-08-31。

规则：
1. 每条记录提取：项目（明诚/青苗/柠檬；没写项目的按上文归属，上文也没有就默认明诚）、人数、日期（YYYY-MM-DD；只写"周一/周二…"的归属到本周对应日期；写"第X周 周Y"的按校历锚点推算）、备注（原文里的批次名+星期，如"第二周·周一"，没有就留空）
2. 固定班规：柠檬的课固定在周一、青苗固定在周五；如果柠檬/青苗没写星期几，日期取该周的周一/周五
3. 忽略汇总行（如"共计""90档"），只取明细行
4. 只返回 JSON 数组：[{"project":"明诚","headcount":9,"date":"2026-09-14","note":"第二周·周一"}]
5. 一条人数记录都提取不到就返回 []

内容：
${String(text || '').slice(0, 2000)}`;
    const reply = await deepseek.callDeepSeek([{ role: 'user', content: prompt }], cfg.apiKey);
    try {
      const s = String(reply || '').trim();
      const arr = JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && Number(x.headcount) > 0)
        .map((x) => {
          const project = String(x.project || '明诚');
          const headcount = Math.round(Number(x.headcount));
          const unitPrice = io === '收入' ? incomePriceOf(project) : expensePriceOf(project);
          return {
            project,
            headcount,
            unitPrice,
            amount: headcount * unitPrice,
            date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') ? x.date : today,
            note: String(x.note || '').slice(0, 50),
          };
        });
    } catch (e) {
      return [];
    }
  }

  return { ensureTable, addRecord, listRecords, deleteRecord, summary, parseLedgerFromText, expensePriceOf, incomePriceOf, TABLE_NAME };
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dow + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { createLedgerCenter };
