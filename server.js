// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

// ===== CONFIG =====
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE))
  throw new Error("Supabase credentials required");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

// ===== HELPERS =====
function cleanPartido(input) {
  if (!input) return "";
  try { input = decodeURIComponent(String(input)); } catch {}
  return input.replace(/%20/g, " ").replace(/\s+/g, " ").trim();
}
function searchVariantsFor(partido) {
  const base = partido;
  const noInitials = partido.replace(/\b[A-Z]\.\s*/g, "").replace(/\s+/g, " ").trim();
  const swapped = noInitials.includes(" vs ") ? noInitials.split(" vs ").reverse().join(" vs ") : noInitials;
  return Array.from(new Set([base, noInitials, swapped]));
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
function safeParseJson(text) {
  try { return JSON.parse(text); } catch {
    const s = text.indexOf("{"); const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) try { return JSON.parse(text.slice(s, e + 1)); } catch {}
    return null;
  }
}
async function fetchImageAsDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Error descargando imagen (${resp.status})`);
  const ct = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
  const buf = await resp.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${ct};base64,${b64}`;
}

// ===== SCORE + RESULT HELPERS =====
function parseScoreToAB(scoreStr) {
  if (!scoreStr) return null;
  const m = String(scoreStr).trim().match(/(\d+)\s*[-–:]\s*(\d+)/);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]) };
}
function normName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
function decideStatusBasic({ market, pick, scoreAB, teams }) {
  const mkt = normName(market || "");
  const p = normName(pick || "");
  const left = normName(teams?.left || "");
  const right = normName(teams?.right || "");
  if (!scoreAB) return { status: null, reason: "no score" };

  const is1x2 = /(1x2|1 x 2|ganador|resultado final)/.test(mkt);
  if (!is1x2) return { status: null, reason: "unsupported market" };

  const { a, b } = scoreAB;
  if (a === b) {
    if (/\b(x|empate|draw)\b/.test(p)) return { status: "Ganada", reason: "empate y pick X" };
    return { status: "Perdida", reason: "empate y pick no es X" };
  }
  const winner = a > b ? "left" : "right";
  if (winner === "left") {
    if (left && p.includes(left)) return { status: "Ganada", reason: "ganó el equipo elegido" };
    if (right && p.includes(right)) return { status: "Perdida", reason: "perdió el equipo elegido" };
  } else {
    if (right && p.includes(right)) return { status: "Ganada", reason: "ganó el equipo elegido" };
    if (left && p.includes(left)) return { status: "Perdida", reason: "perdió el equipo elegido" };
  }
  return { status: null, reason: "no pude mapear pick con teams" };
}

// ===== ENRICHMENT SOURCES =====
function pickDomains(sport) {
  if (!sport) return ["sofascore.com", "flashscore.com", "espn.com", "as.com", "marca.com"];
  const s = sport.toLowerCase();
  if (s.includes("tennis")) return ["sofascore.com", "flashscore.com", "atptour.com", "wtatennis.com", "tennis.com"];
  return ["sofascore.com", "flashscore.com", "espn.com", "livescore.com", "laliga.com", "legaseriea.it"];
}

// ===== ENRICH VIA WEB =====
async function enrichViaWeb(partido, horaTexto = null, sport = "football") {
  partido = cleanPartido(partido);
  if (!partido) return null;
  const todayISO = new Date().toISOString().slice(0, 10);
  const variants = searchVariantsFor(partido);
  const domains = pickDomains(sport);

  const prompt = [
    `Encuentra información actualizada (HOY o MAÑANA) sobre el partido "${partido}".`,
    `Fuentes permitidas (priorízalas): ${domains.join(", ")}.`,
    variants.length > 1 ? `También busca con estas variantes: ${variants.join(" | ")}.` : "",
    `Devuelve SOLO JSON con formato:
{
  "tournament": "nombre exacto del torneo",
  "tournamentTz": "IANA timezone",
  "startLocal": "YYYY-MM-DD HH:mm",
  "startIso": "YYYY-MM-DDTHH:mm:ssZ",
  "confidence": 0..1,
  "sources": ["url1","url2"]
}`
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: prompt,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "ES", timezone: "Europe/Madrid" } }],
      tool_choice: "auto",
      temperature: 0.1
    })
  });

  const j = await r.json();
  let textOut = "";
  try {
    const out = j.output || [];
    const msg = out.find(o => o.type === "message") || out[out.length - 1] || {};
    textOut = (msg.content?.find(c => c.type === "output_text")?.text || "").trim();
  } catch {}
  return safeParseJson(textOut) || null;
}

// ===== OCR IMAGE PARSE =====
async function parseImageWithOpenAI(image_url_or_data_url) {
  const prompt = `Extrae las selecciones del ticket en JSON con campos:
  partido, torneo, fecha_hora_texto, mercado, apuesta, cuota, casa_apuestas.
  Responde SOLO con JSON: {"bookmaker":"...","selections":[...]}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Eres un extractor OCR+IE muy preciso." },
      { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image_url_or_data_url } }] }
    ]
  });
  const raw = resp.choices?.[0]?.message?.content || "{}";
  return safeParseJson(raw) || {};
}

// ===== ROUTES =====
app.get("/health", (_req, res) => res.send("ok"));

// 🟢 CONFIRMAR RESULTADO (PRIORITIZA FUENTES Y CALCULA ESTADO)
app.get("/check-result", async (req, res) => {
  try {
    const { partido, pick, market, sport } = req.query;
    if (!partido) return res.status(400).json({ error: "missing partido" });

    const domains = pickDomains(sport);
    const prompt = `
Confirma si el partido "${decodeURIComponent(partido)}" YA TERMINÓ (hoy o ayer) y cuál fue el MARCADOR FINAL.
Debes usar EXCLUSIVAMENTE estas fuentes (priorízalas): ${domains.join(", ")}.

Responde SOLO en JSON:
{
  "finished": true|false,
  "score": "A-B|null",
  "teams": {"left":"local","right":"visitante"},
  "sources": [{"url":"https://...", "score":"A-B|null"}]
}`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: prompt,
        tools: [{ type: "web_search", user_location: { type: "approximate", country: "ES", timezone: "Europe/Madrid" } }],
        tool_choice: "auto",
        temperature: 0.1
      })
    });

    const ai = await response.json();
    let text = "";
    try {
      const out = ai.output || [];
      const msg = out.find(o => o.type === "message") || out[out.length - 1] || {};
      text = (msg.content?.find(c => c.type === "output_text")?.text || "").trim();
    } catch {}
    const parsed = safeParseJson(text) || {};

    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    const okSources = sources.filter(s => {
      try {
        const host = new URL(s.url).hostname;
        return domains.some(d => host.endsWith(d));
      } catch { return false; }
    }).slice(0, 3);

    const scoreStr = parsed.score || (okSources.find(s => s.score)?.score || null);
    const scoreAB = parseScoreToAB(scoreStr);

    let statusBlock = { status: null, reason: "sin market/pick" };
    if (req.query.market && req.query.pick && scoreAB) {
      statusBlock = decideStatusBasic({
        market: req.query.market,
        pick: req.query.pick,
        scoreAB,
        teams: parsed.teams || { left: "", right: "" }
      });
    }

    return res.json({
      finished: parsed.finished || !!scoreStr,
      score: scoreStr,
      status: statusBlock.status,
      reason: statusBlock.reason,
      teams: parsed.teams || { left: "", right: "" },
      sources: okSources
    });
  } catch (err) {
    console.error("❌ /check-result error:", err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
