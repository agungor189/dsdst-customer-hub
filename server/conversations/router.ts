import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { assignmentSchema, conversationQuerySchema, emailAttachmentReplySchema, noteSchema, readStateSchema, replySchema, statusSchema, whatsappTemplateSendSchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { queueEmailReplyWithAttachments, queueReply, queueWhatsAppTemplate } from "../outbox/service.js";
import { writeAudit } from "../audit/index.js";
import { getPanelCustomerContext, PanelUnavailableError } from "../panel/client.js";
import type { AdapterRegistry } from "../channels/core/registry.js";
import { decryptSecret } from "../security/crypto.js";
import { ProviderError } from "../channels/core/types.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from "../attachments/storage.js";
import { canAccessConversation, conversationAccountScope } from "../auth/ownership.js";

const json = <T>(value: string | null, fallback: T): T => { try { return JSON.parse(value || "") as T; } catch { return fallback; } };

export function createConversationRouter(db: Database.Database, config: AppConfig, registry: AdapterRegistry) {
  const router=express.Router();
  const replyUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_ATTACHMENT_BYTES,files:MAX_ATTACHMENT_COUNT,fields:4}}).array("attachments",MAX_ATTACHMENT_COUNT);
  router.param("id",(req,res,next,id)=>{
    if(!req.panelUser||!canAccessConversation(db,String(id),req.panelUser))return res.status(404).json({error:{code:"NOT_FOUND"}});
    next();
  });
  router.get("/counts",(req,res)=>{
    const scope=conversationAccountScope("a",req.panelUser!);
    const base=`FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.merged_into_contact_id IS NULL AND ${scope.sql}`;
    const row=db.prepare(`SELECT
      count(*) all_count,
      sum(CASE WHEN c.unread_count>0 THEN 1 ELSE 0 END) unread_count,
      sum(CASE WHEN c.assigned_user_id IS NULL THEN 1 ELSE 0 END) unassigned_count,
      sum(CASE WHEN c.assigned_user_id=? THEN 1 ELSE 0 END) mine_count,
      sum(CASE WHEN c.status='WAITING_INTERNAL' THEN 1 ELSE 0 END) waiting_count,
      sum(CASE WHEN c.status='RESOLVED' THEN 1 ELSE 0 END) resolved_count
      ${base}`).get(req.panelUser!.id,...scope.params) as any;
    const channelRows=db.prepare(`SELECT a.channel_type,count(*) count ${base} GROUP BY a.channel_type`).all(...scope.params) as Array<{channel_type:string;count:number}>;
    const assigneeRows=db.prepare(`SELECT c.assigned_user_id,count(*) count ${base} AND c.assigned_user_id IS NOT NULL GROUP BY c.assigned_user_id`).all(...scope.params) as Array<{assigned_user_id:string;count:number}>;
    res.json({
      all:Number(row.all_count??0),unread:Number(row.unread_count??0),unassigned:Number(row.unassigned_count??0),mine:Number(row.mine_count??0),
      waiting:Number(row.waiting_count??0),resolved:Number(row.resolved_count??0),
      channels:Object.fromEntries(channelRows.map(item=>[item.channel_type,Number(item.count)])),
      assignees:Object.fromEntries(assigneeRows.map(item=>[item.assigned_user_id,Number(item.count)])),
    });
  });
  router.get("/",(req,res)=>{
    const parsed=conversationQuerySchema.safeParse(req.query); if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const scope=conversationAccountScope("a",req.panelUser!);
    const q=parsed.data; const where:string[]=["ct.merged_into_contact_id IS NULL",scope.sql]; const params:any[]=[...scope.params];
    if(q.channel){where.push("a.channel_type=?");params.push(q.channel);} if(q.status){where.push("c.status=?");params.push(q.status);}
    if(q.priority){where.push("c.priority=?");params.push(q.priority);} if(q.assigned){where.push(q.assigned==="unassigned"?"c.assigned_user_id IS NULL":"c.assigned_user_id=?");if(q.assigned!=="unassigned")params.push(q.assigned);}
    if(q.unread==="true")where.push("c.unread_count>0");
    if(q.tag){where.push("EXISTS(SELECT 1 FROM conversation_tags filter_tag WHERE filter_tag.conversation_id=c.id AND filter_tag.tag_id=?)");params.push(q.tag);}
    if(q.q){where.push(`(ct.display_name LIKE ? OR ct.email LIKE ? OR ct.phone LIKE ? OR EXISTS(SELECT 1 FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.username LIKE ?) OR EXISTS(SELECT 1 FROM message_search ms WHERE ms.conversation_id=c.id AND ms.body_text MATCH ?) OR json_extract(c.metadata_json,'$.sku') LIKE ? OR json_extract(c.metadata_json,'$.order_code') LIKE ?)`);const like=`%${q.q}%`;params.push(like,like,like,like,`"${q.q.replace(/"/g,'')}"*`,like,like);}
    const total=(db.prepare(`SELECT count(*) count FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE ${where.join(" AND ")}`).get(...params) as {count:number}).count;
    params.push(q.limit);
    const rows=db.prepare(`SELECT c.*,a.channel_type,a.name channel_name,ct.display_name,
      (SELECT body_text FROM messages WHERE conversation_id=c.id ORDER BY datetime(created_at) DESC LIMIT 1) last_message
      FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id
      WHERE ${where.join(" AND ")} ORDER BY datetime(c.last_message_at) DESC LIMIT ?`).all(...params) as any[];
    const tagStmt=db.prepare("SELECT t.id,t.name,t.color FROM tags t JOIN conversation_tags ct ON ct.tag_id=t.id WHERE ct.conversation_id=? ORDER BY t.name");
    res.json({items:rows.map(row=>({...row,metadata:json(row.metadata_json,{}),tags:tagStmt.all(row.id)})),total});
  });
  router.get("/:id",(req,res)=>{
    const conversation=db.prepare(`SELECT c.*,a.channel_type,a.name channel_name,a.status channel_status,ct.display_name,ct.email,ct.phone,ct.panel_customer_id,
      (SELECT ci.external_user_id FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.channel_account_id=c.channel_account_id LIMIT 1) customer_identifier
      FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=?`).get(req.params.id) as any;
    if(!conversation)return res.status(404).json({error:{code:"NOT_FOUND"}});
    const messages=db.prepare("SELECT id,direction,sender_type,sender_external_id,body_text,body_html,message_type,status,external_created_at,received_at,sent_at,created_at,metadata_json FROM messages WHERE conversation_id=? ORDER BY datetime(created_at),rowid").all(req.params.id) as any[];
    const attachmentRows=db.prepare(`SELECT a.id,a.message_id,a.type,a.filename,a.mime_type,a.size_bytes,a.storage_path IS NOT NULL downloadable
      FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=? ORDER BY a.created_at,a.id`).all(req.params.id) as any[];
    const attachmentsByMessage=new Map<string,any[]>();
    for(const attachment of attachmentRows){const items=attachmentsByMessage.get(attachment.message_id)??[];items.push({...attachment,download_url:attachment.downloadable?`/api/attachments/${attachment.id}/download`:null});attachmentsByMessage.set(attachment.message_id,items);}
    const notes=db.prepare("SELECT * FROM internal_notes WHERE conversation_id=? ORDER BY datetime(created_at)").all(req.params.id);
    const tags=db.prepare("SELECT t.* FROM tags t JOIN conversation_tags ct ON ct.tag_id=t.id WHERE ct.conversation_id=?").all(req.params.id);
    const scope=conversationAccountScope("history_account",req.panelUser!);
    const conversationHistory=db.prepare(`SELECT history.id,history.subject,history.status,history.last_message_at,history_account.channel_type,history_account.name channel_name
      FROM conversations history JOIN channel_accounts history_account ON history_account.id=history.channel_account_id
      WHERE history.contact_id=? AND history.id<>? AND ${scope.sql} ORDER BY datetime(history.last_message_at) DESC LIMIT 10`).all(conversation.contact_id,conversation.id,...scope.params);
    res.json({...conversation,capabilities:[...registry.get(conversation.channel_type).capabilities],metadata:json(conversation.metadata_json,{}),messages:messages.map(message=>({...message,metadata:json(message.metadata_json,{}),attachments:attachmentsByMessage.get(message.id)??[]})),notes,tags,conversation_history:conversationHistory});
  });
  router.put("/:id/read-state",requirePermission("customer_hub:view"),(req,res)=>{
    const parsed=readStateSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const unreadCount=parsed.data.unread?1:0;
    db.transaction(()=>{
      db.prepare("UPDATE conversations SET unread_count=? WHERE id=?").run(unreadCount,req.params.id);
      db.prepare("INSERT INTO conversation_events(id,conversation_id,event_type,actor_user_id,payload_json) VALUES(?,?,?,?,?)").run(randomUUID(),req.params.id,parsed.data.unread?"MARKED_UNREAD":"MARKED_READ",req.panelUser!.id,JSON.stringify(parsed.data));
      writeAudit(db,{actorUserId:req.panelUser!.id,action:parsed.data.unread?"CONVERSATION_MARKED_UNREAD":"CONVERSATION_MARKED_READ",entityType:"conversation",entityId:String(req.params.id),ip:req.ip});
    })();
    res.json({unread_count:unreadCount});
  });
  router.post("/:id/replies",requirePermission("customer_hub:reply"),(req,res,next)=>{
    if(!req.is("multipart/form-data"))return next();
    replyUpload(req,res,error=>{
      if(error instanceof multer.MulterError){const code=error.code==="LIMIT_FILE_SIZE"?"ATTACHMENT_TOO_LARGE":error.code==="LIMIT_FILE_COUNT"||error.code==="LIMIT_UNEXPECTED_FILE"?"TOO_MANY_ATTACHMENTS":"VALIDATION_ERROR";return res.status(400).json({error:{code}});}
      if(error)return next(error);
      const parsed=emailAttachmentReplySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
      const files=(req.files as Express.Multer.File[]|undefined)??[];
      try{return res.status(202).json(queueEmailReplyWithAttachments(db,registry,config.attachmentsDir,String(req.params.id),parsed.data.body,parsed.data.client_message_id,files.map(file=>({filename:file.originalname,mimeType:file.mimetype,content:file.buffer})),req.panelUser!,req.ip));}
      catch(error:any){return res.status(error.status??500).json({error:{code:error.code??"REPLY_FAILED",message:error.message}});}
    });
  },(req,res)=>{
    const parsed=replySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    try{res.status(202).json(queueReply(db,registry,String(req.params.id),parsed.data.body,parsed.data.client_message_id,req.panelUser!,req.ip));}catch(error:any){res.status(error.status??500).json({error:{code:error.code??"REPLY_FAILED",message:error.message}});}
  });
  router.post("/:id/whatsapp-template",requirePermission("customer_hub:reply"),async(req,res)=>{
    const parsed=whatsappTemplateSendSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const conversation=db.prepare(`SELECT c.id,c.channel_account_id,a.channel_type,a.external_account_id,a.encrypted_credentials
      FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?`).get(req.params.id) as any;
    if(!conversation)return res.status(404).json({error:{code:"NOT_FOUND"}});
    if(conversation.channel_type!=="META_WHATSAPP")return res.status(400).json({error:{code:"CHANNEL_NOT_SUPPORTED",message:"Conversation is not WhatsApp"}});
    const adapter=registry.get("META_WHATSAPP");
    if(!adapter.validateWhatsAppTemplate)return res.status(501).json({error:{code:"NOT_SUPPORTED"}});
    try{
      const existing=db.prepare("SELECT id,status,conversation_id FROM messages WHERE client_message_id=?").get(parsed.data.client_message_id) as any;
      if(existing){
        if(existing.conversation_id!==conversation.id)return res.status(409).json({error:{code:"IDEMPOTENCY_CONFLICT"}});
        return res.status(202).json({id:existing.id,status:existing.status,duplicate:true});
      }
      const credentials=conversation.encrypted_credentials?decryptSecret<Record<string,string>>(conversation.encrypted_credentials,config.encryptionKey):null;
      await adapter.validateWhatsAppTemplate(
        {id:conversation.channel_account_id,externalAccountId:conversation.external_account_id,credentials},
        parsed.data.template_name,parsed.data.language_code,{body:parsed.data.body_parameters,header:parsed.data.header_parameters},
      );
      res.status(202).json(queueWhatsAppTemplate(db,registry,conversation.id,{
        templateName:parsed.data.template_name,languageCode:parsed.data.language_code,bodyParameters:parsed.data.body_parameters,
        headerParameters:parsed.data.header_parameters,clientMessageId:parsed.data.client_message_id,
      },req.panelUser!,req.ip));
    }catch(error:any){
      if(error instanceof ProviderError)return res.status(error.code.startsWith("WHATSAPP_TEMPLATE")||error.code==="WHATSAPP_WABA_REQUIRED"||error.code==="PROVIDER_VALIDATION_FAILED"?400:502).json({error:{code:error.code,message:error.message,retryable:error.retryable}});
      res.status(error.status??500).json({error:{code:error.code??"REPLY_FAILED",message:error.message}});
    }
  });
  router.post("/:id/notes",requirePermission("customer_hub:view"),(req,res)=>{
    const parsed=noteSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const id=randomUUID();db.transaction(()=>{db.prepare("INSERT INTO internal_notes(id,conversation_id,user_id,username,text) VALUES(?,?,?,?,?)").run(id,req.params.id,req.panelUser!.id,req.panelUser!.username,parsed.data.text);writeAudit(db,{actorUserId:req.panelUser!.id,action:"NOTE_CREATED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip});})();const created=db.prepare("SELECT id,user_id,username,text,created_at FROM internal_notes WHERE id=?").get(id);res.status(201).json(created);
  });
  router.put("/:id/assignment",requirePermission("customer_hub:assign"),(req,res)=>{
    const parsed=assignmentSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const current=db.prepare("SELECT assigned_user_id FROM conversations WHERE id=?").get(req.params.id) as {assigned_user_id:string|null};
    if(parsed.data.assigned_user_id!==null&&parsed.data.assigned_user_id!==req.panelUser!.id)return res.status(403).json({error:{code:"ASSIGNMENT_SELF_ONLY",message:"Konuşmalar yalnızca kendinize atanabilir."}});
    if(current.assigned_user_id&&current.assigned_user_id!==req.panelUser!.id)return res.status(409).json({error:{code:"ASSIGNED_TO_ANOTHER_USER",message:"Konuşma başka bir kullanıcıya atanmış."}});
    db.transaction(()=>{db.prepare("UPDATE conversations SET assigned_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.assigned_user_id,req.params.id);db.prepare("INSERT INTO conversation_events(id,conversation_id,event_type,actor_user_id,payload_json) VALUES(?,?,?,?,?)").run(randomUUID(),req.params.id,"ASSIGNMENT_CHANGED",req.panelUser!.id,JSON.stringify(parsed.data));writeAudit(db,{actorUserId:req.panelUser!.id,action:"ASSIGNMENT_CHANGED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip,payload:parsed.data});})();res.json({ok:true,assigned_user_id:parsed.data.assigned_user_id});
  });
  router.put("/:id/status",requirePermission("customer_hub:assign"),(req,res)=>{
    const parsed=statusSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    db.transaction(()=>{db.prepare("UPDATE conversations SET status=?,closed_at=CASE WHEN ? IN ('CLOSED','RESOLVED') THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.status,parsed.data.status,req.params.id);writeAudit(db,{actorUserId:req.panelUser!.id,action:"STATUS_CHANGED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip,payload:parsed.data});})();res.json({ok:true});
  });
  router.put("/:id/tags/:tagId",requirePermission("customer_hub:manage_tags"),(req,res)=>{const tag=db.prepare("SELECT id,name,color FROM tags WHERE id=?").get(req.params.tagId);if(!tag)return res.status(404).json({error:{code:"TAG_NOT_FOUND"}});db.prepare("INSERT OR IGNORE INTO conversation_tags(conversation_id,tag_id) VALUES(?,?)").run(req.params.id,req.params.tagId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"TAG_ADDED",entityType:"conversation",entityId:String(req.params.id),payload:{tag_id:req.params.tagId}});res.json(tag);});
  router.delete("/:id/tags/:tagId",requirePermission("customer_hub:manage_tags"),(req,res)=>{db.prepare("DELETE FROM conversation_tags WHERE conversation_id=? AND tag_id=?").run(req.params.id,req.params.tagId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"TAG_REMOVED",entityType:"conversation",entityId:String(req.params.id),payload:{tag_id:req.params.tagId}});res.status(204).end();});
  router.get("/:id/customer-notes",requirePermission("customer_hub:view"),(req,res)=>{
    const conversation=db.prepare("SELECT contact_id FROM conversations WHERE id=?").get(req.params.id) as {contact_id:string};
    const items=db.prepare("SELECT id,user_id,username,text,visibility,created_at FROM customer_notes WHERE contact_id=? AND (visibility='SHARED' OR owner_user_id=?) ORDER BY datetime(created_at),rowid").all(conversation.contact_id,req.panelUser!.id);
    res.json({items});
  });
  router.post("/:id/customer-notes",requirePermission("customer_hub:view"),(req,res)=>{
    const parsed=noteSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const conversation=db.prepare(`SELECT c.contact_id,a.channel_type,a.owner_user_id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?`).get(req.params.id) as {contact_id:string;channel_type:string;owner_user_id:string|null};
    const personal=conversation.channel_type==="EMAIL";const visibility=personal?"PERSONAL":"SHARED";const ownerUserId=personal?req.panelUser!.id:null;const id=randomUUID();
    db.transaction(()=>{db.prepare("INSERT INTO customer_notes(id,contact_id,user_id,username,text,visibility,owner_user_id) VALUES(?,?,?,?,?,?,?)").run(id,conversation.contact_id,req.panelUser!.id,req.panelUser!.username,parsed.data.text,visibility,ownerUserId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"CUSTOMER_NOTE_CREATED",entityType:"contact",entityId:conversation.contact_id,ip:req.ip,payload:{visibility}});})();
    res.status(201).json(db.prepare("SELECT id,user_id,username,text,visibility,created_at FROM customer_notes WHERE id=?").get(id));
  });
  router.get("/:id/customer-context",requirePermission("customer_hub:view_customer_context"),async(req,res)=>{
    const contact=db.prepare("SELECT ct.panel_customer_id,ct.email,ct.phone FROM contacts ct JOIN conversations c ON c.contact_id=ct.id WHERE c.id=?").get(req.params.id) as any;if(!contact)return res.status(404).json({status:"not_found"});
    try{res.json(await getPanelCustomerContext(config,req.panelToken!,contact.panel_customer_id,{email:contact.email,phone:contact.phone}));}catch(error){if(error instanceof PanelUnavailableError)return res.status(200).json({status:"unavailable",message:"Panel şu anda erişilemiyor"});throw error;}
  });
  return router;
}
