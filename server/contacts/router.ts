import { randomUUID } from "node:crypto";
import express from "express";
import type Database from "better-sqlite3";
import { mergeSchema } from "../../shared/schemas/api.js";
import { requirePermission } from "../auth/middleware.js";
import { writeAudit } from "../audit/index.js";

export function createContactRouter(db: Database.Database){const router=express.Router();
  router.get("/suggestions",(req,res)=>{const rows=db.prepare(`SELECT a.id source_contact_id,b.id target_contact_id,a.display_name source_name,b.display_name target_name,
    CASE WHEN a.normalized_email=b.normalized_email THEN 'EMAIL' ELSE 'PHONE' END reason FROM contacts a JOIN contacts b ON a.id<b.id AND a.merged_into_contact_id IS NULL AND b.merged_into_contact_id IS NULL
    WHERE (a.normalized_email IS NOT NULL AND a.normalized_email=b.normalized_email) OR (a.normalized_phone IS NOT NULL AND a.normalized_phone=b.normalized_phone) LIMIT 100`).all();res.json({items:rows});});
  router.post("/merge",requirePermission("customer_hub:assign"),(req,res)=>{const parsed=mergeSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});const {source_contact_id:source,target_contact_id:target}=parsed.data;if(source===target)return res.status(400).json({error:{code:"SAME_CONTACT"}});
    try{const eventId=randomUUID();db.transaction(()=>{const sourceRow=db.prepare("SELECT * FROM contacts WHERE id=? AND merged_into_contact_id IS NULL").get(source) as any;const targetRow=db.prepare("SELECT * FROM contacts WHERE id=? AND merged_into_contact_id IS NULL").get(target) as any;if(!sourceRow||!targetRow)throw new Error("Contact not found or already merged");const snapshot={source:sourceRow,target:targetRow,conversation_ids:(db.prepare("SELECT id FROM conversations WHERE contact_id=?").all(source) as any[]).map(r=>r.id),identity_ids:(db.prepare("SELECT id FROM contact_identities WHERE contact_id=?").all(source) as any[]).map(r=>r.id)};db.prepare("UPDATE conversations SET contact_id=? WHERE contact_id=?").run(target,source);db.prepare("UPDATE contact_identities SET contact_id=? WHERE contact_id=?").run(target,source);db.prepare("UPDATE contacts SET merged_into_contact_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(target,source);db.prepare("INSERT INTO contact_merge_events(id,source_contact_id,target_contact_id,actor_user_id,snapshot_json) VALUES(?,?,?,?,?)").run(eventId,source,target,req.panelUser!.id,JSON.stringify(snapshot));writeAudit(db,{actorUserId:req.panelUser!.id,action:"CONTACT_MERGED",entityType:"contact",entityId:target,ip:req.ip,payload:{source_contact_id:source,merge_event_id:eventId}});})();res.json({id:eventId});}catch(error:any){res.status(409).json({error:{code:"MERGE_FAILED",message:error.message}});}});
  return router;}
