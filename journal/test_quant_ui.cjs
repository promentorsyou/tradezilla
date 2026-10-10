const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('../coinbase-quant-pro/apps/web/node_modules/playwright');
test('decision-first Quant UI, all markets/timeframes, independence and failures',async()=>{
 const docs=path.resolve(__dirname,'../docs');
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;const file=path.join(docs,name==='/'?'index.html':name);if(!file.startsWith(docs+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',file.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));const url=`http://127.0.0.1:${server.address().port}/#/quant`;
 await p.goto(url);await p.waitForSelector('#qp-ranking tr');assert.equal(await p.locator('#qp-ranking tr').count(),6);
 assert.match(await p.locator('.qp-best').innerText(),/NO QUALIFIED TRADE/);
 await p.evaluate(()=>window.testCanvas=document.querySelector('#qp-chart canvas'));
 for(const coin of ['XRP','BTC','ETH','SOL','ADA','ZEC']){
  await p.locator(`[data-coin="${coin}-USDC"]`).click();assert.equal(await p.locator('#qp-product').inputValue(),coin+'-USDC');
  for(const f of ['1m','5m','15m','1H','4H','1D','1W']){await p.locator(`[data-frame="${f}"]`).click();assert.match(await p.locator('#qp-quality').innerText(),new RegExp(f));}
 }
 assert.ok(await p.evaluate(()=>window.testCanvas===document.querySelector('#qp-chart canvas')),'Chart canvas retained through market/timeframe changes');
 await p.locator('[data-coin="XRP-USDC"]').click();await p.locator('#qp-budget').fill('50000');await p.locator('#qp-budget').dispatchEvent('change');
 await p.locator('[data-target="200"]').click();await p.locator('#qp-hold').selectOption('15');await p.locator('#qp-sort').selectOption('spread');
 for(const [id,v] of [['entry','1.4'],['stop','1.38'],['slip','0'],['maker','0.075']]){await p.locator('#qp-'+id).fill(v);await p.locator('#qp-'+id).dispatchEvent('change');}
 assert.match(await p.locator('#qp-calculation').innerText(),/Maker risk-limited/);assert.doesNotMatch(await p.locator('#qp-calculation').innerText(),/invariant|Check positive/);
 await p.locator('#qp-plan-overlay').click();assert.equal(await p.locator('#qp-plan-overlay').getAttribute('aria-pressed'),'true');
 await p.locator('#qp-indicators').click();await p.locator('#qp-zones').click();await p.locator('#qp-reload').click();
 assert.ok(await p.evaluate(()=>window.testCanvas===document.querySelector('#qp-chart canvas')));
 await p.locator('#qp-budget').focus();await p.keyboard.press('Tab');assert.equal(await p.locator('#qp-target').evaluate(el=>el===document.activeElement),true);
 await p.screenshot({path:path.join(docs,'../coinbase-quant-pro/docs/upgrade-desktop.png'),fullPage:true});
 await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(docs,'../coinbase-quant-pro/docs/upgrade-mobile.png'),fullPage:true});
 // Public research must mount without any portfolio payload.
 const independent=await context.newPage();independent.on('pageerror',e=>errors.push(e.message));
 await independent.route('**/*',route=>{if(route.request().resourceType()==='document'){let html=fs.readFileSync(path.join(docs,'index.html'),'utf8').replace(/window\.__REPORT__ = [\s\S]*?;<\/script>/,'window.__REPORT__ = null;</script>');return route.fulfill({contentType:'text/html',body:html});}return route.continue();});
 await independent.goto(url);await independent.waitForSelector('#qp-ranking tr');assert.equal(await independent.locator('#qp-ranking tr').count(),6);
 const failed=await context.newPage();await failed.route('**/quant-data.json*',r=>r.fulfill({status:503,body:'unavailable'}));await failed.goto(url);await failed.waitForFunction(()=>document.querySelector('#qp-error')?.textContent.includes('unavailable'));assert.match(await failed.locator('.qp-best').innerText(),/WAIT/);
 assert.deepEqual(errors,[]);console.log('Six markets × seven frames; chart identity; planning; sorting; keyboard; mobile; independent public load; failure state: PASS');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
