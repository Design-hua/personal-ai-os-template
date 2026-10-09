// lib/lark-sync.js
// 飞书数据 → 今日计划.json 的同步编排、过期清理、摘要推送、定时调度。
//
// 同步原则（避免双写冲突）：
// - 飞书侧（日程/任务/妙记）条目带 source + sourceId，按唯一键 upsert，重复同步不重复添加；
// - 日程已结束 → 本地置 done；任务以飞书"未完成列表"为权威，不在列表中 → 本地置 done；
// - 妙记 AI 待办接口不返回完成状态/id，因此只新增/更新文本，保留本地 done，不做完成对齐；
// - source=local 的手动条目永不被同步逻辑修改或删除；
// - 私人数据（记账/心情/习惯等）不参与同步，摘要只含日程与待办。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TODO_FILE = '07_行为与决策/今日计划.json';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 显式按 UTC+8 取墙上时间，不依赖容器/主机时区配置
function parts8(d) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return {
    y: x.getUTCFullYear(),
    m: x.getUTCMonth() + 1,
    day: x.getUTCDate(),
    h: x.getUTCHours(),
    min: x.getUTCMinutes(),
    s: x.getUTCSeconds(),
    wd: x.getUTCDay(),
  };
}

function display8(d) {
  const p = parts8(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.min)}:${pad2(p.s)}`;
}

function dateKey8(d) {
  const p = parts8(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)}`;
}

function hhmmFromSec(sec) {
  const p = parts8(new Date(sec * 1000));
  return `${pad2(p.h)}:${pad2(p.min)}`;
}

// source+sourceId → 稳定正整数 id（48bit，JS 安全整数范围内）
function stableId(source, sourceId) {
  const hex = crypto
    .createHash('md5')
    .update(source + '|' + sourceId)
    .digest('hex')
    .slice(0, 12);
  return parseInt(hex, 16);
}

function readTodos(dataRoot) {
  try {
    const arr = JSON.parse(
      fs.readFileSync(path.join(dataRoot, TODO_FILE), 'utf8')
    );
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

// 当天 [00:00, 次日00:00) 的秒级时间戳
function todayRangeSec() {
  const p = parts8(new Date());
  const startUtc = Date.UTC(p.y, p.m - 1, p.day) - 8 * 3600 * 1000;
  return { startSec: Math.floor(startUtc / 1000), endSec: Math.floor(startUtc / 1000) + 86400 };
}

// 近 n 天（含今天）的毫秒范围
function recentDaysMs(n) {
  const { startSec } = todayRangeSec();
  const startMs = startSec * 1000 - (n - 1) * 86400 * 1000;
  return { startMs, endMs: (startSec + 86400) * 1000 - 1 };
}

function taskPriority(dueMs) {
  if (!dueMs) return 'P1';
  const { endSec } = todayRangeSec();
  const weekLater = (endSec + 6 * 86400) * 1000;
  if (dueMs <= endSec * 1000) return 'P0'; // 已逾期或今天到期
  if (dueMs <= weekLater) return 'P1';
  return 'P2';
}

/**
 * 执行一次全量同步
 * @returns {object} 各类新增/更新/完成/删除统计
 */
async function syncAll({ client, dataRoot, stateFile }) {
  const now = new Date();
  const nowDisplay = display8(now);
  const todayKey = dateKey8(now);
  const { startSec, endSec } = todayRangeSec();

  const todos = readTodos(dataRoot);

  // 飞书条目索引：source + '|' + sourceId -> 条目
  const index = new Map();
  for (const t of todos) {
    if (t && t.source && t.sourceId) {
      index.set(t.source + '|' + t.sourceId, t);
    }
  }

  const stats = {
    events: { added: 0, updated: 0, completed: 0 },
    tasks: { added: 0, updated: 0, completed: 0 },
    minutes: { added: 0, updated: 0, failed: 0 },
    removed: 0,
  };

  function upsert({ source, sourceId, text, priority, done, eventTime, eventDate, keepLocalDone }) {
    const key = source + '|' + sourceId;
    const exist = index.get(key);
    if (exist) {
      let changed = false;
      if (exist.text !== text) { exist.text = text; changed = true; }
      if (priority && exist.priority !== priority) { exist.priority = priority; changed = true; }
      if (eventTime !== undefined && exist.eventTime !== eventTime) {
        exist.eventTime = eventTime; changed = true;
      }
      if (eventDate !== undefined && exist.eventDate !== eventDate) {
        exist.eventDate = eventDate; changed = true;
      }
      // 妙记待办：完成状态以本地为准（接口不提供状态）
      const nextDone = keepLocalDone ? Boolean(exist.done) : Boolean(done);
      if (Boolean(exist.done) !== nextDone) {
        exist.done = nextDone;
        changed = true;
        if (nextDone) stats[source === 'lark_calendar' ? 'events' : 'tasks'].completed++;
      }
      if (changed) exist.updatedAt = nowDisplay;
      return changed ? 'updated' : 'unchanged';
    }
    const item = {
      id: stableId(source, sourceId),
      text,
      priority: priority || 'P1',
      done: Boolean(done),
      createdAt: nowDisplay,
      source,
      sourceId,
    };
    if (eventTime !== undefined) item.eventTime = eventTime;
    if (eventDate !== undefined) item.eventDate = eventDate;
    todos.push(item);
    index.set(key, item);
    return 'added';
  }

  // 1) 今日日程 ----------------------------------------------------------
  const events = await client.getEvents(startSec, endSec - 1);
  const eventIds = new Set();
  for (const ev of events) {
    eventIds.add(ev.eventId);
    const hm = hhmmFromSec(ev.startSec);
    const allDay = hm === '00:00' && ev.endSec - ev.startSec >= 20 * 3600;
    const text = (allDay ? '' : hm + ' ') + ev.summary;
    const done = ev.endSec ? ev.endSec * 1000 < Date.now() : false;
    const r = upsert({
      source: 'lark_calendar',
      sourceId: ev.eventId,
      text,
      priority: 'P1',
      done,
      eventTime: allDay ? '全天' : hm,
      eventDate: todayKey,
    });
    if (r === 'added') stats.events.added++;
    else if (r === 'updated') stats.events.updated++;
  }

  // 2) 我负责的未完成任务 -------------------------------------------------
  const tasks = await client.getMyOpenTasks();
  const taskGuids = new Set(tasks.map((t) => t.guid));
  for (const t of tasks) {
    taskGuids.add(t.guid);
    const r = upsert({
      source: 'lark_task',
      sourceId: t.guid,
      text: t.summary,
      priority: taskPriority(t.dueMs),
      done: false,
    });
    if (r === 'added') stats.tasks.added++;
    else if (r === 'updated') stats.tasks.updated++;
  }
  // 本地已有、但不在飞书未完成列表中的任务 → 飞书侧已完成/删除
  for (const t of todos) {
    if (t.source === 'lark_task' && !taskGuids.has(t.sourceId) && !t.done) {
      t.done = true;
      t.updatedAt = nowDisplay;
      stats.tasks.completed++;
    }
  }

  // 3) 近 2 天妙记 AI 待办（失败不影响主链路） -----------------------------
  try {
    const { startMs, endMs } = recentDaysMs(2);
    const minutes = await client.searchMyMinutes(startMs, endMs);
    for (const m of minutes) {
      let todoList;
      try {
        todoList = await client.getMinuteTodos(m.token);
      } catch (e) {
        stats.minutes.failed++;
        continue;
      }
      for (const td of todoList) {
        const sourceId = `${m.token}:${crypto.createHash('md5').update(td.content).digest('hex').slice(0, 12)}`;
        const who = td.assignees.length ? ' @' + td.assignees.join(' @') : '';
        const r = upsert({
          source: 'lark_minutes',
          sourceId,
          text: td.content + who,
          priority: 'P1',
          done: false,
          keepLocalDone: true,
        });
        if (r === 'added') stats.minutes.added++;
        else if (r === 'updated') stats.minutes.updated++;
      }
    }
  } catch (e) {
    stats.minutes.failed++;
    stats.minutes.error = e.message;
  }

  // 4) 清理 ---------------------------------------------------------------
  const kept = [];
  for (const t of todos) {
    if (!t.source) { kept.push(t); continue; } // 旧数据/本地条目
    // 跨天日程直接清除（每天会按当天日程重建）
    if (t.source === 'lark_calendar' && t.eventDate && t.eventDate < todayKey) {
      stats.removed++;
      continue;
    }
    // 非本地条目完成超过 7 天清除
    if (t.done) {
      const ref = (t.updatedAt || t.createdAt || '').replace(' ', 'T');
      const doneAt = ref ? new Date(ref + '+08:00').getTime() : 0;
      if (doneAt && Date.now() - doneAt > 7 * 86400 * 1000) {
        stats.removed++;
        continue;
      }
    }
    kept.push(t);
  }

  writeTodos(dataRoot, kept);

  const result = { syncedAt: nowDisplay, todayKey, stats };
  saveState(stateFile, {
    lastSyncAt: nowDisplay,
    lastSyncResult: result,
  });
  return result;
}

function saveState(stateFile, patch) {
  if (!stateFile) return;
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {}
  fs.writeFileSync(
    stateFile,
    JSON.stringify(Object.assign({}, cur, patch), null, 2),
    'utf8'
  );
}

/**
 * 生成并推送每日摘要（仅日程 + 待办，不含私人模块数据）
 */
async function pushDigest({ client, dataRoot }) {
  const status = client.getStatus();
  if (!status.openId) throw new Error('缺少 open_id，无法推送');

  const todos = readTodos(dataRoot);
  const { startSec } = todayRangeSec();
  const todayKey = dateKey8(new Date());

  const dayEvents = todos
    .filter((t) => t.source === 'lark_calendar' && t.eventDate === todayKey)
    .sort((a, b) => (a.eventTime || '').localeCompare(b.eventTime || ''));

  const open = todos.filter((t) => !t.done);
  const p0 = open.filter((t) => t.priority === 'P0');
  const p1 = open.filter((t) => t.priority === 'P1');
  const p2 = open.filter((t) => t.priority === 'P2');

  const lines = [];
  lines.push(`📅 个人工作台日报 ${todayKey}`);
  lines.push('');
  lines.push(`【今日日程】${dayEvents.length} 条`);
  for (const e of dayEvents.slice(0, 15)) {
    lines.push(`${e.eventTime === '全天' ? '全天' : (e.eventTime || '')} ${e.text.replace(/^\d{2}:\d{2}\s/, '')}`);
  }
  if (dayEvents.length === 0) lines.push('（无）');
  lines.push('');
  lines.push(`【待办】未完成 ${open.length} 条（P0 ${p0.length} · P1 ${p1.length} · P2 ${p2.length}）`);
  const ordered = p0.concat(p1).concat(p2);
  for (const t of ordered.slice(0, 15)) {
    const tag = t.source === 'lark_task' ? '✅' : t.source === 'lark_minutes' ? '🎙' : t.source === 'lark_calendar' ? '📅' : '•';
    lines.push(`${tag} [${t.priority}] ${t.text}`);
  }
  if (ordered.length > 15) lines.push(`……等 ${ordered.length} 条`);
  if (ordered.length === 0) lines.push('（无）');

  await client.sendTextAsBot(status.openId, lines.join('\n'));
  return { sentAt: display8(new Date()), lines: lines.length };
}

/**
 * 每日定时调度（按 UTC+8 的 HH:mm 触发），setTimeout 链
 */
function startScheduler({ client, dataRoot, stateFile, time, notifyEnabled }) {
  const hm = /^(\d{2}):(\d{2})$/.exec(time || '08:00') ? time : '08:00';
  let stopped = false;
  let timer = null;

  function scheduleNext() {
    if (stopped) return;
    const [hh, mm] = hm.split(':').map(Number);
    const now = new Date();
    const p = parts8(now);
    let targetUtcMs =
      Date.UTC(p.y, p.m - 1, p.day, hh - 8, mm, 0);
    if (targetUtcMs <= now.getTime()) targetUtcMs += 86400 * 1000;
    const delay = targetUtcMs - now.getTime();
    timer = setTimeout(run, delay);
  }

  async function run() {
    try {
      const r = await syncAll({ client, dataRoot, stateFile });
      console.log('[lark] 定时同步完成:', JSON.stringify(r.stats));
      if (notifyEnabled !== false) {
        const p = await pushDigest({ client, dataRoot });
        console.log('[lark] 日报已推送:', p.sentAt);
      }
    } catch (e) {
      console.error('[lark] 定时任务失败:', e.message);
    } finally {
      scheduleNext();
    }
  }

  scheduleNext();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = {
  syncAll,
  pushDigest,
  startScheduler,
  // 导出供测试
  _internal: { stableId, todayRangeSec, taskPriority, dateKey8, readTodos },
};
