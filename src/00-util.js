/* ==========================================================================
   00 · 通用工具（转义 / 存储 / 提示 / 小函数）
   ========================================================================== */

var HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 站名等用户可控文本进入 DOM 前必须转义，防止 XSS / 破版 */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return HTML_ESCAPE_MAP[ch];
  });
}

function $(selector, root) {
  return (root || document).querySelector(selector);
}

function $all(selector, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(selector));
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

/** 合法经纬度判断：用于外部（localStorage / 用户输入）数据的校验 */
function isValidLatLng(lat, lng) {
  return isFiniteNumber(lat) && isFiniteNumber(lng) &&
    lat >= -85 && lat <= 85 && lng >= -180 && lng <= 180;
}

function roundTo(value, digits) {
  var factor = Math.pow(10, digits || 0);
  return Math.round(value * factor) / factor;
}

/** 存储包装：隐私模式 / file:// 下 localStorage 可能直接抛错，这里全部吞掉 */
var storage = {
  get: function (key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  },
  set: function (key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; }
  },
  remove: function (key) {
    try { window.localStorage.removeItem(key); return true; } catch (err) { return false; }
  },
  getJSON: function (key) {
    var raw = storage.get(key);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed == null ? null : parsed;
    } catch (err) {
      return null;
    }
  },
  setJSON: function (key, value) {
    try { return storage.set(key, JSON.stringify(value)); } catch (err) { return false; }
  }
};

/* ---------------------------------------------------------------- 轻提示 */

var toastState = { timer: 0, el: null };

/** 底部居中的轻提示（不阻塞、不打断动画） */
function toast(message, duration) {
  var el = toastState.el || $('#toast');
  if (!el) return;
  toastState.el = el;
  el.textContent = String(message == null ? '' : message);
  el.classList.add('is-on');
  window.clearTimeout(toastState.timer);
  toastState.timer = window.setTimeout(function () {
    el.classList.remove('is-on');
  }, duration || 2200);
}

/* ------------------------------------------------------------ 动画辅助 */

/** 安全地销毁 GSAP tween，避免场景重建后透明度/位移残留 */
function killTweens(target) {
  if (!target || !window.gsap) return;
  try { gsap.killTweensOf(target); } catch (err) { /* noop */ }
}

function killTimeline(timeline) {
  if (!timeline) return;
  try {
    timeline.kill();
  } catch (err) { /* noop */ }
}

/** 轻微节流的 resize 派发，避免地图尺寸抖动 */
function debounce(fn, wait) {
  var timer = 0;
  return function () {
    var args = arguments;
    var self = this;
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { fn.apply(self, args); }, wait);
  };
}

/** 一次性脚本加载（带超时，失败不抛错、不阻塞主流程） */
function loadScriptOnce(src, timeoutMs) {
  return new Promise(function (resolve) {
    if (!src) { resolve(false); return; }
    var settled = false;
    var script = document.createElement('script');
    var timer = window.setTimeout(function () { finish(false); }, timeoutMs || 3000);

    function finish(ok) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      // 超时也不移除节点：中断下载会在 console 留下 net::ERR_ABORTED；
      // 让它自然下载完，后续可见性由调用方判断。
      resolve(ok);
    }

    script.async = true;
    script.src = src;
    script.onload = function () { finish(true); };
    script.onerror = function () { finish(false); };
    document.head.appendChild(script);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
}

/** 数字滚动：视觉上更像“数据在更新”，同时保持克制 */
function tweenTextNumber(el, from, to) {
  if (!el) return;
  if (!window.gsap || from === to) {
    el.textContent = String(to);
    return;
  }
  var proxy = { value: from };
  killTweens(proxy);
  el.textContent = String(from);
  gsap.to(proxy, {
    value: to,
    duration: 0.65,
    ease: 'power2.out',
    onUpdate: function () { el.textContent = String(Math.round(proxy.value)); }
  });
}
