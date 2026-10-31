// Browser regressions use recorded source data; fixtures never enter runtime views.
// UI_BASE_URL may be the Vite dev server or `vite preview` of a production build;
// only the latter carries the Content Security Policy and the minified CSS, so
// run both. Any policy violation fails the run.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const artifactDir=fileURLToPath(new URL('../artifacts/', import.meta.url));
const baseUrl=process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
await mkdir(artifactDir,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[], cspViolations=[];
// Every page: uncaught errors and CSP violations are collected, and TradingView
// (the chart iframe's host) and web fonts never load from the network.
const watch=async(page)=>{
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('__reportCsp',violation=>cspViolations.push(violation));
 await page.addInitScript(()=>{
  if (window!==window.top) return;
  document.addEventListener('securitypolicyviolation',e=>window.__reportCsp(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
 });
 await page.route(/https:\/\/([a-z0-9-]+\.)*tradingview\.com|fonts\.googleapis|fonts\.gstatic/,route=>route.abort());
 return page;
};
const fixture=name=>readFile(new URL(`../tests/fixtures/${name}`,import.meta.url),'utf8');
// The desktop bridge as preload.cjs ships it: window.dipAnalyzer = { invoke }, in
// the top frame only. Recorded responses answer by request (fetch-url: the URL;
// fetch-yahoo-chart: 'SYMBOL range interval'), after an optional delay per channel.
// Anything else rejects in Electron's own wording, which the app's bridge strips;
// so does every request while window.__failWith holds a message. window.__calls
// logs every call.
const stubBridge=(page,{urls={},charts={},delays={}}={})=>page.addInitScript(({urls,charts,delays})=>{
 if (window!==window.top) return;
 window.__calls=[];
 window.__failWith=null;
 window.dipAnalyzer={invoke:async(channel,...args)=>{
  window.__calls.push([channel,...args]);
  if (!['fetch-url','fetch-yahoo-chart','configure-network'].includes(channel)) throw new Error(`Unknown desktop channel: ${channel}`);
  if (channel==='configure-network') return {requestTimeoutMs:args[0].requestTimeoutSeconds*1000};
  await new Promise(resolve=>setTimeout(resolve,delays[channel]??0));
  const key=channel==='fetch-url'?args[0]:args.join(' ');
  const body=channel==='fetch-url'?urls[key]:charts[key];
  if (window.__failWith||body===undefined) throw new Error(`Error invoking remote method '${channel}': Error: ${window.__failWith||`No recorded response for ${key}`}`);
  return channel==='fetch-url'?body:JSON.parse(body);
 }};
},{urls,charts,delays});
// null when the page fits the viewport; otherwise the outermost boxes past its
// right edge that no clipping or scrolling ancestor contains.
const overflowAt=page=>page.evaluate(()=>{
 const width=window.innerWidth;
 if (document.documentElement.scrollWidth<=width) return null;
 const contained=el=>{ for (let node=el.parentElement;node&&node!==document.body;node=node.parentElement) if (getComputedStyle(node).overflowX!=='visible') return true; return false; };
 const offenders=[...document.body.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>width+0.5&&!contained(el));
 return `scrollWidth ${document.documentElement.scrollWidth}: `+offenders.slice(0,4).map(el=>`${[el.tagName.toLowerCase(),...el.classList].join('.')} (right ${Math.round(el.getBoundingClientRect().right)})`).join(', ');
});
const page=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await page.goto(baseUrl+'/#/futures');
await page.getByText('Quotes unavailable',{exact:true}).waitFor();
assert.equal(await page.locator('.futures-table tbody tr').count(),0);
assert.equal(await page.locator('.chart-caption').last().textContent(),'Finviz source samples · 5-minuteUnavailable');
await page.screenshot({path:artifactDir+'/futures-unavailable.png',fullPage:true});
// Without the desktop bridge every desk renders its heading and its own
// unavailable notices, shows no price, names itself in the window title and fits
// the viewport, wide and at 390 px. Settings states the alert rules (C1.5).
const ROUTES=[
 {path:'/#/',title:'Overview',root:'.dashboard',heading:/Market Dips|Overview/,notices:['Market data requires the desktop app connection. No sample quotes are shown.','Market quotes require the desktop app connection.']},
 {path:'/#/futures',title:'Futures',root:'.futures-page',heading:/See the market|Futures/,notices:['Quotes unavailable','Futures data requires the Electron desktop app.','Market data is unavailable']},
 {path:'/#/etfs',title:'ETF rankings',root:'.etf-awards-page',heading:/ETF/,notices:['ETF quotes require the desktop app connection.','Rankings unavailable.']},
 {path:'/#/oil',title:'Oil Watch',root:'.oil-watch-page',heading:/Oil Watch/,notices:['Oil Watch quotes require the desktop app connection.','News feed requires the desktop app connection.','Market quotes require the desktop app connection.']},
 {path:'/#/discovery',title:'Discovery',root:'.discovery-page',heading:/Discovery/,notices:['Discovery quotes require the desktop app connection.','Scanner unavailable.']},
 {path:'/#/stock/AAPL',title:'AAPL — Stock',root:'.stock-details',heading:/AAPL/,notices:['Market data requires the desktop app connection. No sample quotes are shown.','Finviz statistics and news require the desktop app connection.','Failed to load 1-month chart data for AAPL.','52-week position unavailable']},
 {path:'/#/settings',title:'Settings',root:'.settings-page',heading:/^Settings$/,notices:['Minimum score applies to Breakout and Bullish alerts; breakdown and bearish warnings are raised regardless of score.','Not reported by Yahoo’s chart endpoint','Technical alerts use only quotes whose own timestamp is at most 5 minutes old.']},
 {path:'/#/stock/',title:'Page not found',root:null,heading:/Page not found/,notices:[]},
];
for (const viewport of [{width:1440,height:1050},{width:390,height:844}]) {
 await page.setViewportSize(viewport);
 for (const route of ROUTES) {
  await page.goto(baseUrl+route.path);
  const desk=route.root?page.locator('main').locator(route.root).first():page.locator('main');
  await desk.getByRole('heading',{name:route.heading}).first().waitFor();
  for (const notice of route.notices) await desk.getByText(notice,{exact:true}).first().waitFor();
  assert.equal(await page.title(),`${route.title} — Dip Analyzer PRO`);
  assert.doesNotMatch(await page.locator('main').innerText(),/\$\d/,`${route.path} shows a price without a desktop bridge`);
  assert.equal(await overflowAt(page),null,`${route.path} overflows the ${viewport.width} px viewport`);
 }
}
await page.setViewportSize({width:1440,height:1050});
await page.goto(baseUrl+'/#/settings');
// Appearance settings must reach rendered elements, not stop at <html>.
await page.getByRole('heading',{name:'Appearance',exact:true}).waitFor();
await page.getByRole('radiogroup',{name:'Motion',exact:true}).getByText('Reduced',{exact:true}).click();
await page.getByRole('radiogroup',{name:'Density',exact:true}).getByText('Compact',{exact:true}).click();
await page.getByLabel('Glow intensity',{exact:true}).focus();
await page.getByLabel('Glow intensity',{exact:true}).press('Home');
// Tokens are compared as numbers: the production build minifies 0.73 to '.73'
// (and 270ms to '.27s'), so their text differs between dev and the bundle.
const appearanceApplied=()=> {
 const body=getComputedStyle(document.body);
 const token=name=>parseFloat(body.getPropertyValue(name));
 const dot=document.querySelector('.status-dot');
 return token('--density')===0.73
  && token('--gap')===19
  && token('--glow-intensity')===0
  && token('--t-fast')===0
  && dot && Number(getComputedStyle(dot,'::after').opacity)===0;
};
await page.waitForFunction(appearanceApplied);
assert.equal(await page.locator('.app-container').evaluate(node=>getComputedStyle(node).paddingLeft),'28px');
await page.getByLabel('Visual theme',{exact:true}).selectOption('theme-majestic');
await page.waitForFunction(()=>document.body.classList.contains('theme-majestic'));
await page.waitForFunction(appearanceApplied);
await page.getByLabel('Visual theme',{exact:true}).selectOption('theme-pierce27');
await page.waitForFunction(()=>document.documentElement.classList.contains('theme-pierce27'));
await page.waitForFunction(appearanceApplied);
await page.reload();
await page.waitForFunction(appearanceApplied);
assert.equal(await page.getByLabel('Glow intensity',{exact:true}).inputValue(),'0');
await page.screenshot({path:artifactDir+'/settings-appearance.png',fullPage:true});
const preferencesBeforeImport=JSON.parse(await page.getByLabel('Export',{exact:true}).inputValue());
assert.deepEqual(preferencesBeforeImport.data,{chartCacheSeconds:0,requestTimeoutSeconds:12});
await page.getByLabel('Import',{exact:true}).fill('{"alerts":null}');
await page.getByRole('button',{name:'Apply',exact:true}).click();
await page.locator('.settings-error').waitFor();
assert.match(await page.locator('.settings-error').textContent(),/alerts must be an object/);
assert.deepEqual(JSON.parse(await page.getByLabel('Export',{exact:true}).inputValue()),preferencesBeforeImport);
await page.getByRole('button',{name:'Reset Appearance to defaults',exact:true}).click();
await page.waitForFunction(()=>parseFloat(getComputedStyle(document.body).getPropertyValue('--density'))===1);
const liveData=await fixture('futures-reference.json');
const FUTURES_API='https://finviz.com/api/futures_all?timeframe=i5';
await stubBridge(page,{urls:{[FUTURES_API]:liveData}});
await page.goto(baseUrl+'/#/futures');
await page.reload();
await page.locator('.futures-table tbody tr').nth(58).waitFor();
assert.equal(await page.locator('.futures-table tbody tr').count(),59);
await page.getByRole('button',{name:'Rates',exact:true}).click();
assert.equal(await page.locator('.futures-table tbody tr').count(),8);
await page.getByLabel('Search futures').fill('ZF');
assert.equal(await page.locator('.futures-table tbody tr').count(),1);
assert.match(await page.locator('.futures-table tbody tr').textContent(),/103\.6015625/);
await page.getByLabel('Search futures').fill('');
await page.getByRole('button',{name:'All markets',exact:true}).click();
await page.screenshot({path:artifactDir+'/futures-desktop.png',fullPage:true});
const fetchedBefore=await page.locator('.source-banner-time').textContent();
// A refused refresh reaches the desk in the provider's own words, without Electron's IPC wrapping.
await page.evaluate(()=>window.__failWith='Finviz returned HTTP 429 Too Many Requests');
await page.getByRole('button',{name:'Refresh quotes',exact:true}).click();
await page.getByText('Refresh incomplete · previous quotes retained',{exact:true}).waitFor();
const refusal=await page.locator('.futures-page .data-notice',{hasText:'Refresh incomplete'}).textContent();
assert.match(refusal,/Finviz refresh failed: Finviz returned HTTP 429 Too Many Requests; Finviz returned HTTP 429 Too Many Requests/);
assert.doesNotMatch(refusal,/Error invoking remote method/);
assert.equal(await page.locator('.source-banner-time').textContent(),fetchedBefore);
assert.equal(await page.locator('.futures-table tbody .quote-status.cached').count(),59);
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:artifactDir+'/futures-mobile.png',fullPage:true});
assert.equal(await overflowAt(page),null,'the futures desk overflows the 390 px viewport');
// The documented legacy bridge (src/utils/bridge.js keeps it for browser scripts):
// the same recorded futures through window.require('electron').ipcRenderer.invoke.
const legacy=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await legacy.addInitScript(({liveData,url})=>{
 window.require=name=>(name==='electron'?{ipcRenderer:{invoke:async(channel,requested)=>{
  if (channel==='fetch-url'&&requested===url) return liveData;
  throw new Error(`No recorded response for ${requested}`);
 }}}:null);
},{liveData,url:FUTURES_API});
await legacy.goto(baseUrl+'/#/futures');
await legacy.locator('.futures-table tbody tr').nth(58).waitFor();
assert.equal(await legacy.evaluate(()=>typeof window.dipAnalyzer),'undefined');
await legacy.close();
// Data settings through a recording bridge. A number field commits on blur only
// (U18): clearing the 12 and typing 45 sends and saves nothing until the field is
// left, then exactly one configure-network 45. Chart cache and request timeout
// survive a reload and an export → reset → import round trip (U17). A fresh load
// sends the saved timeout before any provider request (U15).
const savedData=p=>p.evaluate(()=>JSON.parse(localStorage.getItem('dipAnalyzerSettingsV2')).data);
const sentTimeouts=p=>p.evaluate(()=>window.__calls.filter(([channel])=>channel==='configure-network').map(([,options])=>options.requestTimeoutSeconds));
const firstCall=p=>p.evaluate(()=>window.__calls[0]);
const data=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await stubBridge(data);
await data.goto(baseUrl+'/#/settings');
const timeoutField=data.getByLabel('Request timeout',{exact:true});
const chartCache=data.getByRole('radiogroup',{name:'Chart cache',exact:true});
await timeoutField.waitFor();
const sentBefore=await sentTimeouts(data);
assert.deepEqual([...new Set(sentBefore)],[12]);
await timeoutField.fill('');
await timeoutField.pressSequentially('4');
assert.deepEqual(await savedData(data),{chartCacheSeconds:0,requestTimeoutSeconds:12},'a cleared field or a 4 is saved mid-edit');
await timeoutField.pressSequentially('5');
assert.deepEqual(await sentTimeouts(data),sentBefore,'a timeout is sent mid-edit');
assert.deepEqual(await savedData(data),{chartCacheSeconds:0,requestTimeoutSeconds:12},'a timeout is saved mid-edit');
await timeoutField.press('Tab');
await data.waitForFunction(()=>window.__calls.at(-1)[1]?.requestTimeoutSeconds===45);
assert.deepEqual(await sentTimeouts(data),[...sentBefore,45]);
await chartCache.getByText('5 min',{exact:true}).click();
assert.deepEqual(await savedData(data),{chartCacheSeconds:300,requestTimeoutSeconds:45});
await data.reload();
await timeoutField.waitFor();
assert.deepEqual(await firstCall(data),['configure-network',{requestTimeoutSeconds:45}]);
assert.equal(await timeoutField.inputValue(),'45');
assert.ok(await chartCache.getByRole('radio',{name:'5 min',exact:true}).isChecked());
const exported=await data.getByLabel('Export',{exact:true}).inputValue();
assert.deepEqual(JSON.parse(exported).data,{chartCacheSeconds:300,requestTimeoutSeconds:45});
await data.getByRole('button',{name:'Reset Data & sources to defaults',exact:true}).click();
assert.deepEqual(await savedData(data),{chartCacheSeconds:0,requestTimeoutSeconds:12});
assert.equal(await timeoutField.inputValue(),'12');
await data.getByLabel('Import',{exact:true}).fill(exported);
await data.getByRole('button',{name:'Apply',exact:true}).click();
await data.getByText(/^Settings applied\./).waitFor();
assert.deepEqual(await savedData(data),{chartCacheSeconds:300,requestTimeoutSeconds:45});
await data.reload();
assert.equal(await timeoutField.inputValue(),'45');
assert.ok(await chartCache.getByRole('radio',{name:'5 min',exact:true}).isChecked());
for (const path of ['/#/','/#/futures']) {
 await data.goto(baseUrl+path);
 await data.reload();
 await data.waitForFunction(()=>window.__calls.some(([channel])=>channel!=='configure-network'));
 assert.deepEqual(await firstCall(data),['configure-network',{requestTimeoutSeconds:45}],`${path}: the saved timeout goes first`);
}
await data.close();
// Backup → Copy with the clipboard write refused (U13): the instruction stays, with
// the export focused and fully selected, past the 2.7 s a confirmation lasts. A copy
// of part of it is not confirmed and leaves the clipboard alone; a copy of all of it
// is confirmed, and the confirmation fades. A working clipboard gets the export.
const MANUAL_COPY='Clipboard unavailable — the text is selected; copy it manually.';
const PARTIAL_COPY='Not all of the text was selected — select all of it and copy again.';
const clipboardContext=await browser.newContext({viewport:{width:1440,height:1050}});
await clipboardContext.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(baseUrl).origin});
const backup=await watch(await clipboardContext.newPage());
await backup.addInitScript(()=>{
 const write=navigator.clipboard.writeText.bind(navigator.clipboard);
 window.__seedClipboard=text=>write(text);
 window.__refuseClipboard=true;
 window.__clipboardWrites=[];
 Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:text=>(window.__refuseClipboard
  ?Promise.reject(new DOMException('Write permission denied.','NotAllowedError'))
  :(window.__clipboardWrites.push(text),write(text)))});
});
await backup.goto(baseUrl+'/#/settings');
const exportBox=backup.getByLabel('Export',{exact:true});
const copyStatus=backup.locator('.settings-field',{has:exportBox}).locator('.settings-status');
const clipboardText=()=>backup.evaluate(()=>navigator.clipboard.readText());
const exportText=await exportBox.inputValue();
await backup.evaluate(()=>window.__seedClipboard('SENTINEL'));
await backup.getByRole('button',{name:'Copy',exact:true}).click();
await copyStatus.getByText(MANUAL_COPY,{exact:true}).waitFor();
assert.deepEqual(await exportBox.evaluate(box=>[box===document.activeElement,box.selectionStart,box.selectionEnd===box.value.length]),[true,0,true]);
await backup.waitForTimeout(3500);
assert.equal(await copyStatus.textContent(),MANUAL_COPY,'the manual-copy instruction faded');
await exportBox.evaluate(box=>box.setSelectionRange(5,5));
await backup.keyboard.press('Control+C');
await copyStatus.getByText(PARTIAL_COPY,{exact:true}).waitFor();
assert.equal(await clipboardText(),'SENTINEL');
assert.equal(await backup.getByRole('button',{name:'Copied',exact:true}).count(),0);
await backup.keyboard.press('Control+A');
await backup.keyboard.press('Control+C');
await copyStatus.getByText('Copied to the clipboard.',{exact:true}).waitFor();
assert.equal(await clipboardText(),exportText);
await backup.getByRole('button',{name:'Copied',exact:true}).waitFor();
await backup.getByRole('button',{name:'Copy',exact:true}).waitFor({timeout:5000});
assert.equal(await copyStatus.textContent(),'');
await backup.evaluate(()=>{ window.__refuseClipboard=false; return window.__seedClipboard('SENTINEL'); });
await backup.getByRole('button',{name:'Copy',exact:true}).click();
await copyStatus.getByText('Copied to the clipboard.',{exact:true}).waitFor();
assert.deepEqual(await backup.evaluate(()=>window.__clipboardWrites),[exportText]);
assert.equal(await clipboardText(),exportText);
await clipboardContext.close();
// The stock page from recorded data: Yahoo charts of the 2026-10-30 session (AAPL,
// a Hold; PLUG, a sub-$5 Strong Sell) and Finviz's AAPL quote page of the next morning.
const recordedStock={
 urls:{'https://finviz.com/stock?t=AAPL&p=d':await fixture('finviz-quote-AAPL-2026-10-31.html')},
 charts:{'AAPL 1mo 1d':await fixture('yahoo-chart-AAPL-1mo-2026-10-30.json'),'PLUG 1mo 1d':await fixture('yahoo-chart-PLUG-1mo-2026-10-30.json')},
};
const toneOf=(p,selectors)=>p.evaluate(selectors=>selectors.map(selector=>[...document.querySelector(selector).classList].find(name=>/--(success|warning|danger|muted)$/.test(name))),selectors);
const stock=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await stubBridge(stock,recordedStock);
await stock.goto(baseUrl+'/#/stock/AAPL');
// U45: statistics, headlines with their publishers, and the 52-week strip from the quote page.
await stock.locator('.sd-range-caption').waitFor();
assert.equal(await stock.locator('.sd-range-caption').textContent(),'Current $344.63 — 93% of the Finviz 52-week range');
assert.deepEqual(await stock.locator('.sd-range-bound').allTextContents(),['$243.42','$351.73']);
assert.equal(await stock.locator('.sd-stat').count(),16);
assert.equal(await stock.locator('.sd-news-item').count(),10);
assert.deepEqual((await stock.locator('.sd-news-source').allTextContents()).slice(0,3),['Barrons.com','Investing.com','Bloomberg']);
assert.ok((await stock.locator('.sd-news-time').allTextContents()).every(time=>time.endsWith(' ET')));
// U35: a Hold carries the warning tone on the dip pill, the score box and the verdict chip.
assert.equal(await stock.locator('.sd-verdict').textContent(),'Hold');
assert.deepEqual(await toneOf(stock,['.sd-title .sd-pill','.sd-score','.sd-verdict']),['sd-pill--warning','sd-score--warning','sd-verdict--warning']);
// U06: the chart is TradingView's page in a sandboxed iframe without popups; its
// loader script never runs in the document that holds the bridge.
const tradingView=async(p,container)=>{
 const frame=p.locator(`${container} iframe`);
 await frame.waitFor({state:'attached'});
 assert.equal(await frame.getAttribute('sandbox'),'allow-scripts allow-same-origin');
 assert.match(await frame.getAttribute('src'),/^https:\/\/s\.tradingview\.com\/widgetembed\//);
 assert.deepEqual(await p.evaluate(()=>[document.querySelectorAll('script[src*="tradingview"], script[src*="tv.js"]').length,typeof window.TradingView]),[0,'undefined']);
};
await tradingView(stock,'#tv_stockdetail_chart');
// Switching symbol never pairs the new symbol with the previous one's quote.
await stock.evaluate(()=>{
 window.__frames=[];
 new MutationObserver(()=>window.__frames.push([document.querySelector('.sd-symbol')?.textContent,document.querySelector('.sd-quote-line strong')?.textContent]))
  .observe(document.body,{subtree:true,childList:true,characterData:true});
});
await stock.goto(baseUrl+'/#/stock/PLUG');
await stock.locator('.sd-verdict',{hasText:'Strong Sell'}).waitFor();
assert.ok(!(await stock.evaluate(()=>window.__frames)).some(([symbol,price])=>symbol==='PLUG'&&price==='$344.63'),'PLUG was shown with AAPL\'s quote');
// U35: a Strong Sell carries the danger tone throughout.
assert.deepEqual(await toneOf(stock,['.sd-title .sd-pill','.sd-score','.sd-verdict']),['sd-pill--danger','sd-score--danger','sd-verdict--danger']);
// U44: the sub-$5 series keeps every price tick at $0 or above, with distinct labels,
// and its line spans most of the plot instead of a sliver.
await stock.locator('.sd-chart .recharts-area-curve').waitFor();
const axis=await stock.evaluate(()=>{
 const chart=document.querySelector('.sd-chart');
 const grid=chart.querySelector('.recharts-cartesian-grid').getBoundingClientRect();
 return {
  ticks:[...chart.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map(node=>node.textContent),
  fill:chart.querySelector('.recharts-area-curve').getBoundingClientRect().height/grid.height,
 };
});
const tickPrices=axis.ticks.map(tick=>Number(tick.replace(/^\$/,'')));
assert.ok(tickPrices.length>=3&&tickPrices.every(price=>price>=0&&price<5),`price ticks ${axis.ticks.join(' ')}`);
assert.equal(new Set(axis.ticks).size,axis.ticks.length,`repeated tick labels ${axis.ticks.join(' ')}`);
assert.ok(axis.fill>0.5,`the price line spans ${axis.fill.toFixed(2)} of the plot`);
// With Finviz failing, its sections say so and the 52-week strip uses Yahoo's range.
for (const notice of ['Finviz statistics and news refresh failed. Please retry.','Statistics unavailable','News unavailable from Finviz.']) await stock.getByText(notice,{exact:true}).waitFor();
assert.match(await stock.locator('.sd-range-caption').textContent(),/^Current \$1\.\d\d — \d+% of the Yahoo Finance 52-week range$/);
assert.doesNotMatch(await stock.locator('main').innerText(),/Error invoking remote method/);
await stock.goto(baseUrl+'/#/discovery');
await tradingView(stock,'#tv_discovery_chart');
await stock.close();
// U67: each source loads on its own: Finviz's sections fill while Yahoo is still
// pending, and the score shows while Finviz is still loading.
const slowStock=async delays=>{
 const p=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
 await stubBridge(p,{...recordedStock,delays});
 await p.goto(baseUrl+'/#/stock/AAPL');
 return p;
};
let slow=await slowStock({'fetch-yahoo-chart':4000,'fetch-url':100});
await slow.locator('.sd-news-item').nth(9).waitFor();
assert.equal(await slow.locator('.sd-stat').count(),16);
assert.ok(await slow.locator('.sd-quote-line--pending').isVisible(),'the Finviz sections waited for Yahoo');
await slow.close();
slow=await slowStock({'fetch-yahoo-chart':100,'fetch-url':4000});
await slow.locator('.sd-score').waitFor();
assert.ok(await slow.getByText('Loading Finviz statistics…',{exact:true}).isVisible(),'the score waited for Finviz');
await slow.close();
// U33: an Overview symbol is a focusable link, and Enter opens its stock page with
// one history entry. The recorded losers page; Yahoo is unavailable, so rows stay
// unscored. The RelVol column is gone (U26).
const overview=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await stubBridge(overview,{urls:{'https://finviz.com/screener/stocks?v=111&o=change&r=1':await fixture('ui/finviz-losers-r1-2026-10-31.html')}});
await overview.goto(baseUrl+'/#/');
await overview.locator('.dash-row').nth(19).waitFor();
await overview.waitForFunction(()=>!document.querySelector('.dash-spinner'));
assert.equal(await overview.getByRole('columnheader',{name:/RelVol/}).count(),0);
const symbolLink=overview.locator('.dash-row').first().getByRole('link');
const symbol=await symbolLink.textContent();
assert.equal(await symbolLink.getAttribute('href'),`#/stock/${symbol}`);
await symbolLink.focus();
assert.ok(await symbolLink.evaluate(link=>link===document.activeElement),'the symbol link takes focus');
const historyBefore=await overview.evaluate(()=>history.length);
await overview.keyboard.press('Enter');
await overview.locator('.sd-symbol',{hasText:symbol}).waitFor();
assert.equal(await overview.evaluate(()=>history.length),historyBefore+1);
await overview.close();
// U23: arrowing through Sector scans only the value it settles on, and Refresh
// pressed before a pick has settled scans that pick once, not the previous scope.
const sectors=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await stubBridge(sectors,{urls:{'https://finviz.com/screener/stocks?v=111&o=change&r=1':await fixture('ui/finviz-losers-r1-2026-10-31.html')}});
await sectors.goto(baseUrl+'/#/');
await sectors.waitForFunction(()=>document.querySelectorAll('.dash-row').length===20&&!document.querySelector('.dash-spinner'));
const scannedScopes=()=>sectors.evaluate(()=>window.__calls.filter(([channel,url])=>channel==='fetch-url'&&new URL(url).searchParams.get('r')==='1').map(([,url])=>new URL(url).searchParams.get('f')??'any'));
const sectorSelect=sectors.getByLabel('Sector',{exact:true});
await sectorSelect.focus();
for (let i=0;i<3;i++) await sectors.keyboard.press('ArrowDown');
await sectors.waitForTimeout(700);
assert.deepEqual(await scannedScopes(),['any','sec_consumercyclical']);
await sectors.keyboard.press('ArrowDown');
await sectors.getByRole('button',{name:'Refresh quotes',exact:true}).click();
await sectors.waitForTimeout(700);
assert.deepEqual(await scannedScopes(),['any','sec_consumercyclical','sec_consumerdefensive']);
await sectors.close();
// U58: when the stock page's chunk fails to load (here its first request, during the
// idle warm-up), the desk shows its error panel once, without an uncaught error, and
// the header and navigation stay usable. Go to Overview leaves it; Reload recovers it.
const chunk=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
const boundaryLogs=[];
chunk.on('console',message=>{ if (message.type()==='error'&&message.text().startsWith('Render error caught by an error boundary')) boundaryLogs.push(message.text()); });
let chunkRequests=0;
await chunk.route(/\/StockDetails[^/]*\.jsx?(\?|$)/,route=>(chunkRequests++===0?route.abort():route.continue()));
await chunk.goto(baseUrl+'/#/');
for (let i=0;i<100&&chunkRequests===0;i++) await chunk.waitForTimeout(50);
assert.equal(chunkRequests,1,'the stock page chunk is warmed up after startup');
await chunk.goto(baseUrl+'/#/stock/AAPL');
const deskError=chunk.getByRole('alert').filter({has:chunk.getByRole('heading',{name:'This desk hit an error',exact:true})});
await deskError.waitFor();
assert.equal(await chunk.getByRole('navigation',{name:'Main navigation',exact:true}).count(),1);
assert.equal(boundaryLogs.length,1,'the failed desk is logged once');
await deskError.getByRole('button',{name:'Go to Overview',exact:true}).click();
await chunk.locator('main .dashboard').waitFor();
await chunk.goto(baseUrl+'/#/stock/AAPL');
await deskError.getByRole('button',{name:'Reload',exact:true}).click();
await chunk.locator('main .stock-details').waitFor();
await chunk.close();
// With storage refused on every access (site data blocked), every desk still renders.
const noStorage=await watch(await browser.newPage({viewport:{width:1440,height:1050}}));
await noStorage.addInitScript(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){ throw new DOMException('The operation is insecure.','SecurityError'); }}));
for (const route of ROUTES.filter(route=>route.root)) {
 await noStorage.goto(baseUrl+route.path);
 await noStorage.reload();
 await noStorage.locator('main').locator(route.root).first().getByRole('heading',{name:route.heading}).first().waitFor();
 assert.equal(await noStorage.getByRole('heading',{name:/hit an error$/}).count(),0,`${route.path} failed without storage`);
}
await noStorage.close();
assert.deepEqual(errors,[]);
assert.deepEqual(cspViolations,[],'Content Security Policy violations');
console.log(JSON.stringify({routes:ROUTES.length,widths:[1440,390],instruments:59,rates:8,cached:59,legacyBridge:true,dataSettings:{chartCacheSeconds:300,requestTimeoutSeconds:45},plugTicks:axis.ticks,plugFill:Number(axis.fill.toFixed(2)),pageErrors:errors,cspViolations,screenshots:artifactDir},null,2));
await browser.close();
