import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SqliteKnowledgeStore} from "../../knowledge/sqlite-store.js";
import {createDefaultCampaignConfig} from "../filesystem/config.js";
import {CampaignRepo} from "./campaign-repo.js";
import {createGitIO} from "./isogit-adapter.js";
describe("real SQLite Git snapshots",()=>{
  it("reopens restored database and rolls back aliases, typed state, logs, references and notices together",async()=>{
    const temporary=await mkdtemp(join(tmpdir(),"mv-sqlite-git-"));let store:SqliteKnowledgeStore|undefined;
    try{
      const root=join(temporary,"campaign");await mkdir(root);await writeFile(join(root,"config.json"),JSON.stringify(createDefaultCampaignConfig("Test","Player","Shadow")));
      store=new SqliteKnowledgeStore(join(root,"knowledge.sqlite"),{create:true});
      const repo=new CampaignRepo({dir:root,git:createGitIO()});repo.snapshotHook=capture=>store!.withSnapshot(capture);repo.restoreHook=restore=>store!.withSnapshot(restore);
      await store.mutate([{op:"upsert",collection:"Characters",name:"Shadow",fields:{hp:7},history:"Arrived"},{op:"upsert",collection:"Lore",name:"Quest",fields:{hero:{$ref:"Shadow"}}}]);
      const originalUID=await store.resolve("Shadow"),originalNotices=await store.pendingNotices();await repo.init("checkpoint: original");const before=(await repo.getLog())[0].oid;
      await store.mutate([{op:"patch",uid:"Shadow",name:"Bob",fields:{hp:1},history:"Revealed"}]);await store.acknowledgeNotices(originalNotices.map(notice=>notice.id));const later=await repo.checkpoint("later");expect(later).not.toBeNull();expect(later).not.toBe(before);
      await repo.rollback(before);
      expect(await store.resolve("Shadow")).toBe(originalUID);expect(await store.resolve("Bob")).toBeNull();expect((await store.read("Shadow")).fields.hp).toBe(7);
      expect((await store.read("Shadow")).logs).toHaveLength(1);expect((await store.read("Quest")).fields.hero).toEqual({$ref:originalUID});expect(await store.pendingNotices()).toEqual(originalNotices);
      await store.mutate([{op:"patch",uid:"Shadow",fields:{hp:6}}]);expect((await store.read("Shadow")).fields.hp).toBe(6);
    }finally{await store?.close();await rm(temporary,{recursive:true,force:true});}
  });
  it("rejects an old-save target before resetting or writing current campaign bytes",async()=>{
    const temporary=await mkdtemp(join(tmpdir(),"mv-sqlite-gate-"));let store:SqliteKnowledgeStore|undefined;
    try{
      const root=join(temporary,"campaign");await mkdir(root);const configPath=join(root,"config.json");const config=createDefaultCampaignConfig("Test","Player","Bob");
      await writeFile(configPath,JSON.stringify({...config,version:1}));store=new SqliteKnowledgeStore(join(root,"knowledge.sqlite"),{create:true});const git=createGitIO();const repo=new CampaignRepo({dir:root,git});
      repo.snapshotHook=capture=>store!.withSnapshot(capture);repo.restoreHook=restore=>store!.withSnapshot(restore);await repo.init("checkpoint: old");const old=(await repo.getLog())[0].oid;
      await writeFile(configPath,JSON.stringify(config));await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",fields:{hp:7}}]);await repo.checkpoint("current");const bytes=await readFile(store.path);const configBytes=await readFile(configPath);
      await expect(repo.rollback(old)).rejects.toThrow("not supported");expect(await readFile(store.path)).toEqual(bytes);expect(await readFile(configPath)).toEqual(configBytes);expect((await store.read("Bob")).fields.hp).toBe(7);
    }finally{await store?.close();await rm(temporary,{recursive:true,force:true});}
  });
});
