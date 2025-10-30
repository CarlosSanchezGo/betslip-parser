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

// Quita acentos/diacríticos y baja a minúsculas
function normalizePlain(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const raw = selection.partido || "";
  if (!raw) return null;

  // 1) Separa los dos lados del partido por "vs"
  const sides = raw.split(/vs/i).map(s => s.trim()).filter(Boolean);
  if (sides.length < 2) {
    logD("no 'vs' in match text", raw);
    return null;
  }

  // 2) Normaliza y crea variantes (nombre sin iniciales + apellido)
  function expandName(side) {
    // Ej: "J. Sinner" -> ["J Sinner", "Sinner"]
    const plain = normalizePlain(side);
    // tokens >= 2
    const tokens = plain.split(/\s+/).filter(Boolean);
    const variants = new Set();

    if (tokens.length >= 2) {
      // quita iniciales de 1 carácter
      const noInitials = tokens.filter(t => t.length > 1).join(" ");
      if (noInitials) variants.add(noInitials);
      // añade sólo el último token (suele ser apellido)
      variants.add(tokens[tokens.length - 1]);
    } else {
      variants.add(plain);
    }
    return Array.from(variants);
  }

  // Corrige casos comunes de apellidos con/ sin tilde
  function addDiacriticAlternatives(v) {
    const out = new Set([v]);
    if (v.includes("cerundolo")) out.add(v.replace("cerundolo", "cerúndolo"));
    if (v.includes("alcaraz")) out.add(v.replace("alcaraz", "álcaraz")); // por si acaso
    // añade más reglas si lo necesitas
    return Array.from(out);
  }

  const leftVars  = expandName(sides[0]).flatMap(addDiacriticAlternatives);
  const rightVars = expandName(sides[1]).flatMap(addDiacriticAlternatives);

  // 3) Primero intenta una búsqueda combinada (ambos apellidos)
  const combinedQueries = [];
  for (const a of leftVars) for (const b of rightVars) {
    combinedQueries.push(`${a} ${b}`);
  }

  async function searchAll(q) {
    const url = `${base}/search/all?q=${encodeURIComponent(q)}`;
    return await fetchJsonWithTimeout(url, 6000);
  }

  // 4) Intenta encontrar IDs de jugadores de TENIS para cada lado
  async function topTennisCandidates(q) {
    const res = await searchAll(q);
    // Prioriza sección de tenis si existe
    const tennis = res?.tennis;
    const fromTennis =
      (tennis?.players || []).map(p => ({ type: "player", id: p.id, name: p.name })).slice(0, 5);

    if (fromTennis.length) return fromTennis;

    // Si no hay sección de tenis, abre a todo (por si el index cambia)
    const generic = [];
    for (const section of Object.values(res || {})) {
      if (!section || typeof section !== "object") continue;
      if (Array.isArray(section.players)) {
        section.players.slice(0, 3).forEach(p => generic.push({ type: "player", id: p.id, name: p.name }));
      }
      if (Array.isArray(section.teams)) {
        section.teams.slice(0, 3).forEach(t => generic.push({ type: "team", id: t.id, name: t.name }));
      }
    }
    return generic.slice(0, 5);
  }

  // 5) Dado un playerId, trae próximos eventos
  async function nextEventsForPlayer(id) {
    const url = `${base}/player/${id}/events/next/0`;
    const data = await fetchJsonWithTimeout(url, 6000);
    return Array.isArray(data?.events) ? data.events : [];
  }

  // === Estrategia A: búsqueda combinada y cruce de eventos ===
  for (const combo of combinedQueries.slice(0, 6)) {
    try {
      const candLeft  = await topTennisCandidates(combo);
      const candRight = candLeft; // con query combinada lo normal es que estén ambos
      // Trae eventos de los primeros 3 jugadores detectados
      const eventsById = {};
      for (const c of candLeft.slice(0, 3)) {
        const evs = await nextEventsForPlayer(c.id);
        eventsById[c.id] = evs;
      }
      // Busca un evento donde aparezca *otra* variante del segundo lado
      for (const evs of Object.values(eventsById)) {
        for (const ev of evs) {
          const home = normalizePlain(ev?.homeTeam?.name || "");
          const away = normalizePlain(ev?.awayTeam?.name || "");
          // ¿Contiene apellidos/variantes de ambos lados?
          const hasLeft  = leftVars.some(v => home.includes(normalizePlain(v)) || away.includes(normalizePlain(v)));
          const hasRight = rightVars.some(v => home.includes(normalizePlain(v)) || away.includes(normalizePlain(v)));
          if (hasLeft && hasRight) {
            const tournament = ev?.tournament?.name || ev?.season?.name || "";
            const startIso   = ev?.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : null;
            logD("A-match", combo, tournament, startIso);
            return { tournament, startIso };
          }
        }
      }
    } catch (e) {
      logD("A-fail", combo, String(e));
    }
  }

  // === Estrategia B: buscar cada lado por separado y cruzar agendas ===
  async function firstCandidatesOrNull(vars) {
    for (const v of vars) {
      try {
        const list = await topTennisCandidates(v);
        if (list.length) return list.slice(0, 3);
      } catch (e) {
        logD("B-search-fail", v, String(e));
      }
    }
    return null;
  }

  const leftCands  = await firstCandidatesOrNull(leftVars);
  const rightCands = await firstCandidatesOrNull(rightVars);

  if (!leftCands || !rightCands) {
    logD("B-no-cands", { leftVars, rightVars });
    return null;
  }

  // Trae eventos próximos de ambos lados y busca intersección (mismo eventId o vs por nombres)
  const leftEventsPromises  = leftCands.map(c => nextEventsForPlayer(c.id));
  const rightEventsPromises = rightCands.map(c => nextEventsForPlayer(c.id));
  const leftEventsLists  = await Promise.allSettled(leftEventsPromises);
  const rightEventsLists = await Promise.allSettled(rightEventsPromises);

  const leftEvents  = leftEventsLists.flatMap(p => p.status === "fulfilled" ? (p.value || []) : []);
  const rightEvents = rightEventsLists.flatMap(p => p.status === "fulfilled" ? (p.value || []) : []);

  // Índice rápido por normalización de "home vs away"
  function sig(ev) {
    const h = normalizePlain(ev?.homeTeam?.name || "");
    const a = normalizePlain(ev?.awayTeam?.name || "");
    return h < a ? `${h} vs ${a}` : `${a} vs ${h}`;
  }
  const rightIndex = new Map(rightEvents.map(ev => [sig(ev), ev]));

  for (const ev of leftEvents) {
    const key = sig(ev);
    if (rightIndex.has(key)) {
      const twin = rightIndex.get(key);
      const startUnix = ev.startTimestamp || twin.startTimestamp;
      const tournament = ev?.tournament?.name || twin?.tournament?.name || ev?.season?.name || twin?.season?.name || "";
      const startIso = startUnix ? new Date(startUnix * 1000).toISOString() : null;
      logD("B-match", { key, tournament, startIso });
      return { tournament, startIso };
    }
  }

  logD("no match", { leftVars, rightVars });
// === Fallback final: búsqueda en internet ===
try {
  const baseUrl = process.env.SELF_URL || "https://betslip-parser.onrender.com";
  const url = `${baseUrl}/enrich-online?partido=${encodeURIComponent(selection.partido)}`;
  const r = await fetch(url);
  if (r.ok) {
    const data = await r.json();
    if (data?.found?.tournament) {
      logD("found via web search", data.found);
      return {
        tournament: data.found.tournament,
        startIso: data.found.startIso || null
      };
    }
  }
} catch (e) {
  console.log("[ENRICH web fallback error]", e.message);
}

logD("no match", { leftVars, rightVars });
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

// === Enriquecimiento online: busca torneo y hora en internet ===
app.get("/enrich-online", async (req, res) => {
  const partido = req.query.partido;
  if (!partido) return res.status(400).json({ error: "Missing ?partido=" });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un asistente que busca información deportiva en Internet.
Devuelve JSON con las claves: tournament (nombre del torneo o liga), startIso (fecha y hora ISO en UTC si existe), y confidence (0 a 1).`
        },
        {
          role: "user",
          content: `Busca el torneo y la hora exacta del partido ${partido}.`
        }
      ],
      tools: [
        { type: "web_search" } // 🔍 permite búsqueda en internet
      ]
    });

    const text = completion.choices[0].message?.content || "{}";
    const json = JSON.parse(text);
    res.json({ ok: true, partido, found: json });
  } catch (e) {
    console.error("❌ enrich-online error", e);
    res.status(500).json({ error: e.message });
  }
});


// ============== HEALTH & LISTEN ==============
app.get("/health", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on " + PORT));
