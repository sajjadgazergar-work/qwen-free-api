# Third-party notices

## ds-free-api

Conduit includes the source of **ds-free-api** by NIyueeE under `providers/deepseek` so the DeepSeek provider can retain its specialized proof-of-work, TLS-emulation, account-pool, and session implementation.

This component is licensed under GNU GPL version 3. Its original `LICENSE`, README files, source notices, and copyright statements are retained.

Upstream: https://github.com/NIyueeE/ds-free-api

## Gemini-FastAPI

Conduit includes a pinned source snapshot of **Gemini-FastAPI** by Yongkun Li under `providers/gemini`. It provides the managed OpenAI-compatible Gemini service, account pooling, multimodal conversion, conversation persistence, model discovery, and tool-call translation.

Gemini-FastAPI is licensed under the MIT License. Its original `LICENSE`, README, and source notices are retained.

Upstream: https://github.com/Nativu5/Gemini-FastAPI
Pinned upstream commit: `febafc8f3605932cd8a474065b267c7948e7bc70`

## gemini-webapi

Gemini-FastAPI depends on **gemini-webapi** by HanaokaYuzu for the reverse-engineered Gemini Web transport, browser-session authentication, streaming, model selection, and cookie refresh.

The upstream project is licensed under GNU AGPL version 3. Review AGPL obligations before network deployment or distribution, particularly if modifying or redistributing the provider service.

Upstream: https://github.com/HanaokaYuzu/Gemini-API

## Compliance note

Licenses can impose obligations beyond retaining notices. This file is not legal advice. Review the full license texts and your distribution/deployment model before using Conduit in a proprietary product.
