// Launch Radar (radar-8) — board rendering. Data comes from data.js
// (window.RADAR_DATA), written by main.ts from the sealed snapshot.
(function () {
  var D = window.RADAR_DATA;
  if (!D) { document.getElementById('rows').innerHTML = '<tr><td>No data.</td></tr>'; return; }
  var meta = D.meta, rows = D.rows;
  var $ = function (id) { return document.getElementById(id); };

  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function moneyShort(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return money(n);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Header stats.
  var mix = meta.verdict_mix;
  $('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b><span>clean pre-token protocols</span></div>' +
    '<div class="stat"><b>' + meta.watchlist_covered + '/' + meta.watchlist_total + '</b><span>watchlist covered</span></div>' +
    '<div class="stat"><b>' + mix.FARM + ' FARM</b><span>' + mix.THIN + ' THIN · ' + mix.SKIP + ' SKIP</span></div>' +
    '<div class="stat"><b>' + moneyShort(rows[0].implied_value_usd) + '</b><span>top implied value</span></div>';

  // Method box: the model in one paragraph, then the blind-test table.
  $('method-text').innerHTML =
    'Implied value = TVL × <b>category multiple</b> × <b>size factor</b>. The category multiple is the median ' +
    'mcap/TVL of the ' + meta.fit_n + ' tokens that already trade in that category, winsorised at ' +
    meta.winsorise_cap_multiple + '× and shrunk toward the global median ' + meta.global_median_multiple +
    '× with K=6. The size factor is half the fitted log-size slope (' + meta.size_slope_kept +
    ' kept of ' + meta.size_slope_fitted + ' fitted), so the biggest protocols are not punished for their size. ' +
    'Seven-day growth and age were tested as value terms and kept out — they do not predict the traded multiples — ' +
    'so they move only the farm verdict, never the value. Every row carries a P10–P90 band and a rank range from ' +
    meta.bootstraps + ' bootstrap refits of the traded set.';
  $('blind-table').innerHTML =
    '<tr><th>Blind test (median |log error|)</th><th>Flat global median</th><th>This model</th></tr>' +
    '<tr><td>Leave-one-out, ' + meta.fit_n + ' traded tokens</td><td>' + meta.blind_loo_flat + '×</td><td><b>' + meta.blind_loo_model + '×</b></td></tr>' +
    '<tr><td>Walk-forward (train listed before 2025, test ' + meta.blind_wf_n_test + ')</td><td>' + meta.blind_wf_flat + '×</td><td><b>' + meta.blind_wf_model + '×</b></td></tr>';
  var ex = meta.excluded, exText = Object.keys(ex).map(function (k) { return ex[k] + ' ' + k; }).join(', ');
  $('audit-text').textContent =
    'Audit: ' + meta.audited_no_token + ' protocols record no token; ' + exText + ' were audited out, leaving ' +
    rows.length + ' clean rows. The watchlist is the floor, never the ceiling — rows below it are the early finds this radar exists for.';
  $('farm-text').textContent =
    'Each plan farms a $' + meta.ticket_usd.toLocaleString('en-US') + ' ticket over 90 days in ' + meta.farm_actions +
    ' on-chain actions, costed at the chain\'s gas price plus a $15 bridge when the chain is not Ethereum. ' +
    'Expected airdrop per farmer = implied value × ' + Math.round(meta.airdrop_pool_share * 100) + '% airdrop pool × launch odds ÷ farmers ' +
    '(TVL ÷ $5,000, capped 150–150,000). FARM when the expected value is at least ' + meta.farm_bar +
    '× the cost, THIN when it covers the cost, SKIP below it. Break-even odds are shown on every row.';
  $('foot').textContent = 'Snapshot as of ' + meta.as_of + ' · ' + meta.fit_n + ' traded tokens price the board · deterministic: re-running the program reproduces this board byte for byte.';

  // Filter options.
  var cats = [...new Set(rows.map(function (r) { return r.category || 'Uncategorised'; }))].sort();
  var chains = [...new Set(rows.flatMap(function (r) { return r.chains; }))].sort();
  cats.forEach(function (c) { var o = document.createElement('option'); o.textContent = c; $('f-cat').appendChild(o); });
  chains.forEach(function (c) { var o = document.createElement('option'); o.textContent = c; $('f-chain').appendChild(o); });

  var state = { q: '', cat: '', chain: '', verdict: '', watch: false, sort: 'value' };
  var selected = null;

  function filtered() {
    var list = rows.filter(function (r) {
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q) < 0) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.watch && !r.on_watchlist) return false;
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || -999) - (a.change_7d || -999);
      if (key === 'expected') return b.expected_usd - a.expected_usd;
      if (key === 'name') return a.name.localeCompare(b.name);
      return b.implied_value_usd - a.implied_value_usd;
    });
    return list;
  }

  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(function (r) {
      var g = r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (selected === r.slug ? 'sel' : '') + '">' +
        '<td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b>' + (r.on_watchlist ? ' <span class="watch">★ watchlist</span>' : '') + '<br><span style="color:var(--muted);font-size:12px">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td><td>' + esc(r.chains.slice(0, 2).join(', ')) + '</td>' +
        '<td class="num">' + moneyShort(r.tvl_usd) + '</td><td class="num">' + g + '</td>' +
        '<td class="num"><b>' + moneyShort(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + moneyShort(r.band_low_usd) + ' – ' + moneyShort(r.band_high_usd) + '</td>' +
        '<td class="num">' + r.rank_low + '–' + r.rank_high + '</td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '<td class="num">' + money(r.expected_usd) + '</td></tr>';
    }).join('');
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols shown.';
    document.querySelectorAll('#rows tr').forEach(function (tr) {
      tr.addEventListener('click', function () { select(tr.getAttribute('data-slug'), true); });
    });
  }

  function select(slug, push) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selected = slug;
    if (push) location.hash = '#/detail/' + slug;
    var g = r.change_7d === null ? 'not reported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '% over 7 days';
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + '</h2><div class="big">' + money(r.implied_value_usd) + '</div>' +
      '<p style="color:var(--muted);margin:4px 0">Rank #' + r.rank + ' (range ' + r.rank_low + '–' + r.rank_high + ' over ' + meta.bootstraps + ' refits) · ' +
      esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</p>' +
      '<h3>How the value is built</h3><dl>' +
      '<dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd>' +
      '<dt>Multiple applied</dt><dd>' + r.multiple + '× (' + r.comps_n + ' traded comp' + (r.comps_n === 1 ? '' : 's') + ' in category)</dd>' +
      '<dt>7-day growth</dt><dd>' + g + '</dd>' +
      '<dt>Age with no token</dt><dd>' + (r.age_days === null ? 'unknown' : r.age_days + ' days') + '</dd>' +
      '<dt>P10–P90 band</dt><dd>' + money(r.band_low_usd) + ' – ' + money(r.band_high_usd) + '</dd></dl>' +
      '<h3>Farm economics</h3><dl>' +
      '<dt>Verdict</dt><dd><span class="pill ' + r.verdict + '">' + r.verdict + '</span></dd>' +
      '<dt>Cost to farm (90 days)</dt><dd>' + money(r.cost_usd) + '</dd>' +
      '<dt>Expected per farmer</dt><dd>' + money(r.expected_usd) + '</dd>' +
      '<dt>Launch odds priced in</dt><dd>' + Math.round(r.launch_prob * 100) + '%</dd>' +
      '<dt>Break-even launch odds</dt><dd>' + Math.round(r.break_even_odds * 100) + '%</dd>' +
      '<dt>Farmers sharing the pool</dt><dd>about ' + r.farmers.toLocaleString('en-US') + '</dd></dl>' +
      '<h3>Farm plan — $' + meta.ticket_usd.toLocaleString('en-US') + ' ticket</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    render();
  }

  function route() {
    var h = location.hash || '';
    var m = h.match(/^#\/detail\/(.+)$/);
    if (m) { select(decodeURIComponent(m[1]), false); return; }
    var f = h.match(/^#\/filter\/verdict\/(FARM|THIN|SKIP)$/);
    if (f) { state.verdict = f[1]; $('f-verdict').value = f[1]; render(); select(rows[0].slug, false); return; }
    var c = h.match(/^#\/filter\/category\/(.+)$/);
    if (c) { state.cat = decodeURIComponent(c[1]); $('f-cat').value = state.cat; render(); select(rows[0].slug, false); return; }
    select(rows[0].slug, false);
  }

  $('q').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
  $('f-cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  $('f-chain').addEventListener('change', function (e) { state.chain = e.target.value; render(); });
  $('f-verdict').addEventListener('change', function (e) { state.verdict = e.target.value; render(); });
  $('f-watch').addEventListener('change', function (e) { state.watch = e.target.checked; render(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  document.querySelectorAll('#board th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var map = { rank: 'value', name: 'name', tvl: 'tvl', growth: 'growth', value: 'value', verdict: 'value', expected: 'expected' };
      state.sort = map[th.getAttribute('data-k')] || 'value';
      $('sort').value = state.sort; render();
    });
  });
  window.addEventListener('hashchange', route);
  route();
})();
