import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, FilePenLine, Link as LinkIcon, Save, Trash2, X } from "lucide-react";
import { PORTAL, statuses, type Category, type Editable, type Entry, type Scope, type StoredEntry } from "./types";
import { Badge } from "./ui";

type Changes = StoredEntry["changes"];
export type Persist = (item: Entry, changes: Changes) => Promise<void>;
export type Removal = (item: Entry) => Promise<void>;
const singular: Record<Category, string> = { essay: "Personal statement", response: "Written response", letter: "Recommendation", form: "Form section", material: "Supporting material", milestone: "Milestone" };
const editableKeys: (keyof Editable)[] = ["title","status","target","done","prompt","limit","draft","notes","link"];
export function Editor({ original, isNew, childrenEntries, onClose, onOpen, save, remove }: {
  original: Entry; isNew: boolean; childrenEntries: Entry[]; onClose: () => void; onOpen: (item: Entry) => void; save: Persist; remove: Removal;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [item, setItem] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = ["essay","response"].includes(item.category);
  const isCustom = item.id.startsWith("custom-");
  const adjustableScope = !item.promptSource && ["Conditional","Applies to you"].includes(original.scope) && !isCustom && item.category === "response";
  const receipt = item.category === "letter" ? "received" : item.id === "transcript" ? original.checks.at(-1)?.id : undefined;
  const dirty = JSON.stringify(original) !== JSON.stringify(item);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { node?.close(); document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  function close(next: () => void = onClose) {
    if (busy || (dirty && !window.confirm("Discard the unsaved changes to this item?"))) return;
    next();
  }
  function update<K extends keyof Entry>(key: K, value: Entry[K]) {
    setItem(prev => ({ ...prev, [key]: value }));
  }
  function toggle(id: string) {
    setItem(prev => {
      const checked = !prev.done.includes(id);
      const done = checked ? [...prev.done, id] : prev.done.filter(x => x !== id);
      let status = prev.status;
      if (id === receipt) status = checked ? "Final" : "In progress";
      else if (checked && status === "Not started") status = "In progress";
      return { ...prev, done, status };
    });
  }
  function setStatus(status: Entry["status"]) {
    setItem(prev => {
      let done = prev.done;
      if (receipt && status === "Final" && !done.includes(receipt)) done = [...done, receipt];
      if (receipt && status !== "Final") done = done.filter(v => v !== receipt);
      return { ...prev, status, done };
    });
  }
  async function commit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const patch = Object.fromEntries(editableKeys.filter(key => JSON.stringify(original[key]) !== JSON.stringify(item[key])).map(key => [key, item[key]])) as Changes;
      if (item.scope !== original.scope) patch.scope = item.scope;
      if (isNew) { patch.category = item.category; patch.title = item.title; patch.scope = item.scope; patch.group = item.group; }
      if (Object.keys(patch).length) await save(original, patch);
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save. Your edits are still here."); }
    finally { setBusy(false); }
  }
  async function deleteItem() {
    if (!window.confirm("Delete this custom item and its saved notes and draft?")) return;
    setBusy(true); setError("");
    try { await remove(original); onClose(); } catch(e) { setError(e instanceof Error ? e.message : "Could not delete the item."); } finally { setBusy(false); }
  }
  const wordCount = item.draft.trim() ? item.draft.trim().split(/\s+/u).length : 0;
  return <dialog ref={dialog} className="editor-dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); close(); }}
    onClick={e => { if(e.target === dialog.current) {const rect=dialog.current.getBoundingClientRect(); if (e.clientX < rect.left || e.clientY < rect.top || e.clientX > rect.right || e.clientY > rect.bottom) close();} }}>
    <form onSubmit={commit} className="editor-form">
      <header className="editor-strip"><span><FilePenLine size={15}/>{isNew ? "New item" : singular[item.category]}</span><button type="button" className="icon-button" onClick={() => close()} aria-label="Close detail"><X size={19}/></button></header>
      <div className="editor-scroll"><div className="editor-lede"><div className="eyebrow">{item.code || "Workspace"} · {item.scope}</div><h2 id={titleId}>{isNew ? "Add " + singular[item.category].toLowerCase() : original.title}</h2>{item.description && <p>{item.description}</p>}</div>
      {(isCustom || item.category === "letter") && <label className="field">Item name<input required maxLength={180} value={item.title} placeholder="Give this item a name" onChange={e=>update("title",e.target.value)}/></label>}
      <div className="field-pair"><label className="field">Status<span className="select-wrap"><select value={item.status} onChange={e=>setStatus(e.target.value as Entry["status"])}>{statuses.map(s=><option key={s}>{s}</option>)}</select><ChevronDown size={14}/></span></label>
        <label className="field">{item.id==="deadline" ? "Official deadline" : "Working target"}<input type="date" required={item.category==="milestone"} value={item.target} disabled={item.id==="deadline"} onChange={e=>update("target", e.target.value)}/></label></div>
      {(isCustom || adjustableScope) && <label className="field">Requirement<select value={item.scope} onChange={e=>update("scope", e.target.value as Scope)}>{(adjustableScope ? ["Conditional","Applies to you"] : ["Required","Applies to you","Conditional","Optional","Planning"]).map(x=><option key={x}>{x}</option>)}</select></label>}
      {writing && (item.promptSource ? <section className="prompt-box"><div className="prompt-head"><span className="mini-label">Official prompt</span><a href={PORTAL} target="_blank" rel="noreferrer">SlideRoom <ArrowUpRight size={13}/></a></div><div className="prompt-text">{item.prompt}</div><small>{item.promptSource} · {item.code}</small></section>
        : <label className="field">Exact prompt<textarea rows={4} value={item.prompt} placeholder="Paste the exact wording from the live application." onChange={e=>update("prompt",e.target.value)}/></label>)}
      {writing && <section className="writing-box"><label className="field">Your draft<textarea className="draft-input" rows={8} value={item.draft} maxLength={100000} placeholder="Write here or paste your own draft…" onChange={e=>{const draft=e.target.value;setItem(prev=>({...prev,draft,status: draft && prev.status==="Not started" ? "In progress" : prev.status}));}}/></label>
        <div className={"counter" + (item.limit && item.draft.length>item.limit ? " over" : "")}><span>{wordCount.toLocaleString()} words</span><span>{item.draft.length.toLocaleString()}{item.limit ? " / " + item.limit.toLocaleString() : ""} characters</span></div>
        {item.limit && item.draft.length>item.limit && <p className="form-warning">Your draft is {(item.draft.length-item.limit).toLocaleString()} characters over the recorded limit.</p>}
        {!original.limit && <label className="field limit-field">Character limit from the live form<input type="number" min={1} max={100000} placeholder="Unverified" value={item.limit || ""} onChange={e=>update("limit", e.target.value ? Number(e.target.value) : null)}/></label>}
      </section>}
      {item.checks.length>0 && <section className="check-section"><div className="detail-title"><h3>{item.category==="letter" ? "Follow-up checklist" : "Checklist"}</h3><small>{item.done.length} / {item.checks.length}</small></div>
        <div className="check-list">{item.checks.map(c=><label key={c.id} className={"check-label"+(item.done.includes(c.id) ? " checked" : "")}><input type="checkbox" checked={item.done.includes(c.id)} onChange={()=>toggle(c.id)}/><span className="check-drawn">{item.done.includes(c.id) && <Check size={12}/>}</span><span>{c.label}{c.optional && <small> · if needed</small>}</span></label>)}</div>
      </section>}
      {childrenEntries.length>0 && <details className="related"><summary>Linked drafts and records <span>{childrenEntries.length}</span></summary>{childrenEntries.map(c=><button key={c.id} type="button" onClick={()=>close(()=>onOpen(c))}><span>{c.group && c.category==="response" ? c.group+" · " : ""}{c.title}</span><ChevronRight size={14}/></button>)}</details>}
      <label className="field">Notes<textarea rows={4} maxLength={50000} placeholder="Add reminders, questions or details to check…" value={item.notes} onChange={e=>update("notes",e.target.value)}/></label>
      <label className="field">Supporting link<input type="url" placeholder="https://…" value={item.link} onChange={e=>update("link",e.target.value)}/></label>
      {/^https?:\/\//i.test(item.link) && <a className="inline-source" href={item.link} target="_blank" rel="noreferrer"><LinkIcon size={13}/>Open linked material <ArrowUpRight size={13}/></a>}
      {isCustom&&!isNew && <button className="danger-link" type="button" onClick={deleteItem} disabled={busy}><Trash2 size={14}/>Delete this item</button>}
      </div>
      <footer className="editor-footer">{error && <div className="error-message" role="alert">{error}</div>}<div className="footer-row"><span className="save-hint" aria-live="polite">{busy ? "Saving…" : dirty || isNew ? "Unsaved changes" : <Badge status={item.status}/>}</span><button type="button" className="secondary" disabled={busy} onClick={()=>close()}>Close</button><button type="submit" className="primary" disabled={busy || (!dirty && !isNew)}><Save size={14}/>{isNew ? "Add item" : "Save changes"}</button></div></footer>
    </form>
  </dialog>;
}
