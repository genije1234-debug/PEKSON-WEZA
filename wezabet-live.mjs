/**
 * WezaBet KE – Live Fudbal (Node WS)
 * Port: 3301
 */

import http from "http";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import { createWezaFeed, wezaLiveHtml, SPORT_FOOTBALL } from "./wezabet-feed.mjs";

const PORT = Number(process.env.PORT || 3301);
const OPEN_UI = process.env.WEZ_OPEN_UI !== "0";
const WS_URL = process.env.WEZ_WS || "wss://wezabet.ke/_br?&language=en";
const PING_MS = 10000;
const HTML = wezaLiveHtml("WezaBet Node");
const feed = createWezaFeed();

const CHROME = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find(p => p && fs.existsSync(p));

function connect() {
  feed.setWs("connecting");
  let ws;
  try {
    ws = new WebSocket(WS_URL, {
      headers: {
        Origin: "https://wezabet.ke",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });
  } catch (e) {
    feed.setWs("down", e.message);
    setTimeout(connect, 2000);
    return;
  }

  const ping = setInterval(() => {
    try { if (ws.readyState === 1) ws.send("p"); } catch {}
  }, PING_MS);

  ws.addEventListener("open", () => {
    feed.setWs("up", "");
    feed.bumpReconnect();
    console.log("[wez] WS open", WS_URL);
    const send = obj => ws.send(JSON.stringify(obj));
    send({ type: "subscribeLive", data: { subscribe: true, type: 0, feed: "br", payload: null } });
    send({ type: "subscribeLive", data: { subscribe: true, type: 12, id: SPORT_FOOTBALL, isLive: true } });
  });
  ws.addEventListener("message", ev => feed.ingest(String(ev.data)));
  ws.addEventListener("error", () => { feed.setWs(feed.wsState, "ws error"); });
  ws.addEventListener("close", () => {
    clearInterval(ping);
    feed.setWs("down", feed.lastErr || "ws close");
    console.warn("[wez] WS close, reconnect...");
    setTimeout(connect, 1500);
  });
}

function openChrome(url) {
  if (!OPEN_UI) return;
  if (CHROME) {
    execFile(CHROME, [url], err => { if (err) console.warn("Chrome:", err.message); });
    return;
  }
  if (os.platform() === "win32") execFile("cmd", ["/c", "start", "", "chrome", url]);
}

const server = http.createServer((req, res) => {
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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`WezaBet Node → http://localhost:${PORT}`);
  connect();
  openChrome(`http://localhost:${PORT}`);
});
