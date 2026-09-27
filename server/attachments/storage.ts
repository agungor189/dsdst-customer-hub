import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type AllowedAttachmentMimeType,
} from "../../shared/contracts/attachments.js";

export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_BYTES };
export const ALLOWED_ATTACHMENT_TYPES = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);

export type AttachmentErrorCode =
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_TOTAL_TOO_LARGE"
  | "TOO_MANY_ATTACHMENTS"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "ATTACHMENT_CONTENT_MISMATCH"
  | "ATTACHMENT_INTEGRITY_ERROR";

export class AttachmentError extends Error {
  readonly status: number;
  constructor(public readonly code: AttachmentErrorCode, message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeAttachmentFilename(name: string): string {
  return path.basename(name).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180) || "attachment";
}

export type PersistableAttachment = { filename: string; mimeType: string; content: Buffer };
export type ValidatedAttachment = PersistableAttachment & { mimeType: AllowedAttachmentMimeType };
export type SkippedAttachment = { filename: string; mime_type: string; size_bytes: number; reason: "TOO_LARGE" | "UNSUPPORTED_TYPE" };
export type StoredAttachmentRow = {
  id?: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  sha256: string;
};

const MIME_EXTENSIONS: Record<AllowedAttachmentMimeType, ReadonlySet<string>> = {
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/png": new Set([".png"]),
  "image/webp": new Set([".webp"]),
  "application/pdf": new Set([".pdf"]),
};

export function detectAttachmentMimeType(content: Buffer): AllowedAttachmentMimeType | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (content.length >= 5 && content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export function validateOutboundAttachments(attachments: PersistableAttachment[]): ValidatedAttachment[] {
  if (attachments.length > MAX_ATTACHMENT_COUNT) throw new AttachmentError("TOO_MANY_ATTACHMENTS", `En fazla ${MAX_ATTACHMENT_COUNT} dosya eklenebilir.`);
  const total=attachments.reduce((sum,item)=>sum+item.content.length,0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new AttachmentError("ATTACHMENT_TOTAL_TOO_LARGE", "Eklerin toplam boyutu 18 MB sınırını aşıyor.");
  return attachments.map(attachment => {
    const filename=normalizeAttachmentFilename(attachment.filename);
    const claimed=attachment.mimeType.toLowerCase();
    if (attachment.content.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError("ATTACHMENT_TOO_LARGE", `${filename} 10 MB sınırını aşıyor.`);
    if (!ALLOWED_ATTACHMENT_TYPES.has(claimed)) throw new AttachmentError("UNSUPPORTED_MEDIA_TYPE", `${filename} desteklenen bir dosya türü değil.`,415);
    const detected=detectAttachmentMimeType(attachment.content);
    if (!detected || detected !== claimed) throw new AttachmentError("ATTACHMENT_CONTENT_MISMATCH", `${filename} içeriği bildirilen dosya türüyle eşleşmiyor.`,415);
    if (!MIME_EXTENSIONS[detected].has(path.extname(filename).toLowerCase())) throw new AttachmentError("ATTACHMENT_CONTENT_MISMATCH", `${filename} uzantısı dosya içeriğiyle eşleşmiyor.`,415);
    return {filename,mimeType:detected,content:attachment.content};
  });
}

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

function ensureStorageRoot(attachmentsDir: string) {
  fs.mkdirSync(attachmentsDir,{recursive:true,mode:0o700});
}

export function storeMessageAttachments(db: Database.Database, attachmentsDir: string, messageId: string, attachments: PersistableAttachment[], createdPaths: string[] = []): string[] {
  if (!attachments.length) return [];
  ensureStorageRoot(attachmentsDir);
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
  return createdPaths;
}

export function removeStoredFiles(paths: string[]) {
  for (const target of paths) {
    try { fs.unlinkSync(target); } catch { /* best-effort compensation after DB rollback */ }
  }
}

export function persistInboundAttachments(db: Database.Database, attachmentsDir: string, messageId: string, attachments: PersistableAttachment[]): void {
  if (!attachments.length) return;
  let createdPaths:string[]=[];
  try {
    db.transaction(() => { storeMessageAttachments(db,attachmentsDir,messageId,attachments,createdPaths); })();
  } catch (error) {
    removeStoredFiles(createdPaths);
    throw error;
  }
}

export function readStoredAttachment(attachmentsDir:string,row:StoredAttachmentRow):Buffer {
  if (!row.storage_path || path.basename(row.storage_path) !== row.storage_path) throw new AttachmentError("ATTACHMENT_INTEGRITY_ERROR","Ek dosya güvenlik doğrulamasından geçemedi.",409);
  try {
    ensureStorageRoot(attachmentsDir);
    const root=path.resolve(attachmentsDir);
    const target=path.resolve(root,row.storage_path);
    if (path.dirname(target)!==root) throw new Error("unsafe path");
    const linkStat=fs.lstatSync(target);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error("unsafe file");
    const realRoot=fs.realpathSync(root);
    const realTarget=fs.realpathSync(target);
    if (path.dirname(realTarget)!==realRoot) throw new Error("escaped root");
    const content=fs.readFileSync(realTarget);
    if (content.length!==row.size_bytes) throw new Error("size mismatch");
    const sha=createHash("sha256").update(content).digest("hex");
    if (sha!==row.sha256) throw new Error("checksum mismatch");
    return content;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("ATTACHMENT_INTEGRITY_ERROR","Ek dosya bütünlük doğrulamasından geçemedi.",409);
  }
}

export function loadMessageAttachments(db:Database.Database,attachmentsDir:string,messageId:string) {
  const rows=db.prepare("SELECT filename,mime_type,size_bytes,storage_path,sha256 FROM attachments WHERE message_id=? ORDER BY created_at,id").all(messageId) as StoredAttachmentRow[];
  return rows.map(row=>({filename:row.filename,mimeType:row.mime_type,content:readStoredAttachment(attachmentsDir,row)}));
}
