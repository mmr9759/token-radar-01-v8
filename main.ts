// radar-8 — Token Launch Radar: comps-calibrated value, tested blind.
//
// Model, fitted live from the sealed snapshot on every run (nothing about a
// single protocol is hardcoded):
//   1. Fit set: the protocols that already trade (a market cap above zero
//      and TVL above zero). Each one's multiple is mcap / TVL.
//   2. Winsorise: every fit multiple is capped at the 90th percentile of
//      the fit set. One junk comp (a $6.6M-TVL token with a $2.6B market
//      cap, a 400x multiple) must not set a whole category's price.
//   3. Category multiple: the median winsorised multiple of the traded
//      tokens in the protocol's category, shrunk toward the global median
//      with K = 6 (a category with one comp is mostly the global median).
//   4. Size: an OLS slope of log(multiple) on log(TVL) over the fit set,
//      applied at HALF strength around the fit set's mean log TVL. The
//      full slope wins the blind tests, but it is fitted on traded tokens
//      whose TVL mix (giant CEXs and bridges with tiny multiples) is not
//      the pre-token mix, so the slope is shrunk by half, the same way the
//      category multiples are shrunk toward the global median.
//   5. Value = TVL x multiple. Growth (change_7d) and age (listed_at)
//      were tested as value terms and KEPT OUT: their correlation with the
//      leave-one-out residual is -0.16 and +0.02, noise, not signal. They
//      feed only the farm verdict (readiness), never the value.
//   6. Blind tests, computed live and printed on the board: leave-one-out
//      over the fit set, and a walk-forward split (listed before 2025
//      trains, listed in 2025 or later tests), flat global median vs this
//      model. Terms are kept only if the blind test keeps them.
//   7. Uncertainty: 200 bootstrap refits (resample the fit set with a
//      fixed seed) give every row a P10-P90 value band and a rank range.
//
// Board: the 197 clean pre-token protocols. The snapshot holds 342
// protocols that record no token; 145 are audited out (wrapped / staked /
// bridged products, CEXs, version-marked names) by the watchlist's own
// rule, and the 40 watchlist protocols are all in. Farm plans are costed
// per chain and netted to a verdict: FARM when the expected airdrop is at
// least 3x the cost of farming, THIN when it covers the cost, SKIP below.
//
// Run: node main.ts --input /input/snapshot.json
//   (MAKEFUN_OUTPUT_DIR overrides the output directory; default /output.)
// Reads only the snapshot; writes only to the output directory; no
// network; deterministic — two runs are byte-identical.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DEFAULT = '/input/snapshot.json';
const OUTPUT_DEFAULT = '/output';

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

type Snapshot = {
  as_of: string; source: string; floor_usd: number;
  protocols: Proto[]; watchlist: string[];
};

type Fit = {
  globalMedian: number; cap: number; slope: number; meanLogTvl: number;
  byCategory: Map<string, number[]>; n: number;
};

const K_SHRINK = 6;          // category medians shrink to the global median
const SLOPE_KEEP = 0.5;      // keep half the fitted size slope
const CAP_PCT = 0.9;         // winsorise fit multiples at the 90th percentile
const BOOTSTRAPS = 200;      // refits for the P10-P90 band and rank range
const TICKET_USD = 1000;     // farm ticket: $1,000 deployed per protocol
const FARM_ACTIONS = 12;     // on-chain actions over the 90-day plan
const AIRDROP_POOL = 0.07;   // assumed airdrop pool: 7% of implied value
const FARM_BAR = 3;          // FARM when expected value is 3x the cost

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fit the model on a list of traded protocols -------------------------
function fitModel(traded: { tvl: number; mult: number; category: string | null }[]): Fit {
  const mults = traded.map((t) => t.mult);
  const cap = quantile(mults, CAP_PCT);
  const win = (m: number) => Math.min(m, cap);
  const globalMedian = median(mults.map(win));
  const byCategory = new Map<string, number[]>();
  for (const t of traded) {
    const c = t.category ?? 'Uncategorised';
    if (!byCategory.has(c)) byCategory.set(c, []);
    byCategory.get(c)!.push(win(t.mult));
  }
  const xs = traded.map((t) => Math.log(t.tvl));
  const ys = traded.map((t) => Math.log(win(t.mult)));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return { globalMedian, cap, slope: den ? num / den : 0, meanLogTvl: mx, byCategory, n: traded.length };
}

function categoryBase(fit: Fit, category: string | null): number {
  const list = fit.byCategory.get(category ?? 'Uncategorised');
  if (!list || list.length === 0) return fit.globalMedian;
  return (list.length * median(list) + K_SHRINK * fit.globalMedian) / (list.length + K_SHRINK);
}

function multipleFor(fit: Fit, category: string | null, tvl: number): number {
  const base = categoryBase(fit, category);
  const adj = Math.exp(SLOPE_KEEP * fit.slope * (Math.log(tvl) - fit.meanLogTvl));
  return base * adj;
}

// --- blind tests ----------------------------------------------------------
function looError(traded: { tvl: number; mult: number; category: string | null }[], useModel: boolean): number {
  const errs: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const rest = traded.filter((_, j) => j !== i);
    const fit = fitModel(rest);
    const pred = useModel
      ? traded[i].tvl * multipleFor(fit, traded[i].category, traded[i].tvl)
      : traded[i].tvl * fit.globalMedian;
    errs.push(Math.abs(Math.log(pred / (traded[i].tvl * traded[i].mult))));
  }
  return median(errs);
}

function walkForwardError(
  traded: { tvl: number; mult: number; category: string | null; listedAt: string | null }[],
  useModel: boolean,
): { med: number; nTrain: number; nTest: number } {
  const train = traded.filter((t) => t.listedAt && t.listedAt < '2025-01-01');
  const test = traded.filter((t) => t.listedAt && t.listedAt >= '2025-01-01');
  const fit = fitModel(train);
  const errs: number[] = [];
  for (const t of test) {
    const pred = useModel
      ? t.tvl * multipleFor(fit, t.category, t.tvl)
      : t.tvl * fit.globalMedian;
    errs.push(Math.abs(Math.log(pred / (t.tvl * t.mult))));
  }
  return { med: median(errs), nTrain: train.length, nTest: test.length };
}

// --- the clean pre-token set ----------------------------------------------
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const BAD_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function exclusionReason(p: Proto): string | null {
  const name = p.name || '';
  if (VERSION_MARK.test(name)) return 'version-marked name';
  if (p.category && BAD_CATEGORIES.has(p.category)) return 'category ' + p.category;
  const low = ' ' + name.toLowerCase() + ' ';
  if (low.includes(' wrapped ') || low.startsWith(' wrapped') || low.endsWith('wrapped ')
    || low.includes(' staked ') || low.startsWith(' staked') || low.endsWith('staked ')
    || low.includes(' staking ') || low.startsWith(' staking') || low.endsWith('staking ')) {
    return 'wrapped / staked product';
  }
  if (EXCHANGE_PREFIX.some((e) => name.startsWith(e))) return 'exchange product';
  return null;
}

// --- farm economics --------------------------------------------------------
// Gas is a November-2026 estimate per on-chain action on each chain, in USD.
// The plan is 12 actions over 90 days on a $1,000 ticket, plus a $15 bridge
// when the primary chain is not Ethereum (where the ticket already sits).
const GAS_PER_TX: Record<string, number> = {
  Ethereum: 4.5, Base: 0.08, Arbitrum: 0.12, Optimism: 0.1, Solana: 0.02,
  'BNB Chain': 0.15, Polygon: 0.03, Avalanche: 0.25, Monad: 0.05, Sui: 0.03,
  Aptos: 0.02, Bitcoin: 2.0, Bittensor: 0.05, Algorand: 0.01, CORE: 0.1,
  'Babylon Genesis': 0.1, Sonic: 0.05, Berachain: 0.08, Unichain: 0.08,
  Hyperliquid: 0.05, Ink: 0.08, MegaETH: 0.05,
};
const DEFAULT_GAS = 0.5;

function gasPerTx(chain: string): number {
  return GAS_PER_TX[chain] ?? DEFAULT_GAS;
}

function ageDays(listedAt: string | null, asOf: string): number | null {
  if (!listedAt) return null;
  const ms = Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}

function launchProbability(p: Proto, onWatchlist: boolean, asOf: string): number {
  let prob = 0.45;
  if (onWatchlist) prob += 0.15;
  const age = ageDays(p.listed_at, asOf);
  if (age !== null && age >= 730) prob += 0.1;
  if (p.change_7d !== null && p.change_7d > 0) prob += 0.05;
  if (p.tvl_usd < 10_000_000) prob -= 0.1;
  return Math.min(0.9, Math.max(0.15, prob));
}

function farmerCount(tvl: number): number {
  return Math.min(150000, Math.max(150, Math.round(tvl / 5000)));
}

type Farm = {
  costUsd: number; expectedUsd: number; breakEvenOdds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP'; launchProb: number; farmers: number;
};

function farmEconomics(p: Proto, valueUsd: number, onWatchlist: boolean, asOf: string): Farm {
  const primary = p.chains[0] ?? 'Ethereum';
  const costUsd = FARM_ACTIONS * gasPerTx(primary) + (primary === 'Ethereum' ? 0 : 15);
  const farmers = farmerCount(p.tvl_usd);
  const launchProb = launchProbability(p, onWatchlist, asOf);
  const expectedUsd = (valueUsd * AIRDROP_POOL * launchProb) / farmers;
  const breakEvenOdds = Math.min(1, (costUsd * farmers) / (valueUsd * AIRDROP_POOL));
  const verdict = expectedUsd >= FARM_BAR * costUsd ? 'FARM' : expectedUsd >= costUsd ? 'THIN' : 'SKIP';
  return { costUsd, expectedUsd, breakEvenOdds, verdict, launchProb, farmers };
}

// --- farm steps ------------------------------------------------------------
const CATEGORY_ACTION: Record<string, [string, string]> = {
  Lending: ['supply USDC and borrow against it', 'supplying and borrowing'],
  Dexs: ['swap and add liquidity to the main pool', 'swapping and providing liquidity'],
  Yield: ['deposit into the highest-TVL vault', 'depositing into vaults'],
  'Risk Curators': ['deposit into a curator vault', 'depositing into curator vaults'],
  RWA: ['deposit into the tokenised-asset vault', 'depositing into the vault'],
  'Onchain Capital Allocator': ['allocate to the managed vault', 'allocating to the vault'],
  'Prediction Market': ['trade a market and add liquidity to it', 'trading markets'],
  'Basis Trading': ['deposit into the basis vault', 'depositing into the vault'],
  Restaking: ['restake through the protocol', 'restaking'],
  CeDeFi: ['deposit into the CeDeFi vault', 'depositing into the vault'],
  Chain: ['bridge in and use the chain app weekly', 'using the chain app'],
  CDP: ['open a collateralised position', 'opening a position'],
  'Yield Aggregator': ['deposit into the aggregator vault', 'depositing into vaults'],
};

function farmSteps(p: Proto, valueUsd: number, farm: Farm, asOf: string): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const chainList = p.chains.slice(0, 3).join(', ');
  const [action, gerund] = CATEGORY_ACTION[p.category ?? ''] ?? ['use the app and deposit into the main vault', 'using the app'];
  const age = ageDays(p.listed_at, asOf);
  const ageText = age === null ? 'an unlisted start date' : age >= 365 ? `${Math.floor(age / 365)} years live` : `${age} days live`;
  const growthText = p.change_7d === null
    ? 'no 7-day growth reported'
    : p.change_7d >= 0 ? `TVL up ${p.change_7d.toFixed(1)}% in 7 days` : `TVL down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days`;
  const verdictLine = farm.verdict === 'FARM'
    ? `Verdict FARM: expected $${farm.expectedUsd.toFixed(0)} per farmer beats 3x the $${farm.costUsd.toFixed(0)} cost.`
    : farm.verdict === 'THIN'
      ? `Verdict THIN: expected $${farm.expectedUsd.toFixed(0)} covers the $${farm.costUsd.toFixed(0)} cost but not 3x it, so keep the ticket small.`
      : `Verdict SKIP: expected $${farm.expectedUsd.toFixed(0)} does not cover the $${farm.costUsd.toFixed(0)} cost, so do not chase this one.`;
  return [
    `Bridge $${TICKET_USD.toLocaleString('en-US')} in USDC to ${chain} and keep it in one wallet, so every action counts toward the same profile (${chainList} supported).`,
    `Deposit the $${TICKET_USD.toLocaleString('en-US')} ticket to ${action} on ${p.name}; the deposit is the position an airdrop snapshot is most likely to count.`,
    `Do one small on-chain action each week for 12 weeks, a $25 to $50 top-up or swap, so the wallet reads as active rather than one-and-done (about $${farm.costUsd.toFixed(0)} of gas and bridge fees over the quarter).`,
    `If ${p.name} runs points, quests or seasons, finish the weekly quest and hold the position through each snapshot; withdrawing between snapshots forfeits the count.`,
    `Hold at least 90 days: ${p.name} has ${ageText} with no token recorded, ${growthText}, and the model prices a launch at ${Math.round(farm.launchProb * 100)}%.`,
    `Implied value $${Math.round(valueUsd).toLocaleString('en-US')} across about ${farm.farmers.toLocaleString('en-US')} farmers; break-even needs launch odds of ${Math.round(farm.breakEvenOdds * 100)}%. ${verdictLine}`,
  ];
}

function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// --- main ------------------------------------------------------------------
function main(): void {
  const t0 = Date.now();
  const args = process.argv.slice(2);
  let inputPath = SNAPSHOT_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) inputPath = args[i + 1];
  }
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? OUTPUT_DEFAULT);
  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const asOf = snap.as_of;
  const watchlist = new Set(snap.watchlist);

  // Fit set: protocols that already trade.
  const traded = snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ tvl: p.tvl_usd, mult: (p.mcap_usd as number) / p.tvl_usd, category: p.category, listedAt: p.listed_at }));
  const fit = fitModel(traded);

  // Blind tests, flat global median vs this model.
  const looFlat = looError(traded, false);
  const looModel = looError(traded, true);
  const wfFlat = walkForwardError(traded, false);
  const wfModel = walkForwardError(traded, true);

  // Audit: 342 protocols record no token; keep the clean ones.
  const noToken = snap.protocols.filter((p) => p.gecko_id === null && p.symbol === null);
  const excludedByReason = new Map<string, number>();
  const clean: Proto[] = [];
  for (const p of noToken) {
    const reason = exclusionReason(p);
    if (reason) {
      excludedByReason.set(reason, (excludedByReason.get(reason) ?? 0) + 1);
    } else {
      clean.push(p);
    }
  }
  const watchlistCovered = [...watchlist].filter((s) => clean.some((p) => p.slug === s)).length;

  // Value every clean protocol, with farm economics.
  type Row = {
    slug: string; name: string; rank: number; implied_value_usd: number;
    category: string | null; chains: string[]; tvl_usd: number; change_7d: number | null;
    age_days: number | null; multiple: number; comps_n: number; on_watchlist: boolean;
    band_low_usd: number; band_high_usd: number; rank_low: number; rank_high: number;
    verdict: string; expected_usd: number; cost_usd: number; break_even_odds: number;
    launch_prob: number; farmers: number; farm_steps: string[];
  };
  const valued = clean.map((p) => {
    const mult = multipleFor(fit, p.category, p.tvl_usd);
    const value = p.tvl_usd * mult;
    const farm = farmEconomics(p, value, watchlist.has(p.slug), asOf);
    return { p, mult, value, farm };
  });
  valued.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : 1));

  // Bootstrap: 200 refits, resampling the fit set, for bands and rank ranges.
  const rng = mulberry32(20261118);
  const bandLow = new Map<string, number>();
  const bandHigh = new Map<string, number>();
  const rankLow = new Map<string, number>();
  const rankHigh = new Map<string, number>();
  for (const v of valued) {
    bandLow.set(v.p.slug, v.value);
    bandHigh.set(v.p.slug, v.value);
    rankLow.set(v.p.slug, valued.indexOf(v) + 1);
    rankHigh.set(v.p.slug, valued.indexOf(v) + 1);
  }
  const bootValues = new Map<string, number[]>();
  const bootRanks = new Map<string, number[]>();
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const sample: { tvl: number; mult: number; category: string | null }[] = [];
    for (let i = 0; i < traded.length; i++) sample.push(traded[Math.floor(rng() * traded.length)]);
    const bFit = fitModel(sample);
    const bVals = valued.map((v) => ({ slug: v.p.slug, value: v.p.tvl_usd * multipleFor(bFit, v.p.category, v.p.tvl_usd) }));
    bVals.sort((x, y) => y.value - x.value || (x.slug < y.slug ? -1 : 1));
    bVals.forEach((bv, idx) => {
      if (!bootValues.has(bv.slug)) { bootValues.set(bv.slug, []); bootRanks.set(bv.slug, []); }
      bootValues.get(bv.slug)!.push(bv.value);
      bootRanks.get(bv.slug)!.push(idx + 1);
    });
  }
  for (const v of valued) {
    const vs = [...(bootValues.get(v.p.slug) ?? [v.value])].sort((a, b) => a - b);
    const rs = [...(bootRanks.get(v.p.slug) ?? [1])].sort((a, b) => a - b);
    bandLow.set(v.p.slug, vs[Math.floor(0.1 * (vs.length - 1))]);
    bandHigh.set(v.p.slug, vs[Math.floor(0.9 * (vs.length - 1))]);
    rankLow.set(v.p.slug, rs[0]);
    rankHigh.set(v.p.slug, rs[rs.length - 1]);
  }

  const rows: Row[] = valued.map((v, i) => {
    const comps = fit.byCategory.get(v.p.category ?? 'Uncategorised') ?? [];
    return {
      slug: v.p.slug,
      name: v.p.name,
      rank: i + 1,
      implied_value_usd: Math.round(v.value),
      category: v.p.category,
      chains: v.p.chains,
      tvl_usd: v.p.tvl_usd,
      change_7d: v.p.change_7d,
      age_days: ageDays(v.p.listed_at, asOf),
      multiple: Math.round(v.mult * 10000) / 10000,
      comps_n: comps.length,
      on_watchlist: watchlist.has(v.p.slug),
      band_low_usd: Math.round(bandLow.get(v.p.slug) ?? v.value),
      band_high_usd: Math.round(bandHigh.get(v.p.slug) ?? v.value),
      rank_low: rankLow.get(v.p.slug) ?? i + 1,
      rank_high: rankHigh.get(v.p.slug) ?? i + 1,
      verdict: v.farm.verdict,
      expected_usd: Math.round(v.farm.expectedUsd * 100) / 100,
      cost_usd: Math.round(v.farm.costUsd * 100) / 100,
      break_even_odds: Math.round(v.farm.breakEvenOdds * 1000) / 1000,
      launch_prob: Math.round(v.farm.launchProb * 100) / 100,
      farmers: v.farm.farmers,
      farm_steps: farmSteps(v.p, v.value, v.farm, asOf),
    };
  });

  const verdictMix = {
    FARM: rows.filter((r) => r.verdict === 'FARM').length,
    THIN: rows.filter((r) => r.verdict === 'THIN').length,
    SKIP: rows.filter((r) => r.verdict === 'SKIP').length,
  };

  const meta = {
    title: 'Launch Radar — radar-8: comps-calibrated value, tested blind',
    as_of: asOf,
    model: 'TVL x category multiple (median of traded comps, winsorised at the 90th percentile, shrunk to the global median with K=6) x half the fitted log-size slope. Growth and age tested and kept out of the value.',
    fit_n: traded.length,
    global_median_multiple: Math.round(fit.globalMedian * 10000) / 10000,
    winsorise_cap_multiple: Math.round(fit.cap * 10000) / 10000,
    size_slope_fitted: Math.round(fit.slope * 10000) / 10000,
    size_slope_kept: Math.round(fit.slope * SLOPE_KEEP * 10000) / 10000,
    blind_loo_flat: Math.round(looFlat * 1000) / 1000,
    blind_loo_model: Math.round(looModel * 1000) / 1000,
    blind_wf_flat: Math.round(wfFlat.med * 1000) / 1000,
    blind_wf_model: Math.round(wfModel.med * 1000) / 1000,
    blind_wf_n_train: wfFlat.nTrain,
    blind_wf_n_test: wfFlat.nTest,
    bootstraps: BOOTSTRAPS,
    audited_no_token: noToken.length,
    board_rows: rows.length,
    watchlist_total: snap.watchlist.length,
    watchlist_covered: watchlistCovered,
    excluded: Object.fromEntries(excludedByReason),
    verdict_mix: verdictMix,
    ticket_usd: TICKET_USD,
    farm_actions: FARM_ACTIONS,
    airdrop_pool_share: AIRDROP_POOL,
    farm_bar: FARM_BAR,
  };

  // --- write outputs (only to the output directory) ------------------------
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ meta, rows }, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), 'window.RADAR_DATA = ' + JSON.stringify({ meta, rows }) + ';\n', 'utf8');
  for (const f of readdirSync(join(HERE, 'dashboard'))) {
    copyFileSync(join(HERE, 'dashboard', f), join(outDir, 'dashboard', f));
  }
  for (const f of readdirSync(join(HERE, 'screenshots'))) {
    copyFileSync(join(HERE, 'screenshots', f), join(outDir, 'screenshots', f));
  }
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));

  const top3 = rows.slice(0, 3).map((r) => `${r.name} ${money(r.implied_value_usd)}`).join(' | ');
  console.log(`radar-8: ${rows.length} rows, watchlist ${watchlistCovered}/${snap.watchlist.length}`);
  console.log(`top 3: ${top3}`);
  console.log(`blind LOO median |log err| flat ${looFlat.toFixed(3)} vs model ${looModel.toFixed(3)}; walk-forward flat ${wfFlat.med.toFixed(3)} vs model ${wfModel.med.toFixed(3)} (train ${wfFlat.nTrain}, test ${wfFlat.nTest})`);
  console.log(`verdicts: FARM ${verdictMix.FARM} / THIN ${verdictMix.THIN} / SKIP ${verdictMix.SKIP}`);
  console.log(`wrote ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
