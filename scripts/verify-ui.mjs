// Browser regressions use recorded source data; fixtures never enter runtime views.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const artifactDir=fileURLToPath(new URL('../artifacts/', import.meta.url));
const baseUrl=process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
await mkdir(artifactDir,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route(/https:\/\/(s3\.tradingview|fonts\.googleapis|fonts\.gstatic)/,route=>route.abort());
await page.goto(baseUrl+'/#/futures');
await page.getByText('Quotes unavailable',{exact:true}).waitFor();
assert.equal(await page.locator('.futures-table tbody tr').count(),0);
assert.equal(await page.locator('.chart-caption').last().textContent(),'Finviz source samples · intradayUnavailable');
await page.screenshot({path:artifactDir+'/futures-unavailable.png',fullPage:true});
for (const url of ['/#/','/#/etfs','/#/oil','/#/discovery','/#/stock/AAPL','/#/settings']) {
 await page.goto(baseUrl+url);
 await page.waitForTimeout(700);
 assert.equal(await page.getByText('Zombie Corp',{exact:true}).count(),0);
 assert.equal(await page.getByText('Mock News',{exact:false}).count(),0);
}
const liveData=await readFile(new URL('../tests/fixtures/futures-reference.json',import.meta.url),'utf8');
await page.addInitScript(({liveData})=>{
 window.__failQuotes=false;
 window.require=()=>({ipcRenderer:{invoke:async(_method,url)=>{
  if (window.__failQuotes) throw new Error('Controlled network failure');
  if (url.includes('/api/futures_all')) return liveData;
  throw new Error('Unexpected endpoint');
 }}});
},{liveData});
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
await page.evaluate(()=>window.__failQuotes=true);
await page.getByRole('button',{name:'Refresh quotes',exact:true}).click();
await page.getByText('Refresh incomplete · previous quotes retained',{exact:true}).waitFor();
assert.equal(await page.locator('.source-banner-time').textContent(),fetchedBefore);
assert.equal(await page.locator('.futures-table tbody .quote-status.cached').count(),59);
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:artifactDir+'/futures-mobile.png',fullPage:true});
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'page overflows narrow viewport');
assert.deepEqual(errors,[]);
console.log(JSON.stringify({routes:7,instruments:59,rates:8,cached:59,narrowWidth:390,pageErrors:errors,screenshots:artifactDir},null,2));
await browser.close();
