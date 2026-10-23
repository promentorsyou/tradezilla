const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), http=require('node:http');
const {chromium}=require('../coinbase-quant-pro/apps/web/node_modules/playwright');
test('calendar drilldown, loss review and snapshot polling', async()=>{
 let html=fs.readFileSync(require('node:path').join(__dirname,'../docs/index.html'),'utf8');
 const server=http.createServer((req,res)=>res.end(html));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();
 try {
  const p=await browser.newPage(), errors=[]; p.on('pageerror',e=>errors.push(e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}/#/calendar`);
  const loss=await p.evaluate(()=>window.__REPORT__.trades.find(t=>t.net_pnl<0 && t.status==='CLOSED'));
  await p.locator('a.cal-cell').first().click();
  await p.waitForSelector('h2'); assert.match(await p.locator('#views').innerText(),/Day executions/);
  await p.evaluate(date=>location.hash='#/days?date='+date,loss.close_time.slice(0,10));
  await p.waitForSelector('.loss-review'); assert.match(await p.locator('#views').innerText(),/does not prove a mistake/);
  const before=await p.evaluate(()=>window.__REPORT__.generated_at);
  html=html.replace(before,'2099-01-01T00:00:00+00:00');
  await p.locator('#refresh').click();
  await p.waitForFunction(()=>window.__REPORT__.generated_at.startsWith('2099'));
  assert.deepEqual(errors,[]);
 } finally {await browser.close(); await new Promise(r=>server.close(r));}
});
