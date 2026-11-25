/* ==========================================================================
   50 · 时间轴：按「开通日期」排序的事件纪事 + 镜头叙事
   - 事件：整条线路开通 / 单个站点单独开通，统一按日期先后播放
   - 镜头：线路延伸时始终把「起点 → 头部」框在画面中央并逐步拉远（特写感），
           事件之间先拉远、平移、再推近；全部跑完收束为全览
   ========================================================================== */

var STORY_TIMING = {
  intro: 4.0,            // 遮罩淡出 + HUD 依次上浮（整体 0.5× 速度）
  travel: 4.8,           // 事件之间的镜头飞行（一次动画完成平移+缩放）
  lineBase: 4.4,         // 整线绘制的基础时长
  linePerStation: 1.68,  // 每多一站增加的绘制时长
  lineMin: 11.2,
  lineMax: 25.6,
  gap: 0.6,              // 一条线画完到下一个事件之间的呼吸
  stationHold: 6.0,      // 单站开通的停留
  dateFlip: 2.4,         // 日期翻页耗时（与镜头飞行重叠）
  outro: 6.8             // 收束到全览
};

/** 单条线路的绘制时长：站越多画得越久，但控制在可接受区间 */
function lineDrawDuration(line) {
  var duration = STORY_TIMING.lineBase + STORY_TIMING.linePerStation * line.stations.length;
  return clamp(duration, STORY_TIMING.lineMin, STORY_TIMING.lineMax);
}

var Story = {
  tl: null,
  playing: false,
  finished: false,
  phase: -1,
  startedAt: 0,
  events: [],
  openedLines: {},
  openedStations: {},
  openedMeters: 0,
  drawing: false,
  lastStats: '',

  /** 有没有可播放的内容（勾选线路里至少有一个站）——启动与切城时用来判断 */
  playableLineIndexes: function () {
    var plan = App.plan;
    if (!plan) return [];
    var indexes = [];
    plan.lines.forEach(function (line, index) {
      if (typeof LineSelection !== 'undefined' && !LineSelection.isSelected(line.key)) return;
      if (!line.stations.length) return;
      indexes.push(index);
    });
    return indexes;
  },

  /* ------------------------------------------------------- 事件表构建 */

  /**
   * 把所有「开通动作」展开成事件，并按日期升序排序：
   * - 线路事件：日期取自 line.dateText，包含该线路上「随线路开通」的站点
   * - 站点事件：日期取自 station.openDate（缺省用线路日期），只点亮这一个点
   */
  buildEvents: function () {
    var plan = App.plan;
    var events = [];
    this.events = events;
    if (!plan) return events;

    var seenStation = {};
    var lineEvents = [];
    var stationEvents = [];

    plan.lines.forEach(function (line, lineIndex) {
      if (typeof LineSelection !== 'undefined' && !LineSelection.isSelected(line.key)) return;

      var withLineCount = 0;
      line.stations.forEach(function (station, stationIndex) {
        if (station.openMode === 'alone') {
          if (seenStation[station.key]) return;
          seenStation[station.key] = true;
          var rawText = normalizeDateInput(station.openDate) || normalizeDateInput(line.dateText);
          stationEvents.push({
            type: 'station',
            lineIndex: lineIndex,
            stationKey: station.key,
            stationIndex: stationIndex,
            dateText: rawText || '—',
            dateValue: parseDateValue(rawText || line.dateText),
            order: stationEvents.length
          });
          return;
        }
        withLineCount += 1;
      });

      if (withLineCount > 0) {
        lineEvents.push({
          type: 'line',
          lineIndex: lineIndex,
          dateText: normalizeDateInput(line.dateText) || line.dateText || '—',
          dateValue: parseDateValue(line.dateText),
          order: lineEvents.length
        });
      }
    });

    var all = lineEvents.concat(stationEvents);
    this.events = all;
    all.sort(function (a, b) {
      if (a.dateValue !== b.dateValue) {
        if (a.dateValue === Infinity) return 1;
        if (b.dateValue === Infinity) return -1;
        return a.dateValue - b.dateValue;
      }
      if (a.type !== b.type) return a.type === 'line' ? -1 : 1;   // 同日：先整线后单站
      return a.order - b.order;
    });
    return all;
  },

  /* --------------------------------------------------------------- 播放 */

  play: function () {
    if (!App.plan) return null;
    this.reset();

    this.startedAt = Math.round(performance.now());
    Scene.build(App.plan);
    Scene.openedLineKeys = {};
    setMapLocked(true);
    Camera.resume();

    var self = this;
    var timing = STORY_TIMING;
    var events = this.buildEvents();
    this.playing = true;
    // 重播/开播时数据面板清零，随后随事件累加；顶栏/版权先切到首个事件
    this.lastStats = '';
    Scene.applyStats({ lines: 0, stations: 0, km: 0 });
    Scene.updateCredit();
    if (events.length) this.applyHeader(events[0]);

    var tl = gsap.timeline({
      defaults: { overwrite: 'auto' },
      onComplete: function () {
        self.playing = false;
        self.finished = true;
        (App.plan ? App.plan.lines : []).forEach(function (_, index) {
          Scene.setHeadVisible(index, false);
        });
      }
    });
    this.tl = tl;

    var veil = $('#veil');
    if (veil) {
      gsap.set(veil, { opacity: 1 });
      tl.to(veil, { opacity: 0, duration: 0.8, ease: 'power2.out' }, 0);
    }

    var hudItems = [$('#timeCapsule'), $('#lineHead'), $('#stats'), $('#replayBtn'), $('#skipBtn'), $('#credit'), $('#controls'), $('#zoomCtl')].filter(Boolean);
    if (hudItems.length) {
      tl.from(hudItems, { y: 16, opacity: 0, duration: 0.85, stagger: 0.07, ease: 'power3.out' }, 0.05);
    }

    if (!events.length) {
      Scene.updateStats([]);
      tl.call(function () { self.finished = true; self.playing = false; }, null, 0.6);
      return tl;
    }

    // 播放期间禁止手动改比例（滚轮已禁用，缩放按钮也置灰）
    if (typeof ZoomUI !== 'undefined') ZoomUI.setEnabled(false);

    // 开场先给全景，第一个事件再拉进特写
    Scene.fit(false);
    Camera.init();
    Camera.setPanorama(App.map.getZoom());     // 全景比例 → 统一的特写比例 A
    Camera.active = true;
    Camera.resume();
    Camera.syncFromMap();
    var cursor = timing.intro + 0.05;

    events.forEach(function (event, index) {
      var line = App.plan.lines[event.lineIndex];
      if (!line) return;
      var isLine = event.type === 'line';

      /* --- 顶栏与日期：与镜头飞行重叠，屏幕中心不动、信息先换 --- */
      if (index > 0) self.addHeaderFlip(tl, cursor, event);

      /* --- 镜头飞行到事件起点 --- */
      var startPoint = isLine ? self.lineStartPoint(event.lineIndex) : self.stationPoint(event.stationKey);
      // 整线：用「整条线路刚好落在画面内」的固定缩放；单站：固定特写缩放
      var targetZoom = isLine ? Camera.lineZoom(event.lineIndex) : Camera.stationZoom();
      var travelAt = cursor + (index > 0 ? 0.14 : 0);
      tl.call(function () {
        self.prefetchEvent(event, targetZoom);
        Camera.flyTo(startPoint, targetZoom, {
          duration: timing.travel,
          dip: index === 0 ? 0.6 : undefined
        });
      }, null, travelAt);

      var landAt = travelAt + timing.travel;

      if (isLine) {
        /* --- 整线开通：跟拍绘制 --- */
        var slot = { value: 0 };
        var duration = lineDrawDuration(line);
        tl.call(function () {
          Camera.snapTo(startPoint, targetZoom);      // 开画前对齐构图，避免飞行残差
          self.beginLine(event);
        }, null, landAt - 0.1);
        var settle = 0.4;                     // 等镜头缩放动画落定再开始画线
        tl.to(slot, {
          value: 1,
          duration: duration,
          ease: 'none',
          onUpdate: function () {
            var head = Scene.drawProgress(event.lineIndex, slot.value);
            // 只平移：缩放保持特写比例 A 不变；镜头跟着「正在延伸的头部」走
            if (head) Camera.panTo([head[0], head[1]]);
            self.syncRevealedStats();
          }
        }, landAt + settle);
        tl.call(function () {
          self.drawing = false;
          Scene.completeLine(event.lineIndex);
          Scene.setHeadVisible(event.lineIndex, false);
        }, null, landAt + settle + duration + 0.05);
        // 画完：拉回「全景比例」展示这条线的全景，再停留一拍
        var panorama = Camera.linePanoramaTarget(event.lineIndex);
        if (panorama) {
          tl.call(function () {
            Camera.flyTo([panorama.center.lat, panorama.center.lng], panorama.zoom, {
              duration: CAMERA.flyBack,
              dip: 0
            });
          }, null, landAt + settle + duration + 0.12);
        }
        cursor = landAt + settle + duration + (panorama ? CAMERA.flyBack + CAMERA.panoramaHold : 0) + timing.gap;
      } else {
        /* --- 单站开通：只点亮一个点（固定特写缩放，不再推近） --- */
        tl.call(function () {
          Camera.snapTo(startPoint, targetZoom);
          self.beginStation(event);
          Scene.revealStandalone(event.stationKey);
          self.syncRevealedStats();
          self.applyHeader(event);
        }, null, landAt);
        var stationOverview = Camera.overviewTarget();
        if (stationOverview) {
          tl.call(function () {
            Camera.flyTo([stationOverview.center.lat, stationOverview.center.lng], stationOverview.zoom, {
              duration: CAMERA.flyBack,
              dip: 0
            });
          }, null, landAt + timing.stationHold);
        }
        cursor = landAt + timing.stationHold + (stationOverview ? CAMERA.flyBack : 0) + timing.gap;
      }
    });

    /* --- 收束：所有事件跑完后拉远到全览 --- */
    var overview = self.overviewTarget();
    if (overview) {
      tl.call(function () {
        self.prefetchOverview(overview.zoom);
        Camera.flyTo([overview.center.lat, overview.center.lng], overview.zoom, {
          duration: timing.outro,
          dip: 0.9
        });
      }, null, cursor);
    }
    tl.call(function () { self.finishAll(); }, null, cursor + timing.outro * 0.7);
    return tl;
  },

  /* ------------------------------------------------------------ 事件应用 */

  addHeaderFlip: function (tl, at, event) {
    var self = this;
    var dateText = $('#dateText');
    var lineHead = $('#lineHead');
    var statsPanel = $('#stats');
    var flip = STORY_TIMING.dateFlip;

    if (lineHead) tl.to(lineHead, { opacity: 0, y: -7, duration: 0.24, ease: 'power2.in' }, at);
    if (dateText) tl.to(dateText, {
      rotationX: -88,
      opacity: 0,
      transformOrigin: '50% 100%',
      duration: 0.26,
      ease: 'power2.in'
    }, at);
    if (statsPanel) tl.to(statsPanel, { opacity: 0.45, duration: 0.26, ease: 'power2.in' }, at);

    tl.call(function () { self.applyHeader(event); }, null, at + 0.26);

    if (dateText) {
      tl.fromTo(dateText, { rotationX: 88, opacity: 0 }, {
        rotationX: 0,
        opacity: 1,
        duration: 0.4,
        ease: 'power2.out',
        clearProps: 'transform'
      }, at + 0.26);
    }
    if (lineHead) tl.to(lineHead, { opacity: 1, y: 0, duration: 0.42, ease: 'power2.out' }, at + 0.28);
    if (statsPanel) tl.to(statsPanel, { opacity: 1, duration: 0.42, ease: 'power2.out' }, at + 0.28);
    return at + flip;
  },

  /** 顶栏 / 日期 / 数据面板切到当前事件 */
  applyHeader: function (event) {
    if (!event) return;
    var line = App.plan.lines[event.lineIndex];
    if (!line) return;
    if (event.type === 'line') {
      Scene.updateHeader(event.lineIndex);
      var dateEl = $('#dateText');
      if (dateEl) dateEl.textContent = event.dateText;
    } else {
      Scene.updateStationHeader(event.lineIndex, this.findStation(event.stationKey), event.dateText);
    }
    this.syncRevealedStats();
  },

  beginLine: function (event) {
    var line = App.plan.lines[event.lineIndex];
    if (!line) return;
    this.openedLines[event.lineIndex] = true;
    if (Scene.openedLineKeys) Scene.openedLineKeys[line.key] = true;
    var geometry = Scene.geometries[line.key];
    if (geometry && isFiniteNumber(geometry.totalMeters)) this.openedMeters += geometry.totalMeters;
    this.drawing = true;
    if (typeof RouteCanvas !== 'undefined') RouteCanvas.begin(App.plan.lines[event.lineIndex].key);
    Scene.setHeadVisible(event.lineIndex, true);
    var route = Scene.routes[line.key];
    if (route && geometry && geometry.render.length) {
      route.head.setLatLng(L.latLng(geometry.render[0][0], geometry.render[0][1]));
      route.head.setOpacity(1);
    }
    this.phase = event.lineIndex;
    this.applyHeader(event);
  },

  beginStation: function (event) {
    var line = App.plan.lines[event.lineIndex];
    if (!line) return;
    this.phase = event.lineIndex;
    this.openedStations[event.stationKey] = true;
    this.syncRevealedStats();
  },

  /** 面板上的站点数跟随「已点亮的点」变化 */
  syncRevealedStats: function () {
    var total = 0;
    var self = this;
    Object.keys(Scene.stations).forEach(function (key) {
      if (Scene.stations[key].state !== 'hidden') total += 1;
    });
    var lineCount = Object.keys(this.openedLines).length;
    var signature = lineCount + '/' + total + '/' + Math.round(this.openedMeters / 1000);
    if (signature === this.lastStats) return;
    this.lastStats = signature;
    Scene.applyStats({
      lines: lineCount,
      stations: total,
      km: Math.round(this.openedMeters / 1000)
    });
  },

  /* ------------------------------------------------------------ 几何工具 */

  findStation: function (stationKey) {
    var plan = App.plan;
    if (!plan) return null;
    for (var i = 0; i < plan.lines.length; i += 1) {
      for (var j = 0; j < plan.lines[i].stations.length; j += 1) {
        if (plan.lines[i].stations[j].key === stationKey) return plan.lines[i].stations[j];
      }
    }
    return null;
  },

  /** 渲染坐标下的线路起点 */
  lineStartPoint: function (lineIndex) {
    var line = App.plan.lines[lineIndex];
    var geometry = line ? Scene.geometries[line.key] : null;
    if (!geometry || !geometry.render.length) return [App.map.getCenter().lat, App.map.getCenter().lng];
    return geometry.render[0];
  },

  /** 线路实际长度（米）：仅用于诊断/埋点 */
  lineLength: function (lineIndex) {
    var line = App.plan.lines[lineIndex];
    var geometry = line ? Scene.geometries[line.key] : null;
    return geometry && isFiniteNumber(geometry.totalMeters) ? geometry.totalMeters : 0;
  },

  /** 事件开始前，预热即将进入视野的瓦片（±1 个层级），避免"边转边加载" */
  prefetchEvent: function (event, zoom) {
    if (typeof Basemap === 'undefined' || !Basemap.prefetch || !event) return;
    var line = App.plan.lines[event.lineIndex];
    var geometry = line ? Scene.geometries[line.key] : null;
    var points = [];

    if (event.type === 'line' && geometry) {
      points = geometry.render;
    } else {
      var node = Scene.stations[event.stationKey];
      if (node) {
        var latlng = node.marker.getLatLng();
        var pad = 0.018;
        points = [[latlng.lat - pad, latlng.lng - pad], [latlng.lat + pad, latlng.lng + pad]];
      }
    }
    if (!points.length) return;
    if (event.type === 'line' && geometry && Basemap.prefetchRoute) {
      // 沿线整条预取：跟拍时镜头沿线路缓慢平移，沿途瓦片必须提前到位
      Basemap.prefetchRoute(geometry, [zoom, zoom - 1]);
      return;
    }
    Basemap.prefetch(L.latLngBounds(points), [zoom - 1, zoom, zoom + 1]);
  },

  /** 收束到全览前预热整张网络 */
  prefetchOverview: function (zoom) {
    if (typeof Basemap === 'undefined' || !Basemap.prefetch) return;
    var points = [];
    Object.keys(Scene.geometries).forEach(function (key) {
      points = points.concat(Scene.geometries[key].render);
    });
    if (!points.length) return;
    Basemap.prefetch(L.latLngBounds(points), [zoom, zoom + 1]);
  },

  stationPoint: function (stationKey) {
    var node = Scene.stations[stationKey];
    if (!node) return [App.map.getCenter().lat, App.map.getCenter().lng];
    var latlng = node.marker.getLatLng();
    return [latlng.lat, latlng.lng];
  },

  /** 全览：统一用全景比例（与"拉回原比例"的收束保持一致） */
  overviewTarget: function () {
    var cameraOverview = typeof Camera !== 'undefined' ? Camera.overviewTarget() : null;
    if (cameraOverview) return cameraOverview;
    var self = this;
    var points = [];
    Object.keys(this.openedLines).forEach(function (index) {
      var line = App.plan.lines[Number(index)];
      var geometry = line ? Scene.geometries[line.key] : null;
      if (geometry) points = points.concat(geometry.render);
    });
    Object.keys(this.openedStations).forEach(function (key) {
      var node = Scene.stations[key];
      if (node) {
        var latlng = node.marker.getLatLng();
        points.push([latlng.lat, latlng.lng]);
      }
    });
    if (!points.length) {
      // 兜底：整张网络
      Object.keys(Scene.geometries).forEach(function (key) {
        points = points.concat(Scene.geometries[key].render);
      });
    }
    return Camera.fitTarget(points);
  },

  /** 收尾：顶栏停在最后一个事件，数据为全量 */
  finishAll: function () {
    var events = this.events;
    var last = events[events.length - 1];
    this.syncRevealedStats();
    if (last) {
      var line = App.plan.lines[last.lineIndex];
      if (line) {
        if (last.type === 'line') Scene.updateHeader(last.lineIndex);
        else Scene.updateStationHeader(last.lineIndex, this.findStation(last.stationKey), last.dateText);
      }
    }
    this.drawing = false;
    Scene.updateCredit();
    Scene.resolveLabelSides();
    Camera.active = false;
    if (typeof ZoomUI !== 'undefined') ZoomUI.setEnabled(true);
    this.finished = true;
    this.playing = false;
  },

  /** 兼容旧调用：结束态 */
  finish: function () {
    this.finishAll();
  },

  skip: function () {
    if (!this.tl || this.finished) return;
    // 跳过时不追中间构图（否则会瞬间连跨多个缩放层级、狂拉瓦片）
    if (typeof Camera !== 'undefined') Camera.active = false;
    this.tl.progress(1, false);
    var overview = this.overviewTarget();
    if (overview && typeof Camera !== 'undefined') {
      Camera.snapTo([overview.center.lat, overview.center.lng], overview.zoom);
    }
    if (typeof ZoomUI !== 'undefined') ZoomUI.setEnabled(true);
  },

  /* --------------------------------------------------------------- 复位 */

  reset: function () {
    killTimeline(this.tl);
    this.tl = null;
    this.playing = false;
    this.finished = false;
    this.phase = -1;
    this.events = [];
    this.openedLines = {};
    this.openedStations = {};
    this.openedMeters = 0;
    this.lastStats = '';
    this.drawing = false;
    Camera.active = false;
    Camera.suspended = false;
    if (typeof ZoomUI !== 'undefined') ZoomUI.setEnabled(true);

    var hud = [$('#dateText'), $('#lineHead'), $('#stats'), $('#timeCapsule'), $('#credit'), $('#replayBtn'), $('#skipBtn'), $('#controls'), $('#zoomCtl')];
    hud.forEach(function (el) {
      if (!el) return;
      killTweens(el);
      if (window.gsap) gsap.set(el, { clearProps: 'transform,opacity,visibility,transform-origin' });
      else el.removeAttribute('style');
    });

    var veil = $('#veil');
    if (veil) {
      killTweens(veil);
      veil.style.opacity = '1';
    }
  },

  stop: function () {
    if (typeof Camera !== 'undefined') Camera.active = false;
    killTimeline(this.tl);
    this.tl = null;
    this.playing = false;
    var veil = $('#veil');
    if (veil) {
      killTweens(veil);
      veil.style.opacity = '0';
    }
  },

  replay: function () {
    if (!App.plan) return;
    this.play();
  }
};
