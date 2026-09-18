import { randomUUID } from "node:crypto";
import express from "express";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { assignmentSchema, conversationQuerySchema, noteSchema, replySchema, statusSchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { queueReply } from "../outbox/service.js";
import { writeAudit } from "../audit/index.js";
import { getPanelCustomerContext, PanelUnavailableError } from "../panel/client.js";

const json = <T>(value: string | null, fallback: T): T => { try { return JSON.parse(value || "") as T; } catch { return fallback; } };

export function createConversationRouter(db: Database.Database, config: AppConfig) {
  const router=express.Router();
  router.get("/",(req,res)=>{
    const parsed=conversationQuerySchema.safeParse(req.query); if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const q=parsed.data; const where:string[]=["ct.merged_into_contact_id IS NULL"]; const params:any[]=[];
    if(q.channel){where.push("a.channel_type=?");params.push(q.channel);} if(q.status){where.push("c.status=?");params.push(q.status);}
    if(q.priority){where.push("c.priority=?");params.push(q.priority);} if(q.assigned){where.push(q.assigned==="unassigned"?"c.assigned_user_id IS NULL":"c.assigned_user_id=?");if(q.assigned!=="unassigned")params.push(q.assigned);}
    if(q.unread==="true")where.push("c.unread_count>0");
    if(q.q){where.push(`(ct.display_name LIKE ? OR ct.email LIKE ? OR ct.phone LIKE ? OR EXISTS(SELECT 1 FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.username LIKE ?) OR EXISTS(SELECT 1 FROM message_search ms WHERE ms.conversation_id=c.id AND ms.body_text MATCH ?) OR json_extract(c.metadata_json,'$.sku') LIKE ? OR json_extract(c.metadata_json,'$.order_code') LIKE ?)`);const like=`%${q.q}%`;params.push(like,like,like,like,`"${q.q.replace(/"/g,'')}"*`,like,like);}
    params.push(q.limit);
    const rows=db.prepare(`SELECT c.*,a.channel_type,a.name channel_name,ct.display_name,
      (SELECT body_text FROM messages WHERE conversation_id=c.id ORDER BY datetime(created_at) DESC LIMIT 1) last_message
      FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id
      WHERE ${where.join(" AND ")} ORDER BY datetime(c.last_message_at) DESC LIMIT ?`).all(...params) as any[];
    const tagStmt=db.prepare("SELECT t.id,t.name,t.color FROM tags t JOIN conversation_tags ct ON ct.tag_id=t.id WHERE ct.conversation_id=? ORDER BY t.name");
    res.json({items:rows.map(row=>({...row,metadata:json(row.metadata_json,{}),tags:tagStmt.all(row.id)}))});
  });
  router.get("/:id",(req,res)=>{
    const conversation=db.prepare(`SELECT c.*,a.channel_type,a.name channel_name,a.status channel_status,ct.display_name,ct.email,ct.phone,ct.panel_customer_id
      FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=?`).get(req.params.id) as any;
    if(!conversation)return res.status(404).json({error:{code:"NOT_FOUND"}});
    const messages=db.prepare("SELECT id,direction,sender_type,sender_external_id,body_text,body_html,message_type,status,external_created_at,received_at,sent_at,created_at FROM messages WHERE conversation_id=? ORDER BY datetime(created_at),rowid").all(req.params.id);
    const notes=db.prepare("SELECT * FROM internal_notes WHERE conversation_id=? ORDER BY datetime(created_at)").all(req.params.id);
    const tags=db.prepare("SELECT t.* FROM tags t JOIN conversation_tags ct ON ct.tag_id=t.id WHERE ct.conversation_id=?").all(req.params.id);
    db.prepare("UPDATE conversations SET unread_count=0 WHERE id=?").run(req.params.id);
    res.json({...conversation,metadata:json(conversation.metadata_json,{}),messages,notes,tags});
  });
  router.post("/:id/replies",requirePermission("customer_hub:reply"),(req,res)=>{
    const parsed=replySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    try{res.status(202).json(queueReply(db,String(req.params.id),parsed.data.body,parsed.data.client_message_id,req.panelUser!,req.ip));}catch(error:any){res.status(error.status??500).json({error:{code:"REPLY_FAILED",message:error.message}});}
  });
  router.post("/:id/notes",requirePermission("customer_hub:view"),(req,res)=>{
    const parsed=noteSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const id=randomUUID();db.transaction(()=>{db.prepare("INSERT INTO internal_notes(id,conversation_id,user_id,username,text) VALUES(?,?,?,?,?)").run(id,req.params.id,req.panelUser!.id,req.panelUser!.username,parsed.data.text);writeAudit(db,{actorUserId:req.panelUser!.id,action:"NOTE_CREATED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip});})();res.status(201).json({id});
  });
  router.put("/:id/assignment",requirePermission("customer_hub:assign"),(req,res)=>{
    const parsed=assignmentSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    db.transaction(()=>{db.prepare("UPDATE conversations SET assigned_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.assigned_user_id,req.params.id);db.prepare("INSERT INTO conversation_events(id,conversation_id,event_type,actor_user_id,payload_json) VALUES(?,?,?,?,?)").run(randomUUID(),req.params.id,"ASSIGNMENT_CHANGED",req.panelUser!.id,JSON.stringify(parsed.data));writeAudit(db,{actorUserId:req.panelUser!.id,action:"ASSIGNMENT_CHANGED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip,payload:parsed.data});})();res.json({ok:true});
  });
  router.put("/:id/status",requirePermission("customer_hub:assign"),(req,res)=>{
    const parsed=statusSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    db.transaction(()=>{db.prepare("UPDATE conversations SET status=?,closed_at=CASE WHEN ? IN ('CLOSED','RESOLVED') THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.data.status,parsed.data.status,req.params.id);writeAudit(db,{actorUserId:req.panelUser!.id,action:"STATUS_CHANGED",entityType:"conversation",entityId:String(req.params.id),ip:req.ip,payload:parsed.data});})();res.json({ok:true});
  });
  router.put("/:id/tags/:tagId",requirePermission("customer_hub:manage_tags"),(req,res)=>{db.prepare("INSERT OR IGNORE INTO conversation_tags(conversation_id,tag_id) VALUES(?,?)").run(req.params.id,req.params.tagId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"TAG_ADDED",entityType:"conversation",entityId:String(req.params.id),payload:{tag_id:req.params.tagId}});res.json({ok:true});});
  router.delete("/:id/tags/:tagId",requirePermission("customer_hub:manage_tags"),(req,res)=>{db.prepare("DELETE FROM conversation_tags WHERE conversation_id=? AND tag_id=?").run(req.params.id,req.params.tagId);writeAudit(db,{actorUserId:req.panelUser!.id,action:"TAG_REMOVED",entityType:"conversation",entityId:String(req.params.id),payload:{tag_id:req.params.tagId}});res.status(204).end();});
  router.get("/:id/customer-context",requirePermission("customer_hub:view_customer_context"),async(req,res)=>{
    const contact=db.prepare("SELECT ct.panel_customer_id,ct.email,ct.phone FROM contacts ct JOIN conversations c ON c.contact_id=ct.id WHERE c.id=?").get(req.params.id) as any;if(!contact)return res.status(404).json({status:"not_found"});
    try{res.json(await getPanelCustomerContext(config,req.panelToken!,contact.panel_customer_id,{email:contact.email,phone:contact.phone}));}catch(error){if(error instanceof PanelUnavailableError)return res.status(200).json({status:"unavailable",message:"Panel şu anda erişilemiyor"});throw error;}
  });
  return router;
}
