import fs from "node:fs";
import express from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { requirePermission } from "../auth/middleware.js";
import { AttachmentError, MAX_ATTACHMENT_BYTES, normalizeAttachmentFilename, persistInboundAttachments, readStoredAttachment, validateOutboundAttachments } from "./storage.js";

export function createAttachmentRouter(db:Database.Database,config:AppConfig) {
  fs.mkdirSync(config.attachmentsDir,{recursive:true});
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_ATTACHMENT_BYTES,files:1}});
  const router=express.Router();
  router.get("/:id/download",requirePermission("customer_hub:view"),(req,res)=>{
    const attachment=db.prepare(`SELECT a.filename,a.mime_type,a.size_bytes,a.storage_path,a.sha256 FROM attachments a
      JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.id=?`).get(req.params.id) as {filename:string;mime_type:string;size_bytes:number;storage_path:string|null}|undefined;
    if(!attachment||!attachment.storage_path)return res.status(404).json({error:{code:"ATTACHMENT_NOT_FOUND"}});
    let content:Buffer;try{content=readStoredAttachment(config.attachmentsDir,attachment as any);}catch(error){const issue=error instanceof AttachmentError?error:null;return res.status(issue?.status??409).json({error:{code:issue?.code??"ATTACHMENT_INTEGRITY_ERROR"}});}
    res.setHeader("Content-Type",attachment.mime_type);
    res.setHeader("Content-Length",String(content.length));
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    res.setHeader("Cache-Control","private, no-store");
    res.send(content);
  });
  router.post("/messages/:messageId",requirePermission("customer_hub:reply"),(req,res,next)=>upload.single("file")(req,res,error=>{if(error instanceof multer.MulterError)return res.status(400).json({error:{code:error.code==="LIMIT_FILE_SIZE"?"ATTACHMENT_TOO_LARGE":"VALIDATION_ERROR"}});if(error)return next(error);next();}),(req,res)=>{
    const messageId=String(req.params.messageId);
    if(!req.file) return res.status(415).json({error:{code:"UNSUPPORTED_MEDIA_TYPE"}});
    const message=db.prepare("SELECT m.id,m.direction,EXISTS(SELECT 1 FROM outbox_jobs j WHERE j.message_id=m.id) has_outbox FROM messages m WHERE m.id=?").get(messageId) as {id:string;direction:string;has_outbox:number}|undefined;
    if(!message) return res.status(404).json({error:{code:"NOT_FOUND"}});
    if(message.direction==="OUTBOUND"||message.has_outbox)return res.status(409).json({error:{code:"OUTBOUND_ATTACHMENT_FLOW_REQUIRED",message:"Giden e-posta ekleri yanıtla birlikte gönderilmelidir."}});
    try{
      const [attachment]=validateOutboundAttachments([{filename:req.file.originalname,mimeType:req.file.mimetype,content:req.file.buffer}]);
      persistInboundAttachments(db,config.attachmentsDir,messageId,[attachment]);
      const stored=db.prepare("SELECT id,sha256 FROM attachments WHERE message_id=? AND filename=? ORDER BY created_at DESC LIMIT 1").get(messageId,normalizeAttachmentFilename(req.file.originalname)) as {id:string;sha256:string};
      return res.status(201).json({id:stored.id,filename:attachment.filename,mime_type:attachment.mimeType,size_bytes:attachment.content.length,sha256:stored.sha256});
    }catch(error){const issue=error instanceof AttachmentError?error:null;return res.status(issue?.status??500).json({error:{code:issue?.code??"ATTACHMENT_STORE_FAILED",message:issue?.message}});}
  });
  return router;
}
