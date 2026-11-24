/* ==========================================================================
   70 · 城市切换 / 线路多选 / 缩放控件 / 地图源设置（高德 Key）
   ========================================================================== */

/* ------------------------------------------------------- 线路显示选择 */

var LineSelection = {
  selected: {},

  /** 载入某城市的选择状态（默认全选） */
  sync: function (plan) {
    this.selected = plan ? loadLineSelection(plan.cityId, plan) : {};
    return this.selected;
  },

  isSelected: function (key) {
    return this.selected[key] !== false;
  },

  indices: function () {
    var plan = App.plan;
    if (!plan) return [];
    return plan.lines.map(function (line, index) { return index; }).filter(function (index) {
      return LineSelection.isSelected(plan.lines[index].key);
    });
  },

  count: function () {
    return this.indices().length;
  },

  /** 勾选/取消一条线路：至少保留一条 */
  toggle: function (key) {
    var plan = App.plan;
    if (!plan) return false;
    var next = this.selected[key] === false;
    if (!next && this.count() <= 1) {
      toast('至少保留一条线路参与播放');
      return false;
    }
    this.selected[key] = next;
    this.persist();
    return true;
  },

  setAll: function (value) {
    var plan = App.plan;
    if (!plan) return;
    var self = this;
    plan.lines.forEach(function (line) { self.selected[line.key] = !!value; });
    this.persist();
  },

  persist: function () {
    if (App.plan) saveLineSelection(App.plan.cityId, this.selected);
  }
};

var LineUI = {
  render: function () {
    var body = $('#linePanelBody');
    var countEl = $('#lineSelectCount');
    var plan = App.plan;
    if (countEl) countEl.textContent = String(plan ? LineSelection.count() + '/' + plan.lines.length : '0');
    if (!body || !plan) return;

    body.innerHTML = plan.lines.map(function (line, index) {
      var checked = LineSelection.isSelected(line.key);
      var rail = (line.type || 'metro') === 'intercity';
      var stationCount = line.stations.length;
      var disabled = !checked && LineSelection.count() <= 1;
      return '' +
        '<label class="line-row' + (checked ? ' is-on' : '') + (disabled ? ' is-disabled' : '') + '" data-line-key="' + escapeHtml(line.key) + '">' +
          '<input type="checkbox"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + ' data-act="toggle-line" data-key="' + escapeHtml(line.key) + '" />' +
          '<i class="' + (rail ? 'is-rail' : '') + '" style="--line-color:' + escapeHtml(line.color) + '"></i>' +
          '<span class="line-row-name">' + escapeHtml(line.name) + '</span>' +
          (rail ? '<span class="line-row-tag">城际</span>' : '') +
          '<span class="line-row-meta">' + stationCount + ' 站</span>' +
        '</label>';
    }).join('');
  },

  /** 勾选变化：重建场景并重新播放 */
  applyChange: function () {
    this.render();
    var plan = App.plan;
    if (!plan) return;
    if (Edit.active) {
      Edit.rebuild();
      return;
    }
    Story.play();
    toast('已选择 ' + LineSelection.count() + ' 条线路参与播放');
  },

  bind: function () {
    var self = this;
    var body = $('#linePanelBody');
    if (body) {
      body.addEventListener('change', function (event) {
        var input = event.target;
        if (!input || !input.dataset || input.dataset.act !== 'toggle-line') return;
        if (LineSelection.toggle(input.dataset.key)) self.applyChange();
        else self.render();
      });
    }
    var all = $('#lineSelectAll');
    if (all) {
      all.addEventListener('click', function () {
        LineSelection.setAll(true);
        self.applyChange();
      });
    }
    var none = $('#lineSelectNone');
    if (none) {
      none.addEventListener('click', function () {
        var plan = App.plan;
        if (!plan || !plan.lines.length) return;
        LineSelection.setAll(false);
        // 至少保留第一条
        LineSelection.selected[plan.lines[0].key] = true;
        LineSelection.persist();
        self.applyChange();
      });
    }
    var btn = $('#lineSelectBtn');
    var panel = $('#linePanel');
    if (btn && panel) {
      btn.addEventListener('click', function (event) {
        event.stopPropagation();
        self.render();
        panel.classList.toggle('is-on');
        btn.setAttribute('aria-expanded', panel.classList.contains('is-on') ? 'true' : 'false');
      });
    }
    document.addEventListener('click', function (event) {
      if (!panel || !panel.classList.contains('is-on')) return;
      var target = event.target;
      if (panel.contains(target) || (btn && btn.contains(target))) return;
      panel.classList.remove('is-on');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }
};

/* ---------------------------------------------------------- 缩放控件 */

var ZoomUI = {
  relayoutTimer: 0,
  scaleQueued: false,

  bind: function () {
    var zoomIn = $('#zoomIn');
    var zoomOut = $('#zoomOut');
    var zoomFit = $('#zoomFit');
    if (zoomIn) zoomIn.addEventListener('click', function () { ZoomUI.step(1); });
    if (zoomOut) zoomOut.addEventListener('click', function () { ZoomUI.step(-1); });
    if (zoomFit) zoomFit.addEventListener('click', function () { ZoomUI.fit(); });
    // 视野变化后只做「节流 + 去抖」的标签重排：
    // 镜头叙事期间每次 setView 都会触发 moveend，逐帧重排会让站名闪烁
    if (App.map) {
      App.map.on('moveend zoomend', function () { ZoomUI.scheduleRelayout(); });
      App.map.on('move zoom', function () { ZoomUI.scheduleScale(); });
    }
    this.syncScale();
  },

  /** 节流：标签避让（播放中交给 Story 收尾统一处理） */
  scheduleRelayout: function () {
    var self = this;
    if (typeof Story !== 'undefined' && Story.playing && typeof Camera !== 'undefined' && Camera.active) return;
    window.clearTimeout(this.relayoutTimer);
    this.relayoutTimer = window.setTimeout(function () { self.relayoutLabels(); }, 200);
  },

  /** 节流：比例尺提示（每帧只算一次） */
  scheduleScale: function () {
    if (this.scaleQueued) return;
    this.scaleQueued = true;
    var self = this;
    window.requestAnimationFrame(function () {
      self.scaleQueued = false;
      self.syncScale();
    });
  },

  /** 播放动画期间禁用缩放按钮；空闲/编辑态才可用 */
  setEnabled: function (enabled) {
    var on = !!enabled;
    ['zoomIn', 'zoomOut', 'zoomFit'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.disabled = !on;
      el.classList.toggle('is-disabled', !on);
    });
    var ctl = document.getElementById('zoomCtl');
    if (ctl) ctl.classList.toggle('is-inert', !on);
  },

  /** 按钮缩放：仅在非播放态可用（播放期间比例由镜头控制） */
  step: function (delta) {
    var map = App.map;
    if (!map) return;
    if (typeof Story !== 'undefined' && Story.playing) return;
    if (typeof Camera !== 'undefined') {
      Camera.active = false;
      Camera.suspend();
      Camera.syncFromMap();
    }
    var current = Math.round(map.getZoom());
    var next = clamp(current + delta, map.getMinZoom(), map.getMaxZoom());
    if (next === current) return;
    map.setView(map.getCenter(), next, { animate: false });
    this.syncScale();
    this.scheduleRelayout();
  },

  relayoutLabels: function () {
    if (Edit.active) Edit.resolveLabelSides();
    else if (Scene.built) Scene.resolveLabelSides();
  },

  /** 复位视野：编辑态按当前方案适配，播放态按场景适配 */
  fit: function () {
    var map = App.map;
    if (!map) return;
    if (typeof Story !== 'undefined' && Story.playing) return;
    if (typeof Camera !== 'undefined') {
      Camera.active = false;
      Camera.suspend();
      Camera.syncFromMap();
    }
    if (Edit.active) {
      var bounds = L.latLngBounds([]);
      (App.plan ? App.plan.lines : []).forEach(function (line) {
        line.stations.forEach(function (station) {
          var point = Basemap.project(station.lat, station.lng);
          bounds.extend([point[0], point[1]]);
        });
      });
      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          paddingTopLeft: L.point(map.getSize().x <= 720 ? 18 : 286, map.getSize().x <= 720 ? 172 : 148),
          paddingBottomRight: L.point(map.getSize().x <= 720 ? 18 : 66, map.getSize().x <= 720 ? 196 : 96),
          maxZoom: 14,
          animate: true
        });
      } else if (App.plan && App.plan.view) {
        var center = Basemap.project(App.plan.view.center[0], App.plan.view.center[1]);
        map.setView(center, App.plan.view.zoom, { animate: true });
      }
      this.relayoutLabels();
      return;
    }
    if (Scene.built) Scene.fit(true);
    this.relayoutLabels();
  },

  /** 用比例尺提示当前缩放级别，给控件一点“地图感” */
  syncScale: function () {
    var label = $('#zoomLevel');
    if (!label || !App.map) return;
    var zoom = App.map.getZoom();
    var meters = 156543.03392 * Math.cos(App.map.getCenter().lat * Math.PI / 180) / Math.pow(2, zoom);
    var perPx = Math.round(meters);
    label.textContent = perPixelLabel(perPx);
  }
};

function perPixelLabel(metersPerPixel) {
  if (!isFiniteNumber(metersPerPixel) || metersPerPixel <= 0) return '';
  if (metersPerPixel < 1) return '≤1 m/px';
  if (metersPerPixel < 10) return Math.round(metersPerPixel) + ' m/px';
  if (metersPerPixel < 1000) return Math.round(metersPerPixel / 10) * 10 + ' m/px';
  return (Math.round(metersPerPixel / 100) / 10) + ' km/px';
}

/* ------------------------------------------------------- 城市选择器 */

var CityUI = {
  /* --------------------------------------------------------- 城市选择器 */

  renderSelect: function () {
    var select = $('#citySelect');
    if (!select) return;
    var cities = listCities();
    var html = cities.map(function (city) {
      return '<option value="' + escapeHtml(city.id) + '"' +
        (city.id === App.cityId ? ' selected' : '') + '>' + escapeHtml(city.name) + '</option>';
    }).join('');
    html += '<option value="__custom__">＋ 自定义城市…</option>';
    select.innerHTML = html;
    select.value = App.cityId || '';
  },

  onSelectChange: function (value) {
    if (value === '__custom__') {
      this.openCitySheet();
      this.renderSelect();                       // 选择器回到当前城市
      return;
    }
    this.switchCity(value);
  },

  /** 切换城市：保存 → 停动画 → 销毁场景 → 载入方案 → 适配视野 → 自动播放 */
  switchCity: function (cityId) {
    if (!cityId || cityId === App.cityId) {
      this.renderSelect();
      return;
    }
    var self = this;
    var begin = function () {
      if (Edit.active) {
        Edit.flushPersist();                     // 先保存当前城市的编辑状态
        Edit.exit(true);                         // 静默退出，不重建场景
      }
      Story.stop();
      Scene.destroy();

      App.loadCity(cityId);
      self.renderSelect();
      LineSelection.sync(App.plan);
      LineUI.render();
      Scene.updateCredit();

      var plan = App.plan;
      var playable = Story.playableLineIndexes().length > 0;

      if (playable) {
        Story.play();
        toast('已切换到「' + plan.cityName + '」');
        return;
      }

      // 空白线网：直接进入编辑，从零添加线路与站点
      Scene.build(plan);
      Scene.updateHeader(0);
      Scene.updateStats([0]);
      Scene.updateCredit();
      Edit.enter();
      toast('「' + plan.cityName + '」为空白线网，点击地图添加站点');
    };

    if (RemoteStore.enabled) {
      RemoteStore.pullCity(cityId).then(begin, begin);
    } else {
      begin();
    }
  },

  /* --------------------------------------------------------- 自定义城市 */

  openCitySheet: function () {
    var center = App.map.getCenter();
    var wgs = Basemap.unproject(center.lat, center.lng);
    $('#customCityName').value = '';
    $('#customCityLat').value = roundTo(wgs[0], 5);
    $('#customCityLng').value = roundTo(wgs[1], 5);
    openSheet('citySheet');
    window.setTimeout(function () { $('#customCityName').focus(); }, 60);
  },

  useMapCenter: function () {
    var center = App.map.getCenter();
    var wgs = Basemap.unproject(center.lat, center.lng);
    $('#customCityLat').value = roundTo(wgs[0], 5);
    $('#customCityLng').value = roundTo(wgs[1], 5);
  },

  createCity: function () {
    var name = String($('#customCityName').value || '').trim();
    var lat = Number($('#customCityLat').value);
    var lng = Number($('#customCityLng').value);
    if (!name) { toast('请填写城市名'); return; }
    if (!isValidLatLng(lat, lng)) { toast('中心坐标不合法'); return; }

    if (Edit.active) { Edit.flushPersist(); Edit.exit(true); }
    Story.stop();
    Scene.destroy();

    var cityId = createCustomCity(name, [lat, lng]);
    closeSheet('citySheet');
    App.loadCity(cityId);
    this.renderSelect();
    LineSelection.sync(App.plan);
    LineUI.render();
    Scene.build(App.plan);
    Scene.updateHeader(0);
    Scene.updateStats([0]);
    Scene.updateCredit();
    Story.reset();
    var veil = $('#veil');
    if (veil) veil.style.opacity = '0';
    var center = Basemap.project(lat, lng);
    App.map.setView(L.latLng(center[0], center[1]), 12, { animate: false });
    Edit.enter();
    toast('已生成「' + name + '」空白线网，点击地图添加站点');
  },

  /* ------------------------------------------------------- 地图设置面板 */

  openSettings: function () {
    var input = $('#amapKeyInput');
    if (input) input.value = getStoredAmapKey();
    this.updateBasemapIndicator();
    openSheet('settingsSheet');
  },

  updateBasemapIndicator: function () {
    var el = $('#basemapStatus');
    if (el) el.textContent = '当前底图：' + Basemap.label() + (Basemap.isGcj() ? '（GCJ-02 投影）' : '（WGS84）');
    var storageEl = $('#storageStatus');
    if (storageEl) storageEl.textContent = '数据存储：' + RemoteStore.label();
    var status = $('#amapKeyStatus');
    if (status) {
      var key = getStoredAmapKey();
      if (!key) {
        status.textContent = '未配置 Key：按「OpenFreeMap 矢量 → Esri 栅格」顺序使用默认底图。';
        return;
      }
      var keyState = {
        valid: 'Key 校验通过。',
        invalid: 'Key 无效，已静默回退到默认底图链路。',
        unknown: 'Key 校验未完成（网络不可达），保留高德瓦片。',
        checking: 'Key 校验中…'
      }[Basemap.keyStatus] || '';
      status.textContent = (Basemap.mode === 'amap' ? '高德底图已生效。' : '当前底图为默认链路。') + keyState;
    }
  },

  saveAmapKey: function () {
    var input = $('#amapKeyInput');
    var key = String(input ? input.value : '').trim();
    setStoredAmapKey(key);
    closeSheet('settingsSheet');
    this.applyBasemapChange(key ? '正在切换到高德底图…' : '已切换为默认底图');
  },

  clearAmapKey: function () {
    setStoredAmapKey('');
    var input = $('#amapKeyInput');
    if (input) input.value = '';
    closeSheet('settingsSheet');
    this.applyBasemapChange('已清除 Key，恢复默认底图');
  },

  /** 换源后重建场景：坐标投影可能变化，必须重新渲染并重新播放 */
  applyBasemapChange: function (message) {
    if (Edit.active) Edit.flushPersist();
    Story.stop();
    Scene.destroy();
    if (message) toast(message);
    Basemap.decisionClosed = false;
    var self = this;
    Basemap.restart().then(function () {
      CityUI.updateBasemapIndicator();
      Scene.updateCredit();
      if (Edit.active) {
        Edit.rebuild();
        return;
      }
      if (Story.playableLineIndexes().length) {
        Story.play();
      } else {
        Scene.build(App.plan);
        Scene.updateHeader(0);
        Scene.updateStats([0]);
      }
    });
  }
};

/* ------------------------------------------------------------- 面板开关 */

function openSheet(id) {
  var sheet = document.getElementById(id);
  if (!sheet) return;
  sheet.classList.add('is-on');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('has-sheet');
}

function closeSheet(id) {
  var sheet = document.getElementById(id);
  if (!sheet) return;
  sheet.classList.remove('is-on');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('.sheet.is-on')) document.body.classList.remove('has-sheet');
}

function closeAllSheets() {
  $all('.sheet.is-on').forEach(function (sheet) { closeSheet(sheet.id); });
  var linePanel = $('#linePanel');
  if (linePanel) linePanel.classList.remove('is-on');
}
