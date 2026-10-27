export interface NavItem {
  to: string;
  label: string;
  icon: string;
  desc: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * The menu, one group per kind of work, each tool in exactly one place:
 *   Market Overview      — the whole market at a glance (indices, F&O universe, scans, heavyweights, institutions)
 *   Option Chain & OI    — one underlying's option chain and its open-interest readings
 *   Intraday Charts & Range — one underlying's price, flow and expected-move charts through the session
 *   Strategy             — build, find, chart and replay option strategies
 *   Paper Trading        — the paper account, saved strategies, alerts and algos
 *   More                 — calculators, lessons, settings
 * Tabs that showed the same kind of data were merged into one tab with views (old addresses redirect,
 * see App.tsx): F&O Market (heat-map · futures build-up · breadth), F&O Scanners (pre-built scans ·
 * unusual option activity), Institutional Activity (FII / DII · participant-wise OI).
 */
export const NAV: NavGroup[] = [
  {
    title: 'Market Overview',
    items: [
      { to: '/', label: 'Home', icon: '⌂', desc: 'Indices, MCX commodities, movers, build-up and flows at a glance' },
      { to: '/watchlist', label: 'Watchlist', icon: '☆', desc: 'Track underlyings, futures and option contracts' },
      { to: '/fno-market', label: 'F&O Market', icon: '▦', desc: 'Every F&O future: heat-map, price vs OI build-up, sector breadth' },
      { to: '/scanners', label: 'F&O Scanners', icon: '⌕', desc: 'Pre-built build-up, OI, price, IV, option and trend scans, and unusual option activity' },
      { to: '/nifty-top10', label: 'NIFTY Top 10 Desk', icon: '★', desc: 'The index heavyweights: futures, options and order flow side by side, with a transparent bias' },
      { to: '/institutions', label: 'Institutional Activity', icon: '₹', desc: 'FII / DII cash flows and participant-wise F&O positions (official, daily)' },
    ],
  },
  {
    title: 'Option Chain & OI',
    items: [
      { to: '/option-chain', label: 'Option Chain', icon: '⛓', desc: 'Live chain with OI, IV, Greeks and build-up — indices, stocks and MCX commodities (GOLD, CRUDEOIL …)' },
      { to: '/oi/strikes', label: 'OI Analysis', icon: '▮', desc: 'Strike-wise OI and change in OI' },
      { to: '/oi/multi-strike', label: 'Multi-Strike OI', icon: '≋', desc: 'Intraday OI of chosen strikes' },
      { to: '/oi/pcr', label: 'PCR & OI Trend', icon: '⚖', desc: 'Call vs put OI through the day, PCR and change-in-OI PCR, daily PCR' },
      { to: '/oi/max-pain', label: 'Max Pain', icon: '◎', desc: 'Option pain by strike and its drift' },
    ],
  },
  {
    title: 'Intraday Charts & Range',
    items: [
      { to: '/terminal', label: 'Market Terminal', icon: '▣', desc: 'Price with EMA, total CE vs PE OI with build-up, PCR (OI & COI) and volume vs OI on one screen' },
      { to: '/order-book', label: 'Order Flow & Book', icon: '⇄', desc: 'Buyer vs seller initiated quantity per minute, cumulative delta, market depth' },
      { to: '/orb', label: '15-min Range Breakout', icon: '⇥', desc: 'First 15-min candle high/low — broken = trending' },
      { to: '/expected-range', label: 'Expected Range', icon: '↕', desc: 'Daily and intraday expected move of NIFTY, SENSEX, GOLD, SILVER, NATURAL GAS and CRUDE OIL (ATM IV, straddle, India VIX), with hit-rates' },
      { to: '/straddle', label: 'Straddle Chart', icon: '⋈', desc: 'ATM straddle / strangle premium intraday' },
    ],
  },
  {
    title: 'Strategy',
    items: [
      { to: '/builder', label: 'Strategy Builder', icon: '✚', desc: 'Payoff, Greeks, POP, margin and what-if' },
      { to: '/templates', label: 'Strategy Wizard', icon: '✦', desc: '49 ready-made strategies by market view' },
      { to: '/optimizer', label: 'Optimizer', icon: '⚙', desc: 'Best reward-to-risk strategies for your view' },
      { to: '/strategy-chart', label: 'Strategy Chart', icon: '📈', desc: 'Chart any multi-leg strategy like one instrument' },
      { to: '/recap', label: 'Trade Recap', icon: '⏪', desc: 'Replay the market from any past date & time' },
    ],
  },
  {
    title: 'Paper Trading',
    items: [
      { to: '/positions', label: 'Positions & Orders', icon: '💼', desc: 'Paper-trading account: orders, trades, funds' },
      { to: '/strategies', label: 'Strategy Manager', icon: '🗂', desc: 'Virtual strategies with live MTM & alerts' },
      { to: '/alerts', label: 'Alerts', icon: '🔔', desc: 'Price, IV, PCR, OI and MTM alerts' },
      { to: '/algo', label: 'Algo Strategies', icon: '🤖', desc: 'Backtest and deploy rule-based strategies (Strategy 2 · ₹20 and Strategy 3 · ₹50 premium ladders)' },
    ],
  },
  {
    title: 'More',
    items: [
      { to: '/calculators', label: 'Calculators', icon: '∑', desc: 'Option price, Greeks, IV and margin' },
      { to: '/learn', label: 'Learn', icon: '🎓', desc: 'Options classroom' },
      { to: '/settings', label: 'Settings', icon: '⚙︎', desc: 'Theme, defaults and account' },
    ],
  },
];

export const MOBILE_TABS: NavItem[] = [
  { to: '/', label: 'Home', icon: '⌂', desc: '' },
  { to: '/option-chain', label: 'Chain', icon: '⛓', desc: '' },
  { to: '/builder', label: 'Builder', icon: '✚', desc: '' },
  { to: '/positions', label: 'Positions', icon: '💼', desc: '' },
  { to: '/tools', label: 'Tools', icon: '▦', desc: '' },
];
