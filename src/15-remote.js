/* ==========================================================================
   15 · 可选后端（本地优先 + 服务端同步）
   - file:// 双击打开：完全离线，方案存在 localStorage
   - 由 server/server.mjs 下发（http）：启动时从 /api/plans 拉取，
     之后每次保存都写穿到服务端；服务端不可用时自动退回纯本地模式
   ========================================================================== */

var RemoteStore = {
  enabled: false,
  status: 'local',          // 'local' | 'server' | 'offline'
  base: '/api',
  lastError: '',
  queueTimer: 0,
  pending: {},

  /** 带超时的 JSON 请求：失败返回 null，绝不抛错、不打印 console */
  request: function (method, path, body, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, timeoutMs || 1500);
    var options = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (controller) options.signal = controller.signal;
    if (body !== undefined) options.body = JSON.stringify(body);
    return fetch(RemoteStore.base + path, options).then(function (response) {
      window.clearTimeout(timer);
      if (response.status === 204) return { ok: true };
      if (!response.ok) return null;
      return response.json();
    }).catch(function (err) {
      window.clearTimeout(timer);
      RemoteStore.lastError = String(err && err.message ? err.message : err);
      return null;
    });
  },

  /**
   * 启动同步：探测服务端 → 合并方案与自定义城市。
   * 本地优先：只有本地缺该城市方案时才采纳服务端版本，避免覆盖离线编辑。
   */
  boot: function () {
    if (!/^https?:$/.test(window.location.protocol)) return Promise.resolve('local');
    var self = this;
    return this.request('GET', '/health', undefined, 1400).then(function (health) {
      if (!health || health.ok !== true) return 'local';
      self.enabled = true;
      self.status = 'server';
      return self.syncPlans().then(function () { return self.syncCities(); }).then(function () {
        return 'server';
      });
    }).then(function (mode) {
      if (mode !== 'server') self.status = 'local';
      return mode;
    }, function () {
      self.status = 'local';
      return 'local';
    });
  },

  syncPlans: function () {
    var self = this;
    return this.request('GET', '/plans', undefined, 1800).then(function (list) {
      if (!list || !Array.isArray(list.cities) || !list.cities.length) return true;
      var jobs = list.cities.slice(0, 24).map(function (cityId) {
        return self.request('GET', '/plans?city=' + encodeURIComponent(cityId), undefined, 1800).then(function (payload) {
          if (!payload || !payload.plan) return false;
          if (storage.get(STORE.plan(cityId))) return false;         // 本地已有 → 保持本地
          if (!isValidStoredPlan(payload.plan, cityId)) return false;
          storage.setJSON(STORE.plan(cityId), payload.plan);
          return true;
        });
      });
      return Promise.all(jobs).then(function () { return true; });
    });
  },

  syncCities: function () {
    var self = this;
    return this.request('GET', '/cities', undefined, 1500).then(function (payload) {
      if (!payload || !Array.isArray(payload.cities)) return true;
      var local = loadCustomCities();
      var byId = {};
      local.forEach(function (city) { byId[city.id] = city; });
      payload.cities.forEach(function (city) {
        if (!city || typeof city.id !== 'string' || !city.id) return;
        if (findPreset(city.id)) return;
        if (!byId[city.id]) byId[city.id] = city;
      });
      var merged = Object.keys(byId).map(function (id) { return byId[id]; });
      storage.setJSON(STORE.cities, merged);
      return true;
    });
  },

  /** 切换城市时补拉一次该城市方案（仅当本地没有时才采纳服务端版本） */
  pullCity: function (cityId) {
    if (!this.enabled || !cityId) return Promise.resolve(false);
    return this.request('GET', '/plans?city=' + encodeURIComponent(cityId), undefined, 1600).then(function (payload) {
      if (!payload || !payload.plan) return false;
      if (storage.get(STORE.plan(cityId))) return false;
      if (!isValidStoredPlan(payload.plan, cityId)) return false;
      storage.setJSON(STORE.plan(cityId), payload.plan);
      return true;
    });
  },

  /** 写穿：把方案推到服务端（400ms 内多次保存只发一次） */
  pushPlan: function (plan) {
    if (!this.enabled || !plan || !plan.cityId) return;
    this.pending[plan.cityId] = { cityId: plan.cityId, plan: JSON.parse(JSON.stringify(plan)) };
    this.scheduleFlush();
  },

  removePlan: function (cityId) {
    if (!this.enabled) return;
    delete this.pending[cityId];
    this.request('DELETE', '/plans?city=' + encodeURIComponent(cityId), undefined, 1600);
  },

  pushCities: function (list) {
    if (!this.enabled) return;
    this.request('PUT', '/cities', list, 1600);
  },

  scheduleFlush: function () {
    var self = this;
    window.clearTimeout(this.queueTimer);
    this.queueTimer = window.setTimeout(function () { self.flush(); }, 400);
  },

  flush: function () {
    if (!this.enabled) return;
    var self = this;
    Object.keys(this.pending).forEach(function (cityId) {
      var job = self.pending[cityId];
      delete self.pending[cityId];
      self.request('PUT', '/plans?city=' + encodeURIComponent(cityId), job.plan, 2200).then(function (res) {
        if (!res) self.status = 'offline';
        else if (self.status === 'offline') self.status = 'server';
      });
    });
  },

  label: function () {
    if (!this.enabled) return '本地浏览器（localStorage）';
    if (this.status === 'offline') return '服务端（暂时不可达，已本地缓存）';
    return '服务端（已连接 /api/plans）';
  }
};

/* 页面隐藏前把未落盘的改动推上去 */
window.addEventListener('pagehide', function () {
  if (RemoteStore.enabled && Object.keys(RemoteStore.pending).length) RemoteStore.flush();
});
