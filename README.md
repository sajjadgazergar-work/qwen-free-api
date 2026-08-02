# Conduit v0.1

Conduit is an expandable, multi-provider harness that exposes website-backed AI providers through one OpenAI-compatible API and one provider-neutral control plane.

This release includes:

- **Qwen** — native TypeScript provider with multimodal requests, streaming, account rotation, and schema-validated tool calling.
- **DeepSeek** — managed Rust provider using `ds-free-api` for TLS emulation, proof-of-work, login/session refresh, streaming, files, and its native tool-call repair pipeline.
- **Unified dashboard** — add, inspect, and remove Qwen and DeepSeek accounts from Conduit at `/admin`.
- **Unified model endpoint** — Qwen and DeepSeek models are returned by `GET /v1/models`.
- **Unified chat endpoint** — `POST /v1/chat/completions` routes by model prefix or explicit provider.

## Architecture

```text
OpenAI client
     |
     v
Conduit :8000
  |-- Qwen adapter (native)
  |     |-- browser-session account pool
  |     `-- canonical tool-call protocol + JSON Schema validation
  |
  `-- DeepSeek adapter (managed provider contract)
        `-- ds-free-api :22217
              |-- email/mobile account pool
              |-- login + session refresh
              `-- native transport and tool-call repair
```

The DeepSeek process remains isolated behind a provider adapter because its transport requires specialized TLS behavior, a WASM proof-of-work solver, and lifecycle management. The user-facing control plane is not isolated: Conduit now proxies DeepSeek setup, account creation, removal, health, and status into its own dashboard.

## Start

```bash
cp .env.example .env
docker compose up --build -d
```

Open:

- Dashboard: `http://localhost:8000/admin`
- OpenAI base URL: `http://localhost:8000/v1`

The included DeepSeek configuration starts empty. On the dashboard:

1. Enter a new DeepSeek service admin password (minimum six characters). The first connection initializes the managed service; later connections use the same password.
2. Add a DeepSeek account using either email/password or mobile/area-code/password.
3. The managed provider logs in and refreshes its web session internally.

Both provider stores persist under `./data`. DeepSeek’s mutable configuration persists in `./config/deepseek.toml`.

## Qwen account onboarding

Qwen authentication is Alibaba browser SSO rather than DeepSeek’s stable account-password API. It may require CAPTCHA, OTP, federated login, passkey approval, or device-risk verification. Conduit therefore does **not** collect or replay an Alibaba password.

Instead:

1. Use **Open Qwen login** on the Conduit dashboard.
2. Complete login directly with Qwen/Alibaba in the browser.
3. Import the resulting browser session into Conduit. Supported forms are a complete Cookie header, `tongyi_sso_ticket`, `login_aliyunid_ticket`, or a supported Qwen web bearer session.
4. Give it an account label. Conduit persists, masks, rotates, cools down, and removes it as an account entry.

This is account-based onboarding with browser-mediated authentication. It avoids storing the Alibaba password and remains compatible with interactive login challenges. A future browser-extension/device handoff can automate session transfer without changing the provider account contract.

## Routing

Send all requests to `/v1/chat/completions`.

| Selection | Provider |
|---|---|
| `model: "qwen..."` | Qwen |
| `model: "deepseek-..."` | DeepSeek |
| `provider: "deepseek"` | DeepSeek (explicit override) |

Responses include `x-conduit-provider: qwen` or `x-conduit-provider: deepseek`.

## Models

```bash
curl http://localhost:8000/v1/models
```

Default DeepSeek IDs:

- `deepseek-default`
- `deepseek-expert`
- `deepseek-vision`

Qwen exposes its model aliases and thinking/fast variants from the native adapter.

## Chat example

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-default",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": false
  }'
```

Change the model to `qwen3.7-plus` to use Qwen.

## Tool calling

The public contract is OpenAI-compatible for both providers:

- client sends `tools`, `tool_choice`, and optionally `parallel_tool_calls`;
- Conduit returns `assistant.tool_calls` and `finish_reason: "tool_calls"`;
- client executes its functions and returns matching `role: "tool"` messages;
- provider generates the next response.

Qwen preserves full nested JSON Schemas, validates generated arguments with AJV, rejects unknown tools, validates tool-call/result continuation, supports repeated canonical `<tool_call>` blocks, and performs one bounded protocol repair. DeepSeek retains its model-specific parser and repair pipeline while exposing the same external OpenAI contract.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8000` | Conduit HTTP port |
| `ADMIN_PASSWORD` | empty | Optional Basic Auth for Conduit dashboard routes |
| `QWEN_TOKENS` | empty | Optional comma-separated bootstrap Qwen sessions |
| `QWEN_ACCOUNT_COOLDOWN_MS` | `30000` | Initial account cooldown after an upstream failure |
| `CONDUIT_DATA_DIR` | `./data` | Persistent native-provider state |
| `DEEPSEEK_BASE_URL` | `http://deepseek:22217` | Managed provider address |
| `DEEPSEEK_UPSTREAM_API_KEY` | empty | Optional DeepSeek service API key |
| `DEEPSEEK_TIMEOUT_MS` | `180000` | DeepSeek proxy timeout |
| `DEEPSEEK_MODELS` | defaults | Comma-separated public model IDs |

## Provider extension contract

New providers should be added under `src/providers/` and implement these boundaries:

1. request selection/routing;
2. model discovery;
3. chat proxy or native completion adapter;
4. health/status;
5. account management operations;
6. normalized public errors and `x-conduit-provider` observability.

Provider-specific authentication and tool grammar stay behind the adapter. The dashboard and OpenAI API remain provider-neutral.

## Security and licensing

- Conduit masks account secrets in all dashboard responses.
- DeepSeek admin JWTs are kept in browser session storage and are not persisted by the dashboard.
- Account passwords are submitted only to the local managed DeepSeek service and persisted by that service with owner-only file permissions.
- Qwen/Alibaba passwords are never collected.
- `ds-free-api` is GPLv3. Its source and license are included. Review `THIRD_PARTY_NOTICES.md` before distribution.
