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

export const NAV: NavGroup[] = [
  {
    title: 'Market',
    items: [
      { to: '/', label: 'Home', icon: '⌂', desc: 'Indices, movers, build-up and flows at a glance' },
      { to: '/watchlist', label: 'Watchlist', icon: '☆', desc: 'Track underlyings, futures and option contracts' },
      { to: '/option-chain', label: 'Option Chain', icon: '⛓', desc: 'Live chain with OI, IV, Greeks and build-up' },
      { to: '/synopsis', label: 'Synopsis', icon: '▦', desc: 'Heat-map of the whole F&O market' },
      { to: '/fii-dii', label: 'FII / DII', icon: '₹', desc: 'Institutional cash-market flows' },
      { to: '/participants', label: 'Participant OI', icon: '👥', desc: 'Client, DII, FII and Pro positions' },
    ],
  },
  {
    title: 'Trend & Flow',
    items: [
      { to: '/orb', label: '15-min Range Breakout', icon: '⇥', desc: 'First 15-min candle high/low — broken = trending' },
      { to: '/order-flow', label: 'Order Flow (1-min)', icon: '⇄', desc: 'Buyer vs seller volume in the last minute' },
    ],
  },
  {
    title: 'Open Interest',
    items: [
      { to: '/oi/strikes', label: 'OI Analysis', icon: '▮', desc: 'Strike-wise OI and change in OI' },
      { to: '/oi/multi-strike', label: 'Multi-Strike OI', icon: '≋', desc: 'Intraday OI of chosen strikes' },
      { to: '/oi/trend', label: 'OI Trend', icon: '↗', desc: 'Cumulative call vs put OI through the day' },
      { to: '/oi/pcr', label: 'PCR', icon: '⚖', desc: 'Put-call ratio, intraday and daily' },
      { to: '/oi/max-pain', label: 'Max Pain', icon: '◎', desc: 'Option pain by strike and its drift' },
      { to: '/oi/futures', label: 'Futures OI', icon: '⇅', desc: 'Price & OI build-up for every F&O future' },
      { to: '/oi/breadth', label: 'Build-up Breadth', icon: '▤', desc: 'Sector-wise long/short build-up counts' },
    ],
  },
  {
    title: 'Volatility',
    items: [
      { to: '/vol/iv-chart', label: 'IV Chart', icon: '∿', desc: 'ATM IV intraday and IV vs HV history' },
      { to: '/vol/ivp', label: 'IV Rank & Percentile', icon: '%', desc: 'IV, IVR, IVP and HV for all F&O symbols' },
      { to: '/vol/skew', label: 'Volatility Skew', icon: '⌣', desc: 'IV smile across strikes and expiries' },
      { to: '/vol/surface', label: 'Volatility Surface', icon: '▩', desc: 'IV by moneyness × expiry' },
      { to: '/vol/cone', label: 'Volatility Cone', icon: '◇', desc: 'Realised vol percentiles by horizon' },
    ],
  },
  {
    title: 'Strategy',
    items: [
      { to: '/builder', label: 'Strategy Builder', icon: '✚', desc: 'Payoff, Greeks, POP, margin and what-if' },
      { to: '/templates', label: 'Strategy Wizard', icon: '✦', desc: '49 ready-made strategies by market view' },
      { to: '/optimizer', label: 'Optimizer', icon: '⚙', desc: 'Best reward-to-risk strategies for your view' },
      { to: '/straddle', label: 'Straddle Chart', icon: '⋈', desc: 'ATM straddle / strangle premium intraday' },
      { to: '/strategy-chart', label: 'Strategy Chart', icon: '📈', desc: 'Chart any multi-leg strategy like one instrument' },
      { to: '/recap', label: 'Trade Recap', icon: '⏪', desc: 'Replay the market from any past date & time' },
    ],
  },
  {
    title: 'Trade',
    items: [
      { to: '/positions', label: 'Positions & Orders', icon: '💼', desc: 'Paper-trading account: orders, trades, funds' },
      { to: '/strategies', label: 'Strategy Manager', icon: '🗂', desc: 'Virtual strategies with live MTM & alerts' },
      { to: '/alerts', label: 'Alerts', icon: '🔔', desc: 'Price, IV, PCR, OI and MTM alerts' },
    ],
  },
  {
    title: 'Algo',
    items: [
      { to: '/algo', label: 'Algo Strategies', icon: '🤖', desc: 'Backtest and deploy rule-based strategies (Strategy 2 · ₹20 premium ladder)' },
    ],
  },
  {
    title: 'Scanners',
    items: [
      { to: '/scanners', label: 'F&O Scanners', icon: '⌕', desc: 'Build-up, OI, price, IV and option scans' },
      { to: '/unusual', label: 'Unusual Options', icon: '⚡', desc: 'Abnormal volume, OI and IV activity' },
      { to: '/order-book', label: 'Order Book', icon: '≣', desc: 'Market depth with order-flow analytics' },
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
