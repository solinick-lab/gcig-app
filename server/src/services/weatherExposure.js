// Curated exposure-basket config for the WX terminal panel. Two
// baskets in v1 — the cleanest, most uncontroversial ones for the
// single event type the panel cares about (US-landfall named storms):
//
//   gulf_oil_gas — Gulf-of-Mexico producers + pipelines. The Gulf
//     hosts ~14% of US crude production and a third of refining
//     capacity; a Cat 3+ landfall on the Texas / Louisiana coast
//     forces precautionary shut-ins and shuttered refineries. The
//     listing is editorial-but-transparent: integrateds with material
//     Gulf upstream (XOM), pure-play producers (OXY, MRO, CTRA),
//     midstream that runs the wet/dry gas highways inland (ET, EPD,
//     KMI). The market reaction is typically a relief rally on prompt
//     gas pricing + a near-term squeeze on refined-product cracks.
//
//   pc_insurers — US P&C names with material hurricane-cat exposure.
//     A landfall is a known insurance loss; the question is whether
//     it eats into reinsurance retention layers and pressures
//     catastrophe reinsurance pricing into the next year. HIG / TRV
//     / ALL / PGR / CB are the names with the broadest hurricane-
//     prone homeowners + commercial books. The trade is sometimes
//     post-event "fade the sell-off" (loss already priced in) and
//     sometimes a structural re-rate when retention layers blow
//     through.
//
// Both rationales sit in the methodology footer the panel renders, so
// the user sees what we're betting on and can disagree. Adding a
// third basket (utilities, ag, nat gas) is a config-only follow-up;
// no engine change.

export const EXPOSURES = [
  {
    id: 'gulf_oil_gas',
    label: 'Gulf O&G',
    tickers: ['XOM', 'OXY', 'MRO', 'ET', 'EPD', 'KMI', 'CTRA'],
    rationale:
      'Gulf of Mexico producers and pipelines. A landfall forces ' +
      'shut-ins on offshore platforms and idles refining capacity on ' +
      'the Texas / Louisiana coast — the historical price action is ' +
      'usually a near-term move on prompt gas and refined-product ' +
      'cracks.',
    eventTypes: ['us_landfall_named_storm'],
  },
  {
    id: 'pc_insurers',
    label: 'P&C Insurers (hurricane-exposed)',
    tickers: ['HIG', 'TRV', 'ALL', 'PGR', 'CB'],
    rationale:
      'P&C insurers with material US hurricane-catastrophe books. A ' +
      'landfall is a known loss event; the market read hinges on ' +
      'whether the loss eats through reinsurance retention layers ' +
      'and pressures cat-reinsurance pricing into the next year. ' +
      'Post-landfall the names sometimes fade as the loss is priced ' +
      'in, sometimes re-rate when retention layers blow through.',
    eventTypes: ['us_landfall_named_storm'],
  },
];
