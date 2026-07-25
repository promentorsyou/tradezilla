"""Read-only Coinbase Advanced Trade client (CDP JWT / ES256).

Credentials come from environment variables only:
    COINBASE_API_KEY_NAME     organizations/<org>/apiKeys/<key-id>
    COINBASE_API_PRIVATE_KEY  -----BEGIN EC PRIVATE KEY-----\\n...\\n-----END EC PRIVATE KEY-----\\n

Only GET is exposed, so nothing importing this module can place, modify or
cancel an order. A View-only API key is sufficient.
"""
import os
import secrets
import time

import jwt
import requests
from cryptography.hazmat.primitives import serialization

HOST = "api.coinbase.com"

_key_name = None
_private_key = None


def _load():
    global _key_name, _private_key
    if _private_key is not None:
        return
    _key_name = os.environ.get("COINBASE_API_KEY_NAME")
    pem = os.environ.get("COINBASE_API_PRIVATE_KEY")
    if not _key_name or not pem:
        raise SystemExit(
            "Set COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY "
            "(use a View-only key)."
        )
    _private_key = serialization.load_pem_private_key(
        pem.replace("\\n", "\n").encode(), password=None
    )


def _token(method: str, path: str) -> str:
    _load()
    now = int(time.time())
    return jwt.encode(
        {
            "sub": _key_name,
            "iss": "cdp",
            "nbf": now,
            "exp": now + 120,
            "uri": f"{method} {HOST}{path}",
        },
        _private_key,
        algorithm="ES256",
        headers={"kid": _key_name, "nonce": secrets.token_hex(16)},
    )


def get(path: str, params: dict | None = None, timeout: int = 30):
    return requests.get(
        f"https://{HOST}{path}",
        params=params,
        headers={"Authorization": f"Bearer {_token('GET', path)}"},
        timeout=timeout,
    )


def get_json(path: str, params: dict | None = None) -> dict:
    r = get(path, params)
    r.raise_for_status()
    return r.json()
