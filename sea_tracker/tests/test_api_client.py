import hashlib
import hmac
from unittest.mock import MagicMock, patch

import pytest

from sea_tracker import api_client


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("GCIG_API_URL", "https://api.example.com")
    monkeypatch.setenv("SEA_INGEST_SECRET", "test-secret")


def _expected_sig(ts: str, path: str, body: bytes) -> str:
    msg = f"{ts}.{path}.".encode("ascii") + body
    return hmac.new(b"test-secret", msg, hashlib.sha256).hexdigest()


def test_post_signals_signs_correctly():
    rows = [{"date": "2026-05-03", "name": "x", "value": 1.0}]
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": True, "written": 1}
        req.post.return_value = resp
        out = api_client.post_signals(rows)

    assert out == {"ok": True, "written": 1}
    args, kwargs = req.post.call_args
    assert args[0] == "https://api.example.com/api/sea/signals"
    headers = kwargs["headers"]
    assert headers["Content-Type"] == "application/json"
    ts = headers["X-Sea-Timestamp"]
    sig = headers["X-Sea-Signature"]
    body = kwargs["data"]
    assert sig == _expected_sig(ts, "/api/sea/signals", body)


def test_post_snapshot_signs_correctly():
    payload = {"snapshotAt": "2026-05-04T20:00:00Z", "vesselCount": 0, "payload": {}}
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": True}
        req.post.return_value = resp
        api_client.post_snapshot(payload)

    args, kwargs = req.post.call_args
    assert args[0] == "https://api.example.com/api/sea/snapshot"
    body = kwargs["data"]
    headers = kwargs["headers"]
    assert headers["X-Sea-Signature"] == _expected_sig(
        headers["X-Sea-Timestamp"], "/api/sea/snapshot", body
    )


def test_missing_env_raises(monkeypatch):
    monkeypatch.delenv("GCIG_API_URL", raising=False)
    with pytest.raises(RuntimeError, match="GCIG_API_URL"):
        api_client.post_signals([])


def test_4xx_raises():
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=401, text="nope")
        req.post.return_value = resp
        with pytest.raises(RuntimeError, match="signals POST failed"):
            api_client.post_signals([{"date": "2026-05-03", "name": "x", "value": 1}])


def test_get_aisstream_key_returns_value():
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"aisstreamApiKey": "abc-123"}
        req.get.return_value = resp
        out = api_client.get_aisstream_key()
    assert out == "abc-123"
    args, kwargs = req.get.call_args
    assert args[0] == "https://api.example.com/api/sea/secrets"
    headers = kwargs["headers"]
    assert headers["X-Sea-Signature"] == _expected_sig(
        headers["X-Sea-Timestamp"], "/api/sea/secrets", b""
    )


def test_get_aisstream_key_503_raises():
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=503, text="not configured")
        req.get.return_value = resp
        with pytest.raises(RuntimeError, match="secrets GET failed"):
            api_client.get_aisstream_key()


def test_get_aisstream_key_empty_payload_raises():
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"aisstreamApiKey": ""}
        req.get.return_value = resp
        with pytest.raises(RuntimeError, match="no aisstreamApiKey"):
            api_client.get_aisstream_key()
