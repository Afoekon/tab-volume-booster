const $ = id => document.getElementById(id);
let tabId = null, settings = TVB.normalize(), saveScope = "site", active = false;
let custom = { custom1: TVB.eq(), custom2: TVB.eq() }, queue = Promise.resolve(), lastError = false;
const audioControls = document.querySelectorAll('#slider, #night-mode-toggle, #smooth-audio-toggle, #pan-slider, #reset-pan-btn, .mode-btn, .eq-slider, [data-volume], [data-step], #default, #scope-select');
const defaults = { theme: "system", accent: "#1a73e8", bg: "#2a2a35", text: "#00ffcc" };
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function status(text, error = false) { lastError = error; $("status").textContent = text; $("status").style.color = error ? "#c43e33" : ""; }
function lock(locked) { audioControls.forEach(control => { control.disabled = locked; }); }
async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ target: "background", type, tabId, ...payload });
  if (!result?.ok) throw new Error(result?.error || "The booster did not respond. Reload the extension.");
  return result;
}
function syncUI() {
  $("slider").value = settings.volume;
  $("label").textContent = `${settings.volume}%`;
  $("night-mode-toggle").checked = settings.nightMode;
  $("smooth-audio-toggle").checked = settings.smoothing;
  $("pan-slider").value = settings.pan;
  $("scope-select").value = saveScope;
  document.querySelectorAll(".eq-slider").forEach(el => { el.value = settings.eq[el.dataset.band]; el.title = `${el.dataset.band.slice(1)} Hz: ${el.value} dB`; });
  document.querySelectorAll(".mode-btn").forEach(el => el.classList.toggle("active", el.dataset.mode === settings.mode));
}
function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(error => status(error.message, true));
  return queue;
}
function save(customPreset = false) {
  const snapshot = TVB.normalize(settings);
  syncUI();
  // Dispatch immediately: the worker serializes writes even if the popup closes.
  send("SAVE", { settings: snapshot, customPreset }).then(async () => {
    if (!active) { await send("START"); await refreshStatus(); }
  }).catch(error => status(error.message, true));
}
async function refreshStatus() {
  if (tabId === null) return;
  try {
    const result = await send("STATUS");
    active = result.active;
    if (result.error) status(result.error, true);
    else if (!result.pageReady) status("Refresh this page once to enable automatic boosting.");
    else if (result.paused) status("Original audio restored for this tab.");
    else if (result.state === "suspended") status("Use the website's Play button to enable audio processing.");
    else if (!active) status(result.skippedCount ? "This player cannot be boosted automatically; original audio is playing." : "Automatic boosting is ready. Play a video to use your saved settings.");
    else if (result.clipped) status("Audio is clipping. Lower the boost or EQ.", true);
    else if (result.gainReductionDb > 0.5) status(`Boosting with peak protection (-${result.gainReductionDb.toFixed(1)} dB).`);
    else status(result.peak > 0.0001 ? "Automatically boosting this website's player." : "Automatic boosting is active; no sound detected yet.");
  } catch (error) { status(error.message, true); }
}
function applyTheme(theme = defaults.theme, accent = defaults.accent, bg = defaults.bg, text = defaults.text) {
  if (!["system", "light", "dark", "custom"].includes(theme)) theme = defaults.theme;
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  accent = color(accent, defaults.accent); bg = color(bg, defaults.bg); text = color(text, defaults.text);
  document.body.setAttribute("data-theme", theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme);
  const style = document.documentElement.style;
  style.setProperty("--accent-color", accent);
  for (const [key, value] of [["--bg-color", bg], ["--text-color", text], ["--panel-bg", bg], ["--btn-bg", bg]]) {
    if (theme === "custom") style.setProperty(key, value); else style.removeProperty(key);
  }
  $("custom-colors-group").style.display = theme === "custom" ? "block" : "none";
  $("theme-select").value = theme; $("accent-picker").value = accent; $("bg-picker").value = bg; $("text-picker").value = text;
}
systemTheme.addEventListener("change", () => {
  if ($("theme-select").value === "system") applyTheme("system", $("accent-picker").value, $("bg-picker").value, $("text-picker").value);
});
$("open-settings-btn").addEventListener("click", () => { $("main-view").style.display = "none"; $("settings-view").style.display = "block"; });
$("close-settings-btn").addEventListener("click", () => { $("main-view").style.display = "block"; $("settings-view").style.display = "none"; });
for (const id of ["theme-select", "accent-picker", "bg-picker", "text-picker"]) {
  $(id).addEventListener(id === "theme-select" ? "change" : "input", () => {
    applyTheme($("theme-select").value, $("accent-picker").value, $("bg-picker").value, $("text-picker").value);
    enqueue(() => chrome.storage.local.set({ global_theme: $("theme-select").value, global_accent: $("accent-picker").value, global_bg: $("bg-picker").value, global_text: $("text-picker").value }));
  });
}
$("reset-theme-btn").addEventListener("click", () => {
  applyTheme();
  enqueue(() => chrome.storage.local.remove(["global_theme", "global_accent", "global_bg", "global_text"]));
});
$("reset-all-btn").addEventListener("click", () => {
  if (!window.confirm("Clear all saved audio settings, custom presets and themes, and stop boosting every tab?")) return;
  lock(true);
  enqueue(async () => {
    try { await send("RESET_ALL"); settings = TVB.normalize(); saveScope = "site"; custom = { custom1: TVB.eq(), custom2: TVB.eq() }; applyTheme(); syncUI(); await send("START"); await refreshStatus(); }
    finally { lock(false); }
  });
});
$("stop-audio-btn").addEventListener("click", () => {
  $("stop-audio-btn").disabled = true;
  enqueue(async () => {
    try { status("Restoring original audio..."); await send("STOP"); await refreshStatus(); }
    finally { $("stop-audio-btn").disabled = false; }
  });
});
$("slider").addEventListener("input", () => { settings.volume = Number($("slider").value); save(); });
$("night-mode-toggle").addEventListener("change", () => { settings.nightMode = $("night-mode-toggle").checked; save(); });
$("smooth-audio-toggle").addEventListener("change", () => { settings.smoothing = $("smooth-audio-toggle").checked; save(); });
$("pan-slider").addEventListener("input", () => { settings.pan = Number($("pan-slider").value); save(); });
$("reset-pan-btn").addEventListener("click", () => { settings.pan = 0; save(); });
$("scope-select").addEventListener("change", () => {
  const scope = $("scope-select").value;
  lock(true);
  enqueue(async () => {
    try { const result = await send("SCOPE", { scope }); saveScope = result.scope; settings = TVB.normalize(result.settings); syncUI(); }
    finally { lock(false); }
  });
});
document.querySelectorAll(".mode-btn").forEach(button => button.addEventListener("click", () => {
  settings.mode = button.dataset.mode;
  settings.eq = { ...(TVB.presets[settings.mode] || custom[settings.mode]) };
  save();
}));
document.querySelectorAll(".eq-slider").forEach(control => control.addEventListener("input", () => {
  if (!["custom1", "custom2"].includes(settings.mode)) settings.mode = "custom1";
  settings.eq[control.dataset.band] = Number(control.value);
  custom[settings.mode] = { ...settings.eq };
  save(true);
}));
document.querySelectorAll('[data-volume]').forEach(button => button.addEventListener('click', () => {
  settings.volume = Number(button.dataset.volume); save();
}));
document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
  settings.volume = TVB.clamp(settings.volume + Number(button.dataset.step), 0, 1000, 100); save();
}));
$("default").addEventListener("click", () => { settings = TVB.normalize(); save(); });
lock(true);
$("stop-audio-btn").disabled = true;
applyTheme();
(async () => {
  try {
    const prefs = await chrome.storage.local.get(null);
    applyTheme(prefs.global_theme, prefs.global_accent, prefs.global_bg, prefs.global_text);
    custom = { custom1: TVB.eq(prefs.global_custom1), custom2: TVB.eq(prefs.global_custom2) };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("No active tab was found.");
    tabId = tab.id;
    const result = await send("INIT");
    settings = TVB.normalize(result.settings); saveScope = result.scope;
    syncUI();
    await send("START");
    lock(false); $("stop-audio-btn").disabled = false;
    await refreshStatus();
    const timer = setInterval(refreshStatus, 1000);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  } catch (error) { status(error.message, true); }
})();
