import type { ChannelType } from "../../shared/contracts/domain.js";

export type ChannelConfigDefinition = {
  credentialKeys: readonly string[];
  secretKeys: readonly string[];
  externalAccountKey: string;
};

export const channelConfigDefinitions: Partial<Record<ChannelType,ChannelConfigDefinition>> = {
  TRENDYOL: {
    credentialKeys:["seller_id","environment","api_key","api_secret"],
    secretKeys:["api_key","api_secret"],externalAccountKey:"seller_id",
  },
  META_WHATSAPP: {
    credentialKeys:["phone_number_id","business_account_id","graph_api_version","access_token"],
    secretKeys:["access_token"],externalAccountKey:"phone_number_id",
  },
  META_FACEBOOK: {
    credentialKeys:["page_id","graph_api_version","access_token"],
    secretKeys:["access_token"],externalAccountKey:"page_id",
  },
  META_INSTAGRAM: {
    credentialKeys:["ig_account_id","graph_api_version","access_token"],
    secretKeys:["access_token"],externalAccountKey:"ig_account_id",
  },
  EMAIL: {
    credentialKeys:["mailbox_email","imap_host","imap_port","imap_secure","smtp_host","smtp_port","smtp_secure","username","password","from_address","from_name","reply_to","imap_mailbox"],
    secretKeys:["password"],externalAccountKey:"mailbox_email",
  },
  WEBSITE: {
    credentialKeys:["site_id","site_name","allowed_origins","widget_secret"],
    secretKeys:["widget_secret"],externalAccountKey:"site_id",
  },
};

export function safeChannelConfig(channelType:ChannelType, credentials:Record<string,string>|null) {
  const definition=channelConfigDefinitions[channelType];
  if(!definition) return {non_secret_config:{},secret_state:{configured:Boolean(credentials)}};
  const secrets=new Set(definition.secretKeys);
  return {
    non_secret_config:Object.fromEntries(definition.credentialKeys.filter(key=>!secrets.has(key)&&credentials?.[key]!==undefined).map(key=>[key,credentials![key]])),
    secret_state:Object.fromEntries(definition.secretKeys.map(key=>[key,Boolean(credentials?.[key])])),
  };
}

export function mergeChannelConfig(channelType:ChannelType, existing:Record<string,string>|null, incoming:Record<string,string>) {
  const definition=channelConfigDefinitions[channelType];
  if(!definition) throw Object.assign(new Error("Bu kanal UI üzerinden yapılandırılamıyor."),{status:400,code:"CHANNEL_NOT_SUPPORTED"});
  const unknown=Object.keys(incoming).filter(key=>!definition.credentialKeys.includes(key));
  if(unknown.length) throw Object.assign(new Error("Bilinmeyen kanal ayarı."),{status:400,code:"VALIDATION_ERROR"});
  const merged:Record<string,string>={...(existing??{})};
  const secretKeys=new Set(definition.secretKeys);
  for(const key of definition.credentialKeys) {
    if(!(key in incoming)) continue;
    const value=incoming[key];
    if(secretKeys.has(key)&&value.trim()==="") continue;
    merged[key]=value;
  }
  return {credentials:merged,externalAccountId:merged[definition.externalAccountKey]?.trim()??"",secretKeysUpdated:definition.secretKeys.filter(key=>incoming[key]?.length>0)};
}
