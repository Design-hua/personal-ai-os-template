// lib/douyin-fetch.js
// 抖音完整链路：容器内 Chromium（真实浏览器指纹过风控）→ 提取播放直链 → 下载 → ffmpeg 提音频 → ASR 转写
//
// 背景：抖音 Web API 查 TLS 指纹，yt-dlp（最新版+真实 cookies+UA 伪装）均被拦；
//       但真实浏览器匿名访问视频页可从 video 元素拿到签名 CDN 直链，
//       且 CDN 下载不查指纹（纯 HTTP 206 即可），Mac 与 NAS 同公网 IP 时直链通用。
// 依赖：容器内 apk 安装的 chromium（musl 原生）+ ffmpeg + npm 包 playwright-core（纯 JS）

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const DOWNLOAD_MAX_BYTES = 400 * 1024 * 1024; // 400MB 上限保护

// Mac 侧直链共享表：dy-harvest-mac.js（真实 Chrome）采集后写入，容器【只读】
// SMB 双端同写一个文件会产生撕裂内容，故采用单向文件流：
//   容器 → Mac 的请求走 dy-requests/<视频ID>.json（每视频一个文件，容器唯一写、Mac 采集后删）
//   Mac → 容器的结果走 dy-playmap.json（Mac 唯一写、容器只读+内存去重）
const PLAYMAP_FILE = path.join(__dirname, '..', 'skills', 'video-summarizer', 'dy-playmap.json');
const REQUESTS_DIR = path.join(__dirname, '..', 'skills', 'video-summarizer', 'dy-requests');
const PLAYMAP_TTL_MS = 2 * 3600 * 1000; // CDN 直链含时间签名会过期，2 小时内有效

// 临时分段取证日志（写挂载目录，Mac 侧可读）；定位容器自采中途断连问题后可移除
const DEBUG_LOG = path.join(__dirname, '..', 'skills', 'video-summarizer', 'selfcheck-debug.log');
function dbg(stage, extra) {
  try {
    let mem = '';
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const mav = mi.match(/MemAvailable:\s+(\d+)/);
      mem = ` memAvail=${mav ? Math.round(Number(mav[1]) / 1024) + 'MB' : '?'}`;
    } catch (e) { /* 非容器环境无 /proc */ }
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${stage}${mem}${extra ? ' ' + extra : ''}\n`);
  } catch (e) { /* ignore */ }
}

function readPlayEntry(videoId) {
  try {
    const map = JSON.parse(fs.readFileSync(PLAYMAP_FILE, 'utf8'));
    const e = map && map[videoId];
    if (!e || e.status !== 'ok' || !e.playUrl) return null;
    // blob: 直链只在采集它的 Mac 浏览器页面内有效，容器无法下载 → 视为无效缓存
    if (!/^https?:\/\//.test(e.playUrl) || /^blob:/.test(e.playUrl)) return null;
    const t = Date.parse(e.harvestedAt || '');
    if (!isFinite(t) || Date.now() - t > PLAYMAP_TTL_MS) return null;
    return e;
  } catch (e) {
    return null;
  }
}

/** 清掉失效的缓存条目（直链签名被吊销时容器自愈用；原子写防撕裂，Mac 关机时由容器安全维护） */
function purgePlayEntry(videoId) {
  if (!videoId) return;
  try {
    const map = JSON.parse(fs.readFileSync(PLAYMAP_FILE, 'utf8'));
    if (!map[videoId]) return;
    delete map[videoId];
    const tmp = PLAYMAP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, PLAYMAP_FILE);
  } catch (e) { /* 读不到/写失败不影响主流程 */ }
}

/** 容器浏览器取直链失败 → 写独立请求文件，Mac 侧 dy-watch-mac.js 监视器自动采集后删除 */
function writePendingEntry(videoId, url) {
  if (!videoId) return;
  try {
    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    const file = path.join(REQUESTS_DIR, `${videoId}.req`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ videoId, url, requestedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { /* 请求文件写失败不影响主流程报错 */ }
}

// ---------- 依赖可用性 ----------

/**
 * Xvfb 虚拟显示器自愈（容器独立过抖音风控的关键）：
 * pidfile+/proc 验证存活 → 没活就 spawn 一个，等 socket 就绪后返回 ':99'；
 * 环境里没有 Xvfb（如 Mac 本地）或显式 DY_HEADLESS=1 时返回 ''（退化为无头）。
 */
function ensureXvfb() {
  return new Promise((resolve) => {
    if (process.env.DY_HEADLESS === '1') return resolve('');
    const alive = (pid) => {
      try {
        return pid
          && fs.existsSync(`/proc/${pid}/comm`)
          && fs.readFileSync(`/proc/${pid}/comm`, 'utf8').includes('Xvfb');
      } catch (e) { return false; }
    };
    try {
      const oldPid = parseInt(fs.readFileSync('/tmp/xvfb.pid', 'utf8').trim(), 10);
      if (alive(oldPid)) return resolve(':99');
    } catch (e) { /* 无 pidfile */ }
    const { spawn, execFileSync } = require('child_process');
    let installed = false;
    try { execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }); installed = true; } catch (e) { installed = false; }
    if (!installed) return resolve('');
    let child;
    try {
      fs.mkdirSync('/tmp/.X11-unix', { recursive: true });
      try { fs.unlinkSync('/tmp/.X11-unix/X99'); } catch (e) { /* 残留 socket 清理 */ }
      const outFd = fs.openSync('/tmp/xvfb.log', 'a');
      child = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
        detached: true, stdio: ['ignore', outFd, outFd],
      });
      child.unref();
      fs.writeFileSync('/tmp/xvfb.pid', String(child.pid));
    } catch (e) { return resolve(''); }
    let tries = 0;
    const tick = () => {
      if (alive(child.pid) && fs.existsSync('/tmp/.X11-unix/X99')) return resolve(':99');
      if (++tries >= 25) return resolve(''); // 最多等 5 秒，等不到就退化为无头，不阻塞主流程
      setTimeout(tick, 200);
    };
    setTimeout(tick, 200);
  });
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH || '',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/headless-shell',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (e) {
      /* 尝试下一个 */
    }
  }
  return null;
}

/** { ok, reason } — chromium + playwright-core + ffmpeg 是否就绪 */
function isAvailable() {
  if (!findChromium()) return { ok: false, reason: '容器内未安装 Chromium' };
  try {
    require('playwright-core');
  } catch (e) {
    return { ok: false, reason: 'playwright-core 未安装' };
  }
  return { ok: true, reason: '' };
}

function ffmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function hasFfmpeg() {
  return Boolean(findChromium()); // ffmpeg 与 chromium 由 ensure-python.sh 一并安装；这里只做粗判
}

// ---------- 真实浏览器 cookies 注入（过无声 NoCaptcha 风控验证） ----------

const DOUYIN_COOKIES_FILE = path.join(__dirname, '..', 'skills', 'video-summarizer', 'www.douyin.com_cookies.txt');

/** 解析 Netscape 格式 cookies 文件 → playwright addCookies 数组（仅 douyin 域） */
function loadDouyinCookies() {
  try {
    const raw = fs.readFileSync(DOUYIN_COOKIES_FILE, 'utf8');
    const cookies = [];
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const c = line.split('\t').map((s) => s.trim());
      if (c.length < 7) continue;
      const [domain, , cookiePath, secure, expiry, name, value] = c;
      if (!/douyin/.test(domain)) continue;
      cookies.push({
        name,
        value,
        domain: domain.startsWith('.') ? domain : domain,
        path: cookiePath || '/',
        expires: Number(expiry) > 0 ? Number(expiry) : -1,
        secure: secure === 'TRUE',
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
    return cookies;
  } catch (e) {
    return [];
  }
}

// ---------- 第一步：浏览器拿直链 ----------

/**
 * 打开抖音视频页，等播放器加载，提取直链与元信息
 * @param {string} url 短链或完整视频页链接
 * @param {object} opts { skipCache: 忽略共享直链表缓存强制现采 }
 * @returns {Promise<{playUrl, title, durationSec, fromCache}>}
 */
async function fetchPlayInfo(url, opts) {
  const o = opts || {};
  dbg('BEGIN', String(url).slice(0, 80));
  // 短链 → 桌面版视频页（headless 直开分享页常只加载占位播放器）；顺带解析出视频ID
  let pageUrl = url;
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    const loc = r.headers.get('location') || '';
    const m = loc.match(/\/video\/(\d+)/);
    if (m) pageUrl = `https://www.douyin.com/video/${m[1]}`;
  } catch (e) { /* 解析失败就用原链接 */ }

  // 共享直链表命中（Mac 真实 Chrome 采集、2 小时内）→ 跳过容器浏览器
  const vid = (String(pageUrl).match(/\/video\/(\d+)/) || [])[1] || '';
  if (vid && !o.skipCache) {
    const cached = readPlayEntry(vid);
    if (cached) {
      return { playUrl: cached.playUrl, playUrls: [cached.playUrl], title: cached.title || '', durationSec: 0, subtitleText: '', fromCache: true, videoId: vid };
    }
  }

  const avail = isAvailable();
  if (!avail.ok) {
    writePendingEntry(vid, pageUrl); // 交 Mac 侧采集
    throw new Error(avail.reason);
  }
  const { chromium } = require('playwright-core');
  const executablePath = findChromium();

  // Xvfb 存活真实验证 + 运行时自愈：进程没了就立刻拉起（不依赖容器重启）
  const xvfbDisplay = await ensureXvfb();
  dbg('XVFB', xvfbDisplay || 'headless');
  const launchArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--mute-audio',
    // headless 下自动播放默认受限，播放器不加载视频就没有 currentSrc
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
  ];
  // 持久化浏览器画像：设备指纹/uifid/ttwid 跨次访问保持稳定（养环境，降低风控升级概率）
  const PROFILE_DIR = process.env.DY_PROFILE_DIR || '/tmp/dy-profile';
  const contextOpts = {
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  };
  let context;
  let browser;
  let persistent = true;
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath,
      headless: !xvfbDisplay,
      env: xvfbDisplay ? { ...process.env, DISPLAY: xvfbDisplay } : process.env,
      args: launchArgs,
      ...contextOpts,
    });
  } catch (e) {
    dbg('PROFILE_FAIL', String(e.message).slice(0, 100));
    // 画像被占用（并发）或损坏 → 退回一次性上下文，别中断
    persistent = false;
    let browser2;
    try {
      browser2 = await chromium.launch({
        executablePath,
        headless: !xvfbDisplay,
        env: xvfbDisplay ? { ...process.env, DISPLAY: xvfbDisplay } : process.env,
        args: launchArgs,
      });
    } catch (e3) {
      dbg('LAUNCH_FAIL', String(e3.message).slice(0, 120));
      if (xvfbDisplay && /XServer|X server|closed|Target/i.test(String(e3.message))) {
        browser2 = await chromium.launch({ executablePath, headless: true, env: process.env, args: launchArgs });
      } else throw e3;
    }
    context = await browser2.newContext(contextOpts);
    browser = browser2;
  }
  dbg('LAUNCH_OK', 'profile=' + (persistent ? 'persistent' : 'ephemeral'));
  browser = context; // 持久化上下文自带 close；一次性模式下为 Browser，finally 统一 close
  try {
    // 隐藏 webdriver 自动化特征
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
    // 注入真实浏览器 cookies（关键：无声 NoCaptcha 风控凭 __ac_signature 等放行）
    const dyCookies = loadDouyinCookies();
    if (dyCookies.length) {
      await context.addCookies(dyCookies).catch(() => {});
    }
    const page = (context.pages && context.pages()[0]) || (await context.newPage());

    // 网络层捕获真实 CDN 直链（播放器被拦但 API 已预取时的兜底）+ 关键 API 响应日志
    let netCdnUrl = '';
    const apiLog = [];
    // 【get笔记式首选路线】截获抖音页面【自己合法签名】请求成功的 aweme/detail 响应：
    // 页面自身的请求带合法 a_bogus/msToken，风控对其放行（实测播放器被验证码拦住时该接口仍 200）。
    // waiter 可重新武装：首次没等到就 reload 再来一轮（应对偶发风控升级）。
    let detailFound = null;
    let detailWaiter = null;
    const armDetail = () => {
      if (detailFound || detailWaiter) return;
      detailWaiter = {};
      detailWaiter.promise = new Promise((res) => { detailWaiter.resolve = res; });
    };
    armDetail();
    page.on('response', (resp) => {
      try {
        const u = resp.url();
        if (!netCdnUrl && resp.status() === 200 && /douyinvod|zjcdn|aweme\.snssdk\.com\/aweme\/v1\/play/.test(u)) {
          netCdnUrl = u;
        }
        if (!detailFound && /aweme\/v1\/web\/aweme\/detail/.test(u)) {
          resp.json()
            .then((j) => {
              if (j && j.aweme_detail) {
                detailFound = j.aweme_detail;
                if (detailWaiter) detailWaiter.resolve(detailFound);
              }
            })
            .catch(() => {});
        }
        if (/aweme\/v1\/(web\/)?(aweme\/detail|general\/search|web\/general)|verify|captcha/.test(u) && apiLog.length < 6) {
          apiLog.push(`${resp.status()} ${u.replace(/^https?:\/\//, '').slice(0, 90)}`);
        }
      } catch (e) { /* ignore */ }
    });

    // 预热：先逛首页养设备状态，再进视频页（降低数据接口被风控直接拦掉的概率）
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.mouse.move(400, 300).catch(() => {});
    await page.mouse.move(700, 450).catch(() => {});

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    dbg('GOTO_OK');

    // 关登录弹窗（多轮尝试，失败不阻塞）
    const closePopups = async (rounds) => {
      for (let i = 0; i < rounds; i++) {
        await page.waitForTimeout(1000);
        const closed = await page
          .evaluate(() => {
            const sels = ['[aria-label="关闭"]', '[class*="login-close"]', '[class*="dy-account-close"]', '[data-e2e="login-close"]'];
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) { el.click(); return s; }
            }
            return null;
          })
          .catch(() => null);
        await page.keyboard.press('Escape').catch(() => {});
        if (!closed) break;
      }
    };
    await closePopups(3);
    dbg('POPUP_DONE');

    const waitDetail = async (ms) => {
      if (detailFound) return detailFound;
      return Promise.race([
        detailWaiter.promise,
        new Promise((res) => setTimeout(() => res(null), ms)),
      ]);
    };

    // —— 首选：页面自身签名的 detail 响应（无需播放器过验证码）——
    let detail = await waitDetail(18000);
    if (!detail) {
      // 首轮没截获（偶发风控）→ 重新武装后刷新页面再等一轮
      dbg('DETAIL_RELOAD_RETRY');
      detailWaiter = null;
      armDetail();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await closePopups(2);
      detail = await waitDetail(18000);
    }

    if (detail && detail.video) {
      const dv = detail.video || {};
      const urls = [];
      for (const u of (dv.play_addr && dv.play_addr.url_list) || []) {
        if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
      }
      // 码率档位作为备选直链（主地址失效时依次重试）
      for (const br of dv.bit_rate || []) {
        for (const u of ((br.play_addr && br.play_addr.url_list) || [])) {
          if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
        }
      }
      if (urls.length) {
        const t = await page.evaluate(() => {
          let title = document.title || '';
          for (const m of document.querySelectorAll('meta[property="og:title"], meta[name="title"]')) {
            const c = (m.content || '').trim();
            if (c.length > title.length) title = c;
          }
          return title.replace(/\s*[|｜-]\s*抖音.*$/, '').replace(/\s*[-|]\s*抖音\s*$/, '').trim();
        }).catch(() => '');
        const subtitleText = await fetchOfficialSubtitle(dv).catch(() => '');
        dbg('DETAIL_OK', `urls=${urls.length} sub=${subtitleText ? 'Y' : 'N'}`);
        return {
          playUrl: urls[0],
          playUrls: urls,
          title: t || String(detail.desc || '').slice(0, 80),
          durationSec: Number(dv.duration) > 1000 ? Math.round(Number(dv.duration) / 1000) : 0,
          subtitleText,
          fromCache: false,
          videoId: vid,
        };
      }
      dbg('DETAIL_NO_URL');
    } else {
      dbg('DETAIL_MISS');
    }

    // —— 兜底1：等真实播放直链（排除抖音占位素材 douyinstatic 的 uuu_*.mp4 加载动画）——
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        const src = (v && (v.currentSrc || v.src)) || '';
        return /douyinvod|zjcdn|aweme|snssdk|v1\/play/.test(src);
      },
      { timeout: 60000 }
    ).catch(() => {});
    dbg('WAIT_SRC_DONE', 'net=' + (netCdnUrl ? 'Y' : 'N'));

    const info = await page.evaluate(() => {
      const v = document.querySelector('video');
      let src = v ? (v.currentSrc || v.src) : '';
      // 占位加载动画不是真实视频（douyinstatic 的 uuu_*.mp4），当作没拿到
      if (/douyinstatic|\/uuu_/.test(src)) src = '';
      let title = document.title || '';
      for (const m of document.querySelectorAll('meta[property="og:title"], meta[name="title"]')) {
        const c = (m.content || '').trim();
        if (c.length > title.length) title = c;
      }
      return {
        playUrl: src,
        durationSec: v && isFinite(v.duration) ? Math.round(v.duration) : 0,
        title: title.replace(/\s*[|｜-]\s*抖音.*$/, '').replace(/\s*[-|]\s*抖音\s*$/, '').trim(),
      };
    });

    const playUrl = info.playUrl || netCdnUrl;
    dbg('EVAL_DONE', `src=${info.playUrl ? 'Y' : 'N'} net=${netCdnUrl ? 'Y' : 'N'}`);
    if (!playUrl) {
      dbg('NO_SRC_THROW');
      writePendingEntry(vid, pageUrl); // 交 Mac 侧采集
      // 失败诊断：截图 + cookie/登录态/API 响应摘要；写 /tmp 防止触发 nodemon 重启
      const ck = await context.cookies().catch(() => []);
      const ckNames = ck.map((c) => c.name);
      const loginState = ckNames.includes('sessionid') ? '已登录' : '未登录';
      const bodyText = await page
        .evaluate(() => String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200))
        .catch(() => '');
      await page
        .screenshot({ path: '/tmp/dy-fetch-fail.png', fullPage: false })
        .catch(() => {});
      const apiBrief = apiLog.slice(0, 4).join(' | ');
      throw new Error(
        `未取得真实播放直链 [cookies=${ck.length} ${loginState}${dyCookies.length ? ',注入' + dyCookies.length : ',未注入'}]` +
        `[标题="${(info.title || document.title || '').slice(0, 40)}"] [正文=${bodyText.slice(0, 100)}]` +
        (apiBrief ? ` [API=${apiBrief}]` : '')
      );
    }
    dbg('SUCCESS', String(playUrl).slice(0, 80));
    const playUrls = [playUrl];
    if (netCdnUrl && !playUrls.includes(netCdnUrl)) playUrls.push(netCdnUrl);
    return { playUrl, playUrls, title: info.title, durationSec: info.durationSec, subtitleText: '', fromCache: false, videoId: vid };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 官方字幕（轻抖"提文案"同款：有官方字幕就免下载免ASR） ----------

/** 把抖音字幕内容（JSON / SRT / VTT / 纯文本）清洗成纯文字稿 */
function parseSubtitleText(raw) {
  const s = String(raw || '');
  if (!s.trim()) return '';
  // JSON 结构：递归收集所有 text/Text 字段
  if (s.trim().startsWith('{') || s.trim().startsWith('[')) {
    try {
      const parts = [];
      const walk = (o) => {
        if (o == null) return;
        if (typeof o === 'string') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (typeof o === 'object') {
          for (const [k, v] of Object.entries(o)) {
            if ((k === 'text' || k === 'Text' || k === 'content') && typeof v === 'string' && v.trim()) {
              parts.push(v.trim());
            } else if (typeof v === 'object') {
              walk(v);
            }
          }
        }
      };
      walk(JSON.parse(s));
      if (parts.length) return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) { /* 不是合法JSON，按文本处理 */ }
  }
  // SRT/VTT：去序号、时间轴、标签
  return s
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\d+$/.test(t)) return false;
      if (/\d{2}:\d{2}[.,:]/.test(t) && /-->/.test(t)) return false;
      if (/^WEBVTT/i.test(t) || /^Kind:|^Language:/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** 从 detail.video 提取官方字幕文字（无字幕返回 ''） */
async function fetchOfficialSubtitle(video) {
  const subs = video.subtitleInfos || video.subtitle_infos || [];
  let best = '';
  for (const sub of subs) {
    const rawUrl = sub.Url || sub.url || sub.SubtitleUrl || '';
    if (!rawUrl) continue;
    const surl = rawUrl.startsWith('http') ? rawUrl : `https:${rawUrl.startsWith('//') ? rawUrl : '//' + rawUrl}`;
    try {
      const r = await fetch(surl, {
        headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) continue;
      const text = parseSubtitleText(await r.text());
      // 优先中文、其次更长的
      const lang = String(sub.LanguageCodeName || sub.language || '').toLowerCase();
      if (text.length > best.length || (/zh|cn/i.test(lang) && text.length >= best.length * 0.5)) best = text;
    } catch (e) { /* 单条字幕失败不阻塞 */ }
  }
  return best.length >= 20 ? best : '';
}

// ---------- 第二步：下载 ----------

/** 流式下载直链到临时文件（带 UA/Referer 与大小上限），返回 { filePath, bytes } */
async function downloadMedia(playUrl, destDir) {
  const dir = destDir || os.tmpdir();
  const filePath = path.join(dir, `dy_${Date.now()}.mp4`);
  const resp = await fetch(playUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
    signal: AbortSignal.timeout(180000),
  });
  if (!resp.ok || !resp.body) throw new Error(`CDN 下载失败: HTTP ${resp.status}`);

  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared && declared > DOWNLOAD_MAX_BYTES) throw new Error(`文件过大(${Math.round(declared / 1048576)}MB)，超出处理上限`);

  const out = fs.createWriteStream(filePath);
  let bytes = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > DOWNLOAD_MAX_BYTES) {
      reader.cancel().catch(() => {});
      out.destroy();
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      throw new Error('文件超过 400MB 上限，已中止');
    }
    if (!out.write(Buffer.from(value))) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
  if (bytes < 10000) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    throw new Error(`下载内容异常（仅 ${bytes} 字节）`);
  }
  return { filePath, bytes };
}

// ---------- 第三步：ffmpeg 提音频 ----------

function execFileP(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs || 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).slice(-300)));
      else resolve(stdout);
    });
  });
}

/** 提取压缩音频（供 ASR 上传）：mp3 → m4a(aac) → wav 逐级尝试，返回 { filePath, ext, mime } */
async function extractAudio(inputPath, destDir) {
  const dir = destDir || os.tmpdir();
  const base = path.join(dir, `dy_${Date.now()}`);
  const attempts = [
    { args: ['-codec:a', 'libmp3lame', '-b:a', '48k'], ext: 'mp3', mime: 'audio/mpeg' },
    { args: ['-codec:a', 'aac', '-b:a', '48k'], ext: 'm4a', mime: 'audio/mp4' },
    { args: ['-acodec', 'pcm_s16le'], ext: 'wav', mime: 'audio/wav' },
  ];
  let lastErr = '';
  for (const a of attempts) {
    const outPath = `${base}.${a.ext}`;
    try {
      await execFileP(
        ffmpegBin(),
        ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', ...a.args, outPath],
        180000
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        return { filePath: outPath, ext: a.ext, mime: a.mime };
      }
      lastErr = `${a.ext} 输出异常`;
    } catch (e) {
      lastErr = e.message;
      try { fs.unlinkSync(outPath); } catch (e2) { /* ignore */ }
    }
  }
  throw new Error('ffmpeg 提取音频失败: ' + lastErr);
}

// ---------- 关键帧理解（P1）与长音频分段（P2）----------

// 超过此时长（秒）的音频按段切分后逐段转写，避免整段上传超限/超时
const LONG_AUDIO_SEC = 20 * 60;
const FRAME_COUNT = 8;   // 每条视频均匀抽 8 帧
const FRAME_WIDTH = 480; // 压缩到 480 宽，控 base64 体积

const FRAME_PROMPT = `下面按时间先后顺序给了一条短视频的若干张关键帧截图。请只依据画面，逐帧极简列出对"理解视频内容、做创作拆解"有用的信息：画面上出现的标题条、字幕或关键词、数据数字、书名/产品名、图表或幻灯片要点，以及人物动作与场景。
要求：
- 用"第1帧：…"格式逐条写，每帧 1-2 行；没有实质文字就一句话描述画面
- 画面上的文字按原样抄，数字、人名、书名不要猜
- 不要客套、不要整体总结、不要讲画面之外的内容`;

// 不带"非零码即 reject"的 exec，拿完整 stderr（ffmpeg -i 正常情况下也返回 1）
function execFileRaw(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
    });
  });
}

// 用 ffmpeg -i 的 stderr 解析时长（秒）；失败返回 0
async function probeDuration(filePath) {
  try {
    const { stderr } = await execFileRaw(ffmpegBin(), ['-hide_banner', '-i', filePath]);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch (e) {
    return 0;
  }
}

// 均匀抽 n 张 jpg 关键帧（不依赖 ffprobe，按 fps 滤波器）；返回生成的文件路径
async function extractFrames(videoPath, durationSec) {
  const dir = os.tmpdir();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const pattern = path.join(dir, `dyf_${stamp}_%02d.jpg`);
  const dur = Number(durationSec) > 1 ? Number(durationSec) : 0;
  // 已知时长→均匀分布；未知时长→每 15 秒一帧兜底
  const rate = dur > 0 ? (FRAME_COUNT / dur).toFixed(5) : (1 / 15).toFixed(5);
  const args = [
    '-y', '-i', videoPath,
    '-vf', `fps=${rate},scale=${FRAME_WIDTH}:-2`,
    '-frames:v', String(FRAME_COUNT),
    '-q:v', '4',
    pattern,
  ];
  await execFileRaw(ffmpegBin(), args, 180000);
  // ffmpeg %02d 从 1 还是 0 开始不保证，直接按前缀扫目录
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`dyf_${stamp}_`) && f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try { return fs.statSync(f).size > 3000; } catch (e) { return false; }
    });
  return files.slice(0, FRAME_COUNT);
}

// 抽帧 → 多模态一次识别；任何失败返回空串（绝不影响转写主流程）
async function recognizeVideoFrames(videoPath, durationSec, vision) {
  if (!vision || typeof vision.recognizeMany !== 'function') return { text: '', count: 0 };
  let frames = [];
  try {
    frames = await extractFrames(videoPath, durationSec);
    if (!frames.length) return { text: '', count: 0 };
  } catch (e) {
    return { text: '', count: 0 };
  }
  try {
    const images = frames.map((f) => ({ base64: fs.readFileSync(f).toString('base64'), mimeType: 'image/jpeg' }));
    const text = await vision.recognizeMany(images, FRAME_PROMPT);
    return { text: String(text || '').trim(), count: frames.length };
  } catch (e) {
    console.log('[douyin-fetch] 关键帧识别失败（不影响转写）: ' + String(e.message).slice(0, 120));
    return { text: '', count: frames.length };
  } finally {
    for (const f of frames) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  }
}

// 转写音频：短的整段上传；超 20 分钟用 ffmpeg 分段（-c copy 快速无损切）后逐段转写拼接
async function transcribeAudioLong(audioPath, asr, meta) {
  const m = meta || {};
  const ext = m.ext || 'mp3';
  const mime = m.mime || 'audio/mpeg';
  const dur = Number(m.durationSec) > 0 ? Number(m.durationSec) : await probeDuration(audioPath);

  if (!dur || dur <= LONG_AUDIO_SEC) {
    const text = await asr.transcribe(fs.readFileSync(audioPath), `recording.${ext}`, { mimeType: mime });
    return { text: String(text || ''), segments: 1, durationSec: dur };
  }

  const dir = path.dirname(audioPath);
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const segPattern = path.join(dir, `dyseg_${stamp}_%03d.${ext}`);
  const { stderr, code } = await execFileRaw(
    ffmpegBin(),
    ['-y', '-i', audioPath, '-f', 'segment', '-segment_time', String(LONG_AUDIO_SEC), '-c', 'copy', '-loglevel', 'error', segPattern],
    180000
  );
  if (code !== 0) throw new Error('长音频分段失败: ' + stderr.slice(-200));

  const segFiles = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`dyseg_${stamp}_`) && f.endsWith('.' + ext))
    .sort()
    .map((f) => path.join(dir, f));
  if (!segFiles.length) throw new Error('长音频分段后未生成片段');

  console.log(`[douyin-fetch] 音频 ${Math.round(dur)}s，分 ${segFiles.length} 段逐段转写…`);
  const texts = [];
  for (let i = 0; i < segFiles.length; i++) {
    const sf = segFiles[i];
    try {
      const t = await asr.transcribe(fs.readFileSync(sf), `seg_${i}.${ext}`, { mimeType: mime });
      texts.push(String(t || '').trim());
      console.log(`[douyin-fetch] 段 ${i + 1}/${segFiles.length} 完成 ${texts[texts.length - 1].length} 字`);
    } finally {
      try { fs.unlinkSync(sf); } catch (e) { /* ignore */ }
    }
  }
  return { text: texts.join(''), segments: segFiles.length, durationSec: dur };
}

// ---------- 主入口 ----------

/**
 * 抖音链接 → 文字稿（完整链路，内部处理下载与临时文件清理）
 * @param {string} url
 * @param {object} o { asr: {transcribe}, keepTemp: bool }
 * @returns {Promise<{title, durationSec, transcript, bytes, audioBytes}>}
 */
async function collectTranscript(url, o) {
  const opt = o || {};
  if (!opt.asr || typeof opt.asr.transcribe !== 'function') throw new Error('未接入 ASR 模块');

  let info = await fetchPlayInfo(url);
  // videoId 由 fetchPlayInfo 解析（短链也会在内部重定向为 /video/<id>），自愈重试要用
  const vid = info.videoId || (String(url).match(/\/video\/(\d+)/) || [])[1] || '';

  // 官方字幕直通：有字幕就免去下载+ASR（轻抖"提文案"同款），并清理可能遗留的临时文件
  if (info.subtitleText) {
    return {
      title: info.title || '',
      durationSec: info.durationSec || 0,
      transcript: info.subtitleText,
      bytes: 0,
      audioBytes: 0,
      fromOfficialSubtitle: true,
    };
  }

  let media = null;
  let audio = null;
  try {
    // 依次尝试 detail 给出的多个直链；缓存直链失效则清缓存重新现采后再试
    const candidates = () => (info.playUrls && info.playUrls.length ? info.playUrls : [info.playUrl]).filter(Boolean);
    let lastErr = null;
    const tryDownloads = async () => {
      for (const u of candidates()) {
        try {
          return await downloadMedia(u);
        } catch (e) {
          lastErr = e;
          console.log(`[douyin-fetch] 直链下载失败(${String(e.message).slice(0, 60)})，尝试下一个地址`);
        }
      }
      throw lastErr || new Error('无可用直链');
    };
    try {
      media = await tryDownloads();
    } catch (dlErr) {
      // 缓存直链被吊销 → 清掉 Mac 共享缓存，容器浏览器现采重试一次
      const transient = /HTTP \d{3}|timeout|aborted|下载内容异常|无可用直链/.test(String(dlErr.message));
      if (!info.fromCache || !transient) {
        // 非缓存来源也自愈一次：detail 直链偶发签名过期，重新开页面截获
        if (!transient) throw dlErr;
        console.log('[douyin-fetch] 全部直链失败，重新开页面现采重试一次');
        info = await fetchPlayInfo(url, { skipCache: true });
        media = await tryDownloads();
      } else {
        console.log(`[douyin-fetch] 缓存直链下载失败(${String(dlErr.message).slice(0, 60)})，清缓存后容器自采重试`);
        purgePlayEntry(vid);
        info = await fetchPlayInfo(url, { skipCache: true });
        media = await tryDownloads();
      }
    }
    audio = await extractAudio(media.filePath);

    // 语音转写（长音频自动分段）与 关键帧视觉理解 并行；帧识别失败不影响转写
    const videoDur = Number(info.durationSec) > 0 ? Number(info.durationSec) : 0;
    const [asrResult, frameResult] = await Promise.allSettled([
      transcribeAudioLong(audio.filePath, opt.asr, { ext: audio.ext, mime: audio.mime, durationSec: videoDur }),
      recognizeVideoFrames(media.filePath, videoDur, opt.vision),
    ]);
    if (asrResult.status !== 'fulfilled') throw asrResult.reason instanceof Error ? asrResult.reason : new Error('ASR 转写失败');
    const transcript = asrResult.value.text || '';
    const frameText = frameResult.status === 'fulfilled' ? (frameResult.value.text || '') : '';
    const frameCount = frameResult.status === 'fulfilled' ? (frameResult.value.count || 0) : 0;

    return {
      title: info.title || '',
      durationSec: asrResult.value.durationSec || videoDur,
      transcript: String(transcript || ''),
      frameText,
      frameCount,
      segments: asrResult.value.segments || 1,
      bytes: media.bytes,
      audioBytes: fs.existsSync(audio.filePath) ? fs.statSync(audio.filePath).size : 0,
    };
  } finally {
    for (const f of [media && media.filePath, audio && audio.filePath]) {
      if (f && !opt.keepTemp) {
        try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = { isAvailable, hasFfmpeg, findChromium, ensureXvfb, loadDouyinCookies, readPlayEntry, purgePlayEntry, writePendingEntry, fetchPlayInfo, downloadMedia, extractAudio, collectTranscript, probeDuration, extractFrames, transcribeAudioLong };
