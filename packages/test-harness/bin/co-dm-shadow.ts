/** Explicitly opt-in, isolated provider replay; never imports the withheld oracle into agent context. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SqliteKnowledgeStore } from '../../engine/src/knowledge/sqlite-store.js';
import { buildKnowledgeToolHandler, ENTITY_TOOLS, ENTITY_INPUT_POLICIES } from '../../engine/src/entities/tools.js';
import { runScribe, type ScribeFileIO } from '../../engine/src/agents/subagents/scribe.js';
import { loadConnectionStore, buildEffectiveConnections } from '../../engine/src/config/connections.js';
import { createProviderFromConnection } from '../../engine/src/providers/index.js';
import { loadModelConfig } from '../../engine/src/config/models.js';
import type { KnowledgeValue } from '../../shared/src/types/knowledge.js';
import type { ChatParams, LLMProvider } from '../../engine/src/providers/types.js';

const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Required fixture handle missing'); return value; };
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? required(args[args.indexOf(name) + 1]) : fallback;
const root = resolve('.');
const fixtures = resolve(option('--fixtures', 'docs/experiments/co-dm/fixtures'));
const output = resolve(option('--output', `.batch-runs/co-dm-shadow-${Date.now()}`));
if (!output.startsWith(join(root, '.batch-runs') + '\\') && !output.startsWith(join(root, '.batch-runs') + '/')) throw new Error('Output must be inside workspace .batch-runs');
const repeats = Number(option('--repeats', '1'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('--repeats must be 1..5');
const arms = option('--arms', 'baseline,candidate').split(',');
if (arms.some(arm => !['baseline', 'candidate'].includes(arm))) throw new Error('--arms baseline,candidate');
const sources = await Promise.all(['initial-state.json', 'events.json', 'oracle.json'].map(name => readFile(join(fixtures, name), 'utf8')));
const initial = JSON.parse(required(sources[0]));
const feed = JSON.parse(required(sources[1]));
const oracle = JSON.parse(required(sources[2])); // evaluator scope only
const hashes = sources.map(s => createHash('sha256').update(s).digest('hex'));
await mkdir(output, { recursive: true });
await writeFile(join(output, 'manifest.json'), JSON.stringify({ mode: 'shadow-memory-only', live: args.includes('--live'), repeats, arms, fixtureHashes: hashes, node: process.version, limitations: ['No interactive latency claims', 'Portrait/theme and prose invariants require separate review', 'Wire provider effort recorded; dollars unavailable unless validated price source supplied'] }, null, 2));
if (!args.includes('--live')) {
  console.log(`Prepared manifest at ${output}; no provider calls. Add --live to execute.`);
  process.exit(0);
}
loadModelConfig({ reset: true });
const configDir = resolve(option('--config', '.batch-runs/sol61-gameplay-20261003/config'));
const connections = buildEffectiveConnections(loadConnectionStore(configDir), configDir);
const conn = connections.connections.find(c => c.provider === 'openai-apikey') ?? connections.connections.find(c => c.provider === 'openrouter');
if (!conn) throw new Error('No API-key provider in configured connection store');
const prices = args.includes('--prices') ? JSON.parse(await readFile(resolve(option('--prices','')), 'utf8')) : null;

for (let repeat = 1; repeat <= repeats; repeat++) for (const arm of arms) {
  const dir = join(output, `${arm}-${repeat}`); await mkdir(dir, { recursive: true });
  let store = new SqliteKnowledgeStore(join(dir, 'knowledge.sqlite'), { create: true });
  const ids: Record<string, string> = {};
  const collections: Record<string, string> = {};
  for (const path of initial.collections as string[]) {
    const parts = path.split('/'); let parent: string | undefined;
    for (let n = 0; n < parts.length; n++) {
      const prefix = parts.slice(0, n + 1).join('/');
      if (!collections[prefix]) { await store.mutate([{ op: 'create_collection', name: required(parts[n]), ...(parent ? { parent } : {}) }]); collections[prefix] = required(await store.resolve(required(parts[n]))); }
      parent = collections[prefix];
    }
  }
  for (const record of initial.records) {
    await store.mutate([{ op: 'upsert', collection: required(collections[record.collection]), name: record.name, aliases: [record.uid, ...(record.aliases ?? [])], body: record.body ?? '', visibility: record.visibility === 'public' ? 'player-facing' : 'private' }]);
    ids[record.uid] = required(await store.resolve(record.name));
  }
  const map = (value: unknown): KnowledgeValue => Array.isArray(value) ? value.map(map) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? ids[v] ?? v : map(v)])) : value as KnowledgeValue;
  for (const record of initial.records) {
    await store.mutate([{ op: 'patch', uid: required(ids[record.uid]), fields: map(record.data) as Record<string, KnowledgeValue> }]);
    if (record.approvedPublic) await store.mutate([{ op: 'disclose', uid: required(ids[record.uid]), ...record.approvedPublic }]);
  }
  const io: ScribeFileIO = { campaignKnowledge: async () => store, readFile: async p => readFile(p, 'utf8'), writeFile: async (p,c) => { await mkdir(resolve(p, '..'), {recursive:true}); await writeFile(p,c); }, exists: async () => false, listDir: async () => [], mkdir: async p => { await mkdir(p,{recursive:true}); } };
  const calls: unknown[] = []; const ledger: unknown[] = []; const scores: unknown[] = [];
  const raw = createProviderFromConnection(conn, { configDir });
  const capture = async (params: ChatParams, invoke: () => ReturnType<LLMProvider['chat']>) => {
    const start = performance.now(); const {dispatchTool:_dispatchTool,...requestData}=params;void _dispatchTool;const requestSnapshot=structuredClone(requestData);ledger.push({type:'provider-request',start,params:requestSnapshot});const base = { model: params.model, effort: params.thinking?.effort ?? null, provider: raw.providerId, inputHash: createHash('sha256').update(JSON.stringify({system:requestSnapshot.systemPrompt,messages:requestSnapshot.messages,tools:requestSnapshot.tools})).digest('hex'), start };
    try { const result = await invoke(); ledger.push({type:'provider-output',model:params.model,result:structuredClone(result)}); calls.push({...base,end:performance.now(),usage:structuredClone(result.usage),billing:{uncachedInput:Math.max(0,result.usage.inputTokens-result.usage.cacheReadTokens-result.usage.cacheCreationTokens),cachedInput:result.usage.cacheReadTokens,outputIncludingReasoning:result.usage.outputTokens,reasoningSubset:result.usage.reasoningTokens,cacheWrites:result.usage.cacheCreationTokens},costUsd:prices?.[params.model] ? ((Math.max(0,result.usage.inputTokens-result.usage.cacheReadTokens-result.usage.cacheCreationTokens)*prices[params.model].input + result.usage.cacheReadTokens*prices[params.model].cached + result.usage.outputTokens*prices[params.model].output + result.usage.cacheCreationTokens*(prices[params.model].write ?? prices[params.model].input))/1e6) : null,priceSource:prices?.source ?? null}); return result; }
    catch { calls.push({...base,end:performance.now(),error:'provider-call-failed'}); throw new Error('Provider call failed; details retained by provider local diagnostics'); }
  };
  const provider: LLMProvider = new Proxy(raw, { get(target,key) { if(key === 'chat') return (p:ChatParams) => capture(p, () => target.chat(p)); if(key === 'stream') return (p:ChatParams,d:(s:string)=>void) => capture(p, () => target.stream(p,d)); const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value as KnowledgeValue; } });
  const state = structuredClone(initial); let scene = 1;
  const frozen = () => JSON.stringify({ knowledge: undefined, fixtureUidMapping: ids, authoritative: { resources: state.resources, deck: state.deck, modeline: state.modeline, theme: state.theme, dmNotes: state.dmNotes } });
  const handler = buildKnowledgeToolHandler(store, { sceneNumber: () => scene, source: 'co-dm' });
  const { ContinuingCoDmAgent } = await import('../../engine/src/agents/experiments/co-dm-agent.js');
  const candidate = arm === 'candidate' ? new ContinuingCoDmAgent({provider,model:'gpt-6.1-sol',frozenContext:`${frozen()}\n${await store.snapshot()}`,tools:ENTITY_TOOLS,toolInputPolicies:ENTITY_INPUT_POLICIES,toolHandler:async (name,input) => { const result = await handler(name,input); ledger.push({scene,name,input,result}); return required(result); }}) : null;
  let pending: unknown[] = [];
  try {
    for (const stage of feed.stages) {
      for (const event of stage.events) {
        if (event.type === 'dm.notes_updated') state.dmNotes = event.payload.text;
        if (event.type === 'tool.outcome' && event.payload.ok) {
          for (const [key,value] of Object.entries(event.payload.authoritative ?? {})) {
            if (key in state.resources) state.resources[key] = value;
            else if (key === 'modeline') state.modeline = value;
            // Custody is deliberately agent-maintained rather than prewritten into knowledge.
          }
        }
      }
      pending.push(...stage.events.map(map));
      if (candidate && [2,3].includes(stage.stage)) continue;
      const start = performance.now();
      const result = candidate ? await candidate.run(pending) : await runScribe(provider,{updates:[{visibility:([1,2,4].includes(stage.stage)?'private':'player-facing'),content:stage.baselineHandoff.text}],campaignRoot:dir,sceneNumber:scene,homeDir:dir},io,'gpt-6-luna');
      pending = [];
      const snapshot = await store.snapshot();
      await writeFile(join(dir, `stage-${stage.stage}.private.json`),JSON.stringify({watermark:stage.events.at(-1).seq,knowledgeOutline:snapshot,records:await Promise.all((await store.outline()).filter(n=>n.kind==="entity").map(n=>store.read(n.uid,{textLimit:100000,logLimit:100}))),state,feedback:'feedback' in result ? result.feedback : undefined,start,end:performance.now()},null,2));
      for (const checkpoint of oracle.checkpoints.filter((c: { stage: number })=>c.stage === stage.stage)) {
        const expected = checkpoint.expectedValues ?? {}; const checks: unknown[] = [];
        for(const [uid,path] of Object.entries(expected.collectionOf ?? {})) { const node=await store.read(required(ids[uid])); checks.push({group:'sharedMemory',check:`collection ${uid}`,pass:node.parent===collections[path as string]}); }
        const privateFigure=await store.read(required(ids.figure),{textLimit:100000});
        const publicEntities=await Promise.all((await store.outline()).filter(n=>n.kind==='entity').map(n=>store.read(n.uid,{textLimit:100000})));
        checks.push({group:'sharedMemory',check:'secret allegiance not public',pass:!JSON.stringify(publicEntities.filter(n=>n.visibility==='player-facing')).includes('dead-drop network')});
        checks.push({group:'sharedMemory',check:'rumor does not establish dead=true',pass:privateFigure.fields.dead!==true});
        if(stage.stage>=7) { const archive=await store.read(required(ids.archive),{textLimit:100000}); const original=initial.records.find((r:{uid:string})=>r.uid==='archive'); checks.push({group:'sharedMemory',check:'archive body exact',pass:archive.body===original.body}); }

        for (const ref of expected.refs ?? []) { const node=await store.read(required(ids[ref.uid]),{textLimit:100000}); checks.push({group:'sharedMemory',check:`${ref.uid}.${ref.field}`,pass:JSON.stringify(node.fields[ref.field])===JSON.stringify(map(ref.equals))}); }
        for(const [from,to] of Object.entries(expected.redirects ?? {})) checks.push({group:'sharedMemory',check:`redirect ${from}`,pass:await store.resolveUid(required(ids[from]))===ids[to as string]});
        for(const [uid,text] of Object.entries(expected.retainedBodyIncludes ?? {})) checks.push({group:'sharedMemory',check:`body ${uid}`,pass:(await store.read(required(ids[uid]),{textLimit:100000})).body.includes(text as string)});
        for(const preservation of expected.exactPreservation ?? []) { const original=initial.records.find((r: { uid: string })=>r.uid===preservation.uid); const node=await store.read(required(ids[preservation.uid]),{textLimit:100000}); checks.push({group:'sharedMemory',check:`preserve ${preservation.uid}.${preservation.field}`,pass:JSON.stringify(preservation.field==='body'?node.body:node.fields)===JSON.stringify(preservation.field==='body'?original.body:map(original.data))}); }
        scores.push({stage:stage.stage,watermark:checkpoint.watermark,checks,proseReview:'pending',candidateOnly:'unscored: dedicated presentation integration required'});
      }
      if(stage.stage===9) { scene++; candidate?.reset(`${frozen()}\n${snapshot}`); }
    }
    const before=await store.snapshot(); const beforeRecords=JSON.stringify(await Promise.all((await store.outline()).filter(n=>n.kind==='entity').map(n=>store.read(n.uid,{textLimit:100000,logLimit:100})))); await store.close(); store=new SqliteKnowledgeStore(join(dir,'knowledge.sqlite')); const after=await store.snapshot(); const afterRecords=JSON.stringify(await Promise.all((await store.outline()).filter(n=>n.kind==='entity').map(n=>store.read(n.uid,{textLimit:100000,logLimit:100}))));
    scores.push({check:'sqlite reload exact',group:'sharedMemory',pass:before===after && beforeRecords===afterRecords});
    if(candidate) await writeFile(join(dir,'continuing-context.private.json'),JSON.stringify(candidate.getMessages()));
  } finally {
    await writeFile(join(dir,'calls.json'),JSON.stringify(calls,null,2));
    await writeFile(join(dir,'operations.private.json'),JSON.stringify(ledger,null,2));
    await writeFile(join(dir,'scores.json'),JSON.stringify(scores,null,2));
    await store.close(); await raw.dispose?.();
  }
  console.log(`Completed ${arm} repeat ${repeat}: ${dir}`);
}
