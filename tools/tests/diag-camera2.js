(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;
  const out = { samples: [], ticks: 0 };

  // 统计 tick 是否在跑
  let lastState = null;
  const trap = setInterval(() => {
    if (!lastState) { lastState = { ...C.state }; return; }
    if (Math.abs(C.state.lat - lastState.lat) > 1e-9 || Math.abs(C.state.zoom - lastState.zoom) > 1e-9) out.ticks += 1;
    lastState = { ...C.state };
  }, 100);

  St.stop();
  await sleep(200);
  St.play();

  for (let i = 0; i < 22; i += 1) {
    await sleep(130);
    const key = 'zz-l1';
    const route = S.routes[key];
    const el = route.head.getElement();
    const op = el ? Number(getComputedStyle(el).opacity) : 0;
    if (op < 0.6) continue;
    const size = map.getSize();
    const head = map.latLngToContainerPoint(route.head.getLatLng());
    const start = S.geometries[key].render[0];
    const midPoint = L.latLng((start[0] + route.head.getLatLng().lat) / 2, (start[1] + route.head.getLatLng().lng) / 2);
    const midPx = map.latLngToContainerPoint(midPoint);
    out.samples.push({
      headOff: Number((Math.max(Math.abs(head.x - size.x / 2) / size.x, Math.abs(head.y - size.y / 2) / size.y)).toFixed(3)),
      midOff: Number((Math.max(Math.abs(midPx.x - size.x / 2) / size.x, Math.abs(midPx.y - size.y / 2) / size.y)).toFixed(3)),
      mapZoom: map.getZoom(),
      stateZoom: Number(C.state.zoom.toFixed(2)),
      targetZoom: Number(C.target.zoom.toFixed(2)),
      dLatCenterVsTarget: Number((map.getCenter().lat - C.target.lat).toFixed(5)),
      active: C.active,
      suspended: C.suspended
    });
  }
  clearInterval(trap);
  out.running = C.running;
  out.storyPlaying = St.playing;
  return JSON.stringify(out);
})()
