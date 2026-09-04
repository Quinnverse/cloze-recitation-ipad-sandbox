/* ============================================================
   store.js · 数据层（IndexedDB 大容量底座 + localStorage 兜底）
   对外 API 与旧版完全一致（同步读取走内存缓存，写入异步落盘），
   上层 main.js / ui.js 无需改动。
   模型：
     session = { id, title, text, createdAt, blanks:[idx], wrong:{idx:count},
                 lastResult, reps:[{at,rate,blankCount,wrongIdx:[]}] }
     wrongItem = { id, sessionId, sessionTitle, token, gold, sentence,
                   mistakes, corrects, lastWrong, tries[], createdAt }
     （tries：[{v:答案, count, firstAt, lastAt}] 去重合并的全部错答历史；
       corrects：练习答对累计次数（20260823c 起答对才计数），满 5 次"毕业"不再强制）
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';

  var DB_NAME = 'rt_db_v1', DB_VER = 1, LS_KEY = 'rt_data_v1';
  var data = { sessions: [], wrongs: [] };
  var db = null, useLS = false, readyPromise = null;
  var REPS_CAP = 200; // 每个会话练习历史软上限，防止无限膨胀

  /* ---------------- IDB 低层封装 ---------------- */
  function openDB() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no idb')); return; }
      var r = window.indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('wrongs')) {
          var ws = d.createObjectStore('wrongs', { keyPath: 'id' });
          ws.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = function (e) { db = e.target.result; res(db); };
      r.onerror = function () { rej(r.error || new Error('idb open failed')); };
    });
  }
  function tx(stores, mode) { return db.transaction(stores, mode || 'readonly'); }
  function reqP(r) {
    return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });
  }
  function txDone(t) {
    return new Promise(function (res, rej) { t.oncomplete = function () { res(); }; t.onerror = function () { rej(t.error); }; });
  }
  function getAll(store) { var t = tx(store, 'readonly'); return reqP(t.objectStore(store).getAll()); }
  function putRec(store, val) { var t = tx(store, 'readwrite'); t.objectStore(store).put(val); return txDone(t); }
  function delRec(store, key) { var t = tx(store, 'readwrite'); t.objectStore(store).delete(key); return txDone(t); }

  /* ---------------- 落盘（双通道：IDB 优先，失败回退 LS） ---------------- */
  function persistSession(s) { return useLS ? saveLS() : putRec('sessions', s); }
  function persistWrong(w) { return useLS ? saveLS() : putRec('wrongs', w); }
  function removeWrongsBySession(id) {
    if (useLS) return saveLS();
    return getAll('wrongs').then(function (list) {
      var todo = [];
      (list || []).forEach(function (w) { if (w.sessionId === id) todo.push(delRec('wrongs', w.id)); });
      return Promise.all(todo);
    });
  }
  function saveLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); }
    catch (e) { RT.util.toast('保存失败：浏览器存储已满，建议导出备份或删除旧会话'); }
  }
  function loadLS() {
    try { var raw = localStorage.getItem(LS_KEY); if (raw) data = JSON.parse(raw); } catch (e) { /* ignore */ }
    if (!data.sessions) data = { sessions: [], wrongs: [] };
  }

  /* ---------------- 启动加载 / 迁移 ---------------- */
  // file:// 等场景下 indexedDB.open() 可能既不 success 也不 error（永久挂起），
  // 必须加超时兜底：超时即回退 localStorage，否则 db=null 时任何写入都会崩溃。
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('idb open timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function load() {
    return withTimeout(openDB(), 1500).then(function () {
      return Promise.all([getAll('sessions'), getAll('wrongs')]);
    }).then(function (pairs) {
      var sess = pairs[0] || [], wrongs = pairs[1] || [];
      if (!sess.length && !wrongs.length) return migrateFromLS();
      data.sessions = sess; data.wrongs = wrongs;
    }).catch(function () {
      // IDB 不可用（如早期 file:// 场景）→ 退回 localStorage
      useLS = true;
      loadLS();
      if (!data.sessions.length && !data.wrongs.length) migrateFromLS();
    });
  }
  function migrateFromLS() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return; }
    if (!raw) return;
    var old; try { old = JSON.parse(raw); } catch (e) { return; }
    if (!old || !old.sessions) return;
    data.sessions = old.sessions || [];
    // 迁移时清洗冗余 text 字段
    data.wrongs = (old.wrongs || []).map(function (w) {
      var c = {}; for (var k in w) if (k !== 'text') c[k] = w[k]; return c;
    });
    var ps = data.sessions.map(function (s) { return persistSession(s); });
    var pw = data.wrongs.map(function (w) { return persistWrong(w); });
    return Promise.all(ps.concat(pw)).then(function () {
      try { if (!useLS) localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    });
  }

  /* ---------------- 配额预警 ---------------- */
  function checkQuota() {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        if (e.quota && e.usage / e.quota > 0.8)
          RT.util.toast('存储空间已用 ' + Math.round(e.usage / e.quota * 100) + '%，建议导出备份或删除旧会话');
      }).catch(function () { /* ignore */ });
    }
  }

  /* ---------------- sessions ---------------- */
  function listSessions() {
    return data.sessions.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
  }
  function getSession(id) {
    for (var i = 0; i < data.sessions.length; i++)
      if (data.sessions[i].id === id) return data.sessions[i];
    return null;
  }
  function addSession(s) { data.sessions.push(s); persistSession(s); checkQuota(); }
  function updateSession(id, patch) {
    var s = getSession(id); if (!s) return null;
    for (var k in patch) if (patch.hasOwnProperty(k)) s[k] = patch[k];
    if (s.reps && s.reps.length > REPS_CAP) s.reps = s.reps.slice(s.reps.length - REPS_CAP);
    persistSession(s); return s;
  }
  function deleteSession(id) {
    data.sessions = data.sessions.filter(function (s) { return s.id !== id; });
    data.wrongs = data.wrongs.filter(function (w) { return w.sessionId !== id; });
    var p1 = useLS ? saveLS() : (function () {
      var t = tx('sessions', 'readwrite'); t.objectStore('sessions').delete(id); return txDone(t);
    })();
    var p2 = removeWrongsBySession(id);
    return Promise.all([p1, p2]);
  }

  /* ---------------- wrongs ---------------- */
  function ensureWrong(w) {
    // 以 (会话, 错词, 所在句) 唯一标识一个错点：同一词在不同句子里算不同错点，
    // 这样"按句统计错误次数"才能精准定位到具体哪句话。
    for (var i = 0; i < data.wrongs.length; i++)
      if (data.wrongs[i].sessionId === w.sessionId && data.wrongs[i].token === w.token && data.wrongs[i].sentence === w.sentence)
        return data.wrongs[i];
    var item = {
      id: RT.util.uid('w'), sessionId: w.sessionId, sessionTitle: w.sessionTitle,
      token: w.token, gold: w.gold, sentence: w.sentence || '',
      mistakes: 0, corrects: 0, lastWrong: '', tries: [], createdAt: Date.now()
    };
    data.wrongs.push(item); persistWrong(item); checkQuota(); return item;
  }
  // 记一次错答：mistakes+1、lastWrong 更新为本次错答、tries 去重合并历史
  //（同一答案再次填错 count+1；新答案追加一条，firstAt/lastAt 记时间）
  function noteWrong(id, filled) {
    var w = null;
    for (var i = 0; i < data.wrongs.length; i++) if (data.wrongs[i].id === id) w = data.wrongs[i];
    if (!w) return null;
    w.mistakes = (w.mistakes || 0) + 1;
    w.lastWrong = filled || '';
    w.tries = Array.isArray(w.tries) ? w.tries : [];
    var txt = (filled || '').trim();
    if (txt) {
      var hit = null;
      for (var j = 0; j < w.tries.length; j++) if (w.tries[j].v === txt) hit = w.tries[j];
      if (hit) { hit.count = (hit.count || 0) + 1; hit.lastAt = Date.now(); }
      else w.tries.push({ v: txt, count: 1, firstAt: Date.now(), lastAt: Date.now() });
    }
    persistWrong(w); return w;
  }
  function updateWrong(id, patch) {
    var w = null;
    for (var i = 0; i < data.wrongs.length; i++) if (data.wrongs[i].id === id) w = data.wrongs[i];
    if (!w) return null;
    for (var k in patch) if (patch.hasOwnProperty(k)) w[k] = patch[k];
    persistWrong(w); return w;
  }
  // 手动删除单条错题记录（删除后不再参与强制重现）
  function deleteWrong(id) {
    var w = null;
    for (var i = 0; i < data.wrongs.length; i++) if (data.wrongs[i].id === id) w = data.wrongs[i];
    if (!w) return Promise.resolve(false);
    data.wrongs = data.wrongs.filter(function (x) { return x.id !== id; });
    if (useLS) { saveLS(); return Promise.resolve(true); }
    return delRec('wrongs', id).then(function () { return true; });
  }
  // 未毕业错点：正确次数未达 5 次，仍需在生成填空时强制重现
  function openWrongs() {
    return data.wrongs.filter(function (w) { return (w.corrects || 0) < 5; });
  }

  /* ---------------- 每日成果 ---------------- */
  function dayStats(key) {
    var blankTotal = 0, correctTotal = 0, wrongNew = 0, seen = {};
    data.sessions.forEach(function (s) {
      (s.reps || []).forEach(function (r) {
        if (RT.util.dayKey(r.at) === key) {
          blankTotal += r.blankCount; correctTotal += Math.round(r.blankCount * r.rate / 100);
        }
      });
    });
    data.wrongs.forEach(function (w) {
      if (RT.util.dayKey(w.createdAt) === key && !seen[w.id]) { wrongNew++; seen[w.id] = 1; }
    });
    var rate = blankTotal ? Math.round(correctTotal / blankTotal * 100) : 0;
    return { key: key, rounds: 0, blankTotal: blankTotal, correctTotal: correctTotal, rate: rate, wrongNew: wrongNew };
  }
  function lastNDays(n) {
    var arr = [], k, i;
    for (i = n - 1; i >= 0; i--) { k = RT.util.dayKeyOffset(-i); arr.push(dayStats(k)); }
    return arr;
  }
  function totalLearned() {
    var days = {}, sum = 0;
    data.sessions.forEach(function (s) { (s.reps || []).forEach(function (r) { days[RT.util.dayKey(r.at)] = 1; sum += r.blankCount; }); });
    return { days: Object.keys(days).length, blanks: sum, sessions: data.sessions.length };
  }

  /* ---------------- 复习队列（已随复习模块移除，仅保留最小兼容） ---------------- */
  function allWrongs() { return data.wrongs.slice(); }

  /* ---------------- 导出 / 导入备份 ---------------- */
  function exportData() {
    var blob = new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), sessions: data.sessions, wrongs: data.wrongs })], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'beisong-backup-' + RT.util.dayKey() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function clearAll() {
    data = { sessions: [], wrongs: [] };
    if (useLS) { saveLS(); return Promise.resolve(); }
    var t = tx(['sessions', 'wrongs'], 'readwrite');
    t.objectStore('sessions').clear(); t.objectStore('wrongs').clear();
    return txDone(t);
  }
  function importData(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        try {
          var obj = JSON.parse(r.result);
          if (!obj.sessions || !obj.wrongs) throw new Error('备份格式不正确');
          clearAll().then(function () {
            data.sessions = obj.sessions; data.wrongs = obj.wrongs;
            var ps = data.sessions.map(function (s) { return persistSession(s); });
            var pw = data.wrongs.map(function (w) { return persistWrong(w); });
            return Promise.all(ps.concat(pw));
          }).then(function () { res(); }).catch(rej);
        } catch (e) { rej(e); }
      };
      r.onerror = function () { rej(new Error('文件读取失败')); };
      r.readAsText(file);
    });
  }

  function save() {
    var ps = data.sessions.map(function (s) { return persistSession(s); });
    var pw = data.wrongs.map(function (w) { return persistWrong(w); });
    return Promise.all(ps.concat(pw));
  }
  function ready() { if (!readyPromise) readyPromise = load(); return readyPromise; }

  RT.store = {
    ready: ready,
    raw: function () { return data; },
    listSessions: listSessions, getSession: getSession, addSession: addSession,
    updateSession: updateSession, deleteSession: deleteSession,
    ensureWrong: ensureWrong, updateWrong: updateWrong, noteWrong: noteWrong, deleteWrong: deleteWrong,
    allWrongs: allWrongs, openWrongs: openWrongs,
    dayStats: dayStats, lastNDays: lastNDays, totalLearned: totalLearned,
    exportData: exportData, importData: importData, save: save
  };
})(window.RT);
