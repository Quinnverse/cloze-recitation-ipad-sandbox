/* ============================================================
   util.js · 通用工具（DOM / 时间 / 文本归一化）
   注意：全部使用传统 script + 全局命名空间 RT，保证 file:// 直开可用
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';

  var doc = document;

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(p) {
    return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 时间 ---------- */
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  function dayKey(ts) {
    var d = ts == null ? new Date() : new Date(ts);
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }
  function dayKeyOffset(n) { return dayKey(Date.now() + n * DAY); }
  function shortDay(key) { var p = key.split('-'); return (+p[1]) + '/' + (+p[2]); }

  function fmtWhen(ts) {
    if (!ts) return '—';
    var diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    if (diff < MIN) return '刚刚';
    if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前';
    if (dayKey(ts) === dayKey()) return '今天 ' + hm(ts);
    if (dayKey(ts) === dayKeyOffset(-1)) return '昨天 ' + hm(ts);
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function hm(ts) {
    var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }
  function fmtDelta(ms) {
    if (ms <= 0) return '已到期';
    if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + ' 分钟后';
    if (ms < DAY) return Math.round(ms / HOUR) + ' 小时后';
    return Math.round(ms / DAY) + ' 天后';
  }

  /* ---------- 文本归一化（判定用） ----------
     trim → NFKC(全角转半角) → 小写 → 去首尾标点 → 内部多余空格压缩为 1 个 */
  var EDGE_RE;
  try {
    EDGE_RE = new RegExp('^[\\s\\p{P}\\p{S}]+|[\\s\\p{P}\\p{S}]+$', 'gu');
  } catch (e) {
    EDGE_RE = /^[\s!-\/:-@\[-`{-~，。、；：？！“”‘’（）【】《》〈〉…—～·「」『』〖〗\u3000]+|[\s!-\/:-@\[-`{-~，。、；：？！“”‘’（）【】《》〈〉…—～·「」『』〖〗\u3000]+$/g;
  }

  function normalize(s) {
    s = String(s == null ? '' : s);
    if (s.normalize) { try { s = s.normalize('NFKC'); } catch (e) { /* ignore */ } }
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
    EDGE_RE.lastIndex = 0;
    s = s.replace(EDGE_RE, '');
    return s.replace(/\s+/g, ' ');
  }
  function stripAll(s) { return normalize(s).replace(/\s+/g, ''); }

  /** 判定：归一化精确匹配（中文场景额外忽略全部空白） */
  function sameAnswer(user, gold) {
    var a = normalize(user), b = normalize(gold);
    if (a === '' ) return false;
    if (a === b) return true;
    return stripAll(user) !== '' && stripAll(user) === stripAll(gold);
  }

  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2000);
  }

  /* ---------- confirm 弹窗 ---------- */
  function confirmBox(title, body, onYes) {
    var m = $('#modal');
    $('#mkTitle').textContent = title;
    $('#mkBody').textContent = body || '';
    m.hidden = false;
    function close() {
      m.hidden = true;
      $('#mkYes').onclick = null; $('#mkNo').onclick = null; m.onclick = null;
    }
    $('#mkYes').onclick = function () { close(); onYes && onYes(); };
    $('#mkNo').onclick = close;
    m.onclick = function (e) { if (e.target === m) close(); };
  }

  RT.util = {
    $: $, $$: $$, esc: esc, uid: uid,
    MIN: MIN, HOUR: HOUR, DAY: DAY,
    dayKey: dayKey, dayKeyOffset: dayKeyOffset, shortDay: shortDay,
    fmtWhen: fmtWhen, fmtDelta: fmtDelta, hm: hm,
    normalize: normalize, stripAll: stripAll, sameAnswer: sameAnswer,
    pct: pct, clamp: clamp, toast: toast, confirmBox: confirmBox
  };
})(window.RT);
