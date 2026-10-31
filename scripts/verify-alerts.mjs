// Browser regressions for the alert UI, on recorded source data (one chart carries
// test-only closes); none of it reaches a runtime view.
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {stubBridge,watcher} from './ui-harness.mjs';
const baseUrl=process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[], cspViolations=[];
// Uncaught errors and, on a production build, Content Security Policy violations
// (the alert clip must play under media-src 'self') fail the run.
const watch=watcher(errors,cspViolations);
const fixture=name=>readFile(new URL(`../tests/fixtures/${name}`,import.meta.url),'utf8');
const page=await watch(await browser.newPage());
const soundRequests=[];
page.on('request',request=>{ if (/\/alien_ominous[^/?]*\.(mp3|wav)$/.test(request.url())) soundRequests.push(request.url()); });
await page.addInitScript(()=>{
 // Counts contexts, amber sounds (one compressor each), clip elements and clip plays.
 window.__contexts=0;window.__closed=0;window.__amber=0;window.__plays=0;window.__clips=0;
 const NativeAudio=window.Audio;
 window.Audio=function(...args){window.__clips++;return new NativeAudio(...args);};
 const param={setValueAtTime(){},linearRampToValueAtTime(){}};
 class AudioContext {
 constructor(){window.__contexts++;this.currentTime=0;this.destination={};this.state='running';}
 createGain(){return {gain:param,connect(){}};}
 createBiquadFilter(){return {frequency:param,connect(){}};}
 createDynamicsCompressor(){window.__amber++;return {attack:param,threshold:param,ratio:param,connect(){},disconnect(){}};}
 createOscillator(){const osc={frequency:param,detune:param,connect(){},start(){},stop(){setTimeout(()=>osc.onended?.(),0);}};return osc;}
 resume(){return Promise.resolve();}
 close(){window.__closed++;this.state='closed';return Promise.resolve();}
 }
 window.AudioContext=AudioContext;
 HTMLMediaElement.prototype.play=function(){window.__plays++;return Promise.resolve();};
 window.__alert=(detail)=>window.dispatchEvent(new CustomEvent('stock-alert',{detail:{message:'Controlled alert',timestamp:Date.now(),...detail}}));
 // History length 15; the minimum score stays at the default 60.
 localStorage.setItem('dipAnalyzerSettingsV2',JSON.stringify({version:2,alerts:{historyLimit:15}}));
 // Stored entries from an older or hand-edited history: a message that is not text, junk.
 localStorage.setItem('dipAnalyzerAlertHistory',JSON.stringify([{id:'old',symbol:'OLD',type:'breakdown',color:'amber',message:{text:'not a string'},source:{},timestamp:'yesterday'},null,{message:'no symbol'}]));
});
const counts=()=>page.evaluate(()=>({contexts:window.__contexts,closed:window.__closed,amber:window.__amber,plays:window.__plays}));
const toasts=()=>page.locator('.alert-toast:not(.alert-toast--overflow)').count();
const focused=()=>page.evaluate(()=>document.activeElement.getAttribute('aria-label')??document.activeElement.tagName);
await page.goto(baseUrl+'/#/futures');
await page.getByRole('heading',{name:/See the market/}).waitFor();
await page.waitForTimeout(500);
// The alert sound is loaded on the first sound, never at startup.
assert.equal(await page.evaluate(()=>window.__clips),0,'no audio element at startup');
assert.deepEqual(soundRequests,[],'the alert sound is not fetched at startup');
// A malformed stored entry renders as an entry instead of blanking the window.
await page.getByRole('button',{name:'Alert history',exact:true}).click();
await page.locator('.alert-entry',{hasText:'$OLD'}).waitFor();
// The drawer covers its toggle, so opening it moves focus to its Close button; the Close
// button goes with the drawer, so closing it returns focus to the toggle.
assert.equal(await focused(),'Close alert history','focus after the toggle opened the history');
await page.getByRole('button',{name:'Close alert history',exact:true}).click();
assert.equal(await focused(),'Alert history','focus after closing the history');
// One amber alert: one context and one sound; the context is kept for the next amber sound.
await page.evaluate(()=>window.__alert({symbol:'TEST',type:'breakdown',color:'amber'}));
await page.waitForTimeout(250);
assert.deepEqual(await counts(),{contexts:1,closed:0,amber:1,plays:0},'one alert must create one audio context and one sound under StrictMode');
// A burst inside the same two seconds: three toasts plus one summary, and no sound at all.
await page.evaluate(()=>{ for (let i=1;i<=12;i++) window.__alert({symbol:`B${i}`,type:i%2?'breakdown':'bearish',color:i===3?'amber':'blue',score:10}); });
await page.waitForTimeout(250);
assert.equal(await toasts(),3,'at most three alert toasts are visible');
assert.equal((await page.locator('.alert-toast--overflow').textContent()).trim(),'+10 more alerts — open history');
assert.deepEqual(await counts(),{contexts:1,closed:0,amber:1,plays:0},'a burst inside the two-second window plays no sound and creates no context');
// Two seconds after the first sound, the next alert sounds once more.
await page.waitForTimeout(2000);
const lateAt=await page.evaluate(()=>{ window.__alert({symbol:'LATE1',type:'breakdown'}); window.__alert({symbol:'LATE2',type:'breakdown'}); return Date.now(); });
await page.waitForTimeout(250);
assert.deepEqual(await counts(),{contexts:1,closed:0,amber:1,plays:1},'at most one sound per two seconds');
// The first clip sound created the one audio element, and the shipped clip decodes.
assert.equal(await page.evaluate(()=>window.__clips),1,'the alert clip is created on its first sound');
for (let i=0;i<40&&!soundRequests.length;i++) await page.waitForTimeout(50);
assert.ok(soundRequests.length>0,'the alert clip is fetched on its first sound');
const clip=await page.evaluate(async(url)=>{
 const audio=document.createElement('audio');
 audio.src=url;
 await new Promise((resolve,reject)=>{ audio.onloadedmetadata=resolve; audio.onerror=()=>reject(new Error('alert clip does not decode')); });
 return {url,duration:audio.duration};
},soundRequests[0]);
assert.ok(clip.duration>3.9&&clip.duration<4.2,`alert clip decodes to about 4 s (${clip.duration})`);
// The next amber sound, once the window has passed, plays on the same context.
await page.waitForFunction(at=>Date.now()-at>=2050,lateAt);
await page.evaluate(()=>window.__alert({symbol:'AMBER2',type:'breakdown',color:'amber'}));
await page.waitForTimeout(250);
assert.deepEqual(await counts(),{contexts:1,closed:0,amber:2,plays:1},'a second amber sound reuses the one audio context');
// The minimum score gates Bullish alerts only: the score-10 warnings above were raised,
// and so is a breakout under it.
await page.evaluate(()=>{
 window.__alert({symbol:'LOWBULL',type:'bullish',score:10});
 window.__alert({symbol:'LOWBRK',type:'breakout',score:59});
 window.__alert({symbol:'HIGHBULL',type:'bullish',score:60});
});
await page.waitForTimeout(250);
// The summary opens the history and, as it removes itself, hands focus to the drawer:
// every raised alert, newest first, up to the history length.
await page.locator('.alert-overflow').focus();
await page.keyboard.press('Enter');
await page.locator('.alert-drawer').waitFor();
assert.equal(await focused(),'Close alert history','focus after the summary opened the history');
const entries=(await page.locator('.alert-entry .alert-symbol').allTextContents()).map(text=>text.trim());
assert.deepEqual(entries,['$HIGHBULL','$LOWBRK','$AMBER2','$LATE2','$LATE1',...Array.from({length:10},(_,i)=>`$B${12-i}`)]);
assert.equal(await page.locator('.alert-toast--overflow').count(),0,'opening the history clears the summary');
await page.keyboard.press('Enter');
await page.locator('.alert-drawer').waitFor({state:'detached'});
assert.equal(await focused(),'Alert history','focus after closing the history from the keyboard');
// With the history open already, the summary still hands focus to the drawer.
await page.keyboard.press('Enter'); // the focused toggle opens the history
await page.locator('.alert-drawer').waitFor();
assert.equal(await focused(),'Close alert history','focus after the toggle opened the history from the keyboard');
await page.evaluate(()=>{ for (let i=1;i<=4;i++) window.__alert({symbol:`OPEN${i}`,type:'breakdown'}); });
await page.locator('.alert-overflow').focus();
await page.keyboard.press('Enter');
await page.locator('.alert-toast--overflow').waitFor({state:'detached'});
assert.equal(await focused(),'Close alert history','focus after the summary, with the history open already');
// The floating history toggle never hides a focused control (WCAG 2.4.11): tab through
// the Overview with the recorded screener page; Yahoo is unavailable, so rows stay unscored.
const screener=await fixture('finviz-overview-2026.html');
const obscured={};
for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
 const tab=await watch(await browser.newPage({viewport}));
 await tab.addInitScript(screener=>{
  const empty='<table><tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr></table>';
  window.dipAnalyzer={invoke:async(channel,url)=>{
   if (channel==='configure-network') return {};
   if (channel==='fetch-url') return new URL(url).searchParams.get('r')==='1'?screener:empty;
   throw new Error(`No recorded data for ${channel}`);
  }};
 },screener);
 await tab.goto(baseUrl+'/#/');
 await tab.locator('.dash-row').nth(9).waitFor();
 await tab.waitForFunction(()=>!document.querySelector('.dash-spinner'));
 await tab.getByLabel('Search ticker',{exact:true}).focus();
 const stops={total:0,fully:0,partly:0};
 for (let i=0;i<60;i++) {
  await tab.keyboard.press('Tab');
  const covered=await tab.evaluate(()=>{
   const el=document.activeElement;
   if (!el||el===document.body||el.closest('.alert-history-toggle, .alert-drawer, .workspace-header')) return null;
   const r=el.getBoundingClientRect();
   const points=[[r.left+1,r.top+1],[r.right-1,r.top+1],[r.left+1,r.bottom-1],[r.right-1,r.bottom-1],[r.left+r.width/2,r.top+r.height/2]];
   return points.filter(([x,y])=>document.elementFromPoint(x,y)?.closest('.alert-history-toggle')).length;
  });
  if (covered===null) continue;
  stops.total++;
  if (covered===5) stops.fully++; else if (covered>0) stops.partly++;
 }
 obscured[viewport.width]=stops;
 assert.ok(stops.total>=20,`tabbed through the Overview rows at ${viewport.width} px`);
 assert.equal(stops.fully,0,`the history toggle hid a focused control at ${viewport.width} px`);
 await tab.close();
}
const silent=(tab,settings={})=>tab.addInitScript(settings=>localStorage.setItem('dipAnalyzerSettingsV2',JSON.stringify({version:2,...settings,alerts:{...settings.alerts,sound:false}})),settings);
// U59: in Alien Fractal the alert layer stays in the viewport however far a long
// desk is scrolled. A filter on <body> made it the containing block of fixed
// elements, which put the toggle and toasts at the end of the page and the drawer
// at its start.
const fractal=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await silent(fractal,{appearance:{theme:'theme-anime'}});
await stubBridge(fractal,{urls:{'https://finviz.com/api/futures_all?timeframe=i5':await fixture('futures-reference.json')}});
await fractal.goto(baseUrl+'/#/futures');
await fractal.locator('.futures-table tbody tr').nth(58).waitFor();
assert.ok(await fractal.evaluate(()=>document.body.classList.contains('theme-anime')));
// Measured once its toast or drawer has finished sliding in.
const inViewport=locator=>locator.evaluate(async el=>{
 await Promise.all((el.closest('.alert-toast, .alert-drawer')??el).getAnimations().map(animation=>animation.finished));
 const r=el.getBoundingClientRect();
 return r.width>0&&r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;
});
for (const [edge,y] of [['TOP',0],['BOTTOM',1e6]]) {
 await fractal.evaluate(y=>window.scrollTo(0,y),y);
 if (y) assert.ok(await fractal.evaluate(()=>scrollY>500),'the futures desk scrolls');
 await fractal.evaluate(symbol=>window.dispatchEvent(new CustomEvent('stock-alert',{detail:{symbol,type:'breakdown',message:'Controlled alert',timestamp:Date.now()}})),edge);
 const toast=fractal.locator('.alert-toast',{hasText:`$${edge}`});
 await toast.waitFor();
 assert.ok(await inViewport(toast),`the toast leaves the viewport scrolled to the ${edge.toLowerCase()}`);
 assert.ok(await inViewport(fractal.locator('.alert-history-toggle')),`the history toggle leaves the viewport scrolled to the ${edge.toLowerCase()}`);
}
await fractal.getByRole('button',{name:'Alert history',exact:true}).click();
assert.ok(await inViewport(fractal.getByRole('button',{name:'Close alert history',exact:true})),'the history drawer\'s close button leaves the viewport');
await fractal.close();
// C1 end to end. The Overview scans the recorded losers page and scores the two rows
// that have recorded charts, PTHS and CETX: both at a one-month breakdown, scored 15,
// with a bearish trend that turns true together with it. With the browser clock two
// minutes after their 2026-10-30 close, each raises one alert although the minimum
// score is 60, which gates Bullish alerts only, and a refresh that finds the same
// conditions stays silent (C1.2). With Breakdown alerts off, each alert is the
// bearish trend instead. Six minutes after the close the quotes are stale and the
// same scan raises nothing (C1.1).
const losers={urls:{'https://finviz.com/screener/stocks?v=111&o=change&r=1':await fixture('ui/finviz-losers-r1-2026-10-31.html')},
 charts:{'PTHS 1mo 1d':await fixture('ui/yahoo-chart-PTHS-1mo-2026-10-30.json'),'CETX 1mo 1d':await fixture('ui/yahoo-chart-CETX-1mo-2026-10-30.json')}};
const closedAt=Date.parse('2026-10-30T20:00:00Z');
// Scan number `runs` is over once it has requested CETX's chart, the later of the two, and the spinner is gone.
const scanned=(tab,runs)=>tab.waitForFunction(runs=>window.__calls.filter(([channel,symbol])=>channel==='fetch-yahoo-chart'&&symbol==='CETX').length===runs
 &&document.querySelectorAll('.dash-row').length===20&&!document.querySelector('.dash-spinner'),runs);
const raised=tab=>tab.evaluate(()=>JSON.parse(localStorage.getItem('dipAnalyzerAlertHistory')||'[]').map(({symbol,type,color,score})=>`${symbol} ${type} ${color} ${score}`).sort());
const scanAt=async(minutesAfterClose,settings)=>{
 const tab=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
 await tab.clock.install({time:closedAt+minutesAfterClose*60000});
 await silent(tab,settings);
 await stubBridge(tab,losers);
 await tab.goto(baseUrl+'/#/');
 await scanned(tab,1);
 assert.equal((await tab.locator('.dash-row',{hasText:'PTHS'}).locator('.dash-verdict').textContent()).trim(),'Strong Sell (15)');
 return tab;
};
const alerted=['CETX breakdown amber 15','PTHS breakdown amber 15'];
const recorded=(tab,count=2)=>tab.waitForFunction(count=>JSON.parse(localStorage.getItem('dipAnalyzerAlertHistory')||'[]').length>=count,count,{timeout:5000}).catch(()=>{});
const fresh=await scanAt(2);
await recorded(fresh);
assert.deepEqual(await raised(fresh),alerted,'fresh quotes at a breakdown raised these alerts');
assert.deepEqual((await fresh.locator('.alert-toast .alert-symbol').allTextContents()).map(text=>text.trim()).sort(),['$CETX','$PTHS']);
await fresh.getByRole('button',{name:'Refresh quotes',exact:true}).click();
await scanned(fresh,2);
await fresh.waitForTimeout(500);
assert.deepEqual(await raised(fresh),alerted,'a refresh repeated an alert whose condition held');
await fresh.close();
const bearish=['CETX bearish blue 15','PTHS bearish blue 15'];
const trendOnly=await scanAt(2,{alerts:{breakdown:false}});
await recorded(trendOnly);
assert.deepEqual(await raised(trendOnly),bearish,'with Breakdown alerts off, the bearish trend that turned true with each breakdown raised these alerts');
assert.deepEqual((await trendOnly.locator('.alert-toast .alert-toast-tag').allTextContents()).map(text=>text.trim()),['BEARISH','BEARISH']);
await trendOnly.close();
const stale=await scanAt(6);
await stale.waitForTimeout(500);
assert.deepEqual(await raised(stale),[],'a quote older than five minutes raised an alert');
assert.equal(await stale.locator('.alert-toast').count(),0);
await stale.close();
// A breakout raised by a scan at the default minimum score of 60. The dip score keeps a
// fresh one-month closing high at or under 50 in practice (no dip, no bounce to score),
// which is why the minimum score gates Bullish alerts only. No recorded chart is at such a high, and no row of the losers page can be (it
// trades under yesterday's close), so the Photonics basket gets PTHS's recorded response
// as LITE's chart, with test-only closes: a 20.00 closing high 12 sessions before the
// 2026-10-30 close of 20.60. The basket's other charts are unavailable.
const breakoutChart=JSON.parse(losers.charts['PTHS 1mo 1d']);
{
 const result=breakoutChart.chart.result[0];
 result.indicators.quote[0].close=[15,15.5,16,16.4,16.9,17.3,17.8,18.4,18.9,19.5,20,19.6,19.1,18.7,18.4,18.6,18.9,19.1,19.3,19.2,19.5,19.8,20.6];
 assert.equal(result.indicators.quote[0].close.length,result.timestamp.length);
 Object.assign(result.meta,{symbol:'LITE',longName:'LITE',shortName:'LITE',regularMarketPrice:20.6});
}
const photonics=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await photonics.clock.install({time:closedAt+2*60000});
await silent(photonics);
await photonics.addInitScript(()=>localStorage.setItem('dipAnalyzerSector','photonics'));
await stubBridge(photonics,{charts:{'LITE 1mo 1d':JSON.stringify(breakoutChart)}});
await photonics.goto(baseUrl+'/#/');
await photonics.waitForFunction(()=>window.__calls.some(([channel,symbol])=>channel==='fetch-yahoo-chart'&&symbol==='LITE')
 &&document.querySelectorAll('.dash-row').length===8&&!document.querySelector('.dash-spinner'));
assert.equal((await photonics.locator('.dash-row',{hasText:'LITE'}).locator('.dash-verdict').textContent()).trim(),'Hold (50)');
await recorded(photonics,1);
const breakout=['LITE breakout blue 50'];
assert.deepEqual(await raised(photonics),breakout,'a breakout under the minimum score raised this alert');
assert.deepEqual((await photonics.locator('.alert-toast .alert-toast-tag').allTextContents()).map(text=>text.trim()),['BREAKOUT']);
await photonics.close();
// The scan that raises alerts also says where each score came from (data-3). With a
// 15-minute chart cache, a refresh ten minutes later retrieves the losers page again and
// reuses the charts: a row shows when its Finviz row was retrieved, and its score
// breakdown the Yahoo quote time and when that chart was retrieved, each with a zone.
const reused=await watch(await browser.newPage({viewport:{width:1440,height:1050},timezoneId:'America/New_York',locale:'en-US'}));
await reused.clock.install({time:closedAt+2*60000});
await silent(reused,{data:{chartCacheSeconds:900}});
await stubBridge(reused,losers);
await reused.goto(baseUrl+'/#/');
await scanned(reused,1);
await reused.clock.runFor(10*60000);
await reused.getByRole('button',{name:'Refresh quotes',exact:true}).click();
await reused.waitForFunction(url=>window.__calls.filter(([,requested])=>requested===url).length===2&&!document.querySelector('.dash-spinner'),Object.keys(losers.urls)[0]);
const pths=reused.locator('.dash-row',{hasText:'PTHS'});
await pths.getByRole('button',{name:'Toggle score breakdown for PTHS',exact:true}).click();
const provenance={
 row:(await pths.locator('.dash-meta',{hasText:'Retrieved:'}).textContent()).trim(),
 score:(await reused.locator('.dash-detail-meta').textContent()).trim(),
};
assert.equal(await reused.evaluate(()=>window.__calls.filter(([channel,symbol])=>channel==='fetch-yahoo-chart'&&symbol==='PTHS').length),1,'the refresh reused the cached chart');
assert.match(provenance.row,/^Retrieved: 10\/30\/2026, 4:12:\d\d\sPM\sEDT$/);
assert.match(provenance.score,/ quote \$9\.40 as of 10\/30\/2026, 4:00:00\sPM\sEDT · delay unknown · retrieved 10\/30\/2026, 4:02:\d\d\sPM\sEDT$/);
await reused.close();
// Alerts while the window is hidden (tests-3). Only the Overview scan raises alerts, so with
// an alert type on, its auto-refresh keeps running while the window is hidden; with every
// type off it pauses like every desk and catches up once when the window is shown again.
// A scan is counted by its request for the losers page.
const hiddenMinute=async alerts=>{
 const tab=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
 await tab.clock.install({time:closedAt+2*60000});
 await silent(tab,{scanner:{refreshMinutes:1},alerts});
 await stubBridge(tab,losers);
 await tab.goto(baseUrl+'/#/');
 await scanned(tab,1);
 const scans=()=>tab.evaluate(url=>window.__calls.filter(([,requested])=>requested===url).length,Object.keys(losers.urls)[0]);
 const show=visible=>tab.evaluate(visible=>{
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>(visible?'visible':'hidden')});
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>!visible});
  document.dispatchEvent(new Event('visibilitychange'));
 },visible);
 await show(false);
 await tab.clock.runFor(61000);
 await tab.waitForTimeout(500);
 const hidden=await scans();
 await show(true);
 await tab.waitForTimeout(500);
 const shown=await scans();
 await tab.close();
 return {hidden,shown};
};
const whileHidden={alertsOn:await hiddenMinute({}),alertsOff:await hiddenMinute({breakout:false,breakdown:false,trend:false})};
assert.deepEqual(whileHidden.alertsOn,{hidden:2,shown:2},'with alerts on, the Overview scans while hidden and owes no catch-up');
assert.deepEqual(whileHidden.alertsOff,{hidden:1,shown:2},'with every alert type off, the Overview pauses while hidden and catches up once');
const result={...(await counts()),history:entries.length,clip,obscured,c1:{fresh:alerted,trendOnly:bearish,stale:[],breakout},provenance,whileHidden,errors,cspViolations};
console.log(result);
await browser.close();
assert.deepEqual(errors,[]);
assert.deepEqual(cspViolations,[],'Content Security Policy violations');
