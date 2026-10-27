/* Public news context, never an execution signal. No account data leaves this module. */
window.TradeNews = (() => {
  let root, timer, request, report, snapshot, failed = false, selection = 'all', lastFetch = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const domains = ['coindesk.com', 'cointelegraph.com', 'federalreserve.gov'];
  function safeLink(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && domains.some(d => u.hostname === d || u.hostname.endsWith('.'+d)); } catch { return false; }
  }
  function time(value) { return new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); }
  function paint() {
    if (!root?.isConnected) return;
    const now = Date.now(), age = now - Date.parse(snapshot?.fetched_at);
    const fresh = !failed && Number.isFinite(age) && age >= -60000 && age <= 1800000;
    const held = [...new Set((report?.trades || []).filter(t => t.status === 'OPEN').map(t => t.symbol))];
    const candidates = fresh ? snapshot.articles.filter(a => {
      const age = now - Date.parse(a.published_at);
      return age >= 0 && age <= 86400000 && safeLink(a.url) && snapshot.sources.some(s => s.source === a.source && s.ok);
    }) : [];
    const rows = candidates.filter(a => selection === 'all' || (selection === 'held' ? a.symbols.some(s => held.includes(s)) || a.topic === 'Policy / macro' : a.symbols.includes(selection)));
    const failedSources = snapshot?.sources.filter(s => !s.ok).map(s => s.source) || [];
    const events = fresh && snapshot.calendar_ok ? snapshot.events.filter(e => e.end_date >= new Date().toISOString().slice(0,10) && safeLink(e.url)) : [];
    root.innerHTML = `<div class="news-head"><div><span class="news-eyebrow">DECISION CONTEXT · PUBLIC SOURCES</span><h2>Crypto news & event watch</h2></div><button type="button" class="btn" id="news-check">Check updates</button></div>
      <p class="news-status ${fresh ? '' : 'warn'}" role="status">${fresh ? `Feeds checked ${esc(time(snapshot.fetched_at))} · ${Math.max(0,Math.floor(age/60000))} min ago` : 'NEWS UNAVAILABLE / STALE — current headlines hidden; do not interpret this as no market risk.'}${failedSources.length ? ' · Missing sources: '+esc(failedSources.join(', ')) : ''}</p>
      <p class="muted">Rolling 24-hour headlines. Browser checks every minute; cloud collection is scheduled every 5 minutes and may be delayed. Feeds expire after 30 minutes. Publisher delays and incomplete coverage remain possible.</p>
      <label>News relevance <select id="news-filter"><option value="all">All crypto news</option><option value="held">Open positions + macro</option>${held.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></label>
      <div class="news-layout"><div><div class="news-list">${rows.slice(0,12).map(a => `<article class="news-item"><div class="news-meta">${esc(a.source)} · ${esc(time(a.published_at))} · ${esc(a.topic)}</div><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)} ↗</a><small>${a.symbols.length ? esc(a.symbols.join(' · ')) : 'General crypto coverage'} · Headline-based tags, not verified impact</small></article>`).join('') || '<p class="empty">No current headlines match this selection. This does not mean there is no relevant news.</p>'}</div><p class="muted">Publisher headlines and links only. Reports, opinions and forecasts are not independently verified; read the source and corroborate material claims. No automatic bullish/bearish scores.</p></div>
      <aside class="news-context"><h3>Upcoming catalysts</h3>${events.map(e => `<p><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)} · ${esc(e.start_date)} – ${esc(e.end_date)}</a><small>${esc(e.note)}</small></p>`).join('') || '<p>No freshly verified upcoming FOMC dates available.</p>'}<p><a href="https://www.bls.gov/schedule/" target="_blank" rel="noopener noreferrer">Official inflation & jobs calendar ↗</a></p><p class="muted">BLS dates are not imported. Check the official calendar. Unscheduled news cannot be predicted.</p>
      <h3>Before buying, holding or selling</h3><ul><li><b>Buy:</b> Verify the catalyst at its original source. Check spread, liquidity, fees and your maximum loss; avoid chasing a headline.</li><li><b>Hold:</b> Is your original thesis still valid? Recheck position concentration and your planned exit.</li><li><b>Sell / reduce:</b> Review whether the thesis or risk limit was invalidated. Compare net exit proceeds after fees—not only the price move.</li></ul><p>Use <a href="#/live">Running Trades</a> for snapshot-based maker/taker breakeven, or <a href="#/quant">Quant Pro</a> for market checks. News alone cannot determine an appropriate trade or guarantee returns.</p></aside></div>`;
    root.querySelector('#news-filter').value = selection;
    root.querySelector('#news-filter').onchange = e => { selection = e.target.value; paint(); };
    root.querySelector('#news-check').onclick = refresh;
    root.querySelector('#news-check').disabled = !!request;
  }
  async function refresh() {
    if (!root || request) return;
    const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000); lastFetch = Date.now();
    try {
      const url = new URL('news-data.json', location.href); url.hash = ''; url.search = `v=${Date.now()}`;
      const response = await fetch(url, {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('News unavailable');
      const data = await response.json();
      if (data.schema_version !== 1 || !Array.isArray(data.articles) || !Array.isArray(data.sources) || !Array.isArray(data.events)) throw new Error('Invalid news snapshot');
      if (request !== controller) return;
      snapshot = data; failed = false;
    } catch { if (request === controller) failed = true; }
    finally { clearTimeout(timeout); if (request === controller) {request = null; paint();} }
  }
  function destroy() { clearInterval(timer); request?.abort(); request = null; root = null; }
  function mount(element, data) {
    destroy(); root = element; report = data; selection = 'all'; paint(); refresh();
    timer = setInterval(() => {paint(); if (Date.now()-lastFetch >= 60000) refresh();}, 15000);
  }
  document.addEventListener('visibilitychange', () => {if (!document.hidden && root) {paint(); refresh();}});
  return {mount, destroy};
})();
