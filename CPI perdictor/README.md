# cpi-forecaster

Monthly US headline CPI forecaster. Pulls the macro panel from your
gcig-api (which holds the FRED key), runs a SARIMA + Ridge + XGBoost
ensemble for the next 3 months, and POSTs the forecast back to gcig-api.

Secrets needed on this host: ONE shared HMAC secret. The FRED_API_KEY
stays on Render.

## How the system fits together

```
                              FRED.gov
                                ▲
                                │ (FRED_API_KEY only here)
                                │
┌──────────────┐  GET /api/cpi/fred-panel  ┌──────────────────┐
│ THIS HOST    │ ◀───────────────────────── │  gcig-api        │
│ (WSL/Linux)  │     HMAC-signed            │  (Render)        │
│              │                            │                  │
│ cpi-forecast │  POST /api/cpi/ingest      │   CpiForecast    │
│              │ ─────────────────────────▶ │   (Postgres)     │
└──────────────┘     HMAC-signed            └──────────────────┘
                                                    │
                                                    ▼
                                            React /cpi page
```

The forecaster pulls macro data through gcig-api and pushes the forecast
back through gcig-api. It never holds upstream API keys.

## Install (in WSL Ubuntu)

```bash
sudo apt update && sudo apt install -y python3-venv python3-pip python3-dev build-essential

cd ~/cpi-forecaster
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e .
```

## Configure

Two env vars on this host:

```bash
export GCIG_API_URL="https://gcig-api.onrender.com"
export CPI_INGEST_SECRET="<shared secret — same value as on Render>"
```

Put them in `~/.bashrc`, an env file, or a systemd unit's `EnvironmentFile=`.

To make a secret once:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Set the SAME value:

1. Render dashboard → `gcig-api` → Environment → `CPI_INGEST_SECRET`
2. Your shell here on this host

(`FRED_API_KEY` stays on Render only — already configured for the
existing macro snapshot. The forecaster never sees it.)

## Run

```bash
# Dry run — pull panel, compute, print, don't POST.
cpi-forecast run --dry-run

# Real run — POSTs the forecast.
cpi-forecast run

# Save the JSON to disk too.
cpi-forecast run --json /tmp/cpi-$(date +%F).json
```

## Schedule (monthly cron)

US BLS releases CPI for month M around the 10th–13th of M+1, at 8:30 ET.
Schedule for the morning of the 14th UTC to be safe:

```cron
# crontab -e (in WSL)
15 11 14 * * bash -lc 'source ~/cpi-forecaster/.venv/bin/activate && cpi-forecast run >> ~/cpi-forecaster/run.log 2>&1'
```

11:15 UTC is 7:15 AM Eastern, well after the BLS release window.

WSL2 note: cron isn't auto-started when Windows boots. Two options:

1. Start cron in WSL on demand: `sudo service cron start` (need to do this
   each time you launch WSL — or set up a wsl.conf to auto-start it).
2. Use Windows Task Scheduler instead, with the action
   `wsl -- bash -lc "source ~/cpi-forecaster/.venv/bin/activate && cpi-forecast run"`.
   This wakes WSL on demand, doesn't need WSL to be running 24/7.

For a once-a-month job, Task Scheduler is more reliable.

## Project layout

```
cpi-forecaster/
├── pyproject.toml
├── src/cpi_forecaster/
│   ├── api_client.py       # HMAC-signed client for gcig-api
│   ├── fred.py             # Loads the macro panel via gcig-api
│   ├── features.py         # YoY/MoM/lags/transforms; ragged-edge handling
│   ├── models/
│   │   ├── sarima.py       # statsmodels SARIMAX, AIC grid
│   │   ├── ridge.py        # sklearn RidgeCV with macro features
│   │   └── xgb.py          # xgboost regressor
│   ├── ensemble.py         # inverse-error weights, MoM→YoY chaining
│   ├── backtest.py         # rolling 24-month backtest
│   ├── publish.py          # thin wrapper over api_client.post_forecast
│   └── cli.py              # `cpi-forecast` entrypoint
└── README.md
```

## What the website needs

In `gcig-app`:

1. The `CpiForecast` Prisma model is already in `schema.prisma`. Run the
   migration:
   ```bash
   cd gcig-app/server
   npx prisma migrate dev --name add_cpi_forecast
   ```
2. Render needs `CPI_INGEST_SECRET` set in the `gcig-api` service env.
   `FRED_API_KEY` should already be set there for the existing macro
   snapshot — the forecaster reuses that.
3. Sign in to the site — **CPI Forecast** is in the sidebar under
   "Investing." It says "No forecast yet" until the first POST lands.

## Troubleshooting

- **`fred-panel GET failed: 401 Invalid signature`** — `CPI_INGEST_SECRET`
  doesn't match between host and Render. Must be byte-for-byte identical.
- **`fred-panel GET failed: 401 Timestamp outside tolerance window`** —
  clock skew. In WSL: `sudo apt install -y ntp && sudo service ntp start`.
- **`fred-panel GET failed: 503 FRED fetch failed`** — `FRED_API_KEY` is
  missing or rate-limited on Render. Check the `gcig-api` env vars.
- **`Not enough history for backtest`** — empty cache + a temporary
  network blip. `rm -rf .cache && cpi-forecast run --dry-run`.
