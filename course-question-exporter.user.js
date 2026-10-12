// ==UserScript==
// @name         网课题目导出器
// @namespace    https://github.com/AIR-pixel/yuketang-question-exporter
// @version      2.3.0
// @description  导出学习通 / 智慧树 / 雨课堂的题目为 Markdown；雨课堂支持批量导出未完成作业（按章节分组），并把被字体加密的题目文字还原成正常文字
// @author       AIR-pixel
// @license      MIT
// @homepageURL  https://github.com/AIR-pixel/yuketang-question-exporter
// @supportURL   https://github.com/AIR-pixel/yuketang-question-exporter/issues
// @updateURL    https://raw.githubusercontent.com/AIR-pixel/yuketang-question-exporter/main/course-question-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/AIR-pixel/yuketang-question-exporter/main/course-question-exporter.user.js
// @match        *://*.chaoxing.com/*
// @match        *://*.zhihuishu.com/*
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 「抠题」思路借鉴 OCS 网课助手：把每道题的容器 -> 题干 -> 选项 -> 题型
 * 用 CSS 选择器描述，再 querySelectorAll 批量取出。此处只读不写，不提交任何答案。
 *
 * 两类场景：
 *   1) 当前页面就是题目页        -> 「导出本页题目」
 *   2) 当前页面是课程/作业列表   -> 「批量导出未完成作业」（目前实现雨课堂）
 *
 * 注意：雨课堂作业是一题一题渲染的（左侧题号切换），
 * 批量导出会依次点击左侧题号来读取每一题，全程不点击任何提交按钮。
 *
 * ── v2.1.0 字体反爬解密 ────────────────────────────────────────────────
 * 雨课堂 / 超星会给题目下发「字形置换」字体：字体里码点 X 的字形轮廓实际
 * 画的是另一个字 Y。页面看得到正常文字，但读取 textContent 拿到的是乱码。
 * 解法（算法移植自 OCS 的 font-decrypt 模块）：把密文字用加密字体渲染成
 * 位图 -> 提取二值特征 -> 与「官方原版字体预生成的特征表」做两级最近邻，
 * 反推出每个字形实际画的是哪个字。
 * 本脚本默认【只改内存、不回写 DOM】：导出时用映射表翻译文本，
 * 不修改页面元素，避免误映射把用户看到的页面改坏。
 *
 * ── v2.3.0 真实页面结构修正 ────────────────────────────────────────────
 * v2.2.0 只在本地夹具上验证了「题干重复」，但真实雨课堂的 DOM 更阴：
 *   .problem-body 的 innerText = 题干 + 全部选项（多行）
 *   .item-body > div:first-child 的 innerText = 只有题干
 * 两者在 DOM 里**并不嵌套**，所以「丢外层容器」和「删相邻重复行」都拦不住，
 * 结果 120 道单选题题干仍然各出现两遍、还夹着一坨裸选项文本。
 * v2.3.0 改成按**文本包含关系**选最纯的那个候选（短的是长的子串就丢长的）；
 * 另外选项控件 innerText 形如 "A\n、 九一八事变"，会折行并剥掉重复的字母前缀。
 */

(function () {
  'use strict';

  var HOST = location.hostname;

  /**
   * 平台判定。正常只认域名；额外开一个本地夹具入口：
   *   http://127.0.0.1/xxx.html?__ceplatform=yuketang
   * 便于在本地 HTML 上跑回归测试（非 localhost 地址永远走域名匹配）。
   */
  var PLATFORM = (function () {
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(HOST)) {
      var m = /[?&]__ceplatform=(chaoxing|zhihuishu|yuketang)(?:&|$)/.exec(location.search);
      if (m) return m[1];
    }
    if (/chaoxing\.com$/.test(HOST)) return 'chaoxing';
    if (/zhihuishu\.com$/.test(HOST)) return 'zhihuishu';
    // gdufemooc.cn = 长江雨课堂（OCS 里和 yuketang.cn 同属「雨课堂」项目）
    if (/yuketang\.cn$/.test(HOST) || /gdufemooc\.cn$/.test(HOST)) return 'yuketang';
    return '';
  })();
  if (!PLATFORM) return;

  // 同源子 iframe 交给顶层统一处理；跨域 iframe（如超星）自己处理
  if (window.top !== window.self) {
    try {
      void window.top.document.title;
      return;
    } catch (e) {
      /* 跨域，继续 */
    }
  }

  var CONFIG = {
    includeImages: true,
    maxFrameDepth: 3,
    stepTimeoutMs: 6000,
    stepSettleMs: 450,
    /** 作业页面（iframe 内出现题目根）等待超时；超时后会再点一次任务点重试 */
    exerciseTimeoutMs: 25000,
    /** 等用户手动处理「未保存答案」确认弹窗的最长时间，超时后自动点确认 */
    guardWaitMs: 20000,

    /** 字体反爬解密（字形置换类）*/
    decrypt: {
      enabled: true,
      /** FRB2 参考特征表。雨课堂 = wght250 表；超星另有 cx 表，按需替换 */
      refTableUrl: 'https://cdn.ocsjs.com/resources/font/font_ref_yuketang.bin',
      /**
       * FontFace 字重锁定。雨课堂加密字体是 SourceHanSansSC-VF 可变字体，
       * 默认按 wght400 实例化，而特征表按 wght250 生成，不锁定必错。
       * 静态字体（如超星 cxsecret）可留空字符串。
       */
      fontWeight: '250',
      /** 优先在 Web Worker（OffscreenCanvas）里破解，不卡页面；不支持时自动回退 */
      useWorker: true,
      /** true = 把解密结果回写页面 DOM（会摘掉加密字体 class），默认关闭 */
      writeBack: false
    }
  };

  /* ============================== 基础工具 ============================== */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function waitFor(fn, timeoutMs, periodMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var iv = setInterval(function () {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) {
          clearInterval(iv);
          resolve(v);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          resolve(null);
        }
      }, periodMs || 200);
    });
  }

  var PLATFORM_LABEL = { chaoxing: '超星学习通', zhihuishu: '智慧树', yuketang: '雨课堂' };

  function platformName() {
    return PLATFORM_LABEL[PLATFORM] || HOST;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function timestamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fileStamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
      pad(d.getHours()) + pad(d.getMinutes());
  }

  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch (e) { return ''; }
  }

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  /**
   * 取元素文本；开启 includeImages 时把其中的图片 URL 以 Markdown 语法附在末尾。
   * @param {string} [rawText] 覆盖文本来源（用于「克隆后替换空格输入框」这类场景）
   */
  function textOf(el, rawText) {
    if (!el) return '';
    var t = rawText !== undefined ? normalize(rawText) : normalize(el.innerText || el.textContent || '');
    // 字体反爬：把密文翻译成真字（未加密页面 ACTIVE_MAP 为 null，无额外开销）
    t = decryptInText(t);
    if (CONFIG.includeImages) {
      var urls = [];
      var imgs = el.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var src = absUrl(imgs[i].getAttribute('data-src') || imgs[i].getAttribute('src'));
        if (src && urls.indexOf(src) === -1) urls.push(src);
      }
      if (urls.length) {
        t += (t ? '\n' : '') + urls.map(function (u) { return '![](' + u + ')'; }).join('\n');
      }
    }
    return t;
  }

  /* ============================== 字体反爬解密 ============================== */
  /*
   * 字形置换类加密的通用解法。算法细节（渲染归一化、盒式降采样、
   * 两级最近邻、可变字体字重陷阱）与参考实现保持逐行一致：
   *   - 480x480 固定画布 / 字号 360 / 基线 y=384 / 按 advance 水平居中
   *   - 不裁剪墨迹 bbox（保留绝对位置，用于区分 一 / — / _ 这类靠位置区分的字）
   *   - 积分图 + 盒式平均降采样后按表头阈值二值化
   *   - 16x16 粗特征全表 L2 扫描取 top40 -> 24x24 精特征排序
   * 这些常数必须与特征表生成端严格一致，改一个就全错。
   */

  var FD = {
    RENDER: 360,
    SQ: 480,
    BASELINE: 384,
    SHORTLIST: 40,
    INK_THRESHOLD: 40,
    COVERAGE_THRESHOLD: 1000,
    WORKER_TIMEOUT: 30000,
    FONT_LOAD_TIMEOUT: 15000,
    REF_TABLE_TIMEOUT: 30000
  };

  /** 当前正在解密的文档对应的映射表（extractWithProfile 里按 doc 临时挂上） */
  var ACTIVE_MAP = null;
  /** Document -> 映射表 */
  var DOC_MAPS = new WeakMap();
  /** 字体 URL -> { map, cracked, details, chain } */
  var FONT_CACHE = Object.create(null);
  /** 需要补的提示（字体没找到 / 表没下来），导出时写进文件头 */
  var DECRYPT_WARNINGS = [];
  /**
   * 选项兜底统计：
   *   judgement = 判断题页面没渲染出可读选项，按题型补的「正确/错误」数量
   *   missed    = 检测到答题控件却一个选项文本都没抠出来（选择器与平台变体不匹配）
   */
  var SYNTH_COUNT = { judgement: 0, missed: 0 };

  function resetSynthCount() {
    SYNTH_COUNT.judgement = 0;
    SYNTH_COUNT.missed = 0;
  }

  function warnOnce(msg) {
    if (DECRYPT_WARNINGS.indexOf(msg) === -1) {
      DECRYPT_WARNINGS.push(msg);
      console.warn('[题目导出·字体解密] ' + msg);
    }
  }

  /* ---------- FRB2 特征表加载 ---------- */

  var REF_TABLE_CACHE = Object.create(null);

  function unpackBits(packed, offset, count, dims) {
    var bytesPerGlyph = dims / 8;
    var out = new Uint8Array(count * dims);
    for (var i = 0; i < count; i++) {
      var pBase = offset + i * bytesPerGlyph;
      var oBase = i * dims;
      for (var b = 0; b < bytesPerGlyph; b++) {
        var byte = packed[pBase + b];
        // MSB 优先：第 0 位是字节的最高位
        for (var k = 0; k < 8; k++) out[oBase + b * 8 + k] = (byte >> (7 - k)) & 1;
      }
    }
    return out;
  }

  function loadRefTable(url) {
    if (REF_TABLE_CACHE[url]) return REF_TABLE_CACHE[url];
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FD.REF_TABLE_TIMEOUT);
    var p = fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var dv = new DataView(buf);
        var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        if (magic !== 'FRB2') throw new Error('特征表格式不对：' + magic);
        var count = dv.getUint32(4, true);
        var threshold = dv.getUint32(8, true);
        var gc = dv.getUint32(12, true);
        var gf = dv.getUint32(16, true);
        var cps = new Uint32Array(count);
        var off = 20;
        for (var i = 0; i < count; i++, off += 4) cps[i] = dv.getUint32(off, true);
        var packed = new Uint8Array(buf);
        var coarse = unpackBits(packed, off, count, gc * gc);
        off += (count * gc * gc) / 8;
        var fine = unpackBits(packed, off, count, gf * gf);
        return { count: count, cps: cps, coarse: coarse, fine: fine, gc: gc, gf: gf, threshold: threshold };
      })
      .then(
        function (t) { clearTimeout(timer); return t; },
        function (e) { clearTimeout(timer); delete REF_TABLE_CACHE[url]; throw e; }
      );
    REF_TABLE_CACHE[url] = p;
    return p;
  }

  /* ---------- 主线程渲染与匹配 ---------- */

  var _renderCtx = null;
  function getRenderCtx() {
    if (!_renderCtx) {
      var cv = document.createElement('canvas');
      cv.width = FD.SQ;
      cv.height = FD.SQ;
      _renderCtx = cv.getContext('2d', { willReadFrequently: true });
    }
    return _renderCtx;
  }

  /** 渲染单字并提取 0/1 特征；空白字形（空格）返回 null */
  function renderGlyph(fontFamily, ch, table) {
    var ctx = getRenderCtx();
    ctx.clearRect(0, 0, FD.SQ, FD.SQ);
    ctx.fillStyle = '#fff';
    ctx.font = FD.RENDER + 'px "' + fontFamily + '"';
    ctx.textBaseline = 'alphabetic';
    var advance = ctx.measureText(ch).width;
    ctx.fillText(ch, (FD.SQ - advance) / 2, FD.BASELINE);
    var px = ctx.getImageData(0, 0, FD.SQ, FD.SQ).data;

    var hasInk = false;
    for (var i = 3; i < px.length; i += 4) {
      if (px[i] > FD.INK_THRESHOLD) { hasInk = true; break; }
    }
    if (!hasInk) return null;

    // 积分图：一次构建后每格 O(1) 求和，与逐像素盒式平均结果完全一致
    var W = FD.SQ + 1;
    var ii = new Uint32Array(W * W);
    for (var y = 0; y < FD.SQ; y++) {
      var rowSum = 0;
      var srcRow = y * FD.SQ * 4;
      var dstRow = (y + 1) * W;
      var upRow = y * W;
      for (var x = 0; x < FD.SQ; x++) {
        rowSum += px[srcRow + x * 4 + 3];
        ii[dstRow + x + 1] = ii[upRow + x + 1] + rowSum;
      }
    }

    var box = function (n) {
      var b = FD.SQ / n;
      var area = b * b;
      var out = new Uint8Array(n * n);
      for (var gy = 0; gy < n; gy++) {
        for (var gx = 0; gx < n; gx++) {
          var y0 = gy * b;
          var x0 = gx * b;
          var sum = ii[(y0 + b) * W + x0 + b] - ii[y0 * W + x0 + b] - ii[(y0 + b) * W + x0] + ii[y0 * W + x0];
          out[gy * n + gx] = sum / area > table.threshold ? 1 : 0;
        }
      }
      return out;
    };

    return { coarse: box(table.gc), fine: box(table.gf) };
  }

  var _covCache = Object.create(null);
  /**
   * 双回退对比法判断字体是否覆盖某字符。
   * 覆盖时 "family", serif 与 "family", sans-serif 都走该字体自身字形，像素完全相同；
   * 未覆盖时分别落到 serif / sans-serif 系统回退字体，像素必然不同。
   * 用 document.fonts.check() 不行——Chrome 只检查字体是否加载，不检查字形覆盖。
   */
  function isCoveredByFont(fontFamily, ch) {
    var render = function (fallback) {
      var key = fontFamily + '|' + fallback;
      var cv = _covCache[key];
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = 200;
        cv.height = 200;
        _covCache[key] = cv;
      }
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 200, 200);
      ctx.fillStyle = '#fff';
      ctx.font = '120px "' + fontFamily + '", ' + fallback;
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, 10, 100);
      return ctx.getImageData(0, 0, 200, 200).data;
    };
    var a = render('serif');
    var b = render('sans-serif');
    var diff = 0;
    for (var i = 3; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
    return diff < FD.COVERAGE_THRESHOLD;
  }

  function bitDistance(tableArr, idx, dims, q) {
    var s = 0;
    var base = idx * dims;
    for (var i = 0; i < dims; i++) if (tableArr[base + i] !== q[i]) s++;
    return s;
  }

  function crackChar(table, feat) {
    var count = table.count;
    var dists = new Float64Array(count);
    for (var i = 0; i < count; i++) dists[i] = bitDistance(table.coarse, i, table.gc * table.gc, feat.coarse);
    var sorted = Float64Array.from(dists);
    sorted.sort();
    var threshold = sorted[Math.min(FD.SHORTLIST, count) - 1];
    var idx = [];
    for (var j = 0; j < count; j++) if (dists[j] <= threshold) idx.push(j);
    var bestI = -1, best = Infinity, second = Infinity;
    for (var k = 0; k < idx.length; k++) {
      var d = bitDistance(table.fine, idx[k], table.gf * table.gf, feat.fine);
      if (d < best) { second = best; best = d; bestI = idx[k]; }
      else if (d < second) { second = d; }
    }
    return { ch: String.fromCodePoint(table.cps[bestI]), best: best, second: second, margin: second > 0 ? 1 - best / second : 1 };
  }

  /* ---------- Worker 通道（OffscreenCanvas，不阻塞主线程） ---------- */

  var FD_WORKER_SOURCE = `
'use strict';
var RENDER = 360, SQ = 480, BASELINE = 384, SHORTLIST = 40, INK_THRESHOLD = 40;
var renderCv = null;
function getRenderCtx() {
	if (!renderCv) {
		renderCv = new OffscreenCanvas(SQ, SQ);
		renderCv.ctx = renderCv.getContext('2d', { willReadFrequently: true });
	}
	return renderCv.ctx;
}
var covCv = {};
function isCoveredByFont(fontFamily, ch) {
	var render = function (fallback) {
		var cv = covCv[fallback];
		if (!cv) {
			cv = new OffscreenCanvas(200, 200);
			cv.ctx = cv.getContext('2d', { willReadFrequently: true });
			covCv[fallback] = cv;
		}
		var ctx = cv.ctx;
		ctx.clearRect(0, 0, 200, 200);
		ctx.fillStyle = '#fff';
		ctx.font = '120px "' + fontFamily + '", ' + fallback;
		ctx.textBaseline = 'middle';
		ctx.fillText(ch, 10, 100);
		return ctx.getImageData(0, 0, 200, 200).data;
	};
	var a = render('serif');
	var b = render('sans-serif');
	var diff = 0;
	for (var i = 3; i < a.length; i += 4) { diff += Math.abs(a[i] - b[i]); }
	return diff < 1000;
}
function renderGlyph(fontFamily, ch, table) {
	var ctx = getRenderCtx();
	ctx.clearRect(0, 0, SQ, SQ);
	ctx.fillStyle = '#fff';
	ctx.font = RENDER + 'px "' + fontFamily + '"';
	ctx.textBaseline = 'alphabetic';
	var advance = ctx.measureText(ch).width;
	ctx.fillText(ch, (SQ - advance) / 2, BASELINE);
	var px = ctx.getImageData(0, 0, SQ, SQ).data;
	var hasInk = false;
	for (var i = 3; i < px.length; i += 4) { if (px[i] > INK_THRESHOLD) { hasInk = true; break; } }
	if (!hasInk) { return null; }
	var W = SQ + 1;
	var ii = new Uint32Array(W * W);
	for (var y = 0; y < SQ; y++) {
		var rowSum = 0;
		var srcRow = y * SQ * 4;
		var dstRow = (y + 1) * W;
		var upRow = y * W;
		for (var x = 0; x < SQ; x++) {
			rowSum += px[srcRow + x * 4 + 3];
			ii[dstRow + x + 1] = ii[upRow + x + 1] + rowSum;
		}
	}
	var box = function (n) {
		var b = SQ / n;
		var area = b * b;
		var out = new Uint8Array(n * n);
		for (var gy = 0; gy < n; gy++) {
			for (var gx = 0; gx < n; gx++) {
				var y0 = gy * b;
				var x0 = gx * b;
				var sum = ii[(y0 + b) * W + x0 + b] - ii[y0 * W + x0 + b] - ii[(y0 + b) * W + x0] + ii[y0 * W + x0];
				out[gy * n + gx] = sum / area > table.threshold ? 1 : 0;
			}
		}
		return out;
	};
	return { coarse: box(table.gc), fine: box(table.gf) };
}
function bitDistance(tableArr, idx, dims, q) {
	var s = 0;
	var base = idx * dims;
	for (var i = 0; i < dims; i++) { if (tableArr[base + i] !== q[i]) { s++; } }
	return s;
}
function crackChar(table, feat) {
	var count = table.count;
	var dists = new Float64Array(count);
	for (var i = 0; i < count; i++) { dists[i] = bitDistance(table.coarse, i, table.gc * table.gc, feat.coarse); }
	var sorted = Float64Array.from(dists);
	sorted.sort();
	var threshold = sorted[Math.min(SHORTLIST, count) - 1];
	var idx = [];
	for (var j = 0; j < count; j++) { if (dists[j] <= threshold) { idx.push(j); } }
	var bestI = -1, best = Infinity, second = Infinity;
	for (var k = 0; k < idx.length; k++) {
		var d = bitDistance(table.fine, idx[k], table.gf * table.gf, feat.fine);
		if (d < best) { second = best; best = d; bestI = idx[k]; }
		else if (d < second) { second = d; }
	}
	return { ch: String.fromCodePoint(table.cps[bestI]), margin: second > 0 ? 1 - best / second : 1 };
}
self.onmessage = function (e) {
	var msg = e.data;
	(async function () {
		if (typeof FontFace === 'undefined' || typeof OffscreenCanvas === 'undefined' || !self.fonts) {
			throw new Error('worker env unsupported');
		}
		var family = 'font-decrypt-w-' + Math.random().toString(36).slice(2);
		var source = typeof msg.fontSource === 'string' ? 'url("' + msg.fontSource + '")' : msg.fontSource;
		var face = new FontFace(family, source, msg.fontWeight ? { weight: msg.fontWeight } : {});
		await face.load();
		self.fonts.add(face);
		var table = {
			count: msg.count, cps: msg.cps, coarse: msg.coarse, fine: msg.fine,
			gc: msg.gc, gf: msg.gf, threshold: msg.threshold
		};
		var map = {};
		var details = [];
		var uniq = msg.chars;
		for (var i = 0; i < uniq.length; i++) {
			var ch = uniq[i];
			if (!isCoveredByFont(family, ch)) { map[ch] = ch; continue; }
			var feat = renderGlyph(family, ch, table);
			if (!feat) { map[ch] = ch; continue; }
			var r = crackChar(table, feat);
			map[ch] = r.ch;
			details.push({ from: ch, to: r.ch, margin: +r.margin.toFixed(3) });
			self.postMessage({ type: 'progress', done: i + 1, total: uniq.length });
		}
		self.postMessage({ type: 'result', map: map, details: details });
	})().catch(function (err) {
		self.postMessage({ type: 'error', message: String((err && err.message) || err) });
	});
};
`;

  function crackFontInWorker(fontSource, chars, table, onProgress) {
    return new Promise(function (resolve) {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return resolve(null);
      var worker, url;
      try {
        url = URL.createObjectURL(new Blob([FD_WORKER_SOURCE], { type: 'application/javascript' }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
      } catch (e) {
        return resolve(null);
      }
      var settled = false;
      var timer = setTimeout(function () { done(null); }, FD.WORKER_TIMEOUT);
      function done(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve(r);
      }
      worker.onerror = function () { done(null); };
      worker.onmessage = function (e) {
        var msg = e.data || {};
        if (msg.type === 'progress') { if (onProgress) onProgress(msg.done, msg.total); }
        else if (msg.type === 'result') { done({ map: msg.map, details: msg.details }); }
        else if (msg.type === 'error') { done(null); }
      };
      worker.postMessage({
        fontSource: fontSource,
        chars: chars,
        fontWeight: CONFIG.decrypt.fontWeight || undefined,
        count: table.count,
        cps: table.cps,
        coarse: table.coarse,
        fine: table.fine,
        gc: table.gc,
        gf: table.gf,
        threshold: table.threshold
      });
    });
  }

  /* ---------- 破解入口 ---------- */

  /** 破解一批字符，返回 { map: 密文->真字, details } */
  async function crackFont(fontSource, chars, onProgress) {
    var table = await loadRefTable(CONFIG.decrypt.refTableUrl);
    var uniq = [];
    var seen = Object.create(null);
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      if (c.trim() === '' || seen[c]) continue;
      seen[c] = 1;
      uniq.push(c);
    }
    if (!uniq.length) return { map: {}, details: [] };

    if (CONFIG.decrypt.useWorker !== false) {
      var r = await crackFontInWorker(fontSource, uniq, table, onProgress);
      if (r) return r;
      warnOnce('Worker 通道不可用（CSP 或环境不支持），已回退主线程解密。');
    }

    var family = 'font-decrypt-' + Math.random().toString(36).slice(2);
    var source = typeof fontSource === 'string' ? 'url("' + fontSource + '")' : fontSource;
    var desc = CONFIG.decrypt.fontWeight ? { weight: CONFIG.decrypt.fontWeight } : {};
    var face = new FontFace(family, source, desc);
    // 字体 URL 无响应时 load() 可能永不 settle，必须加超时
    await Promise.race([
      face.load(),
      new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error('字体加载超时')); }, FD.FONT_LOAD_TIMEOUT);
      })
    ]);
    if (document.fonts && document.fonts.add) document.fonts.add(face);

    var map = Object.create(null);
    var details = [];
    for (var n = 0; n < uniq.length; n++) {
      var ch = uniq[n];
      // 页面明文区的字符不在加密字体 cmap 内，浏览器用系统回退字体渲染（显示的就是真字），
      // 这类字符不是密文，回退渲染的图像参与匹配会产生垃圾映射，必须跳过
      if (!isCoveredByFont(family, ch)) { map[ch] = ch; continue; }
      var feat = renderGlyph(family, ch, table);
      if (!feat) { map[ch] = ch; continue; }
      var res = crackChar(table, feat);
      map[ch] = res.ch;
      details.push({ from: ch, to: res.ch, margin: +res.margin.toFixed(3) });
      if (onProgress) onProgress(n + 1, uniq.length);
      if (n % 10 === 9) await sleep(0);
    }
    return { map: map, details: details };
  }

  /** 用映射表翻译一段文本（没解过的字符原样保留） */
  function decryptText(text, map) {
    if (!map || !text) return text;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      out += (map[c] !== undefined ? map[c] : c);
    }
    return out;
  }

  /** textOf 内部调用：按当前文档的映射表翻译 */
  function decryptInText(t) {
    return ACTIVE_MAP ? decryptText(t, ACTIVE_MAP) : t;
  }

  /* ---------- 字体发现 ---------- */

  function isFontFaceRule(rule) {
    if (!rule) return false;
    // 跨 realm（iframe）时 instanceof 会失败，用 type 常量判定
    if (rule.type === 5) return true;
    var n = rule.constructor && rule.constructor.name;
    return n === 'CSSFontFaceRule';
  }

  /** 列出页面所有 @font-face（族名 + 绝对化后的 src） */
  function listFontFaces(doc) {
    doc = doc || document;
    var faces = [];
    var base = (doc.location && doc.location.href) || location.href;
    var sheets;
    try { sheets = Array.from(doc.styleSheets); } catch (e) { sheets = []; }
    for (var s = 0; s < sheets.length; s++) {
      var rules;
      try { rules = Array.from(sheets[s].cssRules); } catch (e) { continue; } // 跨域样式表读不到，跳过
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!isFontFaceRule(rule) || !rule.style) continue;
        var family = String(rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim();
        var m = /url\(["']?([^"')]+)["']?\)/.exec(String(rule.style.getPropertyValue('src') || ''));
        if (!family || !m) continue;
        var src = m[1];
        if (src.indexOf('data:') !== 0) {
          try { src = new URL(src, base).href; } catch (e) { /* 保留原值 */ }
        }
        faces.push({ family: family, src: src });
      }
    }
    return faces;
  }

  /** 从资源加载记录里找字体文件 URL（用目标文档所属 window 的 performance） */
  function findFontUrls(doc) {
    doc = doc || document;
    var urls = [];
    var perf = (doc.defaultView && doc.defaultView.performance) || performance;
    var entries;
    try { entries = perf.getEntriesByType('resource'); } catch (e) { entries = []; }
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      if (/\.(ttf|otf|woff2?)(\?|$)/i.test(name) && urls.indexOf(name) === -1) urls.push(name);
    }
    return urls;
  }

  /** 定位当前作业/考试使用的加密字体文件 */
  function findExamFontUrl(doc) {
    doc = doc || document;
    var faces = listFontFaces(doc);
    for (var i = 0; i < faces.length; i++) {
      if (/exam|decrypt/i.test(faces[i].family) || /exam_font|fe_font/i.test(faces[i].src)) return faces[i].src;
    }
    var urls = findFontUrls(doc);
    for (var j = 0; j < urls.length; j++) {
      if (/exam_font|fe_font/i.test(urls[j])) return urls[j];
    }
    // 实在找不到特征串就退回第一份非 data: 字体（data URI 也是一份可用来源）
    for (var k = 0; k < faces.length; k++) {
      if (faces[k].src) return faces[k].src;
    }
    return urls[0] || '';
  }

  /** 当前文档中带加密标记的元素 */
  var YKT_ENCRYPTED_SELECTOR = '.xuetangx-com-encrypted-font';
  function encryptedEls(doc) {
    doc = doc || document;
    var els = [];
    try { els = Array.from(doc.querySelectorAll(YKT_ENCRYPTED_SELECTOR)); } catch (e) { els = []; }
    // 已经写过回写的元素会带这个 class，跳过（防双重解密）
    return els.filter(function (el) { return !el.classList.contains('xuetangx-com-font-decrypted'); });
  }

  /**
   * 确保某个 document 的加密文字已解密，并把映射表挂到 DOC_MAPS。
   * 按字体 URL 缓存 + 增量：同一字体只完整破解一次，切题时只补新出现的字符。
   * 解密失败不抛错——导出按密文继续，并在文件头写明原因（fail-open）。
   */
  async function ensureDecrypt(doc, onProgress) {
    doc = doc || document;
    if (!CONFIG.decrypt.enabled) return null;
    var els = encryptedEls(doc);
    if (!els.length) return null;

    var url = findExamFontUrl(doc);
    if (!url) {
      warnOnce('页面有加密文字，但没找到加密字体文件（@font-face 可能由跨域样式表提供），本次按密文导出。');
      return null;
    }

    var entry = FONT_CACHE[url];
    if (!entry) {
      entry = { map: Object.create(null), cracked: Object.create(null), details: [], chain: Promise.resolve() };
      FONT_CACHE[url] = entry;
    }

    var chars = [];
    var seen = Object.create(null);
    for (var i = 0; i < els.length; i++) {
      var t = els[i].textContent || '';
      for (var j = 0; j < t.length; j++) {
        var c = t[j];
        if (c.trim() === '' || seen[c]) continue;
        seen[c] = 1;
        chars.push(c);
      }
    }
    var todo = chars.filter(function (c) { return !entry.cracked[c]; });

    if (todo.length) {
      var task = function () {
        return crackFont(url, todo, onProgress).then(function (res) {
          for (var k in res.map) {
            entry.map[k] = res.map[k];
            entry.cracked[k] = 1;
          }
          entry.details = entry.details.concat(res.details || []);
        });
      };
      // 同一字体的多次请求串行化，避免并发重复破解
      var next = entry.chain.catch(function () { }).then(task);
      entry.chain = next.catch(function () { });
      try {
        await next;
      } catch (e) {
        warnOnce('字体解密失败：' + (e && e.message ? e.message : e) + '（特征表下不来或字体加载失败），本次按密文导出。');
        return null;
      }
    }

    DOC_MAPS.set(doc, entry.map);

    if (CONFIG.decrypt.writeBack) writeBackDecrypted(doc, entry.map);
    return entry.map;
  }

  /**
   * 可选：把解密结果写回 DOM。
   * 注意必须同时摘掉加密字体 class 并换成 xuetangx-com-font-decrypted，
   * 否则明文会继续用加密字体渲染，显示成另一套错字。
   */
  function writeBackDecrypted(doc, map) {
    var els = encryptedEls(doc);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        node.nodeValue = decryptText(node.nodeValue || '', map);
      }
      el.classList.remove('xuetangx-com-encrypted-font');
      el.classList.add('xuetangx-com-font-decrypted');
    }
  }

  /** 批量准备：对一组文档依次解密，返回总共用到的字体数 */
  async function prepareDecrypt(docs, onProgress) {
    if (!CONFIG.decrypt.enabled) return 0;
    var totalChars = 0;
    for (var i = 0; i < docs.length; i++) {
      var els = encryptedEls(docs[i]);
      if (!els.length) continue;
      var n = els.reduce(function (a, el) { return a + (el.textContent || '').length; }, 0);
      if (onProgress) onProgress('字体解密中（第 ' + (i + 1) + ' 个文档，' + n + ' 字）…');
      await ensureDecrypt(docs[i], function (done, all) {
        if (onProgress && (done === all || done % 20 === 0)) onProgress('字体解密中 ' + done + '/' + all + ' 字…');
      });
      totalChars += n;
    }
    return totalChars;
  }

  /** 手动测试解密效果（控制台用）：打印前若干个 密文->真字 对照 */
  async function testDecrypt(limit) {
    limit = limit || 40;
    var docs = collectDocuments(document, 0, []).filter(function (d) { return encryptedEls(d).length; });
    if (!docs.length) {
      console.log('当前页面没有检测到加密文字（.xuetangx-com-encrypted-font）。');
      return '无加密文字';
    }
    await prepareDecrypt(docs);
    var lines = [];
    docs.forEach(function (d, i) {
      var url = findExamFontUrl(d);
      var map = DOC_MAPS.get(d) || {};
      var pairs = Object.keys(map).slice(0, limit).map(function (k) {
        return JSON.stringify(k) + ' -> ' + JSON.stringify(map[k]);
      });
      lines.push('--- 文档 ' + i + ' ---');
      lines.push('字体: ' + url);
      lines.push('映射表条目: ' + Object.keys(map).length);
      lines.push(pairs.join('\n'));
    });
    var out = lines.join('\n');
    console.log(out);
    return out;
  }



  /* ============================== 题型 ============================== */

  var TYPE_KEYWORDS = [
    ['单选', 'single'],
    ['多选', 'multiple'],
    ['判断', 'judgement'],
    ['填空', 'completion'],
    ['简答', 'completion'],
    ['问答', 'completion'],
    ['主观', 'completion'],
    ['名词解释', 'completion'],
    ['论述', 'completion']
  ];

  var TYPE_LABEL = {
    single: '单选题',
    multiple: '多选题',
    judgement: '判断题',
    completion: '填空题 / 简答题',
    unknown: '未识别题型'
  };

  function typeFromText(text) {
    if (!text) return null;
    for (var i = 0; i < TYPE_KEYWORDS.length; i++) {
      if (text.indexOf(TYPE_KEYWORDS[i][0]) !== -1) return TYPE_KEYWORDS[i][1];
    }
    return null;
  }

  function typeFromDom(root) {
    var radios = root.querySelectorAll('input[type="radio"]').length;
    var checks = root.querySelectorAll('input[type="checkbox"]').length;
    var areas = root.querySelectorAll('textarea').length;
    if (checks > 2) return 'multiple';
    if (radios === 2) return 'judgement';
    if (radios > 2) return 'single';
    if (areas >= 1) return 'completion';
    return null;
  }

  /**
   * 判断选项是否已被勾选。
   * 选项元素不一定是勾选框本身（超星是 span、雨课堂是 label、智慧树是 div），
   * 所以只在「最近的 li / label」这一层找，避免往上查到选项公共父容器造成污染。
   */
  function isChecked(option) {
    var row = option.closest('li, label') || option;
    var scopes = row === option ? [option] : [option, row];
    for (var i = 0; i < scopes.length; i++) {
      var s = scopes[i];
      var input = s.querySelector('input');
      if (input && input.checked) return true;
      if (s.classList && /is-checked|checked/.test(s.className)) return true;
      if (s.querySelector('.is-checked, .el-radio.is-checked, .el-checkbox.is-checked')) return true;
      if (s.querySelector('[aria-checked="true"]')) return true;
    }
    return false;
  }

  /* ============================== 平台规则 ============================== */

  var PROFILES = {
    chaoxing: [
      {
        name: '作业 / 考试',
        root: '.questionLi',
        title: '.splitS-left .mark_name, h3, .mark_name, .Zy_TItle .clearfix',
        options: '.answerBg .answer_p, .textDIV, .eidtDiv, ul li .after, ul li textarea, ul textarea',
        typeEl: 'input[id^="answertype"], input[name^="type"]'
      },
      {
        name: '章节测验',
        root: '.TiMu',
        title: '.Zy_TItle .clearfix, .Zy_TItle',
        options: 'ul li .after, ul li textarea, ul textarea, ul li label:not(.before)',
        typeEl: 'input[id^="answertype"]'
      },
      {
        name: '通用兜底',
        root: '.TiMu, .questionLi, .mark_item',
        title: '.mark_name, .Zy_TItle',
        options: '.answerBg .answer_p, ul li .after, ul li label',
        typeEl: 'input[id^="answertype"], input[name^="type"]'
      }
    ],

    zhihuishu: [
      {
        name: '共享课 作业/考试',
        root: '.examPaper_subject',
        title: '.subject_describe > div, .smallStem_describe > div:nth-child(2)',
        options: '.subject_node .nodeLab',
        typeEl: '.subject_type'
      },
      {
        name: '校内课',
        root: 'div:has(> .questionContent)',
        title: '.questionContent',
        options: '.optionUl label'
      },
      {
        name: '智慧课 作业',
        root: '.questionContent',
        title: '.questionName .centent-pre',
        options: '.radio-view li.clearfix, .checkbox-views label.el-checkbox, .fillAnswer'
      },
      {
        name: '智慧课 考试',
        root: '.question-area-content',
        title: '.text-mainText.font-medium, .font-medium',
        options: 'label.user-select.group, div.real-editor'
      },
      {
        name: '融合课',
        root: '.exam-item',
        title: '.quest-title .option-name, .option-name',
        options: 'label',
        typeEl: '.quest-type'
      },
      {
        name: '高教社 作业',
        root: '.q_main',
        title: '.question-topic',
        options: 'label',
        typeEl: '.question_score'
      },
      {
        name: '高教社 课后作业',
        root: '.question-item',
        title: '.qeustion-content, .combination-content',
        options: '.option-item, .vditor-content',
        typeEl: '.title-box, .combination-title'
      }
    ],
  };

  /**
   * 雨课堂答题控件选择器。
   * 实测坑：判断题在真实页面**不是** ul.list-unstyled li label 结构
   * （v2.1.0 导出的 127 道判断题全部「无选项」），所以这里把常见的几种
   * radio/checkbox 变体都列上；仍抠不到时代码里还有「从 input 反推」和
   * 「按判断题题型补固定两项」两层兜底。
   */
  var YKT_OPTION_SELECTOR = [
    'ul[class*="list-unstyled"] li label',
    'ul[class*="list-unstyled"] li .radioText',
    'ul[class*="list-unstyled"] li .checkboxText',
    'label.el-radio',
    'label.el-checkbox',
    '.el-radio',
    '.el-checkbox',
    '.judge-item',
    '[class*="judge"] li',
    'iframe[id^="ueditor_"]',
    'input.blank-item-dynamic',
    'input[placeholder="输入答案"]',
    'textarea'
  ].join(', ');

  PROFILES.yuketang = [
    {
      name: '作业（题目区）',
      root: '.container-problem .subject-item, .problem-container .subject-item',
      title: '.problem-body, .item-body > div:first-child',
      // 填空题的横线是 input 不是文字，需要先把空格替换成 ____ 再取文本
      titleText: yktTitleOf,
      options: YKT_OPTION_SELECTOR,
      typeEl: '.item-type'
    },
    {
      name: '作业（兜底）',
      root: '.subject-item',
      title: '.problem-body, .item-body > div:first-child',
      titleText: yktTitleOf,
      options: YKT_OPTION_SELECTOR,
      typeEl: '.item-type'
    }
  ];

  function getProfiles() {
    return PROFILES[PLATFORM] || [];
  }

  /* ============================== 抠题 ============================== */

  function queryAll(doc, selector) {
    if (!selector) return [];
    try { return Array.prototype.slice.call(doc.querySelectorAll(selector)); }
    catch (e) { return []; }
  }

  var LETTER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function letter(i) { return LETTER[i] || String(i + 1); }

  function extractWithProfile(doc, profile) {
    // 抠题是同步的，这里把该文档的字体映射表临时挂到 ACTIVE_MAP，
    // textOf 里的 decryptInText 就会自动翻译密文（未解密时为 null，零开销）
    var prevMap = ACTIVE_MAP;
    ACTIVE_MAP = DOC_MAPS.get(doc) || null;

    try {
    var roots = queryAll(doc, profile.root);
    var questions = [];

    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];

      var titleEls = pickTitleEls(root, profile);
      // titleText 允许平台自定义题干提取（雨课堂填空题要把横线 input 换成 ____）
      var titleParts = titleEls.map(function (el) {
        var t = profile.titleText ? profile.titleText(el) : textOf(el);
        return t;
      }).filter(Boolean);
      var title = dedupeLines(titleParts.join('\n'));
      if (!title) continue;

      var optionEls = pickOptionEls(root, profile.options);
      var options = [];
      for (var j = 0; j < optionEls.length; j++) {
        var rawOpt = textOf(optionEls[j]);
        var txt = normalizeOptionText(rawOpt, letter(j));
        if (txt) options.push({ text: txt, checked: isChecked(optionEls[j]) });
      }

      var type = null;
      var typeEl = profile.typeEl ? root.querySelector(profile.typeEl) : null;
      if (typeEl) type = typeFromText(decryptInText(normalize(typeEl.textContent) + normalize(typeEl.value)));
      if (!type) type = typeFromDom(root);
      if (!type) type = options.length >= 2 ? 'single' : 'completion';

      // 兜底一：选择题/判断题的选项不是预期结构时，直接读实际的 radio/checkbox
      if (!options.length && (type === 'single' || type === 'multiple' || type === 'judgement')) {
        options = optionsFromInputs(root);
      }
      // 兜底二：判断题的「对/错」既可能没有 input，也不在任何已知选项容器里，
      // 那就扫叶子节点，直接找写着判断词的元素，拿到的是页面真实用词
      if (!options.length && type === 'judgement') {
        options = judgementOptionsFromDom(root);
      }
      // 兜底三：判断题页面若把「对/错」渲染成图标（无 input、无可读文本），
      // 按题型补上固定的两项，否则 AI 拿到一道没有任何选项的判断题没法作答。
      if (!options.length && type === 'judgement') {
        options = [{ text: '正确', checked: false }, { text: '错误', checked: false }];
        SYNTH_COUNT.judgement++;
      }
      // 兜底四：明明有答题控件却一个选项都没抠出来，说明选择器跟这个平台的变体对不上，记下来
      if (!options.length && root.querySelector('input[type="radio"], input[type="checkbox"], textarea')) {
        SYNTH_COUNT.missed++;
      }

      // 最后一道安全网：万一页面里根本没有「纯题干」元素（只有一个把选项也包进去的
      // .problem-body），题干末尾会拖着「A / 、xxx / B / …」这一段，这里按已抠出的
      // 选项名单把它剥掉，保证任何情况下题干里都不会混进选项。
      title = stripOptionEcho(title, options);

      questions.push({ title: title, options: options, type: type });
    }
    return questions;
    } finally {
      ACTIVE_MAP = prevMap;
    }
  }

  /**
   * 挑出题干元素。两道闸门，缺一不可：
   *
   * ① DOM 包含：命中元素里若还套着另一个命中元素，只保留最内层那个（容器丢掉）。
   * ② 文本包含：真实雨课堂页面里 `.problem-body` 的 innerText 是「题干 + 全部选项」，
   *    而 `.item-body > div:first-child` 只有题干，两者在 DOM 里**并不嵌套** ——
   *    只靠 ① 拦不住，题干里会多出一整段选项文本，且题干本身出现两遍
   *    （v2.1.0 实测：120 道单选题全部如此）。这里按「谁更纯」来选：
   *    候选 A 的文本若是候选 B 文本的子串，就丢 A 留 B。
   */
  function pickTitleEls(root, profile) {
    var matched = queryAll(root, profile.title);
    if (!matched.length) return [];

    var cands = [];
    for (var i = 0; i < matched.length; i++) {
      var el = matched[i];
      var key = normalize(el.innerText || el.textContent || '').replace(/\s+/g, '');
      if (!key) continue;
      cands.push({ el: el, key: key });
    }
    if (!cands.length) return [];

    return cands.filter(function (c) {
      for (var k = 0; k < cands.length; k++) {
        var o = cands[k];
        if (o === c) continue;
        // ① 别的命中元素被它套着 → 它只是个容器
        if (c.el.contains(o.el)) return false;
        // ② 别的候选更短、且整段是它的子串 → 它多带了选项，丢掉（≥4 字防误杀）
        if (o.key !== c.key && o.key.length >= 4 && c.key.indexOf(o.key) !== -1) return false;
      }
      return true;
    }).map(function (c) { return c.el; });
  }

  /**
   * 取选项元素，并丢掉「被另一个命中元素包着」的内层元素。
   * 与题干相反，选项要保留**最外层**：选项选择器常同时命中 label 和 label 里的
   * .radioText / .checkboxText，不去重每个选项会出现两遍，连「页面已选」的
   * 字母判定都会错位（实测 fixture 里 checked 从 B 变成 D）。
   */
  function pickOptionEls(root, selector) {
    var matched = queryAll(root, selector);
    if (matched.length < 2) return matched;
    return matched.filter(function (el) {
      for (var k = 0; k < matched.length; k++) {
        if (matched[k] !== el && matched[k].contains(el)) return false;
      }
      return true;
    });
  }

  /**
   * 归一化选项文本。
   * 雨课堂真实页面的选项控件 innerText 是「字母 + 换行 + 顿号 + 内容」，例如
   *   "A\n、 九一八事变"
   * 直接导出会变成两行、且字母重复一遍。这里折叠换行、剥掉与位置匹配的字母前缀。
   * 只在**字母恰好等于该选项的序号字母**时才剥，避免把「A、B、C 三种」这种
   * 真的以字母开头的选项内容吃掉。
   */
  function normalizeOptionText(raw, expectLetter) {
    var t = String(raw == null ? '' : raw).replace(/\r/g, '');
    t = t.replace(/[ \t\f\v]{2,}/g, ' ').trim();

    // 字母 + （可选换行）+ 分隔符：整段剥掉
    var lead = /^([A-Za-z])[ \t\f\v]*(?:\n[ \t\f\v]*)?([、.．,，:：)）])[ \t\f\v]*/.exec(t);
    if (lead && (!expectLetter || lead[1].toUpperCase() === String(expectLetter).toUpperCase())) {
      return t.slice(lead[0].length).trim();
    }
    // 没有字母、直接以分隔符开头：也剥掉
    if (/^[、.．,，:：][ \t\f\v]/.test(t)) return t.replace(/^[、.．,，:：][ \t\f\v]*/, '').trim();
    return t;
  }

  /**
   * 去掉整行完全重复的行（雨课堂会同时渲染桌面版/移动版节点，文本一模一样） */
  function dedupeLines(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var key = lines[i].replace(/\s+/g, '');
      if (key && seen[key]) continue;
      if (key) seen[key] = 1;
      out.push(lines[i]);
    }
    return out.join('\n');
  }

  /**
   * 兜底取选项：直接从实际的 radio / checkbox 反推。
   * 选项文本优先取最近的 label / 父元素；取不到就退回 input.value
   * （雨课堂判断题的 input value 是 "true"/"false"，对应「对/错」）。
   */
  function optionsFromInputs(root) {
    var inputs = queryAll(root, 'input[type="radio"], input[type="checkbox"]');
    var out = [];
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var row = null;
      try { row = inp.closest('label') || inp.parentElement; } catch (e) { row = inp.parentElement; }
      var t = '';
      if (row) t = decryptInText(normalize(row.innerText || row.textContent || ''));
      if (!t) {
        var v = String(inp.value || '');
        t = v === 'true' ? '对' : v === 'false' ? '错' : v;
      }
      t = normalizeOptionText(t, letter(out.length));
      if (!t) continue;
      out.push({ text: t, checked: !!inp.checked });
    }
    return out;
  }

  /**
   * 判断题兜底：扫叶子节点，找出写着判断词的可点元素。
   * 比「直接补 正确/错误」更好——拿到的是页面真实用词（对/错 / √/× / 是/否）。
   */
  var JUDGE_WORDS = ['正确', '错误', '对', '错', '√', '×', '✓', '✗', 'T', 'F', '是', '否'];

  function judgementOptionsFromDom(root) {
    var els = queryAll(root, '*');
    var found = [];
    var seen = Object.create(null);
    for (var i = 0; i < els.length && found.length < 4; i++) {
      var el = els[i];
      if (el.children && el.children.length) continue;      // 只看叶子，避免把题干容器当选项
      var t = decryptInText(normalize(el.innerText || el.textContent || ''));
      if (!t || t.length > 6) continue;
      t = normalizeOptionText(t, letter(found.length));
      if (!t || t.length > 4) continue;
      if (JUDGE_WORDS.indexOf(t) === -1) continue;
      if (seen[t]) continue;
      seen[t] = 1;
      found.push({ text: t, checked: isChecked(el) });
    }
    return found.length >= 2 ? found : [];
  }

  /**
   * 安全网：把题干里混进来的选项行剥掉。
   * 真实页面上 `.problem-body` 的 innerText 是「题干 + 选项」，若它同时是唯一命中的
   * 题干元素（拿不到纯题干元素），题干里就会拖着一串「A / 、 xxx / B / …」。
   * 这里按已抠出的选项名单，逐行丢掉「裸字母」「以顿号开头」「内容等于某个选项」的行；
   * 丢空了就整体放弃（宁可保留原文，也不能把题干清成空）。
   */
  function stripOptionEcho(title, options) {
    if (!title || !options || options.length < 2) return title;
    var keys = options.map(function (o) { return normalize(o.text).replace(/\s+/g, ''); })
      .filter(function (k) { return k; });
    if (keys.length < 2) return title;

    var lines = String(title).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var k = normalize(raw).replace(/\s+/g, '');
      if (k) {
        var drop = false;
        if (/^[A-Za-z]$/.test(k)) drop = true;                    // 光秃秃一个字母
        else if (/^[、.．,，:：)]/.test(k)) drop = true;            // 「、 xxx」这种半截
        if (!drop) {
          for (var j = 0; j < keys.length; j++) {
            // 整行就是一个选项，或「字母 + 顿号 + 选项」
            if (k === keys[j] ||
                k === letter(j) + keys[j] ||
                k === letter(j) + '、' + keys[j]) { drop = true; break; }
          }
        }
        if (drop) continue;
      }
      out.push(raw);
    }
    var res = out.join('\n').trim();
    return res || title;
  }

  /** 选最合适的一套规则：命中题目多、且有选项的题权重更高 */
  function pickBestProfile(doc) {
    var profiles = getProfiles();
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < profiles.length; i++) {
      var qs = extractWithProfile(doc, profiles[i]);
      var withOptions = qs.filter(function (q) { return q.options.length >= 2; }).length;
      var score = qs.length + withOptions * 2;
      if (qs.length && score > bestScore) {
        bestScore = score;
        best = { profile: profiles[i], questions: qs };
      }
    }
    return best;
  }

  function collectDocuments(doc, depth, out) {
    out.push(doc);
    if (depth >= CONFIG.maxFrameDepth) return out;
    var frames = doc.querySelectorAll('iframe, frame');
    for (var i = 0; i < frames.length; i++) {
      var child = null;
      try { child = frames[i].contentDocument; } catch (e) { child = null; }
      if (child && child.documentElement && out.indexOf(child) === -1) {
        collectDocuments(child, depth + 1, out);
      }
    }
    return out;
  }

  function dedupeQuestions(list) {
    var seen = {};
    return list.filter(function (q) {
      var key = q.title.replace(/\s+/g, '').slice(0, 140);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /** 扫当前文档 + 同源子 iframe */
  function scanAll() {
    var docs = collectDocuments(document, 0, []);
    var all = [];
    for (var i = 0; i < docs.length; i++) {
      var best = pickBestProfile(docs[i]);
      if (best) {
        best.questions.forEach(function (q) { q.profile = best.profile.name; });
        all = all.concat(best.questions);
      }
    }
    return dedupeQuestions(all);
  }

  /** 先解密字体、再扫全页（「导出本页题目」走这条） */
  async function scanAllDecrypted(onProgress) {
    resetSynthCount();
    var docs = collectDocuments(document, 0, []);
    await prepareDecrypt(docs, onProgress);
    return scanAll();
  }

  /* ============================== Markdown ============================== */

  /** 选项已自带 "A." 前缀时不重复加 */
  function optionLine(i, text) {
    var first = (text.split('\n')[0] || '').trim();
    if (new RegExp('^' + letter(i) + '[、.．)\\s]').test(first)) return text;
    return letter(i) + '. ' + text;
  }

  function questionToMarkdown(q, index, headingLevel) {
    var h = headingLevel || '###';
    var lines = [];
    lines.push(h + ' ' + (index !== undefined ? index + '. ' : '') + (TYPE_LABEL[q.type] || TYPE_LABEL.unknown));
    lines.push('');
    lines.push(q.title);
    lines.push('');

    if (q.options.length) {
      if (q.type === 'completion') {
        q.options.forEach(function (o, j) {
          lines.push('- 第 ' + (j + 1) + ' 空：' + o.text.replace(/\n/g, ' '));
        });
      } else {
        q.options.forEach(function (o, j) {
          lines.push('- ' + optionLine(j, o.text).replace(/\n/g, '\n  '));
        });
      }
    } else {
      lines.push('_（无选项）_');
    }

    var picked = [];
    q.options.forEach(function (o, j) { if (o.checked) picked.push(letter(j)); });
    if (picked.length) {
      lines.push('');
      lines.push('**页面已选：' + picked.join(' ') + '**');
    }

    return lines.join('\n');
  }

  /** 解密相关的提示行（写进文件头，方便事后判断导出的是不是明文） */
  function decryptNoteLines() {
    var lines = [];
    if (!CONFIG.decrypt.enabled) {
      lines.push('- 字体解密：已关闭');
    } else if (DECRYPT_WARNINGS.length) {
      DECRYPT_WARNINGS.forEach(function (w) { lines.push('- ⚠ 字体解密：' + w); });
    } else {
      var n = Object.keys(FONT_CACHE).length;
      lines.push('- 字体解密：' + (n ? '已破解 ' + n + ' 个字体映射表' : '本页无加密文字'));
    }
    if (SYNTH_COUNT.judgement) {
      lines.push('- 说明：有 ' + SYNTH_COUNT.judgement + ' 道判断题页面未渲染出可读选项，按题型补了「正确 / 错误」两项');
    }
    if (SYNTH_COUNT.missed) {
      lines.push('- ⚠ 有 ' + SYNTH_COUNT.missed + ' 道题检测到答题控件却没抠出选项文本，建议用 diagnose() 排查选择器');
    }
    return lines;
  }

  /**
   * 文末提示词：让用户把整份文件直接丢给 AI 就能拿到「题号 + 答案」。
   * 格式定死是为了方便回填——每行 `章节-题号. 答案`，AI 不需要解释。
   */
  function aiPromptSection(opts) {
    opts = opts || {};
    var grouped = !!opts.grouped;
    var total = opts.total || 0;
    var lines = [];
    lines.push('---');
    lines.push('');
    lines.push('# 【提示词】把本文件整份发给 AI，直接拿到「题号 + 答案」');
    lines.push('');
    lines.push('> 下面这段是给 AI 的指令，**连本文件一起整份粘贴或上传**即可，不用再改。');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('你是答题助手。上面的内容是一份课程作业题目清单，' +
      (grouped ? '按作业/章节分组，' : '') +
      '共 ' + (total || '若干') + ' 道题，每道题都标了题型' +
      (grouped ? '（除单选题外还可能是多选题 / 判断题 / 填空题）' : '') + '。');
    if (opts.optionNote) lines.push('');
    if (opts.optionNote) lines.push(opts.optionNote);
    lines.push('');
    lines.push('## 你的任务');
    lines.push('');
    lines.push('逐题给出答案，**一道都不能漏**，严格按下面的规定输出。');
    lines.push('不要写解释、分析、前言、总结，也不要重复题干。');
    lines.push('');
    lines.push('## 答案格式');
    lines.push('');
    lines.push('每行一题，格式固定为：`' + (grouped ? '章节号-题号' : '题号') + '. 答案`');
    lines.push('');
    lines.push('- 单选题：给一个字母，例：`' + (grouped ? '3-5' : '5') + '. C`');
    lines.push('- 多选题：给全部正确选项字母，按字母顺序连写，例：`' + (grouped ? '3-6' : '6') + '. ABD`');
    lines.push('- 判断题：只写 `对` 或 `错`，例：`' + (grouped ? '1-2' : '2') + '. 错`');
    lines.push('- 填空题：按空位顺序写，用 ` / ` 分隔，例：`' + (grouped ? '2-4' : '4') + '. 防御性 / 积极防御`');
    lines.push('- 简答 / 论述题：只给要点，用 `；` 分隔，不超过 80 字');
    lines.push('');
    lines.push('## 其他要求');
    lines.push('');
    if (grouped) {
      lines.push('1. 章节号取二级标题（`## 1. …`）开头的数字，题号取三级标题（`### 3. …`）开头的数字。');
    } else {
      lines.push('1. 题号取三级标题（`### 3. …`）开头的数字。');
    }
    lines.push('2. 把握不大的题，在答案后加 `?`（例：`' + (grouped ? '5-9' : '9') + '. B?`），**不要留空、不要跳过**。');
    lines.push('3. 所有答案放进一个代码块里连续输出，中间不要插入别的文字。');
    lines.push('4. 题目超过 150 道时允许分几段连续输出，段与段之间不重复、不遗漏。');
    lines.push('');
    lines.push('输出长这样：');
    lines.push('');
    lines.push('    ' + (grouped ? '1-1' : '1') + '. 对');
    lines.push('    ' + (grouped ? '1-2' : '2') + '. 错');
    lines.push('    ' + (grouped ? '2-1' : '3') + '. C');
    lines.push('    ' + (grouped ? '2-2' : '4') + '. ABD');
    lines.push('');
    return lines;
  }

  /** 判断题若是补出来的固定两项，提示里要说清楚，免得 AI 以为是页面原文 */
  function optionNote() {
    return SYNTH_COUNT.judgement
      ? '> 注：判断题未从页面抠到选项原文，统一按「正确 / 错误」两项处理，作答时写 `对` 或 `错` 即可。'
      : '';
  }

  function buildMarkdown(questions, meta) {
    meta = meta || {};
    var counts = {};
    questions.forEach(function (q) { counts[q.type] = (counts[q.type] || 0) + 1; });
    var dist = Object.keys(counts)
      .map(function (k) { return (TYPE_LABEL[k] || k) + ' ' + counts[k]; })
      .join(' / ');

    var lines = [];
    lines.push('# ' + (meta.title || ('题目导出 · ' + platformName())));
    lines.push('');
    lines.push('- 来源：' + location.href);
    lines.push('- 时间：' + timestamp());
    lines.push('- 题量：' + questions.length);
    lines.push('- 题型分布：' + dist);
    decryptNoteLines().forEach(function (l) { lines.push(l); });
    lines.push('');
    lines.push('---');
    lines.push('');

    questions.forEach(function (q, i) {
      lines.push(questionToMarkdown(q, i + 1, '###'));
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    lines = lines.concat(aiPromptSection({ grouped: false, total: questions.length, optionNote: optionNote() }));
    return lines.join('\n');
  }

  /** 按章节分组的 Markdown（批量导出用） */
  function buildGroupedMarkdown(groups, meta) {
    meta = meta || {};
    var total = groups.reduce(function (n, g) { return n + g.questions.length; }, 0);
    var lines = [];
    lines.push('# ' + (meta.title || ('作业题目导出 · ' + platformName())));
    lines.push('');
    lines.push('- 来源：' + location.href);
    lines.push('- 时间：' + timestamp());
    lines.push('- 作业数：' + groups.length);
    lines.push('- 总题量：' + total);
    decryptNoteLines().forEach(function (l) { lines.push(l); });
    lines.push('');
    lines.push('---');
    lines.push('');

    groups.forEach(function (g, gi) {
      lines.push('## ' + (gi + 1) + '. ' + g.title);
      lines.push('');
      if (g.note) {
        lines.push('> ' + g.note);
        lines.push('');
      }
      if (!g.questions.length) {
        lines.push('_（未提取到题目）_');
        lines.push('');
        lines.push('---');
        lines.push('');
        return;
      }
      g.questions.forEach(function (q, qi) {
        lines.push(questionToMarkdown(q, qi + 1, '###'));
        lines.push('');
      });
      lines.push('---');
      lines.push('');
    });

    lines = lines.concat(aiPromptSection({ grouped: true, total: total, optionNote: optionNote() }));
    return lines.join('\n');
  }

  function download(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return filename;
  }

  /* ============================== 雨课堂：批量导出 ============================== */

  var YKT_EXERCISE_IFRAME = '.lms-graph-exercise iframe#iframeExerciseId, iframe#iframeExerciseId';
  var YKT_QUESTION_ROOT = '.container-problem .subject-item';
  var YKT_NAV_ITEM = '.problems-aside .subject-item.J_order';
  /** 平台风控人机验证容器 */
  var YKT_CAPTCHA = '#homework-automation-risk-challenge';
  /** 切题时「未保存答案」确认框 / 批量提交框（后者是写操作，脚本绝不代点） */
  var YKT_CHANGE_GUARD = '.homework-problem-change-guard-dialog';
  var YKT_BATCH_GUARD = '.homework-problem-batch-submit-dialog';
  /** 横线填空题的空格输入框 */
  var YKT_BLANK_INPUT = 'input.blank-item-dynamic, input[placeholder="输入答案"]';

  /**
   * 当前题目的标识 = 题型文本 + 正文前若干字符。
   * 仅用 .item-type 不够——同一种题型的两道题文本可能完全相同（都没带题号时），
   * 会导致「切题成功了但判定为没切换」而白等超时。带上正文就唯一了。
   */
  function yktMarker(doc) {
    var root = doc.querySelector(YKT_QUESTION_ROOT);
    if (!root) return '';
    var typeEl = root.querySelector('.item-type');
    var bodyEl = root.querySelector('.problem-body') || root.querySelector('.item-body');
    return normalize((typeEl ? typeEl.textContent : '') + '|' + (bodyEl ? bodyEl.textContent : ''))
      .replace(/\s+/g, '')
      .slice(0, 80);
  }

  /**
   * 提取题干文本（含解密）。
   * 横线填空题的答案输入框本身没有文本，直接提取会让题干里「少掉」那几个空，
   * 导出后看不出哪里要填。这里克隆一份、把每个空格输入框换成 ____ 再取文本。
   * 用克隆而不是改原 DOM：不触碰页面，避免干扰 Vue 的渲染。
   */
  function yktTitleOf(el) {
    if (!el.querySelector(YKT_BLANK_INPUT)) return textOf(el);
    var clone = el.cloneNode(true);
    var blanks = clone.querySelectorAll(YKT_BLANK_INPUT);
    for (var i = 0; i < blanks.length; i++) {
      blanks[i].parentNode.replaceChild(document.createTextNode('____'), blanks[i]);
    }
    return textOf(el, clone.textContent || '');
  }

  /** 取可见的 el-dialog__wrapper */
  function yktVisibleDialog(doc, selector) {
    var els;
    try { els = doc.querySelectorAll(selector); } catch (e) { return null; }
    for (var i = 0; i < els.length; i++) {
      var wrap = els[i].closest('.el-dialog__wrapper');
      if (wrap && wrap.style.display !== 'none') return wrap;
    }
    return null;
  }

  /**
   * 处理切题时弹出的「未保存答案」确认框。
   * - 切换确认框：先等用户手动点；超过 guardWaitMs 后自动点「确认」。
   *   我们全程没有作答，确认只是放弃未保存内容，不会提交任何答案。
   * - 批量提交框：绝不代点（那是写操作），最多等 5 分钟，超时就放弃等待继续跑。
   */
  async function resolveYktGuard(doc, onProgress) {
    if (yktVisibleDialog(doc, YKT_BATCH_GUARD)) {
      var tip = toast('检测到「批量提交」弹窗\n请手动处理（脚本不会代点）', false, 0);
      if (onProgress) onProgress('等待手动处理批量提交弹窗…');
      var deadline = Date.now() + 5 * 60 * 1000;
      while (yktVisibleDialog(doc, YKT_BATCH_GUARD) && Date.now() < deadline) await sleep(800);
      tip.remove();
      return;
    }
    if (!yktVisibleDialog(doc, YKT_CHANGE_GUARD)) return;

    if (onProgress) onProgress('检测到未保存答案确认框，等待手动确认…');
    var gone = await waitFor(function () {
      return !yktVisibleDialog(doc, YKT_CHANGE_GUARD);
    }, CONFIG.guardWaitMs, 300);
    if (gone) return;

    var wrap = yktVisibleDialog(doc, YKT_CHANGE_GUARD);
    if (wrap) {
      var btn = wrap.querySelector('.el-button--primary');
      if (btn) { btn.click(); await sleep(400); }
    }
  }

  /**
   * 等待用户手动完成平台风控人机验证。
   * 元素不存在时立即返回；存在则挂起，直到验证通过（元素消失）。
   * 作业在 iframe 内，优先在 doc 里找，兜底顶层 document。
   * 超过 10 分钟未完成则放弃等待，继续往下跑（题目可能取不到，会在 note 里体现）。
   */
  async function waitYktCaptcha(doc, onProgress) {
    var getCaptcha = function () {
      try { return doc.querySelector(YKT_CAPTCHA) || document.querySelector(YKT_CAPTCHA); } catch (e) { return null; }
    };
    if (!getCaptcha()) return;
    var tip = toast('检测到人机验证（安全核验）\n请手动完成验证，完成后自动继续导出', false, 0);
    if (onProgress) onProgress('等待手动完成人机验证…');
    var done = await waitFor(function () { return !getCaptcha(); }, 10 * 60 * 1000, 1000);
    tip.remove();
    if (done) toast('验证已完成，继续导出', true, 3000);
    else toast('等待人机验证超时（10 分钟），继续尝试导出', false, 6000);
  }

  /** 在作业 iframe 内遍历所有题号，逐题读取（只读，不提交） */
  async function tourYuketangExercise(doc, hooks) {
    hooks = hooks || {};
    var onProgress = hooks.onProgress;

    // 两条通道：计数进度用 (i, total, msg)，纯文字提示用 (null, null, msg)。
    // 早先两类提示共用一个回调，导致「等待人机验证」被当成题号渲染成
    // 「第 等待手动完成人机验证…/undefined 题」（夹具里实测到）。
    var note = onProgress ? function (msg) { onProgress(null, null, msg); } : null;

    await waitYktCaptcha(doc, note);

    /** 当前题的「解密 + 抠题」：每次切题后新出现的密文都会增量破解 */
    async function readCurrent() {
      await ensureDecrypt(doc, hooks.onDecrypt);
      return extractWithProfile(doc, PROFILES.yuketang[0]);
    }

    // 没有题号导航，说明题目已一次性渲染完，直接抠
    var navs = Array.from(doc.querySelectorAll(YKT_NAV_ITEM));
    if (navs.length <= 1) {
      var once = dedupeQuestions(await readCurrent());
      once.skipped = [];
      once.dupNavs = [];
      once.navTotal = 0;   // 0 = 不是逐题导航，别做数量核对
      return once;
    }

    var collected = [];
    var seen = {};
    var skipped = [];       // 始终没读到的题号（1 基），导出时写进章节备注
    var dupNavs = [];       // 内容与已收录重复的题号（1 基）

    function keyOf(q) { return q.title.replace(/\s+/g, '').slice(0, 140); }

    for (var i = 0; i < navs.length; i++) {
      var accepted = false;

      // 同一题号最多试 3 次。风控弹窗（#homework-automation-risk-challenge）
      // 是在【点击切题的那一刻】被触发的，所以检查点必须放在点击之后；
      // 否则会读到上一题的旧内容、又被标题去重静默吃掉 —— 表现就是「这题被略过了」。
      for (var attempt = 0; attempt < 3 && !accepted; attempt++) {
        await waitYktCaptcha(doc, note);

        var nav = doc.querySelectorAll(YKT_NAV_ITEM)[i];
        if (!nav) break;

        var before = yktMarker(doc);
        var wasActive = nav.classList.contains('active') && attempt === 0;

        if (!wasActive) {
          nav.click();
          await sleep(300);
          // 弹窗会挡住切题，先处理
          await resolveYktGuard(doc, note);
          // 点击后立刻再查一次人机验证（风控就在这里弹）
          await waitYktCaptcha(doc, note);

          var changed = await waitFor(function () {
            var m = yktMarker(doc);
            return m && m !== before;
          }, CONFIG.stepTimeoutMs, 150);

          await sleep(CONFIG.stepSettleMs);
          await resolveYktGuard(doc, note);
          await waitYktCaptcha(doc, note);

          if (!changed) {
            // marker 没变有两种可能：正文相同的两道题（极少），或者根本没切过去。
            // 用「这一题抠出来的内容是不是已经收录过」来区分，是新的就照样收下。
            var probe = await readCurrent();
            var freshProbe = probe.filter(function (q) { return !seen[keyOf(q)]; });
            if (!freshProbe.length) {
              if (attempt < 2 && onProgress) {
                onProgress(i + 1, navs.length, '第 ' + (i + 1) + ' 题未切换成功，重试…');
              }
              continue;   // 还是旧题，重试
            }
          }
        }

        var marker = yktMarker(doc);
        var qs = await readCurrent();
        var fresh = qs.filter(function (q) { return keyOf(q) && !seen[keyOf(q)]; });

        if (qs.length && !fresh.length) {
          // 内容抠到了但全被去重 —— 说明这道题的内容与已收录的重复
          // （本页点过两次同一题号，或平台重复渲染），记一笔便于事后核对。
          dupNavs.push(i + 1);
        }
        fresh.forEach(function (q) {
          seen[keyOf(q)] = true;
          q.marker = marker;
          q.order = i + 1;
          collected.push(q);
        });
        if (qs.length) accepted = true;
        else if (attempt < 2 && onProgress) {
          onProgress(i + 1, navs.length, '第 ' + (i + 1) + ' 题内容为空，重试…');
        }
      }

      if (!accepted) skipped.push(i + 1);
      if (onProgress) onProgress(i + 1, navs.length, collected.length);
    }

    collected.skipped = skipped;
    collected.dupNavs = dupNavs;
    collected.navTotal = navs.length;
    return collected;
  }

  /** 找出本页所有「作业类」任务点 */
  function listYuketangTasks(doc) {
    var roots = queryAll(doc, '.leaf-item');
    if (!roots.length) roots = queryAll(doc, '[class*="leaf-item"]');

    var tasks = [];
    roots.forEach(function (el) {
      var tagEl = el.querySelector('.leaf-item-tag');
      var titleEl = el.querySelector('.leaf-item-title');
      var tag = normalize(tagEl ? tagEl.textContent : '');
      var title = normalize(titleEl ? titleEl.textContent : el.textContent);
      if (!title) return;
      // 只要作业 / 测验 / 考试类任务点
      if (!/作业|测验|考试|测试/.test(tag)) return;

      var finished = !!el.querySelector('[class*="yuanquangou"]');
      tasks.push({
        el: el,
        tag: tag,
        title: title,
        finished: finished,
        chapter: nearestChapterTitle(el)
      });
    });
    return tasks;
  }

  var YKT_CHAPTER_TITLE_SELECTORS = ['.nav-item-title', '.chapter-title', '.section-title', '.nav-item-title-text'];

  /**
   * 往上找最近的章节标题。
   * 注意：章节标题常与 .leaf-item 是兄弟节点，用 prev.querySelector 只会搜后代、
   * 匹配不到元素自身，所以这里要先判断元素本身是否命中。
   */
  function nearestChapterTitle(el) {
    var node = el;
    var guard = 0;
    while (node && node !== document.body && guard++ < 30) {
      var prev = node.previousElementSibling;
      while (prev) {
        for (var i = 0; i < YKT_CHAPTER_TITLE_SELECTORS.length; i++) {
          var sel = YKT_CHAPTER_TITLE_SELECTORS[i];
          var hit = null;
          if (prev.matches && prev.matches(sel)) hit = prev;
          else if (prev.querySelector) hit = prev.querySelector(sel);
          if (hit && normalize(hit.textContent)) return normalize(hit.textContent);
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  /** 任务点元素可能在切题过程中被 Vue 重渲染掉，失效时按 title+tag 重新定位 */
  function findTaskEl(task) {
    if (task.el && task.el.isConnected) return task.el;
    var fresh = listYuketangTasks(document);
    for (var k = 0; k < fresh.length; k++) {
      if (fresh[k].title === task.title && fresh[k].tag === task.tag) return fresh[k].el;
    }
    return null;
  }

  /** 进入作业并等题目根渲染；超时后再点一次任务点重试一次（应对首屏加载慢） */
  async function enterYuketangExercise(task, onRetry) {
    // 点任务点前先记下当前 iframe 的题目标识。
    // 雨课堂很可能复用同一个 iframe 元素、只换内容，此时「等了到 iframe」会立刻命中
    // 上一个作业的旧内容 —— 必须等标识变化，才能确认已经切到新作业。
    var prevIframe = document.querySelector(YKT_EXERCISE_IFRAME);
    var prevMarker = '';
    try {
      if (prevIframe && prevIframe.contentDocument) prevMarker = yktMarker(prevIframe.contentDocument);
    } catch (e) { /* 跨域读不到，忽略 */ }

    function currentDoc() {
      var f = document.querySelector(YKT_EXERCISE_IFRAME);
      var d = null;
      try { d = f && f.contentDocument; } catch (e) { d = null; }
      if (!d || !d.querySelector(YKT_QUESTION_ROOT)) return null;
      return { doc: d, frame: f, marker: yktMarker(d) };
    }

    for (var attempt = 0; attempt < 2; attempt++) {
      var el = findTaskEl(task);
      if (!el) return { error: '任务点元素已失效（页面被重渲染），无法重新定位' };

      el.click();
      await waitYktCaptcha(document);
      await sleep(400);

      // 第一阶段：等内容真的换掉（标识变化 或 iframe 元素被换新）
      if (prevMarker) {
        var switched = await waitFor(function () {
          var c = currentDoc();
          if (!c) return null;
          if (c.marker && c.marker !== prevMarker) return c;
          if (c.frame !== prevIframe) return c;
          return null;
        }, CONFIG.stepTimeoutMs, 200);
        if (switched) return { doc: switched.doc };
        // 没换也不死等：可能本来就是同一个作业，继续走第二阶段判定
      }

      // 第二阶段：等题目根就绪
      var ready = await waitFor(function () {
        var c = currentDoc();
        return c && c.marker ? c : null;
      }, CONFIG.exerciseTimeoutMs, 200);
      if (ready) return { doc: ready.doc };

      if (attempt === 0) {
        if (onRetry) onRetry();
        prevMarker = '';
        await sleep(1500);
      }
    }
    return { error: '作业页面加载超时，未取到题目（已重试 1 次）' };
  }

  async function batchExportYuketang(onProgress) {
    var tasks = listYuketangTasks(document);
    if (!tasks.length) {
      throw new Error(
        '未在页面中找到「作业」任务点。\n' +
        '请确认当前是课程的「学习内容 / 未完成」列表页。\n' +
        '可执行 __courseExport.diagnose() 查看页面结构。'
      );
    }

    var targets = tasks.filter(function (t) { return !t.finished; });
    if (!targets.length) targets = tasks;

    resetSynthCount();
    var groups = [];
    for (var i = 0; i < targets.length; i++) {
      var task = targets[i];
      var group = {
        title: (task.chapter ? task.chapter + ' / ' : '') + task.title,
        questions: [],
        note: ''
      };
      groups.push(group);

      if (onProgress) onProgress(i + 1, targets.length, '进入：' + task.title);

      try {
        var entered = await enterYuketangExercise(task, function () {
          if (onProgress) onProgress(i + 1, targets.length, '加载较慢，重试进入：' + task.title);
        });
        if (entered.error) {
          group.note = entered.error;
          continue;
        }

        var idoc = entered.doc;
        await sleep(600);

        group.questions = await tourYuketangExercise(idoc, {
          onProgress: function (cur, total, got) {
            if (!onProgress) return;
            // cur 为空 = 上层发的是「纯文字提示」（等待人机验证之类），原样透传
            if (!cur) { onProgress(null, null, got); return; }
            onProgress(i + 1, targets.length, '第 ' + cur + '/' + total + ' 题（本章已取 ' + got + '）');
          },
          onDecrypt: function (done, total) {
            if (onProgress) onProgress(i + 1, targets.length, '字体解密 ' + done + '/' + total + ' 字…');
          }
        });

        var notes = [];
        // 题号总数 vs 实收题量：不等就说明有题没读进来（以前被静默吃掉，看不到）
        if (group.questions.navTotal && group.questions.length < group.questions.navTotal) {
          notes.push('⚠ 题号导航共 ' + group.questions.navTotal + ' 题，实收 ' + group.questions.length +
            ' 题；未读到的题号：' + (group.questions.skipped.join(', ') || '（被去重，见下）'));
        }
        if (group.questions.dupNavs && group.questions.dupNavs.length) {
          notes.push('题号 ' + group.questions.dupNavs.join(', ') + ' 的内容与前面重复（平台重复渲染或切换异常），已去重');
        }
        // 有密文但没拿到映射表 = 解密失败，明确标出来（导出的是乱码）
        var cipherEls = encryptedEls(idoc);
        if (cipherEls.length && !DOC_MAPS.get(idoc)) {
          notes.push('⚠ 本章题目仍为加密字体（解密失败），文字可能是乱码');
        }
        group.note = notes.join('；');
      } catch (err) {
        group.note = '处理失败：' + (err && err.message ? err.message : err);
      }

      await sleep(500);
    }

    return groups;
  }

  /* ============================== 诊断 ============================== */

  function diagnose() {
    var lines = [];
    lines.push('=== 页面 ===');
    lines.push('url: ' + location.href);
    lines.push('platform: ' + platformName());
    lines.push('title: ' + document.title);

    lines.push('');
    lines.push('=== 任务点候选 ===');
    ['.leaf-item', '[class*="leaf-item"]', '.nav-item-title', '[class*="leaf-item-tag"]'].forEach(function (sel) {
      lines.push(sel + ' -> ' + document.querySelectorAll(sel).length);
    });

    var tasks = listYuketangTasks(document);
    lines.push('识别到的作业任务点: ' + tasks.length);
    tasks.slice(0, 10).forEach(function (t, i) {
      lines.push('  [' + i + '] tag=' + JSON.stringify(t.tag) +
        ' finished=' + t.finished +
        ' chapter=' + JSON.stringify(t.chapter) +
        ' title=' + JSON.stringify(t.title.slice(0, 30)));
    });

    lines.push('');
    lines.push('=== 作业 iframe ===');
    lines.push(YKT_EXERCISE_IFRAME + ' -> ' + document.querySelectorAll(YKT_EXERCISE_IFRAME).length);
    var f = document.querySelector(YKT_EXERCISE_IFRAME);
    lines.push('contentDocument 可访问: ' + !!(f && f.contentDocument));
    if (f && f.contentDocument) {
      var idoc = f.contentDocument;
      lines.push('  ' + YKT_QUESTION_ROOT + ' -> ' + idoc.querySelectorAll(YKT_QUESTION_ROOT).length);
      lines.push('  ' + YKT_NAV_ITEM + ' -> ' + idoc.querySelectorAll(YKT_NAV_ITEM).length);
      var qs = extractWithProfile(idoc, PROFILES.yuketang[0]);
      lines.push('  当前题提取到: ' + qs.length);
      qs.slice(0, 3).forEach(function (q, i) {
        lines.push('    [' + i + '] type=' + q.type + ' opts=' + q.options.length +
          ' title=' + JSON.stringify(q.title.slice(0, 30)));
      });
    }

    lines.push('');
    lines.push('=== 字体解密 ===');
    lines.push('开关: ' + CONFIG.decrypt.enabled + ' / 特征表: ' + CONFIG.decrypt.refTableUrl);
    lines.push('已加载特征表: ' + Object.keys(REF_TABLE_CACHE).length + ' / 已破解字体: ' + Object.keys(FONT_CACHE).length);
    collectDocuments(document, 0, []).forEach(function (d, i) {
      var els = encryptedEls(d);
      if (!els.length) return;
      var url = findExamFontUrl(d);
      var map = DOC_MAPS.get(d);
      lines.push('  文档 ' + i + '：密文元素 ' + els.length + ' 个');
      lines.push('    @font-face: ' + listFontFaces(d).map(function (f) { return f.family + ' -> ' + f.src.slice(0, 90); }).join(' | '));
      lines.push('    字体资源: ' + findFontUrls(d).join(' | '));
      lines.push('    选中字体: ' + (url || '(未找到)'));
      lines.push('    当前映射表: ' + (map ? Object.keys(map).length + ' 条' : '(未破解)'));
      var sample = (els[0].textContent || '').slice(0, 24);
      lines.push('    密文样例: ' + JSON.stringify(sample));
      if (map) lines.push('    解密样例: ' + JSON.stringify(decryptText(sample, map)));
    });

    lines.push('');
    lines.push('=== 本页直接抠题 ===');
    lines.push('题数: ' + scanAll().length);

    var out = lines.join('\n');
    console.log(out);
    return out;
  }

  /* ============================== 界面 ============================== */

  function toast(msg, ok, ms) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:110px',
      'max-width:320px', 'padding:10px 14px', 'border-radius:8px',
      'font:13px/1.5 -apple-system,"Segoe UI",sans-serif', 'color:#fff',
      'background:' + (ok ? '#0F6E56' : '#993C1D'),
      'box-shadow:0 2px 10px rgba(0,0,0,.2)', 'pointer-events:none',
      'white-space:pre-wrap'
    ].join(';');
    document.body.appendChild(el);
    if (ms) setTimeout(function () { el.remove(); }, ms);
    return el;
  }

  function makeButton(text, color, bottom) {
    var btn = document.createElement('div');
    btn.textContent = text;
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'right:16px', 'bottom:' + bottom + 'px',
      'padding:8px 14px', 'border-radius:8px', 'cursor:pointer',
      'font:13px/1 -apple-system,"Segoe UI",sans-serif', 'color:#fff',
      'background:' + color, 'box-shadow:0 2px 10px rgba(0,0,0,.25)',
      'user-select:none'
    ].join(';');
    return btn;
  }

  function injectUI() {
    if (document.getElementById('__course_export_btn')) return;

    var btn = makeButton('导出本页题目', '#185FA5', 16);
    btn.id = '__course_export_btn';
    btn.title = '把当前页面的全部题目导出为 Markdown（自动破解字体反爬）';
    btn.addEventListener('click', async function () {
      var old = btn.textContent;
      btn.textContent = '扫描中…';
      var busy = null;
      try {
        var docs = collectDocuments(document, 0, []);
        if (docs.some(function (d) { return encryptedEls(d).length; })) {
          busy = toast('检测到加密文字，正在破解字体…', true, 0);
        }
        var questions = await scanAllDecrypted(function (msg) {
          btn.textContent = '解密中…';
          if (busy) busy.textContent = msg;
        });
        if (busy) { busy.remove(); busy = null; }
        if (!questions.length) {
          toast('未在当前页面找到题目。\n请确认已打开作业 / 考试 / 测试页面。', false, 4000);
        } else {
          var file = download(buildMarkdown(questions), '题目_' + platformName() + '_' + fileStamp() + '.md');
          toast('已导出 ' + questions.length + ' 题\n' + file, true, 4000);
        }
      } catch (err) {
        if (busy) busy.remove();
        toast('导出失败：' + (err && err.message ? err.message : err), false, 5000);
      }
      btn.textContent = old;
    });
    document.body.appendChild(btn);

    // 字体解密自检：只在雨课堂显示，方便快速确认解密是否有效
    if (PLATFORM === 'yuketang') {
      var dbg = makeButton('测试字体解密', '#5B4B8A', 108);
      dbg.id = '__course_export_decrypt_btn';
      dbg.title = '立即破解当前页面加密文字，并把 密文->真字 对照表打到控制台';
      dbg.addEventListener('click', async function () {
        var old = dbg.textContent;
        dbg.textContent = '解密中…';
        try {
          var out = await testDecrypt(60);
          var n = out.split('\n').filter(function (l) { return l.indexOf('->') !== -1; }).length;
          toast(n ? ('解密完成，' + n + ' 条映射已打印到控制台（F12）') : String(out), n > 0, 5000);
        } catch (err) {
          toast('解密失败：' + (err && err.message ? err.message : err), false, 6000);
        }
        dbg.textContent = old;
      });
      document.body.appendChild(dbg);
    }

    if (PLATFORM === 'yuketang') {
      var batch = makeButton('批量导出未完成作业', '#0F6E56', 62);
      batch.id = '__course_export_batch_btn';
      batch.title = '逐个进入未完成的作业任务点，遍历全部题目并按章节导出 Markdown（只读，不提交）';
      batch.addEventListener('click', async function () {
        var tasks = listYuketangTasks(document);
        if (!tasks.length) {
          toast('未找到作业任务点。\n请确认在「学习内容 / 未完成」列表页。\n可执行 __courseExport.diagnose() 排查。', false, 6000);
          return;
        }
        var pending = tasks.filter(function (t) { return !t.finished; });
        var list = pending.length ? pending : tasks;
        var preview = list.slice(0, 8).map(function (t) { return '· ' + t.title; }).join('\n');

        var ok = window.confirm(
          '即将依次进入 ' + list.length + ' 个作业任务点读取题目。\n' +
          '过程会点击左侧题号切换题目，但不会点击任何提交按钮。\n' +
          '题目文字若被字体加密，会自动破解还原（首次约 1~3 秒/作业）。\n' +
          '如果弹出「人机验证」，请手动完成，脚本会自动继续。\n' +
          '期间请不要操作页面，每题约需 1~2 秒。\n\n' +
          preview + (list.length > 8 ? '\n…' : '') + '\n\n确认开始？'
        );
        if (!ok) return;

        batch.textContent = '准备中…';
        var busy = toast('批量导出中，请勿操作页面…', true, 0);
        try {
          var groups = await batchExportYuketang(function (i, total, msg) {
            if (i) {
              batch.textContent = i + '/' + total + ' 处理中…';
              busy.textContent = '批量导出中（' + i + '/' + total + '）\n' + msg;
            } else if (msg) {
              // 纯文字提示（等待人机验证 / 等待手动确认…）：不动计数器，只换正文
              busy.textContent = '批量导出中…\n' + msg;
            }
          });
          var total = groups.reduce(function (n, g) { return n + g.questions.length; }, 0);
          var file = download(
            buildGroupedMarkdown(groups, { title: '未完成作业题目导出 · 雨课堂' }),
            '作业题目_雨课堂_' + fileStamp() + '.md'
          );
          busy.remove();
          var failChapters = groups.filter(function (g) { return g.note && g.note.indexOf('⚠') === 0; }).length;
          toast(
            '已导出 ' + groups.length + ' 个作业 / 共 ' + total + ' 题\n' + file +
            (failChapters ? '\n⚠ 有 ' + failChapters + ' 个作业解密失败，文字可能是乱码' : ''),
            !failChapters, failChapters ? 12000 : 6000
          );
        } catch (err) {
          busy.remove();
          toast('批量导出失败：' + (err && err.message ? err.message : err), false, 8000);
        }
        batch.textContent = '批量导出未完成作业';
      });
      document.body.appendChild(batch);
    }
  }

  // 调试出口：控制台可用 __courseExport.diagnose() / testDecrypt() / scanAll() / listYuketangTasks()
  window.__courseExport = {
    CONFIG: CONFIG,
    PROFILES: PROFILES,
    collectDocuments: collectDocuments,
    extractWithProfile: extractWithProfile,
    pickBestProfile: pickBestProfile,
    scanAll: scanAll,
    scanAllDecrypted: scanAllDecrypted,
    buildMarkdown: buildMarkdown,
    buildGroupedMarkdown: buildGroupedMarkdown,
    listYuketangTasks: listYuketangTasks,
    tourYuketangExercise: tourYuketangExercise,
    batchExportYuketang: batchExportYuketang,
    diagnose: diagnose,
    // 字体解密
    encryptedEls: encryptedEls,
    listFontFaces: listFontFaces,
    findFontUrls: findFontUrls,
    findExamFontUrl: findExamFontUrl,
    loadRefTable: loadRefTable,
    crackFont: crackFont,
    crackChar: crackChar,
    decryptText: decryptText,
    ensureDecrypt: ensureDecrypt,
    prepareDecrypt: prepareDecrypt,
    testDecrypt: testDecrypt,
    FONT_CACHE: FONT_CACHE,
    DECRYPT_WARNINGS: DECRYPT_WARNINGS,
    SYNTH_COUNT: SYNTH_COUNT,
    buildAiPrompt: aiPromptSection,
    // 抽取细节（回归测试用）
    pickTitleEls: pickTitleEls,
    pickOptionEls: pickOptionEls,
    normalizeOptionText: normalizeOptionText,
    dedupeLines: dedupeLines
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
