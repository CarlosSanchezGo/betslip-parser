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

// ===== Enriquecimiento con browsing real =====
async function enrichViaWeb(partido, horaTexto = null) {
  if (!USE_WEB) return null;
  partido = cleanPartido(partido);
  if (!partido) return null;

  const todayISO = new Date().toISOString().slice(0, 10);
  const variants = searchVariantsFor(partido);

  const userPrompt = [
    `Encuentra información actualizada (HOY o MAÑANA) sobre el partido "${partido}".`,
    variants.length > 1 ? `También busca con estas variantes: ${variants.join(" | ")}.` : "",
    `Prioriza fuentes fiables para horarios y torneos, en este orden:
     - flashscore.com
     - sofascore.com
     - atptour.com / wtatennis.com
     - espn.com / tycsports.com / as.com`,
    `Si no hay resultados en esas webs, intenta con medios deportivos oficiales.`,
    `Devuelve SOLO un JSON con este formato:
{
  "tournament": "nombre exacto del torneo",
  "tournamentTz": "IANA timezone (p.ej. 'Europe/Paris')",
  "startLocal": "YYYY-MM-DD HH:mm (hora local del torneo, 24h)",
  "startIso": "UTC ISO (YYYY-MM-DDTHH:mm:ssZ)",
  "confidence": 0..1,
  "sources": ["url1","url2"]
}`,
    `No inventes: si no encuentras hora confirmada, pon null en startLocal y startIso.`,
    `Fecha de referencia: ${todayISO}`
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: userPrompt,
      tools: [{
        type: "web_search",
        user_location: { type: "approximate", country: "ES", timezone: "Europe/Madrid" },
        search_context_size: "medium"
      }],
      tool_choice: "auto",
      temperature: 0.1
    })
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("[web enrich] HTTP", r.status, j?.error?.message || j);
    return null;
  }

  let textOut = "";
  try {
    const out = j.output || [];
    const msg = out.find(o => o.type === "message") || out[out.length - 1] || {};
    const contentArr = msg?.content || [];
    textOut = (contentArr.find(c => c.type === "output_text")?.text || "").trim();
  } catch (_) {}

  let data = safeParseJson(textOut) || null;
  if (!data) {
    console.error("[web enrich] no JSON parseable:", textOut.slice(0, 200));
    return null;
  }
  return data;
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

app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) return res.status(400).json({ error: "missing fields" });

    const imageSource = image_url.startsWith("data:")
      ? image_url
      : await fetchImageAsDataUrl(image_url);

    const parsed = await parseImageWithOpenAI(imageSource);
    if (!Array.isArray(parsed.selections)) return res.json([]);

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
      let fecha_hora_iso = toISOFromES(fecha_hora_texto) || resolveRelativeDate(fecha_hora_texto);

      if ((!torneo || !fecha_hora_iso) && partido && USE_WEB) {
        const web = await enrichViaWeb(partido, fecha_hora_texto);
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

app.get("/debug-enrich-web", async (req, res) => {
  try {
    const raw = req.query.partido || "";
    const partido = cleanPartido(raw);
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const found = await enrichViaWeb(partido);
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
      tipster_id,        // opcional, lo usamos para limpiar bookmaker si coincide con el tipster
      torneo,            // -> tournament
      fecha_hora_iso,    // -> start_time_utc (UTC ISO)
      mercado,           // -> market
      apuesta,           // -> pick
      cuota,             // -> odds (número)
      casa_apuestas      // -> bookmaker
    } = req.body || {};

    if (!selection_id) {
      return res.status(400).json({ error: "missing selection_id" });
    }

    // helper mínimo por si no lo tienes ya
    const cleanBookmaker = (name, tid) => {
      if (!name) return null;
      const n = String(name).toLowerCase();
      if (tid && n.includes(String(tid).toLowerCase())) return null; // evita confundir tipster con casa
      if (n.includes("tipster")) return null;
      return name;
    };

    const patch = {};
    if (typeof torneo !== "undefined") patch.tournament = torneo || null;
    if (typeof fecha_hora_iso !== "undefined") {
      patch.start_time_utc = fecha_hora_iso ? new Date(fecha_hora_iso).toISOString() : null;
      if (patch.start_time_utc) patch.start_time_text = null; // si hay UTC, limpiamos texto
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

// 🟢 Listar todas las apuestas del tipster
app.get("/list-betslips", async (req, res) => {
  const { tipster_id } = req.query;
  if (!tipster_id) return res.status(400).json({ error: "missing tipster_id" });
  const { data, error } = await supabase
    .from("betslips")
    .select("id, created_at, stake, currency, resultado, resultado_texto, bet_selections (id, match, tournament, start_time_utc, market, pick, odds, bookmaker)")
    .eq("tipster_id", tipster_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  try {
    const { partido } = req.query;
    if (!partido) return res.status(400).json({ error: "missing partido" });

    // Usa OpenAI con web search
    const completion = await openai.responses.create({
      model: "gpt-4o-mini",
      tool_choice: "auto",
      tools: [{ type: "web_search" }],
      input: `Busca el resultado final del partido ${partido}. Indica si ya terminó y si fue ganado, perdido o nulo desde el punto de vista de apuestas.`,
    });

    const text = completion.output_text || "";
    res.json({ finished: true, result: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

app.get("/list-betslips", async (req, res) => {
  try {
    const { tipster_id } = req.query;
    if (!tipster_id) {
      console.error("Missing tipster_id in query");
      return res.status(400).json({ error: "missing tipster_id" });
    }

    // 1️⃣ Bet slips
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
      return res.json([]); // no apuestas aún
    }

    // 2️⃣ Bet selections
    const slipIds = slips.map(s => s.id).filter(Boolean);
    const { data: selections, error: selError } = await supabase
      .from("bet_selections")
      .select("id, betslip_id, match, tournament, start_time_utc, start_time_text, market, pick, odds, bookmaker")
      .in("betslip_id", slipIds);

    if (selError) {
      console.error("Supabase selections error:", selError.message);
      return res.json(slips.map(s => ({ ...s, bet_selections: [] })));
    }

    // 3️⃣ Agrupar
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));



