// Terminal function registry. Each entry is a Bloomberg-style mnemonic
// (DES, GP, CN, BI, etc.) with metadata and the React component that renders
// the panel for it. Adding a new function = adding one entry here plus one
// component file under ./functions/.

import Description from './functions/Description.jsx';
import Chart from './functions/Chart.jsx';
import News from './functions/News.jsx';
import BloombergIntelligence from './functions/BloombergIntelligence.jsx';
import Help from './functions/Help.jsx';
import Movers from './functions/Movers.jsx';
import Peers from './functions/Peers.jsx';
import InsiderActivity from './functions/InsiderActivity.jsx';
import Filings from './functions/Filings.jsx';
import Earnings from './functions/Earnings.jsx';
import Consensus from './functions/Consensus.jsx';
import Compare from './functions/Compare.jsx';
import InsiderClusters from './functions/InsiderClusters.jsx';
import Notes from './functions/Notes.jsx';
import Governance from './functions/Governance.jsx';
import TopNews from './functions/TopNews.jsx';
import WorldIndices from './functions/WorldIndices.jsx';
import MacroSensitivity from './functions/MacroSensitivity.jsx';
import ComingSoon from './functions/ComingSoon.jsx';

export const FUNCTIONS = [
  {
    id: 'DES',
    label: 'Description',
    help: 'Company snapshot: quote, fundamentals, business summary, AI brief.',
    requires: 'ticker',
    component: Description,
  },
  {
    id: 'GP',
    label: 'Chart',
    help: 'Price chart with selectable interval.',
    requires: 'ticker',
    component: Chart,
  },
  {
    id: 'CN',
    label: 'Company News',
    help: 'Latest news headlines for the focused ticker.',
    requires: 'ticker',
    component: News,
  },
  {
    id: 'BI',
    label: 'Bloomberg Intelligence',
    help: 'Free-form research chat with workspace context.',
    requires: null,
    component: BloombergIntelligence,
  },
  {
    id: 'HELP',
    label: 'Help',
    help: 'List of available terminal functions.',
    requires: null,
    component: Help,
  },
  { id: 'FA', label: 'Financial Analysis', help: 'Multi-year fundamentals deep dive.', requires: 'ticker', component: ComingSoon },
  { id: 'PEER', label: 'Peers', help: 'Sector peer comparison table.', requires: 'ticker', component: Peers },
  { id: 'INSDR', label: 'Insider Activity', help: 'Form 4 insider buys/sells on the price chart.', requires: 'ticker', component: InsiderActivity },
  { id: 'FIL', label: 'Filings', help: 'Recent SEC filings (8-K/10-Q/10-K/DEF 14A/Form 4) with an AI read.', requires: 'ticker', component: Filings },
  { id: 'EARN', label: 'Earnings', help: 'Next report + trailing EPS beat/miss history.', requires: 'ticker', component: Earnings },
  { id: 'CON', label: 'Analyst Consensus', help: 'Buy/hold/sell breakdown & trend.', requires: 'ticker', component: Consensus },
  { id: 'CMP', label: 'Compare', help: '2–4 tickers side by side: live price, day %, valuation.', requires: null, component: Compare },
  { id: 'ICLUSTER', label: 'Insider Clusters', help: 'Multi-insider buy clusters across your book (last 60d).', requires: null, component: InsiderClusters },
  { id: 'NOTE', label: 'Notes', help: 'Your private research notes for this ticker (saved to your profile).', requires: 'ticker', component: Notes },
  { id: 'MGMT', label: 'Management & Board', help: 'CEO, board, comp & interlocking boards from the latest DEF 14A.', requires: 'ticker', component: Governance },
  { id: 'WEI', label: 'World Indices', help: 'Global index snapshot.', requires: null, component: WorldIndices },
  { id: 'TOP', label: 'Top News', help: 'Market-wide top headlines.', requires: null, component: TopNews },
  { id: 'MOVR', label: 'Movers', help: 'Day\'s biggest gainers and losers.', requires: null, component: Movers },
  { id: 'ECO', label: 'Economic Calendar', help: 'Upcoming releases and central bank events.', requires: null, component: ComingSoon },
  { id: 'MACRO', label: 'Macro Sensitivity', help: 'Portfolio sensitivity to 10Y, oil, USD, VIX, SPY (1y OLS).', requires: null, component: MacroSensitivity },
];

export const FUNCTION_BY_ID = Object.fromEntries(FUNCTIONS.map((f) => [f.id, f]));
export const FUNCTION_IDS = new Set(FUNCTIONS.map((f) => f.id));

export function getFunction(id) {
  return FUNCTION_BY_ID[String(id || '').toUpperCase()] || null;
}
