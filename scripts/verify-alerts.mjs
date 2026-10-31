// Browser regressions for the alert UI; recorded source data only, never in runtime views.
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const baseUrl=process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
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
await page.goto(baseUrl+'/#/futures');
await page.getByRole('heading',{name:/See the market/}).waitFor();
await page.waitForTimeout(500);
// The alert sound is loaded on the first sound, never at startup.
assert.equal(await page.evaluate(()=>window.__clips),0,'no audio element at startup');
assert.deepEqual(soundRequests,[],'the alert sound is not fetched at startup');
// A malformed stored entry renders as an entry instead of blanking the window.
await page.getByRole('button',{name:'Alert history',exact:true}).click();
await page.locator('.alert-entry',{hasText:'$OLD'}).waitFor();
await page.getByRole('button',{name:'Close alert history',exact:true}).click();
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
// The minimum score gates the buy side only: the score-10 warnings above were raised.
await page.evaluate(()=>{
 window.__alert({symbol:'LOWBULL',type:'bullish',score:10});
 window.__alert({symbol:'LOWBRK',type:'breakout',score:59});
 window.__alert({symbol:'HIGHBULL',type:'bullish',score:60});
});
await page.waitForTimeout(250);
// The summary opens the history: every raised alert, newest first, up to the history length.
await page.locator('.alert-overflow').click();
await page.locator('.alert-drawer').waitFor();
const entries=(await page.locator('.alert-entry .alert-symbol').allTextContents()).map(text=>text.trim());
assert.deepEqual(entries,['$HIGHBULL','$AMBER2','$LATE2','$LATE1',...Array.from({length:11},(_,i)=>`$B${12-i}`)]);
assert.equal(await page.locator('.alert-toast--overflow').count(),0,'opening the history clears the summary');
// The floating history toggle never hides a focused control (WCAG 2.4.11): tab through
// the Overview with the recorded screener page; Yahoo is unavailable, so rows stay unscored.
const screener=await readFile(new URL('../tests/fixtures/finviz-overview-2026.html',import.meta.url),'utf8');
const obscured={};
for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
 const tab=await browser.newPage({viewport});
 tab.on('pageerror',error=>errors.push(error.message));
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
const result={...(await counts()),history:entries.length,clip,obscured,errors};
console.log(result);
await browser.close();
assert.deepEqual(errors,[]);
