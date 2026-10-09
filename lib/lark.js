// lib/lark.js
// 飞书开放平台客户端：OAuth v3 令牌管理 + 日历/任务/妙记/消息 API 封装
// 仅使用 Node 18 内置能力（fetch / crypto / URL），零新增依赖。
//
// 端点均依据 2026-09 飞书官方文档核实：
// - 授权页:   GET  https://accounts.feishu.cn/open-apis/authen/v1/authorize
// - 令牌端点: POST https://accounts.feishu.cn/oauth/v3/token (RFC6749 风格, v3)
// - 应用令牌: POST /open-apis/auth/v3/tenant_access_token/internal
// - 用户信息: GET  /open-apis/authen/v1/user_info
// - 主日历:   GET  /open-apis/calendar/v4/calendars/primary
// - 日程列表: GET  /open-apis/calendar/v4/calendars/:id/events (start_time/end_time 为秒)
// - 我的任务: GET  /open-apis/task/v2/tasks?completed=false
// - 妙记搜索: POST /open-apis/minutes/v1/minutes/search (时间为毫秒)
// - 妙记产物: GET  /open-apis/minutes/v1/minutes/:token/artifacts -> minute_todos
// - 发消息:   POST /open-apis/im/v1/messages?receive_id_type=open_id

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPEN_HOST = 'https://open.feishu.cn';
const ACCOUNTS_HOST = 'https://accounts.feishu.cn';

// 默认申请的用户授权 scope。如接口报 missing_scopes，可通过环境变量
// LARK_OAUTH_SCOPES 覆盖（空格分隔），无需改代码。
const DEFAULT_SCOPES = [
  'calendar:calendar.event:read', // 日历日程只读
  'task:task:read', // 任务只读
  'minutes:minutes.search:read', // 妙记搜索
  'minutes:minutes:readonly', // 妙记内容/AI 产物只读
  'contact:user.base:readonly', // 获取本人 open_id
  'bitable:app', // 多维表格读写（视频灵感收录）
  'offline_access', // 必须：换取 refresh_token
].join(' ');

class LarkApiError extends Error {
  constructor(message, code, scopes) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.missingScopes = scopes;
  }
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function createLarkClient(options) {
  const cfg = {
    appId: options.appId || '',
    appSecret: options.appSecret || '',
    redirectBase: (options.redirectBase || '').replace(/\/+$/, ''),
    tokenFile: options.tokenFile,
    stateFile: options.stateFile,
    scopes: (options.scopes || DEFAULT_SCOPES).trim(),
  };

  // 授权 state：内存暂存（10 分钟有效）。容器重启后旧链接失效，重新点授权即可。
  const pendingStates = new Map();

  let tenantCache = { token: '', expireAt: 0 };
  let primaryCalendarId = '';

  // ---------- token 文件 ----------

  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(cfg.tokenFile, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function writeStore(data) {
    fs.mkdirSync(path.dirname(cfg.tokenFile), { recursive: true });
    fs.writeFileSync(cfg.tokenFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  function writeState(patch) {
    const cur = readState();
    const next = Object.assign({}, cur, patch);
    fs.writeFileSync(cfg.stateFile, JSON.stringify(next, null, 2), 'utf8');
  }

  // ---------- 状态查询 ----------

  function isConfigured() {
    return Boolean(cfg.appId && cfg.appSecret && cfg.redirectBase);
  }

  function getStatus() {
    const store = readStore();
    const state = readState();
    const now = Date.now();
    const authorized = Boolean(store && store.accessToken);
    const needReauth = Boolean(
      store && store.refreshExpireAt && store.refreshExpireAt < now
    );
    return {
      configured: isConfigured(),
      authorized,
      openId: (store && store.openId) || '',
      accessExpireAt: (store && store.accessExpireAt) || 0,
      refreshExpireAt: (store && store.refreshExpireAt) || 0,
      needReauth,
      lastSyncAt: state.lastSyncAt || '',
      lastSyncResult: state.lastSyncResult || null,
    };
  }

  // ---------- 授权链接 ----------

  function buildAuthorizeUrl() {
    if (!isConfigured()) {
      throw new LarkApiError('飞书未配置：缺少 LARK_APP_ID/LARK_APP_SECRET/LARK_REDIRECT_BASE');
    }
    const state = randomState();
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    const params = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: cfg.redirectBase + '/api/lark/oauth/callback',
      response_type: 'code',
      state,
      scope: cfg.scopes,
    });
    return `${ACCOUNTS_HOST}/open-apis/authen/v1/authorize?${params.toString()}`;
  }

  function validateState(state) {
    const exp = pendingStates.get(state);
    if (!exp) return false;
    pendingStates.delete(state);
    if (Date.now() > exp) return false;
    return true;
  }

  // ---------- OAuth v3 令牌 ----------

  async function postToken(form) {
    // v3 端点遵循 RFC6749：application/x-www-form-urlencoded
    const resp = await fetch(`${ACCOUNTS_HOST}/oauth/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const json = await resp.json().catch(() => ({}));
    // v3 为标准 OAuth 响应；兼容飞书 envelope 包装
    if (typeof json.code !== 'undefined' && json.code !== 0) {
      throw new LarkApiError(
        json.error_description || json.msg || '令牌接口返回错误',
        json.code
      );
    }
    const data = json.data && json.data.access_token ? json.data : json;
    if (!data.access_token) {
      throw new LarkApiError('令牌响应缺少 access_token');
    }
    return data;
  }

  async function exchangeCode(code) {
    const data = await postToken({
      grant_type: 'authorization_code',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      code,
      redirect_uri: cfg.redirectBase + '/api/lark/oauth/callback',
    });
    await saveTokenSet(data);
    return getStatus();
  }

  async function refreshUserToken() {
    const store = readStore();
    if (!store || !store.refreshToken) {
      throw new LarkApiError('缺少 refresh_token，需要重新授权');
    }
    const data = await postToken({
      grant_type: 'refresh_token',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      refresh_token: store.refreshToken,
    });
    await saveTokenSet(data);
  }

  async function saveTokenSet(data) {
    const now = Date.now();
    const store = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || (readStore() || {}).refreshToken || '',
      // 提前 10 分钟视为过期
      accessExpireAt: now + (data.expires_in || 7200) * 1000 - 10 * 60 * 1000,
      refreshExpireAt: data.refresh_token
        ? now + (data.refresh_token_expires_in || 30 * 24 * 3600) * 1000
        : (readStore() || {}).refreshExpireAt || 0,
      openId: data.open_id || (readStore() || {}).openId || '',
      updatedAt: new Date(now + 8 * 3600 * 1000).toISOString(),
    };
    writeStore(store);

    // token 响应若未带 open_id，调 user_info 补一次
    if (!store.openId) {
      try {
        const info = await getUserInfo(store.accessToken);
        const again = readStore() || {};
        again.openId = info.open_id || info.openId || '';
        writeStore(again);
      } catch (e) {
        // 不阻塞授权流程，status 里会提示
      }
    }
  }

  async function getUserInfo(accessToken) {
    const json = await apiCall('GET', '/open-apis/authen/v1/user_info', {
      token: accessToken,
    });
    return json.data || {};
  }

  async function getValidUserToken() {
    const store = readStore();
    if (!store || !store.accessToken) {
      throw new LarkApiError('尚未完成飞书授权，请先在工作台点击"授权飞书"');
    }
    if (store.refreshExpireAt && store.refreshExpireAt < Date.now()) {
      throw new LarkApiError('飞书授权已超过有效期，请重新授权');
    }
    if (store.accessExpireAt < Date.now()) {
      await refreshUserToken();
    }
    return (readStore() || {}).accessToken;
  }

  // ---------- 应用令牌（机器人发消息） ----------

  async function getTenantToken() {
    if (tenantCache.token && tenantCache.expireAt > Date.now()) {
      return tenantCache.token;
    }
    const resp = await fetch(`${OPEN_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const json = await resp.json();
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new LarkApiError(json.msg || '获取 tenant_access_token 失败', json.code);
    }
    tenantCache = {
      token: json.tenant_access_token,
      expireAt: Date.now() + (json.expire || 7200) * 1000 - 5 * 60 * 1000,
    };
    return tenantCache.token;
  }

  // ---------- 通用请求 ----------

  async function apiCall(method, urlPath, opts) {
    const o = opts || {};
    const url = new URL(OPEN_HOST + urlPath);
    if (o.query) {
      for (const [k, v] of Object.entries(o.query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: 'Bearer ' + o.token,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const json = await resp.json().catch(() => ({}));
    if (json.code !== 0) {
      const missing =
        (json.error && json.error.missing_scopes) ||
        (json.data && json.data.missing_scopes) ||
        null;
      throw new LarkApiError(
        `${json.msg || '飞书接口错误'}` + (missing ? `（缺少权限: ${missing.join(',')}）` : ''),
        json.code,
        missing
      );
    }
    return json;
  }

  // 用户身份调用，401/过期时自动刷新一次
  async function userApi(method, urlPath, opts) {
    const o = opts || {};
    try {
      const token = await getValidUserToken();
      return await apiCall(method, urlPath, Object.assign({}, o, { token }));
    } catch (e) {
      if (e instanceof LarkApiError && (e.code === 99991663 || /token/i.test(e.message))) {
        await refreshUserToken();
        const token = await getValidUserToken();
        return await apiCall(method, urlPath, Object.assign({}, o, { token }));
      }
      throw e;
    }
  }

  // ---------- 日历 ----------

  async function getPrimaryCalendar() {
    if (primaryCalendarId) return primaryCalendarId;
    const json = await userApi('GET', '/open-apis/calendar/v4/calendars/primary');
    // 实际返回有三种形态：data.calendars[0] / data.calendar / data 本身即日历对象（含 calendar_id）
    const item =
      (json.data && json.data.calendars && json.data.calendars[0]) ||
      (json.data && json.data.calendar) ||
      (json.data && json.data.calendar_id && json.data) ||
      {};
    if (!item.calendar_id) throw new LarkApiError('未获取到主日历 ID');
    primaryCalendarId = item.calendar_id;
    return primaryCalendarId;
  }

  /**
   * 拉取时间范围内的日程（秒级时间戳）
   * 返回 [{eventId, summary, startSec, endSec, status, allDay}]
   */
  async function getEvents(startSec, endSec) {
    const calId = encodeURIComponent(await getPrimaryCalendar());
    const json = await userApi(
      'GET',
      `/open-apis/calendar/v4/calendars/${calId}/events`,
      { query: { start_time: startSec, end_time: endSec, page_size: 1000 } }
    );
    const items = (json.data && json.data.items) || [];
    return items
      .filter((ev) => ev.status !== 'cancelled')
      .map((ev) => ({
        eventId: ev.event_id,
        summary: ev.summary || '(无标题日程)',
        startSec: Number((ev.start_time && ev.start_time.timestamp) || 0),
        endSec: Number((ev.end_time && ev.end_time.timestamp) || 0),
        status: ev.status,
      }));
  }

  // ---------- 任务 ----------

  /**
   * 我负责的未完成任务（自动分页，上限 200 条）
   * 返回 [{guid, summary, dueMs, allDay}]
   */
  async function getMyOpenTasks() {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const query = {
        completed: false,
        page_size: 100,
        user_id_type: 'open_id',
      };
      if (pageToken) query.page_token = pageToken;
      const json = await userApi('GET', '/open-apis/task/v2/tasks', { query });
      const items = (json.data && json.data.items) || [];
      for (const t of items) {
        out.push({
          guid: t.guid,
          summary: t.summary || '(无标题任务)',
          dueMs: t.due && t.due.timestamp ? Number(t.due.timestamp) : 0,
          allDay: Boolean(t.due && t.due.is_all_day),
        });
      }
      if (!json.data || !json.data.has_more) break;
      pageToken = json.data.page_token || '';
      if (!pageToken) break;
    }
    return out;
  }

  // ---------- 妙记 ----------

  /**
   * 搜索时间范围内我拥有/参与的妙记（毫秒），按 token 去重
   * 返回 [{token, title}]
   */
  async function searchMyMinutes(startMs, endMs) {
    const store = readStore();
    const openId = store && store.openId;
    if (!openId) throw new LarkApiError('缺少 open_id，无法搜索妙记');

    const queries = [{ owner_ids: [openId] }, { participant_ids: [openId] }];
    const map = new Map();
    for (const role of queries) {
      try {
        const json = await userApi('POST', '/open-apis/minutes/v1/minutes/search', {
          body: Object.assign(
            { start_time: String(startMs), end_time: String(endMs) },
            role
          ),
        });
        const items =
          (json.data && (json.data.items || json.data.minutes)) || [];
        for (const m of items) {
          const token = m.token || m.minute_token;
          if (token) map.set(token, { token, title: m.title || m.topic || '(妙记)' });
        }
      } catch (e) {
        // 一个身份维度失败不阻塞另一个
        map.set('__error__' + Object.keys(role)[0], { error: e.message });
      }
    }
    map.forEach((v, k) => {
      if (k.startsWith('__error__')) map.delete(k);
    });
    return Array.from(map.values());
  }

  /**
   * 获取妙记 AI 产物中的待办
   * 返回 [{content, assignees:[]}]
   */
  async function getMinuteTodos(minuteToken) {
    const json = await userApi(
      'GET',
      `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/artifacts`
    );
    const todos = (json.data && json.data.minute_todos) || [];
    return todos
      .filter((t) => t && typeof t.content === 'string' && t.content.trim())
      .map((t) => ({
        content: t.content.trim(),
        assignees: Array.isArray(t.assignees) ? t.assignees : [],
      }));
  }

  /**
   * 获取妙记的对话文字稿
   * 端点：GET /open-apis/minutes/v1/minutes/:minute_token/transcript
   * 响应为二进制文件流（txt 纯文本），不是 JSON envelope。
   * 需权限「导出妙记转写的文字内容」。
   *
   * @param {string} minuteToken 妙记 token（URL 末尾 obcn... 那串）
   * @param {object} opts { needSpeaker?: boolean, needTimestamp?: boolean }
   * @returns {Promise<string>} 纯文本文字稿
   */
  async function getMinuteTranscript(minuteToken, opts) {
    const o = opts || {};
    const query = {};
    if (o.needSpeaker) query.need_speaker = 'true';
    if (o.needTimestamp) query.need_timestamp = 'true';
    query.file_format = 'txt';
    const token = await getValidUserToken();
    const url = new URL(
      OPEN_HOST +
        `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript`
    );
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    });
    if (resp.status === 200) {
      return await resp.text();
    }
    // 非 200 时响应体可能是 JSON 错误信息
    let msg = `妙记文字稿接口返回 ${resp.status}`;
    try {
      const errJson = await resp.json();
      if (errJson && errJson.msg) msg = errJson.msg;
      const missing =
        (errJson && errJson.error && errJson.error.missing_scopes) ||
        (errJson && errJson.data && errJson.data.missing_scopes) ||
        null;
      if (missing) msg += `（缺少权限: ${missing.join(',')}）`;
    } catch (e) {
      const tail = (await resp.text()).slice(0, 200);
      if (tail) msg += `: ${tail}`;
    }
    throw new LarkApiError(msg, resp.status);
  }

  // ---------- 消息（机器人身份） ----------

  async function sendTextAsBot(openId, text) {
    if (!openId) throw new LarkApiError('缺少收件人 open_id');
    const token = await getTenantToken();
    const json = await apiCall('POST', '/open-apis/im/v1/messages', {
      token,
      query: { receive_id_type: 'open_id' },
      body: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return json.data || {};
  }

  // ---------- 多维表格（用户身份） ----------
  // 端点依据 2026-09 飞书官方文档：
  // - 字段: GET/POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields
  // - 记录: GET/POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records
  //         PUT  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id

  async function listBitableFields(appToken, tableId) {
    const json = await userApi(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { query: { page_size: 100 } }
    );
    return (json.data && json.data.items) || [];
  }

  async function createBitableField(appToken, tableId, body) {
    const json = await userApi(
      'POST',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { body }
    );
    return (json.data && json.data.field) || {};
  }

  async function listBitableRecords(appToken, tableId, opts) {
    const o = opts || {};
    if (o.fetchAll) {
      let items = [];
      let pageToken;
      do {
        const data = await listBitableRecords(appToken, tableId, { pageSize: 500, pageToken });
        items = items.concat(data.items || []);
        pageToken = data.has_more ? data.page_token : '';
      } while (pageToken);
      return { items };
    }
    const query = { page_size: o.pageSize || 500 };
    if (o.pageToken) query.page_token = o.pageToken;
    const json = await userApi(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      { query }
    );
    return json.data || {};
  }

  async function createBitableRecord(appToken, tableId, fields) {
    const json = await userApi(
      'POST',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      { body: { fields } }
    );
    return (json.data && json.data.record) || {};
  }

  // 批量创建记录（每批最多 1000 条，飞书硬限制）。records: [{ fields }]
  async function batchCreateBitableRecords(appToken, tableId, records) {
    const out = [];
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      const json = await userApi(
        'POST',
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
        { body: { records: chunk } }
      );
      out.push(...((json.data && json.data.records) || []));
    }
    return out;
  }

  async function updateBitableRecord(appToken, tableId, recordId, fields) {
    const json = await userApi(
      'PUT',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      { body: { fields } }
    );
    return (json.data && json.data.record) || {};
  }

  async function deleteBitableRecord(appToken, tableId, recordId) {
    const json = await userApi(
      'DELETE',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`
    );
    return (json.data) || {};
  }

  // 列出多维表格 App 下所有数据表（用于按名查找，避免重复建表）
  async function listBitableTables(appToken) {
    const json = await userApi(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      { query: { page_size: 100 } }
    );
    return (json.data && json.data.items) || [];
  }

  // 在多维表格 App 下新建数据表（含初始字段），返回 { table_id }
  async function createBitableTable(appToken, body) {
    const json = await userApi(
      'POST',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      { body }
    );
    return json.data || {};
  }

  return {
    isConfigured,
    getStatus,
    buildAuthorizeUrl,
    validateState,
    exchangeCode,
    refreshUserToken,
    getEvents,
    getMyOpenTasks,
    searchMyMinutes,
    getMinuteTodos,
    getMinuteTranscript,
    sendTextAsBot,
    listBitableFields,
    createBitableField,
    listBitableRecords,
    createBitableRecord,
    batchCreateBitableRecords,
    updateBitableRecord,
    deleteBitableRecord,
    listBitableTables,
    createBitableTable,
  };
}

module.exports = { createLarkClient, LarkApiError };
