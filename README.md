# Conduit v0.2.1

Conduit is an expandable, multi-provider harness that exposes website-backed AI providers through one OpenAI-compatible API and one provider-neutral control plane.

This release includes:

- **Qwen** — native TypeScript provider with multimodal requests, streaming, account rotation, and schema-validated tool calling.
- **DeepSeek** — managed Rust provider using `ds-free-api` for its specialized transport, account login, sessions, and tool-call repair.
- **Gemini** — managed Python provider using `Gemini-FastAPI` and `gemini-webapi` for Google browser sessions, rotating-cookie refresh, model discovery, multimodal input, conversation reuse, and OpenAI-compatible tool calling.
- **Unified dashboard** — add, inspect, and remove all three providers' accounts at `/admin`.
- **Unified models and chat** — `GET /v1/models` merges provider models; `POST /v1/chat/completions` routes by model prefix or explicit provider.

## Architecture

```text
OpenAI client
     |
     v
Conduit :8000
  |-- Qwen adapter (native TypeScript)
  |     `-- browser-session pool + canonical tool protocol
  |-- DeepSeek adapter (managed service)
  |     `-- ds-free-api :22217
  `-- Gemini adapter (managed service)
        `-- Gemini-FastAPI :8000
              `-- gemini-webapi + rotating Google sessions
```

The managed-service boundary is deliberate. Gemini Web's private RPC shape, model headers, XSRF behavior, and cookie rotation change independently of Conduit. Pinning the maintained service is safer than copying a hard-coded 80-field request array into the gateway. Conduit owns routing and account administration; the provider owns its volatile web transport.

## Start

```bash
cp .env.example .env
docker compose up --build -d
```

The bundled stack wires DeepSeek and Gemini internally. Do not enter provider base URLs in the dashboard and do not expose the provider services. Every OpenAI-compatible client uses the single Conduit base URL shown on the dashboard.

Open:

- Dashboard: `http://localhost:8000/admin`
- OpenAI base URL: `http://localhost:8000/v1`

Provider state persists under `./data`; provider configuration persists under `./config`.

## Account onboarding

### Qwen

Qwen uses Alibaba browser SSO. Sign in at Qwen, then import the complete Cookie header, supported ticket, or supported web bearer session. Conduit does not collect the Alibaba password.

### DeepSeek

Add the email/mobile account and the password used at `chat.deepseek.com`. Conduit creates and stores its own internal provider-management secret automatically; there is no separate provider-admin password to create, remember, or enter in the dashboard. The bundled provider performs website login and session refresh.

DeepSeek's upstream project only supports account/password login; it does not currently support importing an existing browser cookie as an account. If the DeepSeek account was created through Google or another federated method and has no password, set a password through DeepSeek's account flow before adding it.

### Gemini

Gemini uses Google browser sessions rather than direct password login:

1. Open `https://gemini.google.com` in a private/incognito window and sign in.
2. Open Developer Tools → Network, select a Gemini request, and copy its complete `Cookie` request header.
3. Paste that one header into Conduit. Conduit extracts `__Secure-1PSID` and `__Secure-1PSIDTS` automatically.
4. Optionally assign a per-account proxy.

You can still submit the two values separately through the management API for backward compatibility.

The provider validates the session before saving it. Secrets are never returned by Conduit's admin APIs. Auto-refreshed cookies are persisted in the Gemini cache volume.

## Routing

| Selection | Provider |
|---|---|
| `model: "qwen..."` | Qwen |
| `model: "deepseek-..."` | DeepSeek |
| `model: "gemini-..."` | Gemini |
| `provider: "deepseek"` | DeepSeek explicit override |
| `provider: "gemini"` | Gemini explicit override |

Responses include `x-conduit-provider` with the selected provider.

## Models

Conduit asks the Gemini service for its current model registry instead of hard-coding speculative IDs such as `gemini-3.1-pro` or `gemini-3.6-flash`. Available models depend on upstream library support and the Google account tier. `GEMINI_MODELS` is only a discovery fallback when the service is temporarily unavailable; it does not unlock models.

```bash
curl http://localhost:8000/v1/models
```

## Chat example

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-3-pro",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": false
  }'
```

Use an ID returned by `/v1/models` for the selected account and provider.

## Tool calling

The public contract is OpenAI-compatible:

- clients send `tools` and `tool_choice`;
- Conduit returns `assistant.tool_calls` with `finish_reason: "tool_calls"`;
- clients execute functions and submit matching `role: "tool"` results;
- the selected provider produces the next turn.

Qwen uses Conduit's schema-preserving canonical tool protocol and bounded repair. DeepSeek and Gemini retain provider-specific parsers behind the same public contract. Gemini-FastAPI preserves full function schemas and supports `none`, `auto`, `required`, and named function choices.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8000` | Conduit HTTP port |
| `ADMIN_PASSWORD` | empty | Optional Basic Auth for dashboard routes |
| `QWEN_TOKENS` | empty | Optional Qwen bootstrap sessions |
| `QWEN_ACCOUNT_COOLDOWN_MS` | `30000` | Qwen cooldown after failure |
| `DEEPSEEK_BASE_URL` | `http://deepseek:22217` | Advanced external-service override; bundled deployment needs no change |
| `DEEPSEEK_ADMIN_PASSWORD` | generated automatically | Optional fixed internal management secret |
| `DEEPSEEK_UPSTREAM_API_KEY` | empty | Optional DeepSeek API key |
| `GEMINI_BASE_URL` | `http://gemini:8000` | Advanced external-service override; bundled deployment needs no change |
| `GEMINI_MANAGEMENT_KEY` | private bundled default | Optional internal account-management authentication override |
| `GEMINI_UPSTREAM_API_KEY` | empty | Optional Gemini service API key |
| `GEMINI_TIMEOUT_MS` | `300000` | Gemini proxy timeout |
| `GEMINI_MODELS` | fallback list | Models shown only when live discovery fails |

## Important limitations

- Gemini Web is an undocumented interface and can break when Google changes it.
- Google may require re-login, CAPTCHA, device approval, or other interactive verification. Conduit never automates these challenges.
- Model availability is account- and region-dependent; paid models are not made free by the proxy.
- Session cookies grant account access. Use a separate browser session/account, owner-only storage, a strong dashboard password, and a private network.
- Review Google's terms before deployment or distribution.

## Provider extension contract

New providers under `src/providers/` implement request selection, model discovery, chat proxying, health, account management, normalized errors, and the `x-conduit-provider` header. Provider-specific authentication and transport stay behind that adapter.

## Licensing

Conduit includes third-party provider source and notices. `ds-free-api` is GPLv3. `Gemini-FastAPI` is MIT, while its `gemini-webapi` dependency is AGPL-3.0. Review `THIRD_PARTY_NOTICES.md` and the corresponding licenses before distribution.
