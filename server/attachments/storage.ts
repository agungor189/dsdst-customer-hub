import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function normalizeAttachmentFilename(name: string): string {
  return path.basename(name).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180) || "attachment";
}

export type PersistableAttachment = { filename: string; mimeType: string; content: Buffer };
export type SkippedAttachment = { filename: string; mime_type: string; size_bytes: number; reason: "TOO_LARGE" | "UNSUPPORTED_TYPE" };

export function filterInboundAttachments(attachments: PersistableAttachment[]) {
  const accepted: PersistableAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const attachment of attachments) {
    const filename = normalizeAttachmentFilename(attachment.filename);
    const mimeType = attachment.mimeType.toLowerCase();
    if (attachment.content.length > MAX_ATTACHMENT_BYTES) {
      skipped.push({filename,mime_type:mimeType,size_bytes:attachment.content.length,reason:"TOO_LARGE"});
    } else if (!ALLOWED_ATTACHMENT_TYPES.has(mimeType)) {
      skipped.push({filename,mime_type:mimeType,size_bytes:attachment.content.length,reason:"UNSUPPORTED_TYPE"});
    } else {
      accepted.push({...attachment,filename,mimeType});
    }
  }
  return {accepted,skipped};
}

export function persistInboundAttachments(db: Database.Database, attachmentsDir: string, messageId: string, attachments: PersistableAttachment[]): void {
  if (!attachments.length) return;
  fs.mkdirSync(attachmentsDir,{recursive:true});
  const createdPaths: string[] = [];
  try {
    db.transaction(() => {
      for (const attachment of attachments) {
        const sha=createHash("sha256").update(attachment.content).digest("hex");
        if (db.prepare("SELECT id FROM attachments WHERE message_id=? AND filename=? AND sha256=?").get(messageId,attachment.filename,sha)) continue;
        const diskName=randomUUID();
        const target=path.join(attachmentsDir,diskName);
        fs.writeFileSync(target,attachment.content,{mode:0o600,flag:"wx"});
        createdPaths.push(target);
        db.prepare("INSERT INTO attachments(id,message_id,type,filename,mime_type,size_bytes,storage_path,sha256) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(),messageId,attachment.mimeType.startsWith("image/")?"IMAGE":"DOCUMENT",attachment.filename,attachment.mimeType,attachment.content.length,diskName,sha);
      }
    })();
  } catch (error) {
    for (const target of createdPaths) {
      try { fs.unlinkSync(target); } catch { /* best-effort cleanup after DB rollback */ }
    }
    throw error;
  }
}
