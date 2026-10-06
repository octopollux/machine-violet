/** Summarize normalized calls without charging reasoning twice. Estimates, not invoices. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory=resolve(process.argv[2]??'.batch-runs');
// Read the shipped catalog directly: offline reports must not inherit local user overrides.
interface PublishedRate {
 pricing:{input:number;cacheRead:number;cacheWrite:number;output:number};
 pricingDetails?:{source:string;checkedAt:string;serviceTier:string;longContext?:{aboveInputTokens:number;inputMultiplier:number;outputMultiplier:number}};
}
const catalog=JSON.parse(await readFile(new URL('../../engine/src/config/known-models.json',import.meta.url),'utf8')) as {models:Record<string,PublishedRate>};
const rates=Object.fromEntries(Object.entries(catalog.models)
 .filter(([,model])=>model.pricingDetails?.serviceTier==='standard')
 .map(([id,model])=>[id,{input:model.pricing.input,cached:model.pricing.cacheRead,write:model.pricing.cacheWrite,output:model.pricing.output,...model.pricingDetails}]));
interface Call {model:string;role?:string;effort?:string|null;usage?:{inputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;outputTokens:number;reasoningTokens:number};error?:string}
const results:unknown[]=[];
for(const entry of await readdir(directory,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 const path=join(directory,entry.name,'calls.json');let calls:Call[];
 try{calls=JSON.parse(await readFile(path,'utf8')) as Call[];}catch{continue;}
 let total=0,unknown=0;const priced= calls.map(call=>{
  const rate=rates[call.model],u=call.usage;if(!rate||!u){unknown++;return {...call,estimateUsd:null};}
  const policy=rate.longContext;const long=!!policy&&u.inputTokens>policy.aboveInputTokens;const inputMultiplier=long?(policy?.inputMultiplier??1):1;const outputMultiplier=long?(policy?.outputMultiplier??1):1;
  const uncached=Math.max(0,u.inputTokens-u.cacheReadTokens-u.cacheCreationTokens);
  const estimateUsd=(uncached*rate.input*inputMultiplier+u.cacheReadTokens*rate.cached*inputMultiplier+u.cacheCreationTokens*rate.write*inputMultiplier+u.outputTokens*rate.output*outputMultiplier)/1e6;
  total+=estimateUsd;return {...call,uncachedInput:uncached,reasoningSubset:u.reasoningTokens,estimateUsd,longContext:long};
 });
 results.push({arm:entry.name,calls:calls.length,failures:calls.filter(c=>c.error).length,estimatedUsd:total,unpricedCalls:unknown,pricedCalls:priced});
}
await writeFile(join(directory,'cost-estimates.json'),JSON.stringify({date:new Date().toISOString().slice(0,10),rateCatalog:'packages/engine/src/config/known-models.json',rates,assumptions:['Standard service tier assumed; actual wire service tier unavailable','No regional surcharge assumed; region routing unavailable','Fast tier would double estimate; regional surcharge may add 10 percent','Output includes reasoning; reasoning breakdown not billed again','Normalized OpenAI input includes cached and cache-write categories; each priced once','Only models with checked Standard pricing provenance in the shipped catalog are priced','ChatGPT subscription calls are valued at API-equivalent rates, not subscription charges','Image jobs are excluded: captured calls contain no image billing usage'],results},null,2));
console.log(`Wrote estimates for ${results.length} arms`);
