'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const deepseek = require('./deepseek');
const storage = require('./storage');
const profileGrowth = require('./profile-growth');
const extractTodos = require('./extract-todos');
const larkSync = require('./lark-sync');

const TODO_FILE = '07_行为与决策/今日计划.json';

function readTodoFile(dataRoot) {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, TODO_FILE), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeTodoFile(dataRoot, todos) {
  const filePath = path.join(dataRoot, TODO_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), 'utf8');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeTs() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return {
    ts: `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
    display: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  };
}

function createRouter({ apiKey, dataRoot, lark, videoIntake, noteIntake, asr, vision, taskRunner, experienceCenter, writingStudio, profileCenter, knowledgeCenter, thinkingStudio, decisionCenter, projectCenter, meetingCenter, scheduleCenter, ledgerCenter }) {
  const router = express.Router();
  // lark = { client, stateFile, notifyEnabled } | null（未配置时为 null）
  const larkClient = lark && lark.client;

  // 统一回答：优先走思考伙伴（聚合 档案/经验/知识资料/视频拆解，分层标注来源）；
  // 思考伙伴不可用或失败时，回退到原来的普通问答，保证聊天不断。
  async function answerThinking(question, history, dateStr) {
    if (thinkingStudio && typeof thinkingStudio.answer === 'function' && thinkingStudio.isReady()) {
      try {
        const r = await thinkingStudio.answer({ question, history, now: dateStr });
        if (r && r.ok) return { reply: r.reply, sources: r.used || null };
        console.error('思考伙伴返回异常，回退普通问答:', r && r.error);
      } catch (e) {
        console.error('思考伙伴调用失败，回退普通问答:', e.message);
      }
    }
    let context = '';
    try { context = storage.readContext(dataRoot); } catch (e) { context = ''; }
    const reply = await deepseek.ask(`[当前时间：${dateStr}]\n\n${question}`, context, apiKey, history);
    return { reply, sources: null };
  }

  // 显式命令：会前简报
  // 「会前」→ 自动取未来48h最近日程；「会前：主题」→ 按主题召回
  async function handleMeetingCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^会前(?:[：:]\s*([\s\S]+))?$/);
    if (!m || !meetingCenter) return null;
    if (!meetingCenter.isReady()) {
      return { handled: true, reply: '会前简报未启用：需要飞书授权（LARK_BASE_TOKEN）和 DEEPSEEK_API_KEY。' };
    }
    const topic = (m[1] || '').trim();
    try {
      const r = await meetingCenter.brief({ topic });
      if (!r.ok) return { handled: true, reply: r.error };
      const head = r.event
        ? `📋 会前简报｜${r.event.timeText} 《${r.topic}》`
        : `📋 会前简报｜${r.topic}`;
      const u = r.used || {};
      const foot = `\n\n（召回：待拍板决策 ${u.decisions || 0}、相关项目 ${u.projects || 0}、历史纪要 ${u.notes || 0}、外部资料 ${u.knowledge || 0}）`;
      return { handled: true, reply: `${head}\n\n${r.reply}${foot}` };
    } catch (e) {
      return { handled: true, reply: `会前简报生成失败：${e.message}` };
    }
  }

  // 显式命令解析：决策： / 新建项目： / 项目建议：
  async function handleDecideCommand(rawText) {
    const text = String(rawText || '').trim();

    // 决策：<要不要做X……>
    let m = text.match(/^决策[：:]\s*([\s\S]+)$/);
    if (m && decisionCenter) {
      const question = m[1].trim();
      if (!decisionCenter.isReady()) return { handled: true, reply: '决策卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
      try {
        const r = await decisionCenter.createFromQuestion(question);
        if (!r.ok) return { handled: true, reply: `决策尽调失败：${r.error}` };
        return { handled: true, reply: formatDecisionReply(question, r) };
      } catch (e) {
        return { handled: true, reply: `决策尽调出了点问题：${e.message}` };
      }
    }

    // 新建项目：<名称>（换行 或 | 后可接补充说明）
    m = text.match(/^新建项目[：:]\s*([^\n|｜]+)(?:[\n|｜]\s*([\s\S]+))?$/);
    if (m && projectCenter) {
      const name = m[1].trim();
      const brief = (m[2] || '').trim();
      if (!projectCenter.isReady()) return { handled: true, reply: '项目卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
      try {
        const r = await projectCenter.createProject({ name, brief, autoPlan: true });
        if (!r.ok) return { handled: true, reply: `新建项目失败：${r.error}` };
        return { handled: true, reply: `🗂 项目卡已建：《${name}》\n状态：${r.status}（AI 只做了规划草案，是否真正推进由你决定）\nAI 已拟好 目标/里程碑/下一步/退出条件，可在飞书「项目卡」表查看修改。\n\n想推进时回复「项目建议：${name}」我帮你做阶段体检。` };
      } catch (e) {
        return { handled: true, reply: `新建项目出了点问题：${e.message}` };
      }
    }

    // 项目建议：<项目名关键词>
    m = text.match(/^项目建议[：:]\s*(.+)$/);
    if (m && projectCenter) {
      const kw = m[1].trim();
      if (!projectCenter.isReady()) return { handled: true, reply: '项目卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
      try {
        const lr = await projectCenter.listProjects({ keyword: kw });
        if (!lr.ok) return { handled: true, reply: `读取项目失败：${lr.error}` };
        if (!lr.items.length) return { handled: true, reply: `没找到名称含「${kw}」的项目。可先发「新建项目：${kw}」建一张项目卡。` };
        const it = lr.items[0];
        const multi = lr.items.length > 1 ? `（找到 ${lr.items.length} 个，默认取：${it.name}）\n` : '';
        const ar = await projectCenter.adviseProject(it.recordId);
        if (!ar.ok) return { handled: true, reply: `${multi}项目体检失败：${ar.error}` };
        return { handled: true, reply: `${multi}${formatAdviseReply(it, ar.advise)}` };
      } catch (e) {
        return { handled: true, reply: `项目体检出了点问题：${e.message}` };
      }
    }

    return null;
  }

  // 显式命令：研究： / 研究快讯： / 对比：
  //   「研究快讯：主题」→ 快讯档 200-400字
  //   「研究：主题」→ 摘要档 500-1000字；「研究：主题｜深度」→ 深度档 1500字+
  //   「对比：A vs B」→ 对比档 800-1200字（A、B 分别召回资料再按标题去重合并）
  // 产出带 researchable 标记，前端出现「💾 存为研究资料」按钮，落库到飞书「知识资料」表
  // （信息层级=AI分析、来源平台=自产研究，绝不进档案已确认层）。
  async function handleResearchCommand(rawText) {
    if (!thinkingStudio || typeof thinkingStudio.answer !== 'function' || !thinkingStudio.isReady()) return null;
    const text = String(rawText || '').trim();
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} 星期${week} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    async function run(question, format, topics, label) {
      try {
        const r = await thinkingStudio.answer(
          topics ? { question, format, topics, now: dateStr } : { question, format, now: dateStr }
        );
        if (!r || !r.ok) return { handled: true, reply: (r && r.error) || '研究生成失败' };
        return {
          handled: true,
          reply: `${label}｜${question}\n\n${r.reply}`,
          research: { question, reply: r.reply },
        };
      } catch (e) {
        return { handled: true, reply: `研究生成失败：${e.message}` };
      }
    }

    let m = text.match(/^研究快讯[：:]\s*([\s\S]+)$/);
    if (m) return run(m[1].trim(), 'flash', null, '⚡ 研究快讯');

    m = text.match(/^研究[：:]\s*([\s\S]+)$/);
    if (m) {
      const body = m[1].trim();
      const deepM = body.match(/^([\s\S]+?)\s*[｜|]\s*深度$/);
      if (deepM) return run(deepM[1].trim(), 'deep', null, '📚 深度研究');
      return run(body, 'summary', null, '🔬 研究摘要');
    }

    m = text.match(/^对比[：:]\s*([\s\S]+)$/);
    if (m) {
      const parts = m[1]
        .split(/\s+(?:vs|VS|Vs|对比)\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length !== 2) {
        return { handled: true, reply: '对比格式：对比：A vs B（两个对象用 vs 隔开，如：对比：飞书多维表格 vs Notion）' };
      }
      return run(`${parts[0]} vs ${parts[1]}`, 'compare', parts, '⚖️ 对比研究');
    }
    return null;
  }

  // 显式命令：书卡：<书名> → 查开放书库元数据 + AI 拆书卡（候选，回复「存」落知识资料表）
  // 开放书库：Gutenberg / OpenLibrary / Google Books（合法公开资源，不抓盗版）
  async function handleBookCardCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^书卡[：:]\s*(.+)$/);
    if (!m) return null;
    if (!thinkingStudio || typeof thinkingStudio.answer !== 'function' || !thinkingStudio.isReady()) return null;
    const bookName = m[1].trim();
    if (!bookName) return { handled: true, reply: '书卡格式：书卡：<书名>（如：书卡：原子习惯）' };

    // 1) 查开放书库元数据（Gutenberg → OpenLibrary → Google Books，取第一个有结果的）
    let meta = null; let metaSource = '';
    try {
      const r = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(bookName)}`).then(x => x.json()).catch(() => null);
      const b = r && r.results && r.results[0];
      if (b) { meta = { title: b.title, authors: (b.authors || []).map(a => a.name).join('、'), summary: b.summaries && b.summaries[0] || '', subjects: (b.subjects || []).slice(0, 5).join('、'), url: `https://www.gutenberg.org/ebooks/${b.id}`, formats: Object.keys(b.formats || {}).filter(k => k.includes('html') || k.includes('epub') || k.includes('plain')).slice(0, 3).map(k => `${k}: ${b.formats[k]}`) }; metaSource = 'Project Gutenberg'; }
    } catch (e) { /* 网络失败继续下一个源 */ }
    if (!meta) {
      try {
        const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(bookName)}&limit=1`).then(x => x.json()).catch(() => null);
        const d = r && r.docs && r.docs[0];
        if (d) { meta = { title: d.title, authors: (d.author_name || []).join('、'), summary: d.first_sentence || '', subjects: (d.subject || []).slice(0, 5).join('、'), url: `https://openlibrary.org${d.key}`, formats: [] }; metaSource = 'Open Library'; }
      } catch (e) { /* */ }
    }
    if (!meta) {
      try {
        const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(bookName)}&maxResults=1`).then(x => x.json()).catch(() => null);
        const v = r && r.items && r.items[0] && r.items[0].volumeInfo;
        if (v) { meta = { title: v.title, authors: (v.authors || []).join('、'), summary: v.description || '', subjects: (v.categories || []).slice(0, 5).join('、'), url: v.infoLink || '', formats: [] }; metaSource = 'Google Books'; }
      } catch (e) { /* */ }
    }

    // 2) AI 拆书卡（带元数据上下文）
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const metaBlock = meta
      ? `\n\n【开放书库元数据（来源：${metaSource}）】\n书名：${meta.title}\n作者：${meta.authors || '未知'}\n简介：${(meta.summary || '').slice(0, 500)}\n主题：${meta.subjects || '无'}\n在线阅读：${meta.url}\n${meta.formats.length ? '可用格式：' + meta.formats.join('、') : ''}`
      : '\n\n【未在开放书库找到该书，请基于你的知识拆解，并明确标注「非书库来源」】';
    const question = `请为《${bookName}》生成一张结构化书卡，包含以下部分（用 markdown 标题分段）：\n1. 一句话概括（30字内）\n2. 核心观点（3-5条，每条一句话）\n3. 金句摘录（3-5条，标注出处章节如可知）\n4. 适合谁读（一句话）\n5. 行动清单（读完能马上做的3件事）\n6. 延伸阅读（同主题2-3本推荐）\n7. 资源链接（开放书库在线阅读地址，如有）${metaBlock}`;

    try {
      const r = await thinkingStudio.answer({ question, format: 'deep', now: dateStr });
      if (!r || !r.ok) return { handled: true, reply: (r && r.error) || '书卡生成失败' };
      const cardText = `📚 书卡｜《${bookName}》\n\n${r.reply}\n\n（来源：${metaSource || 'AI 知识'}；回复「存」落知识资料表）`;
      // 存入临时候选，等用户回复「存」再落库
      bookCardFlow = { bookName, cardText: r.reply, meta, metaSource, ts: Date.now() };
      return { handled: true, reply: cardText, bookCard: { bookName, reply: r.reply, meta, metaSource } };
    } catch (e) {
      return { handled: true, reply: `书卡生成失败：${e.message}` };
    }
  }

  // 显式命令：存（把最近一次书卡候选写入知识资料表）
  async function handleSaveBookCardCommand(rawText) {
    const text = String(rawText || '').trim();
    if (!/^存$/.test(text)) return null;
    if (!bookCardFlow || Date.now() - bookCardFlow.ts > 3600_000) {
      return { handled: true, reply: '没有待保存的书卡（候选 1 小时内有效）。先发「书卡：<书名>」。' };
    }
    if (!knowledgeCenter || typeof knowledgeCenter.saveResearch !== 'function') {
      return { handled: true, reply: '知识资料未启用' };
    }
    const bc = bookCardFlow;
    try {
      const r = await knowledgeCenter.saveResearch({
        question: `书卡·${bc.bookName}`,
        reply: bc.cardText,
        title: `书卡·${bc.bookName}`,
        author: bc.metaSource || 'AI',
        domain: '认知与个人成长',
      });
      bookCardFlow = null;
      if (r && r.ok) {
        const st = r.duplicated ? '已在知识库（重复跳过）' : '已存入知识资料表';
        return { handled: true, reply: `💾 ${st}：书卡·《${bc.bookName}》` };
      }
      return { handled: true, reply: `保存失败：${(r && r.error) || '未知错误'}` };
    } catch (e) {
      return { handled: true, reply: `保存失败：${e.message}` };
    }
  }

  // 书卡候选（单用户单候选，1 小时 TTL）
  let bookCardFlow = null;

  // 课时账候选（单用户单候选，1 小时 TTL）
  let ledgerFlow = null;

  // 全勤名单按班（用户拍板 2026-10-07，来自名单截图）：
  //   明诚：周一9人 周二13人 周三12人 周四15人；青苗：周五9人；柠檬：周一4人
  // 结算一次 = 一笔支出（实际人数×老师价）+ 一笔收入（该次课全勤人数×收费价）
  const FULLTIME_ROSTER = {
    明诚: { 1: 9, 2: 13, 3: 12, 4: 15 }, // 周几 → 全勤人数
    青苗: { 5: 9 },
    柠檬: { 1: 4 },
  };
  function rosterOf(project, dateStr) {
    const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=周日
    return (FULLTIME_ROSTER[project] || {})[dow] || 0;
  }

  // 每条支出候选配一条收入候选（同日期同项目，全勤人数×收费价）
  function incomeCandidatesOf(expenseItems) {
    return expenseItems
      .map((c) => {
        const hc = rosterOf(c.project, c.date);
        if (!hc) return null;
        const unitPrice = ledgerCenter.incomePriceOf(c.project);
        return { project: c.project, headcount: hc, unitPrice, amount: hc * unitPrice, date: c.date, note: (c.note ? c.note + '·' : '') + '全勤收入' };
      })
      .filter(Boolean);
  }

  function formatLedgerCandidates(list) {
    const expenseLines = list.map((c, i) => `${i + 1}. ${c.date} ${c.project} ${c.headcount}人 × ${c.unitPrice} = ${c.amount}元${c.note ? '（' + c.note + '）' : ''}`);
    const expenseTotal = list.reduce((s, c) => s + c.amount, 0);
    const incomeItems = incomeCandidatesOf(list);
    const incomeLines = incomeItems.map((c, i) => `${i + 1}. ${c.date} ${c.project} 全勤${c.headcount}人 × ${c.unitPrice} = ${c.amount}元`);
    const incomeTotal = incomeItems.reduce((s, c) => s + c.amount, 0);
    return `🧾 本次结算候选：\n\n📤 支出（实际上课人数×老师价，共 ${expenseTotal} 元）：\n${expenseLines.join('\n')}\n\n📥 收入（全勤名单×收费价，共 ${incomeTotal} 元）：\n${incomeLines.join('\n') || '（无匹配的全勤班级）'}\n\n回复「存」＝支出＋收入一起入账；「存支出」「存收入」只入一边；不对就说哪里错。`;
  }

  // 显式命令：记账：... → AI 解析人数/金额 → 候选，回「存」（支出+收入）或「存支出/存收入」入账
  async function handleLedgerCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^记账[：:]\s*([\s\S]+)$/);
    if (!m) return null;
    if (!ledgerCenter) return { handled: true, reply: '记账未启用（需飞书授权 + LARK_BASE_TOKEN）。' };
    const list = await ledgerCenter.parseLedgerFromText(m[1], '支出');
    if (!list.length) return { handled: true, reply: '没解析出人数。试试「记账：明诚 周一9人 周二12人」' };
    ledgerFlow = { items: list, ts: Date.now() };
    return { handled: true, reply: formatLedgerCandidates(list) };
  }

  // 显式命令：存（=全存，支出+收入一起入）/存支出/存收入/全存（课时账候选入账）
  // 「存」默认全入：截图/聊天流程都会同时给出支出与收入候选；已入过的由防重复机制自动跳过
  async function handleSaveLedgerCommand(rawText) {
    const text = String(rawText || '').trim();
    const saveExpense = /^存支出$/.test(text);
    const saveIncome = /^存收入$/.test(text);
    const saveAll = /^(全存|存)$/.test(text);
    if (!saveExpense && !saveIncome && !saveAll) return null;
    if (!ledgerFlow || Date.now() - ledgerFlow.ts > 3600_000) return null;
    if (bookCardFlow && bookCardFlow.ts > ledgerFlow.ts) return null;
    const expenseItems = ledgerFlow.items;
    const incomeItems = saveExpense ? [] : incomeCandidatesOf(expenseItems);
    try {
      const existing = await ledgerCenter.listRecords();
      const dayOf = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const dupSet = new Set(existing.map((r) => `${dayOf(r.date)}|${r.project}|${r.io}|${Number(r.headcount)}|${r.amount}`));
      let saved = 0, skipped = 0, total = 0;
      const batch = [
        ...(saveIncome ? [] : expenseItems.map((c) => ({ ...c, io: '支出', source: c.source || '💬聊天' }))),
        ...incomeItems.map((c) => ({ ...c, io: '收入', source: '💬聊天' })),
      ];
      for (const c of batch) {
        if (dupSet.has(`${c.date}|${c.project}|${c.io}|${c.headcount}|${c.amount}`)) { skipped++; continue; }
        await ledgerCenter.addRecord({
          date: c.date, project: c.project, headcount: c.headcount, unitPrice: c.unitPrice,
          io: c.io, source: c.source, note: c.note,
        });
        saved++; total += c.amount;
      }
      ledgerFlow = null;
      if (!saved && skipped) return { handled: true, reply: `这 ${skipped} 条账之前已入过，未重复入账。` };
      return { handled: true, reply: `💾 已入账 ${saved} 条，合计 ${total} 元${skipped ? `（跳过重复 ${skipped} 条）` : ''}。` };
    } catch (e) {
      return { handled: true, reply: `入账失败：${e.message}` };
    }
  }

  // 显式命令：拆任务：项目名 → 里程碑拆成带验收标准的任务清单（候选，确认后才落任务计划表）
  async function handleBreakdownCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^拆任务[：:]\s*(.+)$/);
    if (!m) return null;
    if (!projectCenter || !projectCenter.isReady()) return { handled: true, reply: '项目卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
    if (!taskRunner || !taskRunner.isReady()) return { handled: true, reply: '任务计划未启用：需要飞书授权 + DEEPSEEK_API_KEY。' };
    const kw = m[1].trim();
    try {
      const lr = await projectCenter.listProjects({ keyword: kw });
      if (!lr.ok) return { handled: true, reply: `读取项目失败：${lr.error}` };
      if (!lr.items.length) return { handled: true, reply: `没找到名称含「${kw}」的项目。可先发「新建项目：${kw}」建项目卡。` };
      const it = lr.items[0];
      const multi = lr.items.length > 1 ? `（找到 ${lr.items.length} 个，默认取：${it.name}）\n` : '';
      const br = await projectCenter.breakdownTasks(it.recordId);
      if (!br.ok) return { handled: true, reply: `${multi}任务拆解失败：${br.error}` };
      const id = newFlowId();
      breakdownFlows.set(id, { id, createdAt: Date.now(), projectName: br.projectName, recordId: it.recordId, tasks: br.tasks });
      lastBreakdownFlowId = id;
      const L = [`${multi}🧩 任务拆解候选｜《${br.projectName}》（${br.tasks.length} 条，来自里程碑拆解）`];
      br.tasks.forEach((t, i) => {
        L.push(`${i + 1}. [${t.priority}][${t.aiSuitable ? 'AI可代做' : '需你动手'}] ${t.task}\n   验收：${t.criteria || '—'}`);
      });
      L.push('\n✅ 确认后才会写入「任务计划」表：点下方按钮，或回复「确认拆解」（我不自动写入）。');
      return {
        handled: true,
        reply: L.join('\n'),
        breakdown: { id, projectName: br.projectName, count: br.tasks.length },
      };
    } catch (e) {
      return { handled: true, reply: `任务拆解出了点问题：${e.message}` };
    }
  }

  // 显式命令：确认拆解 → 把最近一次拆解候选批量写入「任务计划」表
  async function handleConfirmBreakdownCommand(rawText) {
    if (!/^确认拆解$/.test(String(rawText || '').trim())) return null;
    const flow = getBreakdownFlow(lastBreakdownFlowId);
    if (!flow) return { handled: true, reply: '没有待确认的拆解候选（候选 1 小时内有效）。先发「拆任务：项目名」。' };
    return applyBreakdownFlow(flow);
  }

  async function applyBreakdownFlow(flow) {
    try {
      const r = await taskRunner.createBreakdownTasks(flow.projectName, flow.tasks);
      if (!r.ok) return { handled: true, reply: `写入任务计划失败：${r.error}` };
      breakdownFlows.delete(lastBreakdownFlowId);
      lastBreakdownFlowId = '';
      const aiCount = flow.tasks.filter((t) => t.aiSuitable).length;
      const dupNote = r.created === 0 ? '\n（本次候选与现有任务全部重名，未重复创建）' : '';
      return {
        handled: true,
        reply: `✅ 已写入「任务计划」${r.created} 条｜《${flow.projectName}》${dupNote}\n· AI可代做 ${aiCount} 条：已置为待处理，后台轮询自动执行\n· 需你动手 ${r.created - aiCount} 条：任务中心「待确认」，你决定何时做\n每条都带验收标准，AI 执行完会自查达标/未达标。`,
      };
    } catch (e) {
      return { handled: true, reply: `写入任务计划出了点问题：${e.message}` };
    }
  }

  // 显式命令：帮助 / 命令 / 指令 / help → 返回全部聊天命令速查（零 AI 调用）
  // 清单与各 handle*Command 正则一一对应，新增命令时同步更新这里
  function handleHelpCommand(rawText) {
    const t = String(rawText || '').trim().toLowerCase();
    if (!['帮助', '命令', '指令', 'help'].includes(t)) return null;
    const reply = [
      '📖 命令速查（都是「动词：内容」格式，忘了就发「帮助」）',
      '',
      '🔍 想研究东西',
      '· 研究快讯：<话题> —— 快速了解一个话题',
      '· 研究：<话题> —— 深度分析（可存知识库）',
      '· 对比：A vs B —— 两样东西对比研究',
      '',
      '📋 想推进项目',
      '· 拆任务：<项目名> —— 把项目拆成带验收标准的任务（拆完回复「确认拆解」才写入）',
      '· 项目建议：<项目名> —— 问项目顾问要下一步建议',
      '· 新建项目：<项目名> —— 手动开一张项目卡',
      '',
      '⚖️ 想拍板决策',
      '· 决策：<要不要做X> —— 十维尽调出决策卡（拍板权在你）',
      '· 立项：<已拍板的决策关键词> —— ✅决定做的决策卡一键转项目',
      '',
      '🧠 想沉淀',
      '· 记经验：<一句话> —— 经验直接落卡（✅已确认生效）',
      '· 书卡：<书名> —— 查开放书库 + AI 拆书卡（回复「存」落知识库）',
      '',
      '🗓️ 开会前',
      '· 会前：<会议主题> —— 会前准备简报',
    ].join('\n');
    return { handled: true, reply };
  }

  // 显式命令：记经验：<内容> → 聊天里亲手记的经验直接落经验卡
  // （用户亲手打字 = 亲口陈述，addExperience 不传 confirmed 默认 ✅已确认；类型/级别用默认值，分类去飞书表改）
  async function handleRecordExperienceCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^记经验[：:]\s*(.+)$/);
    if (!m) return null;
    const content = m[1].trim();
    if (!experienceCenter) return { handled: true, reply: '经验复盘功能未启用（需飞书授权）' };
    if (!content) return { handled: true, reply: '记经验格式：记经验：<经验内容>（一句话说清这条经验）' };
    try {
      const r = await experienceCenter.addExperience({ content, source: '聊天记录' });
      if (!r.ok) return { handled: true, reply: `经验卡写入失败：${r.error}` };
      return { handled: true, reply: `🧠 已记入经验卡（✅已确认 · 普通经验 · 中性观察，分类可去飞书「经验复盘」表改）：\n「${content.slice(0, 60)}${content.length > 60 ? '…' : ''}」` };
    } catch (e) {
      return { handled: true, reply: `经验卡写入出了点问题：${e.message}` };
    }
  }

  // 隐式命令：日程自动记录（用户随口说「明天下午3点开会」→ AI 解析 → 直接落飞书日程表，来源 💬聊天）
  // 触发条件：含日期/时间词、非显式命令、非链接、非问句；AI 解析不出日程则放行给主流程
  const SCHED_HINT = /(明天|后天|大后天|今晚|明早|今晚|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*月\d{1,2}\s*[号日]|[上下中]午\s*\d|晚上?\s*\d|早上\s*\d|凌晨\s*\d|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点)/;
  async function handleScheduleAutoCommand(rawText) {
    const text = String(rawText || '').trim();
    if (!scheduleCenter) return null;
    if (text.length < 4 || text.length > 200) return null;
    if (/^(记经验|决策|立项|拆任务|确认拆解|书卡|研究快讯|研究|对比|帮助|存|日程)[：:]/.test(text)) return null; // 显式命令已分流
    if (/https?:\/\//.test(text)) return null; // 链接走收录流程
    if (/[？?]\s*$/.test(text)) return null; // 问句不是日程
    if (!SCHED_HINT.test(text)) return null;
    let parsed = null;
    try { parsed = await scheduleCenter.parseScheduleFromText(text); } catch (e) { return null; } // 解析失败不阻塞主流程
    if (!parsed || !parsed.date || !parsed.content) return null;
    // 只记今天及未来的日程，过去日期视为闲聊误判
    const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (parsed.date < todayStr) return null;
    try {
      const r = await scheduleCenter.addSchedule({
        date: parsed.date, time: parsed.time || '', content: parsed.content, source: '💬聊天', note: '',
      });
      if (!r.ok) return null;
      return {
        handled: true,
        reply: `📅 已记入日程表：${parsed.date}${parsed.time ? ' ' + parsed.time : ''} · ${parsed.content}\n（说错了就去「日程表」页面删；截图日程也可以直接发给我识别）`,
      };
    } catch (e) { return null; }
  }

  // 显式命令：立项：<决策关键词> → 已拍板(✅决定做)的决策卡转项目卡（尽调结论预填，不重新描述）
  async function handleLaunchCommand(rawText) {
    const text = String(rawText || '').trim();
    const m = text.match(/^立项[：:]\s*(.+)$/);
    if (!m) return null;
    if (!decisionCenter || !decisionCenter.isReady()) return { handled: true, reply: '决策卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
    if (!projectCenter || !projectCenter.isReady()) return { handled: true, reply: '项目卡未启用：需要飞书授权（LARK_BASE_TOKEN）。' };
    const kw = m[1].trim();
    try {
      const dr = await decisionCenter.listDecisions({});
      if (!dr.ok) return { handled: true, reply: `读取决策卡失败：${dr.error}` };
      const decided = dr.items.filter((x) => x.status === '✅决定做');
      const hit = decided.find((x) => x.question.includes(kw)) || decided.find((x) => x.finalDecision && x.finalDecision.includes(kw));
      if (!hit) {
        const listText = decided.slice(0, 5).map((x, i) => `${i + 1}. ${x.question}`).join('\n');
        return { handled: true, reply: `没找到与「${kw}」相关的 ✅决定做 决策卡。\n${listText ? `已拍板的决策卡有：\n${listText}\n` : '目前还没有已拍板的决策卡，先发「决策：要不要做X」做尽调并在飞书拍板。\n'}` };
      }
      const pr = await projectCenter.listProjects({ keyword: hit.question.slice(0, 20) });
      if (pr.ok && (pr.items || []).some((x) => x.name === hit.question)) {
        return { handled: true, reply: `《${hit.question}》已有同名项目卡，不用重复立项。想拆任务直接回复「拆任务：${hit.question.slice(0, 20)}」。` };
      }
      const r = await projectCenter.createProjectFromDecision(hit);
      if (!r.ok) return { handled: true, reply: `立项失败：${r.error}` };
      return {
        handled: true,
        reply: `🗂 已从决策卡立项：《${r.fromDecision}》\n状态：${r.status}（AI 只做规划草案，是否推进由你决定）\n已带入：已知事实、可选方案、最大未知、验证路径、你的最终决定 → 拟成 目标/里程碑/下一步/风险/退出条件 草案，可在飞书「项目卡」表查看修改。\n\n想拆成可执行任务时回复「拆任务：${r.fromDecision.slice(0, 20)}」。`,
      };
    } catch (e) {
      return { handled: true, reply: `立项出了点问题：${e.message}` };
    }
  }

  function formatDecisionReply(question, r) {
    const a = r.analysis || {};
    const L = [];
    L.push(`🎯 决策卡已建好，状态：${r.status}`);
    L.push(`事项：${question}`);
    L.push(`领域：${a['领域'] || '其他'}｜证据充分度：${a['证据充分度'] || '不足'}｜AI置信度：${a['AI倾向置信度'] || '低'}`);
    const arr = (x) => (Array.isArray(x) && x.length) ? x.map((v, i) => `${i + 1}. ${v}`).join('\n') : '（暂无明确依据）';
    L.push(`\n【已知事实】（只来自你确认过的档案/经验和你这次说的）\n${arr(a['已知事实'])}`);
    L.push(`\n【你已有的判断】\n${arr(a['我的既有判断'])}`);
    const d = a['十维尽调'] || {};
    const dims = ['项目', '团队', '商业模式', '数据', '风险', '最小验证', '最坏损失', '资源', '投入', '退出条件'];
    L.push('\n【十维尽调】\n' + dims.map((k) => `■ ${k}：${d[k] || '目前无依据'}`).join('\n'));
    L.push(`\n【最大未知】\n${arr(a['最大未知'])}`);
    L.push(`\n【拍板前·最低成本验证路径】\n${arr(a['可验证路径'])}`);
    const opts = Array.isArray(a['可选方案']) ? a['可选方案'].filter((x) => x && x['方案']).map((x, i) => `${i + 1}. ${x['方案']}（取舍：${x['取舍'] || '—'}）`).join('\n') : '';
    L.push(`\n【可选方案】\n${opts || '（暂无）'}`);
    L.push(`\n【AI 倾向】（仅 AI 观点，不是你的决定）\n${a['AI倾向'] || '—'}`);
    const u = r.used || {};
    L.push(`\n（已参考：已确认档案 ${u.profileConfirmed || 0} 条、已确认经验 ${u.experiences || 0} 条、外部知识资料 ${u.knowledge || 0} 篇）`);
    L.push('⚠️ 我不替你拍板。想清楚后在飞书「决策卡」表把状态改成 ✅决定做 / ⛔决定不做 / ⏸暂缓，并写下你的最终决定；之后可让我按复盘日期做决策复盘。');
    return L.join('\n');
  }

  function formatAdviseReply(it, a) {
    const L = [];
    L.push(`📊 项目体检：${it.name}（${it.cycle}，当前状态 ${it.status}）`);
    L.push(`\n【阶段判断】${a['阶段判断'] || '—'}`);
    L.push(`理由：${a['判断理由'] || '—'}`);
    L.push(`\n【建议的下一步】${a['更新后的下一步'] || '—'}`);
    L.push(`【阻塞破解】${a['阻塞破解'] || '—'}`);
    L.push(`【本周期复盘要点】${a['本周期复盘要点'] || '—'}`);
    L.push(`【退出条件检查】${a['是否触及退出条件'] || '否'}`);
    L.push('\n⚠️ 是否加码/暂停/退出由你本人决定，我不自动改项目状态。确定后可在飞书「项目卡」表更新状态，进展也可在表里记录。');
    return L.join('\n');
  }

  // ============ 会后回流（候选→用户确认，绝不自动写卡） ============
  // flowId → {createdAt, noteTitle, decisions:[{decision,basis}], openQuestions:[], projects:[{recordId,name,status}]}
  const meetingFlows = new Map();
  const FLOW_TTL_MS = 60 * 60 * 1000;
  function newFlowId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function getFlow(id) {
    const f = meetingFlows.get(id);
    if (!f) return null;
    if (Date.now() - f.createdAt > FLOW_TTL_MS) { meetingFlows.delete(id); return null; }
    return f;
  }
  // 从妙记整理结果构造回流候选；匹配关联项目（关键词子串）；没有任何可回流项时返回 null
  async function buildMeetingFlow(nr) {
    if (!nr || !nr.meetingType) return null;
    const decisions = (Array.isArray(nr.decisions) ? nr.decisions : []).filter((d) => d && d.decision);
    const openQuestions = (Array.isArray(nr.openQuestions) ? nr.openQuestions : []).filter(Boolean);
    let projects = [];
    if (projectCenter && nr.relatedProject) {
      try {
        const lr = await projectCenter.listProjects({ keyword: nr.relatedProject });
        projects = ((lr && lr.items) || []).slice(0, 3).map((p) => ({ recordId: p.recordId, name: p.name, status: p.status }));
      } catch (e) { projects = []; }
    }
    if (!decisions.length && !openQuestions.length && !projects.length) return null;
    const id = newFlowId();
    meetingFlows.set(id, {
      createdAt: Date.now(),
      noteTitle: String(nr.title || '').slice(0, 80),
      meetingType: nr.meetingType,
      decisions,
      openQuestions,
      projects,
    });
    if (meetingFlows.size > 50) {
      // 简单清理：删掉最早的一批
      const keys = [...meetingFlows.keys()].slice(0, 20);
      keys.forEach((k) => meetingFlows.delete(k));
    }
    return { id, meetingType: nr.meetingType, decisions, openQuestions, projects };
  }

  // ============ 项目任务拆解（候选→用户确认，绝不自动写表） ============
  // flowId → {createdAt, projectName, recordId, tasks:[{task,criteria,priority,aiSuitable}]}
  const breakdownFlows = new Map();
  const BREAKDOWN_TTL_MS = 60 * 60 * 1000;
  let lastBreakdownFlowId = '';
  function getBreakdownFlow(id) {
    const f = breakdownFlows.get(id);
    if (!f) return null;
    if (Date.now() - f.createdAt > BREAKDOWN_TTL_MS) { breakdownFlows.delete(id); return null; }
    return f;
  }

  // 所有响应通过 JSON body 返回，响应头不放任何中文
  // 统一输入处理：分类 → 对话/回答/存记录（/api/input 与语音对话共用）
  async function processUserInput(text, history) {
    // 显式命令：会前简报（优先级最高）
    const meetingCmd = await handleMeetingCommand(text);
    if (meetingCmd && meetingCmd.handled) return { ok: true, mode: 'chat', reply: meetingCmd.reply, saved: false };

    // 显式命令：决策卡 / 项目卡（优先级最高，避免被分类器当普通提问）
    const cmd = await handleDecideCommand(text);
    if (cmd && cmd.handled) return { ok: true, mode: 'chat', reply: cmd.reply, saved: false };

    // 显式命令：研究 / 研究快讯 / 对比（思考伙伴档位化研究，可落库）
    const researchCmd = await handleResearchCommand(text);
    if (researchCmd && researchCmd.handled) {
      return {
        ok: true,
        mode: 'chat',
        reply: researchCmd.reply,
        saved: false,
        researchable: Boolean(researchCmd.research),
        research: researchCmd.research || null,
      };
    }

    // 显式命令：书卡（查开放书库 + AI 拆书卡，回复「存」落知识资料表）
    const bookCmd = await handleBookCardCommand(text);
    if (bookCmd && bookCmd.handled) {
      return { ok: true, mode: 'chat', reply: bookCmd.reply, saved: false };
    }

    // 显式命令：记账（课时/人数 → 候选，回「存」入账）
    const ledgerCmd = await handleLedgerCommand(text);
    if (ledgerCmd && ledgerCmd.handled) {
      return { ok: true, mode: 'chat', reply: ledgerCmd.reply, saved: false };
    }

    // 显式命令：存（课时账候选入账；无记账候选或书卡候选更新时放行给书卡）
    const saveLedgerCmd = await handleSaveLedgerCommand(text);
    if (saveLedgerCmd && saveLedgerCmd.handled) {
      return { ok: true, mode: 'chat', reply: saveLedgerCmd.reply, saved: true };
    }

    // 显式命令：存（保存书卡候选到知识资料表）
    const saveBookCmd = await handleSaveBookCardCommand(text);
    if (saveBookCmd && saveBookCmd.handled) {
      return { ok: true, mode: 'chat', reply: saveBookCmd.reply, saved: true };
    }

    // 显式命令：拆任务（里程碑→带验收标准的任务候选，确认后才落表）
    const breakdownCmd = await handleBreakdownCommand(text);
    if (breakdownCmd && breakdownCmd.handled) {
      return {
        ok: true, mode: 'chat', reply: breakdownCmd.reply, saved: false,
        breakdown: breakdownCmd.breakdown || null,
      };
    }

    // 显式命令：确认拆解（把最近一次候选写入任务计划表）
    const confirmCmd = await handleConfirmBreakdownCommand(text);
    if (confirmCmd && confirmCmd.handled) {
      return { ok: true, mode: 'chat', reply: confirmCmd.reply, saved: false };
    }

    // 显式命令：立项（已拍板决策卡 → 项目卡，尽调结论预填）
    const launchCmd = await handleLaunchCommand(text);
    if (launchCmd && launchCmd.handled) {
      return { ok: true, mode: 'chat', reply: launchCmd.reply, saved: false };
    }

    // 显式命令：记经验（用户聊天里亲手记的经验金句，直接落经验卡，默认已确认）
    const expCmd = await handleRecordExperienceCommand(text);
    if (expCmd && expCmd.handled) {
      return { ok: true, mode: 'chat', reply: expCmd.reply, saved: false };
    }

    // 显式命令：帮助（命令速查，零 AI）
    const helpCmd = handleHelpCommand(text);
    if (helpCmd && helpCmd.handled) {
      return { ok: true, mode: 'chat', reply: helpCmd.reply, saved: false };
    }

    // 隐式命令：日程自动记录（「明天下午3点开会」→ 直接落飞书日程表）
    const schedCmd = await handleScheduleAutoCommand(text);
    if (schedCmd && schedCmd.handled) {
      return { ok: true, mode: 'chat', reply: schedCmd.reply, saved: false };
    }

    // 妙记笔记收录：优先于视频链接收录（feishu.cn/minutes/obcn...）
    if (noteIntake) {
      const nr = await noteIntake.collect(text);
      if (nr && nr.handled) {
        captureNoteTodos(nr, '妙记');
        const expAdded = await captureNoteExperiences(nr, '妙记沉淀').catch(() => 0);
        const expLine = expAdded > 0 ? `\n🧠 已自动沉淀 ${expAdded} 条方法论到「经验复盘」表。` : '';
        // 会后回流候选（只构造候选，不写决策卡/项目卡；用户点按钮才入库）
        const flow = await buildMeetingFlow(nr).catch(() => null);
        let flowLine = '';
        if (flow) {
          const bits = [];
          if (flow.decisions.length) bits.push(`${flow.decisions.length} 个会上已拍板的决定`);
          if (flow.openQuestions.length) bits.push(`${flow.openQuestions.length} 个待决事项`);
          if (flow.projects.length) bits.push(`关联项目「${flow.projects[0].name}」`);
          flowLine = `\n\n🔁 会后回流：检测到${bits.join('、')}。点下方按钮归档到决策卡/项目卡（我不会自动写入）。`;
        }
        return {
          ok: true,
          mode: 'chat',
          reply: nr.reply + expLine + flowLine,
          saved: false,
          note: { token: nr.token, title: nr.title, todoAdded: nr.todoAdded || 0, expAdded },
          meetingFlow: flow,
        };
      }
    }

    // 视频链接收录：优先于普通分类流程（B站/YouTube/抖音/小红书/TikTok）
    if (videoIntake) {
      const vr = await videoIntake.collect(text);
      if (vr && vr.handled) {
        return {
          ok: true,
          mode: 'chat',
          reply: vr.reply,
          saved: false,
          video: { url: vr.url, platform: vr.platform, dedup: Boolean(vr.dedup), queued: Boolean(vr.queued), title: vr.title || '', recordId: vr.recordId || '' },
        };
      }
    }

    let cls;
    try {
      cls = await deepseek.classify(text, apiKey);
    } catch (e) {
      const err = new Error(`分类失败: ${e.message}`); err.status = 502; throw err;
    }

    // 当前时间前缀（用于回答类请求，让 AI 知道"今天"是哪天）
    const _now = new Date(Date.now() + 8 * 3600 * 1000);
    const _week = ['日','一','二','三','四','五','六'][_now.getDay()];
    const _dateStr = `${_now.getFullYear()}-${pad2(_now.getMonth()+1)}-${pad2(_now.getDate())} 星期${_week} ${pad2(_now.getHours())}:${pad2(_now.getMinutes())}`;

    // 情况1：不是记录，只是对话回应 → 不存，走思考伙伴回答（失败自动回退普通问答）
    if (cls.isRecord === false) {
      let ans;
      try {
        ans = await answerThinking(text, history, _dateStr);
      } catch (e) {
        const err = new Error(`回答失败: ${e.message}`); err.status = 502; throw err;
      }
      return {
        ok: true,
        mode: 'chat',
        reply: ans.reply,
        saved: false,
        sources: ans.sources,
        researchable: Boolean(ans.sources),
        research: ans.sources ? { question: text, reply: ans.reply } : null,
      };
    }

    // 情况2：是提问 → 不存，走思考伙伴回答
    if (cls.type === '提问') {
      let ans;
      try {
        ans = await answerThinking(text, history, _dateStr);
      } catch (e) {
        const err = new Error(`回答失败: ${e.message}`); err.status = 502; throw err;
      }
      return {
        ok: true,
        mode: 'answer',
        type: cls.type,
        title: cls.title,
        reply: ans.reply,
        saved: false,
        sources: ans.sources,
        researchable: Boolean(ans.sources),
        research: ans.sources ? { question: text, reply: ans.reply } : null,
      };
    }

    // 情况3：是记录 → 存文件
    let aiAnalysis;
    try {
      aiAnalysis = await deepseek.ask(
        `请基于以下输入生成简短的AI判断（不替用户做决定，只分析）:\n${text}`,
        '',
        apiKey,
        history
      );
    } catch (e) {
      aiAnalysis = `AI判断生成失败: ${e.message}`;
    }

    let saved;
    try {
      saved = storage.saveRecord(dataRoot, cls.type, cls.title, text, aiAnalysis);
    } catch (e) {
      const err = new Error(`保存失败: ${e.message}`); err.status = 500; throw err;
    }

    // 画像生长分析（失败不影响主流程）
    let profileUpdated = false;
    let profileItems = 0;
    try {
      const result = await profileGrowth.analyze(text, apiKey);
      if (result && result.shouldUpdate && result.items && result.items.length > 0) {
        const { ts, display } = makeTs();
        const recordPath = saved.dir + '/' + saved.file;
        storage.appendProfileUpdate(dataRoot, ts, display, recordPath, result.items);
        profileUpdated = true;
        profileItems = result.items.length;
      }
    } catch (e) {
      // 静默
    }

    // 中文文件名等通过 body 返回，不进 header
    return {
      ok: true,
      mode: 'saved',
      type: cls.type,
      title: cls.title,
      saved: true,
      dir: saved.dir,
      file: saved.file,
      path: saved.path,
      profileUpdated,
      profileItems,
    };
  }

  // ==== 聊天记录持久化：data/chat-history.jsonl（双端共享，刷新不丢） ====
  const chatLogFile = path.join(dataRoot, 'chat-history.jsonl');
  function appendChatLog(entry) {
    try {
      fs.appendFileSync(chatLogFile, JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n');
    } catch (e) {
      console.error('聊天记录写入失败:', e.message);
    }
  }
  // 与前端 saved 卡片文案保持一致，重载渲染无差异
  function savedCardText(r) {
    let body = `已保存为「${r.type}」\n标题：${r.title}\n目录：${r.dir}`;
    if (r.profileUpdated) body += `\n认知条目：+${r.profileItems} 条`;
    return body;
  }
  // 一问一答成对落盘（请求失败不落盘）
  function logExchange(userMsg, result) {
    if (!result || result.ok === false) return;
    appendChatLog(userMsg);
    appendChatLog({
      role: 'assistant',
      kind: result.mode === 'saved' ? 'saved' : 'assistant',
      mode: result.mode || '',
      text: result.mode === 'saved' ? savedCardText(result) : (result.reply || ''),
    });
  }

  router.get('/api/chat/history', (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    let msgs = [];
    try {
      const raw = fs.readFileSync(chatLogFile, 'utf8');
      msgs = raw.split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { /* 文件不存在视为空 */ }
    const total = msgs.length;
    const end = Math.max(0, total - skip);
    return res.json({ ok: true, total, messages: msgs.slice(Math.max(0, end - limit), end) });
  });

  router.post('/api/input', async (req, res) => {
    const text = (req.body && req.body.text) || '';
    const history = (req.body && req.body.history) || [];
    const quote = String((req.body && req.body.quote) || '').trim();
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: '输入为空' });
    }
    try {
      const result = await processUserInput(text.trim(), history);
      logExchange({ role: 'user', kind: 'user', text: text.trim(), quote: quote || undefined }, result);
      return res.json(result);
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // 研究产出落库：思考伙伴回答 → 飞书「知识资料」表
  // 信息层级=AI分析、来源平台=自产研究，按条目key（selfresearch::内容哈希）幂等，重复保存跳过
  router.post('/api/thinking/save-research', express.json(), async (req, res) => {
    if (!knowledgeCenter || typeof knowledgeCenter.saveResearch !== 'function') {
      return res.status(400).json({ ok: false, error: '知识资料未启用：需要飞书授权（LARK_BASE_TOKEN）' });
    }
    const question = String((req.body && req.body.question) || '').trim();
    const reply = String((req.body && req.body.reply) || '').trim();
    if (!reply) return res.status(400).json({ ok: false, error: '研究内容为空，无法保存' });
    try {
      const r = await knowledgeCenter.saveResearch({ question, reply });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 项目任务拆解：确认写入「任务计划」表（用户在聊天里点按钮/回复确认拆解后才调用）
  router.post('/api/tasks/breakdown/apply', express.json(), async (req, res) => {
    if (!taskRunner || !taskRunner.isReady()) {
      return res.status(400).json({ ok: false, error: '任务计划未启用' });
    }
    const id = String((req.body && req.body.id) || '');
    const flow = getBreakdownFlow(id) || (lastBreakdownFlowId ? getBreakdownFlow(lastBreakdownFlowId) : null);
    if (!flow) return res.status(404).json({ ok: false, error: '拆解候选不存在或已过期（1小时有效），请重新发「拆任务：项目名」' });
    try {
      const r = await taskRunner.createBreakdownTasks(flow.projectName, flow.tasks);
      if (!r.ok) return res.status(400).json(r);
      clearTaskListCache();
      breakdownFlows.delete(flow.id || id);
      if (lastBreakdownFlowId === (flow.id || id)) lastBreakdownFlowId = '';
      const aiCount = flow.tasks.filter((t) => t.aiSuitable).length;
      return res.json({ ok: true, created: r.created, total: r.total, aiCount, projectName: flow.projectName });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 图片输入：base64 图片 → 视觉识别 → 复用 processUserInput（分类/存记录/对话）
  router.post('/api/input/image', express.json({ limit: '25mb' }), async (req, res) => {
    if (!vision || !vision.isReady()) {
      return res.status(400).json({ ok: false, error: '图片识别未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
    }
    const image = (req.body && req.body.image) || '';
    const history = (req.body && req.body.history) || [];
    const userPrompt = ((req.body && req.body.prompt) || '').trim();
    if (!image) return res.status(400).json({ ok: false, error: '图片为空' });

    let text = '';
    try {
      text = await vision.recognize(image, undefined, userPrompt || undefined);
    } catch (e) {
      return res.status(502).json({ ok: false, error: '图片识别失败: ' + e.message });
    }
    if (!text || !text.trim()) {
      return res.json({ ok: false, error: '没识别出内容，换张清晰的图试试？' });
    }
    // 课时账截图：提示词含记账类关键词，或识别文本含「周X N人」模式 → 出记账候选（回「存」入账）
    const ledgerHint = /记账|课时|结算|人数|课时费|算账/.test(userPrompt || '') || /周[一二三四五六日][^\d]{0,4}\d+\s*人/.test(text);
    if (ledgerCenter && ledgerHint) {
      try {
        const list = await ledgerCenter.parseLedgerFromText(userPrompt ? `${userPrompt}\n${text}` : text, '支出');
        if (list.length) {
          list.forEach((c) => { c.source = '📸截图'; });
          ledgerFlow = { items: list, ts: Date.now() };
          appendChatLog({ role: 'user', kind: 'user', text: `[图片]${userPrompt ? ' ' + userPrompt : ''}` });
          appendChatLog({ role: 'assistant', kind: 'assistant', mode: 'chat', text: formatLedgerCandidates(list) });
          return res.json({
            ok: true, mode: 'chat', saved: false,
            recognizedText: text.trim().slice(0, 2000), userPrompt,
            reply: formatLedgerCandidates(list),
          });
        }
      } catch (e) {
        console.error('课时账截图解析失败（回退普通流程）:', e.message);
      }
    }
    // 有用户提问时，把「提问 + 图片回答」一起给 AI，让它结合上下文回应
    const inputText = userPrompt
      ? `【图片】用户问：${userPrompt}\n【图片内容/识别结果】${text.trim()}`
      : text.trim();
    try {
      const result = await processUserInput(inputText, history);
      logExchange({ role: 'user', kind: 'user', text: `[图片]${userPrompt ? ' ' + userPrompt : ''}` }, result);
      return res.json({ ok: true, recognizedText: text.trim().slice(0, 2000), userPrompt, ...result });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  router.post('/api/ask', async (req, res) => {
    const question = (req.body && req.body.text) || '';
    const history = (req.body && req.body.history) || [];
    if (!question || !question.trim()) {
      return res.status(400).json({ ok: false, error: '问题为空' });
    }
    let context;
    try {
      context = storage.readContext(dataRoot);
    } catch (e) {
      context = '';
    }
    let reply;
    try {
      reply = await deepseek.ask(question, context, apiKey, history);
    } catch (e) {
      return res.status(502).json({ ok: false, error: `回答失败: ${e.message}` });
    }
    return res.json({ ok: true, reply });
  });

  // 语音对话：录音 → ASR 转写 → 复用 AI 问答（服务端按会话记多轮上下文）
  // 前端用浏览器自带 speechSynthesis 朗读回复，零额外依赖
  const voiceChatSessions = new Map(); // sessionId -> [{role, content}]
  router.post('/api/ask/voice', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    if (!asr || !asr.isReady()) {
      return res.status(400).json({ ok: false, error: '语音转写未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ ok: false, error: '音频内容为空' });
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm';
    let text = '';
    try {
      text = await asr.transcribe(buf, 'voice.' + ext, { mimeType: mime });
    } catch (e) {
      return res.status(502).json({ ok: false, error: '转写失败: ' + e.message });
    }
    if (!text || !text.trim()) {
      return res.json({ ok: false, error: '没听清，再说一次？' });
    }
    const sid = String(req.headers['x-chat-session'] || 'default').slice(0, 64);
    const hist = voiceChatSessions.get(sid) || [];
    try {
      // 与打字完全一致的分类逻辑：妙记/视频链接收录、对话、提问、存记录（含画像生长）
      const r = await processUserInput(text.trim(), hist);
      hist.push({ role: 'user', content: text.trim() });
      if (r.reply) hist.push({ role: 'assistant', content: r.reply });
      while (hist.length > 24) hist.shift();
      voiceChatSessions.set(sid, hist);
      return res.json({ ok: true, userText: text.trim().slice(0, 500), ...r });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // 纯语音转文字：音频 → 文字，不做 AI 对话、不存记录（供评价框、待办等场景"语音输入"）
  router.post('/api/asr/transcribe', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    if (!asr || !asr.isReady()) {
      return res.status(400).json({ ok: false, error: '语音转写未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ ok: false, error: '音频内容为空' });
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm';
    try {
      const text = await asr.transcribe(buf, 'dictation.' + ext, { mimeType: mime });
      if (!text || !text.trim()) return res.json({ ok: false, error: '没听清，再说一次？' });
      return res.json({ ok: true, text: text.trim() });
    } catch (e) {
      return res.status(502).json({ ok: false, error: '转写失败: ' + e.message });
    }
  });

  router.get('/api/records', (req, res) => {
    try {
      const files = storage.scanAllMarkdown(dataRoot);
      const list = files.map((f) => {
        const rel = f.split('data' + require('path').sep).pop() || f;
        let preview = '';
        try {
          preview = require('fs').readFileSync(f, 'utf8').slice(0, 200);
        } catch (e) {}
        return { file: rel, preview };
      });
      return res.json({ ok: true, records: list });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/api/profile-updates', (req, res) => {
    try {
      const entries = storage.readProfileUpdates(dataRoot);
      return res.json({ ok: true, entries });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.delete('/api/profile-updates/:id', (req, res) => {
    const id = req.params.id || '';
    if (!/^\d{14}$/.test(id)) {
      return res.status(400).json({ ok: false, error: '非法 ID' });
    }
    try {
      const result = storage.deleteProfileEntry(dataRoot, id);
      if (!result.ok) {
        return res.status(404).json({ ok: false, error: result.reason });
      }
      return res.json({ ok: true, removed: result.removed });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/api/health', (req, res) => {
    return res.json({ ok: true });
  });

  // 读取今日计划
  router.get('/api/todos', (req, res) => {
    try {
      const todos = readTodoFile(dataRoot);
      return res.json({ ok: true, todos });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 新增待办
  router.post('/api/todos', (req, res) => {
    const text = (req.body && req.body.text) || '';
    const priority = (req.body && req.body.priority) || 'P2';
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: 'text 不能为空' });
    }
    try {
      const todos = readTodoFile(dataRoot);
      const now = Date.now();
      const { display } = makeTs();
      todos.push({ id: now, text: text.trim(), priority, done: false, createdAt: display, source: 'local' });
      writeTodoFile(dataRoot, todos);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 切换待办完成状态
  router.post('/api/todos/toggle', (req, res) => {
    const id = req.body && req.body.id;
    if (id === undefined || id === null) {
      return res.status(400).json({ ok: false, error: '缺少 id' });
    }
    try {
      const todos = readTodoFile(dataRoot);
      const item = todos.find(t => String(t.id) === String(id));
      if (!item) {
        return res.status(404).json({ ok: false, error: '待办不存在' });
      }
      item.done = !item.done;
      writeTodoFile(dataRoot, todos);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 删除待办
  router.delete('/api/todos', (req, res) => {
    const id = req.body && req.body.id;
    if (id === undefined || id === null) {
      return res.status(400).json({ ok: false, error: '缺少 id' });
    }
    try {
      const todos = readTodoFile(dataRoot);
      const idx = todos.findIndex(t => String(t.id) === String(id));
      if (idx === -1) {
        return res.status(404).json({ ok: false, error: '待办不存在' });
      }
      todos.splice(idx, 1);
      writeTodoFile(dataRoot, todos);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 妙记/录音/图片笔记的待办同步汇入任务中心（状态=待确认，来源=妙记）
  function captureNoteTodos(nr, source) {
    if (!taskRunner || !nr || !Array.isArray(nr.todos)) return;
    const title = String(nr.title || '');
    for (const t of nr.todos) {
      if (!t || !t.text) continue;
      taskRunner.captureTask(
        t.text,
        `笔记《${title.slice(0, 80)}》中提到要做：${t.text}。请针对这件事给出具体的执行建议或直接完成。`,
        source
      ).catch(() => {});
    }
  }

  // 妙记/录音/图片里的方法论干货自动沉淀进「经验复盘」表（AI 高门槛筛选，每次最多 2 条）
  // 返回成功入库条数；单条失败不阻塞，经验中心未配置时静默跳过
  async function captureNoteExperiences(nr, source) {
    if (!experienceCenter || !nr || !Array.isArray(nr.experiences)) return 0;
    const noteTitle = String(nr.title || '').slice(0, 80);
    let added = 0;
    for (const x of nr.experiences) {
      if (!x || !x.content) continue;
      try {
        const r = await experienceCenter.addExperience({
          content: x.content,
          type: x.type,
          level: x.level,
          category: x.category,
          videoTitle: noteTitle ? `笔记《${noteTitle}》` : '',
          source: source || '妙记沉淀',
          confirmed: false, // AI 自动提炼 → 🟡待我确认，用户点头才算个人经验
        });
        if (r && r.ok) added++;
      } catch (e) { /* 单条经验失败不阻塞主流程 */ }
    }
    return added;
  }

  // 从用户输入提取待办（前端在保存记录后调，结果加到 workbench 今日计划）
  router.post('/api/extract-todos', async (req, res) => {
    const text = (req.body && req.body.text) || '';
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: '输入为空' });
    }
    try {
      const result = await extractTodos.extractTodos(text, apiKey);
      const todos = result.todos || [];
      // 把提取到的待办追加到 JSON 文件
      if (todos.length > 0) {
        const existing = readTodoFile(dataRoot);
        const now = Date.now();
        const { display } = makeTs();
        for (let i = 0; i < todos.length; i++) {
          existing.push({
            id: now + i,
            text: todos[i].text,
            priority: todos[i].priority || 'P2',
            done: false,
            createdAt: display,
            source: 'local',
          });
        }
        writeTodoFile(dataRoot, existing);
      }
      // AI 可执行的任务自动派发到飞书「任务计划」（后台轮询执行，不阻塞响应）
      let aiDispatched = 0;
      // AI 不可执行的任务也汇入任务中心（状态=待确认，用户可查看/派发/忽略）
      let captured = 0;
      if (taskRunner) {
        for (const t of todos) {
          if (t.aiSuitable && t.instruction) {
            taskRunner.dispatch(t.text, t.instruction, { wait: false })
              .then(() => { aiDispatched++; })
              .catch(() => {});
          } else {
            taskRunner.captureTask(t.text, t.instruction || '', '助手')
              .then((r) => { if (r.ok && !r.skipped) captured++; })
              .catch(() => {});
          }
        }
      }
      return res.json({ ok: true, todos, aiTasks: todos.filter((t) => t.aiSuitable).length, capturedTasks: captured });
    } catch (e) {
      return res.json({ ok: true, todos: [], warning: e.message });
    }
  });

  // ============ 视频灵感收录 ============

  // 手动收录视频链接：{ text 或 url, wait?: true }
  // 默认异步（立即返回，后台拆解完写入飞书表格）；wait=true 时同步等全流程结束
  router.post('/api/videos/collect', async (req, res) => {
    if (!videoIntake) {
      return res.status(400).json({ ok: false, error: '视频收录功能未启用：需配置飞书与 LARK_BASE_TOKEN/LARK_VIDEO_TABLE_ID' });
    }
    const body = req.body || {};
    const text = body.text || body.url || '';
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: 'text 不能为空' });
    }
    try {
      const vr = await videoIntake.collect(text, { wait: Boolean(body.wait) });
      if (!vr.handled) {
        return res.status(400).json({ ok: false, error: '未识别到支持的视频链接（B站/YouTube/抖音/小红书/TikTok）' });
      }
      clearVideoRecentCache();
      return res.json({ ok: true, ...vr });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 图片收录：base64 图片 → OCR 识别 → 走视频同款爆款拆解 → 写入视频表（来源=图片）
  router.post('/api/videos/collect-image', express.json({ limit: '25mb' }), async (req, res) => {
    if (!videoIntake) {
      return res.status(400).json({ ok: false, error: '视频收录功能未启用：需配置飞书与 LARK_BASE_TOKEN/LARK_VIDEO_TABLE_ID' });
    }
    if (!vision || !vision.isReady()) {
      return res.status(400).json({ ok: false, error: '图片识别未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
    }
    const image = (req.body && req.body.image) || '';
    const wait = Boolean(req.body && req.body.wait);
    if (!image) return res.status(400).json({ ok: false, error: '图片为空' });
    try {
      const text = await vision.recognize(image);
      if (!text || !text.trim()) {
        return res.json({ ok: false, error: '图片里没识别出文字，换张文字清晰的截图试试？' });
      }
      const vr = await videoIntake.collectImageText(text, { wait });
      clearVideoRecentCache();
      return res.json({ ok: true, recognizedText: text.slice(0, 800), ...vr });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 对某条视频追加「我的评价」：{ url 或 recordId, text }，多条评价追加不覆盖
  router.post('/api/videos/comment', async (req, res) => {
    if (!videoIntake) {
      return res.status(400).json({ ok: false, error: '视频收录功能未启用' });
    }
    const body = req.body || {};
    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: '评价内容为空' });
    if (!body.url && !body.recordId) {
      return res.status(400).json({ ok: false, error: '缺少视频链接或记录 ID' });
    }
    try {
      const r = await videoIntake.commentOnVideo({ url: body.url, recordId: body.recordId, text });
      clearVideoRecentCache();
      return res.json({ ok: true, title: r.title, recordId: r.recordId });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 最近收录的视频（首屏视频卡 + 聊天 @ 选择评价目标用）
  // SWR 缓存：30s 内直接回；过期后旧数据秒回 + 后台刷新（写操作清缓存，下次读同步重拉）
  let videoRecentCache = new Map(); // limit -> { ts, items }
  const VIDEO_RECENT_TTL = 30 * 1000;
  const videoRefreshing = new Set();
  function clearVideoRecentCache() { videoRecentCache.clear(); }
  function refreshVideoRecent(limit) {
    if (videoRefreshing.has(limit) || !videoIntake) return;
    videoRefreshing.add(limit);
    videoIntake.listRecentVideos(limit)
      .then((items) => { videoRecentCache.set(limit, { ts: Date.now(), items }); })
      .catch(() => {})
      .finally(() => videoRefreshing.delete(limit));
  }
  router.get('/api/videos/recent', async (req, res) => {
    if (!videoIntake) return res.json({ ok: true, items: [] });
    const limit = Number(req.query.limit) || 8;
    const hit = videoRecentCache.get(limit);
    if (hit) {
      if (Date.now() - hit.ts >= VIDEO_RECENT_TTL) refreshVideoRecent(limit); // 过期 → 旧数据秒回 + 后台刷新
      return res.json({ ok: true, items: hit.items });
    }
    try {
      const items = await videoIntake.listRecentVideos(limit);
      videoRecentCache.set(limit, { ts: Date.now(), items });
      return res.json({ ok: true, items });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 【诊断】容器内验证抖音音频可获取性：依赖清单 + cookies 文件 + yt-dlp 实测
  // 用途：用户放置 www.douyin.com_cookies.txt 后一键验证门槛，通过后再接 ASR。验证完可删。
  router.get('/api/videos/diagnose', (req, res) => {
    const targetUrl = String(req.query.url || 'https://v.douyin.com/10pqdA85hV8/');
    const skillDir = path.join(__dirname, '..', 'skills', 'video-summarizer');
    const script = `
echo "=== env ==="
uname -m
python3 --version 2>&1
python3 -c "import yt_dlp;print('yt_dlp', yt_dlp.version.__version__)" 2>&1 | tail -1
command -v ffmpeg || echo ffmpeg_MISSING
python3 -c "import faster_whisper;print('faster_whisper OK')" 2>&1 | tail -1
echo "=== cookies ==="
ls -la "${skillDir}"/*cookies* 2>/dev/null || echo NO_COOKIE_FILES
echo "=== douyin deps ==="
command -v ffmpeg || echo NO_FFMPEG
command -v chromium-browser || command -v chromium || echo NO_CHROMIUM
node -e "require('playwright-core');console.log('playwright-core OK')" 2>&1 | tail -1
node -e "const d=require('/app/lib/douyin-fetch.js');console.log('douyinFetch:',JSON.stringify(d.isAvailable()))" 2>&1 | tail -1
echo "=== install media deps (multi-mirror probe) ==="
echo "alpine-release: $(cat /etc/alpine-release 2>/dev/null)"
ALPINE_VER="v$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2)"
GOOD_MIRROR=""
for M in mirrors.ustc.edu.cn mirrors.huaweicloud.com mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn dl-cdn.alpinelinux.org; do
  URL="https://$M/alpine/$ALPINE_VER/main/aarch64/APKINDEX.tar.gz"
  if wget -q -T 8 -O /tmp/apkindex_test.tar "$URL" 2>/dev/null && [ -s /tmp/apkindex_test.tar ]; then
    GOOD_MIRROR="$M"
    echo "probe OK: $M"
    break
  else
    echo "probe FAIL: $M"
  fi
done
if [ -n "$GOOD_MIRROR" ]; then
  printf 'https://%s/alpine/%s/main\nhttps://%s/alpine/%s/community\n' "$GOOD_MIRROR" "$ALPINE_VER" "$GOOD_MIRROR" "$ALPINE_VER" > /etc/apk/repositories
  echo "--- repositories ---"
  cat /etc/apk/repositories
  echo "--- apk add ffmpeg ---"
  command -v ffmpeg >/dev/null 2>&1 || apk add --no-cache ffmpeg 2>&1 | tail -6
  echo "--- apk add chromium ---"
  command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || apk add --no-cache chromium 2>&1 | tail -6
else
  echo "NO_REACHABLE_MIRROR"
fi
node -e "require('playwright-core')" >/dev/null 2>&1 || npm install --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com playwright-core 2>&1 | tail -1
echo "install_done: ffmpeg=$(command -v ffmpeg || echo 无) chromium=$(command -v chromium-browser || command -v chromium || echo 无) pw=$(node -e "require('playwright-core')" >/dev/null 2>&1 && echo OK || echo 无)"
echo "=== douyin fetchPlayInfo debug ==="
command -v Xvfb >/dev/null 2>&1 || apk add --no-cache xvfb-run 2>&1 | tail -2
mkdir -p /tmp/.X11-unix
# socket 文件存在 ≠ Xvfb 活着（残留 socket 会骗过检测），pidfile+proc 双重验证
xvfb_alive() {
  if [ -f /tmp/xvfb.pid ] && kill -0 "$(cat /tmp/xvfb.pid)" 2>/dev/null; then return 0; fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -x Xvfb >/dev/null 2>&1; then return 0; fi
  return 1
}
if command -v Xvfb >/dev/null 2>&1 && ! xvfb_alive; then
  rm -f /tmp/.X11-unix/X99
  (Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & echo $! > /tmp/xvfb.pid)
  sleep 2
fi
echo "xvfb_display: $(xvfb_alive && echo 运行中 || echo 未启动)"
[ -e /tmp/.X11-unix/X99 ] || echo "xvfb_log: $(tail -3 /tmp/xvfb.log 2>/dev/null)"
node -e "
const d=require('/app/lib/douyin-fetch.js');
d.fetchPlayInfo(process.argv[1]).then(r=>{console.log('FETCH_OK title='+r.title+' dur='+r.durationSec+' url='+String(r.playUrl).slice(0,80));process.exit(0);}).catch(e=>{console.log('FETCH_ERR '+String(e.message||e).slice(0,500));process.exit(0);});
" "\$1"
echo "=== douyin page dump ==="
node /app/skills/video-summarizer/douyin-dump.js "\$1" 2>&1 | tail -25
echo "=== install curl_cffi (for TLS impersonation) ==="
python3 -c "import curl_cffi" 2>/dev/null || \
  pip3 install --no-cache-dir --break-system-packages -q curl_cffi -i https://mirrors.aliyun.com/pypi/simple/ 2>&1 | tail -1 || true
python3 -c "import curl_cffi" 2>/dev/null || \
  pip3 install --no-cache-dir --break-system-packages -q curl_cffi 2>&1 | tail -1 || true
python3 -c "import curl_cffi;print('curl_cffi OK', curl_cffi.__version__)" 2>&1 | tail -1
echo "=== ytdlp attempts (UA match, then impersonate) ==="
cd "${skillDir}"
timeout 200 python3 - "$1" <<'PY'
import sys, os
sys.path.insert(0, '.')
import video_subtitle as v
url = sys.argv[1]
ck = None
for p in v.COOKIES_PATHS:
    if os.path.exists(p):
        ck = p
        print('using_cookie_file:', os.path.basename(p))
        break
import yt_dlp
CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

def attempt(name, extra):
    opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'socket_timeout': 20, 'cookiefile': ck}
    opts.update(extra)
    try:
        meta = yt_dlp.YoutubeDL(opts).extract_info(url, download=False)
        fmts = (meta or {}).get('formats') or []
        audio = [f for f in fmts if (f.get('acodec') or 'none') != 'none']
        print(f'[{name}] OK title:', (meta or {}).get('title'), '| audio_formats:', len(audio))
        return True
    except Exception as e:
        print(f'[{name}] FAIL:', str(e)[:160])
        return False

done = attempt('cookies+chromeUA', {'user_agent': CHROME_UA})
if done:
    print('VERDICT: OK - audio reachable')
    sys.exit(0)
try:
    from yt_dlp.networking.impersonate import ImpersonateTarget
    target = ImpersonateTarget('chrome')
    done = attempt('cookies+impersonate-chrome', {'impersonate': target})
except Exception as e:
    print('[impersonate] unavailable:', str(e)[:120])
print('VERDICT:', 'OK - audio reachable' if done else 'BLOCKED - all attempts failed')
PY
echo "=== exit=$? ==="
`;
    require('child_process').execFile('sh', ['-c', script, 'sh', targetUrl], {
      timeout: 540000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      res.json({
        ok: !err && /VERDICT: OK/.test(stdout),
        stdout,
        stderr: String(stderr || '').slice(-1000),
        error: err ? `${err.message} (killed=${err.killed || false})` : null,
      });
    });
  });

  // 【快速自检】只验证 Xvfb 虚拟显示器 + 容器浏览器独立取抖音直链（约1-2分钟返回）
  // 比 /api/videos/diagnose 轻得多：后者要装全套依赖+yt-dlp，耗时超 Node 5 分钟请求上限会白屏
  router.get('/api/videos/dy-selfcheck', async (req, res) => {
    const d = require('./douyin-fetch');
    const t0 = Date.now();
    let info = null;
    let fetchErr = null;
    let display = '';
    try {
      const avail = d.isAvailable();
      if (!avail.ok) return res.json({ ok: false, stage: '环境', error: avail.reason, ms: Date.now() - t0 });
      display = await d.ensureXvfb();
      const targetUrl = String(req.query.url || 'https://www.douyin.com/video/7688306714000493870');
      try {
        info = await d.fetchPlayInfo(targetUrl);
      } catch (e) {
        fetchErr = String(e.message || e).slice(0, 400);
      }
      return res.json({
        ok: Boolean(info && info.playUrl),
        xvfb: display || '(无头模式)',
        fromCache: info ? Boolean(info.fromCache) : false,
        title: info ? info.title : '',
        playUrl: info ? String(info.playUrl).slice(0, 120) : '',
        error: fetchErr,
        ms: Date.now() - t0,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e), ms: Date.now() - t0 });
    }
  });

  // ============ 语音/妙记笔记收录 ============

  // ============ 任务派发与 AI 执行中心 ============

  // 任务表直达链接（前端「打开任务表」用；表不存在时自动创建）
  router.get('/api/tasks/table-link', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    try {
      await taskRunner.ensureTable();
      return res.json({ ok: true, url: taskRunner.getTableLink() });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 派发任务：{ title, instruction, wait? }
  // wait=true：同步执行，返回 AI 结果；wait 缺省：入表为「待处理」，由后台轮询执行
  router.post('/api/tasks/dispatch', async (req, res) => {
    if (!taskRunner) {
      return res.status(400).json({ ok: false, error: '任务派发功能未启用：需配置飞书授权、LARK_BASE_TOKEN 与 DeepSeek API Key' });
    }
    const body = req.body || {};
    const title = (body.title || '').trim();
    const instruction = (body.instruction || '').trim();
    if (!title || !instruction) {
      return res.status(400).json({ ok: false, error: 'title 与 instruction 均不能为空' });
    }
    try {
      const r = await taskRunner.dispatch(title, instruction, { wait: Boolean(body.wait) });
      clearTaskListCache();
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 手动触发一轮轮询（调试用）
  router.post('/api/tasks/run', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    try {
      const r = await taskRunner.tick();
      clearTaskListCache();
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 待拍板的 AI 选题建议列表 / 自动捕捉的任务（状态=待确认）
  // SWR 缓存：30s 内直接回；过期后旧数据秒回 + 后台刷新（写操作清缓存，下次读同步重拉）
  let taskListCache = { suggestions: null, captured: null }; // 各: { ts, data } | null
  const TASK_LIST_TTL = 30 * 1000;
  const taskRefreshing = {};
  function clearTaskListCache() { taskListCache = { suggestions: null, captured: null }; }
  function refreshTaskList(key, fetcher) {
    if (taskRefreshing[key]) return;
    taskRefreshing[key] = true;
    fetcher()
      .then((data) => { taskListCache[key] = { ts: Date.now(), data }; })
      .catch(() => {})
      .finally(() => { taskRefreshing[key] = false; });
  }
  router.get('/api/tasks/suggestions', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    const hit = taskListCache.suggestions;
    if (hit) {
      if (Date.now() - hit.ts >= TASK_LIST_TTL) refreshTaskList('suggestions', () => taskRunner.listSuggestions()); // 过期 → 旧数据秒回 + 后台刷新
      return res.json(hit.data);
    }
    try {
      const r = await taskRunner.listSuggestions();
      taskListCache.suggestions = { ts: Date.now(), data: r };
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  router.get('/api/tasks/captured', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    const hit = taskListCache.captured;
    if (hit) {
      if (Date.now() - hit.ts >= TASK_LIST_TTL) refreshTaskList('captured', () => taskRunner.listCaptured());
      return res.json(hit.data);
    }
    try {
      const r = await taskRunner.listCaptured();
      taskListCache.captured = { ts: Date.now(), data: r };
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 拍板：把某条建议派给 AI 立即执行 { recordId }
  router.post('/api/tasks/accept', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    const recordId = ((req.body && req.body.recordId) || '').trim();
    if (!recordId) return res.status(400).json({ ok: false, error: 'recordId 为空' });
    try {
      const r = await taskRunner.acceptSuggestion(recordId);
      clearTaskListCache();
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 忽略某条建议 { recordId }
  router.post('/api/tasks/dismiss', async (req, res) => {
    if (!taskRunner) return res.status(400).json({ ok: false, error: '任务派发功能未启用' });
    const recordId = ((req.body && req.body.recordId) || '').trim();
    if (!recordId) return res.status(400).json({ ok: false, error: 'recordId 为空' });
    try {
      const r = await taskRunner.dismissSuggestion(recordId);
      clearTaskListCache();
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 妙记笔记飞书表直达链接（前端「打开飞书表格」按钮用；表不存在时自动创建）
  // 表链接基本不变：SWR 缓存 5 分钟，过期旧值秒回+后台刷新
  let noteLinkCache = null; // { ts, data }
  const NOTE_LINK_TTL = 5 * 60 * 1000;
  router.get('/api/notes/table-link', async (req, res) => {
    if (!noteIntake) {
      return res.status(400).json({ ok: false, error: '笔记收录功能未启用' });
    }
    if (noteLinkCache) {
      if (Date.now() - noteLinkCache.ts >= NOTE_LINK_TTL) {
        noteIntake.getTableLink()
          .then((data) => { noteLinkCache = { ts: Date.now(), data }; })
          .catch(() => {});
      }
      return res.json(noteLinkCache.data);
    }
    try {
      const r = await noteIntake.getTableLink();
      noteLinkCache = { ts: Date.now(), data: r };
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 手动收录妙记链接：{ text }
  // 同步执行：拉文字稿 → AI 整理 → 待办入今日计划 + 正文存本地
  router.post('/api/notes/collect', async (req, res) => {
    if (!noteIntake) {
      return res.status(400).json({ ok: false, error: '笔记收录功能未启用：需配置飞书授权与 DEEPSEEK_API_KEY' });
    }
    const body = req.body || {};
    const text = body.text || '';
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: 'text 不能为空' });
    }
    try {
      const nr = await noteIntake.collect(text, { wait: true });
      if (!nr.handled) {
        return res.status(400).json({ ok: false, error: '未识别到妙记链接（形如 https://xxx.feishu.cn/minutes/obcn...）' });
      }
      captureNoteTodos(nr, '妙记');
      const expAdded = await captureNoteExperiences(nr, '妙记沉淀').catch(() => 0);
      return res.json({ ok: true, expAdded, ...nr });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 录音收录：raw body 直传音频（audio/webm 或 audio/mp4），零 multer 依赖
  // 流程：ASR 转写 → DeepSeek 整理 → 待办入今日计划 + 笔记存本地
  router.post('/api/notes/collect-audio',
    express.raw({ type: '*/*', limit: '30mb' }),
    async (req, res) => {
      if (!noteIntake) {
        return res.status(400).json({ ok: false, error: '笔记功能未启用：需配置 DEEPSEEK_API_KEY 与飞书授权' });
      }
      if (!asr || !asr.isReady()) {
        return res.status(400).json({ ok: false, error: '语音转写未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
      }
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || !buf.length) {
        return res.status(400).json({ ok: false, error: '音频内容为空：请以 raw body 直传录音文件' });
      }
      const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm';
      try {
        const transcript = await asr.transcribe(buf, 'recording.' + ext, { mimeType: mime });
        if (!transcript || !transcript.trim()) {
          return res.json({ ok: false, error: '转写结果为空：录音可能没有说话内容或时长过短' });
        }
        const nr = await noteIntake.organize(transcript, '工作台录音');
        captureNoteTodos(nr, '妙记');
        const expAddedAudio = await captureNoteExperiences(nr, '录音沉淀').catch(() => 0);
        return res.json({ ok: true, expAdded: expAddedAudio, transcript: transcript.slice(0, 800), ...nr });
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message });
      }
    });

  // 图片笔记：base64 图片 → OCR 识别文字 → 走妙记同款整理 → 待办入今日计划 + 笔记存本地/飞书
  router.post('/api/notes/collect-image', express.json({ limit: '25mb' }), async (req, res) => {
    if (!noteIntake) {
      return res.status(400).json({ ok: false, error: '笔记功能未启用：需配置 DEEPSEEK_API_KEY 与飞书授权' });
    }
    if (!vision || !vision.isReady()) {
      return res.status(400).json({ ok: false, error: '图片识别未启用：需在 .env 配置 SILICONFLOW_API_KEY' });
    }
    const image = (req.body && req.body.image) || '';
    if (!image) return res.status(400).json({ ok: false, error: '图片为空' });
    try {
      const text = await vision.recognize(image);
      if (!text || !text.trim()) {
        return res.json({ ok: false, error: '图片里没识别出文字，换张清晰的图试试？' });
      }
      const nr = await noteIntake.organize(text, '图片识别');
      captureNoteTodos(nr, '妙记');
      const expAddedImage = await captureNoteExperiences(nr, '图片沉淀').catch(() => 0);
      return res.json({ ok: true, expAdded: expAddedImage, transcript: text.slice(0, 800), ...nr });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // ============ 经验复盘中心（板块二） ============

  // 经验列表 ?cluster=&type=
  router.get('/api/experience/list', async (req, res) => {
    if (!experienceCenter) return res.status(400).json({ ok: false, error: '经验复盘功能未启用' });
    try {
      const r = await experienceCenter.listExperiences({ cluster: req.query.cluster || '', type: req.query.type || '' });
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 手动记经验 { content, type?, level?, category?, cluster?, videoTitle?, source? }
  router.post('/api/experience/add', express.json(), async (req, res) => {
    if (!experienceCenter) return res.status(400).json({ ok: false, error: '经验复盘功能未启用' });
    const b = req.body || {};
    if (!b.content || !String(b.content).trim()) return res.status(400).json({ ok: false, error: '经验内容不能为空' });
    try {
      const r = await experienceCenter.addExperience({ ...b, source: b.source || '手动记录' });
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 评价转经验：AI 预填类型/级别/分类 { text, videoTitle?, cluster? }
  router.post('/api/experience/from-review', express.json(), async (req, res) => {
    if (!experienceCenter) return res.status(400).json({ ok: false, error: '经验复盘功能未启用' });
    const b = req.body || {};
    if (!b.text || !String(b.text).trim()) return res.status(400).json({ ok: false, error: '评价内容不能为空' });
    try {
      const r = await experienceCenter.fromReview(b);
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 视频评分（1-5 星「值得模仿」） { url, score }
  router.post('/api/videos/rate', express.json(), async (req, res) => {
    if (!experienceCenter) return res.status(400).json({ ok: false, error: '视频评分功能未启用' });
    const b = req.body || {};
    if (!b.url) return res.status(400).json({ ok: false, error: '缺少视频链接' });
    try {
      const r = await experienceCenter.rateVideo(b.url, b.score);
      clearVideoRecentCache();
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // ============ AI 写作室（板块四） ============

  // 预览本次创作会召回哪些视频拆解与经验卡片
  router.get('/api/writing/materials', async (req, res) => {
    if (!writingStudio) return res.status(400).json({ ok: false, error: '写作室未启用' });
    try {
      const m = await writingStudio.previewMaterials({
        cluster: (req.query && req.query.cluster) || '',
        keyword: (req.query && req.query.keyword) || '',
      }, (req.query && req.query.brief) || '');
      return res.json({ ok: true, ...m });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 生成初稿：body { brief, cluster, keyword, format }
  router.post('/api/writing/generate', express.json(), async (req, res) => {
    if (!writingStudio) return res.status(400).json({ ok: false, error: '写作室未启用' });
    const b = req.body || {};
    if (!b.brief || !String(b.brief).trim()) {
      return res.status(400).json({ ok: false, error: '请先描述你想写什么' });
    }
    try {
      const r = await writingStudio.generate({
        brief: b.brief,
        cluster: b.cluster || '',
        keyword: b.keyword || '',
        format: b.format || '口播脚本',
      });
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // ============ 我的档案（Skill 01 认识我） ============

  // 档案概览：总数/已确认/待确认 各领域计数
  router.get('/api/profile/overview', async (req, res) => {
    if (!profileCenter) return res.status(400).json({ ok: false, error: '我的档案未启用' });
    try {
      const r = await profileCenter.listProfiles({});
      if (!r.ok) return res.status(400).json(r);
      const byStatus = {}, byDomain = {};
      for (const it of r.items) {
        byStatus[it.status] = (byStatus[it.status] || 0) + 1;
        byDomain[it.domain] = (byDomain[it.domain] || 0) + 1;
      }
      return res.json({ ok: true, total: r.total, byStatus, byDomain });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 列档案：?status=&domain=&layer=&keyword=
  router.get('/api/profile/list', async (req, res) => {
    if (!profileCenter) return res.status(400).json({ ok: false, error: '我的档案未启用' });
    try {
      const r = await profileCenter.listProfiles({
        status: req.query.status || '',
        domain: req.query.domain || '',
        layer: req.query.layer || '',
        keyword: req.query.keyword || '',
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 确认/否定/标过时：body { recordId, status, note? }
  router.post('/api/profile/set-status', express.json(), async (req, res) => {
    if (!profileCenter) return res.status(400).json({ ok: false, error: '我的档案未启用' });
    const b = req.body || {};
    if (!b.recordId || !b.status) return res.status(400).json({ ok: false, error: '缺少 recordId/status' });
    try {
      const r = await profileCenter.setStatus(b.recordId, b.status, b.note);
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 从种子文件（seed/profile-seed.json，由本地档案解析生成）幂等同步
  router.post('/api/profile/sync-seed', express.json(), async (req, res) => {
    if (!profileCenter) return res.status(400).json({ ok: false, error: '我的档案未启用' });
    try {
      const seedFile = path.join(__dirname, '..', 'seed', 'profile-seed.json');
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      const r = await profileCenter.syncSeed(seed.items || []);
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: '同步失败: ' + e.message });
    }
  });

  // ============ 知识资料库（第二大脑·外部知识层）============

  router.get('/api/knowledge/overview', async (req, res) => {
    if (!knowledgeCenter) return res.status(400).json({ ok: false, error: '知识资料库未启用' });
    try {
      return res.json(await knowledgeCenter.getOverview());
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  router.get('/api/knowledge/list', async (req, res) => {
    if (!knowledgeCenter) return res.status(400).json({ ok: false, error: '知识资料库未启用' });
    try {
      const r = await knowledgeCenter.listKnowledge({
        domain: req.query.domain || '',
        keyword: req.query.keyword || '',
        max: req.query.max ? Number(req.query.max) : 0,
      });
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 删除知识资料（书库删书等；飞书表记录物理删除）
  router.post('/api/knowledge/delete', express.json(), async (req, res) => {
    if (!knowledgeCenter) return res.status(400).json({ ok: false, error: '知识资料库未启用' });
    const b = req.body || {};
    try { return res.json(await knowledgeCenter.deleteKnowledge(b.recordId)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 从 seed/knowledge-seed.json（57 篇得到大脑 AI 分析解析生成）幂等同步
  router.post('/api/knowledge/sync-seed', express.json(), async (req, res) => {
    if (!knowledgeCenter) return res.status(400).json({ ok: false, error: '知识资料库未启用' });
    try {
      const seedFile = path.join(__dirname, '..', 'seed', 'knowledge-seed.json');
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      return res.json(await knowledgeCenter.syncSeed(seed.items || []));
    } catch (e) {
      return res.status(502).json({ ok: false, error: '同步失败: ' + e.message });
    }
  });

  // ============ 决策卡（Skill 05） ============

  // 只做尽调分析，不落表
  router.post('/api/decisions/analyze', express.json(), async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    try { return res.json(await decisionCenter.analyze((req.body || {}).question)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 尽调并建卡（状态固定 🟡待我拍板）
  router.post('/api/decisions/create', express.json(), async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    try { return res.json(await decisionCenter.createFromQuestion((req.body || {}).question)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  router.get('/api/decisions/list', async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    try { return res.json(await decisionCenter.listDecisions({ status: (req.query && req.query.status) || '' })); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 用户拍板：只有此接口能改成 做/不做/暂缓
  router.post('/api/decisions/decide', express.json(), async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    const b = req.body || {};
    try { return res.json(await decisionCenter.decide(b.recordId, b)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 决策复盘回填
  router.post('/api/decisions/review', express.json(), async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    const b = req.body || {};
    try { return res.json(await decisionCenter.review(b.recordId, b.conclusion)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 删除决策卡（飞书表记录物理删除，不可恢复）
  router.post('/api/decisions/delete', express.json(), async (req, res) => {
    if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
    const b = req.body || {};
    try { return res.json(await decisionCenter.deleteDecision(b.recordId)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // ============ 项目卡（Skill 06） ============

  router.post('/api/projects/create', express.json(), async (req, res) => {
    if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
    try { return res.json(await projectCenter.createProject(req.body || {})); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  router.get('/api/projects/list', async (req, res) => {
    if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
    try {
      return res.json(await projectCenter.listProjects({
        status: (req.query && req.query.status) || '',
        keyword: (req.query && req.query.keyword) || '',
      }));
    } catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 用户手动改状态/周期
  router.post('/api/projects/status', express.json(), async (req, res) => {
    if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
    const b = req.body || {};
    try { return res.json(await projectCenter.setStatus(b.recordId, b)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 记录进展；advise=true 同时给 AI 推进判断（只更新 AI 字段/下一步，不改状态）
  router.post('/api/projects/progress', express.json(), async (req, res) => {
    if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
    const b = req.body || {};
    try { return res.json(await projectCenter.addProgress(b.recordId, b.note, b.advise === true)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 只做阶段体检，不写表
  router.post('/api/projects/advise', express.json(), async (req, res) => {
    if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
    const b = req.body || {};
    try { return res.json(await projectCenter.adviseProject(b.recordId)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // ============ 会议中心（会前简报 + 会后回流确认） ============

  // 生成会前简报 {topic?}；topic 为空时自动取未来48h最近日程
  router.post('/api/meetings/brief', express.json(), async (req, res) => {
    if (!meetingCenter) return res.status(400).json({ ok: false, error: '会议中心未启用' });
    const b = req.body || {};
    try { return res.json(await meetingCenter.brief({ topic: b.topic || '' })); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  });

  // 用户确认会后回流：
  //  action='decision'：把 flow.decisions[index] 直接建成 ✅决定做 决策卡（用户二次确认=本人拍板）
  //  action='progress'：把本次会议决定作为进展追加到项目卡（不改项目状态、不触发AI体检）
  router.post('/api/meetings/apply-flow', express.json(), async (req, res) => {
    if (!meetingCenter) return res.status(400).json({ ok: false, error: '会议中心未启用' });
    const b = req.body || {};
    const flow = getFlow(String(b.flowId || ''));
    if (!flow) return res.status(404).json({ ok: false, error: '回流候选已过期或不存在（有效期 1 小时），请重新收录妙记' });

    try {
      if (b.action === 'decision') {
        if (!decisionCenter) return res.status(400).json({ ok: false, error: '决策卡未启用' });
        const idx = Number(b.index || 0);
        const d = flow.decisions[idx];
        if (!d) return res.status(400).json({ ok: false, error: '该决定候选不存在' });
        const r = await decisionCenter.createConfirmedDecision({
          question: d.decision,
          decision: d.decision,
          basis: d.basis,
          source: `会议妙记《${flow.noteTitle}》${flow.meetingType ? '（' + flow.meetingType + '）' : ''}`,
        });
        return res.json(r);
      }
      if (b.action === 'progress') {
        if (!projectCenter) return res.status(400).json({ ok: false, error: '项目卡未启用' });
        const recordId = String(b.projectRecordId || '');
        const proj = flow.projects.find((p) => p.recordId === recordId);
        if (!proj) return res.status(400).json({ ok: false, error: '请选择正确的关联项目' });
        const decLines = flow.decisions.map((d) => `✅ ${d.decision}`).join('；');
        const note = `会议《${flow.noteTitle}》进展同步${decLines ? '：' + decLines : ''}`.slice(0, 600);
        const r = await projectCenter.addProgress(recordId, note, false);
        return res.json({ ok: true, ...r, projectName: proj.name });
      }
      return res.status(400).json({ ok: false, error: '未知 action（decision | progress）' });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // ============ 飞书集成 ============

  // 飞书配置/授权状态
  router.get('/api/lark/status', (req, res) => {
    if (!larkClient) {
      return res.json({
        ok: true,
        status: { configured: false, authorized: false, lastSyncAt: '' },
      });
    }
    try {
      return res.json({ ok: true, status: larkClient.getStatus() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 跳转飞书授权页
  router.get('/api/lark/authorize', (req, res) => {
    if (!larkClient) {
      return res.status(400).json({ ok: false, error: '飞书未配置：请先在 .env 设置 LARK_APP_ID/LARK_APP_SECRET/LARK_REDIRECT_BASE' });
    }
    try {
      const url = larkClient.buildAuthorizeUrl();
      return res.redirect(302, url);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // OAuth 回调：用 code 换 user_access_token
  router.get('/api/lark/oauth/callback', async (req, res) => {
    if (!larkClient) {
      return res.status(400).send(renderCallbackHtml(false, '飞书未配置'));
    }
    const code = req.query.code;
    const state = req.query.state;
    if (req.query.error || !code) {
      return res.status(400).send(renderCallbackHtml(false, '授权被拒绝或未返回 code'));
    }
    if (!larkClient.validateState(state)) {
      return res.status(400).send(renderCallbackHtml(false, 'state 已过期，请回工作台重新点击授权'));
    }
    try {
      await larkClient.exchangeCode(code);
      return res.send(renderCallbackHtml(true, '飞书授权成功，可以关闭本页回到工作台'));
    } catch (e) {
      return res.status(502).send(renderCallbackHtml(false, '授权失败：' + e.message));
    }
  });

  // 手动立即同步
  router.post('/api/lark/sync', async (req, res) => {
    if (!larkClient) {
      return res.status(400).json({ ok: false, error: '飞书未配置' });
    }
    try {
      const result = await larkSync.syncAll({
        client: larkClient,
        dataRoot,
        stateFile: lark.stateFile,
      });
      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, missingScopes: e.missingScopes || null });
    }
  });

  // 手动立即推送今日摘要
  router.post('/api/lark/notify', async (req, res) => {
    if (!larkClient) {
      return res.status(400).json({ ok: false, error: '飞书未配置' });
    }
    try {
      const result = await larkSync.pushDigest({ client: larkClient, dataRoot });
      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, missingScopes: e.missingScopes || null });
    }
  });

  /* ---- 日程管理 API ---- */
  // 查询日程（按年月，或按日期范围）
  router.get('/api/schedules', async (req, res) => {
    if (!scheduleCenter) return res.status(400).json({ ok: false, error: '日程管理未启用' });
    const { start, end } = req.query;
    try {
      const items = await scheduleCenter.listSchedules({ startDate: start, endDate: end });
      return res.json({ ok: true, items, count: items.length });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 添加日程（手动或解析后调用）
  router.post('/api/schedules', express.json(), async (req, res) => {
    if (!scheduleCenter) return res.status(400).json({ ok: false, error: '日程管理未启用' });
    try {
      const r = await scheduleCenter.addSchedule(req.body);
      return res.json({ ok: true, recordId: r.recordId });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 从文本解析日程（聊天命令用）
  router.post('/api/schedules/parse', express.json(), async (req, res) => {
    if (!scheduleCenter) return res.status(400).json({ ok: false, error: '日程管理未启用' });
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: '缺少 text 参数' });
    try {
      const parsed = await scheduleCenter.parseScheduleFromText(text);
      return res.json({ ok: !!parsed, parsed });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 从截图识别日程并写入（校历/日程截图；vision 提取多条，日期+时间+事项相同自动跳过）
  router.post('/api/schedules/image', express.json({ limit: '8mb' }), async (req, res) => {
    if (!scheduleCenter) return res.status(400).json({ ok: false, error: '日程管理未启用' });
    const image = String((req.body && req.body.image) || '');
    if (!image) return res.status(400).json({ ok: false, error: '缺少 image 参数' });
    try {
      const entries = await scheduleCenter.parseScheduleFromImage(image.replace(/^data:image\/\w+;base64,/, ''));
      if (!entries || !entries.length) return res.json({ ok: false, error: '图里没识别出日程信息' });
      const r = await scheduleCenter.addSchedules(entries, '📸截图');
      return res.json({ ok: true, count: entries.length, added: r.added, skipped: r.skipped, parsed: entries[0] });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- 记账（课时收入/日常收支）----
  // 汇总：收支合计 + 分项目净额
  router.get('/api/ledger/summary', async (req, res) => {
    if (!ledgerCenter) return res.status(400).json({ ok: false, error: '记账未启用（需飞书授权 + LARK_BASE_TOKEN）' });
    try { return res.json(await ledgerCenter.summary()); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 账目列表
  router.get('/api/ledger/list', async (req, res) => {
    if (!ledgerCenter) return res.status(400).json({ ok: false, error: '记账未启用' });
    try {
      const items = await ledgerCenter.listRecords();
      return res.json({ ok: true, items, count: items.length });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 手动补录一条账目（人数+单价自动算金额，或直接给金额）
  router.post('/api/ledger/add', express.json(), async (req, res) => {
    if (!ledgerCenter) return res.status(400).json({ ok: false, error: '记账未启用' });
    try { return res.json(await ledgerCenter.addRecord(req.body || {})); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 删除一条账目（改账=删错的+加对的）
  router.delete('/api/ledger/:recordId', async (req, res) => {
    if (!ledgerCenter) return res.status(400).json({ ok: false, error: '记账未启用' });
    const id = req.params.recordId;
    if (!id) return res.status(400).json({ ok: false, error: '缺少 recordId' });
    try { return res.json(await ledgerCenter.deleteRecord(id)); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 文本解析课时账（预览候选，不落库）
  router.post('/api/ledger/parse', express.json(), async (req, res) => {
    if (!ledgerCenter) return res.status(400).json({ ok: false, error: '记账未启用' });
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: '缺少 text 参数' });
    try { return res.json({ ok: true, items: await ledgerCenter.parseLedgerFromText(text) }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
}

function renderCallbackHtml(ok, message) {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书授权</title></head>
<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;background:#f8fafc">
<div style="text-align:center;padding:32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px">
<div style="font-size:40px">${ok ? '✅' : '❌'}</div>
<p style="color:${color};font-size:16px;margin:16px 0 8px">${message}</p>
${ok ? '<p style="color:#64748b;font-size:13px">2 秒后自动关闭…<script>setTimeout(()=>window.close(),2000)</script></p>' : ''}
</div></body></html>`;
}

module.exports = { createRouter };
