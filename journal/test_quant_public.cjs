const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const context = {window:{},setInterval,clearInterval,setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync(__dirname+'/static/quant-pro.js','utf8'),context);
const analyze = context.window.QuantPro.analyze;
function rows(n=250){return Array.from({length:n},(_,i)=>({time:1704067200+i*3600,open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100+i*.1,volume:10}));}
test('causal EMA, RSI and ATR use genuine calculations',()=>{
 const a=analyze(rows(),'1H');assert.equal(a.rsi.at(-1).value,100);assert.ok(Math.abs(a.atr-2)<1e-10);assert.equal(a.trend,'Bullish');
 let expected=100;for(const r of rows().slice(1))expected=r.close*2/21+expected*19/21;assert.ok(Math.abs(a.e20.at(-1).value-expected)<1e-8);
 assert.equal(a.e200[198].value,null);assert.ok(a.e200[199].value>0);
});
test('no history is fabricated across gaps',()=>{
 const input=rows();input.splice(20,10);const a=analyze(input,'1H');assert.equal(a.discarded,20);assert.equal(a.rows.length,220);
});
test('future bars do not change prior EMA values',()=>{
 const a=analyze(rows(220),'1H'),b=analyze(rows(250),'1H');assert.equal(JSON.stringify(a.e20),JSON.stringify(b.e20.slice(0,220)));
});
test('empty and insufficient histories remain unavailable',()=>{
 assert.equal(analyze([],'1W').trend,'Insufficient history');assert.equal(analyze(rows(10),'1H').rsi.at(-1).value,null);
});
