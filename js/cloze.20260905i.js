/* ============================================================
   cloze.js · 挖空引擎
   1) tokenize(text)   中英混排切分 → token 数组（确定性，可由原文重算，无需持久化）
   2) score(tokens)    核心知识点打分：长词 / 术语后缀 / 数字 / 专有名词 / 低频字 / 全文复现
   3) autoSelect(...)  按密度(少/中/多) + 最小间距挑选挖空位；支持强制挖空(错点必挖)/排除
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';

  /* ---------------- 字符判定 ---------------- */
  function isCJK(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF);
  }
  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  function isLatin(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }
  function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\u3000' || ch === '\u00A0'; }

  /* 中文功能词（切分点）：这些字几乎只作虚词，用来把长句切成"知识点块" */
  var CN_STOP = {};
  '的地得了着过是在和与或把被而则就也都还又很最更不没这那之以所们你我他她它呢吗吧啊呀哦嗯且从向对跟但却因由如若请各每该此其并等于及'
    .split('').forEach(function (c) { CN_STOP[c] = 1; });

  /* 术语/名词后缀：以这些字结尾的块，往往是学科名词、概念或称谓 */
  var TERM_TAIL = {};
  ('性化率度法论学义制系统力量期型式象征理念则策观点说派别机构务原定律应现结构功能过程阶段特征作用条件因素方向途径准指标模规律体主'
   + '家者员师生物品器会所局部院署司厂店馆区域权益能观感值线网点表图册卡'
  ).split('').forEach(function (c) { TERM_TAIL[c] = 1; });

  /* 常用字表（约 500 字）：不在表内 → 视为低频字，加权 */
  var COMMON = {};
  ('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四五果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞')
    .split('').forEach(function (c) { COMMON[c] = 1; });

  /* 数字后可吸附的"时间/日期"单位字（"1978年"、"20分钟" 作为一个整体挖空）。
     注意：刻意不含 个/组/块/米/种/类 等通用量词——它们常出现在人名/词里，
     贪心吸附会把"1956年米勒"错拼成"1956年米"、"2个组块"错拼成"2个组"。 */
  var UNIT = {};
  '年月日时分秒钟周天岁世纪年代季度'
    .split('').forEach(function (c) { UNIT[c] = 1; });

  var EN_STOP = {};
  ('the a an and or but if then than that this these those of in on at to for from with without by as is are was were be been being am do does did done have has had not no nor so such very much many more most less least it its it\'s they them their there here when where which who whom whose what how why all any both each few other some only own same too can will just should now about into over after before during above below up down out off again further once he she his her you your we our i me my us also would could may might must shall upon per via etc')
    .split(' ').forEach(function (w) { EN_STOP[w] = 1; });

  /* ---------------- 1) 分词 ---------------- */
  /**
   * token = {
   *   s: 原文片段, t: 类型 'cn'|'en'|'num'|'pt'|'sp'|'br',
   *   p: 起始字符位置, cz: 是否可自动挖空, ck: 是否可手动点击, st: 句序号
   * }
   */
  function tokenize(text) {
    text = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var toks = [], n = text.length, i = 0, fcache = {};

    /* 词性度量：片段在全文的"可成词次数"。
       仅当它反复出现、且左右邻字都有变化（极大重复串）时才算，
       否则 "艾宾浩" 这种残片会被 "艾宾浩斯" 的出现次数带高。 */
    function docCount(sub) { return wordness(sub); }
    function wordness(sub) {
      if (fcache[sub] != null) return fcache[sub];
      var pos = [], from = 0, k;
      while ((k = text.indexOf(sub, from)) >= 0) { pos.push(k); from = k + 1; if (pos.length > 6) break; }
      var c = pos.length, res = 0;
      if (c >= 2) {
        var L = sub.length, rs = {}, ls = {}, rn = 0, ln = 0, j;
        for (j = 0; j < c; j++) {
          var rc = pos[j] + L < n ? text.charAt(pos[j] + L) : '\u0000';
          var lc = pos[j] > 0 ? text.charAt(pos[j] - 1) : '\u0000';
          if (!rs[rc]) { rs[rc] = 1; rn++; }
          if (!ls[lc]) { ls[lc] = 1; ln++; }
        }
        if (rn >= 2 && ln >= 2) res = c;
      }
      return (fcache[sub] = res);
    }

    function push(t, s, p, cz, ck) {
      toks.push({ s: s, t: t, p: p, cz: !!cz, ck: !!ck, st: 0 });
    }

    while (i < n) {
      var ch = text.charAt(i);

      if (ch === '\n') { push('br', '\n', i); i++; continue; }

      if (isSpace(ch)) {
        var j = i; while (j < n && isSpace(text.charAt(j))) j++;
        push('sp', text.slice(i, j), i); i = j; continue;
      }

      /* 数字（含小数/千分位/百分号/日期 + 中文单位） */
      if (isDigit(ch)) {
        var k = i;
        while (k < n && isDigit(text.charAt(k))) k++;
        while (k < n - 1 && '.,:/-—～~'.indexOf(text.charAt(k)) >= 0 && isDigit(text.charAt(k + 1))) {
          k++; while (k < n && isDigit(text.charAt(k))) k++;
        }
        if (k < n && (text.charAt(k) === '%' || text.charAt(k) === '％')) k++;
        var u = 0;
        while (k < n && u < 2 && isCJK(text.charAt(k)) && UNIT[text.charAt(k)]) { k++; u++; }
        // 自动挖空仅对"较长数字/年代/比例/带单位"开放；短序号(1. 2. 7 等)不自动挖，避免列表编号被挖
        var numStr = text.slice(i, k);
        var numCz = numStr.length >= 3 || /[%％]/.test(numStr) || u > 0;
        push('num', numStr, i, numCz, true); i = k; continue;
      }

      /* 英文单词（允许内部连字符/撇号、尾部数字，如 COVID-19 / GPT4） */
      if (isLatin(ch)) {
        var m = i;
        while (m < n) {
          var c2 = text.charAt(m);
          if (isLatin(c2) || isDigit(c2)) { m++; continue; }
          if ((c2 === '-' || c2 === '\'' || c2 === '’' || c2 === '.') &&
              m + 1 < n && (isLatin(text.charAt(m + 1)) || isDigit(text.charAt(m + 1)))) { m += 2; continue; }
          break;
        }
        var w = text.slice(i, m);
        var lower = w.toLowerCase();
        var okEn = w.length >= 3 && !EN_STOP[lower];
        push('en', w, i, okEn, true); i = m; continue;
      }

      /* 中文连续段 → 优先用 segmentit 切成自然词，失败回退内置切块 */
      if (isCJK(ch)) {
        var e = i; while (e < n && isCJK(text.charAt(e))) e++;
        segSplit(text.slice(i, e), i).forEach(function (t) { toks.push(t); });
        i = e; continue;
      }

      /* 其余（标点/符号） */
      push('pt', ch, i); i++;
    }

    markSentences(toks);
    return toks;
  }

  /* 中文分词：统一使用内置轻量切块（chunkCN），不再依赖外部 3.7MB 的
     segmentit 词典（首屏下载/初始化会严重拖慢、卡死主线程）。
     挖空场景下分词粒度由 score 引擎 + 用户点选/拖选决定，内置切块已够用。 */
  function getSeg() { return null; }

  /** 把一段纯中文用 segmentit 切成自然词；segmentit 不返回起止位置，
     但分词是对原文的连续无缝切分，按累计游标即可得到精确字符偏移。 */
  function segSplit(run, base) {
    var seg = getSeg();
    if (!seg) return chunkCN(run, base, null);
    var raw;
    try { raw = seg.doSegment(run); } catch (e) { return chunkCN(run, base, null); }
    if (!raw || !raw.length) return chunkCN(run, base, null);
    var out = [], cursor = 0;
    raw.forEach(function (w) {
      var s = w && (w.w || w.word || '');
      if (!s || /^\s+$/.test(s)) return;
      out.push({ s: s, t: 'cn', p: base + cursor, cz: s.length >= 2, ck: true, st: 0 });
      cursor += s.length;
    });
    return out.length ? out : chunkCN(run, base, null);
  }

  /** 把一段中文按功能词切成块；≥6 字的长块再用动态规划切成词组（segmentit 不可用时的回退） */
  function chunkCN(run, base, docCount) {
    var raw = [], buf = '', bufAt = 0, i;
    for (i = 0; i < run.length; i++) {
      var c = run.charAt(i);
      if (CN_STOP[c]) {
        if (buf) { raw.push({ s: buf, at: bufAt, stop: false }); buf = ''; }
        raw.push({ s: c, at: i, stop: true });
      } else {
        if (!buf) bufAt = i;
        buf += c;
      }
    }
    if (buf) raw.push({ s: buf, at: bufAt, stop: false });

    var out = [];
    raw.forEach(function (p) {
      if (p.stop || p.s.length < 6) { out.push(p); return; }
      splitLong(p.s, docCount).forEach(function (q) {
        out.push({ s: q.s, at: p.at + q.at, stop: false });
      });
    });

    return out.map(function (p) {
      return {
        s: p.s, t: 'cn', p: base + p.at,
        cz: !p.stop && p.s.length >= 2,
        ck: !p.stop,
        st: 0
      };
    });
  }

  /** 长块切分：DP 最大化"词组合理度"，倾向 2~4 字、以术语后缀结尾、全文复现的片段 */
  function splitLong(s, docCount) {
    s = String(s == null ? '' : s);
    var L = s.length;
    if (L <= 0) return [];
    if (!Number.isFinite(L)) L = 0;
    var MAXP = 5, best = [], cut = [], i, k;
    best[0] = 0;
    for (i = 1; i <= L; i++) {
      best[i] = -Infinity;
      for (k = 1; k <= MAXP && k <= i; k++) {
        var v = best[i - k] + pieceScore(s.substr(i - k, k), docCount);
        if (v > best[i]) { best[i] = v; cut[i] = k; }
      }
    }
    var out = [];
    i = L;
    while (i > 0) { k = cut[i]; out.unshift({ s: s.substr(i - k, k), at: i - k }); i -= k; }
    return out;
  }

  /* 极少作词首的纯后缀字：用于避免把 "心理学家" 切成 "心理学|家…" */
  var BAD_HEAD = {};
  '性化率度论义制员者家式型们'.split('').forEach(function (c) { BAD_HEAD[c] = 1; });

  function pieceScore(p, docCount) {
    var L = p.length;
    var v = Math.pow(L, 1.6);                       // L^1.6：整体偏好更长的词，避免碎成单双字
    if (L === 1) v -= 1.6;
    if (TERM_TAIL[p.charAt(L - 1)]) v += 1.3;
    if (BAD_HEAD[p.charAt(0)]) v -= 1.8;
    if (L >= 2 && docCount) {
      var f = docCount(p);
      if (f > 1) v += Math.min(f - 1, 3) * 1.2;      // 全文复现 → 很可能是真实词
    }
    return v;
  }

  /** 标句号：用于复习时只展示所在句子 */
  function markSentences(toks) {
    var si = 0;
    for (var i = 0; i < toks.length; i++) {
      toks[i].st = si;
      var s = toks[i].s;
      if (toks[i].t === 'br') { si++; continue; }
      if (toks[i].t === 'pt' && '。！？；!?;'.indexOf(s) >= 0) si++;
    }
  }

  /* ---------------- 2) 打分 ---------------- */
  function score(toks) {
    var freq = {}, i, t;
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      if (!t.ck) continue;
      var key = t.t + ':' + t.s.toLowerCase();
      freq[key] = (freq[key] || 0) + 1;
    }

    var out = [];
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      out[i] = t.cz ? scoreOne(t, freq) : 0;
    }
    return out;
  }

  function scoreOne(t, freq) {
    var s = t.s, L = s.length, v = 0, j;

    if (t.t === 'num') {
      v = 3.0;                                        // 数字/年代/比例 = 高价值考点
      if (/[%％]/.test(s)) v += 0.5;
      if (L >= 3) v += 0.3;
    } else if (t.t === 'en') {
      if (/^[A-Z0-9\-]{2,}$/.test(s)) v += 2.4;       // 缩写：DNA / GDP / COVID-19
      else if (/^[A-Z]/.test(s)) v += 1.5;            // 专有名词
      v += L >= 9 ? 1.5 : L >= 7 ? 1.1 : L >= 5 ? 0.8 : 0.4;
      if (/\d/.test(s)) v += 0.4;
    } else {
      /* 中文块：3~4 字最像术语 */
      v += L === 2 ? 1.0 : L === 3 ? 1.55 : L === 4 ? 1.7 : L === 5 ? 1.35 : 1.1;
      if (TERM_TAIL[s.charAt(L - 1)]) v += 0.75;      // 术语后缀
      var rare = 0;
      for (j = 0; j < L; j++) if (!COMMON[s.charAt(j)]) rare++;
      v += Math.min(rare * 0.22, 0.7);                // 低频字 = 专业术语
      if (/[零一二三四五六七八九十百千万亿]/.test(s)) v += 0.35;
      if (/^(第|其)/.test(s)) v -= 0.3;
      if ('后前中内时上下里外间'.indexOf(s.charAt(L - 1)) >= 0) v -= 0.5;  // 方位/时态收尾多半不是术语
    }

    var f = freq[t.t + ':' + s.toLowerCase()] || 1;
    v += Math.min(f - 1, 3) * 0.45;                   // 全文反复出现 = 核心概念
    return v;
  }

  /* ---------------- 3) 自动选空 ---------------- */
  var DENSITY = {
    low:  { ratio: 0.16, gap: 16 },
    mid:  { ratio: 0.32, gap: 9 },
    high: { ratio: 0.55, gap: 5 }
  };
  var MAX_BLANKS = 400;

  /**
   * @param toks     tokenize 结果
   * @param opt.density 'low'|'mid'|'high'
   * @param opt.forced  必挖索引数组（历史错点）
   * @param opt.exclude 手动还原的索引数组
   * @param opt.boostTerms 需要加权的词面（错点同词加权）
   * @return 排序后的索引数组
   */
  function autoSelect(toks, opt) {
    opt = opt || {};
    var cfg = DENSITY[opt.density] || DENSITY.mid;
    var forced = opt.forced || [], exclude = {}, boost = {};
    (opt.exclude || []).forEach(function (i) { exclude[i] = 1; });
    (opt.boostTerms || []).forEach(function (w) { boost[RT.util.normalize(w)] = 1; });

    var sc = score(toks), i, cands = [];
    for (i = 0; i < toks.length; i++) {
      if (!toks[i].cz || exclude[i]) continue;
      var v = sc[i];
      if (boost[RT.util.normalize(toks[i].s)]) v += 2.5;
      cands.push({ i: i, v: v, p: toks[i].p, len: toks[i].s.length });
    }
    cands.sort(function (a, b) { return b.v - a.v || a.i - b.i; });

    var target = RT.util.clamp(Math.round(cands.length * cfg.ratio), Math.min(1, cands.length), MAX_BLANKS);
    var picked = [], taken = {}, used = {};
    var maxPer = opt.density === 'high' ? 2 : 1;   // 同一个词最多挖几次，避免重复刷同一词

    /* 先放入必挖（历史错点），并让它们参与间距计算 */
    forced.forEach(function (i) {
      if (toks[i] && toks[i].ck && !taken[i] && picked.length < MAX_BLANKS) {
        taken[i] = 1;
        var kf = RT.util.normalize(toks[i].s);
        used[kf] = (used[kf] || 0) + 1;
        picked.push({ i: i, p: toks[i].p, len: toks[i].s.length });
      }
    });

    function farEnough(c, gap) {
      for (var k = 0; k < picked.length; k++) {
        var q = picked[k];
        if (c.p < q.p + q.len + gap && q.p < c.p + c.len + gap) return false;
      }
      return true;
    }

    /* 多轮：先按标准间距 + 去重限制，仍不足则逐步放宽 */
    var gaps = [cfg.gap, Math.max(2, Math.floor(cfg.gap / 2)), 1];
    for (var g = 0; g < gaps.length && picked.length < target; g++) {
      var lim = g === 0 ? maxPer : maxPer + g;
      for (i = 0; i < cands.length && picked.length < target; i++) {
        var c = cands[i];
        if (taken[c.i]) continue;
        var key = RT.util.normalize(toks[c.i].s);
        if ((used[key] || 0) >= lim) continue;
        if (!farEnough(c, gaps[g])) continue;
        taken[c.i] = 1; used[key] = (used[key] || 0) + 1; picked.push(c);
      }
    }

    return picked.map(function (x) { return x.i; }).sort(function (a, b) { return a - b; });
  }

  /** 取某个 token 所在句子的 token 区间（复习卡片用） */
  function sentenceRange(toks, idx) {
    var st = toks[idx] ? toks[idx].st : 0, a = idx, b = idx;
    while (a > 0 && toks[a - 1].st === st) a--;
    while (b < toks.length - 1 && toks[b + 1].st === st) b++;
    /* 句子过长时围绕目标截断 */
    if (b - a > 90) { a = Math.max(a, idx - 45); b = Math.min(b, idx + 45); }
    return [a, b];
  }

  /* ---------------- 4) 建议挖空（基于本引擎打分，不依赖外部分词） ----------------
     思路：复用 autoSelect 同一套 score() 重要性打分，把"当前还没挖、但分数高"的
     token 标记为建议（虚线下划线，点一下即挖）。好处：完全本地、确定性、可调，
     且"建议"和"自动挖"用的是同一把尺子，用户不会觉得两套逻辑打架。
     建议数量 = 在「自动多」密度基础上再放宽一档，确保总比当前已挖的多一些可选。 */

  /**
   * 标记建议挖空的 token（写入 t.suggest）。
   * @param toks tokenize 结果
   * @param blanks 当前已挖索引数组
   * @param density 当前密度（决定基线）
   */
  function suggestTokens(toks, blanks, density) {
    blanks = blanks || [];
    var sc = score(toks);
    var cands = [];
    toks.forEach(function (t, i) {
      if (t.cz && blanks.indexOf(i) < 0 && sc[i] > 0) cands.push({ i: i, v: sc[i] });
    });
    cands.sort(function (a, b) { return b.v - a.v; });
    // 建议上限：比"自动多"再多一档，保证有得选；至少给一些
    var K = Math.round(cands.length * 0.55);
    if (K < 3 && cands.length) K = Math.min(3, cands.length);
    toks.forEach(function (t) { t.suggest = false; });
    for (var j = 0; j < K && j < cands.length; j++) toks[cands[j].i].suggest = true;
  }

  RT.cloze = {
    tokenize: tokenize,
    score: score,
    autoSelect: autoSelect,
    sentenceRange: sentenceRange,
    suggestTokens: suggestTokens,
    DENSITY: DENSITY
  };
})(window.RT);
