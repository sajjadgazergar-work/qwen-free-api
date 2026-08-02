# Logging Specification

## Principles

1. **Zero output from library code**: Library crates (`ds_core/`) use only the `log` crate — never print directly to stdout/stderr
2. **Caller controls output**: Log level, format, and destination are determined by the application layer (`main.rs` / examples)
3. **Structured targets**: Every log call must specify a `target:` for module-level filtering

## Log Levels

| Level | Usage | Examples |
|-------|-------|----------|
| `ERROR` | Fatal errors requiring human intervention | All accounts failed init, PoW crash, config corruption |
| `WARN` | Degraded but recoverable anomalies | Single account init failure, session cleanup failure, rate limiting, pool exhaustion, SSE stream interruption, tool parse fallback |
| `INFO` | Key lifecycle events | Account init success, server start/shutdown, dynamic add/remove |
| `DEBUG` | Debug information | HTTP request/response summaries, account assignment, SSE event types, tool call parsing |
| `TRACE` | Finest granularity data | Raw SSE event content, conversion deltas, state machine frames |

## Target Specification

Format: `crate::module` or `crate::module::submodule`

| Module | Target | Description |
|--------|--------|-------------|
| `ds_core::accounts::pool` | `ds_core::accounts` | Account pool lifecycle, assignment, health checks, rate limiting |
| `ds_core::accounts::pow` | `ds_core::accounts` | PoW computation (shares target with accounts) |
| `ds_core::chat::response` | `ds_core::accounts` | Stream lifecycle, stop_stream, delete_session (shares target with accounts) |
| `ds_core::client` | `ds_core::client` | HTTP requests/responses, API calls |
| `openai_adapter` | `adapter` | OpenAI protocol adapter (request parsing, response conversion, tool parsing, obfuscation) |
| `anthropic_compat` | `anthropic_compat` | Anthropic compat layer entry |
| `anthropic_compat::request` | `anthropic_compat::request` | Anthropic → OpenAI request mapping |
| `anthropic_compat::models` | `anthropic_compat::models` | Anthropic model list |
| `anthropic_compat::response::stream` | `anthropic_compat::response::stream` | Anthropic streaming response conversion |
| `anthropic_compat::response::aggregate` | `anthropic_compat::response::aggregate` | Anthropic non-streaming response aggregation |
| `server` | `http::server` | Server lifecycle (startup, shutdown signals) |
| `server::handlers` | `http::request` / `http::response` | HTTP request summary (path, stream flag), response summary (status, bytes) |
| `server::error` | `http::response` | HTTP error response (status, error message) |
| `server::stream` | `http::response` | SSE stream errors |

## Code Examples by Module

### Library Core (ds_core/)

```rust
use log::{info, debug, warn, error};

// INFO: Key lifecycle events
info!(target: "ds_core::accounts", "Account {} initialized successfully", display_id);
info!(target: "ds_core::accounts", "Account {} added dynamically", display_id);
info!(target: "ds_core::accounts", "Account {} removed", id);
info!(target: "ds_core::accounts", "Account {} re-login successful", display_id);

// WARN: Individual failure, degradable
warn!(target: "ds_core::accounts", "Account {} initialization failed: {}", display_id, e);
warn!(target: "ds_core::accounts", "Account {} re-login failed (attempt {}): {}", display_id, count, e);
warn!(target: "ds_core::accounts", "Account {} marked as Error", account.display_id());
warn!(target: "ds_core::accounts", "{}/{} accounts unavailable", failed, total);
warn!(target: "ds_core::accounts", "All accounts failed to initialize — they may be disabled or have invalid credentials");

// WARN: Rate limiting / pool exhaustion
warn!(target: "ds_core::accounts", "req={} account pool exhausted: model_type={}", request_id, model_type);
warn!(target: "ds_core::accounts", "req={} rate limit hint: rate_limit_reached", request_id);

// ERROR: All accounts failed
error!(target: "ds_core::accounts", "Account {} re-login failed {} times, marked as Invalid: {}", display_id, count, e);
error!(target: "ds_core::accounts", "All accounts failed to initialize");
```

### Raw HTTP Client (ds_core/client)

```rust
use log::{debug, warn};

// DEBUG: HTTP request summary
debug!(target: "ds_core::client", "POST {} - {} bytes body", path, body_len);

// DEBUG: HTTP response summary
debug!(target: "ds_core::client", "{} {} - status={} ({} ms)", method, path, status, elapsed);

// WARN: WAF challenge detected
warn!(target: "ds_core::client", "WAF challenge detected on {}", path);

// WARN: Unexpected HTTP status
warn!(target: "ds_core::client", "unexpected status {} for {}: {}", status, path, body_preview);
```

### Response Layer (ds_core/chat/)

```rust
use log::{debug, trace, warn};

// DEBUG: Stream events (request-level)
debug!(target: "ds_core::accounts", "req={} account assigned: model_type={}", request_id, model_type);
debug!(target: "ds_core::accounts", "req={} session created: id={}", request_id, session_id);
debug!(target: "ds_core::accounts", "req={} PoW computation completed", request_id);
debug!(target: "ds_core::accounts", "req={} SSE ready: resp_msg={}", request_id, stop_id);

// TRACE: Raw SSE bytes
trace!(target: "ds_core::accounts", "req={} <<< ({} bytes) {}", request_id, len, content);

// WARN: Cleanup failures
warn!(target: "ds_core::accounts", "stop_stream failed: {}", e);
warn!(target: "ds_core::accounts", "delete_session failed: {}", e);
```

### OpenAI Adapter (openai_adapter/)

```rust
use log::{debug, info, trace, warn};

// DEBUG: Adapter entry
debug!(target: "adapter", "req={} adapter processing: model={}, stream={}", request_id, model, stream);

// DEBUG: Response pipeline init
debug!(target: "adapter", "building stream response: model={}, include_usage={}, include_obfuscation={}, stop_count={}, repair={}", model, usage, obfuscation, stop, repair);

// DEBUG: Aggregate completion
debug!(target: "adapter", "aggregate response done: finish_reason={:?}, has_tool_calls={}", reason, has_tc);

// INFO: Retry succeeded
info!(target: "adapter", "req={} retry {} succeeded", request_id, attempt);

// WARN: SSE stream error
warn!(target: "adapter", "SSE stream error: {}", e);

// WARN: Tool parse → repair
warn!(target: "adapter", "tool parser failed → requesting repair");

// WARN: Converter stream ended early
warn!(target: "adapter", "converter stream ended early: model={}, usage_value={:?}", model, usage);

// WARN: Tool call repair failed
warn!(target: "adapter", "tool call repair failed: {}", e);

// TRACE: Raw SSE event (converter input)
trace!(target: "adapter", "<<< {} {}", event, data);

// TRACE: State machine frame output
trace!(target: "adapter", ">>> state: {frame}");

// TRACE: Converter delta
trace!(target: "adapter", ">>> conv: content delta len={}", len);

// TRACE: Serialized chunk
trace!(target: "adapter", ">>> {}", chunk_json);
```

### Anthropic Compat (anthropic_compat/)

```rust
use log::{debug, trace};

// DEBUG: Request mapping
debug!(target: "anthropic_compat::request", "req={} mapped {} messages, {} tools", request_id, msg_count, tool_count);

// DEBUG: Stream conversion
debug!(target: "anthropic_compat::response::stream", "req={} event: type={}, has_content={}", request_id, event_type, has_content);

// DEBUG: Aggregate conversion
debug!(target: "anthropic_compat::response::aggregate", "req={} aggregated: output_tokens={}, stop_reason={:?}", request_id, output_tokens, stop_reason);

// TRACE: Raw Anthropic event
trace!(target: "anthropic_compat::response::stream", "req={} >>> {}", request_id, event_json);
```

### HTTP Server (server/)

```rust
use log::{debug, info, error};

// INFO: Server lifecycle
info!(target: "http::server", "Server starting on {}:{}", host, port);
info!(target: "http::server", "Shutdown signal received, draining connections");

// DEBUG: Request summary (handler entry)
debug!(target: "http::request", "req={} POST /v1/chat/completions stream={}", req_id, stream);

// DEBUG: Response summary (handler exit)
debug!(target: "http::response", "req={} 200 JSON response {} bytes", req_id, len);

// ERROR: SSE stream error (response send phase)
error!(target: "http::response", "SSE stream error: {}", e);
```

## Runtime Control

```bash
# Default level (info)
just serve

# Debug mode
RUST_LOG=debug just serve

# Module-level filtering — accounts only
RUST_LOG=ds_core::accounts=debug just serve

# Multi-level — accounts debug, client warn, rest info
RUST_LOG=ds_core::accounts=debug,ds_core::client=warn,info just serve

# Silent (errors only)
RUST_LOG=error just serve

# Trace the full SSE pipeline
RUST_LOG=adapter=trace,ds_core::accounts=debug,info just serve

# Focus on rate limiting and request tracing
RUST_LOG=ds_core::accounts=debug,adapter=warn just serve

# Output to file
RUST_LOG=debug just serve 2> server.log
```

## Prohibited Practices

- ❌ `println!` / `eprintln!` in library code (`ds_core/`, adapters)
- ❌ Untargeted log macros (bare `log::info!` without `target:`)
- ❌ Logging sensitive information (tokens, passwords, API keys)
- ❌ High-frequency TRACE logs enabled by default (each SSE byte, tight loops)
- ❌ Chinese text in log messages — all logs must be in English
