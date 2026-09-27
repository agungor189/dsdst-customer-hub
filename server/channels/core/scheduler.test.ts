import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../test-utils.js";
import { encryptSecret } from "../../security/crypto.js";
import type { ChannelAdapter, ChannelSyncContext } from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import { ChannelSyncScheduler } from "./scheduler.js";

test("scheduler decrypts credentials per account without singleton account state and redacts failures",async()=>{
  const {db,config}=testDatabase();
  const first=db.prepare("SELECT id FROM channel_accounts WHERE channel_type='N11'").get() as {id:string};
  const firstCredentials={api_key:"first-key",api_secret:"first-secret"};
  const secondCredentials={api_key:"second-key",api_secret:"second-secret"};
  db.prepare("UPDATE channel_accounts SET status='ACTIVE',polling_interval_seconds=60,encrypted_credentials=?,external_account_id='n11-first' WHERE id=?")
    .run(encryptSecret(firstCredentials,config.encryptionKey),first.id);
  const secondId=randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds) VALUES(?,'N11','n11 second','ACTIVE',?,'n11-second',60)")
    .run(secondId,encryptSecret(secondCredentials,config.encryptionKey));

  const contexts:Array<{id:string;externalAccountId:string;apiKey:string|undefined}>=[];
  const adapter:ChannelAdapter={
    channelType:"N11",
    capabilities:new Set(["POLLING"]),
    validateConfiguration:()=>({valid:true,errors:[]}),
    async sendMessage(){throw new Error("unused");},
    async syncMessages(context:ChannelSyncContext){
      contexts.push({id:context.id,externalAccountId:context.externalAccountId,apiKey:context.credentials?.api_key});
      if(context.id===first.id) throw new Error(`provider rejected ${context.credentials?.api_secret}`);
    },
  };
  const registry={get:()=>adapter,list:()=>[]} as unknown as AdapterRegistry;
  await new ChannelSyncScheduler(db,registry,config).tick();
  assert.deepEqual(contexts,[
    {id:first.id,externalAccountId:"n11-first",apiKey:"first-key"},
    {id:secondId,externalAccountId:"n11-second",apiKey:"second-key"},
  ]);
  const failure=db.prepare("SELECT last_error FROM channel_accounts WHERE id=?").get(first.id) as {last_error:string};
  assert.equal(failure.last_error,"provider rejected [REDACTED]");
  assert.doesNotMatch(failure.last_error,/first-secret|first-key/);
  assert.equal((db.prepare("SELECT last_error FROM channel_accounts WHERE id=?").get(secondId) as any).last_error,null);
  db.close();
});
