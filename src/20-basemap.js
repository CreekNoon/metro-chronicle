/* ==========================================================================
   20 · 地图源（三级底图策略）
   —— 时序设计（对应验收：4s 先铺栅格、6s 必须开场）
      t=0    铺 Esri 灰度栅格（最稳的兜底，保证首屏一定有底图）
      t≤2.2s 若有高德 Key：轻量校验 → 通过则切高德瓦片（GCJ-02 投影）
      后台    尝试 OpenFreeMap Positron 矢量（MapLibre 运行时异步加载）
              成功则淡入矢量层；栅格保留在矢量层之下，因此矢量出问题也不会白屏
   —— 任何一层失败都静默降级，绝不阻塞开场与动画
   ========================================================================== */

var BASEMAP_SOURCES = {
  esriBase: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  esriReference: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  amapTiles: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  amapProbe: 'https://restapi.amap.com/v3/ip',
  openFreeMapStyle: 'https://tiles.openfreemap.org/styles/positron',
  maplibreScript: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
};

var BASEMAP_LABELS = {
  amap: '高德地图',
  vector: 'OpenFreeMap 矢量',
  raster: 'Esri 灰度栅格',
  blank: '本地浅灰底图'
};

var BASEMAP_ATTRIBUTION = {
  amap: '底图 © 高德地图（AMap）',
  vector: '底图 © OpenFreeMap · OpenStreetMap contributors',
  raster: '底图 © Esri · World Light Gray Canvas',
  blank: '底图：本地浅灰画布（离线）'
};

var AMAP_KEY_PROBE_TIMEOUT = 2200;      // 高德 Key 校验超时
var VECTOR_SCRIPT_TIMEOUT = 6000;       // MapLibre 运行时异步加载超时（后台进行，不阻塞开场；超时只记日志，不 abort）

/** 读取高德 Key：页面内保存值优先（空串表示用户主动清除），其次是顶部常量注入点 */
function getStoredAmapKey() {
  var stored = storage.get(STORE.amapKey);
  if (stored != null) return String(stored).trim();
  return typeof AMAP_KEY === 'string' ? AMAP_KEY.trim() : '';
}

function setStoredAmapKey(key) {
  storage.set(STORE.amapKey, String(key == null ? '' : key).trim());
}

/* ------------------------------------------------- 高德 Key 轻量校验 */

/**
 * 用高德 Web 服务接口做一次极轻量的 Key 校验（JSONP，不加载 SDK）。
 * 返回 'valid' | 'invalid' | 'unknown'：
 * - status=1 或 infocode=10009（平台不匹配，Key 本身存在）→ valid
 * - 明确的错误码（INVALID_USER_KEY 等）→ invalid，调用方据此回退默认底图
 * - 断网 / 超时 / 脚本失败 → unknown（无法判断，保留高德瓦片，不误伤配置）
 */
function probeAmapKey(key) {
  return new Promise(function (resolve) {
    if (!/^[0-9a-fA-F]{32}$/.test(key)) { resolve('invalid'); return; }
    var callbackName = '__amapKeyProbe' + Math.random().toString(36).slice(2);
    var script = document.createElement('script');
    var settled = false;
    var timer = window.setTimeout(function () { finish('unknown'); }, AMAP_KEY_PROBE_TIMEOUT);

    function finish(result) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { delete window[callbackName]; } catch (err) { window[callbackName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(result);
    }

    window[callbackName] = function (payload) {
      if (!payload) { finish('unknown'); return; }
      var status = String(payload.status);
      var infocode = String(payload.infocode);
      if (status === '1' || infocode === '10000' || infocode === '10009') { finish('valid'); return; }
      finish('invalid');
    };

    script.onerror = function () { finish('unknown'); };
    script.async = true;
    script.src = BASEMAP_SOURCES.amapProbe + '?key=' + encodeURIComponent(key) + '&callback=' + callbackName;
    document.head.appendChild(script);
  });
}

/* --------------------------------------------------------- 底图控制器 */

var Basemap = {
  map: null,
  mode: 'blank',
  datum: 'wgs84',
  attribution: BASEMAP_ATTRIBUTION.blank,
  rasterLayers: [],
  vectorEl: null,
  vectorMap: null,
  vectorReady: false,
  vectorAttempted: false,
  maplibrePromise: null,
  datumLocked: false,
  syncQueued: false,
  listenersBound: false,
  onChange: null,

  /** 首次初始化：铺栅格 → （可选）高德校验 → 后台尝试矢量 */
  init: function (map) {
    var self = this;
    this.map = map;
    this.bindMapListeners();

    // 网络恢复后补一次底图（断网时用的是本地浅灰画布）
    window.addEventListener('online', function () {
      if (self.mode !== 'blank') return;
      self.vectorAttempted = false;
      self.maplibrePromise = null;
      var key = getStoredAmapKey();
      if (key) { self.showAmap(); self.validateKeyInBackground(key); return; }
      self.showRaster();
      self.attemptVectorInBackground();
    });

    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    // 有高德 Key：高德为默认底图。高德瓦片接口本身不校验 Key，
    // 因此立即铺图（首屏更快），Key 是否可用只在后台校验、仅用于状态提示。
    if (!offline && getStoredAmapKey()) {
      this.showAmap();
      this.validateKeyInBackground(getStoredAmapKey());
      return Promise.resolve(this.mode);
    }

    this.showRaster();
    if (!offline) this.attemptVectorInBackground();
    return Promise.resolve(this.mode);
  },

  /**
   * 后台校验高德 Key：
   * - valid / unknown：保留高德底图
   * - invalid：Key 明确无效 → 静默回退到「矢量 → 栅格」默认链路
   */
  validateKeyInBackground: function (key) {
    var self = this;
    this.keyStatus = 'checking';
    probeAmapKey(key).then(function (result) {
      self.keyStatus = result;
      if (result === 'invalid' && self.mode === 'amap') self.fallbackFromAmap();
      if (typeof self.onChange === 'function') self.onChange(self);
    }, function () {
      self.keyStatus = 'unknown';
    });
  },

  /** Key 无效时的静默回退（不弹窗、不阻塞播放） */
  fallbackFromAmap: function () {
    this.destroyVector();
    this.removeRaster();
    this.vectorAttempted = false;
    this.maplibrePromise = null;
    this.showRaster();
    if (typeof navigator === 'undefined' || navigator.onLine !== false) this.attemptVectorInBackground();
  },

  /* ------------------------------------------------------------ 栅格 */

  /** 铺（或恢复）Esri 灰度栅格：始终作为兜底层 */
  showRaster: function () {
    if (!this.map) return;
    // 断网时不发起必然失败的瓦片请求：直接用本地浅灰画布，
    // 既不会白屏，也不会在 console 留下资源加载错误。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setMode('blank', 'wgs84');
      return;
    }
    if (this.rasterLayers.length) {
      if (this.mode !== 'amap') this.setModeForRaster();
      return;
    }
    var base = L.tileLayer(BASEMAP_SOURCES.esriBase, {
      maxZoom: 19,
      maxNativeZoom: 16,
      crossOrigin: true,
      pane: 'tilePane'
    });
    var reference = L.tileLayer(BASEMAP_SOURCES.esriReference, {
      maxZoom: 19,
      maxNativeZoom: 16,
      crossOrigin: true,
      pane: 'tilePane'
    });
    base.addTo(this.map);
    reference.addTo(this.map);
    this.rasterLayers = [base, reference];
    this.setModeForRaster();
  },

  setModeForRaster: function () {
    this.setMode(this.vectorReady ? 'vector' : 'raster', 'wgs84');
  },

  /** 完全移除栅格（仅高德模式使用） */
  removeRaster: function () {
    var map = this.map;
    this.rasterLayers.forEach(function (layer) {
      try { map.removeLayer(layer); } catch (err) { /* noop */ }
    });
    this.rasterLayers = [];
  },

  /* ------------------------------------------------------------ 高德 */

  showAmap: function () {
    if (!this.map) return;
    this.destroyVector();
    this.removeRaster();

    var layer = L.tileLayer(BASEMAP_SOURCES.amapTiles, {
      subdomains: '1234',
      maxZoom: 19,
      maxNativeZoom: 18,
      className: 'basemap-amap',
      crossOrigin: true,
      pane: 'tilePane'
    });
    layer.addTo(this.map);
    this.amapLayer = layer;

    // 高德瓦片为 GCJ-02，渲染坐标需要投影（编辑与持久化仍用 WGS84）
    this.setMode('amap', 'gcj02');
  },

  /* -------------------------------------------------- OpenFreeMap 矢量 */

  loadMaplibre: function () {
    if (this.maplibrePromise) return this.maplibrePromise;
    if (window.maplibregl) {
      this.maplibrePromise = Promise.resolve(true);
      return this.maplibrePromise;
    }
    this.maplibrePromise = loadScriptOnce(BASEMAP_SOURCES.maplibreScript, VECTOR_SCRIPT_TIMEOUT).then(function (ok) {
      var ready = !!(ok && window.maplibregl);
      if (ready) window.__maplibreglReady = true;
      return ready;
    });
    return this.maplibrePromise;
  },

  /**
   * 后台升级到矢量底图：不阻塞开场，
   * 成功后淡入矢图层（栅格仍在下层，因此不会白屏）。
   * 注意：加载慢时不销毁实例、不 abort 请求（否则 console 会出现 AbortError），
   * 只是暂时保持隐藏，等它自己加载完再淡入。
   */
  attemptVectorInBackground: function () {
    if (this.vectorAttempted) return;
    this.vectorAttempted = true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;   // 离线不做无意义请求
    var self = this;
    this.loadMaplibre().then(function (loaded) {
      if (!loaded || self.mode === 'amap' || self.vectorReady || self.vectorMap) return false;
      return self.createVector();
    }).then(null, function () { /* 静默降级 */ });
  },

  createVector: function () {
    var self = this;
    if (!window.maplibregl || !this.map) return Promise.resolve(false);

    var container = document.createElement('div');
    container.className = 'basemap-vector';
    var host = this.map.getContainer();
    host.insertBefore(container, host.firstChild);
    this.vectorEl = container;

    var center = this.map.getCenter();
    var instance = null;
    try {
      instance = new window.maplibregl.Map({
        container: container,
        style: BASEMAP_SOURCES.openFreeMapStyle,
        center: [center.lng, center.lat],
        zoom: this.map.getZoom() - 1,
        interactive: false,
        attributionControl: false,
        validateStyle: false,
        fadeDuration: 0,
        refreshExpiredTiles: false,
        dragRotate: false,
        pitchWithRotate: false
      });
    } catch (err) {
      this.vectorEl = null;
      if (container.parentNode) container.parentNode.removeChild(container);
      return Promise.resolve(false);
    }

    this.vectorMap = instance;

    return new Promise(function (resolve) {
      var settled = false;

      function finish(ok) {
        if (settled) return;
        settled = true;
        if (instance.off) {
          try { instance.off('load', onLoad); instance.off('error', onError); } catch (err) { /* noop */ }
        }
        if (ok && self.mode !== 'amap') {
          self.onVectorReady();
          resolve(true);
        } else if (ok) {
          resolve(false);
        } else {
          self.destroyVector();
          resolve(false);
        }
      }

      function onLoad() { finish(true); }
      function onError(event) {
        // 只有“样式都取不到”才判失败，瓦片级别的偶发错误直接忽略
        var message = event && event.error ? String(event.error.message || '') : '';
        if (/style|fetch|network|404|abort/i.test(message)) finish(false);
      }

      instance.on('load', onLoad);
      instance.on('error', onError);
    });
  },

  keyStatus: 'unknown',
  onVectorReady: function () {
    this.vectorReady = true;
    // 矢量层位于 Leaflet 容器最底层（z-index 0），而栅格瓦片在地图面板内，
    // 层叠顺序更高，必须移除栅格，否则看到的仍是栅格底图。
    this.removeRaster();
    if (this.vectorEl) this.vectorEl.classList.add('is-on');
    this.setMode('vector', 'wgs84');
    this.syncVector(true);
    this.watchVectorHealth();
  },

  /** 矢量瓦片若持续报错，自动回退到 Esri 栅格，避免只剩浅灰画布 */
  watchVectorHealth: function () {
    var self = this;
    if (!this.vectorMap) return;
    var errors = 0;
    try {
      this.vectorMap.on('error', function () {
        errors += 1;
        if (errors < 6 || self.mode !== 'vector') return;
        self.vectorAttempted = true;
        self.destroyVector();
        self.showRaster();
        self.setMode('raster', 'wgs84');
      });
    } catch (err) { /* noop */ }
  },

  destroyVector: function () {
    this.vectorReady = false;
    if (this.vectorMap) {
      try { this.vectorMap.remove(); } catch (err) { /* noop */ }
      this.vectorMap = null;
    }
    if (this.vectorEl && this.vectorEl.parentNode) {
      this.vectorEl.parentNode.removeChild(this.vectorEl);
    }
    this.vectorEl = null;
  },

  /** Leaflet 视野 → MapLibre（缩进一级：512px 瓦片 vs 256px 瓦片） */
  syncVector: function (immediate) {
    var self = this;
    if (immediate) {
      this.flushVectorSync();
      return;
    }
    if (this.syncQueued) return;
    this.syncQueued = true;
    window.requestAnimationFrame(function () {
      self.syncQueued = false;
      self.flushVectorSync();
    });
  },

  flushVectorSync: function () {
    if (!this.vectorReady || !this.vectorMap || !this.map) return;
    try {
      var center = this.map.getCenter();
      this.vectorMap.jumpTo({
        center: [center.lng, center.lat],
        zoom: this.map.getZoom() - 1,
        bearing: 0,
        pitch: 0
      });
    } catch (err) { /* noop */ }
  },

  bindMapListeners: function () {
    if (this.listenersBound || !this.map) return;
    this.listenersBound = true;
    var self = this;
    this.map.on('move zoom viewreset', function () { self.syncVector(false); });
    this.map.on('resize', function () {
      self.syncVector(false);
      if (self.vectorMap && self.vectorMap.resize) {
        try { self.vectorMap.resize(); } catch (err) { /* noop */ }
      }
    });
  },

  /* -------------------------------------------------------- 状态工具 */

  setMode: function (mode, datum) {
    var changed = this.mode !== mode;
    this.mode = mode;
    this.datum = datum;
    this.attribution = BASEMAP_ATTRIBUTION[mode] || BASEMAP_ATTRIBUTION.blank;
    var host = this.map && this.map.getContainer();
    if (host) {
      host.classList.toggle('basemap-amap', mode === 'amap');
      host.classList.toggle('basemap-vector', mode === 'vector');
      host.classList.toggle('basemap-raster', mode === 'raster');
    }
    if (changed && typeof this.onChange === 'function') this.onChange(this);
  },

  /** 渲染坐标：仅高德模式需要 WGS84 → GCJ-02 */
  project: function (lat, lng) {
    return this.datum === 'gcj02' ? wgs84ToGcj02(lat, lng) : [lat, lng];
  },

  /** 反投影：编辑时把地图上的点还原成 WGS84 再存储 */
  unproject: function (lat, lng) {
    return this.datum === 'gcj02' ? gcj02ToWgs84(lat, lng) : [lat, lng];
  },

  isGcj: function () { return this.datum === 'gcj02'; },

  label: function () { return BASEMAP_LABELS[this.mode] || BASEMAP_LABELS.blank; },

  /** 重新决策底图（设置面板保存 / 清除 Key 后调用） */
  restart: function () {
    this.datumLocked = false;
    this.vectorAttempted = false;
    this.maplibrePromise = null;
    this.destroyVector();
    this.removeRaster();
    var self = this;
    var key = getStoredAmapKey();
    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    if (!offline && key) {
      this.showAmap();
      this.validateKeyInBackground(key);
      return Promise.resolve(this.mode);
    }
    this.showRaster();
    if (!offline) this.attemptVectorInBackground();
    return Promise.resolve(this.mode);
  }
};
