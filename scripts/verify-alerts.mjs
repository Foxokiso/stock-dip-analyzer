import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
await page.addInitScript(()=>{
 window.__contexts=0;window.__closed=0;
 const param={setValueAtTime(){},linearRampToValueAtTime(){}};
 class AudioContext {
 constructor(){window.__contexts++;this.currentTime=0;this.destination={};}
 createGain(){return {gain:param,connect(){}};}
 createBiquadFilter(){return {frequency:param,connect(){}};}
 createDynamicsCompressor(){return {attack:param,threshold:param,ratio:param,connect(){}};}
 createOscillator(){const osc={frequency:param,detune:param,connect(){},start(){},stop(){setTimeout(()=>osc.onended?.(),0);}};return osc;}
 close(){window.__closed++;return Promise.resolve();}
 }
 window.AudioContext=AudioContext;
});
await page.goto((process.env.UI_BASE_URL || 'http://127.0.0.1:5174')+'/#/futures');
await page.getByRole('heading',{name:/See the market/}).waitFor();
await page.evaluate(()=>window.dispatchEvent(new CustomEvent('stock-alert',{detail:{symbol:'TEST',type:'breakdown',color:'amber',message:'Controlled alert',timestamp:Date.now()}})));
await page.waitForTimeout(250);
const result=await page.evaluate(()=>({contexts:window.__contexts,closed:window.__closed}));
console.log(result);
await browser.close();
assert.equal(result.contexts,1,'one alert must create only one audio context under StrictMode');
assert.equal(result.closed,1,'completed alert must release its audio context');
