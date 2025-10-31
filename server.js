// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// =====================
// Config básica
// =====================
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

// =====================
// Helpers comunes
// =====================
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

// =======================================================
// NUEVO: Enrichment verificado con allow-list de dominios
// =======================================================
const dedupeSpaces = s => (s || "").replace(/\s+/g, " ").trim();
function normalizeMatchName(raw) {
  if (!raw) return null;
  let s = dedupeSpaces(raw);
  s = s.replace(/\s*[-–—]\s*/g, " vs "); // “A - B” → “A vs B”
  return s;
}
const SOURCE_ALLOWLIST = {
  football: ["laliga.com","rfef.es","espn.com","sofascore.com","flashscore.com","livescore.com","uefa.com","premierleague.com","legaseriea.it","bundesliga.com","ligue1.com"],
  tennis:   ["atptour.com","wtatennis.com","sofascore.com","flashscore.com","tennis.com","itftennis.com"],
  default:  ["espn.com","sofascore.com","flashscore.com","livescore.com"]
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
  if (!r.ok) {
    const t = await r.text();
    console.error("[verified enrich] HTTP", r.status, t);
    return { tournament:null,startIso:null,tz:null,sourceUrl:null };
  }
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
  if (!USE_WEB) return null;
  try {
    return await findFixtureVerified(partido, sport);
  } catch (err) {
    console.error("[enrichViaWeb] error:", err.message);
    return null;
  }
}

// =====================
// OCR con OpenAI (imagen)
// =====================
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

// =====================
// Rutas
// =====================
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

app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id, sport } = req.body || {};
    if (!image_url || !tipster_id) return res.status(400).json({ error: "missing fields" });

    const imageSource = image_url.startsWith("data:")
      ? image_url
      : await fetchImageAsDataUrl(image_url);

    const parsed = await parseImageWithOpenAI(imageSource);
    if (!Array.isArray(parsed.selections)) return res.json([]);

    // crea betslip
    const { data: slip, error: slipErr } = await supabase
      .from("betslips")
      .insert({
        tipster_id,
        source_image_url: image_url,
        parsed_at: new Date().toISOString()
      })
      .select("id")
      .single();
    if (slipErr) throw slipErr;
    const betslip_id = slip.id;

    const rows = [];
    for (const sel of parsed.selections) {
      let { partido, torneo, fecha_hora_texto, mercado, apuesta, cuota } = sel || {};
      partido = cleanPartido(partido);
      const casa_raw = sel?.casa_apuestas || parsed.bookmaker || null;
      const casa_apuestas = cleanBookmaker(casa_raw, tipster_id);

      // fecha/hora desde imagen
      let fecha_hora_iso = toISOFromES(fecha_hora_texto) || resolveRelativeDate(fecha_hora_texto);

      // enrichment web si falta torneo/hora
      if ((!torneo || !fecha_hora_iso) && partido && USE_WEB) {
        const web = await enrichViaWeb(partido, fecha_hora_texto, sport);
        if (web) {
          if (!torneo && web.tournament) torneo = web.tournament;
          if (!fecha_hora_iso && web.startIso) fecha_hora_iso = web.startIso;
        }
      }

      const oddsNumber = parseFloat(String(cuota || "").replace(",", "."));
      const insertObj = {
        betslip_id,
        match: partido || null,
        tournament: torneo || null,
        start_time_utc: fecha_hora_iso || null,
        start_time_text: fecha_hora_iso ? null : fecha_hora_texto || null,
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
      if (selErr) throw selErr;

      rows.push({
        "Partido": selIns.match,
        "Torneo": selIns.tournament,
        "Fecha y hora": selIns.start_time_utc
          ? new Date(selIns.start_time_utc).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
          : selIns.start_time_text,
        "Mercado": selIns.market,
        "Apuesta": selIns.pick,
        "Cuota": selIns.odds,
        "Casa de apuestas": selIns.bookmaker,
        _betslip_id: betslip_id,
        _selection_id: selIns.id
      });
    }
    res.json(rows);
  } catch (e) {
    console.error("parse-rows error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Debug enrichment (para probar desde navegador)
app.get("/debug-enrich-web", async (req, res) => {
  try {
    const raw = req.query.partido || "";
    const partido = cleanPartido(raw);
    const sport = req.query.sport || null;
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const found = await enrichViaWeb(partido, null, sport);
    res.json({ ok: true, partido, found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Actualiza una selección (tabla bet_selections)
app.post("/update-selection", async (req, res) => {
  try {
    const {
      selection_id,
      tipster_id,
      torneo,
      fecha_hora_iso,
      mercado,
      apuesta,
      cuota,
      casa_apuestas
    } = req.body || {};

    if (!selection_id) {
      return res.status(400).json({ error: "missing selection_id" });
    }

    const _cleanBookmaker = (name, tid) => {
      if (!name) return null;
      const n = String(name).toLowerCase();
      if (tid && n.includes(String(tid).toLowerCase())) return null;
      if (n.includes("tipster")) return null;
      return name;
    };

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
      patch.bookmaker = _cleanBookmaker(casa_apuestas, tipster_id);
    }

    const { data, error } = await supabase
      .from("bet_selections")
      .update(patch)
      .eq("id", selection_id)
      .select("id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, selection: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ✅ Actualiza stake/moneda de un ticket (tabla betslips)
app.post("/update-stake", async (req, res) => {
  try {
    const { betslip_id, stake, currency } = req.body || {};
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });

    const stakeNum =
      stake === null || typeof stake === "undefined"
        ? null
        : (typeof stake === "number" ? stake : parseFloat(String(stake).replace(",", ".")));

    const { data, error } = await supabase
      .from("betslips")
      .update({
        stake: stakeNum !== null && Number.isFinite(stakeNum) ? stakeNum : null,
        currency: currency || null
      })
      .eq("id", betslip_id)
      .select("id, stake, currency")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, betslip: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 🟢 Listar todas las apuestas del tipster (con selecciones)
app.get("/list-betslips", async (req, res) => {
  try {
    const { tipster_id } = req.query;
    if (!tipster_id) {
      console.error("Missing tipster_id in query");
      return res.status(400).json({ error: "missing tipster_id" });
    }

    const { data: slips, error: slipsError } = await supabase
      .from("betslips")
      .select("id, tipster_id, created_at, stake, currency, resultado, resultado_texto, closed_at")
      .eq("tipster_id", tipster_id)
      .order("created_at", { ascending: false });

    if (slipsError) {
      console.error("Supabase slips error:", slipsError.message);
      return res.status(500).json({ error: slipsError.message });
    }

    if (!slips || slips.length === 0) {
      return res.json([]);
    }

    const slipIds = slips.map(s => s.id).filter(Boolean);
    const { data: selections, error: selError } = await supabase
      .from("bet_selections")
      .select("id, betslip_id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
      .in("betslip_id", slipIds);

    if (selError) {
      console.error("Supabase selections error:", selError.message);
      return res.json(slips.map(s => ({ ...s, bet_selections: [] })));
    }

    const grouped = slips.map(slip => ({
      ...slip,
      bet_selections: selections.filter(sel => sel.betslip_id === slip.id)
    }));

    return res.json(grouped);
  } catch (err) {
    console.error("list-betslips fatal:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
});

// 🔴 Eliminar apuesta completa
app.delete("/delete-betslip", async (req, res) => {
  try {
    const { betslip_id } = req.body;
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });
    await supabase.from("bet_selections").delete().eq("betslip_id", betslip_id);
    await supabase.from("betslips").delete().eq("id", betslip_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🟡 Buscar resultado en internet
app.get("/check-result", async (req, res) => {
  console.log("🟢 Versión correcta de /check-result cargada");
  try {
    const { partido, pick } = req.query;
    if (!partido) return res.status(400).json({ error: "missing partido" });

    const prompt = `Busca si el partido "${decodeURIComponent(
      partido
    )}" ya terminó HOY o AYER.
Devuelve SOLO JSON:
{"finished":true|false,"score":"x-y|null","status":"Ganada|Perdida|Nula|null","confidence":0..1,"sources":["url1","url2"]}

Reglas:
- Si no terminó: finished=false, el resto null.
- Determina status respecto al pick del apostante (si se proporciona: "${pick || ""}"). 
- Si no puedes determinar, status=null.`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: prompt,
        tools: [
          {
            type: "web_search",
            user_location: {
              type: "approximate",
              country: "ES",
              timezone: "Europe/Madrid",
            },
          },
        ],
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error: ${text}`);
    }

    const result = await response.json();
    let text = "";
    try {
      const out = result.output || [];
      const msg = out.find(o => o.type === "message") || out[out.length - 1] || {};
      text = (msg.content?.find(c => c.type === "output_text")?.text || "").trim();
    } catch (err) {
      console.warn("⚠️ parse text failed:", err);
    }

    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(text.slice(s, e + 1)) : null;

    res.json(
      parsed || {
        finished: false,
        score: null,
        status: null,
        confidence: 0,
        sources: [],
      }
    );
  } catch (err) {
    console.error("❌ /check-result error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🟣 Cerrar apuesta con resultado confirmado
app.post("/close-betslip", async (req, res) => {
  const { betslip_id, resultado, resultado_texto } = req.body;
  if (!betslip_id || !resultado) return res.status(400).json({ error: "missing params" });
  const { data, error } = await supabase
    .from("betslips")
    .update({
      resultado,
      resultado_texto,
      closed_at: new Date().toISOString(),
    })
    .eq("id", betslip_id)
    .select("id, resultado, resultado_texto, closed_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, betslip: data });
});

// =====================
// Arranque
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
