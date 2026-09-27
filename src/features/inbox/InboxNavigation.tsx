import {Archive,AtSign,CheckCircle2,Clock3,Inbox,Mail,MessageCircle,MessagesSquare,Settings2,ShoppingBag,Sparkles,UserRoundCheck,UsersRound} from "lucide-react";
import type {ChannelType} from "../../../shared/contracts/domain";

const channelIcon:Record<ChannelType,typeof Mail>={META_INSTAGRAM:AtSign,META_FACEBOOK:MessagesSquare,META_WHATSAPP:MessageCircle,EMAIL:Mail,WEBSITE:MessageCircle,TRENDYOL:ShoppingBag,N11:ShoppingBag,MANUAL_EXTERNAL:Archive};
const sharedChannels:Array<[ChannelType,string]>=[["TRENDYOL","Trendyol"],["META_WHATSAPP","WhatsApp"],["META_INSTAGRAM","Instagram"],["META_FACEBOOK","Facebook"],["WEBSITE","Website"]];
const personalChannels:Array<[ChannelType,string]>=[["EMAIL","E-posta"]];
const otherChannels:Array<[ChannelType,string]>=[["N11","n11"],["MANUAL_EXTERNAL","Manuel"]];

export function InboxNavigation({filter,onFilter,counts,settings,onSettings}:{filter:string;onFilter:(v:string)=>void;counts:{all:number;unread:number};settings:boolean;onSettings:()=>void}){
  const sections=[["all","Tümü",Inbox,counts.all],["unassigned","Atanmamış",UsersRound,null],["mine","Bana Atanan",UserRoundCheck,null],["unread","Okunmamış",Sparkles,counts.unread],["waiting","Bekleyenler",Clock3,null],["resolved","Çözümlenenler",CheckCircle2,null]] as const;
  const channelButton=([id,label]:[ChannelType,string],scope?:"shared"|"personal")=>{const Icon=channelIcon[id];return <button key={id} className={!settings&&filter===id?"active":""} onClick={()=>onFilter(id)}><Icon size={16}/><span>{label}</span>{scope&&<small className={`nav-scope-badge ${scope}`}>{scope==="personal"?"Kişisel":"Şirket ortak"}</small>}</button>};
  return <aside className="inbox-nav"><div className="app-brand"><div className="brand-mark"><MessagesSquare size={20}/></div><div><strong>Customer Hub</strong><span>DSDST</span></div></div><nav>
    <p className="nav-label">GELEN KUTUSU</p>{sections.map(([id,label,Icon,count])=><button key={id} className={!settings&&filter===id?"active":""} onClick={()=>onFilter(id)}><Icon size={17}/><span>{label}</span>{count!==null&&<b>{count}</b>}</button>)}
    <p className="nav-label channel-label">ORTAK KANALLAR</p>{sharedChannels.map(channel=>channelButton(channel,"shared"))}
    <p className="nav-label channel-label">KİŞİSEL</p>{personalChannels.map(channel=>channelButton(channel,"personal"))}
    <p className="nav-label channel-label">DİĞER</p>{otherChannels.map(channel=>channelButton(channel,"shared"))}
    <p className="nav-label channel-label">YÖNETİM</p><button className={settings?"active":""} onClick={onSettings}><Settings2 size={16}/><span>Kanal ayarları</span></button>
  </nav><div className="nav-profile"><div className="status-dot"/><div><strong>Operasyon ekibi</strong><span>Çevrimiçi</span></div></div></aside>;
}
