import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { AdapterRegistry } from "../channels/core/registry.js";
import { decryptSecret, redactCredentialValues } from "../security/crypto.js";
import { ProviderError } from "../channels/core/types.js";
import { retryDelaySeconds } from "./service.js";

export class OutboxWorker {
  private timer?: NodeJS.Timeout; private running=false; private lastRunAt: string|null=null;
  constructor(private db: Database.Database, private registry: AdapterRegistry, private config: AppConfig, private workerId=`worker-${process.pid}`) {}
  start(){ this.timer=setInterval(()=>void this.tick(),this.config.outboxPollMs); this.timer.unref(); }
  stop(){ if(this.timer) clearInterval(this.timer); }
  health(){ return {running:this.running,lastRunAt:this.lastRunAt}; }
  async tick(){
    if(this.running) return false; this.running=true; this.lastRunAt=new Date().toISOString();
    try {
      const job=this.claim(); if(!job) return false;
      const adapter=this.registry.get(job.channel_type);
      let credentials:Record<string,string>|null=null;
      try {
        credentials=job.encrypted_credentials ? decryptSecret<Record<string,string>>(job.encrypted_credentials,this.config.encryptionKey) : null;
        const envelope={messageId:job.message_id,externalConversationId:job.external_conversation_id,body:job.body_text,metadata:{...JSON.parse(job.conversation_metadata_json||"{}"),...JSON.parse(job.metadata_json||"{}")}};
        const account={id:job.channel_account_id,externalAccountId:job.external_account_id,credentials};
        adapter.validateReply?.(envelope,{...account,db:this.db,phase:"SEND"});
        const result=await adapter.sendMessage(envelope,account);
        this.db.transaction(()=>{
          this.db.prepare("UPDATE messages SET status=?,external_message_id=?,sent_at=CURRENT_TIMESTAMP WHERE id=? AND status='SENDING'").run(result.status,result.externalMessageId,job.message_id);
          this.db.prepare("UPDATE outbox_jobs SET status='COMPLETED',locked_at=NULL,locked_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND locked_by=?").run(job.id,this.workerId);
        })();
      } catch(error){
        const providerError=error instanceof ProviderError?error:new ProviderError(error instanceof Error?error.message:"Provider error",true,"UNKNOWN");
        const safeError=redactCredentialValues(`${providerError.code}: ${providerError.message}`,credentials).slice(0,1000);
        const attempts=job.attempt_count+1; const terminal=!providerError.retryable||attempts>=5; const delay=retryDelaySeconds(attempts);
        this.db.transaction(()=>{
          this.db.prepare("UPDATE messages SET status=? WHERE id=? AND EXISTS(SELECT 1 FROM outbox_jobs WHERE id=? AND locked_by=? AND status='PROCESSING')")
            .run(terminal?"FAILED":"QUEUED",job.message_id,job.id,this.workerId);
          this.db.prepare("UPDATE outbox_jobs SET status=?,attempt_count=?,next_attempt_at=datetime('now', ?),last_error=?,locked_at=NULL,locked_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND locked_by=?")
            .run(terminal?"FAILED":"PENDING",attempts,`+${delay} seconds`,safeError,job.id,this.workerId);
        })();
      }
      return true;
    } finally {this.running=false;}
  }
  private claim(){
    return this.db.transaction(()=>{
      const job=this.db.prepare(`SELECT j.id,j.message_id,j.attempt_count,m.body_text,m.metadata_json,c.external_conversation_id,c.metadata_json conversation_metadata_json,a.id channel_account_id,a.external_account_id,a.channel_type,a.encrypted_credentials
        FROM outbox_jobs j JOIN messages m ON m.id=j.message_id JOIN conversations c ON c.id=m.conversation_id JOIN channel_accounts a ON a.id=m.channel_account_id
        WHERE j.status='PENDING' AND datetime(j.next_attempt_at)<=datetime('now') AND j.locked_at IS NULL ORDER BY j.created_at LIMIT 1`).get() as any;
      if(!job)return null;
      const claimed=this.db.prepare("UPDATE outbox_jobs SET status='PROCESSING',locked_at=CURRENT_TIMESTAMP,locked_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING' AND locked_at IS NULL").run(this.workerId,job.id);
      if(claimed.changes!==1)return null;
      this.db.prepare("UPDATE messages SET status='SENDING' WHERE id=? AND status='QUEUED'").run(job.message_id);
      return job;
    })();
  }
}
