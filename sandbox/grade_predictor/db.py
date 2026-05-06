"""SQLite store for the per-teacher training corpus.

Schema is intentionally simple — one row per training example. The
teacher 'profile' is just "all rows where teacher = X". We don't
pre-aggregate teacher style; the prompt builder pulls the N most
similar prior essays at query time and lets the LLM infer style
from concrete examples (RAG, not fine-tuning).

Embeddings are stored as JSON-serialised float arrays. NumPy lookup
is fast enough for the volumes we expect (hundreds of essays per
teacher, well under a second per cosine-similarity scan).
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np


@dataclass(frozen=True)
class TrainingExample:
    id: int
    teacher: str
    essay: str
    feedback: str
    grade: str
    rubric: str | None
    created_at: float
    embedding: np.ndarray


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("""
        CREATE TABLE IF NOT EXISTS training_examples (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher     TEXT NOT NULL,
            essay       TEXT NOT NULL,
            feedback    TEXT NOT NULL,
            grade       TEXT NOT NULL,
            rubric      TEXT,
            created_at  REAL NOT NULL,
            embedding   TEXT NOT NULL
        )
    """)
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_training_teacher "
        "ON training_examples(teacher)"
    )
    return con


def insert_example(
    con: sqlite3.Connection,
    *,
    teacher: str,
    essay: str,
    feedback: str,
    grade: str,
    rubric: str | None,
    embedding: np.ndarray,
) -> int:
    cur = con.execute(
        """
        INSERT INTO training_examples
            (teacher, essay, feedback, grade, rubric, created_at, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            teacher.strip(),
            essay,
            feedback,
            grade,
            rubric,
            time.time(),
            json.dumps(embedding.tolist()),
        ),
    )
    con.commit()
    return cur.lastrowid


def list_teachers(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        """
        SELECT teacher, COUNT(*) AS n, MAX(created_at) AS last
        FROM training_examples
        GROUP BY teacher
        ORDER BY n DESC
        """
    ).fetchall()
    return [
        {"name": r["teacher"], "examples": r["n"], "last_updated": r["last"]}
        for r in rows
    ]


def fetch_examples_for_teacher(
    con: sqlite3.Connection, teacher: str
) -> list[TrainingExample]:
    rows = con.execute(
        """
        SELECT id, teacher, essay, feedback, grade, rubric, created_at, embedding
        FROM training_examples
        WHERE teacher = ?
        ORDER BY created_at DESC
        """,
        (teacher.strip(),),
    ).fetchall()
    out: list[TrainingExample] = []
    for r in rows:
        out.append(TrainingExample(
            id=r["id"],
            teacher=r["teacher"],
            essay=r["essay"],
            feedback=r["feedback"],
            grade=r["grade"],
            rubric=r["rubric"],
            created_at=r["created_at"],
            embedding=np.array(json.loads(r["embedding"]), dtype=np.float32),
        ))
    return out


def top_k_similar(
    examples: Iterable[TrainingExample],
    *,
    query: np.ndarray,
    k: int,
) -> list[TrainingExample]:
    """Cosine similarity over every example for the teacher; return
    the top K. Linear scan is fine — typical teacher profile is
    <500 essays."""
    arr = list(examples)
    if not arr:
        return []
    qn = query / (np.linalg.norm(query) + 1e-12)
    scored = []
    for ex in arr:
        en = ex.embedding / (np.linalg.norm(ex.embedding) + 1e-12)
        sim = float(np.dot(qn, en))
        scored.append((sim, ex))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [ex for _sim, ex in scored[:k]]
