import { Activity, ArrowRight, ArrowUpRight, CalendarDays, ChevronRight, ClipboardList, Clock3, Compass, FilePenLine, FileText, FlaskConical, FolderOpen, Layers3, LayoutDashboard, ListChecks, NotebookText, UsersRound, type LucideIcon } from "lucide-react";
import { dateLabel, daysBetween, DEADLINE, DEADLINE_INSTANT, progressOf, type Entry, type Status } from "./types";
import type { Action } from "./actions";

export const views = ["overview", "actions", "essays", "letters", "forms", "materials", "timeline", "sources"] as const;
export type View = typeof views[number];
export const viewInfo: Record<View, { title: string; nav: string; icon: LucideIcon; subtitle: string }> = {
  overview: { title: "Application overview", nav: "Overview", icon: LayoutDashboard, subtitle: "Your research, writing and submission plans in one place." },
  actions: { title: "Next actions", nav: "Next actions", icon: ListChecks, subtitle: "Open work ranked by your target dates, urgency and progress." },
  essays: { title: "Essay workspace", nav: "Essays & responses", icon: FilePenLine, subtitle: "Official prompts, your own drafts and the notes behind them." },
  letters: { title: "Recommendations", nav: "Recommendations", icon: UsersRound, subtitle: "Track three letters, from the first request to a confirmed receipt." },
  forms: { title: "Form sections", nav: "Form sections", icon: ClipboardList, subtitle: "The 11 forms in the 2027 U.S. SlideRoom application, in portal order." },
  materials: { title: "Supporting materials", nav: "Supporting materials", icon: FolderOpen, subtitle: "Track school records, score reports, supporting links and payment." },
  timeline: { title: "Application timeline", nav: "Timeline", icon: CalendarDays, subtitle: "Your working targets, coach meeting and official submission deadline." },
  sources: { title: "Sources & references", nav: "Sources & references", icon: NotebookText, subtitle: "The official application and the planning materials used in this workspace." },
};
export function Badge({ status }: { status: Status }) {
  return <span className={"badge state-" + status.toLowerCase().replace(" ", "-")}><i />{status}</span>;
}
export function SectionHeading({ icon: Icon, title, more, onMore }: { icon?: LucideIcon; title: string; more?: string; onMore?: () => void }) {
  return <div className="section-head"><div className="section-title">{Icon && <Icon size={19}/>}<h2>{title}</h2></div>
    {more && <button type="button" className="text-link" onClick={onMore}>{more} <ArrowRight size={14}/></button>}</div>;
}
export function DeadlineBanner({ today, now, onOpen }: { today: string; now: number; onOpen: () => void }) {
  const delta = daysBetween(today, DEADLINE);
  const until = now > Date.parse(DEADLINE_INSTANT) ? "Deadline passed" : delta === 0 ? "Due today" : delta + (delta === 1 ? " day left" : " days left");
  return <button onClick={onOpen} className="deadline-banner" aria-label={"Application deadline, December 11, 2026 at 10:59 p.m. Central. " + until + ". Open timeline."}>
    <div className="banner-copy"><div className="banner-eyebrow"><span className="signal-dot"/> Submission deadline</div>
      <div className="banner-date">December 11, 2026</div>
      <div className="banner-meta"><span className="countdown"><Clock3 size={12}/>{until}</span><span>Friday <b>·</b> 10:59 p.m. CT</span></div>
    </div><div className="banner-art" aria-hidden="true"></div></button>;
}
export function Stats({ items, go }: { items: Entry[]; go: (v: View) => void }) {
  const defs: [Entry["category"], View, string, LucideIcon, string][] = [
    ["essay", "essays", "Essays", FilePenLine, "finalized"], ["letter", "letters", "Letters", UsersRound, "received"],
    ["form", "forms", "Form sections", ClipboardList, "finalized"], ["material", "materials", "Materials", FolderOpen, "ready"],
  ];
  return <div className="stats">{defs.map(([cat, view, title, Icon, word]) => {
    const subset = items.filter(i => i.category === cat && !["Optional","Planning","Conditional"].includes(i.scope));
    const { final, total } = progressOf(subset);
    return <button onClick={() => go(view)} key={cat} className={"stat stat-" + cat}><div className="stat-title"><Icon size={16}/><span>{title}</span><ArrowUpRight className="stat-open" size={12}/></div>
      <div className="stat-number">{final}<span> / {total}</span><small>{word}</small></div><div className="meter"><div style={{ width: (total ? final / total * 100 : 0) + "%" }}/></div>
    </button>;
  })}</div>;
}
export function ActionRow({ action, open }: { action: Action; open: (item: Entry) => void }) {
  return <button type="button" className="action-row" onClick={() => open(action.item)}>
    <span className="action-square" aria-hidden="true"><ChevronRight size={12}/></span>
    <span className="row-body"><strong>{action.title}</strong><span className="row-sub">{action.detail}</span></span>
    <span className={"priority priority-" + action.level.toLowerCase()}><i/>{action.level}</span>
    <span className="row-target">{dateLabel(action.target)}</span></button>;
}
export function ProfilePanel({fields}:{fields:[string,string,string][]}) {
  return <section className="panel profile-panel"><SectionHeading icon={Compass} title="Research focus"/>
    {fields.map(([field,topic,subfield],i)=><div className="focus-row" key={field}><div className="focus-icon">{i===0?<Activity size={19}/>:<Layers3 size={19}/>}</div>
      <div><div className="mini-label">Field {String(i+1).padStart(2,"0")} · {field}</div><strong>{topic}</strong><p>{subfield}</p></div></div>)}
  </section>;
}
export function EntryRow({ item, open, index }: { item: Entry; open: (item: Entry) => void; index?: number }) {
  const Icon = item.category === "material" ? FolderOpen : item.category === "form" ? ClipboardList : item.category === "response" ? FlaskConical : FileText;
  return <button type="button" className="entry-row" onClick={() => open(item)}>
    <span className="item-symbol">{index !== undefined ? String(index + 1).padStart(2, "0") : <Icon size={16}/>}</span>
    <span className="row-body"><strong>{item.title}</strong><span className="row-sub">{[item.code, item.category === "response" ? item.group : item.category === "essay" ? "Personal statement" : item.group, item.scope === "Optional" || item.scope === "Planning" ? item.scope : ""].filter(Boolean).join(" · ")}</span></span>
    <Badge status={item.status}/><ChevronRight className="row-chevron" size={16}/>
  </button>;
}
