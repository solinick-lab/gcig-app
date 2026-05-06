"""Thin Ollama client wrapper.

The grade predictor uses two models:

  GENERATION_MODEL   qwen3.6:27b   ~17 GB. Long-context, strong
                                   instruction-following. Used for the
                                   actual grading + line-by-line
                                   comments. Slow on 16 GB VRAM
                                   (~1-5 min/essay) — acceptable per
                                   spec.

  EMBEDDING_MODEL    nomic-embed-text   ~270 MB. Fast similarity
                                   search for retrieving the most
                                   relevant prior essays from the
                                   same teacher.

Both pinned in memory via OLLAMA_KEEP_ALIVE=24h on the server side
so each call doesn't pay a load-from-disk cost.
"""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np
import ollama


GENERATION_MODEL = os.environ.get("GP_GENERATION_MODEL", "qwen3.6:27b")
EMBEDDING_MODEL = os.environ.get("GP_EMBEDDING_MODEL", "nomic-embed-text")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")


_client: ollama.Client | None = None


def _client_for(host: str) -> ollama.Client:
    global _client
    if _client is None:
        _client = ollama.Client(host=host)
    return _client


def embed(text: str) -> np.ndarray:
    """Vector embedding for retrieval. Truncated input (Ollama's
    embedding models cap around 512-2048 tokens depending on
    family); the start of the essay is the most stylistically
    informative slice anyway."""
    cli = _client_for(OLLAMA_HOST)
    truncated = text[:8000]  # ~2000 tokens, comfortably inside any embedding model
    resp = cli.embeddings(model=EMBEDDING_MODEL, prompt=truncated)
    vec = resp.get("embedding") or []
    if not vec:
        raise RuntimeError(f"empty embedding from {EMBEDDING_MODEL}")
    return np.asarray(vec, dtype=np.float32)


def generate_grade(prompt: str, *, max_tokens: int = 4096) -> str:
    """Run a generate call against the bigger model. Returns raw text."""
    cli = _client_for(OLLAMA_HOST)
    resp = cli.generate(
        model=GENERATION_MODEL,
        prompt=prompt,
        stream=False,
        options={
            "num_predict": max_tokens,
            "temperature": 0.3,         # low — we want consistent grading
            "num_ctx": 16384,           # plenty for essay + 3 retrieved + rubric
            "keep_alive": "24h",        # pin in memory per Option A
        },
    )
    return resp.get("response", "")


def parse_grade_json(raw: str) -> dict[str, Any]:
    """Pull the JSON object out of an LLM response.

    The model is asked to emit `{"line_by_line": [...], "overall_feedback":
    "...", "grade": "..."}` but sometimes wraps it in prose or markdown
    fences. We grab the largest balanced {...} block we can find. If
    nothing parses, return the raw text under a recovery key so the
    UI can still show something."""
    # Strip code fences if present.
    text = raw.strip()
    if text.startswith("```"):
        # Drop opening fence (and optional language tag) and closing fence.
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    # Find the outermost JSON object.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {"_raw": raw, "_parse_error": "no JSON object found"}
    candidate = text[start:end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        return {"_raw": raw, "_parse_error": f"JSON decode: {exc}"}
