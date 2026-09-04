/**
 * Zajednički WezaBet live parser (Node WS i Chrome CDP).
 */

export const SPORT_FOOTBALL = 1;

export function createWezaFeed(opts = {}) {
  const STALE_MS = Number(opts.staleMs || process.env.WEZ_STALE_MS || 35000);
  const EXPIRE_MS = Number(opts.expireMs || 25000);
  const matches = new Map();
  let lastOk = null;
  let lastErr = "";
  let lastMsgAt = 0;
  let wsState = "down";
  let reconnects = 0;

  function selOpen(s) {
    return s && s.status === 1 && Number(s.price) > 1;
  }

  function pick1x2(market) {
    if (!market || !market.selections) return { o1: null, oX: null, o2: null };
    const list = Object.values(market.selections);
    const by = Object.fromEntries(list.map(s => [String(s.abbrv || "").toUpperCase(), s]));
    return {
      o1: by["1"] || list.find(s => s.order === 0) || null,
      oX: by["X"] || list.find(s => /draw/i.test(s.name || "")) || list.find(s => s.order === 1) || null,
      o2: by["2"] || list.find(s => s.order === 2) || null,
    };
  }

  function scoreFromBoard(sb) {
    if (!sb) return null;
    if (sb.result && Array.isArray(sb.result) && sb.result.length) {
      const h = sb.result.find(r => r.position === "home");
      const a = sb.result.find(r => r.position === "away");
      if (h && a && h.value != null && a.value != null) return `${h.value}-${a.value}`;
    }
    if (Array.isArray(sb.Results)) {
      const h = sb.Results.find(r => String(r.position) === "1" || r.position === "home");
      const a = sb.Results.find(r => String(r.position) === "2" || r.position === "away");
      if (h && a) return `${h.value ?? h.Value}-${a.value ?? a.Value}`;
    }
    return null;
  }

  function upsert(id, patch, now) {
    let m = matches.get(id);
    if (!m) {
      m = { id, _scoreTs: 0, _suspTs: 0, _prevScore: null, _prevSusp: null, _seen: now };
      matches.set(id, m);
    }
    Object.assign(m, patch);
    m._seen = now;
    return m;
  }

  function applyEvent(ev, extra = {}, now = Date.now()) {
    if (!ev || !ev.id) return;
    const sportId = Number(ev.sport?.id ?? extra.sportId ?? ev.sportId ?? 0);
    if (sportId && sportId !== SPORT_FOOTBALL) return;

    const markets = ev.markets && typeof ev.markets === "object" ? ev.markets : {};
    const m1 = markets["1"] || Object.values(markets).find(x => x && x.type === 1);
    const { o1, oX, o2 } = pick1x2(m1);
    const openN = [o1, oX, o2].filter(selOpen).length;
    const betStop = !!(ev.betStop ?? extra.betStop);
    const mktSusp = !!(m1 && m1.suspended);
    const suspended = betStop || mktSusp || !m1 || openN === 0;

    const sb = ev.scoreboard || ev.liveScore?.scoreboard || extra.scoreboard || null;
    const score = scoreFromBoard(sb) || extra.score || null;
    const league = [extra.region || ev.region?.name, extra.league || ev.league?.name].filter(Boolean).join(" / ");
    const homeN = selOpen(o1) ? Number(o1.price) : null;
    const drawN = selOpen(oX) ? Number(oX.price) : null;
    const awayN = selOpen(o2) ? Number(o2.price) : null;

    const m = upsert(String(ev.id), {
      name: ev.name || extra.name || "",
      league,
      country: extra.region || ev.region?.name || "",
      phase: sb?.period || ev.scoreboard?.period || extra.period || "",
      minute: sb?.time || ev.scoreboard?.time || extra.time || "",
      betStop,
      status: ev.status,
    }, now);
    if (sb) m._sb = sb;

    if (score != null) {
      if (m._prevScore != null && score !== m._prevScore) m._scoreTs = now;
      m._prevScore = score;
      m.score = score;
    } else if (!m.score) {
      m.score = "-";
    }

    if (m._prevSusp === false && suspended) m._suspTs = now;
    m._prevSusp = suspended;
    m.suspended = suspended;
    m.betSusp = suspended;
    m.odds = {
      home: homeN,
      draw: drawN,
      away: awayN,
      "1": homeN != null ? homeN.toFixed(2) : "-",
      X: drawN != null ? drawN.toFixed(2) : "-",
      "2": awayN != null ? awayN.toFixed(2) : "-",
    };
    m.oddsSupp = { home: homeN == null, draw: drawN == null, away: awayN == null };
  }

  function applyMarket(msg, now) {
    const id = String(msg.matchId || msg.payload?.eventId || "");
    if (!id || Number(msg.sportId) !== SPORT_FOOTBALL) return;
    const m = matches.get(id);
    if (!m) return;
    const market = msg.payload;
    if (!market) return;
    if (Number(market.type) === 1 || String(market.id) === "1") {
      applyEvent({
        id,
        name: m.name,
        markets: { 1: market },
        betStop: m.betStop,
        scoreboard: m._sb,
      }, { sportId: SPORT_FOOTBALL, region: m.country, league: (m.league || "").split(" / ").pop() }, now);
    }
  }

  function applyStat(msg, now) {
    const id = String(msg.matchId || "");
    if (!id || Number(msg.sportId) !== SPORT_FOOTBALL) return;
    const sb = msg.payload?.scoreboard;
    const m = matches.get(id);
    if (!m) return;
    m._sb = sb;
    const score = scoreFromBoard(sb);
    if (score != null) {
      if (m._prevScore != null && score !== m._prevScore) m._scoreTs = now;
      m._prevScore = score;
      m.score = score;
    }
    if (sb?.period) m.phase = sb.period;
    if (sb?.time) m.minute = sb.time;
    m._seen = now;
  }

  function handle(msg) {
    const now = Date.now();
    lastMsgAt = now;
    const t = msg?.data?.messageType ?? msg?.messageType;
    const data = msg?.data || msg;
    if (t === 0) return;
    if (t === 30 && Array.isArray(data.payload)) {
      if (data.payload.length === 0) return;
      const first = data.payload[0];
      const looksSoccer = first && (
        first.sport?.id == null ||
        Number(first.sport?.id ?? first.sportId ?? 1) === SPORT_FOOTBALL
      );
      const seen = new Set();
      for (const ev of data.payload) {
        const sid = Number(ev.sport?.id ?? ev.sportId ?? (looksSoccer ? 1 : 0));
        if (sid !== SPORT_FOOTBALL) continue;
        seen.add(String(ev.id));
        applyEvent(ev, { sportId: SPORT_FOOTBALL }, now);
      }
      for (const [id, m] of matches) {
        if (!seen.has(id) && now - (m._seen || 0) > EXPIRE_MS) matches.delete(id);
      }
      lastOk = new Date();
      lastErr = "";
      return;
    }
    if (t === 1 || t === 8) applyMarket(data, now);
    if (t === 2 || t === 7) applyStat(data, now);
    if (t === 3 || t === 6) {
      if (Number(data.sportId) === SPORT_FOOTBALL && data.payload) {
        applyEvent(data.payload, {
          sportId: SPORT_FOOTBALL,
          region: data.payload.region?.name,
          league: data.payload.league?.name,
        }, now);
      }
    }
    if (t === 4 && Number(data.sportId) === SPORT_FOOTBALL && data.matchId) {
      matches.delete(String(data.matchId));
    }
    if ((t === 16 || t === 19) && Number(data.sportId) === SPORT_FOOTBALL && data.matchId) {
      const m = matches.get(String(data.matchId));
      if (m) {
        if (!m.suspended) m._suspTs = now;
        m.betStop = true;
        m.suspended = true;
        m.betSusp = true;
        m._prevSusp = true;
        m._seen = now;
      }
    }
  }

  function ingest(raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (Array.isArray(d)) d.forEach(handle);
    else handle(d);
  }

  function matchList() {
    const now = Date.now();
    return [...matches.values()]
      .map(m => ({
        id: m.id,
        name: m.name,
        league: m.league,
        country: m.country,
        score: m.score || "-",
        phase: m.phase,
        minute: m.minute,
        suspended: !!m.suspended,
        betSusp: !!m.betSusp,
        odds: m.odds || {},
        oddsSupp: m.oddsSupp || {},
        scoreTs: m._scoreTs || 0,
        suspTs: m._suspTs || 0,
        age: Math.max(0, now - (m._seen || 0)),
        stale: wsState !== "up" || (lastMsgAt > 0 && now - lastMsgAt > STALE_MS),
        goalFlash: m._scoreTs > 0 && now - m._scoreTs < 5000,
      }))
      .sort((a, b) => {
        if (a.suspended !== b.suspended) return a.suspended ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
  }

  function payload() {
    const list = matchList();
    return {
      ts: lastOk ? lastOk.toISOString() : null,
      ok: wsState === "up" && !lastErr,
      err: lastErr,
      ws: wsState,
      lastMs: lastMsgAt ? Date.now() - lastMsgAt : 0,
      reconnects,
      count: list.length,
      suspended: list.filter(x => x.suspended).length,
      stale: list.filter(x => x.stale).length,
      matches: list,
    };
  }

  return {
    ingest,
    matchList,
    payload,
    health: () => ({ ok: wsState === "up", lastErr, ws: wsState, count: matches.size, lastMsgAt }),
    setWs(state, err) {
      wsState = state;
      if (err !== undefined) lastErr = err;
    },
    clearErr() { lastErr = ""; },
    bumpReconnect() { reconnects++; lastErr = ""; },
    get wsState() { return wsState; },
    get lastErr() { return lastErr; },
  };
}

export function wezaLiveHtml(title) {
  return `<!DOCTYPE html>
<html lang="sr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0f14;color:#e6edf3;font-family:'Segoe UI',Arial,sans-serif}
header{position:sticky;top:0;background:#0d1117;border-bottom:1px solid #21262d;padding:14px 20px;display:flex;align-items:center;gap:12px;font-size:16px;z-index:5}
header .dot{width:11px;height:11px;border-radius:50%;background:#3fb950;display:inline-block}
header .dot.off{background:#f85149}
header b{color:#58a6ff;font-size:19px}
#list{max-width:1100px;margin:0 auto}
.row{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid #161b22}
.row.susp{background:#2a0f0f}
.team{flex:1;min-width:0}
.team .nm{font-size:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.team .lg{font-size:12px;color:#6b7480;margin-top:2px}
.min{font-size:13px;color:#8b949e;min-width:72px}
.score{font-size:28px;font-weight:800;letter-spacing:1px;min-width:88px;text-align:center}
.score.goal{color:#ff4d4d}
.odds{display:flex;gap:8px;min-width:250px}
.odd{background:#161b22;border-radius:6px;padding:8px 10px;min-width:72px;text-align:center}
.odd span{display:block;font-size:11px;color:#8b949e}
.odd b{font-size:16px}
.badge{font-size:14px;font-weight:800;padding:9px 14px;border-radius:6px;min-width:110px;text-align:center}
.badge.susp{background:#f85149;color:#fff}
.badge.ok{background:#12351b;color:#3fb950}
.empty{padding:48px 20px;text-align:center;color:#6b7480}
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <span id="hdr">učitavam…</span>
</header>
<div id="list"></div>
<script>
const TITLE=${JSON.stringify(title)};
const list=document.getElementById('list');
function render(d){
  document.getElementById('dot').className='dot'+(d.ok?'':' off');
  document.getElementById('hdr').innerHTML =
    '<b>'+TITLE+'</b> &nbsp;'+d.count+' mečeva &nbsp;·&nbsp; '+d.suspended+' suspend'
    + ' &nbsp;·&nbsp; WS '+(d.ws||'?')
    + (d.ok?'':' &nbsp;·&nbsp; <span style="color:#f85149">'+(d.err||'greška')+'</span>');
  if(!d.matches.length){ list.innerHTML='<div class="empty">Nema živih fudbalskih mečeva.</div>'; return; }
  const emp=list.querySelector('.empty'); if(emp) emp.remove();
  const ex=new Map([...list.querySelectorAll('.row')].map(r=>[r.dataset.id,r]));
  const seen=new Set();
  d.matches.forEach(m=>{
    seen.add(String(m.id));
    let row=ex.get(String(m.id));
    if(!row){ row=document.createElement('div'); row.dataset.id=m.id; list.appendChild(row); }
    row.className='row'+(m.suspended?' susp':'');
    const o=m.odds||{};
    row.innerHTML=
      '<div class="team"><div class="nm">'+m.name+'</div><div class="lg">'+(m.league||'')+'</div></div>'
     +'<div class="min">'+(m.minute||'')+'<br>'+(m.phase||'')+'</div>'
     +'<div class="score'+(m.goalFlash?' goal':'')+'">'+(m.score||'-')+'</div>'
     +'<div class="odds">'
       +'<div class="odd"><span>1</span><b>'+(o['1']||'-')+'</b></div>'
       +'<div class="odd"><span>X</span><b>'+(o.X||'-')+'</b></div>'
       +'<div class="odd"><span>2</span><b>'+(o['2']||'-')+'</b></div>'
     +'</div>'
     +'<div class="badge '+(m.suspended?'susp':'ok')+'">'+(m.suspended?'SUSPEND':'OK')+'</div>';
  });
  for(const [id,row] of ex){ if(!seen.has(id)) row.remove(); }
}
async function poll(){ try{ const r=await fetch('/feed',{cache:'no-store'}); if(r.ok) render(await r.json()); }catch(e){} setTimeout(poll,120); }
poll();
</script></body></html>`;
}

