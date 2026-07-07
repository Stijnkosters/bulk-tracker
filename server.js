import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ---- Opslag: JSON-bestand op persistent volume (DATA_DIR), val terug op lokale map ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "tracker.json");

const DEFAULT_SETTINGS = {
  target_kcal: 3100,
  target_protein: 160,
  target_fat: 95,
  target_carbs: 400,
  start_weight: 72,
  goal_weight: 80,
  weekly_rate_min: 0.2,
  weekly_rate_max: 0.3,
};

function loadDB() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      logs: raw.logs || {},
      templates: Array.isArray(raw.templates) ? raw.templates : [],
      reviews: raw.reviews || {},
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, logs: {}, templates: [], reviews: {} };
  }
}
function saveDB(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomair, voorkomt corruptie
}

let DB = loadDB();
saveDB(DB);

const num = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(String(v).trim().replace(",", "."));
  return isNaN(n) ? null : n;
};
const fmtDate = (d) => d.toISOString().slice(0, 10);

function logsAscending() {
  return Object.values(DB.logs).sort((a, b) => a.date.localeCompare(b.date));
}

function rollingWeight(asc, endIdx, win = 7) {
  const vals = [];
  for (let i = endIdx; i >= 0 && vals.length < win; i--) {
    if (typeof asc[i]?.weight === "number") vals.push(asc[i].weight);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Weektempo via lineaire regressie over laatste ≤14 weegmomenten (kg/week)
function weeklyRateTrend(asc) {
  const pts = asc.filter((l) => typeof l.weight === "number").slice(-14);
  if (pts.length < 5) return null;
  const x0 = new Date(pts[0].date).getTime();
  const xs = pts.map((p) => (new Date(p.date).getTime() - x0) / 86400000);
  const ys = pts.map((p) => p.weight);
  const n = pts.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return ((n * sxy - sx * sy) / denom) * 7;
}

function buildWeeklySummary() {
  const settings = DB.settings;
  const today = new Date();
  const last7Dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    last7Dates.push(fmtDate(d));
  }
  const days = last7Dates.map((dt) => DB.logs[dt] || { date: dt });
  const filled = days.filter((d) => d.kcal != null);
  const avg = (key) =>
    filled.length ? filled.reduce((a, b) => a + (b[key] || 0), 0) / filled.length : null;

  const weightLogs = logsAscending().filter((l) => typeof l.weight === "number");
  const currentAvg = weightLogs.length ? rollingWeight(weightLogs, weightLogs.length - 1, 7) : null;
  const weeklyRate = weeklyRateTrend(weightLogs);
  const latestWeight = weightLogs.length ? weightLogs[weightLogs.length - 1].weight : null;

  return {
    settings,
    daysLogged: filled.length,
    averages: { kcal: avg("kcal"), protein: avg("protein"), fat: avg("fat"), carbs: avg("carbs") },
    weight: { latest: latestWeight, sevenDayAvg: currentAvg, weeklyRate },
    days,
  };
}

// ---- API ----
app.get("/api/state", (req, res) => {
  const logs = logsAscending().reverse().slice(0, 90);
  res.json({ settings: DB.settings, logs, templates: DB.templates || [] });
});

// ---- Trainingsschema's (templates) ----
app.post("/api/templates", (req, res) => {
  const b = req.body || {};
  const name = (b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Naam ontbreekt" });
  const exercises = Array.isArray(b.exercises)
    ? b.exercises
        .map((e) => (typeof e === "string"
          ? { name: e.trim(), note: "" }
          : { name: String(e.name || "").trim(), note: String(e.note || "").trim() }))
        .filter((e) => e.name)
    : [];
  DB.templates = DB.templates || [];
  if (b.id) {
    const idx = DB.templates.findIndex((t) => t.id === b.id);
    if (idx >= 0) DB.templates[idx] = { id: b.id, name, exercises };
    else DB.templates.push({ id: b.id, name, exercises });
  } else {
    DB.templates.push({ id: "tpl_" + Date.now(), name, exercises });
  }
  saveDB(DB);
  res.json({ ok: true, templates: DB.templates });
});

app.delete("/api/templates/:id", (req, res) => {
  DB.templates = (DB.templates || []).filter((t) => t.id !== req.params.id);
  saveDB(DB);
  res.json({ ok: true, templates: DB.templates });
});

// ---- Weekoverzicht & zondag-review ----
function weekStartOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // 0 = maandag
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function isoWeekNum(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // donderdag van die week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const jday = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(jan4.getUTCDate() - jday + 3);
  return 1 + Math.round((d - jan4) / (7 * 86400000));
}

function buildWeekAgg(weekStart) {
  const start = new Date(weekStart + "T00:00:00Z");
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    days.push(DB.logs[ds] || { date: ds });
  }
  const filled = days.filter((x) => x.kcal != null);
  const avg = (k) => (filled.length ? filled.reduce((a, b) => a + (b[k] || 0), 0) / filled.length : null);
  const weights = days.filter((x) => typeof x.weight === "number").map((x) => x.weight);
  const avgWeight = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null;
  const trainingDays = days.filter((x) => (x.training && String(x.training).trim()) || (x.exercises && x.exercises.length)).length;
  return {
    weekStart,
    weekEnd: days[6].date,
    weekNum: isoWeekNum(weekStart),
    daysLogged: filled.length,
    avg: { kcal: avg("kcal"), protein: avg("protein"), fat: avg("fat"), carbs: avg("carbs") },
    avgWeight,
    weighIns: weights.length,
    trainingDays,
    days,
  };
}

app.get("/api/weeks", (req, res) => {
  const all = logsAscending();
  if (!all.length) return res.json({ weeks: [] });
  const firstWeek = weekStartOf(all[0].date);
  const curWeek = weekStartOf(new Date().toISOString().slice(0, 10));
  const weeks = [];
  let w = firstWeek;
  let prev = null;
  while (w <= curWeek) {
    const agg = buildWeekAgg(w);
    agg.weightChange = agg.avgWeight != null && prev?.avgWeight != null ? agg.avgWeight - prev.avgWeight : null;
    agg.review = DB.reviews?.[w] || null;
    weeks.push(agg);
    prev = agg;
    const d = new Date(w + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 7);
    w = d.toISOString().slice(0, 10);
  }
  weeks.reverse(); // nieuwste eerst
  res.json({ weeks });
});

app.post("/api/review", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const week = weekStartOf(((req.body || {}).week || new Date().toISOString().slice(0, 10)));
  const cur = buildWeekAgg(week);
  const prevStart = (() => { const d = new Date(week + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); })();
  const prev = buildWeekAgg(prevStart);
  const s = DB.settings;
  const asc = logsAscending().filter((l) => typeof l.weight === "number");
  const trend = weeklyRateTrend(asc);
  const r = (v, d = 0) => (v == null ? "—" : Number(v).toFixed(d));

  if (!apiKey) {
    return res.status(400).json({ error: "Geen ANTHROPIC_API_KEY ingesteld op Railway.", week: cur });
  }

  const wk = (a, label) => `${label} (${a.weekStart} t/m ${a.weekEnd}, ${a.daysLogged}/7 gelogd, ${a.trainingDays} trainingsdagen):
- Gem. kcal ${r(a.avg.kcal)} | eiwit ${r(a.avg.protein)} g | vet ${r(a.avg.fat)} g | koolh ${r(a.avg.carbs)} g
- Gem. gewicht: ${r(a.avgWeight, 1)} kg (${a.weighIns} weegmomenten)
Dagen: ${a.days.map((d) => `${d.date.slice(5)}: ${d.kcal != null ? `${r(d.kcal)}kcal E${r(d.protein)}/V${r(d.fat)}/K${r(d.carbs)}` : "niet gelogd"}${d.weight ? ` ${d.weight}kg` : ""}${d.training ? ` [${d.training}]` : ""}`).join("\n")}`;

  const dataBlock = `PROFIEL: Stijn, 22 jr, 1.86 m. Lean bulk: start ${s.start_weight} kg, doel ${s.goal_weight} kg lean met behoud sixpack.
HUIDIGE TARGETS: ${s.target_kcal} kcal · eiwit ${s.target_protein} g · vet ${s.target_fat} g · koolh ${s.target_carbs} g.
STREEFTEMPO: +${s.weekly_rate_min}-${s.weekly_rate_max} kg/week.
GEWICHTSTREND (regressie laatste ~2 wk): ${trend == null ? "nog onvoldoende data" : (trend > 0 ? "+" : "") + r(trend, 2) + " kg/week"}
GEWICHTSVERANDERING vs vorige week: ${cur.weightChange == null ? (cur.avgWeight != null && prev.avgWeight != null ? r(cur.avgWeight - prev.avgWeight, 2) + " kg" : "—") : (cur.weightChange > 0 ? "+" : "") + r(cur.weightChange, 2) + " kg"}

${wk(cur, "DEZE WEEK")}

${wk(prev, "VORIGE WEEK")}`;

  const system = `Je bent de fitnesscoach van Stijn, een directe e-commerce operator. Schrijf een wekelijkse zondag-beoordeling in het Nederlands. Direct, resultaatgericht, geen open deuren of motivatiespeeches. Wees eerlijk: lean bulk = +0,2-0,3 kg/week; sneller = vet erbij, trager = geen groei. Gebruik EXACT deze structuur met markdown-koppen:
## Observatie
Feiten uit de data, kort.
## Analyse
Wat betekent dit? Tempo vs streeftempo, macro-adherentie, patronen (bv. vet structureel te hoog).
## Verdict
Op koers / te snel / te traag — één regel met reden.
## Macro-aanpassing
Concreet: targets HOUDEN of WIJZIGEN. Bij wijzigen: geef exacte nieuwe cijfers (kcal/E/V/K) en waarom. Baseer +/-150 kcal aanpassingen op het gewichtstempo. Bij te weinig data: benoem en houd targets.
## Acties komende week
3-5 concrete acties.
## KPI's
Wat moet volgende week op de teller staan om succesvol te zijn.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: `Hier is mijn weekdata. Geef de zondag-beoordeling.\n\n${dataBlock}` }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data?.error?.message || "API-fout" });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    DB.reviews = DB.reviews || {};
    DB.reviews[week] = { text, created_at: new Date().toISOString() };
    saveDB(DB);
    res.json({ review: text, week });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/log", (req, res) => {
  const b = req.body || {};
  if (!b.date) return res.status(400).json({ error: "Datum ontbreekt" });
  DB.logs[b.date] = {
    date: b.date,
    weight: num(b.weight), kcal: num(b.kcal), protein: num(b.protein),
    fat: num(b.fat), carbs: num(b.carbs), waist: num(b.waist),
    training: b.training || null,
    exercises: Array.isArray(b.exercises)
      ? b.exercises.map((e) => ({
          name: e?.name || "",
          note: e?.note || "",
          sets: Array.isArray(e?.sets) ? e.sets.map((s) => ({ weight: num(s?.weight), reps: num(s?.reps) })) : [],
        }))
      : [],
    notes: b.notes || null,
    updated_at: new Date().toISOString(),
  };
  saveDB(DB);
  res.json({ ok: true });
});

app.delete("/api/log/:date", (req, res) => {
  delete DB.logs[req.params.date];
  saveDB(DB);
  res.json({ ok: true });
});

app.post("/api/settings", (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k in DEFAULT_SETTINGS) {
      const n = Number(String(v).trim().replace(",", "."));
      if (!isNaN(n)) DB.settings[k] = n;
    }
  }
  saveDB(DB);
  res.json({ ok: true, settings: DB.settings });
});

app.get("/api/summary", (req, res) => res.json(buildWeeklySummary()));

// ---- Export naar CSV (opent in Excel) ----
app.get("/api/export.csv", (req, res) => {
  const rows = logsAscending();
  const headers = ["datum", "gewicht_kg", "calorieen", "eiwit_g", "vet_g", "koolhydraten_g", "buik_cm", "training", "oefeningen", "notitie"];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const exText = (ex) =>
    (ex || [])
      .map((e) => `${e.name || ""}${e.note ? ` (${e.note})` : ""} ${(e.sets || []).map((s) => `${s.weight ?? ""}x${s.reps ?? ""}`).join("/")}`.trim())
      .join("; ");
  const lines = [headers.join(",")];
  for (const l of rows) {
    lines.push([l.date, l.weight, l.kcal, l.protein, l.fat, l.carbs, l.waist, l.training, exText(l.exercises), l.notes].map(esc).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n"); // BOM zodat Excel accenten goed leest
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leanbulk-export-${today}.csv"`);
  res.send(csv);
});

// ---- AI-weekfeedback via Anthropic API ----
app.post("/api/feedback", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const summary = buildWeeklySummary();
  if (!apiKey) {
    return res.status(400).json({
      error: "Geen ANTHROPIC_API_KEY ingesteld. Gebruik 'Kopieer weekdata' en plak in Claude.",
      summary,
    });
  }
  const s = summary.settings, a = summary.averages, w = summary.weight;
  const r = (v, d = 0) => (v == null ? "—" : Number(v).toFixed(d));

  const dataBlock = `
PROFIEL: 22 jr, 1.86 m, lean bulk. Start ${s.start_weight} kg, doel ${s.goal_weight} kg lean met behoud sixpack.
Streeftempo: +${s.weekly_rate_min}-${s.weekly_rate_max} kg/week (7-daags gemiddelde).
DAGTARGETS: ${s.target_kcal} kcal · eiwit ${s.target_protein} g · vet ${s.target_fat} g · koolhydraten ${s.target_carbs} g.

AFGELOPEN 7 DAGEN (${summary.daysLogged} dagen gelogd):
- Gem. kcal: ${r(a.kcal)} (target ${s.target_kcal})
- Gem. eiwit: ${r(a.protein)} g (target ${s.target_protein})
- Gem. vet: ${r(a.fat)} g (target ${s.target_fat})
- Gem. koolhydraten: ${r(a.carbs)} g (target ${s.target_carbs})
- Gewicht nu (7-daags gem.): ${r(w.sevenDayAvg, 1)} kg
- Weekverandering: ${w.weeklyRate == null ? "— (nog te weinig data)" : (w.weeklyRate > 0 ? "+" : "") + r(w.weeklyRate, 2) + " kg"}

DAGDETAIL:
${summary.days.map((d) => `${d.date}: ${d.kcal != null ? `${r(d.kcal)} kcal, E${r(d.protein)}/V${r(d.fat)}/K${r(d.carbs)}` : "niet gelogd"}${d.weight ? `, ${d.weight} kg` : ""}`).join("\n")}
`.trim();

  const system = `Je bent de fitnesscoach van Stijn, een directe e-commerce operator. Geef beknopte, resultaatgerichte weekfeedback in het Nederlands. Gebruik korte bullets en een concreet stappenplan. Geen open deuren, geen motivatiespeeches. Wees eerlijk: lean bulk = +0,2-0,3 kg/week, sneller betekent vet erbij. Beoordeel of hij op koers ligt op basis van gewichtstempo én macro's, en geef 3-5 concrete acties voor komende week. Benoem kort als er te weinig data is gelogd.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: `Hier is mijn weekdata:\n\n${dataBlock}\n\nGeef me je weekfeedback.` }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data?.error?.message || "API-fout", summary });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ feedback: text, summary });
  } catch (e) {
    res.status(500).json({ error: String(e), summary });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tracker draait op poort ${PORT}`));
