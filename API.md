# PanHub 开放 API

PanHub 的搜索与「获取」接口对外开放，任何第三方页面/应用都可以直接调用。
本文档描述鉴权方式、接口协议、错误码与风控规则。

- **服务地址**：`https://panhub.shenzjd.com/api`
- **登录服务**：`https://wx-auth.shenzjd.com`
- **跨域**：服务端已全量放开 CORS（`Access-Control-Allow-Origin: *`）

---

## 1. 调用链路

```
① 用 wx-auth-sdk 完成登录 → 拿到 token
② GET  /api/search.stream?kw=关键词     搜索（SSE 流式）
③ POST /api/transfer {id: tid}          对带 tid 的条目换取分享链接
```

搜索结果是**按网盘类型分组**的，其中已接入转存的条目只下发 `tid`、
**不下发真实直链**——必须调 `/api/transfer` 才能换回可用的分享链接。

---

## 2. 鉴权

### 2.1 鉴权口径

- **搜索 / 探活**：对访客开放。第三方页面用 wx-auth-sdk（≥1.2.44）的
  `getOrCreateAnonTicket()` 取一张匿名票据，拼在请求 URL `?at=` 上即可；
  拿不到票据也照发（服务端对无票请求有独立策略，不承诺放行）。
- **「获取」（转存）**：强制登录，Bearer token 必带。
- 登录方式：关注公众号 + 验证码，或小程序扫码。

### 2.2 拿 token

使用官方 SDK（UMD，全局单例 `window.WxAuth`）：

```html
<script src="https://unpkg.com/wx-auth-sdk/dist/wx-auth.umd.js"></script>
<script>
  WxAuth.init({
    apiBase: "https://wx-auth.shenzjd.com",
    silent: true,      // 静默校验本地已有登录态
    required: true,    // 弹窗不可关闭，必须完成验证
    onVerified(user) {
      console.log("已登录", user);
    },
  });

  // 需要登录时弹出认证窗口
  WxAuth.showAuthModal();
</script>
```

登录成功后，SDK 会把 token 写入**当前域名**的 Cookie `wxauth-token`
（JS 写入，非 HttpOnly，可被前端读取）。

### 2.3 带 token 调接口

token 通过 `Authorization` 头传递：

```
Authorization: Bearer <wxauth-token>
```

> **不要用 Cookie 模式。** Cookie 只在同域请求下有效；第三方站点跨域调用时，
> 浏览器不会带上目标域的 Cookie，必须使用 Bearer 头。

---

## 3. 接口清单

| 接口 | 方法 | 鉴权 | 用途 | 本站使用 |
|---|---|---|---|---|
| `/api/search.stream` | GET (SSE) | 访客票 `?at=` / Bearer | **搜索主通道**，边搜边出 | ✅ |
| `/api/search` | GET | 同上 | 搜索（非流式 / 批次模式） | — |
| `/api/transfer` | POST | ✅ Bearer | **「获取」换取分享链接** | ✅ |
| `/api/check` | POST | 访客票 `?at=` | 链接探活（疑似失效弱提示） | ✅ |
| `/api/hot-keywords` | GET | ❌ | 推荐关键词词表 | ✅ |
| `/api/curated-resources` | GET | ❌ | 精选资源清单 | ✅ |
| `/api/announcement` | GET | ❌ | 站点公告 | ✅ |
| `/api/notice-popup` | GET | ❌ | 弹窗公告 | ✅ |
| `/api/health` | GET | ❌ | 健康检查 | — |

> 「本站使用」一列标注了 PanHub 站点实际调用的接口；其余接口依然对外开放，
> 接入方按需自取。

---

## 4. 搜索：`GET /api/search.stream`

SSE 长连接承载整个搜索，服务端边搜边推送增量结果。

### 请求参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `kw` | ✅ | 搜索关键词，最长 200 字符 |
| `at` | | 匿名票据（wx-auth-sdk `getOrCreateAnonTicket()`，访客准入） |
| `cat` | | 类别过滤：`quark` / `baidu` / `xunlei` / `uc` / `mobile` / `tianyi` / `aliyun` / `115` / `123` |
| `maxResults` | | 本轮目标结果数上限（默认 90）。「继续搜索」时传「已收数量 + 90」 |
| `skipTasks` | | 断点续跑：已完成的内部任务索引，逗号分隔 |
| `initialTotal` | | 前端已有结果数，参与上限判断 |
| `refresh` | | `true` 时跳过服务端缓存 |

### 响应（SSE）

```
event: chunk
data: {"done":1,"total":12,"merged":{"quark":[...],"baidu":[...]}}

event: done
data: {"total":126,"warnings":[],"pluginCount":8,"merged":{...},"completedIndices":[0,1,2],"reachedLimit":true}
```

- `chunk`：每完成一批推送一次，`merged` 是**累计快照**（直接用最新一份覆盖即可）
- `done`：搜索结束。`reachedLimit: true` 表示已达上限且仍有未跑任务，
  前端可展示「继续搜索」，带着 `skipTasks` + `initialTotal` 再连一次
- `error`：`data: {"message":"..."}`

### 结果条目结构

```json
{
  "url": "https://pan.quark.cn/s/xxxx",
  "password": "",
  "note": "资源标题",
  "datetime": "2026-09-10T12:00:00.000Z",
  "source": "tg:频道名",
  "tid": "a1b2c3d4"
}
```

> **`tid` 是「获取」的唯一凭证。** 有 `tid` 的条目其 `url` 已被服务端剥离（空串），
> 前端不应尝试自行拼接或缓存直链。

---

## 5. 搜索（非流式）：`GET /api/search`

> PanHub 站点**未使用**该接口（只用 SSE 主通道），此处保留给需要
> 「一次请求拿到完整结果」或需要自行控制分批节奏的接入方。

常用作流式不可用时的回退方案。

| 参数 | 说明 |
|---|---|
| `kw` | 关键词（必填） |
| `countOnly=1` | 只返回批数，不实际搜索：`{"data":{"totalBatches":6}}` |
| `batch` / `batchSize` | 批次序号与批次大小（`batchSize` 建议 2） |
| `res` | 固定 `merged_by_type` |
| `src` | `tg` / `plugin` / `all` |
| `cat` | 同 `/api/search.stream` |

响应为标准信封：

```json
{ "code": 0, "message": "ok", "data": { "merged_by_type": { "quark": [...] } } }
```

---

## 6. 「获取」：`POST /api/transfer`

请求体（`id` 模式）：

```json
{ "id": "a1b2c3d4" }
```

`Content-Type: application/json`。

**必须把搜索结果里的 `tid` 原样回传**。少数条目（正版合规源等非网盘条目）没有 `tid`，
此时把条目的 `url` 传上来即可：

```json
{ "url": "https://…", "name": "资源标题" }
```

无 `tid` 时后端**不转存**（避免成为「替任何人转存任意链接」的代理），只把原链接
原样交付回来。所以接入方不要自行展示/缓存原链接来绕过这个接口：
原链接交付与转存交付对用户是同一回事。请求体可带 `at`（匿名票据，登录用户
顺手携带即可，用于服务端侧的设备维度风控）。

### 成功响应

```json
{
  "code": 0,
  "data": {
    "share_url": "https://pan.quark.cn/s/yyyy",
    "passcode": "",
    "expired_at": 0,
    "name": "资源标题",
    "cached": true
  }
}
```

### 确定性失效

链接已不可用（被删除 / 需要提取码）时返回 `code: 1`：

```json
{ "code": 1, "data": { "dead": true, "kind": "expired", "message": "该资源已失效…" } }
```

### 未获取到新链接（`fallback`）

风控 / 容量 / 权限 / 凭证失效等**结果确定失败**的情况，返回 `code: 0` + `fallback: true`，
并附中性 `message`；原链接会放进 `share_url`（仍可用，只是不是我们账号的新分享）：

```json
{
  "code": 0,
  "data": {
    "fallback": true,
    "message": "服务暂时繁忙，未能获取到新链接",
    "share_url": "https://…",
    "passcode": ""
  }
}
```

超时 / 网络等**结果未知**的情况维持纯静默回退（不带 `fallback` 字段），
避免把可能已成功的请求说成失败。

> 两种情况的 `code` 都是 0、`share_url` 都存在——接入方至少要展示 `fallback` 分支的
> `message`，否则用户会把「回退的原链接」误认成转存成功。

### 积分不足（`insufficient`）与每日限流（`limited`）

服务端按账号积分计费（每次获取扣分，分值由服务端配置）。积分不足时**不转存、也不回退原链接**，
返回 `code: 0` 并带 `insufficient: true`：

```json
{
  "code": 0,
  "data": {
    "limited": true,
    "insufficient": true,
    "message": "积分不够了，扫码看个广告（+10 积分）就能继续获取。",
    "points": { "balance": 0, "amount": 1, "adReward": 10, "adsRemaining": 3 }
  }
}
```

此时正确动作是**引导用户赚分**（官方前台弹出小程序码看激励视频，轮询
`/api/points/ad-status` 等积分到账后自动重试本次获取），而**不是**提示「资源已失效」——
后者会让用户误以为链接坏了。

每日限流（可在线配置，默认关闭）命中时返回
`{ limited: true, used, limit, driver, message }`，只停该网盘当天，换网盘或次日再试即可。

### 扣分回执（`points`）

链接交付成功时（真实转存 / 缓存命中 / 回退原链接 / 非转存盘型直给）下发：

```json
{ "points": { "charged": "points", "amount": 1, "balance": 9 } }
```

`charged` 取值：`points`（真扣分）/ `unlock`（抵扣看广告获得的放行额度）/
`replayed`（幂等重放，未重复扣分）。
用户没拿到链接的路径（失效、限流、积分不足）一律不计费。

### 复制口令格式

拿到 `share_url` / `passcode` 后，**必须按网盘官方口令格式拼装**再写入剪贴板，
裸 URL 在多数网盘 APP 里无法被识别：

- **夸克**：多行，开头话术 + `链接：xxx` + `提取码：xxx`
- **百度**：单行 `链接：xxx 提取码：xxx` + 官方提示语
- **迅雷**：链接带 `?pwd=xxx#` + App 话术
- **UC**：多行，以 `来自UC网盘分享文件：` 开头

参考实现见本仓库 `src/utils/shareText.ts`。

---

## 7. 其他接口

### 积分（需登录）

「获取」按账号积分计费，积分先由每日签到、再看激励广告补充。

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/points/balance` | GET | ✅ Bearer | 余额 + 今日是否已签到 + 分值参数 |
| `/api/points/checkin` | POST | ✅ Bearer | 每日签到（幂等） |
| `/api/points/ad-qr` | POST | ✅ Bearer | 看广告赚分 · 出码 |
| `/api/points/ad-status` | GET | ❌ | 看广告赚分 · 票据状态轮询 |

`GET /api/points/balance`（分值都由服务端下发，前端不要写死数字）：

```json
{ "ok": true, "balance": 9, "checkedIn": true, "checkinReward": 3, "adReward": 10, "adsRemaining": 3 }
```

`POST /api/points/checkin`——按**北京自然日**幂等，进页时无脑调一次即可，
已领过返回 `granted: 0` 不报错：

```json
{ "ok": true, "granted": 3, "balance": 12 }
```

看广告赚分闭环（官方前台的真实用法）：

```json
// ① POST /api/points/ad-qr —— 服务端用**你自己的凭证**领票并签发小程序码
{ "ok": true, "qrDataUrl": "data:image/png;base64,…", "ticket": "xxxxxxxx", "expiresIn": 900 }

// ② GET /api/points/ad-status?ticket=xxxxxxxx —— 每 2s 轮询一次
{ "status": "pending" }
```

`status` 取值：`pending`（还没看完，继续轮询）/ `redeemed`（积分已到账，可重试本次获取）/
`expired`（票过期，提示用户重新点「获取」）。

> 票是 128 位随机串、不可枚举，所以状态查询不鉴权；出码必须用自己的 token，
> 用服务端凭证代领会把积分记到别人账号上。
> 出码失败一律返回 `200 + ok: false`，接入方按「稍后再试」降级即可。

### `POST /api/check`（无需登录）

```json
{ "items": [{ "url": "https://pan.quark.cn/s/xxx", "password": "" }] }
```

单次最多 50 条。响应：

```json
{
  "code": 0,
  "data": {
    "results": [{ "url": "...", "status": "ok", "reason": "" }]
  }
}
```

`status` 取值：`ok` / `bad`（失效）/ `locked`（需密码）/ `unsupported` / `uncertain`。

### `GET /api/hot-searches?limit=25`

```json
{ "code": 0, "data": { "hotSearches": [{ "term": "关键词", "score": 12 }] } }
```

### `GET /api/douban-hot?category=douban-top250&page=1&limit=25`

```json
{ "code": 0, "data": { "items": [{ "id": 1, "title": "…", "cover": "…" }], "hasMore": true } }
```

### `GET /api/announcement`

```json
{ "code": 0, "data": { "version": 10, "items": [{ "id": "x", "text": "公告内容", "link": "" }] } }
```

### `GET /api/img?url=<encodeURIComponent(图片地址)>`

图片代理（解决豆瓣封面防盗链），直接返回图片二进制。

---

## 8. 错误码

| HTTP | 含义 | 处理建议 |
|---|---|---|
| `400` | 参数错误（如 `kw` 缺失或超长） | 检查参数 |
| `401` | 有凭证但已失效（如取消关注） | 重新走登录流程后重试 |
| `403` | 脚本 UA 被拦截 | **使用浏览器发起请求**，不要用 curl / Node |
| `404` | `tid` 已过期（服务重启 / 超时） | 重新搜索获取新 `tid` |
| `429` | 触发频控 | 读取 `Retry-After` 头后重试 |
| `503` | 该能力暂不可用 | 回退为直接展示原链接 |

---

## 9. 限频与风控

| 规则 | 阈值 | 说明 |
|---|---|---|
| 搜索 IP 频控 | 30 次 / 60s | 三个搜索端点共享计数 |
| 搜索 openid 频控 | 30 次 / 60s | 防止「换 IP 绕 IP 频控」 |
| 链接探活 | 15 次 / 60s | 每次最多 50 条链接 |
| 脚本 UA | 命中即拦 | `curl` / `wget` / `python-requests` / `axios` 等 |
| 未认证请求 | 命中即拦 | 有凭证但失效才会返回 401 |

### ⚠️ 两条必须遵守的规则

1. **必须由浏览器直连。** 不要用服务端（Node / Python / 云函数）代理转发请求，
   代理的 UA 会被判定为脚本，导致出口 IP 被拉黑。
2. **无凭证请求不会报错。** 后端会对无凭证请求返回**结构完全一致的演示数据**
   （HTTP 200）。如果你看到的是固定不变的假结果，说明登录态没生效，
   请检查 `Authorization: Bearer <token>` 是否带上。

---

## 10. 最小可用示例

```js
const API = "https://panhub.shenzjd.com/api";

/** 从本域 Cookie 读取 SDK 写入的 token */
function getToken() {
  const m = document.cookie.match(/(?:^|;\s*)wxauth-token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 搜索（SSE 流式） */
async function search(keyword, onChunk) {
  const resp = await fetch(
    `${API}/search.stream?kw=${encodeURIComponent(keyword)}`,
    {
      // 跨域 + 通配 CORS，必须 omit；认证只靠 Authorization 头
      credentials: "omit",
      headers: {
        accept: "text/event-stream",
        Authorization: `Bearer ${getToken()}`,
      },
    }
  );

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      const payload = JSON.parse(data);
      if (event === "chunk" && payload.merged) onChunk(payload.merged);
      if (event === "done") return payload.merged;
    }
  }
}

/** 获取（换取分享链接） */
async function transfer(tid) {
  const resp = await fetch(`${API}/transfer`, {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ id: tid }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
```
