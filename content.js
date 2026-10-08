(() => {
  let settings = TVB.normalize(), paused = false, graph = null, creating = null, error = null;
  const sources = new WeakMap(), activeSources = new Map(), skipped = new Set(), pending = new Set();
  const observedRoots = new WeakSet();
  let scanning = false, reloadTimer = null, lastReport = null;
  const needsProcessing = () => !paused && (settings.volume !== 100 || settings.nightMode || settings.pan !== 0 || TVB.bands.some(b => settings.eq[b] !== 0));
  const call = (type, payload = {}) => chrome.runtime.sendMessage({ target: "background", type, ...payload });
  function getStatus() {
    return { ok: true, active: needsProcessing() && activeSources.size > 0 && graph?.context.state === "running",
      state: graph?.context.state || "waiting", mediaCount: document.querySelectorAll("audio,video").length,
      skippedCount: skipped.size, peak: graph?.peak || 0, outputPeak: graph?.outputPeak || 0,
      gainReductionDb: graph?.gainReductionDb || 0, clipped: graph?.clipped || false, error };
  }
  function report() {
    const state = getStatus(), fingerprint = JSON.stringify([state.active, state.state, activeSources.size, skipped.size, error]);
    if (fingerprint === lastReport) return;
    lastReport = fingerprint;
    call("REPORT_PAGE", { active: state.active }).catch(() => {});
  }
  function route() {
    if (!graph) return;
    TVBAudio.configure(graph, settings);
    for (const [element, source] of activeSources) {
      source.disconnect();
      if (!element.isConnected) { activeSources.delete(element); continue; }
      source.connect(needsProcessing() ? graph.filters[0] : graph.context.destination);
    }
    report();
  }
  async function ensureGraph() {
    if (graph) return graph;
    if (!creating) creating = (async () => {
      const context = new AudioContext({ latencyHint: "interactive" });
      try {
        graph = await TVBAudio.create(context, chrome.runtime.getURL("peak-guard.js"));
        TVBAudio.configure(graph, settings);
        context.addEventListener("statechange", () => { schedule(document); report(); });
        error = null;
        return graph;
      } catch (failure) {
        await context.close().catch(() => {});
        error = "This page blocked audio processing. Its original audio is unchanged.";
        throw failure;
      }
    })().finally(() => { creating = null; });
    return creating;
  }
  function safeSource(element) {
    if (element.srcObject) return true;
    const source = element.currentSrc || element.src;
    if (!source) return false;
    try {
      const url = new URL(source, location.href);
      return url.protocol === "data:" || url.origin === location.origin || !!element.crossOrigin;
    } catch { return false; }
  }
  async function connect(element) {
    if (!(element instanceof HTMLMediaElement) || !element.isConnected || activeSources.has(element) || !needsProcessing()) return;
    if (!element.readyState) return;
    if (!safeSource(element)) { skipped.add(element); report(); return; }
    skipped.delete(element);
    try {
      const ready = await ensureGraph();
      // Do not reroute a media element into a suspended context and mute it.
      // The site's normal Play/click interaction can unlock Web Audio itself.
      if (ready.context.state !== "running") {
        ready.context.resume().then(() => schedule(element)).catch(() => {});
        return;
      }
      if (!element.isConnected || activeSources.has(element) || !needsProcessing()) return;
      let source = sources.get(element);
      if (!source) { source = ready.context.createMediaElementSource(element); sources.set(element, source); }
      source.connect(ready.filters[0]);
      activeSources.set(element, source);
      report();
    } catch (failure) {
      if (!error) skipped.add(element); // A site/another extension may own its source node.
      report();
    }
  }
  function watch(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") schedule(record.target);
        else record.addedNodes.forEach(schedule);
      }
      for (const element of activeSources.keys()) if (!element.isConnected) { activeSources.get(element).disconnect(); activeSources.delete(element); }
      for (const element of skipped) if (!element.isConnected) skipped.delete(element);
      report();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "crossorigin"] });
    for (const event of ["play", "loadedmetadata", "loadeddata"]) root.addEventListener(event, e => { schedule(e.target); resume(); }, true);
  }
  function scan(root) {
    if (root instanceof HTMLMediaElement) connect(root);
    root.querySelectorAll?.("audio,video").forEach(connect);
    for (const element of [root, ...root.querySelectorAll?.("*") || []]) {
      if (element.shadowRoot) { watch(element.shadowRoot); scan(element.shadowRoot); }
    }
  }
  function schedule(root) {
    if (!(root instanceof Element) && !(root instanceof Document) && !(root instanceof ShadowRoot)) return;
    pending.add(root);
    if (scanning) return;
    scanning = true;
    queueMicrotask(() => { scanning = false; const roots = [...pending]; pending.clear(); roots.forEach(scan); });
  }
  function resume() {
    graph?.context.resume().then(() => { schedule(document); report(); }).catch(() => {});
  }
  async function load() {
    try {
      const state = await call("GET_PAGE_SETTINGS");
      if (!state?.ok) return;
      settings = TVB.normalize(state.settings); paused = state.paused;
      route(); schedule(document);
    } catch { /* Extension was reloaded; existing pages need one refresh. */ }
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== "page" || sender.id !== chrome.runtime.id) return;
    if (msg.type === "STATUS") { reply(getStatus()); return; }
    if (msg.type === "SETTINGS") { settings = TVB.normalize(msg.settings); paused = msg.paused; route(); schedule(document); }
    else if (msg.type === "RESUME") resume();
    reply({ ok: true });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!Object.keys(changes).some(k => k === "global_save_scope" || /^(gain_|eq_|mode_|night_|pan_|smooth_|paused_tab_)/.test(k))) return;
    clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 30);
  });
  document.addEventListener("pointerdown", resume, { capture: true, passive: true });
  document.addEventListener("keydown", resume, { capture: true, passive: true });
  watch(document); load();
})();
