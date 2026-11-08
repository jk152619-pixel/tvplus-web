(function () {
  "use strict";
  var C = window.APP_CONFIG || {};
  var isNative = !!(window.Native && window.Native.get);
  var $app = document.getElementById("app");
  var DNS = (C.dns || []).slice();
  var isWeb = !isNative;
  function toHttps(u) { return String(u).replace(/^http:\/\//i, "https://").replace(/^(https:\/\/[^\/:]+):\d+/, "$1"); }
  if (isWeb) {
    var m = /[?&]dns=([^&]+)/.exec(location.search);
    if (m) DNS = [decodeURIComponent(m[1])];
    if (location.protocol === "https:") DNS = DNS.map(toHttps);
  }

  // ---------------- utilidades ----------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(s) {
    s = String(s || "").toLowerCase();
    return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "") : s;
  }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var toastTimer;
  function toast(msg, ms) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = "none"; }, ms || 2800);
  }
  function busy(on, text) {
    document.getElementById("busyText").textContent = text || "Carregando...";
    document.getElementById("busy").className = on ? "show" : "";
  }
  function fmtDate(ts) {
    if (!ts || ts === "null") return "Ilimitado";
    var d = new Date(Number(ts) * 1000);
    function z(n) { return n < 10 ? "0" + n : n; }
    return z(d.getDate()) + "/" + z(d.getMonth() + 1) + "/" + d.getFullYear();
  }
  function clock() {
    var d = new Date();
    function z(n) { return n < 10 ? "0" + n : n; }
    return z(d.getHours()) + ":" + z(d.getMinutes());
  }
  setInterval(function () {
    var els = document.querySelectorAll(".clock");
    for (var i = 0; i < els.length; i++) els[i].textContent = clock();
  }, 20000);

  // ---------------- rede ----------------
  var cbSeq = 0, cbs = {};
  function decodeB64(b) {
    var bin = atob(b);
    if (window.TextDecoder) {
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(arr);
    }
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }
  window.__nativeCb = function (id, ok, b64) {
    var f = cbs[id]; delete cbs[id];
    if (f) f(ok, decodeB64(b64));
  };
  function httpGet(url) {
    return new Promise(function (resolve, reject) {
      if (isNative) {
        var id = "c" + (++cbSeq);
        cbs[id] = function (ok, text) { ok ? resolve(text) : reject(new Error(text)); };
        window.Native.get(id, url);
      } else {
        fetch(url).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)); }).then(resolve, reject);
      }
    });
  }

  var creds = load("creds", null); // {dns, user, pass}
  var account = load("account", null);
  var cache = {};

  function baseApi(dns, u, p) {
    return dns.replace(/\/+$/, "") + "/player_api.php?username=" + encodeURIComponent(u) + "&password=" + encodeURIComponent(p);
  }
  function api(action, extra) {
    var key = action + "|" + (extra || "");
    if (cache[key]) return Promise.resolve(cache[key]);
    var url = baseApi(creds.dns, creds.user, creds.pass) + "&action=" + action + (extra || "");
    return httpGet(url).then(function (t) {
      var d;
      try { d = JSON.parse(t); } catch (e) { throw new Error("Resposta inválida do servidor"); }
      cache[key] = d;
      return d;
    });
  }
  function streamUrl(kind, id, ext) {
    var b = creds.dns.replace(/\/+$/, "");
    return b + "/" + kind + "/" + encodeURIComponent(creds.user) + "/" + encodeURIComponent(creds.pass) + "/" + id + "." + ext;
  }
  function liveExt() {
    if (isWeb) { var ff = (account && account.allowed_output_formats) || []; return (!ff.length || ff.indexOf("m3u8") >= 0) ? "m3u8" : "ts"; }
    var f = (account && account.allowed_output_formats) || [];
    if (!f.length || f.indexOf("ts") >= 0) return "ts";
    return "m3u8";
  }
  function play(urls, titles, index, live) {
    var data = { urls: urls, titles: titles, index: index || 0, live: !!live };
    if (isNative) window.Native.play(JSON.stringify(data));
    else webPlayer(data);
  }
  // ---------- player web (iPhone / navegador) ----------
  var hlsLib = null;
  function loadHls() {
    if (hlsLib) return hlsLib;
    hlsLib = new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
      sc.onload = function () { res(window.Hls); }; sc.onerror = rej;
      document.head.appendChild(sc);
    });
    return hlsLib;
  }
  var mpegLib = null;
  function loadMpegts() {
    if (mpegLib) return mpegLib;
    mpegLib = new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = "https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js";
      sc.onload = function () { res(window.mpegts); }; sc.onerror = rej;
      document.head.appendChild(sc);
    });
    return mpegLib;
  }
  function webPlayer(d) {
    var old = document.getElementById("wplayer"); if (old) old.remove();
    var i = d.index || 0, hls = null, hideT = 0, mp = null;
    var box = document.createElement("div"); box.id = "wplayer";
    box.innerHTML = '<video playsinline webkit-playsinline autoplay controls></video>' +
      '<div class="wp-top"><button class="wp-x" aria-label="Fechar">✕</button><div class="wp-t"></div></div>' +
      (d.urls.length > 1 ? '<button class="wp-nav wp-prev" aria-label="Anterior">‹</button><button class="wp-nav wp-next" aria-label="Próximo">›</button>' : '') +
      '<div class="wp-msg"></div>';
    document.body.appendChild(box);
    var v = box.querySelector("video"), msg = box.querySelector(".wp-msg");
    function showUi() { box.classList.add("ui"); clearTimeout(hideT); hideT = setTimeout(function () { box.classList.remove("ui"); }, 4000); }
    function load(k) {
      i = (k + d.urls.length) % d.urls.length;
      box.querySelector(".wp-t").textContent = d.titles[i] || "";
      msg.textContent = "Carregando..."; msg.style.display = "block";
      if (hls) { hls.destroy(); hls = null; }
      if (mp) { try { mp.destroy(); } catch (e) {} mp = null; }
      var u = d.urls[i], isHls = /\.m3u8(\?|$)/i.test(u), isTs = /\.ts(\?|$)/i.test(u);
      if (isTs) {
        v.disableRemotePlayback = true;
        loadMpegts().then(function (M) {
          if (!M || !M.isSupported()) { fail(); msg.innerHTML += "<br><small>Este iPhone precisa do iOS 17.1 ou mais novo.</small>"; return; }
          mp = M.createPlayer({ type: "mpegts", isLive: !!d.live, url: u }, { enableWorker: false, liveBufferLatencyChasing: true, lazyLoad: false });
          mp.attachMediaElement(v); mp.load();
          mp.on(M.Events.ERROR, function () { fail(); });
          var pp = mp.play(); if (pp && pp.catch) pp.catch(function () {});
        }, fail);
        showUi(); return;
      }
      if (isHls && !v.canPlayType("application/vnd.apple.mpegurl")) {
        loadHls().then(function (H) {
          if (!H || !H.isSupported()) { v.src = u; return; }
          hls = new H(); hls.loadSource(u); hls.attachMedia(v);
          hls.on(H.Events.ERROR, function (e, x) { if (x && x.fatal) fail(); });
        }, function () { v.src = u; });
      } else v.src = u;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      showUi();
    }
    function fail() {
      msg.style.display = "block";
      msg.innerHTML = "Não foi possível abrir este conteúdo aqui." + (d.urls.length > 1 ? "<br>Toque em › para tentar outro canal." : "") + (d.live ? "" : "<br><small>Alguns filmes e séries vêm num formato que o iPhone não toca.</small>");
    }
    v.addEventListener("playing", function () { msg.style.display = "none"; });
    v.addEventListener("error", fail);
    box.onclick = function (e) { if (e.target === v || e.target === box) showUi(); };
    box.querySelector(".wp-x").onclick = function () { if (hls) hls.destroy(); if (mp) { try { mp.destroy(); } catch (e) {} } v.pause(); v.removeAttribute("src"); v.load(); box.remove(); };
    if (d.urls.length > 1) {
      box.querySelector(".wp-prev").onclick = function () { load(i - 1); };
      box.querySelector(".wp-next").onclick = function () { load(i + 1); };
    }
    load(i);
  }

  function tryLogin(user, pass) {
    var i = 0, lastErr = isWeb ? "Usuário ou senha incorretos, ou o seu servidor ainda não funciona no iPhone. Fale com o suporte." : "Não foi possível conectar ao servidor";
    function next() {
      if (i >= DNS.length) return Promise.reject(new Error(lastErr));
      var dns = DNS[i++];
      return httpGet(baseApi(dns, user, pass)).then(function (t) {
        var d = JSON.parse(t);
        if (d && d.user_info && String(d.user_info.auth) === "1") return { dns: dns, info: d.user_info };
        lastErr = "Usuário ou senha incorretos";
        return next();
      }, function () { return next(); });
    }
    return next();
  }

  // ---------------- favoritos ----------------
  function favs(type) { return load("fav_" + type, {}); }
  function isFav(type, id) { return !!favs(type)[id]; }
  function toggleFav(type, item, id) {
    var f = favs(type);
    if (f[id]) { delete f[id]; toast("Removido dos favoritos"); }
    else { f[id] = item; toast("★ Adicionado aos favoritos"); }
    save("fav_" + type, f);
    return !!f[id];
  }

  // ---------------- navegação por controle ----------------
  function focusables() {
    var all = $app.querySelectorAll(".focusable"), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].offsetParent !== null) out.push(all[i]);
    return out;
  }
  function ensureVisible(el) {
    // Rola todas as áreas (vertical e horizontal) até o item ficar visível
    var p = el.parentElement, m = 24;
    while (p && p !== document.body) {
      var s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) {
        var r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
        if (r.top < pr.top + m) p.scrollTop -= (pr.top + m - r.top);
        else if (r.bottom > pr.bottom - m) p.scrollTop += (r.bottom - pr.bottom + m);
      }
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) {
        var r2 = el.getBoundingClientRect(), pr2 = p.getBoundingClientRect();
        if (r2.left < pr2.left + m) p.scrollLeft -= (pr2.left + m - r2.left);
        else if (r2.right > pr2.right - m) p.scrollLeft += (r2.right - pr2.right + m);
      }
      p = p.parentElement;
    }
  }
  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    ensureVisible(el);
    if (el.onfocusnav) el.onfocusnav();
  }
  function focusFirst(sel) {
    var el = sel ? $app.querySelector(sel) : null;
    if (!el) el = focusables()[0];
    focusEl(el);
  }
  function move(dir) {
    var cur = document.activeElement, list = focusables();
    if (!cur || list.indexOf(cur) < 0) { focusEl(list[0]); return; }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bestScore = Infinity;
    var zoneSel = ".rail,.groups,.chans,.content,.detail,.login-box,.devs,.sp-side,.sp-main";
    var myZone = cur.closest ? cur.closest(zoneSel) : null;
    if (myZone && (dir === "up" || dir === "down") && !myZone.classList.contains("top")) {
      // Primeiro tenta ficar na mesma área (lista, menu lateral...)
      var same = [];
      for (var z = 0; z < list.length; z++) if (list[z].closest(zoneSel) === myZone) same.push(list[z]);
      var hasMore = false;
      for (var y = 0; y < same.length; y++) {
        if (same[y] === cur) continue;
        var qq = same[y].getBoundingClientRect(), my = qq.top + qq.height / 2;
        if (dir === "down" ? my > cy + 2 : my < cy - 2) { hasMore = true; break; }
      }
      if (hasMore || dir === "down") list = same;
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i]; if (e === cur) continue;
      var q = e.getBoundingClientRect();
      var ex = q.left + q.width / 2, ey = q.top + q.height / 2, primary, secondary, overlap;
      if (dir === "right") { if (ex <= cx + 2 || q.left < r.left + 2) continue; primary = Math.max(0, q.left - r.right); secondary = Math.abs(ey - cy); overlap = q.top < r.bottom && q.bottom > r.top; }
      else if (dir === "left") { if (ex >= cx - 2 || q.right > r.right - 2) continue; primary = Math.max(0, r.left - q.right); secondary = Math.abs(ey - cy); overlap = q.top < r.bottom && q.bottom > r.top; }
      else if (dir === "down") { if (ey <= cy + 2 || q.top < r.top + 2) continue; primary = Math.max(0, q.top - r.bottom); secondary = Math.abs(ex - cx); overlap = q.left < r.right && q.right > r.left; }
      else { if (ey >= cy - 2 || q.bottom > r.bottom - 2) continue; primary = Math.max(0, r.top - q.bottom); secondary = Math.abs(ex - cx); overlap = q.left < r.right && q.right > r.left; }
      var score = primary + secondary * (overlap ? 0.3 : 2) + (overlap ? 0 : 400);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) focusEl(best);
  }
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode, a = document.activeElement;
    var isInput = a && a.tagName === "INPUT";
    if (k >= 37 && k <= 40) {
      if (isInput && (k === 37 || k === 39) && a.value) return;
      e.preventDefault();
      move({ 37: "left", 38: "up", 39: "right", 40: "down" }[k]);
    } else if (k === 13 || k === 23) {
      if (isInput) { if (a.onenter) { e.preventDefault(); a.onenter(); } return; }
      e.preventDefault();
      if (a && a.classList && a.classList.contains("focusable")) a.click(); else focusFirst();
    } else if (k === 27 && !isNative) {
      e.preventDefault(); window.appBack();
    }
  });

  // ---------------- pilha de telas ----------------
  var stack = [], current = null, lastBack = 0;
  function show(screen) {
    current = screen;
    screen.render();
  }
  function go(screen) {
    if (current) { current.focusKey = activeKey(); stack.push(current); }
    show(screen);
  }
  function activeKey() {
    var a = document.activeElement;
    return a && a.getAttribute ? a.getAttribute("data-k") : null;
  }
  function restore(screen, fallback) {
    var el = screen.focusKey ? $app.querySelector('[data-k="' + screen.focusKey.replace(/"/g, "") + '"]') : null;
    if (el) focusEl(el); else focusFirst(fallback);
  }
  window.appBack = function () {
    if (document.getElementById("busy").className === "show") return true;
    if (stack.length) {
      var prev = stack.pop();
      current = prev;
      prev.render(true);
      return true;
    }
    if (current && current.name === "home") {
      var now = Date.now();
      if (now - lastBack < 2200) return false;
      lastBack = now;
      toast("Pressione voltar novamente para sair");
      return true;
    }
    return false;
  };

  function recent(all, field, n) { return all.slice().sort(function (a, b) { return (Number(b[field]) || 0) - (Number(a[field]) || 0); }).slice(0, n); }


  // ================= TVPlus+ P2P — telas =================
  var GOLD = "#f7bf1a", RED = "#e3101e";
  var ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 20v-5h4v5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    sport: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 3v5M16 3v5M8 13l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    tv: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" fill="currentColor" font-weight="700">TV</text></svg>',
    vod: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7.5" r="1.8" fill="currentColor"/><circle cx="12" cy="16.5" r="1.8" fill="currentColor"/><circle cx="7.5" cy="12" r="1.8" fill="currentColor"/><circle cx="16.5" cy="12" r="1.8" fill="currentColor"/></svg>',
    hist: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    set: '<svg viewBox="0 0 24 24"><path d="M6 3v18M12 3v18M18 3v18" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="9" r="2.2" fill="#15161b" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15" r="2.2" fill="#15161b" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="8" r="2.2" fill="#15161b" stroke="currentColor" stroke-width="2"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 18c2-3 4-4 7-4s5 1 7 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7z" fill="currentColor"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="2.4"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 2l3 7 7 .6-5.3 4.7L18.5 22 12 18l-6.5 4 1.8-7.7L2 9.6 9 9z" fill="currentColor"/></svg>',
    az: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor"/><text x="12" y="15.5" font-size="8" text-anchor="middle" fill="#15161b" font-weight="900">A-Z</text></svg>',
    calsm: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 2v5M16 2v5" stroke="currentColor" stroke-width="2"/></svg>',
    tvbig: '<svg viewBox="0 0 48 48"><rect x="5" y="12" width="38" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 4l8 8 8-8M14 42h20" fill="none" stroke="currentColor" stroke-width="3"/><text x="24" y="31" font-size="13" text-anchor="middle" fill="currentColor" font-weight="800">TV</text></svg>',
    phone: '<svg viewBox="0 0 48 48"><rect x="13" y="4" width="22" height="40" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="38" r="2" fill="currentColor"/></svg>',
    wifi: '<svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="19.5" r="1.6" fill="currentColor"/></svg>',
    trophy: '<svg viewBox="0 0 48 48"><path d="M14 6h20v10a10 10 0 01-20 0z" fill="' + GOLD + '"/><path d="M14 9H7a6 6 0 006 8M34 9h7a6 6 0 01-6 8" fill="none" stroke="#fff" stroke-width="3"/><path d="M20 30h8v6h6v6H14v-6h6z" fill="#fff"/><circle cx="24" cy="15" r="4" fill="' + RED + '"/></svg>',
    cal: '<svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="32" rx="3" fill="#fff"/><rect x="6" y="9" width="36" height="8" fill="' + RED + '"/><path d="M14 5v8M34 5v8" stroke="' + GOLD + '" stroke-width="3"/><path d="M12 24h10M12 30h10M27 24h9M27 30h9" stroke="#15161b" stroke-width="3"/><circle cx="35" cy="36" r="8" fill="' + GOLD + '"/><path d="M35 32v4l3 2" fill="none" stroke="#15161b" stroke-width="2"/></svg>',
    table: '<svg viewBox="0 0 48 48"><rect x="18" y="14" width="12" height="28" fill="' + GOLD + '"/><rect x="6" y="24" width="12" height="18" fill="#fff"/><rect x="30" y="29" width="12" height="13" fill="#fff"/><text x="24" y="26" font-size="9" text-anchor="middle" fill="#15161b" font-weight="800">1</text><text x="12" y="35" font-size="8" text-anchor="middle" fill="#15161b" font-weight="800">2</text><text x="36" y="38" font-size="8" text-anchor="middle" fill="#15161b" font-weight="800">3</text></svg>'
  };
  function wm() { // marca d'água TVPlus+ no fundo
    var s = "";
    for (var i = 0; i < 18; i++) s += "<span>TVPlus+</span>";
    return '<div class="wm">' + s + "</div>";
  }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function bg(url) { return url ? " style=\"background-image:url('" + esc(url).replace(/'/g, "%27") + "')\"" : ""; }
  var device = load("device", null);
  function applyDevice() { document.body.className = device === "phone" ? "phone" : "tv"; }
  applyDevice();
  var history = load("hist", []);
  function addHist(item) {
    history = history.filter(function (h) { return h.k !== item.k; });
    history.unshift(item); history = history.slice(0, 40); save("hist", history);
  }

  // ---------- conteúdo adulto (bloqueio com senha) ----------
  var DEFAULT_PIN = "0000";
  var adultUnlocked = false; // libera até fechar o app
  var ADULT_RE = /(adult|xxx|\+\s?18|18\s?\+|\bhot\b|erot|porn|sexy|\bsexo\b|playboy|brasileirinhas|\bprive\b)/;
  function getPin() { return String(load("adult_pin", DEFAULT_PIN) || DEFAULT_PIN); }
  function lockOn() { return load("adult_on", true) !== false; }
  function catLocked(c) { return !!c && ADULT_RE.test(norm(c.category_name)); }
  function hideCat(c) { return lockOn() && !adultUnlocked && catLocked(c); }
  function lockMap(cats) { var m = {}; arr(cats).forEach(function (c) { if (catLocked(c)) m[String(c.category_id)] = 1; }); return m; }
  function visible(items, locked) {
    if (adultUnlocked || !lockOn()) return arr(items);
    return arr(items).filter(function (it) { return String(it.is_adult) !== "1" && !locked[String(it.category_id)]; });
  }
  function askPin(ok, title) {
    if (adultUnlocked) { ok(); return; }
    go(pinScreen(function () { adultUnlocked = true; ok(); window.appBack(); }, title));
  }
  function pinScreen(onOk, title) {
    return {
      name: "pin",
      render: function () {
        $app.innerHTML = '<div class="login">' + wm() + '<div class="login-box"><div class="lb-head"><img src="logo.png" alt=""></div><div class="lb-body">' +
          "<h2>🔒 " + esc(title || "Conteúdo bloqueado") + "</h2>" +
          '<label class="lf">' + ICON.lock + '<input id="pin" class="focusable" type="password" inputmode="numeric" placeholder="Senha do controle dos pais" autocomplete="off"></label>' +
          '<div class="msg" id="pmsg"></div><button class="btn-login focusable" id="pok">LIBERAR</button>' +
          '<button class="btn-cancel focusable" id="pcancel">Cancelar</button></div></div></div>';
        var p = document.getElementById("pin");
        function submit() {
          if (p.value.trim() === getPin()) onOk();
          else { document.getElementById("pmsg").textContent = "Senha incorreta"; p.value = ""; focusEl(p); }
        }
        p.onenter = submit;
        document.getElementById("pok").onclick = submit;
        document.getElementById("pcancel").onclick = function () { window.appBack(); };
        focusEl(p);
      }
    };
  }
  function newPinScreen() {
    return {
      name: "newpin",
      render: function () {
        $app.innerHTML = '<div class="login">' + wm() + '<div class="login-box"><div class="lb-head"><img src="logo.png" alt=""></div><div class="lb-body">' +
          "<h2>Nova senha do controle dos pais</h2>" +
          '<label class="lf">' + ICON.lock + '<input id="n1" class="focusable" type="password" inputmode="numeric" placeholder="Nova senha (4 números ou mais)" autocomplete="off"></label>' +
          '<label class="lf">' + ICON.lock + '<input id="n2" class="focusable" type="password" inputmode="numeric" placeholder="Repita a nova senha" autocomplete="off"></label>' +
          '<div class="msg" id="nmsg"></div><button class="btn-login focusable" id="nok">SALVAR</button>' +
          '<button class="btn-cancel focusable" id="ncancel">Cancelar</button></div></div></div>';
        var a = document.getElementById("n1"), b = document.getElementById("n2");
        function submit() {
          var v = a.value.trim();
          if (v.length < 4) { document.getElementById("nmsg").textContent = "Use pelo menos 4 números"; return; }
          if (v !== b.value.trim()) { document.getElementById("nmsg").textContent = "As senhas não são iguais"; return; }
          save("adult_pin", v); toast("Senha trocada"); window.appBack();
        }
        a.onenter = function () { focusEl(b); }; b.onenter = submit;
        document.getElementById("nok").onclick = submit;
        document.getElementById("ncancel").onclick = function () { window.appBack(); };
        focusEl(a);
      }
    };
  }

  // ---------- busca (campo dentro da tela; funciona no controle e no celular) ----------
  function searchBox(box, label, onQ) {
    box.innerHTML = '<div class="sbox">' + ICON.search + '<input id="q" class="focusable" placeholder="' + esc(label) + '" autocomplete="off" autocapitalize="none"></div><div class="sres"></div>';
    var q = box.querySelector("#q"), res = box.querySelector(".sres"), t = 0;
    function run() { var v = q.value.trim(); if (v.length < 2) { res.innerHTML = '<div class="empty">Digite pelo menos 2 letras</div>'; return; } onQ(norm(v), res); }
    q.onenter = function () { run(); var f = res.querySelector(".focusable"); if (f) focusEl(f); };
    q.oninput = function () { clearTimeout(t); t = setTimeout(run, 500); };
    res.innerHTML = '<div class="empty">Digite o nome e aperte OK</div>';
    focusEl(q);
  }

  // ---------- tela: tipo de dispositivo ----------
  function deviceScreen(after) {
    return {
      name: "device",
      render: function () {
        var sel = device || "tv";
        $app.innerHTML = '<div class="devs-wrap">' + wm() + '<div class="devs"><h1>Selecione seu tipo de dispositivo</h1>' +
          '<p>Para uma melhor experiência de uso, selecione corretamente o tipo de dispositivo que você está utilizando. Se desejar alterar o tipo selecionado, você pode fazê-lo na página de configurações.</p>' +
          '<div class="devrow"><button class="dev focusable" data-d="tv">' + ICON.tvbig + '<span><i class="radio"></i>TV</span></button>' +
          '<button class="dev focusable" data-d="phone">' + ICON.phone + '<span><i class="radio"></i>Celular</span></button></div>' +
          '<button class="btn-confirm focusable" data-k="ok">CONFIRMAR</button></div></div>';
        function mark() {
          var b = $app.querySelectorAll(".dev");
          for (var i = 0; i < b.length; i++) b[i].classList.toggle("on", b[i].getAttribute("data-d") === sel);
        }
        var b = $app.querySelectorAll(".dev");
        for (var i = 0; i < b.length; i++) b[i].onclick = function () { sel = this.getAttribute("data-d"); mark(); focusEl($app.querySelector(".btn-confirm")); };
        mark();
        $app.querySelector(".btn-confirm").onclick = function () { device = sel; save("device", sel); applyDevice(); after(); };
        focusFirst('[data-d="' + sel + '"]');
      }
    };
  }

  // ---------- tela: login ----------
  function loginScreen(msg) {
    return {
      name: "login",
      render: function () {
        $app.innerHTML = '<div class="login">' + wm() + '<div class="login-box"><div class="lb-head">' + ICON.user + '</div><div class="lb-body">' +
          '<h2>Login com nome de usuário!</h2>' +
          '<label class="lf">' + ICON.person + '<input id="u" class="focusable" placeholder="Usuário" autocomplete="off" autocapitalize="none"></label>' +
          '<label class="lf">' + ICON.lock + '<input id="p" class="focusable" type="password" placeholder="Senha" autocomplete="off" autocapitalize="none"><button class="eye focusable" type="button">' + ICON.eye + '</button></label>' +
          '<div class="msg">' + esc(msg || "") + '</div>' +
          '<button class="btn-login focusable">LOGIN</button>' +
          (C.whatsapp ? '<div class="support">Suporte: WhatsApp ' + esc(fmtPhone(C.whatsapp)) + '</div>' : "") +
          '</div></div><div class="net">' + ICON.wifi + '</div></div>';
        var u = $app.querySelector("#u"), p = $app.querySelector("#p");
        if (creds) { u.value = creds.user; }
        u.onenter = function () { focusEl(p); };
        p.onenter = submit;
        $app.querySelector(".eye").onclick = function () { p.type = p.type === "password" ? "text" : "password"; };
        $app.querySelector(".btn-login").onclick = submit;
        function submit() {
          var user = u.value.trim(), pass = p.value.trim();
          if (!user || !pass) { $app.querySelector(".msg").textContent = "Digite usuário e senha"; return; }
          busy(true, "Entrando...");
          tryLogin(user, pass).then(function (r) {
            busy(false);
            creds = { dns: r.dns, user: user, pass: pass }; account = r.info;
            save("creds", creds); save("account", account); cache = {};
            stack = []; show(homeScreen());
          }, function (e) { busy(false); $app.querySelector(".msg").textContent = e.message; });
        }
        focusEl(u);
      }
    };
  }
  function fmtPhone(n) {
    n = String(n).replace(/\D/g, "").replace(/^55/, "");
    return n.length === 11 ? "(" + n.slice(0, 2) + ") " + n.slice(2, 7) + "-" + n.slice(7) : n;
  }

  // ---------- estrutura com menu lateral ----------
  var TABS = [["home", "Início"], ["sport", "Esportes"], ["tv", "TV ao Vivo"], ["vod", "Filmes e Séries"], ["hist", "Histórico"], ["set", "Configurações"]];
  function frame(tab, inner) {
    var r = "";
    for (var i = 0; i < TABS.length; i++)
      r += '<button class="ri focusable' + (TABS[i][0] === tab ? " on" : "") + '" data-k="rail-' + TABS[i][0] + '" data-t="' + TABS[i][0] + '" title="' + TABS[i][1] + '">' + ICON[TABS[i][0]] + "</button>";
    return '<div class="shell">' + wm() + '<nav class="rail">' + r + '</nav><main class="main">' + inner + "</main></div>";
  }
  function bindRail(tab) {
    var b = $app.querySelectorAll(".ri");
    for (var i = 0; i < b.length; i++) b[i].onclick = function () {
      var t = this.getAttribute("data-t");
      if (t === tab && !stack.length) return;
      stack = []; show(SCREENS[t]());
    };
  }
  var SCREENS = {
    home: function () { return homeScreen(); }, sport: function () { return sportScreen(); },
    tv: function () { return liveScreen(); }, vod: function () { return vodScreen(); },
    hist: function () { return histScreen(); }, set: function () { return setScreen(); }
  };

  // Coleções/plataformas: aparecem só se o servidor tiver categoria com esse nome
  var COLLS = [
    ["novelas", "Novelas", /novela/], ["netflix", "Netflix", /netflix/], ["prime", "Prime Video", /prime|amazon/],
    ["disney", "Disney+", /disney/], ["hbo", "HBO Max", /hbo|\bmax\b/], ["globoplay", "Globoplay", /globo ?play/],
    ["paramount", "Paramount+", /paramount/], ["apple", "Apple TV+", /apple/], ["star", "Star+", /\bstar\s?\+|\bstar\b/],
    ["crunchy", "Crunchyroll", /crunchy/], ["discovery", "Discovery+", /discovery/], ["doc", "Documentários", /document/],
    ["kids", "Infantil", /infant|kids|desenho/], ["anime", "Animes", /anime/]
  ];
  var PLAT_IDS = { netflix: 1, prime: 1, disney: 1, hbo: 1, globoplay: 1, paramount: 1, apple: 1, star: 1, crunchy: 1, discovery: 1 };
  function vodData() {
    return Promise.all([api("get_vod_categories"), api("get_series_categories"), api("get_vod_streams"), api("get_series")].map(function (p) { return p.catch(function () { return []; }); }))
      .then(function (r) {
        var mc = arr(r[0]), sc = arr(r[1]);
        var lm = lockMap(mc), ls = lockMap(sc);
        return {
          mc: mc, sc: sc, rawM: arr(r[2]), rawS: arr(r[3]),
          movies: visible(r[2], lm), series: visible(r[3], ls),
          vmc: mc.filter(function (c) { return !hideCat(c); }), vsc: sc.filter(function (c) { return !hideCat(c); })
        };
      });
  }
  function collCats(D, re) {
    var out = [];
    D.vmc.forEach(function (c) { if (re.test(norm(c.category_name))) out.push({ kind: "movie", c: c }); });
    D.vsc.forEach(function (c) { if (re.test(norm(c.category_name))) out.push({ kind: "series", c: c }); });
    return out;
  }

  // ---------- Início ----------
  function homeScreen() {
    return {
      name: "home",
      render: function (back) {
        var self = this;
        $app.innerHTML = frame("home",
          '<div class="hhead"><img class="hlogo" src="logo.png" alt=""><span>' + ICON.user + " " + esc(creds.user) + '</span><span>' + ICON.calsm + " " + esc(fmtDate(account && account.exp_date)) + '</span><span class="clock">' + clock() + "</span></div>" +
          '<button class="banner focusable" data-k="banner"><div class="bimg"></div><div class="btxt"><b>TVPlus+</b><small>Carregando destaques...</small></div><div class="dots"></div></button>' +
          '<div class="plats"></div>');
        bindRail("home");
        var slides = [], si = 0;
        var bimg = $app.querySelector(".bimg"), bt = $app.querySelector(".btxt b"), bs = $app.querySelector(".btxt small"), dots = $app.querySelector(".dots");
        function slide() {
          if (!slides.length || !document.body.contains(bimg)) return;
          var n = si % slides.length, s = slides[n]; si++;
          bimg.style.backgroundImage = "url('" + s.img.replace(/'/g, "%27") + "')"; bt.textContent = s.name; bs.textContent = s.type === "series" ? "Série · OK para abrir" : "Filme · OK para assistir";
          dots.innerHTML = slides.map(function (x, i) { return "<i" + (i === n ? ' class="on"' : "") + "></i>"; }).join("");
          $app.querySelector(".banner").onclick = function () { openItem(s.type, s.it); };
        }
        function drawPlats(pl) {
          var box = $app.querySelector(".plats"); if (!box) return;
          box.innerHTML = pl.map(function (p) { return '<button class="plat focusable p-' + p[0] + '" data-k="pl-' + p[0] + '" data-g="' + p[0] + '"><span>' + esc(p[1]) + "</span></button>"; }).join("");
          var b = box.querySelectorAll(".plat");
          for (var i = 0; i < b.length; i++) b[i].onclick = function () { go(vodScreen(this.getAttribute("data-g"))); };
        }
        var hc = load("home_cache", null), started = false, tmr = 0;
        function startSlides() {
          if (!slides.length) { bs.textContent = "OK para abrir Filmes e Séries"; return; }
          slide();
          if (!started) { started = true; tmr = setInterval(function () { if (!document.body.contains(bimg)) clearInterval(tmr); else slide(); }, 7000); }
        }
        if (hc && hc.u === creds.user && hc.slides && hc.slides.length) {
          slides = hc.slides; startSlides(); drawPlats(hc.plats || []);
        }
        vodData().then(function (D) {
          if (!document.body.contains(bimg)) return;
          var fresh = [];
          var old = slides; slides = fresh;
          recent(D.series, "last_modified", 40).forEach(function (s) {
            var bd = s.backdrop_path && s.backdrop_path[0];
            if (bd && slides.length < 8) slides.push({ img: bd, name: s.name, type: "series", it: s });
          });
          if (slides.length < 3) recent(D.movies, "added", 12).forEach(function (m) { if (m.stream_icon && slides.length < 8) slides.push({ img: m.stream_icon, name: m.name, type: "movie", it: m }); });
          var pl = [];
          COLLS.forEach(function (p) { if (PLAT_IDS[p[0]] && collCats(D, p[2]).length) pl.push([p[0], p[1]]); });
          var light = slides.map(function (x) { return { img: x.img, name: x.name, type: x.type, it: x.type === "series" ? { series_id: x.it.series_id, name: x.it.name, cover: x.it.cover, backdrop_path: x.it.backdrop_path, plot: x.it.plot, genre: x.it.genre, rating: x.it.rating, releaseDate: x.it.releaseDate } : x.it }; });
          save("home_cache", { u: creds.user, slides: light, plats: pl });
          if (!old.length) startSlides();
          var a = document.activeElement, onPlat = a && a.classList && a.classList.contains("plat") ? a.getAttribute("data-g") : null;
          drawPlats(pl);
          if (onPlat) { var f = $app.querySelector('.plat[data-g="' + onPlat + '"]'); if (f) focusEl(f); }
          if (back) restore(self, ".banner");
        }, function () {});
        if (!slides.length) $app.querySelector(".banner").onclick = function () { go(vodScreen()); };
        if (back) restore(self, ".banner"); else focusEl($app.querySelector(".banner"));
      }
    };
  }

  // ---------- TV ao Vivo (grupos | canais | guia) ----------
  function b64(s) { try { return decodeURIComponent(escape(atob(s || ""))); } catch (e) { return s || ""; } }
  function hhmm(ts) { var d = new Date(Number(ts) * 1000); function z(n) { return n < 10 ? "0" + n : n; } return z(d.getHours()) + ":" + z(d.getMinutes()); }
  var WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  function dayLbl(ts) { var d = new Date(Number(ts) * 1000); function z(n) { return n < 10 ? "0" + n : n; } return WD[d.getDay()] + ", " + z(d.getDate()) + "/" + z(d.getMonth() + 1); }
  var epgCache = {};
  function epg(id, n) {
    var k = id + "|" + n;
    if (epgCache[k]) return Promise.resolve(epgCache[k]);
    return api("get_short_epg", "&stream_id=" + id + "&limit=" + n).then(function (d) {
      var l = arr(d && d.epg_listings).map(function (e) { return { s: Number(e.start_timestamp), e: Number(e.stop_timestamp), t: b64(e.title) }; });
      var now = Date.now() / 1000; l = l.filter(function (e) { return !e.e || e.e > now; });
      epgCache[k] = l; return l;
    });
  }
  function liveScreen(startCat) {
    var st = { sel: startCat || load("lastLiveCat", "all") };
    return {
      name: "live",
      render: function (back) {
        var self = this;
        $app.innerHTML = frame("tv", '<div class="three"><div class="groups"></div><div class="chans"><div class="empty">Carregando canais...</div></div><div class="guide"><div class="gprev"></div><div class="glist"></div></div></div>');
        bindRail("tv");
        Promise.all([api("get_live_categories"), api("get_live_streams")]).then(function (r) {
          var cats = arr(r[0]), all = visible(r[1], lockMap(cats));
          var g = '<button class="gi focusable" data-k="g-search" data-g="search">' + ICON.search + ' Buscar</button>' +
            '<button class="gi focusable" data-k="g-fav" data-g="fav">' + ICON.star + ' Favoritos</button>' +
            '<button class="gi focusable" data-k="g-all" data-g="all">' + ICON.az + ' Tudo: A-Z</button>';
          cats.forEach(function (c) {
            var lk = hideCat(c);
            g += '<button class="gi focusable" data-k="g-' + esc(c.category_id) + '" data-g="' + esc(c.category_id) + '"' + (lk ? ' data-lock="1"' : "") + '>' + (lk ? "🔒 " : "") + esc(c.category_name) + "</button>";
          });
          var gb = $app.querySelector(".groups"); gb.innerHTML = g;
          var gi = gb.querySelectorAll(".gi");
          for (var i = 0; i < gi.length; i++) gi[i].onclick = function () {
            var v = this.getAttribute("data-g"), name = this.textContent;
            if (v === "search") {
              mark(v);
              searchBox($app.querySelector(".chans"), "Nome do canal", function (q, res) { fill(all.filter(function (c) { return norm(c.name).indexOf(q) >= 0; }), res); });
              return;
            }
            if (this.getAttribute("data-lock")) { askPin(function () { st.sel = v; save("lastLiveCat", v); }, name.replace("🔒 ", "")); return; }
            st.sel = v; save("lastLiveCat", v); mark(v); fill(pick(v));
            var first = $app.querySelector(".ch"); if (first) focusEl(first);
          };
          function mark(v) { for (var j = 0; j < gi.length; j++) gi[j].classList.toggle("on", gi[j].getAttribute("data-g") === v); }
          function pick(v) {
            if (v === "fav") { var f = favs("live"); return all.filter(function (c) { return f[c.stream_id]; }); }
            if (v === "all") return all.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
            return all.filter(function (c) { return String(c.category_id) === String(v); });
          }
          function fill(list, into) {
            var h = "";
            list.slice(0, 600).forEach(function (c, idx) {
              h += '<button class="ch focusable" data-k="ch-' + c.stream_id + '" data-i="' + idx + '">' +
                (c.stream_icon ? '<img loading="lazy" src="' + esc(c.stream_icon) + '" onerror="this.style.visibility=\'hidden\'">' : "<i></i>") +
                '<span class="cn"><b>' + esc(c.name) + (isFav("live", c.stream_id) ? " ★" : "") + '</b><small data-now="' + c.stream_id + '"></small></span></button>';
            });
            var cb = into || $app.querySelector(".chans");
            cb.innerHTML = h || '<div class="empty">' + (st.sel === "fav" && !into ? "Segure OK num canal para favoritar" : "Nenhum canal aqui") + "</div>";
            var urls = list.map(function (c) { return streamUrl("live", c.stream_id, liveExt()); });
            var names = list.map(function (c) { return c.name; });
            var ch = cb.querySelectorAll(".ch");
            for (var k = 0; k < ch.length; k++) {
              ch[k].onclick = function () {
                var i2 = Number(this.getAttribute("data-i")), c = list[i2];
                addHist({ k: "l" + c.stream_id, type: "live", name: c.name, img: c.stream_icon, id: c.stream_id });
                play(urls, names, i2, true);
              };
              ch[k].onfocusnav = (function (c) { return function () { guide(c); }; })(list[k]);
              ch[k].oncontextmenu = (function (c, el) { return function (e) { e.preventDefault(); var on = toggleFav("live", c, c.stream_id); el.querySelector("b").textContent = c.name + (on ? " ★" : ""); }; })(list[k], ch[k]);
            }
            // programa atual embaixo do nome (primeiros canais)
            var seq = list.slice(0, 14), n = 0;
            (function nextNow() {
              if (n >= seq.length) return;
              var c = seq[n++];
              epg(c.stream_id, 8).then(function (l) { setNow(c.stream_id, l); nextNow(); }, nextNow);
            })();
          }
          function setNow(id, l) {
            var el = $app.querySelector('[data-now="' + id + '"]');
            if (el && l[0]) el.textContent = l[0].t;
          }
          var gt = 0;
          function guide(c) {
            $app.querySelector(".gprev").innerHTML = (c.stream_icon ? '<img src="' + esc(c.stream_icon) + '" onerror="this.remove()">' : "") + "<div><b>" + esc(c.name) + "</b><small>OK assiste · segure OK p/ favoritar</small></div>";
            var gl = $app.querySelector(".glist"); gl.innerHTML = '<div class="empty">Carregando guia...</div>';
            clearTimeout(gt);
            gt = setTimeout(function () {
              epg(c.stream_id, 8).then(function (l) {
                setNow(c.stream_id, l);
                var h = "", lastDay = "";
                l.forEach(function (e, n) {
                  var dl = dayLbl(e.s);
                  if (dl !== lastDay) { h += '<div class="eday">' + dl + "</div>"; lastDay = dl; }
                  h += '<div class="ep' + (n === 0 ? " now" : "") + '"><time>' + hhmm(e.s) + "–" + hhmm(e.e) + "</time><span>" + (n === 0 ? "<em>AGORA</em> " : "") + esc(e.t) + "</span></div>";
                });
                gl.innerHTML = h || '<div class="empty">Sem guia de programação</div>';
              }, function () { gl.innerHTML = '<div class="empty">Sem guia de programação</div>'; });
            }, 350);
          }
          var selBtn = gb.querySelector('[data-g="' + String(st.sel).replace(/"/g, "") + '"]');
          if (!selBtn || selBtn.getAttribute("data-lock")) st.sel = "all";
          mark(st.sel); fill(pick(st.sel));
          if (back) restore(self, ".ch"); else focusEl($app.querySelector(".ch") || $app.querySelector('.gi.on'));
        }, function (e) { $app.querySelector(".chans").innerHTML = '<div class="empty">Erro: ' + esc(e.message) + "</div>"; });
      }
    };
  }
  // segurar OK = favoritar (controle remoto)
  var okDown = 0;
  document.addEventListener("keydown", function (e) { if ((e.keyCode === 13 || e.keyCode === 23) && !e.repeat) okDown = Date.now(); else if ((e.keyCode === 13 || e.keyCode === 23) && e.repeat && okDown && Date.now() - okDown > 700) { okDown = 0; var a = document.activeElement; if (a && a.oncontextmenu) a.oncontextmenu({ preventDefault: function () {} }); } }, true);

  // ---------- Filmes e Séries (grupos à esquerda, abas em cima, capas) ----------
  function fmtN(n) { return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
  function interleave(a, b) { var o = [], n = Math.max(a.length, b.length); for (var i = 0; i < n; i++) { if (a[i]) o.push(a[i]); if (b[i]) o.push(b[i]); } return o; }
  function wrap(kind, list) { return list.map(function (it) { return { kind: kind, it: it }; }); }
  function vodScreen(group, tab) {
    var st = { g: group || "dest", t: tab || 0 };
    return {
      name: "vod",
      render: function (back) {
        var self = this;
        $app.innerHTML = frame("vod", '<div class="two"><div class="groups"></div><div class="content"><div class="tabs"></div><div class="grid"><div class="empty">Carregando...</div></div></div></div>');
        bindRail("vod");
        vodData().then(function (D) {
          var mCnt = {}, sCnt = {};
          D.movies.forEach(function (m) { var k = String(m.category_id); mCnt[k] = (mCnt[k] || 0) + 1; });
          D.series.forEach(function (m) { var k = String(m.category_id); sCnt[k] = (sCnt[k] || 0) + 1; });
          function catCount(kind, c) { return ((kind === "series" ? sCnt : mCnt)[String(c.category_id)]) || 0; }
          var nFav = Object.keys(favs("movie")).length + Object.keys(favs("series")).length;
          var groups = [["search", "Buscar"], ["dest", "Destaques"], ["fav", "★ Favoritos", nFav], ["movie", "Filmes", D.movies.length], ["series", "Séries", D.series.length]];
          COLLS.forEach(function (p) {
            var cc = collCats(D, p[2]); if (!cc.length) return;
            var n = 0; cc.forEach(function (x) { n += catCount(x.kind, x.c); });
            groups.push([p[0], p[1], n]);
          });
          var hasAdult = D.mc.some(catLocked) || D.sc.some(catLocked);
          if (hasAdult && lockOn()) groups.push(["adult", (adultUnlocked ? "" : "🔒 ") + "Adultos"]);
          function tabsFor(g) {
            if (g === "dest") return [
              { l: "Séries", f: function () { return wrap("series", recent(D.series, "last_modified", 120)); } },
              { l: "Filmes", f: function () { return wrap("movie", recent(D.movies, "added", 120)); } }];
            if (g === "fav") return [
              { l: "Favoritos", f: function () { var a = favs("movie"), b = favs("series"); return wrap("series", Object.keys(b).map(function (k) { return b[k]; })).concat(wrap("movie", Object.keys(a).map(function (k) { return a[k]; }))); } }];
            if (g === "movie") return [{ l: "Lançamentos", f: function () { return wrap("movie", recent(D.movies, "added", 80)); } }].concat(D.vmc.map(function (c) { return catTab("movie", c, D.movies); }));
            if (g === "series") return [{ l: "Novidades", f: function () { return wrap("series", recent(D.series, "last_modified", 80)); } }].concat(D.vsc.map(function (c) { return catTab("series", c, D.series); }));
            if (g === "adult") {
              var t = [];
              D.mc.forEach(function (c) { if (catLocked(c)) t.push(catTab("movie", c, D.rawM)); });
              D.sc.forEach(function (c) { if (catLocked(c)) t.push(catTab("series", c, D.rawS)); });
              return t;
            }
            for (var i = 0; i < COLLS.length; i++) if (COLLS[i][0] === g)
              return collCats(D, COLLS[i][2]).map(function (x) { return catTab(x.kind, x.c, x.kind === "series" ? D.series : D.movies); });
            return [];
          }
          function catTab(kind, c, list) {
            return { l: c.category_name + " (" + fmtN(catCount(kind, c)) + ")", f: function () { return wrap(kind, list.filter(function (m) { return String(m.category_id) === String(c.category_id); })); } };
          }
          var gb = $app.querySelector(".groups");
          gb.innerHTML = groups.map(function (x) { return '<button class="gi focusable" data-k="vg-' + x[0] + '" data-g="' + x[0] + '">' + (x[0] === "search" ? ICON.search + " " : "") + '<span class="gn">' + esc(x[1]) + "</span>" + (x[2] != null ? '<small class="cnt">' + fmtN(x[2]) + "</small>" : "") + "</button>"; }).join("");
          var gi = gb.querySelectorAll(".gi");
          for (var i = 0; i < gi.length; i++) gi[i].onclick = function () {
            var v = this.getAttribute("data-g");
            if (v === "search") { mark(v); $app.querySelector(".tabs").innerHTML = ""; searchBox($app.querySelector(".grid"), "Nome do filme ou série", function (q, res) {
              var l = wrap("movie", D.movies.filter(function (m) { return norm(m.name).indexOf(q) >= 0; })).concat(wrap("series", D.series.filter(function (m) { return norm(m.name).indexOf(q) >= 0; })));
              cards(l, res);
            }); return; }
            if (v === "adult" && !adultUnlocked) { askPin(function () { st.g = "adult"; st.t = 0; }, "Conteúdo adulto"); return; }
            st.g = v; st.t = 0; draw();
            var f = $app.querySelector(".card") || $app.querySelector(".tab"); if (f) focusEl(f);
          };
          function mark(v) { for (var j = 0; j < gi.length; j++) gi[j].classList.toggle("on", gi[j].getAttribute("data-g") === v); }
          function draw() {
            mark(st.g);
            var tabs = tabsFor(st.g);
            if (st.t >= tabs.length) st.t = 0;
            var tb = $app.querySelector(".tabs");
            tb.innerHTML = tabs.map(function (t, i) { return '<button class="tab focusable' + (i === st.t ? " on" : "") + '" data-k="vt-' + i + '" data-t="' + i + '">' + esc(t.l) + "</button>"; }).join("");
            var tt = tb.querySelectorAll(".tab");
            for (var k = 0; k < tt.length; k++) tt[k].onclick = function () {
              st.t = Number(this.getAttribute("data-t"));
              for (var q = 0; q < tt.length; q++) tt[q].classList.toggle("on", q === st.t);
              cards(tabs[st.t].f(), $app.querySelector(".grid"));
            };
            cards(tabs.length ? tabs[st.t].f() : [], $app.querySelector(".grid"));
          }
          function cards(list, into) {
            var h = "";
            list.slice(0, 300).forEach(function (x, idx) {
              var m = x.it, img = x.kind === "series" ? m.cover : m.stream_icon;
              h += '<button class="card focusable" data-k="c-' + x.kind[0] + (x.kind === "series" ? m.series_id : m.stream_id) + '" data-i="' + idx + '"><div class="poster"' + bg(img) + '></div><span>' + esc(m.name) + "</span></button>";
            });
            into.innerHTML = '<div class="gridin">' + (h || '<div class="empty">' + (st.g === "fav" ? "Segure OK numa capa para favoritar" : "Nada por aqui") + "</div>") + "</div>";
            var c = into.querySelectorAll(".card");
            for (var k = 0; k < c.length; k++) {
              c[k].onclick = function () { var x = list[Number(this.getAttribute("data-i"))]; openItem(x.kind, x.it); };
              c[k].oncontextmenu = (function (x) { return function (e) { e.preventDefault(); toggleFav(x.kind, x.it, x.kind === "series" ? x.it.series_id : x.it.stream_id); }; })(list[k]);
            }
          }
          draw();
          if (back) restore(self, ".card"); else focusEl($app.querySelector(".card") || $app.querySelector(".gi.on"));
        }, function (e) { $app.querySelector(".grid").innerHTML = '<div class="empty">Erro: ' + esc(e.message) + "</div>"; });
      }
    };
  }
  function openItem(type, it) {
    if (type === "movie") {
      var ext = it.container_extension || "mp4";
      addHist({ k: "m" + it.stream_id, type: "movie", name: it.name, img: it.stream_icon, it: it });
      play([streamUrl("movie", it.stream_id, ext)], [it.name], 0, false);
    } else go(seriesScreen(it));
  }
  function seriesScreen(it) {
    var data = null, season = null;
    return {
      name: "series",
      render: function (back) {
        var self = this;
        var bd = it.backdrop_path && it.backdrop_path[0];
        $app.innerHTML = frame("vod", '<div class="detail"' + bg(bd) + '><div class="dshade"></div><div class="dhead"><div class="poster"' + bg(it.cover) + '></div><div><h1>' + esc(it.name) + '</h1><div class="meta">' + esc([it.releaseDate || it.year, it.genre, it.rating ? "★ " + it.rating : ""].filter(Boolean).join(" · ")) + '</div><p>' + esc(it.plot || "") + '</p><button class="btn-fav focusable" data-k="sfav">' + (isFav("series", it.series_id) ? "★ Nos favoritos" : "☆ Favoritar") + '</button></div></div><div class="seasons"></div><div class="eps"><div class="empty">Carregando episódios...</div></div></div>');
        bindRail("vod");
        $app.querySelector(".btn-fav").onclick = function () { toggleFav("series", it, it.series_id); this.textContent = isFav("series", it.series_id) ? "★ Nos favoritos" : "☆ Favoritar"; };
        function draw() {
          var eps = (data && data.episodes) || {}, keys = Object.keys(eps).sort(function (a, b) { return a - b; });
          if (!keys.length) { $app.querySelector(".eps").innerHTML = '<div class="empty">Sem episódios</div>'; return; }
          if (!season || !eps[season]) season = keys[0];
          $app.querySelector(".seasons").innerHTML = keys.map(function (k) { return '<button class="sbtn focusable' + (k === season ? " on" : "") + '" data-k="s-' + k + '" data-s="' + k + '">Temporada ' + k + "</button>"; }).join("");
          var list = eps[season] || [];
          $app.querySelector(".eps").innerHTML = list.map(function (e, i) { return '<button class="epb focusable" data-k="e-' + e.id + '" data-i="' + i + '"><b>' + (e.episode_num || i + 1) + "</b> " + esc(e.title || "Episódio " + (i + 1)) + "</button>"; }).join("");
          var sb = $app.querySelectorAll(".sbtn");
          for (var i = 0; i < sb.length; i++) sb[i].onclick = function () { season = this.getAttribute("data-s"); draw(); focusEl($app.querySelector(".epb")); };
          var urls = list.map(function (e) { return streamUrl("series", e.id, e.container_extension || "mp4"); });
          var names = list.map(function (e) { return it.name + " – T" + season + "E" + (e.episode_num || ""); });
          var eb = $app.querySelectorAll(".epb");
          for (var j = 0; j < eb.length; j++) eb[j].onclick = function () {
            addHist({ k: "s" + it.series_id, type: "series", name: it.name, img: it.cover, it: it });
            play(urls, names, Number(this.getAttribute("data-i")), false);
          };
        }
        if (data) { draw(); restore(self, ".epb"); return; }
        busy(true);
        api("get_series_info", "&series_id=" + it.series_id).then(function (d) { busy(false); data = d || {}; draw(); focusEl($app.querySelector(".epb") || $app.querySelector(".btn-fav")); },
          function (e) { busy(false); toast("Erro: " + e.message); });
      }
    };
  }

  // ---------- Esportes (dados gratuitos da ESPN) ----------
  var ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/";
  var ESPN_TABLE = "https://site.api.espn.com/apis/v2/sports/soccer/";
  var LEAGUES = [
    ["bra.1", "Brasileirão Série A"], ["bra.2", "Brasileirão Série B"], ["bra.copa_do_brazil", "Copa do Brasil"],
    ["conmebol.libertadores", "Libertadores"], ["conmebol.sudamericana", "Sul-Americana"], ["uefa.champions", "Champions League"],
    ["uefa.europa", "Liga Europa"], ["eng.1", "Premier League"], ["esp.1", "La Liga"], ["ita.1", "Serie A Itália"],
    ["ger.1", "Bundesliga"], ["fra.1", "Ligue 1"], ["por.1", "Liga Portugal"], ["ksa.1", "Liga Saudita"], ["usa.1", "MLS"]
  ];
  var TABLE_LEAGUES = ["bra.1", "bra.2", "uefa.champions", "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "por.1", "ksa.1"];
  function lgName(id) { for (var i = 0; i < LEAGUES.length; i++) if (LEAGUES[i][0] === id) return LEAGUES[i][1]; return id; }
  function ymd(d) { function z(n) { return n < 10 ? "0" + n : n; } return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
  function ymd8(d) { return ymd(d).replace(/-/g, ""); }
  var sportCache = {};
  function espn(url) {
    url += (url.indexOf("?") >= 0 ? "&" : "?") + "lang=pt&region=br";
    var c = sportCache[url];
    if (c && Date.now() - c.t < 60000) return Promise.resolve(c.d);
    return httpGet(url).then(function (t) { var d = JSON.parse(t); sportCache[url] = { t: Date.now(), d: d }; return d; });
  }
  function sc(s) { return s == null ? "" : typeof s === "object" ? (s.displayValue != null ? s.displayValue : s.value) : s; }
  function teamOf(cp) {
    var t = (cp && cp.team) || {};
    return { n: t.shortDisplayName || t.displayName || t.name || "?", f: (t.displayName || "") + " " + (t.shortDisplayName || "") + " " + (t.abbreviation || ""), logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || "", s: sc(cp && cp.score) };
  }
  function leagueGames(lg, d1, d2) {
    return espn(ESPN + lg + "/scoreboard?limit=200&dates=" + d1 + (d2 ? "-" + d2 : "")).then(function (r) {
      return arr(r && r.events).map(function (ev) {
        var cp = (ev.competitions && ev.competitions[0]) || {}, cs = arr(cp.competitors);
        var h = cs.filter(function (x) { return x.homeAway === "home"; })[0] || cs[0], a = cs.filter(function (x) { return x.homeAway === "away"; })[0] || cs[1];
        var stt = (ev.status && ev.status.type) || (cp.status && cp.status.type) || {};
        var tv = arr(cp.broadcasts).map(function (b) { return arr(b.names).join(", "); }).filter(Boolean).join(", ");
        return { id: ev.id, t: new Date(ev.date), lg: lg, home: teamOf(h), away: teamOf(a), state: stt.state || "pre", detail: stt.shortDetail || "", clock: ev.status && ev.status.displayClock, tv: tv };
      });
    });
  }
  function dayGames(d) {
    return Promise.all(LEAGUES.map(function (l) { return leagueGames(l[0], ymd8(d)).catch(function () { return null; }); })).then(function (r) {
      var all = [], fails = 0;
      r.forEach(function (x) { if (x === null) fails++; else all = all.concat(x); });
      if (fails === r.length) throw new Error("sem conexão");
      var day = ymd(d);
      all = all.filter(function (g) { return ymd(g.t) === day; });
      all.sort(function (a, b) { return a.t - b.t; });
      return all;
    });
  }
  function gameHtml(g, i, showLg) {
    function z(n) { return n < 10 ? "0" + n : n; }
    var hr = z(g.t.getHours()) + ":" + z(g.t.getMinutes());
    var mid = g.state === "pre" ? '<b class="hr">' + hr + "</b>" : "<b>" + esc(g.home.s) + " x " + esc(g.away.s) + "</b>";
    var badge = g.state === "in" ? '<em class="live">AO VIVO ' + esc(g.clock && g.clock !== "0'" ? g.clock : "") + "</em>" : g.state === "post" ? "<em>Encerrado</em>" : "<em>" + hr + "</em>";
    return '<button class="game focusable" data-k="gm-' + esc(g.id) + '" data-i="' + i + '"><small>' + (showLg ? esc(lgName(g.lg)) : esc(dayLbl(g.t.getTime() / 1000))) + "</small>" +
      '<div class="gl"><span class="tm r">' + esc(g.home.n) + (g.home.logo ? '<img src="' + esc(g.home.logo) + '" onerror="this.remove()">' : "") + "</span>" + mid +
      '<span class="tm">' + (g.away.logo ? '<img src="' + esc(g.away.logo) + '" onerror="this.remove()">' : "") + esc(g.away.n) + "</span></div>" + badge +
      (g.tv ? '<div class="gtv">📺 ' + esc(g.tv) + "</div>" : "") + "</button>";
  }
  function openSportsChannels() {
    api("get_live_categories").then(function (c) {
      var f = arr(c).filter(function (x) { return /esport|sport|futebol|premiere|espn|combate|dazn|tnt|cazé|caze/i.test(x.category_name) && !catLocked(x); })[0];
      stack = []; show(liveScreen(f ? f.category_id : "all"));
    }, function () { stack = []; show(liveScreen()); });
  }
  // Canais que costumam passar cada liga no Brasil (usado quando a ESPN não informa a transmissão)
  var LG_TV = {
    "bra.1": ["premiere", "globo", "sportv", "caze", "record", "amazon", "prime"], "bra.2": ["premiere", "sportv", "band", "espn", "disney"],
    "bra.copa_do_brazil": ["premiere", "sportv", "globo", "amazon", "prime"], "conmebol.libertadores": ["espn", "globo", "sportv", "paramount", "disney"],
    "conmebol.sudamericana": ["espn", "paramount", "disney"], "uefa.champions": ["tnt", "hbo", "max", "space", "caze", "amazon", "prime", "sbt"],
    "uefa.europa": ["espn", "disney", "tnt", "space"], "eng.1": ["espn", "disney"], "esp.1": ["espn", "disney"], "ita.1": ["espn", "disney"],
    "ger.1": ["caze", "sportv", "onefootball"], "fra.1": ["caze", "espn", "disney"], "por.1": ["espn", "disney", "sportv"], "ksa.1": ["band", "caze", "sportv"], "usa.1": ["apple", "espn"]
  };
  var TV_ALIAS = { "disney+": "espn", "disney plus": "espn", "star+": "espn", "max": "tnt", "hbo max": "tnt", "amazon prime video": "prime", "prime video": "prime", "cazetv": "caze", "caze tv": "caze", "sportv": "sportv", "tv globo": "globo", "ge tv": "globo", "paramount+": "paramount" };
  function tvKeys(g) {
    var keys = [];
    String(g.tv || "").split(/\s*,\s*/).forEach(function (n) {
      n = norm(n).trim(); if (!n) return;
      var k = TV_ALIAS[n] || n.replace(/\+/g, "").replace(/\s*(hd|fhd|4k)$/, "").replace(/\s*\d+$/, "").trim();
      if (k && keys.indexOf(k) < 0) keys.push(k);
    });
    (LG_TV[g.lg] || []).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    return keys;
  }
  function teamWords(n) { return norm(n).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (w) { return w.length >= 4 && !/^(clube|futebol|club|sport|esporte|united|city|real|atletico)$/.test(w); }); }
  function openGame(g) {
    busy(true, "Procurando o canal do jogo...");
    Promise.all([api("get_live_categories"), api("get_live_streams")]).then(function (r) {
      busy(false);
      var cats = arr(r[0]), all = visible(r[1], lockMap(cats)), sportCat = {};
      cats.forEach(function (c) { if (/esport|sport|futebol|premiere|espn|combate|dazn|tnt|caze|jogos|evento|ppv/.test(norm(c.category_name))) sportCat[String(c.category_id)] = 1; });
      var found = [], seen = {};
      function add(c, score) { if (!seen[c.stream_id]) { seen[c.stream_id] = 1; found.push({ c: c, s: score }); } }
      // 1º: canal de evento com o nome dos times (ex.: "Man City x Liverpool")
      var hw = teamWords(g.home.f || g.home.n), aw = teamWords(g.away.f || g.away.n);
      all.forEach(function (c) {
        var n = norm(c.name), h = hw.some(function (w) { return n.indexOf(w) >= 0; }), a = aw.some(function (w) { return n.indexOf(w) >= 0; });
        if (h && a) add(c, 0); else if ((h || a) && sportCat[String(c.category_id)]) add(c, 1);
      });
      // 2º: canal que transmite (ESPN, Premiere, TNT...)
      tvKeys(g).forEach(function (k, ki) {
        var kk = k.replace(/[^a-z0-9 ]/g, "").trim(); if (kk.length < 3) return;
        var re = new RegExp("(^|[^a-z])" + kk + "($|[^a-z])");
        all.forEach(function (c) {
          var n = norm(c.name); if (!re.test(n)) return;
          var q = /fhd|full ?hd|1080/.test(n) ? 0 : /\bhd\b/.test(n) ? 0.1 : /\bsd\b|alt|h265/.test(n) ? 0.4 : 0.2;
          add(c, 10 + ki + q + (sportCat[String(c.category_id)] ? 0 : 0.5));
        });
      });
      found.sort(function (x, y) { return x.s - y.s || String(x.c.name).localeCompare(String(y.c.name)); });
      var list = found.slice(0, 40).map(function (x) { return x.c; });
      if (!list.length) { toast("Canal do jogo não encontrado. Abrindo canais de esporte..."); openSportsChannels(); return; }
      var c0 = list[0];
      addHist({ k: "l" + c0.stream_id, type: "live", name: c0.name, img: c0.stream_icon, id: c0.stream_id });
      play(list.map(function (c) { return streamUrl("live", c.stream_id, liveExt()); }), list.map(function (c) { return c.name; }), 0, true);
      if (list.length > 1) setTimeout(function () { toast("Não é o jogo? Use ▲ ▼ no player para trocar de canal", 5000); }, 800);
    }, function () { busy(false); openSportsChannels(); });
  }
  function bindGames(box, list) {
    var b = box.querySelectorAll(".game");
    for (var i = 0; i < b.length; i++) b[i].onclick = function () { var g = list && list[Number(this.getAttribute("data-i"))]; if (g) openGame(g); else openSportsChannels(); };
  }
  var MAIN_LG = { "bra.1": 1, "bra.2": 1, "bra.copa_do_brazil": 1, "conmebol.libertadores": 1, "conmebol.sudamericana": 1, "uefa.champions": 1, "eng.1": 1, "esp.1": 1 };
  function sportScreen() {
    return {
      name: "sport",
      render: function (back) {
        var self = this;
        $app.innerHTML = frame("sport", '<div class="sp-home"><div class="sp-top"><h2>Principais eventos</h2><span class="hint">OK num jogo abre direto o canal que transmite</span></div>' +
          '<div class="sp-body"><div class="sp-main"><div class="empty">Carregando jogos de hoje...</div></div><div class="sp-side">' +
          '<button class="spc focusable" data-k="sp-cal" data-v="cal">' + ICON.cal + "<span>Calendário de eventos</span></button>" +
          '<button class="spc focusable" data-k="sp-lg" data-v="lg">' + ICON.trophy + "<span>Eventos da liga</span></button>" +
          '<button class="spc focusable" data-k="sp-tab" data-v="tab">' + ICON.table + "<span>Classificação</span></button></div></div></div>");
        bindRail("sport");
        var b = $app.querySelectorAll(".spc");
        for (var i = 0; i < b.length; i++) b[i].onclick = function () {
          var v = this.getAttribute("data-v");
          if (v === "cal") go(gamesScreen()); else if (v === "lg") go(leagueScreen()); else go(tableScreen());
        };
        var box = $app.querySelector(".sp-main");
        dayGames(new Date()).then(function (all) {
          var live = all.filter(function (g) { return g.state === "in"; });
          var top = all.filter(function (g) { return g.state !== "in" && MAIN_LG[g.lg]; });
          var rest = all.filter(function (g) { return g.state !== "in" && !MAIN_LG[g.lg]; });
          var list = live.concat(top, rest).slice(0, 30);
          if (!document.body.contains(box)) return;
          box.innerHTML = list.length ? '<div class="gcol">' + list.map(function (g, i) { return gameHtml(g, i, true); }).join("") + "</div>" : '<div class="empty">Nenhum jogo das principais ligas hoje. Veja o Calendário de eventos.</div>';
          bindGames(box, list);
          if (back) restore(self, ".spc");
        }, function () { box.innerHTML = '<div class="empty">Não foi possível carregar os jogos agora. Confira a internet e tente de novo.</div>'; });
        if (back) restore(self, ".spc"); else focusFirst(".spc");
      }
    };
  }
  function gamesScreen() {
    var cur = ymd(new Date());
    return {
      name: "games",
      render: function (back) {
        var self = this, h = "";
        for (var i = -3; i <= 6; i++) {
          var d = new Date(); d.setDate(d.getDate() + i);
          h += '<button class="gi day focusable" data-k="d' + i + '" data-d="' + ymd(d) + '">' + (i === 0 ? "Hoje" : i === 1 ? "Amanhã" : i === -1 ? "Ontem" : WD[d.getDay()]) + "<b>" + ymd(d).slice(8) + "/" + ymd(d).slice(5, 7) + "</b></button>";
        }
        $app.innerHTML = frame("sport", '<div class="two"><div class="groups">' + h + '</div><div class="content"><h2>Calendário de eventos</h2><div class="games"></div></div></div>');
        bindRail("sport");
        var dd = $app.querySelectorAll(".day");
        for (var j = 0; j < dd.length; j++) dd[j].onclick = function () { cur = this.getAttribute("data-d"); load2(); };
        function load2() {
          for (var j = 0; j < dd.length; j++) dd[j].classList.toggle("on", dd[j].getAttribute("data-d") === cur);
          var box = $app.querySelector(".games"); box.innerHTML = '<div class="empty">Carregando jogos...</div>';
          var p = cur.split("-");
          dayGames(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12)).then(function (all) {
            box.innerHTML = all.map(function (g, i) { return gameHtml(g, i, true); }).join("") || '<div class="empty">Nenhum jogo nesse dia</div>';
            bindGames(box, all);
          }, function () { box.innerHTML = '<div class="empty">Não foi possível carregar os jogos agora</div>'; });
        }
        load2();
        if (back) restore(self, ".day.on"); else focusEl($app.querySelector('.day[data-d="' + cur + '"]'));
      }
    };
  }
  function leagueScreen() {
    var cur = LEAGUES[0][0];
    return {
      name: "league",
      render: function (back) {
        var self = this;
        var h = LEAGUES.map(function (l) { return '<button class="gi focusable" data-k="lg-' + l[0] + '" data-l="' + l[0] + '">' + esc(l[1]) + "</button>"; }).join("");
        $app.innerHTML = frame("sport", '<div class="two"><div class="groups">' + h + '</div><div class="content"><h2>Eventos da liga</h2><div class="hint">Últimos resultados e próximos jogos</div><div class="games"></div></div></div>');
        bindRail("sport");
        var g = $app.querySelectorAll(".gi");
        for (var i = 0; i < g.length; i++) g[i].onclick = function () { cur = this.getAttribute("data-l"); load2(); };
        function load2() {
          for (var i = 0; i < g.length; i++) g[i].classList.toggle("on", g[i].getAttribute("data-l") === cur);
          var box = $app.querySelector(".games"); box.innerHTML = '<div class="empty">Carregando...</div>';
          var lg = cur, days = [];
          for (var k = -4; k <= 12; k++) { var d = new Date(); d.setDate(d.getDate() + k); days.push(ymd8(d)); }
          Promise.all(days.map(function (d) { return leagueGames(lg, d).catch(function () { return null; }); })).then(function (r) {
            if (lg !== cur || !document.body.contains(box)) return;
            var all = [], seen = {}, fails = 0;
            r.forEach(function (x) { if (x === null) { fails++; return; } x.forEach(function (gm) { if (!seen[gm.id]) { seen[gm.id] = 1; all.push(gm); } }); });
            if (fails === r.length) { box.innerHTML = '<div class="empty">Não foi possível carregar agora. Confira a internet e tente de novo.</div>'; return; }
            all.sort(function (x, y) { return x.t - y.t; });
            var h = "", lastDay = "";
            all.forEach(function (gm, i) { var dl = dayLbl(gm.t.getTime() / 1000); if (dl !== lastDay) { h += '<div class="eday">' + esc(dl) + "</div>"; lastDay = dl; } h += gameHtml(gm, i, false); });
            box.innerHTML = h || '<div class="empty">Sem jogos dessa liga nesses dias</div>';
            bindGames(box, all);
          });
        }
        load2();
        if (back) restore(self, ".gi.on"); else focusFirst(".gi");
      }
    };
  }
  function stat(e, names) {
    var s = arr(e.stats);
    for (var n = 0; n < names.length; n++) for (var i = 0; i < s.length; i++)
      if (s[i].name === names[n] || s[i].type === names[n] || s[i].abbreviation === names[n]) return s[i].displayValue != null ? s[i].displayValue : s[i].value;
    return "";
  }
  function tableScreen() {
    var cur = TABLE_LEAGUES[0];
    return {
      name: "table",
      render: function (back) {
        var self = this;
        var h = TABLE_LEAGUES.map(function (l) { return '<button class="gi focusable" data-k="tb-' + l + '" data-l="' + l + '">' + esc(lgName(l)) + "</button>"; }).join("");
        $app.innerHTML = frame("sport", '<div class="two"><div class="groups">' + h + '</div><div class="content"><h2>Classificação</h2><div class="hint">J: Jogos · V: Vitórias · E: Empates · D: Derrotas · SG: Saldo · PTS: Pontos</div><div class="tbl"></div></div></div>');
        bindRail("sport");
        var g = $app.querySelectorAll(".gi");
        for (var i = 0; i < g.length; i++) g[i].onclick = function () { cur = this.getAttribute("data-l"); show2(); };
        function show2() {
          for (var i = 0; i < g.length; i++) g[i].classList.toggle("on", g[i].getAttribute("data-l") === cur);
          var box = $app.querySelector(".tbl"); box.innerHTML = '<div class="empty">Carregando...</div>';
          espn(ESPN_TABLE + cur + "/standings").then(function (r) {
            var groups = r && r.children && r.children.length ? r.children : [r || {}], out = "";
            groups.forEach(function (gr) {
              var en = arr(gr.standings && gr.standings.entries).slice();
              if (!en.length) return;
              en.sort(function (a, b) {
                var ra = Number(stat(a, ["rank"])) || 0, rb = Number(stat(b, ["rank"])) || 0;
                if (ra && rb) return ra - rb;
                return (Number(stat(b, ["points"])) || 0) - (Number(stat(a, ["points"])) || 0) || (Number(stat(b, ["pointDifferential"])) || 0) - (Number(stat(a, ["pointDifferential"])) || 0);
              });
              if (groups.length > 1 && gr.name) out += "<h3>" + esc(gr.name) + "</h3>";
              out += '<table><tr><th>#</th><th class="l">Time</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>PTS</th></tr>' + en.map(function (x, n) {
                var t = x.team || {}, logo = t.logos && t.logos[0] && t.logos[0].href;
                return "<tr><td>" + (stat(x, ["rank"]) || n + 1) + '</td><td class="l">' + (logo ? '<img src="' + esc(logo) + '" onerror="this.remove()">' : "") + esc(t.shortDisplayName || t.displayName || "") + "</td><td>" + esc(stat(x, ["gamesPlayed", "GP"])) + "</td><td>" + esc(stat(x, ["wins", "W"])) + "</td><td>" + esc(stat(x, ["ties", "D", "T"])) + "</td><td>" + esc(stat(x, ["losses", "L"])) + "</td><td>" + esc(stat(x, ["pointDifferential", "GD"])) + "</td><td><b>" + esc(stat(x, ["points", "P"])) + "</b></td></tr>";
              }).join("") + "</table>";
            });
            box.innerHTML = out || '<div class="empty">Classificação indisponível para essa liga</div>';
          }, function () { box.innerHTML = '<div class="empty">Não foi possível carregar agora</div>'; });
        }
        show2();
        if (back) restore(self, ".gi.on"); else focusFirst(".gi");
      }
    };
  }

  // ---------- Histórico ----------
  function histScreen() {
    return {
      name: "hist",
      render: function () {
        var h = history.map(function (x, i) {
          return '<button class="card focusable" data-k="h' + i + '" data-i="' + i + '"><div class="poster' + (x.type === "live" ? " logo" : "") + '"' + bg(x.img) + '></div><span>' + esc(x.name) + "</span></button>";
        }).join("");
        $app.innerHTML = frame("hist", '<div class="content full"><h2>Assistidos recentemente</h2><div class="gridin">' + (h || '<div class="empty">Você ainda não assistiu nada</div>') + "</div></div>");
        bindRail("hist");
        var c = $app.querySelectorAll(".card");
        for (var i = 0; i < c.length; i++) c[i].onclick = function () {
          var x = history[Number(this.getAttribute("data-i"))];
          if (x.type === "live") play([streamUrl("live", x.id, liveExt())], [x.name], 0, true); else openItem(x.type, x.it);
        };
        focusFirst(".card");
      }
    };
  }

  // ---------- Configurações ----------
  function setScreen() {
    return {
      name: "set",
      render: function (back) {
        var self = this;
        var ver = ""; try { if (window.Native && window.Native.version) ver = window.Native.version(); } catch (e) {}
        $app.innerHTML = frame("set", '<div class="content full set"><div class="sethead"><img src="logo.png" alt=""><h2>Configurações</h2></div>' +
          '<div class="info"><p>Usuário: <b>' + esc(creds.user) + "</b></p><p>Vencimento: <b>" + esc(fmtDate(account && account.exp_date)) + "</b></p><p>Telas: <b>" + esc((account && account.max_connections) || "1") + "</b></p>" + (ver ? "<p>Versão do app: <b>" + esc(ver) + "</b></p>" : "") + "</div>" +
          '<button class="sbtn focusable" data-k="a-dev" data-a="dev">Tipo de dispositivo: ' + (device === "phone" ? "Celular" : "TV") + "</button>" +
          '<button class="sbtn focusable" data-k="a-adult" data-a="adult">🔒 Conteúdo adulto: ' + (lockOn() ? "bloqueado" : "liberado") + "</button>" +
          '<button class="sbtn focusable" data-k="a-pin" data-a="pin">Trocar senha do controle dos pais</button>' +
          '<button class="sbtn focusable" data-k="a-hist" data-a="hist">Limpar histórico</button>' +
          (window.Native && window.Native.checkUpdate ? '<button class="sbtn focusable" data-k="a-upd" data-a="upd">Verificar atualização</button>' : "") +
          (C.whatsapp ? '<button class="sbtn focusable" data-k="a-wa" data-a="wa">Suporte: WhatsApp ' + esc(fmtPhone(C.whatsapp)) + "</button>" : "") +
          '<button class="sbtn red focusable" data-k="a-out" data-a="out">Sair da conta</button>' +
          '<p class="pinhint">Senha padrão do controle dos pais: <b>' + DEFAULT_PIN + "</b>. Troque para uma só sua.</p></div>");
        bindRail("set");
        var b = $app.querySelectorAll(".sbtn");
        for (var i = 0; i < b.length; i++) b[i].onclick = function () {
          var a = this.getAttribute("data-a");
          if (a === "dev") show(deviceScreen(function () { show(setScreen()); }));
          else if (a === "adult") askPin(function () { save("adult_on", !lockOn()); if (lockOn()) adultUnlocked = false; cache = {}; }, "Controle dos pais");
          else if (a === "pin") askPin(function () { setTimeout(function () { go(newPinScreen()); }, 0); }, "Controle dos pais");
          else if (a === "hist") { history = []; save("hist", []); toast("Histórico limpo"); }
          else if (a === "upd") { toast("Verificando atualização..."); window.Native.checkUpdate(); }
          else if (a === "wa") toast("Chame no WhatsApp: " + fmtPhone(C.whatsapp), 5000);
          else if (a === "out") { save("account", null); account = null; cache = {}; epgCache = {}; adultUnlocked = false; stack = []; show(loginScreen()); }
        };
        if (back) restore(self, ".sbtn"); else focusFirst(".sbtn");
      }
    };
  }

  // ---------- início ----------
  function start() { if (creds && account) show(homeScreen()); else show(loginScreen()); }
  if (isWeb && !device) { device = (Math.min(screen.width, screen.height) < 700) ? "phone" : "tv"; save("device", device); applyDevice(); }
  if (isWeb) {
    var bb = document.createElement("button"); bb.id = "webBack"; bb.setAttribute("aria-label", "Voltar"); bb.textContent = "‹";
    bb.onclick = function () { window.appBack(); };
    document.body.appendChild(bb);
    setInterval(function () { bb.style.display = stack.length ? "flex" : "none"; }, 300);
  }
  if (!device) show(deviceScreen(start)); else start();
})();
