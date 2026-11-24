#!/usr/bin/env node
/**
 * probe.mjs — dependency-free Chrome DevTools Protocol probe for offline,
 * single-file HTML pages (Windows / Node 22+ / global WebSocket).
 *
 * Only Node built-ins are used: node:child_process, node:fs, node:http,
 * node:os, node:path, node:net, node:timers/promises + global WebSocket.
 *
 * Output contract: exactly one line on stdout, prefixed with `PROBE_JSON:`
 * and containing a JSON object. All diagnostics go to stderr. Exit code is 0
 * unless the command line itself is malformed (then 2).
 *
 * Usage:
 *   node tools/probe.mjs --url=file:///C:/x/page.html \
 *     [--eval=file:///C:/x/step1.js] [--eval=document.title] \
 *     [--wait=8000] [--screenshot=C:\tmp\shot.png] \
 *     [--offline=0|1] [--mobile=0|1] [--viewport=1280x720] [--locale=zh-CN]
 *
 * Payload fields:
 *   ok, url, args, chrome, loadTimedOut, dom{title,scrollWidth,clientWidth},
 *   console[{type,text}], pageErrors[{text,description,url}],
 *   requestFailures[{url,errorText}] (max 40), requestFailuresTotal,
 *   evals[...], screenshot{path,bytes}|{path,error}, elapsedMs, totalElapsedMs,
 *   warnings[], fatal (only when something went wrong).
 *
 * `evals` entries are raw result values; failures look like {error:"..."} and
 * values that cannot cross the protocol look like {unserializable:true,raw:"..."}.
 *
 * Env:
 *   PROBE_CHROME_PATH  override the Chrome executable (default: Program Files
 *                      Chrome). A .mjs/.js path is treated as a CDP mock and run
 *                      with the current Node binary (used by offline CI tests).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/* ------------------------------------------------------------------ config */

const DEFAULT_CHROME =
  process.env.PROBE_CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const CDP_LOAD_TIMEOUT_MS = 20000; // Page.loadEventFired wait
const ACTIVE_PORT_TIMEOUT_MS = 15000; // DevToolsActivePort polling
const DETECT_TIMEOUT_MS = 15000; // /json/version polling
const TAIL_CONSOLE_WAIT_MS = 300; // collect trailing console events
const MAX_REQUEST_FAILURES = 40; // truncate noisy offline runs
const MAX_TEXT_LEN = 20000; // per console line safety cap

/* ----------------------------------------------------------------- logging */

function log(...parts) {
  try {
    process.stderr.write(`[probe] ${parts.join(' ')}\n`);
  } catch {
    /* stderr closed — nothing to do */
  }
}

function truncateText(s, max = MAX_TEXT_LEN) {
  const str = String(s);
  return str.length > max ? `${str.slice(0, max)}…[truncated ${str.length - max} chars]` : str;
}

/* ------------------------------------------------------------- argv parsing */

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return BOOL_TRUE.has(String(value).trim().toLowerCase());
}

/**
 * Parses `--key=value` style args. `--eval` is repeatable and keeps order.
 * A bare `--flag` (no `=`) is treated as `--flag=1`.
 */
function parseArgs(argv) {
  const out = { eval: [], wait: 0, offline: false, mobile: false, url: '', screenshot: '', viewport: '', locale: '', chrome: '', profile: '', fileAccess: true, extraFlags: [] };
  for (const raw of argv) {
    if (typeof raw !== 'string' || !raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).trim().toLowerCase();
    const value = eq === -1 ? '1' : raw.slice(eq + 1);
    switch (key) {
      case 'url':
        out.url = value.trim();
        break;
      case 'eval':
        out.eval.push(value);
        break;
      /* 复用固定 profile：用于「刷新后方案仍在」的跨进程持久化验证 */
      case 'profile':
        out.profile = value.trim();
        break;
      /* 关闭 --allow-file-access-from-files，验证默认双击打开的行为 */
      case 'file-access':
        out.fileAccess = parseBool(value, true);
        break;
      case 'extra-flag':
        out.extraFlags.push(value);
        break;
      case 'wait': {
        const n = Number.parseInt(value, 10);
        out.wait = Number.isFinite(n) && n > 0 ? n : 0;
        break;
      }
      case 'screenshot':
        out.screenshot = value.trim();
        break;
      case 'offline':
        out.offline = parseBool(value);
        break;
      case 'mobile':
        out.mobile = parseBool(value);
        break;
      case 'viewport':
        out.viewport = value.trim();
        break;
      case 'locale':
        out.locale = value.trim();
        break;
      case 'chrome':
        out.chrome = value.trim();
        break;
      case 'help':
      case 'h':
        out.help = true;
        break;
      default:
        log(`ignoring unknown argument: --${key}`);
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------ path helpers */

/** file:///C:/a/b%20c.js -> C:\a\b c.js  (no node:url on purpose) */
function fileUrlToPath(value) {
  let s = String(value);
  s = s.replace(/^file:\/\//i, '');
  s = s.replace(/^localhost(?=\/)/i, ''); // file://localhost/C:/...
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); // /C:/... -> C:/...
  s = s.replace(/\//g, '\\');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw on malformed escapes */
  }
  return s;
}

function isFileUrl(value) {
  return /^file:\/\//i.test(String(value).trim());
}

function readTextFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.replace(/^\uFEFF/, ''); // strip BOM
}

/* ------------------------------------------------------------- cdp transport */

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map(); // method -> Set(fn)
    this.closed = false;
    this.closeListeners = [];
  }

  async connect(timeoutMs = 10000) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket open timeout after ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (ev) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error while connecting: ${ev?.message || ev?.error?.message || 'unknown'}`));
        },
        { once: true },
      );
    });
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(`CDP socket closed before ${entry.method} answered`));
      }
      this.pending.clear();
      for (const fn of this.closeListeners) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msg = JSON.parse(raw);
    } catch (e) {
      log('bad CDP frame:', e.message);
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(`${entry.method}: ${msg.error.message || 'CDP error'}${msg.error.data ? ` (${msg.error.data})` : ''}`);
        err.cdpError = msg.error;
        entry.reject(err);
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) {
        for (const fn of [...set]) {
          try {
            fn(msg.params || {}, msg.sessionId);
          } catch (e) {
            log(`handler for ${msg.method} threw:`, e.message);
          }
        }
      }
    }
  }

  on(method, fn) {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Resolves once `method` fires (optionally filtered by sessionId). */
  once(method, { sessionId = null, timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid && sid !== sessionId) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(params);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
      }
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed || !this.ws) return Promise.reject(new Error(`CDP socket closed: ${method}`));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`CDP timeout ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.ws.send(JSON.stringify(message));
      } catch (e) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e);
      }
    });
  }

  close() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

/* ----------------------------------------------------------------- helpers */

function httpJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`invalid JSON from ${url}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout for ${url}`)));
    req.on('error', reject);
  });
}

function isPortListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function removeDirQuiet(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    log('removed temp user-data-dir:', dir);
  } catch (e) {
    log('WARN could not remove temp dir:', dir, e.message);
  }
}

/* ---------------------------------------------------------- chrome launcher */

function chromeFlags(userDataDir, extraFlags, fileAccess = true) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...(fileAccess === false ? [] : ['--allow-file-access-from-files']),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    ...extraFlags,
    'about:blank',
  ];
}

/**
 * Spawns headless Chrome, waits for <userDataDir>/DevToolsActivePort, then asks
 * /json/version for the browser-level webSocketDebuggerUrl.
 */
async function launchChrome({ chromePath, userDataDir, extraFlags = [], stderrPath = null, fileAccess = true }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    /* ignore stale file */
  }

  const args = chromeFlags(userDataDir, extraFlags, fileAccess);
  // Test hook: PROBE_CHROME_PATH/--chrome may point at a .mjs/.js CDP mock
  // (e.g. a fake browser for CI where Chrome cannot be launched); it then runs
  // under the current Node binary with the same flag list.
  const isNodeScript = /\.(mjs|cjs|js)$/i.test(chromePath);
  const exe = isNodeScript ? process.execPath : chromePath;
  const spawnArgs = isNodeScript ? [chromePath, ...args] : args;
  log('spawn chrome:', isNodeScript ? `${exe} ${chromePath}` : chromePath);
  log('flags:', args.join(' '));
  // Primary attempt keeps the documented `stdio: 'ignore'`; only the diagnostic
  // retry writes Chrome's stderr to a real file (never a pipe) so a launch
  // failure carries Chrome's own error message.
  let stderrFd = null;
  let stdio = 'ignore';
  if (stderrPath) {
    try {
      stderrFd = fs.openSync(stderrPath, 'w');
      stdio = ['ignore', 'ignore', stderrFd];
    } catch (e) {
      log('could not open stderr log (ignored):', e.message);
    }
  }
  const proc = spawn(exe, spawnArgs, { stdio, windowsHide: true });
  if (stderrFd !== null) {
    try {
      fs.closeSync(stderrFd);
    } catch {
      /* child keeps its own duplicate */
    }
  }
  proc.on('error', (e) => log('chrome spawn error:', e.message));

  const deadline = Date.now() + ACTIVE_PORT_TIMEOUT_MS;
  let raw = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Chrome exited early (code ${proc.exitCode}) before opening a debug port`);
    try {
      const txt = fs.readFileSync(portFile, 'utf8').trim();
      if (txt) {
        raw = txt;
        break;
      }
    } catch {
      /* file not there yet */
    }
    await sleep(100);
  }
  if (!raw) throw new Error(`DevToolsActivePort not written within ${ACTIVE_PORT_TIMEOUT_MS}ms`);

  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const port = Number.parseInt(lines[0], 10);
  const browserPath = lines[1] || '';
  if (!Number.isFinite(port) || port <= 0) throw new Error(`invalid port in DevToolsActivePort: ${JSON.stringify(raw)}`);

  // Port can be open a hair before the HTTP endpoint answers.
  const portDeadline = Date.now() + 5000;
  while (Date.now() < portDeadline) {
    if (await isPortListening(port)) break;
    await sleep(100);
  }

  let version = null;
  const detectDeadline = Date.now() + DETECT_TIMEOUT_MS;
  for (let i = 0; !version && Date.now() < detectDeadline; i++) {
    try {
      version = await httpJson(`http://127.0.0.1:${port}/json/version`, 2000);
    } catch (e) {
      log(`/json/version attempt ${i + 1} failed: ${e.message}`);
      await sleep(200);
    }
  }
  if (!version) throw new Error(`could not read http://127.0.0.1:${port}/json/version`);

  const wsUrl =
    version.webSocketDebuggerUrl ||
    (browserPath ? `ws://127.0.0.1:${port}${browserPath}` : `ws://127.0.0.1:${port}/devtools/browser`);

  return { proc, port, browserPath, wsUrl, version };
}

/* ------------------------------------------------------- remote-object text */

function primitiveText(arg) {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg !== 'object') return String(arg);
  if (arg.type === 'undefined') return 'undefined';
  if (Object.prototype.hasOwnProperty.call(arg, 'unserializableValue') && arg.unserializableValue !== undefined) {
    return String(arg.unserializableValue);
  }
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    const v = arg.value;
    if (typeof v === 'string') return v;
    if (v === null) return 'null';
    if (typeof v === 'object') {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return String(v);
  }
  if (typeof arg.description === 'string' && arg.description) return arg.description;
  if (typeof arg.preview === 'object' && arg.preview) {
    try {
      return JSON.stringify(arg.preview);
    } catch {
      /* fall through */
    }
  }
  return arg.type || 'unknown';
}

/* ------------------------------------------------------------------- probe */

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stderr.write(
      'usage: node tools/probe.mjs --url=file:///C:/x/page.html [--eval=<file:///x.js|expr>]... ' +
        '[--wait=ms] [--screenshot=C:\\tmp\\shot.png] [--offline=0|1] [--mobile=0|1] [--viewport=WxH] [--locale=zh-CN]\n',
    );
    return 0;
  }

  if (!args.url) {
    const bad = { ok: false, fatal: 'missing required argument --url=file:///C:/path/page.html' };
    process.stdout.write(`PROBE_JSON:${JSON.stringify(bad)}\n`);
    return 2;
  }

  const chromePath = args.chrome || DEFAULT_CHROME;
  const payload = {
    ok: false,
    url: args.url,
    args: {
      url: args.url,
      wait: args.wait,
      offline: args.offline,
      mobile: args.mobile,
      viewport: args.viewport || null,
      locale: args.locale || null,
      screenshot: args.screenshot || null,
      evalCount: args.eval.length,
    },
    chrome: null,
    loadTimedOut: false,
    dom: null,
    console: [],
    pageErrors: [],
    requestFailures: [],
    requestFailuresTotal: 0,
    evals: [],
    screenshot: null,
    elapsedMs: 0,
    warnings: [],
  };

  /** @type {import('node:child_process').ChildProcess|null} */
  let chrome = null;
  let cdp = null;
  let tmpDir = null;
  let targetId = null;
  let sessionId = null;
  let navigateStartedAt = 0;

  // ---- collection state ---------------------------------------------------
  const consoleEntries = []; // {type, text}  (text finalized later)
  const consoleArgJobs = [];
  const pageErrors = [];
  const requestUrls = new Map(); // requestId -> url
  const requestFailures = [];
  let requestFailuresTotal = 0;

  const warn = (msg) => {
    payload.warnings.push(msg);
    log('WARN', msg);
  };

  const finalizeConsole = async () => {
    if (consoleArgJobs.length) await Promise.allSettled(consoleArgJobs);
    for (const entry of consoleEntries) {
      const parts = entry._parts || [];
      delete entry._parts;
      entry.text = truncateText(parts.filter((p) => p !== '' && p !== undefined).join(' '));
    }
  };

  async function shutdown() {
    // 1. close the page target (ignored on failure)
    try {
      if (cdp && !cdp.closed && targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 3000);
    } catch (e) {
      log('closeTarget failed (ignored):', e.message);
    }
    // 2. drop the WS
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    // 3. kill Chrome + whole process tree
    const pid = chrome && chrome.pid;
    try {
      if (chrome && chrome.exitCode === null) {
        chrome.kill();
        await sleep(250);
      }
    } catch (e) {
      log('chrome.kill failed (ignored):', e.message);
    }
    if (pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', (e) =>
          log('taskkill spawn error (ignored):', e.message),
        );
        await sleep(400);
      } catch (e) {
        log('taskkill failed (ignored):', e.message);
      }
    }
    // 4. rm -rf the throwaway profile（复用固定 profile 时保留）
    if (!args.profile) removeDirQuiet(tmpDir);
  }

  try {
    /* ---------------------------------------------------------- 1. chrome */
    tmpDir = args.profile
      ? (fs.mkdirSync(path.resolve(args.profile), { recursive: true }), path.resolve(args.profile))
      : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'));
    log('user-data-dir:', tmpDir);

    const launch = await launchChrome({ chromePath, userDataDir: tmpDir, fileAccess: args.fileAccess, extraFlags: args.extraFlags }).catch(async (e) => {
      // Retry once with sandbox-disabling flags: headless Chrome inside a
      // restricted container/CI often cannot start its own sandbox. This retry
      // also captures Chrome's stderr to a file so a failure explains itself.
      warn(`first chrome launch failed (${e.message}); retrying with --no-sandbox --disable-dev-shm-usage`);
      removeDirQuiet(tmpDir);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'));
      const stderrPath = path.join(tmpDir, 'chrome-stderr.log');
      try {
        return await launchChrome({
          chromePath,
          userDataDir: tmpDir,
          extraFlags: ['--no-sandbox', '--disable-dev-shm-usage'],
          stderrPath,
        });
      } catch (e2) {
        try {
          const tail = fs.readFileSync(stderrPath, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n');
          if (tail) {
            payload.chromeStderrTail = tail;
            warn(`chrome stderr: ${tail.replace(/\s+/g, ' ').slice(0, 600)}`);
          }
        } catch {
          /* no log written */
        }
        throw e2;
      }
    });

    chrome = launch.proc;
    payload.chrome = {
      port: launch.port,
      wsPath: launch.browserPath || null,
      product: launch.version.Browser || null,
      protocolVersion: launch.version['Protocol-Version'] || null,
    };

    /* ---------------------------------------------- 2. browser-level WS */
    cdp = new Cdp(launch.wsUrl);
    await cdp.connect(10000);
    log('connected to browser websocket');

    /* ----------------------------------------------- 3. wire collectors */
    const materializeArg = async (objectId, fallback) => {
      const fn =
        'function(){try{const seen=new WeakSet();const s=JSON.stringify(this,function(k,v){' +
        'if(v&&typeof v==="object"){if(seen.has(v))return "[Circular]";seen.add(v);}return v;});' +
        'if(typeof s==="string"&&s!==""&&s!=="{}")return s;}catch(e){}' +
        'try{if(this&&this.nodeType===1)return this.outerHTML;}catch(e){}' +
        'try{const s2=String(this);if(s2!=="[object Object]")return s2;}catch(e){}return "";}';
      const raced = await Promise.race([
        cdp
          .send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true, silent: true }, sessionId, 2500)
          .catch(() => null),
        sleep(2500).then(() => null),
      ]);
      const value = raced && raced.result ? raced.result.value : undefined;
      if (typeof value === 'string' && value) return value;
      return fallback;
    };

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const parts = [];
      for (const arg of params.args || []) {
        const direct = primitiveText(arg);
        if ((arg.type === 'object' || arg.type === 'function') && arg.objectId) {
          const idx = parts.push(direct) - 1;
          consoleArgJobs.push(
            materializeArg(arg.objectId, direct)
              .then((text) => {
                if (text) parts[idx] = text;
              })
              .catch(() => {}),
          );
        } else {
          parts.push(direct);
        }
      }
      // stack trace of console.trace()/console.assert() is useful, keep it flat
      const entry = { type: params.type || 'log', text: '', _parts: parts };
      if ((params.type === 'trace' || params.type === 'assert') && params.stackTrace) {
        const frames = (params.stackTrace.callFrames || [])
          .slice(0, 5)
          .map((f) => `${f.functionName || '<anonymous>'}@${f.url || ''}:${(f.lineNumber ?? 0) + 1}`);
        if (frames.length) entry._parts.push(`\n${frames.join(' <- ')}`);
      }
      consoleEntries.push(entry);
    });

    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      const level = String(entry.level || '').toLowerCase();
      if (level !== 'error' && level !== 'warning') return;
      let text = entry.text || '(no text)';
      if (entry.url && !String(text).includes(entry.url)) text += ` @ ${entry.url}`;
      consoleEntries.push({ type: `log.${level}`, text: '', _parts: [text] });
    });

    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const exception = details.exception || {};
      pageErrors.push({
        text: details.text || '',
        description: exception.description || exception.value || '',
        url: details.url || '',
      });
    });

    cdp.on('Network.requestWillBeSent', (params) => {
      const req = params.request || {};
      if (params.requestId) requestUrls.set(params.requestId, req.url || '');
    });

    cdp.on('Network.loadingFailed', (params) => {
      requestFailuresTotal += 1;
      if (requestFailures.length >= MAX_REQUEST_FAILURES) return;
      requestFailures.push({
        url: requestUrls.get(params.requestId) || params.requestId || '',
        errorText: params.errorText || (params.blockedReason ? `blocked: ${params.blockedReason}` : 'unknown'),
      });
    });

    cdp.on('Target.targetCrashed', (params) => {
      warn(`page target crashed: ${JSON.stringify(params)}`);
    });

    /* ------------------------------------------ 4. page target + session */
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 10000);
    targetId = created.targetId;
    if (!targetId) throw new Error('Target.createTarget returned no targetId');
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 10000);
    sessionId = attached.sessionId;
    if (!sessionId) throw new Error('Target.attachToTarget returned no sessionId (flatten unsupported?)');
    log('attached to target', targetId, 'session', sessionId);

    const send = (method, params = {}, timeoutMs = 30000) => cdp.send(method, params, sessionId, timeoutMs);

    /* ------------------------------------------------- 5. domain enables */
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    // Network.enable is always on: requestFailures is a required collection item.
    await send('Network.enable');

    if (args.offline) {
      const offlineParams = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
      try {
        await send('Network.emulateNetworkConditions', offlineParams);
        log('offline emulation enabled via Network.emulateNetworkConditions');
      } catch (e) {
        warn(`Network.emulateNetworkConditions failed (${e.message}); trying Network.overrideNetworkState`);
        try {
          await send('Network.overrideNetworkState', { ...offlineParams, connectionType: 'none' });
          log('offline emulation enabled via Network.overrideNetworkState');
        } catch (e2) {
          warn(`Network.overrideNetworkState failed (${e2.message}); trying Network.emulateNetworkConditionsByRule`);
          try {
            await send('Network.emulateNetworkConditionsByRule', {
              offline: true,
              matchedNetworkConditions: [{ urlPattern: '*', latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
            });
            await send('Network.emulateNetworkConditions', offlineParams).catch(() => {});
            log('offline emulation enabled via emulateNetworkConditionsByRule');
          } catch (e3) {
            warn(`offline emulation unavailable: ${e3.message}`);
          }
        }
      }
    }

    if (args.mobile) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
        screenWidth: 390,
        screenHeight: 844,
      });
      try {
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      } catch (e) {
        warn(`Emulation.setTouchEmulationEnabled failed: ${e.message}`);
      }
      log('mobile emulation: 390x844 @2x');
    } else if (args.viewport) {
      const m = /^(\d+)\s*[xX*×]\s*(\d+)$/.exec(args.viewport);
      if (!m) {
        warn(`ignoring malformed --viewport=${args.viewport} (expected WxH)`);
      } else {
        const width = Number.parseInt(m[1], 10);
        const height = Number.parseInt(m[2], 10);
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        log(`viewport override: ${width}x${height}`);
      }
    }

    if (args.locale) {
      try {
        await send('Emulation.setLocaleOverride', { locale: args.locale });
        log('locale override:', args.locale);
      } catch (e) {
        warn(`Emulation.setLocaleOverride(${args.locale}) failed: ${e.message}`);
      }
    }

    /* ------------------------------------------------------- 6. navigate */
    const loadFired = cdp.once('Page.loadEventFired', { sessionId, timeoutMs: CDP_LOAD_TIMEOUT_MS }).then(
      () => true,
      () => false,
    );
    navigateStartedAt = Date.now();
    const nav = await send('Page.navigate', { url: args.url }, 20000);
    if (nav.errorText) warn(`Page.navigate reported errorText: ${nav.errorText}`);
    if (nav.loaderId) log('navigation loaderId:', nav.loaderId);

    const loaded = await loadFired;
    payload.loadTimedOut = !loaded;
    if (!loaded) warn(`Page.loadEventFired not seen within ${CDP_LOAD_TIMEOUT_MS}ms — continuing`);
    log(`page load ${loaded ? 'fired' : 'timed out'} after ${Date.now() - navigateStartedAt}ms`);

    /* ------------------------------------------------------ 7. extra wait */
    if (args.wait > 0) {
      log(`waiting ${args.wait}ms (collecting console)`);
      await sleep(args.wait);
    }

    /* --------------------------------------------------------- 8. evals */
    for (let i = 0; i < args.eval.length; i++) {
      const raw = args.eval[i];
      let expression = raw;
      let label = `inline#${i}`;
      if (isFileUrl(raw)) {
        const filePath = fileUrlToPath(raw);
        label = filePath;
        try {
          expression = readTextFile(filePath);
        } catch (e) {
          payload.evals.push({ error: `cannot read eval file ${filePath}: ${e.message}` });
          warn(`eval file unreadable: ${filePath}`);
          continue;
        }
      }
      // 特殊指令：__RELOAD__ 重新加载当前页面（用于验证「刷新后方案仍在」）
      if (String(expression).trim() === '__RELOAD__') {
        log('reloading page for persistence test');
        try {
          await send('Page.navigate', { url: args.url }, 20000);
        } catch (e) {
          warn('reload navigate failed: ' + e.message);
        }
        await sleep(2200);
        payload.evals.push({ reloaded: true });
        continue;
      }

      log(`eval[${i}] ${label} (${String(expression).length} chars)`);

      let outcome;
      try {
        outcome = await evaluateExpression(send, expression);
      } catch (e) {
        outcome = { error: e.message };
      }
      payload.evals.push(outcome);
    }

    /* ------------------------------------------------- 9. dom snapshot */
    try {
      const domRes = await send(
        'Runtime.evaluate',
        {
          expression:
            '({title: document.title, scrollWidth: document.documentElement ? document.documentElement.scrollWidth : null, clientWidth: document.documentElement ? document.documentElement.clientWidth : null})',
          returnByValue: true,
          awaitPromise: true,
          silent: true,
        },
        10000,
      );
      if (domRes.exceptionDetails) {
        warn(`dom snapshot threw: ${domRes.exceptionDetails.text || 'unknown'}`);
        payload.dom = null;
      } else {
        payload.dom = domRes.result ? domRes.result.value ?? null : null;
      }
    } catch (e) {
      warn(`dom snapshot failed: ${e.message}`);
      payload.dom = null;
    }

    /* --------------------------------------------------- 10. screenshot */
    if (args.screenshot) {
      const target = path.isAbsolute(args.screenshot) ? args.screenshot : path.resolve(process.cwd(), args.screenshot);
      const capture = () => send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
      try {
        let shot;
        try {
          shot = await capture();
        } catch (e) {
          // One retry: headless compositor occasionally needs a beat after load.
          log('screenshot attempt 1 failed, retrying once:', e.message);
          await sleep(250);
          shot = await capture();
        }
        if (!shot.data) throw new Error('captureScreenshot returned no data');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const buf = Buffer.from(shot.data, 'base64');
        fs.writeFileSync(target, buf);
        payload.screenshot = { path: target, bytes: buf.length };
        log(`screenshot saved: ${target} (${buf.length} bytes)`);
      } catch (e) {
        warn(`screenshot failed: ${e.message}`);
        payload.screenshot = { path: target, error: e.message };
      }
    }

    /* --------------------------------------- 11. tail console + payload */
    await sleep(TAIL_CONSOLE_WAIT_MS);
    await finalizeConsole();

    payload.console = consoleEntries;
    payload.pageErrors = pageErrors;
    payload.requestFailures = requestFailures;
    payload.requestFailuresTotal = requestFailuresTotal;
    payload.ok = true;
    // elapsedMs: navigation -> payload emission (per spec); totalElapsedMs adds
    // Chrome launch + teardown overhead.
    payload.elapsedMs = navigateStartedAt ? Date.now() - navigateStartedAt : Date.now() - startedAt;
    payload.totalElapsedMs = Date.now() - startedAt;
  } catch (e) {
    payload.ok = false;
    payload.fatal = e && e.message ? e.message : String(e);
    if (e && e.stack) log('FATAL\n' + e.stack);
    else log('FATAL', payload.fatal);
    try {
      await finalizeConsole();
    } catch {
      /* ignore */
    }
    payload.console = consoleEntries;
    payload.pageErrors = pageErrors;
    payload.requestFailures = requestFailures;
    payload.requestFailuresTotal = requestFailuresTotal;
    payload.elapsedMs = navigateStartedAt ? Date.now() - navigateStartedAt : Date.now() - startedAt;
    payload.totalElapsedMs = Date.now() - startedAt;
  } finally {
    await shutdown();
  }

  // Single-line, UTF-8, machine-parsable output.
  const line = Buffer.from(`PROBE_JSON:${JSON.stringify(payload)}\n`, 'utf8');
  await new Promise((resolve) => process.stdout.write(line, resolve));
  return 0;
}

/* ------------------------------------------------------ evaluate one step */

async function evaluateExpression(send, expression) {
  const base = {
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
    silent: true,
    userGesture: true,
  };

  const firstLineOf = (details) => {
    if (!details) return '';
    const description = details.exception && details.exception.description;
    if (description) return String(description).split('\n')[0];
    const raw = (details.exception && details.exception.value) || details.text || '';
    return String(raw).split('\n')[0];
  };

  const attempt = async (expr) => {
    try {
      return { res: await send('Runtime.evaluate', { ...base, expression: expr }, 60000) };
    } catch (e) {
      return { protocolError: String(e.message || e) };
    }
  };

  let step = await attempt(expression);

  // Top-level `await` is a SyntaxError outside async functions/modules: retry
  // wrapped in an async IIFE. (Syntax errors arrive as exceptionDetails, not as
  // protocol errors, so this check happens after the first result.)
  if (step.res && step.res.exceptionDetails && /await is only valid/i.test(firstLineOf(step.res.exceptionDetails))) {
    log('retrying eval wrapped in an async IIFE (top-level await)');
    step = await attempt(`(async () => { ${expression} })()`);
  }

  if (step.protocolError) {
    const msg = step.protocolError;
    // Circular / too-deep values cannot cross the protocol with returnByValue.
    if (/returned by value|serializ|couldn't be|too long|not JSON-serializable/i.test(msg)) {
      return { unserializable: true, raw: msg };
    }
    return { error: msg };
  }

  const res = step.res;
  if (res.exceptionDetails) {
    return { error: firstLineOf(res.exceptionDetails) || 'evaluation threw' };
  }

  const result = res.result || {};
  if (Object.prototype.hasOwnProperty.call(result, 'unserializableValue') && result.unserializableValue !== undefined) {
    return { unserializable: true, raw: result.unserializableValue };
  }
  if (result.type === 'undefined') return null;
  if (result.objectId && !Object.prototype.hasOwnProperty.call(result, 'value')) {
    // e.g. a DOM node: try once more to pull something printable.
    try {
      const sub = await send(
        'Runtime.callFunctionOn',
        {
          objectId: result.objectId,
          functionDeclaration: 'function(){try{return String(this);}catch(e){return null;}}',
          returnByValue: true,
          silent: true,
        },
        5000,
      );
      if (sub.result && sub.result.value !== undefined) return sub.result.value;
    } catch {
      /* fall through */
    }
    return { unserializable: true, raw: result.description || result.type };
  }
  if (!Object.prototype.hasOwnProperty.call(result, 'value')) return { unserializable: true, raw: result.description || result.type || 'no-value' };
  return result.value;
}

/* -------------------------------------------------------------------- run */

main()
  .then((code) => {
    process.exitCode = code;
    // give stdout/stderr a tick to flush before the process goes away
    setTimeout(() => process.exit(code), 50);
  })
  .catch((e) => {
    try {
      process.stderr.write(`[probe] unexpected crash: ${e && e.stack ? e.stack : e}\n`);
      process.stdout.write(`PROBE_JSON:${JSON.stringify({ ok: false, fatal: String(e && e.message ? e.message : e) })}\n`);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
