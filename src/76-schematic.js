/* ==========================================================================
   76 · 线网示意图（RMP / schematic）渲染引擎
   —— 不叠地理底图：把 WGS84 地理线路「自动派生」为八方向示意图
      （横 / 竖 / 45°、等距站点、换乘站合点、标签避让），
      纯 SVG + DOM 绘制，缩放靠 CSS transform，天然 60fps、可离线、可逐帧导出。

   入口：?engine=schematic（或 ?engine=rmp / schematic）
   数据源：App.plan（经纬度仍是唯一真相，编辑后调用 Schematic.rebuild() 重新派生）
   ========================================================================== */

var SCHEMATIC = {
  unit: 64,              // 相邻站点的基准间距（示意图单位）
  minUnit: 50,           // 最短站间距（字号放大后留出标签空间）
  maxUnit: 118,          // 最长站间距
  iterations: 240,       // 八方向松弛迭代次数
  labelGap: 18,          // 标签与圆点的距离（与 CSS 中 16px 字号匹配）
  focusGain: 2.15,       // 特写倍率 = 全景 × 该值
  travel: 1.5,
  maxLabelAttempts: 8
};

var Schematic = {
  root: null,
  svg: null,
  nodesLayer: null,
  plan: null,
  layout: null,
  nodes: {},
  lines: {},
  events: [],
  timeline: null,
  running: false,
  phase: 'idle',
  scale: 1,               // 当前视口缩放（>1 放大）
  targetScale: 1,
  offset: { x: 0, y: 0 },
  targetOffset: { x: 0, y: 0 },
  panoramaScale: 1,
  focusScale: 2.15,
  rafId: 0,
  startedAt: 0,

  /* --------------------------------------------------------------- 入口 */

  start: function () {
    if (this.root) return true;
    var host = document.getElementById('scMap');
    if (!host) return false;
    var plan = App.plan;
    if (!plan || !plan.lines || !plan.lines.length) return false;

    var mapEl = document.getElementById('map');
    var mlEl = document.getElementById('mlMap');
    if (mapEl) mapEl.style.display = 'none';
    if (mlEl) mlEl.style.display = 'none';
    host.style.display = 'block';
    host.setAttribute('aria-hidden', 'false');

    this.root = host;
    this.root.innerHTML = '<div class="sc-stage"><svg class="sc-svg" xmlns="http://www.w3.org/2000/svg"></svg><div class="sc-nodes"></div></div>';
    this.stage = this.root.querySelector('.sc-stage');
    this.svg = this.root.querySelector('.sc-svg');
    this.nodesLayer = this.root.querySelector('.sc-nodes');

    this.rebuild();
    this.bindCameraLoop();

    var veil = document.getElementById('veil');
    if (veil) veil.style.opacity = '0';
    var self = this;
    window.setTimeout(function () { self.play(); }, 400);
    return true;
  },

  /** 退出示意图：恢复地理视图并重新播放（顶栏按钮用） */
  stop: function () {
    if (!this.root) return false;
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    this.running = false;
    this.finished = false;
    this.phase = 'idle';
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.root.style.display = 'none';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = '';
    this.root = null;
    this.stage = null;
    this.svg = null;
    this.nodesLayer = null;
    this.nodes = {};
    this.lines = {};
    this.layout = null;

    var mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.display = '';
    if (typeof App !== 'undefined') App.engine = 'leaflet';
    if (typeof Story !== 'undefined') Story.replay();
    return true;
  },

  /** 编辑完成后重新派生示意图（数据变了就重排 + 重绘） */
  rebuild: function () {
    if (!this.root) return false;
    var plan = App.plan;
    if (!plan || !plan.lines || !plan.lines.length) return false;
    this.plan = plan;
    this.layout = this.computeLayout(plan);
    this.render();
    this.fitPanorama();
    this.computeEvents();
    return true;
  },

  /* --------------------------------------------------------- 布局（核心） */

  /**
   * 由经纬度派生八方向示意图布局。
   * 1) 每条线独立八方向化：从起点出发，方向吸附到 45° 整数倍，长度按真实距离成比例，
   *    这样每条线的所有线段都严格落在 8 个方向上；
   * 2) 求每条线的平移量，让换乘站尽量重合（最小二乘迭代，平移不破坏方向）；
   * 3) 缩放到视口，令"全景 = 1 倍缩放"，站点 DOM 尺寸才是真实像素；
   * 4) 标签方位：按相邻线段方向与重叠情况自动择优。
   */
  computeLayout: function (plan) {
    var unit = SCHEMATIC.unit;
    var minUnit = SCHEMATIC.minUnit;
    var maxUnit = SCHEMATIC.maxUnit;

    /* ---------- 1) 每条线：方向吸附到 45°，段长按真实距离成比例 ---------- */
    var geoMaxLen = 0;
    var rawShapes = plan.lines.map(function (line) {
      var latSum = 0;
      line.stations.forEach(function (station) { latSum += station.lat; });
      var lat0 = latSum / Math.max(1, line.stations.length);
      var kx = Math.cos((lat0 * Math.PI) / 180);
      var segs = [];
      for (var i = 1; i < line.stations.length; i += 1) {
        var prev = line.stations[i - 1];
        var next = line.stations[i];
        var dxGeo = (next.lng - prev.lng) * kx;
        var dyGeo = -(next.lat - prev.lat);
        var lenGeo = Math.hypot(dxGeo, dyGeo);
        var angle = lenGeo > 1e-9 ? Math.atan2(dyGeo, dxGeo) : -Math.PI / 2;
        var snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        segs.push({ dir: { x: Math.cos(snapped), y: Math.sin(snapped) }, lenGeo: lenGeo });
        geoMaxLen = Math.max(geoMaxLen, lenGeo);
      }
      return { line: line, segs: segs };
    });

    var lineShapes = rawShapes.map(function (raw) {
      var dirs = [];
      var lens = [];
      var targetLens = [];
      raw.segs.forEach(function (seg) {
        var share = geoMaxLen > 1e-12 ? seg.lenGeo / geoMaxLen : 0.5;
        var target = minUnit + (maxUnit - minUnit) * Math.min(1, share);
        dirs.push(seg.dir);
        targetLens.push(target);
        lens.push(target);
      });
      return { line: raw.line, dirs: dirs, lens: lens, targetLens: targetLens, offset: { x: 0, y: 0 } };
    });

    var shapePosition = function (shape, stationIndex) {
      var x = shape.offset.x;
      var y = shape.offset.y;
      for (var i = 0; i < stationIndex; i += 1) {
        x += shape.dirs[i].x * shape.lens[i];
        y += shape.dirs[i].y * shape.lens[i];
      }
      return { x: x, y: y };
    };

    /* ---------- 2) 联合拟合：只调"段长 + 整体平移"，方向永远保持 45° ---------- */
    var stationOwners = {};
    lineShapes.forEach(function (shape, lineIndex) {
      shape.line.stations.forEach(function (station, stationIndex) {
        if (!stationOwners[station.key]) stationOwners[station.key] = [];
        stationOwners[station.key].push({ lineIndex: lineIndex, stationIndex: stationIndex });
      });
    });

    var fitIterations = 260;
    for (var fit = 0; fit < fitIterations; fit += 1) {
      var alpha = 0.16 * (1 - fit / fitIterations * 0.7);

      // 以"站点最多"的线作为形状基准：其它线向共享站点的平均位置靠拢
      Object.keys(stationOwners).forEach(function (key) {
        var owners = stationOwners[key];
        if (owners.length < 2) return;
        var cx = 0;
        var cy = 0;
        owners.forEach(function (owner) {
          var point = shapePosition(lineShapes[owner.lineIndex], owner.stationIndex);
          cx += point.x;
          cy += point.y;
        });
        cx /= owners.length;
        cy /= owners.length;

        // 每一处出现都朝平均值靠拢：平移 + 调整它前面各段的长度
        owners.forEach(function (owner) {
          var shape = lineShapes[owner.lineIndex];
          var point = shapePosition(shape, owner.stationIndex);
          var ex = cx - point.x;
          var ey = cy - point.y;
          shape.offset.x += ex * alpha * 0.7;
          shape.offset.y += ey * alpha * 0.7;
          var count = Math.max(1, owner.stationIndex);
          for (var i = 0; i < owner.stationIndex; i += 1) {
            var u = shape.dirs[i];
            var projection = (ex * u.x + ey * u.y) / count;
            var next = shape.lens[i] + projection * alpha;
            shape.lens[i] = Math.max(minUnit, Math.min(maxUnit, next));
          }
        });
      });

      // 线路之间互斥：两条线的站点靠得太近时，把整条线推开（只平移，方向不变）
      for (var la = 0; la < lineShapes.length; la += 1) {
        for (var lb = la + 1; lb < lineShapes.length; lb += 1) {
          var shapeA = lineShapes[la];
          var shapeB = lineShapes[lb];
          var minGap = minUnit * 0.42;
          var closest = null;
          for (var ia = 0; ia < shapeA.line.stations.length; ia += 1) {
            var pa = shapePosition(shapeA, ia);
            for (var ib = 0; ib < shapeB.line.stations.length; ib += 1) {
              // 同一个换乘站不参与互斥（那正是要对齐的目标）
              if (shapeA.line.stations[ia].key === shapeB.line.stations[ib].key) continue;
              var pb = shapePosition(shapeB, ib);
              var dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
              if (dist < 1e-6) continue;
              if (!closest || dist < closest.dist) {
                closest = { dist: dist, x: (pb.x - pa.x) / dist, y: (pb.y - pa.y) / dist };
              }
            }
          }
          if (closest && closest.dist < minGap) {
            var pushAway = (minGap - closest.dist) * 0.12;
            shapeA.offset.x -= closest.x * pushAway;
            shapeA.offset.y -= closest.y * pushAway;
            shapeB.offset.x += closest.x * pushAway;
            shapeB.offset.y += closest.y * pushAway;
          }
        }
      }

      // 拉回地理比例：段长始终朝"真实距离成比例"的目标靠拢，避免走向被拟合拉扯变形
      lineShapes.forEach(function (shape) {
        for (var i = 0; i < shape.lens.length; i += 1) {
          shape.lens[i] += (shape.targetLens[i] - shape.lens[i]) * 0.06;
        }
      });
    }

    // 收尾：只做「换乘站对齐」，不再互斥，把拼缝收紧
    for (var polish = 0; polish < 40; polish += 1) {
      Object.keys(stationOwners).forEach(function (key) {
        var owners = stationOwners[key];
        if (owners.length < 2) return;
        var cx = 0;
        var cy = 0;
        owners.forEach(function (owner) {
          var point = shapePosition(lineShapes[owner.lineIndex], owner.stationIndex);
          cx += point.x;
          cy += point.y;
        });
        cx /= owners.length;
        cy /= owners.length;
        owners.forEach(function (owner) {
          var shape = lineShapes[owner.lineIndex];
          var point = shapePosition(shape, owner.stationIndex);
          shape.offset.x += (cx - point.x) * 0.12;
          shape.offset.y += (cy - point.y) * 0.22;
        });
      });
    }

    // 间距修复：不同线路的站点靠得过近时，把整条线平移推开（方向不受影响）
    for (var repair = 0; repair < 90; repair += 1) {
      var repaired = true;
      for (var ra = 0; ra < lineShapes.length; ra += 1) {
        for (var rb = ra + 1; rb < lineShapes.length; rb += 1) {
          var shapeA2 = lineShapes[ra];
          var shapeB2 = lineShapes[rb];
          var minGap2 = minUnit * 0.62;
          var closest2 = null;
          for (var ia2 = 0; ia2 < shapeA2.line.stations.length; ia2 += 1) {
            var pa2 = shapePosition(shapeA2, ia2);
            for (var ib2 = 0; ib2 < shapeB2.line.stations.length; ib2 += 1) {
              if (shapeA2.line.stations[ia2].key === shapeB2.line.stations[ib2].key) continue;
              var pb2 = shapePosition(shapeB2, ib2);
              var dist2 = Math.hypot(pb2.x - pa2.x, pb2.y - pa2.y);
              if (dist2 < 1e-6) continue;
              if (!closest2 || dist2 < closest2.dist) {
                closest2 = { dist: dist2, x: (pb2.x - pa2.x) / dist2, y: (pb2.y - pa2.y) / dist2 };
              }
            }
          }
          if (closest2 && closest2.dist < minGap2) {
            var push2 = (minGap2 - closest2.dist) * 0.35;
            shapeA2.offset.x -= closest2.x * push2;
            shapeA2.offset.y -= closest2.y * push2;
            shapeB2.offset.x += closest2.x * push2;
            shapeB2.offset.y += closest2.y * push2;
            repaired = false;
          }
        }
      }
      if (repaired) break;
    }

    /* ---------- 3) 汇总站点坐标 ---------- */
    var nodes = {};
    var order = [];
    Object.keys(stationOwners).forEach(function (key) {
      var owners = stationOwners[key];
      var cx = 0;
      var cy = 0;
      owners.forEach(function (entry) {
        var point = shapePosition(lineShapes[entry.lineIndex], entry.stationIndex);
        cx += point.x;
        cy += point.y;
      });
      var sample = owners[0];
      var station = plan.lines[sample.lineIndex].stations[sample.stationIndex];
      // 站点位置取"线路最长的那条线"的落点：主干线保持严格八方向，其它线只在换乘处轻微贴合
      var primary = owners[0];
      owners.forEach(function (entry) {
        if (plan.lines[entry.lineIndex].stations.length > plan.lines[primary.lineIndex].stations.length) primary = entry;
      });
      var anchorPoint = shapePosition(lineShapes[primary.lineIndex], primary.stationIndex);
      nodes[key] = {
        key: key,
        name: station.name,
        lat: station.lat,
        lng: station.lng,
        lineKeys: owners.map(function (entry) { return plan.lines[entry.lineIndex].key; }),
        x: anchorPoint.x,
        y: anchorPoint.y,
        labelSide: 'bottom'
      };
      void cx;
      void cy;
      order.push(key);
    });

    var linePaths = lineShapes.map(function (shape) {
      var points = shape.line.stations.map(function (station, stationIndex) {
        return shapePosition(shape, stationIndex);
      });
      var cumulative = [0];
      var total = 0;
      for (var k = 1; k < points.length; k += 1) {
        total += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
        cumulative.push(total);
      }
      return {
        line: shape.line,
        points: points,
        cumulative: cumulative,
        total: total,
        stationRatio: cumulative.map(function (value) { return total > 1e-6 ? value / total : 0; })
      };
    });

    // 每条线严格穿过站点中心，并在需要处插入 90°/45° 折角 —— 保证所有线段都落在 8 个方向上
    var isOctilinear = function (dx, dy) {
      var eps = 0.75;
      if (Math.abs(dx) < eps || Math.abs(dy) < eps) return true;
      return Math.abs(Math.abs(dx) - Math.abs(dy)) < eps;
    };

    linePaths.forEach(function (entry) {
      var stations = entry.line.stations.map(function (station) {
        var node = nodes[station.key];
        return { x: node.x, y: node.y };
      });
      var points = [stations[0]];
      var stationIndices = [0];
      for (var i = 1; i < stations.length; i += 1) {
        var a = stations[i - 1];
        var b = stations[i];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        if (!isOctilinear(dx, dy) && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
          var elbow;
          if (Math.abs(dx) >= Math.abs(dy)) {
            elbow = { x: b.x - Math.sign(dx) * Math.abs(dy), y: a.y };
          } else {
            elbow = { x: a.x, y: b.y - Math.sign(dy) * Math.abs(dx) };
          }
          points.push(elbow);
        }
        points.push(b);
        stationIndices.push(points.length - 1);
      }

      var cumulative = [0];
      var total = 0;
      for (var k = 1; k < points.length; k += 1) {
        total += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
        cumulative.push(total);
      }
      entry.points = points;
      entry.stationIndices = stationIndices;
      entry.total = total;
      entry.cumulative = cumulative;
      entry.stationRatio = stationIndices.map(function (index) {
        return total > 1e-6 ? cumulative[index] / total : 0;
      });
      if (entry.stationRatio.length) {
        entry.stationRatio[0] = 0;
        entry.stationRatio[entry.stationRatio.length - 1] = 1;
      }
    });

    /* ---------- 4) 归一化 + 适配视口 ---------- */
    var xs = order.map(function (key) { return nodes[key].x; });
    var ys = order.map(function (key) { return nodes[key].y; });
    var minX = Math.min.apply(null, xs);
    var minY = Math.min.apply(null, ys);
    var pad = unit * 1.4;
    order.forEach(function (key) {
      nodes[key].x -= minX - pad;
      nodes[key].y -= minY - pad;
    });
    linePaths.forEach(function (entry) {
      entry.points.forEach(function (point) {
        point.x -= minX - pad;
        point.y -= minY - pad;
      });
    });

    var rawWidth = Math.max.apply(null, xs) - minX + pad * 2;
    var rawHeight = Math.max.apply(null, ys) - minY + pad * 2;

    var host = this.root ? this.root.getBoundingClientRect() : { width: 1200, height: 700 };
    var viewW = Math.max(320, host.width - 110);
    var viewH = Math.max(240, host.height - 110);
    var fit = Math.min(viewW / Math.max(1, rawWidth), viewH / Math.max(1, rawHeight));

    order.forEach(function (key) {
      nodes[key].x *= fit;
      nodes[key].y *= fit;
    });
    linePaths.forEach(function (entry) {
      entry.points.forEach(function (point) {
        point.x *= fit;
        point.y *= fit;
      });
      entry.total *= fit;
      entry.cumulative = entry.cumulative.map(function (value) { return value * fit; });
    });

    var width = rawWidth * fit + 60;
    var height = rawHeight * fit + 60;
    this.layoutSize = { width: width, height: height };

    /* ---------- 5) 标签方位 ---------- */
    this.placeLabels(nodes, order, linePaths, width, height);

    /* ---------- 6) 线段列表（自检：所有线段都应落在 8 个方向上） ---------- */
    var edges = [];
    linePaths.forEach(function (entry) {
      for (var i = 1; i < entry.points.length; i += 1) {
        edges.push({
          lineKey: entry.line.key,
          x1: entry.points[i - 1].x,
          y1: entry.points[i - 1].y,
          x2: entry.points[i].x,
          y2: entry.points[i].y,
          isElbow: entry.stationIndices.indexOf(i) < 0 && entry.stationIndices.indexOf(i - 1) < 0
        });
      }
    });

    this.fidelity = this.measureFidelity(plan, nodes, order, linePaths);

    return {
      nodes: nodes,
      order: order,
      edges: edges,
      fidelity: this.fidelity,
      lines: linePaths,
      width: width,
      height: height,
      unit: unit * fit
    };
  },

  /**
   * 走向保真度：
   *  - quadrants：所有站点两两之间，示意图里的相对方位（东北/东南/…）是否与真实地理一致
   *  - bearingMeanDeg：每条线"首站→末站"的走向与真实方位角的平均偏差
   * 用来量化"示意图有没有照着真实线路走向来画"。
   */
  measureFidelity: function (plan, nodes, order, linePaths) {
    var latSum = 0;
    var count = 0;
    order.forEach(function (key) { latSum += nodes[key].lat; count += 1; });
    var lat0 = count ? latSum / count : 27.9;
    var kx = Math.cos((lat0 * Math.PI) / 180);

    var same = 0;
    var pairs = 0;
    for (var i = 0; i < order.length; i += 1) {
      for (var j = i + 1; j < order.length; j += 1) {
        var a = nodes[order[i]];
        var b = nodes[order[j]];
        var gx = (b.lng - a.lng) * kx;
        var gy = -(b.lat - a.lat);
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        if (Math.abs(gx) < 1e-9 && Math.abs(gy) < 1e-9) continue;
        pairs += 1;
        var sx = gx >= 0 ? 1 : -1;
        var sy = gy >= 0 ? 1 : -1;
        var tx = dx >= 0 ? 1 : -1;
        var ty = dy >= 0 ? 1 : -1;
        // 允许其中一轴接近 0 时只比较主方向
        var majorGeoX = Math.abs(gx) >= Math.abs(gy);
        var majorDiaX = Math.abs(dx) >= Math.abs(dy);
        if (majorGeoX === majorDiaX && (majorGeoX ? sx === tx : sy === ty)) same += 1;
      }
    }

    var bearingDiff = 0;
    var bearingCount = 0;
    linePaths.forEach(function (entry) {
      var stations = entry.line.stations;
      if (stations.length < 2) return;
      var first = stations[0];
      var last = stations[stations.length - 1];
      var gx2 = (last.lng - first.lng) * kx;
      var gy2 = -(last.lat - first.lat);
      var geoBearing = Math.atan2(gy2, gx2);
      var p0 = entry.points[entry.stationIndices[0]];
      var p1 = entry.points[entry.stationIndices[entry.stationIndices.length - 1]];
      var diaBearing = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      var diff = Math.abs(geoBearing - diaBearing);
      while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
      bearingDiff += (diff * 180) / Math.PI;
      bearingCount += 1;
    });

    return {
      quadrants: pairs ? Number((same / pairs).toFixed(3)) : 1,
      pairs: pairs,
      bearingMeanDeg: bearingCount ? Number((bearingDiff / bearingCount).toFixed(1)) : 0
    };
  },

  /** 标签方位：先按相邻线段方向取"背面"，再按重叠/出界情况换位 */
  placeLabels: function (nodes, order, linePaths, width, height) {
    var boxes = [];
    var candidates = [
      { side: 'bottom', dx: 0, dy: 1 },
      { side: 'top', dx: 0, dy: -1 },
      { side: 'right', dx: 1, dy: 0 },
      { side: 'left', dx: -1, dy: 0 }
    ];
    var gap = SCHEMATIC.labelGap + 6;

    order.forEach(function (key) {
      var node = nodes[key];
      var guessW = Math.max(34, node.name.length * 16.5);
      var guessH = 20;

      var boxFor = function (candidate) {
        var w = guessW;
        var h = guessH;
        var x = node.x;
        var y = node.y;
        if (candidate.dx === 1) { x += gap + 2; y -= h / 2; }
        else if (candidate.dx === -1) { x -= w + gap + 2; y -= h / 2; }
        else if (candidate.dy === 1) { x -= w / 2; y += gap; }
        else { x -= w / 2; y -= h + gap; }
        return { x: x, y: y, w: w, h: h };
      };

      var best = null;
      candidates.forEach(function (candidate) {
        var box = boxFor(candidate);
        var score = 0;
        if (box.x < 4 || box.y < 4 || box.x + box.w > width - 4 || box.y + box.h > height - 4) score += 6;
        boxes.forEach(function (other) { if (overlap(box, other)) score += 8; });
        order.forEach(function (otherKey) {
          if (otherKey === key) return;
          var other = nodes[otherKey];
          if (Math.abs(other.x - node.x) > 120 && Math.abs(other.y - node.y) > 120) return;
          if (box.x - 9 < other.x && other.x < box.x + box.w + 9 && box.y - 9 < other.y && other.y < box.y + box.h + 9) score += 5;
        });
        linePaths.forEach(function (entry) {
          for (var i = 1; i < entry.points.length; i += 1) {
            var prev = entry.points[i - 1];
            var point = entry.points[i];
            if (Math.abs(prev.x - node.x) > 140 && Math.abs(point.x - node.x) > 140) continue;
            var segAngle = Math.atan2(point.y - prev.y, point.x - prev.x);
            var candAngle = Math.atan2(candidate.dy, candidate.dx);
            var diff = Math.abs(((segAngle - candAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            if (diff < 0.4) score += 1.5;
          }
        });
        if (!best || score < best.score) best = { candidate: candidate, box: box, score: score };
      });

      boxes.push(best.box);
      node.labelSide = best.candidate.side;
    });
  },

  /* ------------------------------------------------------------- 渲染 */

  render: function () {
    var layout = this.layout;
    if (!layout) return;
    var self = this;
    var svg = this.svg;
    var ns = 'http://www.w3.org/2000/svg';

    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    svg.innerHTML = '';
    this.nodesLayer.innerHTML = '';
    this.nodes = {};
    this.lines = {};

    var defs = document.createElementNS(ns, 'defs');
    svg.appendChild(defs);

    layout.lines.forEach(function (entry) {
      var line = entry.line;
      var style = lineTypeStyle(line.type);
      var d = entry.points.map(function (point, index) {
        return (index === 0 ? 'M' : 'L') + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
      }).join(' ');

      var group = document.createElementNS(ns, 'g');
      group.setAttribute('class', 'sc-line sc-line-' + line.key);
      group.setAttribute('data-line-key', line.key);

      var make = function (className, width, color, opacity, dash) {
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', String(width));
        path.setAttribute('stroke-opacity', String(opacity));
        path.setAttribute('stroke-linecap', dash ? 'butt' : 'round');
        path.setAttribute('stroke-linejoin', 'round');
        if (dash) path.setAttribute('stroke-dasharray', '14 9');
        path.setAttribute('class', className);
        // 画到一半靠 dash 揭示：先整体算长度
        path.style.visibility = 'hidden';
        group.appendChild(path);
        return path;
      };

      var glow = make('sc-glow', style.glowWeight + 6, line.color, 0.1, false);
      var casing = make('sc-casing', style.casingWeight + 4, '#ffffff', 0.95, false);
      var main = make('sc-main', style.weight + 2, line.color, 1, !!style.dashArray);

      [glow, casing, main].forEach(function (path) {
        var length = 0;
        try { length = path.getTotalLength(); } catch (err) { length = 0; }
        path.dataset.length = String(length);
        path.style.visibility = '';
        path.style.strokeDasharray = length + ' ' + length;
        path.style.strokeDashoffset = String(length);
      });

      svg.appendChild(group);
      self.lines[line.key] = { group: group, glow: glow, casing: casing, main: main, entry: entry, style: style };
    });

    // 站点节点（复用现有 .st 样式，保证与地理版观感一致）
    layout.order.forEach(function (key) {
      var node = layout.nodes[key];
      var line = self.plan.lines.filter(function (item) { return item.key === node.lineKeys[0]; })[0];
      var transfer = node.lineKeys.length >= 2;
      var ringStyle = ringStyleVars(self.plan, key);
      var classes = ['st', 'is-hidden', 'side-' + (node.labelSide || 'bottom')];
      if (transfer) classes.push('is-transfer');
      if (line && line.type === 'intercity') classes.push('has-rail');

      var el = document.createElement('div');
      el.className = classes.join(' ');
      el.setAttribute('data-station-key', key);
      el.style.setProperty('--line-color', line ? line.color : '#666');
      if (ringStyle) el.setAttribute('style', '--line-color:' + (line ? line.color : '#666') + ';' + ringStyle);
      el.innerHTML =
        '<span class="st-halo"></span>' +
        '<span class="st-ring"></span>' +
        '<span class="st-dot"></span>' +
        '<span class="st-label"><span class="st-label-inner"><span class="st-name">' + escapeHtml(node.name) + '</span></span></span>';
      el.style.transform = 'translate(' + (node.x - SCHEMATIC.labelGap * 0) + 'px,' + node.y + 'px)';
      self.nodesLayer.appendChild(el);
      self.nodes[key] = { el: el, node: node, state: 'hidden' };
    });
  },

  /** 设定某条线「已绘制到 ratio」 */
  setLineProgress: function (lineKey, ratio) {
    var line = this.lines[lineKey];
    if (!line) return;
    var p = clamp(ratio, 0, 1);
    line.progress = p;      // 供逐帧渲染（视频导出）读取
    [line.main, line.casing, line.glow].forEach(function (path) {
      var length = Number(path.dataset.length) || 0;
      if (!length) return;
      path.style.strokeDasharray = length + ' ' + length;
      path.style.strokeDashoffset = String(length * (1 - p));
      if (p >= 0.9999 && path.classList.contains('sc-main') && line.style.dashArray) {
        path.style.strokeDasharray = '14 9';
        path.style.strokeDashoffset = '0';
      }
    });
  },

  setStationState: function (key, state) {
    var target = this.nodes[key];
    if (!target) return;
    target.state = state;
    target.el.classList.remove('is-hidden', 'is-ghost', 'is-opened', 'is-transfer-lit');
    if (state === 'hidden') target.el.classList.add('is-hidden');
    else if (state === 'ghost') target.el.classList.add('is-ghost');
    else target.el.classList.add('is-opened');
    target.el.classList.toggle('is-transfer', target.node.lineKeys.length >= 2 && state !== 'hidden');
  },

  /* ------------------------------------------------------------- 视口 */

  fitPanorama: function () {
    if (!this.root || !this.layout) return;
    var host = this.root.getBoundingClientRect();
    var pad = 48;
    var sx = (host.width - pad * 2) / this.layout.width;
    var sy = (host.height - pad * 2) / this.layout.height;
    this.panoramaScale = Math.min(sx, sy);
    this.focusScale = this.panoramaScale * SCHEMATIC.focusGain;
    this.stage.style.width = this.layout.width + 'px';
    this.stage.style.height = this.layout.height + 'px';
    this.centerOn(this.layout.width / 2, this.layout.height / 2, this.panoramaScale);
    this.applyTransform();
  },

  centerOn: function (x, y, scale) {
    var host = this.root.getBoundingClientRect();
    this.targetScale = scale;
    this.targetOffset.x = host.width / 2 - x * scale;
    this.targetOffset.y = host.height / 2 - y * scale;
  },

  applyTransform: function () {
    if (!this.stage) return;
    this.stage.style.transform =
      'translate(' + this.offset.x.toFixed(2) + 'px,' + this.offset.y.toFixed(2) + 'px) scale(' + this.scale.toFixed(4) + ')';
  },

  bindCameraLoop: function () {
    var self = this;
    this.offset.x = this.targetOffset.x;
    this.offset.y = this.targetOffset.y;
    this.scale = this.targetScale;
    var loop = function () {
      self.offset.x += (self.targetOffset.x - self.offset.x) * 0.22;
      self.offset.y += (self.targetOffset.y - self.offset.y) * 0.22;
      self.scale += (self.targetScale - self.scale) * 0.16;
      self.applyTransform();
      self.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  },

  /* ---------------------------------------------------------- 事件与播放 */

  /**
   * 直接复用 Story 的事件表：按开通日期排序，含「单独开通」的站点事件，
   * 并遵循线路多选（LineSelection）。示意图只是换了一套渲染/镜头而已。
   */
  computeEvents: function () {
    if (typeof Story !== 'undefined' && typeof Story.buildEvents === 'function') {
      this.events = Story.buildEvents() || [];
    } else {
      this.events = [];
    }
    return this.events;
  },

  play: function () {
    if (this.running || !this.layout) return;
    var self = this;
    var timing = (typeof STORY_TIMING !== 'undefined') ? STORY_TIMING : {
      travel: 1.5, lineBase: 2.2, linePerStation: 0.84, lineMin: 5.6, lineMax: 12.8,
      stationHold: 3, gap: 0.3, panoramaHold: 1.6, flyBack: 1.6
    };
    var hold = typeof timing.panoramaHold === 'number' ? timing.panoramaHold : 1.6;
    var flyBack = typeof timing.flyBack === 'number' ? timing.flyBack : SCHEMATIC.flyBack || 1.6;

    this.running = true;
    this.finished = false;
    this.phase = 'intro';
    this.startedAt = this.startedAt || performance.now();

    // 归零：全部隐藏、线路全未绘制
    this.layout.order.forEach(function (key) { self.setStationState(key, 'hidden'); });
    this.layout.lines.forEach(function (entry) { self.setLineProgress(entry.line.key, 0); });
    this.updateStats(false);

    var tl = gsap.timeline({
      onComplete: function () {
        self.running = false;
        self.finished = true;
        self.phase = 'done';
        self.centerOn(self.layout.width / 2, self.layout.height / 2, self.panoramaScale);
        self.updateStats(true);
      }
    });
    this.timeline = tl;
    var cursor = 0.3;

    (this.events || []).forEach(function (event) {
      var line = self.plan.lines[event.lineIndex];
      if (!line) return;
      var entry = self.layout.lines.filter(function (item) { return item.line.key === line.key; })[0];
      if (!entry) return;

      if (event.type === 'line') {
        var stations = line.stations.length;
        var draw = Math.max(timing.lineMin, Math.min(timing.lineMax, timing.lineBase + timing.linePerStation * stations));

        // 1) 镜头推到线路起点（特写）
        tl.call(function () {
          self.phase = 'travel';
          self.updateHud({ dateText: event.dateText, line: line, name: line.name });
          var first = entry.points[0];
          self.centerOn(first.x, first.y, self.focusScale);
        }, null, cursor);
        cursor += timing.travel;

        // 2) 沿线绘制 + 逐站点亮 + 镜头跟随头部
        var state = { p: 0 };
        tl.to(state, {
          p: 1,
          duration: draw,
          ease: 'none',
          onUpdate: function () {
            self.phase = 'draw';
            self.setLineProgress(line.key, state.p);
            var head = self.headOf(entry, state.p);
            if (head) self.centerOn(head.x, head.y, self.focusScale);
            self.revealByProgress(event, entry, state.p);
            self.updateStats(false);
          }
        }, cursor);
        cursor += draw;

        // 3) 拉回全景展示整条线
        tl.call(function () {
          self.phase = 'panorama';
          self.centerOn(self.layout.width / 2, self.layout.height / 2, self.panoramaScale);
          self.setLineProgress(line.key, 1);
          self.lineDone(line.key);
          self.updateStats(false);
        }, null, cursor);
        cursor += hold + timing.gap;
      } else {
        /* 单站开通：镜头对准该站 → 点亮 → 回到全景 */
        var station = line.stations[event.stationIndex];
        tl.call(function () {
          self.phase = 'station';
          self.updateStationHud({ dateText: event.dateText, line: line, station: station });
          var target = station ? self.nodes[station.key] : null;
          if (target) self.centerOn(target.node.x, target.node.y, self.focusScale * 1.18);
        }, null, cursor);
        cursor += timing.travel;

        tl.call(function () {
          if (station) self.setStationState(station.key, 'opened');
          self.updateStats(false);
        }, null, cursor);
        cursor += timing.stationHold;

        tl.call(function () {
          self.phase = 'panorama';
          self.centerOn(self.layout.width / 2, self.layout.height / 2, self.panoramaScale);
        }, null, cursor);
        cursor += flyBack + timing.gap;
      }
    });

    tl.call(function () {
      self.centerOn(self.layout.width / 2, self.layout.height / 2, self.panoramaScale);
    }, null, cursor);
  },

  /** 复位所有站点与线路进度（seek 倒退或重新导出时用） */
  resetStates: function () {
    var self = this;
    if (!this.layout) return;
    this.layout.order.forEach(function (key) { self.setStationState(key, 'hidden'); });
    this.layout.lines.forEach(function (entry) { self.setLineProgress(entry.line.key, 0); });
    this.lastSeek = 0;
    this.updateStats(false);
  },

  /**
   * 精确 seek 到某个时间点（逐帧渲染用）：
   * 时间轴被暂停后只做"更新到该时刻"，倒退时先复位，保证同一 t 一定得到同一画面。
   */
  seek: function (t) {
    if (!this.timeline) return false;
    var time = Math.max(0, t);
    if (typeof this.lastSeek === 'number' && time < this.lastSeek - 1e-6) {
      this.resetStates();
      this.timeline.pause(0);
    }
    this.timeline.time(time, false);
    this.scale = this.targetScale;
    this.offset.x = this.targetOffset.x;
    this.offset.y = this.targetOffset.y;
    this.lastSeek = time;
    return true;
  },

  /** 跳过动画：直接到终态 */
  skip: function () {
    if (!this.layout) return;
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    var self = this;
    this.layout.order.forEach(function (key) {
      if (self.nodes[key].state === 'hidden') self.setStationState(key, 'opened');
    });
    this.layout.lines.forEach(function (entry) { self.setLineProgress(entry.line.key, 1); });
    this.running = false;
    this.finished = true;
    this.phase = 'done';
    this.centerOn(this.layout.width / 2, this.layout.height / 2, this.panoramaScale);
    this.updateStats(true);
    var last = (this.events || [])[this.events.length - 1];
    if (last) {
      var line = this.plan.lines[last.lineIndex];
      if (line) {
        if (last.type === 'station') this.updateStationHud({ dateText: last.dateText, line: line, station: line.stations[last.stationIndex] });
        else this.updateHud({ dateText: last.dateText, line: line, name: line.name });
      }
    }
  },

  /** 重播：清空后重新按事件表播放 */
  replay: function () {
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    this.running = false;
    this.finished = false;
    this.phase = 'idle';
    this.startedAt = performance.now();
    this.computeEvents();
    this.play();
  },

  updateStationHud: function (event) {
    var date = document.getElementById('dateText');
    if (date) date.textContent = event.dateText || '';
    var name = document.getElementById('lineName');
    if (name && event.station) name.textContent = event.station.name;
    var range = document.getElementById('lineRange');
    if (range && event.line) range.textContent = (event.line.name || '') + ' · 单独开通';
    var status = document.getElementById('lineStatus');
    if (status) status.textContent = '站点开通';
  },

  /** 折线上按里程比例取"头部"位置 */
  headOf: function (entry, ratio) {
    var points = entry.points;
    if (!points || points.length < 2) return points && points[0] ? points[0] : null;
    var target = entry.total * clamp(ratio, 0, 1);
    var cumulative = entry.cumulative;
    var index = 0;
    while (index < cumulative.length - 2 && cumulative[index + 1] < target) index += 1;
    var segStart = cumulative[index];
    var segEnd = cumulative[index + 1];
    var t = segEnd - segStart > 1e-9 ? (target - segStart) / (segEnd - segStart) : 1;
    t = clamp(t, 0, 1);
    var a = points[index];
    var b = points[index + 1] || a;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  },

  /** 按绘制进度点亮该线上"已到达"的站点 */
  revealByProgress: function (event, entry, ratio) {
    var self = this;
    var line = this.plan.lines[event.lineIndex];
    if (!line) return;
    line.stations.forEach(function (station, index) {
      var stationRatio = entry.stationRatio[index];
      if (ratio + 1e-6 < stationRatio) return;
      var target = self.nodes[station.key];
      if (!target || target.state !== 'hidden') return;
      // 单独开通的站点由它自己的事件点亮，不随线路提前出现
      if (station.openMode === 'alone') return;
      self.setStationState(station.key, station.ghost ? 'ghost' : 'opened');
    });
  },

  /** 线路画完之后，补齐这条线上仍未点亮的站点 */
  lineDone: function (lineKey) {
    var self = this;
    var line = this.plan.lines.filter(function (item) { return item.key === lineKey; })[0];
    if (!line) return;
    line.stations.forEach(function (station) {
      if (station.openMode === 'alone') return;   // 留给它自己的开通事件
      var target = self.nodes[station.key];
      if (!target || target.state !== 'hidden') return;
      self.setStationState(station.key, station.ghost ? 'ghost' : 'opened');
    });
  },

  /* ----------------------------------------------------------------- HUD */

  updateHud: function (event) {
    var date = document.getElementById('dateText');
    if (date) date.textContent = event.dateText;
    var name = document.getElementById('lineName');
    if (name) name.textContent = event.name;
    var range = document.getElementById('lineRange');
    if (range && event.line.stations.length) {
      range.textContent = event.line.stations[0].name + ' → ' + event.line.stations[event.line.stations.length - 1].name;
    }
    var status = document.getElementById('lineStatus');
    if (status) status.textContent = '全线开通';
  },

  updateStats: function (final) {
    var self = this;
    if (!this.plan) return;

    // 与地理版共用统计口径：去重站点数 + 已开通线路里程
    var geo = {};
    this.plan.lines.forEach(function (line) {
      var total = 0;
      for (var i = 1; i < line.stations.length; i += 1) {
        total += haversineMeters(
          [line.stations[i - 1].lat, line.stations[i - 1].lng],
          [line.stations[i].lat, line.stations[i].lng]
        );
      }
      geo[line.key] = { totalMeters: total };
    });

    var openedLines = [];
    this.plan.lines.forEach(function (line) {
      if (final) { openedLines.push(line); return; }
      var opened = line.stations.some(function (station) {
        var node = self.nodes[station.key];
        if (!node || node.state === 'hidden') return false;
        // 该站被这条线点亮（单站开通事件也算）
        return node.node.lineKeys.indexOf(line.key) >= 0;
      });
      if (opened) openedLines.push(line);
    });

    var stats = (typeof computeStats === 'function')
      ? computeStats(openedLines, geo, [])
      : { lines: openedLines.length, stations: 0, km: 0 };

    var setText = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text; };
    setText('statLines', String(stats.lines));
    setText('statStations', String(stats.stations));
    setText('statKm', stats.km ? String(stats.km) : '—');
    this.stats = stats;
  },

  /* ---------------------------------------------------------- 调试接口 */

  snapshot: function () {
    var self = this;
    return {
      ready: !!this.root,
      phase: this.phase,
      nodes: this.layout ? this.layout.order.length : 0,
      edges: this.layout ? this.layout.edges.length : 0,
      lines: this.layout ? this.layout.lines.length : 0,
      width: this.layout ? Math.round(this.layout.width) : 0,
      height: this.layout ? Math.round(this.layout.height) : 0,
      scale: Number(this.scale.toFixed(3)),
      panoramaScale: Number(this.panoramaScale.toFixed(3)),
      focusScale: Number(this.focusScale.toFixed(3)),
      fidelity: this.fidelity || null,
      revealed: Object.keys(this.nodes).filter(function (key) { return self.nodes[key].state !== 'hidden'; }).length
    };
  }
};

/** 矩形相交判断（标签避让用） */
function overlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}
