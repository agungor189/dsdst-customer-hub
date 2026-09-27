import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { testDatabase } from "../test-utils.js";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
  detectAttachmentMimeType,
  readStoredAttachment,
  validateOutboundAttachments,
} from "./storage.js";

const samples={
  "image/jpeg":Buffer.from([0xff,0xd8,0xff,0x01]),
  "image/png":Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x01]),
  "image/webp":Buffer.from("RIFF0000WEBPdata","ascii"),
  "application/pdf":Buffer.from("%PDF-1.7\n","ascii"),
} as const;

function code(expected:string){return(error:unknown)=>error instanceof AttachmentError&&error.code===expected}

test("outbound attachment magic bytes accept only the four supported matching formats",()=>{
  assert.equal(detectAttachmentMimeType(samples["image/jpeg"]),"image/jpeg");
  assert.equal(detectAttachmentMimeType(samples["image/png"]),"image/png");
  assert.equal(detectAttachmentMimeType(samples["image/webp"]),"image/webp");
  assert.equal(detectAttachmentMimeType(samples["application/pdf"]),"application/pdf");
  assert.deepEqual(validateOutboundAttachments([
    {filename:"photo.JPG",mimeType:"image/jpeg",content:samples["image/jpeg"]},
    {filename:"image.png",mimeType:"image/png",content:samples["image/png"]},
    {filename:"image.webp",mimeType:"image/webp",content:samples["image/webp"]},
    {filename:"report.pdf",mimeType:"application/pdf",content:samples["application/pdf"]},
  ]).map(item=>item.mimeType),["image/jpeg","image/png","image/webp","application/pdf"]);
  assert.throws(()=>validateOutboundAttachments([{filename:"fake.pdf",mimeType:"application/pdf",content:Buffer.from("<html>")}]),code("ATTACHMENT_CONTENT_MISMATCH"));
  assert.throws(()=>validateOutboundAttachments([{filename:"fake.png",mimeType:"image/jpeg",content:samples["image/jpeg"]}]),code("ATTACHMENT_CONTENT_MISMATCH"));
  assert.throws(()=>validateOutboundAttachments([{filename:"archive.zip",mimeType:"application/zip",content:Buffer.from("PK") }]),code("UNSUPPORTED_MEDIA_TYPE"));
});

test("outbound attachment count, per-file and aggregate limits are centralized",()=>{
  assert.equal(MAX_ATTACHMENT_COUNT,5);assert.equal(MAX_ATTACHMENT_BYTES,10*1024*1024);assert.equal(MAX_TOTAL_ATTACHMENT_BYTES,18*1024*1024);
  assert.throws(()=>validateOutboundAttachments(Array.from({length:6},(_,index)=>({filename:`${index}.pdf`,mimeType:"application/pdf",content:samples["application/pdf"]}))),code("TOO_MANY_ATTACHMENTS"));
  assert.throws(()=>validateOutboundAttachments([{filename:"large.pdf",mimeType:"application/pdf",content:Buffer.concat([samples["application/pdf"],Buffer.alloc(MAX_ATTACHMENT_BYTES)])}]),code("ATTACHMENT_TOO_LARGE"));
  const nineMb=Buffer.concat([samples["application/pdf"],Buffer.alloc(9*1024*1024)]);
  assert.throws(()=>validateOutboundAttachments([{filename:"a.pdf",mimeType:"application/pdf",content:nineMb},{filename:"b.pdf",mimeType:"application/pdf",content:nineMb}]),code("ATTACHMENT_TOTAL_TOO_LARGE"));
});

test("stored attachment reads reject traversal, symlinks, size changes and checksum changes",()=>{
  const {db,config}=testDatabase();fs.mkdirSync(config.attachmentsDir,{recursive:true});const name=randomUUID(),target=path.join(config.attachmentsDir,name),content=samples["application/pdf"];fs.writeFileSync(target,content,{mode:0o600});
  const row={filename:"report.pdf",mime_type:"application/pdf",size_bytes:content.length,storage_path:name,sha256:createHash("sha256").update(content).digest("hex")};
  assert.deepEqual(readStoredAttachment(config.attachmentsDir,row),content);
  assert.throws(()=>readStoredAttachment(config.attachmentsDir,{...row,storage_path:"../outside"}),code("ATTACHMENT_INTEGRITY_ERROR"));
  const link=randomUUID();fs.symlinkSync(target,path.join(config.attachmentsDir,link));assert.throws(()=>readStoredAttachment(config.attachmentsDir,{...row,storage_path:link}),code("ATTACHMENT_INTEGRITY_ERROR"));
  assert.throws(()=>readStoredAttachment(config.attachmentsDir,{...row,size_bytes:content.length+1}),code("ATTACHMENT_INTEGRITY_ERROR"));
  assert.throws(()=>readStoredAttachment(config.attachmentsDir,{...row,sha256:"0".repeat(64)}),code("ATTACHMENT_INTEGRITY_ERROR"));
  db.close();
});
