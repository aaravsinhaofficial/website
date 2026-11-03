import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Check, ChevronRight, LockKeyhole, Menu, PanelLeft, Search, X } from "lucide-react";
import type { Vault } from "./vault";
import { nextActions } from "./actions";
import { applyChanges, dayInKaty, entry, PORTAL, type Category, type Entry, type StoredEntry } from "./types";
import { Editor } from "./editor";
import { ActionPanel, InventoryPanel, Overview, Sources, Timeline } from "./panels";
import { viewInfo, views, type View } from "./ui";

const navGroups: [string, View[]][] = [["Workspace",["overview","actions"]],["Application",["essays","letters","forms","materials","timeline"]]];
const categoryNames: Record<Category,string> = { essay:"Essay",letter:"Recommendation",response:"Written response",material:"Material",form:"Form section",milestone:"Milestone" };
function hashView() {
  const value = window.location.hash.slice(1);
  return views.includes(value as View) ? value as View : "overview";
}
function SearchDialog({items,open,close}:{items:Entry[];open:(i:Entry)=>void;close:()=>void}) {
  const d=useRef<HTMLDialogElement>(null);
  const [q,setQ]=useState("");
  useEffect(()=>{const n=d.current;n?.showModal();return()=>n?.close();},[]);
  const matching = items.filter(i=>[i.title,i.code,i.description,i.group,i.prompt].join(" ").toLowerCase().includes(q.toLowerCase().trim())).slice(0,35);
  return <dialog className="search-dialog" ref={d} aria-label="Search workspace" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===d.current) {const r=d.current.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}}>
    <div className="search-top"><Search size={19}/><input autoFocus aria-label="Search all workspace items" placeholder="Search essays, people, sections…" value={q} onChange={e=>setQ(e.target.value)}/><button onClick={close} className="icon-button" aria-label="Close search"><X size={17}/></button></div>
    <div className="search-results"><p className="mini-label">{q.trim()?"Matching items":"Workspace items"}</p>{matching.map(i=><button key={i.id} onClick={()=>{close();open(i);}}><span><strong>{i.title}</strong><small>{categoryNames[i.category]} · {i.code} {i.category==="response"?" · "+i.group:""}</small></span><ChevronRight size={15}/></button>)}{!matching.length&&<div className="empty">No items found.</div>}</div>
  </dialog>;
}
export default function Workspace({vault,onLock}:{vault:Vault;onLock:()=>void}) {
  const {inventory,profile,sources}=vault.seed;
  const [view,setView]=useState<View>("overview");
  const [records,setRecords]=useState<StoredEntry[]>(vault.seed.records);
  const [phase,setPhase]=useState<"loading"|"ready"|"failed">("loading");
  const [loadError,setLoadError]=useState("");
  const [drawer,setDrawer]=useState<{item:Entry;isNew:boolean}|null>(null);
  const [searching,setSearching]=useState(false);
  const [mobile,setMobile]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  const [toast,setToast]=useState("");
  const items=useMemo(()=>applyChanges(inventory,records),[inventory,records]);
  const today=dayInKaty(new Date(now));
  const actions=useMemo(()=>nextActions(items,today),[items,today]);
  const requestId=useRef(0);
  const load=useCallback(async()=>{
    const marker=++requestId.current;
    try {
      const updated=await vault.records();
      if(marker===requestId.current){setRecords(updated);setPhase("ready");setLoadError("");}
    } catch(e){ if(marker===requestId.current){setPhase("failed");setLoadError(e instanceof Error?e.message:"Could not load your workspace.");} }
  },[vault]);
  useEffect(()=>{
    load();
    window.addEventListener("focus",load);
    return ()=>window.removeEventListener("focus",load);
  },[load]);
  useEffect(()=>{
    const sync=()=>{setView(hashView());setMobile(false);window.scrollTo(0,0);};
    sync();window.addEventListener("hashchange",sync);
    const timer=window.setInterval(()=>setNow(Date.now()),60000);
    return()=>{window.removeEventListener("hashchange",sync);window.clearInterval(timer);};
  },[]);
  useEffect(()=>{
    function handle(e:KeyboardEvent){
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();if(!drawer)setSearching(s=>!s);}
      else if(e.key==="Escape")setMobile(false);
    }
    window.addEventListener("keydown",handle);return()=>window.removeEventListener("keydown",handle);
  },[drawer]);
  useEffect(()=>{if(toast){const t=window.setTimeout(()=>setToast(""),2800);return()=>clearTimeout(t);}},[toast]);
  function go(v:View) {setMobile(false);setView(v);window.location.hash=v;window.scrollTo(0,0);}
  function open(item:Entry) {setMobile(false);setDrawer({item,isNew:false});}
  function add(cat:Category, group?:string) {
    const randomId = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
    setDrawer({item:entry(cat,"custom-"+randomId,"",{code:"CUSTOM", scope:cat==="milestone"?"Planning":"Required",group:group || (cat==="response"?"Other responses":cat==="milestone"?"Personal target":"")}),isNew:true});}
  async function change(item:Entry, changes:StoredEntry["changes"]|null) {
    if(phase!=="ready")throw new Error("Saved records have not loaded. Retry the connection before saving.");
    try {
      const updated=await vault.change(item,changes);
      requestId.current++;
      setRecords(updated);
      setToast(changes?"Changes saved":"Item deleted");
    } catch(e) { await load(); throw e; }
  }
  const info=viewInfo[view];
  const countFor=(v:View)=> v==="essays" ? items.filter(i=>i.category==="essay").length : v==="letters" ? items.filter(i=>i.category==="letter").length : null;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById("main-content")?.focus();}}>Skip to content</a>
    {mobile&&<button className="nav-backdrop" aria-label="Close navigation" onClick={()=>setMobile(false)}/>}
    <aside className={"sidebar"+(mobile?" shown":"")} aria-label="Workspace navigation">
      <button className="brand" onClick={()=>go("overview")} aria-label="Fieldwork home"><img src="/rsi-dashboard/favicon.svg" alt="" width="34" height="34"/><span>Fieldwork</span></button>
      <div className="project-tile"><div className="project-glyph"><BookOpen size={18}/></div><div><b>RSI 2027</b><small>Application tracker</small></div></div>
      <nav>{navGroups.map(([label,group])=><div className="nav-group" key={label}><div className="nav-title">{label}</div>{group.map(v=>{
        const Icon=viewInfo[v].icon;const n=countFor(v);return <a href={"#"+v} key={v} onClick={e=>{e.preventDefault();go(v);}} aria-current={view===v?"page":undefined} className={"nav-item"+(view===v?" active":"")}><Icon size={17}/><span>{viewInfo[v].nav}</span>{n!==null&&<small>{n}</small>}</a>;
      })}</div>)}</nav>
      <div className="sidebar-bottom"><a className={"nav-item source-nav"+(view==="sources"?" active":"")} aria-current={view==="sources"?"page":undefined} href="#sources" onClick={e=>{e.preventDefault();go("sources");}}><BookOpen size={16}/>Sources & references</a><div className="profile"><span className="avatar">{profile.initials}</span><div><strong>{profile.name}</strong><small>{profile.subtitle}</small></div></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><button className="icon-button mobile-menu" aria-expanded={mobile} aria-label="Open navigation" onClick={()=>setMobile(x=>!x)}><Menu size={20}/></button><div className="crumb"><PanelLeft size={16}/><span>Workspace</span><ChevronRight size={12}/><b>RSI 2027</b></div><div className="top-tools"><button className="search-trigger" aria-label="Search workspace" onClick={()=>setSearching(true)}><Search size={15}/><span>Search</span><kbd>⌘ K</kbd></button><button type="button" className="private-label lock-control" onClick={onLock} aria-label="Lock this browser"><LockKeyhole size={12}/>Lock workspace</button></div></header>
      <main className="main-content" id="main-content" tabIndex={-1}>
        <div className="page-title"><div><div className="eyebrow"><span className="eyebrow-line"/>Research Science Institute</div><h1>{info.title}</h1><p>{info.subtitle}</p></div><a className="portal-button" href={PORTAL} target="_blank" rel="noreferrer">Open application <ArrowUpRight size={15}/></a></div>
        {phase==="failed"&&<div className="load-issue" role="alert">{loadError} <button onClick={load}>Retry</button></div>}
        {view==="overview" ? <Overview items={items} open={open} go={go} actions={actions} today={today} now={now} fields={profile.fields}/> :
          view==="actions" ? <ActionPanel actions={actions} open={open}/> :
          view==="timeline" ? <Timeline items={items} open={open} add={add}/> :
          view==="sources" ? <Sources records={sources}/> : <InventoryPanel key={view} view={view} items={items} open={open} add={add}/>}
        <footer className="page-foot"><span>Fieldwork <i>/</i> RSI 2027</span><span>{phase==="loading"?"Loading saved work…":phase==="ready"?"Private application workspace":"Saved work unavailable"}</span></footer>
      </main>
    </div>
    {drawer&&<Editor key={drawer.item.id} original={drawer.item} isNew={drawer.isNew} childrenEntries={items.filter(i=>i.parent===drawer.item.id)} onClose={()=>setDrawer(null)} onOpen={open} save={change} remove={item=>change(item,null)}/>}
    {searching&&<SearchDialog items={items} open={open} close={()=>setSearching(false)}/>}
    {toast&&<div className="toast" role="status"><Check size={15}/>{toast}</div>}
  </div>;
}
