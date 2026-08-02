# DeepSeek 后端 API 参考

本文档描述 `ds_core` 内部 `DsClient` 向 DeepSeek 后端发起的原始 HTTP 请求。

## 基本信息

### Base URLs

- `https://chat.deepseek.com/api/v0` — 所有 API 端点
- `https://fe-static.deepseek.com` — WASM 文件下载

### 公共请求头

| Header | 说明 |
|--------|------|
| `User-Agent` | 必填，WAF 绕过，值需像真实浏览器 UA |
| `Authorization: Bearer <token>` | 鉴权请求必填 |
| `X-Ds-Pow-Response: <base64>` | 需要 PoW 的请求必填 |
| `X-Client-Version` | 客户端版本号（当前对应 `2.0.0`） |
| `X-Client-Platform` | 客户端平台 |
| `X-Client-Locale` | 客户端语言区域 |

### 响应信封格式

所有非流式响应使用统一的 `Envelope` 封装：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": { ... }
  }
}
```

- `code != 0` → 系统级错误（如 40003 无效 Token）
- `biz_code != 0` → 业务级错误
- `biz_data` → 实际数据

### PoW target_path 映射

| 端点 | target_path |
|------|-------------|
| completion | `/api/v0/chat/completion` |
| edit_message | `/api/v0/chat/edit_message` |
| upload_file | `/api/v0/file/upload_file` |

### 错误响应格式

| 情况 | 格式 |
|------|------|
| 字段缺失 | HTTP 422: `{"detail":[{"loc":"body.<field>"}]}` |
| 无效 Token | HTTP 200: `{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}` |
| 业务错误 | HTTP 200: `{"code":0,"data":{"biz_code":<N>,"biz_msg":"<msg>","biz_data":null}}` |
| 登录失败 | HTTP 200: `{"code":0,"data":{"biz_code":2,"biz_msg":"PASSWORD_OR_USER_NAME_IS_WRONG"}}` |

---

## 0. 登录 login

- **URL**: `POST /api/v0/users/login`
- **请求头**:
  - `User-Agent`：必填
  - `Content-Type: application/json`：可选（HTTP 库自动设置时不需要）
- **请求体**:

```json
{
  "email": null,
  "mobile": "[phone_number]",
  "password": "<password>",
  "area_code": "+86",
  "device_id": "[任意 base64 或空字符串，但字段不能省略]",
  "os": "web"
}
```

- `email` / `mobile`：二选一，另一个传 `null`
- `device_id`：必填字段（省略 → 422），但值可为空或随机
- `os`：必填（省略 → 422），固定 `"web"`

- **响应**:

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "code": 0,
      "msg": "",
      "user": {
        "id": "test",
        "token": "api-token",
        "email": "te****t@email.com",
        "mobile_number": "999******99",
        "area_code": "+86",
        "status": 0,
        "id_profile": { "provider": "WECHAT", "id": "test", "name": "test", "picture": "...", "locale": "zh_CN", "email": null },
        "id_profiles": [],
        "chat": { "is_muted": 0, "mute_until": null },
        "has_legacy_chat_history": false,
        "need_birthday": false
      }
    }
  }
}
```

- **关键字段**: `data.biz_data.user.token`（后续所有请求的 Bearer token）
- **错误**: `biz_code=2` / `biz_msg="PASSWORD_OR_USER_NAME_IS_WRONG"`

---

## 1. 创建会话 create_session

- **URL**: `POST /api/v0/chat_session/create`
- **请求头**: `Authorization`, `User-Agent`
- **请求体**: `{}`
- **响应**:

```json
{
  "code": 0,
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "chat_session": {
        "id": "e6795fb3-272f-4782-87cf-6d6140b5bf76",
        "seq_id": 197895830,
        "agent": "chat",
        "model_type": "default",
        "title": null,
        "title_type": "WIP",
        "version": 0,
        "current_message_id": null,
        "pinned": false,
        "inserted_at": 1775732630.005,
        "updated_at": 1775732630.005
      },
      "ttl_seconds": 259200
    }
  }
}
```

- **关键字段**: `data.biz_data.chat_session.id`（后续 completion 用的 `chat_session_id`）
- `ttl_seconds`: 259200（3天），会话有效期

---

## 2. 获取 WASM get_wasm

- **URL**: `GET https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.<hash>.wasm`
- **请求头**: 无需鉴权，无需 User-Agent
- **响应**: 约 26KB，`Content-Type: application/wasm`，标准 WASM 格式（`\x00asm` magic number）
- **注意**: URL 中的 hash 部分可能改变，建议可配置

---

## 3. 创建 PoW Challenge create_pow_challenge

- **URL**: `POST /api/v0/chat/create_pow_challenge`
- **请求头**: `Authorization`, `User-Agent`
- **请求体**:

```json
{
  "target_path": "/api/v0/chat/completion"
}
```

- **响应**:

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "challenge": {
        "algorithm": "DeepSeekHashV1",
        "challenge": "7ffc9d19b6eed96a6fca68f8ffe30ee61035d4959e4180f187bf85b356016a96",
        "salt": "3bde54628ea8413fee87",
        "signature": "ce4678cf7a1290c2a7ac88c4195a5b8497e5fc4b0e8044e804f5a6f3af6fe462",
        "difficulty": 144000,
        "expire_at": 1775380966945,
        "expire_after": 300000,
        "target_path": "/api/v0/chat/completion"
      }
    }
  }
}
```

- 关键字段: `challenge`（哈希输入前缀）、`salt`（拼接用）、`difficulty`（目标阈值）、`expire_at`（过期时间戳 ms）
- `algorithm`: 固定 `"DeepSeekHashV1"`
- `expire_after`: 300000ms = 5 分钟有效期

---

## 4. 对话完成 completion

- **URL**: `POST /api/v0/chat/completion`
- **请求头**: `Authorization`, `User-Agent`, `X-Ds-Pow-Response`（每次请求必须重新计算）
- **请求体**:

```json
{
  "chat_session_id": "<来自 create 端点的 id>",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "你好",
  "ref_file_ids": ["file-xxx"],
  "thinking_enabled": true,
  "search_enabled": true,
  "preempt": false
}
```

- `model_type`: `"expert"`（默认）| `"default"` | 等
- `ref_file_ids`: 上传文件后返回的文件 ID 数组，会话级别记忆，后续 `edit_message` 无需重复传入
- `preempt`: 预占模式（目前网页端未使用），默认 false
- **Response**: `text/event-stream` SSE 流

### SSE 事件格式

**1. `ready` — 会话就绪**

```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}
```

`ready` 后通常紧跟 `event: update_session`，这是正常的会话更新时间，不要误认为流结束。

**2. `update_session` — 会话更新**

```
event: update_session
data: {"updated_at":1775386361.526172}
```

**3. 增量内容 — 操作符格式**

所有增量更新使用统一的数据格式，通过 `"p"`（路径）和 `"o"`（操作符）组合：

| 格式 | 示例 |
|------|------|
| `"p"` 路径 + `"v"` 值 | `{"p":"response/status","v":"FINISHED"}` |
| `"p"` + `"o":"APPEND"` + `"v"` 值 | `{"p":"response/fragments/-1/content","o":"APPEND","v":"，"}` |
| `"p"` + `"o":"SET"` + `"v"` 值 | `{"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.95}` |
| `"p"` + `"o":"BATCH"` + `"v"` 数组 | `{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},{"p":"quasi_status","v":"FINISHED"}]}` |
| 纯 `"v"` 值 | `{"v":"用户"}`（继续追加到上一 `"p"` 路径）|
| 完整 JSON 对象（初始快照） | `{"v":{"response":{"message_id":2,"fragments":[...]}}}` |

### Delta 解析算法

来自 DeepSeek 前端源码的完整 delta 解析逻辑：

```javascript
class DeltaParser {
    constructor() {
        this.op = "SET";   // 默认操作符
        this.path = "";    // 默认路径
    }

    parse(event) {
        // path/op 跨事件持久化：后续事件可省略 p/o 字段
        let op  = this.op  = event.o ?? this.op;
        let path = this.path = event.p ?? this.path;

        // 非 BATCH：返回单条操作
        if (op !== "BATCH")
            return [{ path, op, value: event.v }];

        // BATCH：分解数组中的每一项
        let subParser = new DeltaParser;
        let results = [];
        for (let item of event.v) {
            let sub = subParser.parse(item);
            for (let s of sub)
                s.path = (path ? path + "/" : "") + s.path;
            results.push(...sub);
        }
        return results;
    }
}
```

**关键规则**：

| 规则 | 说明 |
|------|------|
| `p` 和 `o` 跨事件持久化 | 后续事件可省略 `p`/`o`，沿用上一事件的值 |
| `o` 默认值为 `"SET"` | 无 `o` 字段的事件使用 SET 语义 |
| `APPEND` 对字符串 = `+=` | 纯增量追加 |
| `BATCH` 递归分解 | 子项 `p` 前置父路径 |
| 操作类型只有 3 种 | `SET`（替换）、`APPEND`（追加）、`BATCH`（批量） |

**状态更新引擎逻辑**:

```javascript
switch (op) {
case "SET":
    target[resolvePath(lastPart)] = value;  // 直接赋值
    break;
case "APPEND":
    if (typeof value === "string")
        target[resolvePath(lastPart)] += value;  // 字符串拼接
    else if (Array.isArray(value))
        // 数组合并（push 或 splice 到负索引位置）
    break;
}
```

### SSE 流状态路径

| 路径/字段 | 说明 |
|-----------|------|
| `response/fragments/-1/content` | 最后一个 fragment 的内容 |
| `response/fragments/-1/elapsed_secs` | 思考/搜索耗时（秒），仅 THINK 类型 |
| `response/fragments/-1/status` | fragment 状态 `WIP` → `FINISHED` |
| `response/fragments/-{n}/status` | 负索引标记任意 fragment 完成 |
| `response/conversation_mode` | 会话模式：`"DEFAULT"` 或 `"DEEP_SEARCH"` |
| `response/has_pending_fragment` | 后台有 fragment 处理中时为 true |
| `response/search_status` | `"SEARCHING"` → `"FINISHED"` |
| `response/accumulated_token_usage` | token 用量累计 |
| `response/quasi_status` | BATCH 内结束信号：`"FINISHED"` 或 `"INCOMPLETE"` |
| `response/status` | 主状态 `WIP` → `FINISHED` 或 `INCOMPLETE` |

### Fragment 结构

```typescript
{
  id: number,
  type: "THINK" | "RESPONSE"
      | "TOOL_SEARCH"            // 搜索查询（含 queries + results）
      | "TOOL_OPEN"              // 打开链接（含 result + reference）
      | "TIP",                   // 提示条（含 style + hide_on_wip）
  content: string | null,
  elapsed_secs?: number,         // THINK 类型：思考耗时
  status?: "WIP" | "FINISHED",
  queries?: Array<{ query: string }>,
  results?: Array<{ url: string, title: string, snippet: string, ... }>,
  result?: { url: string, title: string, snippet: string, ... },
  reference?: { id: number, type: "TOOL_SEARCH" },
  style?: "WARNING",
  hide_on_wip?: boolean,
  references?: Array<{ id: number, type: "TOOL_SEARCH" | "TOOL_OPEN" }>,
  stage_id: number
}
```

### 思考内容 vs 实际输出

通过 `fragments[].type` 字段区分：

```
type == "THINK"     → 思考内容（仅 thinking=ON 时出现）
type == "RESPONSE"  → 实际输出内容
```

### 流阶段顺序（thinking=ON, search=ON）

```
 1. SNAPSHOT    → 初始快照，fragments[0].type="THINK"
 2. THINKING    → content APPEND 追加思考内容
 3. THINK END   → elapsed_secs SET
 4. TOOL_SEARCH → APPEND TOOL_SEARCH fragment
 5. SEARCH      → results SET（大量结果）
 6. SEARCH END  → status="FINISHED"
 7. THINK(2)    → APPEND 新 THINK fragment（评估搜索结果）
 8. TOOL_OPEN   → APPEND 多个 TOOL_OPEN fragment
 9. OPEN END    → status="FINISHED"（批量标记）
10. THINK(3)    → APPEND 新 THINK fragment（整理信息）
11. RESPONSE    → APPEND RESPONSE fragment
12. CONTENT     → content APPEND 追加输出
13. REFERENCE   → BATCH 注入引用标记 [reference:N]
14. TIP         → APPEND TIP fragment
15. BATCH       → accumulated_token_usage + quasi_status="FINISHED"
16. DONE        → status="FINISHED"
```

### 流阶段顺序（thinking=OFF, search=OFF）

```
1. SNAPSHOT    → 初始快照，fragments[0].type="RESPONSE"
2. CONTENT     → content APPEND
3. BATCH       → accumulated_token_usage + quasi_status="FINISHED"
4. DONE        → status="FINISHED"
```

### `hint` — 服务端提示/错误

```
event: hint
data: {"type":"error","content":"Content is too long. Please shorten it and try again.","clear_response":true,"finish_reason":"input_exceeds_limit"}
```

- `type`: `"error"` 表示错误提示，其他值可忽略
- `finish_reason`: `"input_exceeds_limit"`（输入超长）、`"rate_limit_reached"`（限流）等
- hint 事件通常出现在 `ready` 后不久，流处理器应在收到 hint 后主动终止

### 流结束序列

**正常完成**:
```
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":139},{"p":"quasi_status","v":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":1778639258.866693}

event: title
data: {"content":"Rust所有权概念解释"}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

**手动中断**:
```
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":39},{"p":"quasi_status","v":"INCOMPLETE"}]}
data: {"p":"response/status","v":"INCOMPLETE"}
```

**最可靠的结束信号是 `response/status` 变为 `FINISHED` 或 `INCOMPLETE`。**

---

## 5. 编辑消息 edit_message

- **URL**: `POST /api/v0/chat/edit_message`
- **请求头**: `Authorization`, `User-Agent`, `X-Ds-Pow-Response`
- **请求体**:

```json
{
  "chat_session_id": "<session_id>",
  "message_id": 1,
  "prompt": "test again",
  "search_enabled": true,
  "thinking_enabled": true
}
```

- **注意**: `model_type` 和 `ref_file_ids` 不在 payload 中——二者在首次 completion 时传入后由 session 级别记忆，后续 edit_message 继承
- `message_id`: 必须已存在（空 session 的 `message_id=1` 会返回 `biz_code=26, "invalid message id"`）
- 编辑后生成新的 `message_id`，需从 SSE `ready` 事件中获取 `response_message_id` 用于后续 `stop_stream`
- **Response**: 同 `completion`（SSE 流）

---

## 6. 停止流 stop_stream

- **URL**: `POST /api/v0/chat/stop_stream`
- **请求头**: `Authorization`, `User-Agent`
- **请求体**:

```json
{
  "chat_session_id": "57bf7fb1-5fde-4d21-a08e-5dfa017216d5",
  "message_id": 2
}
```

- `chat_session_id`: 来自 create 端点的 session ID
- `message_id`: 要取消的响应消息 ID。编辑请求的 `message_id=1` 对应响应 `message_id=2`
- **不需要 PoW header**
- **作用**: 取消正在进行的流式输出。客户端断开连接后调用此端点可让 DeepSeek 侧停止继续生成。

**响应**:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```

---

## 7. 删除会话 delete_session

- **URL**: `POST /api/v0/chat_session/delete`
- **请求头**: `Authorization`, `User-Agent`
- **请求体**: `{"chat_session_id": "<session_id>"}`
- **响应**:

```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```

---

## 8. 更新标题 update_title

- **URL**: `POST /api/v0/chat_session/update_title`
- **请求头**: `Authorization`, `User-Agent`
- **请求体**:

```json
{
  "chat_session_id": "<session_id>",
  "title": "test"
}
```

- **响应**:

```json
{
  "code": 0,
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "chat_session_updated_at": 1775382827.122839,
      "title": "test"
    }
  }
}
```

- **错误码**: `biz_code=5` → `EMPTY_CHAT_SESSION`（空 session 无法设置标题）；`biz_code=1` → `ILLEGAL_CHAT_SESSION_ID`

---

## 9. 上传文件 upload_file

- **URL**: `POST /api/v0/file/upload_file`
- **请求头**: `Authorization`, `User-Agent`, `X-Ds-Pow-Response`（target_path 为 `/api/v0/file/upload_file`）
- **请求体**: `multipart/form-data`，字段名 `file`

```
Content-Disposition: form-data; name="file"; filename="test.txt"
Content-Type: text/plain
```

- **响应**:

```json
{
  "code": 0,
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "id": "file-4387ddbe-efed-4459-83b0-ebb89db61f0f",
      "status": "PENDING",
      "file_name": "test.txt",
      "from_share": false,
      "file_size": 1000,
      "model_kind": "NORMAL",
      "token_usage": null,
      "error_code": null,
      "inserted_at": 1778644590.853,
      "updated_at": 1778644590.853,
      "is_image": false,
      "audit_result": null
    }
  }
}
```

- 关键字段: `data.biz_data.id`（后续 completion 的 `ref_file_ids` 使用）
- 上传后 `status` 为 `PENDING`，需轮询 `fetch_files` 直到 `status=SUCCESS`
- 状态流转: `PENDING` → `PARSING` → `SUCCESS`（或 `FAILED`）

---

## 10. 查询文件状态 fetch_files

- **URL**: `GET /api/v0/file/fetch_files?file_ids=<id>`
- **请求头**: `Authorization`, `User-Agent`
- **响应**:

```json
{
  "code": 0,
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "files": [
        {
          "id": "file-xxx",
          "status": "SUCCESS",
          "file_name": "main.js",
          "from_share": false,
          "file_size": 2836902,
          "model_kind": "NORMAL",
          "token_usage": 619907,
          "error_code": null,
          "inserted_at": 1778644547.106,
          "updated_at": 1778644547.106,
          "is_image": false,
          "audit_result": null
        }
      ]
    }
  }
}
```

- 关键字段: `files[].status` → `SUCCESS` 表示上传完成
- 状态流转: `PENDING` → `PARSING` → `SUCCESS`
- `model_kind`: `"NORMAL"`（文本/PDF）或 `"VISION"`（图片）
- `token_usage`: 文件解析消耗的 token 数（SUCCESS 后才有值）

---

## WASM 故障处理

若 DeepSeek 更新了 WASM 文件导致 PoW 计算失败：

1. `PowSolver` 使用动态导出探测（不硬编码 `__wbindgen_export_0`），自动适配大部分 WASM 变更
2. 如仍失败，更新配置中的 `wasm_url` 指向新的 WASM 文件 URL
3. 参见 `ds_core/src/accounts/pow.rs` 中的动态探测逻辑

## WAF 绕过

- US IP 被 DeepSeek CloudFront WAF 拦截（HTTP 202 / x-amzn-waf-action）
- 配置非 US 代理即可绕过：`[proxy] url = "http://127.0.0.1:7890"`
- `wreq` 使用 BoringSSL 自动模拟 Chrome 136 TLS 指纹
