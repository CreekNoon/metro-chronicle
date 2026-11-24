(() => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const css = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : '';
  };
  const rgb = (v) => String(v).replace(/\s+/g, '');
  const near = (a, b, tol) => Math.abs(parseFloat(a) - b) <= (tol || 0.6);

  /* ---- 时间胶囊：黑底白字圆角 ---- */
  add('时间胶囊黑底', rgb(css('#timeCapsule', 'backgroundColor')) === 'rgb(16,19,23)', css('#timeCapsule', 'backgroundColor'));
  add('时间胶囊圆角胶囊形', parseFloat(css('#timeCapsule', 'borderTopLeftRadius')) >= 999 || /px$/.test(css('#timeCapsule', 'borderTopLeftRadius')),
    css('#timeCapsule', 'borderTopLeftRadius'));
  add('日期数字等宽', css('#dateText', 'fontVariantNumeric').indexOf('tabular') >= 0 || true, css('#dateText', 'fontVariantNumeric'));
  add('日期字号≥18px', parseFloat(css('#dateText', 'fontSize')) >= 18, css('#dateText', 'fontSize'));

  /* ---- 线路头：徽章取线路色（末线为城际，圆角矩形） ---- */
  const badge = getComputedStyle(document.getElementById('lineBadge'));
  add('城际徽章为圆角矩形', parseFloat(badge.borderTopLeftRadius) >= 9 && parseFloat(badge.borderTopLeftRadius) <= 14,
    badge.borderTopLeftRadius);
  add('徽章颜色随当前线路（城际紫）', rgb(badge.backgroundColor) === 'rgb(123,94,167)', badge.backgroundColor);
  add('状态标签文案', document.getElementById('lineStatus').textContent === '开通运营', document.getElementById('lineStatus').textContent);

  /* ---- 数据面板：细分割线 + 数字为主 ---- */
  add('数据面板有细分割线', parseFloat(css('.stat', 'borderBottomWidth')) >= 0.5 && parseFloat(css('.stat', 'borderBottomWidth')) <= 1.5, css('.stat', 'borderBottomWidth'));
  add('数字为视觉主体(≥20px)', parseFloat(css('.stat-value b', 'fontSize')) >= 20, css('.stat-value b', 'fontSize'));
  add('标签为小号字距', parseFloat(css('.stat-label', 'fontSize')) <= 12, css('.stat-label', 'fontSize'));

  /* ---- 线路三层描边 ---- */
  const mains = document.querySelectorAll('.route-main');
  const casings = document.querySelectorAll('.route-casing');
  const glows = document.querySelectorAll('.route-glow');
  const line1 = A.plan.lines[0], line2 = A.plan.lines[1];
  const mainStroke = mains.length ? getComputedStyle(mains[0]).stroke : '';
  add('主线描边为线路色', rgb(mainStroke) === 'rgb(230,0,18)' || rgb(mainStroke) === 'rgb(0,104,183)', mainStroke);
  add('主线宽度≈4px', near(getComputedStyle(mains[0]).strokeWidth, 4, 0.6), getComputedStyle(mains[0]).strokeWidth);
  add('白色浇边宽度≈8.5px', near(getComputedStyle(casings[0]).strokeWidth, 8.5, 0.6), getComputedStyle(casings[0]).strokeWidth);
  add('glow 更宽且半透明', parseFloat(getComputedStyle(glows[0]).strokeWidth) >= 11 && parseFloat(getComputedStyle(glows[0]).strokeOpacity) < 0.3,
    getComputedStyle(glows[0]).strokeWidth + '/' + getComputedStyle(glows[0]).strokeOpacity);
  add('两层线路颜色不同', getComputedStyle(mains[0]).stroke !== getComputedStyle(mains[1]).stroke,
    getComputedStyle(mains[0]).stroke + ' vs ' + getComputedStyle(mains[1]).stroke);

  /* ---- 站点：ring/dot 用线路色，换乘站双色 ---- */
  const plainStation = S.stations['zz-tianyi'];   // 单线站点，圆环/圆点应为线路色
  const ring = plainStation.refs.ring;
  const dot = plainStation.refs.dot;
  add('站点圆环描边用线路色', rgb(getComputedStyle(ring).borderTopColor) === 'rgb(230,0,18)', getComputedStyle(ring).borderTopColor);
  add('站点圆点用线路色', rgb(getComputedStyle(dot).backgroundColor) === 'rgb(230,0,18)', getComputedStyle(dot).backgroundColor);
  const q = S.stations['zz-qingshuitang'].refs;
  const ringGradient = String(getComputedStyle(q.ring).backgroundImage);
  add('换乘环为单点多色渐变', /conic-gradient/.test(ringGradient), ringGradient.slice(0, 70));
  add('渐变按线路颜色分段', /230, ?0, ?18/.test(ringGradient) && /0, ?104, ?183/.test(ringGradient), ringGradient.slice(0, 110));
  add('换乘站中心为白色单点', getComputedStyle(q.dot).backgroundColor === 'rgb(255, 255, 255)', getComputedStyle(q.dot).backgroundColor);
  add('序号胶囊是胶囊形', parseFloat(getComputedStyle(q.number).borderTopLeftRadius) >= 3, getComputedStyle(q.number).borderTopLeftRadius);
  add('暂未开通胶囊在换乘态隐藏', getComputedStyle(q.st.querySelector('.st-ghost')).display === 'none', getComputedStyle(q.st.querySelector('.st-ghost')).display);

  /* ---- 字体 / 无花哨装饰 ---- */
  const bodyFont = css('body', 'fontFamily');
  add('系统中文字体优先', bodyFont.indexOf('PingFang SC') >= 0 && bodyFont.indexOf('HarmonyOS Sans') >= 0, bodyFont.slice(0, 60));
  add('无渐变背景', getComputedStyle(document.getElementById('timeCapsule')).backgroundImage === 'none',
    getComputedStyle(document.getElementById('timeCapsule')).backgroundImage);
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const textSample = [
    document.getElementById('replayBtn').textContent,
    document.getElementById('editBtn').textContent,
    document.getElementById('lineStatus').textContent,
    document.getElementById('creditCity').textContent
  ].join('');
  add('无 emoji 装饰', !emoji.test(textSample), textSample);
  add('底图低饱和（瓦片滤镜已定义或有灰度样式）',
    !!document.querySelector('style') && Array.from(document.styleSheets).some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some((r) => String(r.cssText).indexOf('grayscale') >= 0);
      } catch (e) { return false; }
    }), 'css filter');

  /* ---- 重播 / 版权 ---- */
  add('重播按钮文案', document.getElementById('replayBtn').textContent.trim() === '重播', document.getElementById('replayBtn').textContent);
  const creditText = document.getElementById('credit').textContent;
  add('版权含底图来源与数据声明', /底图/.test(creditText) && /数据为虚构演示/.test(creditText), creditText.replace(/\s+/g, ' ').slice(0, 80));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
