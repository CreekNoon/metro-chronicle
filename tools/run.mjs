/**
 * 测试包装器：调用 tools/probe.mjs，把单行 PROBE_JSON 解析成可读报告。
 * 用法示例：
 *   node tools/run.mjs --wait=16000 --eval=tools/tests/t5-edit.js
 *   node tools/run.mjs --offline --wait=14000 --eval=tools/tests/t8-offline.js --shot=dist/offline.png
 *   node tools/run.mjs --mobile --wait=16000 --eval=tools/tests/t2-layout.js
 * 额外参数：--profile=<dir>（跨运行复用浏览器 profile）、--page=<相对路径>、--file-access=0、--quiet
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const argv = process.argv.slice(2);
const opts = { wait: 0, page: '地铁线网开通纪事.html', evals: [], shot: '', profile: '', offline: false, mobile: false, fileAccess: null, quiet: false };

for (const raw of argv) {
  const eq = raw.indexOf('=');
  const key = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).trim().toLowerCase();
  const value = eq === -1 ? '1' : raw.slice(eq + 1);
  if (key === 'wait') opts.wait = Number(value) || 0;
  else if (key === 'page') opts.page = value;
  else if (key === 'eval') opts.evals.push(value);
  else if (key === 'shot') opts.shot = value;
  else if (key === 'profile') opts.profile = value;
  else if (key === 'offline') opts.offline = value !== '0';
  else if (key === 'mobile') opts.mobile = value !== '0';
  else if (key === 'file-access') opts.fileAccess = value !== '0';
  else if (key === 'quiet') opts.quiet = value !== '0';
}

const toFileUrl = (p) => (/^https?:\/\//i.test(p) ? p : 'file:///' + path.resolve(repo, p).replace(/\\/g, '/').replace(/^\/+/, ''));
const probeArgs = [
  path.join(repo, 'tools', 'probe.mjs'),
  '--url=' + toFileUrl(opts.page),
  '--wait=' + opts.wait
];
if (opts.offline) probeArgs.push('--offline=1');
if (opts.mobile) probeArgs.push('--mobile=1');
if (opts.profile) probeArgs.push('--profile=' + path.resolve(repo, opts.profile));
if (opts.fileAccess !== null) probeArgs.push('--file-access=' + (opts.fileAccess ? '1' : '0'));
if (opts.shot) probeArgs.push('--screenshot=' + path.resolve(repo, opts.shot));
for (const item of opts.evals) {
  const isPath = /\.js$/i.test(item) && fs.existsSync(path.resolve(repo, item));
  probeArgs.push('--eval=' + (isPath ? toFileUrl(item) : item));
}

const started = Date.now();
const res = spawnSync(process.execPath, probeArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (res.stdout || '') + (res.stderr || '');
const line = out.split(/\r?\n/).filter((l) => l.startsWith('PROBE_JSON:')).pop();
if (!line) {
  console.log('NO PROBE_JSON. raw tail:');
  console.log(out.slice(-3000));
  process.exit(1);
}
const payload = JSON.parse(line.slice('PROBE_JSON:'.length));

const pad = (n) => String(n).padStart(2, '0');
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log('─'.repeat(78));
console.log(`页面   ${payload.url}`);
console.log(`耗时   ${secs}s   底图/视口 ${JSON.stringify(payload.dom || null)}`);
if (payload.chrome) console.log(`浏览器 ${payload.chrome.product}`);
console.log(`pageErrors ${payload.pageErrors.length}   console ${payload.console.length}   requestFailures ${payload.requestFailuresTotal}`);
for (const e of payload.pageErrors) console.log('  PAGE-ERROR ' + (e.description || e.text || '').split('\n').slice(0, 3).join(' | '));
for (const c of payload.console) {
  if (/error|warn/i.test(c.type || '')) console.log('  CONSOLE ' + c.type + ': ' + String(c.text).slice(0, 220));
}
if (payload.warnings && payload.warnings.length) console.log('  WARN ' + payload.warnings.join(' | ').slice(0, 300));
if (payload.requestFailuresTotal) {
  const uniq = {};
  for (const f of payload.requestFailures) {
    const host = (f.url || '').replace(/^(\w+:)?\/\/([^/]+).*/, '$2') || f.url;
    const key = host + ' :: ' + (f.errorText || '?');
    uniq[key] = (uniq[key] || 0) + 1;
  }
  console.log('  请求失败来源 ' + JSON.stringify(uniq));
}
if (payload.screenshot) console.log(`截图   ${payload.screenshot.path} (${payload.screenshot.bytes} B)`);

for (let i = 0; i < payload.evals.length; i += 1) {
  const item = payload.evals[i];
  if (typeof item === 'string') {
    let report = null;
    try { report = JSON.parse(item); } catch { report = null; }
    if (report && report.checks) {
      const fails = report.checks.filter((c) => !c.ok);
      console.log(`\n[eval ${i}] ${report.pass}/${report.total} 通过`);
      for (const f of fails) console.log(`   ✗ ${f.name}${f.detail ? '  ::  ' + String(f.detail).slice(0, 160) : ''}`);
      if (opts.quiet) {
        const passes = report.checks.filter((c) => c.ok);
        for (const p of passes) console.log(`   ✓ ${p.name}${p.detail ? '  ::  ' + String(p.detail).slice(0, 120) : ''}`);
      }
    } else {
      console.log(`\n[eval ${i}] ${String(item).slice(0, 6000)}`);
    }
  } else {
    console.log(`\n[eval ${i}] 异常 ${JSON.stringify(item).slice(0, 400)}`);
  }
}
console.log('─'.repeat(78));
