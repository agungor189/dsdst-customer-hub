import {useCallback,useEffect,useMemo,useState} from "react";
import {AtSign,Check,ChevronLeft,Clipboard,Eye,EyeOff,Globe2,Mail,MessageCircle,RefreshCw,Settings2,ShoppingBag,X} from "lucide-react";
import type {ChannelType,PanelUser} from "../../../shared/contracts/domain";
import {api,ApiError} from "../../lib/api";

type Account={id:string;channel_type:ChannelType;name:string;status:string;external_account_id:string;polling_interval_seconds:number|null;last_sync_at:string|null;last_error:string|null;next_retry_at:string|null};
type Config=Account&{non_secret_config:Record<string,string>;secret_state:Record<string,boolean>;app_origin:string};
type Field={key:string;label:string;kind?:"password"|"select"|"checkbox"|"origins";required?:boolean;optionalSecret?:boolean;options?:Array<[string,string]>;placeholder?:string};
type Provider={type:ChannelType;label:string;description:string;Icon:typeof Mail;fields:Field[];externalKey:string;polling:boolean};

const providers:Provider[]=[
  {type:"TRENDYOL",label:"Trendyol",description:"Ürün soruları ve yanıtları",Icon:ShoppingBag,externalKey:"seller_id",polling:true,fields:[
    {key:"seller_id",label:"Seller ID",required:true},{key:"environment",label:"Environment",kind:"select",required:true,options:[["production","Production"],["stage","Stage"]]},
    {key:"api_key",label:"API Key",kind:"password",required:true},{key:"api_secret",label:"API Secret",kind:"password",required:true},
  ]},
  {type:"META_WHATSAPP",label:"WhatsApp",description:"Cloud API mesajları ve template’ler",Icon:MessageCircle,externalKey:"phone_number_id",polling:false,fields:[
    {key:"phone_number_id",label:"Phone Number ID",required:true},{key:"business_account_id",label:"WABA / Business Account ID"},{key:"graph_api_version",label:"Graph API Version",required:true,placeholder:"vXX.X"},{key:"access_token",label:"Access Token",kind:"password",required:true},
  ]},
  {type:"META_INSTAGRAM",label:"Instagram",description:"Instagram Direct mesajları",Icon:AtSign,externalKey:"ig_account_id",polling:false,fields:[
    {key:"ig_account_id",label:"Instagram Account ID",required:true},{key:"graph_api_version",label:"Graph API Version",required:true,placeholder:"vXX.X"},{key:"access_token",label:"Access Token",kind:"password",required:true},
  ]},
  {type:"META_FACEBOOK",label:"Facebook Messenger",description:"Sayfa mesajları",Icon:MessageCircle,externalKey:"page_id",polling:false,fields:[
    {key:"page_id",label:"Page ID",required:true},{key:"graph_api_version",label:"Graph API Version",required:true,placeholder:"vXX.X"},{key:"access_token",label:"Page Access Token",kind:"password",required:true},
  ]},
  {type:"EMAIL",label:"E-posta",description:"IMAP gelen kutusu ve SMTP yanıtları",Icon:Mail,externalKey:"mailbox_email",polling:true,fields:[
    {key:"mailbox_email",label:"Mailbox e-posta / external account",required:true},{key:"imap_host",label:"IMAP Host",required:true},{key:"imap_port",label:"IMAP Port",required:true},{key:"imap_secure",label:"IMAP SSL/TLS",kind:"checkbox"},
    {key:"smtp_host",label:"SMTP Host",required:true},{key:"smtp_port",label:"SMTP Port",required:true},{key:"smtp_secure",label:"SMTP SSL/TLS",kind:"checkbox"},{key:"username",label:"Username",required:true},{key:"password",label:"Password / App Password",kind:"password",required:true},
    {key:"from_address",label:"From Address",required:true},{key:"from_name",label:"From Name"},{key:"reply_to",label:"Reply-To"},{key:"imap_mailbox",label:"Mailbox",required:true},
  ]},
  {type:"WEBSITE",label:"Website Chat",description:"Site içi canlı destek widget’ı",Icon:Globe2,externalKey:"site_id",polling:false,fields:[
    {key:"site_id",label:"Site ID",required:true},{key:"site_name",label:"Site Name",required:true},{key:"allowed_origins",label:"Allowed Origins",kind:"origins",required:true,placeholder:"https://magaza.example"},{key:"widget_secret",label:"Widget Secret (opsiyonel)",kind:"password",optionalSecret:true},
  ]},
];

const defaults:Record<string,Record<string,string>>={
  TRENDYOL:{environment:"production"},EMAIL:{imap_port:"993",imap_secure:"true",smtp_port:"465",smtp_secure:"true",imap_mailbox:"INBOX"},WEBSITE:{allowed_origins:"[]"},
};

export function ChannelSettings({user,onBack}:{user:PanelUser;onBack:()=>void}){
  const[accounts,setAccounts]=useState<Account[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[editing,setEditing]=useState<{provider:Provider;account?:Account}|null>(null),[config,setConfig]=useState<Config>(),[toast,setToast]=useState("");
  const canManage=user.role==="admin"||(user.role!=="readonly"&&user.permissions["customer_hub:manage_channels"]===true);
  const load=useCallback(async()=>{setLoading(true);setError("");try{setAccounts((await api<{items:Account[]}>("/channels")).items);}catch(e){setError(e instanceof Error?e.message:"Kanallar yüklenemedi.");}finally{setLoading(false)}},[]);
  useEffect(()=>{void load()},[load]);
  useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(""),3000);return()=>window.clearTimeout(timer)},[toast]);
  async function open(provider:Provider,account?:Account){setEditing({provider,account});setConfig(undefined);if(account){try{setConfig(await api<Config>(`/channels/${account.id}/config`));}catch(e){setError(e instanceof Error?e.message:"Kanal ayarları yüklenemedi.");setEditing(null);}}}
  return <section className="channel-settings"><header className="settings-header"><button className="mobile-back" onClick={onBack} aria-label="Gelen kutusuna dön"><ChevronLeft/>Gelen kutusu</button><div><p className="eyebrow">AYARLAR</p><h1>Kanallar</h1><span>Bağlantı durumlarını izleyin ve kanal hesaplarını güvenle yapılandırın.</span></div><button className="secondary-button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>Yenile</button></header>
    {!canManage&&<div className="readonly-banner">Salt okunur görünüm · Kanal kimlik bilgilerini değiştirme yetkiniz yok.</div>}
    {error&&<div className="page-error" role="alert">{error}</div>}
    <div className="channel-grid">{providers.map(provider=>{const account=accounts.find(item=>item.channel_type===provider.type);return <ChannelCard key={provider.type} provider={provider} account={account} loading={loading} onOpen={()=>void open(provider,account)} canManage={canManage}/>})}</div>
    {editing&&(!editing.account||config)&&<ChannelEditor provider={editing.provider} account={editing.account} config={config} canManage={canManage} onClose={()=>setEditing(null)} onSaved={async message=>{setToast(message);const updated=(await api<{items:Account[]}>("/channels")).items;setAccounts(updated);const saved=editing.account??updated.find(item=>item.channel_type===editing.provider.type);if(saved&&(editing.account||editing.provider.type==="WEBSITE")){setEditing({provider:editing.provider,account:saved});setConfig(await api<Config>(`/channels/${saved.id}/config`));}else setEditing(null)}}/>}
    {toast&&<div className="toast" role="status"><Check size={16}/>{toast}</div>}
  </section>;
}

function ChannelCard({provider,account,loading,onOpen,canManage}:{provider:Provider;account?:Account;loading:boolean;onOpen:()=>void;canManage:boolean}){const {Icon}=provider;const status=account?.status??"NOT_CONFIGURED";return <article className="channel-card"><div className="channel-card-top"><div className="channel-icon"><Icon size={19}/></div><div><h2>{provider.label}</h2><p>{provider.description}</p></div><Status value={status}/></div><dl><div><dt>Hesap</dt><dd>{account?maskId(account.external_account_id):"—"}</dd></div><div><dt>Son senkron</dt><dd>{account?.last_sync_at?relative(account.last_sync_at):"Henüz yok"}</dd></div><div><dt>Polling</dt><dd>{account?.polling_interval_seconds?`Her ${account.polling_interval_seconds} sn`:provider.polling?"Kapalı":"Webhook"}</dd></div></dl>{account?.last_error&&<p className="channel-error" title="Son kanal hatası">{safeError(account.last_error)}</p>}<button className="secondary-button card-action" disabled={loading||(!account&&!canManage)} onClick={onOpen}><Settings2 size={15}/>{account?(canManage?"Düzenle":"Görüntüle"):"Yapılandır"}</button></article>}

function ChannelEditor({provider,account,config,canManage,onClose,onSaved}:{provider:Provider;account?:Account;config?:Config;canManage:boolean;onClose:()=>void;onSaved:(message:string)=>Promise<void>}){
  const initial=useMemo(()=>({...defaults[provider.type],...(config?.non_secret_config??{}),...(account&&!config?.non_secret_config?.[provider.externalKey]?{[provider.externalKey]:account.external_account_id}:{})}),[provider,config,account]);
  const[name,setName]=useState(config?.name??account?.name??provider.label),[values,setValues]=useState<Record<string,string>>(initial),[polling,setPolling]=useState(String(config?.polling_interval_seconds??(provider.polling?60:""))),[visible,setVisible]=useState<Record<string,boolean>>({}),[fieldErrors,setFieldErrors]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(""),[copied,setCopied]=useState(false);
  useEffect(()=>{if(!config)return;setName(config.name);setValues({...defaults[provider.type],...config.non_secret_config,...(!config.non_secret_config[provider.externalKey]?{[provider.externalKey]:config.external_account_id}:{})});setPolling(String(config.polling_interval_seconds??(provider.polling?60:"")));setVisible({})},[config,provider]);
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose()};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close)},[onClose]);
  const origins=parseOrigins(values.allowed_origins);
  const snippet=provider.type==="WEBSITE"&&config?`<script\n src="${config.app_origin.replace(/\/$/,"")}/widget/dsdst-chat.js"\n data-site-id="${escapeAttribute(values.site_id||config.external_account_id)}"\n defer\n></script>`:"";
  function change(key:string,value:string){setValues(current=>({...current,[key]:value}));setFieldErrors(current=>({...current,[key]:""}))}
  function validate(){const next:Record<string,string>={};if(!name.trim())next.name="Bağlantı adı zorunludur.";for(const field of provider.fields){if(field.required&&field.kind!=="password"&&!String(values[field.key]??"").trim())next[field.key]="Bu alan zorunludur.";if(field.kind==="password"&&field.required&&!values[field.key]&&!config?.secret_state[field.key])next[field.key]="Bu secret henüz kayıtlı değil.";}if(values.graph_api_version&&!/^v\d+\.\d+$/.test(values.graph_api_version))next.graph_api_version="vXX.X biçimini kullanın.";if(provider.type==="EMAIL"){for(const key of ["imap_port","smtp_port"])if(values[key]&&!/^\d+$/.test(values[key]))next[key]="Geçerli bir port girin.";for(const key of ["mailbox_email","from_address","reply_to"])if(values[key]&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[key]))next[key]="Geçerli bir e-posta adresi girin.";}if(provider.type==="WEBSITE"&&(!origins.length||origins.some(origin=>!validOrigin(origin))))next.allowed_origins="En az bir tam HTTPS origin girin (localhost için HTTP kullanılabilir).";if(provider.polling&&(!/^\d+$/.test(polling)||Number(polling)<60||Number(polling)>86400))next.polling="60–86400 arasında bir değer girin.";setFieldErrors(next);return Object.keys(next).length===0;}
  async function submit(event:React.FormEvent){event.preventDefault();if(!canManage||!validate())return;setBusy(true);setError("");try{const credentials={...values};if(provider.type==="WEBSITE")credentials.allowed_origins=JSON.stringify(origins);const external=credentials[provider.externalKey]?.trim();const payload={...(account?{id:account.id}:{}),channel_type:provider.type,name:name.trim(),external_account_id:external,credentials,...(provider.polling?{polling_interval_seconds:Number(polling)||60}:{})};const result=account?await api<{configured:boolean;validation_errors?:string[]}>(`/channels/${account.id}`,{method:"PUT",body:JSON.stringify(payload)}):await api<{configured:boolean;validation_errors?:string[]}>("/channels",{method:"POST",body:JSON.stringify(payload)});if(!result.configured){setError(`Ayarlar kaydedildi ancak bağlantı yapılandırması eksik: ${friendlyValidation(result.validation_errors)}`);return}await onSaved("Kanal ayarları kaydedildi.");}catch(e){setError(e instanceof ApiError?e.message:"Kanal ayarları kaydedilemedi.");}finally{setBusy(false)}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="channel-modal" role="dialog" aria-modal="true" aria-labelledby="channel-editor-title"><header><div><span>{account?"KANAL AYARLARI":"YENİ BAĞLANTI"}</span><h2 id="channel-editor-title">{provider.label}</h2></div><button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={18}/></button></header><form onSubmit={submit} autoComplete="off"><div className="form-grid"><FieldShell label="Bağlantı adı" error={fieldErrors.name} wide><input value={name} onChange={e=>setName(e.target.value)} disabled={!canManage}/></FieldShell>{provider.fields.map(field=><FieldInput key={field.key} field={field} value={values[field.key]??""} stored={Boolean(config?.secret_state[field.key])} disabled={!canManage} visible={Boolean(visible[field.key])} error={fieldErrors[field.key]} origins={origins} onVisible={()=>setVisible(current=>({...current,[field.key]:!current[field.key]}))} onChange={value=>change(field.key,value)}/>)}{provider.polling&&<FieldShell label="Polling interval (saniye)" error={fieldErrors.polling}><input type="number" min={60} max={86400} value={polling} onChange={e=>setPolling(e.target.value)} disabled={!canManage}/><small>Minimum 60 saniye</small></FieldShell>}</div>{snippet&&<section className="snippet"><div><strong>Shopify installation snippet</strong><span>Temaya eklemeden önce site ID ve origin listesini kontrol edin.</span></div><pre>{snippet}</pre><button type="button" className="secondary-button" onClick={async()=>{await navigator.clipboard.writeText(snippet);setCopied(true)}}><Clipboard size={15}/>{copied?"Kopyalandı":"Kopyala"}</button></section>}{error&&<div className="form-banner" role="alert">{error}</div>}<footer><button type="button" className="secondary-button" onClick={onClose}>Kapat</button>{canManage&&<button className="primary-button compact" disabled={busy}>{busy?"Kaydediliyor…":"Kaydet"}</button>}</footer></form></div></div>;
}

function FieldInput({field,value,stored,disabled,visible,error,origins,onVisible,onChange}:{field:Field;value:string;stored:boolean;disabled:boolean;visible:boolean;error?:string;origins:string[];onVisible:()=>void;onChange:(value:string)=>void}){
  if(field.kind==="origins")return <FieldShell label={field.label} error={error} wide>
    <div className="origin-input">
      <div className="origin-chips">{origins.map(origin=><span key={origin}>{origin}<button type="button" aria-label={`${origin} kaldır`} disabled={disabled} onClick={()=>onChange(JSON.stringify(origins.filter(item=>item!==origin)))}><X size={12}/></button></span>)}</div>
      <input placeholder={field.placeholder} disabled={disabled} onKeyDown={event=>{
        if(event.key!=="Enter"&&event.key!==",")return;
        event.preventDefault();
        const raw=event.currentTarget.value.trim().replace(/,$/,"");
        if(raw&&!origins.includes(raw))onChange(JSON.stringify([...origins,raw]));
        event.currentTarget.value="";
      }} onBlur={event=>{
        const raw=event.currentTarget.value.trim();
        if(raw&&!origins.includes(raw)){onChange(JSON.stringify([...origins,raw]));event.currentTarget.value="";}
      }}/>
    </div>
    <small>Origin’i yazıp Enter’a basın. Wildcard kabul edilmez.</small>
  </FieldShell>;
  if(field.kind==="checkbox")return <FieldShell label={field.label} error={error}><label className="switch-field"><input type="checkbox" checked={value==="true"} disabled={disabled} onChange={e=>onChange(String(e.target.checked))}/><span>{value==="true"?"Açık":"Kapalı"}</span></label></FieldShell>;
  if(field.kind==="select")return <FieldShell label={field.label} error={error}><select value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>{field.options?.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></FieldShell>;
  if(field.kind==="password")return <FieldShell label={field.label} error={error}><div className="secret-input"><input type={visible?"text":"password"} value={value} disabled={disabled} placeholder={stored?"••••••••  Kayıtlı":"Yeni secret girin"} onChange={e=>onChange(e.target.value)} autoComplete="new-password"/><button type="button" onClick={onVisible} disabled={disabled} aria-label={visible?"Secret’ı gizle":"Secret’ı göster"}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></div>{stored&&!value&&<small>Boş bırakırsanız kayıtlı değer korunur.</small>}</FieldShell>;
  return <FieldShell label={field.label} error={error}><input value={value} placeholder={field.placeholder} disabled={disabled} onChange={e=>onChange(e.target.value)}/></FieldShell>;
}
function FieldShell({label,error,wide,children}:{label:string;error?:string;wide?:boolean;children:React.ReactNode}){return <label className={`field-shell ${wide?"wide":""}`}><span>{label}</span>{children}{error&&<em>{error}</em>}</label>}
function Status({value}:{value:string}){const labels:Record<string,string>={ACTIVE:"Bağlı",DEGRADED:"Sorun var",ERROR:"Hata",NOT_CONFIGURED:"Yapılandırılmadı"};return <span className={`health health-${value.toLowerCase()}`}>{labels[value]??value}</span>}
function maskId(value:string){if(!value)return"—";if(value.includes("@")){const[name,domain]=value.split("@");return `${name.slice(0,2)}•••@${domain}`}if(value.length<7)return`${value.slice(0,2)}•••`;return`${value.slice(0,4)}••••${value.slice(-3)}`}
function relative(raw:string){const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(raw))/1000));if(seconds<60)return"az önce";if(seconds<3600)return`${Math.floor(seconds/60)} dk önce`;if(seconds<86400)return`${Math.floor(seconds/3600)} sa önce`;return`${Math.floor(seconds/86400)} gün önce`}
function safeError(value:string){return value.replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").slice(0,180)}
function parseOrigins(value?:string){if(!value)return[];try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed.filter(item=>typeof item==="string"):[]}catch{return value.split(",").map(item=>item.trim()).filter(Boolean)}}
function validOrigin(value:string){try{const url=new URL(value);return url.origin===value&&!url.username&&!url.password&&(url.protocol==="https:"||(url.protocol==="http:"&&["localhost","127.0.0.1","::1"].includes(url.hostname)))}catch{return false}}
function escapeAttribute(value:string){return value.replace(/[&"<>]/g,character=>({"&":"&amp;","\"":"&quot;","<":"&lt;",">":"&gt;"}[character]!))}
function friendlyValidation(errors?:string[]){if(!errors?.length)return"zorunlu alanları kontrol edin.";const labels:Record<string,string>={seller_id:"Seller ID",api_key:"API Key",api_secret:"API Secret",access_token:"Access Token",phone_number_id:"Phone Number ID",business_account_id:"WABA ID",graph_api_version:"Graph API Version",page_id:"Page ID",ig_account_id:"Instagram Account ID",imap_host:"IMAP Host",smtp_host:"SMTP Host",username:"Username",password:"Password",allowed_origins:"Allowed Origins",site_id:"Site ID",site_name:"Site Name"};return errors.slice(0,3).map(error=>{const key=Object.keys(labels).find(item=>error.includes(item));return key?`${labels[key]} alanını kontrol edin`:"Alan değerlerini kontrol edin"}).join(" · ")}
