(async () => {
  const M = window.__METRO__;
  const A = M.App, E = M.Edit;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('页面由服务端下发（http 协议）', window.location.protocol === 'http:', window.location.protocol);
  add('后端已连接（写穿启用）', M.RemoteStore.enabled === true, M.RemoteStore.status);
  add('存储模式标记为 server', M.snapshot().storage === 'server', M.snapshot().storage);
  add('地图与动画正常启动', !!A.map && (M.Story.playing === true || M.Story.finished === true), JSON.stringify(M.snapshot().story));

  /* 编辑一个站名 → 自动写穿到服务端 */
  E.enter();
  await sleep(400);
  const station = A.plan.lines[0].stations[0];
  E.select(station.key);
  await sleep(200);
  const input = document.querySelector('#editCard [data-act="name"]');
  input.value = '服务端云龙';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  E.exit();
  await sleep(1600);

  add('编辑已写入本地', A.plan.lines[0].stations[0].name === '服务端云龙', A.plan.lines[0].stations[0].name);
  add('推送后服务端状态正常', M.RemoteStore.status === 'server', M.RemoteStore.status);
  add('推送队列已清空', Object.keys(M.RemoteStore.pending).length === 0, Object.keys(M.RemoteStore.pending).join(','));

  /* 直接调 API 校验服务端确实收到了 */
  let serverPlan = null;
  try {
    const response = await fetch('/api/plans?city=' + A.cityId, { headers: { 'Content-Type': 'application/json' } });
    if (response.ok) serverPlan = await response.json();
  } catch (e) { /* ignore */ }
  add('服务端可读回该城市方案', !!serverPlan && !!serverPlan.plan);
  add('服务端方案包含最新站名',
    !!serverPlan && serverPlan.plan.lines[0].stations[0].name === '服务端云龙',
    serverPlan ? serverPlan.plan.lines[0].stations[0].name : 'n/a');
  add('服务端方案线路数与类型完整',
    !!serverPlan && serverPlan.plan.lines.length === 4 && serverPlan.plan.lines.some(l => l.type === 'intercity'),
    serverPlan ? serverPlan.plan.lines.map(l => l.type).join(',') : 'n/a');

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
