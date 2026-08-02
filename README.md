# Qwen-Free-API

Unified OpenAI-compatible Gateway for Qwen Web API from scratch, mirroring the design and setup of `ds-free-api` but built for Alibaba's Qwen models.

## Features

- **Zero-cost API Gateway**: Wraps Qwen web platform capabilities into an OpenAI-compatible endpoint.
- **Dynamic anti-bot bypass**: Built-in Baxia header spoofing (`bx-ua`, `bx-umidtoken`, `bx-v`) to bypass Aliyun WAF without requiring heavy headless browsers like Playwright/Puppeteer.
- **Multimodal & Attachments support**: Supports parsing and uploading inline images/documents as attachments.
- **Rotatable Account Pool**: Supports comma-separated tickets in environment variables or request headers.
- **Robust stream handling**: SSE client-side streaming mapping Qwen's incremental response to OpenAI chat completion chunks.
- **Validated tool calling**: Canonical Qwen function-call prompting, full JSON Schema preservation, OpenAI-compatible `tool_calls`, parallel calls, `tool_choice`, and multi-turn tool-result continuation.

## Deployed URL

Your service is deployed on Railway and available at:
`https://qwen-free-api-production.up.railway.app`

## Quick Start

### 1. Retrieve Qwen Session Token

Log in to [chat.qwen.ai](https://chat.qwen.ai/), open developer tools (`F12`), go to **Application -> Cookies**, and copy the value of either:
- `tongyi_sso_ticket`
- `login_aliyunid_ticket`

### 2. Run API Requests

You can use the token directly as a Bearer token in your client header.

#### Chat Completions

```bash
curl -X POST https://qwen-free-api-production.up.railway.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_QWEN_TICKET" \
  -d '{
    "model": "qwen3.5-plus",
    "messages": [
      {
        "role": "user",
        "content": "Hello! Introduce yourself."
      }
    ],
    "stream": true
  }'
```

#### Tool Calling

The gateway acts as a protocol adapter: it decides when a client-provided function is needed and returns OpenAI-compatible `assistant.tool_calls`. The client executes those functions and sends their results back in `role: "tool"` messages. The gateway never executes arbitrary client functions itself.

```bash
curl -X POST https://qwen-free-api-production.up.railway.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_QWEN_TICKET" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role":"user","content":"What time is it in Tehran?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get the current time in an IANA timezone.",
        "parameters": {
          "type": "object",
          "additionalProperties": false,
          "required": ["timezone"],
          "properties": {"timezone":{"type":"string"}}
        }
      }
    }],
    "tool_choice": "auto",
    "parallel_tool_calls": true
  }'
```

A tool request is returned in the standard shape:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {
          "name": "get_time",
          "arguments": "{\"timezone\":\"Asia/Tehran\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

Send the assistant call and matching result back to continue the conversation:

```json
{
  "model": "qwen3-coder-plus",
  "messages": [
    {"role":"user","content":"What time is it in Tehran?"},
    {
      "role":"assistant",
      "content":null,
      "tool_calls":[{
        "id":"call_abc",
        "type":"function",
        "function":{"name":"get_time","arguments":"{\"timezone\":\"Asia/Tehran\"}"}
      }]
    },
    {
      "role":"tool",
      "tool_call_id":"call_abc",
      "name":"get_time",
      "content":"{\"time\":\"14:30\"}"
    }
  ],
  "tools": [{
    "type":"function",
    "function":{
      "name":"get_time",
      "description":"Get the current time in an IANA timezone.",
      "parameters":{
        "type":"object",
        "additionalProperties":false,
        "required":["timezone"],
        "properties":{"timezone":{"type":"string"}}
      }
    }
  }]
}
```

Supported controls:

- `tool_choice`: `"none"`, `"auto"`, `"required"`, or a named function choice.
- `parallel_tool_calls`: set `false` to permit at most one call in a response.
- Full nested JSON Schemas are retained and validated before calls are returned.
- Invalid tool names, invalid arguments, missing results, duplicate results, and mismatched call IDs return structured errors instead of being silently repaired.

#### Image Generations

```bash
curl -X POST https://qwen-free-api-production.up.railway.app/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_QWEN_TICKET" \
  -d '{
    "prompt": "A beautiful cinematic painting of Tehran at night under rain",
    "model": "qwen3.5-plus",
    "n": 1,
    "size": "1024x1024",
    "response_format": "url"
  }'
```

## Environment Variables

Configure these in your Railway service variables:

| Variable | Description |
|---|---|
| `PORT` | Listening port (Default: `8000`) |
| `API_TOKENS` | Comma-separated list of Qwen tickets to use as a global pool. If set, you can call the API using any generic auth token. |
| `ENABLE_SEARCH` | Set to `true` to enable web search query integration on Qwen backend (Default: `false`). |

---

# Conduit v0.1: Qwen + DeepSeek

This source tree is now the first Conduit release: one OpenAI-compatible entry
point with two web providers.

## Provider routing

No new client endpoint is required. Send requests to `/v1/chat/completions`:

- models beginning with `qwen` route to the native Qwen adapter;
- models beginning with `deepseek-` route to the DeepSeek provider;
- `"provider": "deepseek"` can explicitly select DeepSeek and is removed before
  forwarding upstream;
- `GET /v1/models` combines both providers;
- `GET /admin/api/providers` reports provider configuration and health.

The response includes `x-conduit-provider: qwen|deepseek` for observability.

## Why DeepSeek is isolated

The DeepSeek web transport needs TLS client emulation, a WASM proof-of-work
solver, session lifecycle cleanup, account re-login, streaming repair, and file
upload behavior. Conduit therefore keeps the audited Rust implementation as an
isolated service instead of translating those security-sensitive details into a
partial JavaScript clone. This also provides a stable provider boundary for
adding future websites.

The DeepSeek source is included under `providers/deepseek`. See
`THIRD_PARTY_NOTICES.md` before redistribution.

## Start v0.1

```bash
cp .env.example .env
cp config/deepseek.toml.example config/deepseek.toml
# Edit .env and config/deepseek.toml, then:
docker compose up --build -d
```

In `config/deepseek.toml`, add one or more account credentials:

```toml
[[ds_core.accounts]]
email = "you@example.com"
mobile = ""
area_code = ""
password = "your-password"
```

DeepSeek obtains and refreshes its bearer token internally. Conduit never sends
those account passwords to API clients.

For Qwen, put a comma-separated credential pool in `QWEN_TOKENS`. Supported
values remain complete Cookie headers, `login_aliyunid_ticket`,
`tongyi_sso_ticket`, and currently supported Qwen web bearer values.

## Qwen username/password status

Direct server-side email/password login is intentionally **not** implemented in
v0.1. Unlike DeepSeek's stable `/users/login` flow, Qwen authentication is an
Alibaba identity/SSO browser flow that may involve CAPTCHA, OTP, federated login,
and device-risk checks. Automating it by replaying credentials would be brittle
and would encourage storing passwords in plaintext. The provider boundary is
ready for a future user-driven browser/device authorization flow, but Conduit
will not pretend that a reliable password endpoint exists.

## Tool calling

Qwen uses Conduit's canonical schema-preserving tool protocol and bounded repair
step. DeepSeek keeps its native three-tier tool-call parser and repair pipeline.
Both produce the same OpenAI `assistant.tool_calls`, continuation messages, SSE
chunks, and `finish_reason: "tool_calls"` contract at the public endpoint.

This is deliberate for v0.1: normalize the external protocol while allowing
each model family to use the prompt grammar and recovery behavior it follows
best. A later shared provider contract can consolidate metrics and conformance
tests without forcing one model's internal tags onto another.
