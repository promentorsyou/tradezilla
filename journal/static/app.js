/* Trading journal front-end: routing, rendering, and view state. */
(function () {
  'use strict';

  const { areaChart, barChart, donut, radar, heatmap, money, esc } = window.Charts;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  let DATA = null;
  const state = {
    view: 'dashboard',
    tradeSort: { key: 'open_time', dir: -1 },
    tradeFilter: { text: '', status: 'all', result: 'all' },
    calMonth: null,
    symbolTab: 'pnl',
  };

  const num = (v, dp) => (Number(v) || 0).toLocaleString('en-US',
    { minimumFractionDigits: dp === undefined ? 2 : dp,
      maximumFractionDigits: dp === undefined ? 2 : dp });
  const pct = (v, dp) => (Number(v) || 0).toFixed(dp === undefined ? 1 : dp) + '%';
  const cls = (v) => (Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : 'muted');
  const sign = (v) => (Number(v) > 0 ? '+' : '');
  /* Signed dollars. sign() alone returns '' for a negative, so pairing it with
     Math.abs() silently printed a loss as a gain. Always build both here. */
  const usd = (v) => (Number(v) < 0 ? '-' : '+') + '$' + num(Math.abs(Number(v) || 0));

  function fmtQty(v) {
    const n = Number(v) || 0;
    if (n === 0) return '0';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(8);
  }
  function fmtPrice(v) {
    const n = Number(v) || 0;
    if (n === 0) return '—';
    if (n >= 1000) return '$' + n.toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return '$' + n.toFixed(4);
    return '$' + n.toFixed(6);
  }
  function fmtDur(sec) {
    const s = Number(sec) || 0;
    if (!s) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
      m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }
  // The report is bucketed in one timezone, published in DATA.timezone.
  // Older reports predate the field, so fall back to what they used: UTC.
  const tzName = () => (DATA && DATA.timezone) || 'UTC';
  const tzLabel = () => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tzName(), timeZoneName: 'short',
      }).formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName').value;
    } catch (e) { return 'UTC'; }
  };
  // A UTC timestamp's calendar date on the journal's clock, as YYYY-MM-DD.
  // Trades are grouped into days server-side the same way (engine.local_date),
  // so this has to agree with that or a trade filed under one day in
  // DATA.days shows up, or fails to show up, in a different day's card here.
  const localDate = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tzName() })
        .format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 10); }
  };
  // A UTC timestamp's clock time on the journal's clock, as "3:41 PM" -
  // matches the zone every date on this page is already bucketed in, so a
  // sale showing under "Thu Sep 3" also reads as a Thursday-afternoon time,
  // not whatever offset the viewer's own device happens to be in.
  const localTime = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tzName(), hour: 'numeric', minute: '2-digit',
      }).format(new Date(iso));
    } catch (e) { return ''; }
  };
  // Today's date on the journal's clock, as YYYY-MM-DD.
  const localToday = () => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tzName() })
        .format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  };

  /* ---------------- shell ---------------- */
  const TITLES = {
    dashboard: ['Dashboard', 'Live from your Coinbase account'],
    days: ['Day View', 'Every trading day, newest first'],
    trades: ['Trade View', 'All round-trip trades, HIFO matched'],
    positions: ['Positions', 'What you are holding right now'],
    reports: ['Reports', 'Performance analytics and reconciliation'],
    calendar: ['Calendar', 'Monthly P&L calendar'],
    live: ['Running Trades', 'Every position open right now, live'],
  };

  function route() {
    const v = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
    state.view = TITLES[v] ? v : 'dashboard';
    $$('.nav-item').forEach((a) =>
      a.classList.toggle('active', a.dataset.view === state.view));
    const [t, s] = TITLES[state.view];
    $('#view-title').textContent = t;
    $('#view-sub').textContent = s;
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (!DATA) return;
    const el = $('#views');
    el.hidden = false;
    try {
      el.innerHTML = ({
        dashboard: viewDashboard, days: viewDays, trades: viewTrades,
        positions: viewPositions, reports: viewReports, calendar: viewCalendar,
        live: viewLive,
      })[state.view]();
      wire();
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="error-box">Render error: ${esc(err.message)}</div>`;
    }
  }


  /* ---------------- running trades ---------------- */

  /* Price ladder for the live chart: a candlestick body per bar, with the
     entry, breakeven, take-profit and stop drawn straight across so you can
     see at a glance which side of each line the market is on. */
  function tradeChart(t) {
    const c = t.candles || [];
    if (c.length < 2) return '<div class="lt-nochart">no candle data</div>';
    const W = 760, H = 264, PL = 6, PR = 74, PT = 12, PB = 18;
    const lines = [
      { v: t.entry_price, k: 'entry', label: 'Entry' },
      { v: t.breakeven_maker, k: 'be', label: 'B/E' },
      { v: t.take_profit, k: 'tp', label: 'TP' },
      { v: t.stop_loss, k: 'sl', label: 'SL' },
    ].filter((l) => l.v > 0);
    let lo = Math.min(...c.map((b) => b.l), ...lines.map((l) => l.v));
    let hi = Math.max(...c.map((b) => b.h), ...lines.map((l) => l.v));
    const pad = (hi - lo) * 0.06 || hi * 0.001;
    lo -= pad; hi += pad;
    const y = (v) => PT + (hi - v) / (hi - lo) * (H - PT - PB);
    const bw = (W - PL - PR) / c.length;
    const x = (i) => PL + i * bw + bw / 2;

    const bars = c.map((b, i) => {
      const up = b.c >= b.o;
      const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
      const w = Math.max(bw * 0.62, 1.2);
      return `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}"
                y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}"
                class="wick ${up ? 'up' : 'dn'}"/>
              <rect x="${(x(i) - w / 2).toFixed(1)}" y="${top.toFixed(1)}"
                width="${w.toFixed(1)}" height="${Math.max(bot - top, 1).toFixed(1)}"
                class="body ${up ? 'up' : 'dn'}"/>`;
    }).join('');

    // Entry, breakeven and the live price often sit within a few dollars of
    // each other, which stacks their labels into an unreadable smear. Lay the
    // tags out top-down and push each one clear of the one above it.
    const last = c[c.length - 1].c, ly = y(last);
    const tags = lines.concat([{ v: last, k: 'now', label: '' }])
      .map((l) => ({ v: l.v, k: l.k, label: l.label, y: y(l.v) }))
      .filter((l) => l.y >= PT - 4 && l.y <= H - PB + 4)
      .sort((a, b) => a.y - b.y);
    let prev = -1e9;
    tags.forEach((l) => { l.ty = Math.max(l.y, prev + 11); prev = l.ty; });

    const rules = tags.filter((l) => l.k !== 'now').map((l) =>
      `<line x1="${PL}" x2="${W - PR}" y1="${l.y.toFixed(1)}" y2="${l.y.toFixed(1)}"
         class="rule ${l.k}"/>
       <text x="${W - PR + 6}" y="${(l.ty + 3.5).toFixed(1)}"
         class="rule-tag ${l.k}">${l.label} ${fmtPrice(l.v)}</text>`).join('');
    const nowTag = tags.find((l) => l.k === 'now');
    return `<svg class="lt-chart" viewBox="0 0 ${W} ${H}"
              preserveAspectRatio="none" role="img"
              aria-label="${esc(t.symbol)} price with entry, breakeven and target">
        ${bars}${rules}
        <line x1="${PL}" x2="${W - PR}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"
          class="rule now"/>
        <text x="${W - PR + 6}"
          y="${((nowTag ? nowTag.ty : ly) + 3.5).toFixed(1)}"
          class="rule-tag now">${fmtPrice(last)}</text>
      </svg>
      <div class="lt-chart-foot">${c.length} × 15-minute bars · last
        ${new Date(c[c.length - 1].t * 1000).toLocaleString()}</div>`;
  }

  /* Where price sits between the stop and the target. When there is no stop,
     the bar runs from entry instead, because that is the only floor there is. */
  function progressBar(t) {
    const lo = t.stop_loss || Math.min(t.entry_price, t.price);
    const hi = t.take_profit || Math.max(t.entry_price, t.price);
    if (!(hi > lo)) return '';
    const at = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    return `<div class="lt-track">
        <div class="lt-track-fill" style="width:${at(t.price).toFixed(2)}%"></div>
        <div class="lt-mark be" style="left:${at(t.breakeven_maker).toFixed(2)}%"
          title="Breakeven ${fmtPrice(t.breakeven_maker)}"></div>
        <div class="lt-mark now" style="left:${at(t.price).toFixed(2)}%"
          title="Now ${fmtPrice(t.price)}"></div>
      </div>
      <div class="lt-track-ends">
        <span class="${t.stop_loss ? 'neg' : 'muted'}">
          ${t.stop_loss ? 'Stop ' + fmtPrice(t.stop_loss) : 'no stop set'}</span>
        <span class="muted">B/E ${fmtPrice(t.breakeven_maker)}</span>
        <span class="pos">${t.take_profit ? 'Target ' + fmtPrice(t.take_profit)
          : 'no target'}</span>
      </div>`;
  }

  /* Round to a step a human would pick: 1, 2, 2.5 or 5 times a power of ten.
     A raw price/16 gives steps like $59.54, which makes a table nobody can
     read down quickly. */
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const pick = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return pick * mag;
  }

  /* The exit table: what you take home at each price step, centred on
     breakeven so the line between losing and winning is in the middle of the
     table rather than off one end. */
  function exitTable(t) {
    const be = t.breakeven_maker;
    if (!(be > 0 && t.qty > 0)) return '';
    const keep = 1 - (t.rebate_rate || 0.25), mk = t.maker_rate || 0.0005,
      tk = t.taker_rate || 0.001;
    const at = (p) => p * t.qty * (1 - mk * keep) - t.basis;
    // A take-profit rests above the market and fills as maker; a stop
    // crosses the book when it triggers and pays taker (same split the
    // server uses for tp_pnl/sl_pnl) - pricing an SL row at the maker rate
    // would understate the loss.
    const atTaker = (p) => p * t.qty * (1 - tk * keep) - t.basis;

    // 17 rows spanning roughly +/-0.55% of price - the band a trade this size
    // actually travels in, not a textbook range.
    const HALF = 8;
    const step = niceStep(be * 0.012 / (HALF * 2));
    const rows = [];
    for (let i = -HALF; i <= HALF; i++) {
      rows.push({ p: be + step * i, be: i === 0 });
    }
    // The live price and the resting target are the two prices actually being
    // decided between, so they go in at their real values. Labelling a nearby
    // grid row instead would print the wrong P&L against the right name - a
    // row reading "target" at $79,467.99 is not the $79,480 order you placed.
    const add = (v, key) => {
      if (!(v > 0)) return;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (Math.abs(rows[i].p - v) < 1e-9) { rows[i][key] = true; return; }
        // a grid row this close would sit on top of the real one
        if (Math.abs(rows[i].p - v) < step * 0.4 && !rows[i].be) rows.splice(i, 1);
      }
      rows.push({ p: v, [key]: true });
    };
    // When the take-profit or stop-loss sits outside the +/-8-step band, don't
    // just append it as one isolated row - bridge the gap in 10 even steps so
    // the table shows the actual path of $ outcomes out to the order resting
    // there, not a jump straight from the last grid row to a lone target/stop.
    const EXTRA = 10;
    const top = be + step * HALF, bottom = be - step * HALF;
    const bridge = (target, pathKey) => {
      if (!(target > 0)) return;
      const from = target > top ? top : target < bottom ? bottom : null;
      if (from === null) return; // already inside the grid
      const inc = (target - from) / EXTRA;
      for (let i = 1; i < EXTRA; i++) {
        rows.push({ p: from + inc * i, [pathKey]: true });
      }
    };
    bridge(t.take_profit, 'tpPath');
    bridge(t.stop_loss, 'slPath');
    add(t.price, 'now');
    add(t.take_profit, 'tp');
    add(t.stop_loss, 'sl');
    rows.sort((a, b) => b.p - a.p);

    return `<div class="xt">
      <div class="xt-head">
        <div>
          <div class="xt-title">Exit table</div>
          <div class="xt-sub">every $${num(step, step < 1 ? 4 : 2)} of price =
            <b>$${num(step * t.qty)}</b></div>
        </div>
      </div>
      <table class="xt-tbl"><thead><tr>
          <th>Sell at</th><th class="r">You keep</th><th class="r">From now</th>
        </tr></thead><tbody>
        ${rows.map((r) => {
          const v = (r.sl || r.slPath) ? atTaker(r.p) : at(r.p);
          const k = [r.be ? 'is-be' : '', r.tp ? 'is-tp' : '', r.sl ? 'is-sl' : '',
                     r.now ? 'is-now' : '', v >= 0 ? 'w' : 'l'].join(' ');
          const badge = r.be ? '<span class="tag be">breakeven</span>'
            : r.tp ? '<span class="tag tp">target</span>'
            : r.sl ? '<span class="tag sl">stop</span>'
            : r.now ? '<span class="tag now">now</span>' : '';
          return `<tr class="${k}">
            <td class="xt-p">${fmtPrice(r.p)} ${badge}</td>
            <td class="r xt-v ${cls(v)}">${r.be ? '$0.00' : usd(v)}</td>
            <td class="r xt-m">${sign(r.p / t.price - 1)}${
              pct((r.p / t.price - 1) * 100, 2)}</td>
          </tr>`;
        }).join('')}
      </tbody></table>
      <div class="lt-note">Priced as a resting limit (maker
        ${pct(t.maker_rate * 100, 3)}), net of the
        ${pct(t.rebate_rate * 100, 1)} rebate and of the
        $${num(t.fees_on_position)} buy fee already paid. Crossing the spread
        instead costs ${pct(t.taker_rate * 100, 3)} and moves breakeven to
        ${fmtPrice(t.breakeven_taker)}${t.stop_loss
          ? ' - the stop row above is priced at that taker rate, since a stop crosses the book when it triggers'
          : ''}.</div>
    </div>`;
  }

  /* Breakeven, stated once and loudly. It is the number that decides whether
     closing now costs money, so it should never need looking for. */
  function breakevenBar(t) {
    const gap = t.price - t.breakeven_maker;
    const need = t.breakeven_maker - t.price;
    const above = gap >= 0;
    return `<div class="be-bar ${above ? 'ok' : 'under'}">
      <div class="be-main">
        <div class="be-label">Breakeven — sell here and you are flat</div>
        <div class="be-price">${fmtPrice(t.breakeven_maker)}</div>
      </div>
      <div class="be-side">
        <div class="be-row"><span>Live price</span>
          <b class="${above ? 'pos' : 'neg'}">${fmtPrice(t.price)}</b></div>
        <div class="be-row"><span>${above ? 'Clear by' : 'Still needs'}</span>
          <b class="${above ? 'pos' : 'neg'}">$${num(Math.abs(above ? gap : need))}
            (${sign(t.to_breakeven_pct)}${pct(t.to_breakeven_pct, 3)})</b></div>
        <div class="be-row"><span>Close now (maker)</span>
          <b class="${cls(t.unrealized_maker)}">${usd(t.unrealized_maker)}</b></div>
        <div class="be-row"><span>Close now (market)</span>
          <b class="${cls(t.unrealized_taker)}">${usd(t.unrealized_taker)}</b></div>
      </div>
    </div>`;
  }

  function viewLive() {
    const live = DATA.live_trades || [];
    if (!live.length) {
      return `<div class="card lt-empty">
          <div class="lt-empty-mark">◎</div>
          <h3>No running trades</h3>
          <p class="muted">You are flat. Every position is closed and the
            balance is sitting in cash.</p>
          <p class="muted small">Last synced
            ${new Date(DATA.generated_at).toLocaleString()}.</p>
        </div>`;
    }
    const totVal = live.reduce((a, t) => a + t.value, 0);
    const totUn = live.reduce((a, t) => a + t.unrealized_maker, 0);
    const totTp = live.reduce((a, t) => a + (t.tp_pnl || 0), 0);
    const totSl = live.reduce((a, t) => a + (t.sl_pnl || 0), 0);

    const head = `<div class="lt-head">
        <div class="lt-head-item"><span>Open positions</span><b>${live.length}</b></div>
        <div class="lt-head-item"><span>Capital at work</span><b>$${num(totVal)}</b></div>
        <div class="lt-head-item"><span>Open P&amp;L</span>
          <b class="${cls(totUn)}">${usd(totUn)}</b></div>
        <div class="lt-head-item"><span>If all targets hit</span>
          <b class="pos">+$${num(totTp)}</b></div>
        <div class="lt-head-item"><span>If all stops hit</span>
          <b class="${totSl ? 'neg' : 'muted'}">${totSl ? '-$' + num(Math.abs(totSl))
            : 'no stops'}</b></div>
      </div>`;

    const cards = live.map((t) => {
      const un = t.unrealized_maker;
      const beat = t.price >= t.breakeven_maker;
      const stat = (label, val, k, hint) => `<div class="lt-stat">
          <div class="lt-stat-label">${esc(label)}</div>
          <div class="lt-stat-val ${k || ''}">${val}</div>
          ${hint ? `<div class="lt-stat-hint">${hint}</div>` : ''}
        </div>`;
      return `<section class="card lt-card ${un >= 0 ? 'win' : 'lose'}">
        <header class="lt-top">
          <div class="lt-id">
            <div class="lt-sym">${esc(t.symbol)}</div>
            <div class="lt-meta">
              <span class="chip">${esc((t.products || []).join(', '))}</span>
              <span class="chip">${fmtQty(t.qty)} ${esc(t.symbol)}</span>
              <span class="chip">held ${fmtDur(t.hold_seconds)}</span>
              <span class="chip ${t.taker_fills && !t.maker_fills ? 'chip-warn' : ''}">
                entry ${t.taker_fills && !t.maker_fills ? 'taker' : 'mixed'}
                · ${t.maker_fills + t.taker_fills} fills</span>
            </div>
          </div>
          <div class="lt-pnl">
            <div class="lt-pnl-val ${cls(un)}">${usd(un)}</div>
            <div class="lt-pnl-sub ${cls(un)}">
              ${sign(un)}${pct(un / t.basis * 100, 2)} open · sell maker now</div>
          </div>
        </header>

        ${breakevenBar(t)}
        ${progressBar(t)}

        <div class="lt-stats">
          ${stat('Entry (avg)', fmtPrice(t.entry_price),
                 '', `$${num(t.cost)} in`)}
          ${stat('Breakeven', fmtPrice(t.breakeven_maker), beat ? 'pos' : 'neg',
                 `${sign(t.to_breakeven_pct)}${pct(t.to_breakeven_pct, 3)} away`)}
          ${stat('Live price', fmtPrice(t.price), beat ? 'pos' : 'neg',
                 `worth $${num(t.value)}`)}
          ${stat('Take profit', t.take_profit ? fmtPrice(t.take_profit) : '—',
                 t.take_profit ? 'pos' : 'muted',
                 t.tp_pnl != null ? `gain +$${num(t.tp_pnl)}` : 'none set')}
          ${stat('Stop loss', t.stop_loss ? fmtPrice(t.stop_loss) : '—',
                 t.stop_loss ? 'neg' : 'muted',
                 t.sl_pnl != null ? `loss -$${num(Math.abs(t.sl_pnl))}`
                   : 'nothing protecting this')}
          ${stat('Reward : risk', t.reward_risk
                   ? `1 : ${num(t.reward_risk, 1)}` : '—',
                 t.reward_risk && t.reward_risk > 1 ? 'neg' : 'muted',
                 t.reward_risk ? `risking $${num(Math.abs(t.sl_pnl))} to make
                   $${num(t.tp_pnl)}` : 'no stop, so undefined')}
        </div>

        ${t.reward_risk && t.reward_risk > 3 ? `<div class="lt-warn">
          <b>The stop is doing the damage.</b> This trade risks
          $${num(Math.abs(t.sl_pnl))} to make $${num(t.tp_pnl)} —
          ${num(t.reward_risk, 1)} : 1 against you. One stop-out erases
          ${Math.round(t.reward_risk)} winners of this size.</div>` : ''}
        ${!t.stop_loss ? `<div class="lt-warn soft">
          <b>No stop on this position.</b> $${num(t.basis)} is exposed with
          nothing underneath it.</div>` : ''}

        <div class="lt-grid">
          <div class="lt-chart-wrap">${tradeChart(t)}</div>
          <div class="lt-ladder-wrap">${exitTable(t)}</div>
        </div>

        <footer class="lt-foot">
          <span>Opened ${new Date(t.open_time).toLocaleString()}</span>
          <span>Cost basis $${num(t.basis)} = $${num(t.cost)} coins +
            $${num(t.fees_on_position)} fee net of rebate</span>
          ${t.order_created ? `<span>Order placed
            ${new Date(t.order_created + 'Z').toLocaleString()}</span>` : ''}
        </footer>
      </section>`;
    }).join('');

    return head + cards + `<div class="lt-sync">Prices and orders read live from
      Coinbase at ${new Date(DATA.generated_at).toLocaleString()}. Breakeven
      assumes the exit rests as a maker order; every figure is net of fees and
      the Coinbase One rebate.</div>`;
  }

  /* ---------------- dashboard ---------------- */
  function viewDashboard() {
    const s = DATA.summary, r = DATA.reconciliation;
    const days = DATA.days;
    const cum = days.map((d) => ({ label: d.date.slice(5), value: d.cumulative }));
    const daily = days.map((d) => ({
      label: d.date.slice(5), value: d.net_pnl,
      extra: `${d.trades} trade(s) · ${pct(d.win_rate)} win`,
    }));
    const dd = DATA.drawdown.map((d) => ({ label: d.date.slice(5), value: d.drawdown }));

    const kpi = (label, value, klass, foot, extra) => `
      <div class="card kpi c3">
        <div class="kpi-row">
          <div style="min-width:0">
            <div class="kpi-label">${esc(label)}</div>
            <div class="kpi-value ${klass || ''}">${value}</div>
            ${foot ? `<div class="kpi-foot">${foot}</div>` : ''}
          </div>
          ${extra || ''}
        </div>
      </div>`;

    const pf = s.profit_factor;
    const pfPct = Math.min(100, (pf / 3) * 100);

    return `
    <div class="grid">
      ${kpi('Net P&L (closed trades)', money(s.net_pnl), cls(s.net_pnl),
        `${s.trade_count} closed · ${s.open_count} open`)}
      ${kpi('Trade win %', pct(s.win_rate), '',
        `${s.wins}W / ${s.losses}L`,
        donut(s.win_rate, { size: 72, tip: `${s.wins} wins of ${s.trade_count}` }))}
      ${kpi('Profit factor', pf.toFixed(2), pf >= 1 ? 'pos' : 'neg',
        `${money(s.gross_profit)} won vs ${money(s.gross_loss)} lost`,
        donut(pfPct, { size: 72, label: pf.toFixed(2),
          color: pf >= 1 ? 'var(--pos)' : 'var(--neg)', tip: 'Gross profit / gross loss' }))}
      ${kpi('Day win %', pct(s.day_win_rate), '',
        `${s.win_days} of ${s.day_count} days`,
        donut(s.day_win_rate, { size: 72 }))}

      <div class="card c4">
        <h3>Zella Score <span class="muted">${s.zella_score.score} / 100</span></h3>
        ${radar(stripScore(s.zella_score))}
        <div class="bar-track"><div class="bar-fill" style="width:${s.zella_score.score}%"></div></div>
        <div class="note">Composite of win rate, profit factor, win/loss ratio,
          drawdown control, recovery and consistency.</div>
      </div>

      <div class="card c8">
        <h3>Daily net cumulative P&L</h3>
        ${areaChart(cum, { height: 236 })}
      </div>

      <div class="card c7">
        <h3>Net daily P&L</h3>
        ${barChart(daily, { height: 210 })}
      </div>

      <div class="card c5">
        <h3>Avg win vs avg loss</h3>
        ${winLossBar(s)}
        <div class="metrics" style="margin-top:14px">
          <div class="metric"><div class="m-l">Avg win</div>
            <div class="m-v pos">${money(s.avg_win)}</div></div>
          <div class="metric"><div class="m-l">Avg loss</div>
            <div class="m-v neg">${money(-s.avg_loss)}</div></div>
          <div class="metric"><div class="m-l">Ratio</div>
            <div class="m-v">${s.avg_win_loss_ratio.toFixed(2)}</div></div>
          <div class="metric"><div class="m-l">Expectancy</div>
            <div class="m-v ${cls(s.trade_expectancy)}">${money(s.trade_expectancy)}</div></div>
        </div>
      </div>

      <div class="card c7">
        <h3>Progress tracker <span class="muted">daily results</span></h3>
        ${heatmap(days)}
        <div class="legend">
          <span><i style="background:var(--pos)"></i>Profitable day</span>
          <span><i style="background:var(--neg)"></i>Losing day</span>
          <span><i style="background:var(--line)"></i>No trades</span>
        </div>
      </div>

      <div class="card c5">
        <h3>Account balance</h3>
        <div class="kpi-value" style="margin-bottom:4px">
          ${money(DATA.portfolio.total_value)}</div>
        <div class="kpi-foot">
          Invested ${money(r.net_invested)} ·
          <span class="${cls(r.total_return)}">${sign(r.total_return)}${money(r.total_return)}
          (${pct(r.total_return_pct)})</span>
        </div>
        ${holdingsMini()}
      </div>

      <div class="card c7">
        <h3>Drawdown</h3>
        ${areaChart(dd, { height: 190, color: 'var(--neg)' })}
        <div class="note">Max drawdown ${money(s.max_drawdown)} ·
          recovery factor ${s.recovery_factor.toFixed(2)}</div>
      </div>

      <div class="card c5">
        <h3>Open positions</h3>
        ${openPositionsTable()}
      </div>

      <div class="card c12">
        <h3>Recent trades <a href="#/trades" class="muted" style="font-weight:500">View all →</a></h3>
        ${tradeTable(sortTrades(DATA.trades.slice()).slice(0, 12), true)}
      </div>
    </div>`;
  }

  const stripScore = (z) => {
    const o = {}; Object.keys(z).forEach((k) => { if (k !== 'score') o[k] = z[k]; }); return o;
  };

  function winLossBar(s) {
    const w = s.avg_win, l = s.avg_loss, tot = w + l || 1;
    return `<div style="display:flex;height:26px;border-radius:7px;overflow:hidden;
      border:1px solid var(--line)">
      <div style="width:${(w / tot) * 100}%;background:var(--pos);display:flex;
        align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600">
        ${w ? money(w) : ''}</div>
      <div style="width:${(l / tot) * 100}%;background:var(--neg);display:flex;
        align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600">
        ${l ? money(-l) : ''}</div>
    </div>`;
  }

  function holdingsMini() {
    const h = DATA.portfolio.holdings;
    if (!h.length) return '<div class="empty">No holdings</div>';
    return `<div style="margin-top:12px">${h.map((x) => `
      <div style="display:flex;align-items:center;gap:9px;padding:6px 0;
        border-bottom:1px solid var(--line-2)">
        <span class="sym" style="width:52px">${esc(x.currency)}</span>
        <div class="bar-track" style="flex:1;margin:0">
          <div class="bar-fill" style="width:${x.weight.toFixed(1)}%"></div></div>
        <span style="width:88px;text-align:right">${money(x.value)}</span>
        <span class="muted" style="width:44px;text-align:right;font-size:11px">
          ${x.weight.toFixed(0)}%</span>
      </div>`).join('')}</div>`;
  }

  function openPositionsTable() {
    const open = DATA.trades.filter((t) => t.status === 'OPEN');
    if (!open.length) return '<div class="empty">No open positions</div>';
    return `<div class="tbl-wrap"><table>
      <thead><tr><th class="l">Symbol</th><th>Qty</th><th>Avg cost</th>
        <th>Mark</th><th>Unrealized</th></tr></thead>
      <tbody>${open.map((t) => `<tr>
        <td class="l sym">${esc(t.symbol)}</td>
        <td>${fmtQty(t.open_qty)}</td>
        <td>${fmtPrice(t.open_avg_price)}</td>
        <td>${fmtPrice(t.mark_price)}</td>
        <td class="${cls(t.unrealized_pnl)}">${sign(t.unrealized_pnl)}${money(t.unrealized_pnl)}
          <span class="muted" style="font-size:10.5px"> (${pct(t.net_roi)})</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  /* ---------------- trades ---------------- */
  function sortTrades(list) {
    const { key, dir } = state.tradeSort;
    return list.sort((a, b) => {
      let x = a[key], y = b[key];
      if (key === 'net_pnl') { x = pnlOf(a); y = pnlOf(b); }
      if (x === null || x === undefined) x = -Infinity;
      if (y === null || y === undefined) y = -Infinity;
      if (typeof x === 'string') return x < y ? dir : x > y ? -dir : 0;
      return (x - y) * dir * -1;
    });
  }
  const pnlOf = (t) => (t.status === 'CLOSED' ? t.net_pnl : (t.unrealized_pnl || 0));

  function filterTrades(list) {
    const f = state.tradeFilter, q = f.text.toLowerCase();
    return list.filter((t) => {
      if (q && !t.symbol.toLowerCase().includes(q)) return false;
      if (f.status !== 'all' && t.status !== f.status) return false;
      if (f.result !== 'all') {
        if (f.result === 'WIN' && !(t.status === 'CLOSED' && t.net_pnl > 0)) return false;
        if (f.result === 'LOSS' && !(t.status === 'CLOSED' && t.net_pnl < 0)) return false;
      }
      return true;
    });
  }

  function tradeTable(list, compact) {
    if (!list.length) return '<div class="empty">No trades match these filters</div>';
    const th = (key, label, klass) =>
      `<th class="sortable ${klass || ''}" data-sort="${key}">${label}${
        state.tradeSort.key === key ? (state.tradeSort.dir === -1 ? ' ↓' : ' ↑') : ''}</th>`;
    return `<div class="tbl-wrap"><table>
      <thead><tr>
        ${th('open_time', 'Open date', 'l')}
        ${th('symbol', 'Symbol', 'l')}
        <th class="l">Status</th>
        ${compact ? '' : th('close_time', 'Close date', 'l')}
        <th>Entry</th><th>Exit</th>
        ${compact ? '' : '<th>Qty</th>'}
        ${compact ? '' : '<th>Fees</th>'}
        ${th('net_pnl', 'Net P&L')}
        <th>Net ROI</th>
        ${compact ? '' : '<th>Hold</th>'}
      </tr></thead>
      <tbody>${list.map((t) => {
        const p = pnlOf(t);
        const badge = t.status === 'OPEN' ? 'open'
          : t.net_pnl > 0 ? 'win' : t.net_pnl < 0 ? 'loss' : 'be';
        const label = t.status === 'OPEN' ? 'OPEN'
          : t.net_pnl > 0 ? 'WIN' : t.net_pnl < 0 ? 'LOSS' : 'BE';
        return `<tr>
          <td class="l">${esc(localDate(t.open_time))}</td>
          <td class="l sym">${esc(t.symbol)}</td>
          <td class="l"><span class="pill ${badge}">${label}</span></td>
          ${compact ? '' : `<td class="l">${esc(localDate(t.close_time) || '—')}</td>`}
          <td>${fmtPrice(t.entry_price)}</td>
          <td>${t.status === 'OPEN' ? fmtPrice(t.mark_price) : fmtPrice(t.exit_price)}</td>
          ${compact ? '' : `<td>${fmtQty(t.status === 'OPEN' ? t.open_qty : t.entry_qty)}</td>`}
          ${compact ? '' : `<td class="muted">${money(t.fees)}</td>`}
          <td class="${cls(p)}">${sign(p)}${money(p)}${
            t.status === 'OPEN' ? ' <span class="muted" style="font-size:10px">unrl</span>' : ''}</td>
          <td class="${cls(t.net_roi)}">${sign(t.net_roi)}${pct(t.net_roi)}</td>
          ${compact ? '' : `<td class="muted">${fmtDur(t.hold_seconds)}</td>`}
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function viewTrades() {
    const filtered = filterTrades(DATA.trades.slice());
    const sorted = sortTrades(filtered);
    const closed = sorted.filter((t) => t.status === 'CLOSED');
    const net = closed.reduce((a, t) => a + t.net_pnl, 0);
    return `
    <div class="filters">
      <input id="f-text" type="search" placeholder="Search symbol…"
        value="${esc(state.tradeFilter.text)}" style="min-width:180px">
      <select id="f-status">
        <option value="all">All statuses</option>
        <option value="CLOSED"${state.tradeFilter.status === 'CLOSED' ? ' selected' : ''}>Closed</option>
        <option value="OPEN"${state.tradeFilter.status === 'OPEN' ? ' selected' : ''}>Open</option>
      </select>
      <select id="f-result">
        <option value="all">All results</option>
        <option value="WIN"${state.tradeFilter.result === 'WIN' ? ' selected' : ''}>Wins</option>
        <option value="LOSS"${state.tradeFilter.result === 'LOSS' ? ' selected' : ''}>Losses</option>
      </select>
      <span class="muted" style="margin-left:auto">
        ${sorted.length} trade(s) · net <b class="${cls(net)}">${money(net)}</b></span>
    </div>
    <div class="card c12">${tradeTable(sorted, false)}</div>`;
  }

  /* ---------------- day view ---------------- */
  // One row per sale (engine.daily_stats' own "sales" list), not per
  // round-trip trade matched to this day by close date. A position that
  // exits over two orders the same day - or a partial exit today of a
  // trade that only finishes closing on a later day - is real money on
  // this day either way, and "Trades" above already counts it; the old
  // round-trip-based list could only ever show the day a trade's LAST
  // order fell on, so a day's own header and its own row count could
  // disagree, and a partial exit had nowhere to show up at all.
  function salesTable(sales) {
    if (!sales.length) return '<div class="empty">No sales this day</div>';
    return `<div class="tbl-wrap"><table>
      <thead><tr>
        <th class="l">Time</th><th class="l">Symbol</th><th class="l">Result</th>
        <th>Entry</th><th>Exit</th><th>Qty</th><th>Fees</th><th>Net P&L</th>
      </tr></thead>
      <tbody>${sales.map((x) => {
        const badge = x.pnl > 0 ? 'win' : x.pnl < 0 ? 'loss' : 'be';
        const label = x.pnl > 0 ? 'WIN' : x.pnl < 0 ? 'LOSS' : 'BE';
        return `<tr>
          <td class="l">${esc(localTime(x.time))}</td>
          <td class="l sym">${esc(x.symbol)}</td>
          <td class="l"><span class="pill ${badge}">${label}</span>${
            x.full_close ? '' : ' <span class="tag partial">PARTIAL</span>'}</td>
          <td>${fmtPrice(x.entry_price)}</td>
          <td>${fmtPrice(x.exit_price)}</td>
          <td>${fmtQty(x.qty)}</td>
          <td class="muted">${money(x.fees)}</td>
          <td class="${cls(x.pnl)}">${sign(x.pnl)}${money(x.pnl)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function viewDays() {
    const days = DATA.days.slice().reverse();
    if (!days.length) return '<div class="empty">No closed trades yet</div>';
    return days.map((d) => `
      <div class="day-card" data-day="${d.date}">
        <div class="day-head">
          <span class="chev">›</span>
          <span class="day-date">${fmtDate(d.date)}</span>
          <span class="day-pnl ${cls(d.net_pnl)}">${sign(d.net_pnl)}${money(d.net_pnl)}</span>
          <div class="day-stats">
            <div class="day-stat"><b>${d.trades}</b><span>Trades</span></div>
            <div class="day-stat"><b class="${cls(d.gross_pnl)}">${money(d.gross_pnl)}</b>
              <span>Gross P&L</span></div>
            <div class="day-stat"><b>${d.wins} / ${d.losses}</b><span>W / L</span></div>
            <div class="day-stat"><b>${pct(d.win_rate)}</b><span>Win rate</span></div>
            <div class="day-stat"><b>${money(d.fees)}</b><span>Commissions</span></div>
            <div class="day-stat"><b>${d.profit_factor ? d.profit_factor.toFixed(2) : '—'}</b>
              <span>Profit factor</span></div>
          </div>
        </div>
        <div class="day-body">${salesTable(d.sales || [])}</div>
      </div>`).join('');
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  /* ---------------- positions ---------------- */
  function viewPositions() {
    const p = DATA.portfolio, orders = DATA.open_orders || [];
    const open = DATA.trades.filter((t) => t.status === 'OPEN');
    return `
    <div class="grid">
      <div class="card c8">
        <h3>Holdings <span class="muted">${money(p.total_value)} total</span></h3>
        <div class="tbl-wrap"><table>
          <thead><tr><th class="l">Asset</th><th>Balance</th><th>Available</th>
            <th>On hold</th><th>Price</th><th>Value</th><th>Weight</th></tr></thead>
          <tbody>${p.holdings.map((h) => `<tr>
            <td class="l sym">${esc(h.currency)}</td>
            <td>${fmtQty(h.balance)}</td>
            <td>${fmtQty(h.available)}</td>
            <td class="${h.hold > 0 ? 'warn' : 'muted'}">${h.hold > 0 ? fmtQty(h.hold) : '—'}</td>
            <td>${fmtPrice(h.price)}</td>
            <td><b>${money(h.value)}</b></td>
            <td class="muted">${h.weight.toFixed(1)}%</td>
          </tr>`).join('')}</tbody></table></div>
      </div>

      <div class="card c4">
        <h3>Open orders</h3>
        ${orders.length ? orders.map((o) => `
          <div style="padding:9px 0;border-bottom:1px solid var(--line-2)">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <b>${esc(o.product)}</b>
              <span class="pill ${o.side === 'BUY' ? 'win' : 'loss'}">${esc(o.side)}</span>
            </div>
            <div class="muted" style="font-size:11.5px;margin-top:3px">
              ${esc(o.type || '')} · size ${esc(o.size || '—')}
              ${o.limit_price ? '<br>limit ' + fmtPrice(o.limit_price) : ''}
              ${o.stop_price ? ' · stop ' + fmtPrice(o.stop_price) : ''}
            </div>
          </div>`).join('') : '<div class="empty">No open orders</div>'}
      </div>

      <div class="card c12">
        <h3>Open positions detail</h3>
        ${open.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th class="l">Symbol</th><th class="l">Opened</th><th>Qty</th>
            <th>Avg cost</th><th>Mark</th><th>Cost basis</th><th>Market value</th>
            <th>Unrealized</th><th>ROI</th><th>Realized so far</th></tr></thead>
          <tbody>${open.map((t) => `<tr>
            <td class="l sym">${esc(t.symbol)}</td>
            <td class="l">${esc(localDate(t.open_time))}</td>
            <td>${fmtQty(t.open_qty)}</td>
            <td>${fmtPrice(t.open_avg_price)}</td>
            <td>${fmtPrice(t.mark_price)}</td>
            <td>${money(t.open_basis)}</td>
            <td>${money(t.market_value)}</td>
            <td class="${cls(t.unrealized_pnl)}"><b>${sign(t.unrealized_pnl)}${money(t.unrealized_pnl)}</b></td>
            <td class="${cls(t.net_roi)}">${sign(t.net_roi)}${pct(t.net_roi)}</td>
            <td class="${cls(t.realized_pnl)}">${money(t.realized_pnl)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No open positions</div>'}
        <div class="note">“Realized so far” is profit or loss already banked by
          partial exits of a position that is still open.</div>
      </div>
    </div>`;
  }

  /* ---------------- reports ---------------- */
  function viewReports() {
    const s = DATA.summary, r = DATA.reconciliation, f = DATA.fee_tier || {};
    const bySym = DATA.by_symbol;
    const hourly = DATA.hourly.map((h) => ({
      label: String(h.hour).padStart(2, '0'), value: h.net_pnl,
      extra: `${h.trades} trade(s)`,
    }));
    const wd = DATA.weekday.map((d) => ({
      label: d.day, value: d.net_pnl, extra: `${d.trades} trade(s)`,
    }));
    const m = (l, v, k) => `<div class="metric"><div class="m-l">${l}</div>
      <div class="m-v ${k || ''}">${v}</div></div>`;

    return `
    <div class="grid">
      <div class="card c12">
        <h3>Performance summary</h3>
        <div class="metrics">
          ${m('Net P&L (closed)', money(s.net_pnl), cls(s.net_pnl))}
          ${m('Realized on open positions', money(s.realized_from_open), cls(s.realized_from_open))}
          ${m('Unrealized', money(s.unrealized_pnl), cls(s.unrealized_pnl))}
          ${m('Total return', money(r.total_return), cls(r.total_return))}
          ${m('Win %', pct(s.win_rate))}
          ${m('Profit factor', s.profit_factor.toFixed(2), s.profit_factor >= 1 ? 'pos' : 'neg')}
          ${m('Trade expectancy', money(s.trade_expectancy), cls(s.trade_expectancy))}
          ${m('Avg win / avg loss', s.avg_win_loss_ratio.toFixed(2))}
          ${m('Largest win', money(s.largest_win), 'pos')}
          ${m('Largest loss', money(s.largest_loss), 'neg')}
          ${m('Max drawdown', money(s.max_drawdown), 'neg')}
          ${m('Recovery factor', s.recovery_factor.toFixed(2))}
          ${m('Avg daily P&L', money(s.avg_daily_pnl), cls(s.avg_daily_pnl))}
          ${m('Avg hold time', fmtDur(s.avg_hold_seconds))}
          ${m('Total fees paid', money(s.total_fees), 'neg')}
          ${m('Rewards income', money(r.income), 'pos')}
        </div>
      </div>

      <div class="card c6">
        <h3>P&L reconciliation</h3>
        <div class="recon-row"><span>Net invested (external cash)</span>
          <b>${money(r.net_invested)}</b></div>
        <div class="recon-row"><span>Realized — closed trades</span>
          <b class="${cls(s.net_pnl)}">${money(s.net_pnl)}</b></div>
        <div class="recon-row"><span>Realized — partial exits</span>
          <b class="${cls(s.realized_from_open)}">${money(s.realized_from_open)}</b></div>
        <div class="recon-row"><span>Unrealized on open positions</span>
          <b class="${cls(s.unrealized_pnl)}">${money(s.unrealized_pnl)}</b></div>
        <div class="recon-row"><span>Rewards &amp; interest income</span>
          <b class="pos">${money(r.income)}</b></div>
        <div class="recon-row total"><span>Expected portfolio value</span>
          <b>${money(r.expected_value)}</b></div>
        <div class="recon-row"><span>Actual portfolio value</span>
          <b>${money(r.actual_value)}</b></div>
        <div class="recon-row"><span>Unexplained residual</span>
          <b class="${r.balanced ? 'muted' : 'neg'}">${money(r.residual)}</b></div>
        <div class="note">${r.balanced
          ? 'Balanced within tolerance. The residual comes from Coinbase rounding and the spread baked into simple-interface prices, which are not itemised anywhere in the API.'
          : 'Residual exceeds tolerance — treat these figures as approximate.'}</div>
      </div>

      <div class="card c6">
        <h3>Fees &amp; account</h3>
        <div class="metrics">
          ${m('Fee tier', esc(f.tier || '—'))}
          ${m('Maker fee', f.maker !== undefined ? (f.maker * 100).toFixed(3) + '%' : '—')}
          ${m('Taker fee', f.taker !== undefined ? (f.taker * 100).toFixed(3) + '%' : '—')}
          ${m('30-day volume', money(f.volume_30d || 0, 0))}
          ${m('Fees paid (lifetime)', money(s.total_fees), 'neg')}
          ${m('Fees as % of invested',
            pct((s.total_fees / (r.net_invested || 1)) * 100, 2))}
        </div>
        <div class="note">Fees shown are Coinbase's per-fill commissions as reported
          by the API. Coinbase One rebates arrive separately and are counted as income,
          not netted into trade P&L.</div>
      </div>

      <div class="card c12">
        <h3>Performance by symbol</h3>
        <div class="tbl-wrap"><table>
          <thead><tr><th class="l">Symbol</th><th>Closed trades</th><th>Win %</th>
            <th>Realized</th><th>Unrealized</th><th>Total</th><th>Fees</th>
            <th>Volume</th></tr></thead>
          <tbody>${bySym.map((x) => `<tr>
            <td class="l sym">${esc(x.symbol)}</td>
            <td>${x.trades}${x.open ? ` <span class="pill open">${x.open} open</span>` : ''}</td>
            <td>${x.trades ? pct(x.win_rate) : '—'}</td>
            <td class="${cls(x.net_pnl)}">${money(x.net_pnl)}</td>
            <td class="${cls(x.unrealized)}">${x.unrealized ? money(x.unrealized) : '—'}</td>
            <td class="${cls(x.total)}"><b>${sign(x.total)}${money(x.total)}</b></td>
            <td class="muted">${money(x.fees)}</td>
            <td class="muted">${money(x.volume, 0)}</td>
          </tr>`).join('')}</tbody></table></div>
      </div>

      <div class="card c6">
        <h3>P&L by entry hour (${tzLabel()})</h3>
        ${barChart(hourly, { height: 190 })}
      </div>
      <div class="card c6">
        <h3>P&L by weekday</h3>
        ${barChart(wd, { height: 190 })}
      </div>
    </div>`;
  }

  /* ---------------- calendar ---------------- */
  // Months worth showing: any month you closed a trade, any month you opened
  // one, and always the current month. Listing only closed-trade months makes
  // a month where you bought but haven't sold yet vanish entirely.
  function calendarMonths() {
    const m = new Set(DATA.days.map((d) => d.date.slice(0, 7)));
    (DATA.open_activity || []).forEach((a) => m.add(a.date.slice(0, 7)));
    m.add(new Date().toISOString().slice(0, 7));
    return Array.from(m).sort();
  }

  function viewCalendar() {
    const days = DATA.days;
    const acts = DATA.open_activity || [];
    if (!days.length && !acts.length) return '<div class="empty">No trades yet</div>';
    const months = calendarMonths();
    if (!state.calMonth || !months.includes(state.calMonth)) {
      state.calMonth = months[months.length - 1];
    }
    const idx = months.indexOf(state.calMonth);
    const map = {}; days.forEach((d) => { map[d.date] = d; });
    const actMap = {}; acts.forEach((a) => { actMap[a.date] = a; });
    const [y, mo] = state.calMonth.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const lead = first.getUTCDay();

    const monthDays = days.filter((d) => d.date.startsWith(state.calMonth));
    const mNet = monthDays.reduce((a, d) => a + d.net_pnl, 0);
    const mGreen = monthDays.filter((d) => d.net_pnl > 0).length;
    const mRed = monthDays.filter((d) => d.net_pnl < 0).length;
    const mTrades = monthDays.reduce((a, d) => a + d.trades, 0);
    const mFees = monthDays.reduce((a, d) => a + (d.fees || 0), 0);
    const best = monthDays.reduce((a, d) => (!a || d.net_pnl > a.net_pnl ? d : a), null);
    const worst = monthDays.reduce((a, d) => (!a || d.net_pnl < a.net_pnl ? d : a), null);
    // Shade each day against the month's own biggest move, so a quiet month
    // still reads and one outlier day does not wash everything else out.
    const peak = Math.max(...monthDays.map((d) => Math.abs(d.net_pnl)), 1);
    const today = localToday();

    let cells = '';
    const weeks = [];
    let week = { pnl: 0, days: 0, trades: 0 };
    for (let i = 0; i < lead; i++) cells += '<div class="cal-cell blank"></div>';
    for (let d = 1; d <= dim; d++) {
      const key = `${state.calMonth}-${String(d).padStart(2, '0')}`;
      const rec = map[key];
      const act = actMap[key];
      let k = '', style = '', body = '';
      if (rec) {
        k = rec.net_pnl > 0 ? 'win' : rec.net_pnl < 0 ? 'loss' : 'flat';
        const w = Math.min(Math.abs(rec.net_pnl) / peak, 1);
        style = ` style="--w:${(0.10 + w * 0.55).toFixed(3)}"`;
        const syms = (rec.symbols || []).join(' ');
        body = `<div class="cal-pnl ${cls(rec.net_pnl)}">${sign(rec.net_pnl)}${money(rec.net_pnl)}</div>
          <div class="cal-meta">${rec.trades} trade${rec.trades === 1 ? '' : 's'}${
            rec.trades ? ` \u00b7 ${Math.round(rec.win_rate)}%` : ''}</div>
          ${syms ? `<div class="cal-syms">${esc(syms)}</div>` : ''}`;
      } else if (act) {
        k = 'opened';
        body = `<div class="cal-pnl muted">\u2014</div>
          <div class="cal-meta">${act.opened} opened</div>
          <div class="cal-syms">${esc(act.symbols.join(' '))}</div>`;
      }
      cells += `<div class="cal-cell ${k}${key === today ? ' today' : ''}"${style}>
        <div class="cal-day">${d}</div>${body}
      </div>`;
      if (rec) { week.pnl += rec.net_pnl; week.days++; week.trades += rec.trades; }
      if ((lead + d) % 7 === 0) {
        weeks.push(week);
        cells += weekCell(weeks.length, week);
        week = { pnl: 0, days: 0, trades: 0 };
      }
    }
    const trail = (lead + dim) % 7;
    if (trail) {
      for (let i = trail; i < 7; i++) cells += '<div class="cal-cell blank"></div>';
      weeks.push(week);
      cells += weekCell(weeks.length, week);
    }

    const stat = (label, val, klass) =>
      `<div class="cal-stat"><span>${label}</span><b class="${klass || ''}">${val}</b></div>`;

    return `
    <div class="cal-head">
      <button class="cal-nav" id="cal-prev" ${idx <= 0 ? 'disabled' : ''}>\u2039</button>
      <b class="cal-title">${first.toLocaleDateString('en-US',
        { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
      <button class="cal-nav" id="cal-next" ${idx >= months.length - 1 ? 'disabled' : ''}>\u203a</button>
      <div class="cal-net ${cls(mNet)}">${sign(mNet)}${money(mNet)}</div>
    </div>
    <div class="cal-stats">
      ${stat('Green days', mGreen, 'pos')}
      ${stat('Red days', mRed, 'neg')}
      ${stat('Day win rate', (mGreen + mRed) ? Math.round(mGreen / (mGreen + mRed) * 100) + '%' : '\u2014')}
      ${stat('Sell orders', mTrades)}
      ${stat('Fees paid', money(mFees), 'neg')}
      ${best && best.net_pnl > 0 ? stat('Best day', sign(best.net_pnl) + money(best.net_pnl) + ' \u00b7 ' + best.date.slice(8), 'pos') : ''}
      ${worst && worst.net_pnl < 0 ? stat('Worst day', sign(worst.net_pnl) + money(worst.net_pnl) + ' \u00b7 ' + worst.date.slice(8), 'neg') : ''}
    </div>
    <div class="cal-grid">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) =>
        `<div class="cal-dow">${d}</div>`).join('')}
      <div class="cal-dow">Week</div>
      ${cells}
    </div>
    <div class="cal-note">Net realized P&amp;L per day \u2014 proceeds less cost,
      both sides\u2019 fees deducted and Coinbase One rebates credited back.
      A day counts money made the day the sale happened, partial exits included.</div>`;
  }

  const weekCell = (n, w) => `<div class="cal-week ${w.days ? cls(w.pnl) : ''}">
    <span class="cal-week-n">W${n}</span>
    <b>${w.days ? sign(w.pnl) + money(w.pnl) : '\u2014'}</b>
    <span class="muted">${w.days ? w.days + 'd \u00b7 ' + w.trades : ''}</span></div>`;

  /* ---------------- events ---------------- */
  function wire() {
    $$('th.sortable').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.tradeSort = state.tradeSort.key === k
        ? { key: k, dir: -state.tradeSort.dir } : { key: k, dir: -1 };
      render();
    }));
    $$('.day-head').forEach((h) => h.addEventListener('click', () =>
      h.parentElement.classList.toggle('open')));

    const t = $('#f-text');
    if (t) {
      t.addEventListener('input', debounce(() => {
        state.tradeFilter.text = t.value;
        render();
        const n = $('#f-text');
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      }, 220));
    }
    const st = $('#f-status');
    if (st) st.addEventListener('change', () => {
      state.tradeFilter.status = st.value; render();
    });
    const rs = $('#f-result');
    if (rs) rs.addEventListener('change', () => {
      state.tradeFilter.result = rs.value; render();
    });

    const months = calendarMonths();
    const prev = $('#cal-prev'), next = $('#cal-next');
    if (prev) prev.addEventListener('click', () => {
      const i = months.indexOf(state.calMonth);
      if (i > 0) { state.calMonth = months[i - 1]; render(); }
    });
    if (next) next.addEventListener('click', () => {
      const i = months.indexOf(state.calMonth);
      if (i < months.length - 1) { state.calMonth = months[i + 1]; render(); }
    });
  }

  function debounce(fn, ms) {
    let id; return function () { clearTimeout(id); id = setTimeout(fn, ms); };
  }

  /* tooltip */
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    tip.textContent = el.getAttribute('data-tip');
    tip.style.opacity = '1';
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.style.opacity !== '1') return;
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight) y = e.clientY - r.height - pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) tip.style.opacity = '0';
  });

  /* theme */
  const savedTheme = localStorage.getItem('tj-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tj-theme', next);
    render();
  });

  /* load */
  async function load(refresh) {
    const btn = $('#refresh');
    btn.disabled = true;
    if (refresh) { $('#views').hidden = true; $('#loading').hidden = false; }
    $('#error').hidden = true;
    try {
      const res = await fetch('/api/report' + (refresh ? '?refresh=1' : ''));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      DATA = await res.json();
      $('#loading').hidden = true;
      const r = DATA.reconciliation;
      const badge = $('#recon-badge');
      badge.textContent = r.balanced ? '✓ Reconciled' : '⚠ Check reconciliation';
      badge.classList.toggle('warn', !r.balanced);
      badge.title = `Residual ${money(r.residual)} vs tolerance ${money(r.tolerance)}`;
      $('#built-at').textContent = 'Updated ' +
        new Date(DATA.generated_at).toLocaleString();
      route();
    } catch (err) {
      $('#loading').hidden = true;
      const box = $('#error');
      box.hidden = false;
      box.textContent = 'Could not load your trades.\n\n' + err.message +
        '\n\nCheck that COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY are set, ' +
        'then press Refresh.';
    } finally {
      btn.disabled = false;
    }
  }

  $('#refresh').addEventListener('click', () => load(true));
  window.addEventListener('hashchange', route);
  load(false);
})();
