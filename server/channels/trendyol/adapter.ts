import { randomUUID } from "node:crypto";
import type { Capability } from "../../../shared/contracts/domain.js";
import { ingestInbound } from "../../messages/inbound.js";
import type { ChannelAccountContext, ChannelAdapter, ChannelSyncContext, NormalizedInboundMessage, OutboundEnvelope, ReplyValidationContext, SendResult } from "../core/types.js";
import { ProviderError } from "../core/types.js";

const PRODUCTION_BASE_URL = "https://apigw.trendyol.com";
const STAGE_BASE_URL = "https://stageapigw.trendyol.com";
const CURSOR_TYPE = "trendyol_questions_last_modified_ms";
const INITIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_OVERLAP_MS = 60 * 1000;
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;

type TrendyolCredentials = {
  seller_id: string;
  api_key: string;
  api_secret: string;
  environment: "production" | "stage";
};

export type TrendyolAnswer = {
  id?: string | number;
  text?: string;
  creationDate?: string | number;
  hasPrivateInfo?: boolean;
  reason?: string;
};

export type TrendyolQuestion = {
  id?: string | number;
  text?: string;
  customerId?: string | number;
  userName?: string;
  showUserName?: boolean;
  status?: string;
  creationDate?: string | number;
  lastModifiedDate?: string | number;
  productName?: string;
  productMainId?: string | number;
  barcode?: string;
  imageUrl?: string;
  webUrl?: string;
  public?: boolean;
  reason?: string;
  reportReason?: string;
  reportedDate?: string | number;
  rejectedDate?: string | number;
  answeredDateMessage?: string;
  answer?: TrendyolAnswer | null;
  rejectedAnswer?: TrendyolAnswer | null;
};

type QuestionsResponse = {
  content?: TrendyolQuestion[];
  page?: number;
  size?: number;
  totalElements?: number;
  totalPages?: number;
};

type AdapterOptions = {
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  maxPages?: number;
};

const capabilities: ReadonlySet<Capability> = new Set(["READ_MESSAGES", "SEND_MESSAGES", "POLLING", "PRODUCT_QUESTIONS"]);

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isoDate(value: unknown, fallbackMs: number): string {
  return new Date(timestampMs(value) ?? fallbackMs).toISOString();
}

function questionId(question: TrendyolQuestion): string {
  if (question.id === undefined || question.id === null || String(question.id).trim() === "") {
    throw new ProviderError("Trendyol question response is missing an id", true, "PROVIDER_UNAVAILABLE");
  }
  return String(question.id);
}

function publicMetadata(question: TrendyolQuestion): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    questionId: question.id === undefined ? undefined : String(question.id),
    status: question.status,
    productName: question.productName,
    productMainId: question.productMainId,
    barcode: question.barcode,
    imageUrl: question.imageUrl,
    webUrl: question.webUrl,
    creationDate: question.creationDate,
    public: question.public,
    reason: question.reason,
    reportReason: question.reportReason,
    reportedDate: question.reportedDate,
    rejectedDate: question.rejectedDate,
    answeredDateMessage: question.answeredDateMessage,
    rejectedAnswer: question.rejectedAnswer ? {
      id: question.rejectedAnswer.id,
      text: question.rejectedAnswer.text,
      creationDate: question.rejectedAnswer.creationDate,
      reason: question.rejectedAnswer.reason,
    } : undefined,
  }).filter(([, value]) => value !== undefined));
}

export function normalizeTrendyolQuestion(question: TrendyolQuestion, externalAccountId: string, nowMs = Date.now()): NormalizedInboundMessage {
  const id = questionId(question);
  const customerId = question.customerId === undefined || question.customerId === null || String(question.customerId).trim() === ""
    ? `trendyol-question-${id}`
    : String(question.customerId);
  const visibleName = question.showUserName !== false && question.userName?.trim() ? question.userName.trim() : "Trendyol Müşterisi";
  return {
    eventId: `trendyol-question-${id}`,
    externalAccountId,
    externalConversationId: id,
    externalMessageId: `trendyol-question-${id}`,
    externalUserId: customerId,
    displayName: visibleName,
    body: question.text ?? "",
    subject: question.productName,
    messageType: "PRODUCT_QUESTION",
    externalCreatedAt: isoDate(question.creationDate, nowMs),
    metadata: publicMetadata(question),
  };
}

export function validateTrendyolAnswerText(text: string): void {
  const length = [...text].length;
  if (length < 10 || length > 2000) {
    throw new ProviderError("Trendyol answer text must be between 10 and 2000 characters", false, "PROVIDER_VALIDATION_FAILED");
  }
}

function modifiedAt(question: TrendyolQuestion): number | null {
  const values = [
    question.lastModifiedDate,
    question.creationDate,
    question.reportedDate,
    question.rejectedDate,
    question.answer?.creationDate,
    question.rejectedAnswer?.creationDate,
  ].map(timestampMs).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

export class TrendyolAdapter implements ChannelAdapter {
  readonly channelType = "TRENDYOL" as const;
  readonly capabilities = capabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxPages: number;

  constructor(private readonly options: AdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  }

  validateConfiguration(credentials: Record<string, string> | null) {
    const errors = ["seller_id", "api_key", "api_secret"]
      .filter(key => !credentials?.[key]?.trim())
      .map(key => `${key} is required`);
    if (credentials?.environment && credentials.environment !== "production" && credentials.environment !== "stage") {
      errors.push("environment must be production or stage");
    }
    return { valid: errors.length === 0, errors };
  }

  validateReply(envelope: OutboundEnvelope, _context: ReplyValidationContext): void {
    validateTrendyolAnswerText(envelope.body);
  }

  async syncMessages(context: ChannelSyncContext): Promise<void> {
    const credentials = this.credentials(context.credentials);
    const endDate = this.now();
    const cursor = context.db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type=?")
      .get(context.id, CURSOR_TYPE) as {cursor_value: string}|undefined;
    const cursorMs = cursor ? Number(cursor.cursor_value) : Number.NaN;
    const startDate = Number.isFinite(cursorMs) ? Math.max(0, cursorMs - CURSOR_OVERLAP_MS) : endDate - INITIAL_WINDOW_MS;
    let newestObserved = startDate;
    let completed = true;

    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.listQuestions(credentials, { startDate, endDate, page, size: PAGE_SIZE });
      const questions = Array.isArray(response.content) ? response.content : [];
      for (const question of questions) {
        const normalized = normalizeTrendyolQuestion(question, context.externalAccountId, endDate);
        ingestInbound(context.db, "TRENDYOL", normalized);
        const conversation = context.db.prepare("SELECT id,metadata_json FROM conversations WHERE channel_account_id=? AND external_conversation_id=?")
          .get(context.id, normalized.externalConversationId) as {id: string; metadata_json: string}|undefined;
        if (!conversation) throw new ProviderError("Normalized Trendyol conversation was not persisted", true, "PROVIDER_UNAVAILABLE");
        let existingMetadata: Record<string, unknown> = {};
        try { existingMetadata = JSON.parse(conversation.metadata_json || "{}"); } catch { /* preserve a valid provider snapshot below */ }
        context.db.prepare("UPDATE conversations SET subject=?,external_url=?,metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(normalized.subject ?? null, question.webUrl ?? null, JSON.stringify({...existingMetadata,...normalized.metadata}), conversation.id);
        this.syncProviderAnswer(context, conversation.id, question);
        newestObserved = Math.max(newestObserved, modifiedAt(question) ?? newestObserved);
      }

      const totalPages = Number(response.totalPages ?? (questions.length < PAGE_SIZE ? page + 1 : page + 2));
      if (questions.length === 0 || page + 1 >= totalPages) break;
      if (page + 1 === this.maxPages) completed = false;
    }

    const nextCursor = completed ? endDate : newestObserved;
    context.db.prepare(`INSERT INTO sync_cursors(channel_account_id,cursor_type,cursor_value) VALUES(?,?,?)
      ON CONFLICT(channel_account_id,cursor_type) DO UPDATE SET cursor_value=excluded.cursor_value,updated_at=CURRENT_TIMESTAMP`)
      .run(context.id, CURSOR_TYPE, String(nextCursor));
  }

  async sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult> {
    validateTrendyolAnswerText(envelope.body);
    const credentials = this.credentials(account.credentials);
    const questionId = String(envelope.metadata.questionId ?? envelope.metadata.question_id ?? envelope.externalConversationId).trim();
    if (!questionId) throw new ProviderError("Trendyol question id is missing", false, "QUESTION_NOT_FOUND");
    const result = await this.requestJson<{answerId?: string|number}>(
      credentials,
      `/integration/qna/sellers/${encodeURIComponent(credentials.seller_id)}/questions/${encodeURIComponent(questionId)}/answers`,
      { method: "POST", body: JSON.stringify({text: envelope.body}) },
    );
    if (result.answerId === undefined || result.answerId === null || String(result.answerId).trim() === "") {
      throw new ProviderError("Trendyol answer response is missing answerId", true, "PROVIDER_UNAVAILABLE");
    }
    return { externalMessageId: String(result.answerId), status: "SENT" };
  }

  private async listQuestions(credentials: TrendyolCredentials, input: {startDate: number; endDate: number; page: number; size: number; status?: string}) {
    const query = new URLSearchParams({
      startDate: String(input.startDate),
      endDate: String(input.endDate),
      page: String(input.page),
      size: String(input.size),
      orderByField: "LastModifiedDate",
      orderByDirection: "ASC",
    });
    if (input.status) query.set("status", input.status);
    return this.requestJson<QuestionsResponse>(credentials, `/integration/qna/sellers/${encodeURIComponent(credentials.seller_id)}/questions/filter?${query}`);
  }

  private syncProviderAnswer(context: ChannelSyncContext, conversationId: string, question: TrendyolQuestion) {
    const answer = question.answer;
    if (question.status !== "ANSWERED" || !answer || answer.id === undefined || answer.id === null || !answer.text) return;
    const externalMessageId = String(answer.id);
    const existing = context.db.prepare("SELECT id FROM messages WHERE channel_account_id=? AND external_message_id=?")
      .get(context.id, externalMessageId) as {id: string}|undefined;
    if (existing) {
      context.db.prepare("UPDATE messages SET status='SENT',sent_at=COALESCE(sent_at,CURRENT_TIMESTAMP) WHERE id=?").run(existing.id);
      return;
    }
    const createdAt = isoDate(answer.creationDate, this.now());
    context.db.transaction(() => {
      const matchingOutbound = context.db.prepare(`SELECT id FROM messages
        WHERE conversation_id=? AND direction='OUTBOUND' AND external_message_id IS NULL AND body_text=? AND status IN ('QUEUED','SENDING','SENT')
        ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1`).get(conversationId, answer.text) as {id:string}|undefined;
      if (matchingOutbound) {
        context.db.prepare("UPDATE messages SET external_message_id=?,status='SENT',external_created_at=COALESCE(external_created_at,?),sent_at=COALESCE(sent_at,?),metadata_json=? WHERE id=?")
          .run(externalMessageId,createdAt,createdAt,JSON.stringify({answerId:externalMessageId,hasPrivateInfo:answer.hasPrivateInfo}),matchingOutbound.id);
        context.db.prepare("UPDATE outbox_jobs SET status='COMPLETED',locked_at=NULL,locked_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND status IN ('PENDING','PROCESSING')")
          .run(matchingOutbound.id);
      } else {
        context.db.prepare(`INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,message_type,status,external_created_at,sent_at,metadata_json)
          VALUES(?,?,?,?,?,'SYSTEM',?,'PRODUCT_ANSWER','SENT',?,?,?)`)
          .run(randomUUID(), conversationId, context.id, externalMessageId, "OUTBOUND", answer.text, createdAt, createdAt, JSON.stringify({answerId: externalMessageId, hasPrivateInfo: answer.hasPrivateInfo}));
      }
      context.db.prepare("UPDATE conversations SET status='WAITING_CUSTOMER',last_message_at=CASE WHEN datetime(last_message_at)<datetime(?) THEN ? ELSE last_message_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(createdAt, createdAt, conversationId);
    })();
  }

  private credentials(value: Record<string, string> | null): TrendyolCredentials {
    const validation = this.validateConfiguration(value);
    if (!validation.valid || !value) throw new ProviderError("Trendyol account is not configured", false, "NOT_CONFIGURED");
    return {
      seller_id: value.seller_id.trim(),
      api_key: value.api_key,
      api_secret: value.api_secret,
      environment: value.environment === "stage" ? "stage" : "production",
    };
  }

  private async requestJson<T>(credentials: TrendyolCredentials, path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = credentials.environment === "stage" ? STAGE_BASE_URL : PRODUCTION_BASE_URL;
    try {
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${credentials.api_key}:${credentials.api_secret}`, "utf8").toString("base64")}`,
          "User-Agent": `${credentials.seller_id} - SelfIntegration`,
          ...(init.body ? {"Content-Type": "application/json"} : {}),
          ...init.headers,
        },
      });
      if (!response.ok) throw this.httpError(response.status);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Trendyol provider is unavailable", true, "PROVIDER_UNAVAILABLE");
    }
  }

  private httpError(status: number): ProviderError {
    if (status === 400) return new ProviderError("Trendyol rejected the request", false, "PROVIDER_VALIDATION_FAILED");
    if (status === 401) return new ProviderError("Trendyol authentication failed", false, "AUTHENTICATION_FAILED");
    if (status === 403) return new ProviderError("Trendyol authorization failed", false, "AUTHORIZATION_FAILED");
    if (status === 404) return new ProviderError("Trendyol question was not found", false, "QUESTION_NOT_FOUND");
    if (status === 429) return new ProviderError("Trendyol rate limit exceeded", true, "RATE_LIMITED");
    if (status >= 500) return new ProviderError("Trendyol provider is unavailable", true, "PROVIDER_UNAVAILABLE");
    return new ProviderError("Trendyol rejected the request", false, "PROVIDER_VALIDATION_FAILED");
  }
}
