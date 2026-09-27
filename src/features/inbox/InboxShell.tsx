import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {LogOut,PanelRightClose} from "lucide-react";
import type {ChannelType,InboxConversation,PanelUser} from "../../../shared/contracts/domain";
import {api} from "../../lib/api";
import {InboxNavigation} from "./InboxNavigation";
import {ConversationList} from "../conversations/ConversationList";
import {ConversationThread} from "../conversations/ConversationThread";
import {CustomerSidebar} from "../contacts/CustomerSidebar";
import {ChannelSettings} from "../channels/ChannelSettings";

export type InboxCounts={all:number;unread:number;unassigned:number;mine:number;waiting:number;resolved:number;channels:Partial<Record<ChannelType,number>>;assignees:Record<string,number>};
type Tag={id:string;name:string;color:string};
const emptyCounts:InboxCounts={all:0,unread:0,unassigned:0,mine:0,waiting:0,resolved:0,channels:{},assignees:{}};

export function InboxShell({user,onLogout}:{user:PanelUser;onLogout:()=>void}){
  const[filter,setFilter]=useState("all"),[tag,setTag]=useState(""),[query,setQuery]=useState(""),[items,setItems]=useState<InboxConversation[]>([]),[total,setTotal]=useState(0),[counts,setCounts]=useState<InboxCounts>(emptyCounts),[tags,setTags]=useState<Tag[]>([]),[selected,setSelected]=useState<string>(),[detail,setDetail]=useState<any>(),[loading,setLoading]=useState(true),[showContext,setShowContext]=useState(true),[view,setView]=useState<"inbox"|"settings">("inbox"),[mobilePane,setMobilePane]=useState<"list"|"thread"|"context">("list"),[error,setError]=useState(""),[logoutOpen,setLogoutOpen]=useState(false);
  const logoutButton=useRef<HTMLButtonElement>(null);
  const params=useMemo(()=>{const p=new URLSearchParams();if(query)p.set("q",query);if(tag)p.set("tag",tag);if(filter==="unread")p.set("unread","true");else if(filter==="unassigned")p.set("assigned","unassigned");else if(filter==="mine")p.set("assigned",user.id);else if(filter==="resolved")p.set("status","RESOLVED");else if(filter==="waiting")p.set("status","WAITING_INTERNAL");else if(filter.includes("_")||["EMAIL","WEBSITE","TRENDYOL","N11"].includes(filter))p.set("channel",filter);return p},[filter,tag,query,user.id]);
  const load=useCallback(async()=>{setLoading(true);setError("");try{const[list,nextCounts,tagResult]=await Promise.all([api<{items:InboxConversation[];total:number}>(`/conversations?${params}`),api<InboxCounts>("/conversations/counts"),api<{items:Tag[]}>("/tags")]);setItems(list.items);setTotal(list.total);setCounts(nextCounts);setTags(tagResult.items)}catch(reason){setError(reason instanceof Error?reason.message:"Gelen kutusu yüklenemedi.")}finally{setLoading(false)}},[params]);
  useEffect(()=>{void load()},[load]);
  useEffect(()=>{if(selected)api(`/conversations/${selected}`).then(setDetail).catch(reason=>setError(reason instanceof Error?reason.message:"Konuşma yüklenemedi."));else setDetail(undefined)},[selected,items]);
  const openFilter=(next:string)=>{setFilter(next);setSelected(undefined);setView("inbox");setMobilePane("list")};
  const openSettings=()=>setView("settings");
  const openConversation=async(id:string)=>{setSelected(id);setMobilePane("thread");const item=items.find(candidate=>candidate.id===id);if(!item?.unread_count)return;setItems(current=>current.map(candidate=>candidate.id===id?{...candidate,unread_count:0}:candidate));try{await api(`/conversations/${id}/read-state`,{method:"PUT",body:JSON.stringify({unread:false})});await load()}catch(reason){setError(reason instanceof Error?reason.message:"Okundu bilgisi kaydedilemedi.");await load()}};
  return <main className={`hub-shell ${showContext?"":"context-closed"} view-${view} mobile-${mobilePane}`}>
    <InboxNavigation filter={filter} onFilter={openFilter} counts={counts} settings={view==="settings"} onSettings={openSettings}/>
    {view==="settings"?<ChannelSettings user={user} onBack={()=>setView("inbox")}/>:<>
      <ConversationList items={items} total={total} selected={selected} onSelect={id=>void openConversation(id)} query={query} onQuery={setQuery} loading={loading} onSettings={openSettings} tags={tags} tag={tag} onTag={value=>{setTag(value);setSelected(undefined)}}/>
      <ConversationThread id={selected} user={user} onChanged={load} onBack={()=>setMobilePane("list")} onContext={()=>setMobilePane("context")}/>
      {showContext&&<CustomerSidebar conversation={detail} user={user} onChanged={load} onBack={()=>setMobilePane("thread")}/>} </>}
    <div className="top-actions"><button onClick={()=>setShowContext(value=>!value)} title="Müşteri paneli"><PanelRightClose size={18}/></button><button ref={logoutButton} onClick={()=>setLogoutOpen(true)} title="Çıkış"><LogOut size={18}/></button></div>
    {error&&<div className="toast error" role="alert">{error}<button aria-label="Kapat" onClick={()=>setError("")}>×</button></div>}
    {logoutOpen&&<LogoutDialog onCancel={()=>{setLogoutOpen(false);logoutButton.current?.focus()}} onLogout={async()=>{await api("/auth/logout",{method:"POST"});onLogout()}}/>}
  </main>;
}

function LogoutDialog({onCancel,onLogout}:{onCancel:()=>void;onLogout:()=>Promise<void>}){
  const cancelRef=useRef<HTMLButtonElement>(null),confirmRef=useRef<HTMLButtonElement>(null);const[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{cancelRef.current?.focus()},[]);
  const keyDown=(event:React.KeyboardEvent)=>{if(event.key==="Escape")onCancel();if(event.key==="Tab"){if(event.shiftKey&&document.activeElement===cancelRef.current){event.preventDefault();confirmRef.current?.focus()}else if(!event.shiftKey&&document.activeElement===confirmRef.current){event.preventDefault();cancelRef.current?.focus()}}};
  const confirm=async()=>{setBusy(true);setError("");try{await onLogout()}catch(reason){setError(reason instanceof Error?reason.message:"Çıkış tamamlanamadı.");setBusy(false)}};
  return <div className="modal-backdrop" role="presentation"><div className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-description" onKeyDown={keyDown}><h2 id="logout-title">Çıkış yapmak istiyor musunuz?</h2><p id="logout-description">Customer Hub oturumunuz sonlandırılacak.</p>{error&&<div className="form-banner" role="alert">{error}</div>}<footer><button ref={cancelRef} className="secondary-button" onClick={onCancel} disabled={busy}>Vazgeç</button><button ref={confirmRef} className="danger-button" onClick={()=>void confirm()} disabled={busy}>{busy?"Çıkış yapılıyor…":"Çıkış Yap"}</button></footer></div></div>;
}
