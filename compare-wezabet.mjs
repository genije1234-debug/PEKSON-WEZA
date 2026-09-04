/**
 * compare-wezabet.mjs – Bwin (3200) protiv bržeg WezaBet izvora
 * Node 3301 + Chrome 3303. Port 3302. Sokabet se ne dira.
 *
 * GK/GG = koji WezaBet prvi javi (Node ili Chrome).
 * Merenje kreće SAMO kad je Bwin ispred bar jednog WezaBet score-a.
 */

import http from "http";

const PORT      = Number(process.env.PORT || 3302);
const BWIN_API  = process.env.BWIN_API || "http://localhost:3200/data";
const WEZ_API   = process.env.WEZ_API || "http://localhost:3301/feed";
const WEZ_CHROME_API = process.env.WEZ_CHROME_API || "http://localhost:3303/feed";
const POLL_MS   = Number(process.env.POLL_MS || 150);
const FETCH_MS  = Number(process.env.FETCH_MS || 5000);
const MAX_HIST  = 300;

const TG_TOKEN   = process.env.TG_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const TG_URL     = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(TG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("Telegram greška:", e.message);
  }
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "Cache-Control": "no-store" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
}

const NOISE = new Set([
  "fc", "fk", "ac", "as", "cd", "sc", "cf", "if", "ca", "ia", "bk", "sk", "nk", "ok",
  "the", "and", "de", "la", "el", "los", "las", "del", "von", "van",
]);

// Prag je 4: na 3 znaka "u20"/"u21" postaju validan token i uparuju bilo koja
// dva omladinska meca (npr. America U20 ↔ Parnamirim U20).
function tokens(name) {
  return norm(name).split(/\s+/).filter(w => w.length >= 4 && !NOISE.has(w));
}

function overlapCount(a, b) {
  return a.filter(t => b.includes(t)).length;
}

// Uzrast / zenski / rezerve nisu dokaz da je meč isti, ali moraju da se poklope.
function qualifier(name) {
  const n = norm(name);
  const age = n.match(/\b(u1[5-9]|u2[0-3])\b/);
  if (age) return age[1];
  if (/\b(w|women|womens|ladies|fem|feminine)\b/.test(n)) return "w";
  if (/\b(res|reserve|reserves|ii)\b/.test(n)) return "res";
  return "";
}

function splitTeams(matchName) {
  const s = String(matchName ?? "");
  const vs = s.match(/\s+vs\.?\s+/i);
  if (vs && vs.index >= 0) {
    return [s.slice(0, vs.index), s.slice(vs.index + vs[0].length)];
  }
  const idx = s.indexOf(" - ");
  if (idx > 0) return [s.slice(0, idx), s.slice(idx + 3)];
  const v2 = s.indexOf(" v ");
  if (v2 > 0) return [s.slice(0, v2), s.slice(v2 + 3)];
  return [s, ""];
}

function leagueSim(bwinComp, bwinRegion, sokaLeague) {
  const bTok = tokens(norm(bwinRegion) + " " + norm(bwinComp));
  const aTok = tokens(norm(sokaLeague));
  return bTok.filter(t => aTok.includes(t)).length;
}

const parseCache = new Map();

function parsedName(name) {
  let p = parseCache.get(name);
  if (!p) {
    const [h, a] = splitTeams(name);
    p = { home: tokens(h), away: tokens(a), qual: qualifier(name) };
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(name, p);
  }
  return p;
}

// U prijateljskim se liga zove "World / Club Friendly" na obe strane, pa poklapanje
// lige tamo ne znaci nista i jednostrano uparivanje bi bilo nagadjanje.
function isFriendly(bwin, soka) {
  const s = norm(`${bwin.competition ?? ""} ${bwin.region ?? ""} ${soka.league ?? ""}`);
  return /friendl/.test(s);
}

function pairScore(bwin, soka) {
  const b = parsedName(bwin.name ?? "");
  const s = parsedName(soka.name ?? "");
  if (b.qual !== s.qual) return 0;

  const dh = overlapCount(b.home, s.home), da = overlapCount(b.away, s.away);
  const rh = overlapCount(b.home, s.away), ra = overlapCount(b.away, s.home);
  const dSides = Number(dh > 0) + Number(da > 0);
  const rSides = Number(rh > 0) + Number(ra > 0);
  const useDirect = dSides > rSides || (dSides === rSides && dh + da >= rh + ra);
  const sides = useDirect ? dSides : rSides;
  const toks  = useDirect ? dh + da : rh + ra;
  if (!sides) return 0;

  const lg = leagueSim(bwin.competition ?? "", bwin.region ?? "", soka.league ?? "");
  // Skracenice ispod 4 znaka (Abb, TSC) nemaju ni jedan token, pa im ta strana nikad
  // ne moze da se poklopi; jedna strana + liga ih spasava u pravim ligama.
  if (sides < 2 && (lg < 1 || isFriendly(bwin, soka))) return 0;

  // Dve strane uvek biju jednu, pa jednostrani parovi uzimaju samo ostatak.
  return sides * 1000 + toks * 10 + lg;
}

// Ekskluzivno uparivanje: najjaci parovi prvi, svaki mec sa obe strane samo jednom.
function buildPairs(bwinSlots, sokaList) {
  const cand = [];
  for (const bwin of bwinSlots) {
    for (const soka of sokaList) {
      const score = pairScore(bwin, soka);
      if (score > 0) cand.push({ bwin, soka, score });
    }
  }
  cand.sort((a, b) => b.score - a.score);

  const usedBwin = new Set(), usedSoka = new Set();
  const out = [];
  for (const c of cand) {
    if (usedBwin.has(c.bwin.id) || usedSoka.has(c.soka.id)) continue;
    usedBwin.add(c.bwin.id);
    usedSoka.add(c.soka.id);
    out.push(c);
  }
  return out;
}

function parseScore(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\D+(\d+)/);
  if (!m) return null;
  return { home: +m[1], away: +m[2], total: +m[1] + +m[2] };
}

function sokaSuspended(soka) {
  return !!(soka.betSusp || soka.suspended);
}

function sokaOdds(soka) {
  const o = soka.odds || {};
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 1 ? n : null;
  };
  return {
    home: num(o.home ?? o["1"]),
    draw: num(o.draw ?? o.X ?? o.x),
    away: num(o.away ?? o["2"]),
  };
}

const pairState = new Map();
const history = [];
let latestPairs = [];
let feedStatus = {
  sokaOk: false, sokaErr: "start", sokaStale: 0, bwinOk: false, ts: 0,
  nodeOk: false, chromeOk: false, nodeErr: "", chromeErr: "",
};

function addOrUpdateHist(entry) {
  if (!history.includes(entry)) {
    history.unshift(entry);
    if (history.length > MAX_HIST) history.pop();
  }
}

function unwrapSoka(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.matches)) return data.matches;
  return [];
}

function readFeed(data, failMsg) {
  if (failMsg) return { all: [], live: [], ok: false, err: failMsg };
  const all = unwrapSoka(data);
  const ok = Array.isArray(data) ? true : data?.ok !== false;
  return {
    all,
    live: ok ? all.filter(m => !m.stale) : [],
    ok,
    err: ok ? "" : (data?.err || "greska"),
  };
}

function firstSuspAfter(goalTs, ...named) {
  let best = null;
  for (const { m, via } of named) {
    if (!m || !sokaSuspended(m)) continue;
    const t = (m.suspTs && m.suspTs >= goalTs) ? m.suspTs : Date.now();
    if (!best || t < best.t) best = { t, via };
  }
  return best;
}

function firstScoreCatch(goalTs, bwinScore, ...named) {
  const bs = parseScore(bwinScore);
  if (!bs) return null;
  let best = null;
  for (const { m, via } of named) {
    if (!m) continue;
    const as = parseScore(m.score);
    if (!as || as.total < bs.total) continue;
    const t = (m.scoreTs && m.scoreTs >= goalTs) ? m.scoreTs : Date.now();
    if (!best || t < best.t) best = { t, via, score: m.score };
  }
  return best;
}

function raceView(nodeM, chromeM) {
  const srcs = [];
  if (nodeM) srcs.push({ m: nodeM, via: "node" });
  if (chromeM) srcs.push({ m: chromeM, via: "chrome" });
  if (!srcs.length) return null;

  let scorePick = srcs[0];
  for (const s of srcs) {
    const a = parseScore(scorePick.m.score);
    const b = parseScore(s.m.score);
    if (b && (!a || b.total > a.total || (b.total === a.total && (s.m.scoreTs || 0) > (scorePick.m.scoreTs || 0)))) {
      scorePick = s;
    }
  }
  const oddsPick = srcs.find(s => !sokaSuspended(s.m)) || srcs[0];
  const anySusp = srcs.some(s => sokaSuspended(s.m));
  return {
    id: nodeM?.id || chromeM?.id,
    name: nodeM?.name || chromeM?.name,
    league: nodeM?.league || chromeM?.league,
    score: scorePick.m.score,
    suspended: anySusp,
    odds: sokaOdds(oddsPick.m),
    oddsSupp: oddsPick.m.oddsSupp ?? {},
    via: srcs.length === 2 ? "node+chrome" : srcs[0].via,
  };
}

async function doPoll() {
  const [bwinRes, nodeRes, chromeRes] = await Promise.allSettled([
    getJson(BWIN_API),
    getJson(WEZ_API),
    getJson(WEZ_CHROME_API),
  ]);

  if (bwinRes.status !== "fulfilled") {
    feedStatus = {
      ...feedStatus,
      sokaOk: false,
      sokaErr: bwinRes.reason?.message || "bwin fetch",
      bwinOk: false,
      ts: Date.now(),
    };
    return;
  }

  const bwinData = bwinRes.value;
  const node = readFeed(
    nodeRes.status === "fulfilled" ? nodeRes.value : null,
    nodeRes.status === "fulfilled" ? "" : (nodeRes.reason?.message || "node fetch"),
  );
  const chrome = readFeed(
    chromeRes.status === "fulfilled" ? chromeRes.value : null,
    chromeRes.status === "fulfilled" ? "" : (chromeRes.reason?.message || "chrome fetch"),
  );

  const bwinSlots = bwinData?.slots ?? [];
  const sokaOk = node.ok || chrome.ok;
  const sokaStale = (node.all.length - node.live.length) + (chrome.all.length - chrome.live.length);

  feedStatus = {
    sokaOk,
    sokaErr: sokaOk ? "" : [node.err, chrome.err].filter(Boolean).join(" / ") || "greska",
    sokaStale,
    bwinOk: bwinSlots.length > 0,
    ts: Date.now(),
    nodeOk: node.ok,
    chromeOk: chrome.ok,
    nodeErr: node.err,
    chromeErr: chrome.err,
  };

  if (!sokaOk) return;

  if ((node.all.length + chrome.all.length) > 0 && node.live.length === 0 && chrome.live.length === 0) return;

  const nodePairs = buildPairs(bwinSlots, node.live);
  const chromePairs = buildPairs(bwinSlots, chrome.live);
  const byBwin = new Map();
  for (const p of nodePairs) byBwin.set(p.bwin.id, { bwin: p.bwin, nodeM: p.soka, chromeM: null });
  for (const p of chromePairs) {
    const cur = byBwin.get(p.bwin.id);
    if (cur) cur.chromeM = p.soka;
    else byBwin.set(p.bwin.id, { bwin: p.bwin, nodeM: null, chromeM: p.soka });
  }

  const activeBwinIds = new Set();
  const pairs = [];

  for (const { bwin, nodeM, chromeM } of byBwin.values()) {
    const key = bwin.id;
    activeBwinIds.add(key);
    const raced = raceView(nodeM, chromeM);
    if (!raced) continue;
    const named = [
      { m: nodeM, via: "node" },
      { m: chromeM, via: "chrome" },
    ];

    if (!pairState.has(key)) {
      pairState.set(key, {
        sokaId:        raced.id,
        lastGoalTs:    bwin.goalTs ?? 0,
        bwinGoalTs:    null,
        bwinGoalScore: null,
        gkDone:        false,
        ggDone:        false,
        prevRealSusp:  false,
        histEntry:     null,
      });
    }

    const st = pairState.get(key);
    st.sokaId = raced.id;

    {
      const bs = parseScore(bwin.score);
      const wezScores = named.map(s => s.m && parseScore(s.m.score)).filter(Boolean);
      const gTs = bwin.goalTs ?? 0;
      const bwinAheadSome = !!(bs && wezScores.some(as => bs.total > as.total));

      if (gTs > st.lastGoalTs) {
        st.lastGoalTs = gTs;
        if (bwinAheadSome) {
          st.bwinGoalTs    = gTs;
          st.bwinGoalScore = bwin.score;
          st.ggDone        = false;
          const already = named.filter(s => s.m && sokaSuspended(s.m));
          st.gkDone = already.length > 0;
          st.histEntry = {
            ts:        new Date().toLocaleTimeString("sr"),
            matchName: bwin.name,
            goalScore: bwin.score,
            gk:        already.length ? "0.00" : null,
            gkPre:     already.length > 0,
            gkVia:     already.length ? already.map(s => s.via).join("+") : null,
            gg:        null,
            ggVia:     null,
          };
          addOrUpdateHist(st.histEntry);
          console.log(`[GOL] ${bwin.name}  Bwin:${bwin.score}  Wez:${raced.score ?? "-"}${already.length ? "  (bio suspendovan i pre gola)" : ""}`);
        }
      }

      const realSuspNow = named.some(s => s.m && sokaSuspended(s.m));
      if (st.bwinGoalTs && !st.gkDone && realSuspNow && !st.prevRealSusp) {
        const hit = firstSuspAfter(st.bwinGoalTs, ...named);
        const suspAt = hit ? hit.t : Date.now();
        const gk = ((suspAt - st.bwinGoalTs) / 1000).toFixed(2);
        st.gkDone = true;
        if (st.histEntry) {
          st.histEntry.gk = gk;
          st.histEntry.gkVia = hit?.via || null;
        }
        console.log(`[GK] ${bwin.name}  ${gk}s  ${hit?.via || ""}`);
      }
      st.prevRealSusp = realSuspNow;

      if (st.bwinGoalTs && !st.ggDone) {
        const hit = firstScoreCatch(st.bwinGoalTs, bwin.score, ...named);
        if (hit) {
          const gg = ((hit.t - st.bwinGoalTs) / 1000).toFixed(2);
          st.ggDone = true;
          if (st.histEntry) {
            st.histEntry.gg = gg;
            st.histEntry.ggVia = hit.via;
          }
          console.log(`[GG] ${bwin.name}  ${gg}s  ${hit.via}`);
          const gk = st.histEntry?.gk ?? "?";
          const goalScore = st.histEntry?.goalScore ?? bwin.score;
          const gkNum = parseFloat(gk);
          if (Number.isFinite(gkNum) && gkNum >= 2) {
            sendTelegram(`🟡🟡🟡🟡🟡\n⚡ <b>${bwin.name}</b>\n${goalScore}\nGK: ${gk}s | GG: ${gg}s\n🟡🟡🟡🟡🟡`);
          } else {
            console.log(`[TG skip] ${bwin.name}  GK=${gk}s < 2s → ne šaljem`);
          }
        }
      }
    }

    const bs = parseScore(bwin.score);
    const as = parseScore(raced.score);
    const bwinAhead = bs && as ? bs.total > as.total : false;

    pairs.push({
      bwinId:     bwin.id,
      sokaId:     raced.id,
      name:       bwin.name,
      sokaName:   raced.name,
      bwinLeague: (bwin.region ? bwin.region + " – " : "") + (bwin.competition ?? ""),
      sokaLeague: raced.league ?? "",
      bwinScore:  bwin.score ?? "-",
      sokaScore:  raced.score ?? "-",
      bwinAhead,
      odds: raced.odds,
      oddsSupp: raced.oddsSupp,
      suspended: raced.suspended,
      wezVia: raced.via,
    });
  }

  for (const k of pairState.keys()) {
    if (!activeBwinIds.has(k)) pairState.delete(k);
  }

  pairs.sort((a, b) => a.name.localeCompare(b.name));
  latestPairs = pairs;
}

async function loop() {
  while (true) {
    try { await doPoll(); } catch (e) { console.error("[poll]", e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bwin ↔ WezaBet (brži)</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
h2{padding:8px 12px;font-size:14px;color:#58a6ff;border-bottom:1px solid #21262d;flex-shrink:0}
#top{flex:1 1 auto;overflow-y:auto;min-height:0}
#bot{flex:0 0 220px;border-top:2px solid #21262d;overflow-y:auto}
#bot h2{background:#0d1117;position:sticky;top:0;z-index:1}
table{width:100%;border-collapse:collapse}
thead th{background:#161b22;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5px 8px;text-align:left;border-bottom:1px solid #21262d;position:sticky;top:0;z-index:1}
tbody tr{border-bottom:1px solid #161b22}
tbody tr:hover{background:#161b22}
td{padding:5px 8px;vertical-align:middle}
.leagues{font-size:10px;color:#484f58}
.name{font-weight:600;font-size:13px}
.score{font-family:monospace;font-size:15px;font-weight:700;text-align:center}
.score.ahead{color:#ff4040}
.score.ok{color:#e6edf3}
.odd{text-align:center;min-width:52px;font-weight:600;font-size:14px;padding:3px 6px;border-radius:3px}
.odd.ok{color:#e6edf3;background:#161b22}
.odd.susp{color:#5a3030;background:#1a0a0a;text-decoration:line-through}
.paired{font-size:10px;color:#484f58;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hist-body{padding:4px 0}
.hrow{padding:4px 12px;border-bottom:1px solid #161b22;font-size:12px;color:#c9d1d9;display:flex;gap:12px;align-items:center}
.hrow .ht{color:#484f58;width:70px;flex-shrink:0}
.hrow .hname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .hscore{color:#8b949e;width:60px;flex-shrink:0;text-align:center}
.gk{color:#f0883e;font-weight:600}
.gg{color:#3fb950;font-weight:600}
.pending{color:#484f58;font-style:italic}
#updated{position:fixed;bottom:4px;right:10px;font-size:10px;color:#484f58}
</style>
</head>
<body>
<div id="top">
  <h2>⚽ Bwin ↔ WezaBet (brži Node/Chrome) <span id="cnt" style="font-size:11px;color:#8b949e;font-weight:normal"></span><span id="feed" style="font-size:11px;font-weight:normal;float:right"></span></h2>
  <table>
    <thead>
      <tr>
        <th>Meč</th>
        <th>Score Bwin</th>
        <th>Score WezaBet</th>
        <th style="text-align:center">1</th>
        <th style="text-align:center">X</th>
        <th style="text-align:center">2</th>
        <th>Liga (WezaBet)</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<div id="bot">
  <h2>📋 Istorija GK / GG</h2>
  <div id="hist-body"></div>
</div>
<div id="updated"></div>
<script>
const tbody = document.getElementById("tbody");
const histBody = document.getElementById("hist-body");
const cntEl = document.getElementById("cnt");
const feedEl = document.getElementById("feed");
const updEl = document.getElementById("updated");

function fmtOdd(v){ return v && v > 1 ? Number(v).toFixed(2) : "-"; }

function oddCell(val, susp, evSupp){
  if(evSupp || susp) return \`<td class="odd susp">\${fmtOdd(val)}</td>\`;
  return \`<td class="odd ok">\${fmtOdd(val)}</td>\`;
}

function render(data){
  const pairs = data.pairs || [];
  const hist  = data.history || [];
  cntEl.textContent = "(" + pairs.length + " parova)";

  const st = data.status || {};
  function dot(ok, name, err){
    return ok
      ? '<span style="color:#3fb950">'+name+' OK</span>'
      : '<span style="color:#f85149">'+name+' PAO'+(err?': '+err:'')+'</span>';
  }
  if(st.sokaOk === false){
    feedEl.innerHTML = '<span style="color:#f85149">WezaBet PAO – merenje stoji</span> · '+dot(st.nodeOk,'Node',st.nodeErr)+' · '+dot(st.chromeOk,'Chrome',st.chromeErr);
  } else {
    feedEl.innerHTML = dot(st.nodeOk,'Node',st.nodeErr)+' · '+dot(st.chromeOk,'Chrome',st.chromeErr);
  }

  const existRows = new Map([...tbody.querySelectorAll("tr")].map(r=>[r.dataset.id, r]));
  const seen = new Set();
  pairs.forEach(p => {
    seen.add(p.bwinId);
    const html = \`
      <td>
        <div class="name">\${p.name}</div>
        <div class="paired">\${p.bwinLeague}</div>
      </td>
      <td class="score \${p.bwinAhead ? 'ahead' : 'ok'}">\${p.bwinScore}</td>
      <td class="score ok">\${p.sokaScore}<div class="leagues">\${p.wezVia||''}</div></td>
      \${oddCell(p.odds.home, p.oddsSupp.home, p.suspended)}
      \${oddCell(p.odds.draw, p.oddsSupp.draw, p.suspended)}
      \${oddCell(p.odds.away, p.oddsSupp.away, p.suspended)}
      <td class="leagues">\${p.sokaLeague}</td>
    \`;
    let row = existRows.get(p.bwinId);
    if(!row){
      row = document.createElement("tr");
      row.dataset.id = p.bwinId;
      tbody.appendChild(row);
    }
    row.innerHTML = html;
  });
  for(const [id, row] of existRows){
    if(!seen.has(id)) row.remove();
  }

  histBody.innerHTML = hist.map(h => {
    const gk = h.gkPre
      ? \`<span class="pending">GK: bio susp.\${h.gkVia?' ('+h.gkVia+')':''}</span>\`
      : h.gk != null ? \`<span class="gk">GK: \${h.gk}s\${h.gkVia?' ('+h.gkVia+')':''}</span>\` : \`<span class="pending">GK: ...</span>\`;
    const gg = h.gg != null ? \`<span class="gg">GG: \${h.gg}s\${h.ggVia?' ('+h.ggVia+')':''}</span>\` : \`<span class="pending">GG: ...</span>\`;
    return \`<div class="hrow">
      <span class="ht">\${h.ts}</span>
      <span class="hname" title="\${h.matchName}">\${h.matchName}</span>
      <span class="hscore">\${h.goalScore}</span>
      \${gk}
      \${gg}
    </div>\`;
  }).join("");

  updEl.textContent = new Date().toLocaleTimeString("sr");
}

async function poll(){
  try{
    const r = await fetch("/api");
    if(r.ok) render(await r.json());
  } catch(e){}
  setTimeout(poll, 300);
}
poll();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const u = (req.url || "/").split("?")[0];
  if (u === "/api") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ pairs: latestPairs, history, status: feedStatus }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`Compare Bwin ↔ WezaBet → http://localhost:${PORT}`);
  if (process.env.WEZ_TG_TEST === "1") {
    sendTelegram(`🟡🟡🟡🟡🟡\n⚡ <b>CS 2 de Mayo - Sportivo Luqueno</b>\n1:0\nGK: 2.84s | GG: 4.12s\n🟡🟡🟡🟡🟡`);
    console.log("[TG] probni signal poslat");
  }
  loop();
});
