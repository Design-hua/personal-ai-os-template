// lib/task-runner.js
// 任务派发与 AI 执行中心
//
// 飞书多维表格「任务计划」：
//   任务名（文本）/ 状态（AI建议 | 待处理/AI执行中/已完成/失败/已忽略）/ 派发指令（文本）/ AI回复结果（文本）
//
// 工作方式：
//   1. ensureTable() 按表名查找，不存在则自动建表
//   2. start() 定时轮询：找「状态=待处理」→ 标记 AI执行中 → 调 DeepSeek 执行「派发指令」→ 结果写回「AI回复结果」+ 状态改已完成
//   3. dispatch() 供前端手动派发：创建一条待处理任务，下一轮轮询执行
//   4. suggestFromVideo()：视频拆解后把选题角度生成「AI建议」任务，等用户在任务中心点「派给 AI」才执行

'use strict';

const deepseek = require('./deepseek');

const TABLE_NAME = '任务计划';
const PRIORITY_OPTIONS = ['P0', 'P1', 'P2'];
const FIELD_DEFS = [
  { field_name: '任务名', type: 1 },
  {
    field_name: '状态',
    type: 3,
    property: { options: [{ name: 'AI建议' }, { name: '待确认' }, { name: '待处理' }, { name: 'AI执行中' }, { name: '已完成' }, { name: '失败' }, { name: '已忽略' }] },
  },
  { field_name: '派发指令', type: 1 },
  { field_name: 'AI回复结果', type: 1 },
  { field_name: '优先级', type: 3, property: { options: PRIORITY_OPTIONS.map((name) => ({ name })) } },
  { field_name: '验收标准', type: 1 },
  { field_name: '关联项目', type: 1 },
];

function createTaskRunner(opts) {
  const o = opts || {};
  const cfg = {
    client: o.client || null, // lib/lark.js 客户端
    baseToken: o.baseToken || '',
    tableId: o.tableId || '', // 留空则自动按表名查找/创建
    apiKey: o.apiKey || '',
    intervalMs: Number(o.intervalMs || 5 * 60 * 1000),
    notifyEnabled: o.notifyEnabled !== false, // 后台任务完成/失败时发飞书通知
  };

  let tableId = cfg.tableId || '';
  let timer = null;
  let ticking = false;

  function isReady() {
    return Boolean(cfg.client && cfg.baseToken && cfg.apiKey);
  }

  // 后台任务完成/失败 → 飞书机器人私聊通知用户；通知失败不影响主流程
  async function pushNotify(text) {
    if (cfg.notifyEnabled === false || !cfg.client || typeof cfg.client.sendTextAsBot !== 'function') return;
    try {
      const st = typeof cfg.client.getStatus === 'function' ? cfg.client.getStatus() : null;
      if (st && st.openId) await cfg.client.sendTextAsBot(st.openId, text);
    } catch (e) {
      console.warn('[task-runner] 飞书通知发送失败:', e.message);
    }
  }

  function getTableId() {
    return tableId;
  }

  function getTableLink() {
    if (!cfg.baseToken || !tableId) return '';
    return `https://feishu.cn/base/${cfg.baseToken}?table=${tableId}`;
  }

  // 存量表自动补列（新增字段时旧表不重建，逐个补上；失败不影响主流程）
  async function ensureFields() {
    try {
      const have = new Set(
        ((await cfg.client.listBitableFields(cfg.baseToken, tableId)) || []).map((f) => f.field_name)
      );
      const missing = FIELD_DEFS.filter((d) => !have.has(d.field_name));
      for (const d of missing) {
        await cfg.client.createBitableField(cfg.baseToken, tableId, d).catch(() => {});
      }
    } catch (e) {
      console.warn('[task-runner] 补列失败（不影响主流程）:', e.message);
    }
  }

  // 按表名查找「任务计划」表，不存在则创建（含全部字段）；已存在则自动补缺失字段
  async function ensureTable() {
    if (tableId) return { ok: true, tableId };
    if (!isReady()) return { ok: false, error: '任务派发未配置（需飞书授权 + LARK_BASE_TOKEN + DeepSeek API Key）' };
    const tables = await cfg.client.listBitableTables(cfg.baseToken);
    const hit = (tables || []).find((t) => t && t.name === TABLE_NAME);
    if (hit) {
      tableId = hit.table_id;
      await ensureFields();
      return { ok: true, tableId, existed: true };
    }
    const created = await cfg.client.createBitableTable(cfg.baseToken, {
      table: { name: TABLE_NAME, default_view_name: '全部任务', fields: FIELD_DEFS },
    });
    tableId = (created && created.table_id) || '';
    if (!tableId) throw new Error('创建「任务计划」表失败：未返回 table_id');
    return { ok: true, tableId, created: true };
  }

  // 创建一条待处理任务；wait=true 时同步执行并写回结果（前端派发按钮用）
  // opts: { wait, criteria(验收标准), priority(P0|P1|P2), project(关联项目) }
  async function dispatch(title, instruction, opts2) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const o = opts2 || {};
    const fields = {
      任务名: String(title || '').slice(0, 200),
      状态: '待处理',
      派发指令: String(instruction || ''),
    };
    if (o.criteria) fields['验收标准'] = String(o.criteria).slice(0, 2000);
    if (PRIORITY_OPTIONS.includes(o.priority)) fields['优先级'] = o.priority;
    if (o.project) fields['关联项目'] = String(o.project).slice(0, 100);
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, tableId, fields);
    const recordId = rec && rec.record_id;
    if (o.wait && recordId) {
      const r = await executeRecord(recordId, fields, { silent: true });
      return { ok: true, recordId, executed: true, ...r };
    }
    return { ok: true, recordId, executed: false };
  }

  // 执行单条任务：状态→AI执行中 → DeepSeek → 写回结果
  // opts.silent=true 时不发飞书通知（用户在线点「派给 AI」的同步执行，前端已就地展示结果）
  async function executeRecord(recordId, fields, opts2) {
    const silent = Boolean(opts2 && opts2.silent);
    const title = String((fields && fields['任务名']) || '未命名任务').slice(0, 120);
    const link = getTableLink();
    const criteria = String((fields && fields['验收标准']) || '').trim();
    const instruction = String((fields && fields['派发指令']) || '').trim();
    if (!instruction) {
      await cfg.client.updateBitableRecord(cfg.baseToken, tableId, recordId, {
        状态: '失败',
        AI回复结果: '派发指令为空，无法执行',
      });
      return { ok: false, error: '派发指令为空' };
    }
    // 有验收标准的任务：要求 AI 完成后末尾自查「达标/未达标」，不额外多花一次 AI 调用
    const execPrompt = criteria
      ? `${instruction}\n\n【验收标准】${criteria}\n完成上面任务后，在回复最末尾单独一行输出自查，格式固定：自查：达标 或 自查：未达标｜一句话理由（对照验收标准如实判断，不得敷衍）。`
      : instruction;
    await cfg.client.updateBitableRecord(cfg.baseToken, tableId, recordId, { 状态: 'AI执行中' });
    try {
      const reply = await deepseek.callDeepSeek(
        [
          {
            role: 'system',
            content:
              '你是用户的个人 AI 助手，正在执行用户派发的任务指令。直接给出可落地、具体的结果，不要寒暄。结果控制在 1500 字以内。',
          },
          { role: 'user', content: execPrompt },
        ],
        cfg.apiKey
      );
      const replyText = String(reply || '');
      await cfg.client.updateBitableRecord(cfg.baseToken, tableId, recordId, {
        状态: '已完成',
        AI回复结果: replyText.slice(0, 20000),
      });
      if (!silent) {
        const snippet = replyText.length > 500 ? replyText.slice(0, 500) + '……' : replyText;
        const selfCheck = criteria ? (replyText.match(/自查[：:][^\n]*/) || [''])[0] : '';
        await pushNotify(
          `✅ AI 已完成任务：${title}${criteria && selfCheck ? `\n${selfCheck}` : ''}\n\n${snippet}\n\n📋 完整结果见任务计划表：${link}`
        );
      }
      return { ok: true, reply: replyText };
    } catch (e) {
      await cfg.client
        .updateBitableRecord(cfg.baseToken, tableId, recordId, {
          状态: '失败',
          AI回复结果: '执行失败: ' + e.message,
        })
        .catch(() => {});
      if (!silent) {
        await pushNotify(
          `❌ AI 任务执行失败：${title}\n原因：${e.message}\n\n可在任务计划表检查后重试：${link}`
        );
      }
      return { ok: false, error: e.message };
    }
  }

  // 项目拆解任务批量落表（用户在聊天里确认后才调用）：
  // aiSuitable=true → 待处理（轮询自动执行，与聊天提取的 AI 任务同策略）；否则 → 待确认（任务中心手动派发）
  // tasks: [{ task, criteria, priority, aiSuitable }]；同名活动任务去重
  async function createBreakdownTasks(project, tasks) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const projectName = String(project || '').slice(0, 100);
    const list = (tasks || []).filter((t) => t && t.task).slice(0, 10);
    if (!list.length) return { ok: false, error: '任务清单为空' };
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    // 防重复拆解：AI 重新拆解时措辞会漂移（字符串去重拦不住语义重复），
    // 该项目还有进行中的拆解任务时直接拒绝追加，处理完再拆
    const activeCount = ((data && data.items) || []).filter((r) => {
      const f = (r && r.fields) || {};
      if (String(f['关联项目'] || '') !== projectName) return false;
      const s = f['状态'];
      return s === '待确认' || s === '待处理' || s === 'AI执行中';
    }).length;
    if (activeCount > 0) {
      return { ok: false, error: `《${projectName}》已有 ${activeCount} 条进行中的拆解任务，先在任务中心处理完再拆，避免重复执行` };
    }
    // 去重范围含已完成任务：防止同一项目重复拆解时把已完成的任务再写一遍
    const existingNames = new Set(
      ((data && data.items) || []).map((r) => String((r.fields && r.fields['任务名']) || ''))
    );
    let created = 0;
    for (const t of list) {
      const name = `【项目】${String(t.task).slice(0, 180)}`;
      if (existingNames.has(name)) continue;
      const fields = {
        任务名: name,
        状态: t.aiSuitable ? '待处理' : '待确认',
        派发指令: t.aiSuitable ? `${t.task}\n（所属项目：${projectName}）` : '',
        验收标准: String(t.criteria || '').slice(0, 2000),
        优先级: PRIORITY_OPTIONS.includes(t.priority) ? t.priority : 'P2',
        关联项目: projectName,
      };
      await cfg.client.createBitableRecord(cfg.baseToken, tableId, fields);
      existingNames.add(name);
      created++;
    }
    return { ok: true, created, total: list.length };
  }

  // 视频拆解后：把选题角度生成「AI建议」任务（不自动执行，等用户拍板）
  // angles: [{ title, instruction }]；同标题建议不重复创建
  async function suggestFromVideo(angles, meta) {
    const st = await ensureTable();
    if (!st.ok) return { ok: false, error: st.error };
    const list = (angles || []).filter((a) => a && a.title && a.instruction).slice(0, 3);
    if (!list.length) return { ok: true, created: 0 };
    const m = meta || {};
    // 查已有建议，按任务名去重（同一视频重复拆解不重复建）
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    const existingNames = new Set(
      ((data && data.items) || []).map((r) => String((r.fields && r.fields['任务名']) || ''))
    );
    let created = 0;
    for (const a of list) {
      const title = `【选题】${String(a.title).slice(0, 180)}`;
      if (existingNames.has(title)) continue;
      const instruction = [
        a.instruction,
        m.title ? `\n参考视频：《${String(m.title).slice(0, 120)}》` : '',
        m.cluster ? `\n话题簇：${m.cluster}` : '',
        m.url ? `\n视频链接：${m.url}` : '',
        '\n要求：给出可直接拍摄的内容方案（含开头3秒钩子、主体结构、结尾引导），800字以内。',
      ].join('');
      await cfg.client.createBitableRecord(cfg.baseToken, tableId, {
        任务名: title,
        状态: 'AI建议', // 单选字段：值不在选项中时飞书会自动新增选项
        派发指令: instruction,
      });
      existingNames.add(title);
      created++;
    }
    return { ok: true, created };
  }

  // 列出待拍板的 AI 建议（最新在前）
  async function listSuggestions() {
    const st = await ensureTable();
    if (!st.ok) return st;
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    const items = ((data && data.items) || [])
      .filter((r) => r.fields && r.fields['状态'] === 'AI建议')
      .map((r) => ({
        recordId: r.record_id,
        title: String(r.fields['任务名'] || ''),
        instruction: String(r.fields['派发指令'] || ''),
      }));
    return { ok: true, items };
  }

  // 全窗口自动捕捉的任务：来自聊天提取（AI助手）、妙记笔记待办等所有窗口
  // 状态=「待确认」：轮询不会自动执行，任务中心可见，用户点「派给 AI」才执行
  // source: '助手' | '妙记' | ...，作为任务名前缀标记来源
  async function captureTask(title, instruction, source) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const name = `${source ? `【${source}】` : ''}${String(title || '').slice(0, 180)}`;
    // 去重：同名任务已在（待确认/待处理/AI执行中/AI建议）则跳过，避免重复捕捉
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    const active = ((data && data.items) || []).filter((r) => {
      const s = r.fields && r.fields['状态'];
      return s === '待确认' || s === '待处理' || s === 'AI执行中' || s === 'AI建议';
    });
    if (active.some((r) => String((r.fields && r.fields['任务名']) || '') === name)) {
      return { ok: true, skipped: true };
    }
    const rec = await cfg.client.createBitableRecord(cfg.baseToken, tableId, {
      任务名: name,
      状态: '待确认',
      派发指令: String(instruction || ''),
    });
    return { ok: true, recordId: rec && rec.record_id };
  }

  // 列出待确认的捕捉任务（最新在前）
  async function listCaptured() {
    const st = await ensureTable();
    if (!st.ok) return st;
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    const items = ((data && data.items) || [])
      .filter((r) => r.fields && r.fields['状态'] === '待确认')
      .map((r) => ({
        recordId: r.record_id,
        title: String(r.fields['任务名'] || ''),
        instruction: String(r.fields['派发指令'] || ''),
      }));
    return { ok: true, items };
  }

  // 用户点「派给 AI」：立即同步执行该建议，写回结果
  async function acceptSuggestion(recordId) {
    const st = await ensureTable();
    if (!st.ok) return st;
    const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
    const rec = (data.items || []).find((r) => r.record_id === recordId);
    if (!rec) return { ok: false, error: '建议不存在或已被处理' };
    const r = await executeRecord(recordId, rec.fields, { silent: true });
    return { ok: Boolean(r.ok), reply: r.reply || '', error: r.error };
  }

  // 用户点「忽略」：状态改已忽略（不删除，保留痕迹）
  async function dismissSuggestion(recordId) {
    const st = await ensureTable();
    if (!st.ok) return st;
    await cfg.client.updateBitableRecord(cfg.baseToken, tableId, recordId, { 状态: '已忽略' });
    return { ok: true };
  }

  // 轮询一轮：执行所有「待处理」任务，返回处理数量
  async function tick() {
    if (ticking) return { ok: true, skipped: true };
    ticking = true;
    try {
      const st = await ensureTable();
      if (!st.ok) return st;
      const data = await cfg.client.listBitableRecords(cfg.baseToken, tableId, { pageSize: 200 });
      const items = (data && data.items) || [];
      let done = 0;
      for (const rec of items) {
        const f = (rec && rec.fields) || {};
        if (f['状态'] !== '待处理') continue;
        await executeRecord(rec.record_id, f);
        done++;
      }
      return { ok: true, done };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer || !isReady()) return;
    // 启动 30 秒后跑第一轮，之后按间隔轮询；失败只记日志不中断
    setTimeout(() => {
      tick().catch((e) => console.warn('[task-runner] 轮询失败:', e.message));
    }, 30000);
    timer = setInterval(() => {
      tick().catch((e) => console.warn('[task-runner] 轮询失败:', e.message));
    }, cfg.intervalMs);
    console.log(`[task-runner] 任务派发轮询已启动（每 ${Math.round(cfg.intervalMs / 60000)} 分钟检查一次「${TABLE_NAME}」表）`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { isReady, ensureTable, dispatch, createBreakdownTasks, suggestFromVideo, listSuggestions, captureTask, listCaptured, acceptSuggestion, dismissSuggestion, tick, start, stop, getTableId, getTableLink };
}

module.exports = { createTaskRunner };
