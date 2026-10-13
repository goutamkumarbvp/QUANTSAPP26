/**
 * TEST-ONLY: an in-memory SFeed socket (the server side is driven by the test) and its factory.
 */
import type { SFeedSocket, SFeedSocketEvents, SFeedSocketFactory } from '../../src/live/kotak/sfeed/client';

export class FakeSocket implements SFeedSocket {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly on: SFeedSocketEvents,
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.on.close(code ?? 1005, reason ?? '');
  }
  terminate(): void {
    this.closed = true;
  }
  /* server side */
  open(): void {
    this.on.open();
  }
  text(o: unknown): void {
    this.on.message(typeof o === 'string' ? o : JSON.stringify(o), false);
  }
  bin(b: Uint8Array): void {
    this.on.message(b, true);
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** Net subscriptions per event family after every (un)subscribe frame sent so far, as 'seg|token'. */
  subscribed(): Record<'index' | 'scrips' | 'lite' | 'depth', Set<string>> {
    const out = { index: new Set<string>(), scrips: new Set<string>(), lite: new Set<string>(), depth: new Set<string>() };
    const fam: Record<string, keyof typeof out> = { Indices: 'index', Scrips: 'scrips', ScripsLite: 'lite', Depth: 'depth' };
    for (const f of this.frames()) {
      const ev = typeof f.event === 'string' ? f.event : '';
      const m = /^(subscribe|unsubscribe)(Indices|ScripsLite|Scrips|Depth)$/.exec(ev);
      if (!m || typeof f.inputtoken !== 'string') continue;
      const set = out[fam[m[2]]];
      for (const t of f.inputtoken.split(',')) {
        if (m[1] === 'subscribe') set.add(t);
        else set.delete(t);
      }
    }
    return out;
  }
}

export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: SFeedSocketFactory = (url, on) => {
    const s = new FakeSocket(url, on);
    sockets.push(s);
    return s;
  };
  return { sockets, factory, last: (): FakeSocket => sockets[sockets.length - 1] };
}
