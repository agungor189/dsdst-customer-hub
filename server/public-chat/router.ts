import express from "express";
import rateLimit from "express-rate-limit";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { decryptSecret } from "../security/crypto.js";
import { parseWebsiteCredentials } from "../channels/website/adapter.js";
import { applyMessageStatus } from "../messages/status.js";
import { createSessionSchema, publicMessageSchema, publicMessagesQuerySchema, readMessagesSchema } from "./schemas.js";
import { createWebsiteSession, ingestWebsiteMessage, resolveWebsiteSession, type PublicSession } from "./service.js";

type WebsiteAccount = {id:string;external_account_id:string;encrypted_credentials:string};
type RequestWithSession = express.Request & {websiteSession?: PublicSession};

const sessionWindows = new Map<string,{startedAt:number;count:number}>();
function takeSessionQuota(sessionId: string, limit: number) {
  const now=Date.now();
  if(sessionWindows.size>10_000)for(const [id,window] of sessionWindows)if(now-window.startedAt>=60_000)sessionWindows.delete(id);
  const current=sessionWindows.get(sessionId);
  if (!current || now-current.startedAt>=60_000) { sessionWindows.set(sessionId,{startedAt:now,count:1}); return true; }
  current.count += 1;
  return current.count <= limit;
}

export function createPublicChatRouter(db: Database.Database, config: AppConfig) {
  const router=express.Router();
  const ipLimiter=rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false,message:{error:{code:"RATE_LIMITED"}}});
  const sessionCreateLimiter=rateLimit({windowMs:60_000,limit:20,standardHeaders:true,legacyHeaders:false,message:{error:{code:"RATE_LIMITED"}}});
  router.use(ipLimiter);

  const loadAccount=(siteId:string):WebsiteAccount|undefined=>db.prepare(`SELECT id,external_account_id,encrypted_credentials FROM channel_accounts
    WHERE channel_type='WEBSITE' AND external_account_id=? AND status='ACTIVE'`).get(siteId) as WebsiteAccount|undefined;
  const allowed=(account:WebsiteAccount,origin:string)=>{
    try {
      const credentials=decryptSecret<Record<string,string>>(account.encrypted_credentials,config.encryptionKey);
      const parsed=parseWebsiteCredentials(credentials);
      return parsed?.site_id===account.external_account_id&&parsed.allowed_origins.includes(origin);
    } catch { return false; }
  };
  const cors=(res:express.Response,origin:string)=>{
    res.setHeader("Access-Control-Allow-Origin",origin);
    res.setHeader("Vary","Origin");
    res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type, X-DSDST-Site-ID");
    res.setHeader("Access-Control-Max-Age","600");
  };

  router.use((req,res,next)=>{
    const origin=req.headers.origin;
    const siteId=req.get("X-DSDST-Site-ID");
    if (!origin || !siteId) return res.status(403).json({error:{code:"ORIGIN_REJECTED"}});
    const account=loadAccount(siteId);
    if (!account || !allowed(account,origin)) return res.status(403).json({error:{code:"ORIGIN_REJECTED"}});
    cors(res,origin);
    res.locals.websiteAccount=account;
    if (req.method==="OPTIONS") return res.status(204).end();
    next();
  });

  router.post("/session",sessionCreateLimiter,(req,res)=>{
    const parsed=createSessionSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const account=res.locals.websiteAccount as WebsiteAccount;
    if(parsed.data.site_id!==account.external_account_id)return res.status(403).json({error:{code:"ACCOUNT_MISMATCH"}});
    const result=createWebsiteSession(db,{accountId:account.id,externalAccountId:account.external_account_id,origin:req.headers.origin!,visitorId:parsed.data.visitor_id,name:parsed.data.name,email:parsed.data.email,phone:parsed.data.phone});
    res.setHeader("Cache-Control","no-store");
    res.status(201).json({session_token:result.token,visitor_id:result.visitorId,expires_at:result.expiresAt,greeting:"Merhaba, size nasıl yardımcı olabiliriz?"});
  });

  router.use((req:RequestWithSession,res,next)=>{
    const authorization=req.get("Authorization")??"";
    const match=/^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    if(!match)return res.status(401).json({error:{code:"SESSION_TOKEN_REQUIRED"}});
    const session=resolveWebsiteSession(db,match[1]);
    if(!session)return res.status(401).json({error:{code:"SESSION_INVALID"}});
    const account=res.locals.websiteAccount as WebsiteAccount;
    if(session.channel_account_id!==account.id || session.external_account_id!==req.get("X-DSDST-Site-ID"))return res.status(403).json({error:{code:"ACCOUNT_MISMATCH"}});
    if(session.origin!==req.headers.origin)return res.status(403).json({error:{code:"ORIGIN_REJECTED"}});
    if(!takeSessionQuota(session.id,60))return res.status(429).json({error:{code:"SESSION_RATE_LIMITED"}});
    req.websiteSession=session; next();
  });

  router.post("/messages",(req:RequestWithSession,res)=>{
    const parsed=publicMessageSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    try {
      const result=ingestWebsiteMessage(db,req.websiteSession!,{clientMessageId:parsed.data.client_message_id,body:parsed.data.body,context:parsed.data.context??{}});
      res.status(result.duplicate?200:202).json({message_id:result.messageId,conversation_id:result.conversationId,duplicate:result.duplicate,acknowledgement:"Mesajınız alındı."});
    } catch(error:any) { res.status(error.status??500).json({error:{code:error.code??"MESSAGE_FAILED",message:error.message}}); }
  });

  router.get("/messages",(req:RequestWithSession,res)=>{
    const parsed=publicMessagesQuerySchema.safeParse(req.query);
    if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});
    const session=req.websiteSession!;
    if(!session.conversation_id)return res.json({items:[]});
    const deliverable=db.prepare(`SELECT external_message_id FROM messages WHERE conversation_id=? AND channel_account_id=?
      AND direction='OUTBOUND' AND status='SENT' AND external_message_id IS NOT NULL`).all(session.conversation_id,session.channel_account_id) as Array<{external_message_id:string}>;
    for(const message of deliverable)applyMessageStatus(db,"WEBSITE",{eventId:`website-delivered:${session.id}:${message.external_message_id}`,externalAccountId:session.external_account_id,externalMessageId:message.external_message_id,status:"DELIVERED",externalCreatedAt:new Date().toISOString(),metadata:{delivery_source:"widget_fetch"}});
    const rows=db.prepare(`SELECT id,direction,body_text,status,created_at,sent_at FROM (SELECT id,direction,body_text,status,created_at,sent_at,rowid message_rowid FROM messages
      WHERE conversation_id=? AND channel_account_id=? ORDER BY datetime(created_at) DESC,rowid DESC LIMIT ?)
      ORDER BY datetime(created_at),message_rowid`).all(session.conversation_id,session.channel_account_id,parsed.data.limit);
    res.setHeader("Cache-Control","no-store");res.json({items:rows});
  });

  router.post("/read",(req:RequestWithSession,res)=>{
    const parsed=readMessagesSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});
    const session=req.websiteSession!;
    if(!session.conversation_id)return res.status(204).end();
    const select=db.prepare(`SELECT external_message_id FROM messages WHERE id=? AND conversation_id=? AND channel_account_id=?
      AND direction='OUTBOUND' AND external_message_id IS NOT NULL`);
    for(const id of parsed.data.message_ids){const message=select.get(id,session.conversation_id,session.channel_account_id)as{external_message_id:string}|undefined;if(message)applyMessageStatus(db,"WEBSITE",{eventId:`website-read:${session.id}:${message.external_message_id}`,externalAccountId:session.external_account_id,externalMessageId:message.external_message_id,status:"READ",externalCreatedAt:new Date().toISOString(),metadata:{read_source:"widget_visible"}});}
    res.status(204).end();
  });
  return router;
}
