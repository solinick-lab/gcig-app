# grade_predictor

Per-teacher essay grading over a local Ollama-served LLM. Lives
outside the gcig-app monorepo's main pipelines so the experiment +
ML deps stay isolated from the production stack.

## What it does

1. Student submits an essay. After the teacher returns it graded,
   the student feeds the comments + final grade back as training
   data tagged with the teacher's name.
2. As the corpus grows per teacher, retrieval-augmented prompts
   start grounding new predictions in actual prior examples from
   the same teacher.
3. For new essays, the system retrieves the 3 most similar prior
   essays (cosine similarity over `nomic-embed-text` embeddings),
   stuffs them into the context, and asks `qwen3.6:27b` to mimic
   the teacher's grading style.

The LLM never sees a "training corpus" it learned weights from;
the grading style is built fresh per request from concrete prior
examples (RAG, not fine-tuning). This is "use the data, not just
the model".

## Running

Prereqs:

- Ollama installed and running (`ollama serve` or the Windows
  service installer).
- `qwen3.6:27b` and `nomic-embed-text` pulled:

  ```
  ollama pull qwen3.6:27b
  ollama pull nomic-embed-text
  ```

- Python 3.11+

Install + run:

```bash
cd sandbox
python -m venv .venv
.venv\Scripts\activate            # PowerShell on Windows
pip install -e .
python -m grade_predictor.server  # listens on :8001
```

For "Option A" (both models pinned in memory between requests):

```
set OLLAMA_KEEP_ALIVE=24h
ollama serve
```

## Talking to it from the React Sandbox page

The React Sandbox in gcig-app calls `GP_API_URL` (defaults to
`http://localhost:8001`). To reach it from the Render-deployed
client over the public internet, expose it via a Cloudflare tunnel
the same way `llm.thegriffinfund.org` is set up:

```
cloudflared tunnel route dns <tunnel-id> grade.thegriffinfund.org
```

Then on the gcig-client side, set `VITE_GP_API_URL` to
`https://grade.thegriffinfund.org` at build time and update the
CSP `connect-src` directive accordingly.

## Endpoints

- `GET  /health`     — liveness + which models are configured
- `GET  /teachers`   — corpus size per teacher
- `POST /train`      — save one (essay, feedback, grade, teacher) tuple
- `POST /predict`    — return line-by-line comments + grade prediction

See `grade_predictor/server.py` for request/response schemas.

## Storage

SQLite at `sandbox/data/grade_predictor.db`. Schema is in
`grade_predictor/db.py`. Embeddings are stored as JSON-encoded float
arrays alongside the row — fine for hundreds of essays per teacher;
swap to a real vector store if you ever cross thousands.
