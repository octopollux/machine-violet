/** Repeatable isolated GameEngine A/B workload; explicit --live required. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as paceDelay } from 'node:timers/promises';
import { campaignDirs } from '../../engine/src/tools/filesystem/scaffold.js';
import { performance } from 'node:perf_hooks';
import { GameEngine } from '../../engine/src/agents/game-engine.js';
import { detectSceneState } from '../../engine/src/agents/scene-manager.js';
import { readBundledRuleCard } from '../../engine/src/config/systems.js';
import { EntityStore } from '../../engine/src/entities/store.js';
import { buildUIState } from '../../engine/src/agents/dm-prompt.js';
import { buildNameInspiration } from '../../engine/src/agents/name-inspiration.js';
import { createBaseFileIO } from '../../engine/src/server/fileio.js';
import { createClocksState } from '../../engine/src/tools/clocks/index.js';
import { createCombatState } from '../../engine/src/tools/combat/index.js';
import { createDecksState } from '../../engine/src/tools/cards/index.js';
import { createObjectivesState } from '../../engine/src/tools/objectives/index.js';
import { loadModelConfig } from '../../engine/src/config/models.js';
import { buildEffectiveConnections, loadConnectionStore } from '../../engine/src/config/connections.js';
import { createProviderFromConnection } from '../../engine/src/providers/index.js';
import type { ChatParams, LLMProvider } from '../../engine/src/providers/types.js';
import type { CampaignConfig, EngineCallbacks, GameState } from '../../shared/src/index.js';

const args=process.argv.slice(2);
const opt=(key:string,fallback:string)=>args.includes(key)?args[args.indexOf(key)+1]??fallback:fallback;
const out=resolve(opt('--output',`.batch-runs/co-dm-paired-${Date.now()}`));
if(!out.startsWith(join(resolve('.'),'.batch-runs')+'\\')&&!out.startsWith(join(resolve('.'),'.batch-runs')+'/')) throw new Error('Output must stay inside .batch-runs');
const source=resolve(opt('--source','.batch-runs/sol61-gameplay-20261003/data/campaigns/long-patience'));
const isolationKey=(p:string)=>p.replace(/\\/g,'/').toLowerCase().replace(/\/$/,'');const outKey=isolationKey(out),sourceKey=isolationKey(source);if(outKey===sourceKey||outKey.startsWith(sourceKey+'/')||sourceKey.startsWith(outKey+'/'))throw new Error('Output cannot overlap captured source campaign');
const ref=opt('--ref','b1b0a0d');
const sourceCommit=spawnSync('git',['-C',source,'rev-parse',ref],{encoding:'utf8'});if(sourceCommit.status!==0)throw new Error('Source commit unavailable');
const pairs=Number(opt('--pairs','1'));
const thinkMs=Number(opt('--think-ms','0'));if(!Number.isInteger(thinkMs)||thinkMs<0||thinkMs>600000)throw new Error('--think-ms must be 0..600000');
if(!Number.isInteger(pairs)||pairs<1||pairs>5)throw new Error('--pairs 1..5');
const nameInspiration=buildNameInspiration();
const reloadAction='I quietly observe my surroundings again before making any new commitment.';
const actions=[
 'I finish my coffee and watch the entrance for the late liaison contact.',
 'I quietly inspect the nearest exit and listen to the room without approaching anyone.',
 'I ask the bartender whether anyone has left a message for Alex Mercer.',
 'I check my watch, then step outside and observe the street before deciding where to go.',
 'I look around carefully and listen before taking another step.',
 'I check whether anyone appears to be following me, without confronting them.',
 'I pause somewhere unobtrusive and review only what I have actually learned.'
];
const sourceListing=spawnSync('rg',['--files','packages/engine/src','packages/shared/src','packages/test-harness/bin','package-lock.json'],{encoding:'utf8'});if(sourceListing.status!==0)throw new Error('Source inventory failed');const sourceHashes=Object.fromEntries(await Promise.all(sourceListing.stdout.trim().split(/\r?\n/).sort().map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));const workingTreeHash=createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
await mkdir(out,{recursive:true});
await writeFile(join(out,'source-hashes.json'),JSON.stringify(sourceHashes,null,2));
await writeFile(join(out,'manifest.json'),JSON.stringify({mode:'paired-live-game-engine',workingTreeHash,node:process.version,routing:{dm:{model:'gpt-6.1-sol',effort:'medium'},coDm:{model:'gpt-6.1-sol',effort:'medium'},scribe:{model:'gpt-6-luna',effort:'recorded per wire request'}},live:args.includes('--live'),source,ref,sourceCommit:sourceCommit.stdout.trim(),pairs,actions,reloadAction,forcedCutAfter:4,thinkMs,schedule:thinkMs?`controlled pace: arrival at verified readiness + ${thinkMs}ms; think excluded from turn latency`:'fast-player: submit immediately after verified waiting_input; no completion sleep',randomness:'normal engine random mechanics; not fixed; label independent branch divergence',images:'disabled matched campaign config; image quality not measured',limitations:['No UI or human-paced measurements','Narrative divergence requires blind review and exclusions','Session end/reload separately measured']},null,2));
if(!args.includes('--live')&&!args.includes('--prepare')){console.log(`Prepared paired manifest: ${out}; no provider calls`);process.exit(0);}
await writeFile(join(out,'dev-config.jsonc'),JSON.stringify({effort:{dm:'medium'}}));
loadModelConfig({reset:true,cwd:out});
const configDir=resolve(opt('--config','.batch-runs/sol61-gameplay-20261003/config'));
const connections=buildEffectiveConnections(loadConnectionStore(configDir),configDir);
const conn=connections.connections.find(c=>c.provider==='openai-apikey');
if(!conn)throw new Error('No OpenAI API-key connection available');
for(let pair=1;pair<=pairs;pair++)for(const arm of pair%2?['baseline','candidate']:['candidate','baseline']){
 const dir=join(out,`${pair}-${arm}`);await mkdir(dir,{recursive:true});
 const archive=spawnSync('git',['-C',source,'archive',ref],{maxBuffer:128*1024*1024});
 if(archive.status!==0)throw new Error('Campaign snapshot archive failed');
 const unpack=spawnSync('tar',['-xf','-','-C',dir],{input:archive.stdout});
 if(unpack.status!==0)throw new Error('Campaign snapshot extraction failed');
 for(const directory of campaignDirs(dir))await mkdir(directory,{recursive:true});
 const config=JSON.parse(await readFile(join(dir,'config.json'),'utf8')) as CampaignConfig;
 config.recovery.enable_git=false;config.image_generation='off';
 const raw=createProviderFromConnection(conn,{configDir});const calls:unknown[]=[];const trace:unknown[]=[];const turns:Record<string,unknown>[]=[];
 const capture=async(p:ChatParams,invoke:()=>ReturnType<LLMProvider['chat']>)=>{if(!args.includes('--live'))throw new Error('Offline preparation attempted provider inference');const start=performance.now();const {dispatchTool:_dispatchTool,...requestData}=p;void _dispatchTool;const requestSnapshot=structuredClone(requestData);const requestHash=createHash('sha256').update(JSON.stringify(requestSnapshot)).digest('hex');const systemHash=createHash('sha256').update(JSON.stringify(requestSnapshot.systemPrompt)).digest('hex');privateInputs.push({start,params:requestSnapshot});try{const result=await invoke();privateInputs.push({start,result:structuredClone(result)});calls.push({role:p.conversationId??'unknown',requestHash,systemHash,model:p.model,effort:p.thinking?.effort??null,provider:raw.providerId,start,end:performance.now(),usage:structuredClone(result.usage),billing:{uncachedInput:Math.max(0,result.usage.inputTokens-result.usage.cacheReadTokens-result.usage.cacheCreationTokens),cachedInput:result.usage.cacheReadTokens,cacheWrite:result.usage.cacheCreationTokens,outputIncludingReasoning:result.usage.outputTokens,reasoningSubset:result.usage.reasoningTokens},costUsd:null});return result;}catch{calls.push({role:p.conversationId??'unknown',model:p.model,effort:p.thinking?.effort??null,start,end:performance.now(),error:'provider-call-failed'});throw new Error('Provider call failed');}};
 const provider:LLMProvider=new Proxy(raw,{get(t,k){if(k==='chat')return(p:ChatParams)=>capture(p,()=>t.chat(p));if(k==='stream')return(p:ChatParams,d:(s:string)=>void)=>capture(p,()=>t.stream(p,d));const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 let ui={modelines:{} as Record<string,string>,styleName:'clean',variant:'exploration'};
 let completed=false;let preparedOnly=false;let lastReady=performance.now();const engineErrors:{name:string;message:string;classification:string}[]=[];
 const sanitize=(text:string)=>text.replaceAll(conn.apiKey,'[credential]').replace(/sk-[A-Za-z0-9_-]+/g,'[credential]').replace(/Bearer\s+[^\s]+/gi,'Bearer [credential]');
 const assertNoEngineErrors=()=>{if(engineErrors.length)throw new Error(`Engine callback failure: ${engineErrors[0]?.classification}`);};
 const pace=async()=>{const scheduledArrival=lastReady+thinkMs;const remaining=scheduledArrival-performance.now();if(remaining>0)await paceDelay(remaining);return {thinkMs,scheduledReady:lastReady,scheduledArrival};};
 let current:Record<string,unknown>|undefined;
 const privateInputs:unknown[]=[];let io=createBaseFileIO();let engine:GameEngine|undefined;
 const active=()=>{if(!engine)throw new Error('Engine not booted');return engine;};
 const knowledge=async()=>{if(!io.campaignKnowledge)throw new Error('Knowledge provider missing');return io.campaignKnowledge(dir);};
 const callbacks:EngineCallbacks={onNarrativeDelta:d=>{if(d&&current&&current.firstText==null)current.firstText=performance.now();trace.push({type:'text',at:performance.now(),text:d});},onNarrativeComplete:text=>{if(current)current.narrativeEnd=performance.now();trace.push({type:'narrative-complete',at:performance.now(),text});},onStateChange:state=>{if(state==='waiting_input'){lastReady=performance.now();if(current)current.inputReady=lastReady;}trace.push({type:'state',state,at:performance.now()});},onTuiCommand:command=>{if(command.type==='update_modeline'&&typeof command.character==='string'&&typeof command.text==='string')ui.modelines[command.character]=command.text;if(command.type==='set_theme'&&typeof command.theme==='string')ui.styleName=command.theme;if(typeof command.variant==='string')ui.variant=command.variant;engine?.setUIState(buildUIState(ui));trace.push({type:'tui',command,at:performance.now()});},onToolStart:name=>trace.push({type:'tool-start',name,at:performance.now()}),onToolEnd:(name,result)=>trace.push({type:'tool-end',name,result,at:performance.now()}),onExchangeDropped:()=>trace.push({type:'exchange-dropped',at:performance.now()}),onUsageUpdate:(usage,tier)=>trace.push({type:'usage',usage,tier,at:performance.now()}),onError:error=>{const message=sanitize(error.message);const classification=/ENOENT/.test(message)?'missing-file':/provider|API/i.test(message)?'provider-error':'engine-error';engineErrors.push({name:error.name,message,classification});trace.push({type:'engine-error',name:error.name,message,classification,at:performance.now()});},onRetry:(status,delayMs)=>trace.push({type:'retry',status,delayMs,at:performance.now()}),onTurnStart:()=>{if(current)current.accepted=performance.now();},onTurnEnd:()=>trace.push({type:'turn-end',at:performance.now()})};
 const boot=async()=>{
  const scene=await detectSceneState(dir,io);const state:GameState={maps:{},clocks:createClocksState(),combat:createCombatState(),combatConfig:config.combat,decks:createDecksState(),objectives:createObjectivesState(),config,campaignRoot:dir,homeDir:join(dir,'home'),activePlayerIndex:0,displayResources:{},resourceValues:{}};
  const knowledge=await io.campaignKnowledge?.(dir);const notes=await knowledge?.resolve('DM Notes');
  const entityStore=new EntityStore(dir,io);const sheets:string[]=[];for(const player of config.players)if(await entityStore.exists('character',player.character))sheets.push((await entityStore.read('character',player.character)).raw);
  const rules=config.system?readBundledRuleCard(config.system):null; if(config.system&&!rules)throw new Error('Bundled rule card unavailable; explicit imported rule-card support required');
  engine=new GameEngine({provider,tierProviders:{large:{provider,model:'gpt-6.1-sol'},medium:{provider,model:'gpt-6.1-sol'},small:{provider,model:'gpt-6-luna'}},gameState:state,scene,sessionState:{nameInspiration,...(rules?{rulesAppendix:rules}:{}),...(sheets.length?{pcSheets:sheets.join('\n\n---\n\n')}:{}),...(notes&&knowledge?{dmNotes:(await knowledge.read(notes,{textLimit:16000})).body}:{})},fileIO:io,callbacks,...(arm==='candidate'?{coDmExperiment:{isolatedCampaign:true as const,provider,model:'gpt-6.1-sol',onEvent:event=>{const at=performance.now();trace.push({type:'co-dm-queue',...event,at});if(event.kind==='enqueue'&&current)current.queueEventIds=event.eventIds;if(event.kind==='commit')for(const turn of turns){const ids=turn.queueEventIds as string[]|undefined;if(ids?.length&&ids.every(id=>event.eventIds?.includes(id)))turn.catchup=at;}}}}:{})});
  const loaded=await engine.getPersister()?.loadAll();if(loaded){if(loaded.combat)Object.assign(state.combat,loaded.combat);if(loaded.clocks)Object.assign(state.clocks,loaded.clocks);if(loaded.decks)Object.assign(state.decks,loaded.decks);if(loaded.objectives)Object.assign(state.objectives,loaded.objectives);if(loaded.resources){state.displayResources=loaded.resources.displayResources??{};state.resourceValues=loaded.resources.resourceValues??{};}if(loaded.ui){ui={modelines:loaded.ui.modelines??{},styleName:loaded.ui.styleName??'clean',variant:loaded.ui.variant??'exploration'};engine.setUIState(buildUIState(ui));}if(loaded.conversation)engine.seedConversation(loaded.conversation);if(loaded.scene)Object.assign(scene,{precis:loaded.scene.precis??scene.precis,openThreads:loaded.scene.openThreads??scene.openThreads,npcIntents:loaded.scene.npcIntents??scene.npcIntents,playerReads:loaded.scene.playerReads??scene.playerReads});}
  await engine.resumeSession();assertNoEngineErrors();
 };
 try{
  await boot();const openingScene=active().getSceneManager().getScene().sceneNumber;
  if(args.includes('--prepare')&&!args.includes('--live')) { await writeFile(join(dir,'prepared.json'),JSON.stringify({state:active().getState(),scene:active().getSceneManager().getScene().sceneNumber,providerCalls:calls.length}));completed=true;preparedOnly=true;continue; }
  for(let i=0;i<actions.length;i++){
   if(active().getState()!=='waiting_input')throw new Error('Input readiness gate failed');
   const schedule=await pace();current={index:i+1,...schedule,arrival:performance.now(),scene:active().getSceneManager().getScene().sceneNumber};turns.push(current);
   await active().processInput(config.players[0]?.character??'Alex Mercer',actions[i]??'');current.returned=performance.now();assertNoEngineErrors();current.sceneAfter=active().getSceneManager().getScene().sceneNumber;current.boundaryBearing=current.sceneAfter!==current.scene;
   if(active().getState()!=='waiting_input')throw new Error('Turn did not return to input readiness');
   const queue=active().getCoDmState();current.queueAfterTurn=queue?{epoch:queue.epoch,cursor:queue.cursor,pending:queue.pending.length,mailbox:queue.mailbox.length}:null; if(current.catchup==null)current.catchup='pending: ordinary turns do not impose a drain';
   if(i===3){const reachedScene=active().getSceneManager().getScene().sceneNumber;if(reachedScene>openingScene){trace.push({type:'boundary-schedule',kind:'natural-cut-already-reached',afterTurn:4,scene:reachedScene,at:performance.now()});}else{current=undefined;const start=performance.now();await active().transitionScene('Street observation');assertNoEngineErrors();trace.push({type:'forced-transition',start,end:performance.now()});}}
  }
  current=undefined;const endStart=performance.now();await active().endSession('Experimental session');assertNoEngineErrors();await active().settleDeferredWork();assertNoEngineErrors();trace.push({type:'session-end',start:endStart,end:performance.now()});
  const before=await (await knowledge()).snapshot();await io.closeKnowledgeStores?.();io=createBaseFileIO();const reloadStart=performance.now();await boot();await active().settleCoDm();const after=await (await knowledge()).snapshot();trace.push({type:'reload',start:reloadStart,end:performance.now(),knowledgeEqual:before===after});if(before!==after)throw new Error('Reload knowledge snapshot mismatch');assertNoEngineErrors();
  const reloadSchedule=await pace();current={index:8,kind:'post-reload',...reloadSchedule,arrival:performance.now(),scene:active().getSceneManager().getScene().sceneNumber};turns.push(current);await active().processInput(config.players[0]?.character??'Alex Mercer',reloadAction);current.returned=performance.now();assertNoEngineErrors();if(active().getState()!=='waiting_input')throw new Error('Post-reload input failed');completed=true;
 }finally{await engine?.settleCoDm().catch(()=>{completed=false;trace.push({type:'catchup-failed'});});await engine?.settleDeferredWork().catch(()=>{completed=false;trace.push({type:'settle-failed'});});await writeFile(join(dir,'run-status.json'),JSON.stringify({valid:completed&&engineErrors.length===0,preparedOnly,completed,errorClassifications:engineErrors.map(e=>e.classification),thinkMs}));await writeFile(join(dir,'turn-timing.json'),JSON.stringify(turns,null,2));await writeFile(join(dir,'calls.json'),JSON.stringify(calls,null,2));const usageTotals:Record<string,Record<string,number>>={};for(const call of calls as {role?:string;model:string;usage?:Record<string,number>}[]){if(!call.usage)continue;const key=`${call.role??'unknown'}:${call.model}`;const row=usageTotals[key]??{};for(const [category,count]of Object.entries(call.usage))row[category]=(row[category]??0)+count;usageTotals[key]=row;}await writeFile(join(dir,'usage-totals.json'),JSON.stringify({usageTotals,dollars:null,reasoningBilling:'Included in output; do not charge twice',priceStatus:'pending verified per-model source'},null,2));await writeFile(join(dir,'trace.private.json'),JSON.stringify(trace,null,2));await writeFile(join(dir,'provider.private.json'),JSON.stringify(privateInputs,null,2));await io.closeKnowledgeStores?.();await raw.dispose?.();}
 if(!completed||engineErrors.length)throw new Error(`Paired arm failed; inspect ${join(dir,'run-status.json')} and private trace diagnostics`);
 console.log(`Completed paired arm ${pair} ${arm}`);
}
