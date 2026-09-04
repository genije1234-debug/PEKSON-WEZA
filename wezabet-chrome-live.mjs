/**
 * WezaBet KE – Live Fudbal (Chrome / Puppeteer, presretanje sajt WS)
 * Port: 3303
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";
import { createWezaFeed, wezaLiveHtml, SPORT_FOOTBALL } from "./wezabet-feed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3303);
const PAGE_URL = process.env.WEZ_CHROME_URL || "https://wezabet.ke/sports/live";
const PROFILE_DIR = path.join(__dirname, "wezabet-chrome-ui");
const HTML = wezaLiveHtml("WezaBet Chrome");
const feed = createWezaFeed();
const recentTypes = [];
let last30 = null;
let debugPage = null;
const RELOAD_MS = 1500;
const STALE_RELOAD_MS = 40000;

const CHROME = [
  process.env.CHROME,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find(p => p && fs.existsSync(p));

function noteTypes(raw) {
  try {
    const d = JSON.parse(raw);
    const list = Array.isArray(d) ? d : [d];
    for (const x of list) {
      const t = x?.data?.messageType ?? x?.messageType ?? x?.type ?? "?";
      recentTypes.push(t);
      if (t === 30) {
        const payload = x?.data?.payload ?? x?.payload;
        last30 = {
          n: Array.isArray(payload) ? payload.length : typeof payload,
          first: Array.isArray(payload) && payload[0] ? {
            name: payload[0].name,
            sport: payload[0].sport,
            sportId: payload[0].sportId,
            isLiveScheduled: payload[0].isLiveScheduled,
          } : null,
          sports: Array.isArray(payload)
            ? [...new Set(payload.map(e => e.sport?.id ?? e.sportId ?? "?"))].slice(0, 12)
            : [],
        };
      }
    }
  } catch {
    recentTypes.push("raw");
  }
  if (recentTypes.length > 40) recentTypes.splice(0, recentTypes.length - 40);
}

function ingestFrame(raw) {
  if (!raw || raw.length < 2) return;
  if (raw === "p" || raw === "ping") return;
  noteTypes(raw);
  const before = feed.health().lastMsgAt;
  feed.ingest(raw);
  if (feed.health().lastMsgAt !== before && feed.wsState !== "up") {
    feed.setWs("up", "");
    feed.bumpReconnect();
  }
}

function isWezSocket(url) {
  return String(url || "").toLowerCase().includes("_br");
}

async function clickSoccer(page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("a, button, span, div")].find(e =>
      /^(soccer|football|fudbal)$/i.test((e.textContent || "").trim())
    );
    if (el) el.click();
  }).catch(() => {});
}

async function startBrowser() {
  if (!CHROME) {
    feed.setWs("down", "Chrome nije pronađen");
    console.error("Chrome nije pronađen");
    return;
  }

  for (const f of [
    path.join(PROFILE_DIR, "Default", "Sessions"),
    path.join(PROFILE_DIR, "Default", "Last Session"),
    path.join(PROFILE_DIR, "Default", "Last Tabs"),
  ]) {
    try {
      if (fs.existsSync(f)) {
        const stat = fs.statSync(f);
        if (stat.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
        else fs.unlinkSync(f);
      }
    } catch {}
  }

  feed.setWs("connecting");
  console.log("[wez-chrome] pokrećem", CHROME);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
      "--no-restore-session-state",
      "--disable-restore-session-state",
      "--hide-crash-restore-bubble",
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  debugPage = page;
  await page.evaluateOnNewDocument(() => {
    const Orig = window.WebSocket;
    function subscribeFootball(ws) {
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: "subscribeLive", data: { subscribe: true, type: 12, id: 1, isLive: true } }));
        window.__wezSubOK = (window.__wezSubOK || 0) + 1;
      } catch {}
    }
    function Patched(...args) {
      const ws = new Orig(...args);
      try {
        const url = String(args[0] || "");
        if (url.includes("_br")) {
          window.__wezWS = ws;
          if (ws.readyState === 1) subscribeFootball(ws);
          else ws.addEventListener("open", () => subscribeFootball(ws));
        }
      } catch {}
      return ws;
    }
    Patched.prototype = Orig.prototype;
    window.WebSocket = Patched;
  });

  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.enable");

  const wezSockets = new Set();
  let reloading = false;
  let reloadTimer = null;

  async function subscribeFootball() {
    try {
      const ok = await page.evaluate(sportId => {
        const ws = window.__wezWS;
        if (!ws || ws.readyState !== 1) return false;
        const send = obj => ws.send(JSON.stringify(obj));
        send({ type: "subscribeLive", data: { subscribe: true, type: 12, id: sportId, isLive: true } });
        return true;
      }, SPORT_FOOTBALL);
      if (ok) console.log("[wez-chrome] subscribe football");
      return ok;
    } catch {
      return false;
    }
  }

  async function openLive(why) {
    console.log("[wez-chrome]", why, PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000));
    await clickSoccer(page);
    for (let i = 0; i < 8 && !(await subscribeFootball()); i++) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  function scheduleReload(why) {
    if (reloading || reloadTimer) return;
    feed.setWs("down", why);
    console.warn("[wez-chrome] reconnect za", RELOAD_MS, "ms:", why);
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      if (!page || page.isClosed()) return;
      reloading = true;
      try {
        await openLive("reload");
      } catch (e) {
        console.warn("[wez-chrome] reload fail:", e.message);
        reloading = false;
        scheduleReload("reload fail");
        return;
      }
      reloading = false;
    }, RELOAD_MS);
  }

  cdp.on("Network.webSocketCreated", evt => {
    const url = evt.url || "";
    if (!isWezSocket(url)) return;
    wezSockets.add(evt.requestId);
    console.log("[wez-chrome] WS", url);
    feed.setWs("up", "");
    feed.bumpReconnect();
    setTimeout(() => subscribeFootball(), 400);
  });
  cdp.on("Network.webSocketFrameReceived", evt => {
    try { ingestFrame(evt.response?.payloadData ?? ""); } catch {}
  });
  cdp.on("Network.webSocketClosed", evt => {
    if (!wezSockets.has(evt.requestId)) return;
    wezSockets.delete(evt.requestId);
    console.warn("[wez-chrome] WS close");
    scheduleReload("ws close");
  });

  browser.on("disconnected", () => {
    feed.setWs("down", "chrome zatvoren");
    console.warn("[wez-chrome] browser down, restart 3s...");
    setTimeout(() => startBrowser().catch(e => {
      feed.setWs("down", e.message);
      console.error("[wez-chrome]", e.message);
    }), 3000);
  });

  try {
    await openLive("otvoren");
  } catch (e) {
    feed.setWs(feed.wsState, e.message);
    console.warn("[wez-chrome] goto:", e.message);
    scheduleReload("goto fail");
  }

  setInterval(() => {
    if (feed.payload().ws === "up") subscribeFootball();
  }, 10000);
  setInterval(() => {
    const p = feed.payload();
    const quiet = p.lastMs > STALE_RELOAD_MS;
    if (p.ws !== "up" || quiet) scheduleReload(p.ws !== "up" ? (p.err || "ws down") : "tišina");
  }, 15000);
}

const server = http.createServer(async (req, res) => {
  const u = (req.url || "/").split("?")[0];
  if (u === "/api" || u === "/data") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(feed.matchList()));
    return;
  }
  if (u === "/feed") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(feed.payload()));
    return;
  }
  if (u === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(feed.health()));
    return;
  }
  if (u === "/debug") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    const info = debugPage
      ? await debugPage.evaluate(() => ({
        has: !!window.__wezWS,
        ready: window.__wezWS ? window.__wezWS.readyState : null,
        url: window.__wezWS ? window.__wezWS.url : "",
        sub: window.__wezSubOK || 0,
      })).catch(e => ({ err: e.message }))
      : { err: "no page" };
    res.end(JSON.stringify({ ...feed.health(), info, types: recentTypes.slice(-24), last30 }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`WezaBet Chrome → http://localhost:${PORT}`);
  startBrowser().catch(e => {
    feed.setWs("down", e.message);
    console.error("[wez-chrome]", e.message);
  });
});
