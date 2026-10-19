/**
 * Trading safety boundary. Q26 is a paper-trading program: orders go to the in-memory PaperBroker
 * (services/trading.ts) and are filled against live quotes; nothing is ever sent to a broker. The
 * Kotak client (live/kotak/rest.ts) has market-data calls only. These values are constants, not
 * configuration: no environment variable, setting or request can turn them on. The weekly audit
 * checks them and the Kotak client's methods at run time.
 */
export const SAFETY = Object.freeze({
  mode: 'paper',
  /** Strategies/algos never route orders to a broker (they place paper orders only). */
  autoExecutionToBroker: false,
  /** No user or operator can be granted live-order authority in this program. */
  liveOrderAuthority: false,
  /** No code path submits, modifies or cancels a broker order. */
  brokerSubmission: false,
} as const);

/** Method names that would mean a broker order path exists on a client class. */
export const ORDER_METHOD_PATTERN = /order|place|modify|cancel|exit|square|basket|gtt|bracket|cover/i;
