import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "25mb" }));

// === CONFIG ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// === HELPERS ===
function resolveRelativeDate(text) {
  try {
    const now = new Date();
    if (/mañana/i.test(text)) {
      const m = text.match(/(\d{1,2}):(\d{2})/);
      if (m) {
        const dt = new Date(now);
        dt.setDate(now.getDate() + 1);
        dt.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
        return dt.toISOString();
      }
    }
  } catch {}
  return null;
}

function cleanBookmaker(name, tipsterId) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (n.includes("tipster") || n.includes(tipsterId?.toLowerCase())) return null;
  return name;
}

const ENRICH_DEBUG = process.env.ENRICH_DEBUG === "true";
const logD = (...args) => ENRICH_DEBUG && console.log("[ENRICH]", ...args);

// ---- Fetch con fallback a proxy anti-bot (ZenRows) ----
async function fetchJsonSmart(url, { timeoutMs = 6000, ua = "Mozilla/5.0", lang = "es-ES,es;q=0.9" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": lang }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (r.ok) return r.json();

  if ((r.status === 403 || r.status === 429) && process.env.ZENROWS_API_KEY) {
    const proxyUrl = `https://api.zenrows.com/v1/?url=${encodeURIComponent(url)}&js_render=false&premium_proxy=true&apikey=${process.env.ZENROWS_API_KEY}`;
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), timeoutMs + 4000);
    try {
      const r2 = await fetch(proxyUrl, { headers: { "User-Agent": ua, "Accept-Language": lang }, signal: ctrl2.signal });
      if (!r2.ok) throw new Error(`Proxy HTTP ${r2.status}`);
      return await r2.json();
    } finally {
      clearTimeout(t2);
    }
  }
  throw new Error(`HTTP ${r.status}`);
}

// === ENRICH GENERIC SELECTION ===
async function enrichGenericSelection(selection) {
  const base = "https://api.sofascore.com/api/v1";
  const raw = selection.partido || "";
  if (!raw) return null;

  const sides = raw.split(/vs/i).map(s => s.trim()).filter(Boolean);
  if (sides.length < 2) return null;

  function normalizePlain(s) {
    return (s || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\./g, "").replace(/\s{2,}/g, " ").trim();
  }

  function expandName(side) {
    const plain = normalizePlain(side);
    const tokens = plain.split(/\s+/).filter(Boolean);
    const set = new Set();
    if (tokens.length >= 2) {
      set.add(tokens.filter(t => t.length > 1).join(" "));
      set.add(tokens[tokens.length - 1]);
    } else {
      set.add(plain);
    }
    return Array.from(set);
  }

  const leftVars = expandName(sides[0]);
  const rightVars = expandName(sides[1]);
  const combinedQueries = [];
  for (const a of leftVars) for (const b of rightVars) combinedQueries.push(`${a} ${b}`);

  async function topTennisCandidates(q) {
    const res = await fetchJsonSmart(`${base}/search/all?q=${encodeURIComponent(q)}`);
    const tennis = res?.tennis;
    const fromTennis =
      (tennis?.players || []).map(p => ({ type: "player", id: p.id, name: p.name })).slice(0, 5);
    if (fromTennis.length) return fromTennis;

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

  async function nextOrPrevEventsForPlayer(id) {
    try {
      const d = await fetchJsonSmart(`${base}/player/${id}/events/next/0`);
      if (Array.isArray(d?.events) && d.events.length) return d.events;
    } catch {}
    try {
      const d = await fetchJsonSmart(`${base}/player/${id}/events/previous/0`);
      if (Array.isArray(d?.events) && d.events.length) return d.events;
    } catch {}
    return [];
  }

  function sig(ev) {
    const h = normalizePlain(ev?.homeTeam?.name || "");
    const a = normalizePlain(ev?.awayTeam?.name || "");
    return h < a ? `${h} vs ${a}` : `${a} vs ${h}`;
  }

  // Estrategia combinada
  for (const combo of combinedQueries.slice(0, 6)) {
    try {
      const cands = await topTennisCandidates(combo);
      const eventsById = {};
      await Promise.all(
        cands.slice(0, 3).map(async c => (eventsById[c.id] = await nextOrPrevEventsForPlayer(c.id)))
      );
      for (const evs of Object.values(eventsById)) {
        for (const ev of evs) {
          const home = normalizePlain(ev?.homeTeam?.name || "");
          const away = normalizePlain(ev?.awayTeam?.name || "");
          const hasLeft = leftVars.some(v => home.includes(v) || away.includes(v));
          const hasRight = rightVars.some(v => home.includes(v) || away.includes(v));
          if (hasLeft && hasRight) {
            const tournament = ev?.tournament?.name || ev?.season?.name || "";
            const startIso = ev?.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : null;
            return { tournament, startIso };
          }
        }
      }
    } catch (e) {
      logD("A-fail", combo, e.message);
    }
  }
  return null;
}

// === ROUTES ===

// Upload URL (mock)
app.post("/upload-url", async (req, res) => {
  const { filename } = req.body;
  return res.json({
    uploadUrl: `https://fileserver.local/${filename}`,
    publicUrl: `https://fileserver.local/${filename}`
  });
});

// Parse Rows
app.post("/parse-rows", async (req, res) => {
  const { image_url, tipster_id } = req.body;
  const upstream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Extrae los datos estructurados del ticket de apuesta."
      },
      {
        role: "user",
        content: `Imagen: ${image_url}`
      }
    ]
  });

  const parsed = JSON.parse(upstream.choices[0].message.content || "{}");
  const rows = [];
  const updates = [];

  for (const sel of parsed.selections || []) {
    let fechaISO = sel.fecha_hora_iso || null;
    const fechaTxt = sel.fecha_hora_texto || "";

    if (!fechaISO && fechaTxt) {
      const iso = resolveRelativeDate(fechaTxt);
      if (iso) fechaISO = iso;
    }

    const found = await enrichGenericSelection({ partido: sel.partido });
    if (found) {
      if (!fechaISO && found.startIso) fechaISO = found.startIso;
      if (!sel.torneo && found.tournament) sel.torneo = found.tournament;
    }

    const casaLimpia = cleanBookmaker(sel.casa_apuestas || parsed.bookmaker, tipster_id) || null;

    if (sel.selection_id) {
      const updateObj = { id: sel.selection_id };
      if (fechaISO) updateObj.start_time_utc = new Date(fechaISO);
      if (sel.torneo) updateObj.tournament = sel.torneo;
      if (casaLimpia !== (sel.casa_apuestas || parsed.bookmaker))
        updateObj.bookmaker = casaLimpia;
      updates.push(updateObj);
    }

    rows.push({
      Partido: sel.partido,
      Torneo: sel.torneo || "",
      "Fecha y hora": fechaISO
        ? new Date(fechaISO).toLocaleString("es-ES", {
            dateStyle: "medium",
            timeStyle: "short"
          })
        : fechaTxt || "(pendiente)",
      Mercado: sel.mercado,
      Apuesta: sel.apuesta,
      Cuota: sel.cuota,
      "Casa de apuestas": casaLimpia || "",
      _betslip_id: parsed.betslip_id,
      _selection_id: sel.selection_id || null,
      _fecha_hora_iso: fechaISO || null,
      _fecha_hora_texto: fechaTxt || ""
    });
  }

  if (updates.length) {
    await Promise.all(updates.map(u => supabase.from("bet_selections").update(u).eq("id", u.id)));
  }

  res.json(rows);
});

// === Debug endpoint ===
app.get("/debug-enrich", async (req, res) => {
  try {
    const partido = req.query.partido || "";
    const found = await enrichGenericSelection({ partido });
    res.json({ ok: true, partido, found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Server start ===
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
