// lib/thinking.js
// 「思考伙伴」——第 3 步：提问时自动聚合第二大脑，分层回答，不混层、不瞎编。
//
// 召回四类来源，严格分层：
//   ① 我的档案（仅 ✅我已确认）……代表"我是谁、我信什么"，结合个人情境用
//   ② 我确认的经验复盘（仅 ✅我已确认）……我自己复盘出的方法论
//   ③ 知识资料（信息层级=AI分析，外部）……得到大脑等外部观点，仅供参考、需自行验证
//   ④ 爆款视频拆解……内容创作参考
//
// 纪律：
//   - 待我确认 / AI 推断的内容一律不召回（不把没确认的东西当用户观点）
//   - 外部资料的投资建议、趋势预测不得当已验证事实
//   - 资料里没有就明说，不编造来源；引用处带来源编号，结尾列来源
//   - 个人决策给贴合分析，但最终决定权留给用户

'use strict';

const deepseek = require('./deepseek');
const { gramsOf, matchCount } = require('./knowledge');
const { CONFIRM_YES } = require('./experience');

const SYSTEM_PROMPT = `你是用户的个人"思考伙伴"。你不是客服，也不是中立搜索引擎，你了解他、帮他把问题想透，但绝不替他拍板。

你会拿到四层资料，它们的性质完全不同，回答时必须区别对待：
- 【我的档案·已确认】：他本人确认过的身份、事实、核心原则和判断，代表"他是谁、他信什么、他要什么"。给建议时要主动贴合这些，这是最高优先级的个人情境。
- 【我确认的经验】：他自己复盘得到的方法论和踩坑记录，是他真实验证过的做法。
- 【知识资料·外部AI分析】：来自得到大脑等外部内容、再经AI整理的别人观点和方法，仅供参考，不代表他、也未经他验证。里面的投资建议、趋势预测、成功案例尤其不能当事实陈述，要提示需自行核实。
- 【爆款视频拆解】：他收集的短视频创作参考。

回答规则（必须遵守）：
1. 优先用上述资料回答。资料里没有依据的，就直接说"我掌握的资料里没有可靠依据"，绝不能编造数据、案例、出处或来源编号。
2. 行文里凡引用某条资料，用编号标注：外部资料标[资n]、他的经验标[验n]、视频标[视n]。档案是他自己的东西，不用编号，自然融入即可。
3. 明确区分三类话：已验证事实、外部/他人观点、你的分析推断。属于推断或外部预测的，要说明"这是推断/外部观点，需要你核实"。
4. 涉及他个人该怎么做时：结合【我的档案】和【我确认的经验】给出贴合他处境的分析和可选项，讲清各选项的取舍，但把最终决定权留给他，不替他做决定。
5. 投资、健康、重大人生决策类问题，必须提示风险与"自行核实、独立决策"，语气克制不煽动。
6. 回答末尾另起一行"📚 参考来源"，列出你实际用到的外部资料/经验/视频标题（和编号对应）；如果没用到任何外部资料就不写这一节。最后用一句话提示：含AI整理与推断，关键决策请他自己确认。
7. 说人话、有针对性，不要罗列资料堆砌，不要泛泛而谈的正确废话。
8. 当多条资料之间结论互相矛盾时，必须明确指出"资料之间存在矛盾"并分别说明各方说法和出处，不要自行抹平、也不要只挑支持其中一方的。
9. 引用的外部资料如果来源日期距今超过约两年，要在引用处标注"（资料较旧，可能过时）"。`;

// 回答格式档位（研究命令用）：默认摘要。字数是硬要求写进本次提问，不改变分层引用纪律。
const FORMATS = {
  flash: { label: '研究快讯', guide: '快讯档：全文200-400字。先一句话结论，再给2-4条要点，每条带来源编号；不展开论述，不写铺垫。' },
  summary: { label: '研究摘要', guide: '摘要档：全文500-1000字。先给核心结论，再分层展开要点与依据，引用处带编号。' },
  deep: { label: '深度研究', guide: '深度档：全文1500字以上。须包含：核心结论、分层论证、不同观点与矛盾点、贴合他处境的分析与可选项、风险提示；引用处带编号。' },
  compare: { label: '对比研究', guide: '对比档：全文800-1200字。分维度并列比较两个对象（可用文字对照表），指出各自适用场景与风险；结论给倾向但明确说明最终决定由他自己拍板，可衔接「决策：X」命令。' },
};

function createThinkingStudio(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    profileCenter: o.profileCenter || null,
    knowledgeCenter: o.knowledgeCenter || null,
    experienceCenter: o.experienceCenter || null,
    videoIntake: o.videoIntake || null,
  };

  function isReady() {
    return Boolean(cfg.apiKey);
  }

  // ③ 知识资料
  async function gatherKnowledge(query) {
    if (!cfg.knowledgeCenter || typeof cfg.knowledgeCenter.recall !== 'function') return [];
    try {
      const r = await cfg.knowledgeCenter.recall(query, { max: 6 });
      return (r && r.items) || [];
    } catch (e) {
      return [];
    }
  }

  // ② 我确认的经验（AI 待确认的不召回）
  async function gatherExperiences(query) {
    if (!cfg.experienceCenter || typeof cfg.experienceCenter.listExperiences !== 'function') return [];
    let r;
    try {
      r = await cfg.experienceCenter.listExperiences({ confirmed: CONFIRM_YES });
    } catch (e) {
      return [];
    }
    const qset = new Set(gramsOf(query));
    const items = ((r && r.items) || []).map((x) => ({
      ...x,
      score: qset.size
        ? matchCount(qset, `${x.content || ''} ${x.category || ''} ${x.cluster || ''}`)
        : 0,
    }));
    // 有相关性命中的优先；不足时用核心原则兜底（少而精）
    const hit = items.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const picked = hit.length ? hit : items.filter((x) => x.level === '🔥核心原则');
    return picked.slice(0, 6);
  }

  // ④ 视频拆解
  async function gatherVideos(query) {
    if (!cfg.videoIntake || typeof cfg.videoIntake.listVideosRich !== 'function') return [];
    let vids;
    try {
      vids = await cfg.videoIntake.listVideosRich(100);
    } catch (e) {
      return [];
    }
    const qset = new Set(gramsOf(query));
    if (!qset.size) return [];
    return vids
      .map((v) => ({
        ...v,
        score: matchCount(qset, `${v.title || ''} ${v.hook || ''} ${v.structure || ''} ${v.cluster || ''}`),
      }))
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }

  // ① 我的档案（全量已确认，量小，作为稳定人设上下文）
  async function gatherProfile() {
    if (!cfg.profileCenter || typeof cfg.profileCenter.getConfirmedDigest !== 'function') {
      return { text: '', count: 0, pendingCount: 0 };
    }
    try {
      const d = await cfg.profileCenter.getConfirmedDigest();
      return { text: String(d.text || '').slice(0, 3500), count: d.count || 0, pendingCount: d.pendingCount || 0 };
    } catch (e) {
      return { text: '', count: 0, pendingCount: 0 };
    }
  }

  function buildContext(profile, knowledge, experiences, videos) {
    const parts = [];
    if (profile.text) {
      parts.push(`【我的档案·已确认（这是用户本人的情况和原则，不是外部观点）】\n${profile.text}`);
    }
    if (knowledge.length) {
      const lines = ['【知识资料·外部AI分析（别人的观点，未经他验证，供参考；编号[资n]）】'];
      knowledge.forEach((k, i) => {
        const body = k.viewpoints || k.summary || k.knowledge || '';
        lines.push(
          `\n[资${i + 1}]《${k.title}》${k.author ? '·' + k.author : ''}${k.date ? '（' + k.date + '）' : ''}〔${k.domain}〕`,
          body.slice(0, 600)
        );
      });
      parts.push(lines.join('\n'));
    }
    if (experiences.length) {
      const lines = ['【我确认的经验（他自己验证过的方法论；编号[验n]）】'];
      experiences.forEach((e, i) => {
        const tag = e.type === '❌减分行为' ? '（避坑）' : e.level === '🔥核心原则' ? '（核心原则）' : '';
        lines.push(`[验${i + 1}]${tag} ${String(e.content || '').slice(0, 220)}`);
      });
      parts.push(lines.join('\n'));
    }
    if (videos.length) {
      const lines = ['【爆款视频拆解（创作参考；编号[视n]）】'];
      videos.forEach((v, i) => {
        lines.push(
          `[视${i + 1}]《${v.title}》${v.rating ? '（' + v.rating + '星）' : ''}`,
          v.hook && !/无文案|字幕未涉及/.test(v.hook) ? `钩子：${String(v.hook).slice(0, 120)}` : '',
          v.structure && !/无文案|字幕未涉及/.test(v.structure) ? `结构：${String(v.structure).slice(0, 240)}` : ''
        );
      });
      parts.push(lines.filter(Boolean).join('\n'));
    }
    return parts.join('\n\n');
  }

  /**
   * 回答一个问题
   * @param {object} p { question, history, now, format?, topics? }
   *   format: 'flash'|'summary'(默认)|'deep'|'compare'
   *   topics: 对比研究时传 [A, B]，两边分别召回资料再按标题去重合并
   */
  async function answer(p) {
    const param = p || {};
    if (!isReady()) return { ok: false, error: '思考伙伴未启用：需配置 DEEPSEEK_API_KEY' };
    const question = String(param.question || '').trim();
    if (!question) return { ok: false, error: '问题为空' };
    const fmt = FORMATS[param.format] ? param.format : 'summary';

    // 对比研究：A、B 分别召回，按标题去重合并
    let knowledge;
    if (fmt === 'compare' && Array.isArray(param.topics) && param.topics.length === 2) {
      const [ka, kb] = await Promise.all([gatherKnowledge(param.topics[0]), gatherKnowledge(param.topics[1])]);
      const seen = new Set();
      knowledge = [];
      for (const k of [...(ka || []), ...(kb || [])]) {
        if (k && k.title && !seen.has(k.title)) { seen.add(k.title); knowledge.push(k); }
      }
    } else {
      knowledge = await gatherKnowledge(question);
    }

    const [profile, experiences, videos] = await Promise.all([
      gatherProfile(),
      gatherExperiences(question),
      gatherVideos(question),
    ]);

    const context = buildContext(profile, knowledge, experiences, videos);
    const nowLine = param.now ? `当前时间：${param.now}\n` : '';
    const fmtLine = `\n\n本次回答格式要求（${FORMATS[fmt].label}）：${FORMATS[fmt].guide}`;
    const userMsg =
      (context || '（第二大脑里暂时没有与这个问题相关的资料，请基于你的常识回答，并明确说明这不是他资料库里的内容。）') +
      fmtLine +
      `\n\n${nowLine}他现在的问题：${question}`;

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    const cleanHistory = deepseek.sanitizeHistory ? deepseek.sanitizeHistory(param.history) : [];
    for (const h of cleanHistory) messages.push({ role: h.role, content: h.content });
    messages.push({ role: 'user', content: userMsg });

    const reply = await deepseek.callDeepSeek(messages, cfg.apiKey);

    return {
      ok: true,
      reply: String(reply || ''),
      format: fmt,
      used: {
        profileConfirmed: profile.count,
        profilePending: profile.pendingCount,
        knowledge: knowledge.map((k) => ({ title: k.title, domain: k.domain, date: k.date, author: k.author })),
        experiences: experiences.map((e) => ({ content: String(e.content || '').slice(0, 60), level: e.level, type: e.type })),
        videos: videos.map((v) => ({ title: v.title, rating: v.rating, url: v.url })),
      },
    };
  }

  return { isReady, answer };
}

module.exports = { createThinkingStudio };
