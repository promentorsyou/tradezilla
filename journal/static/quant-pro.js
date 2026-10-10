/* Public browser research. No API key, account endpoint, or order submission. */
(() => {
  'use strict';
  const seconds = {'1m':60,'5m':300,'15m':900,'1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800};
  const fmt = (n, digits = 4) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits});
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const utc = value => value ? new Date(value).toISOString().replace('T',' ').slice(0,19) + ' UTC' : 'Not received';
  let cleanup = () => {};

  function analyze(input, frame) {
    let rows = input.slice(), discarded = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].time - rows[i-1].time !== seconds[frame]) discarded = i;
    rows = rows.slice(discarded);
    const ema = period => {
      let value = rows[0]?.close;
      return rows.map((r,i) => { value = i ? r.close * 2/(period+1) + value*(1-2/(period+1)) : value; return {time:r.time,value:i >= period-1 ? value : null}; });
    };
    const e20 = ema(20), e50 = ema(50), e200 = ema(200);
    let gain = 0, loss = 0, atr = 0;
    const rsi = [], atrs = [];
    rows.forEach((r,i) => {
      const tr = i ? Math.max(r.high-r.low,Math.abs(r.high-rows[i-1].close),Math.abs(r.low-rows[i-1].close)) : r.high-r.low;
      if(i<14) atr += tr/14; else atr = (atr*13+tr)/14;
      atrs.push(i>=13?atr:null);
      if(i){const change=r.close-rows[i-1].close;if(i<=14){gain+=Math.max(change,0)/14;loss+=Math.max(-change,0)/14;}else{gain=(gain*13+Math.max(change,0))/14;loss=(loss*13+Math.max(-change,0))/14;}}
      rsi.push({time:r.time,value:i<14?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss)});
    });
    const last = rows.at(-1), currentATR = atrs.at(-1), tolerance = Math.max((currentATR||last?.close*.005||0)*.35,(last?.close||0)*.001);
    const points=[];
    for(let i=3;i<rows.length-3;i++)for(const [key,fn] of [['high',Math.max],['low',Math.min]]){
      if(rows[i][key]===fn(...rows.slice(i-3,i+4).map(r=>r[key])))points.push({price:rows[i][key],index:i,volume:rows[i].volume});
    }
    const clusters=[];
    for(const p of points.sort((a,b)=>a.price-b.price)){
      const c=clusters.at(-1);if(c&&Math.abs(p.price-c.reduce((s,x)=>s+x.price,0)/c.length)<=tolerance)c.push(p);else clusters.push([p]);
    }
    const averageVolume=rows.reduce((s,r)=>s+r.volume,0)/Math.max(rows.length,1);
    const zones=clusters.map(c=>{
      const mid=c.reduce((s,r)=>s+r.price*Math.max(r.volume,1),0)/c.reduce((s,r)=>s+Math.max(r.volume,1),0);
      const recency=Math.exp(-(rows.length-1-Math.max(...c.map(r=>r.index)))/100);
      const volume=c.reduce((s,r)=>s+r.volume,0)/c.length/Math.max(averageVolume,1e-12);
      return {lower:mid-tolerance/2,upper:mid+tolerance/2,touches:c.length,strength:Math.min(40,c.length*10)+Math.round(30*recency)+Math.round(Math.min(30,volume*15)),type:mid<last.close?'support':'resistance'};
    }).filter(z=>z.upper<last.close||z.lower>last.close);
    const nearest=['support','resistance'].flatMap(side=>zones.filter(z=>z.type===side).sort((a,b)=>Math.abs((a.lower+a.upper)/2-last.close)-Math.abs((b.lower+b.upper)/2-last.close)).slice(0,3));
    const a=e20.at(-1)?.value,b=e50.at(-1)?.value;
    return {rows,e20,e50,e200,rsi,atr:currentATR,zones:nearest,discarded,trend:a!=null&&b!=null?(a>b?'Bullish':'Bearish'):'Insufficient history'};
  }

  function mount(root) {
    cleanup();
    let gone=false, chart, series, priceLine, socket, reconnect, connection=0, lastHeartbeat=0,lastTicker=0,lastSequence=null, lastPrice=null,lastExchangeTime=0;
    let snapshot=null, productId='XRP-USDC', frame='5m', indicators=true, showZones=true, request=null, feedStatus='CONNECTING';
    let volumeSeries,rsiSeries,emaSeries={},zoneSeries=[],planLines=[],chartKey='';
    let bookBids=new Map(),bookAsks=new Map(),bookTime=0,bookReady=false,lastHealthDraw=0;
    const $ = sel => root.querySelector(sel);
    root.innerHTML = `<section class="qp-shell">
      <div class="qp-intro"><div><span class="qp-eyebrow">TRADEZILLA / MARKET INTELLIGENCE</span><h2>Coinbase <em>Quant Pro</em></h2><p>Public spot research. Real market data. No order execution.</p></div><div class="qp-badges"><span class="qp-readonly">◈ READ ONLY</span><span id="qp-live" class="qp-status">CONNECTING</span></div></div>
      <div class="qp-warning" id="qp-error" hidden role="alert"></div>
      <div class="qp-tools"><label>SPOT MARKET <select id="qp-product" aria-label="Quant Pro market"><option>Loading markets…</option></select></label><div id="qp-frames">${Object.keys(seconds).map(f=>`<button data-frame="${f}" class="${f===frame?'active':''}">${f}</button>`).join('')}</div><button id="qp-reload">↻ Refresh snapshot</button></div>
      <div class="qp-market"><div><label>LAST PRICE · USD ALIAS TICKER</label><strong id="qp-price">—</strong><small id="qp-price-time">Awaiting Coinbase feed</small></div><div><label>24H CHANGE · USDC SNAPSHOT</label><strong id="qp-change">—</strong></div><div><label>BASE VOLUME · USDC SNAPSHOT</label><strong id="qp-volume">—</strong></div><div><label>LIVE FEED SOURCE</label><strong id="qp-alias">—</strong><small>USD proxy, not a USDC executable quote</small></div></div>
      <div class="qp-layout"><section class="qp-panel"><div class="qp-chart-controls"><div><button id="qp-indicators" aria-pressed="true">● EMA 20 / 50 / 200</button><button id="qp-zones" aria-pressed="true">● Reaction zones</button></div><span id="qp-ohlc">Completed candles · live price marker</span></div><div id="qp-chart"></div><p class="qp-chart-note">Candles: scheduled Coinbase history, not tick-built bars. Purple pane: RSI 14. <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>.</p></section>
      <aside><section class="qp-panel qp-decision"><label>ANALYTICAL STATE</label><h3>WAIT</h3><h4>Evidence before action.</h4><p>No validated forecasting model or measured execution edge is hosted. Hypothetical levels are arithmetic and rule outputs, not predictions.</p><div id="qp-evidence"></div><span class="qp-untrained">MODELS NOT VALIDATED</span></section><section class="qp-panel qp-history"><h4>Data health</h4><p id="qp-snapshot">Loading GitHub-published public snapshot…</p><p id="qp-quality"></p><small>GitHub is configured for 5-minute snapshots, but runs can be delayed. Live ticker is independent of that schedule.</small></section></aside></div>
      <div class="qp-bottom"><section class="qp-panel"><h4>Multi-timeframe analysis</h4><div class="qp-table-wrap"><table><thead><tr><th>Period</th><th>Trend</th><th>RSI</th><th>Support</th><th>Resistance</th><th>History</th></tr></thead><tbody id="qp-mtf"></tbody></table></div><p class="qp-chart-note">Completed candles only. Indicators use the uninterrupted recent segment. Correlated indicators are not independent evidence.</p></section><section class="qp-panel qp-levels"><h4>Nearest reaction zones <span id="qp-zone-frame">1H</span></h4><div id="qp-levels"></div><p class="qp-chart-note">Descriptive score: touches (40) + recency (30) + pivot volume (30). Not a reversal probability. Candidate zones, not confirmed reversal promises.</p></section></div>
      <p class="qp-disclaimer">Independent research software, not affiliated with Coinbase. No private account connection. No trading, leverage, shorting, or order submission.</p>
    </section>`;

    const workbench=window.QuantWorkbench.mount(root, id=>{
      stopSocket();productId=id;frame='5m';lastPrice=null;$('#qp-product').value=id;
      $('#qp-frames').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.frame===frame));draw();connect();
    }, levels=>{
      if(!series)return;
      for(const line of planLines)series.removePriceLine(line);planLines=[];
      for(const [title,price,color] of levels)if(Number(price)>0)planLines.push(series.createPriceLine({price:Number(price),color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title}));
    });

    const metadata=()=>snapshot?.products.find(p=>p.product_id===productId);
    const precision=()=>Math.max(2,Math.ceil(-Math.log10(Number(metadata()?.increment||'.0001'))));
    const status = s => {feedStatus=s;$('#qp-live').textContent=s;$('#qp-live').className='qp-status '+s.toLowerCase();if(priceLine)priceLine.applyOptions({title:s==='LIVE'?'LIVE PRICE':'LAST PRICE',color:s==='LIVE'?'#77a2ff':'#9b91aa'});};
    const error = message => {$('#qp-error').hidden=!message;$('#qp-error').textContent=message||'';};
    const stopSocket=()=>{connection++;clearTimeout(reconnect);if(socket){socket.onclose=null;socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.close();socket=null;}lastHeartbeat=0;lastTicker=0;lastSequence=null;bookReady=false;bookBids.clear();bookAsks.clear();};
    const health=()=>{
      if(gone)return;
      if(socket?.readyState===WebSocket.OPEN&&lastTicker){const age=Date.now()-lastExchangeTime;status(lastHeartbeat&&Date.now()-lastHeartbeat<12000&&Date.now()-lastTicker<30000&&age>=-5000&&age<30000?'LIVE':lastHeartbeat?'STALE':'CONNECTING');}
      if(snapshot){const age=Math.max(0,(Date.now()-Date.parse(snapshot.generated_at))/60000);$('#qp-snapshot').textContent=`Snapshot ${utc(snapshot.generated_at)} · ${Math.floor(age)} minutes old${age>15?' · STALE SNAPSHOT':''}`;$('#qp-snapshot').classList.toggle('qp-stale',age>15);}
      if(snapshot&&Date.now()-lastHealthDraw>3000){lastHealthDraw=Date.now();workbench.update(snapshot,productId,bookReady?{product_id:metadata().alias,time:new Date(bookTime).toISOString(),bids:[...bookBids].map(([price,size])=>({price,size})),asks:[...bookAsks].map(([price,size])=>({price,size})),live:Date.now()-lastHeartbeat<12000&&socket?.readyState===WebSocket.OPEN}:null);}
    };
    function connect(attempt=0){
      if(gone||!metadata())return;
      const session=++connection;status('CONNECTING');lastSequence=null;lastHeartbeat=0;lastTicker=0;bookReady=false;bookBids.clear();bookAsks.clear();
      socket=new WebSocket('wss://advanced-trade-ws.coinbase.com');
      socket.onopen=()=>{if(gone||session!==connection)return;for(const channel of ['heartbeats','ticker','level2'])socket.send(JSON.stringify({type:'subscribe',channel,product_ids:[metadata().alias]}));};
      socket.onmessage=event=>{
        if(gone||session!==connection)return;
        try {
          const message=JSON.parse(event.data);
          if(message.type==='error'){status('DISCONNECTED');socket.close();return;}
          if(message.sequence_num!=null){if(lastSequence!=null&&message.sequence_num>lastSequence+1){status('STALE');socket.close();loadSnapshot();return;}if(lastSequence!=null&&message.sequence_num<=lastSequence)return;lastSequence=message.sequence_num;}
          if(message.channel==='heartbeats'){lastHeartbeat=Date.now();health();}
          if(message.channel==='l2_data')for(const e of message.events||[]){
            if(e.product_id!==metadata().alias)continue;
            if(e.type==='snapshot'){bookBids.clear();bookAsks.clear();bookReady=true;}
            if(!bookReady)continue;
            for(const u of e.updates||[]){const side=u.side==='bid'?bookBids:bookAsks;if(Number(u.new_quantity)===0)side.delete(u.price_level);else if(Number(u.new_quantity)>0&&Number(u.price_level)>0)side.set(u.price_level,u.new_quantity);}
            bookTime=Date.parse(message.timestamp);
          }
          if(message.channel==='ticker')for(const event of message.events||[])for(const tick of event.tickers||[]){
            if(tick.product_id!==metadata().alias)continue;
            const price=Number(tick.price),age=Date.now()-Date.parse(message.timestamp);
            if(!Number.isFinite(price)||price<=0)continue;
            lastTicker=Date.now();lastExchangeTime=Date.parse(message.timestamp);lastPrice=price;attempt=0;status(age>=-5000&&age<30000&&lastHeartbeat&&Date.now()-lastHeartbeat<12000?'LIVE':lastHeartbeat?'STALE':'CONNECTING');
            $('#qp-price').textContent=fmt(price,precision());$('#qp-price-time').textContent=`Ticker ${utc(message.timestamp)}`;
            if(priceLine)priceLine.applyOptions({price});
            else if(series)priceLine=series.createPriceLine({price,color:'#77a2ff',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:feedStatus==='LIVE'?'LIVE PRICE':'LAST PRICE'});
          }
        }catch{status('DISCONNECTED');socket.close();}
      };
      socket.onerror=()=>{if(session===connection)socket?.close();};
      socket.onclose=()=>{if(!gone&&session===connection){status('DISCONNECTED');reconnect=setTimeout(()=>connect(attempt+1),Math.min(1000*2**Math.min(attempt,5),30000));}};
    }

    function draw(){
      const p=metadata();if(!p||gone)return;
      const rows=p.frames[frame]||[];if(!rows.length){error('No candles are available for this market and timeframe.');return;}
      const data=analyze(rows,frame),dp=precision();
      workbench.update(snapshot,productId);
      if(!lastTicker){$('#qp-price').textContent=fmt(p.price,dp);$('#qp-price-time').textContent='Snapshot price · not live';}
      $('#qp-change').textContent=fmt(p.change,2)+'%';$('#qp-change').className=Number(p.change)>=0?'qp-up':'qp-down';$('#qp-volume').textContent=fmt(p.volume,0);$('#qp-alias').textContent=p.alias;
      $('#qp-quality').textContent=`Last completed ${frame} candle closed ${utc(new Date((rows.at(-1).time+seconds[frame])*1000))}. Forming candle: unavailable. ${data.rows.length} bars used. ${data.discarded?`${data.discarded} older bars excluded at a gap. `:''}${data.rows.length<200?'EMA 200 unavailable: fewer than 200 uninterrupted bars.':''}`;
      $('#qp-evidence').innerHTML=`<p>${esc(data.trend)} EMA20/50 alignment</p><p>RSI14: ${fmt(data.rsi.at(-1)?.value,1)}</p><p>No calibrated predictive confidence</p>`;
      $('#qp-mtf').innerHTML=Object.keys(seconds).map(f=>{const a=analyze(p.frames[f]||[],f);return `<tr><td>${f}</td><td>${esc(a.trend)}</td><td>${fmt(a.rsi.at(-1)?.value,1)}</td><td>${fmt(a.zones.find(z=>z.type==='support')?.upper,dp)}</td><td>${fmt(a.zones.find(z=>z.type==='resistance')?.lower,dp)}</td><td>${a.rows.length} bars${a.discarded?' · gap trimmed':''}</td></tr>`;}).join('');
      $('#qp-zone-frame').textContent=frame;
      $('#qp-levels').innerHTML=data.zones.map(z=>`<div class="qp-zone"><div><span class="${z.type==='support'?'qp-up':'qp-orange'}">${z.type.toUpperCase()}</span><strong>${fmt(z.lower,dp)} – ${fmt(z.upper,dp)}</strong></div><div>${z.strength}<small>/100</small><i style="width:${z.strength}%;background:${z.type==='support'?'#25c8a3':'#eea169'}"></i></div></div>`).join('')||'<p>No confirmed pivot clusters available.</p>';
      if(!window.LightweightCharts){error('Chart library unavailable. Reload the page; data is not simulated.');return;}
      const L=window.LightweightCharts;
      const same=chartKey===productId+frame,range=same?chart?.timeScale().getVisibleRange():null;
      if(!chart){
        chart=L.createChart($('#qp-chart'),{height:510,autoSize:true,localization:{locale:'en-US'},layout:{background:{type:'solid',color:'#0f1829'},textColor:'#8d9eb9',fontSize:11},grid:{vertLines:{color:'#19253a'},horzLines:{color:'#1b293e'}},rightPriceScale:{borderColor:'#2a3b55'}});
        series=chart.addSeries(L.CandlestickSeries,{upColor:'#25c8a3',downColor:'#f2758e',wickUpColor:'#25c8a3',wickDownColor:'#f2758e',borderVisible:false});
        volumeSeries=chart.addSeries(L.HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume'});volumeSeries.priceScale().applyOptions({scaleMargins:{top:.84,bottom:0}});
        for(const [key,color] of [['e20','#69a0ff'],['e50','#ba8dff'],['e200','#f5c577']])emaSeries[key]=chart.addSeries(L.LineSeries,{color,lineWidth:1,priceLineVisible:false,lastValueVisible:false});
        rsiSeries=chart.addSeries(L.LineSeries,{color:'#ba8dff',lineWidth:1,priceLineVisible:false},1);
        for(const price of [30,70])rsiSeries.createPriceLine({price,color:'#4b5373',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:''});chart.panes()[0].setHeight(400);chart.panes()[1].setHeight(110);
        chart.subscribeCrosshairMove(param=>{const r=param.seriesData.get(series);if(r&&'open'in r)$('#qp-ohlc').textContent=`O ${fmt(r.open,precision())} H ${fmt(r.high,precision())} L ${fmt(r.low,precision())} C ${fmt(r.close,precision())}`;});
      }
      if(!same&&priceLine){series.removePriceLine(priceLine);priceLine=null;}
      chart.applyOptions({timeScale:{timeVisible:seconds[frame]<86400,borderColor:'#2a3b55'}});
      series.applyOptions({priceFormat:{type:'price',precision:dp,minMove:Number(p.increment)}});series.setData(rows);
      volumeSeries.setData(rows.map(r=>({time:r.time,value:r.volume,color:r.close>=r.open?'#1f655b':'#69394c'})));
      for(const key of Object.keys(emaSeries)){emaSeries[key].setData(data[key].filter(r=>r.value!=null));emaSeries[key].applyOptions({visible:indicators});}
      for(const z of zoneSeries)chart.removeSeries(z);zoneSeries=[];
      if(showZones)for(const z of data.zones){const color=z.type==='support'?'#25c8a3':'#eea169';const band=chart.addSeries(L.BaselineSeries,{baseValue:{type:'price',price:z.lower},topLineColor:color,topFillColor1:color+'18',topFillColor2:color+'18',bottomLineColor:color,priceLineVisible:false,lastValueVisible:false,autoscaleInfoProvider:()=>null});band.setData([{time:rows[0].time,value:z.upper},{time:rows.at(-1).time,value:z.upper}]);zoneSeries.push(band);}
      rsiSeries.setData(data.rsi.filter(r=>r.value!=null));
      if(range)chart.timeScale().setVisibleRange(range);else chart.timeScale().setVisibleLogicalRange({from:Math.max(0,rows.length-120),to:rows.length+8});chartKey=productId+frame;
      if(lastPrice&&feedStatus==='LIVE'&&!priceLine)priceLine=series.createPriceLine({price:lastPrice,color:'#77a2ff',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:'LIVE ALIAS PRICE'});
      workbench.overlay();
    }

    async function loadSnapshot(){
      if(gone||request)return;
      request=new AbortController();
      try{
        const url=new URL('quant-data.json',location.href.split('#')[0]);url.search='v='+Math.floor(Date.now()/60000);
        const response=await fetch(url,{cache:'no-store',signal:request.signal});
        if(!response.ok)throw new Error('Snapshot HTTP '+response.status);
        const data=await response.json();
        if(data.version!==1||!Array.isArray(data.products)||!Number.isFinite(Date.parse(data.generated_at)))throw new Error('Invalid public snapshot');
        if(gone)return;
        const products=data.products.filter(p=>p.available&&/^[A-Z0-9]+-[A-Z0-9]+$/.test(p.product_id));
        if(!products.length)throw new Error('No active spot products in the snapshot');
        const first=!snapshot,changed=!snapshot||snapshot.generated_at!==data.generated_at;
        snapshot=data;error('');
        if(!products.some(p=>p.product_id===productId))productId=products[0].product_id;
        $('#qp-product').innerHTML=products.map(p=>`<option value="${esc(p.product_id)}"${p.product_id===productId?' selected':''}>${esc(p.product_id)}</option>`).join('');
        if(changed)draw();health();if(first)connect();
      }catch(exc){if(!gone&&exc.name!=='AbortError')error(`Public research snapshot unavailable: ${exc.message}. Portfolio data is unaffected; no fake market data is substituted.`);}
      finally{request=null;}
    }
    $('#qp-product').onchange=event=>{stopSocket();productId=event.target.value;lastPrice=null;draw();connect();};
    $('#qp-frames').onclick=event=>{const next=event.target.dataset.frame;if(!seconds[next])return;frame=next;$('#qp-frames').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.frame===frame));draw();};
    $('#qp-indicators').onclick=()=>{indicators=!indicators;$('#qp-indicators').setAttribute('aria-pressed',String(indicators));draw();};
    $('#qp-zones').onclick=()=>{showZones=!showZones;$('#qp-zones').setAttribute('aria-pressed',String(showZones));draw();};
    $('#qp-reload').onclick=loadSnapshot;
    const healthTimer=setInterval(health,1000),refreshTimer=setInterval(loadSnapshot,60000);
    cleanup=()=>{gone=true;stopSocket();request?.abort();clearInterval(healthTimer);clearInterval(refreshTimer);workbench.destroy();chart?.remove();cleanup=()=>{};};
    loadSnapshot();
  }
  window.QuantPro={mount,destroy:()=>cleanup(),analyze};
})();
