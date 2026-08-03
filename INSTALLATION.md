# Conduit Installation Guide

This guide covers the recommended full Docker Compose installation, a host-side development setup, upgrades, verification, and the most common provider errors.

## 1. Requirements

### Recommended

- Linux, macOS, or Windows with WSL2
- Docker Engine 24+ and Docker Compose v2
- Git
- At least 4 GB of free memory
- At least 5 GB of free disk space for images, provider source, and persistent data

Check the required commands:

```bash
git --version
docker --version
docker compose version
```

On Linux, make sure the Docker daemon is running:

```bash
sudo systemctl enable --now docker
```

## 2. Recommended installation: complete Docker stack

Clone the repository and enter it:

```bash
git clone https://github.com/sajjadgazergar-work/qwen-free-api.git conduit
cd conduit
```

Create the local environment file:

```bash
cp .env.example .env
```

Open `.env` and change at least the dashboard password:

```env
ADMIN_PASSWORD=use-a-long-random-password
```

By default, Conduit binds to `127.0.0.1` so it is not exposed to the local network. Leave this unchanged unless a reverse proxy or another machine must reach it.

Build and start the complete stack:

```bash
docker compose up --build -d
```

Watch startup:

```bash
docker compose ps
docker compose logs -f --tail=100
```

Open:

- Dashboard: `http://localhost:8000/admin`
- OpenAI-compatible base URL: `http://localhost:8000/v1`
- Process health: `http://localhost:8000/health/live`
- Provider readiness: `http://localhost:8000/health/ready`

The gateway starts even if DeepSeek or Gemini is still initializing. A failed optional provider does not block Qwen or other healthy providers.

## 3. Add provider accounts

### Qwen

1. Sign in at `https://chat.qwen.ai` in your browser.
2. Copy a supported Qwen browser session, complete Cookie header, ticket, or web bearer session.
3. Open the Conduit dashboard and add it under Qwen.

Conduit does not ask for or store the Alibaba password.

### DeepSeek

1. Open the Conduit dashboard.
2. Enter either the email address or mobile number used at `https://chat.deepseek.com`.
3. Enter that account's DeepSeek website password.

The password requested here is the website account password, not a Conduit or Docker password. Conduit creates its own internal provider-management secret automatically.

Accounts created exclusively through Google or another federated login may not have a DeepSeek password. Set one through DeepSeek's account flow before adding the account.

### Gemini

1. Open `https://gemini.google.com` in a private/incognito browser window and sign in.
2. Open Developer Tools and select the Network tab.
3. Send a Gemini message and select its network request.
4. Copy the complete `Cookie` request header.
5. Paste the header into the Gemini section of Conduit's dashboard.

Conduit extracts `__Secure-1PSID` and `__Secure-1PSIDTS`. These cookies grant account access; protect the data directory and do not expose the dashboard publicly.

## 4. Verify the installation

Check process health:

```bash
curl -fsS http://localhost:8000/health/live
```

Check provider readiness:

```bash
curl -sS http://localhost:8000/health/ready
```

A `503` readiness response means no provider is currently ready. Its JSON body includes individual provider states and actionable errors.

List available models:

```bash
curl -sS http://localhost:8000/v1/models
```

Test a model returned by that endpoint:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-default",
    "messages": [{"role":"user","content":"Reply with: Conduit is working"}],
    "stream": false
  }'
```

Replace the model with a Qwen or Gemini model ID to test another provider.

## 5. Host-side gateway development

Use this mode when editing the TypeScript gateway. DeepSeek and Gemini remain in Docker, but Conduit runs directly with Node.js.

Install Node.js 20+ and npm, then create the development environment:

```bash
cp .env.local.example .env
npm run setup
```

Start only the managed providers with loopback ports:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d deepseek gemini
```

Start Conduit on the host:

```bash
npm run dev
```

The development URLs are explicit:

```env
DEEPSEEK_BASE_URL=http://127.0.0.1:22217
GEMINI_BASE_URL=http://127.0.0.1:18000
```

Gemini uses host port `18000` because Conduit already uses port `8000`. Do not use Docker service names such as `deepseek` or `gemini` from a host-side Node process; those names only resolve inside the Compose network.

## 6. External provider services

Conduit may connect to provider services running elsewhere. Set explicit URLs:

```env
DEEPSEEK_BASE_URL=https://deepseek.internal.example
GEMINI_BASE_URL=https://gemini.internal.example
```

If the external services require their own API or management credentials, set the corresponding variables documented in `.env.example`. Use TLS and a private network for remote provider services.

## 7. Upgrade

Back up persistent state first:

```bash
tar -czf conduit-backup-$(date +%Y%m%d-%H%M%S).tar.gz data config .env
```

Pull and rebuild:

```bash
git pull --ff-only
docker compose pull
docker compose up --build -d --remove-orphans
```

Verify after the upgrade:

```bash
docker compose ps
curl -fsS http://localhost:8000/health/live
curl -sS http://localhost:8000/health/ready
```

Do not run `docker compose down -v` during a normal upgrade. The `-v` option deletes named volumes and can remove persistent state.

## 8. Stop, restart, and uninstall

Restart:

```bash
docker compose restart
```

Stop without deleting persistent data:

```bash
docker compose down
```

Uninstall containers and images while keeping `data`, `config`, and `.env`:

```bash
docker compose down --rmi local --remove-orphans
```

Delete account state only after making a backup and confirming it is no longer needed.

## 9. Troubleshooting

### `getaddrinfo ENOTFOUND deepseek`

Cause: Conduit is running on the host but is configured with the Docker-only hostname `deepseek`.

Fix:

```env
DEEPSEEK_BASE_URL=http://127.0.0.1:22217
```

Then start the provider with the development override:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d deepseek
```

### `getaddrinfo ENOTFOUND gemini`

Cause: the host-side gateway is using the Docker-only hostname `gemini`.

Fix:

```env
GEMINI_BASE_URL=http://127.0.0.1:18000
```

Then start Gemini with the development override.

### `ECONNREFUSED`

The hostname resolved, but nothing is listening at that address. Check service state and logs:

```bash
docker compose ps
docker compose logs --tail=200 deepseek
docker compose logs --tail=200 gemini
```

### Provider is unhealthy but Conduit is running

This is expected graceful degradation. Check the readiness response and the provider's logs. Conduit liveness should remain healthy so other providers continue working.

### DeepSeek asks for an unknown password

Use the password for the account at `chat.deepseek.com`. Do not use `ADMIN_PASSWORD`, a Docker password, or the generated internal management secret.

### Gemini account cannot be validated

The Google session may have expired or may require CAPTCHA, device approval, or reauthentication. Complete that process manually in the browser and import a fresh Cookie header. Conduit does not automate interactive verification.

### Reset provider configuration

First stop the stack and create a backup. Provider configuration is stored in `config`, while runtime data is stored in `data`. Reset only the affected provider file or directory; do not delete all state as a first troubleshooting step.

### Inspect effective Compose configuration

```bash
docker compose config
```

This catches malformed environment substitution, unexpected ports, and invalid volume paths before startup.

## 10. Security notes

- Keep the default loopback bind unless remote access is required.
- Set a strong `ADMIN_PASSWORD`.
- Put remote access behind HTTPS and an authenticated reverse proxy.
- Restrict filesystem permissions on `.env`, `data`, and `config`.
- Never commit browser cookies, passwords, generated secrets, or `.env`.
- Review provider terms and applicable licenses before deployment or redistribution.
