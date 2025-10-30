// server.js
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { z } from "zod";

// ============== APP & MIDDLEWARE ==============
const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

// ============== ENV ==============
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  SUPABASE_BUCKET = "betslips",
  BASE_TZ = "Europe/Madrid",
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============== HELPERS (bookmaker, fechas relativas) ==============
const KNOWN_BOOKMAKERS = [
  "bet365","betfair","pinnacle","william hill","betway","betsson","codere",
  "sportium","marathonbet","bwin","1xbet","888sport","leovegas","caliente",
  "playdoit","foliatti","daznbet","versus","kirolbet","retabet","betcris"
];

const norm = s => (s || "").toString().trim().toLowerCase();

function cleanBookmaker(rawBookmaker, tipsterId) {
  const b = norm(rawBookmaker);
  const t = norm(tipsterId);
  if (!b) return null;
  if (b.includes(t) || t.includes(b)) return null;
  const cleaned = b
    .replace(/apuesta.*en\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
  if (!cleaned) return null;
  const isKnown = KNOWN_BOOKMAKERS.some(k => cleaned.includes(k));
  return isKnown ? cleaned : null;
}

// Convierte "Hoy 19:00" o "Mañana 06:30" a ISO en UTC usando BASE_TZ
function resolveRelativeDate(text, now = new Date()) {
  if (!text) return null;
  const m = text.toLowerCase().match(/(hoy|mañana)\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, rel, hh, mm] = m;
  const nowTz = new Date(now.toLocaleString("en-US", { timeZone: BASE_TZ }));
  const d = new Date(nowTz);
  if (rel === "mañana") d.setDate(d.getDate() + 1);
  d.setHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0);
  const iso = new Date(
    Date.parse(d.toLocaleString("en-US", { timeZone: "UTC" }))
  ).toISOString();
  return iso;
}

// ===== Debug =====
const ENRICH_DEBUG = process.env.ENRICH_DEBUG === "true";
const logD = (...args) => ENRICH_DEBUG && console.log("[ENRICH]", ...args);

// ===== Timeout fetch =====
async function fetchJsonWithTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ===== Normalización de nombres para mejorar “matches” =====
// Quita iniciales tipo "J." y retorna apellidos/nombres fuertes
function strongTokens(s) {
  if (!s) return [];
  const cleaned = s
    .replace(/\./g, "")        // “J. Sinner” -> “J Sinner”
    .replace(/\s{2,}/g, " ")
    .trim();
  // tokens sin iniciales sueltas
  return cleaned
    .split(/\s+/)
    .filter(tok => tok.length > 1); // quita “J”
}

// De "J. Sinner vs F. Cerúndolo" -> ["Sinner","Cerúndolo"]
function extractKeySurnames(matchText) {
  const base = (matchText || "").replace(/[-–—]/g, " ");
  // separamos por "vs", "/", ","
  const parts = base.split(/vs|\/|,|\(|\)|\s{2,}/i)
    .map(s => s.trim())
    .filter(Boolean);
  // para cada parte, coge el último token “fuerte” (suele ser apellido)
  const keys = parts.map(p => {
    const toks = strongTokens(p);
    return toks.length ? toks[toks.length - 1] : p;
  });
  // dedup
  return Array.from(new Set(keys)).slice(0, 4);
}

// Todas las variaciones posibles que vamos a probar en búsqueda
function nameVariants(matchText) {
  const baseNames = extractKeySurnames(matchText); // apellidos fuertes
  const rawParts = (matchText || "")
    .replace(/[-–—]/g, " ")
    .split(/vs|\/|,|\(|\)|\s{2,}/i)
    .map(s => s.trim())
    .filter(Boolean);

  const initialsRemoved = Array.from(new Set(
    rawParts.map(p => strongTokens(p).join(" "))
  )).filter(Boolean);

  // Mezcla ambas listas
  const all = Array.from(new Set([...baseNames, ...initialsRemoved])).slice(0, 6);
  return all;
}

// ============== ENRIQUECIMIENTO MULTI-DEPORTE (SofaScore) ==============
const matchCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function parseNamesFromMatch(matchText) {
  const txt = (matchText || "").replace(/[-–—]/g, " ");
  const parts = txt
    .split(/vs|\/|,|\(|\)|\s{2,}/i)
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 4);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.json();
}

/**
 * Enriquecedor genérico: intenta encontrar torneo y hora exacta
 * en SofaScore para cualquier deporte soportado.
 * Devuelve { tournament, startIso } o null.
 */
async function enrichGenericSelection(selection) {
  const base = "https://api.sofascore.com/api/v1";
  const variants = nameVariants(selection.partido);
  if (!variants.length) return null;

  const cacheKey = `generic:${variants.join("|")}`;
  const cached = matchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    logD("cache hit", cacheKey, cached.data);
    return cached.data;
  }

  logD("search variants", variants);

  let candidates = [];
  // 1) Buscar por varias variantes hasta encontrar candidatos
  for (const name of variants) {
    try {
      const q = encodeURIComponent(name);
      const url = `${base}/search/all?q=${q}`;
      const search = await fetchJsonWithTimeout(url, 6000);
      // recolecta players & teams de todas las secciones
      for (const section of Object.values(search || {})) {
        if (!section || typeof section !== "object") continue;
        if (Array.isArray(section.players)) {
          section.players.slice(0, 3).forEach(p => candidates.push({ type: "player", id: p.id, n: name }));
        }
        if (Array.isArray(section.teams)) {
          section.teams.slice(0, 3).forEach(t => candidates.push({ type: "team", id: t.id, n: name }));
        }
      }
      if (candidates.length) {
        logD("found candidates for", name, candidates.slice(0, 5));
        break;
      }
    } catch (e) {
      logD("search fail", name, String(e));
    }
  }

  // Si no hay candidatos aún, intento “todo a pelo” con la primera palabra
  if (!candidates.length && variants[0]) {
    logD("no candidates; giving up");
    return null;
  }

  // 2) Probar próximos eventos de esos candidatos
  for (const c of candidates.slice(0, 10)) {
    try {
      const url =
        c.type === "team"
          ? `${base}/team/${c.id}/events/next/0`
          : `${base}/player/${c.id}/events/next/0`;
      const data = await fetchJsonWithTimeout(url, 6000);
      const events = Array.isArray(data?.events) ? data.events : [];
      for (const ev of events) {
        const home = (ev?.homeTeam?.name || "").toLowerCase();
        const away = (ev?.awayTeam?.name || "").toLowerCase();
        // cuenta cuántas variantes “casan” con home/away
        const hits = variants.filter(v => {
          const s = v.toLowerCase();
          return home.includes(s) || away.includes(s);
        }).length;

        if (hits >= Math.min(2, variants.length)) {
          const tournament = ev?.tournament?.name || ev?.season?.name || "";
          const startIso = ev?.startTimestamp
            ? new Date(ev.startTimestamp * 1000).toISOString()
            : null;
          const result = { tournament, startIso };
          matchCache.set(cacheKey, { ts: Date.now(), data: result });
          logD("match!", { variants, tournament, startIso, eventId: ev.id });
          return result;
        }
      }
    } catch (e) {
      logD("events fail", c, String(e));
    }
  }

  logD("no match for", variants);
  return null;
}


// ============== VALIDACIÓN (Zod) ==============
const SelectionSchema = z.object({
  match: z.string(),
  tournament: z.string().nullable().optional(),
  start_time_utc: z.string().datetime().nullable().optional(),
  start_time_text: z.string().nullable().optional(),
  market: z.string(),
  pick: z.string(),
  odds: z.coerce.number(),
  bookmaker: z.string().nullable().optional()
});

const BetSlipSchema = z.object({
  bookmaker: z.string().nullable().optional(),
  bet_type: z.enum(["single","acca","system","other"]).default("acca"),
  selections: z.array(SelectionSchema).min(1),
  stake: z.coerce.number().nullable().optional(),
  total_odds: z.coerce.number().nullable().optional(),
  potential_returns: z.coerce.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  tipster_id: z.string(),
  source_image_url: z.string().url(),
  confidence: z.coerce.number().nullable().optional()
});

// ============== ENDPOINTS BÁSICOS ==============

// 1) URL firmada para subir imagen (Supabase Storage)
app.post("/upload-url", async (req, res) => {
  try {
    const { tipster_id, filename } = req.body || {};
    if (!tipster_id || !filename) return res.status(400).json({ error: "missing fields" });

    const key = `${tipster_id}/${Date.now()}-${filename}`;
    const { data, error } = await supabase
      .storage.from(SUPABASE_BUCKET)
      .createSignedUploadUrl(key);

    if (error) return res.status(500).json({ error: error.message });

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${key}`;
    res.json({ uploadUrl: data.signedUrl, publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 2) Parsear imagen con OpenAI Vision → JSON estructurado (y guardar en DB)
app.post("/parse", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) return res.status(400).json({ error: "missing fields" });

    const system = `Eres un extractor de tickets de apuestas. Devuelve SOLO JSON válido:
{
  "bookmaker": string|null,
  "bet_type": "single"|"acca"|"system"|"other",
  "selections": [{
    "match": string,
    "tournament": string|null,
    "start_time_utc": string|null,
    "start_time_text": string|null,
    "market": string,
    "pick": string,
    "odds": number,
    "bookmaker": string|null
  }],
  "stake": number|null,
  "total_odds": number|null,
  "potential_returns": number|null,
  "currency": string|null
}
Reglas:
- No inventes fechas: si ves "Hoy 19:00" o "Mañana 06:30", usa start_time_utc = null y start_time_text con el literal.
- Convierte comas decimales a punto.
- Si aparece la casa de apuestas, inclúyela; si no, déjala null.`;

    const user = `Extrae los datos del pantallazo y responde SOLO con JSON.`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            { type: "image_url", image_url: { url: image_url } }
          ]
        }
      ]
    });

    const raw = resp.choices?.[0]?.message?.content;
    if (!raw) return res.status(500).json({ error: "no response from model" });

    const parsed = JSON.parse(raw);
    parsed.tipster_id = tipster_id;
    parsed.source_image_url = image_url;

    const valid = BetSlipSchema.parse(parsed);

    // Guardar cabecera
    const { data: slip, error: e1 } = await supabase
      .from("betslips")
      .insert({
        tipster_id,
        bookmaker: valid.bookmaker ?? null,
        bet_type: valid.bet_type,
        stake: valid.stake,
        currency: valid.currency,
        total_odds: valid.total_odds,
        potential_returns: valid.potential_returns,
        source_image_url: valid.source_image_url,
        parsed_at: new Date(),
        confidence: valid.confidence ?? 0.9,
        status: "parsed"
      })
      .select()
      .single();
    if (e1) return res.status(500).json({ error: e1.message });

    // Guardar selecciones y recuperar IDs
    const insertRows = valid.selections.map(s => ({
      betslip_id: slip.id,
      match: s.match,
      tournament: s.tournament ?? null,
      start_time_utc: s.start_time_utc ? new Date(s.start_time_utc) : null,
      start_time_text: s.start_time_text ?? null,
      market: s.market,
      pick: s.pick,
      odds: s.odds,
      bookmaker: s.bookmaker ?? valid.bookmaker ?? null
    }));

    const { data: insertedSelections, error: e2 } = await supabase
      .from("bet_selections")
      .insert(insertRows)
      .select(); // ← devuelve los IDs
    if (e2) return res.status(500).json({ error: e2.message });

    // Respuesta original con selection_id (para que /parse-rows pueda adjuntarlo)
    const selectionsWithIds = valid.selections.map((s, i) => ({
      selection_id: insertedSelections?.[i]?.id || null,
      partido: s.match,
      torneo: s.tournament ?? null,
      fecha_hora_iso: s.start_time_utc ?? null,
      fecha_hora_texto: s.start_time_text ?? null,
      mercado: s.market,
      apuesta: s.pick,
      cuota: s.odds,
      casa_apuestas: s.bookmaker ?? valid.bookmaker ?? null
    }));

    res.json({
      betslip_id: slip.id,
      bookmaker: valid.bookmaker ?? null,
      selections: selectionsWithIds
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 3) Endpoint para Lovable: devuelve ARRAY listo (con enriquecimiento + IDs)
app.post("/parse-rows", async (req, res) => {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) {
      return res.status(400).json({ error: "missing fields: image_url, tipster_id" });
    }

    // Llama a /parse (objeto base)
    const upstream = await fetch(`${req.protocol}://${req.get("host")}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url, tipster_id })
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return res.status(502).json({ error: "upstream /parse error", detail: txt });
    }

    const parsed = await upstream.json();

    // Enriquecer + limpiar y construir filas para la tabla
    // ... tras obtener `parsed` y (opcionalmente) cargar desde DB ...

const rows = [];
for (const sel of (parsed.selections || [])) {
  // lee última versión desde DB si la has implementado (dbById). Si no, usa sel:
  // const db = sel.selection_id ? dbById[sel.selection_id] : null;

  // si no usas dbById, comenta las dos líneas siguientes:
  const db = null; // o tu lookup real
  let fechaISO   = db?.start_time_utc ?? sel.fecha_hora_iso ?? null;
  const fechaTxt = db?.start_time_text ?? sel.fecha_hora_texto ?? "";

  // fallback: si no hay ISO y hay texto relativo, intenta resolverlo a ISO
  if (!fechaISO && fechaTxt) {
    const iso = resolveRelativeDate(fechaTxt);
    if (iso) fechaISO = iso;
  }

  rows.push({
    "Partido": db?.match ?? sel.partido,
    "Torneo": db?.tournament ?? sel.torneo ?? "",
    // 👇 visible con fallback a texto
    "Fecha y hora": fechaISO
      ? new Date(fechaISO).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })
      : (fechaTxt || "(pendiente)"),
    "Mercado": db?.market ?? sel.mercado,
    "Apuesta": db?.pick ?? sel.apuesta,
    "Cuota": db?.odds ?? sel.cuota,
    "Casa de apuestas": (db?.bookmaker ?? sel.casa_apuestas ?? parsed.bookmaker) ? "" : "",

    // metadatos ocultos
    _betslip_id: parsed.betslip_id,
    _selection_id: sel.selection_id || null,
    _fecha_hora_iso: fechaISO || null,
    _fecha_hora_texto: fechaTxt || ""   // 👈 nuevo: llevamos también el texto
  });
}

return res.status(200).json(rows);
      
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 4) EDIT: actualizar campos de una selección (rellenar vacíos desde Lovable)
app.post("/update-selection", async (req, res) => {
  try {
    const {
      selection_id,
      torneo,            // string | null
      fecha_hora_iso,    // string ISO | null
      mercado,           // string | null
      apuesta,           // string | null
      cuota,             // number | null
      casa_apuestas,     // string | null (se limpiará)
      tipster_id         // necesario para limpiar bookmaker
    } = req.body || {};

    if (!selection_id) {
      return res.status(400).json({ error: "missing selection_id" });
    }

    const updates = {};
    if (typeof torneo !== "undefined") updates.tournament = torneo || null;
    if (typeof fecha_hora_iso !== "undefined") {
      updates.start_time_utc = fecha_hora_iso ? new Date(fecha_hora_iso) : null;
      if (fecha_hora_iso) updates.start_time_text = null; // preferimos ISO si lo dan
    }
    if (typeof mercado !== "undefined") updates.market = mercado || null;
    if (typeof apuesta !== "undefined") updates.pick = apuesta || null;
    if (typeof cuota !== "undefined") updates.odds = cuota !== null ? Number(cuota) : null;
    if (typeof casa_apuestas !== "undefined") {
      updates.bookmaker = casa_apuestas ? cleanBookmaker(casa_apuestas, tipster_id || "") : null;
    }

    const { data, error } = await supabase
      .from("bet_selections")
      .update(updates)
      .eq("id", selection_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, selection: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 5) EDIT: actualizar stake (rellenable por usuario desde Lovable)
app.post("/update-stake", async (req, res) => {
  try {
    const { betslip_id, stake, currency } = req.body || {};
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });

    const updates = {};
    if (typeof stake !== "undefined") updates.stake = stake !== null ? Number(stake) : null;
    if (typeof currency !== "undefined") updates.currency = currency || null;

    const { data, error } = await supabase
      .from("betslips")
      .update(updates)
      .eq("id", betslip_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, betslip: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Debug: probar enriquecimiento desde navegador
app.get("/debug-enrich", async (req, res) => {
  try {
    const partido = req.query.partido || "";
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const found = await enrichGenericSelection({ partido });
    return res.json({ ok: true, partido, found });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ============== HEALTH & LISTEN ==============
app.get("/health", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on " + PORT));

