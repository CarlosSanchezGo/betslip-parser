// server.js
// Backend: parsea tickets, enriquece torneo/hora (HOY→+3 días) con OpenAI y persiste en Supabase.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ===== App & CORS =====
const app = express();
// CORS abierto (para pruebas). Luego puedes cerrarlo a tu dominio de Lovable.
app.use(cors());
app.options("*", cors());
app.use(express.json({ limit: "25mb" }));

// ===== SDKs =====
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
  // "30/10/2025 19:00" o "30-10-2025 19:00" -> ISO UTC
  if (!text) return null;
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, M, y, h, min] = m.map(Number);
  const local = new Date(y, M - 1, d, h, min, 0, 0);
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
}

function resolveRelativeDate(text) {
  // "Hoy 19:00" / "Mañana 06:30" -> ISO UTC aproximado
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
  if (tipsterId && n.includes(String(tipsterId).toLowerCase())) return null; // no confundir tipster con casa
  if (n.includes("tipster")) return null;
  return name;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
    }
    return null;
  }
}

// Heurística simple para detectar deporte
function detectSport(partido) {
  const p = (partido || "").toLowerCase();
  const hasInitials = /\b[A-Z]\.\s?[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(partido); // "J. Sinner"
  const hasAmpPair = /\/|&/.test(partido); // dobles
  const looksTennis = hasInitials || hasAmpPair || /\bset|games?\b/i.test(partido);
  const looksSoccer = /\bfc\b|\breal\b|\batl[eé]tico\b|united|city|cf\b|inter|madrid|barcelona|arsenal|juventus/i.test(p);
  const looksBasket = /\blakers|warriors|celtics|bucks|euroliga|euroleague|nba/i.test(p);

  if (looksTennis && !looksSoccer && !looksBasket) return "tennis";
  if (looksSoccer && !looksBasket) return "soccer";
  if (looksBasket) return "basketball";
  return "unknown";
}

// ===== OpenAI: enriquecimiento robusto (HOY→+3 días, JSON forzado, reintentos) =====
async function enrichViaOpenAI(partido) {
  if (!partido) return null;

  const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sport = detectSport(partido);

  async function oneTry(alt = 0) {
    const sys = `
Eres un asistente experto en deporte actual (fecha actual: ${todayISO}).
Objetivo: Para el partido dado, responde SOLO si existe un encuentro programado para HOY, MAÑANA o como máximo en los PRÓXIMOS 3 DÍAS.
Exige precisión:
- "tournament": nombre OFICIAL y específico (ej.: "Swiss Indoors Basel (ATP 500)"; nunca "ATP Tour" genérico).
- "tournamentTz": zona horaria IANA del torneo (ej.: "Europe/Zurich", "Europe/Madrid", "America/New_York").
- "startLocal": fecha y hora LOCAL del torneo (ej.: "2025-10-30 19:00"), 24h sin zona.
- "startIso": la misma hora convertida a UTC en ISO (ej.: "2025-10-30T18:00:00Z").
- "confidence": 0..1.
Si NO hay partido en la ventana (hoy → +3 días), devuelve:
{ "tournament": null, "tournamentTz": null, "startLocal": null, "startIso": null, "confidence": 0.1 }.
NO inventes. Si dudas del torneo o la hora exacta, devuelve startIso=null. Devuelve SOLO JSON válido.`.trim();

    const user = `Partido: ${partido}.
Deporte estimado: ${sport}.
${alt === 0
  ? `Busca si está programado para HOY, MAÑANA o los PRÓXIMOS 3 DÍAS. Evita partidos pasados (p. ej., Miami en marzo).`
  : `Confirma SOLO partidos HOY/MAÑANA/+3 días. Si hay ambigüedad, devuelve startIso=null. Da el torneo OFICIAL (no "ATP Tour").`
}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    });

    return resp.choices?.[0]?.message?.content || "{}";
  }

  let raw = await oneTry(0);
  let json = safeParseJson(raw) || {};

  const now = Date.now();
  const max = now + 3 * 24 * 60 * 60 * 1000; // +3 días
  const invalidGenericTournament = (name) =>
    !!(name && /atp tour|wta tour|tournament|league|liga/i.test(name) &&
      !/\b(ATP|WTA|ITF|Challenger|Grand Slam|Masters|1000|500|250|Copa|Swiss Indoors|Basel|Madrid|Roma|Paris|Acapulco|Miami|Shanghai|Doha|Dubai|Barcelona|Monte-Carlo|Euroleague|LaLiga|Premier|Champions|Europa League)\b/i.test(name));

  const fixJson = (j) => {
    if (j?.startIso) {
      const t = Date.parse(j.startIso);
      if (isNaN(t) || t < now - 10 * 60 * 1000 || t > max) j.startIso = null; // tolerancia -10 min
    }
    if (invalidGenericTournament(j?.tournament)) j.tournament = null;
    return j;
  };

  json = fixJson(json);

  if (!json?.tournament || !json?.startIso) {
    raw = await oneTry(1);
    let json2 = safeParseJson(raw) || {};
    json = fixJson(json2);
  }

  return json || null;
}

// ===== OpenAI: extracción desde imagen =====
async function parseImageWithOpenAI(image_url) {
  const prompt =
`Extrae las selecciones del ticket de apuesta en JSON.
Para cada selección devuelve:
- "partido" (ej. "J. Sinner vs F. Cerúndolo" o parejas si es dobles)
- "torneo" (si aparece)
- "fecha_hora_texto" (tal cual aparece: "Hoy 19:00", "Mañana 10:00", "30/10/2025 21:00")
- "mercado" (ej. "Ganador", "Over/Under", etc.)
- "apuesta" (ej. "J. Sinner", "Over 2.5 sets")
- "cuota" (número)
- "casa_apuestas" (si aparece en el ticket)
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
          { type: "image_url", image_url: { url: image_url } }
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

app.post("/upload-url", async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "missing filename" });

  try {
    // nombre del bucket (puedes cambiarlo si quieres)
    const bucket = process.env.SUPABASE_BUCKET || "uploads";

    // genera una URL firmada para subir la imagen directamente desde Lovable
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(filename);

    if (error) throw error;

    // URL pública (para que OpenAI o tu backend pueda leerla)
    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(filename)}`;

    res.json({
      uploadUrl: data.signedUrl,
      publicUrl
    });
  } catch (e) {
    console.error("upload-url error:", e);
    res.status(500).json({ error: e.message });
  }
});


// Procesa imagen, enriquece y guarda
app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) {
      return res.status(400).json({ error: "missing fields: image_url, tipster_id" });
    }

    // 1) Extraer selecciones del ticket
    const parsed = await parseImageWithOpenAI(image_url);

    // 2) Crear betslip
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

    // 3) Para cada selección: normaliza, enriquece y guarda
    const rows = [];
    for (const sel of parsed.selections) {
      let { partido, torneo, fecha_hora_texto, mercado, apuesta, cuota } = sel || {};
      const casa_raw = sel?.casa_apuestas || parsed.bookmaker || null;

      const casa_apuestas = cleanBookmaker(casa_raw, tipster_id);
      let fecha_hora_iso =
        toISOFromES(fecha_hora_texto) || resolveRelativeDate(fecha_hora_texto);

      // Enriquecer (si falta torneo o ISO)
      if ((!torneo || !fecha_hora_iso) && partido) {
        const gpt = await enrichViaOpenAI(partido);
        if (gpt) {
          if (!torneo && gpt.tournament) torneo = gpt.tournament;
          if (!fecha_hora_iso && gpt.startIso) fecha_hora_iso = gpt.startIso;
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

      // Render local en el navegador del usuario
      const visibleFecha = selIns.start_time_utc
        ? new Date(selIns.start_time_utc).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : (selIns.start_time_text || "(pendiente)");

      rows.push({
        "Partido": selIns.match || "",
        "Torneo": selIns.tournament || "",
        "Fecha y hora": visibleFecha,          // local para el usuario
        "Mercado": selIns.market || "",
        "Apuesta": selIns.pick || "",
        "Cuota": selIns.odds,
        "Casa de apuestas": selIns.bookmaker || "",
        _betslip_id: betslip_id,
        _selection_id: selIns.id,
        _fecha_hora_iso: selIns.start_time_utc,     // UTC para persistir/editar
        _fecha_hora_texto: selIns.start_time_text || ""
      });
    }

    return res.json(rows);
  } catch (e) {
    console.error("parse-rows error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Edición de selección (guardar UTC en BBDD)
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

// Debug crudo (ver salida antes de filtros)
app.get("/debug-enrich-raw", async (req, res) => {
  try {
    const partido = req.query.partido || "";
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const todayISO = new Date().toISOString().slice(0, 10);
    const sport = detectSport(partido);

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Eres un experto en deporte (${todayISO}). Da partido si es HOY/MAÑANA/+3 días; si no, startIso=null. JSON estricto.` },
        { role: "user", content: `Partido: ${partido}. Deporte estimado: ${sport}.` }
      ]
    });

    res.json({
      ok: true,
      partido,
      raw: resp.choices?.[0]?.message?.content || ""
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug normal (con filtros aplicados)
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

// Endpoint temporal para probar si tu API tiene acceso a 'web search'
app.get("/try-web", async (req, res) => {
  try {
    const query = req.query.q || "Cagliari vs Sassuolo horario";
    const completion = await openai.responses.create({
      model: "gpt-4o", // usa gpt-4o, es el único con browsing
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      response_format: { type: "json_object" }
    });

    res.json(completion.output || completion);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Start =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));


