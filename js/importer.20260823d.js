/* ============================================================
   importer.js · 文件导入（docx / pdf / txt）
   全部在本机解析，文件不上传。
   - txt: 原生读取
   - docx: mammoth.js (CDN)
   - pdf: pdf.js (CDN)，逐页抽取文本
   ============================================================ */
window.RT = window.RT || {};
(function (RT) {
  'use strict';

  var MAMMOTH_SRC = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
  var PDF_SRC = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  var PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('文件读取失败')); };
      r.readAsText(file, 'utf-8');
    });
  }

  function parseDocx(file) {
    if (!window.mammoth) return loadScript(MAMMOTH_SRC).then(function () { return parseDocx(file); });
    return file.arrayBuffer().then(function (buf) {
      return mammoth.extractRawText({ arrayBuffer: buf }).then(function (r) {
        return r.value || '';
      });
    });
  }

  function parsePdf(file) {
    if (!window.pdfjsLib) return loadScript(PDF_SRC).then(function () { return parsePdf(file); });
    if (pdfjsLib.workerSrc === undefined || !pdfjsLib.workerSrc) pdfjsLib.workerSrc = PDF_WORKER;
    return file.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: buf }).promise.then(function (pdf) {
        var pages = [], i = 1;
        function next() {
          if (i > pdf.numPages) return pages.join('\n');
          return pdf.getPage(i++).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var str = tc.items.map(function (it) { return it.str; }).join(' ');
              pages.push(str);
              return next();
            });
          });
        }
        return next();
      });
    });
  }

  function parse(file) {
    var name = (file.name || '').toLowerCase();
    var tip = function (m, ok) { if (RT.ui && RT.ui.showParseTip) RT.ui.showParseTip(m, ok); };

    if (name.endsWith('.txt')) {
      return readAsText(file).then(function (t) { tip('已解析 TXT（' + t.length + ' 字）', true); return t; });
    }
    if (name.endsWith('.docx')) {
      tip('正在解析 Word…', true);
      return parseDocx(file).then(function (t) { tip('已解析 DOCX（' + t.length + ' 字）', true); return t; })
        .catch(function (e) { tip('DOCX 解析失败：' + e.message, false); throw e; });
    }
    if (name.endsWith('.pdf')) {
      tip('正在解析 PDF…（首次需联网加载解析库）', true);
      return parsePdf(file).then(function (t) { tip('已解析 PDF（' + t.length + ' 字）', true); return t; })
        .catch(function (e) { tip('PDF 解析失败：' + e.message, false); throw e; });
    }
    // 兜底：尝试当文本
    return readAsText(file).then(function (t) { tip('已按纯文本解析', true); return t; });
  }

  RT.importer = { parse: parse };
})(window.RT);
