// server.js
// API: sube imagen a Supabase, parsea betslip con OpenAI, enriquece torneo/hora con web_search y guarda en Supabase.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ===== App & middleware =====
const app = express();

// Log sencillo para depurar orígenes/rutas
app.use((req, _res, next) => {
  console.log("[REQ]", req.method, req.path, "Origin:", req.headers.origin || "-");
  next();
});

app.use(cors({ origin: true }));  // abre mientras depuras; luego limita a [/\.lovable\.app$/, /localhost:\d+$/]
app.options("*", cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

// ===== ENV / Flags =====
const USE_WEB = (process.env.USE_WEB_ENRICH || "false").toLowerCase() === "true";
const USE_OPENAI = (process.env.USE_OPENAI_ENRICH || "false").toLowerCase() === "true";

// ===== SDKs =====
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!process.env.SUPABASE_KEY && !process.env.SUPABASE_SERVICE_ROLE) {
  throw new Error("SUPABASE_KEY or SUPABASE_SERVICE_ROLE is required");
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

// ===== Helpers =====
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
    if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; } }
    return null;
  }
}

function detectSport(partido) {
  const p = (partido || "").toLowerCase();
  const hasInitials = /\b[A-Z]\.\s?[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(partido);
  const hasPair = /\/|&/.test(partido);
  const tennis = hasInitials || hasPair || /\bset|games?\b/i.test(partido);
  const soccer = /\bfc\b|\breal\b|\batl[eé]tico\b|united|city|cf\b|inter|madrid|barcelona|arsenal|juventus|sassuolo|cagliari/i.test(p);
  const basket = /\blakers|warriors|celtics|bucks|euroliga|euroleague|nba/i.test(p);
  if (tennis && !soccer && !basket) return "tennis";
  if (soccer && !basket) return "soccer";
  if (basket) return "basketball";
  return "unknown";
}

// Descarga imagen y la convierte en data URL (evita que OpenAI tenga que salir a Internet)
async function fetchImageAsDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Error descargando imagen (${resp.status})`);
  const ct = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!/^image\//i.test(ct)) throw new Error(`La URL no devuelve una imagen (content-type: ${ct})`);
  const buf = await resp.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${ct};base64,${b64}`;
}

// ===== Enriquecimiento con navegación web (Responses + web_search) =====
async function enrichViaWeb(partido, horaTexto = null) {
  if (!USE_WEB) return null;
  if (!partido) return null;

  const todayISO = new Date().toISOString().slice(0, 10);
  const sport = detectSport(partido);

  const userPrompt = [
    `Partido: ${partido}.`,
    sport !== "unknown" ? `Deporte estimado: ${sport}.` : "",
    horaTexto ? `Hora en el ticket (si es orientativa): ${horaTexto}.` : "",
    `Necesito hora REAL (confirmada en web) y torneo específico.`,
    `Ventana: HOY, MAÑANA o próximos 3 días desde ${todayISO}.`,
    `Devuelve SOLO JSON válido, exacto:`,
    `{
  "tournament": "nombre oficial específico (p.ej. 'Serie A 2025/26' o 'Swiss Indoors Basel (ATP 500)')",
  "tournamentTz": "IANA timezone (p.ej. 'Europe/Rome')",
  "startLocal": "YYYY-MM-DD HH:mm (hora local torneo, 24h, sin zona)",
  "startIso": "UTC en ISO (p.ej. '2025-10-30T17:30:00Z') o null si no hay partido próximo",
  "confidence": 0..1,
  "sources": ["url1","url2"]
}`,
    `No uses horarios por defecto; confirma con 1–3 fuentes fiables.`,
  ].filter(Boolean).join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",            // browsing activo
      input: userPrompt,
      tools: [{
        type: "web_search",
        user_location: { country: "ES", timezone: "Europe/Madrid" },
        search_context_size: "medium"
      }],
      tool_choice: "auto",
      temperature: 0.0
    })
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("[web enrich] HTTP", r.status, j?.error?.message || j);
    return null;
  }

  // Extrae el texto de salida
  let textOut = "";
  try {
    const out = j.output || [];
    const msg = out.find(o => o.type === "message") || out[out.length - 1] || {};
    const contentArr = msg?.content || [];
    const txt = contentArr.find(c => c.type === "output_text")?.text;
    textOut = (txt || "").trim();
  } catch (_) {}

  let data = null;
  try {
    const s = textOut.indexOf("{"); const e = textOut.lastIndexOf("}");
    data = JSON.parse(s >= 0 && e > s ? textOut.slice(s, e + 1) : textOut);
  } catch (e) {
    console.error("[web enrich] parse error:", e.message, "out:", textOut.slice(0, 400));
    return null;
  }

  // Validaciones servidor: ventana temporal y torneo específico
  const now = Date.now();
  const max = now + 3 * 24 * 60 * 60 * 1000;
  const looksGeneric = (name) =>
    !!(name && /atp tour|wta tour|league|liga|tournament/i.test(name) &&
      !/\b(ATP|WTA|ITF|Challenger|Grand Slam|Masters|1000|500|250|Copa|Serie A|LaLiga|Premier|Champions|Europa League|Basel|Madrid|Roma|Paris|Miami|Shanghai)\b/i.test(name));

  if (data?.startIso) {
    const t = Date.parse(data.startIso);
    if (isNaN(t) || t < now - 10 * 60 * 1000 || t > max) data.startIso = null;
  }
  if (!data?.tournament || looksGeneric(data.tournament)) data.tournament = null;

  return data;
}

// ===== Enriquecimiento sin web (fallback opcional) =====
async function enrichViaOpenAI(partido) {
  if (!USE_OPENAI) return null;
  if (!partido) return null;

  const todayISO = new Date().toISOString().slice(0, 10);
  const sport = detectSport(partido);

  // modelo sin browsing: sólo como “mejor esfuerzo”
  const sys = `
Eres un asistente de deporte (${todayISO}). Responde SOLO si hay partido HOY/MAÑANA/+3 días.
JSON:
{"tournament":"...","tournamentTz":"...","startLocal":"YYYY-MM-DD HH:mm","startIso":"...Z or null","confidence":0..1}
Si dudas, startIso=null.`.trim();

  const user = `Partido: ${partido}. Deporte estimado: ${sport}.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  const data = safeParseJson(text) || {};
  const now = Date.now();
  const max = now + 3 * 24 * 60 * 60 * 1000;
  if (data?.startIso) {
    const t = Date.parse(data.startIso);
    if (isNaN(t) || t < now - 10 * 60 * 1000 || t > max) data.startIso = null;
  }
  return data;
}

// ===== Extracción desde imagen (OCR+IE) =====
async function parseImageWithOpenAI(image_url_or_data_url) {
  const prompt =
`Extrae las selecciones del ticket de apuesta en JSON.
Para cada selección devuelve:
- "partido"
- "torneo" (si aparece)
- "fecha_hora_texto" (p.ej. "Hoy 19:00", "Mañana 10:00", "30/10/2025 21:00")
- "mercado"
- "apuesta"
- "cuota" (número)
- "casa_apuestas" (si aparece)
Responde SOLO con JSON: { "bookmaker": "...", "selections": [ ... ] }`;

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
  const json = safeParseJson(raw) || {};
  if (!Array.isArray(json.selections)) return { bookmaker: null, selections: [] };
  return json;
}

// ===== Rutas =====
app.get("/health", (_req, res) => res.type("text/plain").send("ok"));

// Página raíz informativa (evita "Cannot GET /")
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ TipsterChat Betslip Parser API online. Usa /health, /upload-url o /parse-rows.");
});

// Genera URL firmada de subida + URL pública en Supabase Storage
app.post("/upload-url", async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "missing filename" });

  try {
    const bucket = process.env.SUPABASE_BUCKET || "betslips";
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(filename);

    if (error) throw error;

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(filename)}`;

    return res.json({
      uploadUrl: data.signedUrl,   // PUT aquí el binario desde el front
      publicUrl                    // esta URL pasa a /parse-rows
    });
  } catch (e) {
    console.error("upload-url error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Procesa imagen, enriquece y guarda en Supabase
app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) {
      return res.status(400).json({ error: "missing fields: image_url, tipster_id" });
    }

    // 1) Asegurar data URL para OpenAI (si viene URL http(s), la descargamos)
    let imageSource;
    try {
      imageSource = image_url.startsWith("data:")
        ? image_url
        : await fetchImageAsDataUrl(image_url);
    } catch (e) {
      return res.status(400).json({ error: `Error while downloading ${image_url}: ${e.message}` });
    }

    // 2) Extraer selecciones del ticket
    const parsed = await parseImageWithOpenAI(imageSource);

    // 3) Crear betslip
    const { data: slipIns, error: slipErr } = await supabase
      .from("betslips")
      .insert({
        tipster_id,
        source_image_url: image_url,
        parsed_at: new Date().toISOString()
      })
      .select("id")
      .single();
    if (slipErr) throw new Error(`supabase(betslips.insert): ${slipErr.message}`);
    const betslip_id = slipIns.id;

    // 4) Para cada selección: normaliza, enriquece (web → fallback) y guarda
    const rows = [];
    for (const sel of parsed.selections) {
      let { partido, torneo, fecha_hora_texto, mercado, apuesta, cuota } = sel || {};
      const casa_raw = sel?.casa_apuestas || parsed.bookmaker || null;

      const casa_apuestas = cleanBookmaker(casa_raw, tipster_id);
      let fecha_hora_iso =
        toISOFromES(fecha_hora_texto) || resolveRelativeDate(fecha_hora_texto);

      // Enriquecer si falta torneo/hora
      if ((!torneo || !fecha_hora_iso) && partido) {
        // 4.1 Web browsing real
        if (USE_WEB) {
          try {
            const web = await enrichViaWeb(partido, fecha_hora_texto || null);
            if (web) {
              if (!torneo && web.tournament) torneo = web.tournament;
              if (!fecha_hora_iso && web.startIso) fecha_hora_iso = web.startIso;
            }
          } catch (e) {
            console.error("[enrich web] error:", e.message);
          }
        }
        // 4.2 Fallback sin web (si lo activas por ENV)
        if ((!torneo || !fecha_hora_iso) && USE_OPENAI) {
          try {
            const gpt = await enrichViaOpenAI(partido);
            if (gpt) {
              if (!torneo && gpt.tournament) torneo = gpt.tournament;
              if (!fecha_hora_iso && gpt.startIso) fecha_hora_iso = gpt.startIso;
            }
          } catch (_) {}
        }
      }

      const oddsNumber =
        typeof cuota === "number" ? cuota : parseFloat(String(cuota ?? "").replace(",", "."));

      const insertObj = {
        betslip_id,
        match: partido || null,
        tournament: torneo || null,
        start_time_utc: fecha_hora_iso ? new Date(fecha_hora_iso).toISOString() : null,
        start_time_text: fecha_hora_iso ? null : (fecha_hora_texto || null),
        market: mercado || null,
        pick: apuesta || null,
        odds: Number.isFinite(oddsNumber) ? oddsNumber : null,
        bookmaker: casa_apuestas || null
      };

      const { data: selIns, error: selErr } = await supabase
        .from("bet_selections")
        .insert(insertObj)
        .select("id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
        .single();
      if (selErr) throw new Error(`supabase(bet_selections.insert): ${selErr.message}`);

      // Render “local” (el front lo convierte con toLocaleString)
      const visibleFecha = selIns.start_time_utc
        ? new Date(selIns.start_time_utc).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : (selIns.start_time_text || "(pendiente)");

      rows.push({
        "Partido": selIns.match || "",
        "Torneo": selIns.tournament || "",
        "Fecha y hora": visibleFecha,
        "Mercado": selIns.market || "",
        "Apuesta": selIns.pick || "",
        "Cuota": selIns.odds,
        "Casa de apuestas": selIns.bookmaker || "",
        _betslip_id: betslip_id,
        _selection_id: selIns.id,
        _fecha_hora_iso: selIns.start_time_utc,
        _fecha_hora_texto: selIns.start_time_text || ""
      });
    }

    return res.json(rows);
  } catch (e) {
    console.error("parse-rows error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Edición de selección (guardar UTC, etc.)
app.post("/update-selection", async (req, res) => {
  try {
    const { selection_id, torneo, fecha_hora_iso, mercado, apuesta, cuota, casa_apuestas, tipster_id } = req.body || {};
    if (!selection_id) return res.status(400).json({ error: "missing selection_id" });

    const patch = {};
    if (typeof torneo !== "undefined") patch.tournament = torneo || null;
    if (typeof fecha_hora_iso !== "undefined") {
      patch.start_time_utc = fecha_hora_iso ? new Date(fecha_hora_iso).toISOString() : null;
      if (patch.start_time_utc) patch.start_time_text = null;
    }
    if (typeof mercado !== "undefined") patch.market = mercado || null;
    if (typeof apuesta !== "undefined") patch.pick = apuesta || null;
    if (typeof cuota !== "undefined") {
      const v = typeof cuota === "number" ? cuota : parseFloat(String(cuota).replace(",", "."));
      patch.odds = Number.isFinite(v) ? v : null;
    }
    if (typeof casa_apuestas !== "undefined") {
      patch.bookmaker = cleanBookmaker(casa_apuestas, tipster_id);
    }

    const { data, error } = await supabase
      .from("bet_selections")
      .update(patch)
      .eq("id", selection_id)
      .select("id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
      .single();

    if (error) throw new Error(error.message);
    return res.json({ ok: true, selection: data });
  } catch (e) {
    console.error("update-selection error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Guardar stake del betslip
app.post("/update-stake", async (req, res) => {
  try {
    const { betslip_id, stake, currency } = req.body || {};
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });

    const value =
      stake === null || typeof stake === "undefined"
        ? null
        : (typeof stake === "number" ? stake : parseFloat(String(stake).replace(",", ".")));

    const { data, error } = await supabase
      .from("betslips")
      .update({
        stake: value !== null && Number.isFinite(value) ? value : null,
        currency: currency || null
      })
      .eq("id", betslip_id)
      .select("id, stake, currency")
      .single();

    if (error) throw new Error(error.message);
    return res.json({ ok: true, betslip: data });
  } catch (e) {
    console.error("update-stake error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Debug: salud y enriquecimientos
app.get("/debug-enrich-web", async (req, res) => {
  try {
    const partido = req.query.partido || "";
    const hora = req.query.hora || null;
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const found = await enrichViaWeb(partido, hora);
    res.json({ ok: true, partido, found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug-enrich", async (req, res) => {
  try {
    const partido = req.query.partido || "";
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const found = await enrichViaOpenAI(partido);
    return res.json({ ok: true, partido, found });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ===== Start =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));



