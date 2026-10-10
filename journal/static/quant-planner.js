/* Decimal-safe hypothetical planning. No account access or order submission. */
(function(root) {
  'use strict';
  const D = root.Decimal || (typeof require === 'function' ? require('./vendor/decimal-light.js') : null);
  D.set({precision:40, rounding:4});
  const d=v=>new D(String(v)), floor=(v,step)=>v.div(step).toDecimalPlaces(0,1).mul(step), ceil=(v,step)=>v.div(step).toDecimalPlaces(0,0).mul(step);
  function plan(p) {
    const budget=d(p.budget), rawEntry=d(p.entry), stop=d(p.stop), target=d(p.target), tick=d(p.tick??'.0001'), lot=d(p.lot??'.00000001');
    const buy=d(p.buyFee||0).div(100), sell=d(p.sellFee||0).div(100), slip=d(p.slippage||0).div(100), spread=d(p.spread||0).div(200), fill=d(p.fill??100).div(100);
    if(![budget,rawEntry,tick,lot].every(v=>v.gt(0))||!stop.gt(0)||!stop.lt(rawEntry)||target.lt(0)||fill.lte(0)||fill.gt(1)||[buy,sell,slip,spread].some(v=>v.lt(0)||v.gte('.1')))throw Error('Check positive budget/prices, stop below entry, fill 0–100%, and costs below 10%.');
    const entry=ceil(rawEntry,tick), drag=slip.plus(spread), executedEntry=entry.mul(d(1).plus(drag));
    const baseFee=p.feeCurrency==='base';
    const requested=floor(budget.div(executedEntry.mul(baseFee?1:d(1).plus(buy))),lot);
    const filled=floor(requested.mul(fill),lot), cost=filled.mul(executedEntry).mul(baseFee?1:d(1).plus(buy));
    const acquired=floor(filled.mul(baseFee?d(1).minus(buy):1),lot);
    const sellQty=baseFee?floor(acquired.div(d(1).plus(sell)),lot):acquired;
    if(sellQty.lte(0))throw Error('Budget/fill is below the product quantity increment.');
    const factor=sellQty.mul(d(1).minus(drag)).mul(baseFee?1:d(1).minus(sell));
    const required=ceil(cost.plus(target).div(factor),tick), breakEven=ceil(cost.div(factor),tick);
    const exit=p.exit?floor(d(p.exit),tick):required;
    const proceeds=sellQty.mul(exit).mul(d(1).minus(drag)), net=proceeds.mul(baseFee?1:d(1).minus(sell)).minus(cost);
    const loss=cost.minus(factor.mul(floor(stop,tick))), exitFee=baseFee?sellQty.mul(sell).mul(exit).mul(d(1).minus(drag)):proceeds.mul(sell);
    const out={quantity:filled,acquired,sellQuantity:sellQty,cost,unused:budget.minus(cost),entry,executedEntry,exit,required,breakEven,net,loss,
      entryFee:filled.mul(executedEntry).mul(buy),exitFee,totalFees:filled.mul(executedEntry).mul(buy).plus(exitFee),grossProceeds:proceeds,
      movePct:required.div(entry).minus(1).mul(100),rr:loss.gt(0)?net.div(loss):d(0),fillPct:fill.mul(100)};
    return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.toString()]));
  }
  function riskPlan(p, limits) {
    const full=plan(p), remaining=d(limits.dailyLoss||0).minus(limits.lossUsed||0);
    const min=(...xs)=>xs.reduce((a,b)=>a.lt(b)?a:b);
    const allowed=min(d(limits.risk),remaining), exposure=d(limits.exposure).minus(limits.exposureUsed||0);
    if(allowed.lte(0)||exposure.lte(0)||Number(limits.active||0)>=Number(limits.concurrent))return {full,limited:null,reason:'Risk, daily-loss, exposure or concurrent-signal limit exhausted.'};
    let capital=min(d(p.budget),d(limits.capital),exposure,d(p.budget).mul(allowed).div(full.loss));
    if(capital.lte(0))return {full,limited:null,reason:'No risk capacity'};
    const limited=plan({...p,budget:capital.toString()});
    if(d(limited.loss).gt(allowed.plus('.000001')))throw Error('Risk sizing invariant violated');
    return {full,limited,capital:capital.toString(),reason:'Hypothetical size only; stop fills can gap and losses may exceed this estimate.'};
  }
  function liquidity(book,budget) {
    if(!book?.bids?.length||!book?.asks?.length)return null;
    const bids=book.bids.map(x=>({price:d(x.price),size:d(x.size)})).sort((a,b)=>b.price.cmp(a.price));
    const asks=book.asks.map(x=>({price:d(x.price),size:d(x.size)})).sort((a,b)=>a.price.cmp(b.price));
    if(bids[0].price.gte(asks[0].price)||[...bids,...asks].some(x=>x.price.lte(0)||x.size.lte(0)))return null;
    let left=d(budget),qty=d(0),spent=d(0);
    for(const x of asks){const take=x.size.lt(left.div(x.price))?x.size:left.div(x.price);qty=qty.plus(take);spent=spent.plus(take.mul(x.price));left=left.minus(take.mul(x.price));if(left.lt('0.00000001'))break;}
    let unsold=qty,received=d(0);
    for(const x of bids){const take=x.size.lt(unsold)?x.size:unsold;received=received.plus(take.mul(x.price));unsold=unsold.minus(take);if(unsold.lte(0))break;}
    const bidDepth=bids.reduce((s,x)=>s.plus(x.price.mul(x.size)),d(0)),askDepth=asks.reduce((s,x)=>s.plus(x.price.mul(x.size)),d(0));
    const mid=asks[0].price.plus(bids[0].price).div(2),vwap=spent.div(qty);
    const result={bid:bids[0].price,ask:asks[0].price,spreadBps:asks[0].price.minus(bids[0].price).div(mid).mul(10000),bidDepth,askDepth,
      imbalance:bidDepth.minus(askDepth).div(bidDepth.plus(askDepth)),vwap,impactBps:vwap.div(asks[0].price).minus(1).mul(10000),
      quantity:qty,exitVWAP:received.div(qty),roundTripDrag:spent.minus(received)};
    return {...Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.toString()])),sufficient:left.lt('.000001')&&unsold.lt('.00000001')};
  }
  function gates(p,c,math,liq,now,hold) {
    const reasons=[];
    if(!p.available||p.quote!=='USDC'||p.book?.product_id!==p.product_id)reasons.push('Exact USDC market/book not verified');
    if(!p.basis_verified)reasons.push('Live USD-alias / USDC execution basis unverified');
    const bookAge=(now-Date.parse(p.book?.time))/1000;
    if(!Number.isFinite(bookAge)||bookAge< -5||bookAge>15)reasons.push('Exact-pair book is stale for execution');
    if(!liq?.sufficient)reasons.push('Observable depth cannot cover entry and exit');
    if(liq&&Number(liq.spreadBps)>10)reasons.push('Spread exceeds 10 bps');
    if(liq&&Number(liq.impactBps)>10)reasons.push('Observable entry impact exceeds 10 bps');
    if(!c||c.state!=='TRIGGERED')reasons.push('Completed-candle entry trigger not confirmed');
    if(c&&now/1000>c.expires)reasons.push('Setup expired');
    if(!math||Number(math.net)<=0||Number(math.rr)<1.5)reasons.push('Insufficient net reward / risk');
    if(hold<=60)reasons.push('Scheduled data is not execution-grade intraday coverage');
    reasons.push('No validated out-of-sample setup expectancy for these costs');
    return {eligible:false,signal:'WAIT',reasons};
  }
  root.QuantMath={plan,riskPlan,liquidity,gates};
  if(typeof module!=='undefined')module.exports=root.QuantMath;
})(typeof window!=='undefined'?window:globalThis);
