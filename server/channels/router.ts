import express from "express";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { AdapterRegistry } from "./core/registry.js";
import { channelAccountSchema, channelAccountUpdateSchema, whatsappTemplateListQuerySchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { decryptSecret, encryptSecret, redactCredentialValues } from "../security/crypto.js";
import { writeAudit } from "../audit/index.js";
import { ProviderError } from "./core/types.js";
import { mergeChannelConfig, safeChannelConfig } from "./config-fields.js";
import type { ChannelType } from "../../shared/contracts/domain.js";
import { settingsAccountScope } from "../auth/ownership.js";

export function createChannelRouter(db:Database.Database,config:AppConfig,registry:AdapterRegistry){const router=express.Router();
  const safeLastError=(lastError:string|null,encrypted:string|null)=>{if(!lastError)return null;let credentials:Record<string,string>|null=null;try{credentials=encrypted?decryptSecret<Record<string,string>>(encrypted,config.encryptionKey):null;}catch{}return redactCredentialValues(lastError,credentials).replace(/[\r\n\t]+/g," ").slice(0,300)};
  const ownershipFields=(row:any,userId:string)=>({owner_user_id:row.owner_user_id??null,claimable:row.channel_type==="EMAIL"&&row.owner_user_id===null&&userId!==""});
  router.get("/",(req,res)=>{const scope=settingsAccountScope("ca",req.panelUser!);const rows=db.prepare(`SELECT id,channel_type,name,status,external_account_id,polling_interval_seconds,last_sync_at,last_error,consecutive_failure_count,next_retry_at,created_at,updated_at,encrypted_credentials,owner_user_id FROM channel_accounts ca WHERE ${scope.sql} ORDER BY name`).all(...scope.params) as any[];res.json({items:rows.map(({encrypted_credentials,...row})=>({...row,...ownershipFields(row,req.panelUser!.role==="admin"?req.panelUser!.id:""),last_error:safeLastError(row.last_error,encrypted_credentials),capabilities:[...registry.get(row.channel_type).capabilities],configured:row.status!=="NOT_CONFIGURED"}))});});
  router.get("/:id/config",(req,res)=>{
    const scope=settingsAccountScope("ca",req.panelUser!);
    const row=db.prepare(`SELECT id,channel_type,name,status,external_account_id,polling_interval_seconds,last_sync_at,last_error,encrypted_credentials,updated_at,owner_user_id FROM channel_accounts ca WHERE id=? AND ${scope.sql}`).get(req.params.id,...scope.params) as any;
    if(!row)return res.status(404).json({error:{code:"NOT_FOUND"}});
    let credentials:Record<string,string>|null=null;
    try{credentials=row.encrypted_credentials?decryptSecret<Record<string,string>>(row.encrypted_credentials,config.encryptionKey):null;}catch{return res.status(500).json({error:{code:"CREDENTIALS_UNREADABLE",message:"Kayıtlı kanal ayarları okunamadı."}});}
    const {encrypted_credentials:_,...account}=row;account.last_error=safeLastError(account.last_error,row.encrypted_credentials);
    res.setHeader("Cache-Control","no-store");
    res.json({...account,...ownershipFields(row,req.panelUser!.role==="admin"?req.panelUser!.id:""),...safeChannelConfig(row.channel_type as ChannelType,credentials),app_origin:config.appOrigin});
  });
  router.get("/:id/whatsapp/templates",requirePermission("customer_hub:reply"),async(req,res)=>{
    const parsed=whatsappTemplateListQuerySchema.safeParse(req.query);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const scope=settingsAccountScope("ca",req.panelUser!);
    const row=db.prepare(`SELECT id,channel_type,external_account_id,encrypted_credentials FROM channel_accounts ca WHERE id=? AND ${scope.sql}`).get(req.params.id,...scope.params) as any;
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
  router.post("/",requirePermission("customer_hub:manage_channels"),(req,res)=>{const parsed=channelAccountSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});const adapter=registry.get(parsed.data.channel_type);const validation=adapter.validateConfiguration(parsed.data.credentials??null,parsed.data.external_account_id);const id=randomUUID();const encrypted=parsed.data.credentials?encryptSecret(parsed.data.credentials,config.encryptionKey):null;const pollingInterval=parsed.data.polling_interval_seconds??(adapter.capabilities.has("POLLING")?60:null);const ownerUserId=parsed.data.channel_type==="EMAIL"?req.panelUser!.id:null;db.transaction(()=>{db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds,owner_user_id) VALUES(?,?,?,?,?,?,?,?)").run(id,parsed.data.channel_type,parsed.data.name,validation.valid?"ACTIVE":"NOT_CONFIGURED",encrypted,parsed.data.external_account_id,pollingInterval,ownerUserId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"CHANNEL_CREATED",entityType:"channel_account",entityId:id,ip:req.ip,payload:{channel_type:parsed.data.channel_type,name:parsed.data.name,configured:validation.valid}});})();res.status(201).json({id,channel_type:parsed.data.channel_type,name:parsed.data.name,status:validation.valid?"ACTIVE":"NOT_CONFIGURED",configured:validation.valid,owner_user_id:ownerUserId,claimable:false,validation_errors:validation.errors});});
  router.post("/:id/claim",requirePermission("customer_hub:manage_channels"),(req,res)=>{
    if(req.panelUser!.role!=="admin")return res.status(403).json({error:{code:"FORBIDDEN",message:"Yalnızca yöneticiler sahipsiz e-posta hesabını sahiplenebilir."}});
    const claimed=db.transaction(()=>{
      const result=db.prepare("UPDATE channel_accounts SET owner_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND channel_type='EMAIL' AND owner_user_id IS NULL").run(req.panelUser!.id,req.params.id);
      if(result.changes!==1)return false;
      writeAudit(db,{actorUserId:req.panelUser!.id,action:"CHANNEL_OWNERSHIP_CLAIMED",entityType:"channel_account",entityId:String(req.params.id),ip:req.ip,payload:{owner_user_id:req.panelUser!.id}});
      return true;
    })();
    if(!claimed)return res.status(404).json({error:{code:"NOT_FOUND"}});
    res.json({id:req.params.id,owner_user_id:req.panelUser!.id,claimable:false});
  });
  router.put("/:id",requirePermission("customer_hub:manage_channels"),(req,res)=>{
    const parsed=channelAccountUpdateSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const scope=settingsAccountScope("ca",req.panelUser!);
    const row=db.prepare(`SELECT id,channel_type,external_account_id,encrypted_credentials FROM channel_accounts ca WHERE id=? AND ${scope.sql}`).get(req.params.id,...scope.params) as any;
    if(!row)return res.status(404).json({error:{code:"NOT_FOUND"}});
    if((parsed.data.id&&parsed.data.id!==row.id)||parsed.data.channel_type!==row.channel_type)return res.status(409).json({error:{code:"CHANNEL_ACCOUNT_MISMATCH",message:"Kanal hesabı kimliği eşleşmiyor."}});
    try{
      const existing=row.encrypted_credentials?decryptSecret<Record<string,string>>(row.encrypted_credentials,config.encryptionKey):null;
      const merged=mergeChannelConfig(row.channel_type as ChannelType,existing,parsed.data.credentials);
      if(!merged.externalAccountId)return res.status(400).json({error:{code:"VALIDATION_ERROR",message:"Kanal hesap kimliği zorunludur."}});
      if(parsed.data.external_account_id&&parsed.data.external_account_id!==merged.externalAccountId)return res.status(409).json({error:{code:"CHANNEL_ACCOUNT_MISMATCH",message:"Kanal hesap kimliği ayarlarla eşleşmiyor."}});
      const adapter=registry.get(row.channel_type);
      const validation=adapter.validateConfiguration(merged.credentials,merged.externalAccountId);
      const status=validation.valid?"ACTIVE":"NOT_CONFIGURED";
      const polling=parsed.data.polling_interval_seconds===undefined
        ? undefined
        : parsed.data.polling_interval_seconds;
      db.transaction(()=>{
        if(polling===undefined)db.prepare("UPDATE channel_accounts SET name=?,status=?,encrypted_credentials=?,external_account_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.name,status,encryptSecret(merged.credentials,config.encryptionKey),merged.externalAccountId,row.id);
        else db.prepare("UPDATE channel_accounts SET name=?,status=?,encrypted_credentials=?,external_account_id=?,polling_interval_seconds=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.name,status,encryptSecret(merged.credentials,config.encryptionKey),merged.externalAccountId,polling,row.id);
        writeAudit(db,{actorUserId:req.panelUser!.id,action:"CHANNEL_UPDATED",entityType:"channel_account",entityId:row.id,ip:req.ip,payload:{channel_type:row.channel_type,name:parsed.data.name,configured:validation.valid,rotated_fields:merged.secretKeysUpdated}});
      })();
      res.json({id:row.id,channel_type:row.channel_type,name:parsed.data.name,status,external_account_id:merged.externalAccountId,configured:validation.valid,validation_errors:validation.errors});
    }catch(error:any){res.status(error.status??500).json({error:{code:error.code??"CHANNEL_UPDATE_FAILED",message:error.message}});}
  });
  return router;}
