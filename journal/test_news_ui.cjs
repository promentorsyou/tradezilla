const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('../coinbase-quant-pro/apps/web/node_modules/playwright');
test('news on both routes, filtering, stale expiry, fetch failure, safe links and mobile',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../docs/index.html'));
 const now=Date.now(); let unavailable=false;
 let data={schema_version:1,fetched_at:new Date(now).toISOString(),sources:[{source:'CoinDesk',ok:true}],events:[],calendar_ok:true,articles:[
  {title:'Bitcoin ETF test headline',url:'https://coindesk.com/test',source:'CoinDesk',published_at:new Date(now-1000).toISOString(),symbols:['BTC'],topic:'Flows / liquidity'},
  {title:'Expired headline',url:'https://coindesk.com/old',source:'CoinDesk',published_at:new Date(now-90000000).toISOString(),symbols:[],topic:'Market context'},
  {title:'Unsafe link',url:'javascript:alert(1)',source:'CoinDesk',published_at:new Date(now-1000).toISOString(),symbols:[],topic:'Market context'}]};
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/news-data.json')){res.statusCode=unavailable?503:200;res.end(JSON.stringify(data));}else res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{
  const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:now});
  const base=`http://127.0.0.1:${server.address().port}/`;
  for(const route of ['dashboard','live']){await page.goto(base+'#/'+route);await page.waitForSelector('.news-item');assert.equal(await page.locator('.news-item').count(),1);}
  await page.locator('#news-filter').selectOption('held');assert.equal(await page.locator('#news-filter').inputValue(),'held');
  await page.locator('#news-filter').selectOption('all');
  data.fetched_at=new Date(now-1801000).toISOString();await page.locator('#news-check').click();await page.waitForFunction(()=>document.querySelector('.news-status').textContent.includes('STALE'));assert.equal(await page.locator('.news-item').count(),0);
  data.fetched_at=new Date(now).toISOString();await page.locator('#news-check').click();await page.waitForSelector('.news-item');
  unavailable=true;await page.locator('#news-check').click();await page.waitForFunction(()=>document.querySelector('.news-status').textContent.includes('STALE'));assert.equal(await page.locator('.news-item').count(),0);
  unavailable=false;await page.locator('#news-check').click();await page.waitForSelector('.news-item');
  await page.clock.fastForward(1801000);await page.waitForFunction(()=>document.querySelector('.news-status').textContent.includes('STALE'));assert.equal(await page.locator('.news-item').count(),0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
