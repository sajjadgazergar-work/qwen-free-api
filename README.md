# Qwen-Free-API

Unified OpenAI-compatible Gateway for Qwen Web API from scratch, mirroring the design and setup of `ds-free-api` but built for Alibaba's Qwen models.

## Features

- **Zero-cost API Gateway**: Wraps Qwen web platform capabilities into an OpenAI-compatible endpoint.
- **Dynamic anti-bot bypass**: Built-in Baxia header spoofing (`bx-ua`, `bx-umidtoken`, `bx-v`) to bypass Aliyun WAF without requiring heavy headless browsers like Playwright/Puppeteer.
- **Multimodal & Attachments support**: Supports parsing and uploading inline images/documents as attachments.
- **Rotatable Account Pool**: Supports comma-separated tickets in environment variables or request headers.
- **Robust stream handling**: SSE client-side streaming mapping Qwen's incremental response to OpenAI chat completion chunks.

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
