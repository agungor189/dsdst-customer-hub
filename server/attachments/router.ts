import fs from "node:fs";
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
