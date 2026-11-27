/**
 * Pure offline Web Audio API rally engine synthesizer + pt-BR pacenote speech helper
 * for "Reconhecimento Virtual 3D".
 */

interface EngineAudioNodes {
  ctx: AudioContext;
  oscBase: OscillatorNode;
  oscHarm: OscillatorNode;
  subOsc: OscillatorNode;
  filter: BiquadFilterNode;
  masterGain: GainNode;
}

let activeEngine: EngineAudioNodes | null = null;
let lastSpokenAtMs = 0;

export function startEngineAudio(): boolean {
  if (typeof window === 'undefined') return false;
  if (activeEngine) {
    if (activeEngine.ctx.state === 'suspended') {
      activeEngine.ctx.resume().catch(() => {});
    }
    return true;
  }

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 3.2;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.001;

    const oscBase = ctx.createOscillator();
    oscBase.type = 'sawtooth';
    oscBase.frequency.value = 52;

    const oscHarm = ctx.createOscillator();
    oscHarm.type = 'triangle';
    oscHarm.frequency.value = 104;

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 26;

    const harmGain = ctx.createGain();
    harmGain.gain.value = 0.42;

    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;

    oscBase.connect(filter);
    oscHarm.connect(harmGain);
    harmGain.connect(filter);
    subOsc.connect(subGain);
    subGain.connect(filter);

    filter.connect(masterGain);
    masterGain.connect(ctx.destination);

    oscBase.start();
    oscHarm.start();
    subOsc.start();

    activeEngine = {
      ctx,
      oscBase,
      oscHarm,
      subOsc,
      filter,
      masterGain,
    };
    return true;
  } catch {
    activeEngine = null;
    return false;
  }
}

export function updateEngineTelemetry(speedKmh: number, playing: boolean): void {
  if (!activeEngine) return;
  const { ctx, oscBase, oscHarm, subOsc, filter, masterGain } = activeEngine;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  if (!playing) {
    // Gentle idle rumble when enabled & paused
    oscBase.frequency.setTargetAtTime(42, now, 0.08);
    oscHarm.frequency.setTargetAtTime(84, now, 0.08);
    subOsc.frequency.setTargetAtTime(21, now, 0.08);
    filter.frequency.setTargetAtTime(220, now, 0.08);
    masterGain.gain.setTargetAtTime(0.035, now, 0.08);
    return;
  }

  // Simulate 5-speed close-ratio rally gearbox RPM curve
  const clamped = Math.max(0, Math.min(165, speedKmh));
  const gearThresholds = [0, 32, 62, 92, 124, 170];
  let gear = 1;
  for (let g = 1; g < gearThresholds.length; g += 1) {
    if (clamped <= gearThresholds[g]) {
      gear = g;
      break;
    }
  }
  const low = gearThresholds[gear - 1];
  const high = gearThresholds[gear];
  const gearRatio = Math.max(0.12, Math.min(1, (clamped - low) / Math.max(10, high - low)));

  // Rally engine RPM 2400..7600 -> fundamental frequency 46..158 Hz
  const rpmNorm = 0.25 + gearRatio * 0.75;
  const baseHz = 44 + rpmNorm * 116;

  oscBase.frequency.setTargetAtTime(baseHz, now, 0.05);
  oscHarm.frequency.setTargetAtTime(baseHz * 2.01, now, 0.05);
  subOsc.frequency.setTargetAtTime(baseHz * 0.5, now, 0.05);
  filter.frequency.setTargetAtTime(260 + rpmNorm * 1050, now, 0.06);
  masterGain.gain.setTargetAtTime(0.065 + rpmNorm * 0.06, now, 0.06);
}

export function stopEngineAudio(): void {
  if (!activeEngine) return;
  const { ctx, oscBase, oscHarm, subOsc, masterGain } = activeEngine;
  activeEngine = null;
  try {
    masterGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    oscBase.stop();
    oscHarm.stop();
    subOsc.stop();
    void ctx.close();
  } catch {
    // Ignore already stopped/closed
  }
}

export function speakPacenotePtBr(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if (now - lastSpokenAtMs < 350) return;
  lastSpokenAtMs = now;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'pt-BR';
    utter.rate = 1.15;
    utter.pitch = 1.02;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore speech synthesis errors on restricted webviews
  }
}

export function cancelPacenoteSpeech(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore
  }
}
