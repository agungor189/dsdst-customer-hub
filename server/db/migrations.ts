export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [{
  version: 1,
  name: "initial_customer_hub",
  sql: `
    CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
      encrypted_credentials TEXT, external_account_id TEXT NOT NULL, polling_interval_seconds INTEGER,
      last_sync_at TEXT, last_error TEXT, consecutive_failure_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_type, external_account_id)
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT, normalized_email TEXT, phone TEXT, normalized_phone TEXT,
      panel_customer_id TEXT, merged_into_contact_id TEXT REFERENCES contacts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX contacts_email_idx ON contacts(normalized_email);
    CREATE INDEX contacts_phone_idx ON contacts(normalized_phone);
    CREATE TABLE contact_identities (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), channel_type TEXT NOT NULL,
      channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id), external_user_id TEXT NOT NULL,
      username TEXT, profile_url TEXT, raw_metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_account_id, external_user_id)
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
      external_conversation_id TEXT NOT NULL, subject TEXT, status TEXT NOT NULL DEFAULT 'NEW', priority TEXT NOT NULL DEFAULT 'NORMAL',
      assigned_user_id TEXT, last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, unread_count INTEGER NOT NULL DEFAULT 0,
      external_url TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT,
      UNIQUE(channel_account_id, external_conversation_id)
    );
    CREATE INDEX conversations_inbox_idx ON conversations(status, last_message_at DESC);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id), external_message_id TEXT,
      client_message_id TEXT, direction TEXT NOT NULL, sender_type TEXT NOT NULL, sender_external_id TEXT,
      body_text TEXT NOT NULL DEFAULT '', body_html TEXT, message_type TEXT NOT NULL DEFAULT 'TEXT', status TEXT NOT NULL,
      external_created_at TEXT, received_at TEXT, sent_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_account_id, external_message_id), UNIQUE(client_message_id)
    );
    CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, type TEXT NOT NULL,
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_path TEXT,
      external_url TEXT, sha256 TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT NOT NULL DEFAULT '#64748b', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE conversation_tags (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(conversation_id, tag_id)
    );
    CREATE TABLE internal_notes (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE conversation_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, actor_user_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_cursors (
      channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE, cursor_type TEXT NOT NULL,
      cursor_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(channel_account_id, cursor_type)
    );
    CREATE TABLE outbox_jobs (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error TEXT, locked_at TEXT, locked_by TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX outbox_due_idx ON outbox_jobs(status, next_attempt_at);
    CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_event_id TEXT NOT NULL, signature_valid INTEGER NOT NULL,
      payload_json TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT, processing_error TEXT,
      UNIQUE(provider, external_event_id)
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      ip_address TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);
    CREATE TABLE canned_responses (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, shortcut TEXT NOT NULL UNIQUE, body TEXT NOT NULL, category TEXT,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contact_merge_events (
      id TEXT PRIMARY KEY, source_contact_id TEXT NOT NULL, target_contact_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reversed_at TEXT
    );
    CREATE VIRTUAL TABLE message_search USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, body_text, tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO message_search(message_id, conversation_id, body_text) VALUES (new.id, new.conversation_id, new.body_text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM message_search WHERE message_id = old.id;
    END;
    CREATE TRIGGER messages_au AFTER UPDATE OF body_text ON messages BEGIN
      UPDATE message_search SET body_text = new.body_text WHERE message_id = new.id;
    END;
  `,
}];
