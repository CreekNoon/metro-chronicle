(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { samples: [], transfer: {}, zoom: {} };

  St.stop();
  await sleep(150);
  S.build(A.plan);
  S.drawProgress(0, 1);
  S.drawProgress(1, 1);
  await sleep(60);
  const q = S.stations['zz-qingshuitang'];
  out.transfer = {
    classes: q.refs.st.className,
    dotBg: getComputedStyle(q.refs.dot).backgroundColor,
    dotSize: getComputedStyle(q.refs.dot).width,
    ringImage: String(getComputedStyle(q.refs.ring).backgroundImage).slice(0, 60),
    state: q.state
  };

  St.play();
  const map = A.map;
  for (let i = 0; i < 26; i += 1) {
    await sleep(300);
    if (St.finished) break;
    const size = map.getSize();
    // 取当前元素透明度最高的头部
    let best = null;
    Object.keys(S.routes).forEach((key) => {
      const route = S.routes[key];
      const el = route.head.getElement();
      const op = el ? Number(getComputedStyle(el).opacity) : 0;
      if (!best || op > best.op) best = { key: key, op: op, route: route };
    });
    const center = map.getCenter();
    const zoom = map.getZoom();
    let headOffset = null;
    if (best && best.op > 0.6) {
      const pt = map.latLngToContainerPoint(best.route.head.getLatLng());
      headOffset = {
        key: best.key,
        dx: Number(((pt.x - size.x / 2) / size.x).toFixed(3)),
        dy: Number(((pt.y - size.y / 2) / size.y).toFixed(3))
      };
    }
    out.samples.push({
      t: i,
      zoom: Number(zoom.toFixed(2)),
      center: [Number(center.lat.toFixed(4)), Number(center.lng.toFixed(4))],
      head: headOffset,
      headOpacity: best ? Number(best.op.toFixed(2)) : null
    });
  }
  out.finished = St.finished;
  out.finalZoom = Number(map.getZoom().toFixed(2));
  out.suspended = M.Camera.suspended;
  out.events = St.events.length;
  return JSON.stringify(out);
})()
