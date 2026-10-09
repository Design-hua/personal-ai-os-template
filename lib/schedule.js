// 日程管理：日历视图 + 聊天记录 + 截图识别 → 飞书多维表格「日程表」
//
// 工作方式：
//   1. ensureTable() 按表名查找，不存在则自动建表
//   2. addSchedule() 写入一条日程（聊天命令/截图识别）
//   3. listSchedules() 按日期范围查询（日历视图用）
//   4. parseScheduleFromText() 用 DeepSeek 从文本提取日期/时间/事项
//   5. parseScheduleFromImage() 用 vision 从截图提取日程
//
// 字段定义：
//   日期（日期）/ 时间（文本，如 "15:00"）/ 事项（文本）/ 来源（单选：聊天/截图/手动）/ 备注（文本）

'use strict';

const deepseek = require('./deepseek');

const TABLE_NAME = '日程表';

const SOURCE_OPTIONS = ['💬聊天', '📸截图', '✋手动'];

const FIELD_DEFS = [
  { field_name: '日期', type: 5 },        // 日期类型
  { field_name: '时间', type: 1 },        // 文本，如 "15:00" 或 "下午3点"
  { field_name: '事项', type: 1 },        // 文本
  { field_name: '来源', type: 3, property: { options: SOURCE_OPTIONS.map(name => ({ name })) } }, // 单选
  { field_name: '备注', type: 1 },        // 文本
];

// 飞书日期字段读出来是毫秒时间戳，统一转 YYYY-MM-DD（北京时间）
function dateStrOf(v) {
  if (typeof v === 'number') return new Date(v + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
}

function createScheduleCenter(cfg) {
  const client = cfg.client;

  // ---- 确保日程表存在 ----
  let tableIdPromise = null;
  async function ensureTable() {
    if (cfg.scheduleTableId) return cfg.scheduleTableId;
    if (tableIdPromise) return tableIdPromise;
    tableIdPromise = (async () => {
      // 先尝试按表名查找
      const tables = await client.listBitableTables(cfg.baseToken);
      const found = (tables || []).find(t => t.name === TABLE_NAME);
      if (found) {
        // 补缺失字段
        const have = new Set((await client.listBitableFields(cfg.baseToken, found.table_id)).map(f => f.field_name));
        for (const def of FIELD_DEFS) {
          if (!have.has(def.field_name)) {
            await client.createBitableField(cfg.baseToken, found.table_id, def).catch(() => {});
          }
        }
        return found.table_id;
      }
      // 不存在则创建
      const created = await client.createBitableTable(cfg.baseToken, {
        table: { name: TABLE_NAME, default_view_name: '日历视图', fields: FIELD_DEFS }
      });
      const tid = created.table_id;
      return tid;
    })();
    return tableIdPromise;
  }

  function mapRecord(r) {
    const f = r.fields || {};
    return {
      recordId: r.record_id,
      date: f['日期'] || '',
      time: f['时间'] || '',
      content: f['事项'] || '',
      source: f['来源'] || '',
      note: f['备注'] || '',
    };
  }

  // ---- 查询日程（按日期范围） ----
  // 读缓存 + 后台刷新（SWR）：有过期数据时立即返回旧值、后台拉飞书更新——手机首屏不再干等
  // 增删日程立即清缓存，下一次读同步重拉，保证写入后看到的是新数据
  let listCache = { at: 0, items: null };
  let listRefreshing = false;
  async function refreshListCache() {
    if (listRefreshing) return;
    listRefreshing = true;
    try {
      const tid = await ensureTable();
      const resp = await client.listBitableRecords(cfg.baseToken, tid, { pageSize: 500 });
      listCache = { at: Date.now(), items: (resp.items || []).map(mapRecord) };
    } catch (e) { /* 拉取失败保留旧缓存，下次再试 */ }
    finally { listRefreshing = false; }
  }
  async function listSchedules({ startDate, endDate, limit = 200 } = {}) {
    if (!startDate && !endDate && listCache.items) {
      if (Date.now() - listCache.at >= 30000) refreshListCache(); // 缓存过期 → 旧数据秒回 + 后台刷新
      return listCache.items;
    }
    const tid = await ensureTable();
    let filter = '';
    if (startDate && endDate) {
      // 飞书日期字段是时间戳（毫秒），需要转换
      const startTs = new Date(startDate + 'T00:00:00+08:00').getTime();
      const endTs = new Date(endDate + 'T23:59:59+08:00').getTime();
      filter = `AND(CurrentValue.[日期] >= ${startTs}, CurrentValue.[日期] <= ${endTs})`;
    }
    const body = { page_size: Math.min(limit, 500) };
    if (filter) body.filter = { conjunction: 'and', conditions: [{ field_name: '日期', operator: 'isGreater', value: ['ExactDate', startDate] }] };
    // 简化：拉全部，前端过滤
    const resp = await client.listBitableRecords(cfg.baseToken, tid, { pageSize: 500 });
    const items = (resp.items || []).map(mapRecord);
    if (!startDate && !endDate) listCache = { at: Date.now(), items };
    return items;
  }

  // ---- 添加日程 ----
  async function addSchedule({ date, time, content, source, note }) {
    const tid = await ensureTable();
    // 飞书日期字段要毫秒时间戳
    let dateVal = date;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
      dateVal = new Date(date + 'T00:00:00+08:00').getTime();
    }
    const fields = {
      '日期': dateVal,
      '时间': time || '',
      '事项': content,
      '来源': source || '✋手动',
      '备注': note || '',
    };
    const r = await client.createBitableRecord(cfg.baseToken, tid, fields);
    listCache = { at: 0, items: null };
    return { ok: true, recordId: r.record_id };
  }

  // ---- 从文本解析日程（AI） ----
  async function parseScheduleFromText(text) {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `从下面这段话里提取日程信息。今天是 ${today}。

要求：
1. 提取日期（格式 YYYY-MM-DD），如果是"明天"就推算成具体日期，"下周X"也算
2. 提取时间（格式 HH:MM，如 15:00），如果没有明确时间就留空
3. 提取事项内容
4. 如果这段话不包含日程信息（比如只是闲聊），返回 null

返回 JSON 格式：{"date":"2026-10-06","time":"15:00","content":"开会"} 或 null

用户说：${text}`;

    const reply = await deepseek.callDeepSeek([{ role: 'user', content: prompt }], cfg.apiKey);
    try {
      const parsed = JSON.parse(reply.trim());
      if (!parsed || !parsed.date || !parsed.content) return null;
      return parsed;
    } catch { return null; }
  }

  // ---- 从截图识别日程（vision，支持整页校历一次提取多条） ----
  async function parseScheduleFromImage(base64Image) {
    if (!cfg.vision || !cfg.vision.isReady()) throw new Error('图片识别未启用：需在 .env 配置 SILICONFLOW_API_KEY');
    const prompt = `你是日程识别助手。这是用户上传的日程/校历/日历截图，请提取图中所有日程信息，逐条输出。

规则：
1. date：日期，格式 YYYY-MM-DD。校历图里通常只写月/日：8-12月的日期按2026年，1-7月的日期按2027年
2. time：时间，格式 HH:MM；图中没有具体时间就留空字符串 ""
3. content：事项内容，保留图中原文关键词（如 开学、上课周、国庆放假、考试周、补课）
4. 只提取图中实际标注的信息，不要编造图中没有的日期
5. 校历里每个关键日期节点算一条；日期范围类条目（如 1/18-1/24 考试周）按天拆开，每一天一条
6. 图里确实没有日程信息时返回 []

只返回 JSON 数组，格式：[{"date":"2026-10-01","time":"","content":"国庆放假"}]，不要任何其他文字。`;

    const reply = await cfg.vision.recognize(base64Image, 'image/jpeg', prompt);
    const m = String(reply || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) return [];
      return arr.filter(x => x && /^\d{4}-\d{2}-\d{2}/.test(String(x.date || '')) && String(x.content || '').trim());
    } catch { return []; }
  }

  // ---- 批量添加（整页校历截图用）：日期+时间+事项 完全相同则跳过 ----
  async function addSchedules(entries, source) {
    const existing = await listSchedules();
    const seen = new Set(existing.map(s => `${dateStrOf(s.date)}|${s.time || ''}|${s.content}`));
    let added = 0, skipped = 0;
    for (const e of (entries || [])) {
      const key = `${String(e.date).slice(0, 10)}|${e.time || ''}|${e.content}`;
      if (seen.has(key)) { skipped++; continue; }
      await addSchedule({ date: e.date, time: e.time || '', content: e.content, source: source || '📸截图', note: '' });
      seen.add(key);
      added++;
    }
    return { added, skipped };
  }

  return { ensureTable, listSchedules, addSchedule, addSchedules, parseScheduleFromText, parseScheduleFromImage, TABLE_NAME };
}

module.exports = { createScheduleCenter };
