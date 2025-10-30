// server.js
// Backend minimalista para: parsear betslips, enriquecer torneo/fecha con OpenAI y persistir en Supabase.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ===== Config =====
const app = express();

// 🔓 CORS temporalmente abierto (para descartar bloqueos)
app.use(cors());                // permite cualquier origen
app.options("*", cors());       // responde a preflights OPTIONS

// 👇 si quieres mantener límite alto de payload (imágenes en JSON)
app.use(express.json({ limit: "25mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

const TZ = process.env.BASE_TZ || "Europe/Madrid";

// ===== Helpers =====
function toISOFromES(text) {
  // Convierte textos tipo "30/10/2025 19:00" o "30-10-2025 19:00" a ISO (UTC)
  if (!text) return null;
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [ , d, M, y, h, min ] = m.map(x => parseInt(x, 10));
  // Construye como hora local de Madrid y pásalo a ISO
  const dt = new Date(Date.UTC(y, M - 1, d, h, min, 0));
  return dt.toISOString();
}

function resolveRelativeDate(text) {
  // "Hoy 19:00" / "Mañana 06:30"
  if (!text) return null;
  const lower = text.toLowerCase();
  const hm = text.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return null;
  const [ , h, m ] = hm;
  const now = new Date();
  const local = new Date(now); // tomamos zona local del server (UTC) y tratamos como aproximación
  if (/mañana/.test(lower)) local.setUTCDate(local.getUTCDate() + 1);
  // si dice "hoy" no sumamos días
  local.setUTCHours(parseInt(h,10), parseInt(m,10), 0, 0);
  return local.toISOString();
}

function cleanBookmaker(name, tipsterId) {
  if (!name) return null;
  const n = (""+name).toLowerCase().trim();
  if (tipsterId && n.includes(String(tipsterId).toLowerCase())) return null; // no confundir tipster con casa
  if (n.includes("tipster")) return null;
  return name;
}

async function enrichViaOpenAI(partido) {
  if (!partido) return null;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `Eres un experto en deporte profesional (fecha actual: ${today}).
Tu tarea es identificar el torneo y la hora (ISO UTC) de un partido dado.
PRIORIDAD:
- Da prioridad a partidos que se juegan hoy, mañana o los próximos días.
- Si ya ocurrió, devuelve startIso=null.
Responde SOLO con JSON válido:
{ "tournament": "...", "startIso": "...", "confidence": número entre 0 y 1 }`
        },
        {
          role: "user",
          content: `Partido: ${partido}.
Busca si está programado para hoy, mañana o próximamente.
Si no hay partidos cercanos, devuelve startIso=null y confidence baja.`
        }
      ]
    });

    const text = completion.choices?.[0]?.message?.content || "{}";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      if (s >= 0 && e > s) json = JSON.parse(text.slice(s, e + 1));
    }
    return json || null;
  } catch (e) {
    console.error("[OpenAI enrich error]", e.message);
    return null;
  }
}

async function parseImageWithOpenAI(image_url) {
  // Pide a OpenAI que devuelva un JSON claro con selections
  const prompt =
`Extrae las selecciones del ticket de apuesta en JSON.
Para cada selección devuelve:
- "partido" (ej. "J. Sinner vs F. Cerúndolo" o con parejas si es dobles)
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
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s>=0 && e>s) json = JSON.parse(raw.slice(s, e+1));
  }
  if (!json || !Array.isArray(json.selections)) {
    return { bookmaker: null, selections: [] };
  }
  return json;
}

// ===== Rutas =====

// Salud
app.get("/health", (_req, res) => res.type("text/plain").send("ok"));

// Subida simulada (si tu front ya sube a Storage, puedes ignorar esto)
app.post("/upload-url", async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "missing filename" });
  // En producción usarías Supabase Storage o S3 para firmar pre-signed URL
  return res.json({
    uploadUrl: `https://files.example/${encodeURIComponent(filename)}`,
    publicUrl: `https://files.example/${encodeURIComponent(filename)}`
  });
});

// Endpoint principal: parsear imagen, enriquecer y devolver filas para Lovable
app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) {
      return res.status(400).json({ error: "missing fields: image_url, tipster_id" });
    }

    // 1) Pedimos a OpenAI que extraiga las selecciones del ticket
    const parsed = await parseImageWithOpenAI(image_url);

    // 2) Creamos betslip
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

    // 3) Por cada selección: normalizar, enriquecer torneo/hora si faltan, y guardar
    const rows = [];
    for (const sel of parsed.selections) {
      let { partido, torneo, fecha_hora_texto, mercado, apuesta, cuota } = sel;
      const casa_raw = sel.casa_apuestas || parsed.bookmaker || null;

      // Normalizaciones
      const casa_apuestas = cleanBookmaker(casa_raw, tipster_id);
      let fecha_hora_iso = toISOFromES(fecha_hora_texto) || resolveRelativeDate(fecha_hora_texto);

      // Enriquecer con OpenAI si faltan torneo o fecha exacta
      if ((!torneo || !fecha_hora_iso) && partido) {
        const gpt = await enrichViaOpenAI(partido);
        if (gpt) {
          if (!torneo && gpt.tournament) torneo = gpt.tournament;
          if (!fecha_hora_iso && gpt.startIso) fecha_hora_iso = gpt.startIso;
        }
      }

      // Guardar selección
      const insertObj = {
        betslip_id,
        match: partido || null,
        tournament: torneo || null,
        start_time_utc: fecha_hora_iso ? new Date(fecha_hora_iso).toISOString() : null,
        start_time_text: fecha_hora_iso ? null : (fecha_hora_texto || null),
        market: mercado || null,
        pick: apuesta || null,
        odds: typeof cuota === "number" ? cuota : (parseFloat(String(cuota).replace(",", ".")) || null),
        bookmaker: casa_apuestas || null
      };

      const { data: selIns, error: selErr } = await supabase
        .from("bet_selections")
        .insert(insertObj)
        .select("id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
        .single();

      if (selErr) throw new Error(`supabase(bet_selections.insert): ${selErr.message}`);

      // Fila para Lovable (visible + metadatos)
      const visibleFecha = selIns.start_time_utc
        ? new Date(selIns.start_time_utc).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })
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

// Edición de una selección (desde Lovable, edición en línea)
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
      patch.odds = isNaN(v) ? null : v;
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

    const value = (stake === null || typeof stake === "undefined")
      ? null
      : (typeof stake === "number" ? stake : parseFloat(String(stake).replace(",", ".")));

    const { data, error } = await supabase
      .from("betslips")
      .update({
        stake: (value === null || isNaN(value)) ? null : value,
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

// Debug: probar enriquecimiento con OpenAI directamente
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
