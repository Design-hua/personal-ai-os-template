// lib/video-intake.js
// 视频灵感收录：聊天中的视频链接 → 字幕/元数据提取 → DeepSeek 创作拆解 → 写入飞书多维表格
//
// 字幕提取复用 skills/video-summarizer/video_subtitle.py（stdout 输出 JSON）：
// - B站：公开 API + WBI 签名，零依赖
// - YouTube：youtube-transcript-api
// - 抖音/小红书/TikTok：yt-dlp
// 无字幕时做标题级保守分析（不编造正片内容）。
//
// 飞书写入走 lib/lark.js 的用户身份 bitable 方法（需 bitable:app 权限）。
// 所有字段名可经环境变量覆盖；首次写表前自动补建分析列，权限不足不阻塞主流程。

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const deepseek = require('./deepseek');
const douyinFetch = require('./douyin-fetch');

// 流水线诊断日志：写挂载共享目录，Mac 侧可读（排查"回执成功但表没更新"）
function bgLog(line) {
  try {
    fs.appendFileSync(
      path.join(__dirname, '..', 'skills', 'video-summarizer', 'dy-pipeline.log'),
      `[${new Date().toISOString()}] ${String(line).slice(0, 400)}\n`,
      'utf8'
    );
  } catch (e) { /* 忽略 */ }
}

// ---------- 平台识别 ----------

const PLATFORM_NAMES = {
  bilibili: 'B站',
  youtube: 'YouTube',
  douyin: '抖音',
  xiaohongshu: '小红书',
  tiktok: 'TikTok',
  image: '图片',
};

const HOST_PATTERNS = [
  { platform: 'bilibili', re: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/ },
  { platform: 'youtube', re: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/ },
  { platform: 'douyin', re: /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/ },
  { platform: 'xiaohongshu', re: /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/ },
  { platform: 'tiktok', re: /(^|\.)tiktok\.com$/ },
];

// URL 里中文标点会打断链接，截取时排除常见的中英文包裹符
const URL_RE = /https?:\/\/[^\s，。、；？！,'"》）)】\]》]+/gi;
const BV_RE = /BV[0-9A-Za-z]{8,}/;

function detectPlatformByHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const p of HOST_PATTERNS) {
    if (p.re.test(host)) return p.platform;
  }
  return '';
}

/**
 * 从一段文本中识别视频链接
 * 返回 { url, platform } | null
 */
function parseVideoUrl(text) {
  const t = String(text || '');
  if (!t) return null;

  const urls = t.match(URL_RE) || [];
  for (const raw of urls) {
    const url = raw.replace(/[)】\]》'"]+$/, '');
    try {
      const u = new URL(url);
      const platform = detectPlatformByHost(u.hostname);
      if (platform) return { url, platform };
    } catch (e) { /* 忽略非法 URL */ }
  }

  // 纯 BV 号（无链接）
  const bv = t.match(BV_RE);
  if (bv) {
    return { url: `https://www.bilibili.com/video/${bv[0]}`, platform: 'bilibili' };
  }
  return null;
}

// ---------- 工具 ----------

function extractJson(text) {
  const s = String(text || '').replace(/```json|```/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// 多维表格字段读出来的值可能是 string / 分段数组 / {link,text} 对象
function textOfFieldValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => textOfFieldValue(x)).join('');
  if (typeof v === 'object') return String(v.text || v.name || v.link || '');
  return String(v);
}

// ---------- DeepSeek 拆解 ----------

const L2_SYSTEM = `你是短视频爆款拆解专家。基于给到的视频字幕与元信息做创作向拆解——目的是"搞清这条视频为什么行、怎么借鉴"，不是写内容总结。

硬性要求：
1. 结论基于字幕原文、元信息和「画面关键帧识别」，禁止编造三者里都没有的内容；字幕没讲清楚的就写"字幕未涉及"
2. 画面是字幕的重要补充：标题条/字幕条/屏幕关键词/数据/书名产品/图表以画面为准；当语音与画面文字、数字、人名冲突时，以画面为准，但只使用画面里确实识别到的信息，不得臆测
3. 每项简洁直接（1-3 句；结构拆解可以长一些）
4. 只返回严格 JSON，不要 markdown 代码块，不要多余解释

JSON key 固定为：
{"内容类型":"...","目标人群":"...","开头钩子":"...","结构拆解":"...","差异化":"...","为什么吸引人":"...","换角度再写":"...","选题建议":"...","选题角度":["角度1","角度2","角度3"],"话题簇":"...","素材等级":"高|中|低"}

各字段含义：
- 内容类型：一句话定性视频形态（如"口播干货""剧情反转""探店Vlog"）
- 目标人群：拍给谁看，这类人的痛点/爽点是什么
- 开头钩子：第一句/前3秒用了什么钩子（悬念/反常识/利益点/冲突…），为什么能留住人
- 结构拆解：按顺序拆段落结构（钩子→建立期待→主干→高潮/反转→收尾引导），每段标注作用，引用字幕关键句作证据
- 差异化：同题材里它做对了什么不一样的事
- 为什么吸引人：从情绪调动、节奏、信息密度、表达方式等角度说清爆点
- 换角度再写：基于同一选题给 2-3 个不同角度的新选题，每个附一句可直接用的开头示范
- 选题建议：给出 3 个「适合我模仿」的选题角度——不是创新角度，是可直接套用到我自己账号的角度；每条一行，格式：角度标题 + 一句怎么套用
- 选题角度：数组，恰好 3 个，每个是一个可直接拍的选题角度标题（≤25字，不要序号、不要解释），与「选题建议」一一对应
- 话题簇：从以下 6 个值中选 1 个：AI与第二大脑 / 认知与决策 / 搞钱与周期 / 家庭与教育 / 高校生存 / 个人成长。判断逻辑：AI 工具搭建归 AI 簇；看人看事做判断归认知；钱、资产、周期归搞钱；老婆孩子父母归家庭；职称课题论文归高校；自我管理习惯心态归成长。一条内容能进多个簇时按优先级取第一个：搞钱 → 高校 → 家庭 → AI → 认知 → 成长
- 素材等级：高/中/低（高=值得完整逐段模仿；中=部分元素值得借鉴；低=仅记录灵感）`;

const L1_SYSTEM = `你收到一个视频的标题与简介，没有字幕，无法得知正片内容。只做标题级保守分析：
1. 内容类型：从标题/简介推测形态，末尾注明"（据标题推测）"
2. 目标人群：推测拍给谁看，末尾注明"（据标题推测）"
3. 为什么吸引人：标题的钩子好在哪，末尾注明"（标题级判断）"

硬性要求：禁止编造视频正片内容，只依据标题与简介做推测。
只返回严格 JSON：{"内容类型":"...","目标人群":"...","为什么吸引人":"..."}`;

function userMsgL2(meta) {
  return `【视频信息】
标题：${meta.title || '(无)'}
作者：${meta.author || '(无)'}
时长：${meta.duration || '(无)'}
平台：${PLATFORM_NAMES[meta.platform] || meta.platform || '(未知)'}
链接：${meta.url || ''}
${meta.frame_text ? '\n【画面关键帧识别】（按时间顺序，来自视频截图，屏幕文字/数字以此为准）\n' + meta.frame_text + '\n' : ''}
【字幕全文】
${meta.subtitle_text || '(无字幕)'}`;
}

function userMsgL1(meta) {
  return `【视频信息】
标题：${meta.title || '(无)'}
作者：${meta.author || '(无)'}
平台：${PLATFORM_NAMES[meta.platform] || meta.platform || '(未知)'}
链接：${meta.url || ''}

【简介】
${meta.description || '(无简介)'}`;
}

async function analyzeWithDeepSeek(meta, apiKey) {
  const hasSubtitle = typeof meta.subtitle_text === 'string' && meta.subtitle_text.trim().length >= 80;
  const system = hasSubtitle ? L2_SYSTEM : L1_SYSTEM;
  const user = hasSubtitle ? userMsgL2(meta) : userMsgL1(meta);

  const raw = await deepseek.callDeepSeek(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    apiKey
  );
  const parsed = extractJson(raw);
  if (!parsed) throw new Error('AI 拆解结果不是合法 JSON');
  return { level: hasSubtitle ? 'L2' : 'L1', analysis: parsed };
}

// 把两级分析结果整理成统一的表格字段值（不含标题/链接等基础字段）
function buildAnalysisFields(analysis, level, fieldNames) {
  const F = fieldNames;
  const NA = '（无文案，标题级分析）';
  if (level === 'L2') {
    return {
      [F.type]: String(analysis['内容类型'] || ''),
      [F.audience]: String(analysis['目标人群'] || ''),
      [F.hook]: String(analysis['开头钩子'] || ''),
      [F.structure]: String(analysis['结构拆解'] || ''),
      [F.diff]: String(analysis['差异化'] || ''),
      [F.attract]: String(analysis['为什么吸引人'] || ''),
      [F.angles]: String(analysis['换角度再写'] || ''),
      [F.suggest]: String(analysis['选题建议'] || ''),
      [F.cluster]: String(analysis['话题簇'] || ''),
      [F.level]: String(analysis['素材等级'] || '中'),
    };
  }
  return {
    [F.type]: String(analysis['内容类型'] || ''),
    [F.audience]: String(analysis['目标人群'] || ''),
    [F.attract]: String(analysis['为什么吸引人'] || ''),
    [F.hook]: NA,
    [F.structure]: NA,
    [F.diff]: NA,
    [F.angles]: NA,
    [F.level]: '低',
  };
}

// 把拆解结果拼成一段摘要文本，写入用户已有的总结类字段（如「笔记内容总结」），在主视图直接可见
function buildSummaryText(analysis, level, materialLevel) {
  const a = analysis || {};
  const rows = (pairs) => pairs.filter(([, v]) => v).map(([k, v]) => `■ ${k}：${v}`).join('\n');
  if (level === 'L2') {
    return [
      `【7维创作拆解 · 素材等级：${materialLevel}】`,
      rows([
        ['内容类型', a['内容类型']],
        ['目标人群', a['目标人群']],
        ['开头钩子', a['开头钩子']],
        ['结构拆解', a['结构拆解']],
        ['差异化', a['差异化']],
        ['为什么吸引人', a['为什么吸引人']],
        ['换角度再写', a['换角度再写']],
        ['选题建议', a['选题建议']],
        ['话题簇', a['话题簇']],
      ]),
    ].filter(Boolean).join('\n');
  }
  return [
    `【标题级拆解 · 素材等级：${materialLevel}】`,
    rows([
      ['内容类型', a['内容类型']],
      ['目标人群', a['目标人群']],
      ['为什么吸引人', a['为什么吸引人']],
    ]),
    '注：该视频无可用字幕，以上为基于标题/简介的保守推测，未编造正片内容。',
  ].filter(Boolean).join('\n');
}

// ---------- 工厂 ----------

function createVideoIntake(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    client: o.client || null, // lib/lark.js 客户端
    baseToken: o.baseToken || '',
    tableId: o.tableId || '',
    pythonBin: o.pythonBin || 'python3',
    scriptPath: o.scriptPath || '',
    timeoutMs: Number(o.timeoutMs || 180000),
    asr: o.asr || null, // lib/asr.js 实例：抖音完整链路的语音转写
    vision: o.vision || null, // lib/vision.js 实例：抖音完整链路的关键帧视觉理解
    taskRunner: o.taskRunner || null, // lib/task-runner.js：拆解后生成「AI建议」选题任务
  };

  const fieldDefaults = {
    title: '标题',
    url: '链接',
    type: '内容类型',
    audience: '目标人群',
    hook: '开头钩子',
    structure: '结构拆解',
    diff: '差异化',
    attract: '为什么吸引人',
    angles: '换角度再写',
    suggest: '选题建议',
    cluster: '话题簇',
    level: '素材等级',
    source: '收录来源',
    comment: '我的评价', // 用户手动评价：聊天里追加写入，AI 不覆盖
    summary: '笔记内容总结', // 用户已有字段：存在时把拆解摘要写入，不自动创建
  };
  // 只覆盖非空值（env 未设置时传空字符串不应清掉默认名）
  const F = Object.assign({}, fieldDefaults);
  const supplied = o.fields || {};
  for (const k of Object.keys(supplied)) {
    if (supplied[k]) F[k] = String(supplied[k]);
  }

  // 需要自动补建的拆解列（内容类型用文本：AI 分类是开放词表，单选会造成写表失败）
  const ANALYSIS_FIELD_DEFS = [
    { name: F.type, type: 1 },
    { name: F.audience, type: 1 },
    { name: F.hook, type: 1 },
    { name: F.structure, type: 1 },
    { name: F.diff, type: 1 },
    { name: F.attract, type: 1 },
    { name: F.angles, type: 1 },
    { name: F.suggest, type: 1 },
    { name: F.cluster, type: 3, property: { options: [{ name: 'AI与第二大脑' }, { name: '认知与决策' }, { name: '搞钱与周期' }, { name: '家庭与教育' }, { name: '高校生存' }, { name: '个人成长' }] } },
    { name: F.level, type: 3, property: { options: [{ name: '高' }, { name: '中' }, { name: '低' }, { name: '待分析' }] } },
    { name: F.source, type: 3, property: { options: [{ name: 'B站' }, { name: 'YouTube' }, { name: '抖音' }, { name: '小红书' }, { name: 'TikTok' }, { name: '图片' }] } },
    { name: F.comment, type: 1 },
  ];

  let tableReady = false;
  let ensureFieldsPromise = null;
  let knownFieldNames = null; // 表中已存在的字段名集合（ensureFields 后填充）

  function isReady() {
    return Boolean(cfg.client && cfg.baseToken && cfg.tableId && cfg.scriptPath);
  }

  // 抖音完整转写（下载音频→Whisper→L2）需要真实浏览器 cookies；文件存在才走重型流程
  function hasDouyinCookies() {
    try {
      return fs.existsSync(path.join(path.dirname(cfg.scriptPath), 'www.douyin.com_cookies.txt'));
    } catch (e) {
      return false;
    }
  }

  // 首次写表前补建拆解列；任何失败只告警不阻塞（基础列标题/链接已存在即可用）
  function ensureFields() {
    if (!ensureFieldsPromise) {
      ensureFieldsPromise = (async () => {
        const existing = new Set();
        try {
          const items = await cfg.client.listBitableFields(cfg.baseToken, cfg.tableId);
          for (const f of items) existing.add(f.field_name);
          knownFieldNames = existing;
        } catch (e) {
          return { ok: false, warning: `读取字段失败: ${e.message}` };
        }
        const warnings = [];
        for (const def of ANALYSIS_FIELD_DEFS) {
          if (existing.has(def.name)) continue;
          try {
            await cfg.client.createBitableField(cfg.baseToken, cfg.tableId, {
              field_name: def.name,
              type: def.type,
              ...(def.property ? { property: def.property } : {}),
            });
          } catch (e) {
            warnings.push(`创建字段「${def.name}」失败: ${e.message}`);
          }
        }
        return { ok: warnings.length === 0, warning: warnings.join('；') };
      })();
    }
    return ensureFieldsPromise;
  }

  // 全表拉取 + 本地比对链接查重（个人表量级小，避免 filter 语法兼容问题）
  // 抖音特殊处理：分享短链(v.douyin.com/xxx)与完整链路长链(/video/<数字ID>)指向同一视频，
  // Mac 采集回捞时长链必须能匹配上当初短链建的「低」等级行，否则会重复建行。
  const douyinIdOf = (u) => {
    const m = String(u || '').match(/(?:douyin\.com\/video\/|iesdouyin\.com\/share\/video\/)(\d+)/);
    return m ? m[1] : '';
  };
  const shortLinkCache = new Map(); // 短链 -> 解析出的完整ID（进程内缓存）
  async function resolveDouyinShortId(shortUrl) {
    if (shortLinkCache.has(shortUrl)) return shortLinkCache.get(shortUrl);
    let id = '';
    try {
      const resp = await fetch(shortUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' },
      });
      const loc = resp.headers.get('location') || '';
      id = douyinIdOf(loc);
    } catch (e) { /* 风控/网络失败时退回旧逻辑（可能建行），不阻塞主流程 */ }
    shortLinkCache.set(shortUrl, id);
    return id;
  }
  async function findRecordByUrl(url) {
    let pageToken = '';
    let allItems = [];
    for (let i = 0; i < 20; i++) {
      const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, {
        pageSize: 500,
        pageToken,
      });
      const items = data.items || [];
      allItems = allItems.concat(items);
      for (const rec of items) {
        const v = rec.fields ? rec.fields[F.url] : '';
        if (textOfFieldValue(v).includes(url)) return rec;
      }
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    // 抖音长链回捞：按视频ID匹配完整长链旧行；仍不匹配再解析短链旧行
    const incomingId = douyinIdOf(url);
    if (incomingId) {
      for (const rec of allItems) {
        const stored = textOfFieldValue(rec.fields ? rec.fields[F.url] : '');
        if (douyinIdOf(stored) === incomingId) return rec;
      }
      for (const rec of allItems) {
        const stored = textOfFieldValue(rec.fields ? rec.fields[F.url] : '');
        if (/v\.douyin\.com\//.test(stored) && (await resolveDouyinShortId(stored)) === incomingId) return rec;
      }
    }
    return null;
  }

  // 北京时间时间戳（容器默认 UTC）：MM-DD HH:mm
  function bjNowStamp() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  }

  /**
   * 对某条视频追加「我的评价」（不覆盖旧评价）
   * @param {{url?:string, recordId?:string, text:string}} arg
   * @returns {Promise<{recordId, title}>}
   */
  async function commentOnVideo(arg) {
    const a = arg || {};
    const text = String(a.text || '').trim();
    if (!text) throw new Error('评价内容为空');
    if (!isReady()) throw new Error('视频表格未启用');

    let rec = null;
    if (a.recordId) {
      // recordId 直查：按 URL 反查不可靠时前端也可传 recordId
      const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, { pageSize: 500 });
      rec = (data.items || []).find((it) => it.record_id === a.recordId) || null;
    } else if (a.url) {
      rec = await findRecordByUrl(a.url);
    }
    if (!rec) throw new Error('在表格里没找到这条视频，请用 @ 选择或重新收录');

    await ensureFields();
    const oldVal = textOfFieldValue(rec.fields ? rec.fields[F.comment] : '');
    const block = `【${bjNowStamp()}】${text}`;
    const nextVal = oldVal ? `${oldVal}\n\n${block}` : block;
    await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, rec.record_id, {
      [F.comment]: nextVal,
    });
    bgLog(`评价已追加 recordId=${rec.record_id} len=${text.length}`);
    return { recordId: rec.record_id, title: textOfFieldValue(rec.fields ? rec.fields[F.title] : '') };
  }

  /**
   * 最近收录的视频（供聊天 @ 选择 + 评价页列表）
   * @returns {Promise<Array<{recordId,title,url,cluster,level,comment,hasComment}>>}
   */
  async function listRecentVideos(limit) {
    if (!isReady()) return [];
    const n = Math.min(Number(limit) || 8, 200);
    // 评价页需要全量：最多翻 5 页（500 条）
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, {
        pageSize: 500,
        pageToken,
      });
      all.push(...(data.items || []));
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    // 飞书默认按创建顺序返回，reverse 取最新
    const items = all.slice().reverse();
    const out = [];
    for (const rec of items) {
      const title = textOfFieldValue(rec.fields ? rec.fields[F.title] : '');
      if (!title || title === '（待分析）') continue;
      const comment = textOfFieldValue(rec.fields ? rec.fields[F.comment] : '');
      const rating = Number(rec.fields ? rec.fields['值得模仿'] : 0);
      out.push({
        recordId: rec.record_id,
        title,
        url: textOfFieldValue(rec.fields ? rec.fields[F.url] : ''),
        cluster: textOfFieldValue(rec.fields ? rec.fields[F.cluster] : ''),
        level: textOfFieldValue(rec.fields ? rec.fields[F.level] : ''),
        comment,
        hasComment: Boolean(comment.trim()),
        rating: Number.isFinite(rating) && rating > 0 ? rating : 0,
      });
      if (out.length >= n) break;
    }
    return out;
  }

  /**
   * 视频素材全字段读取（写作室召回用）：含开头钩子/结构/爆点/选题建议等拆解正文
   * @param {number} limit 最多返回条数
   * @returns {Promise<Array<object>>}
   */
  async function listVideosRich(limit) {
    if (!isReady()) return [];
    const n = Math.min(Number(limit) || 60, 200);
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const data = await cfg.client.listBitableRecords(cfg.baseToken, cfg.tableId, {
        pageSize: 500,
        pageToken,
      });
      all.push(...(data.items || []));
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    const out = [];
    for (const rec of all.slice().reverse()) {
      const f = rec.fields || {};
      const title = textOfFieldValue(f[F.title]);
      if (!title || title === '（待分析）') continue;
      const rating = Number(f['值得模仿']);
      out.push({
        recordId: rec.record_id,
        title,
        url: textOfFieldValue(f[F.url]),
        cluster: textOfFieldValue(f[F.cluster]),
        level: textOfFieldValue(f[F.level]),
        rating: Number.isFinite(rating) && rating > 0 ? rating : 0,
        type: textOfFieldValue(f[F.type]),
        hook: textOfFieldValue(f[F.hook]),
        structure: textOfFieldValue(f[F.structure]),
        attract: textOfFieldValue(f[F.attract]),
        suggest: textOfFieldValue(f[F.suggest]),
        angles: textOfFieldValue(f[F.angles]),
      });
      if (out.length >= n) break;
    }
    return out;
  }

  // ---------- 字幕提取 ----------

  function runExtractor(url) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cfg.pythonBin, [cfg.scriptPath, url], {
        cwd: require('path').dirname(cfg.scriptPath),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error(`字幕提取超时（${Math.round(cfg.timeoutMs / 1000)}s）`));
      }, cfg.timeoutMs);

      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`无法启动 Python (${cfg.pythonBin}): ${e.message}`));
      });
      proc.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let json = null;
        const start = stdout.indexOf('{');
        if (start >= 0) {
          try { json = JSON.parse(stdout.slice(start)); } catch (e) { /* fallthrough */ }
        }
        if (json && json.error) {
          // 转录失败但元数据已拿到（抖音/小红书常见：页面可解析出标题，但无公开字幕轨道且未启用 Whisper）
          // 不当作错误，降级为无字幕 meta，走 L1 标题级分析
          if (json.title) {
            return resolve({
              title: json.title || '',
              author: json.author || '',
              duration: json.duration || '',
              description: json.description || '',
              url: json.url || '',
              platform: json.platform || '',
              subtitle_text: '',
              _warning: String(json.error).slice(0, 300),
            });
          }
          return reject(new Error(`字幕提取失败: ${String(json.error).slice(0, 300)}`));
        }
        if (!json || !json.title) {
          const tail = (stderr || stdout).slice(-300);
          return reject(new Error(`字幕提取输出无法解析: ${tail}`));
        }
        resolve(json);
      });
    });
  }

  // ---------- 轻量元数据获取（提取失败时降级用） ----------

  const DOUYIN_APP_UA =
    'com.ss.android.ugc.aweme/110101 (Linux; U; Android 12; en_US; Pixel 6; ' +
    'Build/SD1A.210817.036; Cronet/TTNetVersion:b4d74d15 2023-04-08)';

  function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  // 抖音：短链 → video_id → iesdouyin 分享页 _ROUTER_DATA（App UA，国内网络免登录）
  async function fetchDouyinMeta(rawUrl) {
    try {
      let finalUrl = rawUrl;
      let idMatch = rawUrl.match(/douyin\.com\/video\/(\d+)/);
      if (!idMatch && /v\.douyin\.com|iesdouyin\.com/.test(rawUrl)) {
        const r = await fetchWithTimeout(rawUrl, {
          redirect: 'follow',
          headers: { 'User-Agent': DOUYIN_APP_UA, Accept: '*/*' },
        }, 10000);
        finalUrl = r.url || finalUrl;
        idMatch = finalUrl.match(/video\/(\d+)/);
      }
      if (!idMatch) return null;
      const resp = await fetchWithTimeout(`https://www.iesdouyin.com/share/video/${idMatch[1]}/`, {
        headers: { 'User-Agent': DOUYIN_APP_UA, Accept: '*/*' },
      }, 10000);
      const html = await resp.text();
      const marker = '_ROUTER_DATA';
      const idx = html.indexOf(marker);
      if (idx >= 0) {
        const eq = html.indexOf('=', idx + marker.length);
        const scriptEnd = html.indexOf('</script>', eq);
        if (eq >= 0 && scriptEnd > eq) {
          const data = JSON.parse(html.slice(eq + 1, scriptEnd).trim());
          const loader = (data && data.loaderData) || {};
          for (const v of Object.values(loader)) {
            if (!v || typeof v !== 'object') continue;
            const vr = v.videoInfoRes || v;
            const items = vr.item_list || vr.itemList || [];
            const it = Array.isArray(items) && items[0];
            if (it) {
              const title = it.desc || it.title || '';
              if (title) {
                return {
                  title,
                  author: (it.author && it.author.nickname) ||
                    (it.authorInfo && it.authorInfo.nickname) || '',
                  description: it.desc || '',
                  duration: it.video && it.video.duration
                    ? `${Math.round(Number(it.video.duration) / 1000)}秒`
                    : '',
                };
              }
            }
          }
        }
      }
      // 兜底：页面 og:title（排除风控占位页标题）
      const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
      if (og && og[1] && !/记录美好生活/.test(og[1])) {
        return { title: og[1], author: '', description: '' };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // 分享口令兜底：抖音「【作者的作品】标题… URL」整段粘贴时，从口令文本提取标题
  function extractShareTextMeta(text) {
    const t = String(text || '');
    const m = t.match(/【([^】\n]{1,30}?)的作品】([\s\S]{2,200}?)https?:\/\//);
    if (!m) return null;
    const title = String(m[2] || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    return {
      title: title.slice(0, 120),
      author: String(m[1] || '').trim(),
      description: title.slice(0, 500),
      _shareText: true,
    };
  }

  async function fetchMetaFallback(parsed, rawText) {
    const { url, platform } = parsed;
    // 抖音/小红书：分享口令里自带标题（App「复制链接」的天然格式），优先使用，零网络等待
    if (platform === 'douyin' || platform === 'xiaohongshu') {
      const fromText = extractShareTextMeta(rawText);
      if (fromText) return { ...fromText, url, platform, subtitle_text: '' };
    }
    try {
      if (platform === 'bilibili') {
        const bv = url.match(/BV[0-9A-Za-z]{8,}/);
        if (!bv) return null;
        const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv[0]}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalAI/1.0)' },
        });
        const json = await resp.json();
        if (json.code !== 0 || !json.data) return null;
        const d = json.data;
        return {
          title: d.title || '',
          author: (d.owner && d.owner.name) || '',
          description: d.desc || '',
          duration: d.duration ? `${d.duration}秒` : '',
          url,
          platform,
          subtitle_text: '',
        };
      }
      if (platform === 'youtube') {
        const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        const json = await resp.json();
        if (!json.title) return null;
        return {
          title: json.title || '',
          author: json.author_name || '',
          description: '',
          url,
          platform,
          subtitle_text: '',
        };
      }
      if (platform === 'douyin') {
        const dy = await fetchDouyinMeta(url);
        if (dy) return { ...dy, url, platform, subtitle_text: '' };
      }
    } catch (e) {
      // 全部通道失败
    }
    return null;
  }

  // ---------- 后台流水线 ----------

  async function runPipeline(meta, existingRecord) {
    bgLog(`runPipeline 开始 level候选=${meta.subtitle_text ? 'L2' : 'L1'} 标题=${String(meta.title || '').slice(0, 40)}`);
    let recordId = existingRecord ? existingRecord.record_id : '';

    // 1. 先入库占位（异步模式下让表格先出现"待分析"条目）
    if (!recordId) {
      await ensureFields();
      const baseFields = {
        [F.title]: meta.title || '（待分析）',
        [F.source]: PLATFORM_NAMES[meta.platform] || meta.platform,
        [F.level]: '待分析',
      };
      try {
        // 链接字段为 URL 类型时用对象写法；若实际是文本字段则回退字符串
        // 图片素材无链接：不写链接字段，避免空 link 被飞书拒绝
        if (meta.url) {
          try {
            const created = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, {
              ...baseFields,
              [F.url]: { text: meta.url, link: meta.url },
            });
            recordId = created.record_id || '';
          } catch (e) {
            const created = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, {
              ...baseFields,
              [F.url]: meta.url,
            });
            recordId = created.record_id || '';
          }
        } else {
          const created = await cfg.client.createBitableRecord(cfg.baseToken, cfg.tableId, baseFields);
          recordId = created.record_id || '';
        }
      } catch (e) {
        // 权限不足等：不阻塞分析流程，直接抛出由上层处理
        bgLog(`占位记录创建失败: ${String(e.message).slice(0, 200)}`);
        throw new Error(`写入飞书表格失败: ${e.message}`);
      }
    }
    bgLog(`占位记录就绪 recordId=${recordId || '复用旧记录'}，开始 AI 拆解`);

    // 2. DeepSeek 拆解
    let analyzed;
    try {
      analyzed = await analyzeWithDeepSeek(meta, cfg.apiKey);
      bgLog(`AI 拆解完成 level=${analyzed.level}`);
    } catch (e) {
      if (recordId) {
        await cfg.client
          .updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, {
            [F.structure]: `拆解失败: ${e.message}`,
          })
          .catch(() => {});
      }
      throw e;
    }

    const fieldValues = buildAnalysisFields(analyzed.analysis, analyzed.level, F);

    // 3. 回填表格
    try {
      // 补分析路径没走过建占位记录，这里确保字段清单已加载（有缓存，不会重复创建）
      await ensureFields();
      const updateFields = {
        [F.title]: meta.title || '（无标题）',
        ...fieldValues,
      };
      // 用户表里已有「笔记内容总结」等总结类字段时，同步写入一段可读摘要，主视图直接可见
      if (knownFieldNames && knownFieldNames.has(F.summary)) {
        updateFields[F.summary] = buildSummaryText(
          analyzed.analysis, analyzed.level, String(fieldValues[F.level] || '中')
        );
      }
      await cfg.client.updateBitableRecord(cfg.baseToken, cfg.tableId, recordId, updateFields);
      tableReady = true;
      bgLog(`回填飞书成功 ✓ recordId=${recordId} 话题簇=${fieldValues[F.cluster] || ''}`);
    } catch (e) {
      bgLog(`回填失败: ${String(e.message).slice(0, 200)}`);
      throw new Error(`回填拆解结果失败: ${e.message}`);
    }

    // 4. L2 拆解成功后，把 3 个选题角度生成「AI建议」任务（等用户拍板，失败不影响主流程）
    if (cfg.taskRunner && analyzed.level === 'L2') {
      try {
        let angles = Array.isArray(analyzed.analysis['选题角度']) ? analyzed.analysis['选题角度'] : [];
        // 兼容模型没返回数组的情况：从「选题建议」文本按行抠
        if (!angles.length) {
          angles = String(analyzed.analysis['选题建议'] || '')
            .split('\n')
            .map((s) => s.replace(/^\s*\d+[.、）)]\s*/, '').trim())
            .filter(Boolean);
        }
        const angleTasks = angles.slice(0, 3).map((t) => {
          const title = String(t).replace(/^[【\[]?选题[】\]]?[:：]?/, '').trim().slice(0, 60);
          return { title, instruction: `基于参考视频的选题角度「${title}」，帮我创作一条同主题短视频。` };
        }).filter((a) => a.title);
        if (angleTasks.length) {
          await cfg.taskRunner.suggestFromVideo(angleTasks, {
            title: meta.title || '',
            url: meta.url || '',
            cluster: String(analyzed.analysis['话题簇'] || ''),
          });
        }
      } catch (e) {
        console.warn('[video-intake] 生成选题建议任务失败（不影响拆解）:', e.message);
      }
    }

    return { recordId, level: analyzed.level, analysis: analyzed.analysis, fieldValues };
  }

  // ---------- 主入口 ----------

  /**
   * collect(text, { wait })
   * - wait=false（默认）：识别到链接后立即回复"已开始后台拆解"，流水线在后台跑
   * - wait=true：同步等全流程结束，返回拆解结果（供接口测试/SKILL 调用）
   */
  const inFlight = new Set(); // 正在后台处理的抖音视频 URL（防重复点击/watcher 重复触发）

  // 对外入口：抖音非等待模式在这里加并发锁 + 立即回执，后台同步跑完，结束释放锁
  async function collect(text, options) {
    const opt = options || {};
    const parsed = parseVideoUrl(text);
    if (!parsed) return { handled: false };

    if (parsed.platform === 'douyin' && !opt.wait) {
      // 快速查重：已完整拆解过的视频直接告知，不加锁不排队（待分析/可升级的才继续后台流程）
      let quickExisting = null;
      try { quickExisting = await findRecordByUrl(parsed.url); } catch (e) { quickExisting = null; }
      if (quickExisting) {
        const lv = textOfFieldValue(quickExisting.fields ? quickExisting.fields[F.level] : '');
        if (lv && lv !== '待分析' && lv !== '低') {
          const tt = textOfFieldValue(quickExisting.fields ? quickExisting.fields[F.title] : '');
          return {
            handled: true, mode: 'video', url: parsed.url, platform: parsed.platform,
            queued: false, dedup: true, recordId: quickExisting.record_id,
            title: tt,
            reply: `📌 该视频已拆解完成：《${tt || '未命名'}》（素材等级：${lv}），已在飞书表格中。`,
          };
        }
      }
      if (inFlight.has(parsed.url)) {
        return {
          handled: true, mode: 'video', url: parsed.url, platform: parsed.platform,
          queued: true, skipped: true,
          reply: '⏳ 这个视频正在拆解中，无需重复发送，完成后会自动写入飞书表格。',
        };
      }
      inFlight.add(parsed.url);
      bgLog(`后台任务开始 ${parsed.url}`);
      runCollect(text, { ...opt, wait: true }, parsed)
        .then((r) => {
          bgLog(`done level=${r && r.level} error=${r && r.error ? String(r.error).slice(0, 300) : '无'}`);
          console.log(`[video-intake] 后台抖音处理完成: ${(r && r.reply || '').slice(0, 80)}`);
        })
        .catch((e) => {
          bgLog(`THROW ${String(e.message || e).slice(0, 300)}`);
          console.error(`[video-intake] 后台抖音处理失败: ${String(e.message || e).slice(0, 160)}`);
        })
        .finally(() => inFlight.delete(parsed.url));
      const shareTitle = (extractShareTextMeta(text) || {}).title || '';
      return {
        handled: true,
        mode: 'video',
        url: parsed.url,
        platform: parsed.platform,
        queued: true,
        title: shareTitle,
        reply:
          `🔗 已收到抖音视频${shareTitle ? `：《${shareTitle}》` : ''}\n` +
          '已在后台开始完整拆解（下载→语音转写→七维分析），约 3-8 分钟自动写入飞书表格，' +
          '请稍后点「打开飞书表格」查看，无需在此等待。若该视频已在表格中，将自动升级更新。',
      };
    }

    return runCollect(text, opt, parsed);
  }

  async function runCollect(text, opt, parsed) {
    const platformName = PLATFORM_NAMES[parsed.platform] || parsed.platform;

    if (!isReady()) {
      return {
        handled: true,
        mode: 'video',
        url: parsed.url,
        platform: parsed.platform,
        queued: false,
        reply:
          `识别到${platformName}视频链接，但视频收录功能未启用。\n` +
          '请在 .env 配置 LARK_BASE_TOKEN 与 LARK_VIDEO_TABLE_ID 后重启服务。',
      };
    }

    // 查重
    let existing = null;
    try {
      existing = await findRecordByUrl(parsed.url);
    } catch (e) {
      // 查重失败不阻塞收录（可能只是权限提示），按新条目继续
      existing = null;
    }

    if (existing) {
      const title = textOfFieldValue(existing.fields ? existing.fields[F.title] : '');
      const level = textOfFieldValue(existing.fields ? existing.fields[F.level] : '');
      const analyzed = level && level !== '待分析';
      // 抖音旧记录若只有标题级快照（素材等级=低），浏览器完整链路就绪时自动升级为七维拆解
      const douyinUpgradable =
        parsed.platform === 'douyin' &&
        level === '低' &&
        douyinFetch.isAvailable().ok &&
        cfg.asr &&
        cfg.asr.isReady();
      // 已分析 → 直接返回；待分析 或 可升级 → fallthrough 走（补）分析流程
      if (analyzed && !douyinUpgradable) {
        return {
          handled: true,
          mode: 'video',
          url: parsed.url,
          platform: parsed.platform,
          dedup: true,
          queued: false,
          title,
          reply: `📌 该视频已在表格中：《${title || '未命名'}》（素材等级：${level}）`,
          recordId: existing.record_id,
        };
      }
      if (douyinUpgradable) {
        console.log(`[video-intake] 抖音旧记录为标题级快照，本次走完整链路升级：《${title}》`);
      }
      // 待分析：补跑 L1/L2 分析，复用 runPipeline(meta, existing) 走 update 路径
    }

    // 先提取（同步等提取结果，用来占位建条目）
    let meta;
    let extractionError = null;
    if (parsed.platform === 'douyin') {
      // 注：后台回执已在入口 collect() 统一处理，进入这里一律是 wait:true 的同步完整链路
      // 完整链路：容器 Chromium（真实浏览器指纹过风控）→ CDN 直链下载 → ffmpeg 提音频 → ASR 转写 → L2 七维
      let fullDone = false;
      const avail = douyinFetch.isAvailable();
      bgLog(`环境检查 avail.ok=${avail.ok} reason=${avail.reason || ''} asr=${cfg.asr && cfg.asr.isReady() ? 'ready' : 'none'} cookies=${hasDouyinCookies()}`);
      if (avail.ok && cfg.asr && cfg.asr.isReady()) {
        try {
          console.log('[video-intake] 抖音完整链路启动（浏览器→下载→转写）...');
          bgLog('完整链路启动：取直链/下载/转写…');
          const full = await douyinFetch.collectTranscript(parsed.url, { asr: cfg.asr, vision: cfg.vision });
          if (full.transcript && full.transcript.trim().length >= 80) {
            meta = {
              title: full.title || (extractShareTextMeta(text) || {}).title || '（抖音视频）',
              author: '',
              description: '',
              duration: full.durationSec ? `${full.durationSec}秒` : '',
              subtitle_text: full.transcript,
              frame_text: full.frameText || '',
              url: parsed.url,
              platform: 'douyin',
            };
            fullDone = true;
            bgLog(`转写完成 ${full.transcript.length} 字${full.segments > 1 ? `（${full.segments} 段拼接）` : ''}${full.frameCount ? `，关键帧识别 ${full.frameCount} 张` : ''}`);
            console.log(`[video-intake] 抖音转写完成：${full.transcript.length} 字（段数 ${full.segments || 1}），关键帧 ${full.frameCount || 0} 张，音频 ${Math.round(full.audioBytes / 1024)}KB`);
          } else {
            extractionError = '转写内容过短（可能是纯音乐/无口播视频）';
            bgLog('转写内容过短，转降级');
          }
        } catch (e) {
          extractionError = `抖音完整链路失败: ${e.message}`;
          bgLog(`完整链路失败: ${String(e.message).slice(0, 300)}`);
          console.error('[video-intake] ' + extractionError);
        }
      } else if (!avail.ok) {
        extractionError = avail.reason;
      }
      if (!fullDone) {
        bgLog('走降级通道（cookies/python 或分享口令）');
        if (hasDouyinCookies()) {
          try {
            meta = await runExtractor(parsed.url);
          } catch (e) {
            extractionError = extractionError || e.message;
            meta = await fetchMetaFallback(parsed, text);
          }
        } else {
          meta = await fetchMetaFallback(parsed, text);
        }
        bgLog(`降级结果 meta=${meta ? '有标题' : '无（纯链接抓不到）'}`);
      }
      if (!meta) {
        return {
          handled: true,
          mode: 'video',
          url: parsed.url,
          platform: parsed.platform,
          queued: false,
          error: extractionError || 'douyin metadata unavailable',
          reply:
            '⚠️ 没拿到这个抖音视频的标题（抖音风控，纯链接抓不到信息）。\n' +
            '请在抖音 App 点「分享 → 复制链接」，把整段文案（含【作者的作品】和标题）一起粘贴过来，' +
            '我就能按标题做 3 维拆解并写入表格。',
        };
      }
    } else {
      try {
        meta = await runExtractor(parsed.url);
      } catch (e) {
        extractionError = e.message;
        // 提取失败 → 尝试轻量 API 获取标题，降级做 L1 标题级分析
        const fallback = await fetchMetaFallback(parsed, text);
        if (fallback) {
          meta = fallback;
        } else {
          return {
            handled: true,
            mode: 'video',
            url: parsed.url,
            platform: parsed.platform,
            queued: false,
            error: e.message,
            reply: `⚠️ ${platformName}视频提取失败：${e.message}\n（轻量元数据获取也失败，无法做降级分析）`,
          };
        }
      }
    }

    const isL1 = !meta.subtitle_text || meta.subtitle_text.trim().length < 80;
    // 抖音直链采集失败时已自动写 Mac 采集请求（douyin-fetch.writePendingEntry），
    // Mac 真实浏览器采集成功后由 server.js 轮询器拾取并自动升级为完整 7 维拆解
    const dyUpgradeNote =
      parsed.platform === 'douyin' && /直链|风控|Chromium|浏览器/.test(extractionError || '')
        ? '\n\n⏳ 已自动转交 Mac 端真实浏览器采集视频直链，约 3-5 分钟后本条会自动升级为完整 7 维拆解，无需重新发送。'
        : '';
    const l1Reason = extractionError
      ? `字幕提取失败（${extractionError.slice(0, 60)}），降级做标题级 3 维分析，`
      : (meta._shareText
        ? '未获取到视频页面信息，按你分享口令中的标题做 3 维分析，'
        : (meta._warning
          ? '该平台无公开字幕轨道，按标题做 3 维分析，'
          : '无字幕，做标题级 3 维分析，'));
    const startedReply = isL1
      ? `🔗 已收到${platformName}视频：《${meta.title}》\n` +
        l1Reason +
        '完成后写入飞书多维表格，稍后刷新查看。' +
        dyUpgradeNote
      : `🔗 已收到${platformName}视频：《${meta.title}》\n` +
        '正在后台做 7 维创作拆解（字幕提取完成，AI 分析中），完成后自动写入飞书多维表格，稍后刷新查看。';

    if (opt.wait) {
      // 同步模式：完整跑完
      const result = await runPipeline(meta, existing);
      return {
        handled: true,
        mode: 'video',
        url: parsed.url,
        platform: parsed.platform,
        queued: false,
        wait: true,
        dedup: Boolean(existing),
        level: result.level,
        analysis: result.analysis,
        recordId: result.recordId,
        title: meta.title || '',
        reply: buildDoneReply(meta, result),
      };
    }

    // 异步模式：立即回复，后台继续
    runPipeline(meta, existing)
      .then(() => {
        console.log(`[video-intake] 拆解完成并已写入表格: ${meta.title}`);
      })
      .catch((e) => {
        console.error(`[video-intake] 后台拆解失败: ${meta.title} - ${e.message}`);
      });

    return {
      handled: true,
      mode: 'video',
      url: parsed.url,
      platform: parsed.platform,
      queued: true,
      title: meta.title,
      reply: startedReply,
    };
  }

  function buildDoneReply(meta, result) {
    const a = result.analysis || {};
    const lines = [`✅ 已拆解并写入飞书表格：《${meta.title}》`];
    if (a['内容类型']) lines.push(`内容类型：${a['内容类型']}`);
    lines.push(`素材等级：${result.level === 'L1' ? '低（标题级分析）' : (a['素材等级'] || '待分析')}`);
    if (a['开头钩子']) lines.push(`开头钩子：${a['开头钩子']}`);
    if (a['换角度再写']) lines.push(`换角度再写：${a['换角度再写']}`);
    if (a['选题建议']) lines.push(`选题建议：${a['选题建议']}`);
    lines.push('（完整 7 维拆解见多维表格）');
    return lines.join('\n');
  }

  /**
   * collectImageText(text, { wait })
   * 图片 OCR 文本走视频同款拆解流程，写入飞书视频表（来源=图片，无链接）
   * - wait=false（默认）：立即回执，后台跑
   * - wait=true：同步等结果
   */
  async function collectImageText(text, options) {
    const opt = options || {};
    const clean = String(text || '').trim();
    if (!clean) return { handled: false, error: '图片未识别出文字' };

    if (!isReady()) {
      return {
        handled: true,
        mode: 'video-image',
        reply: '视频/图片收录功能未启用。请在 .env 配置 LARK_BASE_TOKEN 与 LARK_VIDEO_TABLE_ID 后重启服务。',
      };
    }

    const firstLine = clean.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || clean;
    const meta = {
      platform: 'image',
      title: firstLine.slice(0, 30),
      author: '',
      duration: '',
      url: '',
      description: clean.slice(0, 500),
      subtitle_text: clean,
    };

    const run = async () => {
      try {
        const result = await runPipeline(meta, null);
        return {
          handled: true,
          mode: 'video-image',
          ok: true,
          reply: buildDoneReply(meta, result),
          recordId: result.recordId,
          level: result.level,
        };
      } catch (e) {
        return { handled: true, mode: 'video-image', ok: false, error: e.message };
      }
    };

    if (opt.wait) return run();
    // 后台跑，先给回执
    run().catch(() => {});
    return {
      handled: true,
      mode: 'video-image',
      queued: true,
      reply: '📷 图片文字已识别，正在做爆款拆解并写入飞书表格，稍等可在表格查看。',
    };
  }

  return {
    parseVideoUrl,
    isReady,
    collect,
    collectImageText,
    commentOnVideo,
    listRecentVideos,
    listVideosRich,
    // 暴露给测试
    _runExtractor: runExtractor,
    _analyzeWithDeepSeek: analyzeWithDeepSeek,
    _findRecordByUrl: findRecordByUrl,
  };
}

module.exports = { createVideoIntake, parseVideoUrl, PLATFORM_NAMES };
