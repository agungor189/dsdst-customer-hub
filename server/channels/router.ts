import express from "express";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { AdapterRegistry } from "./core/registry.js";
import { channelAccountSchema, whatsappTemplateListQuerySchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { writeAudit } from "../audit/index.js";
import { ProviderError } from "./core/types.js";

export function createChannelRouter(db:Database.Database,config:AppConfig,registry:AdapterRegistry){const router=express.Router();
  router.get("/",(_req,res)=>{const rows=db.prepare("SELECT id,channel_type,name,status,external_account_id,polling_interval_seconds,last_sync_at,last_error,consecutive_failure_count,next_retry_at,created_at,updated_at FROM channel_accounts ORDER BY name").all() as any[];res.json({items:rows.map(row=>({...row,capabilities:[...registry.get(row.channel_type).capabilities],configured:row.status!=="NOT_CONFIGURED"}))});});
  router.get("/:id/whatsapp/templates",requirePermission("customer_hub:reply"),async(req,res)=>{
    const parsed=whatsappTemplateListQuerySchema.safeParse(req.query);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const row=db.prepare("SELECT id,channel_type,external_account_id,encrypted_credentials FROM channel_accounts WHERE id=?").get(req.params.id) as any;
    if(!row)return res.status(404).json({error:{code:"NOT_FOUND"}});
    if(row.channel_type!=="META_WHATSAPP")return res.status(400).json({error:{code:"CHANNEL_NOT_SUPPORTED",message:"Channel account is not WhatsApp"}});
    const adapter=registry.get("META_WHATSAPP");
    if(!adapter.listWhatsAppTemplates)return res.status(501).json({error:{code:"NOT_SUPPORTED"}});
    try{
      const credentials=row.encrypted_credentials?decryptSecret<Record<string,string>>(row.encrypted_credentials,config.encryptionKey):null;
      const templates=await adapter.listWhatsAppTemplates({id:row.id,externalAccountId:row.external_account_id,credentials});
      const items=parsed.data.status?templates.filter(item=>item.status===parsed.data.status):templates;
      res.json({items,approved_count:templates.filter(item=>item.status==="APPROVED").length});
    }catch(error){
      if(error instanceof ProviderError)return res.status(error.code==="WHATSAPP_WABA_REQUIRED"?400:502).json({error:{code:error.code,message:error.message,retryable:error.retryable}});
      throw error;
    }
  });
  router.post("/",requirePermission("customer_hub:manage_channels"),(req,res)=>{const parsed=channelAccountSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});const adapter=registry.get(parsed.data.channel_type);const validation=adapter.validateConfiguration(parsed.data.credentials??null,parsed.data.external_account_id);const id=randomUUID();const encrypted=parsed.data.credentials?encryptSecret(parsed.data.credentials,config.encryptionKey):null;const pollingInterval=parsed.data.polling_interval_seconds??(adapter.capabilities.has("POLLING")?60:null);db.transaction(()=>{db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds) VALUES(?,?,?,?,?,?,?)").run(id,parsed.data.channel_type,parsed.data.name,validation.valid?"ACTIVE":"NOT_CONFIGURED",encrypted,parsed.data.external_account_id,pollingInterval);writeAudit(db,{actorUserId:req.panelUser!.id,action:"CHANNEL_CREATED",entityType:"channel_account",entityId:id,ip:req.ip,payload:{channel_type:parsed.data.channel_type,name:parsed.data.name,configured:validation.valid}});})();res.status(201).json({id,channel_type:parsed.data.channel_type,name:parsed.data.name,status:validation.valid?"ACTIVE":"NOT_CONFIGURED",configured:validation.valid,validation_errors:validation.errors});});
  return router;}
