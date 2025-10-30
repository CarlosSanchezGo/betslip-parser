import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { z } from "zod";

// ---- CONFIG ----
const BASE_TZ = process.env.BASE_TZ || "Europe/Madrid";

// Bookmakers conocidos (añade/quita los que uses)
const KNOWN_BOOKMAKERS = [
  "bet365","betfair","pinnacle","william hill","betway","betsson","codere",
  "sportium","marathonbet","bwin","1xbet","888sport","leovegas","caliente",
  "playdoit","foliatti","daznbet","versus","kirolbet","retabet"
];

// ---- HELPERS ----
const norm = s => (s||"").toString().trim().toLowerCase();

// Si el “bookmaker” devuelto es el tipster o no está en la lista conocida → devuelve null
function cleanBookmaker(rawBookmaker, tipsterId) {
  const b = norm(rawBookmaker);
  const t = norm(tipsterId);
  if (!b) return null;
  if (b.includes(t) || t.includes(b)) return null;
  // intento de normalizar (quita “apuesta realizada en …”)
  const cleaned = b.replace(/apuesta.*en\s*/i, "").replace(/[^\p{L}\p{N}\s]/gu,"").trim();
  if (!cleaned) return null;
  const isKnown = KNOWN_BOOKMAKERS.some(k => cleaned.includes(k));
  return isKnown ? cleaned : null;
}

// Convierte "Mañana 06:30" u "Hoy 19:00" a Date ISO en time zone base.
// Si no puede, devuelve null y deja el texto tal cual.
function resolveRelativeDate(text, now = new Date()) {
  if (!text) return null;
  const m = text.toLowerCase().match(/(hoy|mañana)\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, rel, hh, mm] = m;
  // construimos fecha en tz base
  const nowTz = new Date(now.toLocaleString("en-US", { timeZone: BASE_TZ }));
  const d = new Date(nowTz);
  if (rel === "mañana") d.setDate(d.getDate() + 1);
  d.setHours(parseInt(hh,10), parseInt(mm,10), 0, 0);
  // volvemos a ISO en UTC
  const iso = new Date(
    Date.parse(d.toLocaleString("en-US", { timeZone: "UTC" }))
  ).toISOString();
  return iso;
}


const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  SUPABASE_BUCKET = "betslips",
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** === Esquema Zod con TUS CAMPOS exactamente === */
const Selection = z.object({
  match: z.string(),                              // "Ann/Kim vs Reynolds/Watt"
  tournament: z.string().nullable().optional(),   // "ATP Paris Masters"
  start_time_utc: z.string().datetime().nullable().optional(), // ISO ("2025-10-30T06:30:00Z")
  start_time_text: z.string().nullable().optional(),           // si no hay fecha exacta (ej. "Mañana 06:30")
  market: z.string(),                              // "Ganador"
  pick: z.string(),                                // "Reynolds/Watt"
  odds: z.coerce.number(),                         // 1.05
  bookmaker: z.string().nullable().optional()      // si aparece por selección
});

const BetSlip = z.object({
  bookmaker: z.string().nullable().optional(),     // casa detectada a nivel ticket
  bet_type: z.enum(["single","acca","system","other"]).default("acca"),
  selections: z.array(Selection).min(1),
  stake: z.coerce.number().nullable().optional(),
  total_odds: z.coerce.number().nullable().optional(),
  potential_returns: z.coerce.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  tipster_id: z.string(),
  source_image_url: z.string().url(),
  confidence: z.coerce.number().nullable().optional()
});

// Cache sencilla en memoria para no machacar la API
const matchCache = new Map(); // key -> { ts, data }
const CACHE_MS = 5 * 60 * 1000;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return await r.json();
}

// Intenta localizar torneo y hora exacta en SofaScore
async function enrichTennisSelection(selection) {
  const txt = selection.partido || "";
  const names = Array.from(
    new Set(
      txt
        .replace(/[-–—]/g, " ")
        .split(/vs|\/|,|\(|\)|\s{2,}/i)
        .map(s => s.trim())
        .filter(Boolean)
    )
  ).slice(0, 4);

  if (names.length === 0) return null;

  const key = `tennis:${names.join("|")}`;
  const cached = matchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.data;

  try {
    const q = encodeURIComponent(names[0]);
    const search = await fetchJson(`https://api.sofascore.com/api/v1/search/all?q=${q}`);
    const tennis = (search?.tennis?.players || []).slice(0,3);

    for (const p of tennis) {
      const events = await fetchJson(`https://api.sofascore.com/api/v1/player/${p.id}/events/next/0`);
      const list = (events?.events || []).filter(e => e?.tournament?.name);
      for (const ev of list) {
        const home = (ev?.homeTeam?.name || "").toLowerCase();
        const away = (ev?.awayTeam?.name || "").toLowerCase();
        const hay = names.filter(n => home.includes(n.toLowerCase()) || away.includes(n.toLowerCase())).length;

        if (hay >= Math.min(2, names.length)) {
          const tournament = ev.tournament.name;
          const startUnix = ev.startTimestamp;
          const startIso = startUnix ? new Date(startUnix * 1000).toISOString() : null;
          const data = { tournament, startIso };
          matchCache.set(key, { ts: Date.now(), data });
          return data;
        }
      }
    }
  } catch (e) {
    // ignora errores
  }
  return null;
}


/** 1) URL firmada para subir a Supabase Storage */
app.post("/upload-url", async (req, res) => {
  try {
    const { tipster_id, filename } = req.body;
    if (!tipster_id || !filename) return res.status(400).json({ error: "missing fields" });

    const key = `${tipster_id}/${Date.now()}-${filename}`;
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUploadUrl(key);

    if (error) return res.status(500).json({ error: error.message });

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${key}`;
    res.json({ uploadUrl: data.signedUrl, publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 2) Parsear imagen y devolver EXACTAMENTE tus campos */
app.post("/parse", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body;
    if (!image_url || !tipster_id) return res.status(400).json({ error: "missing fields" });

    const system = `Eres un extractor de tickets de apuestas. Debes devolver SOLO JSON válido y exacto con este esquema:
{
  "bookmaker": string|null,
  "bet_type": "single"|"acca"|"system"|"other",
  "selections": [{
    "match": string,                 // ejemplo: "S. Ann/D.J. Kim vs F. Reynolds/J. Watt"
    "tournament": string|null,       // ejemplo: "ATP Paris Masters"
    "start_time_utc": string|null,   // ISO 8601 o null si no hay fecha exacta
    "start_time_text": string|null,  // literal si no hay fecha exacta (ej. "Mañana 06:30")
    "market": string,                // ej. "Ganador"
    "pick": string,                  // ej. "F. Reynolds/J. Watt"
    "odds": number,                  // usa punto decimal
    "bookmaker": string|null         // si se identifica la casa por selección
  }],
  "stake": number|null,
  "total_odds": number|null,
  "potential_returns": number|null,
  "currency": string|null
}
Reglas:
- No inventes fechas. Si ves "Mañana 06:30", pon start_time_utc = null y start_time_text = "Mañana 06:30".
- Convierte comas decimales a punto.
- Si la casa de apuestas (bookmaker) está visible en el ticket, inclúyela.`;

    const user = `Extrae los datos del pantallazo. Devuelve SÓLO JSON.`;

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

    // Completa campos obligatorios para guardar
    parsed.tipster_id = tipster_id;
    parsed.source_image_url = image_url;

    const valid = BetSlip.parse(parsed);

    // Guarda cabecera
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
        status: 'parsed'
      })
      .select()
      .single();
    if (e1) return res.status(500).json({ error: e1.message });

    // Guarda selecciones
    const rows = valid.selections.map(s => ({
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

    const { error: e2 } = await supabase.from("bet_selections").insert(rows);
    if (e2) return res.status(500).json({ error: e2.message });

    // === RESPUESTA PARA TU WEB (exactamente lo que necesitas mostrar) ===
    const minimal = {
      betslip_id: slip.id,
      bookmaker: valid.bookmaker ?? null,
      selections: valid.selections.map(s => ({
        partido: s.match,
        torneo: s.tournament ?? null,
        fecha_hora_iso: s.start_time_utc ?? null,
        fecha_hora_texto: s.start_time_text ?? null,
        mercado: s.market,
        apuesta: s.pick,
        cuota: s.odds,
        casa_apuestas: s.bookmaker ?? valid.bookmaker ?? null
      }))
    };

    res.json(minimal);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ NUEVO endpoint: devuelve DIRECTAMENTE un array de filas para la tabla
app.post("/parse-rows", async (req, res) => {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) {
      return res.status(400).json({ error: "missing fields: image_url, tipster_id" });
    }

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

    const rows = [];
    for (const sel of (parsed.selections || [])) {
      let fechaISO = sel.fecha_hora_iso || null;
      if (!fechaISO && sel.fecha_hora_texto) {
        const iso = resolveRelativeDate(sel.fecha_hora_texto);
        if (iso) fechaISO = iso;
      }

      try {
        const found = await enrichTennisSelection({ partido: sel.partido });
        if (found) {
          if (!fechaISO && found.startIso) fechaISO = found.startIso;
          if (!sel.torneo && found.tournament) sel.torneo = found.tournament;
        }
      } catch {}

      const casa = cleanBookmaker(sel.casa_apuestas || parsed.bookmaker, tipster_id);

      rows.push({
        "Partido": sel.partido,
        "Torneo": sel.torneo || "",
        "Fecha y hora": fechaISO
          ? new Date(fechaISO).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })
          : (sel.fecha_hora_texto || ""),
        "Mercado": sel.mercado,
        "Apuesta": sel.apuesta,
        "Cuota": sel.cuota,
        "Casa de apuestas": casa || ""
      });
    }

    return res.status(200).json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});


app.get("/health", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on " + PORT));
