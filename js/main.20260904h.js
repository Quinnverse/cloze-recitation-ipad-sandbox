/* ============================================================
   main.js · 主程序（视图路由 + 事件委托 + 练习流程）
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';
  var $ = RT.util.$, $$ = RT.util.$$, esc = RT.util.esc, uid = RT.util.uid;

  /* 全局错误兜底：任何未捕获的异常都弹出来，而不是静默"点不动"，
     方便定位（尤其 Edge 上偶发的运行时错误）。 */
  window.addEventListener('error', function (e) {
    var msg = (e && e.error && e.error.message) || e.message || '未知错误';
    if (RT.util && RT.util.toast) RT.util.toast('⚠ ' + msg);
    console.error('[global error]', e && e.error || e);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason; var msg = (r && r.message) || String(r);
    if (RT.util && RT.util.toast) RT.util.toast('⚠ ' + msg);
    console.error('[unhandled rejection]', r);
  });
  var cloze = RT.cloze, store = RT.store, ui = RT.ui, importer = RT.importer;

  // 触屏划词模式标志：开启后（移动端默认开），设计模式正文整体临时允许原生选区
  // （含已挖蓝词），使触屏长按划选可跨词顺畅进行；桌面端恒为 false，绝不影响鼠标行为。
  var touchSelectMode = false;
  function isTouchSelect() { return touchSelectMode; }
  function isTouchDevice() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
  }

  var DEMO = '艾宾浩斯(Hermann Ebbinghaus)于1885年提出遗忘曲线，发现遗忘在学习之后立即开始，且最初遗忘速度很快，以后逐渐缓慢。' +
    '记忆分为瞬时记忆、短时记忆和长时记忆。复述是保持信息的关键，分散复习比集中复习更高效。' +
    '1956年米勒(Miller)指出短时记忆容量约为7±2个组块。过度学习达到150%时保持效果最好。';

  var state = {
    view: 'sessions',
    cur: null,        // 当前 session
    baseToks: null,   // 原始分词（基准，不随自定义挖空改动）
    toks: null,       // 应用自定义挖空区间后的 token 序列（用于渲染/判分）
    blanks: [],       // 当前挖空 token 索引（引擎自动 + 自定义合并）
    autoBlanks: [],   // 引擎自动挖空索引（reCloze 产生）
    customRanges: [], // 自定义挖空字符区间 [[s,e],...]（用户拖选产生，严格按选区）
    clearedRanges: [],// 用户取消过挖空、且不再希望显示建议虚线的词区间
    forcedWrongs: [], // 未毕业错点强制重现：[{ s, e, wid, token }]（每次生成填空必挖，黄底）
    density: 'mid',
    mode: 'design',   // design（选空）| practice（练习：输入作答+提交批改）| fill（展示：直接看答案）
    results: {}       // 遗留字段
  };

  /* ---------------- 视图路由 ---------------- */
  function go(view) {
    state.view = view;
    $$('.view').forEach(function (v) { v.hidden = true; });
    var map = { sessions: 'v-sessions', new: 'v-new', practice: 'v-practice', stats: 'v-stats', wrong: 'v-wrong' };
    var el = document.getElementById(map[view]); if (el) el.hidden = false;
    $$('.nav-i,.tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-go') === view); });

    if (view === 'sessions') ui.renderSessions();
    else if (view === 'stats') ui.renderStats();
    else if (view === 'wrong') ui.renderWrong();
    window.scrollTo(0, 0);
  }

  /* ---------------- 新建会话 ---------------- */
  function openNew(prefill) {
    $('#newTitle').value = prefill && prefill.title || '';
    $('#newText').value = prefill && prefill.text || '';
    updateCharCount();
    go('new');
  }

  function updateCharCount() {
    var n = ($('#newText').value || '').length;
    $('#charCount').textContent = n + ' 字';
  }

  function createSession() {
    var title = ($('#newTitle').value || '').trim() || ('会话 ' + (store.listSessions().length + 1));
    var text = ($('#newText').value || '').trim();
    if (text.length < 4) { RT.util.toast('请先粘贴或导入要背的内容'); return; }
    var s = {
      id: uid('s'), title: title, text: text, createdAt: Date.now(), updatedAt: Date.now(),
      blanks: [], wrong: {}, lastResult: null, reps: []
    };
    store.addSession(s);
    enterPractice(s);
  }

  /* ---------------- 进入练习 ---------------- */
  function enterPractice(s) {
    if (!s) return;
    state.cur = s;
    var text = (s.text || '').trim();
    if (!text) { RT.util.toast('该会话没有内容，无法练习'); return; }
    try {
      state.baseToks = cloze.tokenize(text);
    } catch (e) {
      console.error('[tokenize error]', e);
      state.baseToks = [{ s: text, t: 'cn', p: 0, cz: false, ck: true }];
    }
    if (!state.baseToks || !state.baseToks.length) { RT.util.toast('该会话内容无法解析'); return; }
    state.mode = 'design';
    state.results = {};
    // 恢复自定义挖空区间（先于引擎挖空叠加）
    state.customRanges = Array.isArray(s.customRanges) ? s.customRanges.filter(function (r) {
      return Array.isArray(r) && r.length === 2 && r[0] >= 0 && r[1] > r[0];
    }) : [];
    state.clearedRanges = Array.isArray(s.clearedRanges) ? s.clearedRanges.filter(function (r) {
      return Array.isArray(r) && r.length === 2 && r[0] >= 0 && r[1] > r[0];
    }) : [];
    // 已有挖空则沿用（清洗越界索引），否则按默认密度自动挖空
    if (s.blanks && s.blanks.length) state.autoBlanks = cleanBlanks(s.blanks, state.baseToks.length);
    else { reCloze(false); }
    setDensity(s.density || state.density, false);
    // 未毕业错点强制重现（corrects<5）：每次进入/生成都重新计算
    computeForcedWrongs();
    // 叠加自定义区间与强制区间，重算最终 toks / blanks
    rebuildFromRanges();
    loadSuggests();
    $('#btnRetry').hidden = true; $('#btnSubmit').hidden = true;
    $('#btnStart').hidden = false; $('#btnPractice').hidden = false;
    // 触屏端始终支持“静止长按普通正文”，无需额外模式开关。
    if (isTouchDevice()) {
      touchSelectMode = true;
    }
    go('practice');
    renderPractice();
    $('#pHint').innerHTML = '<b>三种挖空方式（任选）：</b>① 上方「自动少/中/多」一键按重点词挖；② <span style="background:#DBEAFE;color:#1D4ED8;padding:0 4px;border-radius:5px">浅蓝底</span>是已挖的词，点一下可整块取消；<span style="background:#FEF3C7;color:#B45309;padding:0 4px;border-radius:5px">黄底</span>是错题强制重现的空（<b>练习中答对</b>满 5 次自动解除）；③ <span class="suggest-tip">虚线下划线</span>点一下即挖；触屏可<b>静止长按普通正文</b> → 点「＋挖空」。调好空后任选：<b>练习填空</b>（输入作答+提交批改，错空自动进错题库）或<b>展示填空</b>（直接看答案）。';
  }

  function renderPractice() {
    // 设计模式下，每次渲染都按当前已挖状态重算建议（去掉已挖、保留高价值可选词）
    if (state.mode === 'design') {
      RT.cloze.suggestTokens(state.toks, state.blanks, state.density);
      // 用户取消过挖空的词，不再显示建议虚线（问题1：取消挖空需同步移除划线残留）
      if (state.clearedRanges.length) {
        state.toks.forEach(function (t) {
          if (!t.suggest) return;
          var ts = t.p, te = t.p + t.s.length;
          for (var k = 0; k < state.clearedRanges.length; k++) {
            var r = state.clearedRanges[k];
            if (r[0] < te && r[1] > ts) { t.suggest = false; break; }
          }
        });
      }
    }
    ui.renderPractice(state.cur, state.toks, state.blanks, state.mode);
  }

  /* 建议挖空：用本引擎打分标记高价值可选词（虚线下划线），不依赖外部分词。 */
  function loadSuggests() {
    if (state.mode === 'design') renderPractice();
  }

  /* ---------------- 挖空逻辑 ---------------- */
  // 清洗 blanks：去掉越界 / 非整数 / 非法的索引，防止渲染或判分时访问 toks[k] 越界。
  // 这能消除因存储的旧索引（文本改过、分词变化）导致的各种运行期异常。
  function cleanBlanks(arr, maxLen) {
    if (!arr || !arr.length) return [];
    var seen = {}, out = [];
    arr.forEach(function (i) {
      i = Number(i);
      if (!Number.isInteger(i) || i < 0 || i >= maxLen || seen[i]) return;
      seen[i] = 1; out.push(i);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function setDensity(d, reClozeNow) {
    state.density = d;
    $$('#densitySeg button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-d') === d); });
    if (reClozeNow !== false) reCloze(false);
  }

  function reCloze(keepManual) {
    var s = state.cur;
    var exclude = keepManual ? state.autoBlanks.slice() : [];
    state.autoBlanks = cloze.autoSelect(state.baseToks, {
      density: state.density, forced: [], exclude: exclude
    });
    s.blanks = state.autoBlanks.slice();
    s.density = state.density;
    store.updateSession(s.id, { blanks: s.blanks, density: s.density });
    // 未毕业错点不依赖自动挖空：独立按字符区间强制重现
    computeForcedWrongs();
    rebuildFromRanges();
  }

  /* ---------------- 错题强制重现 ----------------
     未毕业错点（corrects < 5，且记录仍存在）在每次生成/进入填空时必须挖空。
     通过 (sessionId, token, sentence) 在 baseToks 里反查该词的字符区间，
     生成 forcedWrongs 列表，rebuildFromRanges 会把它并入统一掩码并打 forced 标记。 */
  function computeForcedWrongs() {
    state.forcedWrongs = [];
    if (!state.cur || !state.baseToks) return;
    var sid = state.cur.id;
    var wr = RT.store.raw().wrongs || [];
    wr.forEach(function (w) {
      if (w.sessionId !== sid) return;
      if ((w.corrects || 0) >= 5) return;               // 已毕业：不再强制
      if (!w.token) return;
      var toks = state.baseToks;
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (!t || t.t === 'br' || t.t === 'sp') continue;
        if (t.s !== w.token) continue;
        // 同词多次出现时，用所在句消歧，定位到确切的那一句
        if (w.sentence) {
          var rng = cloze.sentenceRange(toks, i);
          var sent = toks.slice(rng[0], rng[1] + 1).map(function (x) { return x.s; }).join('');
          if (sent !== w.sentence) continue;
        }
        // 与已有强制区间去重（同句同词只保留一条记录）
        var dup = state.forcedWrongs.some(function (f) { return f.s === t.p && f.e === t.p + t.s.length; });
        if (!dup) state.forcedWrongs.push({ s: t.p, e: t.p + t.s.length, wid: w.id, token: w.token });
        break;
      }
    });
  }

  /* 用 baseToks + autoBlanks + customRanges 重算最终的 state.toks 与 state.blanks。
     保证：① 自定义挖空严格精确（字符级切分）；② 取消挖空后碎片自动合并还原；
     ③ 渲染/判分只依赖最终的 state.toks / state.blanks。

     关键修正（修复"断词位置不合理 / 点一个取消两个 / 取消反而变大"）：
     旧实现为每个区间独立生成 segCuts 再合并，当同一 token 同时被「自动挖空区间」与
     「自定义区间」覆盖时，会产生重叠/重复的切点，光标拼接时切出越界、重复、错位的子片段，
     使 token 文本与字符偏移被污染；污染后的偏移再传给 removeCustomRangeAt，
     导致它算出的 [sOff,eOff] 与存储的 customRange 对不上 → 取消失败甚至把空格扩大到多处。
     新实现改为「逐字符覆盖掩码」：先把所有区间合并为一个布尔掩码（某字符是否被任一区间覆盖），
     再按覆盖连续性切分成相邻段 —— 任意 token 只会被干净地切成「连续挖空段 + 连续非挖空段」，
     永不产生重叠切点，因此「一次连续选区 = 一个连续空格」，取消也只移除它自己。 */
  function rebuildFromRanges() {
    var toks = state.baseToks, out = [], acc = 0, blankSet = {};
    // 合并所有挖空区间（自动 + 自定义 + 错题强制）为统一掩码源
    var ranges = state.autoBlanks.map(function (i) {
      var t = toks[i]; return [t.p, t.p + t.s.length];
    }).concat(state.customRanges.map(function (r) { return [r[0], r[1]]; }))
      .concat((state.forcedWrongs || []).map(function (f) { return [f.s, f.e]; }));
    var franges = (state.forcedWrongs || []).map(function (f) { return [f.s, f.e]; });
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], ts = t.p, te = t.p + t.s.length;
      var isBr = (t.t === 'br');
      // 换行必须保持为结构节点；空格则参与自定义选区的逐字符覆盖计算。
      // 否则“词 A + 空格 + 词 B”的连续手选会在这里被强行断开，UI 只能渲染成两个蓝块。
      if (isBr) { out.push(t); acc += t.s.length; continue; }
      // 逐字符判是否被任一区间覆盖；同时判是否被强制区间覆盖（黄底标记）
      var len = te - ts, covered = [], manual = [], anyC = false;
      for (var c = 0; c < len; c++) {
        var cp = ts + c, isCov = false, isManual = false;
        for (var k = 0; k < ranges.length; k++) {
          if (cp >= ranges[k][0] && cp < ranges[k][1]) { isCov = true; break; }
        }
        for (var m = 0; m < state.customRanges.length; m++) {
          if (cp >= state.customRanges[m][0] && cp < state.customRanges[m][1]) { isManual = true; break; }
        }
        covered[c] = isCov; manual[c] = isManual; if (isCov) anyC = true;
      }
      if (!anyC) {
        out.push(t);
      } else {
        // 按覆盖连续性切分为相邻段（闭合、无重叠）
        var runStart = 0;
        for (var c2 = 1; c2 <= len; c2++) {
          if (c2 === len || covered[c2] !== covered[runStart] || manual[c2] !== manual[runStart]) {
            out.push(mkTok(t, ts + runStart, c2 - runStart, acc + runStart, covered[runStart],
              isForcedRun(franges, ts + runStart, ts + c2, covered[runStart]), manual[runStart]));
            runStart = c2;
          }
        }
      }
      acc += t.s.length;
    }
    // 重算 p
    var p = 0; out.forEach(function (t) { t.p = p; p += t.s.length; });
    state.toks = out;
    // 收集挖空 token 索引
    out.forEach(function (t, idx) { if (t._blank) blankSet[idx] = 1; });
    state.blanks = Object.keys(blankSet).map(Number).sort(function (a, b) { return a - b; });
  }
  // 一个挖空段是否属于强制区间（段整体落在强制区间内，或强制区间覆盖其起点）
  function isForcedRun(franges, s, e, isBlank) {
    if (!isBlank) return false;
    for (var k = 0; k < franges.length; k++) {
      if (franges[k][0] <= s && e <= franges[k][1]) return true;
    }
    return false;
  }
  function mkTok(src, p, len, accP, isBlank, forced, manual) {
    return {
      s: src.s.substring(p - src.p, (p - src.p) + len),
      t: src.t, p: accP, ck: src.ck, st: src.st,
      suggest: false, _blank: !!isBlank, forced: !!forced, manual: !!manual
    };
  }

  // 取消挖空：移除覆盖该块的所有自定义区间（并同步去掉引擎自动挖空索引）。
  // 定义在前，确保 toggleBlank / selRemove 调用时已完成函数声明 hoisting。
  function removeCustomRangeAt(idxs) {
    if (!idxs || !idxs.length) return;
    var mins = [], maxe = 0;
    idxs.forEach(function (i) {
      var t = state.toks[i]; if (!t) return;
      mins.push(t.p); maxe = Math.max(maxe, t.p + t.s.length);
    });
    var sOff = Math.min.apply(null, mins), eOff = maxe;
    state.customRanges = state.customRanges.filter(function (r) {
      return !(r[0] < eOff && r[1] > sOff);
    });
    state.autoBlanks = state.autoBlanks.filter(function (i) {
      var t = state.baseToks[i]; if (!t) return false;
      var ts = t.p, te = t.p + t.s.length;
      return !(ts >= sOff && te <= eOff);
    });
    // 记录取消区间 → 不再显示建议虚线（问题1）
    state.clearedRanges.push([sOff, eOff]);
    rebuildFromRanges();
    state.cur.customRanges = state.customRanges.map(function (r) { return r.slice(); });
    state.cur.blanks = state.autoBlanks.slice();
    state.cur.clearedRanges = state.clearedRanges.map(function (r) { return r.slice(); });
  }

  // 自定义挖空：把用户选中的 [sOff,eOff) 区间加入 state.customRanges，再 rebuild。
  // 定义在前，确保 toggleBlank / selAdd 调用时已完成函数声明 hoisting。
  function applyCustomCloze(sOff, eOff) {
    // 与已有区间合并（若有重叠则取并集，避免碎片）
    var merged = false;
    for (var k = 0; k < state.customRanges.length; k++) {
      var r = state.customRanges[k];
      if (sOff <= r[1] && eOff >= r[0]) {
        state.customRanges[k] = [Math.min(r[0], sOff), Math.max(r[1], eOff)];
        merged = true; break;
      }
    }
    if (!merged) state.customRanges.push([sOff, eOff]);
    // 该处重新挖空后，旧的"取消虚线"标记已无意义，清理掉避免持续压制建议
    state.clearedRanges = state.clearedRanges.filter(function (cr) {
      return !(cr[0] >= sOff && cr[1] <= eOff);
    });
    rebuildFromRanges();
    state.cur.customRanges = state.customRanges.map(function (r) { return r.slice(); });
    return true;
  }

  function toggleBlank(idxOrArr) {
    var arr = Array.isArray(idxOrArr) ? idxOrArr : [idxOrArr];
    // 错题强制重现的空不可手动取消（答对满 5 次自动解除；也可在错题库删除记录）
    var forcedHit = arr.some(function (i) { var t = state.toks[i]; return t && t.forced; });
    if (forcedHit) { RT.util.toast('错题强制重现中，浏览满 5 次后自动解除'); return; }
    var isOn = arr.every(function (i) { return state.blanks.indexOf(i) >= 0; });
    var sOff = Infinity, eOff = 0;
    arr.forEach(function (i) {
      var t = state.toks[i]; if (!t) return;
      sOff = Math.min(sOff, t.p); eOff = Math.max(eOff, t.p + t.s.length);
    });
    if (sOff === Infinity) return;
    if (isOn) {
      removeCustomRangeAt(arr);
    } else {
      applyCustomCloze(sOff, eOff);
    }
    store.updateSession(state.cur.id, {
      blanks: state.autoBlanks.slice(),
      customRanges: state.customRanges.map(function (r) { return r.slice(); }),
      clearedRanges: state.clearedRanges.map(function (r) { return r.slice(); })
    });
    renderPractice();
  }

  /* ---------------- 练习模式（输入作答 + 提交批改） ---------------- */
  function startPractice() {
    if (!state.blanks.length) { RT.util.toast('先选一些要挖的空'); return; }
    state.mode = 'practice';
    $('#btnStart').hidden = true; $('#btnPractice').hidden = true;
    $('#btnSubmit').hidden = false; $('#btnRetry').hidden = true;
    $('#resultBox').hidden = true;
    renderPractice();
    $('#pHint').innerHTML = '在空白处输入答案，填完点<b>提交批改</b>（或回车）。<span style="background:#FEF3C7;color:#B45309;padding:0 4px;border-radius:5px">黄底</span>为错题强制重现的空：<b>答对</b>计 1 次进度（满 5 次毕业），答错则累计错误次数并记入错答历史。';
    var first = $('#paper').querySelector('input'); if (first) first.focus();
  }

  function submit() {
    var inputs = $$('#paper input');
    var details = [], correct = [], wrong = [], total = inputs.length, skipped = 0;
    inputs.forEach(function (inp) {
      var block = (inp.getAttribute('data-block') || ('' + inp.getAttribute('data-i'))).split(',').map(Number)
        .filter(function (k) { return Number.isInteger(k) && k >= 0 && k < state.toks.length; });
      if (!block.length) return;
      var gold = block.map(function (k) { return state.toks[k].s; }).join('');
      var filled = inp.value;
      var ok = filled.trim() !== '' && RT.util.sameAnswer(filled, gold);
      details.push({ i: block[0], block: block, gold: gold, filled: filled, ok: ok, forced: block.some(function (k) { return state.toks[k] && state.toks[k].forced; }) });
      if (ok) correct.push(block[0]); else { if (!filled.trim()) skipped++; wrong.push(block[0]); }
    });
    var rate = pctSafe(correct.length, total);
    state.mode = 'result';

    // 批改落库：错空 → 错题库（mistakes+1 + 错答历史 tries）；强制空答对 → corrects+1（满 5 毕业）
    var wrongsAdded = 0, graduated = 0;
    details.forEach(function (d) {
      var rng = cloze.sentenceRange(state.toks, d.i);
      var sentence = state.toks.slice(rng[0], rng[1] + 1).map(function (t) { return t.s; }).join('');
      if (!d.ok) {
        var item = store.ensureWrong({
          sessionId: state.cur.id, sessionTitle: state.cur.title, token: d.gold,
          gold: d.gold, sentence: sentence
        });
        store.noteWrong(item.id, d.filled);          // mistakes+1、lastWrong、tries 去重合并
        wrongsAdded++;
      } else if (d.forced) {
        // 答对才计数：强制空答对 corrects+1，满 5 次毕业不再强制重现
        var w = null;
        (RT.store.raw().wrongs || []).forEach(function (x) {
          if (x.sessionId === state.cur.id && x.token === d.gold && (x.sentence || '') === sentence) w = x;
        });
        if (w && (w.corrects || 0) < 5) {
          var nc = (w.corrects || 0) + 1;
          store.updateWrong(w.id, { corrects: nc, lastRight: Date.now() });
          if (nc >= 5) graduated++;
        }
      }
    });

    // 会话统计
    var rep = { at: Date.now(), rate: rate, blankCount: total, wrongIdx: wrong.slice() };
    state.cur.reps = state.cur.reps || [];
    state.cur.reps.push(rep);
    state.cur.lastResult = { rate: rate, at: Date.now() };
    state.cur.updatedAt = Date.now();
    store.updateSession(state.cur.id, { reps: state.cur.reps, lastResult: state.cur.lastResult, updatedAt: state.cur.updatedAt });

    // 逐空标记 ✓/✗，错空内联展示正确答案
    renderResultWithStyles(details);
    ui.showResult(state.cur, { total: total, correct: correct, wrong: wrong, skipped: skipped, rate: rate, details: details, wrongsAdded: wrongsAdded, graduated: graduated });
    ui.renderHeroKpis();
    $('#btnSubmit').hidden = true; $('#btnRetry').hidden = false;
  }

  function renderResultWithStyles(details) {
    details.forEach(function (d) {
      var span = $('#paper').querySelector('.bk[data-i="' + d.i + '"]');
      if (!span) return;
      var inp = span.querySelector('input');
      if (inp) inp.disabled = true;
      span.classList.add(d.ok ? 'r-ok' : 'r-bad');
      if (!d.ok) {
        var mk = document.createElement('span'); mk.className = 'mk'; mk.textContent = '✗'; span.appendChild(mk);
        var ans = document.createElement('span'); ans.className = 'ans'; ans.textContent = d.gold; span.appendChild(ans);
      } else {
        var ok = document.createElement('span'); ok.className = 'mk'; ok.textContent = '✓'; span.appendChild(ok);
      }
    });
  }

  function retry() {
    // 返回编辑模式：可调整挖空 / 重新按密度生成，再练习或展示均可
    state.mode = 'design';
    $('#btnStart').hidden = false; $('#btnPractice').hidden = false;
    $('#btnSubmit').hidden = true; $('#btnRetry').hidden = true;
    $('#resultBox').hidden = true;
    computeForcedWrongs();
    rebuildFromRanges();
    renderPractice();
    $('#pHint').innerHTML = '<b>编辑模式：</b>可调整挖空（黄底＝错题强制重现，不可取消）；点「重新按密度挖」生成新一组空，再点<b>练习填空</b>作答或<b>展示填空</b>看答案。';
  }

  /* ---------------- 展示模式（纯浏览，直接看答案；不计数） ---------------- */
  function startFill() {
    if (!state.blanks.length) { RT.util.toast('先选一些要挖的空'); return; }
    state.mode = 'fill';
    $('#btnStart').hidden = true; $('#btnPractice').hidden = true;
    $('#btnSubmit').hidden = true; $('#btnRetry').hidden = false;
    renderPractice();
    $('#pHint').innerHTML = '<b>展示模式：</b>每空直接显示<b>正确答案</b>（黄底为错题强制重现，附此前的错答历史与进度 N/5）。纯浏览不计数——毕业进度只在<b>练习模式答对</b>时 +1。点<b>返回编辑</b>可调整挖空，或改用<b>练习填空</b>自测。';
    // 记一次浏览型练习（无评分、不计数）
    state.cur.reps = state.cur.reps || [];
    state.cur.reps.push({ at: Date.now(), blankCount: state.blanks.length, viewed: true, rate: null });
    state.cur.updatedAt = Date.now();
    store.updateSession(state.cur.id, { reps: state.cur.reps, updatedAt: state.cur.updatedAt });
    ui.renderHeroKpis();
  }

  /* ---------------- 删除会话 ---------------- */
  function delSession(id) {
    var s = store.getSession(id); if (!s) return;
    RT.util.confirmBox('删除会话', '确定删除「' + (s.title || '') + '」及其全部学习记录？此操作不可恢复。', function () {
      store.deleteSession(id);
      RT.util.toast('已删除');
      if (state.cur && state.cur.id === id) { state.cur = null; }
      go('sessions');
    });
  }

  /* ---------------- 事件委托 ---------------- */
  // 安全的 closest：兼容 SVG 目标（Edge 上点击 SVG 内部 <path>/<svg> 时，
  // 个别内核 e.target.closest 可能不存在或行为异常），统一走 Element 原型。
  function closestEl(node, sel) {
    var n = node;
    while (n && n !== document.body && n.nodeType === 1) {
      try { if (n.matches && n.matches(sel)) return n; } catch (e) {}
      n = n.parentNode;
    }
    // 兜底：直接用标准 closest（若可用）
    try { if (node && node.closest) return node.closest(sel); } catch (e) {}
    return null;
  }

  function bind() {
    document.body.addEventListener('click', function (e) {
      var t = e.target;
      try {
      if (!t || !t.nodeType) return;

      // 拖选浮层按钮：优先处理，避免被下方任何判断吞掉
      if (t.id === 'selAdd' || closestEl(t, '#selAdd')) {
        if (lastRange && lastRange.sOff != null) {
          applyCustomCloze(lastRange.sOff, lastRange.eOff);
          store.updateSession(state.cur.id, {
            blanks: state.autoBlanks.slice(),
            customRanges: state.customRanges.map(function (r) { return r.slice(); })
          });
          clearHighlight(); clearSelPop(); window.getSelection().removeAllRanges();
          renderPractice();
        }
        return;
      }
      if (t.id === 'selRemove' || closestEl(t, '#selRemove')) {
        if (lastRange && lastRange.sOff != null) {
          // 反算该字符区间覆盖的 token 索引，交给 removeCustomRangeAt 处理
          var idxs = [];
          for (var di = 0; di < state.toks.length; di++) {
            var dt = state.toks[di];
            if (dt.t === 'br' || dt.t === 'sp') continue;
            var dts = dt.p, dte = dt.p + dt.s.length;
            if (dte > lastRange.sOff && dts < lastRange.eOff) idxs.push(di);
          }
          removeCustomRangeAt(idxs);
          store.updateSession(state.cur.id, {
            blanks: state.autoBlanks.slice(),
            customRanges: state.customRanges.map(function (r) { return r.slice(); }),
            clearedRanges: state.clearedRanges.map(function (r) { return r.slice(); })
          });
          clearHighlight(); clearSelPop(); window.getSelection().removeAllRanges();
          renderPractice();
        }
        return;
      }

      // 导航
      var goBtn = closestEl(t, '[data-go]');
      if (goBtn) { go(goBtn.getAttribute('data-go')); return; }

      // 删除会话
      var del = closestEl(t, '[data-del]');
      if (del) { e.stopPropagation(); delSession(del.getAttribute('data-del')); return; }

      // 错题库会话卡片（优先于通用 .scard 进入会话分支，避免被劫持）
      var wsCard0 = closestEl(t, '[data-wsid]');
      if (wsCard0) { ui.openWrongSession(wsCard0.getAttribute('data-wsid')); return; }

      // 进入会话
      var card = closestEl(t, '.scard');
      if (card && !closestEl(t, '[data-del]') && !closestEl(t, '[data-wsid]')) { var sid = card.getAttribute('data-sid'); var s = store.getSession(sid); if (s) enterPractice(s); return; }

      // 设计模式：点蓝词(已挖，浅蓝底) / 点建议词(虚线下划线) 加/去空
      if (state.mode === 'design') {
        var tk = closestEl(t, '.tk.on, .tk.suggest');
        if (tk) {
          var blk = tk.getAttribute('data-block');
          toggleBlank(blk ? blk.split(',').map(Number) : +tk.getAttribute('data-i'));
          return;
        }
      }

      // 练习按钮
      if (t.id === 'btnStart') { startFill(); return; }
      if (t.id === 'btnPractice') { startPractice(); return; }
      if (t.id === 'btnSubmit') { submit(); return; }
      if (t.id === 'btnRetry') { retry(); return; }
      if (t.id === 'btnRecloze') { reCloze(true); renderPractice(); RT.util.toast('已重新挖空（错题强制空自动保留）'); return; }
      if (t.id === 'btnClearBlank') {
        state.customRanges = []; state.autoBlanks = [];
        state.cur.customRanges = []; state.cur.blanks = [];
        store.updateSession(state.cur.id, { blanks: [], customRanges: [] });
        computeForcedWrongs();
        rebuildFromRanges(); renderPractice();
        return;
      }

      // 密度
      var d = closestEl(t, '#densitySeg button');
      if (d) { setDensity(d.getAttribute('data-d'), true); renderPractice(); return; }

      // 错题库：会话列表 → 详情
      var wsCard = closestEl(t, '[data-wsid]');
      if (wsCard) { ui.openWrongSession(wsCard.getAttribute('data-wsid')); return; }
      if (closestEl(t, '[data-wback]')) { ui.backWrongList(); return; }
      var wd = closestEl(t, '[data-wdel]');
      if (wd) {
        var wId = wd.getAttribute('data-wdel');
        var wRec = null;
        RT.store.raw().wrongs.forEach(function (x) { if (x.id === wId) wRec = x; });
        if (wRec) {
          RT.util.confirmBox('删除错题记录', '删除「' + (wRec.token || '') + '」这条错题记录？删除后不再强制重现，此操作不可恢复。', function () {
            RT.store.deleteWrong(wId).then(function () {
              RT.util.toast('已删除该错题记录');
              ui.renderWrong(); ui.renderHeroKpis();
            });
          });
        }
        return;
      }

      // 新建 / 示例
      if (t.id === 'btnCreate') { createSession(); return; }
      if (t.id === 'btnDemo') { openNew({ title: '示例 · 记忆心理学', text: DEMO }); return; }

      // 触屏划词模式开关（移动端可见；开启后正文整体允许原生选区，便于跨词划选）
      if (t.id === 'btnTouchSel') {
        touchSelectMode = !touchSelectMode;
        $('#btnTouchSel').classList.toggle('on', touchSelectMode);
        var paper = $('#paper');
        if (paper) paper.classList.toggle('touch-sel', touchSelectMode);
        RT.util.toast(touchSelectMode ? '划词模式已开：长按文字拖动即可选范围' : '划词模式已关');
        return;
      }
      if (t.id === 'btnClearText') { $('#newText').value = ''; updateCharCount(); return; }

      // 数据备份：导出 / 导入
      if (t.id === 'btnExport') { store.exportData(); RT.util.toast('已导出备份文件'); return; }
      if (t.id === 'btnImport') { var fi = $('#importFile'); if (fi) fi.click(); return; }
      } catch (err) {
        // 单个按钮处理出错不应让整个委托死掉（否则会连带其他按钮也点不动）
        console.error('[click handler error]', err);
        if (RT && RT.util && RT.util.toast) RT.util.toast('操作出错：' + (err && err.message || err));
      }
    });

    // ---- 拖选挖空浮层（仅设计模式） ----
    var selPop = $('#selPop'), lastRange = null;

    function clearSelPop() { if (selPop) selPop.hidden = true; lastRange = null; }

    function showSelPop(rect) {
      if (!selPop) return;
      selPop.hidden = false;
      // 先显示以获取实际尺寸
      var pw = selPop.offsetWidth || 96, ph = selPop.offsetHeight || 38;
      var x = rect.left + window.scrollX + rect.width / 2 - pw / 2;
      var y = rect.top + window.scrollY - ph - 8;
      if (y < window.scrollY + 6) y = rect.bottom + window.scrollY + 8; // 上方空间不足则放下方
      x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
      selPop.style.left = x + 'px';
      selPop.style.top = y + 'px';
    }

    function tokenRangeFromSelection() {
      var paper = $('#paper'); if (!paper) return null;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      var range = sel.getRangeAt(0);
      if (!paper.contains(range.startContainer) || !paper.contains(range.endContainer)) return null;
      var text = sel.toString();
      if (text.trim().length < 1) return null;
      // 直接拿选区的真实 DOM 起点/终点，根据每个 token 的 p 偏移精确定位。
      // 不再依赖 getBoundingClientRect 或 indexOf（重复词会错位，导致"跳到前面"）。
      var startT = resolveOffset(range.startContainer, range.startOffset);
      var endT = resolveOffset(range.endContainer, range.endOffset);
      if (startT == null || endT == null) return null;
      var sOff = startT.off, eOff = endT.off;
      if (eOff < sOff) { var tmp = sOff; sOff = eOff; eOff = tmp; }
      if (eOff <= sOff) return null;
      // 严格按用户选区的「字符偏移区间」[sOff, eOff) 执行挖空，
      // 不做任何 token 中心吸附 / 分词扩展 → 选什么挖什么。
      return { idxs: null, sOff: sOff, eOff: eOff, text: text, range: range };
    }

    // 把一个 DOM 节点 + 偏移，解析成"原文中的字符偏移"。
    // 通过遍历该节点到 #paper 的文本节点路径，累加前面所有文本节点的长度，
    // 得到精确、稳定的字符位置（与 token.p 同一坐标系）。
    function resolveOffset(node, offset) {
      if (!node) return null;
      if (node.nodeType === 3) {
        var before = 0, n = node;
        while (n && n !== $('#paper')) {
          var prev = n.previousSibling;
          while (prev) { before += prev.textContent ? prev.textContent.length : 0; prev = prev.previousSibling; }
          n = n.parentNode;
        }
        return { off: before + offset };
      }
      // 元素节点：取它自身前面的文本长度 + 内部前 offset 个子节点的文本长度
      var sum = 0, el = node;
      var prev2 = el.previousSibling;
      while (prev2) { sum += prev2.textContent ? prev2.textContent.length : 0; prev2 = prev2.previousSibling; }
      var parent = el.parentNode;
      // el 是 parent 的第几个子节点
      var idxInParent = 0, sib = parent ? parent.firstChild : null;
      while (sib && sib !== el) { idxInParent++; sib = sib.nextSibling; }
      // 累加 parent 到 paper 的前置文本（不含 el 及其后续）
      var acc = 0, pp = parent;
      while (pp && pp !== $('#paper')) {
        var ps = pp.previousSibling;
        while (ps) { acc += ps.textContent ? ps.textContent.length : 0; ps = ps.previousSibling; }
        pp = pp.parentNode;
      }
      // el 前面的兄弟节点的文本
      var sibSum = 0, s2 = parent ? parent.firstChild : null;
      while (s2 && s2 !== el) { sibSum += s2.textContent ? s2.textContent.length : 0; s2 = s2.nextSibling; }
      // el 内部前 offset 个元素的文本
      var innerSum = 0;
      for (var c = 0; c < offset && el.childNodes[c]; c++) {
        innerSum += el.childNodes[c].textContent ? el.childNodes[c].textContent.length : 0;
      }
      return { off: acc + sibSum + innerSum };
    }

    // 桌面端：鼠标抬起后处理选区（保留原行为，完全不变）
    document.addEventListener('mouseup', function (e) {
      if (state.view !== 'practice' || state.mode !== 'design') return;
      // 点在浮层自己身上不处理（按钮点击由 click 委托处理）
      if (selPop && selPop.contains(e.target)) return;
      // mouseup 时选区已就绪，直接同步处理（去掉 setTimeout 以兼容无头/同步测试，真实浏览器行为一致）
      var r = tokenRangeFromSelection();
      if (!r) { clearSelPop(); return; }
      lastRange = r;
      // 该段字符区间是否完全落在已挖范围内 → 显示「取消挖空」，否则显示「＋挖空」
      var sOff = r.sOff, eOff = r.eOff, allBlank = true;
      for (var bi = 0; bi < state.toks.length; bi++) {
        var t = state.toks[bi];
        if (t.t === 'br' || t.t === 'sp') continue;
        var ts = t.p, te = t.p + t.s.length;
        if (te <= sOff || ts >= eOff) continue;
        if (state.blanks.indexOf(bi) < 0) { allBlank = false; break; }
      }
      var addBtn = $('#selAdd'), rmBtn = $('#selRemove');
      if (addBtn) addBtn.hidden = allBlank;
      if (rmBtn) rmBtn.hidden = !allBlank;
      var rect = r.range.getBoundingClientRect();
      showSelPop(rect);
    });

    // ---- 移动端触控划词增强 ----
    // 触屏设备（含 iPad / 手机）上，原生划词浮层常不触发 mouseup；
    // 改用 selectionchange 监听原生选区（触摸长按划选会产生 selection），
    // 但只对"触摸产生"的选区做处理，鼠标选区仍由 mouseup 负责 → 桌面行为不变。
    var isTouchSel = false;
    document.addEventListener('selectionchange', function () {
      if (state.view !== 'practice' || state.mode !== 'design') return;
      if (!isTouchSel) return;          // 仅处理触摸产生的选区，桌面鼠标选区交给 mouseup
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { clearSelPop(); return; }
      var r = tokenRangeFromSelection();
      if (!r) { clearSelPop(); return; }
      lastRange = r;
      var sOff = r.sOff, eOff = r.eOff, allBlank = true;
      for (var bi = 0; bi < state.toks.length; bi++) {
        var t = state.toks[bi];
        if (t.t === 'br' || t.t === 'sp') continue;
        var ts = t.p, te = t.p + t.s.length;
        if (te <= sOff || ts >= eOff) continue;
        if (state.blanks.indexOf(bi) < 0) { allBlank = false; break; }
      }
      var addBtn = $('#selAdd'), rmBtn = $('#selRemove');
      if (addBtn) addBtn.hidden = allBlank;
      if (rmBtn) rmBtn.hidden = !allBlank;
      var rect = r.range.getBoundingClientRect();
      showSelPop(rect);
    });

    // 把视口坐标 (x,y) 解析成文档字符锚点（兼容 Blink/WebKit 与 Firefox）。
    // 隔离框内正文 user-select:none，不会由用户原生选区触发系统菜单；
    // 划词改为「程序化选区」：手指按下记锚点，移动时用此处算当前字符位置，由代码 setRange 画高亮。
    function caretPoint(x, y) {
      if (document.caretRangeFromPoint) {
        var r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
      }
      if (document.caretPositionFromPoint) {
        var p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
      }
      return null;
    }

    // 正文 DOM、屏幕坐标和原文偏移只维护这一份缓存。拖动过程中只读取缓存，
    // 避免每次 touchmove 重建大量 Range；高亮和最终挖空也共用这套偏移。
    var textGeometry = null;
    function getTextGeometry() {
      var paper = $('#paper'); if (!paper) return null;
      if (textGeometry && textGeometry.paper === paper &&
          (!textGeometry.nodes.length || paper.contains(textGeometry.nodes[0].node))) return textGeometry;
      var walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT, null);
      var geo = { paper: paper, nodes: [], chars: [], length: 0 }, node, acc = 0;
      while ((node = walker.nextNode())) {
        if (node.parentElement && closestEl(node.parentElement, '#selLayer')) continue;
        var len = node.nodeValue ? node.nodeValue.length : 0;
        geo.nodes.push({ node: node, s: acc, e: acc + len });
        for (var i = 0; i < len; i++) {
          var r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
          var rect = r.getBoundingClientRect();
          if (rect.width || rect.height) geo.chars.push({ s: acc + i, e: acc + i + 1, l: rect.left, r: rect.right, t: rect.top, b: rect.bottom });
        }
        acc += len;
      }
      geo.length = acc; textGeometry = geo; return geo;
    }
    function geometryOffset(node, offset, geo) {
      if (!geo || !node || node.nodeType !== 3) return null;
      for (var i = 0; i < geo.nodes.length; i++) if (geo.nodes[i].node === node) return geo.nodes[i].s + offset;
      return null;
    }

    // iPad Safari 在 user-select:none 区域可能不给 caretRangeFromPoint 结果。
    // 用 Range 几何信息定位最近的文本字符，确保普通正文（不在 .tk span 内）也能长按。
    function caretPointByRects(x, y) {
      var paper = $('#paper'); if (!paper) return null;
      var walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT, null);
      var node, best = null, bestDist = Infinity;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.length) continue;
        var whole = document.createRange(); whole.selectNodeContents(node);
        var rects = whole.getClientRects();
        for (var ri = 0; ri < rects.length; ri++) {
          var rr = rects[ri];
          var dx = x < rr.left ? rr.left - x : (x > rr.right ? x - rr.right : 0);
          var dy = y < rr.top ? rr.top - y : (y > rr.bottom ? y - rr.bottom : 0);
          var dist = dx * dx + dy * dy;
          if (dist < bestDist) { bestDist = dist; best = node; }
        }
      }
      if (!best || bestDist > 900) return null;
      var bestOff = 0, charDist = Infinity;
      for (var i = 0; i < best.nodeValue.length; i++) {
        var cr = document.createRange(); cr.setStart(best, i); cr.setEnd(best, i + 1);
        var br = cr.getBoundingClientRect(); if (!br.width && !br.height) continue;
        var cx = br.left + br.width / 2, cy = br.top + br.height / 2;
        var cd = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (cd < charDist) { charDist = cd; bestOff = i; }
      }
      return { node: best, offset: bestOff };
    }

    // 手柄拖动直接计算 #paper 的绝对字符偏移，避免 iPad 在 user-select:none 下
    // 返回错误的 DOM caret（常固定为正文开头，表现为手柄拖了但范围不变）。
    function paperOffsetAtPoint(x, y) {
      var geo = getTextGeometry(); if (!geo) return null;
      var cp = caretPoint(x, y), direct = cp && geometryOffset(cp.node, cp.offset, geo);
      if (direct != null) return Math.max(0, Math.min(geo.length, direct));
      var best = null, bestDist = Infinity;
      for (var i = 0; i < geo.chars.length; i++) {
        var c = geo.chars[i], cx = (c.l + c.r) / 2, cy = (c.t + c.b) / 2;
        var dx = cx - x, dy = cy - y, dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      if (!best) return null;
      return x > (best.l + best.r) / 2 ? best.e : best.s;
    }

    function pointFromPaperOffset(off) {
      var geo = getTextGeometry(); if (!geo) return null;
      for (var i = 0; i < geo.nodes.length; i++) {
        var n = geo.nodes[i]; if (off <= n.e) return { node: n.node, offset: Math.max(0, off - n.s) };
      }
      return null;
    }

    function paintTokenAtPoint(point) {
      if (!point) return false;
      var resolved = resolveOffset(point.node, point.offset); if (!resolved) return false;
      var off = resolved.off, tok = null;
      for (var i = 0; i < state.toks.length; i++) {
        var candidate = state.toks[i];
        if (candidate.t === 'br' || candidate.t === 'sp' || !candidate.s) continue;
        if (off >= candidate.p && off < candidate.p + candidate.s.length) { tok = candidate; break; }
      }
      if (!tok) return false;
      var start = pointFromPaperOffset(tok.p), end = pointFromPaperOffset(tok.p + tok.s.length);
      if (!start || !end) return false;
      paintHighlight(start.node, start.offset, end.node, end.offset);
      return true;
    }

    function paintTokenAtOffset(off) {
      if (off == null) return false;
      for (var i = 0; i < state.toks.length; i++) {
        var tok = state.toks[i];
        if (tok.t === 'br' || tok.t === 'sp' || !tok.s) continue;
        if (off >= tok.p && off < tok.p + tok.s.length) return paintOffsets(tok.p, tok.p + tok.s.length);
      }
      return false;
    }

    // 触摸划词（纯自定义字符级拖选，彻底绕开原生选区 → 永不开系统菜单口子）：
    // - 隔离框（#paper.txt user-select:none + touch-callout:none）：长按不选中、不弹复制菜单
    //   （解决 vivo/iPad 等 ROM 无视 callout 仍弹菜单的问题）。
    // - 拖选由我们自己在 touchmove 用 caretPoint 计算首尾字符锚点，
    //   用覆盖层 #selLayer 画高亮 + 自己的 selPop，绝不调用 window.getSelection().addRange。
    // - touchmove 里仅当「已进入拖选」时才 preventDefault 锁滚动；否则放行交给浏览器滚动，
    //   修复 vivo 等机型正文无法上下滚动的问题。
    var tpAnchor = null;      // 按下锚点 {node,offset}
    var tpAnchorOff = null;   // 按下位置的绝对字符偏移（iPad/WebView 主路径）
    var tpHitToken = null;    // touchstart 真实命中的 token；iPad 上不依赖 caretRangeFromPoint
    var tpDragging = false;   // 是否已进入拖选（超过阈值或长按）
    var tpStartX = 0, tpStartY = 0;
    var tpLongPress = false;  // 长按已进入选词态
    var lpTimer = null;       // 长按计时器
    var MOVE_THRESH = 8;      // 像素：超过视为拖选而非单击
    var curRange = null;      // 当前选区字符偏移 {sOff,eOff}
    var activeHandle = null;  // 正在拖动的自定义边界：start / end
    var lastHandleOffset = null;
    var suppressPaperClickUntil = 0; // 吞掉长按/拖选结束后浏览器合成的 ghost click

    // 高亮覆盖层：挂到 #paper 内（CSS #selLayer{position:absolute;inset:0} + #paper:relative）。
    // 注意：renderPractice 用 paper.innerHTML 整体重渲染会把 #selLayer 从文档中剥离成游离节点，
    // 导致后续高亮画到游离节点而不显示。故每次绘制前 ensureSelLayer() 检测是否在文档内，
    // 若被剥离则重建并重新挂回 #paper，保证自定义高亮恒可见。
    var selLayer = null;
    function ensureSelLayer() {
      var paper = $('#paper');
      if (!paper) return;
      if (selLayer && paper.contains(selLayer)) return; // 仍在文档内，复用
      selLayer = $('#selLayer');                        // 可能已被重渲染剥离 → null
      if (!selLayer) {
        selLayer = document.createElement('div');
        selLayer.id = 'selLayer';
      }
      if (!paper.contains(selLayer)) paper.appendChild(selLayer);
    }

    // 清除自定义高亮覆盖层（先确保层在文档内，避免清空游离节点）
    function clearHighlight() { ensureSelLayer(); if (selLayer) selLayer.innerHTML = ''; }

    // 用两个字符锚点画出高亮，并计算字符偏移写回 curRange/lastRange（供挖空按钮复用）
    function paintHighlight(aNode, aOff, bNode, bOff, exactS, exactE) {
      var paper = $('#paper'); if (!paper) return;
      // renderPractice 会 paper.innerHTML=html 把 #selLayer 剥离；每次绘制前确保它仍在 #paper 内
      if (!selLayer || !selLayer.parentNode || selLayer.parentNode !== paper) {
        if (selLayer && selLayer.parentNode) selLayer.parentNode.removeChild(selLayer);
        selLayer = document.createElement('div');
        selLayer.id = 'selLayer';
        paper.appendChild(selLayer);
      }
      clearHighlight();
      var range = document.createRange();
      try {
        // 归一化方向
        var before = (aNode === bNode) ? (aOff <= bOff)
          : (aNode.compareDocumentPosition(bNode) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (before) { range.setStart(aNode, aOff); range.setEnd(bNode, bOff); }
        else { range.setStart(bNode, bOff); range.setEnd(aNode, aOff); }
      } catch (_) { return; }
      var pr = paper.getBoundingClientRect();
      var rects = range.getClientRects();
      if (!rects.length) return;
      var minTop = Infinity, maxBot = -Infinity, cx = 0, n = 0;
      var firstRect = rects[0], lastRect = rects[rects.length - 1];
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        var d = document.createElement('div'); d.className = 'sel-hl';
        d.style.position = 'absolute';
        d.style.left = (r.left - pr.left + paper.scrollLeft) + 'px';
        d.style.top = (r.top - pr.top + paper.scrollTop) + 'px';
        d.style.width = r.width + 'px';
        d.style.height = r.height + 'px';
        selLayer.appendChild(d);
        minTop = Math.min(minTop, r.top); maxBot = Math.max(maxBot, r.bottom);
        cx += (r.left + r.width / 2); n++;
      }
      // 计算字符偏移（用于真正挖空）
      var so = exactS == null ? resolveOffset(aNode, aOff) : { off: exactS };
      var eo = exactE == null ? resolveOffset(bNode, bOff) : { off: exactE };
      var sOff = so ? so.off : 0, eOff = eo ? eo.off : 0; if (eOff < sOff) { var t = sOff; sOff = eOff; eOff = t; }
      curRange = { sOff: sOff, eOff: eOff };
      lastRange = curRange; // 让现有 ＋挖空/−取消 按钮处理器直接复用
      selLayer.setAttribute('data-range-start', String(sOff));
      selLayer.setAttribute('data-range-end', String(eOff));
      // 原生选区被禁用后，必须提供自己的左右边界手柄。手柄挂在覆盖层上，
      // 只有手柄本身接收触摸；正文区域仍由浏览器处理 pan-y 上下滚动。
      var startHandle = document.createElement('span');
      startHandle.className = 'sel-handle start'; startHandle.setAttribute('data-handle', 'start');
      startHandle.setAttribute('aria-label', '调整选区左边界');
      startHandle.style.left = (firstRect.left - 14 - pr.left + paper.scrollLeft) + 'px';
      startHandle.style.top = (firstRect.top + firstRect.height / 2 - pr.top + paper.scrollTop) + 'px';
      var endHandle = document.createElement('span');
      endHandle.className = 'sel-handle end'; endHandle.setAttribute('data-handle', 'end');
      endHandle.setAttribute('aria-label', '调整选区右边界');
      endHandle.style.left = (lastRect.right + 14 - pr.left + paper.scrollLeft) + 'px';
      endHandle.style.top = (lastRect.top + lastRect.height / 2 - pr.top + paper.scrollTop) + 'px';
      selLayer.appendChild(startHandle); selLayer.appendChild(endHandle);
      // selPop 定位（showSelPop 接收 {left,top,bottom,width}）
      showSelPop({ left: cx / n, top: minTop, bottom: maxBot, width: 0 });
    }

    function paintOffsets(sOff, eOff) {
      var start = pointFromPaperOffset(sOff), end = pointFromPaperOffset(eOff);
      if (!start || !end || eOff <= sOff) return false;
      paintHighlight(start.node, start.offset, end.node, end.offset, sOff, eOff);
      return true;
    }

    document.addEventListener('touchstart', function (e) {
      isTouchSel = true;
      if (state.view !== 'practice' || state.mode !== 'design') return;
      if (selPop && selPop.contains(e.target)) return;
      if (!e.touches || e.touches.length !== 1) { clearTimeout(lpTimer); return; }
      var t = e.touches[0];
      var handle = e.target && closestEl(e.target, '.sel-handle');
      if (handle && curRange) {
        activeHandle = handle.getAttribute('data-handle');
        lastHandleOffset = null;
        handle.classList.add('dragging');
        clearTimeout(lpTimer); suppressPaperClickUntil = Date.now() + 800;
        e.preventDefault();
        return;
      }
      activeHandle = null;
      tpStartX = t.clientX; tpStartY = t.clientY;
      tpDragging = false; tpLongPress = false;
      var hitEl = e.target && e.target.nodeType === 1 ? e.target : null;
      if (!hitEl && document.elementFromPoint) hitEl = document.elementFromPoint(t.clientX, t.clientY);
      tpHitToken = hitEl && closestEl(hitEl, '.tk');
      // 清除上一次残留高亮
      clearHighlight();
      // 虚线建议词和蓝色已挖词只走单击逻辑，不启动长按状态机。
      if (tpHitToken) { clearTimeout(lpTimer); tpAnchor = null; tpAnchorOff = null; return; }
      tpAnchorOff = paperOffsetAtPoint(t.clientX, t.clientY);
      // 常规路径已拿到绝对偏移，不再重复做一次全量 Range 几何扫描；
      // 只有极端 WebView 连缓存定位也失败时，才退回旧的 DOM 锚点兜底。
      tpAnchor = tpAnchorOff == null ? (caretPoint(t.clientX, t.clientY) || caretPointByRects(t.clientX, t.clientY)) : null;
      // 长按 350ms 未移动 → 进入选词态（不再依赖开关也能选）
      clearTimeout(lpTimer);
      lpTimer = setTimeout(function () {
        if (tpDragging) return;
        tpLongPress = true;
        suppressPaperClickUntil = Date.now() + 800;
        var p = $('#paper'); if (p) p.classList.add('dragging');
        // 普通正文静止长按：直接选中数据模型中的完整 token，不要求继续拖动。
        if (!paintTokenAtOffset(tpAnchorOff) && !paintTokenAtPoint(tpAnchor)) RT.util.toast('请长按一段普通正文');
      }, 350);
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (state.view !== 'practice' || state.mode !== 'design') return;
      if (activeHandle && curRange) {
        var ht = e.touches && e.touches[0]; if (!ht) return;
        var handleOff = paperOffsetAtPoint(ht.clientX, ht.clientY);
        if (handleOff != null) {
          var maxOff = state.cur && state.cur.text ? state.cur.text.length :
            (state.toks && state.toks.length ? state.toks[state.toks.length - 1].p + (state.toks[state.toks.length - 1].s || '').length : 0);
          var next = Math.max(0, Math.min(maxOff, handleOff));
          if (activeHandle === 'start') next = Math.min(next, curRange.eOff - 1);
          else next = Math.max(next, curRange.sOff + 1);
          if (next !== lastHandleOffset) {
            var ns = activeHandle === 'start' ? next : curRange.sOff;
            var ne = activeHandle === 'end' ? next : curRange.eOff;
            paintOffsets(ns, ne); lastHandleOffset = next;
            var live = selLayer && selLayer.querySelector('.sel-handle.' + activeHandle);
            if (live) live.classList.add('dragging');
          }
        }
        suppressPaperClickUntil = Date.now() + 800;
        e.preventDefault();
        return;
      }
      var t = e.touches && e.touches[0]; if (!t || (!tpAnchor && tpAnchorOff == null)) return;
      var dx = t.clientX - tpStartX, dy = t.clientY - tpStartY;
      // 阈值内等待静止长按；任何明显移动都只作为浏览手势，不提供拖选。
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clearTimeout(lpTimer);
      tpDragging = true;
      if (tpLongPress) { clearSelPop(); clearHighlight(); }
      tpLongPress = false;
    }, { passive: false });

    document.addEventListener('touchend', function (e) {
      if (state.view !== 'practice' || state.mode !== 'design') { clearTimeout(lpTimer); return; }
      clearTimeout(lpTimer);
      if (activeHandle) {
        activeHandle = null; lastHandleOffset = null; tpAnchor = null; tpAnchorOff = null; tpHitToken = null;
        suppressPaperClickUntil = Date.now() + 800;
        return;
      }
      var p = $('#paper'); if (p) p.classList.remove('dragging');
      if (tpLongPress) {
        // 静止长按选区保留，等待用户点击“＋挖空”。
        tpDragging = false; tpLongPress = false; tpAnchor = null; tpAnchorOff = null; tpHitToken = null; return;
      }
      // 未拖选：长按但未移动 → 清除；或点空白收起浮层
      tpLongPress = false; tpAnchor = null; tpAnchorOff = null; tpHitToken = null;
      if (selPop && !selPop.hidden && !selPop.contains(e.target) && !(e.target && e.target.closest && e.target.closest('#paper'))) {
        clearSelPop(); clearHighlight();
      }
    }, { passive: true });

    document.addEventListener('touchcancel', function () {
      clearTimeout(lpTimer);
      tpAnchor = null; tpAnchorOff = null; tpHitToken = null; tpDragging = false; tpLongPress = false; activeHandle = null; lastHandleOffset = null;
      var p = $('#paper'); if (p) p.classList.remove('dragging');
      clearSelPop(); clearHighlight();
    }, { passive: true });

    // 长按或拖选之后移动浏览器通常仍会派发一次合成 click；若放行，它会触发
    // token 的“点按挖空/取消”，造成一次手势执行两个动作。捕获阶段将其截断。
    document.addEventListener('click', function (e) {
      if (Date.now() > suppressPaperClickUntil) return;
      if (selPop && selPop.contains(e.target)) return;
      if (e.target && closestEl(e.target, '#paper')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // 触摸结束后把标志复位，避免影响后续鼠标操作（双模式设备）
    document.addEventListener('mousemove', function () { isTouchSel = false; }, { passive: true });

    // 点击空白处收起浮层
    document.addEventListener('mousedown', function (e) {
      if (selPop && !selPop.hidden && !selPop.contains(e.target) && !closestEl(e.target, '#paper')) {
        clearSelPop();
      }
    });

    // 屏蔽设计模式下 #paper 内的原生右键/长按菜单（避免"选中文字→右键搜索"
    // 抢占选区与挖空浮层）。全局拦截，但放行可编辑区（textarea/input）保留正常复制。
    document.addEventListener('contextmenu', function (e) {
      if (!e.target) return;
      var tag = e.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return; // 编辑区不拦截
      // 设计模式下：正文内、或挖空浮层自身上的长按菜单都拦截（防 iOS/安卓「复制/翻译/查询」抢焦点）
      if (state.view === 'practice' && state.mode === 'design' &&
          ((e.target && closestEl(e.target, '#paper')) || (selPop && selPop.contains(e.target)))) {
        e.preventDefault();
        var nativeSel = window.getSelection && window.getSelection();
        if (nativeSel && nativeSel.rangeCount) nativeSel.removeAllRanges();
      }
    }, true);
    // 厂商 WebView 的“翻译/搜索”常由原生选区而非 contextmenu 触发；在选区创建
    // 之前拦截 selectstart，作为 CSS 之外的第二道防线。只限制触屏设计区，输入框和
    // 桌面鼠标拖选仍保持原行为。
    document.addEventListener('selectstart', function (e) {
      if (!isTouchDevice() || state.view !== 'practice' || state.mode !== 'design') return;
      if (e.target && closestEl(e.target, '#paper')) e.preventDefault();
    }, true);
    // 浮层自身不可被选中、禁止系统长按菜单(callout)。
    // 关键：绝不对触屏的 mousedown 调 preventDefault —— 否则移动端合成 click 被吞，
    // 点「＋挖空/−取消」无反应（vivo 实测复现）。按钮直接走原生 click 委托即可。
    if (selPop) {
      selPop.setAttribute('style', (selPop.getAttribute('style') || '') + ';user-select:none;-webkit-user-select:none;-webkit-touch-callout:none');
    }

    // 注意：#selAdd / #selRemove 不单独绑定 click（在 Edge 等浏览器上，
    // mousedown 收起浮层会抢在浮层按钮的 click 之前把按钮清掉，导致"点不动")。
    // 改为在 body 的 click 委托里统一处理（见下方 selAdd/selRemove 分支）。

    // 浮层按钮点击：加到 body click 委托（避免 Edge 上 mousedown 先行收起浮层导致点不动）
    // 见下方 document.body click 委托中的 selAdd/selRemove 分支。

    // 文本域字数
    var ta = $('#newText'); if (ta) ta.addEventListener('input', updateCharCount);

    // 练习模式：输入框内回车提交批改
    document.body.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('#paper input')) {
        e.preventDefault();
        if (state.mode === 'practice') submit();
      }
    });

    // 文件导入
    var fileInput = $('#file'), drop = $('#drop');
    if (fileInput) fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    });
    if (drop) {
      drop.addEventListener('click', function () { fileInput.click(); });
      drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }

    // 导入备份文件
    var importInput = $('#importFile');
    if (importInput) importInput.addEventListener('change', function () {
      var f = importInput.files && importInput.files[0];
      if (!f) return;
      RT.util.confirmBox('导入备份', '导入将覆盖当前全部数据，确定继续？', function () {
        store.importData(f).then(function () {
          RT.util.toast('导入成功'); go('sessions');
        }).catch(function (err) { RT.util.toast('导入失败：' + (err && err.message || err)); });
      });
      importInput.value = '';
    });
  }

  function handleFile(file) {
    importer.parse(file).then(function (text) {
      var cur = ($('#newText').value || '').trim();
      $('#newText').value = cur ? (cur + '\n\n' + text) : text;
      if (!($('#newTitle').value || '').trim()) {
        var name = (file.name || '').replace(/\.[^.]+$/, '');
        $('#newTitle').value = name || '导入资料';
      }
      updateCharCount();
    }).catch(function () { /* tip 已提示 */ });
  }

  function pctSafe(a, b) { return b ? Math.round(a / b * 100) : 0; }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
    go('sessions');
  }
  // 先等 IndexedDB 加载完成，再渲染（保证数据已就绪）。
  // 加超时兜底：极端情况下（如 IDB 被禁用/卡死）3 秒内未就绪也强制启动，
  // 避免"整个页面按钮点不动"——事件绑定不依赖数据层。
  var started = false;
  function startOnce() { if (started) return; started = true; init(); }
  RT.store.ready().then(startOnce).catch(startOnce);
  setTimeout(startOnce, 3000);

  RT.app = { state: state, go: go, enterPractice: enterPractice, isTouchDevice: isTouchDevice, isTouchSelect: isTouchSelect };
})(window.RT);
