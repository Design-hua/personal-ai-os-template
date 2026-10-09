// ============================================================
// Meeting Center：会前简报 + 会后回流
// 设计原则：
//  - 简报只做"召回+组织"，每条事实必须标来源，AI 不许编造档案
//  - 会后回流全程"候选→用户确认"，本模块不直接写决策卡/项目卡
// ============================================================

const deepseek = require('./deepseek');
const { gramsOf, matchCount } = require('./knowledge');

const BRIEF_SYSTEM = `你是用户的会前参谋。他会给你一场会的主题，以及从他第二大脑里召回的分层材料（项目卡、待拍板决策卡、历史会议纪要、外部知识资料）。
你的任务：产出一份他进场前 3 分钟能看完的简报。

输出纯文本（不要 markdown 表格），固定五段，段间空行：
1. 🎯 这场会大概要谈什么
   用 1-2 句概括；若主题只是日程标题、信息不足，明确写"按标题推测"，不要展开成虚构议程。
2. 🧭 你这边的背景与现状
   只使用召回材料里有的内容，每条末尾标来源：[项目卡] / [历史纪要] / [外部资料]。按相关度排，最多 6 条。材料为空就写"第二大脑里暂无相关记录"。
3. ⚖️ 待你拍板的事
   只列召回材料里状态为"待我拍板"的决策卡，原样转述事项，提示他这场会能否推动拍板。没有就写"当前没有待拍板事项"。绝不把讨论中的话题包装成待决事项。
4. ❓ 建议带进会场的问题
   3-5 个，必须能从项目卡的"阻塞与风险/当前下一步"、决策卡的"最大未知"或纪要的"待决"里找到依据；没有依据时可基于会议主题给常识性问题，但不得声称是他的既有安排。
5. ✅ 这趟会要拿到的结果
   1-3 条具体、可检验的产出（如"拿到 X 的明确答复/确认 Y 的时间点"）。不要喊口号。

铁律：
- 不得编造他的项目、数据、人脉、决定；召回材料没有就写没有。
- 外部资料观点只作背景，标[外部资料]，不得当成他已确认的事实。
- 语气是参谋不是领导，简短直接，全篇不超过 400 字。`;

function score(qset, text) {
  return qset.size ? matchCount(qset, String(text || '')) : 0;
}

function fmtTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function createMeetingCenter(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    client: o.client || null,
    noteIntake: o.noteIntake || null,
    decisionCenter: o.decisionCenter || null,
    projectCenter: o.projectCenter || null,
    knowledgeCenter: o.knowledgeCenter || null,
  };

  // 未来一段时间的日程（默认 48 小时），按开始时间升序
  async function upcoming(opt) {
    const hours = Number((opt && opt.hours) || 48);
    if (!cfg.client) return { ok: false, error: '未配置飞书客户端' };
    const nowSec = Math.floor(Date.now() / 1000);
    const evs = await cfg.client.getEvents(nowSec, nowSec + hours * 3600);
    const items = (evs || [])
      .filter((e) => e.startSec >= nowSec)
      .sort((a, b) => a.startSec - b.startSec);
    return { ok: true, items };
  }

  // 四路并行召回，任何一路失败都不阻塞
  async function collectBriefContext(topic) {
    const qset = new Set(gramsOf(topic));
    const tasks = {
      decisions: (async () => {
        if (!cfg.decisionCenter) return [];
        try {
          const r = await cfg.decisionCenter.listDecisions({ status: '🟡待我拍板' });
          let items = (r && r.items) || [];
          const ranked = items
            .map((x) => ({ x, s: score(qset, `${x.question} ${x.facts || ''} ${x.unknowns || ''}`) }))
            .filter((z) => z.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 5)
            .map((z) => z.x);
          // 一个都不相关时：待拍板总量很少（≤3）就全带上，让用户知道还有事压着
          if (!ranked.length && items.length > 0 && items.length <= 3) return items.slice(0, 3);
          return ranked;
        } catch (e) { return []; }
      })(),
      projects: (async () => {
        if (!cfg.projectCenter) return [];
        try {
          const r = await cfg.projectCenter.listProjects({});
          const items = ((r && r.items) || []).filter(
            (x) => !/已完成|已退出/.test(x.status || '')
          );
          return items
            .map((x) => ({ x, s: score(qset, `${x.name} ${x.goal || ''} ${x.nextStep || ''} ${x.blockers || ''}`) }))
            .filter((z) => z.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 3)
            .map((z) => z.x);
        } catch (e) { return []; }
      })(),
      notes: (async () => {
        if (!cfg.noteIntake) return [];
        try {
          return await cfg.noteIntake.listNotes({ keyword: topic, limit: 4 });
        } catch (e) { return []; }
      })(),
      knowledge: (async () => {
        if (!cfg.knowledgeCenter || !qset.size) return [];
        try {
          const r = await cfg.knowledgeCenter.recall(topic, { max: 4 });
          return (r && r.items) || [];
        } catch (e) { return []; }
      })(),
    };
    const [decisions, projects, notes, knowledge] = await Promise.all([
      tasks.decisions, tasks.projects, tasks.notes, tasks.knowledge,
    ]);
    return { decisions, projects, notes, knowledge };
  }

  function contextToText(c) {
    const lines = [];
    if (c.projects.length) {
      lines.push('【项目卡】');
      for (const p of c.projects) {
        lines.push(`- 《${p.name}》(${p.status}) 目标：${String(p.goal || '').slice(0, 120)}｜当前下一步：${String(p.nextStep || '').slice(0, 120)}｜阻塞：${String(p.blockers || '无').slice(0, 120)}｜退出条件：${String(p.exitRule || '无').slice(0, 120)}`);
      }
    }
    if (c.decisions.length) {
      lines.push('【待拍板决策卡（状态=待我拍板）】');
      for (const d of c.decisions) {
        lines.push(`- 事项：${d.question}｜最大未知：${String(d.unknowns || '无').slice(0, 150)}`);
      }
    }
    if (c.notes.length) {
      lines.push('【历史会议/妙记纪要】');
      for (const n of c.notes) {
        lines.push(`- 《${n.title}》(${n.meetingType || '笔记'}${n.time ? ' ' + n.time : ''})：${String(n.summary || '').slice(0, 200)}`);
      }
    }
    if (c.knowledge.length) {
      lines.push('【外部知识资料（外部观点，需核实）】');
      for (const k of c.knowledge) {
        lines.push(`- 《${k.title || '未命名资料'}》：${String(k.summary || k.viewpoints || '').slice(0, 200)}`);
      }
    }
    return lines.join('\n') || '（没有召回任何相关材料）';
  }

  /**
   * 生成会前简报
   * @param {{topic?:string, when?:string}} p topic 为空时自动取未来48h最近日程
   */
  async function brief(p) {
    const param = p || {};
    let topic = String(param.topic || '').trim();
    let event = null;

    if (!topic) {
      if (!cfg.client) return { ok: false, error: '请说会议主题（如：会前：矿渣合作）' };
      const up = await upcoming({ hours: 48 });
      if (!up.ok) return up;
      event = up.items[0] || null;
      if (!event) return { ok: false, error: '未来 48 小时日历里没有找到日程。请直接给主题，如「会前：矿渣合作」' };
      topic = event.summary;
    }

    if (!cfg.apiKey) return { ok: false, error: '会前简报未启用：需配置 DEEPSEEK_API_KEY' };

    const ctx = await collectBriefContext(topic);
    const whenLine = event ? `日程时间：${fmtTime(event.startSec)}\n` : (param.when ? `他说的时间：${param.when}\n` : '');
    const userMsg =
      `${whenLine}会议主题：${topic}\n\n` +
      `召回材料如下（只准用这些，没有就写没有）：\n${contextToText(ctx)}`;

    const reply = await deepseek.callDeepSeek(
      [{ role: 'system', content: BRIEF_SYSTEM }, { role: 'user', content: userMsg }],
      cfg.apiKey
    );

    return {
      ok: true,
      topic,
      event: event ? { eventId: event.eventId, summary: event.summary, startSec: event.startSec, timeText: fmtTime(event.startSec) } : null,
      reply: String(reply || '').trim(),
      used: {
        decisions: ctx.decisions.length,
        projects: ctx.projects.length,
        notes: ctx.notes.length,
        knowledge: ctx.knowledge.length,
      },
    };
  }

  function isReady() { return Boolean(cfg.client && cfg.apiKey); }

  return { brief, upcoming, collectBriefContext, isReady };
}

module.exports = { createMeetingCenter };
