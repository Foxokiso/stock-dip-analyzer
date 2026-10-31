// Shared by the browser regression scripts (verify-ui, verify-alerts), so both
// watch their pages the same way and answer through the same desktop bridge.
// Every watched page: uncaught errors and CSP violations are collected into the
// arrays given, and TradingView (the chart iframe's host) and web fonts never
// load from the network.
export const watcher=(errors,cspViolations)=>async(page)=>{
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('__reportCsp',violation=>cspViolations.push(violation));
 await page.addInitScript(()=>{
  if (window!==window.top) return;
  document.addEventListener('securitypolicyviolation',e=>window.__reportCsp(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
 });
 await page.route(/https:\/\/([a-z0-9-]+\.)*tradingview\.com|fonts\.googleapis|fonts\.gstatic/,route=>route.abort());
 return page;
};
// The desktop bridge as preload.cjs ships it: window.dipAnalyzer = { invoke }, in
// the top frame only. Recorded responses answer by request (fetch-url: the URL;
// fetch-yahoo-chart: 'SYMBOL range interval'), after an optional delay per channel.
// Anything else rejects in Electron's own wording, which the app's bridge strips;
// so does every request while window.__failWith holds a message. window.__calls
// logs every call.
export const stubBridge=(page,{urls={},charts={},delays={}}={})=>page.addInitScript(({urls,charts,delays})=>{
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
