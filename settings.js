/* Shared validation and storage keys; preserve the original per-site/global saves. */
globalThis.TVB = (() => {
  const bands = ["b60", "b230", "b910", "b3600", "b14000"];
  const presets = {
    normal: { b60: 0, b230: 0, b910: 0, b3600: 0, b14000: 0 },
    bass: { b60: 10, b230: 6, b910: 0, b3600: 0, b14000: 0 },
    voice: { b60: -4, b230: -2, b910: 4, b3600: 8, b14000: 2 },
    cinema: { b60: 8, b230: 4, b910: 0, b3600: 4, b14000: 8 }
  };
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const scope = value => ["site", "tab", "global"].includes(value) ? value : "site";
  const eq = value => Object.fromEntries(bands.map(b => [b, clamp(value?.[b] ?? 0, -12, 12, 0)]));
  const normalize = (value = {}) => ({
    volume: clamp(value.volume ?? 100, 0, 1000, 100),
    mode: [...Object.keys(presets), "custom1", "custom2"].includes(value.mode) ? value.mode : "normal",
    eq: eq(value.eq), nightMode: value.nightMode === true, smoothing: value.smoothing !== false,
    pan: clamp(value.pan ?? 0, -1, 1, 0)
  });
  const keys = (saveScope, tabId, hostname) => {
    const suffix = saveScope === "global" ? "global" : saveScope === "tab" ? `tab_${tabId}` : `host_${hostname}`;
    return { volume: `gain_${suffix}`, mode: `mode_${suffix}`, eq: `eq_${suffix}`, nightMode: `night_${suffix}`, pan: `pan_${suffix}`, smoothing: `smooth_${suffix}` };
  };
  const read = (data, saveScope, tabId, hostname) => normalize(Object.fromEntries(
    Object.entries(keys(saveScope, tabId, hostname)).map(([field, key]) => [field, data[key]])
  ));
  const write = (value, saveScope, tabId, hostname) => {
    const clean = normalize(value);
    return Object.fromEntries(Object.entries(keys(saveScope, tabId, hostname)).map(([field, key]) => [key, clean[field]]));
  };
  const hostname = url => { try { const u = new URL(url); return ["http:", "https:"].includes(u.protocol) ? u.hostname : null; } catch { return null; } };
  return { bands, presets, clamp, scope, eq, normalize, keys, read, write, hostname };
})();
