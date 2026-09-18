import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import type { PanelUser } from "../shared/contracts/domain.js";
import { loginSchema, inboundSchema } from "../shared/schemas/api.js";
import { panelLogin, panelMe } from "./panel/client.js";
import { createAuthMiddleware, csrfOrigin, requirePermission } from "./auth/middleware.js";
import { createConversationRouter } from "./conversations/router.js";
import { createContactRouter } from "./contacts/router.js";
import { createTagRouter } from "./tags/router.js";
import { createChannelRouter } from "./channels/router.js";
import { createCannedResponsesRouter } from "./canned-responses/router.js";
import { createAttachmentRouter } from "./attachments/router.js";
import { createBackupRouter } from "./backup/router.js";
import { createMetaWebhookRouter } from "./webhooks/meta.js";
import type { AdapterRegistry } from "./channels/core/registry.js";
import { ingestInbound } from "./messages/inbound.js";
import type { OutboxWorker } from "./outbox/worker.js";
import { redact, } from "./security/crypto.js";
import { writeAudit } from "./audit/index.js";

type Verify = (config:AppConfig,token:string)=>Promise<PanelUser>;
type Login = typeof panelLogin;
export function createApp(input:{db:Database.Database;config:AppConfig;registry:AdapterRegistry;worker:OutboxWorker;verify?:Verify;login?:Login}){
  const {db,config,registry,worker}=input;const app=express();app.disable("x-powered-by");app.set("trust proxy",1);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:","https:"],connectSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}},crossOriginEmbedderPolicy:false}));
  app.use(express.json({limit:"1mb",verify:(req,_res,buf)=>{(req as any).rawBody=Buffer.from(buf);}}));app.use(cookieParser());app.use(csrfOrigin(config));
  app.get("/api/health",async(_req,res)=>{let panel="unavailable";try{const response=await fetch(`${config.panelBaseUrl}/api/public/health`,{signal:AbortSignal.timeout(Math.min(config.panelTimeoutMs,2000))});panel=response.ok?"ok":"degraded";}catch{}const summary=db.prepare("SELECT sum(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) healthy,sum(CASE WHEN status IN ('ERROR','DEGRADED') THEN 1 ELSE 0 END) degraded FROM channel_accounts").get() as any;let database="ok";try{database=(db.pragma("quick_check",{simple:true}) as string)==="ok"?"ok":"error";}catch{database="error";}const status=database==="ok"?"ok":"error";res.status(status==="ok"?200:503).json({status,version:config.version,commit:config.commit,database,worker:worker.health().running?"busy":"ok",panel,channels:{healthy:summary.healthy??0,degraded:summary.degraded??0}});});
  app.use("/api/webhooks/meta",createMetaWebhookRouter(db,config));
  const loginLimiter=rateLimit({windowMs:15*60_000,limit:10,skipSuccessfulRequests:true,standardHeaders:true,legacyHeaders:false});
  app.post("/api/auth/login",loginLimiter,async(req,res)=>{const parsed=loginSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR"}});try{const result=await (input.login??panelLogin)(config,parsed.data.username,parsed.data.password);res.cookie(config.sessionCookieName,result.token,{httpOnly:true,secure:config.sessionSecure,sameSite:"strict",maxAge:12*60*60*1000,path:"/"});writeAudit(db,{actorUserId:result.user.id,action:"LOGIN_SUCCESS",entityType:"session",entityId:result.user.id,ip:req.ip});res.json({user:result.user});}catch(error:any){res.status(error.status??502).json({error:{code:error.status===401?"AUTH_FAILED":"PANEL_UNAVAILABLE",message:error.message}});}});
  app.post("/api/auth/logout",(req,res)=>{res.clearCookie(config.sessionCookieName,{httpOnly:true,secure:config.sessionSecure,sameSite:"strict",path:"/"});res.status(204).end();});
  const auth=createAuthMiddleware(config,input.verify??panelMe);app.use("/api",auth);
  app.get("/api/auth/me",(req,res)=>res.json({user:req.panelUser}));
  app.use("/api/conversations",createConversationRouter(db,config));app.use("/api/contacts",createContactRouter(db));app.use("/api/tags",createTagRouter(db));app.use("/api/channels",createChannelRouter(db,config,registry));app.use("/api/canned-responses",createCannedResponsesRouter(db));app.use("/api/attachments",createAttachmentRouter(db,config));app.use("/api/backups",createBackupRouter(db,config));
  app.post("/api/dev/mock/inbound",requirePermission("customer_hub:manage_channels"),(req,res)=>{if(config.production||!config.mockAdaptersEnabled)return res.status(404).end();const parsed=inboundSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:{code:"VALIDATION_ERROR",details:parsed.error.flatten()}});const d=parsed.data;res.status(202).json(ingestInbound(db,"WEBSITE",{eventId:d.event_id,externalAccountId:d.external_account_id,externalConversationId:d.external_conversation_id,externalMessageId:d.external_message_id,externalUserId:d.external_user_id,displayName:d.display_name,username:d.username,body:d.body,subject:d.subject,messageType:d.message_type,externalCreatedAt:d.external_created_at??new Date().toISOString(),metadata:d.metadata}));});
  const dist=path.resolve("dist");if(fs.existsSync(dist)){app.use(express.static(dist,{immutable:true,maxAge:"1y",index:false}));app.get("*",(req,res,next)=>req.path.startsWith("/api/")?next():res.sendFile(path.join(dist,"index.html")));}
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error("REQUEST_ERROR",redact({message:error?.message,code:error?.code}));res.status(error?.status??500).json({error:{code:error?.code??"INTERNAL_ERROR",message:config.production?"İşlem tamamlanamadı.":error?.message}});});return app;
}
