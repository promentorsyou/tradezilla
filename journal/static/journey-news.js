/* Public-only summaries of existing ChatGPT research; no account or news API. */
window.JourneyNews = (() => {
  let root, report, timer, request, data, failed = false, selected = 'all', lastFetch = 0;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = v => new Date(v).toLocaleString();
  const link = v => {try {const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !['chatgpt.com','localhost'].includes(u.hostname);} catch {return false;}};
  function paint() {
    if (!root?.isConnected) return;
    const reports = data?.reports || [], latest = reports[0], age = Date.now() - Date.parse(latest?.researched_at);
    const fresh = !failed && age >= 0 && age <= 5400000;
    const coins = [...new Set(['BTC','ETH','SOL','XRP','ZEC','ADA', ...(report?.trades || []).map(t => t.symbol)])].filter(s => /^[A-Z0-9]{2,12}$/.test(s));
    const matches = r => r.items.filter(i => selected === 'all' || i.symbols.includes(selected) || i.symbols.includes('MARKET'));
    const cards = r => matches(r).map(i => `<article class="news-item"><small>${esc(i.symbols.join(' · '))} · ${esc(i.source_time)}</small><h3>${esc(i.title)}</h3><p>${esc(i.summary)}</p><p class="muted">${esc(i.caveat)}</p><p>${i.sources.filter(s => link(s.url)).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)} ↗</a>`).join(' · ')}</p></article>`).join('') || '<p>No sourced coverage for this coin in this report. This does not mean there is no news.</p>';
    root.innerHTML = `<div class="news-head"><div><span class="news-eyebrow">EXISTING CHATGPT RESEARCH · NO NEW NEWS API</span><h2>Trading Journey research</h2></div><button class="btn" id="journey-check" ${request ? 'disabled' : ''}>${request ? 'Checking…' : 'Check research updates'}</button></div>
      <p role="status" class="journey-status ${fresh ? '' : 'warn'}">${fresh ? 'RECENT REPORT' : 'STALE / UNAVAILABLE'}${latest ? ` · Research ${esc(date(latest.researched_at))} · ${Math.max(0,Math.floor(age/60000))} min old` : ' · No imported report yet'}</p>
      <p class="muted">Hourly import is scheduled through the signed-in desktop session; computer and app must be running. Browser checks publication every minute. Reports older than 90 minutes move to history, not current news. Importing does not make the underlying sources newer.</p>
      <p class="muted">AI research copied from Trading Journey, not independently verified by TradeZilla. Source dates may predate the report. No personal holdings, orders or trade instructions are published here.</p>
      <label>Coin coverage <select id="journey-filter"><option value="all">All researched coins + market risks</option>${coins.map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
      <div class="journey-current">${fresh ? cards(latest) : '<p>No current research displayed. Read archived reports only as historical context.</p>'}</div>
      <details class="journey-history"><summary>Research history (${reports.length} reports)</summary>${reports.map(r => `<details><summary>${esc(date(r.researched_at))} — historical report</summary>${cards(r)}</details>`).join('')}</details>`;
    root.querySelector('#journey-filter').value = selected;
    root.querySelector('#journey-filter').onchange = e => {selected = e.target.value; paint();};
    root.querySelector('#journey-check').onclick = refresh;
  }
  function valid(d) {
    return d?.schema_version === 1 && Array.isArray(d.reports) && d.reports.length <= 168 && d.reports.every(r =>
      Number.isFinite(Date.parse(r.researched_at)) && Array.isArray(r.items) && r.items.length <= 30 && r.items.every(i =>
        ['title','summary','source_time','caveat'].every(k => typeof i[k] === 'string') && Array.isArray(i.symbols) && i.symbols.every(s => typeof s === 'string') && Array.isArray(i.sources) && i.sources.length > 0 && i.sources.every(s => typeof s.label === 'string' && link(s.url))));
  }
  async function refresh() {
    if (!root || request) return;
    const controller = new AbortController(); request = controller; lastFetch = Date.now(); paint();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL('journey-news.json', location.href); url.hash = ''; url.search = `v=${Date.now()}`;
      const res = await fetch(url, {cache:'no-store', signal:controller.signal});
      if (!res.ok) throw Error('Unavailable');
      const next = await res.json(); if (!valid(next)) throw Error('Invalid research');
      if (request !== controller) return;
      data = {...next, reports:[...next.reports].sort((a,b) => Date.parse(b.researched_at)-Date.parse(a.researched_at))}; failed = false;
    } catch {if (request === controller) failed = true;}
    finally {clearTimeout(timeout); if (request === controller) {request = null; paint();}}
  }
  function destroy() {clearInterval(timer); request?.abort(); request = null; root = null;}
  function mount(el, portfolio) {destroy(); root = el; report = portfolio; selected = 'all'; paint(); refresh(); timer = setInterval(() => {paint(); if (Date.now()-lastFetch >= 60000) refresh();}, 15000);}
  document.addEventListener('visibilitychange', () => {if (!document.hidden && root) refresh();});
  return {mount, destroy};
})();
