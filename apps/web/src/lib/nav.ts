/** A page of a menu entry: shown as a sub-tab at the top of the entry's pages. */
export interface SubTab {
  /** Address; a `?view=` query selects a view of a page that has several. */
  to: string;
  label: string;
  desc: string;
}

/** A sidebar entry: one or more related pages, opened at the first. */
export interface NavItem {
  label: string;
  icon: string;
  desc: string;
  tabs: SubTab[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * The menu: six groups, each with only a few entries; an entry's related pages are sub-tabs shown at the
 * top of its pages (every page keeps its own address, so links and bookmarks still work).
 *   Market Overview         — Home (overview · watchlist) · F&O Market (heat-map, build-up, breadth,
 *                             scanners, unusual options, NIFTY Top 10) · Institutional Activity
 *   Option Chain & OI       — Option Chain · Open Interest (strike-wise, multi-strike, PCR, max pain)
 *   Intraday Charts & Range — Market Terminal (terminal, order flow & book, range breakout) · Expected
 *                             Range (expected range, straddle chart)
 *   Strategy                — Strategy Builder (builder, wizard, optimizer) · Strategy Analysis (chart, recap)
 *   Paper Trading           — Portfolio (positions & orders, strategy manager, alerts) · Algo Strategies
 *   More                    — Tools (calculators, learn) · Settings
 */
export const NAV: NavGroup[] = [
  {
    title: 'Market Overview',
    items: [
      {
        label: 'Home',
        icon: '⌂',
        desc: 'Market overview and your watchlist',
        tabs: [
          { to: '/', label: 'Overview', desc: 'Indices, MCX commodities, movers, build-up and flows at a glance' },
          { to: '/watchlist', label: 'Watchlist', desc: 'Track underlyings, futures and option contracts' },
        ],
      },
      {
        label: 'F&O Market',
        icon: '▦',
        desc: 'The whole F&O universe: heat-map, build-up, breadth, scanners, unusual options and the NIFTY heavyweights',
        tabs: [
          { to: '/fno-market?view=heatmap', label: 'Heat-map', desc: 'The F&O stock universe sized by turnover, coloured by price, OI or IV change' },
          { to: '/fno-market?view=futures', label: 'Futures build-up', desc: 'Near-month futures: price change vs OI change' },
          { to: '/fno-market?view=breadth', label: 'Sector breadth', desc: 'Long / short build-up, covering and unwinding by sector' },
          { to: '/scanners', label: 'Scanners', desc: 'Pre-built build-up, OI, price, IV, option and trend scans' },
          { to: '/scanners?view=unusual', label: 'Unusual options', desc: 'Abnormal volume, OI and IV activity' },
          { to: '/nifty-top10', label: 'NIFTY Top 10', desc: 'The index heavyweights: futures, options and order flow side by side, with a transparent bias' },
        ],
      },
      {
        label: 'Institutional Activity',
        icon: '₹',
        desc: 'FII / DII cash flows and participant-wise F&O positions (official, daily)',
        tabs: [
          { to: '/institutions?view=fii-dii', label: 'FII / DII', desc: 'Institutional cash-market flows (official, daily)' },
          { to: '/institutions?view=participants', label: 'Participant OI', desc: 'Client, DII, FII and Pro F&O positions (official, daily)' },
        ],
      },
    ],
  },
  {
    title: 'Option Chain & OI',
    items: [
      {
        label: 'Option Chain',
        icon: '⛓',
        desc: 'Live chain with OI, IV, Greeks and build-up — indices, stocks and MCX commodities',
        tabs: [{ to: '/option-chain', label: 'Option Chain', desc: 'Live chain with OI, IV, Greeks and build-up — indices, stocks and MCX commodities (GOLD, CRUDEOIL …)' }],
      },
      {
        label: 'Open Interest',
        icon: '▮',
        desc: 'Strike-wise OI, multi-strike OI, PCR & OI trend and max pain',
        tabs: [
          { to: '/oi/strikes', label: 'OI Analysis', desc: 'Strike-wise OI and change in OI' },
          { to: '/oi/multi-strike', label: 'Multi-Strike OI', desc: 'Intraday OI of chosen strikes' },
          { to: '/oi/pcr', label: 'PCR & OI Trend', desc: 'Call vs put OI through the day, PCR and change-in-OI PCR, daily PCR' },
          { to: '/oi/max-pain', label: 'Max Pain', desc: 'Option pain by strike and its drift' },
        ],
      },
    ],
  },
  {
    title: 'Intraday Charts & Range',
    items: [
      {
        label: 'Market Terminal',
        icon: '▣',
        desc: 'One underlying through the session: terminal charts, order flow & book, opening range breakout',
        tabs: [
          { to: '/terminal', label: 'Terminal', desc: 'Price with EMA, total CE vs PE OI with build-up, PCR (OI & COI) and volume vs OI on one screen' },
          { to: '/order-book', label: 'Order Flow & Book', desc: 'Buyer vs seller initiated quantity per minute, cumulative delta, market depth' },
          { to: '/orb', label: '15-min Range Breakout', desc: 'First 15-min candle high/low — broken = trending' },
        ],
      },
      {
        label: 'Expected Range',
        icon: '↕',
        desc: 'Daily and intraday expected move (ATM IV, straddle, India VIX) and the straddle chart',
        tabs: [
          { to: '/expected-range', label: 'Expected Range', desc: 'Daily and intraday expected move of NIFTY, SENSEX, GOLD, SILVER, NATURAL GAS and CRUDE OIL (ATM IV, straddle, India VIX), with hit-rates' },
          { to: '/straddle', label: 'Straddle Chart', desc: 'ATM straddle / strangle premium intraday' },
        ],
      },
    ],
  },
  {
    title: 'Strategy',
    items: [
      {
        label: 'Strategy Builder',
        icon: '✚',
        desc: 'Build a strategy, pick a ready-made one or let the optimizer rank them',
        tabs: [
          { to: '/builder', label: 'Builder', desc: 'Payoff, Greeks, POP, margin and what-if' },
          { to: '/templates', label: 'Wizard', desc: '49 ready-made strategies by market view' },
          { to: '/optimizer', label: 'Optimizer', desc: 'Best reward-to-risk strategies for your view' },
        ],
      },
      {
        label: 'Strategy Analysis',
        icon: '📈',
        desc: 'Chart a strategy through the day and replay past sessions',
        tabs: [
          { to: '/strategy-chart', label: 'Strategy Chart', desc: 'Chart any multi-leg strategy like one instrument' },
          { to: '/recap', label: 'Trade Recap', desc: 'Replay the market from any past date & time' },
        ],
      },
    ],
  },
  {
    title: 'Paper Trading',
    items: [
      {
        label: 'Portfolio',
        icon: '💼',
        desc: 'Paper positions, orders and funds, virtual strategies and alerts',
        tabs: [
          { to: '/positions', label: 'Positions & Orders', desc: 'Paper-trading account: orders, trades, funds' },
          { to: '/strategies', label: 'Strategy Manager', desc: 'Virtual strategies with live MTM & alerts' },
          { to: '/alerts', label: 'Alerts', desc: 'Price, IV, PCR, OI and MTM alerts' },
        ],
      },
      {
        label: 'Algo Strategies',
        icon: '🤖',
        desc: 'Backtest and deploy rule-based strategies (Strategy 2 · ₹20 and Strategy 3 · ₹50 premium ladders)',
        tabs: [{ to: '/algo', label: 'Algo Strategies', desc: 'Backtest and deploy rule-based strategies (Strategy 2 · ₹20 and Strategy 3 · ₹50 premium ladders)' }],
      },
    ],
  },
  {
    title: 'More',
    items: [
      {
        label: 'Tools',
        icon: '∑',
        desc: 'Calculators and the options classroom',
        tabs: [
          { to: '/calculators', label: 'Calculators', desc: 'Option price, Greeks, IV and margin' },
          { to: '/learn', label: 'Learn', desc: 'Options classroom' },
        ],
      },
      { label: 'Settings', icon: '⚙︎', desc: 'Theme, defaults and account', tabs: [{ to: '/settings', label: 'Settings', desc: 'Theme, defaults and account' }] },
    ],
  },
];

/** Every page of the menu (each sub-tab), in menu order. */
export const NAV_PAGES: SubTab[] = NAV.flatMap((g) => g.items.flatMap((i) => i.tabs));

const pathOf = (to: string) => to.split('?')[0];
const viewOf = (to: string) => new URLSearchParams(to.split('?')[1] ?? '').get('view');

/**
 * The menu entry and sub-tab of a location: the sub-tab whose path matches and whose `view` is the
 * current one; else the entry's sub-tab of that path without a view; else its first one of that path.
 * `/learn/<lesson>` belongs to Learn.
 */
export function locate(pathname: string, search: string): { item: NavItem; tab: SubTab } | null {
  const path = pathname.startsWith('/learn/') ? '/learn' : pathname;
  const view = new URLSearchParams(search).get('view');
  for (const g of NAV) {
    for (const item of g.items) {
      const same = item.tabs.filter((t) => pathOf(t.to) === path);
      if (!same.length) continue;
      const tab = same.find((t) => view !== null && viewOf(t.to) === view) ?? same.find((t) => viewOf(t.to) === null) ?? same[0];
      return { item, tab };
    }
  }
  return null;
}

/** Bottom bar on phones (the full menu is in the drawer and on /tools). */
export const MOBILE_TABS: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/option-chain', label: 'Chain', icon: '⛓' },
  { to: '/builder', label: 'Builder', icon: '✚' },
  { to: '/positions', label: 'Positions', icon: '💼' },
  { to: '/tools', label: 'Tools', icon: '▦' },
];
