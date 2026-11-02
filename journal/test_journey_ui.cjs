const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '../coinbase-quant-pro/apps/web/node_modules/playwright');
test('Journey research on both routes, timestamps, filtering, expiry, errors and mobile',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../docs/index.html'));
 const now=Date.now(); let unavailable=false;
 let data={schema_version:1,reports:[{researched_at:new Date(now-1000).toISOString(),items:[{title:'BTC public research',summary:'Attributed summary',symbols:['BTC'],source_time:'Previous trading session',caveat:'Not independently verified',sources:[{label:'Source',url:'https://example.com/news'}]}]}]};
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/journey-news.json')){res.statusCode=unavailable?503:200;res.end(JSON.stringify(data));}else if(req.url.startsWith('/news-data.json')){res.end(JSON.stringify({schema_version:1,fetched_at:new Date(now).toISOString(),articles:[],sources:[],events:[]}));}else res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:now});
  const base=`http://127.0.0.1:${server.address().port}/`;
  for(const route of ['dashboard','live']){await page.goto(base+'#/'+route);await page.waitForSelector('.journey-current .news-item');assert.equal(await page.locator('.journey-current .news-item').count(),1);}
  await page.locator('#journey-filter').selectOption('ETH');assert.match(await page.locator('.journey-current').innerText(),/No sourced coverage/);
  await page.locator('#journey-filter').selectOption('BTC');assert.match(await page.locator('.journey-current').innerText(),/Previous trading session/);
  unavailable=true;await page.locator('#journey-check').click();await page.waitForFunction(()=>document.querySelector('.journey-status').textContent.includes('STALE'));assert.equal(await page.locator('.journey-current .news-item').count(),0);
  unavailable=false;await page.locator('#journey-check').click();await page.waitForSelector('.journey-current .news-item');
  await page.clock.fastForward(5401000);await page.waitForFunction(()=>document.querySelector('.journey-status').textContent.includes('STALE'));assert.equal(await page.locator('.journey-current .news-item').count(),0);assert.equal(await page.locator('.journey-history .news-item').count(),1);
  data.reports[0].researched_at=new Date(now+6000000).toISOString();await page.locator('#journey-check').click();assert.equal(await page.locator('.journey-current .news-item').count(),0);
  data.reports[0].items[0].sources[0].url='javascript:alert(1)';await page.locator('#journey-check').click();assert.equal(await page.locator('.journey-panel a[href^="javascript:"]').count(),0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally {await browser.close();await new Promise(r=>server.close(r));}
});
