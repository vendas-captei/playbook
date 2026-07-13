/* ==========================================================================
 * celebrate.js — Comemoração global de vendas no Playbook Captei
 * Incluído em todas as páginas. Para QUALQUER usuário logado, em QUALQUER
 * página: quando entra uma venda ganha, salta na tela fogos de artifício +
 * card com produto, valor e vendedor, parabenizando.
 *
 * Fonte: GET /api/metrics?action=wins (deals ganhos HOJE, qualquer funil).
 * Detecção por polling (Pipedrive não empurra ao browser) — latência ~30s.
 * Estado "já visto" em localStorage por dia → não refaz festa em reload/troca
 * de página e semeia sem comemorar na 1ª visita do dia.
 * ========================================================================== */
(function () {
  "use strict";
  var POLL_MS = 30000;
  var SEEN_KEY = "captei_wins_seen_v1";
  var SESSION_KEY = "captei_pb_session";

  function estaLogado() {
    try {
      var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return !!(s && s.name && (!s.expires || Date.now() <= s.expires));
    } catch (e) {
      return false;
    }
  }
  function hoje() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  }
  function brl(n) {
    try {
      return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
    } catch (e) {
      return "R$ " + (n || 0);
    }
  }
  function loadSeen() {
    try {
      var o = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      if (!o || o.date !== hoje()) return { date: hoje(), ids: [], seeded: false };
      return o;
    } catch (e) {
      return { date: hoje(), ids: [], seeded: false };
    }
  }
  function saveSeen(o) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // ---- Fogos (canvas full-screen, sem dependência) ------------------------
  var canvas, ctx, parts = [], raf = null;
  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
  }
  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.vx *= 0.99; p.life -= 0.012;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.fill();
    }
    parts = parts.filter(function (p) { return p.life > 0; });
    if (parts.length) { raf = requestAnimationFrame(loop); }
    else { raf = null; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }
  function burst(cx, cy) {
    var cores = ["#fde047", "#f97316", "#ec4899", "#22d3ee", "#a855f7", "#4ade80"];
    for (var i = 0; i < 90; i++) {
      var ang = (Math.PI * 2 * i) / 90, spd = 3 + Math.random() * 5;
      parts.push({ x: cx, y: cy, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 0.8 + Math.random() * 0.4, color: cores[(Math.random() * cores.length) | 0] });
    }
  }
  function fireworks() {
    ensureCanvas();
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    var W = canvas.width, H = canvas.height, shots = 0;
    (function fire() {
      burst(W * (0.15 + Math.random() * 0.7), H * (0.12 + Math.random() * 0.45));
      if (!raf) raf = requestAnimationFrame(loop);
      if (++shots < 14) setTimeout(fire, 320);
    })();
  }

  // ---- Card de comemoração ------------------------------------------------
  function mostrarCard(w) {
    var ov = document.createElement("div");
    ov.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.72);backdrop-filter:blur(4px);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "animation:cptFade .3s ease-out;";
    var produto = w.produto ? '<div style="margin-top:18px;font-size:34px;color:#a7f3d0;font-weight:700;">' + esc(w.produto) + "</div>" : "";
    var cliente = w.cliente ? '<div style="margin-top:4px;font-size:22px;color:rgba(255,255,255,.65);">' + esc(w.cliente) + "</div>" : "";
    ov.innerHTML =
      '<div style="text-align:center;padding:56px 72px;border-radius:28px;border:1px solid rgba(250,204,21,.4);' +
      'background:linear-gradient(135deg,#059669,#166534);box-shadow:0 25px 80px rgba(0,0,0,.5);animation:cptPop .4s ease-out;max-width:90vw;">' +
        '<div style="font-size:72px;line-height:1;">🎉🎆💰</div>' +
        '<div style="margin-top:16px;font-size:30px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#fde047;">Venda Fechada!</div>' +
        produto +
        '<div style="margin-top:14px;font-size:76px;font-weight:900;color:#fff;text-shadow:0 3px 12px rgba(0,0,0,.35);">' + brl(w.valor) + "</div>" +
        '<div style="margin-top:20px;font-size:40px;font-weight:800;color:#ecfdf5;">👏 Parabéns, ' + esc(w.vendedor || "") + "!</div>" +
        cliente +
      "</div>";
    document.body.appendChild(ov);
    fireworks();
    setTimeout(function () {
      ov.style.transition = "opacity .4s"; ov.style.opacity = "0";
      setTimeout(function () { ov.remove(); }, 400);
    }, 8000);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- Fila (uma festa por vez) -------------------------------------------
  var fila = [], festejando = false;
  function processarFila() {
    if (festejando || !fila.length) return;
    festejando = true;
    mostrarCard(fila.shift());
    setTimeout(function () { festejando = false; processarFila(); }, 9000);
  }

  // ---- Polling ------------------------------------------------------------
  function checar() {
    if (!estaLogado()) return;
    fetch("/api/metrics?action=wins", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.wins) return;
        var seen = loadSeen();
        var known = {}; seen.ids.forEach(function (id) { known[id] = 1; });
        if (!seen.seeded) {
          // 1ª leitura do dia: marca os ganhos já existentes como vistos, sem comemorar
          seen.ids = d.wins.map(function (w) { return w.id; });
          seen.seeded = true; saveSeen(seen); return;
        }
        d.wins.forEach(function (w) {
          if (!known[w.id]) { known[w.id] = 1; seen.ids.push(w.id); fila.push(w); }
        });
        saveSeen(seen);
        processarFila();
      })
      .catch(function () {});
  }

  // Atalho de teste p/ admins conferirem a animação: Ctrl+Shift+W
  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
      fila.push({ produto: "Captação Ativa", valor: 4990, vendedor: "Teste", cliente: "Imobiliária Exemplo" });
      processarFila();
    }
  });

  var st = document.createElement("style");
  st.textContent =
    "@keyframes cptPop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}" +
    "@keyframes cptFade{0%{opacity:0}100%{opacity:1}}";
  document.head.appendChild(st);

  function start() { checar(); setInterval(checar, POLL_MS); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
