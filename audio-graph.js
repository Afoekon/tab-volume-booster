globalThis.TVBAudio = (() => {
  const frequencies = [60, 230, 910, 3600, 14000];
  const smooth = (param, value, context) => param.setTargetAtTime(value, context.currentTime, 0.015);
  function configure(graph, value) {
    const s = TVB.normalize(value), ctx = graph.context;
    graph.settings = s;
    graph.filters.forEach((filter, i) => smooth(filter.gain, s.eq[TVB.bands[i]], ctx));
    smooth(graph.leveler.parameters.get("enabled"), s.nightMode ? 1 : 0, ctx);
    smooth(graph.booster.parameters.get("drive"), s.smoothing ? s.volume / 100 : 1, ctx);
    graph.guard.parameters.get("enabled").value = s.smoothing ? 1 : 0;
    smooth(graph.gain.gain, s.volume / 100, ctx);
    smooth(graph.panner.pan, s.pan, ctx);
  }
  async function create(context, moduleUrl) {
    await context.audioWorklet.addModule(moduleUrl);
    const filters = frequencies.map((frequency, i) => {
      const filter = context.createBiquadFilter();
      filter.type = i === 0 ? "lowshelf" : i === 4 ? "highshelf" : "peaking";
      filter.frequency.value = Math.min(frequency, context.sampleRate * 0.49);
      return filter;
    });
    const leveler = new AudioWorkletNode(context, "audio-leveler");
    const booster = new AudioWorkletNode(context, "loudness-booster");
    const gain = context.createGain(), panner = context.createStereoPanner();
    const guard = new AudioWorkletNode(context, "peak-guard");
    const chain = [...filters, leveler, booster, gain, panner, guard, context.destination];
    chain.slice(0, -1).forEach((node, i) => node.connect(chain[i + 1]));
    const graph = { context, filters, leveler, booster, gain, panner, guard, peak: 0, outputPeak: 0, gainReductionDb: 0, clipped: false };
    guard.port.onmessage = ({ data }) => Object.assign(graph, data);
    configure(graph, {});
    return graph;
  }
  return { create, configure };
})();
