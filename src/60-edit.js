/* ==========================================================================
   60 · 编辑模式
   - 进入：停止动画 → 解锁地图（保留双击缩放的禁用）→ 显示可编辑图层
   - 加站：点击地图追加到当前线末尾；同线 45m 内选中，另一线 90m 内吸附为换乘站
   - 拖动 / 改名 / 暂未开通 / 前移后移 / 删除 / 加入本线 / 恢复默认 / 清空本线
   - 持久化：按城市写入 localStorage（坐标始终为 WGS84）
   ========================================================================== */

var EDIT_NEAR_SAME_LINE_M = 45;      // 同线点击命中的吸附半径
var EDIT_NEAR_OTHER_LINE_M = 90;     // 跨线吸附为换乘站的半径
var EDIT_MIN_STATIONS = 2;           // 每条线路至少保留站点数

var Edit = {
  active: false,
  lineIndex: 0,
  selectedKey: null,
  group: null,
  routes: {},
  markers: {},
  clearArmedAt: 0,
  deleteLineArmed: 0,
  suppressMapClick: false,
  persistTimer: 0,

  /* -------------------------------------------------------------- 进入 */

  enter: function () {
    if (this.active || !App.plan) return;
    Story.stop();
    Scene.destroy();
    this.active = true;
    this.lineIndex = 0;
    this.selectedKey = null;
    document.body.classList.add('is-editing');
    setMapLocked(false);
    App.map.doubleClickZoom.disable();

    $('#editBar').classList.add('is-on');
    this.renderBar();
    this.rebuild();
    toast('点击地图追加站点，拖动站点调整位置');
  },

  /* -------------------------------------------------------------- 退出 */

  exit: function (silent) {
    if (!this.active) return;
    this.flushPersist();
    this.active = false;
    this.selectedKey = null;
    document.body.classList.remove('is-editing');
    this.destroyLayer();
    this.hideCard();
    $('#editBar').classList.remove('is-on');
    setMapLocked(true);
    if (silent) return;                     // 切换城市等场景由调用方接管重建
    Scene.build(App.plan);
    Scene.updateHeader(Math.min(this.lineIndex, App.plan.lines.length - 1));
    Scene.updateStats(App.plan.lines.map(function (_, index) { return index; }));
    Scene.updateCredit();
  },

  /** 完成并播放：校验通过后退出编辑并从头播放 */
  done: function () {
    var invalid = this.firstInvalidLine();
    if (invalid) {
      toast(invalid);
      return;
    }
    this.exit();
    Story.play();
  },

  firstInvalidLine: function () {
    if (!App.plan) return '当前没有可用方案';
    var playable = 0;
    for (var i = 0; i < App.plan.lines.length; i += 1) {
      var line = App.plan.lines[i];
      if (line.stations.length === 0) continue;              // 空线路忽略，不阻塞播放
      if (line.stations.length < EDIT_MIN_STATIONS) {
        return line.name + '只有 ' + line.stations.length + ' 站，每条线路至少保留 ' + EDIT_MIN_STATIONS + ' 站（或清空该线）';
      }
      playable += 1;
    }
    if (!playable) return '至少需要一条线路有 ' + EDIT_MIN_STATIONS + ' 站以上才能播放';
    return '';
  },

  /* ------------------------------------------------------- 图层重建 */

  rebuild: function () {
    this.destroyLayer();
    if (!this.active || !App.plan) return;
    this.refreshPlanSides();

    var self = this;
    this.group = L.layerGroup().addTo(App.map);
    this.routes = {};
    this.markers = {};

    // 线路（当前线高亮，其余线弱化）
    App.plan.lines.forEach(function (line, index) {
      var geometry = buildLineGeometry(line.stations, function (lat, lng) {
        var point = Basemap.project(lat, lng);
        return [point[0], point[1]];
      });
      var active = index === self.lineIndex;
      var style = lineTypeStyle(line.type);
      var common = { interactive: false, lineCap: 'round', lineJoin: 'round' };
      var glow = L.polyline(geometry.render, Object.assign({}, common, {
        color: line.color, weight: style.glowWeight, opacity: active ? 0.1 : 0.05, className: 'route-layer route-glow'
      }));
      var casing = L.polyline(geometry.render, Object.assign({}, common, {
        color: '#ffffff', weight: style.casingWeight, opacity: active ? 0.96 : 0.6, className: 'route-layer route-casing'
      }));
      var main = L.polyline(geometry.render, Object.assign({}, common, {
        color: line.color,
        weight: style.weight,
        opacity: active ? 1 : 0.4,
        dashArray: style.dashArray || null,
        lineCap: style.dashArray ? 'butt' : 'round',
        className: 'route-layer route-main route-type-' + (line.type || 'metro')
      }));
      glow.addTo(self.group);
      casing.addTo(self.group);
      main.addTo(self.group);
      self.routes[line.key] = { glow: glow, casing: casing, main: main };
    });

    // 站点（同 key 只画一个；城际服务站带特殊标识）
    var keyInfo = {};
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        var info = keyInfo[station.key];
        if (!info) info = keyInfo[station.key] = { types: {}, count: 0 };
        info.types[line.type || 'metro'] = true;
        info.count += 1;
      });
    });

    var seen = {};
    App.plan.lines.forEach(function (line, lineIndex) {
      line.stations.forEach(function (station, stationIndex) {
        if (seen[station.key]) return;
        seen[station.key] = true;
        var info = keyInfo[station.key] || { types: { metro: true }, count: 1 };
        // 暂未开通是更强的状态：即使是换乘站，未开通时先按 ghost 展示
        var state = station.ghost ? 'ghost' : (info.count > 1 ? 'transfer' : 'opened');
        var marker = createStationMarker(station, line, {
          state: state,
          numberText: formatStationNumber(stationIndex + 1),
          draggable: true,
          transferColors: transferColorVars(App.plan, station.key),
          hasRail: !!info.types.intercity,
          isRailOnly: !!info.types.intercity && !info.types.metro
        });
        marker.addTo(self.group);
        marker.on('dragstart', function () { self.suppressMapClick = true; });
        marker.on('dragend', function () { self.onStationDragged(station.key, marker); });
        marker.on('click', function (event) {
          if (event && event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          self.select(station.key);
        });
        self.markers[station.key] = marker;
      });
    });

    this.applySelection();
    this.resolveLabelSides();
  },

  /** 编辑态同样做一次标签避让，避免新加的站名互相压盖 */
  resolveLabelSides: function () {
    var self = this;
    var list = Object.keys(this.markers).map(function (key) {
      var marker = self.markers[key];
      var el = marker.getElement();
      if (!el) return null;
      return {
        station: findStationEverywhere(App.plan, key),
        marker: marker,
        stEl: el.querySelector('.st'),
        labelInnerEl: el.querySelector('.st-label-inner')
      };
    }).filter(Boolean);
    resolveLabelSidesFor(App.map, list);
  },

  destroyLayer: function () {
    if (this.group) {
      try { App.map.removeLayer(this.group); } catch (err) { /* noop */ }
      try { this.group.clearLayers(); } catch (err) { /* noop */ }
    }
    this.group = null;
    this.routes = {};
    this.markers = {};
  },

  refreshPlanSides: function () {
    (App.plan ? App.plan.lines : []).forEach(function (line) {
      var points = line.stations.map(function (station) { return [station.lat, station.lng]; });
      line.stations.forEach(function (station, index) {
        station.side = autoLabelSide(points, index);
      });
    });
    // 同 key 的标签方向保持一致，避免同一站两条线标签朝不同方向
    var sideByKey = {};
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        if (!sideByKey[station.key]) sideByKey[station.key] = station.side;
        else station.side = sideByKey[station.key];
      });
    });
  },

  /* --------------------------------------------------------- 交互逻辑 */

  /** 地图点击：命中已有站 → 选中；跨线附近 → 吸附换乘；否则追加新站 */
  onMapClick: function (event) {
    if (!this.active || !App.plan) return;
    if (this.suppressMapClick) { this.suppressMapClick = false; return; }
    var wgs = Basemap.unproject(event.latlng.lat, event.latlng.lng);
    var point = [wgs[0], wgs[1]];
    var line = App.plan.lines[this.lineIndex];
    if (!line) return;

    var sameLineHit = findStationWithin(line.stations, point, EDIT_NEAR_SAME_LINE_M);
    if (sameLineHit) {
      this.select(sameLineHit.key);
      toast('已选中「' + sameLineHit.name + '」');
      return;
    }

    var otherHit = null;
    for (var i = 0; i < App.plan.lines.length; i += 1) {
      if (i === this.lineIndex) continue;
      var hit = findStationWithin(App.plan.lines[i].stations, point, EDIT_NEAR_OTHER_LINE_M);
      if (hit) { otherHit = hit; break; }
    }

    if (otherHit) {
      var already = line.stations.some(function (station) { return station.key === otherHit.key; });
      if (!already) {
        line.stations.push({
          key: otherHit.key,
          name: otherHit.name,
          lat: otherHit.lat,
          lng: otherHit.lng,
          side: '',
          ghost: false,
          shared: true,
          terminal: false
        });
        markStationShared(App.plan, otherHit.key, true);
      }
      this.selectedKey = otherHit.key;
      this.rebuild();
      this.syncCard();
      this.persist();
      toast('已与「' + otherHit.name + '」设为换乘站');
      return;
    }

    var newStation = {
      key: nextStationKey(App.plan),
      name: defaultStationName(App.plan, line),
      lat: point[0],
      lng: point[1],
      side: '',
      ghost: false,
      shared: false,
      terminal: false
    };
    line.stations.push(newStation);
    this.selectedKey = newStation.key;
    this.rebuild();
    this.syncCard();
    this.persist();
  },

  onStationDragged: function (key, marker) {
    var position = marker.getLatLng();
    var wgs = Basemap.unproject(position.lat, position.lng);
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        if (station.key !== key) return;
        station.lat = wgs[0];
        station.lng = wgs[1];
      });
    });
    this.rebuild();
    this.syncCard();
    this.persist();
    window.setTimeout(function () { Edit.suppressMapClick = false; }, 120);
  },

  select: function (key) {
    this.selectedKey = key;
    this.applySelection();
    this.syncCard();
  },

  applySelection: function () {
    var self = this;
    Object.keys(this.markers).forEach(function (key) {
      var marker = self.markers[key];
      var el = marker.getElement();
      var st = el ? el.querySelector('.st') : null;
      if (!st) return;
      st.classList.toggle('is-selected', key === self.selectedKey);
    });
  },

  /* ------------------------------------------------------------ 操作 */

  selectLine: function (index) {
    if (index === this.lineIndex) return;
    this.lineIndex = clamp(index, 0, App.plan.lines.length - 1);
    this.selectedKey = null;
    this.renderBar();
    this.rebuild();
    this.syncCard();
  },

  rename: function (value) {
    if (!this.selectedKey) return;
    var name = String(value || '').slice(0, 24);
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        if (station.key === Edit.selectedKey) station.name = name;
      });
    });
    var marker = this.markers[this.selectedKey];
    if (marker) {
      var label = marker.getElement() ? marker.getElement().querySelector('.st-name') : null;
      if (label) label.textContent = name;        // 直接写 textContent，避免输入过程重绘丢焦点
    }
    this.persist();
  },

  toggleGhost: function (checked) {
    if (!this.selectedKey) return;
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        if (station.key === Edit.selectedKey) station.ghost = !!checked;
      });
    });
    this.rebuild();
    this.applySelection();
    this.persist();
  },

  move: function (delta) {
    if (!this.selectedKey) return;
    var line = App.plan.lines[this.lineIndex];
    var index = indexOfStation(line.stations, this.selectedKey);
    if (index < 0) return;
    var next = index + delta;
    if (next < 0 || next >= line.stations.length) {
      toast(delta < 0 ? '已经是首站' : '已经是末站');
      return;
    }
    var moved = line.stations.splice(index, 1)[0];
    line.stations.splice(next, 0, moved);
    this.rebuild();
    this.applySelection();
    this.syncCard();
    this.persist();
  },

  remove: function () {
    if (!this.selectedKey) return;
    var line = App.plan.lines[this.lineIndex];
    var index = indexOfStation(line.stations, this.selectedKey);
    if (index < 0) return;
    if (line.stations.length <= EDIT_MIN_STATIONS) {
      toast('每条线路至少保留 ' + EDIT_MIN_STATIONS + ' 站');
      return;
    }
    // 只从当前线路移除；若该站仍被其它线路引用，则保留为换乘站
    line.stations.splice(index, 1);
    this.refreshSharedFlags();
    this.selectedKey = null;
    this.rebuild();
    this.syncCard();
    this.persist();
  },

  /** 把选中站点加入当前线路（两端已有则复用换乘站） */
  joinCurrentLine: function () {
    if (!this.selectedKey) return;
    var line = App.plan.lines[this.lineIndex];
    if (indexOfStation(line.stations, this.selectedKey) >= 0) {
      toast('该站已在当前线路上');
      return;
    }
    var source = findStationEverywhere(App.plan, this.selectedKey);
    if (!source) return;
    line.stations.push({
      key: source.key,
      name: source.name,
      lat: source.lat,
      lng: source.lng,
      side: '',
      ghost: false,
      shared: true,
      terminal: false
    });
    markStationShared(App.plan, source.key, true);
    this.rebuild();
    this.applySelection();
    this.syncCard();
    this.persist();
    toast('已加入本线，并与原线路共用该站');
  },

  restoreDefault: function () {
    var defaults = createDefaultPlan(App.plan.cityId);
    if (!defaults) {
      toast('该城市没有可恢复的默认方案');
      return;
    }
    App.plan = defaults;
    clearSavedPlan(defaults.cityId);
    this.lineIndex = 0;
    this.selectedKey = null;
    this.renderBar();
    this.rebuild();
    this.hideCard();
    toast('已恢复默认方案');
  },

  clearLine: function () {
    var now = Date.now();
    if (now - this.clearArmedAt > 2600) {
      this.clearArmedAt = now;
      toast('再次点击「清空本线」以确认');
      return;
    }
    this.clearArmedAt = 0;
    var line = App.plan.lines[this.lineIndex];
    line.stations.length = 0;
    this.selectedKey = null;
    this.rebuild();
    this.hideCard();
    this.persist();
    toast(line.name + '已清空，点击地图添加站点');
  },

  /* ------------------------------------------------------ 工具条 / 卡片 */

  renderBar: function () {
    var bar = $('#editBar');
    if (!bar || !App.plan) return;
    var self = this;
    var lineButtons = App.plan.lines.map(function (line, index) {
      var rail = (line.type || 'metro') === 'intercity';
      return '<button class="bar-line" data-act="line" data-index="' + index + '"' +
        (index === self.lineIndex ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        '<i class="' + (rail ? 'is-rail' : '') + '" style="--line-color:' + escapeHtml(line.color) + '"></i>' +
        escapeHtml(line.name) +
        '</button>';
    }).join('');
    var canAdd = App.plan.lines.length < 8;
    bar.innerHTML = '' +
      '<div class="bar-group bar-lines">' + lineButtons + '</div>' +
      '<div class="bar-group">' +
        (canAdd ? '<button data-act="add-metro" title="新建地铁线路">＋地铁</button>' : '') +
        (canAdd ? '<button data-act="add-intercity" title="新建城际铁路">＋城际</button>' : '') +
        '<button data-act="delete-line" title="删除当前线路">删除本线</button>' +
      '</div>' +
      '<div class="bar-group">' +
        '<button data-act="reset">恢复默认</button>' +
        '<button data-act="clear">清空本线</button>' +
      '</div>' +
      '<button class="bar-primary" data-act="done">完成并播放</button>';
  },

  /** 新建线路（地铁 / 城际），默认追加到列表末尾并切换过去 */
  addLine: function (type) {
    var plan = App.plan;
    if (!plan) return;
    if (plan.lines.length >= 8) { toast('最多支持 8 条线路'); return; }
    var typeKey = type === 'intercity' ? 'intercity' : 'metro';
    var used = plan.lines.map(function (line) { return line.color; });
    var seq = plan.lines.filter(function (line) { return (line.type || 'metro') === typeKey; }).length + 1;
    var line = {
      key: plan.cityId + '-n' + Date.now().toString(36),
      badge: typeKey === 'intercity' ? '城际' : String(seq),
      name: typeKey === 'intercity' ? (seq > 1 ? '城际铁路 ' + seq : '城际铁路') : seq + ' 号线',
      color: nextLineColor(used),
      type: typeKey,
      dateText: '—',
      status: typeKey === 'intercity' ? '开通运营' : '试运行',
      stations: []
    };
    plan.lines.push(line);
    this.lineIndex = plan.lines.length - 1;
    this.selectedKey = null;
    this.refreshSharedFlags();
    this.renderBar();
    this.rebuild();
    this.hideCard();
    this.persist();
    toast('已新建「' + line.name + '」，点击地图添加站点');
  },

  /** 删除当前线路（二次点击确认，至少保留一条） */
  deleteLine: function () {
    var plan = App.plan;
    if (!plan) return;
    if (plan.lines.length <= 1) { toast('至少保留 1 条线路'); return; }
    var now = Date.now();
    if (now - this.deleteLineArmed > 2600) {
      this.deleteLineArmed = now;
      toast('再次点击「删除本线」以确认');
      return;
    }
    this.deleteLineArmed = 0;
    var removed = plan.lines.splice(this.lineIndex, 1)[0];
    this.lineIndex = clamp(this.lineIndex, 0, plan.lines.length - 1);
    this.selectedKey = null;
    this.refreshSharedFlags();
    this.renderBar();
    this.rebuild();
    this.hideCard();
    this.persist();
    toast('已删除「' + (removed ? removed.name : '线路') + '」');
  },

  /** 换乘标记随线路变化重算，保证存档与视觉一致 */
  refreshSharedFlags: function () {
    if (!App.plan) return;
    var counts = {};
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        counts[station.key] = (counts[station.key] || 0) + 1;
      });
    });
    App.plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        station.shared = counts[station.key] > 1;
      });
    });
  },

  syncCard: function () {
    var card = $('#editCard');
    if (!card) return;
    if (!this.active || !this.selectedKey || !App.plan) {
      this.hideCard();
      return;
    }
    var line = App.plan.lines[this.lineIndex];
    if (!line) { this.hideCard(); return; }
    var index = indexOfStation(line.stations, this.selectedKey);
    var station = index >= 0 ? line.stations[index] : findStationEverywhere(App.plan, this.selectedKey);
    if (!station) { this.hideCard(); return; }

    var inCurrentLine = index >= 0;
    var occurrences = countStationOccurrences(App.plan, station.key);
    var lineName = line.name;
    var ownerLine = findLineOfStation(App.plan, station.key);

    card.innerHTML = '' +
      '<div class="card-head">' +
        '<span class="card-index">' + escapeHtml(inCurrentLine ? formatStationNumber(index + 1) : '--') + '</span>' +
        '<span class="card-line"><i style="--line-color:' + escapeHtml(ownerLine ? ownerLine.color : line.color) + '"></i>' +
          escapeHtml(ownerLine ? ownerLine.name : lineName) + '</span>' +
        (occurrences > 1 ? '<span class="card-tag">换乘站</span>' : '') +
        '<button class="card-close" data-act="close" aria-label="收起">×</button>' +
      '</div>' +
      '<label class="card-field">' +
        '<span>站名</span>' +
        '<input type="text" data-act="name" maxlength="24" value="' + escapeHtml(station.name) + '" />' +
      '</label>' +
      '<label class="card-check">' +
        '<input type="checkbox" data-act="ghost"' + (station.ghost ? ' checked' : '') + ' />' +
        '<span>暂未开通</span>' +
      '</label>' +
      (inCurrentLine ? '' : '<button class="card-btn card-join" data-act="join">加入本线（设为换乘站）</button>') +
      '<div class="card-actions">' +
        '<button class="card-btn" data-act="up"' + (inCurrentLine ? '' : ' disabled') + '>前移</button>' +
        '<button class="card-btn" data-act="down"' + (inCurrentLine ? '' : ' disabled') + '>后移</button>' +
        '<button class="card-btn card-danger" data-act="delete"' + (inCurrentLine ? '' : ' disabled') + '>删除</button>' +
      '</div>';

    card.classList.add('is-on');
  },

  hideCard: function () {
    var card = $('#editCard');
    if (!card) return;
    card.classList.remove('is-on');
    card.innerHTML = '';
  },

  /* --------------------------------------------------------- 持久化 */

  persist: function () {
    var self = this;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(function () {
      if (App.plan) savePlan(App.plan);
    }, 160);
  },

  flushPersist: function () {
    window.clearTimeout(this.persistTimer);
    if (App.plan) savePlan(App.plan);
  }
};

/* --------------------------------------------------------- 编辑辅助函数 */

function indexOfStation(stations, key) {
  for (var i = 0; i < stations.length; i += 1) {
    if (stations[i].key === key) return i;
  }
  return -1;
}

function findStationWithin(stations, point, maxMeters) {
  var best = null;
  var bestDistance = Infinity;
  stations.forEach(function (station) {
    var distance = haversineMeters([station.lat, station.lng], point);
    if (distance <= maxMeters && distance < bestDistance) {
      best = station;
      bestDistance = distance;
    }
  });
  return best;
}

function findStationEverywhere(plan, key) {
  for (var i = 0; i < plan.lines.length; i += 1) {
    var line = plan.lines[i];
    for (var j = 0; j < line.stations.length; j += 1) {
      if (line.stations[j].key === key) return line.stations[j];
    }
  }
  return null;
}

function findLineOfStation(plan, key) {
  for (var i = 0; i < plan.lines.length; i += 1) {
    if (indexOfStation(plan.lines[i].stations, key) >= 0) return plan.lines[i];
  }
  return null;
}

function countStationOccurrences(plan, key) {
  var count = 0;
  plan.lines.forEach(function (line) {
    line.stations.forEach(function (station) {
      if (station.key === key) count += 1;
    });
  });
  return count;
}

function markStationShared(plan, key, shared) {
  plan.lines.forEach(function (line) {
    line.stations.forEach(function (station) {
      if (station.key === key) station.shared = !!shared;
    });
  });
}

function nextStationKey(plan) {
  var used = {};
  plan.lines.forEach(function (line) {
    line.stations.forEach(function (station) { used[station.key] = true; });
  });
  var index = 1;
  var key = '';
  do {
    key = plan.cityId + '-s' + index;
    index += 1;
  } while (used[key]);
  return key;
}

function defaultStationName(plan, line) {
  var total = 0;
  plan.lines.forEach(function (item) { total += item.stations.length; });
  return '新站' + (total + 1);
}
