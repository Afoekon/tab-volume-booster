importScripts("settings.js");
let queue = Promise.resolve();
const serialize = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
const registryKey = tabId => `engine_tab_${tabId}`;
async function saved(tabId, hostname) {
  const prefs = await chrome.storage.local.get(null);
  const scope = TVB.scope(prefs.global_save_scope);
  const data = scope === "tab" ? await chrome.storage.session.get(null) : prefs;
  const paused = (await chrome.storage.session.get(`paused_tab_${tabId}`))[`paused_tab_${tabId}`] === true;
  return { scope, paused, settings: TVB.read(data, scope, tabId, hostname) };
}
async function badge(tabId, volume, active) {
  await chrome.action.setBadgeText({ tabId, text: active ? `${Math.round(volume)}%` : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" });
}
async function registry(tabId) { return (await chrome.storage.session.get(registryKey(tabId)))[registryKey(tabId)] || {}; }
async function sendFrames(tabId, type, payload = {}) {
  const frames = await registry(tabId), replies = [];
  for (const [frameId, entry] of Object.entries(frames)) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { target: "page", type, ...payload }, { documentId: entry.documentId });
      if (response?.ok) replies.push(response);
    } catch { delete frames[frameId]; }
  }
  await chrome.storage.session.set({ [registryKey(tabId)]: frames });
  return replies;
}
async function refreshTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const hostname = TVB.hostname(tab.url);
  if (!hostname) return;
  const state = await saved(tabId, hostname);
  await sendFrames(tabId, "SETTINGS", state);
  const frames = await registry(tabId);
  await badge(tabId, state.settings.volume, !state.paused && Object.values(frames).some(f => f.active));
}
async function refreshAll() {
  const data = await chrome.storage.session.get(null);
  for (const key of Object.keys(data).filter(k => /^engine_tab_\d+$/.test(k))) {
    await refreshTab(Number(key.slice("engine_tab_".length))).catch(() => {});
  }
}
async function handle(msg, sender) {
  if (["GET_PAGE_SETTINGS", "REPORT_PAGE"].includes(msg.type)) {
    if (!Number.isInteger(sender.tab?.id) || !sender.documentId) throw new Error("Missing page identity.");
    const tabId = sender.tab.id, hostname = TVB.hostname(sender.tab.url || (await chrome.tabs.get(tabId)).url);
    if (!hostname) throw new Error("Unsupported page.");
    const frames = await registry(tabId), frameId = String(sender.frameId);
    if (msg.type === "GET_PAGE_SETTINGS") {
      if (frames[frameId]?.documentId !== sender.documentId) frames[frameId] = { documentId: sender.documentId, active: false };
    } else {
      frames[frameId] = { documentId: sender.documentId, active: msg.active === true };
    }
    await chrome.storage.session.set({ [registryKey(tabId)]: frames });
    const state = await saved(tabId, hostname);
    await badge(tabId, state.settings.volume, !state.paused && Object.values(frames).some(f => f.active));
    return { ok: true, ...state };
  }
  if (msg.type === "RESET_ALL") {
    await chrome.storage.local.clear();
    // Retain page registrations so existing players can receive the defaults.
    const data = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(data).filter(k => !k.startsWith("engine_tab_")));
    await refreshAll();
    return { ok: true };
  }
  const tab = await chrome.tabs.get(msg.tabId), hostname = TVB.hostname(tab.url);
  if (!hostname) throw new Error("Open a regular website tab to use the booster.");
  if (msg.type === "INIT") return { ok: true, hostname, ...await saved(tab.id, hostname) };
  if (msg.type === "STATUS") {
    const frames = await sendFrames(tab.id, "STATUS");
    const active = frames.some(f => f.active), graphError = frames.find(f => f.error)?.error;
    const suspended = frames.some(f => f.state === "suspended" && f.mediaCount > 0);
    const { settings, paused } = await saved(tab.id, hostname);
    await badge(tab.id, settings.volume, active);
    return { ok: true, active, paused, automatic: true, pageReady: frames.length > 0,
      state: suspended ? "suspended" : active ? "running" : "waiting",
      mediaCount: frames.reduce((n, f) => n + (f.mediaCount || 0), 0),
      skippedCount: frames.reduce((n, f) => n + (f.skippedCount || 0), 0),
      peak: Math.max(0, ...frames.map(f => f.peak || 0)), outputPeak: Math.max(0, ...frames.map(f => f.outputPeak || 0)),
      gainReductionDb: Math.max(0, ...frames.map(f => f.gainReductionDb || 0)), clipped: frames.some(f => f.clipped), error: graphError };
  }
  if (msg.type === "START" || msg.type === "STOP") {
    await chrome.storage.session.set({ [`paused_tab_${tab.id}`]: msg.type === "STOP" });
    await refreshTab(tab.id);
    if (msg.type === "START") await sendFrames(tab.id, "RESUME");
    return { ok: true };
  }
  if (msg.type === "SAVE") {
    const { scope } = await saved(tab.id, hostname), settings = TVB.normalize(msg.settings);
    await (scope === "tab" ? chrome.storage.session : chrome.storage.local).set(TVB.write(settings, scope, tab.id, hostname));
    if (msg.customPreset && ["custom1", "custom2"].includes(settings.mode)) await chrome.storage.local.set({ [`global_${settings.mode}`]: settings.eq });
    await refreshAll();
    return { ok: true, settings };
  }
  if (msg.type === "SCOPE") {
    await chrome.storage.local.set({ global_save_scope: TVB.scope(msg.scope) });
    await refreshAll();
    return { ok: true, ...await saved(tab.id, hostname) };
  }
  throw new Error("Unknown booster command.");
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== "background" || sender.id !== chrome.runtime.id) return;
  serialize(() => handle(msg, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
  await chrome.storage.session.remove([...Object.values(TVB.keys("tab", tabId, "")), registryKey(tabId), `paused_tab_${tabId}`]);
  await chrome.storage.local.remove(Object.values(TVB.keys("tab", tabId, "")));
}).catch(console.error));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) serialize(() => refreshTab(tabId)).catch(() => {});
});
