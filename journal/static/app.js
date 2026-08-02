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
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
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
  const dateOnly = (t) => (t || '').slice(0, 10);

  /* ---------------- shell ---------------- */
  const TITLES = {
    dashboard: ['Dashboard', 'Live from your Coinbase account'],
    days: ['Day View', 'Every trading day, newest first'],
    trades: ['Trade View', 'All round-trip trades, FIFO matched'],
    positions: ['Positions', 'What you are holding right now'],
    reports: ['Reports', 'Performance analytics and reconciliation'],
    calendar: ['Calendar', 'Monthly P&L calendar'],
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
      })[state.view]();
      wire();
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="error-box">Render error: ${esc(err.message)}</div>`;
    }
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
          <td class="l">${esc(dateOnly(t.open_time))}</td>
          <td class="l sym">${esc(t.symbol)}</td>
          <td class="l"><span class="pill ${badge}">${label}</span></td>
          ${compact ? '' : `<td class="l">${esc(dateOnly(t.close_time) || '—')}</td>`}
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
  function viewDays() {
    const days = DATA.days.slice().reverse();
    if (!days.length) return '<div class="empty">No closed trades yet</div>';
    const byDate = {};
    DATA.trades.forEach((t) => {
      if (t.status !== 'CLOSED') return;
      (byDate[dateOnly(t.close_time)] = byDate[dateOnly(t.close_time)] || []).push(t);
    });
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
        <div class="day-body">${tradeTable(byDate[d.date] || [], false)}</div>
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
            <td class="l">${esc(dateOnly(t.open_time))}</td>
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
        <h3>P&L by entry hour (UTC)</h3>
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
    const mOpens = acts.filter((a) => a.date.startsWith(state.calMonth))
      .reduce((n, a) => n + a.opened, 0);

    let cells = '';
    const weeks = [];
    let week = { pnl: 0, days: 0 };
    for (let i = 0; i < lead; i++) cells += '<div class="cal-cell blank"></div>';
    for (let d = 1; d <= dim; d++) {
      const key = `${state.calMonth}-${String(d).padStart(2, '0')}`;
      const rec = map[key];
      const act = actMap[key];
      const k = rec ? (rec.net_pnl > 0 ? 'win' : rec.net_pnl < 0 ? 'loss' : '') : '';
      let body = '';
      if (rec) {
        body = `<div class="cal-pnl ${cls(rec.net_pnl)}">${sign(rec.net_pnl)}${money(rec.net_pnl)}</div>
          <div class="cal-meta">${rec.trades} closed${act ? ` \u00b7 ${act.opened} opened` : ''}</div>`;
      } else if (act) {
        // bought but nothing closed - real activity, no result yet
        body = `<div class="cal-pnl muted">open</div>
          <div class="cal-meta">${act.opened} opened \u00b7 ${esc(act.symbols.join(', '))}</div>`;
      }
      cells += `<div class="cal-cell ${k}${!rec && act ? ' opened' : ''}">
        <div class="cal-day">${d}</div>${body}
      </div>`;
      if (rec) { week.pnl += rec.net_pnl; week.days++; }
      if ((lead + d) % 7 === 0) { weeks.push(week); week = { pnl: 0, days: 0 }; cells += weekCell(weeks.length, weeks[weeks.length - 1]); }
    }
    const trail = (lead + dim) % 7;
    if (trail) {
      for (let i = trail; i < 7; i++) cells += '<div class="cal-cell blank"></div>';
      weeks.push(week);
      cells += weekCell(weeks.length, week);
    }

    return `
    <div class="cal-head">
      <button class="cal-nav" id="cal-prev" ${idx <= 0 ? 'disabled' : ''}>‹</button>
      <b style="font-size:15px">${first.toLocaleDateString('en-US',
        { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
      <button class="cal-nav" id="cal-next" ${idx >= months.length - 1 ? 'disabled' : ''}>›</button>
      <span class="muted" style="margin-left:12px">Monthly net
        <b class="${cls(mNet)}">${sign(mNet)}${money(mNet)}</b> ·
        ${monthDays.length} day(s) with closed trades${mOpens ? ` · ${mOpens} position(s) opened` : ''}</span>
    </div>
    <div class="cal-grid">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) =>
        `<div class="cal-dow">${d}</div>`).join('')}
      <div class="cal-dow">Week</div>
      ${cells}
    </div>`;
  }

  const weekCell = (n, w) => `<div class="cal-week">Week ${n}
    <b class="${cls(w.pnl)}">${w.days ? sign(w.pnl) + money(w.pnl) : '$0'}</b>
    <span class="muted">${w.days} day(s)</span></div>`;

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
