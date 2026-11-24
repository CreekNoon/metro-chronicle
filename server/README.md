# 城市地铁线网开通纪事 · 本地服务端

零依赖（只用 `node:http` / `node:fs` / `node:path` / `node:url`）的单文件前端本地服务：托管成品页面 + 方案/城市 JSON API + 原子落盘。

- 端口：`8787`（`PORT` 可覆盖），默认只监听 `127.0.0.1`
- 数据文件：`metro-chronicle/server/data/store.json`（首次写入时自动创建目录）
- 请求体上限：512KB（超出返回 `413`）

## 启动

```powershell
node metro-chronicle/server/server.mjs
```

启动日志示意：

```
[metro] 服务已启动：http://127.0.0.1:8787
[metro] 静态根：C:\Users\Ray\Documents\deepseek-harness\default-workspace , ...\metro-chronicle\dist
[metro] 首页：C:\Users\Ray\Documents\deepseek-harness\default-workspace\地铁线网开通纪事.html（存在时优先）
[metro] 数据文件：...\metro-chronicle\server\data\store.json（plans=0 cities=0）
```

换端口 / 换监听地址（PowerShell）：

```powershell
$env:PORT=8799; node metro-chronicle/server/server.mjs
$env:HOST='0.0.0.0'; node metro-chronicle/server/server.mjs
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口；非法值（非 1..65535 整数）回退 8787 并打印一行告警 |
| `HOST` | `127.0.0.1` | 监听地址；改成 `0.0.0.0` 可局域网访问（注意本服务无鉴权） |

## 静态资源

| 路径 | 实际文件 |
| --- | --- |
| `GET /` 或 `/index.html` | 工作区根目录 `地铁线网开通纪事.html`（不存在时回退 `metro-chronicle/dist/metro-chronicle.html`） |
| `GET /dist/metro-chronicle.html` | `metro-chronicle/dist/metro-chronicle.html` |
| `GET /metro-chronicle.html`、`GET /shot-*.png` | 同上 dist 目录（简写别名） |
| `GET /地铁线网开通纪事.html` | 工作区根目录同名文件（URL 编码亦可） |

- 只服务 `.html` / `.css` / `.js` / `.png` 四类扩展名，其它类型（含 `.json`）一律 404。
- 二进制读取原样写回，响应带 `charset=utf-8`、无 BOM、`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`。
- 目录穿越防护：URL 先 `decodeURIComponent`，反斜杠归一为 `/`，出现 `..` 段直接 `403`；随后每个候选路径都做 `path.resolve` 并校验必须落在允许根目录（工作区根 + `metro-chronicle/dist`）内，否则 `403`。
- 支持 `HEAD`；`GET/HEAD` 之外的静态请求返回 `405`。

## API（全部 JSON，UTF-8，无 BOM）

| 方法 | 路径 | 成功响应 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | `200 { ok:true, version:"1.0.0", time:"<ISO>", plans:<int> }` | 健康检查；`plans` 为已存储方案数 |
| GET | `/api/plans?city=<cityId>` | `200 { cityId, plan }` | 不存在 → `404 { error:"not_found" }` |
| GET | `/api/plans`（省略 city） | `200 { cities:[cityId...], count }` | 已存储方案的 cityId 列表（升序） |
| PUT | `/api/plans?city=<cityId>` | `200 { ok:true, cityId, savedAt }` | 请求体为 plan 对象；校验失败 → `400 { ok:false, error:"invalid_plan", reason }` |
| DELETE | `/api/plans?city=<cityId>` | `204`（无响应体） | 幂等：不存在也返回 204，且不写盘 |
| GET | `/api/cities` | `200 { cities:[{id,name,view:{center:[lat,lng],zoom}}...] }` | 自定义城市列表，初始为 `[]` |
| PUT | `/api/cities` | `200 { ok:true, count }` | 请求体为城市对象数组；校验失败 → `400 { ok:false, error:"invalid_cities", reason }` |
| OPTIONS | 任意 `/api/*` | `204` | CORS 预检（允许 `*`，便于 `file://` 页面直连） |
| 任意 | 其它 `/api/*` | `404 { error:"unknown_endpoint" }` | 未知端点 |
| 任意 | 已知端点 + 不支持的方法 | `405 { ok:false, error:"method_not_allowed" }` | 带 `Allow` 头 |

其它错误：`400 { ok:false, error:"invalid_json"|"missing_city"|"invalid_city", reason }`、`413 { ok:false, error:"payload_too_large", reason }`、`500 { ok:false, error:"internal_error"|"storage_error", reason }`。所有错误都走 JSON，进程不退出，每个失败请求打印一行 `console.error`。

### 示例

```powershell
# 健康检查
curl.exe -s http://127.0.0.1:8787/api/health

# 保存方案（body 为 plan JSON，文件需 UTF-8 无 BOM）
curl.exe -s -X PUT "http://127.0.0.1:8787/api/plans?city=test" `
  -H "Content-Type: application/json; charset=utf-8" --data-binary "@plan.json"

# 读取 / 列表 / 删除
curl.exe -s "http://127.0.0.1:8787/api/plans?city=test"
curl.exe -s "http://127.0.0.1:8787/api/plans"
curl.exe -s -o NUL -w "%{http_code}`n" -X DELETE "http://127.0.0.1:8787/api/plans?city=test"
```

## 数据文件

位置：`metro-chronicle/server/data/store.json`

```json
{
  "version": 1,
  "plans": { "<cityId>": { "cityId": "...", "cityName": "...", "view": {}, "lines": [] } },
  "cities": [],
  "updatedAt": "2026-11-24T12:39:50.825Z"
}
```

- **原子写**：先 `mkdirSync(recursive)`，写 `store.json.tmp`，再 `fs.renameSync` 覆盖 `store.json`；写失败时回滚内存中的这次改动并返回 500。
- **内存缓存**：启动时读一次，之后 GET 全部命中内存；每次成功写盘后缓存即为最新。
- **损坏自愈**：启动时若文件缺失 / JSON 损坏 / 根结构非法，先把原文件备份为 `store.json.broken-<ISO 时间戳>`（如 `store.json.broken-2026-11-24T12-39-48-906Z`），随后使用空结构继续启动，日志打印一行说明。
- 清洗说明：`PUT` 会原样保存请求体（不补字段、不改数值），因此 `GET` 返回与 `PUT` 内容一致（仅 JSON 文本层面的数字写法可能不同，例如 `27.80` → `27.8`）。

## plan 校验规则（`PUT /api/plans`）

| 字段 | 规则 |
| --- | --- |
| `cityId` | 非空字符串，且必须与查询参数 `city` 完全一致 |
| `cityName` | 字符串，1..24 字符 |
| `view.center` | `[lat, lng]` 两元素数字数组；lat `-85..85`，lng `-180..180` |
| `view.zoom` | 数字，`3..18` |
| `lines` | 数组，`1..8` 条；`key` 非空且组内唯一 |
| `lines[].badge` | 字符串，1..4 字符 |
| `lines[].name` | 字符串，1..24 字符 |
| `lines[].color` | 匹配 `^#[0-9a-fA-F]{3,8}$` |
| `lines[].type` | 只允许 `"metro"` / `"intercity"`；**缺省视为 `"metro"`**（前端未写该字段也能保存） |
| `lines[].dateText` | 字符串，1..16 字符 |
| `lines[].status` | 字符串，1..8 字符 |
| `lines[].stations` | 数组，`0..40` 站；线内 `key` 唯一 |
| `stations[].name` | 字符串，1..24 字符 |
| `stations[].lat` / `lng` | 数字；lat `-85..85`，lng `-180..180` |
| `stations[].side` | 必填，只允许 `top` / `bottom` / `left` / `right` |
| `stations[].ghost/shared/terminal` | 可缺省；出现时必须是布尔 |
| 跨线路同名站 | 相同 `key` 的坐标必须一致（误差 ≤ `1e-9`），否则 400 并在 `reason` 中给出该 key |

错误统一为 `400 { ok:false, error:"invalid_plan", reason:"<中文说明>" }`，`reason` 会指出具体线路/站点（例如 `站点 a 的 lat 必须是数字，当前为 "27.8"`）。

## 限制与注意事项

1. 无鉴权、无 TLS、只监听回环地址；把 `HOST` 改成 `0.0.0.0` 前请确认网络环境可信。
2. 单进程内存缓存 + 同步写盘：适合本地单人使用；多实例同时写同一 `store.json` 会以后写者为准（不做文件锁）。
3. 静态白名单只含 `.html/.css/.js/.png`；工作区根目录是静态根，因此工作区内的同名资源也可被读取（`server/data/store.json` 属 `.json`，不会被暴露）。
4. `DELETE` 幂等（不存在的 city 也返回 204），不会因为误删报错。
5. `PUT /api/cities` 最多 200 个城市；城市 `id` 不可用 `__proto__` / `constructor` / `prototype`。
6. 服务端不做坐标投影与数据规范化，WGS84 → GCJ-02 的底图投影仍在前端完成。
