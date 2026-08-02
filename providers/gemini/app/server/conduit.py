import asyncio
import os
import re
import tempfile
from pathlib import Path

import yaml
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

from app.services import GeminiClientPool
from app.utils import g_config
from app.utils.config import CONFIG_PATH, GeminiClientSettings

router = APIRouter(prefix="/conduit")
_config_lock = asyncio.Lock()


class AccountInput(BaseModel):
    id: str | None = Field(default=None)
    secure_1psid: str
    secure_1psidts: str = ""
    proxy: str | None = None


def _authorize(x_conduit_management_key: str | None) -> None:
    expected = os.getenv("CONDUIT_MANAGEMENT_KEY", "").strip()
    if expected and x_conduit_management_key != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid management key.")


def _safe_id(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        raw = f"gemini-{len(g_config.gemini.clients) + 1}"
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-")
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid account label.")
    return normalized[:80]


def _account_view(account: GeminiClientSettings, states: dict[str, bool]):
    return {"id": account.id, "proxy": account.proxy, "healthy": states.get(account.id, False)}


def _persist_config() -> None:
    config_path = Path(os.getenv("CONFIG_PATH", CONFIG_PATH))
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = g_config.model_dump(mode="json")
    fd, temporary = tempfile.mkstemp(prefix=f".{config_path.name}.", dir=config_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            yaml.safe_dump(payload, stream, sort_keys=False, allow_unicode=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@router.get("/accounts")
async def list_accounts(x_conduit_management_key: str | None = Header(default=None)):
    _authorize(x_conduit_management_key)
    states = GeminiClientPool().status()
    return {"accounts": [_account_view(account, states) for account in g_config.gemini.clients]}


@router.post("/accounts")
async def add_account(payload: AccountInput, x_conduit_management_key: str | None = Header(default=None)):
    _authorize(x_conduit_management_key)
    secure_1psid = payload.secure_1psid.strip()
    if not secure_1psid:
        raise HTTPException(status_code=400, detail="__Secure-1PSID is required.")

    async with _config_lock:
        account_id = _safe_id(payload.id)
        if any(account.id == account_id for account in g_config.gemini.clients):
            raise HTTPException(status_code=409, detail="A Gemini account with this label already exists.")
        if any(account.secure_1psid == secure_1psid for account in g_config.gemini.clients):
            raise HTTPException(status_code=409, detail="This Gemini browser session is already configured.")

        previous = list(g_config.gemini.clients)
        candidate = GeminiClientSettings(
            id=account_id,
            secure_1psid=secure_1psid,
            secure_1psidts=payload.secure_1psidts.strip(),
            proxy=payload.proxy,
        )
        g_config.gemini.clients = [*previous, candidate]
        pool = GeminiClientPool()
        pool.reconfigure(g_config.gemini.clients)
        try:
            await pool.acquire(account_id)
            _persist_config()
        except Exception as exc:
            g_config.gemini.clients = previous
            pool.reconfigure(previous)
            raise HTTPException(status_code=400, detail=f"Gemini session validation failed: {exc}") from exc

        return {"account": _account_view(candidate, pool.status())}


@router.delete("/accounts/{account_id}")
async def remove_account(account_id: str, x_conduit_management_key: str | None = Header(default=None)):
    _authorize(x_conduit_management_key)
    async with _config_lock:
        remaining = [account for account in g_config.gemini.clients if account.id != account_id]
        if len(remaining) == len(g_config.gemini.clients):
            raise HTTPException(status_code=404, detail="Gemini account not found.")
        g_config.gemini.clients = remaining
        GeminiClientPool().reconfigure(remaining)
        _persist_config()
        return {"success": True}
