"""Read-only Coinbase Advanced Trade client (CDP JWT / ES256 or EdDSA).

Credentials come from environment variables only:
    COINBASE_API_KEY_NAME     organizations/<org>/apiKeys/<key-id>
    COINBASE_API_PRIVATE_KEY  ECDSA PEM or raw base64 Ed25519 private key

Only GET is exposed, so nothing importing this module can place, modify or
cancel an order. A View-only API key is sufficient.
"""
import base64
import binascii
import os
import secrets
import time

import jwt
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

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
    secret = pem.replace("\\n", "\n").strip()
    if secret.startswith("-----BEGIN"):
        _private_key = serialization.load_pem_private_key(
            secret.encode(), password=None
        )
        return

    try:
        raw = base64.b64decode("".join(secret.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SystemExit(
            "COINBASE_API_PRIVATE_KEY is neither PEM nor valid base64."
        ) from exc
    if len(raw) not in (32, 64):
        raise SystemExit(
            "Raw Ed25519 Coinbase keys must decode to 32 or 64 bytes."
        )
    _private_key = ed25519.Ed25519PrivateKey.from_private_bytes(raw[:32])


def _token(method: str, path: str) -> str:
    _load()
    now = int(time.time())
    if isinstance(_private_key, ed25519.Ed25519PrivateKey):
        algorithm = "EdDSA"
    elif isinstance(_private_key, ec.EllipticCurvePrivateKey):
        algorithm = "ES256"
    else:
        raise SystemExit("Unsupported Coinbase private-key type.")
    return jwt.encode(
        {
            "sub": _key_name,
            "iss": "cdp",
            "nbf": now,
            "exp": now + 120,
            "uri": f"{method} {HOST}{path}",
        },
        _private_key,
        algorithm=algorithm,
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
