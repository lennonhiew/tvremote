import { CONFIG, SHOWS } from "./config.js";
import { ICONS } from "./icons.js";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "tv-session";
const ONLINE_MS = 45_000;
let session = localStorage.getItem(SESSION_KEY);
let state = null;
let selectedDay = null;
let appsKey = "";
let pollTimer = 0;
let minutesDraft = null;
let minutesTimer = 0;

// ---------- helpers ----------
function icon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
document.querySelectorAll("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon)));

async function rpc(fn, args = {}) {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.message || `Request failed (${res.status})`);
    err.code = body?.code;
    throw err;
  }
  return body;
}

let toastTimer = 0;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (ms > 0 && m < 1) return "under 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, "0")} min` : `${h} h`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function dayLabel(day, i) {
  if (i === 0 && day === localDay(0)) return "Today";
  if (day === localDay(-1)) return "Yesterday";
  return new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}
function localDay(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD
}
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function signedOut(err) {
  if (err?.code !== "28000") return false;
  localStorage.removeItem(SESSION_KEY);
  session = null;
  showAuth();
  return true;
}

// ---------- auth ----------
async function showAuth() {
  clearTimeout(pollTimer);
  $("app").hidden = true;
  $("auth").hidden = false;
  $("auth-error").textContent = "";
  try {
    const s = await rpc("tv_setup_status");
    $("login-form").hidden = !s.password_set;
    $("setup-form").hidden = s.password_set;
    (s.password_set ? $("login-pw") : $("setup-code")).focus();
  } catch (e) {
    $("auth-error").textContent = "Can't reach the server. Check your connection and reload.";
  }
}

function signedIn(newSession) {
  session = newSession;
  localStorage.setItem(SESSION_KEY, session);
  $("auth").hidden = true;
  $("app").hidden = false;
  poll();
}

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("auth-error").textContent = "";
  try {
    const r = await rpc("tv_login", { p_password: $("login-pw").value });
    if (!r.ok) { $("auth-error").textContent = r.error; return; }
    $("login-pw").value = "";
    signedIn(r.session);
  } catch (e) { $("auth-error").textContent = e.message; }
});

$("setup-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("auth-error").textContent = "";
  if ($("setup-pw").value !== $("setup-pw2").value) { $("auth-error").textContent = "The two passwords don't match."; return; }
  try {
    const r = await rpc("tv_setup", { p_code: $("setup-code").value.trim(), p_password: $("setup-pw").value });
    if (!r.ok) { $("auth-error").textContent = r.error; return; }
    signedIn(r.session);
  } catch (e) { $("auth-error").textContent = e.message; }
});

$("logout").addEventListener("click", async () => {
  try { await rpc("tv_logout", { p_session: session }); } catch {}
  localStorage.removeItem(SESSION_KEY);
  session = null;
  showAuth();
});

// ---------- polling ----------
async function poll() {
  clearTimeout(pollTimer);
  if (!session) return;
  try {
    state = await rpc("tv_state", { p_session: session });
    render();
  } catch (e) {
    if (signedOut(e)) return;
    $("air").classList.remove("on");
    $("air-text").textContent = "Can't reach the server";
  }
  pollTimer = setTimeout(poll, document.hidden ? 30000 : 3000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && session) poll(); });

function online() {
  if (!state?.last_seen) return false;
  return new Date(state.now) - new Date(state.last_seen) < ONLINE_MS && state.status?.screen_on !== false;
}

// ---------- render ----------
function render() {
  const st = state.status || {};
  const on = online();

  // on-air line
  $("air").classList.toggle("on", on);
  $("air-text").textContent = on
    ? (st.locked ? "On · Abbie's time" : st.fg ? `On · ${st.fg}` : "On")
    : `Off · seen ${ago(state.last_seen)}`;

  // Abbie's time
  const lock = $("lock");
  const total = st.session_ms || (state.settings?.minutes || 20) * 60000;
  if (on && st.locked) {
    const rem = st.remaining_ms ?? total;
    lock.classList.remove("idle");
    lock.classList.toggle("paused", !st.playing);
    $("lock-time").textContent = fmtClock(rem);
    $("lock-unit").textContent = "left";
    $("lock-bar").style.width = `${Math.min(100, ((total - rem) / total) * 100)}%`;
    $("lock-note").textContent = st.playing
      ? `Playing ${state.settings?.show?.title || "the show"}. TV unlocks when the timer ends.`
      : "Paused or loading. The timer waits until the show plays.";
    setLockButton("End now", "lock-keyhole-open", { type: "lock_end" }, false);
  } else {
    lock.classList.add("idle");
    lock.classList.remove("paused");
    $("lock-time").textContent = String(state.settings?.minutes || 20);
    $("lock-unit").textContent = "min each time the TV turns on";
    $("lock-bar").style.width = "0%";
    $("lock-note").textContent = on ? "Unlocked. Anyone can use the TV." : "The TV is off. Turn it on with the remote and Abbie's time starts.";
    setLockButton("Start now", "lock-keyhole", { type: "lock_start" }, true);
  }
  $("lock-btn").disabled = !on;

  // remote
  document.querySelectorAll(".remote .btn").forEach((b) => {
    const isKey = JSON.parse(b.dataset.cmd).type === "key";
    b.disabled = !on || (isKey && st.locked);
  });
  $("volume").textContent = on && st.volume_max
    ? (st.muted ? "Muted" : `Volume ${st.volume} of ${st.volume_max}`) + (st.locked ? " · Home and Back are off during Abbie's time" : "")
    : "";

  // apps
  const apps = state.apps || [];
  const key = JSON.stringify(apps);
  if (key !== appsKey) {
    appsKey = key;
    $("apps").innerHTML = apps.map((a) =>
      `<button class="btn" type="button" data-pkg="${esc(a.pkg)}"><span>${esc(a.label)}</span>${icon("chevron-right")}</button>`).join("");
  }
  $("apps").querySelectorAll(".btn").forEach((b) => (b.disabled = !on));
  $("apps-note").textContent = !apps.length ? "The app list appears once the TV has been on."
    : on && st.locked ? "Opening an app ends Abbie's time." : "";

  renderUsage();
  renderSettings();
}

function setLockButton(label, ic, cmd, primary) {
  const b = $("lock-btn");
  b.innerHTML = icon(ic) + label;
  b.dataset.cmd = JSON.stringify(cmd);
  b.classList.toggle("primary", primary);
  b.hidden = false;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderUsage() {
  const days = state.usage || [];
  if (!days.length) {
    $("days").innerHTML = "";
    $("usage-on").textContent = "0 min";
    $("usage").innerHTML = `<li class="empty">Nothing yet. Usage shows up after the TV has been on.</li>`;
    return;
  }
  if (!selectedDay || !days.some((d) => d.day === selectedDay)) selectedDay = days[0].day;
  $("days").innerHTML = days.map((d, i) =>
    `<button type="button" role="tab" data-day="${d.day}" aria-selected="${d.day === selectedDay}">${dayLabel(d.day, i)}</button>`).join("");
  const day = days.find((d) => d.day === selectedDay);
  $("usage-on").textContent = fmtDur(day.screen_ms);
  const rows = Object.entries(day.apps || {}).filter(([, ms]) => ms >= 30000).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  $("usage").innerHTML = rows.length
    ? rows.map(([name, ms]) =>
        `<li class="${name === "Abbie's show" ? "show" : ""}"><span class="name">${esc(name)}</span><span class="dur">${fmtDur(ms)}</span>` +
        `<span class="track"><i style="width:${Math.max(2, (ms / max) * 100)}%"></i></span></li>`).join("")
    : `<li class="empty">No app was open for more than a minute.</li>`;
}

function renderSettings() {
  const s = state.settings || {};
  if (minutesDraft === null) $("minutes").textContent = `${s.minutes || 20} min`;
  $("pin-note").textContent = s.pin_set ? "Set from this website. Needed on the TV to skip Abbie's time."
    : "The TV still uses the starting PIN. Set your own.";
  const sel = $("show");
  if (document.activeElement !== sel) {
    const current = s.show?.id;
    const known = SHOWS.some((x) => x.id === current);
    const opts = SHOWS.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`);
    if (current && !known) opts.push(`<option value="${esc(current)}">${esc(s.show.title || "Your playlist")}</option>`);
    opts.push(`<option value="__custom">Other playlist…</option>`);
    const html = opts.join("");
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    if (sel.value !== "__custom" || $("custom-show").hidden) sel.value = current || SHOWS[0].id;
  }
}

// ---------- actions ----------
async function send(cmd, okMsg) {
  try {
    await rpc("tv_command", { p_session: session, p_cmd: cmd });
    toast(okMsg);
    setTimeout(poll, 1500);
  } catch (e) { if (!signedOut(e)) toast(e.message, true); }
}

$("lock-btn").addEventListener("click", (ev) => {
  const cmd = JSON.parse(ev.currentTarget.dataset.cmd);
  send(cmd, cmd.type === "lock_end" ? "Ending Abbie's time" : "Starting Abbie's time");
});
document.querySelectorAll(".remote .btn").forEach((b) =>
  b.addEventListener("click", () => send(JSON.parse(b.dataset.cmd), "Sent")));
$("apps").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-pkg]");
  if (b) send({ type: "open_app", pkg: b.dataset.pkg }, `Opening ${b.textContent}`);
});
$("days").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-day]");
  if (b) { selectedDay = b.dataset.day; renderUsage(); }
});

async function saveSettings(patch, okMsg) {
  try {
    state.settings = await rpc("tv_save_settings", { p_session: session, p_patch: patch });
    toast(okMsg);
    renderSettings();
    return true;
  } catch (e) { if (!signedOut(e)) toast(e.message, true); return false; }
}

function stepMinutes(delta) {
  const base = minutesDraft ?? (state?.settings?.minutes || 20);
  minutesDraft = Math.min(180, Math.max(5, base + delta));
  $("minutes").textContent = `${minutesDraft} min`;
  clearTimeout(minutesTimer);
  minutesTimer = setTimeout(async () => {
    const m = minutesDraft;
    await saveSettings({ minutes: m }, `Abbie watches for ${m} min`);
    minutesDraft = null;
  }, 700);
}
$("min-down").addEventListener("click", () => stepMinutes(-5));
$("min-up").addEventListener("click", () => stepMinutes(5));

$("show").addEventListener("change", (ev) => {
  const v = ev.target.value;
  $("custom-show").hidden = v !== "__custom";
  if (v === "__custom") { $("custom-url").focus(); return; }
  const show = SHOWS.find((x) => x.id === v) || { id: v, title: ev.target.selectedOptions[0].textContent };
  saveSettings({ show }, `Show: ${show.title}`);
});
$("custom-save").addEventListener("click", async () => {
  const raw = $("custom-url").value.trim();
  const id = (raw.match(/[?&]list=([A-Za-z0-9_-]{10,64})/) || raw.match(/^([A-Za-z0-9_-]{10,64})$/) || [])[1];
  if (!id) { toast("That isn't a YouTube playlist link", true); return; }
  if (await saveSettings({ show: { id, title: "Your playlist" } }, "Show saved")) {
    $("custom-show").hidden = true;
    $("custom-url").value = "";
  }
});

$("pin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const a = $("pin1").value, b = $("pin2").value;
  if (!/^\d{4}$/.test(a)) { toast("The PIN is 4 digits", true); return; }
  if (a !== b) { toast("The two PINs don't match", true); return; }
  if (await saveSettings({ pin_hash: await sha256("tvmenu-pin:" + a) }, "PIN saved. The TV picks it up in a few seconds.")) {
    $("pin1").value = $("pin2").value = "";
  }
});

$("pw-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const r = await rpc("tv_change_password", { p_session: session, p_old: $("pw-old").value, p_new: $("pw-new").value });
    if (!r.ok) { toast(r.error, true); return; }
    $("pw-old").value = $("pw-new").value = "";
    toast("Password changed");
  } catch (e) { if (!signedOut(e)) toast(e.message, true); }
});

// ---------- start ----------
if (session) { $("app").hidden = false; poll(); } else { showAuth(); }
