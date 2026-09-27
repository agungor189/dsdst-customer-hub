type ChatMessage = {id:string;direction:"INBOUND"|"OUTBOUND";body_text:string;status:string};

const script=document.currentScript as HTMLScriptElement|null;
if(script){
  const siteId=script.dataset.siteId?.trim();
  if(!siteId)console.error("DSDST Chat: data-site-id is required");
  else void start(script,siteId);
}

async function start(scriptElement:HTMLScriptElement,siteId:string){
  const apiBase=(scriptElement.dataset.apiBase||new URL(scriptElement.src,location.href).origin).replace(/\/$/,"");
  const storagePrefix=`dsdst_chat_${siteId}_`;
  let token=localStorage.getItem(`${storagePrefix}token`)||"";
  let visitorId=localStorage.getItem(`${storagePrefix}visitor`)||undefined;
  const seen=new Set<string>(); const pendingRead=new Set<string>(); let open=false; let pollTimer=0;

  const host=document.createElement("div"); host.id="dsdst-chat-widget";
  const root=host.attachShadow({mode:"open"}); document.body.append(host);
  const style=document.createElement("style");
  if(scriptElement.nonce)style.nonce=scriptElement.nonce;
  style.textContent=`:host{all:initial;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#111}.launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:58px;height:58px;border:0;border-radius:50%;background:#111;color:#fff;box-shadow:0 12px 34px #0003;cursor:pointer;font:700 19px inherit}.panel{position:fixed;right:20px;bottom:90px;z-index:2147483000;width:min(372px,calc(100vw - 28px));height:min(560px,calc(100vh - 120px));background:#fff;border:1px solid #ddd;border-radius:18px;box-shadow:0 20px 60px #0003;display:none;overflow:hidden}.panel.open{display:grid;grid-template-rows:auto 1fr auto}.head{background:#111;color:#fff;padding:17px 18px;display:flex;justify-content:space-between;align-items:center}.head strong{font-size:15px}.close{border:0;background:transparent;color:#fff;font-size:23px;cursor:pointer}.thread{padding:16px;overflow:auto;background:#f7f7f7}.bubble{max-width:82%;padding:10px 12px;margin:0 0 10px;border-radius:13px;background:#fff;line-height:1.4;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.bubble.me{margin-left:auto;background:#111;color:#fff}.identity{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.identity input{min-width:0;border:1px solid #ccc;border-radius:9px;padding:9px;font:13px inherit}.identity input:first-child{grid-column:1/-1}.foot{padding:12px;border-top:1px solid #ddd;background:#fff}.compose{display:flex;gap:8px}.compose textarea{flex:1;resize:none;min-height:42px;max-height:100px;border:1px solid #bbb;border-radius:11px;padding:10px;font:14px inherit}.send{border:0;border-radius:11px;background:#111;color:#fff;padding:0 15px;font:700 13px inherit;cursor:pointer}.send:disabled{opacity:.5}.status{min-height:17px;margin-top:6px;color:#666;font-size:12px}@media(max-width:520px){.launch{right:14px;bottom:14px}.panel{inset:10px 10px 82px;width:auto;height:auto;border-radius:15px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}`;
  root.append(style);
  const button=element("button","launch","Sohbet");button.type="button";button.setAttribute("aria-label","DSDST destek sohbetini aç");button.textContent="DS";
  const panel=element("section","panel");panel.setAttribute("role","dialog");panel.setAttribute("aria-label","DSDST Destek");panel.setAttribute("aria-hidden","true");
  const header=element("header","head");const title=document.createElement("strong");title.textContent="DSDST Destek";const close=element("button","close","Kapat");close.type="button";close.setAttribute("aria-label","Sohbeti kapat");close.textContent="×";header.append(title,close);
  const thread=element("div","thread");thread.setAttribute("aria-live","polite");addBubble(thread,"Merhaba, size nasıl yardımcı olabiliriz?",false);
  const footer=element("footer","foot");const identity=element("div","identity");
  const name=input("Adınız (opsiyonel)","text");const email=input("E-posta (opsiyonel)","email");const phone=input("Telefon (opsiyonel)","tel");identity.append(name,email,phone);
  const compose=element("div","compose");const textarea=document.createElement("textarea");textarea.maxLength=2000;textarea.rows=1;textarea.placeholder="Mesajınızı yazın…";textarea.setAttribute("aria-label","Mesaj");const send=element("button","send","Gönder");send.type="button";compose.append(textarea,send);const status=element("div","status");status.setAttribute("role","status");footer.append(identity,compose,status);panel.append(header,thread,footer);root.append(panel,button);

  const headers=()=>({"Content-Type":"application/json","X-DSDST-Site-ID":siteId,...(token?{Authorization:`Bearer ${token}`}:{})});
  async function createSession(){
    const response=await fetch(`${apiBase}/api/public/chat/session`,{method:"POST",headers:headers(),body:JSON.stringify({site_id:siteId,visitor_id:visitorId,name:name.value||undefined,email:email.value||undefined,phone:phone.value||undefined})});
    if(!response.ok)throw new Error("Sohbet şu anda başlatılamıyor."); const body=await response.json();token=body.session_token;visitorId=body.visitor_id;localStorage.setItem(`${storagePrefix}token`,token);localStorage.setItem(`${storagePrefix}visitor`,visitorId!);
  }
  async function ensureSession(){if(!token)await createSession();}
  async function flushRead(){if(!pendingRead.size||document.visibilityState!=="visible")return;const ids=[...pendingRead];const response=await fetch(`${apiBase}/api/public/chat/read`,{method:"POST",headers:headers(),body:JSON.stringify({message_ids:ids})});if(response.ok)ids.forEach(id=>pendingRead.delete(id));}
  async function loadMessages(){
    if(!open)return;try{await ensureSession();let response=await fetch(`${apiBase}/api/public/chat/messages`,{headers:headers(),cache:"no-store"});if(response.status===401){token="";localStorage.removeItem(`${storagePrefix}token`);await createSession();response=await fetch(`${apiBase}/api/public/chat/messages`,{headers:headers(),cache:"no-store"});}if(!response.ok)throw new Error();const body=await response.json()as{items:ChatMessage[]};for(const message of body.items){if(seen.has(message.id))continue;seen.add(message.id);addBubble(thread,message.body_text,message.direction==="INBOUND");if(message.direction==="OUTBOUND")pendingRead.add(message.id);}await flushRead();status.textContent="";}catch{status.textContent="Bağlantı kurulamadı. Tekrar denenecek.";}finally{window.clearTimeout(pollTimer);pollTimer=window.setTimeout(loadMessages,2500);}
  }
  async function submit(){const body=textarea.value.trim();if(!body)return;send.disabled=true;status.textContent="Gönderiliyor…";try{await ensureSession();const response=await fetch(`${apiBase}/api/public/chat/messages`,{method:"POST",headers:headers(),body:JSON.stringify({client_message_id:crypto.randomUUID(),body,context:pageContext(scriptElement)})});if(!response.ok)throw new Error();const acknowledgement=await response.json()as{message_id:string};seen.add(acknowledgement.message_id);addBubble(thread,body,true);textarea.value="";identity.hidden=true;status.textContent="Mesajınız alındı.";void loadMessages();}catch{status.textContent="Mesaj gönderilemedi. Lütfen tekrar deneyin.";}finally{send.disabled=false;}}
  button.addEventListener("click",()=>{open=!open;panel.classList.toggle("open",open);panel.setAttribute("aria-hidden",String(!open));button.setAttribute("aria-label",open?"DSDST destek sohbetini kapat":"DSDST destek sohbetini aç");if(open){textarea.focus();void loadMessages();}else window.clearTimeout(pollTimer);});close.addEventListener("click",()=>button.click());send.addEventListener("click",submit);textarea.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void submit();}});
  document.addEventListener("visibilitychange",()=>{if(open&&document.visibilityState==="visible")void flushRead();});
}

function element<K extends keyof HTMLElementTagNameMap>(tag:K,className:string,label?:string){const value=document.createElement(tag);value.className=className;if(label)value.setAttribute("aria-label",label);return value;}
function input(placeholder:string,type:string){const value=document.createElement("input");value.placeholder=placeholder;value.type=type;value.maxLength=type==="email"?254:120;return value;}
function addBubble(parent:HTMLElement,text:string,mine:boolean){const bubble=element("div",`bubble${mine?" me":""}`);bubble.textContent=text;parent.append(bubble);parent.scrollTop=parent.scrollHeight;}
function safeLocation(value:string){try{const url=new URL(value,location.href);return `${url.origin}${url.pathname}`.slice(0,2000);}catch{return undefined;}}
function pageContext(scriptElement:HTMLScriptElement){return{current_url:safeLocation(location.href),page_title:document.title.slice(0,300),referrer:document.referrer?safeLocation(document.referrer):undefined,product_id:scriptElement.dataset.productId,product_handle:scriptElement.dataset.productHandle,product_title:scriptElement.dataset.productTitle,variant_id:scriptElement.dataset.variantId};}
