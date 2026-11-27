import { bearingBetweenDeg, haversineMetersVel, type VelocitySample } from './velocityEngine';

export type PacenoteGrade = 1 | 2 | 3 | 4 | 5 | 6;
export type PacenoteDirection = 'D' | 'E' | 'R';

export interface PacenoteEntry {
  id: string;
  distKm: number;
  distM: number;
  lat: number;
  lon: number;
  altitudeM: number;
  direction: PacenoteDirection;
  grade: PacenoteGrade;
  code: string;
  label: string;
  isHairpin: boolean;
  isLong: boolean;
  tightens: boolean;
  opens: boolean;
  isCritical: boolean;
  isManual: boolean;
  distToNextM: number;
  headingDeg: number;
  sampleIdx: number;
}

export interface ElevationPoint {
  distKm: number;
  altitudeM: number;
}

function signedAngleDiffDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/**
 * Deterministic synthetic altitude (in meters) when KML/GPX lacks 3D Z values,
 * so the 3D terrain mesh and elevation profile always match cleanly.
 */
export function getSampleAltitudeM(sample: VelocitySample, distKm: number): number {
  if (typeof sample.altitudeM === 'number' && Number.isFinite(sample.altitudeM)) {
    return sample.altitudeM;
  }
  const base = 620;
  const hill1 = Math.sin(distKm * 1.45) * 32;
  const hill2 = Math.cos(distKm * 3.1 + 0.7) * 14;
  const micro = Math.sin(distKm * 7.8) * 4.5;
  return Number((base + hill1 + hill2 + micro).toFixed(1));
}

export function buildElevationProfile(samples: VelocitySample[]): ElevationPoint[] {
  if (samples.length === 0) return [];
  const step = Math.max(1, Math.floor(samples.length / 80));
  const pts: ElevationPoint[] = [];
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    pts.push({
      distKm: s.distKm,
      altitudeM: getSampleAltitudeM(s, s.distKm),
    });
  }
  const last = samples[samples.length - 1];
  if (pts.length === 0 || pts[pts.length - 1].distKm !== last.distKm) {
    pts.push({
      distKm: last.distKm,
      altitudeM: getSampleAltitudeM(last, last.distKm),
    });
  }
  return pts;
}

/**
 * Resample a GPS trace to roughly uniform ~20m intervals so GPS jitter never
 * produces false sharp corners, preserving real stage geometry.
 */
export function resampleTraceUniform(
  samples: VelocitySample[],
  stepM = 20
): VelocitySample[] {
  if (samples.length < 2) return samples;
  const out: VelocitySample[] = [samples[0]];
  let accM = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = samples[i];
    const dM = haversineMetersVel(prev.lat, prev.lon, cur.lat, cur.lon);
    accM += dM;
    if (accM >= stepM || i === samples.length - 1) {
      out.push(cur);
      accM = 0;
    }
  }
  return out;
}

function classifyCornerGrade(absTotalDeg: number, radiusM: number): PacenoteGrade {
  if (absTotalDeg >= 108 || radiusM <= 22) return 1;
  if (absTotalDeg >= 72 || radiusM <= 38) return 2;
  if (absTotalDeg >= 46 || radiusM <= 62) return 3;
  if (absTotalDeg >= 27 || radiusM <= 98) return 4;
  if (absTotalDeg >= 14 || radiusM <= 160) return 5;
  return 6;
}

export function buildPacenoteLabel(opts: {
  direction: PacenoteDirection;
  grade: PacenoteGrade;
  isHairpin: boolean;
  isLong: boolean;
  tightens: boolean;
  opens: boolean;
  straightMeters?: number;
}): { code: string; label: string } {
  if (opts.direction === 'R') {
    const m = Math.max(50, Math.round((opts.straightMeters ?? 150) / 50) * 50);
    return { code: `Reta ${m}m`, label: `Reta ${m} metros` };
  }
  const dirWord = opts.direction === 'D' ? 'Direita' : 'Esquerda';
  const parts: string[] = [];
  if (opts.isHairpin) {
    parts.push(`Gancho ${opts.direction}${opts.grade}`);
  } else {
    parts.push(`${opts.direction}${opts.grade}`);
  }
  if (opts.isLong) parts.push('Longa');
  if (opts.tightens) parts.push('Fecha');
  else if (opts.opens) parts.push('Abre');

  const spokenParts: string[] = [];
  if (opts.isHairpin) {
    spokenParts.push(`Gancho ${dirWord} ${opts.grade}`);
  } else {
    spokenParts.push(`${dirWord} ${opts.grade}`);
  }
  if (opts.isLong) spokenParts.push('Longa');
  if (opts.tightens) spokenParts.push('Fecha');
  else if (opts.opens) spokenParts.push('Abre');

  return {
    code: parts.join(' '),
    label: spokenParts.join(' '),
  };
}

function findClosestRawIndex(rawSamples: VelocitySample[], targetDistKm: number): number {
  let rawIdx = 0;
  let bestDiff = Infinity;
  for (let r = 0; r < rawSamples.length; r += 1) {
    const diff = Math.abs(rawSamples[r].distKm - targetDistKm);
    if (diff < bestDiff) {
      bestDiff = diff;
      rawIdx = r;
    }
  }
  return rawIdx;
}

export function generatePacenotesFromTrace(rawSamples: VelocitySample[]): PacenoteEntry[] {
  if (rawSamples.length < 3) return [];
  const uniform = resampleTraceUniform(rawSamples, 22);
  if (uniform.length < 3) return [];

  // Compute local turning rate at each point
  interface RawTurnSeg {
    idx: number;
    bearingDeg: number;
    signedDeg: number;
    segDistM: number;
  }

  const segs: RawTurnSeg[] = [];
  for (let i = 1; i < uniform.length - 1; i += 1) {
    const a = uniform[i - 1];
    const b = uniform[i];
    const c = uniform[i + 1];
    const b1 = bearingBetweenDeg(a.lat, a.lon, b.lat, b.lon);
    const b2 = bearingBetweenDeg(b.lat, b.lon, c.lat, c.lon);
    const signed = signedAngleDiffDeg(b1, b2);
    const d1 = haversineMetersVel(a.lat, a.lon, b.lat, b.lon);
    const d2 = haversineMetersVel(b.lat, b.lon, c.lat, c.lon);
    segs.push({
      idx: i,
      bearingDeg: b2,
      signedDeg: signed,
      segDistM: (d1 + d2) * 0.5,
    });
  }

  const cornerNotes: Array<PacenoteEntry & { exitDistKm: number; exitDistM: number }> = [];
  let i = 0;

  while (i < segs.length) {
    const s = segs[i];
    const dirSign = s.signedDeg > 4.5 ? 1 : s.signedDeg < -4.5 ? -1 : 0;
    if (dirSign === 0) {
      i += 1;
      continue;
    }

    // Group consecutive segments curving in the same direction
    let end = i;
    let totalSigned = s.signedDeg;
    let totalArcM = s.segDistM;
    let firstHalfSigned = Math.abs(s.signedDeg);
    let secondHalfSigned = 0;
    const groupIdxs: number[] = [i];

    while (end + 1 < segs.length) {
      const next = segs[end + 1];
      const nextSign = next.signedDeg > 3.5 ? 1 : next.signedDeg < -3.5 ? -1 : 0;
      if (nextSign === dirSign) {
        end += 1;
        totalSigned += next.signedDeg;
        totalArcM += next.segDistM;
        groupIdxs.push(end);
      } else {
        break;
      }
    }

    const absTotalDeg = Math.abs(totalSigned);
    // Ignore tiny GPS wobbles under 10 deg total
    if (absTotalDeg < 10) {
      i = end + 1;
      continue;
    }

    if (groupIdxs.length >= 2) {
      const mid = Math.floor(groupIdxs.length / 2);
      firstHalfSigned = groupIdxs
        .slice(0, mid)
        .reduce((acc, idx) => acc + Math.abs(segs[idx].signedDeg), 0);
      secondHalfSigned = groupIdxs
        .slice(mid)
        .reduce((acc, idx) => acc + Math.abs(segs[idx].signedDeg), 0);
    }

    const angleRad = (absTotalDeg * Math.PI) / 180;
    const radiusM = angleRad > 0.05 ? totalArcM / angleRad : 400;
    const grade = classifyCornerGrade(absTotalDeg, radiusM);
    const direction: PacenoteDirection = dirSign > 0 ? 'D' : 'E';
    const isHairpin = grade === 1 && absTotalDeg >= 105;
    const isLong = totalArcM >= 75 && !isHairpin;
    const tightens =
      groupIdxs.length >= 2 && secondHalfSigned > firstHalfSigned * 1.42 && absTotalDeg >= 30;
    const opens =
      groupIdxs.length >= 2 && firstHalfSigned > secondHalfSigned * 1.45 && absTotalDeg >= 30;

    const entryPt = uniform[segs[i].idx];
    const exitPt = uniform[segs[end].idx];
    const distKm = entryPt.distKm;
    const distM = Math.round(distKm * 1000);
    const exitDistKm = exitPt.distKm;
    const exitDistM = Math.round(exitDistKm * 1000);
    const { code, label } = buildPacenoteLabel({
      direction,
      grade,
      isHairpin,
      isLong,
      tightens,
      opens,
    });

    const rawIdx = findClosestRawIndex(rawSamples, distKm);

    cornerNotes.push({
      id: `pn_auto_${i}_${distM}`,
      distKm,
      distM,
      lat: entryPt.lat,
      lon: entryPt.lon,
      altitudeM: getSampleAltitudeM(entryPt, distKm),
      direction,
      grade,
      code,
      label,
      isHairpin,
      isLong,
      tightens,
      opens,
      isCritical: grade <= 2,
      isManual: false,
      distToNextM: 0,
      headingDeg: segs[i].bearingDeg,
      sampleIdx: rawIdx,
      exitDistKm,
      exitDistM,
    });

    i = end + 1;
  }

  // Insert straight notes ("Reta 150m", "Reta 200m", "Reta 400m"...) when gap >= 150m
  const notes: PacenoteEntry[] = [];
  const totalDistM = Math.round(rawSamples[rawSamples.length - 1].distKm * 1000);

  const maybePushStraight = (startKm: number, startM: number, endM: number, suffix: string) => {
    const gapM = endM - startM;
    if (gapM < 150) return;
    const roundedM = Math.max(150, Math.round(gapM / 50) * 50);
    const straightStartDistKm = startKm + 0.015;
    const straightStartM = Math.round(straightStartDistKm * 1000);
    if (straightStartM >= endM - 30) return;
    const rawIdx = findClosestRawIndex(rawSamples, straightStartDistKm);
    const sPt = rawSamples[rawIdx] ?? rawSamples[0];
    const nextPt = rawSamples[Math.min(rawSamples.length - 1, rawIdx + 1)] ?? sPt;
    const { code, label } = buildPacenoteLabel({
      direction: 'R',
      grade: 6,
      isHairpin: false,
      isLong: false,
      tightens: false,
      opens: false,
      straightMeters: roundedM,
    });
    notes.push({
      id: `pn_straight_${suffix}_${straightStartM}`,
      distKm: straightStartDistKm,
      distM: straightStartM,
      lat: sPt.lat,
      lon: sPt.lon,
      altitudeM: getSampleAltitudeM(sPt, straightStartDistKm),
      direction: 'R',
      grade: 6,
      code,
      label,
      isHairpin: false,
      isLong: false,
      tightens: false,
      opens: false,
      isCritical: false,
      isManual: false,
      distToNextM: 0,
      headingDeg: bearingBetweenDeg(sPt.lat, sPt.lon, nextPt.lat, nextPt.lon),
      sampleIdx: rawIdx,
    });
  };

  if (cornerNotes.length > 0) {
    maybePushStraight(rawSamples[0].distKm, 0, cornerNotes[0].distM, 'start');
  } else {
    maybePushStraight(rawSamples[0].distKm, 0, totalDistM, 'full');
  }

  for (let c = 0; c < cornerNotes.length; c += 1) {
    const { exitDistKm, exitDistM, ...cleanCorner } = cornerNotes[c];
    notes.push(cleanCorner);
    const nextDistM = c + 1 < cornerNotes.length ? cornerNotes[c + 1].distM : totalDistM;
    maybePushStraight(exitDistKm, exitDistM, nextDistM, `${c}`);
  }

  return recalculatePacenoteDistances(notes, totalDistM);
}

export function recalculatePacenoteDistances(
  notes: PacenoteEntry[],
  totalDistM = 0
): PacenoteEntry[] {
  const sorted = [...notes].sort((a, b) => a.distM - b.distM);
  return sorted.map((n, idx) => {
    const nextDistM = idx < sorted.length - 1 ? sorted[idx + 1].distM : Math.max(n.distM, Math.round(totalDistM));
    return {
      ...n,
      distToNextM: Math.max(0, Math.round(nextDistM - n.distM)),
    };
  });
}

export function formatPacenotesWhatsApp(trackName: string, notes: PacenoteEntry[]): string {
  const header = `🏁 *CADERNO DE NOTAS — ${trackName.toUpperCase()}* (${notes.length} notas)\n`;
  const lines = notes.map((n) => {
    const kmStr = n.distKm.toFixed(2).replace('.', ',');
    const crit = n.isCritical ? ' ⚠️' : '';
    const nextStr = n.distToNextM > 0 ? ` → ${n.distToNextM}m` : ' → FIM';
    return `• *KM ${kmStr}* — ${n.code}${crit}${nextStr}`;
  });
  return `${header}\n${lines.join('\n')}`;
}
