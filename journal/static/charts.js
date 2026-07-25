/* Minimal dependency-free SVG charts.
   Every chart returns an SVG string; hover tooltips are wired by delegation
   in app.js via data-tip attributes. */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const css = (n) => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim() || '#888';

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const money = (v, dp) => {
    const n = Number(v) || 0;
    const d = dp === undefined ? (Math.abs(n) >= 1000 ? 0 : 2) : dp;
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US',
      { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /* ---------------- area / line ---------------- */
  function areaChart(data, opts) {
    opts = opts || {};
    const W = opts.width || 760, H = opts.height || 210;
    const P = { t: 12, r: 14, b: 24, l: 56 };
    if (!data.length) return emptySvg(W, H);

    const xs = data.map((d, i) => i);
    const ys = data.map((d) => +d.value || 0);
    let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
    const ticks = niceTicks(lo, hi, 4);
    lo = ticks[0]; hi = ticks[ticks.length - 1];

    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const X = (i) => P.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const Y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

    const pos = css('--pos'), neg = css('--neg'), line = css('--line');
    const positive = ys[ys.length - 1] >= 0;
    const stroke = opts.color || (positive ? pos : neg);

    let path = '', area = '';
    data.forEach((d, i) => {
      const x = X(i), y = Y(+d.value || 0);
      path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    });
    area = path + `L${X(data.length - 1).toFixed(1)} ${Y(0).toFixed(1)} L${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z`;

    const uid = 'g' + Math.random().toString(36).slice(2, 8);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
    s += `<defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${stroke}" stop-opacity=".28"/>
      <stop offset="1" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs>`;
    ticks.forEach((t) => {
      const y = Y(t);
      s += `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}"
        stroke="${line}" stroke-width="1"${t === 0 ? '' : ' stroke-dasharray="3 4"'}/>`;
      s += `<text x="${P.l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
        font-size="10" fill="${css('--ink-3')}">${esc(money(t, 0))}</text>`;
    });
    s += `<path d="${area}" fill="url(#${uid})"/>`;
    s += `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`;

    const step = Math.ceil(data.length / 6);
    data.forEach((d, i) => {
      if (i % step === 0 || i === data.length - 1) {
        s += `<text x="${X(i).toFixed(1)}" y="${H - 7}" text-anchor="middle"
          font-size="10" fill="${css('--ink-3')}">${esc(d.label || '')}</text>`;
      }
    });
    const bw = iw / data.length;
    data.forEach((d, i) => {
      s += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${P.t}" width="${Math.max(bw, 2).toFixed(1)}"
        height="${ih}" fill="transparent" data-tip="${esc((d.label || '') + '\n' + money(d.value))}"/>`;
    });
    return s + '</svg>';
  }

  /* ---------------- bars ---------------- */
  function barChart(data, opts) {
    opts = opts || {};
    const W = opts.width || 760, H = opts.height || 200;
    const P = { t: 12, r: 14, b: 26, l: 56 };
    if (!data.length) return emptySvg(W, H);

    const ys = data.map((d) => +d.value || 0);
    let ticks = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys), 4);
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const bw = Math.max(2, (iw / data.length) * 0.68);
    const X = (i) => P.l + (i + 0.5) * (iw / data.length);
    const Y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const pos = css('--pos'), neg = css('--neg'), line = css('--line');

    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
    ticks.forEach((t) => {
      const y = Y(t);
      s += `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}"
        stroke="${line}" stroke-width="1"${t === 0 ? '' : ' stroke-dasharray="3 4"'}/>`;
      s += `<text x="${P.l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
        font-size="10" fill="${css('--ink-3')}">${esc(money(t, 0))}</text>`;
    });
    const zero = Y(0);
    data.forEach((d, i) => {
      const v = +d.value || 0, y = Y(v);
      const top = Math.min(y, zero), h = Math.max(1.5, Math.abs(zero - y));
      s += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"
        fill="${v >= 0 ? pos : neg}" opacity=".92"
        data-tip="${esc((d.label || '') + '\n' + money(v) + (d.extra ? '\n' + d.extra : ''))}"/>`;
    });
    const step = Math.ceil(data.length / 8);
    data.forEach((d, i) => {
      if (i % step === 0 || i === data.length - 1) {
        s += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle"
          font-size="10" fill="${css('--ink-3')}">${esc(d.label || '')}</text>`;
      }
    });
    return s + '</svg>';
  }

  /* ---------------- donut gauge ---------------- */
  function donut(pct, opts) {
    opts = opts || {};
    const S = opts.size || 92, r = S / 2 - 8, c = S / 2;
    const circ = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(100, +pct || 0));
    const color = opts.color || (v >= 50 ? css('--pos') : css('--neg'));
    return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img"
      data-tip="${esc(opts.tip || v.toFixed(1) + '%')}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${css('--line')}" stroke-width="8"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="${(circ * v / 100).toFixed(2)} ${circ.toFixed(2)}"
        transform="rotate(-90 ${c} ${c})"/>
      <text x="${c}" y="${c + 4}" text-anchor="middle" font-size="15" font-weight="700"
        fill="${css('--ink')}">${opts.label !== undefined ? esc(opts.label) : v.toFixed(0) + '%'}</text>
    </svg>`;
  }

  /* ---------------- radar (Zella score) ---------------- */
  function radar(parts, opts) {
    opts = opts || {};
    const S = opts.size || 250, c = S / 2, R = c - 40;
    const keys = Object.keys(parts);
    const n = keys.length;
    const ang = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
    const pt = (i, f) => [c + Math.cos(ang(i)) * R * f, c + Math.sin(ang(i)) * R * f];
    const line = css('--line'), brand = css('--brand');

    let s = `<svg viewBox="0 0 ${S} ${S}" width="100%" height="${S}" role="img">`;
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      const p = keys.map((_, i) => pt(i, f).map((v) => v.toFixed(1)).join(',')).join(' ');
      s += `<polygon points="${p}" fill="none" stroke="${line}" stroke-width="1"/>`;
    });
    keys.forEach((_, i) => {
      const [x, y] = pt(i, 1);
      s += `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
        stroke="${line}" stroke-width="1"/>`;
    });
    const poly = keys.map((k, i) =>
      pt(i, Math.max(0, Math.min(100, parts[k])) / 100).map((v) => v.toFixed(1)).join(',')).join(' ');
    s += `<polygon points="${poly}" fill="${brand}" fill-opacity=".22" stroke="${brand}" stroke-width="2"/>`;
    keys.forEach((k, i) => {
      const [x, y] = pt(i, Math.max(0, Math.min(100, parts[k])) / 100);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${brand}"
        data-tip="${esc(labelOf(k) + '\n' + (+parts[k]).toFixed(1) + ' / 100')}"/>`;
    });
    keys.forEach((k, i) => {
      const [x, y] = pt(i, 1.22);
      const a = ang(i);
      const anchor = Math.abs(Math.cos(a)) < 0.25 ? 'middle'
        : Math.cos(a) > 0 ? 'start' : 'end';
      s += `<text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="${anchor}"
        font-size="10" fill="${css('--ink-3')}">${esc(labelOf(k))}</text>`;
      s += `<text x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}" text-anchor="${anchor}"
        font-size="9.5" font-weight="600" fill="${css('--ink-2')}">${(+parts[k]).toFixed(0)}</text>`;
    });
    return s + '</svg>';
  }
  const LABELS = {
    win_rate: 'Win %', profit_factor: 'Profit factor', avg_win_loss: 'Avg win/loss',
    max_drawdown: 'Max drawdown', recovery_factor: 'Recovery', consistency: 'Consistency',
  };
  const labelOf = (k) => LABELS[k] || k;

  /* ---------------- heatmap ---------------- */
  function heatmap(days, opts) {
    opts = opts || {};
    const cell = 12, gap = 3, rows = 7;
    const byDate = {};
    days.forEach((d) => { byDate[d.date] = d; });
    const dates = days.map((d) => d.date).sort();
    if (!dates.length) return emptySvg(400, 110);

    const start = new Date(dates[0] + 'T00:00:00Z');
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    const weeks = Math.ceil((end - start) / (7 * 864e5)) + 1;
    const W = weeks * (cell + gap) + 30, H = rows * (cell + gap) + 20;

    const vals = days.map((d) => Math.abs(d.net_pnl)).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    const pos = css('--pos'), neg = css('--neg');

    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d, i) => {
      if (i % 2) return;
      s += `<text x="0" y="${i * (cell + gap) + cell}" font-size="8.5"
        fill="${css('--ink-3')}">${d}</text>`;
    });
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start.getTime() + (w * 7 + d) * 864e5);
        const key = dt.toISOString().slice(0, 10);
        const rec = byDate[key];
        let fill = css('--line'), op = 1, tip = key + '\nno trades';
        if (rec) {
          const inten = 0.25 + 0.75 * Math.min(1, Math.abs(rec.net_pnl) / max);
          fill = rec.net_pnl >= 0 ? pos : neg;
          op = inten;
          tip = key + '\n' + money(rec.net_pnl) + '\n' + rec.trades + ' trade(s)';
        }
        s += `<rect x="${w * (cell + gap) + 14}" y="${d * (cell + gap)}"
          width="${cell}" height="${cell}" rx="2.5" fill="${fill}" opacity="${op}"
          data-tip="${esc(tip)}"/>`;
      }
    }
    return s + '</svg>';
  }

  function emptySvg(W, H) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12"
      fill="${css('--ink-3')}">No data yet</text></svg>`;
  }

  global.Charts = { areaChart, barChart, donut, radar, heatmap, money, esc };
})(window);
