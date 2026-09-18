import express from "express";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { AdapterRegistry } from "./core/registry.js";
import { channelAccountSchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { encryptSecret } from "../security/crypto.js";
import { writeAudit } from "../audit/index.js";

export function createChannelRouter(db:Database.Database,config:AppConfig,registry:AdapterRegistry){const router=express.Router();
  router.get("/",(_req,res)=>{const rows=db.prepare("SELECT id,channel_type,name,status,external_account_id,polling_interval_seconds,last_sync_at,last_error,consecutive_failure_count,next_retry_at,created_at,updated_at FROM channel_accounts ORDER BY name").all() as any[];res.json({items:rows.map(row=>({...row,capabilities:[...registry.get(row.channel_type).capabilities],configured:row.status!=="NOT_CONFIGURED"}))});});
  router.post("/",requirePermission("customer_hub:manage_channels"),(req,res)=>{const parsed=channelAccountSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});const adapter=registry.get(parsed.data.channel_type);const validation=adapter.validateConfiguration(parsed.data.credentials??null);const id=randomUUID();const encrypted=parsed.data.credentials?encryptSecret(parsed.data.credentials,config.encryptionKey):null;db.transaction(()=>{db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds) VALUES(?,?,?,?,?,?,?)").run(id,parsed.data.channel_type,parsed.data.name,validation.valid?"ACTIVE":"NOT_CONFIGURED",encrypted,parsed.data.external_account_id,parsed.data.polling_interval_seconds??null);writeAudit(db,{actorUserId:req.panelUser!.id,action:"CHANNEL_CREATED",entityType:"channel_account",entityId:id,ip:req.ip,payload:{channel_type:parsed.data.channel_type,name:parsed.data.name,configured:validation.valid}});})();res.status(201).json({id,channel_type:parsed.data.channel_type,name:parsed.data.name,status:validation.valid?"ACTIVE":"NOT_CONFIGURED",configured:validation.valid,validation_errors:validation.errors});});
  return router;}
