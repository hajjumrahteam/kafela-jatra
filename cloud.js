/* Kafela Jatra online part: admin panel, kafela profiles, live notices and content changes.
   Talks to Firebase (Authentication + Realtime Database) over its REST API, so no extra library is needed.
   Loaded before the main script: cached admin changes are applied to the content right away (works offline). */
(function () {
"use strict";
const CFG = window.HG_CLOUD || {};
const READY = !!(CFG.apiKey && CFG.databaseURL && !/PASTE_/.test(CFG.apiKey + CFG.databaseURL));
const ADMIN_EMAIL = CFG.adminEmail || "admin@kafelajatra.app";
const ls = {
  get(k, d) { try { const v = localStorage.getItem("kj:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("kj:" + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("kj:" + k); } catch (e) {} }
};
const q = (s, r = document) => r.querySelector(s), qq = (s, r = document) => [...r.querySelectorAll(s)];
const E = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const B = v => String(v).replace(/\d/g, d => "০১২৩৪৫৬৭৮৯"[d]);
const lines = s => String(s || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
const paras = s => String(s || "").split(/\n\s*\n+/).map(x => x.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rid = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a].map(x => ALPH[x % ALPH.length]).join(""); };
const fmtCode = c => c.slice(0, 5) + "-" + c.slice(5);
const ago = t => { if (!t) return "কখনো না"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "এইমাত্র" : m < 60 ? B(m) + " মিনিট আগে" : m < 1440 ? B(Math.round(m / 60)) + " ঘণ্টা আগে" : B(Math.round(m / 1440)) + " দিন আগে"; };
const toastMsg = m => { if (typeof toast === "function") toast(m); };

/* ---------------- Firebase REST ---------------- */
async function authCall(path, body) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${CFG.apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "AUTH_FAILED"); e.code = e.message; throw e; }
  return j;
}
function Session(key) {
  let s = ls.get(key, null);
  return {
    get on() { return !!s; }, get uid() { return s && s.uid; },
    set(j) { s = { idToken: j.idToken, refreshToken: j.refreshToken, uid: j.localId, exp: Date.now() + ((+j.expiresIn || 3600) - 120) * 1000 }; ls.set(key, s); },
    async token() {
      if (!s) return null;
      if (Date.now() > s.exp) {
        const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${CFG.apiKey}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(s.refreshToken) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (r.status === 400) { this.clear(); } throw new Error("REFRESH_FAILED"); }
        s.idToken = j.id_token; s.refreshToken = j.refresh_token; s.uid = j.user_id; s.exp = Date.now() + ((+j.expires_in || 3600) - 120) * 1000; ls.set(key, s);
      }
      return s.idToken;
    },
    clear() { s = null; ls.del(key); }
  };
}
const adm = Session("adm"), mem = Session("mem");
async function db(method, path, data, sess) {
  let url = `${CFG.databaseURL.replace(/\/+$/, "")}/${path}.json`;
  const t = sess ? await sess.token() : null;
  if (t) url += "?auth=" + encodeURIComponent(t);
  const o = { method, cache: "no-store" };
  if (data !== undefined) { o.headers = { "Content-Type": "application/json" }; o.body = JSON.stringify(data); }
  const r = await fetch(url, o);
  if (!r.ok) { const e = new Error("DB_" + r.status); e.status = r.status; throw e; }
  return r.json();
}
const NOW = { ".sv": "timestamp" };

/* ---------------- admin changes to the content ---------------- */
function parseWins(s) {
  const out = [];
  String(s || "").split(/[,،;]+/).forEach(part => {
    const m = part.match(/(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})/); if (!m) return;
    const a = (+m[1]) * 60 + (+m[2]), b = (+m[3]) * 60 + (+m[4]);
    if (b > a) out.push([a, b]); else { out.push([a, 1440]); if (b > 0) out.push([0, b]); }
  });
  return out;
}
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
function winsText(w) {
  const arr = (w || []).slice().sort((x, y) => x[0] - y[0]);
  // join a window that runs past midnight back into one piece
  const end = arr.find(x => x[1] === 1440), start = arr.find(x => x[0] === 0);
  const parts = [];
  arr.forEach(x => { if (x === start && end) return; if (x === end && start) parts.push(hhmm(x[0]) + "-" + hhmm(start[1])); else parts.push(hhmm(x[0]) + "-" + hhmm(x[1] % 1440)); });
  return parts.join(", ");
}
/* ---------------- admin corrections to the built-in texts ---------------- */
// every built-in item gets a stable key from its original title, so a correction keeps working when files are updated
const hk = s => { let h = 5381; for (const ch of String(s)) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0; return h.toString(36); };
function stampKeys() {
  const seenK = {};
  const uniq = k => { seenK[k] = (seenK[k] || 0) + 1; return seenK[k] > 1 ? k + "_" + seenK[k] : k; };
  (window.DUAS || []).forEach(d => { if (!d._k && !d._cloud) d._k = uniq("d" + hk(d.g + "|" + d.t)); });
  (window.SUNNAH || []).forEach(g => (g[1] || []).forEach(it => { if (!it._k) it._k = uniq("s" + hk(g[0] + "|" + it[0])); }));
  (window.SEERAH || []).forEach(s => { if (!s._k) s._k = uniq("r" + hk(s.t)); });
  for (const [gk, G] of Object.entries(window.GUIDE || {})) (G.sections || []).forEach(s => { if (!s._k) s._k = "g" + gk + "_" + String(s.id).replace(/[.#$\[\]\/]/g, "-"); });
}
const pick = (e, keys) => { const o = {}; keys.forEach(k => { if (e[k] !== undefined) o[k] = e[k]; }); return o; };
function applyEdits(ed) {
  if (!ed) return;
  const D = window.DUAS || [];
  for (let i = D.length - 1; i >= 0; i--) { const e = ed[D[i]._k]; if (!e) continue; if (e.hide) D.splice(i, 1); else Object.assign(D[i], pick(e, ["g", "t", "ref", "note", "times", "pron", "mean", "w"])); }
  (window.SUNNAH || []).forEach(g => { const A = g[1] || []; for (let i = A.length - 1; i >= 0; i--) { const e = ed[A[i]._k]; if (!e) continue; if (e.hide) A.splice(i, 1); else { if (e.t !== undefined) A[i][0] = e.t; if (e.text !== undefined) A[i][1] = e.text; if (e.ref !== undefined) A[i][2] = e.ref; } } });
  const S = window.SEERAH || [];
  for (let i = S.length - 1; i >= 0; i--) { const e = ed[S[i]._k]; if (!e) continue; if (e.hide) S.splice(i, 1); else Object.assign(S[i], pick(e, ["t", "era", "age", "place", "ar", "arMean", "body", "lesson", "src"])); }
  for (const G of Object.values(window.GUIDE || {})) { const A = G.sections || []; for (let i = A.length - 1; i >= 0; i--) { const e = ed[A[i]._k]; if (!e) continue; if (e.hide) A.splice(i, 1); else Object.assign(A[i], pick(e, ["title", "when", "body", "todo", "avoid", "women", "src"])); } }
}
// Quran: corrected pronunciation or meaning of single verses
function patchSurah(data) {
  const ed = content && content.edits; if (!ed || !data) return data;
  (data.verses || []).forEach((v, i) => { const e = ed["q" + data.n + "_" + (i + 1)]; if (e) { if (e.t) v.t = e.t; if (e.b) v.b = e.b; } });
  return data;
}
function applyContent(c) {
  stampKeys();
  if (!c) return;
  try { applyEdits(c.edits); } catch (e) {}
  const H = window.HATEEM;
  if (c.hateem && H) {
    const h = c.hateem;
    for (const k of ["women", "men"]) if (h[k] && H[k]) {
      const g = h[k], o = H[k];
      ["title", "time", "gateTag", "gateText", "goto", "fieldNote"].forEach(f => { if (g[f] !== undefined && g[f] !== "") o[f] = g[f]; });
      if (g.fieldNote === "") o.fieldNote = "";
      if (g.openTxt) { const w = parseWins(g.openTxt); if (w.length) o.open = w; }
      if (g.waitTxt !== undefined) o.wait = parseWins(g.waitTxt);
      if (g.steps && g.steps.length) o.steps = g.steps;
    }
    if (h.warn) H.warn = h.warn;
    if (h.updated) H.updated = h.updated;
    if (h.crowd && h.crowd.length) H.crowd = h.crowd;
  }
  const items = c.items ? Object.entries(c.items).sort((a, b) => (a[1].t || 0) - (b[1].t || 0)) : [];
  for (const [id, it] of items) {
    try {
      if (it.type === "dua" && window.DUAS) window.DUAS.push({ g: it.g || "নতুন দোয়া", t: it.title, ref: it.ref || "", note: it.note || "", w: Array.isArray(it.w) && it.w.length ? it.w : String(it.ar || "").trim().split(/\s+/).filter(Boolean).map(a => [a, ""]), times: it.times || "", pron: it.pron || "", mean: it.mean || "", _cloud: id });
      else if (it.type === "sunnah" && window.SUNNAH) {
        let grp = window.SUNNAH.find(x => x[0] === it.g); if (!grp) { grp = [it.g || "নতুন সুন্নত", []]; window.SUNNAH.push(grp); }
        grp[1].push([it.title, it.text || "", it.ref || ""]);
      }
      else if (it.type === "seerah" && window.SEERAH) window.SEERAH.push({ era: it.g || "আরও অধ্যায়", age: it.age || "", yr: "", t: it.title, ar: it.ar || "", arMean: it.arMean || "", body: paras(it.text), lesson: it.lesson || "", src: it.ref || "" });
      else if (it.type === "guide" && window.GUIDE && window.GUIDE[it.guide]) window.GUIDE[it.guide].sections.push({ id: "x-" + id, title: it.title, when: it.when || "", body: paras(it.text), todo: lines(it.todo), avoid: lines(it.avoid), women: lines(it.women), duas: [], src: it.ref || "" });
    } catch (e) {}
  }
}
let content = ls.get("content", null);
applyContent(content);
// map places are applied by the main script once it has built its list
function applyPlaces(P) {
  if (!content) return;
  const del = content.placesDel || {};
  for (let i = P.length - 1; i >= 0; i--) if (del[P[i].id]) P.splice(i, 1);
  for (const [id, p] of Object.entries(content.places || {})) {
    if (!p || typeof p.lat !== "number") continue;
    const i = P.findIndex(x => x.id === id);
    const obj = Object.assign(i >= 0 ? Object.assign({}, P[i]) : { kind: "history", label: "•", tips: [] }, p, { id });
    if (!obj.city) obj.city = obj.lat > 23 ? "madinah" : "makkah";
    if (i >= 0) P[i] = obj; else P.push(obj);
  }
}

/* ---------------- notifications (app and website) ---------------- */
let _ln = null;
const LN = () => {
  if (_ln) return _ln;
  const C = window.Capacitor;
  if (!C || !(C.isNativePlatform ? C.isNativePlatform() : C.isNative)) return null;
  if (C.Plugins && C.Plugins.LocalNotifications) return (_ln = C.Plugins.LocalNotifications);
  if (typeof C.registerPlugin === "function") return (_ln = C.registerPlugin("LocalNotifications"));
  return null;
};
async function notify(title, body) {
  try {
    const ln = LN();
    if (ln) { await ln.schedule({ notifications: [{ id: 3000 + Math.floor(Math.random() * 900), title, body, channelId: "haram", smallIcon: "ic_stat_haram", iconColor: "#0B6B50", schedule: { at: new Date(Date.now() + 1000), allowWhileIdle: true } }] }); return; }
    if ("Notification" in window && Notification.permission === "granted") {
      const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) reg.showNotification(title, { body, icon: "icon-192.png" }); else new Notification(title, { body, icon: "icon-192.png" });
    }
  } catch (e) {}
}

/* ---------------- styles ---------------- */
const css = `
.cl-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin:12px 0}
.cl-card h3{font-size:18px;margin-bottom:6px}
.cl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cl-in{width:100%;border:1.5px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit;font-size:16px;background:var(--surface);color:var(--ink);min-height:48px}
textarea.cl-in{min-height:110px;line-height:1.6}
.cl-f{display:block;margin:10px 0}
.cl-f>span{display:block;font-weight:700;margin-bottom:4px;font-size:15px}
.cl-f>small{display:block;color:var(--muted);margin-top:3px}
.cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px}
.cl-notice{border-left:5px solid var(--gold);background:var(--gold-soft);color:#2b2108;border-radius:0 14px 14px 0;padding:10px 14px;margin:10px 0}
.cl-notice b{display:block;font-size:16px}
.cl-notice small{color:#6b5a2a}
.cl-me{display:flex;gap:14px;align-items:center}
.cl-ph{width:64px;height:64px;border-radius:50%;object-fit:cover;background:var(--green-soft);flex:0 0 auto;display:grid;place-items:center;font-weight:800;color:var(--green);font-size:24px;overflow:hidden}
.cl-ph img{width:100%;height:100%;object-fit:cover}
.cl-list{list-style:none;padding:0;margin:8px 0}
.cl-item{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin:8px 0;background:var(--surface)}
.cl-item .cl-ph{width:52px;height:52px;font-size:20px}
.cl-item .grow{flex:1;min-width:0}
.cl-item b{display:block}
.cl-item small{color:var(--muted);display:block}
.cl-acts{display:flex;gap:6px;flex-wrap:wrap}
.cl-acts button,.cl-acts a{border:1.5px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:7px 11px;font-weight:700;font-size:14px;text-decoration:none}
.cl-acts .danger{color:#b3261e;border-color:#e2b4ae}
.cl-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;background:#9aa5a0}
.cl-dot.live{background:#1fa463}.cl-dot.mid{background:#e39a1c}
.cl-code{font-family:ui-monospace,monospace;font-weight:800;letter-spacing:1px;background:var(--marble);border-radius:8px;padding:2px 8px}
#admMap{height:min(55vh,460px);border-radius:16px;border:1px solid var(--line);margin:10px 0}
.adm-pin{width:40px;height:40px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);overflow:hidden;background:#0B6B50;color:#fff;display:grid;place-items:center;font-weight:800}
.adm-pin img{width:100%;height:100%;object-fit:cover}
.adm-pin.old{filter:grayscale(1) opacity(.75)}
.adm-name{background:rgba(0,0,0,.72);color:#fff;border-radius:6px;padding:1px 6px;font-size:12px;white-space:nowrap;position:absolute;top:42px;left:50%;transform:translateX(-50%)}
.adm-hotel{width:34px;height:34px;border-radius:9px;background:#C9A24A;color:#000;display:grid;place-items:center;font-weight:800;border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4)}
.cl-pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px;background:var(--marble);border:1px solid var(--line);border-radius:12px;padding:10px;max-height:260px;overflow:auto;direction:ltr;text-align:left}
.cl-tabs{display:flex;gap:6px;overflow-x:auto;padding:4px 0 8px;scrollbar-width:none}
.cl-tabs button{flex:0 0 auto;border:1.5px solid var(--line);background:var(--surface);border-radius:999px;padding:9px 15px;font-weight:700}
.cl-tabs button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.cl-lock{max-width:420px;margin:30px auto;text-align:center}
.cl-err{color:#b3261e;font-weight:700;min-height:24px;margin:8px 0}
.cl-ok{color:var(--green);font-weight:700}
.kj-locked,.kj-locked body{overflow:hidden}
.kj-gate{position:fixed;inset:0;z-index:6000;overflow:auto;display:grid;place-items:center;padding:24px 16px;color:#fff;background:var(--head-bg)}
.kj-gate::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background:repeating-linear-gradient(45deg,rgba(255,255,255,.025) 0 2px,transparent 2px 9px),repeating-linear-gradient(-45deg,rgba(255,255,255,.02) 0 2px,transparent 2px 9px)}
.kj-gate-in{position:relative;width:100%;max-width:420px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:stretch}
.kj-gate-logo{height:min(240px,32vh);width:auto;align-self:center;border-radius:4px;box-shadow:0 0 0 2px rgba(214,176,84,.9),0 16px 44px rgba(0,0,0,.6)}
.kj-gate-in::after{content:"";display:block;height:3px;margin:16px 0 0;background:linear-gradient(90deg,transparent,#c9a24a,#f3d98b,#c9a24a,transparent)}
.kj-gate h1{font-size:34px;font-weight:800;color:#f3d98b;margin:6px 0 0}
.kj-gate-sub{margin:0 0 10px;color:#e8e2d0;font-size:16px}
.kj-gate-lbl{font-weight:700;text-align:left;color:#f3d98b}
.kj-gate .cl-in{text-align:center;font-size:22px;letter-spacing:2px;text-transform:uppercase;background:#fff;color:#14241e;border-color:transparent}
.kj-gate .btn{justify-content:center;font-size:18px;min-height:52px}
.kj-gate .cl-err{color:#ffd2cc}
.kj-gate-help{color:#ddd6c4;font-size:14.5px;margin:4px 0}
.kj-gate-dua{color:#f3d98b;font-size:13.5px;opacity:.9;margin-top:14px}
.kj-adm-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(201,162,74,.7);background:rgba(201,162,74,.15);color:#f3d98b;border-radius:999px;padding:6px 12px;font-weight:700;font-size:14px}
.kj-adm-btn[hidden]{display:none}
.kj-hero{display:flex;gap:16px;align-items:center;margin:14px 0;padding:18px;border-radius:20px;color:#fff;position:relative;overflow:hidden;
  background:var(--hero-bg);box-shadow:0 8px 26px rgba(0,0,0,.22);border:1px solid rgba(201,162,74,.55)}
.kj-hero::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:linear-gradient(90deg,#a87a22,#f3d98b,#a87a22)}
.kj-hero>img{width:72px;height:72px;border-radius:18px}
.kj-hero h2{margin:2px 0;color:#f3d98b;font-size:24px}
.kj-hero p{margin:0;color:#e8e2d0}
.kj-hero small{color:#d8cfb8}
.kj-hero .btn{margin-top:10px}
.kj-hero-ph .cl-ph{width:76px;height:76px;font-size:30px;border:3px solid #f3d98b;background:#d4e8df}
.kj-quick{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.kj-quick>*{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:92px;border-radius:16px;border:1.5px solid var(--line);background:var(--marble);color:var(--ink);font-weight:700;font-size:15px;text-decoration:none;text-align:center;padding:10px}
.kj-quick svg{width:30px;height:30px;color:var(--title)}
.kj-quick>*:active{background:var(--green-soft)}
.kj-trip h3{font-size:20px}
.kj-today{display:inline-block;background:var(--gold-soft);color:#2b2108;border-radius:999px;padding:4px 14px;font-weight:700;margin:2px 0 8px}
.kj-tl{list-style:none;padding:0;margin:6px 0 0;position:relative}
.kj-tl::before{content:"";position:absolute;left:21px;top:8px;bottom:8px;width:3px;background:linear-gradient(var(--gold),var(--green));border-radius:2px}
.kj-tl li{position:relative;display:flex;gap:14px;padding:8px 0}
.kj-dot{flex:0 0 auto;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:3px solid var(--gold);color:var(--title);z-index:1}
.kj-dot svg{width:22px;height:22px}
.kj-tl li.done .kj-dot{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.kj-tl li.done .kj-tl-b{opacity:.65}
.kj-tl li.now .kj-dot{background:var(--gold);border-color:var(--gold);color:#000;box-shadow:0 0 0 6px var(--gold-soft)}
.kj-tl li.now .kj-tl-b{background:var(--gold-soft);border-color:var(--gold)}
.kj-tl-b{flex:1;min-width:0;border:1px solid var(--line);border-radius:14px;padding:10px 14px;background:var(--surface)}
.kj-tl-b b{display:block;font-size:17px}
.kj-tl-b p{margin:4px 0 0;font-family:var(--read);line-height:1.7}
.kj-tl-h{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13.5px;color:var(--muted);margin-bottom:2px}
.kj-day{background:var(--accent);color:var(--accent-ink);border-radius:8px;padding:0 8px;font-weight:700}
.kj-modal{position:fixed;inset:0;z-index:7000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px;overflow:auto}
.kj-modal-in{background:var(--surface);color:var(--ink);border-radius:22px;padding:22px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.kj-dua-modal{text-align:center}
.kj-dua-modal h3{font-size:22px;margin:10px 0 6px}
.kj-dua-modal .ar,.kj-dua-card .ar{font-family:var(--ar);font-size:26px;margin:8px 0 4px;color:var(--title)}
.kj-pron{font-weight:700;margin:0}
.kj-dua-card{display:flex;gap:12px;align-items:flex-start;border:1.5px dashed var(--gold);border-radius:18px;padding:14px 16px;margin:16px 0;background:var(--gold-soft)}
.kj-dua-card>svg{width:28px;height:28px;flex:0 0 auto;color:var(--warn);margin-top:2px}
.kj-dua-card b{font-size:16px}
.kj-dua-card p{margin:4px 0}
.kj-cardwrap img{width:100%;max-width:640px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);display:block;margin:6px auto}
.kj-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
.kj-stats>div{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.kj-stats small{color:var(--muted)}
.kj-stats b{font-size:20px}
.kj-stats .warn{border-color:#e2b4ae;background:#fdf0ee;color:#7a1f16}
.kj-stats .ok{border-color:var(--green);background:var(--green-soft)}
.kj-tbl-wrap{overflow-x:auto;margin:8px 0}
.kj-tbl{width:100%;border-collapse:collapse;min-width:520px}
.kj-tbl th,.kj-tbl td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
.kj-tbl th{font-size:14px;color:var(--muted)}
.kj-tbl tbody tr{cursor:pointer}
.kj-tbl tbody tr:hover,.kj-tbl tr.open{background:var(--green-soft)}
.kj-tbl .due{color:#b3261e;font-weight:700}
.kj-tbl .clear{color:var(--green);font-weight:700}
.kj-cats{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.kj-cats span{background:var(--marble);border:1px solid var(--line);border-radius:999px;padding:4px 12px}
`;

/* ---------------- shared UI bits ---------------- */
const fld = (label, id, val, opt = {}) => `<label class="cl-f"><span>${label}</span>${opt.area
  ? `<textarea class="cl-in" id="${id}" ${opt.ph ? `placeholder="${E(opt.ph)}"` : ""}>${E(val)}</textarea>`
  : opt.sel ? `<select class="cl-in" id="${id}">${opt.sel.map(([v, t]) => `<option value="${E(v)}"${String(v) === String(val) ? " selected" : ""}>${E(t)}</option>`).join("")}</select>`
  : `<input class="cl-in" id="${id}" type="${opt.type || "text"}" value="${E(val)}" ${opt.ph ? `placeholder="${E(opt.ph)}"` : ""} ${opt.attr || ""}>`}${opt.help ? `<small>${opt.help}</small>` : ""}</label>`;
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
const avatar = (m, cls = "cl-ph") => `<span class="${cls}">${m && m.photo ? `<img src="${E(m.photo)}" alt="">` : E(((m && m.name) || "?").trim().slice(0, 1))}</span>`;
function photoToData(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 240, k = Math.min(1, S / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", .72));
    };
    img.onerror = rej; img.src = url;
  });
}
function errText(e) {
  if (!navigator.onLine) return "ইন্টারনেট নেই। সংযোগ চালু করে আবার চেষ্টা করুন।";
  if (e && e.status === 401) return "অনুমতি নেই। সেটআপের নিরাপত্তা নিয়ম ঠিকমতো বসানো হয়েছে কিনা দেখুন।";
  return "কাজটি হয়নি। একটু পরে আবার চেষ্টা করুন।";
}

/* ======================================================================
   MEMBER SIDE: the entry code, notices, my kafela, trip plan, my ID card
   ====================================================================== */
let my = ls.get("my", null);           // { kid, code, m, info, trip, share }
let lead = ls.get("lead", null);
let seen = ls.get("seenNotices", {});
const hasAccess = () => !!((my && mem.on) || adm.on);
const bnDate = d => { try { return new Date(d + "T00:00:00").toLocaleDateString("bn-BD", { day: "numeric", month: "long", year: "numeric" }); } catch (e) { return d; } };
const bnDay = d => { try { return new Date(d + "T00:00:00").toLocaleDateString("bn-BD", { weekday: "long" }); } catch (e) { return ""; } };
const todayStr = () => { const t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };
const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
function hotelPlace() {
  if (!my || !my.info || typeof my.info.lat !== "number") return null;
  return { id: "my-hotel", kind: "service", label: "হো", name: my.info.hotel || "আমার হোটেল", lat: my.info.lat, lng: my.info.lng,
    about: `আপনার কাফেলার (${my.info.name || ""}) হোটেল।${my.m && my.m.room ? " আপনার রুম: " + my.m.room + "।" : ""}`, why: "পথ হারিয়ে গেলে “নিয়ে চলো” চাপুন, রাস্তা ধরে হোটেলে ফেরার পথ দেখাবে।", tips: my.info.phone ? ["মুআল্লিমের নম্বর: " + my.info.phone] : [] };
}
function leadPlace() {
  if (!lead || typeof lead.lat !== "number") return null;
  return { id: "my-lead", kind: "gate", label: "মু", name: "মুআল্লিম / অ্যাডমিন", lat: lead.lat, lng: lead.lng, about: "মুআল্লিম সর্বশেষ এখানে ছিলেন: " + ago(lead.t) + "।", why: "", tips: [] };
}
function renderNotices() {
  const box = q("#noticeBox"); if (!box) return;
  const N = Object.entries((content && content.notices) || {}).map(([id, n]) => Object.assign({ id }, n)).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 5);
  box.innerHTML = N.map(n => `<div class="cl-notice"><b>${E(n.title)}</b>${n.body ? `<div>${E(n.body)}</div>` : ""}<small>${ago(n.t)}</small></div>`).join("");
}
function renderMy() {
  const box = q("#kafelaBox"); if (!box) return;
  if (!my) {
    box.innerHTML = adm.on ? `<div class="kj-hero"><img src="icon-192.png" alt=""><div><h2>আসসালামু আলাইকুম</h2><p>আপনি অ্যাডমিন হিসেবে আছেন। কাফেলা, সদস্য, হিসাব আর যাত্রা পরিকল্পনা অ্যাডমিন প্যানেল থেকে সাজান।</p>
      <button class="btn gold" id="toAdmin">অ্যাডমিন প্যানেল খুলুন</button></div></div>` : "";
    const b = q("#toAdmin"); if (b) b.onclick = openAdmin;
    return;
  }
  const m = my.m || {}, info = my.info || {};
  box.innerHTML = `<div class="kj-hero"><div class="kj-hero-ph">${avatar(m)}</div><div style="min-width:0">
      <small>আসসালামু আলাইকুম</small><h2>${E(m.name || "")}</h2>
      <p>${E(info.name || "")}${m.room ? " · রুম " + E(m.room) : ""}</p></div></div>
    <div class="cl-card"><div class="kj-quick">
      ${typeof info.lat === "number" ? `<button id="myHotel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/></svg>হোটেলে ফেরার পথ</button>` : ""}
      ${info.phone ? `<a href="tel:${E(info.phone)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>মুআল্লিমকে ফোন</a>` : ""}
      ${lead ? `<button id="myLead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>মুআল্লিম কোথায়</button>` : ""}
      <button id="myCardBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M6 16c.8-1.5 2-2 3-2s2.2.5 3 2M14 10h4M14 13h3"/></svg>আমার আইডি কার্ড</button>
    </div>
    <p class="src" id="myShareTxt" style="margin-top:10px"></p>
    <div class="cl-row" style="justify-content:space-between"><label class="cl-row" style="gap:8px"><input type="checkbox" id="myShare" ${my.share !== false ? "checked" : ""} style="width:22px;height:22px;accent-color:var(--green)"> আমার লোকেশন মুআল্লিমকে দেখাও</label>
    <button class="btn ghost small" id="myLeave">বের হন</button></div></div>`;
  const h = q("#myHotel"); if (h) h.onclick = () => { if (window.addPlace) addPlace(hotelPlace()); startNav("my-hotel"); };
  const l = q("#myLead"); if (l) l.onclick = () => { if (window.addPlace) addPlace(leadPlace()); show("map"); setTimeout(() => { initMap(); openSheet("my-lead"); }, 120); };
  q("#myCardBtn").onclick = () => { const c = q("#myCardBox"); if (c) c.scrollIntoView({ behavior: "smooth" }); };
  q("#myShare").onchange = e => { my.share = e.target.checked; ls.set("my", my); shareLoop(); renderShareTxt(); };
  q("#myLeave").onclick = () => { if (!confirm("এই ফোন থেকে আপনার কাফেলার তথ্য মুছে যাবে। আবার ঢুকতে কোড লাগবে। নিশ্চিত?")) return; my = null; ls.del("my"); mem.clear(); stopShare(); renderMember(); checkGate(); };
  renderShareTxt();
}
function renderShareTxt() {
  const el = q("#myShareTxt"); if (!el || !my) return;
  el.textContent = my.share === false ? "লোকেশন পাঠানো বন্ধ।" : shareState.last ? "ওয়েবসাইট খোলা থাকলে আপনার লোকেশন শুধু মুআল্লিম দেখতে পান। শেষবার পাঠানো হয়েছে " + ago(shareState.last) + "।" : "ওয়েবসাইট খোলা থাকলে আপনার লোকেশন শুধু মুআল্লিম দেখতে পান।";
}
const KIND_ICON = {
  flight: '<path d="M2 16l20-6-3-2-7 2-5-5-2 1 3 5-4 1-2-1-1 1z"/>',
  bus: '<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M4 11h16M7 20v-3M17 20v-3"/><circle cx="8" cy="14" r=".8"/><circle cx="16" cy="14" r=".8"/>',
  train: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4"/>',
  makkah: '<path d="M12 4l8 3v10l-8 3-8-3V7z"/><path d="M4 9.5l8 3 8-3"/>',
  madinah: '<path d="M5 20v-7a7 7 0 0 1 14 0v7"/><path d="M12 6V3M3 20h18"/>',
  ziyarah: '<path d="M3 20l6-10 4 6 3-4 5 8z"/>',
  hotel: '<path d="M3 21V5h12v16M15 9h6v12M7 9h4M7 13h4M7 17h4"/>',
  home: '<path d="M3 11l9-7 9 7M5 10v10h14V10"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'
};
const KINDS = [["flight", "বিমান"], ["bus", "বাস"], ["train", "ট্রেন"], ["makkah", "মক্কা"], ["madinah", "মদিনা"], ["ziyarah", "জিয়ারত"], ["hotel", "হোটেল"], ["home", "দেশে ফেরা"], ["other", "অন্যান্য"]];
const kIcon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
function tripHtml(trip, kafelaName) {
  const items = ((trip && trip.items) || []).filter(x => x && x.title);
  if (!items.length) return "";
  const dated = items.filter(x => x.date).map(x => x.date).sort();
  const first = dated[0], last = dated[dated.length - 1], today = todayStr();
  const total = first && last ? dayDiff(first, last) + 1 : 0;
  let curIdx = -1;
  items.forEach((x, i) => { if (x.date && x.date <= today) curIdx = i; });
  if (last && today > last) curIdx = items.length;
  return `<div class="cl-card kj-trip"><h3>${E(trip.title || "আমাদের সফর পরিকল্পনা")}</h3>
    ${total ? `<p class="lead" style="margin:0 0 6px">মোট ${B(total)} দিনের সফর · ${bnDate(first)} থেকে ${bnDate(last)}</p>` : ""}
    ${first && today >= first && today <= last ? `<div class="kj-today">আজ সফরের ${B(dayDiff(first, today) + 1)}তম দিন</div>` : first && today < first ? `<div class="kj-today">সফর শুরু হতে আর ${B(dayDiff(today, first))} দিন</div>` : ""}
    <ol class="kj-tl">${items.map((x, i) => {
      const day = x.date && first ? dayDiff(first, x.date) + 1 : null;
      const st = i < curIdx ? "done" : i === curIdx ? "now" : "";
      return `<li class="${st}"><span class="kj-dot">${kIcon(x.kind)}</span><div class="kj-tl-b">
        <div class="kj-tl-h">${day ? `<span class="kj-day">দিন ${B(day)}</span>` : ""}${x.date ? `<span>${bnDate(x.date)}, ${bnDay(x.date)}</span>` : ""}${x.time ? `<span>· ${E(x.time)}</span>` : ""}</div>
        <b>${E(x.title)}</b>${x.text ? `<p>${E(x.text)}</p>` : ""}</div></li>`; }).join("")}</ol></div>`;
}
function renderTrip() {
  const box = q("#tripBox"); if (!box) return;
  box.innerHTML = my ? tripHtml(my.trip, my.info && my.info.name) : "";
  const items = (my && my.trip && my.trip.items) || [];
  const lastD = items.map(x => x.date).filter(Boolean).sort().pop();
  if (lastD && todayStr() > lastD) askDua("trip-end");
}
async function renderMyCard() {
  const box = q("#myCardBox"); if (!box) return;
  if (!my || !my.m) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="cl-card"><h3>আমার আইডি কার্ড</h3><p class="lead" style="margin:0 0 8px">হারিয়ে গেলে এই কার্ডের QR কোড স্ক্যান করলে আপনার পরিচয় আর মুআল্লিমের নম্বর দেখা যাবে। কার্ডটি প্রিন্ট করে সঙ্গে রাখুন।</p>
    <div class="kj-cardwrap" id="myCardImg"><p class="loading">কার্ড তৈরি হচ্ছে…</p></div>
    <div class="btn-row"><button class="btn" id="myCardDl">ছবি ডাউনলোড</button><button class="btn ghost" id="myCardPr">প্রিন্ট</button></div></div>`;
  try {
    const cv = await drawCard(cardData(my.m, my.info));
    const img = new Image(); img.src = cv.toDataURL("image/png"); img.alt = "আইডি কার্ড";
    q("#myCardImg").innerHTML = ""; q("#myCardImg").appendChild(img);
    q("#myCardDl").onclick = () => downloadCanvas(cv, "kafela-id-" + (my.m.name || "card"));
    q("#myCardPr").onclick = () => printCanvas(cv);
  } catch (e) { q("#myCardImg").innerHTML = '<p class="cl-err">কার্ড দেখানো যাচ্ছে না।</p>'; }
}
function renderMember() { renderNotices(); renderMy(); renderTrip(); renderMyCard(); renderDuaCard(); updateAdminBtn(); }
async function ensureMember() { if (!mem.on) mem.set(await authCall("accounts:signUp", { returnSecureToken: true })); }
// returns an error message, or "" when the code worked
async function joinCode(code) {
  await ensureMember();
  const kid = await db("GET", "codes/" + code, undefined, mem);
  if (!kid) return "কোডটি সঠিক নয়। আবার দেখে লিখুন।";
  const m = await db("GET", `k/${kid}/m/${code}`, undefined, mem);
  if (!m) return "কোডটি সঠিক নয়। আবার দেখে লিখুন।";
  if (m.uid && m.uid !== mem.uid) return "এই কোড আগে অন্য একটি ফোনে ব্যবহার হয়েছে। মুআল্লিমকে বলুন ‘ফোন রিসেট’ করে দিতে।";
  if (!m.uid) await db("PUT", `k/${kid}/m/${code}/uid`, mem.uid, mem);
  const info = await db("GET", `k/${kid}/info`, undefined, mem);
  const trip = await db("GET", `k/${kid}/trip`, undefined, mem).catch(() => null);
  delete m.uid;
  my = { kid, code, m, info: info || {}, trip: trip || null, share: true }; ls.set("my", my);
  if (window.addPlace && hotelPlace()) addPlace(hotelPlace());
  return "";
}
async function refreshMy() {
  if (!READY || !my || !navigator.onLine) return;
  try {
    await ensureMember();
    const m = await db("GET", `k/${my.kid}/m/${my.code}`, undefined, mem);
    if (!m || (m.uid && m.uid !== mem.uid)) { my = null; ls.del("my"); mem.clear(); stopShare(); renderMember(); checkGate(); if (!m) toastMsg("আপনার প্রোফাইল মুছে ফেলা হয়েছে"); return; }
    const info = await db("GET", `k/${my.kid}/info`, undefined, mem);
    const trip = await db("GET", `k/${my.kid}/trip`, undefined, mem).catch(() => my.trip);
    delete m.uid;
    const changed = JSON.stringify([m, info, trip]) !== JSON.stringify([my.m, my.info, my.trip]);
    my.m = m; my.info = info || my.info; my.trip = trip || null; ls.set("my", my);
    const l = await db("GET", "lead", undefined, mem).catch(() => null);
    if (l) { lead = l; ls.set("lead", lead); }
    if (window.addPlace) { const h = hotelPlace(); if (h) addPlace(h); const lp = leadPlace(); if (lp) addPlace(lp); }
    if (changed) { renderMy(); renderTrip(); renderMyCard(); }
  } catch (e) {}
}

/* ---------------- the entry gate: nobody uses the website without a code ---------------- */
function gateHtml() {
  return `<div class="kj-gate-in">
    <img src="logo-door.jpg" alt="কাবার দরজার গিলাফ" class="kj-gate-logo">
    <h1>কাফেলা যাত্রা</h1>
    <p class="kj-gate-sub">উমরাহ ও হজের সফরসঙ্গী</p>
    ${READY ? `<label for="gCode" class="kj-gate-lbl">আপনার কাফেলার দেওয়া কোড</label>
    <input id="gCode" class="cl-in" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="যেমন: K7Q2M-X9P4T">
    <button class="btn gold" id="gGo">প্রবেশ করুন</button>
    <div class="cl-err" id="gErr" role="alert"></div>
    <p class="kj-gate-help">কোড না থাকলে আপনার কাফেলার মুআল্লিমের কাছে চেয়ে নিন। প্রতিটি কোড একজন যাত্রীর জন্য।</p>`
    : `<p class="kj-gate-help">ওয়েবসাইটটি এখনো সার্ভারের সাথে যুক্ত হয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন, অথবা আপনার মুআল্লিমকে জানান।</p>`}
    <p class="kj-gate-dua">এই সেবাটি যিনি তৈরি করেছেন, তাঁর জন্য দোয়া করবেন।</p></div>`;
}
function checkGate() {
  let g = q("#kjGate");
  if (hasAccess()) { if (g) g.remove(); document.documentElement.classList.remove("kj-locked"); return true; }
  if (!g) { g = document.createElement("div"); g.id = "kjGate"; g.className = "kj-gate"; g.setAttribute("role", "dialog"); g.setAttribute("aria-label", "প্রবেশ"); document.body.appendChild(g); }
  g.innerHTML = gateHtml();
  document.documentElement.classList.add("kj-locked");
  const go = q("#gGo"); if (go) { go.onclick = gateSubmit; q("#gCode").addEventListener("keydown", e => { if (e.key === "Enter") gateSubmit(); }); }
  return false;
}
async function gateSubmit() {
  const inp = q("#gCode"), err = q("#gErr"), btn = q("#gGo");
  const raw = inp.value.trim(); if (!raw) return;
  const compact = raw.replace(/[\s\-–]/g, "");
  btn.disabled = true; err.textContent = "";
  try {
    if (compact.length >= 8 && compact.length <= 12) {
      // a traveller's code
      const msg = await joinCode(compact.toUpperCase());
      if (msg) { err.textContent = msg; return; }
      afterEnter(); toastMsg("স্বাগতম");
    } else {
      // the admin's secret code
      if (locked()) { err.textContent = "এটি আপনার ব্যবহারের না"; return; }
      try {
        adm.set(await authCall("accounts:signInWithPassword", { email: ADMIN_EMAIL, password: raw, returnSecureToken: true }));
        ls.del(FAIL_KEY); afterEnter(); openAdmin();
      } catch (e) {
        if (!navigator.onLine || e.message === "Failed to fetch") { err.textContent = "ইন্টারনেট নেই। সংযোগ চালু করে আবার চেষ্টা করুন।"; return; }
        if (/OPERATION_NOT_ALLOWED|CONFIGURATION_NOT_FOUND|API_KEY|PROJECT_NOT_FOUND/.test(e.code)) { err.textContent = "সার্ভার এখনো ঠিকমতো সেটআপ হয়নি।"; return; }
        const n = ls.get(FAIL_KEY, 0) + 1; ls.set(FAIL_KEY, n);
        if (n >= 3) ls.set(LOCK_KEY, 1);
        err.textContent = "এটি আপনার ব্যবহারের না";
      }
    }
  } catch (e) { err.textContent = errText(e); }
  finally { if (btn) btn.disabled = false; }
}
function afterEnter() { checkGate(); renderMember(); shareLoop(); refreshMy(); pullContent(false); startUseTimer(); }

/* ---------------- a request for dua for the person who made this ---------------- */
const DUA_AR = "اللّٰهُمَّ اغْفِرْ لَهُ وَارْحَمْهُ وَاجْزِهِ خَيْرًا";
const DUA_PRON = "আল্লাহুম্মাগফির লাহু ওয়ারহামহু ওয়াজযিহি খাইরা।";
const DUA_MEAN = "হে আল্লাহ, তাঁকে ক্ষমা করুন, তাঁর প্রতি দয়া করুন এবং তাঁকে উত্তম প্রতিদান দিন।";
function renderDuaCard() {
  const box = q("#duaCard"); if (!box) return;
  box.innerHTML = hasAccess() ? `<div class="kj-dua-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3v8a5 5 0 0 0 10 0V3"/><path d="M12 16v5"/></svg>
    <div><b>একটি অনুরোধ</b><p>এই সেবাটি যিনি তৈরি করেছেন, তাঁর জন্য মন থেকে একটু দোয়া করবেন। নাম জানার দরকার নেই, আল্লাহ সব জানেন।</p>
    <p class="ar" lang="ar" dir="rtl">${DUA_AR}</p><p class="src">${DUA_PRON} ${DUA_MEAN}</p></div></div>` : "";
}
function askDua(key) {
  if (!hasAccess()) return;
  const asked = ls.get("duaAsk", {}), now = Date.now();
  if (asked[key] && now - asked[key] < 3 * 864e5) return;     // the same moment at most every three days
  if (asked._last && now - asked._last < 20 * 3600e3) return;  // and at most once a day overall
  if (q("#kjDua")) return;
  asked[key] = now; asked._last = now; ls.set("duaAsk", asked);
  const d = document.createElement("div"); d.id = "kjDua"; d.className = "kj-modal"; d.setAttribute("role", "dialog");
  d.innerHTML = `<div class="kj-modal-in kj-dua-modal"><img src="icon-192.png" alt="" style="width:64px;height:64px;border-radius:16px">
    <h3>একটু দোয়া করবেন?</h3>
    <p>আপনার সফরের এই কাজটি সহজ হয়ে থাকলে, যিনি এই সেবাটি তৈরি করেছেন তাঁর জন্য মন থেকে দোয়া করবেন। তাঁর নাম জানার প্রয়োজন নেই।</p>
    <p class="ar" lang="ar" dir="rtl">${DUA_AR}</p><p class="kj-pron">${DUA_PRON}</p><p class="src">${DUA_MEAN}</p>
    <div class="btn-row" style="justify-content:center"><button class="btn gold" id="duaYes">আমিন, দোয়া করলাম</button><button class="btn ghost" id="duaLater">পরে</button></div></div>`;
  document.body.appendChild(d);
  const close = () => d.remove();
  q("#duaYes").onclick = () => { close(); toastMsg("জাযাকাল্লাহু খাইরান"); };
  q("#duaLater").onclick = close;
  d.addEventListener("click", e => { if (e.target === d) close(); });
}
let useTimer = null;
function startUseTimer() { clearTimeout(useTimer); if (hasAccess()) useTimer = setTimeout(() => { if (!document.hidden) askDua("use"); }, 10 * 60000); }

/* ---------------- ID card with a QR code ---------------- */
function siteBase() { return location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, ""); }
const cardUrl = token => siteBase() + "id.html#" + token;
function cardData(m, info) {
  return { name: m.name || "", photo: m.photo || "", passport: m.passport || "", phone: m.phone || "", bd: m.bd || "", hotel: m.hotel || info.hotel || "", room: m.room || "",
    kafela: info.name || "", muallim: info.muallim || "", muallimPhone: info.phone || "", token: m.card || "" };
}
function loadImg(src) { return new Promise(res => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
function wrapText(ctx, text, maxW) {
  const words = String(text || "").split(/\s+/), out = []; let line = "";
  for (const w of words) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line); return out;
}
async function drawCard(d) {
  const W = 1012, H = 638, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const x = cv.getContext("2d");
  try { await Promise.all(["400 24px 'Anek Bangla'", "700 24px 'Anek Bangla'", "800 24px 'Anek Bangla'"].map(f => document.fonts.load(f, "কাফেলা"))); } catch (e) {}
  const F = (w, s) => `${w} ${s}px 'Anek Bangla', sans-serif`;
  const rr = (X, Y, w, h, r) => { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); };
  // body
  rr(0, 0, W, H, 34); x.save(); x.clip();
  const bg = x.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#fbf8ef"); bg.addColorStop(1, "#eef5f1"); x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.globalAlpha = .06; x.strokeStyle = "#0b6b50"; x.lineWidth = 2;
  for (let i = -H; i < W; i += 44) { x.beginPath(); x.moveTo(i, H); x.lineTo(i + H, 0); x.stroke(); }
  x.globalAlpha = 1;
  // header
  const hg = x.createLinearGradient(0, 0, W, 0); hg.addColorStop(0, "#050505"); hg.addColorStop(.6, "#1a1a1a"); hg.addColorStop(1, "#0b4a2c"); x.fillStyle = hg; x.fillRect(0, 0, W, 118);
  x.fillStyle = "#c9a24a"; x.fillRect(0, 118, W, 6);
  const logo = await loadImg("icon-192.png"); if (logo) x.drawImage(logo, 28, 17, 84, 84);
  x.fillStyle = "#f3d98b"; x.font = F(800, 44); x.textBaseline = "alphabetic"; x.fillText("কাফেলা যাত্রা", 130, 62);
  x.fillStyle = "#ffffff"; x.font = F(500, 24); x.fillText("যাত্রী পরিচয়পত্র · উমরাহ ও হজ", 132, 98);
  x.textAlign = "right"; x.fillStyle = "#f3d98b"; x.font = F(700, 26);
  wrapText(x, d.kafela, 300).slice(0, 2).forEach((l, i) => x.fillText(l, W - 30, 58 + i * 32)); x.textAlign = "left";
  // photo
  const PX = 34, PY = 148, PW = 214, PH = 262;
  x.save(); rr(PX, PY, PW, PH, 18); x.clip(); x.fillStyle = "#d4e8df"; x.fillRect(PX, PY, PW, PH);
  const ph = await loadImg(d.photo);
  if (ph) { const k = Math.max(PW / ph.width, PH / ph.height), w = ph.width * k, h = ph.height * k; x.drawImage(ph, PX + (PW - w) / 2, PY + (PH - h) / 2, w, h); }
  else { x.fillStyle = "#0b6b50"; x.font = F(800, 110); x.textAlign = "center"; x.fillText((d.name || "?").slice(0, 1), PX + PW / 2, PY + PH / 2 + 38); x.textAlign = "left"; }
  x.restore(); rr(PX, PY, PW, PH, 18); x.strokeStyle = "#c9a24a"; x.lineWidth = 5; x.stroke();
  // fields
  const FX = 276, FW = 470; let y = 182;
  x.fillStyle = "#14241e"; x.font = F(800, 38);
  wrapText(x, d.name, FW).slice(0, 2).forEach(l => { x.fillText(l, FX, y); y += 44; });
  y += 4;
  const row = (label, value, lines = 1) => {
    if (!value) return;
    x.font = F(500, 19); x.fillStyle = "#5b6863"; x.fillText(label, FX, y); y += 28;
    x.font = F(700, 25); x.fillStyle = "#14241e";
    wrapText(x, value, FW).slice(0, lines).forEach(l => { x.fillText(l, FX, y); y += 31; }); y += 6;
  };
  row("পাসপোর্ট নম্বর", d.passport);
  row("মোবাইল", d.phone);
  row("বাংলাদেশের ঠিকানা", d.bd, 2);
  row("হোটেল", d.hotel + (d.room ? " · রুম " + d.room : ""));
  // QR
  const QX = 770, QY = 150, QS = 210;
  rr(QX - 10, QY - 10, QS + 20, QS + 20, 16); x.fillStyle = "#ffffff"; x.fill(); x.strokeStyle = "#d5dcd8"; x.lineWidth = 2; x.stroke();
  if (d.token && window.qrcode) {
    const qr = qrcode(0, "M"); qr.addData(cardUrl(d.token)); qr.make();
    const n = qr.getModuleCount(), s = QS / n; x.fillStyle = "#0a0a0a";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) x.fillRect(QX + c * s, QY + r * s, Math.ceil(s), Math.ceil(s));
    if (logo) { const L = QS * .2; x.fillStyle = "#fff"; x.fillRect(QX + QS / 2 - L / 2 - 4, QY + QS / 2 - L / 2 - 4, L + 8, L + 8); x.drawImage(logo, QX + QS / 2 - L / 2, QY + QS / 2 - L / 2, L, L); }
  } else { x.fillStyle = "#9aa5a0"; x.font = F(500, 20); x.textAlign = "center"; x.fillText("QR কোড নেই", QX + QS / 2, QY + QS / 2); x.textAlign = "left"; }
  x.textAlign = "center"; x.fillStyle = "#0b6b50"; x.font = F(700, 20); x.fillText("হারিয়ে গেলে স্ক্যান করুন", QX + QS / 2, QY + QS + 38);
  x.font = F(500, 17); x.fillStyle = "#5b6863"; x.fillText("Scan if lost", QX + QS / 2, QY + QS + 62); x.textAlign = "left";
  // footer
  const fg = x.createLinearGradient(0, 0, W, 0); fg.addColorStop(0, "#c9a24a"); fg.addColorStop(1, "#e7c873"); x.fillStyle = fg; x.fillRect(0, H - 70, W, 70);
  x.fillStyle = "#1c1606"; x.font = F(700, 25);
  const mu = "মুআল্লিম" + (d.muallim ? ": " + d.muallim : "") + (d.muallimPhone ? "  ·  " + d.muallimPhone : "");
  x.fillText(mu, 30, H - 26);
  x.restore();
  return cv;
}
function downloadCanvas(cv, name) {
  const a = document.createElement("a"); a.download = String(name).replace(/[\\/:*?"<>|]+/g, "-") + ".png"; a.href = cv.toDataURL("image/png");
  document.body.appendChild(a); a.click(); a.remove();
}
function printCanvas(cv) {
  const w = window.open("", "_blank"); if (!w) return toastMsg("প্রিন্টের জন্য নতুন পাতা খোলা যায়নি");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>ID card</title><style>@page{size:auto;margin:10mm}body{margin:0;display:flex;justify-content:center}img{width:85.6mm;height:54mm}</style></head><body><img src="${cv.toDataURL("image/png")}" onload="setTimeout(function(){print()},300)"></body></html>`);
  w.document.close();
}

// location sharing while the app is open
const shareState = { watch: null, lastSent: null, last: ls.get("lastSent", 0) };
function stopShare() { if (shareState.watch != null) { navigator.geolocation.clearWatch(shareState.watch); shareState.watch = null; } }
function shareLoop() {
  stopShare();
  if (!READY || !my || my.share === false || !("geolocation" in navigator)) return;
  shareState.watch = navigator.geolocation.watchPosition(async pos => {
    const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
    const p = shareState.lastSent, now = Date.now();
    const moved = p ? Math.hypot((lat - p.lat) * 110540, (lng - p.lng) * 103000) : 1e9;
    if (p && now - p.t < 25000 && moved < 25) return;
    if (p && now - p.t < 8000) return;
    shareState.lastSent = { lat, lng, t: now };
    try {
      await ensureMember();
      await db("PUT", `loc/${my.kid}/${my.code}`, { lat: +lat.toFixed(6), lng: +lng.toFixed(6), acc: Math.round(acc || 0), t: NOW }, mem);
      shareState.last = Date.now(); ls.set("lastSent", shareState.last); renderShareTxt();
    } catch (e) {}
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

/* fresh content from the server */
async function pullContent(first) {
  if (!READY || !navigator.onLine) return;
  try {
    const c = (await db("GET", "content")) || {};
    const strip = x => JSON.stringify(Object.assign({}, x || {}, { notices: null }));
    const changed = strip(c) !== strip(content);
    const quiet = !ls.get("seenInit", false);     // first run on this phone: show old notices, no alert
    content = c; ls.set("content", content);
    renderNotices();
    for (const [id, n] of Object.entries(c.notices || {})) {
      if (seen[id]) continue;
      seen[id] = 1;
      if (!quiet && Date.now() - (n.t || 0) < 3 * 864e5) notify(n.title || "নতুন নোটিশ", n.body || "");
    }
    ls.set("seenNotices", seen); ls.set("seenInit", true);
    if (changed) {
      if (first && !q("#v-admin.active")) setTimeout(() => location.reload(), 200);
      else if (!q("#v-admin.active")) toastMsg("নতুন তথ্য এসেছে। পাতাটি আবার খুললে দেখা যাবে।");
    }
  } catch (e) {}
}

/* ======================================================================
   ADMIN PANEL
   ====================================================================== */
const LOCK_KEY = "admLock", FAIL_KEY = "admFail";
const locked = () => ls.get(LOCK_KEY, 0) === 1;
let admTab = "kafela", admMap = null, admLayer = null, pickCb = null, kafelas = {}, curKid = ls.get("admKid", null), members = {}, locs = {}, admPoll = null, leadWatch = null;
function openAdmin() {
  show("admin");
  if (!READY) { renderAdminSetupOnly(); return; }
  if (adm.on) renderAdmin();
  else if (locked()) { q("#admHeadBtns").innerHTML = ""; q("#admBody").innerHTML = '<div class="cl-lock cl-card"><h3>এটি আপনার ব্যবহারের না</h3></div>'; }
  else renderLogin();
}
function adminEntry() { if (!locked()) openAdmin(); }   // after three wrong codes this device never shows the page again
function updateAdminBtn() { const b = q("#admBtn"); if (b) b.hidden = !adm.on; }
function renderLogin() {
  q("#admBody").innerHTML = `<div class="cl-lock cl-card"><h3>অ্যাডমিন</h3>
    <p class="lead" style="margin:0 auto 8px">শুধু অ্যাডমিনের জন্য। গোপন কোডটি লিখুন।</p>
    <input class="cl-in" id="admCode" type="password" autocomplete="off" style="text-align:center">
    <div class="cl-err" id="admErr"></div>
    <button class="btn" id="admGo" style="width:100%;justify-content:center">ঢুকুন</button></div>`;
  q("#admHeadBtns").innerHTML = "";
  q("#admGo").onclick = login;
  q("#admCode").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
}
async function login() {
  const code = q("#admCode").value, err = q("#admErr"), btn = q("#admGo");
  if (!code) return;
  btn.disabled = true; err.textContent = "";
  try {
    const j = await authCall("accounts:signInWithPassword", { email: ADMIN_EMAIL, password: code, returnSecureToken: true });
    adm.set(j); ls.del(FAIL_KEY); renderAdmin(); afterEnter();
  } catch (e) {
    if (!navigator.onLine || e.message === "Failed to fetch") { err.textContent = "ইন্টারনেট নেই। সংযোগ চালু করে আবার চেষ্টা করুন।"; return; }
    if (/OPERATION_NOT_ALLOWED|CONFIGURATION_NOT_FOUND|API_KEY|PROJECT_NOT_FOUND/.test(e.code)) { err.textContent = "সার্ভার এখনো ঠিকমতো সেটআপ হয়নি।"; return; }
    const n = ls.get(FAIL_KEY, 0) + 1; ls.set(FAIL_KEY, n);
    if (n >= 3) { ls.set(LOCK_KEY, 1); q("#admBody").innerHTML = '<div class="cl-lock cl-card"><h3>এটি আপনার ব্যবহারের না</h3></div>'; setTimeout(() => show("trip"), 2500); return; }
    err.textContent = "এটি আপনার ব্যবহারের না";
  } finally { if (btn) btn.disabled = false; }
}
function logout() { adm.clear(); stopAdminLive(); updateAdminBtn(); renderMember(); if (checkGate()) show("trip"); }

function renderAdmin() {
  q("#admHeadBtns").innerHTML = '<button class="btn ghost small" id="admOut">লগ আউট</button>';
  q("#admOut").onclick = logout;
  const tabs = [["kafela", "কাফেলা ও প্রোফাইল"], ["trip", "যাত্রা পরিকল্পনা"], ["acct", "হিসাব"], ["notice", "নোটিশ"], ["hateem", "হাতিমের সময়"], ["places", "ম্যাপের জায়গা"], ["edit", "লেখা ঠিক করুন"], ["items", "নতুন লেখা যোগ"], ["setup", "সেটআপ"]];
  q("#admBody").innerHTML = `<div class="cl-tabs" id="admTabs">${tabs.map(([k, t]) => `<button data-at="${k}" aria-pressed="${k === admTab}">${t}</button>`).join("")}</div>
    <div id="admMapWrap" hidden><div id="admMap"></div><p class="src" id="admMapNote"></p></div><div id="admPane"></div>`;
  q("#admTabs").onclick = e => { const b = e.target.closest("[data-at]"); if (!b) return; admTab = b.dataset.at; qq("#admTabs button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderTab(); };
  admMap = null; renderTab();
}
function needMap(on) {
  q("#admMapWrap").hidden = !on;
  if (!on) { pickCb = null; return; }
  if (!admMap && window.L) {
    admMap = L.map("admMap", { zoomControl: true }).setView([21.4226, 39.8262], 15);
    (typeof cachedTiles === "function" ? cachedTiles : L.tileLayer)("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, maxNativeZoom: 19, attribution: "ছবি © Esri" }).addTo(admMap);
    admLayer = L.layerGroup().addTo(admMap);
    admMap.on("click", e => { if (pickCb) { const cb = pickCb; pickCb = null; q("#admMapNote").textContent = ""; cb(e.latlng.lat, e.latlng.lng); } });
  }
  setTimeout(() => admMap && admMap.invalidateSize(), 60);
}
function pickOnMap(cb) { pickCb = cb; q("#admMapNote").textContent = "এখন ম্যাপে জায়গাটির ওপর চাপুন।"; q("#admMapWrap").scrollIntoView({ behavior: "smooth", block: "center" }); }
let lastFix = null;
function hereNow(cb) {
  if (lastFix && Date.now() - lastFix.t < 60000) return cb(lastFix.lat, lastFix.lng);
  if (!("geolocation" in navigator)) return toastMsg("লোকেশন পাওয়া যাচ্ছে না");
  toastMsg("লোকেশন খোঁজা হচ্ছে…");
  navigator.geolocation.getCurrentPosition(p => { lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() }; cb(lastFix.lat, lastFix.lng); }, () => toastMsg("লোকেশন পাওয়া যায়নি। লোকেশন চালু আছে কিনা দেখুন।"), { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
}
function renderTab() {
  stopAdminLive();
  const P = q("#admPane");
  needMap(admTab === "kafela" || admTab === "places");
  ({ kafela: tabKafela, trip: tabTrip, acct: tabAcct, notice: tabNotice, hateem: tabHateem, places: tabPlaces, edit: tabEdit, items: tabItems, setup: tabSetup })[admTab](P);
}
async function admGet(path) { try { return await db("GET", path, undefined, adm); } catch (e) { if (e.status === 401) { toastMsg(errText(e)); } throw e; } }
async function admPut(path, data) { return db("PUT", path, data, adm); }
async function admDel(path) { return db("DELETE", path, undefined, adm); }
async function admPost(path, data) { return db("POST", path, data, adm); }
const saveBtn = (id, label = "সংরক্ষণ করুন") => `<button class="btn" id="${id}">${label}</button>`;
async function guard(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { await fn(); if (okMsg) toastMsg(okMsg); }
  catch (e) { if (e && e.message === "x") return; console.warn("admin", e); toastMsg(errText(e)); if (!adm.on) renderLogin(); }
  finally { if (btn) btn.disabled = false; }
}

/* ----- kafela ----- */
async function tabKafela(P) {
  P.innerHTML = '<p class="loading">কাফেলার তালিকা আনা হচ্ছে…</p>';
  try { kafelas = (await admGet("kidx")) || {}; } catch (e) { kafelas = {}; if (!adm.on) return renderLogin(); }
  if (!Object.keys(kafelas).length) {
    // the index is rebuilt from the kafela list if it is missing
    try { const sh = await fetchShallowK(); for (const kid of sh) { const inf = await admGet(`k/${kid}/info`); if (inf) kafelas[kid] = { name: inf.name || kid }; } } catch (e) {}
  }
  const ids = Object.keys(kafelas);
  if (curKid && !kafelas[curKid]) curKid = null;
  if (!curKid && ids.length) curKid = ids[0];
  P.innerHTML = `<div class="cl-card"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">কাফেলা</h3><button class="btn small gold" id="kNew">নতুন কাফেলা</button></div>
    ${ids.length ? `<div class="cl-tabs" id="kList" style="margin-top:8px">${ids.map(id => `<button data-k="${id}" aria-pressed="${id === curKid}">${E(kafelas[id].name)}</button>`).join("")}</div>` : '<p class="lead">এখনো কোনো কাফেলা নেই। “নতুন কাফেলা” চাপুন।</p>'}</div>
    <div id="kPane"></div>`;
  q("#kNew").onclick = () => kafelaForm(null);
  const kl = q("#kList"); if (kl) kl.onclick = e => { const b = e.target.closest("[data-k]"); if (!b) return; curKid = b.dataset.k; ls.set("admKid", curKid); qq("#kList button").forEach(x => x.setAttribute("aria-pressed", x === b)); openKafela(); };
  if (curKid) openKafela(); else drawAdmMap();
  startLead();
}
async function fetchShallowK() {
  const t = await adm.token();
  const r = await fetch(`${CFG.databaseURL.replace(/\/+$/, "")}/k.json?shallow=true&auth=${encodeURIComponent(t)}`, { cache: "no-store" });
  if (!r.ok) return [];
  return Object.keys((await r.json()) || {});
}
function kafelaForm(kid) {
  const info = kid ? (kafelas[kid] && kafelas[kid].info) || {} : {};
  const box = q("#kPane");
  box.innerHTML = `<div class="cl-card"><h3>${kid ? "কাফেলার তথ্য বদলান" : "নতুন কাফেলা"}</h3><div class="cl-grid">
    ${fld("কাফেলার নাম", "kfName", info.name || "", { ph: "যেমন: ঢাকা কাফেলা ১" })}
    ${fld("মুআল্লিমের নাম", "kfMu", info.muallim || "", { ph: "যেমন: মাওলানা আব্দুর রহমান" })}
    ${fld("মুআল্লিমের মোবাইল নম্বর", "kfPhone", info.phone || "", { type: "tel", ph: "+9665…" })}
    ${fld("হোটেলের নাম", "kfHotel", info.hotel || "", { ph: "যেমন: হিলটন সুইটস" })}
    ${fld("হোটেলের লোকেশন", "kfLL", typeof info.lat === "number" ? info.lat.toFixed(6) + ", " + info.lng.toFixed(6) : "", { ph: "২১.৪২১০, ৩৯.৮২৫০", help: "নিচের বোতাম দিয়ে বসান, বা Google Maps থেকে কপি করে এখানে দিন।" })}
    </div><div class="btn-row"><button class="btn ghost small" id="kfHere">আমার এখনকার লোকেশন</button><button class="btn ghost small" id="kfPick">ম্যাপে চাপ দিয়ে বসান</button></div>
    <div class="btn-row">${saveBtn("kfSave")}${kid ? '<button class="btn ghost" id="kfCancel">বাতিল</button>' : ""}</div></div>`;
  const setLL = (a, b) => { q("#kfLL").value = a.toFixed(6) + ", " + b.toFixed(6); };
  q("#kfHere").onclick = () => hereNow(setLL);
  q("#kfPick").onclick = () => pickOnMap(setLL);
  const c = q("#kfCancel"); if (c) c.onclick = openKafela;
  q("#kfSave").onclick = e => guard(e.target, async () => {
    const name = val("kfName"); if (!name) { toastMsg("কাফেলার নাম দিন"); throw new Error("x"); }
    const ll = val("kfLL").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d)).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    const data = { name, muallim: val("kfMu"), phone: val("kfPhone"), hotel: val("kfHotel") };
    if (ll) { data.lat = +ll[1]; data.lng = +ll[2]; }
    const id = kid || rid(12);
    await admPut(`k/${id}/info`, data);
    await admPut(`kidx/${id}`, { name });
    if (kid) await syncPubs(id, data);
    curKid = id; ls.set("admKid", id);
    tabKafela(q("#admPane"));
  }, "সংরক্ষণ হয়েছে");
}
async function openKafela() {
  const kid = curKid, box = q("#kPane"); if (!kid || !box) return;
  box.innerHTML = '<p class="loading">সদস্যদের তালিকা আনা হচ্ছে…</p>';
  let info = {}, mm = {};
  try { info = (await admGet(`k/${kid}/info`)) || {}; mm = (await admGet(`k/${kid}/m`)) || {}; locs = (await admGet(`loc/${kid}`)) || {}; } catch (e) { box.innerHTML = `<p class="cl-err">${errText(e)}</p>`; return; }
  kafelas[kid] = Object.assign(kafelas[kid] || {}, { name: info.name || kid, info });
  members = mm;
  const list = Object.entries(mm).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
  box.innerHTML = `<div class="cl-card"><div class="cl-row" style="justify-content:space-between"><div><h3 style="margin:0">${E(info.name)}</h3>
      <div class="lead">${E(info.hotel || "হোটেল দেওয়া নেই")}${info.phone ? " · " + E(info.phone) : ""} · ${B(list.length)} জন সদস্য</div></div>
      <div class="cl-acts"><button id="kEdit">তথ্য বদলান</button><button class="danger" id="kDel">কাফেলা মুছুন</button></div></div>
      <label class="cl-row" style="gap:8px;margin-top:10px"><input type="checkbox" id="leadOn" ${ls.get("leadOn", true) ? "checked" : ""} style="width:22px;height:22px;accent-color:var(--green)"> আমার লোকেশন সদস্যদের দেখাও (তারা “অ্যাডমিন কোথায়” চাপলে দেখবে)</label></div>
    <div class="cl-card"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">সদস্য</h3><button class="btn small gold" id="mNew">নতুন সদস্য</button></div>
      <div id="mForm"></div>
      <ul class="cl-list" id="mList">${list.map(([code, m]) => memberRow(code, m)).join("") || '<li class="lead">এখনো কোনো সদস্য নেই।</li>'}</ul></div>`;
  q("#kEdit").onclick = () => kafelaForm(kid);
  q("#kDel").onclick = e => { if (!confirm(`“${info.name}” কাফেলা আর এর সব সদস্য মুছে যাবে। নিশ্চিত?`)) return; guard(e.target, async () => {
    for (const [code, m] of Object.entries(mm)) { await admDel("codes/" + code); if (m.card) await admDel("pub/" + m.card); }
    await admDel("acct/" + kid); await admDel("loc/" + kid); await admDel("k/" + kid); await admDel("kidx/" + kid);
    curKid = null; ls.del("admKid"); tabKafela(q("#admPane"));
  }, "কাফেলা মুছে ফেলা হয়েছে"); };
  q("#leadOn").onchange = e => { ls.set("leadOn", e.target.checked); startLead(); };
  q("#mNew").onclick = () => memberForm(null);
  q("#mList").onclick = memberAction;
  drawAdmMap();
  admPoll = setInterval(async () => { try { locs = (await admGet(`loc/${kid}`)) || {}; drawAdmMap(true); qq("[data-seen]").forEach(el => { const l = locs[el.dataset.seen]; el.innerHTML = seenHtml(l); }); } catch (e) {} }, 12000);
}
const seenHtml = l => { const t = l && l.t, m = t ? (Date.now() - t) / 60000 : 1e9; return `<span class="cl-dot ${m < 5 ? "live" : m < 30 ? "mid" : ""}"></span>${t ? "শেষ লোকেশন " + ago(t) : "লোকেশন আসেনি"}`; };
function memberRow(code, m) {
  return `<li class="cl-item">${avatar(m)}<div class="grow"><b>${E(m.name)}</b>
    <small>${m.room ? "রুম " + E(m.room) + " · " : ""}${E(m.phone || "")}</small>
    <small>কোড: <span class="cl-code">${fmtCode(code)}</span> ${m.uid ? "· ফোনে যুক্ত" : "· এখনো যুক্ত হননি"}</small>
    <small data-seen="${code}">${seenHtml(locs[code])}</small>
    <div class="cl-acts" style="margin-top:6px">
      <button data-ma="map" data-c="${code}">ম্যাপে দেখুন</button>
      <button data-ma="go" data-c="${code}">কাছে যান</button>
      ${m.phone ? `<a href="tel:${E(m.phone)}">ফোন</a>` : ""}
      <button data-ma="card" data-c="${code}">আইডি কার্ড</button>
      <button data-ma="share" data-c="${code}">কোড পাঠান</button>
      <button data-ma="edit" data-c="${code}">এডিট</button>
      ${m.uid ? `<button data-ma="reset" data-c="${code}">ফোন রিসেট</button>` : ""}
      <button class="danger" data-ma="del" data-c="${code}">মুছুন</button>
    </div></div></li>`;
}
async function memberAction(e) {
  const b = e.target.closest("[data-ma]"); if (!b) return;
  const code = b.dataset.c, m = members[code] || {}, kid = curKid, a = b.dataset.ma;
  if (a === "map") { const l = locs[code]; if (!l) return toastMsg("এই সদস্যের লোকেশন এখনো আসেনি"); q("#admMapWrap").scrollIntoView({ behavior: "smooth", block: "center" }); admMap.setView([l.lat, l.lng], 18); }
  else if (a === "go") { const l = locs[code]; if (!l) return toastMsg("এই সদস্যের লোকেশন এখনো আসেনি"); addPlace({ id: "mem-" + code, kind: "gate", label: (m.name || "?").slice(0, 1), name: m.name, lat: l.lat, lng: l.lng, about: "সর্বশেষ লোকেশন: " + ago(l.t) + "।", why: m.phone ? "ফোন: " + m.phone : "", tips: [] }); startNav("mem-" + code); }
  else if (a === "share") {
    const txt = `আসসালামু আলাইকুম ${m.name || ""}। “কাফেলা যাত্রা” ওয়েবসাইটে ঢুকতে এই লিংক খুলে কোডটি লিখুন।\nলিংক: ${siteBase()}\nআপনার কোড: ${fmtCode(code)}\nকোডটি শুধু আপনার জন্য, অন্য কাউকে দেবেন না।`;
    if (navigator.share) navigator.share({ text: txt }).catch(() => {}); else { try { await navigator.clipboard.writeText(txt); toastMsg("কপি হয়েছে"); } catch (x) { prompt("কপি করুন", txt); } }
  }
  else if (a === "edit") memberForm(code);
  else if (a === "card") { if (!m.card) return toastMsg("আগে “এডিট” চেপে একবার সংরক্ষণ করুন, তাহলে কার্ড তৈরি হবে"); showCardModal(m, (kafelas[kid] && kafelas[kid].info) || {}); }
  else if (a === "reset") { if (!confirm(`${m.name}-এর কোড আবার নতুন ফোনে ব্যবহার করা যাবে। আগের ফোন থেকে আর লোকেশন আসবে না।`)) return; guard(b, async () => { await admDel(`k/${kid}/m/${code}/uid`); openKafela(); }, "রিসেট হয়েছে"); }
  else if (a === "del") { if (!confirm(`${m.name}-এর প্রোফাইল মুছে যাবে। নিশ্চিত?`)) return; guard(b, async () => { await admDel("codes/" + code); if (m.card) await admDel("pub/" + m.card); await admDel(`acct/${kid}/m/${code}`); await admDel(`loc/${kid}/${code}`); await admDel(`k/${kid}/m/${code}`); openKafela(); }, "মুছে ফেলা হয়েছে"); }
}
function memberForm(code) {
  const m = code ? members[code] || {} : {}, info = (kafelas[curKid] && kafelas[curKid].info) || {};
  let photo = m.photo || "";
  const box = q("#mForm");
  box.innerHTML = `<div class="cl-card" style="background:var(--marble)"><h3>${code ? "সদস্যের তথ্য বদলান" : "নতুন সদস্য"}</h3>
    <div class="cl-me" style="margin-bottom:6px"><span id="mfPh">${avatar(m)}</span><label class="btn ghost small" style="cursor:pointer">ছবি দিন<input type="file" accept="image/*" id="mfFile" hidden></label>${photo ? '<button class="btn ghost small" id="mfNoPh">ছবি সরান</button>' : ""}</div>
    <div class="cl-grid">${fld("নাম", "mfName", m.name || "")}${fld("মোবাইল নম্বর", "mfPhone", m.phone || "", { type: "tel" })}
    ${fld("পাসপোর্ট নম্বর", "mfPass", m.passport || "", { attr: 'autocapitalize="characters"' })}${fld("বাংলাদেশের ঠিকানা", "mfBd", m.bd || "", { ph: "গ্রাম/মহল্লা, উপজেলা, জেলা" })}
    ${fld("হোটেল", "mfHotel", m.hotel || info.hotel || "")}${fld("রুম নম্বর", "mfRoom", m.room || "")}</div>
    <div class="btn-row">${saveBtn("mfSave")}<button class="btn ghost" id="mfCancel">বাতিল</button></div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  q("#mfFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await photoToData(f); q("#mfPh").innerHTML = avatar({ photo }); } catch (x) { toastMsg("ছবিটি খোলা যায়নি"); } };
  const np = q("#mfNoPh"); if (np) np.onclick = () => { photo = ""; q("#mfPh").innerHTML = avatar({ name: val("mfName") }); };
  q("#mfCancel").onclick = () => { box.innerHTML = ""; };
  q("#mfSave").onclick = e => guard(e.target, async () => {
    const name = val("mfName"); if (!name) { toastMsg("নাম দিন"); throw new Error("x"); }
    const c = code || rid(10);
    const data = { name, phone: val("mfPhone"), passport: val("mfPass").toUpperCase(), bd: val("mfBd"), hotel: val("mfHotel"), room: val("mfRoom"), photo, card: m.card || rid(16).toLowerCase() };
    if (code && m.uid) data.uid = m.uid;
    await admPut(`k/${curKid}/m/${c}`, data);
    await admPut("pub/" + data.card, pubData(data, info));
    if (!code) await admPut("codes/" + c, curKid);
    box.innerHTML = ""; await openKafela();
    if (!code) toastMsg("সদস্য যোগ হয়েছে। কোড: " + fmtCode(c));
  }, code ? "সংরক্ষণ হয়েছে" : "");
}
function drawAdmMap(keepView) {
  if (!admMap) return;
  admLayer.clearLayers();
  const pts = [];
  const info = curKid && kafelas[curKid] && kafelas[curKid].info;
  if (info && typeof info.lat === "number") {
    L.marker([info.lat, info.lng], { icon: L.divIcon({ className: "", iconSize: [34, 34], iconAnchor: [17, 17], html: '<div class="adm-hotel">হো</div>' }), title: info.hotel || "হোটেল" }).bindTooltip(info.hotel || "হোটেল").addTo(admLayer);
    pts.push([info.lat, info.lng]);
  }
  for (const [code, l] of Object.entries(locs || {})) {
    const m = members[code]; if (!m || typeof l.lat !== "number") continue;
    const old = !l.t || Date.now() - l.t > 30 * 60000;
    const html = `<div style="position:relative"><div class="adm-pin${old ? " old" : ""}">${m.photo ? `<img src="${E(m.photo)}" alt="">` : E((m.name || "?").slice(0, 1))}</div><div class="adm-name">${E(m.name)}</div></div>`;
    L.marker([l.lat, l.lng], { icon: L.divIcon({ className: "", iconSize: [40, 40], iconAnchor: [20, 20], html }), title: m.name })
      .bindPopup(`<b>${E(m.name)}</b><br>${m.room ? "রুম " + E(m.room) + "<br>" : ""}${ago(l.t)}${m.phone ? `<br><a href="tel:${E(m.phone)}">${E(m.phone)}</a>` : ""}`).addTo(admLayer);
    pts.push([l.lat, l.lng]);
  }
  if (!keepView) { if (pts.length > 1) admMap.fitBounds(pts, { padding: [40, 40], maxZoom: 18 }); else if (pts.length) admMap.setView(pts[0], 17); }
  q("#admMapNote").textContent = Object.keys(locs || {}).length ? "ছবিওয়ালা গোল চিহ্ন সদস্য, ‘হো’ হোটেল। ধূসর চিহ্ন মানে ৩০ মিনিটের বেশি আগের লোকেশন। প্রতি ১২ সেকেন্ডে হালনাগাদ হয়।" : "সদস্যরা কোড দিয়ে ঢুকলে, ওয়েবসাইট খোলা থাকা অবস্থায় তাদের লোকেশন এখানে দেখা যাবে।";
}
function startLead() {
  if (leadWatch != null) { navigator.geolocation.clearWatch(leadWatch); leadWatch = null; }
  if (!ls.get("leadOn", true) || !("geolocation" in navigator) || !adm.on) return;
  let last = 0;
  leadWatch = navigator.geolocation.watchPosition(p => {
    lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() };
    if (Date.now() - last < 30000) return; last = Date.now();
    admPut("lead", { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), t: NOW }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
}
function stopAdminLive() { if (admPoll) { clearInterval(admPoll); admPoll = null; } }

/* ----- choosing a kafela (shared by the trip plan and accounts tabs) ----- */
async function loadKafelas() {
  try { kafelas = (await admGet("kidx")) || {}; } catch (e) { kafelas = {}; }
  const ids = Object.keys(kafelas);
  if (curKid && !kafelas[curKid]) curKid = null;
  if (!curKid && ids.length) curKid = ids[0];
  return ids;
}
function kafelaPicker(ids, onPick) {
  if (!ids.length) return '<div class="cl-card"><p class="lead">এখনো কোনো কাফেলা নেই। আগে “কাফেলা ও প্রোফাইল” থেকে কাফেলা বানান।</p></div>';
  setTimeout(() => { const kl = q("#kPick"); if (kl) kl.onclick = e => { const b = e.target.closest("[data-k]"); if (!b) return; curKid = b.dataset.k; ls.set("admKid", curKid); qq("#kPick button").forEach(x => x.setAttribute("aria-pressed", x === b)); onPick(curKid); }; }, 0);
  return `<div class="cl-card"><h3 style="margin:0 0 6px">কাফেলা বাছুন</h3><div class="cl-tabs" id="kPick">${ids.map(id => `<button data-k="${id}" aria-pressed="${id === curKid}">${E(kafelas[id].name)}</button>`).join("")}</div></div>`;
}
const pubData = (m, info) => ({ name: m.name || "", photo: m.photo || "", passport: m.passport || "", phone: m.phone || "", bd: m.bd || "", hotel: m.hotel || info.hotel || "", room: m.room || "",
  kafela: info.name || "", muallim: info.muallim || "", muallimPhone: info.phone || "", t: NOW });
async function syncPubs(kid, info) {
  const mm = (await admGet(`k/${kid}/m`)) || {};
  for (const m of Object.values(mm)) if (m.card) await admPut("pub/" + m.card, pubData(m, info));
}

/* ----- trip plan ----- */
const TPL = (start, mk, md) => {
  const add = n => { const d = new Date(start + "T00:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  return [
    { date: add(0), kind: "flight", title: "ঢাকা থেকে জেদ্দা (বিমানে)", text: "বিমানবন্দরে ৪ ঘণ্টা আগে পৌঁছান। মীকাতের আগেই ইহরাম বেঁধে নিয়ত করুন। বিমানে ঘোষণা হলে তালবিয়া শুরু করুন।" },
    { date: add(0), kind: "bus", title: "জেদ্দা বিমানবন্দর থেকে মক্কা (বাসে)", text: "ইমিগ্রেশন শেষে কাফেলার বাসে মক্কা, প্রায় দেড় থেকে দুই ঘণ্টা। পথে তালবিয়া পড়তে থাকুন।" },
    { date: add(1), kind: "makkah", title: "উমরাহ পালন", text: "হোটেলে মালপত্র রেখে বিশ্রাম ও ওযু। তারপর মুআল্লিমের সঙ্গে একসাথে তাওয়াফ, সাঈ আর চুল কাটা। “গাইড” ট্যাবে ধাপগুলো দেখুন।" },
    { date: add(3), kind: "ziyarah", title: "মক্কার জিয়ারত", text: "জাবালে নূর (হেরা গুহা), জাবালে সওর, আরাফাত, মুযদালিফা ও মিনা।" },
    { date: add(2), kind: "makkah", title: "মক্কায় অবস্থান ও ইবাদত", text: "পাঁচ ওয়াক্ত নামাজ মসজিদুল হারামে, নফল তাওয়াফ, হাতিমে নামাজ (সময় “হাতিম” ট্যাবে)।" },
    { date: add(mk), kind: "bus", title: "মক্কা থেকে মদিনা", text: "বিদায়ী তাওয়াফ করে বাস বা ট্রেনে মদিনা, বাসে প্রায় ৫–৬ ঘণ্টা।" },
    { date: add(mk + 1), kind: "madinah", title: "মসজিদে নববী ও রওজা মোবারকে সালাম", text: "গেট ১ (বাবুস সালাম) দিয়ে ঢুকে সালাম, গেট ৪১ দিয়ে বের হওয়া। রিয়াদুল জান্নাহর জন্য নুসুক অ্যাপে সময় বুক করুন।" },
    { date: add(mk + 2), kind: "ziyarah", title: "মদিনার জিয়ারত", text: "মসজিদে কুবা, উহুদ পাহাড় ও শহীদদের কবরস্থান, মসজিদে কিবলাতাইন, খন্দকের সাত মসজিদ।" },
    { date: add(mk + md), kind: "bus", title: "মদিনা থেকে জেদ্দা", text: "বিমানের সময় অনুযায়ী বাসে জেদ্দা বিমানবন্দর।" },
    { date: add(mk + md), kind: "home", title: "জেদ্দা থেকে ঢাকা (দেশে ফেরা)", text: "যমযম পানি নিয়মমতো প্যাক করুন। সবার জন্য দোয়া করুন।" }
  ].sort((a, b) => a.date.localeCompare(b.date));
};
let tripDraft = null;
async function tabTrip(P) {
  P.innerHTML = '<p class="loading">আনা হচ্ছে…</p>';
  const ids = await loadKafelas();
  P.innerHTML = kafelaPicker(ids, () => tabTrip(P)) + '<div id="trPane"></div>';
  if (!curKid) return;
  const t = (await admGet(`k/${curKid}/trip`).catch(() => null)) || { title: "", items: [] };
  tripDraft = { title: t.title || "", items: (t.items || []).filter(Boolean) };
  drawTripEditor();
}
function drawTripEditor() {
  const box = q("#trPane"); if (!box) return;
  const it = tripDraft.items;
  box.innerHTML = `<div class="cl-card"><h3>যাত্রা পরিকল্পনা</h3>
    <p class="lead" style="margin:0 0 6px">কাফেলার সবাই “যাত্রা” পাতায় এই পরিকল্পনা দিন অনুযায়ী দেখবে।</p>
    ${fld("শিরোনাম", "trTitle", tripDraft.title, { ph: "যেমন: ১২ দিনের উমরাহ সফর, ডিসেম্বর ২০২৬" })}
    <details class="cl-card" style="background:var(--marble)"><summary style="font-weight:700;cursor:pointer">নমুনা পরিকল্পনা দিয়ে শুরু করুন</summary>
      <div class="cl-grid">${fld("সফর শুরুর তারিখ (ঢাকা থেকে রওনা)", "tpStart", todayStr(), { type: "date" })}${fld("মক্কায় কত দিন", "tpMk", "7", { type: "number" })}${fld("মদিনায় কত দিন", "tpMd", "5", { type: "number" })}</div>
      <button class="btn ghost" id="tpMake">নমুনা বসান</button><small class="src"> এতে এখনকার তালিকা বদলে যাবে।</small></details>
    <ol class="cl-list" id="trList">${it.map((x, i) => `<li class="cl-card" style="margin:8px 0">
      <div class="cl-row" style="justify-content:space-between"><b>ধাপ ${B(i + 1)}</b><div class="cl-acts"><button data-tr="up" data-i="${i}" aria-label="ওপরে">▲</button><button data-tr="down" data-i="${i}" aria-label="নিচে">▼</button><button class="danger" data-tr="del" data-i="${i}">মুছুন</button></div></div>
      <div class="cl-grid">${fld("তারিখ", "trD" + i, x.date || "", { type: "date" })}${fld("সময় (ঐচ্ছিক)", "trT" + i, x.time || "", { ph: "যেমন: সকাল ১০টা" })}${fld("ধরন", "trK" + i, x.kind || "other", { sel: KINDS })}${fld("শিরোনাম", "trN" + i, x.title || "")}</div>
      ${fld("বিস্তারিত", "trX" + i, x.text || "", { area: true })}</li>`).join("")}</ol>
    <div class="btn-row"><button class="btn ghost" id="trAdd">+ নতুন ধাপ</button>${saveBtn("trSave")}</div></div>
    <div id="trPreview"></div>`;
  const read = () => { tripDraft.title = val("trTitle"); tripDraft.items = tripDraft.items.map((x, i) => ({ date: val("trD" + i), time: val("trT" + i), kind: val("trK" + i), title: val("trN" + i), text: val("trX" + i) })); };
  q("#tpMake").onclick = () => { read(); const s = val("tpStart"); if (!s) return toastMsg("শুরুর তারিখ দিন"); tripDraft.items = TPL(s, Math.max(1, +val("tpMk") || 7), Math.max(1, +val("tpMd") || 5)); drawTripEditor(); };
  q("#trAdd").onclick = () => { read(); const last = tripDraft.items[tripDraft.items.length - 1]; tripDraft.items.push({ date: last ? last.date : todayStr(), kind: "other", title: "", text: "" }); drawTripEditor(); };
  q("#trList").onclick = e => { const b = e.target.closest("[data-tr]"); if (!b) return; read(); const i = +b.dataset.i, A = tripDraft.items;
    if (b.dataset.tr === "up" && i > 0) [A[i - 1], A[i]] = [A[i], A[i - 1]];
    if (b.dataset.tr === "down" && i < A.length - 1) [A[i + 1], A[i]] = [A[i], A[i + 1]];
    if (b.dataset.tr === "del" && confirm("এই ধাপটি মুছবেন?")) A.splice(i, 1);
    drawTripEditor(); };
  q("#trSave").onclick = e => guard(e.target, async () => { read(); const items = tripDraft.items.filter(x => x.title); await admPut(`k/${curKid}/trip`, { title: tripDraft.title, items }); tripDraft.items = items; drawTripEditor(); }, "সংরক্ষণ হয়েছে। কাফেলার সবাই দেখতে পাবে।");
  q("#trPreview").innerHTML = '<h3 style="margin:16px 0 6px">যাত্রীরা যেমন দেখবে</h3>' + (tripHtml(tripDraft, "") || '<p class="lead">এখনো কোনো ধাপ নেই।</p>');
}

/* ----- accounts (হিসাব) ----- */
const tk = n => "৳ " + (Math.round(+n || 0)).toLocaleString("bn-BD");
const sr = n => (Math.round((+n || 0) * 100) / 100).toLocaleString("bn-BD") + " রিয়াল";
const num = v => { const t = String(v || "").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d)).replace(/[^\d.\-]/g, ""); return +t || 0; };
const sumOf = o => Object.values(o || {}).reduce((a, x) => a + (+x.a || 0), 0);
const EXP_CATS = ["বাস ভাড়া", "জিয়ারত", "হোটেল", "খাবার", "বিমান টিকিট", "ভিসা", "কুরবানি", "মুআল্লিম খরচ", "অন্যান্য"];
let acct = null, acctMembers = {}, acctOpen = null;
async function tabAcct(P) {
  P.innerHTML = '<p class="loading">আনা হচ্ছে…</p>';
  const ids = await loadKafelas();
  P.innerHTML = kafelaPicker(ids, () => tabAcct(P)) + '<div id="acPane"></div>';
  if (!curKid) return;
  try { acct = (await admGet(`acct/${curKid}`)) || {}; acctMembers = (await admGet(`k/${curKid}/m`)) || {}; } catch (e) { q("#acPane").innerHTML = `<p class="cl-err">${errText(e)}</p>`; return; }
  drawAcct();
}
function calcAcct() {
  const rate = +acct.rate || 0, defPkg = +acct.pkg || 0, rows = [];
  let tPkg = 0, tPaid = 0, tSar = 0;
  for (const [code, m] of Object.entries(acctMembers)) {
    const a = (acct.m && acct.m[code]) || {};
    const pkg = a.pkg != null && a.pkg !== "" ? +a.pkg : defPkg, paid = sumOf(a.pay), sar = sumOf(a.sar);
    const due = pkg + sar * rate - paid;
    rows.push({ code, name: m.name, pkg, paid, sar, due }); tPkg += pkg; tPaid += paid; tSar += sar;
  }
  rows.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  const exps = Object.entries(acct.exp || {}).map(([id, x]) => Object.assign({ id }, x)).sort((a, b) => String(b.d || "").localeCompare(String(a.d || "")));
  const expTk = exps.reduce((s, x) => s + (x.cur === "SAR" ? (+x.a || 0) * rate : (+x.a || 0)), 0);
  const byCat = {}; exps.forEach(x => { byCat[x.cat || "অন্যান্য"] = (byCat[x.cat || "অন্যান্য"] || 0) + (x.cur === "SAR" ? (+x.a || 0) * rate : (+x.a || 0)); });
  const due = rows.reduce((s, r) => s + Math.max(0, r.due), 0);
  return { rate, defPkg, rows, tPkg, tPaid, tSar, exps, expTk, byCat, due, cash: tPaid - expTk - tSar * rate };
}
function drawAcct() {
  const box = q("#acPane"); if (!box) return;
  const c = calcAcct();
  box.innerHTML = `<div class="cl-card"><h3>রিয়ালের দাম ও প্যাকেজ</h3><div class="cl-grid">
      ${fld("১ রিয়াল = কত টাকা", "acRate", acct.rate || "", { ph: "যেমন: ৩২.৫০", help: "দাম বদলালে এখানে নতুন দাম দিন, সব হিসাব সেই দামে হবে।" })}
      ${fld("জনপ্রতি প্যাকেজ মূল্য (টাকা)", "acPkg", acct.pkg || "", { ph: "যেমন: ১৬৫০০০", help: "কারও আলাদা মূল্য হলে তার নামে চাপ দিয়ে বদলান।" })}</div>
      <div class="btn-row">${saveBtn("acSaveBase")}</div></div>
    <div class="kj-stats">
      <div><small>যাত্রী</small><b>${B(c.rows.length)} জন</b></div>
      <div><small>মোট প্যাকেজ মূল্য</small><b>${tk(c.tPkg)}</b></div>
      <div><small>মোট জমা</small><b>${tk(c.tPaid)}</b></div>
      <div class="warn"><small>মোট বকেয়া</small><b>${tk(c.due)}</b></div>
      <div><small>রিয়াল দেওয়া হয়েছে</small><b>${sr(c.tSar)}</b><small>${tk(c.tSar * c.rate)}</small></div>
      <div><small>মোট খরচ</small><b>${tk(c.expTk)}</b></div>
      <div class="${c.cash < 0 ? "warn" : "ok"}"><small>হাতে আছে</small><b>${tk(c.cash)}</b><small>জমা − খরচ − দেওয়া রিয়াল</small></div>
    </div>
    ${!c.rate ? '<p class="cl-err">রিয়ালের দাম দেওয়া হয়নি, তাই রিয়ালের হিসাব টাকায় ধরা হচ্ছে না।</p>' : ""}
    <div class="cl-card"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">যাত্রীদের হিসাব</h3><button class="btn ghost small" id="acCsv">হিসাব ডাউনলোড (Excel)</button></div>
      <div class="kj-tbl-wrap"><table class="kj-tbl"><thead><tr><th>নাম</th><th>প্যাকেজ</th><th>জমা</th><th>রিয়াল নিয়েছে</th><th>বকেয়া</th></tr></thead><tbody>
      ${c.rows.map(r => `<tr data-ac="${r.code}" class="${r.code === acctOpen ? "open" : ""}"><td><b>${E(r.name)}</b></td><td>${tk(r.pkg)}</td><td>${tk(r.paid)}</td><td>${r.sar ? sr(r.sar) : "—"}</td><td class="${r.due > 0 ? "due" : "clear"}">${r.due > 0 ? tk(r.due) : r.due < 0 ? "ফেরত " + tk(-r.due) : "পরিশোধিত"}</td></tr>`).join("") || '<tr><td colspan="5">এই কাফেলায় এখনো কোনো যাত্রী নেই।</td></tr>'}
      </tbody></table></div><p class="src">বকেয়া = প্যাকেজ মূল্য + নেওয়া রিয়ালের দাম − জমা। কারও বিস্তারিত দেখতে তার নামে চাপ দিন।</p>
      <div id="acMem"></div></div>
    <div class="cl-card"><h3>খরচ লিখুন</h3><div class="cl-grid">
      ${fld("খাত", "exCat", EXP_CATS[0], { attr: 'list="expCats"' })}${fld("পরিমাণ", "exAmt", "", { ph: "যেমন: ১২০০০", attr: 'inputmode="decimal"' })}
      ${fld("মুদ্রা", "exCur", "BDT", { sel: [["BDT", "টাকা"], ["SAR", "রিয়াল"]] })}${fld("তারিখ", "exDate", todayStr(), { type: "date" })}</div>
      ${fld("নোট (ঐচ্ছিক)", "exNote", "", { ph: "যেমন: মক্কা থেকে মদিনা দুটি বাস" })}
      <datalist id="expCats">${EXP_CATS.map(x => `<option value="${x}">`).join("")}</datalist>
      <div class="btn-row">${saveBtn("exSave", "খরচ যোগ করুন")}</div>
      ${Object.keys(c.byCat).length ? `<div class="kj-cats">${Object.entries(c.byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span><b>${E(k)}</b> ${tk(v)}</span>`).join("")}</div>` : ""}
      <ul class="cl-list">${c.exps.map(x => `<li class="cl-item"><div class="grow"><b>${E(x.cat || "অন্যান্য")}: ${x.cur === "SAR" ? sr(x.a) + " (" + tk(x.a * c.rate) + ")" : tk(x.a)}</b><small>${x.d ? bnDate(x.d) : ""}${x.n ? " · " + E(x.n) : ""}</small></div><div class="cl-acts"><button class="danger" data-exd="${x.id}">মুছুন</button></div></li>`).join("")}</ul></div>`;
  q("#acSaveBase").onclick = e => guard(e.target, async () => { const r = num(val("acRate")), p = num(val("acPkg")); await admPut(`acct/${curKid}/rate`, r); await admPut(`acct/${curKid}/pkg`, p); acct.rate = r; acct.pkg = p; drawAcct(); }, "সংরক্ষণ হয়েছে");
  box.querySelector(".kj-tbl tbody").onclick = e => { const tr = e.target.closest("[data-ac]"); if (!tr) return; acctOpen = acctOpen === tr.dataset.ac ? null : tr.dataset.ac; drawAcct(); if (acctOpen) q("#acMem").scrollIntoView({ behavior: "smooth", block: "center" }); };
  q("#exSave").onclick = e => guard(e.target, async () => {
    const a = num(val("exAmt")); if (!a) { toastMsg("পরিমাণ দিন"); throw new Error("x"); }
    const x = { cat: val("exCat") || "অন্যান্য", a, cur: val("exCur"), d: val("exDate"), n: val("exNote"), t: NOW };
    const r = await admPost(`acct/${curKid}/exp`, x); acct.exp = acct.exp || {}; acct.exp[r.name] = Object.assign(x, { t: Date.now() }); drawAcct();
  }, "খরচ যোগ হয়েছে");
  box.querySelectorAll("[data-exd]").forEach(b => b.onclick = () => { if (!confirm("এই খরচটি মুছবেন?")) return; guard(b, async () => { await admDel(`acct/${curKid}/exp/${b.dataset.exd}`); delete acct.exp[b.dataset.exd]; drawAcct(); }, "মুছে ফেলা হয়েছে"); });
  q("#acCsv").onclick = () => acctCsv(c);
  if (acctOpen && acctMembers[acctOpen]) drawAcctMember(acctOpen, c);
}
function drawAcctMember(code, c) {
  const m = acctMembers[code], a = (acct.m && acct.m[code]) || {}, r = c.rows.find(x => x.code === code);
  const list = (o, cur) => Object.entries(o || {}).sort((x, y) => String(y[1].d || "").localeCompare(String(x[1].d || ""))).map(([id, x]) => `<li class="cl-item"><div class="grow"><b>${cur === "SAR" ? sr(x.a) + (c.rate ? " (" + tk(x.a * c.rate) + ")" : "") : tk(x.a)}</b><small>${x.d ? bnDate(x.d) : ""}${x.n ? " · " + E(x.n) : ""}</small></div><div class="cl-acts"><button class="danger" data-amd="${cur === "SAR" ? "sar" : "pay"}/${id}">মুছুন</button></div></li>`).join("") || '<li class="lead">কিছু নেই।</li>';
  q("#acMem").innerHTML = `<div class="cl-card" style="background:var(--marble)"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">${E(m.name)}</h3><button class="btn ghost small" id="amClose">বন্ধ করুন</button></div>
    <p class="lead">প্যাকেজ ${tk(r.pkg)} · জমা ${tk(r.paid)} · রিয়াল ${sr(r.sar)} · <b>${r.due > 0 ? "বকেয়া " + tk(r.due) : r.due < 0 ? "ফেরত পাবেন " + tk(-r.due) : "সব পরিশোধিত"}</b></p>
    <div class="cl-grid">${fld("এই যাত্রীর প্যাকেজ মূল্য (খালি রাখলে সাধারণ মূল্য)", "amPkg", a.pkg != null ? a.pkg : "", { attr: 'inputmode="decimal"' })}</div><button class="btn ghost small" id="amPkgSave">মূল্য সংরক্ষণ</button>
    <div class="cl-grid" style="margin-top:12px">
      <div><h4>টাকা জমা দিয়েছেন</h4>${fld("পরিমাণ (টাকা)", "amPay", "", { attr: 'inputmode="decimal"' })}${fld("তারিখ", "amPayD", todayStr(), { type: "date" })}${fld("নোট", "amPayN", "", { ph: "যেমন: বিকাশে" })}<button class="btn small" id="amPayAdd">জমা যোগ করুন</button><ul class="cl-list">${list(a.pay, "BDT")}</ul></div>
      <div><h4>রিয়াল নিয়েছেন</h4>${fld("পরিমাণ (রিয়াল)", "amSar", "", { attr: 'inputmode="decimal"' })}${fld("তারিখ", "amSarD", todayStr(), { type: "date" })}${fld("নোট", "amSarN", "", { ph: "যেমন: মক্কায় হাতখরচ" })}<button class="btn small" id="amSarAdd">রিয়াল যোগ করুন</button><ul class="cl-list">${list(a.sar, "SAR")}</ul></div>
    </div></div>`;
  const base = `acct/${curKid}/m/${code}`;
  const keep = (k, id, x) => { acct.m = acct.m || {}; acct.m[code] = acct.m[code] || {}; acct.m[code][k] = acct.m[code][k] || {}; acct.m[code][k][id] = x; };
  q("#amClose").onclick = () => { acctOpen = null; drawAcct(); };
  q("#amPkgSave").onclick = e => guard(e.target, async () => { const v = val("amPkg"); if (v === "") await admDel(base + "/pkg"); else await admPut(base + "/pkg", num(v)); acct.m = acct.m || {}; acct.m[code] = acct.m[code] || {}; if (v === "") delete acct.m[code].pkg; else acct.m[code].pkg = num(v); drawAcct(); }, "সংরক্ষণ হয়েছে");
  q("#amPayAdd").onclick = e => guard(e.target, async () => { const a2 = num(val("amPay")); if (!a2) { toastMsg("পরিমাণ দিন"); throw new Error("x"); } const x = { a: a2, d: val("amPayD"), n: val("amPayN") }; const r2 = await admPost(base + "/pay", x); keep("pay", r2.name, x); drawAcct(); }, "জমা যোগ হয়েছে");
  q("#amSarAdd").onclick = e => guard(e.target, async () => { const a2 = num(val("amSar")); if (!a2) { toastMsg("পরিমাণ দিন"); throw new Error("x"); } const x = { a: a2, d: val("amSarD"), n: val("amSarN") }; const r2 = await admPost(base + "/sar", x); keep("sar", r2.name, x); drawAcct(); }, "রিয়াল যোগ হয়েছে");
  q("#acMem").querySelectorAll("[data-amd]").forEach(b => b.onclick = () => { if (!confirm("এই হিসাবটি মুছবেন?")) return; guard(b, async () => { const [k, id] = b.dataset.amd.split("/"); await admDel(`${base}/${k}/${id}`); delete acct.m[code][k][id]; drawAcct(); }, "মুছে ফেলা হয়েছে"); });
}
function acctCsv(c) {
  const name = (kafelas[curKid] && kafelas[curKid].name) || "kafela";
  const rows = [["কাফেলা", name], ["১ রিয়াল (টাকা)", c.rate], [], ["নাম", "প্যাকেজ (টাকা)", "জমা (টাকা)", "রিয়াল নিয়েছে", "রিয়ালের দাম (টাকা)", "বকেয়া (টাকা)"]];
  c.rows.forEach(r => rows.push([r.name, r.pkg, r.paid, r.sar, Math.round(r.sar * c.rate), Math.round(r.due)]));
  rows.push([], ["মোট যাত্রী", c.rows.length], ["মোট জমা", c.tPaid], ["মোট বকেয়া", Math.round(c.due)], ["মোট রিয়াল দেওয়া", c.tSar], ["মোট খরচ (টাকা)", Math.round(c.expTk)], ["হাতে আছে (টাকা)", Math.round(c.cash)], [], ["খরচ: তারিখ", "খাত", "পরিমাণ", "মুদ্রা", "টাকায়", "নোট"]);
  c.exps.forEach(x => rows.push([x.d || "", x.cat || "", x.a, x.cur === "SAR" ? "রিয়াল" : "টাকা", Math.round(x.cur === "SAR" ? x.a * c.rate : x.a), x.n || ""]));
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = name.replace(/[\\/:*?"<>|]+/g, "-") + "-hisab.csv"; document.body.appendChild(a); a.click(); a.remove();
}

/* ----- ID card from the admin panel ----- */
async function showCardModal(m, info) {
  const d = document.createElement("div"); d.className = "kj-modal"; d.setAttribute("role", "dialog");
  d.innerHTML = `<div class="kj-modal-in" style="max-width:720px"><h3>${E(m.name)}: আইডি কার্ড</h3><div class="kj-cardwrap" id="cmImg"><p class="loading">কার্ড তৈরি হচ্ছে…</p></div>
    <p class="src">QR কোড স্ক্যান করলে খুলবে: <span style="direction:ltr;display:inline-block;word-break:break-all">${E(cardUrl(m.card))}</span></p>
    <div class="btn-row" style="justify-content:center"><button class="btn" id="cmDl">ছবি ডাউনলোড</button><button class="btn ghost" id="cmPr">প্রিন্ট</button><button class="btn ghost" id="cmX">বন্ধ করুন</button></div></div>`;
  document.body.appendChild(d);
  q("#cmX").onclick = () => d.remove(); d.addEventListener("click", e => { if (e.target === d) d.remove(); });
  const cv = await drawCard(cardData(m, info));
  const img = new Image(); img.src = cv.toDataURL("image/png"); q("#cmImg").innerHTML = ""; q("#cmImg").appendChild(img);
  q("#cmDl").onclick = () => downloadCanvas(cv, "kafela-id-" + m.name);
  q("#cmPr").onclick = () => printCanvas(cv);
}

/* ----- notices ----- */
async function tabNotice(P) {
  P.innerHTML = `<div class="cl-card"><h3>সবার জন্য নোটিশ</h3>
    <p class="lead" style="margin:0">এখানে লিখলে সবাই “যাত্রা” পাতার ওপরে দেখবে, আর নোটিফিকেশন চালু থাকলে ওয়েবসাইট খোলার সময় নোটিফিকেশনও পাবে।</p>
    ${fld("শিরোনাম", "ntTitle", "", { ph: "যেমন: আজ ফজরের পর জমায়েত" })}${fld("বিস্তারিত", "ntBody", "", { area: true, ph: "যেমন: ফজরের পর সবাই গেট ৭৯-এর সামনে দাঁড়াবেন।" })}
    <div class="btn-row">${saveBtn("ntSend", "নোটিশ পাঠান")}</div></div><div class="cl-card"><h3>পাঠানো নোটিশ</h3><ul class="cl-list" id="ntList"><li class="loading">আনা হচ্ছে…</li></ul></div>`;
  const load = async () => {
    const N = Object.entries((await admGet("content/notices").catch(() => null)) || {}).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    q("#ntList").innerHTML = N.map(([id, n]) => `<li class="cl-item"><div class="grow"><b>${E(n.title)}</b><small>${E(n.body || "")}</small><small>${ago(n.t)}</small></div><div class="cl-acts"><button class="danger" data-nd="${id}">মুছুন</button></div></li>`).join("") || '<li class="lead">কোনো নোটিশ নেই।</li>';
  };
  q("#ntSend").onclick = e => guard(e.target, async () => {
    const title = val("ntTitle"); if (!title) { toastMsg("শিরোনাম দিন"); throw new Error("x"); }
    await admPost("content/notices", { title, body: val("ntBody"), t: NOW });
    q("#ntTitle").value = ""; q("#ntBody").value = ""; await load();
  }, "নোটিশ পাঠানো হয়েছে");
  q("#ntList").onclick = e => { const b = e.target.closest("[data-nd]"); if (b && confirm("নোটিশটি মুছবেন?")) guard(b, async () => { await admDel("content/notices/" + b.dataset.nd); await load(); }, "মুছে ফেলা হয়েছে"); };
  load();
}

/* ----- hateem ----- */
async function tabHateem(P) {
  const H = window.HATEEM;
  const gates = [["hateem", "হাতিম (মাতাফ)"]].concat((window.PLACES || []).filter(p => p.kind === "gate").map(p => [p.id, p.name]));
  const part = (k, t) => { const g = H[k]; return `<div class="cl-card"><h3>${t}</h3>
    ${fld("সময় (দেখানোর লেখা)", k + "Time", g.time, { ph: "সকাল ৬টা – ৯টা" })}
    ${fld("খোলা থাকার সময় (২৪ ঘণ্টা হিসাবে)", k + "Open", winsText(g.open), { ph: "06:00-09:00", help: "একাধিক হলে কমা দিন। যেমন: 22:00-01:00" })}
    ${k === "women" ? fld("গেটে অপেক্ষার সময় (না থাকলে ফাঁকা রাখুন)", k + "Wait", winsText(g.wait), { ph: "19:00-06:00" }) : ""}
    ${fld("গেট (ছোট লেখা)", k + "Tag", g.gateTag, { ph: "গেট ৭৪" })}
    ${fld("“নিয়ে চলো” বোতাম কোথায় নেবে", k + "Goto", g.goto, { sel: gates })}
    ${fld("গেটের বর্ণনা", k + "GateText", g.gateText, { area: true })}
    ${fld("ধাপগুলো (প্রতি লাইনে একটি)", k + "Steps", (g.steps || []).join("\n"), { area: true })}
    ${k === "women" ? fld("মাঠের সর্বশেষ তথ্য (সবুজ ঘর)", "hFieldNote", g.fieldNote || "", { area: true }) : ""}</div>`; };
  P.innerHTML = part("women", "মহিলাদের জন্য") + part("men", "পুরুষদের জন্য") + `<div class="cl-card"><h3>অন্যান্য</h3>
    ${fld("সতর্কতা", "hWarn", H.warn, { area: true })}${fld("সর্বশেষ হালনাগাদের তারিখ", "hUpd", H.updated)}
    <div class="btn-row">${saveBtn("hSave")}</div></div>`;
  q("#hSave").onclick = e => guard(e.target, async () => {
    const part2 = k => ({ time: val(k + "Time"), openTxt: val(k + "Open"), gateTag: val(k + "Tag"), goto: val(k + "Goto"), gateText: val(k + "GateText"), steps: lines(val(k + "Steps")) });
    const w = part2("women"); w.waitTxt = val("womenWait"); w.fieldNote = val("hFieldNote");
    if (!parseWins(w.openTxt).length || !parseWins(val("menOpen")).length) { toastMsg("খোলা থাকার সময় ঠিকমতো লিখুন, যেমন 06:00-09:00"); throw new Error("x"); }
    await admPut("content/hateem", { women: w, men: part2("men"), warn: val("hWarn"), updated: val("hUpd") });
  }, "সংরক্ষণ হয়েছে। সবার কাছে চলে যাবে।");
}

/* ----- places ----- */
let plCity = "makkah", plSearch = "";
async function tabPlaces(P) {
  const all = typeof PLACES !== "undefined" ? PLACES : [];
  const list = all.filter(p => p.city === plCity && !/^(my-|mem-)/.test(p.id) && (!plSearch || (p.name + " " + (p.label || "")).includes(plSearch)));
  P.innerHTML = `<div class="cl-card"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">ম্যাপের জায়গা</h3><button class="btn small gold" id="plNew">নতুন জায়গা</button></div>
    <div class="cl-row" style="margin-top:8px"><div class="cl-tabs" id="plCity"><button data-c="makkah" aria-pressed="${plCity === "makkah"}">মক্কা</button><button data-c="madinah" aria-pressed="${plCity === "madinah"}">মদিনা</button></div>
    <input class="cl-in" id="plQ" placeholder="নাম দিয়ে খুঁজুন" value="${E(plSearch)}" style="flex:1;min-width:180px"></div>
    <div id="plForm"></div><ul class="cl-list" id="plList">${list.map(p => `<li class="cl-item"><span class="cl-ph" style="width:40px;height:40px;font-size:15px">${E(p.label || "•")}</span><div class="grow"><b>${E(p.name)}</b><small>${E(typeof kindBn === "function" ? kindBn(p) : p.kind)}</small></div><div class="cl-acts"><button data-pe="${E(p.id)}">এডিট</button></div></li>`).join("")}</ul></div>`;
  q("#plCity").onclick = e => { const b = e.target.closest("[data-c]"); if (b) { plCity = b.dataset.c; tabPlaces(P); } };
  q("#plQ").onchange = e => { plSearch = e.target.value.trim(); tabPlaces(P); };
  q("#plNew").onclick = () => placeForm(null);
  q("#plList").onclick = e => { const b = e.target.closest("[data-pe]"); if (b) placeForm(b.dataset.pe); };
  if (admMap) { admLayer.clearLayers(); list.forEach(p => L.circleMarker([p.lat, p.lng], { radius: 6, color: "#fff", weight: 2, fillColor: p.kind === "gate" ? "#0B6B50" : "#C9A24A", fillOpacity: 1 }).bindTooltip(p.name).addTo(admLayer)); if (list.length) admMap.fitBounds(list.map(p => [p.lat, p.lng]), { padding: [30, 30], maxZoom: 17 }); }
}
function placeForm(id) {
  const p = id ? (PLACES.find(x => x.id === id) || {}) : { kind: "history", city: plCity };
  const kinds = [["gate", "গেট"], ["holy", "মসজিদের ভেতরে"], ["history", "ঐতিহাসিক স্থান"], ["outside", "শহরের বাইরে"], ["service", "সেবা / ওযুখানা"]];
  const box = q("#plForm");
  box.innerHTML = `<div class="cl-card" style="background:var(--marble)"><h3>${id ? "জায়গা এডিট" : "নতুন জায়গা"}</h3><div class="cl-grid">
    ${fld("নাম", "pfName", p.name || "")}${fld("ম্যাপের চিহ্নে ছোট লেখা (১–৩ অক্ষর, যেমন গেট নম্বর)", "pfLabel", p.label || "")}
    ${fld("ধরন", "pfKind", p.kind, { sel: kinds })}${fld("লোকেশন", "pfLL", typeof p.lat === "number" ? p.lat.toFixed(6) + ", " + p.lng.toFixed(6) : "", { ph: "২১.৪২২৫, ৩৯.৮২৬২" })}</div>
    <div class="btn-row"><button class="btn ghost small" id="pfHere">আমার এখনকার লোকেশন</button><button class="btn ghost small" id="pfPick">ম্যাপে চাপ দিয়ে বসান</button></div>
    ${fld("এটা কী", "pfAbout", p.about || p.text || "", { area: true })}${fld("কেন যাবেন", "pfWhy", p.why || "", { area: true })}${fld("টিপস (প্রতি লাইনে একটি)", "pfTips", (p.tips || []).join("\n"), { area: true })}
    <label class="cl-row" style="gap:8px;margin:6px 0"><input type="checkbox" id="pfApprox" ${p.approx ? "checked" : ""} style="width:20px;height:20px"> লোকেশন আনুমানিক</label>
    <div class="btn-row">${saveBtn("pfSave")}<button class="btn ghost" id="pfCancel">বাতিল</button>${id ? '<button class="btn ghost" id="pfDel" style="color:#b3261e">ম্যাপ থেকে মুছুন</button>' : ""}</div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  const setLL = (a, b) => { q("#pfLL").value = a.toFixed(6) + ", " + b.toFixed(6); };
  q("#pfHere").onclick = () => hereNow(setLL); q("#pfPick").onclick = () => pickOnMap(setLL);
  q("#pfCancel").onclick = () => { box.innerHTML = ""; };
  q("#pfSave").onclick = e => guard(e.target, async () => {
    const ll = val("pfLL").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d)).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!val("pfName") || !ll) { toastMsg("নাম আর লোকেশন দিন"); throw new Error("x"); }
    const lat = +ll[1], lng = +ll[2];
    const data = { name: val("pfName"), label: val("pfLabel") || "•", kind: val("pfKind"), lat, lng, city: lat > 23 ? "madinah" : "makkah", about: val("pfAbout"), text: val("pfAbout"), why: val("pfWhy"), tips: lines(val("pfTips")), approx: q("#pfApprox").checked };
    const pid = id || "x" + rid(8).toLowerCase();
    await admPut("content/places/" + pid, data);
    await admDel("content/placesDel/" + pid).catch(() => {});
    if (window.addPlace) addPlace(Object.assign({ id: pid }, data));
    box.innerHTML = ""; tabPlaces(q("#admPane"));
  }, "সংরক্ষণ হয়েছে। সবার কাছে চলে যাবে।");
  const d = q("#pfDel"); if (d) d.onclick = e => { if (!confirm("জায়গাটি সবার ম্যাপ থেকে সরে যাবে। নিশ্চিত?")) return; guard(e.target, async () => {
    await admPut("content/placesDel/" + id, true); await admDel("content/places/" + id).catch(() => {});
    if (window.removePlace) removePlace(id);
    box.innerHTML = ""; tabPlaces(q("#admPane"));
  }, "মুছে ফেলা হয়েছে"); };
}

/* ----- duas, sunnah, seerah, guide sections ----- */
const ITYPES = [["dua", "দোয়া / সূরা / কালাম"], ["sunnah", "সুন্নত"], ["seerah", "সীরাতের অধ্যায়"], ["guide", "উমরাহ / হজ / মদিনা গাইডের ধাপ"]];
async function tabItems(P) {
  P.innerHTML = `<div class="cl-card"><div class="cl-row" style="justify-content:space-between"><h3 style="margin:0">নতুন লেখা যোগ করুন</h3></div>
    <p class="lead" style="margin:4px 0">যা যোগ করবেন, সবার কাছে সঠিক পাতায় চলে যাবে।</p>
    <div class="cl-tabs" id="itNew">${ITYPES.map(([k, t]) => `<button data-it="${k}">${t}</button>`).join("")}</div><div id="itForm"></div></div>
    <div class="cl-card"><h3>যোগ করা লেখা</h3><ul class="cl-list" id="itList"><li class="loading">আনা হচ্ছে…</li></ul></div>`;
  const load = async () => {
    const I = Object.entries((await admGet("content/items").catch(() => null)) || {}).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    q("#itList").innerHTML = I.map(([id, it]) => `<li class="cl-item"><div class="grow"><b>${E(it.title)}</b><small>${E((ITYPES.find(x => x[0] === it.type) || [, ""])[1])}${it.g ? " · " + E(it.g) : ""}</small></div><div class="cl-acts"><button data-ie="${id}">এডিট</button><button class="danger" data-id="${id}">মুছুন</button></div></li>`).join("") || '<li class="lead">এখনো কিছু যোগ করা হয়নি।</li>';
    q("#itList").onclick = e => {
      const ed = e.target.closest("[data-ie]"), de = e.target.closest("[data-id]");
      if (ed) { const it = I.find(x => x[0] === ed.dataset.ie); itemForm(it[1].type, it[0], it[1]); }
      if (de && confirm("লেখাটি সবার কাছ থেকে মুছে যাবে। নিশ্চিত?")) guard(de, async () => { await admDel("content/items/" + de.dataset.id); await load(); }, "মুছে ফেলা হয়েছে");
    };
  };
  q("#itNew").onclick = e => { const b = e.target.closest("[data-it]"); if (b) { qq("#itNew button").forEach(x => x.setAttribute("aria-pressed", x === b)); itemForm(b.dataset.it, null, {}); } };
  P._reload = load; load();
}
function itemForm(type, id, it) {
  const groupsOf = () => type === "dua" ? [...new Set((window.DUAS || []).map(d => d.g))] : type === "sunnah" ? (window.SUNNAH || []).map(s => s[0]) : type === "seerah" ? [...new Set((window.SEERAH || []).map(s => s.era))] : [];
  const dl = `<datalist id="itGroups">${groupsOf().map(g => `<option value="${E(g)}">`).join("")}</datalist>`;
  let f = "";
  if (type === "dua") f = fld("ভাগ (তালিকা থেকে বাছুন বা নতুন নাম লিখুন)", "itG", it.g || "", { attr: 'list="itGroups"' }) + fld("শিরোনাম", "itTitle", it.title || "") + fld("আরবি, শব্দে শব্দে (প্রতি লাইনে: আরবি শব্দ | বাংলা অর্থ)", "itW", (it.w || []).map(x => x[0] + " | " + (x[1] || "")).join("\n") || it.ar || "", { area: true, attr: 'style="min-height:200px;font-size:18px"', help: "অর্থ ছাড়া শুধু আরবিও লেখা যায়। যেমন: رَبِّ | হে আমার রব" }) + fld("বাংলা উচ্চারণ", "itPron", it.pron || "", { area: true }) + fld("অর্থ", "itMean", it.mean || "", { area: true }) + fld("কখন পড়বেন / ফজিলত (ঐচ্ছিক)", "itNote", it.note || "", { area: true }) + fld("তথ্যসূত্র", "itRef", it.ref || "");
  if (type === "sunnah") f = fld("ভাগ", "itG", it.g || "", { attr: 'list="itGroups"' }) + fld("শিরোনাম", "itTitle", it.title || "") + fld("বিস্তারিত", "itText", it.text || "", { area: true }) + fld("তথ্যসূত্র", "itRef", it.ref || "");
  if (type === "seerah") f = fld("যুগ (ভাগ)", "itG", it.g || "", { attr: 'list="itGroups"' }) + fld("বয়স / সময়", "itAge", it.age || "") + fld("শিরোনাম", "itTitle", it.title || "") + fld("আয়াত বা হাদিসের আরবি (ঐচ্ছিক)", "itAr", it.ar || "", { area: true, attr: 'dir="rtl"' }) + fld("আরবির অর্থ", "itArMean", it.arMean || "", { area: true }) + fld("ঘটনা (অনুচ্ছেদের মাঝে একটি ফাঁকা লাইন দিন)", "itText", it.text || "", { area: true }) + fld("শিক্ষা", "itLesson", it.lesson || "") + fld("তথ্যসূত্র", "itRef", it.ref || "");
  if (type === "guide") f = fld("কোন গাইডে", "itGuide", it.guide || "umrah", { sel: [["umrah", "উমরাহ"], ["hajj", "হজ"], ["madinah", "মদিনা"]] }) + fld("শিরোনাম", "itTitle", it.title || "") + fld("কখন (ছোট লেখা)", "itWhen", it.when || "") + fld("বিস্তারিত (অনুচ্ছেদের মাঝে একটি ফাঁকা লাইন দিন)", "itText", it.text || "", { area: true }) + fld("যা করবেন (প্রতি লাইনে একটি)", "itTodo", it.todo || "", { area: true }) + fld("যা করবেন না (প্রতি লাইনে একটি)", "itAvoid", it.avoid || "", { area: true }) + fld("মহিলাদের জন্য (প্রতি লাইনে একটি)", "itWomen", it.women || "", { area: true }) + fld("তথ্যসূত্র", "itRef", it.ref || "");
  const box = q("#itForm");
  box.innerHTML = `<div class="cl-card" style="background:var(--marble)">${dl}${f}<div class="btn-row">${saveBtn("itSave")}<button class="btn ghost" id="itCancel">বাতিল</button></div></div>`;
  q("#itCancel").onclick = () => { box.innerHTML = ""; };
  q("#itSave").onclick = e => guard(e.target, async () => {
    if (!val("itTitle")) { toastMsg("শিরোনাম দিন"); throw new Error("x"); }
    const data = { type, title: val("itTitle"), t: it.t || NOW };
    ["itG:g", "itAr:ar", "itPron:pron", "itMean:mean", "itNote:note", "itRef:ref", "itText:text", "itAge:age", "itArMean:arMean", "itLesson:lesson", "itGuide:guide", "itWhen:when", "itTodo:todo", "itAvoid:avoid", "itWomen:women"].forEach(s => { const [el, k] = s.split(":"); if (document.getElementById(el)) data[k] = val(el); });
    if (document.getElementById("itW")) { data.w = lines(val("itW")).flatMap(l => { const i = l.indexOf("|"); return i < 0 ? l.split(/\s+/).filter(Boolean).map(a => [a, ""]) : [[l.slice(0, i).trim(), l.slice(i + 1).trim()]]; }).filter(x => x[0]); if (!data.w.length) { toastMsg("আরবি লিখুন"); throw new Error("x"); } }
    if (id) await admPut("content/items/" + id, data); else await admPost("content/items", data);
    box.innerHTML = ""; const P = q("#admPane"); if (P._reload) P._reload();
  }, "সংরক্ষণ হয়েছে। সবার কাছে চলে যাবে।");
}

/* ----- correcting any built-in text ----- */
let etType = "dua", etQ = "";
const ETYPES = [["dua", "দোয়া ও সূরা"], ["sunnah", "সুন্নত"], ["seerah", "সীরাত"], ["guide", "উমরাহ / হজ / মদিনা গাইড"], ["quran", "কুরআনের আয়াত"], ["hidden", "লুকানো লেখা"]];
function editList() {
  const qq2 = etQ.trim(), m = s => !qq2 || String(s || "").includes(qq2);
  if (etType === "dua") return (window.DUAS || []).filter(d => d._k && (m(d.t) || m(d.g) || m(d.mean))).map(d => [d._k, d.t, d.g]);
  if (etType === "sunnah") { const o = []; (window.SUNNAH || []).forEach(g => (g[1] || []).forEach(it => { if (it._k && (m(it[0]) || m(g[0]) || m(it[1]))) o.push([it._k, it[0], g[0]]); })); return o; }
  if (etType === "seerah") return (window.SEERAH || []).filter(s => s._k && (m(s.t) || m(s.era))).map(s => [s._k, s.t, s.era]);
  if (etType === "guide") { const o = [], N = { umrah: "উমরাহ", hajj: "হজ", madinah: "মদিনা" }; for (const [gk, G] of Object.entries(window.GUIDE || {})) (G.sections || []).forEach(s => { if (s._k && (m(s.title) || m(s.when))) o.push([s._k, s.title, N[gk] || gk]); }); return o; }
  if (etType === "hidden") return Object.entries((content && content.edits) || {}).filter(([, e]) => e && e.hide).map(([k, e]) => [k, e.title || k, "লুকানো"]);
  return [];
}
function tabEdit(P) {
  P.innerHTML = `<div class="cl-card"><h3>যেকোনো লেখা ঠিক করুন</h3>
    <p class="lead" style="margin:0 0 6px">দোয়া, সূরা, সুন্নত, সীরাত, গাইড বা কুরআনের আয়াতের উচ্চারণ ও অর্থে ভুল থাকলে এখানে ঠিক করুন। সংরক্ষণ করলে সবার কাছে ঠিক করা লেখাটি যাবে।</p>
    <div class="cl-tabs" id="etTabs">${ETYPES.map(([k, t]) => `<button data-et="${k}" aria-pressed="${k === etType}">${t}</button>`).join("")}</div>
    <div id="etBody"></div></div>`;
  q("#etTabs").onclick = e => { const b = e.target.closest("[data-et]"); if (!b) return; etType = b.dataset.et; etQ = ""; tabEdit(P); };
  const body = q("#etBody");
  if (etType === "quran") return quranEditForm(body);
  const list = editList();
  body.innerHTML = `${etType !== "hidden" ? `<input class="cl-in" id="etQ" placeholder="শিরোনাম বা শব্দ দিয়ে খুঁজুন" value="${E(etQ)}" style="margin:6px 0">` : ""}
    <div id="etForm"></div>
    <p class="src">${B(list.length)}টি পাওয়া গেছে${list.length > 80 ? ", প্রথম ৮০টি দেখানো হচ্ছে। খুঁজে নির্দিষ্ট করুন।" : "।"}</p>
    <ul class="cl-list">${list.slice(0, 80).map(([k, t, g]) => `<li class="cl-item"><div class="grow"><b>${E(t)}</b><small>${E(g || "")}${content && content.edits && content.edits[k] && !content.edits[k].hide ? " · ঠিক করা হয়েছে" : ""}</small></div><div class="cl-acts">${etType === "hidden" ? `<button data-unhide="${E(k)}">আবার দেখান</button>` : `<button data-ek="${E(k)}">এডিট</button>`}</div></li>`).join("") || '<li class="lead">কিছু পাওয়া যায়নি।</li>'}</ul>`;
  const qi = q("#etQ"); if (qi) qi.onchange = e => { etQ = e.target.value; tabEdit(P); };
  body.onclick = e => {
    const b = e.target.closest("[data-ek]"); if (b) return editForm(b.dataset.ek);
    const u = e.target.closest("[data-unhide]"); if (u) guard(u, async () => { await admDel("content/edits/" + u.dataset.unhide); delete content.edits[u.dataset.unhide]; ls.set("content", content); tabEdit(P); }, "আবার দেখানো হবে। পাতাটি নতুন করে খুললে দেখা যাবে।");
  };
}
function findByKey(k) {
  let o = (window.DUAS || []).find(d => d._k === k); if (o) return { type: "dua", o };
  for (const g of window.SUNNAH || []) { o = (g[1] || []).find(it => it._k === k); if (o) return { type: "sunnah", o, g: g[0] }; }
  o = (window.SEERAH || []).find(s => s._k === k); if (o) return { type: "seerah", o };
  for (const G of Object.values(window.GUIDE || {})) { o = (G.sections || []).find(s => s._k === k); if (o) return { type: "guide", o }; }
  return null;
}
function refreshViews() { try { duasDone = false; } catch (e) {} try { seerahDone = false; } catch (e) {} try { gRendered = false; } catch (e) {} }
async function saveEdit(k, rec, title) {
  await admPut("content/edits/" + k, rec);
  content = content || {}; content.edits = content.edits || {}; content.edits[k] = rec; ls.set("content", content);
  applyEdits({ [k]: rec }); refreshViews();
}
function editForm(k) {
  const f = findByKey(k); if (!f) return toastMsg("লেখাটি পাওয়া যায়নি");
  const o = f.o, box = q("#etForm");
  let html = "";
  if (f.type === "dua") html = fld("ভাগ", "edG", o.g) + fld("শিরোনাম", "edT", o.t) +
    fld("আরবি, শব্দে শব্দে (প্রতি লাইনে: আরবি শব্দ | বাংলা অর্থ)", "edW", (o.w || []).map(x => x[0] + " | " + (x[1] || "")).join("\n"), { area: true, attr: 'style="min-height:220px;font-size:18px"', help: "আরবি পুরো লেখাটি এই লাইনগুলো থেকেই তৈরি হয়। অর্থ না দিলে শুধু আরবি দেখাবে।" }) +
    fld("বাংলা উচ্চারণ", "edPron", o.pron, { area: true }) + fld("অর্থ", "edMean", o.mean, { area: true }) + fld("কখন পড়বেন / ফজিলত", "edNote", o.note || "", { area: true }) + fld("কতবার (ঐচ্ছিক)", "edTimes", o.times || "") + fld("তথ্যসূত্র", "edRef", o.ref || "");
  if (f.type === "sunnah") html = `<p class="lead">ভাগ: ${E(f.g)}</p>` + fld("শিরোনাম", "edT", o[0]) + fld("বিস্তারিত", "edText", o[1], { area: true, attr: 'style="min-height:160px"' }) + fld("তথ্যসূত্র", "edRef", o[2] || "");
  if (f.type === "seerah") html = fld("শিরোনাম", "edT", o.t) + fld("যুগ (ভাগ)", "edEra", o.era || "") + fld("বয়স / সময়", "edAge", o.age || "") + fld("আরবি (ঐচ্ছিক)", "edAr", o.ar || "", { area: true, attr: 'dir="rtl"' }) + fld("আরবির অর্থ", "edArM", o.arMean || "", { area: true }) +
    fld("ঘটনা (অনুচ্ছেদের মাঝে একটি ফাঁকা লাইন)", "edBody", (o.body || []).join("\n\n"), { area: true, attr: 'style="min-height:260px"' }) + fld("শিক্ষা", "edLesson", o.lesson || "", { area: true }) + fld("তথ্যসূত্র", "edRef", o.src || "");
  if (f.type === "guide") html = fld("শিরোনাম", "edT", o.title) + fld("কখন", "edWhen", o.when || "") + fld("বিস্তারিত (অনুচ্ছেদের মাঝে একটি ফাঁকা লাইন)", "edBody", (o.body || []).join("\n\n"), { area: true, attr: 'style="min-height:240px"' }) +
    fld("যা করবেন (প্রতি লাইনে একটি)", "edTodo", (o.todo || []).join("\n"), { area: true }) + fld("যা করবেন না (প্রতি লাইনে একটি)", "edAvoid", (o.avoid || []).join("\n"), { area: true }) + fld("মহিলাদের জন্য (প্রতি লাইনে একটি)", "edWomen", (o.women || []).join("\n"), { area: true }) + fld("তথ্যসূত্র", "edRef", o.src || "") +
    '<p class="src">এই ধাপের ভেতরের দোয়াগুলো “দোয়া ও সূরা” থেকে আলাদাভাবে ঠিক করা যায় না; দরকার হলে বিস্তারিত অংশে সঠিক লেখা দিন।</p>';
  box.innerHTML = `<div class="cl-card" style="background:var(--marble)"><h3>এডিট করুন</h3>${html}
    <div class="btn-row">${saveBtn("edSave")}<button class="btn ghost" id="edCancel">বাতিল</button><button class="btn ghost" id="edReset">আগের মতো করুন</button><button class="btn ghost" id="edHide" style="color:#b3261e">লুকিয়ে রাখুন</button></div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  q("#edCancel").onclick = () => { box.innerHTML = ""; };
  q("#edSave").onclick = e => guard(e.target, async () => {
    let rec;
    if (f.type === "dua") {
      const w = lines(val("edW")).map(l => { const i = l.indexOf("|"); return i < 0 ? [l.trim(), ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }).filter(x => x[0]);
      if (!w.length || !val("edT")) { toastMsg("শিরোনাম ও আরবি দিন"); throw new Error("x"); }
      rec = { g: val("edG") || o.g, t: val("edT"), w, pron: val("edPron"), mean: val("edMean"), note: val("edNote"), times: val("edTimes"), ref: val("edRef") };
    }
    if (f.type === "sunnah") rec = { t: val("edT"), text: val("edText"), ref: val("edRef") };
    if (f.type === "seerah") rec = { t: val("edT"), era: val("edEra"), age: val("edAge"), ar: val("edAr"), arMean: val("edArM"), body: paras(val("edBody")), lesson: val("edLesson"), src: val("edRef") };
    if (f.type === "guide") rec = { title: val("edT"), when: val("edWhen"), body: paras(val("edBody")), todo: lines(val("edTodo")), avoid: lines(val("edAvoid")), women: lines(val("edWomen")), src: val("edRef") };
    rec.title = rec.t || rec.title; rec.at = NOW;
    await saveEdit(k, rec);
    box.innerHTML = ""; tabEdit(q("#admPane"));
  }, "সংরক্ষণ হয়েছে। সবার কাছে ঠিক করা লেখা যাবে।");
  q("#edReset").onclick = e => { if (!confirm("আপনার করা পরিবর্তন মুছে আগের লেখায় ফিরে যাবে। নিশ্চিত?")) return; guard(e.target, async () => { await admDel("content/edits/" + k); if (content && content.edits) delete content.edits[k]; ls.set("content", content); box.innerHTML = ""; }, "আগের লেখায় ফিরে যাবে। পাতাটি নতুন করে খুললে দেখা যাবে।"); };
  q("#edHide").onclick = e => { if (!confirm("লেখাটি সবার কাছ থেকে লুকানো হবে। পরে “লুকানো লেখা” থেকে আবার দেখানো যাবে।")) return;
    guard(e.target, async () => { await saveEdit(k, { hide: true, title: o.t || o.title || o[0] || "", at: NOW }); box.innerHTML = ""; tabEdit(q("#admPane")); }, "লুকানো হয়েছে"); };
}
function quranEditForm(body) {
  const S = typeof SURAHS !== "undefined" ? SURAHS : [];
  body.innerHTML = `<div class="cl-grid">${fld("সূরা", "qeS", "1", { sel: S.map(([ar, name], i) => [i + 1, B(i + 1) + ". " + name]) })}${fld("আয়াত নম্বর", "qeA", "1", { type: "number", attr: 'min="1"' })}</div>
    <button class="btn ghost" id="qeLoad">আয়াতটি আনুন</button><div id="qeForm"></div>`;
  q("#qeLoad").onclick = async e => {
    const n = +val("qeS"), a = +val("qeA"), box = q("#qeForm");
    box.innerHTML = '<p class="loading">আনা হচ্ছে…</p>';
    let d; try { d = await loadSurah(n); patchSurah(d); } catch (x) { box.innerHTML = '<p class="cl-err">সূরাটি খোলা যায়নি।</p>'; return; }
    const v = d.verses[a - 1]; if (!v) { box.innerHTML = `<p class="cl-err">এই সূরায় ${B(d.verses.length)}টি আয়াত আছে।</p>`; return; }
    const k = "q" + n + "_" + a;
    box.innerHTML = `<div class="cl-card" style="background:var(--marble)"><p class="ar" lang="ar" dir="rtl" style="font-family:var(--ar);font-size:28px;line-height:2">${E(v.a)}</p>
      ${fld("বাংলা উচ্চারণ", "qeT", v.t, { area: true })}${fld("বাংলা অর্থ", "qeB", v.b, { area: true })}
      <div class="btn-row">${saveBtn("qeSave")}<button class="btn ghost" id="qeReset">আগের মতো করুন</button></div>
      <p class="src">আরবি পাঠ বদলানো যায় না; শুধু উচ্চারণ ও অর্থ ঠিক করা যায়।</p></div>`;
    q("#qeSave").onclick = ev => guard(ev.target, async () => { await saveEdit(k, { t: val("qeT"), b: val("qeB"), title: "কুরআন " + n + ":" + a, at: NOW }); }, "সংরক্ষণ হয়েছে");
    q("#qeReset").onclick = ev => guard(ev.target, async () => { await admDel("content/edits/" + k); if (content && content.edits) delete content.edits[k]; ls.set("content", content); q("#qeLoad").click(); }, "আগের লেখায় ফিরেছে");
  };
}

/* ----- setup ----- */
const RULES = JSON.stringify({ rules: {
  content: { ".read": true, ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'` },
  lead: { ".read": "auth != null", ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'` },
  kidx: { ".read": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'` },
  pub: { ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, $t: { ".read": true } },
  acct: { ".read": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'` },
  codes: { ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, $code: { ".read": "auth != null" } },
  k: { ".read": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`,
    $kid: { info: { ".read": "auth != null" }, trip: { ".read": "auth != null" }, m: { $mid: { ".read": "auth != null", uid: { ".write": "auth != null && (!data.exists() || data.val() === auth.uid) && newData.val() === auth.uid" } } } } },
  loc: { ".read": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`, ".write": `auth != null && auth.token.email == '${ADMIN_EMAIL}'`,
    $kid: { $mid: { ".write": "auth != null && root.child('k').child($kid).child('m').child($mid).child('uid').val() === auth.uid", ".validate": "newData.hasChildren(['lat', 'lng', 't'])" } } }
} }, null, 2);
function tabSetup(P) {
  P.innerHTML = `<div class="cl-card"><h3>সার্ভারের অবস্থা</h3><p class="${READY ? "cl-ok" : "cl-err"}">${READY ? "সার্ভার যুক্ত আছে।" : "সার্ভার এখনো যুক্ত হয়নি। GitHub-এর Secrets-এ FIREBASE_API_KEY আর FIREBASE_DATABASE_URL দেওয়া হয়েছে কিনা দেখুন।"}</p>
    <p class="lead">অ্যাডমিন অ্যাকাউন্ট: <span class="cl-code" style="direction:ltr;display:inline-block">${E(ADMIN_EMAIL)}</span></p></div>
    <div class="cl-card"><h3>নিরাপত্তা নিয়ম (Firebase Rules)</h3>
    <p class="lead">Firebase-এ Realtime Database → Rules-এ আগের সব লেখা মুছে এটা বসিয়ে Publish চাপুন। এতে শুধু আপনি (অ্যাডমিন) সবার তথ্য দেখতে ও বদলাতে পারবেন।</p>
    <div class="cl-pre" id="rulesTxt">${E(RULES)}</div><div class="btn-row"><button class="btn" id="rulesCopy">কপি করুন</button></div></div>`;
  q("#rulesCopy").onclick = async () => { try { await navigator.clipboard.writeText(RULES); toastMsg("কপি হয়েছে"); } catch (e) { const r = document.createRange(); r.selectNodeContents(q("#rulesTxt")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toastMsg("লেখাটি বাছাই করা হয়েছে, কপি করুন"); } };
}
function renderAdminSetupOnly() { q("#admHeadBtns").innerHTML = ""; const P = q("#admBody"); P.innerHTML = '<div id="admPane"></div>'; tabSetup(q("#admPane")); }

/* ---------------- start (called by the main script) ---------------- */
function start() {
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const sec = document.createElement("section");
  sec.className = "view"; sec.id = "v-admin"; sec.setAttribute("aria-label", "অ্যাডমিন");
  sec.innerHTML = '<div class="cl-row" style="justify-content:space-between;margin-top:10px"><h2 style="margin:0">অ্যাডমিন প্যানেল</h2><div class="cl-row" id="admHeadBtns"></div></div><div id="admBody"></div>';
  const home = q("#v-home"); home.parentNode.insertBefore(sec, home.nextSibling);
  // the admin button in the header shows only for the admin
  const right = q(".band-top > div:last-child");
  if (right) { const b = document.createElement("button"); b.id = "admBtn"; b.className = "kj-adm-btn"; b.hidden = true; b.setAttribute("aria-label", "অ্যাডমিন প্যানেল");
    b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg><span>অ্যাডমিন</span>';
    b.onclick = openAdmin; right.insertBefore(b, right.firstChild); }
  const brand = q(".brand");
  if (brand) {
    let t = null;
    const down = () => { clearTimeout(t); t = setTimeout(() => { t = null; if (navigator.vibrate) navigator.vibrate(30); if (adm.on) openAdmin(); }, 3000); };
    const up = () => { clearTimeout(t); t = null; };
    brand.addEventListener("pointerdown", down); ["pointerup", "pointerleave", "pointercancel"].forEach(ev => brand.addEventListener(ev, up));
    brand.addEventListener("contextmenu", e => e.preventDefault());
    brand.style.userSelect = "none"; brand.style.webkitUserSelect = "none";
  }
  checkGate();
  renderMember();
  if (my && window.addPlace) { const h = hotelPlace(); if (h) addPlace(h); const lp = leadPlace(); if (lp) addPlace(lp); }
  if (READY) {
    pullContent(true); refreshMy(); shareLoop(); startUseTimer();
    setInterval(() => { if (!document.hidden) { pullContent(false); refreshMy(); } }, 120000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { pullContent(false); refreshMy(); shareLoop(); } else if (my) { stopShare(); } });
    addEventListener("online", () => { pullContent(false); refreshMy(); });
  }
}
window.HGCloud = { start, applyPlaces, askDua, patchSurah, ready: READY };
})();
