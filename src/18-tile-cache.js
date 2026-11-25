/* ==========================================================================
   18 · 底图瓦片缓存（IndexedDB）
   —— 让底图第一次加载后落到本地，之后的刷新/重开直接从本地取，
      不再"每次地图都重新加载"。
      没有 IndexedDB（或隐私模式）时自动退化为内存缓存，功能不受影响。
   ========================================================================== */

var TileCache = {
  dbName: 'metroChronicle.tiles.v1',
  store: 'tiles',
  db: null,
  opening: null,
  enabled: null,          // null=未探测
  mem: {},                // url → objectURL（同一会话内直接命中）
  stats: { hit: 0, miss: 0, put: 0, fail: 0, memHit: 0 },

  available: function () {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  },

  open: function () {
    var self = this;
    if (this.opening) return this.opening;
    if (!this.available()) { this.enabled = false; return Promise.resolve(null); }

    this.opening = new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(self.dbName, 1);
      } catch (err) {
        self.enabled = false;
        resolve(null);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(self.store)) db.createObjectStore(self.store);
      };
      req.onsuccess = function () {
        self.db = req.result;
        self.enabled = true;
        resolve(self.db);
      };
      req.onerror = function () {
        self.enabled = false;
        self.stats.fail += 1;
        resolve(null);
      };
      req.onblocked = function () { resolve(null); };
    });
    return this.opening;
  },

  /** 读缓存：命中时返回可直接赋给 img.src 的 objectURL */
  get: function (url) {
    var self = this;
    if (this.mem[url]) {
      this.stats.memHit += 1;
      this.stats.hit += 1;
      return Promise.resolve(this.mem[url]);
    }
    if (!this.enabled || !this.db) {
      this.stats.miss += 1;
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      var tx;
      try {
        tx = self.db.transaction(self.store, 'readonly');
      } catch (err) {
        self.stats.miss += 1;
        resolve(null);
        return;
      }
      var req = tx.objectStore(self.store).get(url);
      req.onsuccess = function () {
        var entry = req.result;
        if (!entry || !entry.blob) {
          self.stats.miss += 1;
          resolve(null);
          return;
        }
        var objectUrl = URL.createObjectURL(entry.blob);
        self.mem[url] = objectUrl;
        self.stats.hit += 1;
        resolve(objectUrl);
      };
      req.onerror = function () {
        self.stats.miss += 1;
        resolve(null);
      };
    });
  },

  /** 联网取瓦片并写入缓存；失败返回 null（调用方回退为直接用原始 URL） */
  load: function (url) {
    var self = this;
    return fetch(url, { mode: 'cors', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('tile status ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);
        self.mem[url] = objectUrl;
        self.write(url, blob);
        return objectUrl;
      })
      .catch(function () {
        self.stats.fail += 1;
        return null;
      });
  },

  write: function (url, blob) {
    var self = this;
    if (!this.enabled || !this.db) return;
    try {
      var tx = this.db.transaction(this.store, 'readwrite');
      tx.objectStore(this.store).put({ blob: blob, at: Date.now() }, url);
      self.stats.put += 1;
    } catch (err) { /* 写失败不影响显示 */ }
  },

  drop: function (url) {
    if (this.mem[url]) delete this.mem[url];
    if (!this.enabled || !this.db) return;
    try {
      this.db.transaction(this.store, 'readwrite').objectStore(this.store).delete(url);
    } catch (err) { /* noop */ }
  },

  /** 清空全部缓存（设置面板里的"清理底图缓存"用） */
  clear: function () {
    var self = this;
    Object.keys(this.mem).forEach(function (url) { URL.revokeObjectURL(self.mem[url]); });
    this.mem = {};
    this.stats = { hit: 0, miss: 0, put: 0, fail: 0, memHit: 0 };
    if (!this.enabled || !this.db) return Promise.resolve(false);
    return new Promise(function (resolve) {
      try {
        var tx = self.db.transaction(self.store, 'readwrite');
        var req = tx.objectStore(self.store).clear();
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { resolve(false); };
      } catch (err) { resolve(false); }
    });
  },

  summary: function () {
    return {
      enabled: this.enabled !== false,
      backend: this.enabled ? 'indexeddb' : 'memory',
      entriesInSession: Object.keys(this.mem).length,
      hit: this.stats.hit,
      miss: this.stats.miss,
      put: this.stats.put,
      fail: this.stats.fail
    };
  }
};

TileCache.open();

/**
 * 带本地缓存的瓦片图层：优先用缓存里的瓦片，没有再联网并回写缓存。
 * 与 L.tileLayer 用法完全一致。
 */
function createCachedTileLayer(url, options) {
  var Layer = L.TileLayer.extend({
    createTile: function (coords, done) {
      var tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      if (this.options.crossOrigin || this.options.crossOrigin === '') {
        tile.crossOrigin = true;
      }
      var original = this.getTileUrl(coords);
      var settled = false;

      var finish = function (src) {
        if (settled) return;
        settled = true;
        tile.onload = function () { done(null, tile); };
        tile.onerror = function () {
          if (src !== original) {          // 缓存图坏了：删掉，退回原始地址
            TileCache.drop(original);
            tile.onerror = null;
            tile.src = original;
            return;
          }
          done(new Error('tile error'), tile);
        };
        tile.src = src;
      };

      TileCache.get(original).then(function (cached) {
        if (cached) { finish(cached); return; }
        TileCache.load(original).then(function (fresh) {
          finish(fresh || original);
        });
      });

      return tile;
    }
  });
  return new Layer(url, options);
}
