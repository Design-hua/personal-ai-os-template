'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const compression = require('compression');

// 启动标记：每次 node 进程启动写一行（容器侧排查请求被 nodemon 重启掐断时用于取证）
try {
  fs.appendFileSync(
    path.join(__dirname, 'skills', 'video-summarizer', 'server-boot.log'),
    `${new Date().toISOString()} node 启动 pid=${process.pid}\n`
  );
} catch (e) { /* ignore */ }

const express = require('express');
const { createRouter } = require('./lib/router');
const deepseek = require('./lib/deepseek');
const { createLarkClient } = require('./lib/lark');
const larkSync = require('./lib/lark-sync');
const { createVideoIntake } = require('./lib/video-intake');
const { createNoteIntake } = require('./lib/note-intake');
const { createTaskRunner } = require('./lib/task-runner');

const PORT = process.env.PORT || 3000;
const DATA_ROOT = process.env.DATA_ROOT || './data';
const RAW_KEY = process.env.DEEPSEEK_API_KEY;
const API_KEY = deepseek.trimKey(RAW_KEY);

if (deepseek.isPlaceholderKey(API_KEY)) {
  console.warn('====================================================');
  console.warn('警告: DEEPSEEK_API_KEY 未配置或仍是占位符。');
  console.warn('请复制 .env.example 为 .env 并填入真实 Key。');
  console.warn('服务会继续启动，但 AI 相关接口会返回错误。');
  console.warn('====================================================');
} else {
  console.log('DEEPSEEK_API_KEY 已加载 (长度 ' + API_KEY.length + ')');
}

const dataRootAbs = path.resolve(DATA_ROOT);
try {
  fs.mkdirSync(dataRootAbs, { recursive: true });
  console.log('DATA_ROOT:', dataRootAbs);
} catch (e) {
  console.warn('DATA_ROOT 创建失败:', e.message);
}

const app = express();
app.use(compression()); // gzip：219KB 页面压到 ~59KB，WiFi 慢时首屏快数倍
app.use(express.json({ limit: '20mb' }));

// 请求日志（含来源 IP + 全量）：定位手机端打开慢的环节——
// 能看清手机请求是否到达、页面传输多久、各接口耗时（诊断期全量记录）
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '').replace('::1', '127.0.0.1');
    console.log(`[req] ${ip} ${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

// CORS — 允许 file:// 打开的 workbench 跨域调用 API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 静态文件
// HTML 与 sw.js 用 ETag 协商缓存（no-cache 但允许本地存副本）：
// 文件没变 → 304 毫秒级，手机秒开（之前 no-store 导致每次全量重下 219KB 页面）
// 文件变了 → ETag 变化正常下发新版，不会出现"看不到新按钮"
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath) || /[\\/]sw\.js$/i.test(filePath)) {
      res.set('Cache-Control', 'no-cache');
    } else if (/[\\/]assets[\\/]/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=86400'); // 图片等资源内容稳定，缓存1天
    }
  },
}));

// 同时服务 workbench/ 目录（可选同源访问方式）
app.use('/workbench', express.static(path.join(__dirname, 'workbench')));

// 显式设置 PWA 相关文件的 Content-Type（部分浏览器有严格要求）
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// 飞书集成（配置了 LARK_APP_ID 才启用）
let larkBundle = null;
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_REDIRECT_BASE = process.env.LARK_REDIRECT_BASE || '';
if (LARK_APP_ID && LARK_APP_SECRET && LARK_REDIRECT_BASE) {
  const client = createLarkClient({
    appId: LARK_APP_ID,
    appSecret: LARK_APP_SECRET,
    redirectBase: LARK_REDIRECT_BASE,
    tokenFile: path.join(__dirname, '.lark-token.json'),
    stateFile: path.join(__dirname, '.lark-state.json'),
    scopes: process.env.LARK_OAUTH_SCOPES || '',
  });
  larkBundle = {
    client,
    stateFile: path.join(__dirname, '.lark-state.json'),
    notifyEnabled: process.env.LARK_NOTIFY_ENABLED !== 'false',
  };
  console.log('飞书集成已启用，回调基址:', LARK_REDIRECT_BASE);

  if (process.env.LARK_SYNC_ENABLED === 'true') {
    larkSync.startScheduler({
      client,
      dataRoot: dataRootAbs,
      stateFile: larkBundle.stateFile,
      time: process.env.LARK_SYNC_TIME || '08:00',
      notifyEnabled: process.env.LARK_NOTIFY_ENABLED !== 'false',
    });
    console.log('飞书定时同步已开启，每日', process.env.LARK_SYNC_TIME || '08:00');
  }
} else {
  console.log('飞书集成未启用（未配置 LARK_APP_ID/LARK_APP_SECRET/LARK_REDIRECT_BASE）');
}

// 语音转写（硅基流动 SenseVoice）：工作台录音入口 + 抖音完整链路转写
const { createAsr } = require('./lib/asr');
const asr = createAsr({ apiKey: process.env.SILICONFLOW_API_KEY || '' });
console.log(asr.isReady()
  ? '语音转写已启用（硅基流动 SenseVoice，录音入口/抖音拆解可用）'
  : '语音转写未启用：.env 缺少 SILICONFLOW_API_KEY，录音入口与抖音完整拆解不可用');

// 图片识别（硅基流动 Qwen2.5-VL）：聊天框发图自动识别文字/内容
const { createVision } = require('./lib/vision');
const vision = createVision({ apiKey: process.env.SILICONFLOW_API_KEY || '' });
console.log(vision.isReady()
  ? '图片识别已启用（硅基流动 Qwen2.5-VL，聊天发图可用）'
  : '图片识别未启用：.env 缺少 SILICONFLOW_API_KEY');

// 任务派发与 AI 执行中心（飞书表「任务计划」轮询执行；无需额外配置，复用 LARK_BASE_TOKEN）
// 必须在视频收录之前创建：视频拆解完会把选题角度生成「AI建议」任务
let taskRunner = null;
if (larkBundle && larkBundle.client) {
  taskRunner = createTaskRunner({
    apiKey: API_KEY,
    client: larkBundle.client,
    baseToken: process.env.LARK_BASE_TOKEN || '',
    tableId: process.env.LARK_TASK_TABLE_ID || '', // 留空则自动按表名查找/创建「任务计划」表
    intervalMs: Number(process.env.TASK_POLL_MINUTES || 5) * 60 * 1000,
    notifyEnabled: process.env.LARK_NOTIFY_ENABLED !== 'false', // 后台任务完成/失败飞书通知
  });
  taskRunner.start();
}

// 经验复盘中心（板块二）：经验表 CRUD + 评价转经验 + 视频表「值得模仿」评分
const { createExperienceCenter } = require('./lib/experience');
let experienceCenter = null;
if (larkBundle && larkBundle.client) {
  experienceCenter = createExperienceCenter({
    apiKey: API_KEY,
    client: larkBundle.client,
    baseToken: process.env.LARK_BASE_TOKEN || '',
    expTableId: process.env.LARK_EXP_TABLE_ID || '', // 留空自动按表名查找/创建「经验复盘」表
    videoTableId: process.env.LARK_VIDEO_TABLE_ID || '', // 视频评分写入
  });
}

// 视频灵感收录（依赖飞书客户端与多维表格配置；表格未配置时识别到链接会给出降级提示）
let videoIntake = null;
if (larkBundle && larkBundle.client) {
  const LARK_BASE_TOKEN = process.env.LARK_BASE_TOKEN || '';
  const LARK_VIDEO_TABLE_ID = process.env.LARK_VIDEO_TABLE_ID || '';
  videoIntake = createVideoIntake({
    apiKey: API_KEY,
    client: larkBundle.client,
    baseToken: LARK_BASE_TOKEN,
    tableId: LARK_VIDEO_TABLE_ID,
    taskRunner,
    pythonBin: process.env.VIDEO_PYTHON_BIN || 'python3',
    scriptPath: path.join(__dirname, 'skills', 'video-summarizer', 'video_subtitle.py'),
    asr,
    vision,
    fields: {
      title: process.env.LARK_VIDEO_FIELD_TITLE || '',
      url: process.env.LARK_VIDEO_FIELD_URL || '',
      type: process.env.LARK_VIDEO_FIELD_TYPE || '',
      audience: process.env.LARK_VIDEO_FIELD_AUDIENCE || '',
      hook: process.env.LARK_VIDEO_FIELD_HOOK || '',
      structure: process.env.LARK_VIDEO_FIELD_STRUCTURE || '',
      diff: process.env.LARK_VIDEO_FIELD_DIFF || '',
      attract: process.env.LARK_VIDEO_FIELD_ATTRACT || '',
      angles: process.env.LARK_VIDEO_FIELD_ANGLES || '',
      level: process.env.LARK_VIDEO_FIELD_LEVEL || '',
      source: process.env.LARK_VIDEO_FIELD_SOURCE || '',
      summary: process.env.LARK_VIDEO_FIELD_SUMMARY || '',
    },
  });
  console.log(
    LARK_BASE_TOKEN && LARK_VIDEO_TABLE_ID
      ? '视频灵感收录已启用（B站/YouTube/抖音/小红书/TikTok → 多维表格）'
      : '视频灵感收录已加载，但未配置 LARK_BASE_TOKEN/LARK_VIDEO_TABLE_ID，识别到链接时仅提示不写表'
  );
}

// Mac 直链共享表轮询：dy-watch-mac.js（Mac 真实 Chrome）采集成功 → playmap 出现新条目 → 自动跑完整收录链路
// playmap 由 Mac 唯一写入，容器只读；已处理视频用内存 Set 去重（重启后重复触发时 video-intake 自身 dedup 兜底）
if (videoIntake) {
  const fsMod = require('fs');
  const PLAYMAP_FILE = path.join(__dirname, 'skills', 'video-summarizer', 'dy-playmap.json');
  const processedHarvests = new Set();
  setInterval(async () => {
    try {
      const map = JSON.parse(fsMod.readFileSync(PLAYMAP_FILE, 'utf8'));
      for (const [videoId, e] of Object.entries(map || {})) {
        if (!e || e.status !== 'ok' || !e.playUrl || processedHarvests.has(videoId)) continue;
        const t = Date.parse(e.harvestedAt || '');
        if (!isFinite(t) || Date.now() - t > 2 * 3600 * 1000) continue;
        processedHarvests.add(videoId);
        console.log(`[playmap] 拾取 Mac 采集直链 ${videoId}，触发完整收录`);
        try {
          await videoIntake.collect(e.url || `https://www.douyin.com/video/${videoId}`);
        } catch (e) {
          console.log(`[playmap] ${videoId} 收录失败: ${String(e.message || e).slice(0, 160)}`);
        }
      }
    } catch (e) { /* 文件不可读/损坏时跳过本轮 */ }
  }, 15 * 1000);
  console.log('抖音直链共享表轮询已启用（Mac 采集 → 容器自动收录）');
}

// 语音/妙记笔记收录（依赖飞书客户端 + DeepSeek；全量同步至多维表格「妙记笔记」，本地保留 md 归档）
let noteIntake = null;
if (larkBundle && larkBundle.client) {
  noteIntake = createNoteIntake({
    apiKey: API_KEY,
    client: larkBundle.client,
    dataRoot: dataRootAbs,
    baseToken: process.env.LARK_BASE_TOKEN || '',
    tableId: process.env.LARK_NOTE_TABLE_ID || '', // 留空则自动按表名查找/创建「妙记笔记」表
  });
  console.log('妙记笔记收录已启用（妙记链接/录音 → 文字稿 → AI整理 → 今日计划 + 飞书表格「妙记笔记」）');
}

// AI 写作室（板块四）：召回视频拆解 + 经验卡片 + 知识资料生成初稿，打通「拆解→经验→资料→创作」闭环
const { createWritingStudio } = require('./lib/writing');
let writingStudio = null;

// 我的档案（Skill 01 认识我·在线层）：本地认知模型同步到飞书，AI 只可召回「已确认」条目
const { createProfileCenter } = require('./lib/profile');
const profileCenter = createProfileCenter({
  client: (larkBundle && larkBundle.client) || null,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  tableId: process.env.LARK_PROFILE_TABLE_ID || '',
});
if (profileCenter.isReady()) {
  console.log('我的档案已启用（信息层级 + 确认状态纪律：AI 推断不与我的观点混层）');
}

// 知识资料（第二大脑·外部知识层）：57 篇得到大脑 AI 分析等，信息层级固定 AI分析，不与我的观点混层
const { createKnowledgeCenter } = require('./lib/knowledge');
const knowledgeCenter = createKnowledgeCenter({
  client: (larkBundle && larkBundle.client) || null,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  tableId: process.env.LARK_KNOWLEDGE_TABLE_ID || '',
});
if (knowledgeCenter.isReady()) {
  console.log('知识资料库已启用（外部 AI 分析独立分层，仅供召回参考）');
}

// AI 写作室实例化（放到 knowledgeCenter 之后，以便召回知识资料）
writingStudio = createWritingStudio({
  apiKey: API_KEY,
  videoIntake,
  experienceCenter,
  knowledgeCenter,
});
console.log('AI 写作室已启用（视频拆解 + 经验卡片 + 知识资料 → 口播脚本/图文/标题/大纲）');

// 思考伙伴（第 3 步）：提问时聚合 我的档案(已确认)+我确认的经验+知识资料+视频拆解，分层回答、标注来源
const { createThinkingStudio } = require('./lib/thinking');
const thinkingStudio = createThinkingStudio({
  apiKey: API_KEY,
  profileCenter,
  knowledgeCenter,
  experienceCenter,
  videoIntake,
});
console.log('思考伙伴已启用（跨 档案/经验/知识资料/视频拆解 检索，区分事实·外部观点·AI推断）');

// 第 4 步：决策卡（Skill 05 尽调与决策）+ 项目卡（Skill 06 长期项目推进）
// 纪律：AI 只尽调/给建议，默认待用户拍板；状态只能用户本人改，不自动升级目标
const { createDecisionCenter, createProjectCenter } = require('./lib/decide');
const decisionCenter = createDecisionCenter({
  apiKey: API_KEY,
  client: (larkBundle && larkBundle.client) || null,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  tableId: process.env.LARK_DECISION_TABLE_ID || '',
  profileCenter, knowledgeCenter, experienceCenter,
});
const projectCenter = createProjectCenter({
  apiKey: API_KEY,
  client: (larkBundle && larkBundle.client) || null,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  tableId: process.env.LARK_PROJECT_TABLE_ID || '',
  profileCenter, knowledgeCenter, experienceCenter,
});
if (decisionCenter.isReady() && projectCenter.isReady()) {
  console.log('决策卡 + 项目卡已启用（Skill 05 尽调决策 / Skill 06 项目推进，AI 不替用户拍板）');
}

// 会议中心：会前简报（日历+分层召回）与会后回流（候选→用户确认，不自动写卡）
const { createMeetingCenter } = require('./lib/meeting');
const meetingCenter = createMeetingCenter({
  apiKey: API_KEY,
  client: (larkBundle && larkBundle.client) || null,
  noteIntake,
  decisionCenter,
  projectCenter,
  knowledgeCenter,
});
if (meetingCenter.isReady()) {
  console.log('会议中心已启用（会前简报「会前：主题」/ 会后回流候选确认）');
}

// 日程管理：日历视图 + 聊天记录 + 截图识别 → 飞书多维表格「日程表」
const { createScheduleCenter } = require('./lib/schedule');
const scheduleCenter = createScheduleCenter({
  apiKey: API_KEY,
  vision, // 硅基流动 Qwen-VL：校历/日程截图识别用
  client: (larkBundle && larkBundle.client) || null,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  scheduleTableId: process.env.LARK_SCHEDULE_TABLE_ID || '', // 留空自动按表名查找/创建「日程表」
});
if (scheduleCenter) {
  console.log('日程管理已启用（日历视图 + 聊天记录 + 截图识别）');
}

// 记账中心：课时收入（人数×固定单价）+ 日常收支 → 飞书多维表格「记账」
const { createLedgerCenter } = require('./lib/ledger');
const ledgerCenter = ((larkBundle && larkBundle.client) && process.env.LARK_BASE_TOKEN) ? createLedgerCenter({
  apiKey: API_KEY,
  client: larkBundle.client,
  baseToken: process.env.LARK_BASE_TOKEN || '',
  ledgerTableId: process.env.LARK_LEDGER_TABLE_ID || '', // 留空自动按表名查找/创建「记账」表
}) : null;
console.log(ledgerCenter ? '记账中心已启用（聊天「记账：…」/ 截图人数 → 候选 → 回「存」入账）' : '记账中心未启用：需飞书授权 + LARK_BASE_TOKEN');

// API 路由
app.use(createRouter({ apiKey: API_KEY, dataRoot: dataRootAbs, lark: larkBundle, videoIntake, noteIntake, asr, vision, taskRunner, experienceCenter, writingStudio, profileCenter, knowledgeCenter, thinkingStudio, decisionCenter, projectCenter, meetingCenter, scheduleCenter, ledgerCenter }));

// 兜底：非 API 路径返回 index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const file = isMobile ? 'workbench-mobile.html' : 'workbench-desktop.html';
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', file), (err) => {
    if (err) next(err);
  });
});

// 全局错误处理（避免中文信息进 header）
app.use((err, req, res, next) => {
  console.error('未处理错误:', err.message);
  res.status(500).json({ ok: false, error: err.message || '内部错误' });
});

// 抖音全量诊断脚本（/api/videos/diagnose）需在容器内装依赖+开浏览器，耗时可达 8-9 分钟；
// Node 18 默认 requestTimeout=5 分钟会在脚本完成前掐断连接（浏览器表现为 ERR_EMPTY_RESPONSE）
app.requestTimeout = 600000;
app.headersTimeout = 605000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`个人AI操作系统已启动: http://localhost:${PORT}`);
  // 启动预热：提前拉一遍走飞书的读接口，填满服务端缓存——
  // 重启后用户第一次打开手机工作台也能秒开（预热失败不影响服务）
  setTimeout(() => {
    const warmPaths = [
      '/api/schedules',
      '/api/ledger/list',
      '/api/videos/recent?limit=8',
      '/api/tasks/suggestions',
      '/api/tasks/captured',
    ];
    for (const p of warmPaths) {
      fetch(`http://127.0.0.1:${PORT}${p}`).catch(() => {});
    }
    console.log('首屏缓存预热完成（飞书数据已就绪）');
  }, 3000);
});
