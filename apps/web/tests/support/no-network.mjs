// E2E only (LIVE-EMPTY mode): preloaded with `node --import` into the production server bundle so
// the run never reaches Kotak/NSE/BSE, whatever network the machine has. Every outbound fetch fails
// the way an unreachable exchange site does, and the app must show its blank states with reasons.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new TypeError(`fetch failed: network disabled for the e2e run (${new URL(url).host})`);
};
