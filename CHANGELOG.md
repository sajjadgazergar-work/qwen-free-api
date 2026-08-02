# Changelog

## 0.2.2

### Fixed

- Changed host-side provider defaults to explicit loopback URLs, eliminating `getaddrinfo ENOTFOUND deepseek` and `getaddrinfo ENOTFOUND gemini` during local gateway development.
- Kept Docker Compose provider URLs explicit through service DNS names inside the private Compose network.
- Added actionable DNS, connection-refused, timeout, and invalid-URL diagnostics to provider status and proxy errors.
- Replaced the dashboard's generic "run the full stack" message with the actual provider error.
- Mounted the provider configuration directory as writable so dashboard-added DeepSeek accounts and Gemini sessions can persist.

### Added

- `GET /health/live` for gateway process liveness.
- `GET /health/ready` for independent Qwen, DeepSeek, and Gemini readiness.
- Docker health checks for the gateway and both managed providers.
- Graceful SIGTERM/SIGINT HTTP connection draining.
- `docker-compose.dev.yml` for running managed providers in Docker while developing Conduit on the host.
- `.env.local.example` with non-conflicting host URLs.
- A complete `INSTALLATION.md` covering setup, onboarding, verification, development, upgrades, troubleshooting, and security.

### Changed

- Docker Compose remains the canonical deployment, but provider failure no longer blocks gateway startup.
- The default published gateway address is loopback-only. Set `CONDUIT_BIND_ADDRESS` explicitly when remote access is required.
