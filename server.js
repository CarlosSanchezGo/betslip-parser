// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ===== Config =====
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

const USE_WEB = (process.env.USE_WEB_ENRICH || "false").toLowerCase() === "true";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE)) {
  throw new Error("Supabase credentials are required");
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

// ===== Helpers =====
function cleanPartido(input) {
  if (!input) return "";
  try { input = decodeURIComponent(String(input)); } catch {}
  return input.replace(/%20/g, " ").replace(/\s+/g, " ").trim();
}

function searchVariantsFor(partido) {
  const base = partido;
  const noInitials = partido.replace(/\b[A-Z]\.\s*/g, "").replace(/\s+/g, " ").trim();
  const swapped = noInitials.includes(" vs ") ? noInitials.split(" vs ").reverse().join(" vs ") : noInitials;
  const set = new Set([base, noInitials, swapped]);
  return Array.from(set);
}

function toISOFromES(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, M, y, h, min] = m.map(Number);
  const local = new Date(y, M - 1, d, h, min, 0, 0);
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
}

function resolveRelativeDate(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const hm = text.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return null;
  const [, h, m] = hm.map(Number);
  const now = new Date();
  let local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (/mañana/.test(lower)) local = new Date(local.getTime() + 24 * 60 * 60 * 1000);
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
}

function cleanBookmaker(name, tipsterId) {
  if (!name) return null;
  const n = ("" + name).toLowerCase().trim();
  if (tipsterId && n.includes(String(tipsterId).toLowerCase())) return null;
  if (n.includes("tipster")) return null;
  return name;
}

async function fetchImageAsDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Error descargando imagen (${resp.status})`);
  const ct = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!/^image\//i.test(ct)) throw new Error(`La URL no devuelve una imagen (${ct})`);
  const buf = await resp.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${ct};base64,${b64}`;
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch {
    const s = text.indexOf("{"); const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) try { return JSON.parse(text.slice(s, e + 1)); } catch {}
    return null;
  }
}

// ===== Nuevo enriquecimiento verificado (reemplaza el anterior) =====
const dedupeSpaces = s => (s || "").replace(/\s+/g, " ").trim();
function normalizeMatchName(raw) {
  if (!raw) return null;
  let s = dedupeSpaces(raw);
  s = s.replace(/\s*[-–—]\s*/g, " vs ");
  return s;
}
const SOURCE_ALLOWLIST = {
  football: ["laliga.com","rfef.es","espn.com","sofascore.com","flashscore.com","livescore.com","uefa.com","premierleague.com","legaseriea.it","bundesliga.com","ligue1.com"],
  tennis: ["atptour.com","wtatennis.com","sofascore.com","flashscore.com","tennis.com","itftennis.com"],
  default: ["espn.com","sofascore.com","flashscore.com","livescore.com"]
};
const pickDomains = sport => SOURCE_ALLOWLIST[(sport||"").toLowerCase()] || SOURCE_ALLOWLIST.default;
const isAllowed = (url, domains) => { try { const u=new URL(url); return domains.some(d=>u.hostname.endsWith(d)); } catch { return false; } };

async function findFixtureVerified(partidoRaw, sport) {
  const partido = normalizeMatchName(partidoRaw);
  const domains = pickDomains(sport);
  const domainsLine = domains.join(", ");

  const prompt = `
Devuelve SOLO JSON con la hora exacta (UTC) y competición del partido.
Partido: "${partido}"
Deporte: "${sport || "unknown"}"
Usa EXCLUSIVAMENTE estos dominios fiables: ${domainsLine}
Formato JSON:
{
  "tournament": "string|null",
  "startIso": "YYYY-MM-DDTHH:mm:ssZ|null",
  "tz": "IANA tz o null",
  "sourceUrl": "url o null"
}`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: prompt,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "ES", timezone: "Europe/Madrid" } }],
      tool_choice: "auto",
      temperature: 0.1,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI web_search ${r.status}`);
  const j = await r.json();

  let text=""; try {
    const out = j.output || [];
    const msg = out.find(o=>o.type==="message") || out[out.length-1] || {};
    text = (msg.content?.find(c=>c.type==="output_text")?.text || "").trim();
  } catch {}
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s<0 || e<=s) return { tournament:null,startIso:null,tz:null,sourceUrl:null };

  const obj = JSON.parse(text.slice(s,e+1));
  if (!obj?.sourceUrl || !obj?.startIso) return { tournament:null,startIso:null,tz:null,sourceUrl:null };
  if (!isAllowed(obj.sourceUrl, domains)) return { tournament:null,startIso:null,tz:null,sourceUrl:null };

  return {
    tournament: obj.tournament || null,
    startIso: obj.startIso || null,
    tz: obj.tz || null,
    sourceUrl: obj.sourceUrl || null,
  };
}

async function enrichViaWeb(partido, horaTexto = null, sport = null) {
  try {
    const verified = await findFixtureVerified(partido, sport);
    return verified;
  } catch (err) {
    console.error("[enrichViaWeb] fallback error:", err.message);
    return null;
  }
}

// ===== Extracción desde imagen =====
async function parseImageWithOpenAI(image_url_or_data_url) {
  const prompt = `Extrae las selecciones del ticket en JSON con campos:
  partido, torneo, fecha_hora_texto, mercado, apuesta, cuota, casa_apuestas.
  Responde SOLO con JSON: {"bookmaker":"...","selections":[...]}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Eres un extractor OCR+IE muy preciso." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image_url_or_data_url } }
        ]
      }
    ]
  });
  const raw = resp.choices?.[0]?.message?.content || "{}";
  return safeParseJson(raw) || {};
}

// ===== Rutas =====
app.get("/health", (_req, res) => res.send("ok"));

app.post("/upload-url", async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "missing filename" });
  const bucket = process.env.SUPABASE_BUCKET || "betslips";
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(filename);
  if (error) return res.status(500).json({ error: error.message });
  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(filename)}`;
  res.json({ uploadUrl: data.signedUrl, publicUrl });
});

// (resto de tu código tal cual)

