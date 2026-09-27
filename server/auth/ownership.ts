import type Database from "better-sqlite3";
import type { PanelUser } from "../../shared/contracts/domain.js";

export type SqlScope = { sql: string; params: Array<string | number> };

export function conversationAccountScope(alias: string, user: PanelUser): SqlScope {
  return {
    sql: `(${alias}.channel_type <> 'EMAIL' OR ${alias}.owner_user_id = ?)`,
    params: [user.id],
  };
}

export function channelSettingsListScope(alias: string, user: PanelUser): SqlScope {
  return {
    sql: user.role === "admin"
      ? `(${alias}.channel_type <> 'EMAIL' OR ${alias}.owner_user_id = ? OR ${alias}.owner_user_id IS NULL)`
      : `(${alias}.channel_type = 'EMAIL' AND ${alias}.owner_user_id = ?)`,
    params: [user.id],
  };
}

export function channelConfigScope(alias: string, user: PanelUser): SqlScope {
  return {
    sql: user.role === "admin"
      ? `(${alias}.channel_type <> 'EMAIL' OR (${alias}.channel_type = 'EMAIL' AND ${alias}.owner_user_id = ?))`
      : `(${alias}.channel_type = 'EMAIL' AND ${alias}.owner_user_id = ?)`,
    params: [user.id],
  };
}

export function canAccessConversation(db: Database.Database, conversationId: string, user: PanelUser): boolean {
  const scope = conversationAccountScope("a", user);
  return Boolean(db.prepare(`
    SELECT 1
    FROM conversations c
    JOIN channel_accounts a ON a.id = c.channel_account_id
    WHERE c.id = ? AND ${scope.sql}
  `).get(conversationId, ...scope.params));
}

export function contactVisibilityScope(contactAlias: string, user: PanelUser): SqlScope {
  const accountScope=conversationAccountScope("scope_account",user);
  return {
    sql:`EXISTS (
      SELECT 1 FROM conversations scope_conversation
      JOIN channel_accounts scope_account ON scope_account.id=scope_conversation.channel_account_id
      WHERE scope_conversation.contact_id=${contactAlias}.id AND ${accountScope.sql}
    )`,
    params:accountScope.params,
  };
}

export function canAccessEntireContact(db:Database.Database,contactId:string,user:PanelUser):boolean {
  const row=db.prepare(`SELECT count(*) total,
    sum(CASE WHEN a.channel_type <> 'EMAIL' OR a.owner_user_id = ? THEN 1 ELSE 0 END) visible
    FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.contact_id=?`).get(user.id,contactId) as {total:number;visible:number|null};
  return (row.visible??0)===row.total;
}
