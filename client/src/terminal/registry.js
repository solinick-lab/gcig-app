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
import TopNews from './functions/TopNews.jsx';
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
  { id: 'WEI', label: 'World Indices', help: 'Global index snapshot.', requires: null, component: ComingSoon },
  { id: 'TOP', label: 'Top News', help: 'Market-wide top headlines.', requires: null, component: TopNews },
  { id: 'MOVR', label: 'Movers', help: 'Day\'s biggest gainers and losers.', requires: null, component: Movers },
  { id: 'ECO', label: 'Economic Calendar', help: 'Upcoming releases and central bank events.', requires: null, component: ComingSoon },
];

export const FUNCTION_BY_ID = Object.fromEntries(FUNCTIONS.map((f) => [f.id, f]));
export const FUNCTION_IDS = new Set(FUNCTIONS.map((f) => f.id));

export function getFunction(id) {
  return FUNCTION_BY_ID[String(id || '').toUpperCase()] || null;
}
