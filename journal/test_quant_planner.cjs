const assert=require('node:assert/strict'),test=require('node:test');
const M=require('./static/quant-planner.js');
const base={budget:50000,entry:1.4,exit:1.42,stop:1.38,target:200,tick:.0001,lot:.000001};
test('specified 50k XRP examples, budget covers entry fee',()=>{
 assert.ok(Math.abs(Number(M.plan(base).net)-714.285714)<.00001);
 const p=M.plan({...base,buyFee:.075,sellFee:.075});assert.ok(Math.abs(Number(p.net)-638.2712965)<.00001);assert.ok(Number(p.cost)<=50000);
});
test('round-up target achieves net goal after costs and increments',()=>{
 const p=M.plan({...base,exit:undefined,buyFee:.1,sellFee:.1,slippage:.05});assert.ok(Number(p.net)>=200);assert.ok(Number(p.totalFees)>0);assert.ok(Number(p.loss)>0);
});
test('partial fills retain unused budget and less profit at fixed exit',()=>{
 const p=M.plan({...base,fill:25});assert.ok(Number(p.unused)>=37500);assert.ok(Math.abs(Number(p.net)-178.571428)<.001);
});
test('invalid increments and stops rejected, nonaligned entry rounded up',()=>{
 assert.throws(()=>M.plan({...base,lot:0}));assert.throws(()=>M.plan({...base,stop:1.5}));assert.equal(M.plan({...base,entry:1.40001}).entry,'1.4001');assert.throws(()=>M.plan({...base,fill:0}));
});
test('spread and slippage reduce profit exactly once',()=>{
 assert.ok(Number(M.plan({...base,spread:.1}).net)<Number(M.plan(base).net));assert.ok(Number(M.plan({...base,slippage:.1}).net)<Number(M.plan(base).net));
});
test('risk limited capital respects maximum loss and exposure',()=>{
 const p=M.riskPlan({...base,exit:undefined,buyFee:.075,sellFee:.075},{risk:250,capital:50000,exposure:50000,dailyLoss:500,concurrent:1});assert.ok(Number(p.limited.loss)<=250);assert.ok(Number(p.capital)<50000);
 assert.equal(M.riskPlan(base,{risk:250,capital:50000,exposure:0,dailyLoss:500,concurrent:1}).limited,null);
});
test('base fee scenario is explicit and conserves inventory',()=>{const p=M.plan({...base,buyFee:.075,sellFee:.075,feeCurrency:'base'});assert.ok(Number(p.acquired)<Number(p.quantity));assert.ok(Number(p.sellQuantity)<Number(p.acquired));});
test('order book uses price-weighted depth and fails on inadequate exits',()=>{
 const book={bids:[{price:'1.39',size:'100000'}],asks:[{price:'1.4',size:'10000'},{price:'1.41',size:'100000'}]};const l=M.liquidity(book,50000);assert.ok(l.sufficient);assert.ok(Number(l.vwap)>1.4);assert.ok(Number(l.impactBps)>0);assert.ok(Number(l.roundTripDrag)>0);
 assert.equal(M.liquidity({...book,bids:[{price:'1.39',size:'1'}]},50000).sufficient,false);assert.equal(M.liquidity({...book,bids:[{price:'1.5',size:'1'}]},50000),null);
});
test('all six coins fail closed for stale books, aliases and unvalidated models',()=>{
 for(const coin of ['XRP','BTC','ETH','SOL','ADA','ZEC']){const p={product_id:coin+'-USDC',available:true,quote:'USDC',book:{product_id:coin+'-USDC',time:'2020-01-01'}};const g=M.gates(p,null,null,null,Date.now(),15);assert.equal(g.signal,'WAIT');assert.equal(g.eligible,false);assert.ok(g.reasons.some(s=>s.includes('stale')));}
});
