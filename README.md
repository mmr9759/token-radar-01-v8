# Launch Radar — radar-8

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mmr9759/token-radar-01-v8/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mmr9759/token-radar-01-v8/reward.svg)](https://make.fun/c/token-radar-01)

Token launch radar for the [token-radar-01 bounty on make.fun](https://make.fun/c/token-radar-01): which pre-token protocol is worth farming next, and what do I do about it.

## Model (fitted live from the sealed snapshot on every run)

Implied value = TVL × category multiple × size factor.

- **Category multiple**: median mcap/TVL of the 128 tokens that already trade in the protocol's category, winsorised at the 90th percentile and shrunk toward the global median (0.2138×) with K=6. One junk comp — a $6.6M-TVL token with a $2.6B market cap, a 400× multiple — must not set a whole category's price.
- **Size factor**: half the fitted log-size slope, so the biggest protocols are not punished for their size.
- **Kept out of the value**: 7-day growth and age. Tested against the leave-one-out residual they correlate at −0.16 and +0.02 — noise, not signal. They move only the farm verdict, never the value.

## Blind tests (computed live, printed on the board)

| Test (median \|log error\|) | Flat global median | This model |
|---|---|---|
| Leave-one-out, 128 traded tokens | 1.62× | 1.44× |
| Walk-forward (train listed before 2025, test 31) | 1.60× | 1.26× |

Terms are kept only if the blind test keeps them.

## Board

197 clean pre-token protocols: 342 record no token in the snapshot, 145 audited out (wrapped / staked / bridged products, CEXs, version-marked names) by the watchlist's own rule. All 40 watchlist protocols are covered. Every row carries a P10–P90 value band and a rank range from 200 bootstrap refits, plus a costed farm plan netted to FARM / THIN / SKIP on a $1,000 ticket over 90 days.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only, no network, deterministic — two runs are byte-identical. `main.ts` reads the snapshot, writes `board.json`, `data.js` and `dossier.json` to the output directory, and copies `dashboard/` and `screenshots/` there.
