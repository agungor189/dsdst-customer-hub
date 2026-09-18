import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { migrations } from "./migrations.js";

export function openDatabase(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const apply = db.transaction(() => {
    const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{version: number}>).map(row => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name) VALUES (?, ?)").run(migration.version, migration.name);
    }
  });
  apply();
  return db;
}

export function seedDevelopmentData(db: Database.Database) {
  const count = (db.prepare("SELECT count(*) count FROM channel_accounts").get() as {count: number}).count;
  if (count > 0) return;
  const now = new Date().toISOString();
  const seed = db.transaction(() => {
    const accounts = [
      ["META_INSTAGRAM", "Instagram", "demo-instagram", "ACTIVE"],
      ["META_WHATSAPP", "WhatsApp", "demo-whatsapp", "NOT_CONFIGURED"],
      ["EMAIL", "E-posta", "support@dsdst.com", "ACTIVE"],
      ["WEBSITE", "Website", "website", "ACTIVE"],
      ["TRENDYOL", "Trendyol", "trendyol", "NOT_CONFIGURED"],
      ["N11", "n11", "n11", "NOT_CONFIGURED"],
      ["MANUAL_EXTERNAL", "Manuel", "manual", "ACTIVE"],
    ].map(([channelType, name, externalId, status]) => ({ id: randomUUID(), channelType, name, externalId, status }));
    const insertAccount = db.prepare("INSERT INTO channel_accounts(id, channel_type, name, external_account_id, status) VALUES(?,?,?,?,?)");
    for (const a of accounts) insertAccount.run(a.id, a.channelType, a.name, a.externalId, a.status);
    const samples = [
      { type: "META_INSTAGRAM", name: "Melis Aydın", user: "melisbahce", body: "Merhaba, OYA serisi saksılıklar dış mekâna uygun mu?", priority: "HIGH", unread: 2, status: "NEW" },
      { type: "EMAIL", name: "Ali Vural", user: "ali@vural.com", body: "Siparişimin kargo durumunu öğrenebilir miyim?", priority: "NORMAL", unread: 1, status: "OPEN" },
      { type: "WEBSITE", name: "Ece Demir", user: "ece-web", body: "120 cm model için kurulum hizmetiniz var mı?", priority: "NORMAL", unread: 0, status: "WAITING_CUSTOMER" },
      { type: "TRENDYOL", name: "Müşteri #4821", user: "tr-4821", body: "Bu ürün 40x80 sera rafına uyar mı?", priority: "URGENT", unread: 3, status: "NEW" },
    ];
    for (const [index, sample] of samples.entries()) {
      const account = accounts.find(a => a.channelType === sample.type)!;
      const contactId = randomUUID(); const conversationId = randomUUID(); const messageId = randomUUID();
      db.prepare("INSERT INTO contacts(id,display_name,email,normalized_email) VALUES(?,?,?,?)").run(contactId, sample.name, sample.user.includes("@") ? sample.user : null, sample.user.includes("@") ? sample.user : null);
      db.prepare("INSERT INTO contact_identities(id,contact_id,channel_type,channel_account_id,external_user_id,username) VALUES(?,?,?,?,?,?)").run(randomUUID(), contactId, sample.type, account.id, sample.user, sample.user);
      const timestamp = new Date(Date.now() - index * 37 * 60_000).toISOString();
      db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id,status,priority,last_message_at,unread_count,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(conversationId, account.id, contactId, `demo-${index}`, sample.status, sample.priority, timestamp, sample.unread, sample.type === "TRENDYOL" ? JSON.stringify({type:"PRODUCT_QUESTION", sku:"OYA-120", product_name:"OYA 120 Raf", order_code:"TY-4821"}) : "{}");
      db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,status,external_created_at,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(messageId, conversationId, account.id, `demo-msg-${index}`, "INBOUND", "CUSTOMER", sample.body, "RECEIVED", timestamp, timestamp, timestamp);
    }
    for (const [name,color] of [["Satış fırsatı","#0f766e"],["Kargo","#2563eb"],["Ürün sorusu","#c2410c"]]) db.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,?)").run(randomUUID(),name,color);
    for (const [title,shortcut,body,category] of [["Kargo bilgisi","/kargo","Sipariş numaranızı paylaşabilir misiniz? Hemen kontrol edelim.","Sipariş"],["Uyumluluk","/uyumluluk","Ürün ölçülerini ve kullanacağınız alanı paylaşırsanız uyumluluğu kontrol edebiliriz.","Ürün"]]) db.prepare("INSERT INTO canned_responses(id,title,shortcut,body,category) VALUES(?,?,?,?,?)").run(randomUUID(),title,shortcut,body,category);
  });
  seed();
  void now;
}
