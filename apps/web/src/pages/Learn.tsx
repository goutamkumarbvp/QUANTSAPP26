import { Link, useParams } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui';

interface Article {
  slug: string;
  title: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  summary: string;
  body: { h?: string; p: string[]; tool?: { to: string; label: string } }[];
}

const ARTICLES: Article[] = [
  {
    slug: 'options-basics',
    title: 'Options in 10 minutes',
    level: 'Beginner',
    summary: 'Calls, puts, premium, strike, expiry, lot size, ITM/ATM/OTM.',
    body: [
      { p: ['An option is a contract that gives the buyer the right — but not the obligation — to buy (call, CE) or sell (put, PE) the underlying at a fixed price (the strike) on expiry. The buyer pays a premium; the seller (writer) receives it and takes on the obligation.'] },
      { h: 'Moneyness', p: ['A call is in-the-money (ITM) when spot is above the strike, a put when spot is below. The strike nearest to spot is at-the-money (ATM). Everything else is out-of-the-money (OTM) and consists only of time value.'] },
      { h: 'Premium = intrinsic + time value', p: ['Intrinsic value is what the option would be worth if it expired now. Time value is the extra the market pays for the chance of further movement — it decays to zero by expiry.'] },
      { h: 'Contract specs in India', p: ['Index and stock options are European and cash-settled. Expiry days and cycles (weekly or monthly) are set by the exchanges and change from time to time — the app shows only the expiries that are actually listed. Each contract has a fixed lot size set by the exchange and revised periodically; the app reads it from the live instrument master.'], tool: { to: '/option-chain', label: 'Open the option chain' } },
    ],
  },
  {
    slug: 'greeks',
    title: 'The Greeks — delta, gamma, theta, vega',
    level: 'Beginner',
    summary: 'How option prices react to price, time and volatility.',
    body: [
      { h: 'Delta', p: ['Change in premium for a ₹1 move in the underlying. Calls 0 to 1, puts 0 to −1; ATM ≈ ±0.5. Position delta tells you your directional exposure in units of the underlying.'] },
      { h: 'Gamma', p: ['How fast delta changes. Highest for ATM options close to expiry — which is why short ATM options near expiry can swing violently.'] },
      { h: 'Theta', p: ['Premium lost per calendar day, all else equal. Option buyers pay theta; sellers collect it.'] },
      { h: 'Vega', p: ['Change in premium for a 1-point change in implied volatility. Long options are long vega; short options are short vega.'], tool: { to: '/calculators', label: 'Try the Greeks calculator' } },
    ],
  },
  {
    slug: 'open-interest',
    title: 'Reading open interest & build-up',
    level: 'Intermediate',
    summary: 'OI, change in OI, long/short build-up, short covering, long unwinding.',
    body: [
      { p: ['Open interest is the number of contracts outstanding. Price tells you direction; OI tells you whether money is entering or leaving.'] },
      { h: 'The four quadrants', p: ['Price ↑ + OI ↑ = Long build-up (fresh buying). Price ↓ + OI ↑ = Short build-up (fresh selling). Price ↑ + OI ↓ = Short covering. Price ↓ + OI ↓ = Long unwinding.'] },
      { h: 'Option OI as support & resistance', p: ['Strikes with the largest put OI often act as support (put writers defend them); the largest call OI marks resistance. Fresh additions (change in OI) matter more than stale OI.'], tool: { to: '/oi/strikes', label: 'Open OI analysis' } },
    ],
  },
  {
    slug: 'pcr-max-pain',
    title: 'PCR and Max Pain',
    level: 'Intermediate',
    summary: 'Two popular sentiment gauges and how not to misuse them.',
    body: [
      { h: 'Put-call ratio', p: ['PCR = total put OI ÷ total call OI. In Indian index options, rising PCR usually reflects put writing (bullish), while a very high PCR can signal an overcrowded bullish trade. Watch the trend through the day, not a single value.'], tool: { to: '/oi/pcr', label: 'See PCR' } },
      { h: 'Max pain', p: ['The expiry price at which option buyers in aggregate lose the most. Spot sometimes gravitates toward it near expiry, but it is a tendency, not a target — large moves easily override it.'], tool: { to: '/oi/max-pain', label: 'See max pain' } },
    ],
  },
  {
    slug: 'implied-volatility',
    title: 'Implied volatility, IV Rank & IV Percentile',
    level: 'Intermediate',
    summary: 'Is the option expensive or cheap?',
    body: [
      { p: ['Implied volatility (IV) is the volatility that makes the Black-Scholes price equal the market premium — the market\'s forecast of movement. Compare it with historical (realised) volatility to judge whether options are rich or cheap.'] },
      { h: 'IV Rank vs IV Percentile', p: ['IV Rank places today\'s IV between the 1-year low (0) and high (100). IV Percentile is the share of days in the past year when IV was lower. High values favour premium-selling strategies; low values favour buying.'] },
      { h: 'Skew', p: ['Index options usually show higher IV for OTM puts than OTM calls (crash protection is in demand). Changes in skew reveal shifting fear.'] },
    ],
  },
  {
    slug: 'strategies',
    title: 'Spreads, straddles and condors',
    level: 'Intermediate',
    summary: 'Match the strategy to your view on direction and volatility.',
    body: [
      { h: 'Directional', p: ['Bullish: buy call, bull call spread, bull put spread. Bearish: buy put, bear put spread, bear call spread. Spreads cap both profit and loss and reduce cost.'] },
      { h: 'Range-bound', p: ['Short straddles/strangles collect the most premium but carry unlimited risk; iron condors and iron butterflies add wings to define the risk.'] },
      { h: 'Big move expected', p: ['Long straddles and strangles profit from large moves either way and from rising IV, but lose to time decay.'], tool: { to: '/templates', label: 'Browse 49 strategy templates' } },
    ],
  },
  {
    slug: 'opening-range-order-flow',
    title: 'Opening range breakout & 1-minute order flow',
    level: 'Intermediate',
    summary: 'Is the market trending today, and who is pushing it right now?',
    body: [
      { h: 'Note the first 15-minute candle', p: ['At 09:30 the first 15-minute candle (09:15–09:30) is complete. Its high and low form the opening range — the price zone where the day\'s first battle between buyers and sellers happened.'] },
      { h: 'Broken = trending', p: ['If a 1-minute candle closes above the range high, buyers have won the open and the market can be treated as trending up; a close below the range low means trending down. While price stays inside the range the market is range-bound.', 'When both sides get broken the day is a whipsaw — trust the latest break, use tighter stops, and be wary when price falls back inside the range (a possible failed breakout).'], tool: { to: '/orb', label: 'Open the range breakout tool' } },
      { h: '1-minute order flow', p: ['Every trade either lifts the offer (an aggressive buyer) or hits the bid (an aggressive seller). Adding those up minute by minute shows who is in control right now: buy volume vs sell volume, their difference (delta) and the running cumulative delta. The exchange does not publish who initiated a trade, so the app estimates it from live ticks: a trade at or above the best ask seen just before it counts as a buy, at or below the best bid as a sell, and anything else stays unclassified — it is never split 50/50. Volume that arrives after a feed gap is shown separately as a feed gap, and a minute recorded only in part is marked as a lower bound.'] },
      { h: 'Using them together', p: ['A breakout backed by buyers dominating the next few minutes (positive delta) is more convincing than one on thin or opposing flow. If price breaks the high but sellers dominate, treat it with suspicion.'], tool: { to: '/order-book', label: 'Open Order Flow & Book' } },
    ],
  },
  {
    slug: 'algo-premium-ladder',
    title: 'Algo strategy: premium ladder short strangle (Strategy 2)',
    level: 'Advanced',
    summary: 'Sell ₹20 OTM options at 09:20 and roll the safe side every time the other side gains 50%.',
    body: [
      { h: 'Entry', p: ['At 09:20 sell one call and one put, both out of the money, whose premiums are closest to the starting premium (₹20). On NIFTY only strikes that are multiples of 100 are used (24,500, 24,600 …).'] },
      { h: 'The ladder', p: ['The starting premium is the first rung. Each next rung is 50% higher: ₹20 → ₹30 → ₹45 → ₹67.5 → ₹101.25 … with no limit.', 'When either leg’s premium reaches the next rung, the market is moving towards it. The opposite (profitable) leg is bought back and a new OTM option is sold on that side at the strike whose premium is nearest the new rung. Both legs again carry similar premiums, so the position stays roughly balanced and collects more premium as the move extends. A gap through several rungs moves straight to the highest one reached.'] },
      { h: 'Safety rules', p: ['Every newly sold option must be OTM at that moment. If no eligible OTM strike near the required premium exists (typically after a large move, when the needed premium is above anything OTM offers), everything is squared off and the algo stops trading for the day. Whatever is still open at 15:25 is squared off regardless of profit or loss.'] },
      { h: 'Strategy 3: starting premium ₹50', p: ['Strategy 3 follows exactly the same rules but starts from ₹50 premiums, so its levels are ₹50 → ₹75 → ₹112.5 → ₹168.75 … The options sold are closer to the money: more premium and time decay are collected and each leg carries more gamma. A ₹50 option needs a bigger move to gain 50% than a ₹20 one, so it usually adjusts less often — but at the higher levels an OTM strike near the target is more often missing, so it stops for the day more often. Compare both presets over the same backtest period before choosing.'] },
      { h: 'What to watch', p: ['This is a short-volatility strategy: it earns time decay on quiet or range-bound days and loses on strong trends and sharp reversals, where each adjustment sells closer to the money. Check the multi-day backtest — win rate, worst day and maximum drawdown — and size lots by the worst day, not by margin. Charges matter: every adjustment is two orders.'], tool: { to: '/algo', label: 'Open Algo Strategies' } },
    ],
  },
  {
    slug: 'optimizer',
    title: 'Using the optimizer well',
    level: 'Advanced',
    summary: 'Turn a view into the best risk-reward trade.',
    body: [
      { p: ['Enter a target price, the date you expect it by and a stop-loss level where your view is wrong. The optimizer prices every 1–4 leg combination on the live chain at your target and at your stop, then ranks by reward : risk, profit at target or probability of profit.'] },
      { h: 'Tips', p: ['A realistic target matters more than anything — the highest reward : risk strategies (butterflies) need price to land near the target. Use “profit at target” for more forgiving structures and cap capital to stay within your margin.'], tool: { to: '/optimizer', label: 'Open the optimizer' } },
    ],
  },
  {
    slug: 'risk',
    title: 'Risk management for option traders',
    level: 'Advanced',
    summary: 'Position sizing, margin, gamma risk and expiry-day behaviour.',
    body: [
      { p: ['Size every trade by its maximum loss, not its margin. Prefer defined-risk structures when volatility is low (gap risk is underpriced). Short options near expiry carry large gamma — small moves cause big P&L swings.'] },
      { p: ['Set MTM targets and stop-losses on every virtual strategy and use alerts for levels that invalidate your view. Practise with paper trading and replay the sessions the app has recorded in Trade Recap before risking capital.'], tool: { to: '/recap', label: 'Practise with Trade Recap' } },
    ],
  },
];

export default function Learn() {
  const { slug } = useParams();
  const a = ARTICLES.find((x) => x.slug === slug);
  if (a) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Link to="/learn" className="text-sm text-accent">← All lessons</Link>
        <PageHeader title={a.title} subtitle={`${a.level} · ${a.summary}`} />
        <Card>
          <article className="space-y-4 text-sm leading-relaxed">
            {a.body.map((s, i) => (
              <section key={i}>
                {s.h && <h2 className="mb-1 text-base font-semibold">{s.h}</h2>}
                {s.p.map((t, j) => <p key={j} className="mb-2 text-ink/90">{t}</p>)}
                {s.tool && <Link to={s.tool.to} className="btn-ghost mt-1">{s.tool.label} →</Link>}
              </section>
            ))}
          </article>
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <PageHeader title="Options Classroom" subtitle="Short lessons that connect each concept to the tool that uses it" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ARTICLES.map((x) => (
          <Link key={x.slug} to={`/learn/${x.slug}`} className="card card-pad hover:border-accent/60">
            <div className="text-2xs uppercase tracking-wide text-accent">{x.level}</div>
            <div className="mt-1 font-semibold">{x.title}</div>
            <div className="mt-1 text-xs text-muted">{x.summary}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
