import type Database from "better-sqlite3";
import type { AppConfig } from "../../config.js";
import { decryptSecret, redactCredentialValues } from "../../security/crypto.js";
import { retryDelaySeconds } from "../../outbox/service.js";
import type { AdapterRegistry } from "./registry.js";

export class ChannelSyncScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private db: Database.Database, private registry: AdapterRegistry, private config: AppConfig) {}

  start() { this.timer=setInterval(()=>void this.tick(),30_000); this.timer.unref(); }
  stop() { if(this.timer) clearInterval(this.timer); }

  async tick() {
    if(this.running) return;
    this.running=true;
    try {
      const accounts=this.db.prepare(`SELECT * FROM channel_accounts WHERE status='ACTIVE' AND polling_interval_seconds IS NOT NULL AND (next_retry_at IS NULL OR datetime(next_retry_at)<=datetime('now')) AND (last_sync_at IS NULL OR datetime(last_sync_at, '+' || polling_interval_seconds || ' seconds')<=datetime('now'))`).all() as any[];
      for(const account of accounts) {
        const adapter=this.registry.get(account.channel_type);
        if(!adapter.capabilities.has("POLLING")||!adapter.syncMessages) continue;
        let credentials:Record<string,string>|null=null;
        try {
          credentials=account.encrypted_credentials ? decryptSecret<Record<string,string>>(account.encrypted_credentials,this.config.encryptionKey) : null;
          const context={db:this.db,id:String(account.id),externalAccountId:String(account.external_account_id),credentials};
          await adapter.syncConversations?.(context);
          await adapter.syncMessages(context);
          this.db.prepare("UPDATE channel_accounts SET last_sync_at=CURRENT_TIMESTAMP,last_error=NULL,consecutive_failure_count=0,next_retry_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(account.id);
        } catch(error) {
          const count=Number(account.consecutive_failure_count||0)+1;
          const message=redactCredentialValues(String(error instanceof Error?error.message:"Sync failed"),credentials).slice(0,500);
          this.db.prepare("UPDATE channel_accounts SET status=CASE WHEN ? >= 5 THEN 'DEGRADED' ELSE status END,last_error=?,consecutive_failure_count=?,next_retry_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(count,message,count,`+${retryDelaySeconds(count)} seconds`,account.id);
        }
      }
    } finally { this.running=false; }
  }
}
