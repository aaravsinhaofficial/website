import { createHash, timingSafeEqual } from "node:crypto";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

// Hash of the separate API capability derived from the owner's random workspace key.
const verifier = Buffer.from("0664862d681781387b73af4f47013ae9045062f5b7ab117ceb0d31c529efadd3", "hex");
const maxCiphertextLength = 3_500_000;

function authorized(header) {
  const match = typeof header === "string" && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return Boolean(match && timingSafeEqual(createHash("sha256").update(match[1]).digest(), verifier));
}
function validEnvelope(box) {
  return box && box.version === 1 && typeof box.iv === "string" && /^[A-Za-z0-9+/]{16}$/.test(box.iv)
    && typeof box.data === "string" && box.data.length >= 24 && box.data.length <= maxCiphertextLength
    && box.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(box.data);
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!authorized(req.headers.authorization)) return res.status(401).json({error:"Locked"});
  if (!["GET","PUT"].includes(req.method)) {
    res.setHeader("Allow","GET, PUT");
    return res.status(405).json({error:"Method not allowed"});
  }
  const storeId = process.env.RSI_BLOB_STORE_ID;
  if (!storeId) return res.status(503).json({error:"Private storage is not connected."});
  const part = new URL(req.url, "https://aaravsinha.dev").searchParams.get("part") ?? "edits";
  if (!["seed","edits"].includes(part)) return res.status(404).json({error:"Unknown resource"});
  const path = "fieldwork/" + part + "-v1.json";
  const options = {access:"private", storeId};
  const read = () => get(path, {...options, useCache:false});
  try {
    if (req.method === "GET") {
      const result = await read();
      if (!result) return res.status(part === "seed" ? 404 : 200).json({box:null,tag:null});
      const box = await new Response(result.stream).json();
      return res.status(200).json({box,tag:result.blob.etag});
    }
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({error:"Origin mismatch"});
    if (!req.headers["content-type"]?.startsWith("application/json")) return res.status(415).json({error:"Use JSON"});
    if (Number(req.headers["content-length"]) > maxCiphertextLength + 1024) return res.status(413).json({error:"Workspace too large"});
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const tag = payload?.tag;
    const box = payload?.box;
    if (part === "seed" && tag !== null) return res.status(400).json({error:"The migration seed is write-once"});
    if (!validEnvelope(box) || !(tag === null || typeof tag === "string" && /^[a-zA-Z0-9_"-]{1,150}$/.test(tag))) {
      return res.status(400).json({error:"Invalid workspace or version"});
    }
    try {
      const result = await put(path, JSON.stringify(box), {...options, addRandomSuffix:false, cacheControlMaxAge:60,
        contentType:"application/json", allowOverwrite:tag !== null, ...(tag ? {ifMatch:tag} : {})});
      return res.status(200).json({tag:result.etag});
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || (tag === null && await read())) return res.status(409).json({error:"Workspace changed"});
      throw e;
    }
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(400).json({error:"Invalid JSON"});
    console.error("RSI storage request failed",e instanceof Error ? e.name : "StorageError");
    return res.status(503).json({error:"Private storage is temporarily unavailable"});
  }
}
