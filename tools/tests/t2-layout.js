(() => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, E = M.Edit;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const rect = (sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const overlap = (a, b) => {
    if (!a || !b) return 0;
    const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    return w > 1 && h > 1 ? Math.round(w * h) : 0;
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  const isMobile = vw <= 720;

  add('视口', true, `${vw}x${vh} mobile=${isMobile}`);
  add('无横向滚动', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);

  /* ---- HUD 布局 ---- */
  const cap = rect('#timeCapsule');
  const head = rect('#lineHead');
  const stats = rect('#stats');
  const controls = rect('#controls');
  const replay = rect('#replayBtn');
  const credit = rect('#credit');

  add('时间胶囊在视口内', cap.x >= 0 && cap.y >= 0 && cap.right <= vw && cap.bottom <= vh, JSON.stringify(cap));
  add('线路头在胶囊下方', head.y >= cap.bottom - 2, `${head.y} vs ${cap.bottom}`);
  add('数据面板在线路头下方', stats.y >= head.bottom - 2, `${stats.y} vs ${head.bottom}`);
  add('胶囊/线路头/面板互不重叠', overlap(cap, head) === 0 && overlap(head, stats) === 0 && overlap(cap, stats) === 0);
  add('右上控制区不与数据面板重叠', overlap(controls, stats) === 0, `overlap=${overlap(controls, stats)}`);
  add('右上控制区在视口内', controls.right <= vw && controls.y >= 0, JSON.stringify(controls));
  add('重播按钮在视口内', replay.x >= 0 && replay.bottom <= vh, JSON.stringify(replay));
  add('版权在视口内', credit.right <= vw + 1 && credit.bottom <= vh, JSON.stringify(credit));
  add('重播与版权不重叠', overlap(replay, credit) === 0, `overlap=${overlap(replay, credit)}`);
  add('底部控件不压数据面板', overlap(replay, stats) === 0 && overlap(credit, stats) === 0);

  /* ---- 站点标签不被裁切 ---- */
  let outOfView = [];
  Object.keys(S.stations).forEach(k => {
    const label = S.stations[k].refs.label.getBoundingClientRect();
    if (label.left < -1 || label.right > vw + 1 || label.top < -1 || label.bottom > vh + 1) {
      outOfView.push(S.stations[k].station.name);
    }
  });
  add('所有站名标签在视口内', outOfView.length === 0, outOfView.join(',') || 'ok');

  /* ---- 站点标记不互相重叠（可视范围内） ---- */
  const pts = [];
  Object.keys(S.stations).forEach(k => {
    const m = S.stations[k].marker.getLatLng();
    pts.push({ name: S.stations[k].station.name, p: A.map.latLngToContainerPoint(m) });
  });
  let minGap = Infinity, minPair = '';
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const dx = pts[i].p.x - pts[j].p.x, dy = pts[i].p.y - pts[j].p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minGap) { minGap = d; minPair = pts[i].name + '↔' + pts[j].name; }
    }
  }
  const gapLimit = isMobile ? 12 : 24;
  add('站点最小屏幕间距不小于 ' + gapLimit + 'px（圆点不粘连）', minGap >= gapLimit, Math.round(minGap) + 'px (' + minPair + ')');

  /* ---- 站名标签两两不重叠（真实可读性判据） ---- */
  const labels = Object.keys(S.stations).map(k => ({ name: S.stations[k].station.name, r: S.stations[k].refs.label.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i].r, b = labels[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) overlaps.push(`${labels[i].name}↔${labels[j].name}(${Math.round(w)}x${Math.round(h)})`);
    }
  }
  add('站名标签两两不重叠', overlaps.length === 0, overlaps.join(', ') || 'ok');

  /* ---- 编辑态布局：卡片与工具条不重叠 ---- */
  E.enter();
  const bar = rect('#editBar');
  E.select(A.plan.lines[0].stations[1].key);
  const card = rect('#editCard');
  const bar2 = rect('#editBar');
  add('编辑工具条可见', !!bar2 && bar2.h > 20 && getComputedStyle(document.getElementById('editBar')).display !== 'none', JSON.stringify(bar2));
  add('编辑卡片可见', !!card && card.h > 40, JSON.stringify(card));
  add('编辑卡片与工具条不重叠', overlap(card, bar2) === 0, `overlap=${overlap(card, bar2)}`);
  add('编辑卡片在视口内', card.x >= 0 && card.right <= vw && card.bottom <= vh, JSON.stringify(card));
  add('编辑工具条在视口内', bar2.x >= 0 && bar2.right <= vw, `${bar2.x}..${bar2.right} / ${vw}`);
  if (isMobile) {
    const editBtn = rect('#editBtn');
    const display = getComputedStyle(document.getElementById('editBtn')).display;
    add('移动端编辑态隐藏右上编辑按钮', display === 'none', display);
  } else {
    add('桌面编辑态隐藏编辑按钮(冗余入口)', getComputedStyle(document.getElementById('editBtn')).display === 'none');
  }
  add('编辑态无横向滚动', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);
  E.exit();

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
