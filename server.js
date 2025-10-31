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

// 🟢 Debug enrich web
app.get("/debug-enrich-web", async (req, res) => {
  try {
    const partido = req.query.partido ? cleanPartido(req.query.partido) : null;
    if (!partido) return res.status(400).json({ error: "missing partido" });
    const sport = req.query.sport || "football";
    const found = await enrichViaWeb(partido, null, sport);
    res.json({ ok: true, partido, found });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🟡 Check result (prioriza fuentes)
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
    res.status(500).json({ error: err.message });
  }
});

// ✅ Upload + parse
app.post("/parse-rows", async (req, res) => {
  try {
    const { image_url, tipster_id } = req.body || {};
    if (!image_url || !tipster_id) return res.status(400).json({ error: "missing fields" });

    const imageSource = image_url.startsWith("data:") ? image_url : await fetchImageAsDataUrl(image_url);
    const parsed = await parseImageWithOpenAI(imageSource);
    if (!Array.isArray(parsed.selections)) return res.json([]);

    const { data: slip, error: slipErr } = await supabase
      .from("betslips")
      .insert({ tipster_id, source_image_url: image_url, parsed_at: new Date().toISOString() })
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

      if ((!torneo || !fecha_hora_iso) && partido) {
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
      const { data: selIns } = await supabase
        .from("bet_selections")
        .insert(insertObj)
        .select("*")
        .single();
      rows.push(selIns);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Update selection
app.post("/update-selection", async (req, res) => {
  try {
    const { selection_id, torneo, fecha_hora_iso, mercado, apuesta, cuota, casa_apuestas } = req.body || {};
    if (!selection_id) return res.status(400).json({ error: "missing selection_id" });

    const patch = {};
    if (torneo !== undefined) patch.tournament = torneo;
    if (fecha_hora_iso !== undefined) {
      patch.start_time_utc = fecha_hora_iso;
      if (fecha_hora_iso) patch.start_time_text = null;
    }
    if (mercado !== undefined) patch.market = mercado;
    if (apuesta !== undefined) patch.pick = apuesta;
    if (cuota !== undefined) patch.odds = parseFloat(cuota);
    if (casa_apuestas !== undefined) patch.bookmaker = casa_apuestas;

    const { data, error } = await supabase.from("bet_selections").update(patch).eq("id", selection_id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, selection: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Update stake
app.post("/update-stake", async (req, res) => {
  try {
    const { betslip_id, stake, currency } = req.body || {};
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });
    const stakeNum = parseFloat(stake);
    const { data, error } = await supabase
      .from("betslips")
      .update({ stake: stakeNum, currency })
      .eq("id", betslip_id)
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, betslip: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ List betslips
app.get("/list-betslips", async (req, res) => {
  try {
    const { tipster_id } = req.query;
    if (!tipster_id) return res.status(400).json({ error: "missing tipster_id" });
    const { data: slips } = await supabase
      .from("betslips")
      .select("id, created_at, stake, currency, resultado, resultado_texto, closed_at, bet_selections(*)")
      .eq("tipster_id", tipster_id)
      .order("created_at", { ascending: false });
    res.json(slips || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Delete betslip
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

// ✅ Close betslip
app.post("/close-betslip", async (req, res) => {
  try {
    const { betslip_id, resultado, resultado_texto } = req.body;
    if (!betslip_id) return res.status(400).json({ error: "missing betslip_id" });
    const { data, error } = await supabase
      .from("betslips")
      .update({ resultado, resultado_texto, closed_at: new Date().toISOString() })
      .eq("id", betslip_id)
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, betslip: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

