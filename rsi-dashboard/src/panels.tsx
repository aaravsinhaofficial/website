import { useState } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronRight, ClipboardList, FilePenLine, FileText, Filter, Flag, FolderOpen, Link as LinkIcon, ListChecks, LockKeyhole, Plus, Search, UsersRound } from "lucide-react";
import { ActionRow, Badge, DeadlineBanner, EntryRow, ProfilePanel, SectionHeading, Stats, type View } from "./ui";
import { overviewActions, type Action } from "./actions";
import { dateLabel, statuses, type Category, type Entry } from "./types";

type PanelProps = { items: Entry[]; open: (i: Entry) => void; go: (v: View) => void };
export function Overview({ items, open, go, actions, today, now, fields }: PanelProps & { actions: Action[]; today: string; now: number; fields:[string,string,string][] }) {
  const essays = items.filter(i=>i.category==="essay");
  const milestones = items.filter(i=>i.category==="milestone" && i.status!=="Final").sort((a,b)=>a.target.localeCompare(b.target));
  const upcoming = milestones.filter(i=>i.target>=today && i.id!=="deadline").slice(0,2);
  const deadline = milestones.find(i=>i.id==="deadline");
  return <div className="content-stack">
    <DeadlineBanner today={today} now={now} onOpen={()=>go("timeline")}/>
    <Stats items={items} go={go}/>
    <div className="dashboard-columns">
      <section className="panel"><SectionHeading icon={ListChecks} title="Next actions" more="View all" onMore={()=>go("actions")}/>
        <div className="next-list">{overviewActions(actions).map(a=><ActionRow key={a.item.id} action={a} open={open}/>)}
        {!actions.length && <div className="empty">All tracked actions are complete.</div>}</div>
        <div className="panel-foot"><span className="small-dot"/>{actions.filter(a=>a.level==="High").length} high-priority actions open</div>
      </section>
      <ProfilePanel fields={fields}/>
    </div>
    <div className="dashboard-columns lower">
      <section className="panel"><SectionHeading icon={FilePenLine} title="Essay workspace" more="Open workspace" onMore={()=>go("essays")}/>
        {essays.slice(0,5).map((i,n)=><EntryRow key={i.id} item={i} index={n} open={open}/>)}</section>
      <section className="panel"><SectionHeading icon={CalendarDays} title="Key dates" more="Timeline" onMore={()=>go("timeline")}/>
        {[...upcoming,...(deadline?[deadline]:[])].map(i=><button type="button" key={i.id} className="date-mini" onClick={()=>open(i)}>
          <DateTile item={i}/><span className="row-body"><strong>{i.title}</strong><span className="row-sub">{i.group}</span></span><ChevronRight size={14}/></button>)}
        {!milestones.length && <div className="empty">All milestones are complete.</div>}
      </section>
    </div>
  </div>;
}
function DateTile({ item }: { item: Entry }) {
  return <span className={"date-tile"+(item.id==="deadline"?" official":"")}><small>{dateLabel(item.target,{month:"short",day:undefined})}</small><b>{item.target ? Number(item.target.slice(8,10)) : "·"}</b></span>;
}
function Filters({ status, onStatus, query, onQuery, placeholder }: { status: string; onStatus: (s: string)=>void; query: string; onQuery: (s: string)=>void; placeholder: string }) {
  return <div className="filters"><label className="search-input"><Search size={16}/><input aria-label={placeholder} value={query} onChange={e=>onQuery(e.target.value)} placeholder={placeholder}/></label>
    <label className="filter-select"><Filter size={14}/><select aria-label="Filter by status" value={status} onChange={e=>onStatus(e.target.value)}><option value="">All statuses</option>{statuses.map(s=><option key={s}>{s}</option>)}</select></label></div>;
}
function NoResults({clear}: {clear:()=>void}) {
  return <div className="empty"><Search size={23}/><strong>No matching items</strong><span>Try another search or clear the filters.</span><button className="text-link" type="button" onClick={clear}>Clear filters <ArrowRight size={13}/></button></div>;
}
function AddButton({click, label="Add item"}: {click:()=>void; label?:string}) {
  return <button type="button" className="secondary add" onClick={click}><Plus size={14}/>{label}</button>;
}
export function InventoryPanel({ view, items, open, add }: Omit<PanelProps,"go"> & { view: "essays"|"letters"|"forms"|"materials"; add:(category:Category, group?:string)=>void }) {
  const [tab,setTab]=useState("Statements");
  const [status,setStatus]=useState("");
  const [query,setQuery]=useState("");
  const [scope,setScope]=useState("All");
  const cat = ({essays:tab==="Statements"?"essay":"response",letters:"letter",forms:"form",materials:"material"} as const)[view];
  const pool=items.filter(i=>i.category===cat && (view!=="essays" || tab==="Statements" || (tab==="Short answers"?i.group==="Short answers":i.group!=="Short answers")));
  const shown=pool.filter(i=>(!status||i.status===status) && (scope==="All" || (scope==="Optional"?["Optional","Planning"].includes(i.scope):["Required","Applies to you"].includes(i.scope))) && [i.title,i.code,i.group,i.description].join(" ").toLowerCase().includes(query.toLowerCase()));
  const groupOf = (i: Entry) => view==="forms" ? i.group || "Additional sections" : view==="essays" && tab==="Research responses" ? i.group || "Other responses" : "";
  const groups=Array.from(new Set(shown.map(groupOf)));
  const clear=()=>{setStatus("");setQuery("");setScope("All");};
  return <div className="content-stack subpage">
    {view==="essays" && <div className="tabbar" role="tablist" aria-label="Writing type">{["Statements","Research responses","Short answers"].map(x=><button role="tab" aria-selected={tab===x} className={tab===x?"active":""} onClick={()=>{setTab(x);clear();}} key={x}>{x}<small>{items.filter(i=>x==="Statements"?i.category==="essay":i.category==="response" && (x==="Short answers"?i.group==="Short answers":i.group!=="Short answers")).length}</small></button>)}</div>}
    {view==="essays"&&tab==="Statements"&&<div className="context-strip"><BookOpen size={20}/><span><strong>Personal statements · Part IIf</strong><small>The five essays use Q1–4 and Q6. Q5 asks how you heard about RSI. Check any unverified character limits in your live form.</small><details className="section-guidance"><summary>Official section guidance</summary><p>To each question below, please provide a considered response with specific details that give evidence of performance, passion, and promise in STEM.</p><p>Should an applicant be accepted, CEE does not guarantee specific research projects, but the information provided here will offer valuable insight into how a student thinks about science or mathematics and what sorts of problems they might enjoy. Please do NOT request overly specific mentorships, mentors or research projects.</p></details></span></div>}
    {view==="essays"&&tab==="Research responses"&&<div className="context-strip"><FileText size={20}/><span><strong>Research experience · Part IIe</strong><small>Writing fields for your two detailed projects and additional context. Remaining project tables and selections are tracked in Form sections.</small></span></div>}
    {view==="letters"&&<div className="context-strip"><UsersRound size={21}/><span><strong>Three letters and one separate transcript request</strong><small>At least one letter should come from a STEM teacher at your current school. Your school official handles the transcript.</small></span><button className="text-link" onClick={()=>open(items.find(i=>i.id==="transcript")!)}>Transcript <ArrowRight size={14}/></button></div>}
    {view==="materials"&&<div className="context-strip"><FolderOpen size={20}/><span><strong>Supporting records</strong><small>Keep a file link, notes and a checklist for each item. Final uploads and payments take place in SlideRoom.</small></span></div>}
    <div className="toolbar"><Filters status={status} onStatus={setStatus} query={query} onQuery={setQuery} placeholder={"Search " + (view==="letters"?"recommenders":view==="essays"?"writing":view==="forms"?"sections":"materials") + "…"}/>
      <AddButton click={()=>add(cat, cat==="response" ? (tab==="Short answers" ? "Short answers" : "Other research") : undefined)} label={view==="essays"?"Add response":view==="forms"?"Add section":"Add item"}/></div>
    {(view==="materials"||view==="essays"&&tab!=="Statements")&&<div className="quick-filters">{["All","Required or applicable","Optional"].map(x=><button key={x} onClick={()=>setScope(x)} aria-pressed={scope===x} className={scope===x?"selected":""}>{x}</button>)}</div>}
    {!shown.length && <div className="panel"><NoResults clear={clear}/></div>}
    {view==="letters" ? <div className="letter-grid">{shown.map(i=><button className="letter-card panel" onClick={()=>open(i)} key={i.id}><div className="letter-card-top"><span className="initials">{i.title.replace(/^(Mrs\.?|Dr\.?|Prof\.?)\s+/,"").split(" ").map(n=>n[0]).slice(0,2).join("")}</span><Badge status={i.status}/></div><h2>{i.title}</h2><p>{i.group || "Recommender"}</p><div className="step-strip">{i.checks.map(c=><span key={c.id} className={i.done.includes(c.id)?"done":""} title={c.label}/>)}</div><div className="card-bottom"><small>{i.done.includes("received")?"Receipt confirmed":i.done.includes("agreed")?"Agreed to write":i.done.includes("asked")?"Request sent":"Outreach pending"}</small><ArrowRight size={16}/></div></button>)}</div>
    : groups.map(group=><section className="panel" key={group}><div className="group-head"><h2>{group || (view==="essays"?(tab==="Statements"?"Personal statements":tab):view==="materials"?"Material checklist":"Form sections")}</h2><small>{shown.filter(i=>groupOf(i)===group).length} items</small></div>{shown.filter(i=>groupOf(i)===group).map((i,n)=><EntryRow key={i.id} item={i} open={open} index={view==="essays"&&tab==="Statements"?n:undefined}/>)}</section>)}
    {view==="forms"&&<div className="scope-note"><ClipboardList size={15}/><span>Use each section’s checklist to review the live fields. Open its linked responses to edit writing separately.</span></div>}
    {view==="letters"&&<section className="panel"><div className="group-head"><h2>Follow-up checklist</h2><small>By recommender</small></div><div className="table-scroll"><table className="check-table"><thead><tr><th>Recommender</th>{["Asked","Agreed","Invited","Packet","Follow-up","Received"].map(l=><th key={l}>{l}</th>)}</tr></thead><tbody>{shown.map(i=><tr key={i.id}><th><button className="text-link" onClick={()=>open(i)}>{i.title}</button></th>{["asked","agreed","invited","packet","followed","received"].map(k=><td key={k}><button className={"table-check"+(i.done.includes(k)?" yes":"")} aria-label={i.title+" · "+k+" · "+(i.done.includes(k)?"checked":"open")+". Edit checklist."} onClick={()=>open(i)}>{i.done.includes(k)?<Check size={13}/>:<span>·</span>}</button></td>)}</tr>)}</tbody></table></div></section>}
  </div>;
}
export function ActionPanel({ actions, open }: { actions:Action[];open:(i:Entry)=>void }) {
  const [level,setLevel]=useState("All");
  const [category,setCategory]=useState("All work");
  const pool=actions.filter(a=>level==="All"||a.level===level);
  const shown=pool.filter(a=>category==="All work"||({essay:"Essays",letter:"Letters",form:"Forms",material:"Materials",response:"Written responses",milestone:"Milestones"}[a.item.category]===category));
  return <div className="content-stack"><div className="action-controls"><div className="quick-filters">{["All","High","Medium","Normal"].map(l=><button key={l} onClick={()=>setLevel(l)} aria-pressed={level===l} className={level===l?"selected":""}>{l} <small>{actions.filter(a=>l==="All"||a.level===l).length}</small></button>)}</div>
    <label className="filter-select"><Filter size={14}/><select aria-label="Filter action category" value={category} onChange={e=>setCategory(e.target.value)}>{["All work","Essays","Letters","Forms","Materials","Written responses","Milestones"].map(c=><option key={c}>{c}</option>)}</select></label></div>
    <div className="panel"><div className="group-head"><h2>Prioritized work</h2><small>{shown.length} open</small></div>{shown.map(a=><ActionRow key={a.item.id} action={a} open={open}/>)}{!shown.length&&<div className="empty">No open actions match these filters.</div>}</div>
  </div>;
}
export function Timeline({items,open,add}:{items:Entry[];open:(i:Entry)=>void;add:(c:Category)=>void}) {
  const [tab,setTab]=useState("Milestones");
  const all=items.filter(i=>i.target&&(tab==="All targets"||i.category==="milestone")).sort((a,b)=>a.target.localeCompare(b.target)||a.title.localeCompare(b.title));
  const months=Array.from(new Set(all.map(i=>i.target.slice(0,7))));
  return <div className="content-stack"><div className="context-strip"><Flag size={21}/><span><strong>Official cutoff · December 11, 2026</strong><small>10:59 p.m. Central in Katy, Texas · 11:59 p.m. Eastern. Other dates below are personal targets or meetings.</small></span></div><div className="toolbar"><div className="quick-filters">{["Milestones","All targets"].map(t=><button key={t} className={tab===t?"selected":""} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</div><AddButton click={()=>add("milestone")} label="Add milestone"/></div>
    {months.map(month=><section className="panel" key={month}><div className="group-head"><h2>{dateLabel(month+"-01",{day:undefined,month:"long",year:"numeric"})}</h2></div>{all.filter(i=>i.target.startsWith(month)).map(i=><button key={i.id} className="timeline-row" onClick={()=>open(i)}><DateTile item={i}/><span className="row-body"><strong>{i.title}</strong><span className="row-sub">{i.category==="milestone"?i.group:"Personal target · " + (i.code || i.category)}</span></span><Badge status={i.status}/><ChevronRight size={15}/></button>)}</section>)}</div>;
}
export function Sources({records}:{records:[string,string,string][]}) {
  return <div className="content-stack"><section className="panel"><SectionHeading icon={BookOpen} title="Reference index"/>{records.map(([t,d,url])=><a className="source-row" href={url} target="_blank" rel="noreferrer" key={url}><LinkIcon size={17}/><span className="row-body"><strong>{t}</strong><span className="row-sub">{d}</span></span><ArrowUpRight size={16}/></a>)}</section><div className="scope-note"><LockKeyhole size={16}/><span>Statuses record the progress you log here. An unchecked step is unconfirmed in this workspace. Verify invitations, uploads and final submission in SlideRoom.</span></div></div>;
}
