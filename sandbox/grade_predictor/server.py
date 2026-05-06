"""FastAPI server for the grade predictor.

Two surfaces:

  GET  /health               liveness probe
  GET  /teachers             list teachers + corpus size + last update
  POST /train                save (teacher, essay, feedback, grade, rubric?)
  POST /predict              generate line-by-line comments + grade

CORS is open to localhost (Vite dev) + thegriffinfund.org (Render
client) so the React Sandbox page can call this directly without a
gcig-api proxy. Run on the Windows server, expose via Cloudflare
tunnel as a separate hostname.

Storage path defaults to ./data/grade_predictor.db — runs alongside
the package. Override with GP_DB_PATH if you want it elsewhere
(e.g. C:/sea_tracker/grade_predictor.db).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from grade_predictor import db, llm, prompts

logger = logging.getLogger("grade_predictor")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DB_PATH = Path(os.environ.get(
    "GP_DB_PATH",
    str(Path(__file__).resolve().parent.parent / "data" / "grade_predictor.db"),
))

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://thegriffinfund.org",
    "https://www.thegriffinfund.org",
    "https://gcig-client.onrender.com",
]


app = FastAPI(title="Grade Predictor", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ─── Models ──────────────────────────────────────────────────────────

class TrainRequest(BaseModel):
    teacher: str = Field(..., min_length=1, max_length=120)
    essay: str = Field(..., min_length=20, max_length=200_000)
    feedback: str = Field(..., min_length=2, max_length=200_000)
    grade: str = Field(..., min_length=1, max_length=40)
    rubric: str | None = Field(None, max_length=200_000)


class PredictRequest(BaseModel):
    teacher: str = Field(..., min_length=1, max_length=120)
    essay: str = Field(..., min_length=20, max_length=200_000)
    rubric: str | None = Field(None, max_length=200_000)
    top_k: int = Field(3, ge=1, le=10)


class TeacherSummary(BaseModel):
    name: str
    examples: int
    last_updated: float | None


# ─── Routes ──────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "generation_model": llm.GENERATION_MODEL,
        "embedding_model": llm.EMBEDDING_MODEL,
        "db_path": str(DB_PATH),
    }


@app.get("/teachers", response_model=list[TeacherSummary])
def teachers() -> list[dict]:
    con = db.open_db(DB_PATH)
    try:
        return db.list_teachers(con)
    finally:
        con.close()


@app.post("/train")
def train(req: TrainRequest) -> dict:
    try:
        emb = llm.embed(req.essay)
    except Exception as exc:
        logger.exception("embedding failed")
        raise HTTPException(status_code=503, detail=f"embedding failed: {exc}")
    con = db.open_db(DB_PATH)
    try:
        rid = db.insert_example(
            con,
            teacher=req.teacher,
            essay=req.essay,
            feedback=req.feedback,
            grade=req.grade,
            rubric=req.rubric,
            embedding=emb,
        )
    finally:
        con.close()
    logger.info("trained: teacher=%s id=%d grade=%s", req.teacher, rid, req.grade)
    return {"ok": True, "id": rid, "teacher": req.teacher}


@app.post("/predict")
def predict(req: PredictRequest) -> dict:
    try:
        emb = llm.embed(req.essay)
    except Exception as exc:
        logger.exception("query embedding failed")
        raise HTTPException(status_code=503, detail=f"embedding failed: {exc}")

    con = db.open_db(DB_PATH)
    try:
        all_examples = db.fetch_examples_for_teacher(con, req.teacher)
    finally:
        con.close()

    used = db.top_k_similar(all_examples, query=emb, k=req.top_k)

    if used:
        prompt = prompts.build_predict_prompt(
            essay=req.essay,
            teacher=req.teacher,
            rubric=req.rubric,
            examples=used,
        )
    else:
        # Cold start — first essay for this teacher. Fall back to a
        # rubric-only / general prompt.
        prompt = prompts.build_initial_predict_prompt(
            essay=req.essay,
            teacher=req.teacher,
            rubric=req.rubric,
        )

    try:
        raw = llm.generate_grade(prompt)
    except Exception as exc:
        logger.exception("generation failed")
        raise HTTPException(status_code=503, detail=f"generation failed: {exc}")

    parsed = llm.parse_grade_json(raw)
    return {
        "ok": True,
        "teacher": req.teacher,
        "examples_available": len(all_examples),
        "examples_used": len(used),
        "result": parsed,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "grade_predictor.server:app",
        host="0.0.0.0",
        port=int(os.environ.get("GP_PORT", "8001")),
        reload=False,
    )
