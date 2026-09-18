export type EmailHeaders = { messageId?: string; inReplyTo?: string; references?: string[]; subject?: string };
export function resolveEmailThread(headers: EmailHeaders, find: (messageId: string) => string | null): string | null {
  for (const candidate of [headers.inReplyTo, ...(headers.references ?? []).reverse()].filter(Boolean) as string[]) {
    const conversationId = find(candidate.trim()); if (conversationId) return conversationId;
  }
  return null;
}

export interface EmailProvider {
  sync(): Promise<void>;
  send(input: {to: string; subject: string; text: string; inReplyTo?: string; references?: string[]}): Promise<{messageId: string}>;
}
