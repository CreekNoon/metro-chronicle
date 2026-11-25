/* ==========================================================================
   40 · 场景层：线路图层 / 站点标记 / 头部标记 / 视野适配 / 顶栏与数据面板
   —— 所有渲染坐标都经 Basemap.project()（高德模式为 GCJ-02），几何计算仍用 WGS84
   ========================================================================== */


var Scene = {
  map: null,
  plan: null,
  group: null,
  geometries: {},
  routes: {},
  stations: {},
  bounds: null,
  built: false,
  openedLineKeys: {},

  init: function (map) {
    this.map = map;
    return this;
  },

  /* ------------------------------------------------------------ 渲染坐标 */

  toRender: function (lat, lng) {
    var projected = Basemap.project(lat, lng);
    return L.latLng(projected[0], projected[1]);
  },

  /* -------------------------------------------------------------- 构建 */

  build: function (plan) {
    this.destroy();
    this.plan = plan;
    this.built = true;

    var self = this;
    this.group = L.layerGroup().addTo(this.map);
    this.geometries = {};
    this.routes = {};
    this.stations = {};
    this.bounds = L.latLngBounds([]);

    // 1) 逐线几何（平滑曲线 + 里程 + 各站弧长占比）
    plan.lines.forEach(function (line) {
      var geometry = buildLineGeometry(line.stations, function (lat, lng) {
        var projected = Basemap.project(lat, lng);
        return [projected[0], projected[1]];
      });
      self.geometries[line.key] = geometry;
      geometry.render.forEach(function (point) { self.bounds.extend(point); });
    });

    // 2) 线路三层描边（glow / casing / main）
    if (typeof RouteCanvas !== 'undefined') RouteCanvas.reset();
    plan.lines.forEach(function (line) { self.createRouteLayers(line); });

    // 3) 站点：同 key 只建一个标记（换乘站共享）
    //    先汇总每个站被哪些“线路类型”服务，决定站标形状与「城际」胶囊
    var keyInfo = {};
    plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        var info = keyInfo[station.key];
        if (!info) info = keyInfo[station.key] = { types: {}, count: 0 };
        info.types[line.type || 'metro'] = true;
        info.count += 1;
      });
    });

    var seen = {};
    plan.lines.forEach(function (line, lineIndex) {
      line.stations.forEach(function (station, stationIndex) {
        if (seen[station.key]) {
          var existing = self.stations[station.key];
          existing.lineKeys.push(line.key);
          existing.occurrences.push({ lineKey: line.key, lineIndex: lineIndex, stationIndex: stationIndex });
          return;
        }
        seen[station.key] = true;
        var info = keyInfo[station.key] || { types: { metro: true } };
        var node = self.createStationNode(station, line, lineIndex, stationIndex, {
          hasRail: !!info.types.intercity,
          isRailOnly: !!info.types.intercity && !info.types.metro
        });
        self.stations[station.key] = node;
      });
    });

    this.fit(false);
    return this;
  },

  createRouteLayers: function (line) {
    var group = this.group;
    var style = lineTypeStyle(line.type);
    var common = {
      interactive: false,
      lineCap: 'round',
      lineJoin: 'round',
      smoothFactor: 1
    };
    var glow = L.polyline([], Object.assign({}, common, {
      color: line.color,
      weight: style.glowWeight,
      opacity: style.glowOpacity,
      className: 'route-layer route-glow'
    }));
    var casing = L.polyline([], Object.assign({}, common, {
      color: '#ffffff',
      weight: style.casingWeight,
      opacity: 0.96,
      className: 'route-layer route-casing'
    }));
    var main = L.polyline([], Object.assign({}, common, {
      color: line.color,
      weight: style.weight,
      opacity: 1,
      // 城际铁路用虚线：与地铁实线形成直观区分
      dashArray: style.dashArray || null,
      lineCap: style.dashArray ? 'butt' : 'round',
      className: 'route-layer route-main route-type-' + (line.type || 'metro')
    }));

    glow.addTo(group);
    casing.addTo(group);
    main.addTo(group);

    // 不再画「跟着走的圆点」：线路推进到哪里，就在那里生成站点圆点
    this.routes[line.key] = {
      line: line,
      glow: glow,
      casing: casing,
      main: main,
      headPoint: null,      // 当前绘制前沿（只用于镜头跟随，不渲染）
      active: false,
      full: false
    };
  },

  createStationNode: function (station, line, lineIndex, stationIndex, flags) {
    var railFlags = flags || {};
    var marker = createStationMarker(station, line, {
      state: 'hidden',
      numberText: formatStationNumber(stationIndex + 1),
      hasRail: railFlags.hasRail,
      isRailOnly: railFlags.isRailOnly
    });
    marker.addTo(this.group);

    var el = marker.getElement();
    var refs = {
      root: el,
      st: el ? el.querySelector('.st') : null,
      halo: el ? el.querySelector('.st-halo') : null,
      ring: el ? el.querySelector('.st-ring') : null,
      dot: el ? el.querySelector('.st-dot') : null,
      label: el ? el.querySelector('.st-label') : null,
      labelInner: el ? el.querySelector('.st-label-inner') : null,
      name: el ? el.querySelector('.st-name') : null,
      number: el ? el.querySelector('.st-num') : null
    };

    return {
      station: station,
      marker: marker,
      refs: refs,
      lineKey: line.key,
      lineKeys: [line.key],
      occurrences: [{ lineKey: line.key, lineIndex: lineIndex, stationIndex: stationIndex }],
      state: 'hidden',
      revealed: false
    };
  },

  /* ------------------------------------------------------- 绘制进度 */

  /* ------------------------------------------- 渐进揭示（高帧率关键） */

  /**
   * 把整条线路的几何「一次性」交给三条折线，之后只用 stroke-dashoffset 揭示进度。
   * 这样每帧只改样式（合成器直接处理），不必重建 SVG 路径，也不会触发 Leaflet 投影。
   */
  ensureRoutePath: function (lineKey) {
    var route = this.routes[lineKey];
    var geometry = this.geometries[lineKey];
    if (!route || !geometry) return null;
    var zoom = App.map ? App.map.getZoom() : 0;
    if (route.pathZoom !== zoom) {
      route.glow.setLatLngs(geometry.render);
      route.casing.setLatLngs(geometry.render);
      route.main.setLatLngs(geometry.render);
      route.pathZoom = zoom;
      route.dashLen = 0;
      route.dashProgress = -1;
    }
    if (!route.dashLen) {
      var el = route.main && route.main._path;
      var len = 0;
      if (el && typeof el.getTotalLength === 'function') {
        try { len = el.getTotalLength(); } catch (err) { len = 0; }
      }
      route.dashLen = len || 0;
    }
    return route;
  },

  /** 设定线路的揭示进度（0~1）：纯样式更新，无需重建几何 */
  setRouteProgress: function (lineKey, ratio) {
    var route = this.ensureRoutePath(lineKey);
    if (!route) return;
    var p = clamp(ratio, 0, 1);
    if (route.dashProgress === p) return;
    route.dashProgress = p;

    var apply = function (layer) {
      var el = layer && layer._path;
      if (!el) return;
      if (p >= 0.9999) {
        // 画完：交还给图层自身的样式（城际的虚线就是在这里恢复的）
        el.style.strokeDasharray = '';
        el.style.strokeDashoffset = '';
        return;
      }
      var len = route.dashLen;
      if (!len) return;
      el.style.strokeDasharray = len + ' ' + len;
      el.style.strokeDashoffset = String(len * (1 - p));
    };
    apply(route.main);
    apply(route.casing);
    apply(route.glow);
    route.main.getPane && route.main.bringToBack && null;
  },

  /** 按弧长比例绘制线路，并点亮已到达的站点 */
  drawProgress: function (lineIndex, ratio) {
    var line = this.plan && this.plan.lines[lineIndex];
    if (!line) return;
    var route = this.routes[line.key];
    var geometry = this.geometries[line.key];
    if (!route || !geometry) return;

    var t0 = (typeof Metrics !== 'undefined' && Metrics.now) ? Metrics.now() : 0;

    /*
     * 正在延伸的线路用 canvas 逐帧描路径（成本 ∝ 已画长度）；
     * 画完之后才把整条几何交给 SVG（只画一次，之后随平移移动，不再重绘）。
     */
    var style = lineTypeStyle(line.type);
    var index = cutIndexAt(geometry, ratio);
    var headPoint = headPointAt(geometry, ratio);
    if (typeof RouteCanvas !== 'undefined' && RouteCanvas.activeKey === line.key) {
      RouteCanvas.draw(line.key, geometry, index, headPoint, {
        color: line.color,
        weight: style.weight,
        casingWeight: style.casingWeight,
        glowWeight: style.glowWeight,
        glowOpacity: style.glowOpacity,
        dash: !!style.dashArray
      }, ratio);
    }
    route.headPoint = headPoint;

    // 站点：弧长比例已到达 → 依次点亮（跨线共用站触发 ghost → transfer 变换）
    for (var i = 0; i < line.stations.length; i += 1) {
      var station = line.stations[i];
      var stationRatio = geometry.stationRatio[i];
      if (!isFiniteNumber(stationRatio)) stationRatio = 0;
      if (ratio + 1e-6 < stationRatio) continue;

      var node = this.stations[station.key];
      if (!node) continue;
      // 单独开通的站点由自己的事件点亮，不在画线时提前出现
      if (station.openMode === 'alone') continue;
      var numberText = formatStationNumber(i + 1);

      if (!node.revealed) {
        this.revealStation(station.key, station.ghost ? 'ghost' : 'opened', numberText, i);
      }
      // 已开通线路 ≥ 2 条才升级为换乘站；多于 2 条时颜色数随之增加
      this.refreshInterchange(station.key, numberText);
    }
    if (t0 && typeof Metrics !== 'undefined' && Metrics.add) Metrics.add('scene', Metrics.now() - t0);
    return headPoint;
  },

  /** 该站当前「已开通线路」的颜色列表（按 plan 顺序去重） */
  openedColorsFor: function (node) {
    var opened = this.openedLineKeys || {};
    var colors = [];
    (this.plan ? this.plan.lines : []).forEach(function (line) {
      if (!opened[line.key]) return;
      if (!node || node.lineKeys.indexOf(line.key) < 0) return;
      if (colors.indexOf(line.color) < 0) colors.push(line.color);
    });
    return colors;
  },

  /**
   * 换乘站配色渐进：
   * - 只有一条线路开通：保持单线颜色（一个色）
   * - 两条开通：双色圆环
   * - 第三条接入：才变成三色圆环
   */
  refreshInterchange: function (stationKey, numberText) {
    var node = this.stations[stationKey];
    if (!node || !node.refs || !node.refs.st) return;
    var colors = this.openedColorsFor(node);
    var label = numberText || (node.refs.number ? node.refs.number.textContent : '');

    if (colors.length >= 2) {
      var gradient = conicRingGradient(colors);
      if (gradient) node.refs.st.style.setProperty('--ring-gradient', gradient);
      if (node.state !== 'transfer') this.animateGhostToTransfer(stationKey, label);
      return;
    }

    // 未构成换乘：回到单线配色
    node.refs.st.style.removeProperty('--ring-gradient');
    if (node.state === 'transfer') applyStationState(node, node.station.ghost ? 'ghost' : 'opened', label);
  },

  /** 点亮站点：halo → ring → dot → label 依次入场（halo 保持克制的低透明度） */
  revealStation: function (stationKey, mode, numberText, stationIndex) {
    var node = this.stations[stationKey];
    if (!node || node.revealed) return false;
    node.revealed = true;

    var refs = node.refs;
    applyStationState(node, mode, numberText);

    if (!window.gsap || !refs.halo) {
      if (refs.st) refs.st.style.opacity = '1';
      return true;
    }

    var targets = [refs.halo, refs.ring, refs.dot, refs.labelInner, refs.st];
    killTweens(targets);

    gsap.set(refs.st, { opacity: 1 });
    var timeline = gsap.timeline();
    timeline.fromTo(refs.halo, { scale: 0.2, opacity: 0 }, {
      scale: 1,
      opacity: haloOpacityFor(mode),
      duration: 0.55,
      ease: 'power2.out'
    }, 0);
    timeline.fromTo(refs.ring, { scale: 2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'power3.out' }, 0.04);
    timeline.fromTo(refs.dot, { scale: 0.1, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2)' }, 0.1);
    timeline.fromTo(refs.labelInner, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' }, 0.16);
    return true;
  },

  /** 已开通的换乘站：完成态强制显示为换乘（用于重播后的静默状态） */
  forceTransfer: function (stationKey, numberText) {
    var node = this.stations[stationKey];
    if (!node) return;
    applyStationState(node, 'transfer', numberText);
    if (node.refs.st) node.refs.st.style.opacity = '1';
    if (node.refs.labelInner) {
      killTweens(node.refs.labelInner);
      if (window.gsap) gsap.set(node.refs.labelInner, { opacity: 1, y: 0 });
      else node.refs.labelInner.style.opacity = '1';
    }
  },

  /** ghost → transfer 的变换动画（清水塘在 2 号线经过时触发）
      —— 换乘用单点多色圆环表示，切换时做一次「收束 → 弹开」的强调 */
  animateGhostToTransfer: function (stationKey, numberText) {
    var self = this;
    var node = this.stations[stationKey];
    if (!node || node.state === 'transfer') return;
    var refs = node.refs;
    var wasGhost = node.state === 'ghost';
    applyStationState(node, 'transfer', numberText);
    if (refs.st) refs.st.style.opacity = '1';

    if (!window.gsap || !refs.ring) return;

    killTweens([refs.ring, refs.labelInner, refs.halo]);
    var timeline = gsap.timeline();
    timeline.fromTo(refs.ring, { scale: wasGhost ? 0.7 : 0.86, opacity: 0.35 }, {
      scale: 1,
      opacity: 1,
      duration: 0.52,
      ease: 'back.out(2)'
    }, 0);
    timeline.fromTo(refs.halo, { scale: wasGhost ? 1 : 0.9 }, {
      scale: 1.35,
      duration: 0.26,
      ease: 'power2.out',
      yoyo: true,
      repeat: 1
    }, 0);
    timeline.fromTo(refs.labelInner, { opacity: 0.35, y: 3 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, 0.16);
    // 胶囊切换后标签变宽，重新做一次避让
    timeline.call(function () { self.resolveLabelSides(); }, null, 0.7);
  },

  /** 单个站点开通（不画线）：只点亮一个点 */
  revealStandalone: function (stationKey) {
    var node = this.stations[stationKey];
    if (!node || node.revealed) return false;
    var openedLines = this.openedLineKeys || {};
    var sharedOpened = node.lineKeys.filter(function (key) { return openedLines[key]; }).length;
    var mode = node.station.ghost ? 'ghost' : (node.lineKeys.length > 1 && sharedOpened >= 2 ? 'transfer' : 'opened');
    var numberText = formatStationNumber((node.occurrences[0] ? node.occurrences[0].stationIndex : 0) + 1);
    var revealed = this.revealStation(stationKey, mode, numberText, node.occurrences[0] ? node.occurrences[0].stationIndex : 0);
    this.refreshInterchange(stationKey, numberText);
    return revealed;
  },

  /** 标记某条线是否正在「绘制中」（只影响内部状态与镜头跟随，不再有可见圆点） */
  setHeadVisible: function (lineIndex, visible) {
    var line = this.plan && this.plan.lines[lineIndex];
    if (!line) return;
    var route = this.routes[line.key];
    if (!route) return;
    route.active = !!visible;
    if (!visible) route.headPoint = null;
  },

  /** 当前绘制前沿（没有圆点标记时给镜头用） */
  headPointOf: function (lineIndex) {
    var line = this.plan && this.plan.lines[lineIndex];
    var route = line ? this.routes[line.key] : null;
    return route ? route.headPoint : null;
  },

  /** 线路画完：SVG 一次性画出完整路径，canvas 收工 */
  completeLine: function (lineIndex) {
    var line = this.plan && this.plan.lines[lineIndex];
    if (!line) return;
    var route = this.routes[line.key];
    var geometry = this.geometries[line.key];
    if (!route || !geometry) return;
    route.glow.setLatLngs(geometry.render);
    route.casing.setLatLngs(geometry.render);
    route.main.setLatLngs(geometry.render);
    route.pathZoom = App.map ? App.map.getZoom() : 0;
    if (typeof RouteCanvas !== 'undefined') RouteCanvas.finish();
  },

  /** 完整显示一条线（编辑态预览 / 结束态使用） */
  showFullLine: function (lineIndex) {
    this.completeLine(lineIndex);
  },

  showAllLines: function () {
    var self = this;
    (this.plan ? this.plan.lines : []).forEach(function (_, index) { self.showFullLine(index); });
  },

  revealAll: function (lineIndex) {
    var line = this.plan && this.plan.lines[lineIndex];
    if (!line) return;
    for (var i = 0; i < line.stations.length; i += 1) {
      var station = line.stations[i];
      var target = this.stations[station.key];
      if (!target || target.revealed) continue;
      this.revealStation(station.key, station.ghost ? 'ghost' : 'opened', formatStationNumber(i + 1), i);
    }
  },

  /* --------------------------------------------------------- 视野适配 */

  fit: function (animate) {
    if (!this.map) return;
    var size = this.map.getSize();
    var narrow = size.x <= 720;
    var paddingTopLeft = narrow ? L.point(18, 172) : L.point(286, 148);
    var paddingBottomRight = narrow ? L.point(18, 196) : L.point(66, 96);

    if (this.bounds && this.bounds.isValid()) {
      this.map.fitBounds(this.bounds, {
        paddingTopLeft: paddingTopLeft,
        paddingBottomRight: paddingBottomRight,
        maxZoom: 13,
        animate: !!animate,
        duration: 0.6
      });
    } else if (this.plan && this.plan.view) {
      var center = Basemap.project(this.plan.view.center[0], this.plan.view.center[1]);
      this.map.setView(center, this.plan.view.zoom, { animate: false });
    }
    // 视野确定后按真实屏幕位置再避让一次标签
    this.resolveLabelSides();
  },

  /**
   * 渲染期标签避让：以真实屏幕矩形为依据，标签互相压盖时按
   * 「走向法线 → 对侧 → 垂直方向」的顺序换边，保证站名可读。
   */
  resolveLabelSides: function () {
    var self = this;
    if (!this.map) return;
    var list = Object.keys(this.stations).map(function (key) {
      var node = self.stations[key];
      return {
        station: node.station,
        marker: node.marker,
        stEl: node.refs.st,
        labelInnerEl: node.refs.labelInner
      };
    });
    resolveLabelSidesFor(this.map, list);
  },

  /* ------------------------------------------------------------ 销毁 */

  destroy: function () {
    var self = this;
    if (this.group) {
      Object.keys(this.stations).forEach(function (key) {
        var node = self.stations[key];
        if (!node.refs) return;
        [node.refs.st, node.refs.halo, node.refs.ring, node.refs.dot, node.refs.labelInner]
          .forEach(function (el) { killTweens(el); });
      });
      Object.keys(this.routes).forEach(function (key) {
        var route = self.routes[key];
        route.active = false;
        route.headPoint = null;
      });
      try { this.map.removeLayer(this.group); } catch (err) { /* noop */ }
      try { this.group.clearLayers(); } catch (err) { /* noop */ }
    }
    this.group = null;
    this.routes = {};
    this.stations = {};
    this.geometries = {};
    this.bounds = null;
    this.built = false;
  },

  /* -------------------------------------------------------- 文案更新 */

  lineRangeText: function (line) {
    if (!line || !line.stations.length) return '待规划';
    var first = line.stations[0].name;
    var last = line.stations[line.stations.length - 1].name;
    if (line.stations.length === 1) return first;
    return first + '—' + last;
  },

  updateHeader: function (lineIndex) {
    var plan = this.plan;
    if (!plan) return;
    var line = plan.lines[clamp(lineIndex, 0, plan.lines.length - 1)];
    if (!line) return;

    var dateText = $('#dateText');
    var badge = $('#lineBadge');
    var name = $('#lineName');
    var range = $('#lineRange');
    var status = $('#lineStatus');

    if (dateText) dateText.textContent = line.dateText;
    if (badge) {
      badge.textContent = line.badge;
      badge.style.setProperty('--line-color', line.color);
      badge.style.background = line.color;
      badge.dataset.lineType = line.type || 'metro';
      badge.classList.toggle('is-type-intercity', line.type === 'intercity');
    }
    if (name) name.textContent = line.name;
    if (range) range.textContent = this.lineRangeText(line);
    if (status) status.textContent = line.status;
    var header = $('#lineHead');
    if (header) {
      header.style.setProperty('--line-color', line.color);
      header.dataset.lineType = line.type || 'metro';
    }
  },

  /** 数据面板数值写入（线路数 / 站点数 / 里程） */
  applyStats: function (stats) {
    var self = this;
    var lineEl = $('#statLines');
    var stationEl = $('#statStations');
    var kmEl = $('#statKm');

    var prevLines = Number(lineEl && lineEl.dataset.value);
    var prevStations = Number(stationEl && stationEl.dataset.value);
    var prevKm = Number(kmEl && kmEl.dataset.value);

    if (lineEl) { lineEl.dataset.value = String(stats.lines); tweenTextNumber(lineEl, isFiniteNumber(prevLines) && prevLines > 0 ? prevLines : stats.lines, stats.lines); }
    if (stationEl) { stationEl.dataset.value = String(stats.stations); tweenTextNumber(stationEl, isFiniteNumber(prevStations) && prevStations > 0 ? prevStations : stats.stations, stats.stations); }
    if (kmEl) { kmEl.dataset.value = String(stats.km); tweenTextNumber(kmEl, isFiniteNumber(prevKm) && prevKm > 0 ? prevKm : stats.km, stats.km); }

    var panel = $('#stats');
    if (panel && window.gsap) {
      gsap.fromTo(panel, { opacity: 0.55 }, { opacity: 1, duration: 0.45, ease: 'power2.out' });
    }
    return stats;
  },

  /** 按已开通线路统计（未单独开通的站点随线路计入） */
  updateStats: function (activeLineIndexes, extraStationKeys) {
    var plan = this.plan;
    if (!plan) return;
    var lines = activeLineIndexes.map(function (index) { return plan.lines[index]; }).filter(Boolean);
    return this.applyStats(computeStats(lines, this.geometries, extraStationKeys));
  },

  /** 单个站点开通事件的顶栏（保留所属线路的徽章与配色） */
  updateStationHeader: function (lineIndex, station, dateText) {
    var plan = this.plan;
    if (!plan || !station) return;
    this.updateHeader(lineIndex);
    var dateEl = $('#dateText');
    if (dateEl) dateEl.textContent = dateText;
    var nameEl = $('#lineName');
    if (nameEl) nameEl.textContent = station.name;
    var rangeEl = $('#lineRange');
    if (rangeEl) rangeEl.textContent = (plan.lines[lineIndex] ? plan.lines[lineIndex].name : '') + ' · 单独开通';
    var statusEl = $('#lineStatus');
    if (statusEl) statusEl.textContent = '站点开通';
  },

  updateCredit: function () {
    var plan = this.plan;
    var cityEl = $('#creditCity');
    var sourceEl = $('#creditSource');
    if (cityEl) cityEl.textContent = plan ? plan.cityName + ' · 地铁线网开通纪事' : '地铁线网开通纪事';
    if (sourceEl) sourceEl.textContent = Basemap.attribution + ' · 数据为虚构演示';
  }
};

/* --------------------------------------------------------- 站点标记工厂 */

function formatStationNumber(index) {
  var value = Number(index);
  if (!isFinite(value) || value <= 0) return '--';
  return value < 10 ? '0' + value : String(value);
}

/** 站点光晕的设计透明度（与 CSS 保持一致，动画只能收敛到这些值，避免发光过强） */
var HALO_OPACITY = { hidden: 0, ghost: 0.035, opened: 0.09, transfer: 0.06 };

function haloOpacityFor(state) {
  return HALO_OPACITY[state] === undefined ? HALO_OPACITY.opened : HALO_OPACITY[state];
}

/** 站点标记结构：halo / ring / dot / label（站名 + 序号胶囊 + 类型/状态胶囊）
    —— 换乘站用「单点多色圆环」，不再画两个点 */
function stationMarkup(station, line, options) {
  var opts = options || {};
  var side = LABEL_SIDES.indexOf(station.side) >= 0 ? station.side : 'bottom';
  var state = opts.state || 'hidden';
  var color = line && line.color ? line.color : '#e60012';
  var classes = ['st', 'side-' + side, 'is-' + state];
  if (station.terminal) classes.push('is-terminal');
  if (station.shared) classes.push('is-shared');
  // 城际铁路：仅城际服务的站用方形站标；与地铁共站的站保留圆形 + 「城际」胶囊
  if (opts.isRailOnly) classes.push('is-rail');
  if (opts.hasRail) classes.push('has-rail');

  var ringStyle = opts.ringStyle || '';
  var style = '--line-color:' + escapeHtml(color) + ';' + ringStyle;

  return '' +
    '<div class="' + classes.join(' ') + '" data-station-key="' + escapeHtml(station.key) + '" style="' + style + '">' +
      '<span class="st-halo"></span>' +
      '<span class="st-ring"></span>' +
      '<span class="st-dot"></span>' +
      '<span class="st-label">' +
        '<span class="st-label-inner">' +
          '<span class="st-name">' + escapeHtml(station.name) + '</span>' +
          '<span class="st-num">' + escapeHtml(opts.numberText || '') + '</span>' +
          '<span class="st-ghost">暂未开通</span>' +
          '<span class="st-transfer-tag">换乘</span>' +
          '<span class="st-rail-tag">城际</span>' +
        '</span>' +
      '</span>' +
    '</div>';
}

function createStationMarker(station, line, options) {
  var opts = options || {};
  var projected = Basemap.project(station.lat, station.lng);
  var icon = L.divIcon({
    className: 'st-icon',
    html: stationMarkup(station, line, opts),
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });
  return L.marker(L.latLng(projected[0], projected[1]), {
    icon: icon,
    draggable: !!opts.draggable,
    autoPan: false,
    keyboard: false,
    interactive: opts.interactive !== false,
    riseOnHover: false,
    zIndexOffset: opts.zIndexOffset || 0
  });
}

/** 切换站点视觉状态（hidden / ghost / opened / transfer） */
function applyStationState(node, state, numberText) {
  if (!node || !node.refs || !node.refs.st) return;
  var st = node.refs.st;
  var nextState = state || 'opened';
  st.classList.remove('is-hidden', 'is-ghost', 'is-opened', 'is-transfer');
  st.classList.add('is-' + nextState);
  node.state = nextState;
  if (numberText && node.refs.number) node.refs.number.textContent = numberText;
}

/** 换乘站配色：按经过该站的线路颜色把圆环等分成若干段（单点展示，不再画两个点） */
function stationLineColors(plan, stationKey) {
  var colors = [];
  (plan ? plan.lines : []).forEach(function (line) {
    var hit = line.stations.some(function (station) { return station.key === stationKey; });
    if (hit && colors.indexOf(line.color) < 0) colors.push(line.color);
  });
  return colors;
}

function conicRingGradient(colors) {
  if (!colors || colors.length < 2) return '';
  var gap = 6;                                  // 段间白色留白（度）
  var step = 360 / colors.length;
  var parts = [];
  colors.forEach(function (color, index) {
    var start = index * step + gap / 2;
    var end = (index + 1) * step - gap / 2;
    parts.push(color + ' ' + start.toFixed(1) + 'deg ' + end.toFixed(1) + 'deg');
    parts.push('#ffffff ' + end.toFixed(1) + 'deg ' + (end + gap).toFixed(1) + 'deg');
  });
  return 'conic-gradient(from -90deg, ' + parts.join(', ') + ')';
}

/** 换乘站的多色圆环：写进 --ring-gradient，换乘态由 CSS 应用 */
function ringStyleVars(plan, stationKey) {
  var colors = stationLineColors(plan, stationKey);
  if (colors.length < 2) return '';
  return '--ring-gradient:' + conicRingGradient(colors) + ';';
}

/* --------------------------------------------------- 标签方位求解（避让） */

function applyLabelSideClass(stElement, side, tier) {
  if (!stElement) return;
  LABEL_SIDES.forEach(function (name) { stElement.classList.remove('side-' + name); });
  stElement.classList.add('side-' + side);
  stElement.classList.toggle('is-far', tier === 1);
  stElement.classList.toggle('is-far-2', tier === 2);
}

var LABEL_GAP = 14;          // 与 CSS 中标签到圆点的距离保持一致
var LABEL_GAP_FAR = 29;      // 「远距」变体
var LABEL_GAP_FAR2 = 46;     // 「超远距」变体（窄屏极密区段）
var LABEL_MARGIN = 4;        // 边界外扩，避免贴在一起

function labelGapFor(tier) {
  if (tier === 2) return LABEL_GAP_FAR2;
  if (tier === 1) return LABEL_GAP_FAR;
  return LABEL_GAP;
}

function labelRectFor(side, tier, entry) {
  var gap = labelGapFor(tier);
  var cx = entry.point.x;
  var cy = entry.point.y;
  var w = entry.size.w;
  var h = entry.size.h;
  if (side === 'top') return { x: cx - w / 2, y: cy - gap - h, w: w, h: h };
  if (side === 'bottom') return { x: cx - w / 2, y: cy + gap, w: w, h: h };
  if (side === 'left') return { x: cx - gap - w, y: cy - h / 2, w: w, h: h };
  return { x: cx + gap, y: cy - h / 2, w: w, h: h };
}

function labelOverlapArea(a, b) {
  var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function labelRectHits(a, b) {
  return a.x < b.x + b.w + LABEL_MARGIN && b.x < a.x + a.w + LABEL_MARGIN &&
    a.y < b.y + b.h + LABEL_MARGIN && b.y < a.y + a.h + LABEL_MARGIN;
}

function labelRectOutside(rect, size) {
  return rect.x < 2 || rect.y < 2 || rect.x + rect.w > size.x - 2 || rect.y + rect.h > size.y - 2;
}

/** 候选顺序：先近后远；每个距离内按「走向法线 → 对侧 → 两个垂直方向」 */
function labelSideCandidates(preferred) {
  var opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[preferred] || 'top';
  var rest = LABEL_SIDES.filter(function (side) { return side !== preferred && side !== opposite; });
  var order = [preferred, opposite].concat(rest);
  var out = [];
  [0, 1, 2].forEach(function (tier) {
    order.forEach(function (side) { out.push({ side: side, tier: tier }); });
  });
  return out;
}

/**
 * 贪心求解一组站点的标签方位：
 * 1) 优先级高的先放（终端站 / 换乘站），同优先级里宽的标签先放；
 * 2) 每个站点在「近 / 远 / 超远」× 4 方向 共 12 个候选里挑第一个不冲突且不越界的位置；
 * 3) 都放不下时：窄屏按优先级隐藏次要站名；重要的站保留“重叠面积最小”的位置。
 */
function layoutStationLabels(mapSize, entries) {
  var placed = [];
  var allowHide = mapSize.x <= 720;
  var queue = entries.slice().sort(function (a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.size.w - a.size.w;
  });

  queue.forEach(function (entry) {
    var candidates = labelSideCandidates(entry.preferred);
    var chosen = null;
    var bestFallback = null;

    for (var i = 0; i < candidates.length; i += 1) {
      var cand = candidates[i];
      var rect = labelRectFor(cand.side, cand.tier, entry);
      if (labelRectOutside(rect, mapSize)) continue;
      var conflict = false;
      for (var j = 0; j < placed.length; j += 1) {
        if (labelRectHits(rect, placed[j])) { conflict = true; break; }
      }
      if (!conflict) { chosen = { side: cand.side, tier: cand.tier, rect: rect }; break; }
    }

    if (!chosen && bestFallback === null) {
      // 兜底：重叠面积最小（且尽量在视口内）
      var best = null;
      candidates.forEach(function (cand) {
        var rect = labelRectFor(cand.side, cand.tier, entry);
        var area = 0;
        placed.forEach(function (p) { area += labelOverlapArea(rect, p); });
        if (labelRectOutside(rect, mapSize)) area += 4000;
        if (!best || area < best.area) best = { side: cand.side, tier: cand.tier, rect: rect, area: area };
      });
      bestFallback = best;
    }

    var pick = chosen || bestFallback;
    if (pick && (pick.area || 0) === 0) {
      placed.push(pick.rect);
      entry.apply(pick.side, pick.tier);
      return;
    }
    if (allowHide && entry.priority < 2) {
      entry.hide();
      return;
    }
    if (pick) {
      placed.push(pick.rect);
      entry.apply(pick.side, pick.tier);
      return;
    }
    entry.apply(entry.preferred, 0);
  });
}

/** 供场景层 / 编辑层共用的标签避让入口 */
function resolveLabelSidesFor(map, list) {
  if (!map) return;
  var entries = [];

  list.forEach(function (item) {
    if (!item || !item.labelInnerEl || !item.marker || !item.stEl) return;
    item.stEl.classList.remove('is-label-hidden');   // 先恢复可见，才能量到尺寸
  });

  list.forEach(function (item) {
    if (!item || !item.labelInnerEl || !item.marker || !item.stEl) return;
    var rect = item.labelInnerEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var point = map.latLngToContainerPoint(item.marker.getLatLng());
    var priority = 1;
    if (item.stEl.classList.contains('is-terminal') || item.stEl.classList.contains('is-shared')) priority = 2;
    else if (item.stEl.classList.contains('has-rail')) priority = 1.5;

    entries.push({
      preferred: LABEL_SIDES.indexOf(item.station.side) >= 0 ? item.station.side : 'bottom',
      point: L.point(point.x, point.y),
      size: { w: rect.width, h: rect.height },
      priority: priority,
      apply: function (side, tier) {
        if (item.station.side === side &&
          item.stEl.classList.contains('is-far') === (tier === 1) &&
          item.stEl.classList.contains('is-far-2') === (tier === 2)) return;
        item.station.side = side;
        applyLabelSideClass(item.stEl, side, tier);
      },
      hide: function () { item.stEl.classList.add('is-label-hidden'); }
    });
  });
  layoutStationLabels(map.getSize(), entries);
}
