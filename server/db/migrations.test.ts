import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "./index.js";
import { migrations } from "./migrations.js";

test("email ownership migration backfills only one unambiguous CHANNEL_CREATED actor and preserves data",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"customer-hub-migration-"));
  const filename=path.join(root,"hub.db");
  const legacy=new Database(filename);
  legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for(const migration of migrations.filter(item=>item.version<3)){
    legacy.exec(migration.sql);
    legacy.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(migration.version,migration.name);
  }
  const insertAccount=legacy.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,?,?,'ACTIVE',?)");
  insertAccount.run("email-clear","EMAIL","Clear","clear@example.test");
  insertAccount.run("email-ambiguous","EMAIL","Ambiguous","ambiguous@example.test");
  insertAccount.run("email-unknown","EMAIL","Unknown","unknown@example.test");
  insertAccount.run("shared","WEBSITE","Website","site");
  const audit=legacy.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id) VALUES(?,?,?,?,?)");
  audit.run("audit-1","alper","CHANNEL_CREATED","channel_account","email-clear");
  audit.run("audit-2","alper","CHANNEL_CREATED","channel_account","email-clear");
  audit.run("audit-3","alper","CHANNEL_CREATED","channel_account","email-ambiguous");
  audit.run("audit-4","tayfun","CHANNEL_CREATED","channel_account","email-ambiguous");
  audit.run("audit-ignored","nobody","CHANNEL_UPDATED","channel_account","email-unknown");
  legacy.close();

  const migrated=openDatabase(filename);
  const rows=migrated.prepare("SELECT id,owner_user_id FROM channel_accounts ORDER BY id").all() as Array<{id:string;owner_user_id:string|null}>;
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.id,row.owner_user_id])),{
    "email-ambiguous":null,
    "email-clear":"alper",
    "email-unknown":null,
    shared:null,
  });
  assert.equal((migrated.prepare("SELECT count(*) count FROM audit_logs").get() as {count:number}).count,5);
  assert.equal((migrated.prepare("SELECT count(*) count FROM schema_migrations WHERE version=3").get() as {count:number}).count,1);
  assert.equal((migrated.prepare("SELECT count(*) count FROM schema_migrations WHERE version=4").get() as {count:number}).count,1);
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_notes'").get());
  migrated.close();
  fs.rmSync(root,{recursive:true,force:true});
});
