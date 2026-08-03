# Changelog

## 0.3.1

### Fixed

- Added network-aware endpoint discovery for DeepSeek and Gemini. Conduit now tries an explicit configured URL first, then the host-development and Compose endpoints when the failure is DNS, connection, or timeout related.
- Removed the invalid DeepSeek container healthcheck that depended on `wget`, which is not present in the upstream minimal image.
- Changed Compose startup dependencies to service-started semantics so provider initialization does not incorrectly block the gateway.
- Forced clean builder installs to include TypeScript development dependencies even when the caller exports `NODE_ENV=production`.
- Updated the production dependency install to use the supported `--omit=dev` form.

### Verified

- Compared the bundled DeepSeek adapter against current `NIyueeE/ds-free-api` and the Gemini adapter against current `Nativu5/Gemini-FastAPI` and `Sophomoresty/gemini-web2api` behavior.
- Added regression tests for explicit URL priority and host/Compose fallback ordering.

## 0.3.0

### Added

- Replaced the legacy admin page with the complete obsidian-and-copper Conduit Control Plane.
- Added responsive Overview, Providers, Accounts, Routing, Requests, Playground, and Settings workspaces.
- Connected provider checks, account onboarding and removal, request telemetry, log export and clearing, incident export, and playground requests to the existing Conduit APIs.
- Added live provider readiness, runtime metrics, account filtering, health timelines, protocol compatibility, and fallback route simulation.

### Fixed

- Kept full-width simulator controls inside their cards on narrow and wide screens.
- Updated TypeScript module resolution for TypeScript 5.9 compatibility.
- Improved mobile navigation, touch targets, data-card layouts, safe-area spacing, and narrow-screen dialogs.

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
