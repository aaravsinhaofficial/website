import type { Entry, StoredEntry } from "./types";

export type Seed = {
  schema: number;
  profile: {name: string; initials: string; subtitle: string; fields: [string,string,string][]};
  sources: [string,string,string][];
  inventory: Entry[];
  records: StoredEntry[];
};
type Box = {version: 1; iv: string; data: string};
type Access = {key: CryptoKey; token: string};
type Unlock = {wrappingKey: CryptoKey; token: string};
type CloudState = {box: Box | null; tag: string | null};
const enc = new TextEncoder();
const dec = new TextDecoder();
const api = "/api/rsi-state";
const recordContext = "rsi-workspace/edits/v1";
function from64(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/")), c=>c.charCodeAt(0));
}
function to64(bytes: Uint8Array) {
  let result = "";
  for(let i=0;i<bytes.length;i+=16384)result+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(result);
}
async function unlockFromPin(input: string): Promise<Unlock> {
  const pin = input.trim();
  if (!/^[0-9]{8}$/.test(pin)) throw new Error("Enter your 8-digit workspace key.");
  const material = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  // The first half wraps the existing data key. Only the second half is sent to the server.
  const bits = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt: from64("HkCN6Islq94MQwS++jm84g=="), iterations: 600_000,
  }, material, 512));
  try {
    const wrappingKey = await crypto.subtle.importKey("raw", bits.subarray(0, 32), "AES-GCM", false, ["unwrapKey"]);
    const token = to64(bits.subarray(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return {wrappingKey, token};
  } finally { bits.fill(0); }
}
async function decrypt<T>(key: CryptoKey, box: Box, context: string): Promise<T> {
  if(box.version!==1)throw new Error("This workspace format is unsupported.");
  const result=await crypto.subtle.decrypt({name:"AES-GCM",iv:from64(box.iv),additionalData:enc.encode(context)},key,from64(box.data));
  return JSON.parse(dec.decode(result)) as T;
}
async function encrypt(key:CryptoKey, value:unknown, context:string): Promise<Box> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:enc.encode(context)},key,enc.encode(JSON.stringify(value)));
  return {version:1,iv:to64(iv),data:to64(new Uint8Array(bytes))};
}
async function deviceDB(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open("rsi-fieldwork-unlock",1);
    req.onupgradeneeded=()=>req.result.createObjectStore("access");
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
export async function remembered(): Promise<Access | undefined> {
  const db=await deviceDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("access","readonly");
    const req=tx.objectStore("access").get("owner");
    tx.oncomplete=()=>{db.close();resolve(req.result);};
    tx.onabort=()=>{db.close();reject(tx.error);};
  });
}
async function remember(access:Access|null) {
  const db=await deviceDB();
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction("access","readwrite");
    const store=tx.objectStore("access");
    if(access)store.put(access,"owner");else store.delete("owner");
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onabort=()=>{db.close();reject(tx.error);};
  });
}
export async function forget() { await remember(null); }
export class Vault {
  constructor(readonly seed: Seed, private access: Access) {}
  static async open(input:string|Access, persist=false) {
    const login = typeof input === "string" ? await unlockFromPin(input) : input;
    const response=await fetch(api+"?part=seed",{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",headers:{Authorization:"Bearer "+login.token}});
    if(response.status===401){
      if (typeof input !== "string") {
        await forget().catch(() => {});
        throw new Error("Enter your current workspace key to unlock this browser.");
      }
      throw new Error("That key did not unlock this workspace.");
    }
    if(!response.ok)throw new Error("The private workspace could not be loaded. Please try again.");
    const {box,wrappedKey}=await response.json() as {box:Box;wrappedKey:Box};
    let access:Access;
    let seed:Seed;
    try {
      if ("wrappingKey" in login) {
        const key = await crypto.subtle.unwrapKey("raw", from64(wrappedKey.data), login.wrappingKey, {
          name: "AES-GCM", iv: from64(wrappedKey.iv), additionalData: enc.encode("rsi-workspace/data-key/v2"),
        }, "AES-GCM", false, ["encrypt", "decrypt"]);
        access = {key, token: login.token};
      } else { access = login; }
      seed=await decrypt<Seed>(access.key,box,"rsi-workspace/seed/v1");
    }
    catch { throw new Error("That key did not unlock this workspace."); }
    if(seed.schema!==1||!Array.isArray(seed.inventory)||!Array.isArray(seed.records))throw new Error("This workspace could not be read.");
    if(persist){try{await remember(access);}catch{ /* Private browsing can disable remembering a key. */ }}
    return new Vault(seed,access);
  }
  private async request(method:"GET"|"PUT", body?:unknown) {
    return fetch(api,{method,cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",
      headers:{Authorization:"Bearer "+this.access.token,...(body?{"Content-Type":"application/json"}:{})},
      body:body?JSON.stringify(body):undefined});
  }
  private async snapshot() {
    const response=await this.request("GET");
    if(!response.ok)throw new Error("Could not reach your private storage. Please retry.");
    const state=await response.json() as CloudState;
    if(!("box" in state)||!("tag" in state))throw new Error("The server returned an invalid workspace.");
    const records=state.box?await decrypt<StoredEntry[]>(this.access.key,state.box,recordContext):this.seed.records;
    if(!Array.isArray(records))throw new Error("Could not read the saved records.");
    return {records, tag:state.tag};
  }
  async records() { return (await this.snapshot()).records; }
  async change(item:Entry, delta:StoredEntry["changes"]|null):Promise<StoredEntry[]> {
    for(let attempt=0;attempt<3;attempt++){
      const {records,tag}=await this.snapshot();
      const previous=records.find(r=>r.id===item.id);
      if((previous?.revision??0)!==item.revision)throw new Error("This item changed in another session. Copy your text, close the editor and reopen it to review the latest version.");
      if(delta===null&&!item.id.startsWith("custom-"))throw new Error("Only custom items can be deleted.");
      const next=records.filter(r=>r.id!==item.id);
      if(delta!==null)next.push({id:item.id,revision:item.revision+1,changes:{...previous?.changes,...delta}});
      const box=await encrypt(this.access.key,next,recordContext);
      const response=await this.request("PUT",{tag,box});
      if(response.ok)return next;
      if(response.status===409)continue;
      if(response.status===413)throw new Error("The saved workspace is too large. Keep large attachments in supporting links.");
      throw new Error("Your changes could not be saved. Your text is still in the editor. Please retry.");
    }
    throw new Error("Another device is saving. Please retry in a moment.");
  }
}
