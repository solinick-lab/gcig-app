import fixture from './__fixtures__/hurdat2-us-landfalls.json' with { type: 'json' };
import { EXPOSURES } from './weatherExposure.js';
import { runEventStudy as defaultRunEventStudy } from './eventStudy.js';

// The assembly behind the WX panel. Takes a list of the user's
// holdings (cash already filtered out by the route) and returns the
// envelope the panel renders:
//
//   { asOf, activeStorms, exposures: [{ exposure, holdingsOverlap, study }] }
//
// The historical playbook is deterministic for a given fixture + price
// cache, so the per-exposure event-study result rides a 6h shared
// cache — the same convention secFilings.js uses. The NHC live feed is
// best-effort: a fetch failure degrades activeStorms to []; it does
// not fail the whole envelope. Same posture executiveBios / consensus
// / earnings take when their upstream goes dark.

const FIXTURE_LANDFALLS = fixture.entries || [];

// HURDAT2 only sees named-storm landfalls in v1, so every exposure's
// eventTypes filter resolves to the same fixture today. Once HDD/CDD,
// drought, freeze etc. land as separate event archives, this becomes a
// per-event-type fixture lookup; for v1 it's a guard against an
// exposure whose eventTypes never include the v1 event.
const V1_EVENT = 'us_landfall_named_storm';

const STUDY_TTL_MS = 6 * 60 * 60 * 1000;
const studyCache = new Map();

// Test hook: the cache survives across calls in the same process so
// the panel doesn't re-run the math every mount, but the test suite
// asserts behaviour across several injected runEventStudy stubs in a
// single process. Expose a tiny reset so each test can start from a
// clean cache without the math being a load-bearing global.
export function _resetWeatherImpactCache() {
  studyCache.clear();
}

// Honest UA for the NHC active-storms fetch. NHC requires no key but
// asks for a meaningful UA identifying the app + a contact, same
// posture SEC EDGAR enforces. The string mirrors SEC_UA in
// secFilings.js so a single 'Griffin Fund' identity reaches both.
const NHC_UA = 'Griffin Fund (Grace Church School) thegriffinfund.org';

// CurrentStorms.json shape (verified against the NHC docs): a top-
// level object with `activeStorms: [{ name, classification, intensity,
// latitudeNumeric, longitudeNumeric, lastUpdate, ... }]`. Empty list
// outside of hurricane season is the normal case.
async function defaultGetActiveStorms() {
  const res = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json', {
    headers: { 'User-Agent': NHC_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`NHC HTTP ${res.status}`);
  }
  const j = await res.json();
  const raw = Array.isArray(j?.activeStorms) ? j.activeStorms : [];
  return raw.map((s) => ({
    name: s.name || null,
    classification: s.classification || null,
    intensity: s.intensity != null ? Number(s.intensity) : null,
    latitude: s.latitudeNumeric != null ? Number(s.latitudeNumeric) : null,
    longitude: s.longitudeNumeric != null ? Number(s.longitudeNumeric) : null,
    lastUpdate: s.lastUpdate || null,
  }));
}

// A safe-empty study aggregate so a per-exposure rejection cannot leak
// undefined into the panel. The math primitive's own empty-shape uses
// the identical key/shape.
function emptyStudy() {
  return {
    perWindow: {
      '1d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
      '5d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
      '20d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
    },
    perEvent: [],
  };
}

export async function getWeatherImpact(holdings, deps = {}) {
  const runStudy = deps.runEventStudy || defaultRunEventStudy;
  const landfalls = Array.isArray(deps.landfalls) ? deps.landfalls : FIXTURE_LANDFALLS;
  const getActive = deps.getActiveStorms || defaultGetActiveStorms;

  // Holdings are normalized upper-case once; the overlap check is then
  // a straightforward Set intersection per basket.
  const heldUpper = new Set(
    (Array.isArray(holdings) ? holdings : [])
      .map((h) => String(h || '').trim().toUpperCase())
      .filter(Boolean)
  );

  // Active-storm fetch is best-effort and parallel with the studies —
  // a slow NHC fetch shouldn't gate the (cached) historical math.
  const activeP = (async () => {
    try {
      const list = await getActive();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.warn('weatherSignals: NHC active-storm fetch failed:', err.message);
      return [];
    }
  })();

  const exposures = [];
  for (const exposure of EXPOSURES) {
    if (!exposure.eventTypes || !exposure.eventTypes.includes(V1_EVENT)) {
      // A future basket whose event type isn't v1's storm archive —
      // surface it with an empty study, the panel can still render
      // the rationale for transparency.
      exposures.push({
        exposure,
        holdingsOverlap: [],
        study: emptyStudy(),
      });
      continue;
    }
    const overlap = exposure.tickers.filter((t) => heldUpper.has(t.toUpperCase()));
    const cacheKey = `${exposure.id}#${landfalls.length}`;
    const cached = studyCache.get(cacheKey);
    let study;
    if (cached && Date.now() - cached.at < STUDY_TTL_MS) {
      study = cached.study;
    } else {
      try {
        study = await runStudy(landfalls, exposure.tickers);
      } catch (err) {
        console.warn(
          `weatherSignals: event study for ${exposure.id} failed:`,
          err.message
        );
        study = emptyStudy();
      }
      studyCache.set(cacheKey, { at: Date.now(), study });
    }
    exposures.push({ exposure, holdingsOverlap: overlap, study });
  }

  const activeStorms = await activeP;
  return {
    asOf: new Date().toISOString(),
    activeStorms,
    exposures,
  };
}
