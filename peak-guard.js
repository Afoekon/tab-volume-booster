/* Stereo-linked gain processing. No native compressor's automatic makeup gain. */
class AudioLeveler extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "enabled", defaultValue: 0, minValue: 0, maxValue: 1 }];
  }
  constructor() {
    super();
    this.envelope = 0;
    this.attack = Math.exp(-1 / (sampleRate * 0.01));
    this.release = Math.exp(-1 / (sampleRate * 0.2));
    this.makeup = Math.pow(10, 2 / 20); // Only 2 dB of controlled gain.
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    const enabled = parameters.enabled;
    for (let i = 0; i < (output[0]?.length ?? 0); i++) {
      let peak = 0;
      for (let channel = 0; channel < input.length; channel++) {
        const value = input[channel]?.[i] ?? 0;
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
      }
      const coefficient = peak > this.envelope ? this.attack : this.release;
      this.envelope = coefficient * this.envelope + (1 - coefficient) * peak;
      const over = 20 * Math.log10(Math.max(1e-12, this.envelope)) + 18;
      // -18 dB threshold, 3:1 ratio, 6 dB soft knee.
      const reduction = over <= -3 ? 0 : over >= 3 ? (2 / 3) * over : (2 / 3) * (over + 3) ** 2 / 12;
      const processedGain = this.makeup * Math.pow(10, -reduction / 20);
      const mix = enabled.length === 1 ? enabled[0] : enabled[i];
      const gain = 1 + mix * (processedGain - 1);
      for (let channel = 0; channel < output.length; channel++) {
        const value = input[channel]?.[i] ?? 0;
        output[channel][i] = Number.isFinite(value) ? value * gain : 0;
      }
    }
    return true;
  }
}
registerProcessor("audio-leveler", AudioLeveler);

// At >100%, compress the source's louder passages before the requested gain.
// Quieter passages keep their full boost instead of being attenuated whenever
// a louder passage reaches the final output ceiling.
class LoudnessBooster extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "drive", defaultValue: 1, minValue: 0, maxValue: 10, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.envelope = 0;
    this.attack = Math.exp(-1 / (sampleRate * 0.002));
    this.release = Math.exp(-1 / (sampleRate * 0.04));
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    const drive = parameters.drive[0];
    const driveDb = 20 * Math.log10(Math.max(1, drive));
    const ratio = 2 + Math.min(2, driveDb / 10);
    // Choose threshold so a sustained full-scale envelope fits the output
    // ceiling after boost; above threshold, lower-level passages are lifted.
    const thresholdDb = (20 * Math.log10(0.98) - driveDb) * ratio / (ratio - 1);
    const slope = 1 - 1 / ratio;
    for (let i = 0; i < (output[0]?.length ?? 0); i++) {
      let peak = 0;
      for (let channel = 0; channel < input.length; channel++) {
        const value = input[channel]?.[i] ?? 0;
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
      }
      const coefficient = peak > this.envelope ? this.attack : this.release;
      this.envelope = coefficient * this.envelope + (1 - coefficient) * peak;
      let gain = 1;
      if (drive > 1) {
        const over = 20 * Math.log10(Math.max(1e-12, this.envelope)) - thresholdDb;
        // A soft 6 dB knee avoids an abrupt switch into compression.
        const reductionDb = over <= -3 ? 0 : over >= 3 ? slope * over : slope * (over + 3) ** 2 / 12;
        gain = Math.pow(10, -reductionDb / 20);
      }
      for (let channel = 0; channel < output.length; channel++) {
        const value = input[channel]?.[i] ?? 0;
        output[channel][i] = Number.isFinite(value) ? value * gain : 0;
      }
    }
    return true;
  }
}
registerProcessor("loudness-booster", LoudnessBooster);

class PeakGuard extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "enabled", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.delay = Math.ceil(sampleRate * 0.006); // 6 ms to anticipate peaks.
    this.size = this.delay + 1;
    this.ceiling = 0.98; // Preserve nearly all of the normal output range.
    this.release = Math.exp(-1 / (sampleRate * 0.04));
    this.gains = new Float64Array(this.size).fill(1);
    this.gainSum = this.size;
    this.envelopeGain = 1;
    this.detectorValues = new Float64Array(this.size + 1);
    this.detectorTimes = new Float64Array(this.size + 1);
    this.detectorHead = 0;
    this.detectorCount = 0;
    this.samples = 0;
    this.index = 0;
    this.channels = [];
    this.activeChannels = 0;
    this.frames = 0;
    this.peak = 0;
    this.outputPeak = 0;
    this.minGain = 1;
    this.clipped = false;
  }
  process(inputs, outputs, parameters = {}) {
    const input = inputs[0], output = outputs[0];
    const enabled = parameters.enabled?.[0] ?? 1;
    // Allocate only when channel topology changes, never for each audio block.
    while (this.channels.length < output.length) this.channels.push(new Float32Array(this.size));
    if (this.activeChannels !== output.length) {
      this.channels.forEach(channel => channel.fill(0));
      this.activeChannels = output.length;
    }
    for (let i = 0; i < (output[0]?.length ?? 0); i++) {
      let peak = 0;
      for (let channel = 0; channel < output.length; channel++) {
        const sample = input[channel]?.[i] ?? 0;
        const value = Number.isFinite(sample) ? sample : 0;
        this.channels[channel][this.index] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      this.peak = Math.max(this.peak, peak);
      const required = peak > this.ceiling ? this.ceiling / peak : 1;
      // A monotonic deque finds the strongest peak still in the lookahead
      // window. Expired peaks must stop affecting gain even if newer samples
      // also exceed the ceiling, or a transient can suppress an entire song.
      const capacity = this.detectorValues.length;
      while (this.detectorCount && this.detectorTimes[this.detectorHead] < this.samples - this.delay) {
        this.detectorHead = (this.detectorHead + 1) % capacity;
        this.detectorCount--;
      }
      while (this.detectorCount && this.detectorValues[(this.detectorHead + this.detectorCount - 1) % capacity] >= required) this.detectorCount--;
      const tail = (this.detectorHead + this.detectorCount) % capacity;
      this.detectorValues[tail] = required;
      this.detectorTimes[tail] = this.samples++;
      this.detectorCount++;
      const target = this.detectorValues[this.detectorHead];
      this.envelopeGain = target < this.envelopeGain ? target : target + (this.envelopeGain - target) * this.release;
      // Each sample's required gain constrains this whole averaging window,
      // giving a smooth, safe attack for the audio delayed by that window.
      this.gainSum += this.envelopeGain - this.gains[this.index];
      this.gains[this.index] = this.envelopeGain;
      const limitedGain = Math.max(0, Math.min(1, this.gainSum / this.size));
      const gain = 1 + enabled * (limitedGain - 1);
      this.minGain = Math.min(this.minGain, gain);
      const delayedIndex = (this.index + 1) % this.size;
      for (let channel = 0; channel < output.length; channel++) {
        const value = this.channels[channel][delayedIndex] * gain;
        // Numerical/fault guard only. Correct operation stays below the ceiling.
        if (Math.abs(value) > (enabled === 1 ? this.ceiling + 1e-6 : 1)) this.clipped = true;
        const safe = enabled === 1 ? Math.max(-this.ceiling, Math.min(this.ceiling, value)) : value;
        output[channel][i] = safe;
        this.outputPeak = Math.max(this.outputPeak, Math.abs(safe));
      }
      this.index = delayedIndex;
      this.frames++;
      if (this.frames >= sampleRate / 4) {
        this.port.postMessage({ peak: this.peak, outputPeak: this.outputPeak,
          gainReductionDb: -20 * Math.log10(Math.max(1e-12, this.minGain)), clipped: this.clipped });
        this.frames = 0; this.peak = 0; this.outputPeak = 0; this.minGain = 1; this.clipped = false;
      }
    }
    return true;
  }
}
registerProcessor("peak-guard", PeakGuard);
