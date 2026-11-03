import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Vault, forget, remembered } from "./vault";
import Workspace from "./workspace";

function App() {
  const [vault,setVault]=useState<Vault|null>(null);
  const [key,setKey]=useState("");
  const [persist,setPersist]=useState(true);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    (async()=>{
      const saved=await remembered().catch(()=>undefined);
      if(saved){
        const current=await Vault.open(saved);
        if(active)setVault(current);
      }
    })().catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  async function unlock(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError("");
    try{const fresh=await Vault.open(key,persist);setKey("");setVault(fresh);}
    catch(e){setError(e instanceof Error?e.message:"Could not unlock your workspace.");}
    finally{setBusy(false);}
  }
  async function lock(){
    try{await forget();}catch{setError("This browser could not clear the remembered key. Clear site data to remove access from this device.");}
    setVault(null);
  }
  if(loading)return <main className="vault-loading"><img src="/rsi-dashboard/favicon.svg" alt="" width="34" height="34"/><p>Opening your RSI workspace…</p></main>;
  if(vault)return <Workspace vault={vault} onLock={lock}/>;
  return <main className="vault-shell"><div className="vault-card">
    <div className="vault-brand"><img src="/rsi-dashboard/favicon.svg" width="32" height="32" alt=""/>Fieldwork</div>
    <div className="vault-figure" aria-hidden="true"></div>
    <div className="vault-inner"><div className="eyebrow"><LockKeyhole size={13}/>Private application workspace</div>
      <h1>RSI 2027 dashboard</h1><p>Enter your workspace key to open your application.</p>
      <form onSubmit={unlock}><label className="field">Workspace key<input value={key} onChange={e=>setKey(e.target.value)} required type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Paste your private key"/></label>
        <label className="remember"><input type="checkbox" checked={persist} onChange={e=>setPersist(e.target.checked)}/>Remember this browser</label>
        {error&&<div className="error-message" role="alert">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>{busy?"Unlocking…":"Unlock dashboard"}<ArrowRight size={15}/></button>
      </form>
    </div></div></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
