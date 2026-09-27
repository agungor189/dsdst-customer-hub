import type { Capability } from "../../../shared/contracts/domain.js";
import type {
  ChannelAccountContext,
  ChannelAdapter,
  NormalizedInboundMessage,
  NormalizedMessageStatus,
  NormalizedWebhookBatch,
  OutboundEnvelope,
  ReplyValidationContext,
  SendResult,
  WhatsAppTemplate,
  WhatsAppTemplateParameters,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GRAPH_ORIGIN = "https://graph.facebook.com";
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;
const TEMPLATE_PAGE_LIMIT = 100;
const TEMPLATE_MAX_PAGES = 10;
const capabilities: ReadonlySet<Capability> = new Set([
  "READ_MESSAGES", "SEND_MESSAGES", "WEBHOOK", "ATTACHMENTS", "MARK_READ", "CUSTOMER_PROFILE",
]);

type WhatsAppCredentials = {
  access_token: string;
  phone_number_id: string;
  business_account_id?: string;
  graph_api_version: string;
};

type AdapterOptions = { timeoutMs: number; fetch?: typeof fetch; now?: () => number };

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function providerTime(value: unknown, fallbackMs: number): string {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return new Date(Number.isFinite(seconds) ? seconds * 1000 : fallbackMs).toISOString();
}

function mediaMessage(message: Record<string, any>) {
  const type = String(message.type ?? "unknown").toLowerCase();
  const media = record(message[type]);
  const mapping: Record<string,{messageType:string;body:string}> = {
    image: {messageType:"IMAGE",body:"[Görsel]"},
    document: {messageType:"DOCUMENT",body:"[Belge]"},
    audio: {messageType:"AUDIO",body:"[Ses]"},
    video: {messageType:"VIDEO",body:"[Video]"},
    sticker: {messageType:"STICKER",body:"[Görsel]"},
  };
  const selected = mapping[type] ?? {messageType:type.toUpperCase(),body:`[${type || "Mesaj"}]`};
  return {
    ...selected,
    metadata: Object.fromEntries(Object.entries({
      provider_media_id: media.id,
      mime_type: media.mime_type,
      filename: media.filename,
      caption: media.caption,
    }).filter(([,child]) => child !== undefined)),
  };
}

export function normalizeWhatsAppWebhook(payload: unknown, nowMs = Date.now()): NormalizedWebhookBatch {
  const messages: NormalizedInboundMessage[] = [];
  const statuses: NormalizedMessageStatus[] = [];
  const root = record(payload);
  for (const entryValue of Array.isArray(root.entry) ? root.entry : []) {
    const entry = record(entryValue);
    for (const changeValue of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = record(record(changeValue).value);
      if (value.messaging_product !== "whatsapp") continue;
      const phoneNumberId = String(record(value.metadata).phone_number_id ?? "").trim();
      if (!phoneNumberId) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts.map(record) : [];
      for (const rawMessage of Array.isArray(value.messages) ? value.messages : []) {
        const message = record(rawMessage);
        const from = String(message.from ?? "").trim();
        const id = String(message.id ?? "").trim();
        if (!from || !id) continue;
        const contact = contacts.find(item => String(item.wa_id ?? "") === from) ?? contacts[0] ?? {};
        const waId = String(contact.wa_id ?? from);
        const type = String(message.type ?? "unknown").toLowerCase();
        const content = type === "text"
          ? {messageType:"TEXT",body:String(record(message.text).body ?? ""),metadata:{}}
          : mediaMessage(message);
        messages.push({
          eventId:`whatsapp:${phoneNumberId}:${id}`,
          externalAccountId:phoneNumberId,
          externalConversationId:from,
          externalMessageId:id,
          externalUserId:waId,
          displayName:String(record(contact.profile).name ?? "WhatsApp Müşterisi"),
          body:content.body,
          messageType:content.messageType,
          externalCreatedAt:providerTime(message.timestamp,nowMs),
          metadata:{provider:"meta_whatsapp",wa_id:waId,phone_number_id:phoneNumberId,message_type:type,...content.metadata},
        });
      }
      for (const rawStatus of Array.isArray(value.statuses) ? value.statuses : []) {
        const statusValue = record(rawStatus);
        const id = String(statusValue.id ?? "").trim();
        const providerStatus = String(statusValue.status ?? "").toLowerCase();
        const mapped = ({sent:"SENT",delivered:"DELIVERED",read:"READ",failed:"FAILED"} as const)[providerStatus as "sent"|"delivered"|"read"|"failed"];
        if (!id || !mapped) continue;
        const errorCodes = (Array.isArray(statusValue.errors) ? statusValue.errors : [])
          .map(item => record(item).code).filter(code => typeof code === "number" || typeof code === "string");
        statuses.push({
          eventId:`whatsapp-status:${phoneNumberId}:${id}:${providerStatus}:${String(statusValue.timestamp ?? "")}`,
          externalAccountId:phoneNumberId,
          externalMessageId:id,
          status:mapped,
          externalCreatedAt:providerTime(statusValue.timestamp,nowMs),
          metadata:Object.fromEntries(Object.entries({provider:"meta_whatsapp",provider_status:providerStatus,provider_error_codes:errorCodes.length ? errorCodes : undefined}).filter(([,child]) => child !== undefined)),
        });
      }
    }
  }
  return {messages,statuses};
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly channelType = "META_WHATSAPP" as const;
  readonly capabilities = capabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly templateCache = new Map<string,{expiresAt:number;templates:WhatsAppTemplate[]}>();

  constructor(private readonly options: AdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  validateConfiguration(credentials: Record<string,string> | null, externalAccountId?: string) {
    const errors = ["access_token","phone_number_id","graph_api_version"]
      .filter(key => !credentials?.[key]?.trim()).map(key => `${key} is required`);
    if (credentials?.graph_api_version && !/^v\d+\.\d+$/.test(credentials.graph_api_version.trim())) {
      errors.push("graph_api_version must use vXX.X format");
    }
    if (externalAccountId && credentials?.phone_number_id?.trim() && credentials.phone_number_id.trim() !== externalAccountId) {
      errors.push("phone_number_id must match external_account_id");
    }
    return {valid:errors.length===0,errors};
  }

  validateReply(_envelope: OutboundEnvelope, context: ReplyValidationContext): void {
    if (_envelope.metadata.whatsapp_mode === "TEMPLATE") return;
    const row = context.db.prepare(`SELECT COALESCE(external_created_at,received_at,created_at) last_inbound_at
      FROM messages WHERE channel_account_id=? AND conversation_id=(SELECT id FROM conversations WHERE channel_account_id=? AND external_conversation_id=?)
      AND direction='INBOUND' ORDER BY datetime(COALESCE(external_created_at,received_at,created_at)) DESC,rowid DESC LIMIT 1`)
      .get(context.id,context.id,_envelope.externalConversationId) as {last_inbound_at:string}|undefined;
    const lastInbound = row ? Date.parse(row.last_inbound_at) : Number.NaN;
    if (!Number.isFinite(lastInbound) || this.now() - lastInbound > SERVICE_WINDOW_MS) {
      throw new ProviderError("24 saatlik müşteri hizmetleri penceresi kapalı. Template mesaj gerekli.",false,"WHATSAPP_TEMPLATE_REQUIRED");
    }
  }

  handleWebhook(payload: unknown): NormalizedWebhookBatch {
    return normalizeWhatsAppWebhook(payload,this.now());
  }

  async sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult> {
    const credentials = this.credentials(account);
    const template = this.templatePayload(envelope);
    const response = await this.request(credentials,"messages",{
      messaging_product:"whatsapp",
      recipient_type:"individual",
      to:envelope.externalConversationId,
      ...(template ? {type:"template",template} : {type:"text",text:{preview_url:false,body:envelope.body}}),
    });
    const id = String(record(Array.isArray(response.messages) ? response.messages[0] : undefined).id ?? "").trim();
    if (!id) throw new ProviderError("WhatsApp response is missing a message id",true,"PROVIDER_UNAVAILABLE");
    return {externalMessageId:id,status:"SENT"};
  }

  async markRead(externalMessageId: string, account: ChannelAccountContext): Promise<void> {
    const credentials = this.credentials(account);
    await this.request(credentials,"messages",{messaging_product:"whatsapp",status:"read",message_id:externalMessageId});
  }

  async listWhatsAppTemplates(account: ChannelAccountContext): Promise<WhatsAppTemplate[]> {
    const credentials=this.credentials(account);
    if (!credentials.business_account_id) throw new ProviderError("WhatsApp business account id is required to list templates",false,"WHATSAPP_WABA_REQUIRED");
    const templates:WhatsAppTemplate[]=[];
    let after:string|undefined;
    for (let page=0;page<TEMPLATE_MAX_PAGES;page+=1) {
      const query=new URLSearchParams({limit:String(TEMPLATE_PAGE_LIMIT),fields:"id,name,language,category,status,quality_score,components"});
      if (after) query.set("after",after);
      const payload=await this.getRequest(credentials,credentials.business_account_id,"message_templates",query);
      for (const item of Array.isArray(payload.data)?payload.data:[]) {
        const normalized=this.normalizeTemplate(item);
        if (normalized) templates.push(normalized);
      }
      const nextAfter=String(record(record(payload.paging).cursors).after??"").trim();
      const hasNext=Boolean(record(payload.paging).next);
      if (!hasNext||!nextAfter||nextAfter===after) break;
      after=nextAfter;
    }
    this.templateCache.set(this.templateCacheKey(account,credentials),{expiresAt:this.now()+TEMPLATE_CACHE_TTL_MS,templates});
    return templates;
  }

  async validateWhatsAppTemplate(account: ChannelAccountContext, name: string, language: string, parameters: WhatsAppTemplateParameters): Promise<WhatsAppTemplate> {
    const credentials=this.credentials(account);
    if (!credentials.business_account_id) throw new ProviderError("WhatsApp business account id is required to validate templates",false,"WHATSAPP_WABA_REQUIRED");
    const cached=this.templateCache.get(this.templateCacheKey(account,credentials));
    const templates=cached&&cached.expiresAt>this.now()?cached.templates:await this.listWhatsAppTemplates(account);
    const template=templates.find(item=>item.name===name&&item.language===language);
    if (!template) throw new ProviderError("WhatsApp template was not found for this account and language",false,"WHATSAPP_TEMPLATE_NOT_FOUND");
    if (template.status!=="APPROVED") throw new ProviderError("WhatsApp template is not approved",false,"WHATSAPP_TEMPLATE_NOT_APPROVED");
    this.validateTemplateComponents(template,parameters);
    return template;
  }

  private credentials(account: ChannelAccountContext): WhatsAppCredentials {
    const value = account.credentials;
    const validation = this.validateConfiguration(value);
    if (!validation.valid || !value) throw new ProviderError("WhatsApp account is not configured",false,"NOT_CONFIGURED");
    if (value.phone_number_id.trim() !== account.externalAccountId) {
      throw new ProviderError("WhatsApp phone number does not match the channel account",false,"ACCOUNT_CONFIGURATION_MISMATCH");
    }
    return {
      access_token:value.access_token,
      phone_number_id:value.phone_number_id.trim(),
      business_account_id:value.business_account_id?.trim() || undefined,
      graph_api_version:value.graph_api_version.trim(),
    };
  }

  private templatePayload(envelope: OutboundEnvelope):Record<string,unknown>|null {
    if (envelope.metadata.whatsapp_mode!=="TEMPLATE") return null;
    const name=typeof envelope.metadata.template_name==="string"?envelope.metadata.template_name:"";
    const language=typeof envelope.metadata.language_code==="string"?envelope.metadata.language_code:"";
    const components=Array.isArray(envelope.metadata.template_components)?envelope.metadata.template_components:[];
    if (!/^[a-z][a-z0-9_]{0,511}$/.test(name)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
      throw new ProviderError("WhatsApp template metadata is invalid",false,"PROVIDER_VALIDATION_FAILED");
    }
    for (const rawComponent of components) {
      const component=record(rawComponent);
      if (!(component.type==="header"||component.type==="body")||!Array.isArray(component.parameters)) {
        throw new ProviderError("WhatsApp template component is unsupported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
      }
      for (const rawParameter of component.parameters) {
        const parameter=record(rawParameter);
        if (parameter.type!=="text"||typeof parameter.text!=="string") {
          throw new ProviderError("WhatsApp template component is unsupported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
        }
        if (!parameter.text.length||parameter.text.length>1024||/[\u0000-\u001F\u007F]/.test(parameter.text)) {
          throw new ProviderError("WhatsApp template text parameter is invalid",false,"PROVIDER_VALIDATION_FAILED");
        }
      }
    }
    return {name,language:{code:language},components};
  }

  private normalizeTemplate(value:unknown):WhatsAppTemplate|null {
    const item=record(value);
    const id=String(item.id??"").trim();
    const name=String(item.name??"").trim();
    const language=String(item.language??"").trim();
    if (!id||!name||!language) return null;
    const components=(Array.isArray(item.components)?item.components:[]).map(raw=>{
      const component=record(raw);
      return Object.fromEntries(Object.entries({
        type:String(component.type??"").toUpperCase(),
        format:typeof component.format==="string"?component.format.toUpperCase():undefined,
        text:typeof component.text==="string"?component.text:undefined,
        buttons:Array.isArray(component.buttons)?component.buttons.map(rawButton=>{
          const button=record(rawButton);
          return Object.fromEntries(Object.entries({type:button.type,text:button.text,url:button.url}).filter(([,child])=>typeof child==="string"));
        }):undefined,
      }).filter(([,child])=>child!==undefined));
    }) as Array<Record<string,unknown>&{type:string}>;
    return {
      id,name,language,
      category:String(item.category??"UNKNOWN").toUpperCase(),
      status:String(item.status??"UNKNOWN").toUpperCase(),
      ...(item.quality_score!==undefined?{quality_score:typeof item.quality_score==="object"?record(item.quality_score).score:item.quality_score}:{}),
      components,
    };
  }

  private templateCacheKey(account:ChannelAccountContext,credentials:WhatsAppCredentials) {
    return `${account.id}:${account.externalAccountId}:${credentials.business_account_id??""}`;
  }

  private validateTemplateComponents(template:WhatsAppTemplate,parameters:WhatsAppTemplateParameters) {
    let expectedBody=0;
    let expectedHeader=0;
    for (const component of template.components) {
      const type=component.type.toUpperCase();
      if (type==="BODY") expectedBody=this.placeholderCount(component.text);
      else if (type==="HEADER") {
        if (String(component.format??"TEXT").toUpperCase()!=="TEXT") throw new ProviderError("Media template headers are not supported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
        expectedHeader=this.placeholderCount(component.text);
      } else if (type==="BUTTONS") {
        const buttons=Array.isArray(component.buttons)?component.buttons.map(record):[];
        const supportedButtonTypes=new Set(["QUICK_REPLY","PHONE_NUMBER","URL"]);
        if (buttons.some(button=>!supportedButtonTypes.has(String(button.type??"").toUpperCase())||/{{[^}]+}}/.test(String(button.url??"")))) {
          throw new ProviderError("Dynamic or complex template buttons are not supported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
        }
      } else if (type!=="FOOTER") {
        throw new ProviderError("WhatsApp template component is unsupported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
      }
    }
    if (parameters.body.length!==expectedBody||parameters.header.length!==expectedHeader) {
      throw new ProviderError("WhatsApp template parameter count does not match the approved template",false,"PROVIDER_VALIDATION_FAILED");
    }
  }

  private placeholderCount(value:unknown):number {
    const text=typeof value==="string"?value:"";
    if (/{{\s*[^\d\s][^}]*}}/.test(text)) throw new ProviderError("Named template parameters are not supported",false,"WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED");
    const matches=[...text.matchAll(/{{\s*(\d+)\s*}}/g)].map(match=>Number(match[1]));
    return matches.length?Math.max(...matches):0;
  }

  private async request(credentials: WhatsAppCredentials, path: string, body: Record<string,unknown>): Promise<Record<string,any>> {
    try {
      const response = await this.fetchImpl(`${GRAPH_ORIGIN}/${credentials.graph_api_version}/${encodeURIComponent(credentials.phone_number_id)}/${path}`,{
        method:"POST",
        signal:AbortSignal.timeout(this.options.timeoutMs),
        headers:{Authorization:`Bearer ${credentials.access_token}`,"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify(body),
      });
      if (!response.ok) throw this.httpError(response.status);
      return record(await response.json());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("WhatsApp provider is unavailable",true,"PROVIDER_UNAVAILABLE");
    }
  }

  private async getRequest(credentials:WhatsAppCredentials,resourceId:string,path:string,query:URLSearchParams):Promise<Record<string,any>> {
    try {
      const response=await this.fetchImpl(`${GRAPH_ORIGIN}/${credentials.graph_api_version}/${encodeURIComponent(resourceId)}/${path}?${query}`,{
        method:"GET",signal:AbortSignal.timeout(this.options.timeoutMs),headers:{Authorization:`Bearer ${credentials.access_token}`,Accept:"application/json"},
      });
      if (!response.ok) throw this.httpError(response.status);
      return record(await response.json());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("WhatsApp provider is unavailable",true,"PROVIDER_UNAVAILABLE");
    }
  }

  private httpError(status: number): ProviderError {
    if (status === 400) return new ProviderError("WhatsApp rejected the request",false,"PROVIDER_VALIDATION_FAILED");
    if (status === 401) return new ProviderError("WhatsApp authentication failed",false,"AUTHENTICATION_FAILED");
    if (status === 403) return new ProviderError("WhatsApp authorization failed",false,"AUTHORIZATION_FAILED");
    if (status === 404) return new ProviderError("WhatsApp resource was not found",false,"RESOURCE_NOT_FOUND");
    if (status === 429) return new ProviderError("WhatsApp rate limit exceeded",true,"RATE_LIMITED");
    if (status >= 500) return new ProviderError("WhatsApp provider is unavailable",true,"PROVIDER_UNAVAILABLE");
    return new ProviderError("WhatsApp rejected the request",false,"PROVIDER_VALIDATION_FAILED");
  }
}
