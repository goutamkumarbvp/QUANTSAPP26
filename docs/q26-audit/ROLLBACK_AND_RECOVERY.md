# Q26 Options — Rollback and Recovery

## 1. Code rollback

| Version | Where |
|---|---|
| Baseline before this audit | git commit `ea1be96`. Hashes of every tracked file: `docs/q26-audit/baseline-sha256-manifest.txt` |
| This release | branch `claude/quantsapp-trading-audit-noqax6`, the commit after `ea1be96` that adds `docs/q26-audit/` |

Roll back to the baseline:

```bash
git fetch origin claude/quantsapp-trading-audit-noqax6
git checkout ea1be96 -- .            # or: git revert <release commit>
npm ci && npm run build && npm run start:supervised
```

Check a checkout against the baseline manifest:

```bash
git ls-files -z | xargs -0 sha256sum | diff - docs/q26-audit/baseline-sha256-manifest.txt
```

**Data compatibility.** The release changes no stored format, so the baseline reads the same `DATA_DIR`. The
release only adds `DATA_DIR/ops/` (journal, audit reports, quarantine). The baseline ignores that folder, and
it can be deleted.

**Configuration compatibility.** The release ignores an `AUTH_SECRET` that is a placeholder or shorter than
16 characters (with a warning). Rolling back makes such a value active again, which is unsafe. Set a real
secret instead.

## 2. Data backup

Everything stateful is in `DATA_DIR` (default `apps/server/data`):

| Path | Content | Recoverable without a backup? |
|---|---|---|
| `db.json` | Users, paper orders and trades, strategies, alerts, watchlists, algo runs | **No** |
| `market/` | Recorded live sessions (minute bars, chain snapshots) | **No**: live minutes cannot be fetched afterwards |
| `eod/` | Official NSE/BSE end-of-day files | Yes: downloaded again by the EOD backfill / weekly audit |
| `refdata/` | Kotak instrument master cache | Yes: downloaded daily |
| `ops/` | Operations journal, audit reports, quarantine | Not needed |

Back up daily, outside market hours. Copying a running server's files is safe because writes are atomic
(temp file + rename):

```bash
tar -C "$DATA_DIR" -czf q26-data-$(date +%F).tgz db.json market .auth-secret ops/login-state.json
```

Keep several generations offsite. Test a restore at least monthly (§3.1 on a spare machine).

## 3. Recovery procedures

### 3.1 Restore from a backup

Stop the server (Ctrl+C, or `docker stop q26`). Restore `db.json` and `market/` into `DATA_DIR`, then start
again. The EOD files and instrument master come back on their own.

### 3.2 `db.json` unreadable at start

The server moves the file to `db.json.corrupt-<ms>` and starts with an empty database. It logs an ERROR, and
the weekly audit fails `LEDGER-1` until the copy is dealt with. To recover:

- Stop the server.
- Restore `db.json` from the latest backup. Or repair the JSON of the `.corrupt-` copy and rename it back.
- Start the server, then delete the `.corrupt-` file.

### 3.3 Corrupt or missing EOD files

The weekly audit (`DATA-1`, `DATA-2`) downloads missing files again, and moves unreadable ones to
`DATA_DIR/ops/quarantine/<run>/` before downloading them again. To do it by hand, delete the date's files under
`eod/` and restart: the backfill fetches them. Quarantine folders older than 30 days are removed automatically.

### 3.4 Kotak login paused / account locked

The login monitor pauses automatic logins after 5 refusals in a row.

- Check the NEO_* values in `.env`. Kotak needs the TOTP **setup key** (not a 6-digit code) and the current MPIN.
- Check that the host clock is correct.
- Restart, or press **Re-login now** once.
- If Kotak has locked the account, unlock it through Kotak (web/app or support) before trying again.

### 3.5 Server crashes or hangs

Run it with `npm run start:supervised` (or the Docker image), which restarts it after a crash or a hang. The
operations journal (`DATA_DIR/ops/journal/`) and the supervisor's lines in the terminal show what happened.
`OPS-3` in the weekly audit counts the restarts.

### 3.6 Feed stale / disconnected during market hours

The watchdog restarts the market-data socket (at most once per 5 min). If it stays `FEED STALE`:

- check the network allowlist (`*.kotaksecurities.com` over WSS);
- check the Kotak status page;
- press **Re-login now**.

Values shown while the feed is stale are the last ticks received. The dashboard says so; it never fills
values in.

## 4. What is never done automatically

- No order is placed, modified or cancelled with a broker (paper trading only).
- User orders, positions, strategies or settings are never edited or deleted by the watchdog or the audit.
- Configuration (`.env`) and code are never changed at run time.
- Missing live market minutes are never synthesised. They stay blank.
