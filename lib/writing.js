// lib/writing.js
// 板块四：AI 写作室
//
// 读取板块一的视频拆解 + 板块三的经验卡片 + 第二大脑知识资料作为素材，生成可直接拍摄/发布的内容初稿。
// 这是「拆解 → 经验 → 资料 → 创作」复利闭环的最后一环：素材库不再只存不用。
//
// 依赖（注入，均可缺省降级）：
//   videoIntake.listVideosRich()  视频全字段拆解
//   experienceCenter.listExperiences()  经验卡片
//   knowledgeCenter.recall()      得到大脑等外部知识资料（AI分析层，别人观点，仅借鉴不照抄）
//   deepseek                      生成

'use strict';

const deepseek = require('./deepseek');

const FORMAT_OPTIONS = ['口播脚本', '图文笔记', '爆款标题组', '选题大纲'];

function createWritingStudio(opts) {
  const o = opts || {};
  const cfg = {
    apiKey: o.apiKey || '',
    videoIntake: o.videoIntake || null,
    experienceCenter: o.experienceCenter || null,
    knowledgeCenter: o.knowledgeCenter || null,
  };

  function isReady() {
    return Boolean(cfg.apiKey);
  }

  // 召回视频素材：按话题簇/关键词过滤，评分高、素材等级高的优先，最多 max 条
  async function gatherVideos(filter) {
    if (!cfg.videoIntake || typeof cfg.videoIntake.listVideosRich !== 'function') return [];
    const f = filter || {};
    let vids = [];
    try {
      vids = await cfg.videoIntake.listVideosRich(60);
    } catch (e) {
      return [];
    }
    if (f.cluster) vids = vids.filter((v) => v.cluster === f.cluster);
    if (f.keyword) {
      const kw = String(f.keyword).trim();
      if (kw) {
        vids = vids.filter((v) =>
          [v.title, v.hook, v.structure, v.attract, v.suggest]
            .some((s) => String(s || '').includes(kw))
        );
      }
    }
    const levelRank = { 高: 0, 中: 1, 低: 2 };
    return vids
      .slice()
      .sort((a, b) => {
        if (b.rating !== a.rating) return b.rating - a.rating;
        return (levelRank[a.level] ?? 3) - (levelRank[b.level] ?? 3);
      })
      .slice(0, f.max || 5);
  }

  // 召回经验卡片：核心原则/加分行为优先，减分行为（避坑）随后，最多 max 条
  async function gatherExperiences(filter) {
    if (!cfg.experienceCenter || typeof cfg.experienceCenter.listExperiences !== 'function') return [];
    const f = filter || {};
    let r;
    try {
      r = await cfg.experienceCenter.listExperiences(f.cluster ? { cluster: f.cluster } : {});
    } catch (e) {
      return [];
    }
    const items = (r && r.items) || [];
    const rank = (it) => {
      if (it.level === '🔥核心原则' && it.type === '✅加分行为') return 0;
      if (it.level === '🔥核心原则') return 1;
      if (it.type === '✅加分行为') return 2;
      if (it.type === '🟡中性观察') return 3;
      return 4; // ❌减分行为放最后，作为避坑提醒
    };
    return items.slice().sort((a, b) => rank(a) - rank(b)).slice(0, f.max || 8);
  }

  // 召回外部知识资料：按创作需求做相关性匹配（bigram），取观点/方法做启发，最多 max 篇
  async function gatherKnowledge(query) {
    if (!cfg.knowledgeCenter || typeof cfg.knowledgeCenter.recall !== 'function') return [];
    const q = String(query || '').trim();
    if (!q) return [];
    try {
      const r = await cfg.knowledgeCenter.recall(q, { max: 4 });
      return (r && r.items) || [];
    } catch (e) {
      return [];
    }
  }

  // 把素材拼成给 AI 的上下文（每条截断控 token）
  function buildContext(videos, experiences, knowledge) {
    const parts = [];
    if (videos.length) {
      const lines = ['【可参考的爆款视频拆解】'];
      videos.forEach((v, i) => {
        lines.push(
          `\n视频${i + 1}《${v.title}》${v.rating ? '（值得模仿 ' + v.rating + ' 星）' : ''}${v.cluster ? '〔' + v.cluster + '〕' : ''}`,
          v.hook && !/无文案|字幕未涉及/.test(v.hook) ? `· 开头钩子：${String(v.hook).slice(0, 180)}` : '',
          v.structure && !/无文案|字幕未涉及/.test(v.structure) ? `· 结构拆解：${String(v.structure).slice(0, 260)}` : '',
          v.attract ? `· 爆点：${String(v.attract).slice(0, 140)}` : ''
        );
      });
      parts.push(lines.filter(Boolean).join('\n'));
    }
    if (experiences.length) {
      const lines = ['\n【我沉淀的相关经验/原则（务必吸收，减分行为是要避开的坑）】'];
      experiences.forEach((e) => {
        const tag = `${e.type === '✅加分行为' ? '✅' : e.type === '❌减分行为' ? '❌避坑' : '🟡'}${e.level === '🔥核心原则' ? '🔥' : ''}`;
        lines.push(`· ${tag} ${String(e.content).slice(0, 160)}`);
      });
      parts.push(lines.join('\n'));
    }
    if (knowledge && knowledge.length) {
      const lines = ['\n【知识资料·外部AI分析（别人的观点，仅借框架/角度/方法做启发，不是事实、不要照抄、数据案例不得直接引用）】'];
      knowledge.forEach((k) => {
        const body = k.knowledge || k.viewpoints || k.summary || '';
        lines.push(`· 《${k.title}》〔${k.domain}〕：${String(body).slice(0, 220)}`);
      });
      parts.push(lines.join('\n'));
    }
    return parts.join('\n');
  }

  function buildSystemPrompt(format) {
    const fmt = FORMAT_OPTIONS.includes(format) ? format : '口播脚本';
    const shape = {
      口播脚本:
        '输出一条可直接拍摄的 30-60 秒口播脚本，结构为：\n' +
        '【开头3秒钩子】（一句话，制造悬念/反常识/强利益）\n' +
        '【主体】（分 3-4 个小段，每段给具体内容和可念的口播句，节奏明快）\n' +
        '【结尾引导】（一句话引导点赞/关注/评论）',
      图文笔记:
        '输出一篇小红书/公众号风格图文笔记：先给 3 个备选标题，再给正文（带 emoji 小标题、分点、金句），结尾给标签建议。',
      爆款标题组:
        '输出 10 个爆款标题，每行一个，覆盖悬念型、利益型、反常识型、数字型、对话型等不同钩子，不要序号以外的解释。',
      选题大纲:
        '输出一个选题策划大纲：核心观点、目标人群、3 个不同切入角度（每个附一句开头示范）、内容结构、差异化亮点。',
    }[fmt];
    return `你是用户的个人短视频内容策划，正在帮他创作。要求：
1. 充分吸收下方"爆款视频拆解"里被验证有效的钩子与结构，以及"经验/原则"里的方法论；❌避坑项绝不能犯
2. 参考但不照抄素材，结合用户本次的创作需求原创；禁止编造素材里没有的数据（播放量、案例等）
3. "知识资料·外部AI分析"是别人的观点，只能借它的框架、切入角度和表达方法做启发，绝不能照抄句子，更不能把里面的预测、数据、成功案例当成已证实的事实写进稿子
4. 语言口语化、有网感、具体不空泛，符合高校老师做个人 IP 的真实可信人设，不浮夸不标题党造假
5. ${shape}
6. 直接输出成品内容，不要寒暄、不要解释你的思路`;
  }

  /**
   * 预览将用于创作的素材（前端在生成前展示"会参考哪些"）
   * @param {object} filter {cluster,keyword}
   * @param {string} [brief] 创作需求原文，用于知识资料相关性召回
   */
  async function previewMaterials(filter, brief) {
    const [videos, experiences, knowledge] = await Promise.all([
      gatherVideos(filter),
      gatherExperiences(filter),
      gatherKnowledge(brief || (filter && filter.keyword) || ''),
    ]);
    return {
      videos: videos.map((v) => ({ title: v.title, cluster: v.cluster, rating: v.rating, level: v.level })),
      experiences: experiences.map((e) => ({ content: e.content, type: e.type, level: e.level, category: e.category })),
      knowledge: knowledge.map((k) => ({ title: k.title, domain: k.domain, date: k.date, author: k.author })),
    };
  }

  /**
   * 生成初稿
   * @param {object} p { brief 创作需求, cluster 话题簇过滤, keyword 关键词过滤, format 体裁 }
   */
  async function generate(p) {
    const param = p || {};
    if (!isReady()) return { ok: false, error: '写作室未启用：需配置 DEEPSEEK_API_KEY' };
    const brief = String(param.brief || '').trim();
    if (!brief) return { ok: false, error: '请先描述你想写什么' };
    const format = FORMAT_OPTIONS.includes(param.format) ? param.format : '口播脚本';
    const filter = { cluster: param.cluster || '', keyword: param.keyword || '' };

    const [videos, experiences, knowledge] = await Promise.all([
      gatherVideos(filter),
      gatherExperiences(filter),
      gatherKnowledge(brief),
    ]);
    const context = buildContext(videos, experiences, knowledge);
    const userMsg = [
      context || '（素材库中暂无匹配的视频拆解、经验或知识资料，请凭你的专业能力直接创作）',
      `\n【本次创作需求】\n${brief}`,
      `\n【体裁】${format}`,
    ].join('\n');

    const draft = await deepseek.callDeepSeek(
      [
        { role: 'system', content: buildSystemPrompt(format) },
        { role: 'user', content: userMsg },
      ],
      cfg.apiKey
    );

    return {
      ok: true,
      draft: String(draft || ''),
      format,
      materials: {
        videos: videos.map((v) => ({ title: v.title, rating: v.rating, cluster: v.cluster })),
        experiences: experiences.map((e) => ({ content: e.content, type: e.type, level: e.level })),
        knowledge: knowledge.map((k) => ({ title: k.title, domain: k.domain, date: k.date })),
      },
    };
  }

  return { isReady, generate, previewMaterials, FORMAT_OPTIONS };
}

module.exports = { createWritingStudio, FORMAT_OPTIONS };
