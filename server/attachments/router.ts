import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { requirePermission } from "../auth/middleware.js";
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, normalizeAttachmentFilename, persistInboundAttachments } from "./storage.js";

export function createAttachmentRouter(db:Database.Database,config:AppConfig) {
  fs.mkdirSync(config.attachmentsDir,{recursive:true});
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_ATTACHMENT_BYTES,files:1}});
  const router=express.Router();
  router.get("/:id/download",requirePermission("customer_hub:view"),(req,res)=>{
    const attachment=db.prepare(`SELECT a.filename,a.mime_type,a.size_bytes,a.storage_path FROM attachments a
      JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.id=?`).get(req.params.id) as {filename:string;mime_type:string;size_bytes:number;storage_path:string|null}|undefined;
    if(!attachment||!attachment.storage_path)return res.status(404).json({error:{code:"ATTACHMENT_NOT_FOUND"}});
    const root=path.resolve(config.attachmentsDir);
    const target=path.resolve(root,attachment.storage_path);
    if(path.dirname(target)!==root||path.basename(attachment.storage_path)!==attachment.storage_path)return res.status(400).json({error:{code:"UNSAFE_ATTACHMENT_PATH"}});
    let stat:fs.Stats;try{const realRoot=fs.realpathSync(root);const realTarget=fs.realpathSync(target);if(path.dirname(realTarget)!==realRoot)return res.status(400).json({error:{code:"UNSAFE_ATTACHMENT_PATH"}});stat=fs.statSync(realTarget);}catch{return res.status(404).json({error:{code:"ATTACHMENT_NOT_FOUND"}});}
    if(!stat.isFile()||stat.size!==attachment.size_bytes)return res.status(409).json({error:{code:"ATTACHMENT_INTEGRITY_ERROR"}});
    res.setHeader("Content-Type",attachment.mime_type);
    res.setHeader("Content-Length",String(stat.size));
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    res.setHeader("Cache-Control","private, no-store");
    fs.createReadStream(target).on("error",()=>{if(!res.headersSent)res.status(500).end();else res.destroy();}).pipe(res);
  });
  router.post("/messages/:messageId",requirePermission("customer_hub:reply"),upload.single("file"),(req,res)=>{
    const messageId=String(req.params.messageId);
    if(!req.file||!ALLOWED_ATTACHMENT_TYPES.has(req.file.mimetype)) return res.status(415).json({error:{code:"UNSUPPORTED_MEDIA_TYPE"}});
    if(!db.prepare("SELECT id FROM messages WHERE id=?").get(messageId)) return res.status(404).json({error:{code:"NOT_FOUND"}});
    const filename=normalizeAttachmentFilename(req.file.originalname);
    const sha=createHash("sha256").update(req.file.buffer).digest("hex");
    persistInboundAttachments(db,config.attachmentsDir,messageId,[{filename,mimeType:req.file.mimetype,content:req.file.buffer}]);
    const stored=db.prepare("SELECT id FROM attachments WHERE message_id=? AND filename=? AND sha256=?").get(messageId,filename,sha) as {id:string};
    return res.status(201).json({id:stored.id,filename,mime_type:req.file.mimetype,size_bytes:req.file.size,sha256:sha});
  });
  return router;
}
