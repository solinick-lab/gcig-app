#!/usr/bin/env node
//
// Build the US-landfall named-storm fixture for the WX terminal panel.
//
// Source: NHC HURDAT2 — the National Hurricane Center's reanalysis
// archive for the North Atlantic basin. Public, no key, columnar text.
//   https://www.nhc.noaa.gov/data/
// As of 2026-05 the current filename is hurdat2-1851-2025-02272026.txt
// (verify by listing the directory above; NHC re-issues with a new
// suffix every annual update). The header below records the URL this
// run actually used so the fixture is reproducible from a stale repo.
//
// HURDAT2 format (one storm = one header row + N observation rows):
//   header: AL<NN><YYYY>,<NAME>,<COUNT>,
//   obs:    <YYYYMMDD>, <HHMM>, <RECORD_ID>, <STATUS>, <LAT>, <LON>,
//           <WIND>, <PRESSURE>, [12 radii fields]
// RECORD_ID is blank for routine obs and 'L' for the synoptic time of
// US landfall (NHC includes US-coastal-state landfalls only — Mexico,
// Cuba, etc. do not get the 'L' flag here). WIND is in knots; the
// Saffir-Simpson category is bucketed off the max wind at the
// landfall row (Cat 1 = 64–82 kt, Cat 2 = 83–95, Cat 3 = 96–112,
// Cat 4 = 113–136, Cat 5 = ≥137; below 64 kt = Tropical Storm).
//
// The fixture commits only Continental-US landfalls of named storms
// in seasons 2020-present (the WX panel's 5y price-bar cache bounds
// the useful window). HURDAT2's 'L' flag marks *any* landfall — the
// system crossing *a* coastline — so a Caribbean or Mexican landfall
// alone also gets an 'L'. The exposed baskets (Gulf O&G, US P&C
// insurers) trade off the Continental US footprint, so we filter the
// 'L' rows by a bounding box covering the US Gulf + Atlantic coast
// (lat 24-49N, lon 66-97W). Unnamed depressions ("TEN", "AL07…") are
// excluded — the market doesn't trade tropical depressions and the
// basket impact only kicks in once a system carries enough wind to
// be named.
//
// Run:
//   node scripts/build-hurdat2-fixture.mjs
// Writes:
//   server/src/services/__fixtures__/hurdat2-us-landfalls.json
//
// Honest about: NHC publishes the prior season's reanalysis with a
// roughly 12-month lag. The 2024 and 2025 seasons may not yet appear
// in HURDAT2 with their final tracks at the moment of this build;
// when they do, re-run this script and the fixture refreshes in
// place. Until then, the script emits whatever HURDAT2 contains and
// the runtime panel honestly reports the n it has.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HURDAT2_URL =
  'https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-02272026.txt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(
  __dirname,
  '..',
  'server',
  'src',
  'services',
  '__fixtures__',
  'hurdat2-us-landfalls.json'
);

// Continental US Gulf + Atlantic coast filter. Lat strings in HURDAT2
// are e.g. "28.0N"; lon strings are "94.8W" (W is negative, E positive,
// N positive, S negative). A naive bounding box catches the Bahamas
// (~24-27N, -79 to -73W — east of Florida, same latitude band as the
// state) and parts of Cuba. The CONUS Atlantic+Gulf coastline is
// approximately:
//   Gulf:        lat 24-31, lon -97 to -81  (TX → FL panhandle)
//   FL Atlantic: lat 25-31, lon -82 to -80
//   E. seaboard: lat 31-45, lon -82 to -67  (GA → Maine)
// The piecewise check below is the working test: a point counts as a
// US landfall if it sits inside one of those three rectangles. PR/USVI
// (lat 17-19) are excluded by design — the v1 baskets (Gulf O&G + East
// Coast P&C insurers) are CONUS-focused, so this is the right scope.
// Future basket revisions can widen the box.
function isContinentalUSLandfall(latStr, lonStr) {
  const latM = /^(-?\d+(?:\.\d+)?)\s*([NS])$/.exec(latStr.trim());
  const lonM = /^(-?\d+(?:\.\d+)?)\s*([EW])$/.exec(lonStr.trim());
  if (!latM || !lonM) return false;
  const lat = parseFloat(latM[1]) * (latM[2] === 'S' ? -1 : 1);
  const lon = parseFloat(lonM[1]) * (lonM[2] === 'W' ? -1 : 1);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  // Gulf coast (TX → FL panhandle).
  if (lat >= 24 && lat <= 31 && lon >= -97 && lon <= -81) return true;
  // Florida (incl. Keys) — peninsula and Atlantic coast.
  if (lat >= 24 && lat <= 31 && lon >= -82 && lon <= -80) return true;
  // GA → Maine eastern seaboard.
  if (lat >= 31 && lat <= 45 && lon >= -82 && lon <= -67) return true;
  return false;
}

function categoryFromWindKt(kt) {
  if (!Number.isFinite(kt) || kt < 0) return 'Tropical Storm';
  if (kt >= 137) return 'Hurricane Cat 5';
  if (kt >= 113) return 'Hurricane Cat 4';
  if (kt >= 96) return 'Hurricane Cat 3';
  if (kt >= 83) return 'Hurricane Cat 2';
  if (kt >= 64) return 'Hurricane Cat 1';
  return 'Tropical Storm';
}

function parseHurdat2(text) {
  const lines = text.split(/\r?\n/);
  const storms = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !line.trim()) {
      i += 1;
      continue;
    }
    // Header line: AL<NN><YYYY>,<NAME>,<COUNT>,
    const hdr = line.match(/^AL(\d{2})(\d{4}),\s*([A-Z\-]+)\s*,\s*(\d+),/);
    if (!hdr) {
      i += 1;
      continue;
    }
    const season = parseInt(hdr[2], 10);
    const name = hdr[3].trim();
    const obsCount = parseInt(hdr[4], 10);
    const obsRows = [];
    for (let k = 1; k <= obsCount; k++) {
      const row = lines[i + k];
      if (!row) break;
      const cols = row.split(',').map((s) => s.trim());
      // Required: date, hhmm, recordId, status, lat, lon, wind
      if (cols.length < 7) continue;
      obsRows.push({
        date: cols[0],
        hhmm: cols[1],
        recordId: cols[2],
        status: cols[3],
        lat: cols[4],
        lon: cols[5],
        wind: parseInt(cols[6], 10),
      });
    }
    storms.push({ season, name, obsRows });
    i += 1 + obsCount;
  }
  return storms;
}

function buildLandfallEntries(storms) {
  const out = [];
  for (const storm of storms) {
    if (storm.season < 2020) continue;
    // Unnamed systems carry placeholders ("UNNAMED", "TEN", "FIFTEEN"
    // etc.). The market-impact angle hinges on a system being named.
    const isNamed =
      storm.name &&
      storm.name !== 'UNNAMED' &&
      !/^(TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|TWENTY-?ONE|TWENTY-?TWO|THIRTY)$/i.test(
        storm.name
      ) &&
      !/^[A-Z]+ONE$|^[A-Z]+TWO$/.test(storm.name);
    if (!isNamed) continue;
    // The strongest CONUS-landfall observation for this storm. A
    // storm may carry multiple 'L' rows — a Caribbean or Mexican
    // brush (Gonzalo 2020 / Yucatán-then-Texas Beryl 2024) we drop
    // via the CONUS bounding box, and a CONUS storm can land twice
    // (Sally 2020 grazed South Florida as a 30 kt TD before its real
    // 95 kt Alabama landfall four days later). The market-relevant
    // event is the strongest landfall, not the first paw-touch: take
    // the max-wind L row that lies inside CONUS.
    const usLandRows = storm.obsRows.filter(
      (r) => r.recordId === 'L' && isContinentalUSLandfall(r.lat, r.lon)
    );
    if (usLandRows.length === 0) continue;
    const land = usLandRows.reduce((best, r) =>
      Number.isFinite(r.wind) && (best == null || r.wind > best.wind) ? r : best,
    null);
    if (!land) continue;
    const y = land.date.slice(0, 4);
    const m = land.date.slice(4, 6);
    const d = land.date.slice(6, 8);
    out.push({
      name:
        storm.name.charAt(0) + storm.name.slice(1).toLowerCase(),
      date: `${y}-${m}-${d}`,
      category: categoryFromWindKt(land.wind),
      season: storm.season,
    });
  }
  // Sort by date, oldest first — chronological reads well in a
  // hand-eyeballable fixture.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function main() {
  const res = await fetch(HURDAT2_URL, {
    headers: {
      'User-Agent':
        'Griffin Fund (Grace Church School) thegriffinfund.org',
    },
  });
  if (!res.ok) {
    throw new Error(`HURDAT2 fetch failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  const storms = parseHurdat2(text);
  const entries = buildLandfallEntries(storms);
  const payload = {
    _source: HURDAT2_URL,
    _generatedAt: new Date().toISOString(),
    _comment:
      'NHC HURDAT2 Continental-US-landfall named storms (2020-present). ' +
      'HURDAT2 marks every landfall row with an "L" regardless of ' +
      'country; we filter to rows whose lat/lon sit inside the CONUS ' +
      'Gulf + Atlantic coastline rectangles. For storms that landfall ' +
      'in CONUS more than once (Sally 2020 brushed Florida as a TD ' +
      'before its Alabama hurricane landfall), the strongest L row is ' +
      'used — the market-relevant event date. Saffir-Simpson category ' +
      'is bucketed off the wind speed at that row. Regenerate with ' +
      'scripts/build-hurdat2-fixture.mjs after each annual NHC update.',
    entries,
  };
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${entries.length} entries to ${OUT_PATH}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
