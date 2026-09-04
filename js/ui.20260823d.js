/* ============================================================
   ui.js · 渲染层（各视图的纯渲染函数，不绑定事件）
   事件统一在 main.js 里委托绑定。
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';
  var $ = RT.util.$, esc = RT.util.esc, fmtWhen = RT.util.fmtWhen, pct = RT.util.pct;

  /* ---------------- 会话列表 ---------------- */
  function renderSessions() {
    var list = RT.store.listSessions();
    var box = $('#sessList');
    $('#sessCount').textContent = list.length ? ('共 ' + list.length + ' 个') : '';
    renderHeroKpis();

    if (!list.length) {
      box.innerHTML = '<div class="empty"><b>还没有会话</b>点右上角「＋ 新建会话」，导入资料或粘贴文本，马上生成挖空开始背。</div>';
      return;
    }
    box.innerHTML = list.map(function (s) {
      var reps = s.reps || [];
      var last = reps[reps.length - 1];
      var blanks = reps.reduce(function (a, r) { return a + r.blankCount; }, 0);
      var rate = reps.length ? Math.round(reps.reduce(function (a, r) { return a + r.blankCount * r.rate; }, 0) / Math.max(1, blanks)) : 0;
      var wrongN = Object.keys(s.wrong || {}).length;
      var preview = (s.text || '').replace(/\s+/g, ' ').slice(0, 80);
      return '' +
        '<div class="scard" data-sid="' + s.id + '">' +
          '<button class="icon-btn" data-del="' + s.id + '" title="删除会话">🗑</button>' +
          '<h3>' + esc(s.title || '未命名会话') + '</h3>' +
          '<div class="prev">' + esc(preview) + '</div>' +
          '<div class="chips">' +
            '<span class="chip pri">练习 ' + reps.length + ' 次</span>' +
            '<span class="chip">挖空 ' + blanks + '</span>' +
            (rate ? '<span class="chip ' + (rate >= 80 ? 'ok' : 'warm') + '">均正确率 ' + rate + '%</span>' : '') +
            (wrongN ? '<span class="chip bad">错点 ' + wrongN + '</span>' : '') +
          '</div>' +
          '<div class="muted sm">更新于 ' + fmtWhen(s.updatedAt || s.createdAt) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderHeroKpis() {
    var t = RT.store.totalLearned();
    var wrongs = RT.store.raw().wrongs || [];
    var open = wrongs.filter(function (w) { return (w.corrects || 0) < 5; }).length;
    $('#heroKpis').innerHTML = '' +
      '<div class="kpi"><div class="kpi-n grad">' + t.sessions + '</div><div class="kpi-l">学习会话</div></div>' +
      '<div class="kpi"><div class="kpi-n">' + t.blanks + '</div><div class="kpi-l">累计挖空浏览</div></div>' +
      '<div class="kpi"><div class="kpi-n warm">' + t.days + '</div><div class="kpi-l">学习天数</div></div>' +
      '<div class="kpi"><div class="kpi-n ' + (open ? 'warm' : '') + '">' + open + '</div><div class="kpi-l">待巩固错点</div></div>';
  }

  /* ---------------- 练习视图 ---------------- */
  function renderPractice(s, toks, blanks, mode) {
    $('#pTitle').textContent = s.title || '未命名会话';
    var meta = (s.reps || []).length ? ('已练习 ' + (s.reps.length) + ' 次') : '未练习';
    if (Object.keys(s.wrong || {}).length) meta += ' · 错点 ' + Object.keys(s.wrong).length + ' 个';
    $('#pMeta').textContent = meta;

    var html = '', bi = 0;
    var paper = $('#paper');
    paper.className = 'txt' + (mode === 'design' ? ' mode-design' : '');
    // 触屏划词模式：re-render 后保留 touch-sel 类（touchSelectMode 由 main 维护，
    // 这里仅按标志回写 class，保证划词模式在重试/重渲染后不丢失）
    if (RT.app && RT.app.isTouchSelect && RT.app.isTouchSelect()) {
      paper.classList.add('touch-sel');
    }
    var i = 0;
    while (i < toks.length) {
      var t = toks[i];
      if (t.t === 'br') { html += '\n'; i++; continue; }
      if (t.t === 'sp') { html += ' '; i++; continue; }
      var isBlank = blanks.indexOf(i) >= 0;
      if (isBlank) {
        // 合并相邻空白成"一整块"
        var block = [i];
        var j = i + 1;
        while (j < toks.length && blanks.indexOf(j) >= 0) { block.push(j); j++; }
        bi++;
        var segText = block.map(function (k) { return toks[k].s; }).join('');
        var forced = block.some(function (k) { return toks[k] && toks[k].forced; });
        if (mode === 'design') {
          // 块内每个 token 包一层独立内层 span(.seg)，使浏览器原生双击/拖选能精确落在
          // 单个 token 上，避免选中整块时把前一个词一起带上（选词边界 off-by-one）。
          var inners = block.map(function (k) {
            return '<span class="seg" data-i="' + k + '">' + esc(toks[k].s) + '</span>';
          }).join('');
          html += '<span class="tk on' + (forced ? ' forced' : '') + '" data-i="' + i + '" data-block="' + block.join(',') + '" title="' + (forced ? '错题强制重现 · 浏览满5次自动解除' : '已挖空 · 点一下取消') + '">' + inners + '</span>';
        } else if (mode === 'practice') {
          // 练习模式：输入作答（合并块共享一个输入框，提交时整块判分）
          var longCls = segText.length >= 4 ? ' long' : '';
          var sz = Math.max(3, segText.length);
          html += '<span class="bk' + (forced ? ' forced' : '') + '" data-i="' + i + '" data-block="' + block.join(',') + '"><input type="text" class="' + longCls.trim() + '" data-i="' + i + '" data-block="' + block.join(',') + '" size="' + sz + '" autocomplete="off" placeholder="' + bi + '"' + (forced ? ' title="错题强制重现 · 答对计 1 次进度"' : '') + '></span>';
        } else if (mode === 'fill') {
          // 展示模式：直接显示正确答案；强制空黄底并附错答历史与进度 N/5（答对才计数）
          var w = findWrong(s.id, segText, toks, i);
          var tries = (w && Array.isArray(w.tries) ? w.tries.slice() : []).sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
          var missHtml = tries.length
            ? tries.slice(0, 2).map(function (tr) {
                return '<span class="bk-miss" title="此前的错误答案（共 ' + (tr.count || 1) + ' 次）">✗ ' + esc(tr.v) + '</span>';
              }).join('') + (tries.length > 2 ? '<span class="bk-miss" title="' + esc(tries.slice(2).map(function (tr) { return tr.v + '×' + (tr.count || 1); }).join('、')) + '">…</span>' : '')
            : '';
          html += '<span class="bk show' + (forced ? ' forced' : '') + '" data-i="' + i + '" data-block="' + block.join(',') + '">' +
            '<span class="bk-ans">' + esc(segText) + '</span>' +
            (forced && w ? '<span class="bk-cnt">' + Math.min(5, w.corrects || 0) + '/5</span>' : '') +
            missHtml +
            '</span>';
        }
        i = j; continue;
      }
      if (mode === 'design' && t.suggest && t.ck) {
        // 系统建议挖空的关键词（名词/动词/术语）：虚线下划线，点一下即挖
        html += '<span class="tk suggest" data-i="' + i + '" title="名词/动词/术语 · 点击挖空">' + esc(t.s) + '</span>';
      } else {
        html += esc(t.s);
      }
      i++;
    }
    paper.innerHTML = html;
  }

  // 用 (会话, 答案文本, 所在句) 在错题库里反查该空的错题记录（展示模式用）
  function findWrong(sessionId, gold, toks, i) {
    var wrongs = RT.store.raw().wrongs || [];
    var rng = RT.cloze.sentenceRange(toks, i);
    var sentence = toks.slice(rng[0], rng[1] + 1).map(function (t) { return t.s; }).join('');
    var hit = null;
    wrongs.forEach(function (w) {
      if (w.sessionId === sessionId && w.token === gold && (w.sentence || '') === sentence) hit = w;
    });
    return hit;
  }

  /* ---------------- 批改结果面板（练习模式） ---------------- */
  function showResult(s, result) {
    var ok = result.correct, bad = result.wrong;
    var ring = '' +
      '<div class="ring"><svg viewBox="0 0 96 96" width="96" height="96">' +
        '<circle cx="48" cy="48" r="42" fill="none" stroke="#E7EAF0" stroke-width="9"/>' +
        '<circle cx="48" cy="48" r="42" fill="none" stroke="' + (result.rate >= 80 ? '#16A34A' : '#FB923C') + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (2 * Math.PI * 42) + '" stroke-dashoffset="' + (2 * Math.PI * 42 * (1 - result.rate / 100)) + '"/></svg>' +
        '<div class="ring-t">' + result.rate + '%<small>正确率</small></div></div>';
    var summary = '<div class="score">' + ring +
      '<div><div>共 <b>' + result.total + '</b> 空</div>' +
      '<div class="muted sm">答对 ' + ok.length + ' · 答错 ' + bad.length + (result.skipped ? ' · 未填 ' + result.skipped : '') + '</div></div></div>';

    var rows = result.details.map(function (d, n) {
      var cls = d.ok ? 't-ok' : 't-bad';
      var mark = d.ok ? '✓' : '✗';
      var mine = d.filled && d.filled.trim() ? esc(d.filled) : '<i class="muted">（未填）</i>';
      return '<tr><td>' + (n + 1) + '</td><td class="' + cls + '">' + mark + '</td><td>' + esc(d.gold) + '</td><td>' + mine + '</td></tr>';
    }).join('');
    var table = '<table class="wtable"><thead><tr><th>#</th><th>结果</th><th>正确答案</th><th>你的填写</th></tr></thead><tbody>' + rows + '</tbody></table>';

    var notes = '';
    if (result.wrongsAdded) notes += '<div class="tip err" style="margin-top:12px">已将 ' + result.wrongsAdded + ' 个错空记入错题库（累计错误次数与全部错答历史），后续练习中会强制重现、黄底高亮。</div>';
    if (result.graduated) notes += '<div class="tip ok" style="margin-top:8px">🎉 ' + result.graduated + ' 个错点已答对满 5 次，毕业！不再强制重现。</div>';

    $('#resultBox').hidden = false;
    $('#resultBox').innerHTML = '<div class="card" style="margin-top:14px">' + summary + notes + table + '</div>';
  }

  /* ---------------- 每日成果 ---------------- */
  function renderStats() {
    var days = RT.store.lastNDays(14);
    var max = Math.max(1, days.reduce(function (a, d) { return Math.max(a, d.blankTotal); }, 0));
    var t = RT.store.totalLearned();
    var bars = days.map(function (d) {
      var h = Math.round(d.blankTotal / max * 100);
      return '<div><i style="height:' + h + '%" title="' + d.key + '：' + d.blankTotal + ' 空 / ' + d.rate + '%"></i><span>' + RT.util.shortDay(d.key) + '</span></div>';
    }).join('');
    var avg = days.reduce(function (a, d) { return a + d.rate; }, 0) / Math.max(1, days.filter(function (d) { return d.rounds; }).length || 1);

    $('#statsBox').innerHTML = '' +
      '<div class="card"><div class="kpis" style="margin-top:0">' +
        '<div class="kpi"><div class="kpi-n grad">' + t.sessions + '</div><div class="kpi-l">会话总数</div></div>' +
        '<div class="kpi"><div class="kpi-n">' + t.blanks + '</div><div class="kpi-l">累计练习空数</div></div>' +
        '<div class="kpi"><div class="kpi-n warm">' + t.days + '</div><div class="kpi-l">学习天数</div></div>' +
        '<div class="kpi"><div class="kpi-n">' + Math.round(avg) + '%</div><div class="kpi-l">平均正确率</div></div>' +
      '</div></div>' +
      '<div class="card"><div class="lb">近 14 天练习量</div><div class="stage-bars">' + bars + '</div>' +
      '<div class="hint" style="margin:10px 0 0">柱越高＝当天挖空练习越多；悬停查看正确率。</div></div>';
  }

  /* ---------------- 错题库（两级：会话列表 → 会话详情） ---------------- */
  var wrongDetailSid = null; // 当前查看详情的会话 id（null = 会话列表）

  function escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function openWrongSession(sid) { wrongDetailSid = sid; renderWrong(); }
  function backWrongList() { wrongDetailSid = null; renderWrong(); }

  function renderWrong() {
    if (wrongDetailSid) renderWrongDetail(wrongDetailSid);
    else renderWrongList();
  }

  /* 一级：会话列表 —— 按会话累计错误次数降序 */
  function renderWrongList() {
    var wrongs = RT.store.raw().wrongs || [];
    $('#wMeta').textContent = wrongs.length ? ('共 ' + wrongs.length + ' 个错点') : '';
    var box = $('#wrongBox');
    if (!wrongs.length) {
      box.innerHTML = '<div class="empty"><b>还没有错题记录</b>历史上做错的挖空会自动进入这里，按句子归并、按错误次数排序，集中攻克。</div>';
      return;
    }
    var bySess = {};
    wrongs.forEach(function (w) { (bySess[w.sessionId] = bySess[w.sessionId] || []).push(w); });
    var rows = Object.keys(bySess).map(function (sid) {
      var items = bySess[sid];
      var s = RT.store.getSession(sid);
      var misTot = items.reduce(function (a, w) { return a + (w.mistakes || 0); }, 0);
      var open = items.filter(function (w) { return (w.corrects || 0) < 5; }).length;
      return { sid: sid, title: s ? s.title : (items[0].sessionTitle || '已删除会话'), items: items, misTot: misTot, open: open,
        sents: Object.keys(items.reduce(function (m, w) { m[w.sentence || w.token] = 1; return m; }, {})).length };
    }).sort(function (a, b) { return b.misTot - a.misTot; });

    box.innerHTML = '<div class="hint">按会话累计错误次数从高到低排序；点击会话进入详情，句子归并展示、句内各空按错误次数排序。</div>' +
      rows.map(function (r) {
        return '<div class="scard ws-card" data-wsid="' + r.sid + '">' +
          '<div class="ws-go" aria-hidden="true">›</div>' +
          '<h3>' + esc(r.title || '未命名会话') + '</h3>' +
          '<div class="chips">' +
            '<span class="chip bad">累计错 ' + r.misTot + ' 次</span>' +
            '<span class="chip">错空 ' + r.items.length + ' 个 · 涉及 ' + r.sents + ' 句</span>' +
            (r.open ? '<span class="chip warm">待巩固 ' + r.open + ' 个</span>' : '<span class="chip ok">全部已巩固</span>') +
          '</div></div>';
      }).join('');
  }

  /* 二级：会话详情 —— 句子归并卡片；句间按累计错误次数降序，句内各空也按错误次数降序 */
  function renderWrongDetail(sid) {
    var s = RT.store.getSession(sid);
    var wrongs = (RT.store.raw().wrongs || []).filter(function (w) { return w.sessionId === sid; });
    var box = $('#wrongBox');
    if (!wrongs.length) { backWrongList(); return; }

    // 按句子归并
    var sentMap = {};
    wrongs.forEach(function (w) {
      var key = w.sentence || ('…' + w.token + '…');
      if (!sentMap[key]) sentMap[key] = { sentence: key, items: [], misTot: 0 };
      sentMap[key].items.push(w);
      sentMap[key].misTot += (w.mistakes || 0);
    });
    var sents = Object.keys(sentMap).map(function (k) { return sentMap[k]; })
      .sort(function (a, b) { return b.misTot - a.misTot; });

    var misTotal = wrongs.reduce(function (a, w) { return a + (w.mistakes || 0); }, 0);
    $('#wMeta').textContent = '累计错 ' + misTotal + ' 次 · ' + wrongs.length + ' 个错空 · ' + sents.length + ' 句';

    var html = '<div class="sec-head"><button class="btn btn-ghost btn-sm" data-wback>← 全部会话</button>' +
      '<h2 class="h2">' + esc(s ? (s.title || '未命名会话') : '已删除会话') + '</h2></div>' +
      '<div class="hint">同一句的错空归并在一张卡片；句间与句内均按错误次数从高到低排序。黄底为仍在强制重现中的错空（<b>练习中答对</b>满 5 次解除），已掌握的可点「删除」移除。曾错答按次数降序展示全部历史（同一答案多次填错合并计数）。</div>';

    sents.forEach(function (g, n) {
      var items = g.items.slice().sort(function (a, b) { return (b.mistakes || 0) - (a.mistakes || 0); });
      var rows = items.map(function (w) {
        var open = (w.corrects || 0) < 5;
        // 全部错答历史：按次数降序展示（去重合并过），一眼看出易混淆答案
        var tries = (Array.isArray(w.tries) ? w.tries.slice() : [])
          .sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
        var mine = tries.length
          ? tries.map(function (tr, k) {
              return '<span class="wd-v bad' + (k ? ' wd-v2' : '') + '">' + esc(tr.v) +
                (tr.count > 1 ? '<i class="muted sm">×' + tr.count + '</i>' : '') + '</span>';
            }).join('<span class="muted">、</span>')
          : ((w.lastWrong && String(w.lastWrong).trim()) ? '<span class="wd-v bad">' + esc(w.lastWrong) + '</span>' : '<i class="muted">（未记录）</i>');
        return '<div class="wrow">' +
          '<span class="wblank' + (open ? ' forced' : '') + '">' + esc(w.token) + '</span>' +
          '<div class="wrow-body">' +
            '<div class="wd-row"><span class="wd-k">曾错答</span>' + mine +
            '<span class="wd-k">正确</span><span class="wd-v ok">' + esc(w.gold || w.token) + '</span></div>' +
            '<div class="chips">' +
              '<span class="chip bad">错 ' + (w.mistakes || 0) + ' 次</span>' +
              '<span class="chip' + (open ? ' warm' : ' ok') + '">答对 ' + Math.min(5, w.corrects || 0) + '/5</span>' +
              '<button class="btn btn-ghost btn-sm wdel" data-wdel="' + w.id + '">删除</button>' +
            '</div>' +
          '</div></div>';
      }).join('');
      html += '<div class="card scard2">' +
        '<div class="scard2-h"><span class="chip bad">本句累计错 ' + g.misTot + ' 次</span>' +
        '<span class="muted sm">#' + (n + 1) + ' · ' + g.items.length + ' 个错空</span></div>' +
        '<div class="sent">' + markSentence(g.sentence, items) + '</div>' +
        rows + '</div>';
    });
    box.innerHTML = html;
  }

  // 在句子里高亮所有错空位置：先在原文上打占位标记，再统一转义、替换为高亮 span，
  // 避免"先转义再替换"时把已插入的 HTML 里的词再替换一遍。
  function markSentence(sentence, items) {
    var str = sentence;
    items.forEach(function (w) {
      if (!w.token) return;
      var re = new RegExp('(' + escapeRe(w.token) + ')', 'g');
      str = str.replace(re, '\u0002$1\u0003');
    });
    var escd = esc(str)
      .replace(/\u0002/g, '<span class="on blank-mark">')
      .replace(/\u0003/g, '</span>');
    return escd;
  }

  RT.ui = {
    renderSessions: renderSessions, renderPractice: renderPractice, showResult: showResult,
    renderStats: renderStats, renderWrong: renderWrong,
    openWrongSession: openWrongSession, backWrongList: backWrongList,
    renderHeroKpis: renderHeroKpis,
    showParseTip: function (m, ok) {
      var el = $('#parseTip'); if (!el) return;
      el.hidden = false; el.textContent = m;
      el.className = 'tip' + (ok === false ? ' err' : ok === true ? ' ok' : '');
    }
  };
})(window.RT);
