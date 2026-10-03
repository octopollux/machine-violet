import {describe,it,expect,vi} from "vitest";
import {validateCampaign,type ValidationIO} from "./validator.js";
import {SqliteKnowledgeStore} from "../../knowledge/sqlite-store.js";
import type {MapData} from "@machine-violet/shared/types/maps.js";
import type {ClocksState} from "@machine-violet/shared/types/clocks.js";
const cleanClocks=():ClocksState=>({calendar:{epoch:"0",current:100,display_format:"d/m/y",alarms:[]},combat:{active:false,current:0,alarms:[]}});
function fixture(config:string|null='{"version":2}'){
  const store=new SqliteKnowledgeStore(":memory:");
  const provider=vi.fn(async()=>store);
  const io={campaignKnowledge:provider,readFile:vi.fn(async()=>config??""),exists:vi.fn(async()=>config!==null),listDir:vi.fn(async()=>[])} as ValidationIO;
  return {store,io,provider};
}
describe("validateCampaign",()=>{
  it("validates arbitrary nested knowledge without entity directory scans",async()=>{
    const {store,io}=fixture();await store.mutate([{op:"create_collection",name:"Spells"},{op:"upsert",collection:"Spells",name:"Fire",fields:{power:5}}]);
    const result=await validateCampaign("/camp",{},cleanClocks(),io);expect(result.errorCount).toBe(0);expect(result.warningCount).toBe(0);expect(result.filesChecked).toBeGreaterThan(2);expect(io.listDir).not.toHaveBeenCalled();
  });
  it.each([undefined,"{bad json",'{"version":1}','{"version":999}',"{}"])("rejects unsupported/broken config before accessing store: %s",async(config)=>{
    const {io,provider}=fixture(config??null);const result=await validateCampaign("/camp",{},cleanClocks(),io);
    expect(result.errorCount).toBe(1);expect(provider).not.toHaveBeenCalled();
  });
  it("validates map bounds and canonical UID character references",async()=>{
    const {store,io}=fixture();await store.mutate([{op:"upsert",collection:"Characters",name:"Bob"}]);const uid=(await store.resolve("Bob"))!;
    const map:MapData={id:"test",gridType:"square",bounds:{width:10,height:10},defaultTerrain:"floor",regions:[],terrain:{},entities:{"15,15":[{id:`PC:${uid}`,type:"npc"}]},annotations:{},links:[],meta:{}};
    const result=await validateCampaign("/camp",{test:map},cleanClocks(),io);expect(result.issues.some(issue=>issue.message.includes("out of bounds"))).toBe(true);expect(result.warningCount).toBe(0);
  });
  it("continues validating separate clocks",async()=>{
    const {io}=fixture();const clocks=cleanClocks();clocks.calendar.alarms.push({id:"a1",fires_at:50,message:"Past alarm"});
    const result=await validateCampaign("/camp",{},clocks,io);expect(result.errorCount).toBe(0);expect(result.issues.some(issue=>issue.message.includes("Past alarm"))).toBe(true);
  });
});
