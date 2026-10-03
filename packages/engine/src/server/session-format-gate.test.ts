import {describe,it,expect,vi} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SessionManager} from "./session-manager.js";
import {createDefaultCampaignConfig} from "../tools/filesystem/config.js";
import {loadEnv} from "../config/first-launch.js";
vi.mock("../config/first-launch.js",()=>({loadEnv:vi.fn(()=>{throw new Error("Providers must never initialize during rejected save loading");})}));
describe("SessionManager campaign format preflight",()=>{
  it.each([undefined,1,999])("rejects Markdown save version %s before model/runtime setup or filesystem writes",async(version)=>{
    const temporary=await mkdtemp(join(tmpdir(),"mv-session-version-"));
    try{
      const campaign=join(temporary,"old");await mkdir(join(campaign,"characters"),{recursive:true});const config={...createDefaultCampaignConfig("Old","Player","Bob"),version};
      const configPath=join(campaign,"config.json"),sheetPath=join(campaign,"characters","bob.md");await writeFile(configPath,JSON.stringify(config));await writeFile(sheetPath,"# Bob\n\nLegacy sheet");
      const beforeConfig=await readFile(configPath),beforeSheet=await readFile(sheetPath);const manager=new SessionManager(temporary);
      await expect(manager.startSession("old")).rejects.toThrow("not supported");
      expect(manager.getEngine()).toBeNull();expect(loadEnv).not.toHaveBeenCalled();
      expect(await readFile(configPath)).toEqual(beforeConfig);expect(await readFile(sheetPath)).toEqual(beforeSheet);expect((await readdir(campaign)).sort()).toEqual(["characters","config.json"]);
    }finally{await rm(temporary,{recursive:true,force:true});}
  });
  it("rejects malformed version-2 config before providers or database creation",async()=>{
    const temporary=await mkdtemp(join(tmpdir(),"mv-session-shape-"));
    try{const campaign=join(temporary,"broken");await mkdir(campaign);await writeFile(join(campaign,"config.json"),'{"version":2}');
      await expect(new SessionManager(temporary).startSession("broken")).rejects.toThrow("Invalid campaign configuration");
      expect(loadEnv).not.toHaveBeenCalled();expect(await readdir(campaign)).toEqual(["config.json"]);
    }finally{await rm(temporary,{recursive:true,force:true});}
  });
});
