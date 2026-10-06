/** Summarize normalized calls without charging reasoning twice. Estimates, not invoices. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory=resolve(process.argv[2]??'.batch-runs');
const rates:Record<string,{input:number;cached:number;write:number;output:number;source:string}>={
 'gpt-6.1-sol':{input:2,cached:.10,write:2.50,output:10,source:'https://developers.openai.com/api/docs/models/gpt-6.1-sol'},
 'gpt-6-luna':{input:.10,cached:.01,write:.125,output:.50,source:'https://developers.openai.com/api/docs/models/gpt-6-luna'}
};
interface Call {model:string;role?:string;effort?:string|null;usage?:{inputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;outputTokens:number;reasoningTokens:number};error?:string}
const results:unknown[]=[];
for(const entry of await readdir(directory,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 const path=join(directory,entry.name,'calls.json');let calls:Call[];
 try{calls=JSON.parse(await readFile(path,'utf8')) as Call[];}catch{continue;}
 let total=0,unknown=0;const priced= calls.map(call=>{
  const rate=rates[call.model],u=call.usage;if(!rate||!u){unknown++;return {...call,estimateUsd:null};}
  const long=u.inputTokens>272000;const inputMultiplier=long?2:1;const outputMultiplier=long?1.5:1;
  const uncached=Math.max(0,u.inputTokens-u.cacheReadTokens-u.cacheCreationTokens);
  const estimateUsd=(uncached*rate.input*inputMultiplier+u.cacheReadTokens*rate.cached*inputMultiplier+u.cacheCreationTokens*rate.write*inputMultiplier+u.outputTokens*rate.output*outputMultiplier)/1e6;
  total+=estimateUsd;return {...call,uncachedInput:uncached,reasoningSubset:u.reasoningTokens,estimateUsd,longContext:long};
 });
 results.push({arm:entry.name,calls:calls.length,failures:calls.filter(c=>c.error).length,estimatedUsd:total,unpricedCalls:unknown,pricedCalls:priced});
}
await writeFile(join(directory,'cost-estimates.json'),JSON.stringify({date:'2026-10-05',rates,assumptions:['Standard service tier assumed; actual wire service tier unavailable','No regional surcharge assumed; region routing unavailable','Fast tier would double estimate; regional surcharge may add 10 percent','Output includes reasoning; reasoning breakdown not billed again','Normalized OpenAI input includes cached and cache-write categories; each priced once','Cache creation category observed separately; billing semantics must be confirmed against invoice'],results},null,2));
console.log(`Wrote estimates for ${results.length} arms`);
