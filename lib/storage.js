'use strict';

const fs = require('fs');
const path = require('path');

const TYPE_DIRS = {
  '决策记录': '07_行为与决策/01_决策记录',
  '项目进展': '07_行为与决策/02_项目进展',
  '日常思考': '07_行为与决策/03_日常思考',
  '语音笔记': '07_行为与决策/04_语音笔记',
};

const PROFILE_UPDATE_DIR = '04_个人知识/画像更新';
const CONTEXT_SCAN_DIR = '07_行为与决策';
// 优先读取的关键文件（最新状态、认知模型）
const PRIORITY_FILES = [
  '04_个人知识/01_已确认事实.md',
  '04_个人知识/方法论/毛泽东方法论卡片索引.md',
  '04_个人知识/方法论/史记资治通鉴抉择卡片索引.md',
  '04_个人知识/方法论/毛泽东抉择卡片索引.md',
  '04_个人知识/方法论/毛泽东哲学方法论卡片索引.md',
];
const PRIORITY_DIRS = [
  '04_个人知识/认知模型版本',
  '04_个人知识/画像更新',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowParts() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    hhmm: `${pad2(d.getHours())}${pad2(d.getMinutes())}`,
  };
}

function sanitizeSegment(s) {
  if (!s) return 'untitled';
  let out = String(s).trim();
  // 防路径穿越：彻底移除分隔符和上级引用
  out = out.replace(/\.\./g, '');
  out = out.replace(/[\/\\]/g, '');
  // 移除文件系统非法字符
  out = out.replace(/[<>:"|?*\x00-\x1f]/g, '');
  out = out.replace(/\s+/g, '_');
  if (!out) out = 'untitled';
  // 限长
  return out.slice(0, 50);
}

function ensureWithinRoot(rootAbs, targetAbs) {
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

function buildFileName(type, title, parts) {
  const safeTitle = sanitizeSegment(title);
  switch (type) {
    case '决策记录':
      return `${parts.date}_${safeTitle}.md`;
    case '项目进展':
      return `${parts.date}_${safeTitle}.md`;
    case '日常思考':
      return `${parts.date}_${parts.hhmm}.md`;
    default:
      return `${parts.date}_${parts.hhmm}.md`;
  }
}

function buildDirName(type) {
  return TYPE_DIRS[type] || TYPE_DIRS['日常思考'];
}

function saveRecord(dataRoot, type, title, userText, aiAnalysis) {
  const rootAbs = path.resolve(dataRoot);
  const dirName = buildDirName(type);
  const parts = nowParts();
  const fileName = buildFileName(type, title, parts);
  const targetDir = path.join(rootAbs, dirName);
  const targetPath = path.join(targetDir, fileName);

  if (!ensureWithinRoot(rootAbs, targetPath)) {
    throw new Error('非法路径');
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const content = `# [${type}]
## 时间
${parts.date} ${parts.time}
## 内容
${userText}
## AI判断
${aiAnalysis}
## 状态
CURRENT
`;

  fs.writeFileSync(targetPath, content, 'utf8');
  return { path: targetPath, dir: dirName, file: fileName };
}

function scanAllMarkdown(dataRoot, subdir) {
  const rootAbs = path.resolve(dataRoot);
  const start = subdir ? path.join(rootAbs, subdir) : rootAbs;
  // 防路径穿越：subdir 内不允许 ..
  if (subdir && subdir.includes('..')) return [];
  if (!fs.existsSync(start)) return [];
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (!ensureWithinRoot(rootAbs, full)) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }
  walk(start);
  files.sort();
  return files;
}

function readContext(dataRoot, maxChars) {
  const rootAbs = path.resolve(dataRoot);
  const limit = maxChars || 80000;
  const parts = [];
  let total = 0;

  function addFile(f) {
    try {
      const stat = fs.statSync(f);
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(rootAbs, f);
      const header = `\n---\n# 来源: ${rel}\n# 修改时间: ${stat.mtime.toISOString()}\n`;
      const piece = header + text + '\n';
      if (total + piece.length > limit) return false;
      parts.push(piece);
      total += piece.length;
      return true;
    } catch (e) {
      return true;
    }
  }

  // 1. 优先读关键文件
  for (const rel of PRIORITY_FILES) {
    const f = path.join(rootAbs, rel);
    if (fs.existsSync(f)) addFile(f);
  }

  // 2. 优先目录里的最新文件（认知模型）
  for (const dir of PRIORITY_DIRS) {
    const dirAbs = path.join(rootAbs, dir);
    if (!fs.existsSync(dirAbs)) continue;
    try {
      const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => {
          const full = path.join(dirAbs, e.name);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const item of files) {
        if (!addFile(item.full)) break;
      }
    } catch (e) {}
  }

  // 3. 行为与决策目录：按修改时间倒序（最新的在前）
  const allFiles = scanAllMarkdown(dataRoot, CONTEXT_SCAN_DIR);
  const withTime = allFiles.map((f) => {
    try {
      return { full: f, mtime: fs.statSync(f).mtimeMs };
    } catch (e) {
      return { full: f, mtime: 0 };
    }
  });
  withTime.sort((a, b) => b.mtime - a.mtime);

  for (const item of withTime) {
    if (!addFile(item.full)) break;
  }

  return parts.join('');
}

// ============ 画像更新 ============

function monthFromTs(ts) {
  // ts 形如 YYYYMMDDHHMMSS，返回 YYYY-MM
  return ts.slice(0, 4) + '-' + ts.slice(4, 6);
}

function profileUpdateMonthFile(dataRoot, ts) {
  const rootAbs = path.resolve(dataRoot);
  const month = monthFromTs(ts);
  const dir = path.join(rootAbs, PROFILE_UPDATE_DIR);
  const file = path.join(dir, `${month}.md`);
  if (!ensureWithinRoot(rootAbs, file)) {
    throw new Error('非法路径');
  }
  return { rootAbs, dir, file };
}

function appendProfileUpdate(dataRoot, ts, displayTime, recordPath, items) {
  const { dir, file } = profileUpdateMonthFile(dataRoot, ts);
  fs.mkdirSync(dir, { recursive: true });

  let body = '';
  for (const it of items) {
    body += `\n## ${displayTime}\n\n`;
    body += `**原记录**：${recordPath}\n`;
    body += `**提取内容**：${it.content || ''}\n`;
    body += `**类型**：${it.type || 'MY_STATEMENT'}\n`;
    body += `**置信度**：${it.confidence || 'MEDIUM'}\n`;
    body += `**ID**：${ts}\n`;
    body += `\n---\n`;
  }

  let prev = '';
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch (e) {
    prev = '';
  }
  const header = prev ? '' : `# 画像更新 ${monthFromTs(ts)}\n`;
  fs.writeFileSync(file, header + prev + body, 'utf8');
  return { file, ts };
}

// 解析画像更新条目：以 "## YYYY-MM-DD HH:MM:SS" 开头到 "---" 结束（含）
function parseProfileEntries(text) {
  const entries = [];
  const lines = text.split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*$/);
    if (m) {
      if (cur) entries.push(cur);
      cur = { time: m[1], raw: [line], id: '' };
    } else if (cur) {
      cur.raw.push(line);
      // 匹配半角或全角冒号
      const idm = line.match(/\*\*ID\*\*[::：]\s*([0-9]+)/);
      if (idm) cur.id = idm[1];
      if (line.trim() === '---') {
        entries.push(cur);
        cur = null;
      }
    }
  }
  if (cur) entries.push(cur);
  return entries.map((e) => ({
    id: e.id,
    time: e.time,
    text: e.raw.join('\n'),
  }));
}

function readProfileUpdates(dataRoot) {
  const rootAbs = path.resolve(dataRoot);
  const dir = path.join(rootAbs, PROFILE_UPDATE_DIR);
  if (!fs.existsSync(dir)) return [];
  const files = scanAllMarkdown(dataRoot, PROFILE_UPDATE_DIR);
  const all = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    const entries = parseProfileEntries(text);
    for (const e of entries) {
      all.push({
        id: e.id,
        time: e.time,
        text: e.text,
        file: path.relative(rootAbs, f),
      });
    }
  }
  // 倒序：新在前
  all.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return all;
}

function deleteProfileEntry(dataRoot, id) {
  if (!/^\d{14}$/.test(id)) {
    throw new Error('非法 ID');
  }
  const rootAbs = path.resolve(dataRoot);
  const month = monthFromTs(id);
  const file = path.join(
    rootAbs,
    PROFILE_UPDATE_DIR,
    `${month}.md`
  );
  if (!ensureWithinRoot(rootAbs, file)) {
    throw new Error('非法路径');
  }
  if (!fs.existsSync(file)) {
    return { ok: false, reason: '文件不存在' };
  }
  const text = fs.readFileSync(file, 'utf8');
  const entries = parseProfileEntries(text);
  const before = entries.length;
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === before) {
    return { ok: false, reason: '未找到条目' };
  }
  // 重建文件：保留文件头部 + 保留条目
  const headerMatch = text.match(/^# 画像更新[^\n]*\n/);
  let header = headerMatch ? headerMatch[0] : `# 画像更新 ${monthFromTs(id)}\n`;
  let body = '';
  for (const e of kept) {
    body += e.text + '\n';
  }
  const out = header + body;
  fs.writeFileSync(file, out, 'utf8');
  return { ok: true, removed: before - kept.length };
}

module.exports = {
  saveRecord,
  scanAllMarkdown,
  readContext,
  buildDirName,
  buildFileName,
  sanitizeSegment,
  ensureWithinRoot,
  appendProfileUpdate,
  readProfileUpdates,
  deleteProfileEntry,
  parseProfileEntries,
  CONTEXT_SCAN_DIR,
  PROFILE_UPDATE_DIR,
};
