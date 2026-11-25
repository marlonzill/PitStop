import JSZip from 'jszip';

export type GeoTrapKind = 'start' | 'split' | 'finish' | 'start_finish';
export type GeoTrackMode = 'point-to-point' | 'circuit';

export interface GeoWaypoint {
  id: string;
  name: string;
  description?: string;
  lat: number;
  lon: number;
  color?: string;
  folderName?: string;
}

export interface GeoParsedTrap {
  id: string;
  name: string;
  kind: GeoTrapKind;
  lat: number;
  lon: number;
  bearingDeg: number;
  widthM: number;
  unidirectional?: boolean;
}

export interface GeoParsedSample {
  lat: number;
  lon: number;
  speedKmh: number;
  accuracyM: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  timestampMs: number;
  distKm: number;
  stageElapsedMs: number;
  accelLongG?: number | null;
  accelLatG?: number | null;
}

export interface GeoParsedTrack {
  id: string;
  name: string;
  description?: string;
  color?: string;
  waypoints?: GeoWaypoint[];
  mode: GeoTrackMode;
  traps: GeoParsedTrap[];
  createdAtMs: number;
  referenceDistanceKm: number;
  baseTrace?: GeoParsedSample[];
}

export interface ParsedGeoImportResult {
  documentName: string;
  tracks: GeoParsedTrack[];
  waypoints: GeoWaypoint[];
}

export const DEFAULT_TRACK_PALETTE = [
  '#0288D1', // Azul Rally
  '#F57C00', // Laranja Rally
  '#10B981', // Verde Esmeralda
  '#E10600', // Vermelho PitStop
  '#A855F7', // Roxo
  '#FACC15', // Amarelo
  '#EC4899', // Rosa
  '#14B8A6', // Turquesa
];

const MAPS_ME_STYLE_COLORS: Record<string, string> = {
  'placemark-blue': '#0288D1',
  'placemark-red': '#E10600',
  'placemark-orange': '#F57C00',
  'placemark-yellow': '#FBC02D',
  'placemark-green': '#10B981',
  'placemark-purple': '#8E24AA',
  'placemark-pink': '#D81B60',
  'placemark-brown': '#795548',
  'placemark-deeporange': '#F4511E',
  'placemark-deeppurple': '#5E35B1',
  'placemark-cyan': '#00ACC1',
  'placemark-teal': '#00897B',
  'placemark-lime': '#C0CA33',
  'placemark-indigo': '#3949AB',
  'placemark-bluegray': '#546E7A',
  'placemark-gray': '#757575',
};

const GARMIN_COLOR_MAP: Record<string, string> = {
  red: '#E10600',
  darkred: '#B91C1C',
  blue: '#0288D1',
  darkblue: '#1D4ED8',
  cyan: '#06B6D4',
  green: '#10B981',
  darkgreen: '#047857',
  yellow: '#FACC15',
  darkyellow: '#CA8A04',
  magenta: '#D946EF',
  darkmagenta: '#A21CAF',
  orange: '#F57C00',
  black: '#1F2937',
  white: '#F8FAFC',
};

function haversineMetersGeo(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bearingDegGeo(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Math.round(deg * 10) / 10;
}

/**
 * Converte cor KML (`aabbggrr`, ex: `ffd18802` -> `#0288D1`, `ff007cf5` -> `#F57C00`) para `#RRGGBB`.
 */
export function parseKmlColorToHex(kmlColor: string | null | undefined): string | null {
  if (!kmlColor) return null;
  const clean = kmlColor.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    const bb = clean.slice(2, 4);
    const gg = clean.slice(4, 6);
    const rr = clean.slice(6, 8);
    return `#${rr}${gg}${bb}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean}`.toUpperCase();
  }
  return null;
}

function getLocalTagName(el: Element): string {
  return (el.localName || el.tagName.split(':').pop() || '').toLowerCase();
}

function getDirectChildren(el: Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  return Array.from(el.children).filter((c) => getLocalTagName(c) === target);
}

function getDirectChild(el: Element, localName: string): Element | undefined {
  const target = localName.toLowerCase();
  return Array.from(el.children).find((c) => getLocalTagName(c) === target);
}

function getDirectChildText(el: Element, localName: string): string {
  return getDirectChild(el, localName)?.textContent?.trim() ?? '';
}

function sanitizeDescription(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<\/(?:p|div|li|tr|h\d)>/gi, ' · ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, '')
    .trim();
  return cleaned || undefined;
}

/**
 * Remove textos extras de horários (ex: "Horários Largada · SS1 - 11:45h...")
 * mantendo apenas a informação de distância em quilômetros (ex: "9,6 km", "17,9 km").
 */
export function extractTrackKmOnlyDescription(
  raw: string | null | undefined
): string | undefined {
  const cleaned = sanitizeDescription(raw);
  if (!cleaned) return undefined;
  const kmMatch = cleaned.match(/\b(\d{1,4}(?:[.,]\d{1,2})?)\s*km\b/i);
  if (!kmMatch) return undefined;
  const formattedNum = kmMatch[1].replace('.', ',');
  return `${formattedNum} km`;
}

function parseCoordTuples(raw: string): Array<{ lat: number; lon: number; alt: number | null }> {
  const out: Array<{ lat: number; lon: number; alt: number | null }> = [];
  const tokens = raw.trim().split(/\s+/);
  for (const token of tokens) {
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const alt =
      parts.length >= 3 && parts[2] !== '' && Number.isFinite(Number(parts[2]))
        ? Number(parts[2])
        : null;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    ) {
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.lat - lat) < 1e-7 && Math.abs(prev.lon - lon) < 1e-7) {
      continue;
    }
    out.push({ lat, lon, alt });
  }
  return out;
}

function buildTraceFromCoords(
  coords: Array<{ lat: number; lon: number; alt: number | null }>,
  baseTimestampMs: number
): GeoParsedSample[] {
  const trace: GeoParsedSample[] = [];
  let accKm = 0;
  coords.forEach((pt, idx) => {
    if (idx > 0) {
      const prev = coords[idx - 1];
      accKm += haversineMetersGeo(prev.lat, prev.lon, pt.lat, pt.lon) / 1000;
    }
    const next = coords[Math.min(coords.length - 1, idx + 1)];
    const prev = coords[Math.max(0, idx - 1)];
    trace.push({
      lat: pt.lat,
      lon: pt.lon,
      speedKmh: 0,
      accuracyM: 5,
      headingDeg:
        coords.length > 1
          ? bearingDegGeo(prev.lat, prev.lon, next.lat, next.lon)
          : null,
      altitudeM: pt.alt,
      timestampMs: baseTimestampMs + idx * 1000,
      distKm: accKm,
      stageElapsedMs: idx * 1000,
    });
  });
  return trace;
}

function minDistanceToTraceM(
  lat: number,
  lon: number,
  trace: GeoParsedSample[]
): { distM: number; closestIdx: number } {
  if (trace.length === 0) return { distM: Infinity, closestIdx: 0 };
  let bestDist = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < trace.length; i += 1) {
    const d = haversineMetersGeo(lat, lon, trace[i].lat, trace[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { distM: bestDist, closestIdx: bestIdx };
}

function inferBearingNearTrace(
  lat: number,
  lon: number,
  trace: GeoParsedSample[],
  fallbackDeg = 0
): number {
  if (trace.length < 2) return fallbackDeg;
  const { closestIdx } = minDistanceToTraceM(lat, lon, trace);
  let i0 = Math.max(0, closestIdx === trace.length - 1 ? closestIdx - 1 : closestIdx);
  let i1 = Math.min(trace.length - 1, i0 + 1);
  // Look slightly ahead/behind if adjacent vertices are nearly identical (< 4m)
  while (
    i1 < trace.length - 1 &&
    haversineMetersGeo(trace[i0].lat, trace[i0].lon, trace[i1].lat, trace[i1].lon) < 4
  ) {
    i1 += 1;
  }
  while (
    i0 > 0 &&
    haversineMetersGeo(trace[i0].lat, trace[i0].lon, trace[i1].lat, trace[i1].lon) < 4
  ) {
    i0 -= 1;
  }
  if (i0 === i1) return fallbackDeg;
  return bearingDegGeo(trace[i0].lat, trace[i0].lon, trace[i1].lat, trace[i1].lon);
}

function computeEndpointBearing(
  trace: GeoParsedSample[],
  atStart: boolean
): number {
  if (trace.length < 2) return 0;
  if (atStart) {
    const first = trace[0];
    let targetIdx = 1;
    while (
      targetIdx < trace.length - 1 &&
      haversineMetersGeo(first.lat, first.lon, trace[targetIdx].lat, trace[targetIdx].lon) < 8
    ) {
      targetIdx += 1;
    }
    return bearingDegGeo(first.lat, first.lon, trace[targetIdx].lat, trace[targetIdx].lon);
  }
  const last = trace[trace.length - 1];
  let prevIdx = trace.length - 2;
  while (
    prevIdx > 0 &&
    haversineMetersGeo(trace[prevIdx].lat, trace[prevIdx].lon, last.lat, last.lon) < 8
  ) {
    prevIdx -= 1;
  }
  return bearingDegGeo(trace[prevIdx].lat, trace[prevIdx].lon, last.lat, last.lon);
}

function isGenericPlacemarkName(name: string): boolean {
  const clean = name.trim();
  if (!clean) return true;
  return /^(?:caminho|path|untitled(?:\s+path)?|sem\s+t[ií]tulo|line\s*string|trilha|track|rota|route|special|especial)$/i.test(
    clean
  );
}

const POI_KEYWORD_RE =
  /\b(parque\s*(?:de\s*)?servi[cç]os?|service\s*park|paddock|apoio|abastec\w*|posto|box|hospital|hotel|resgate|organiza[cç][aã]o|secretaria|briefing|premia[cç][aã]o|vistoria|parque\s*fechado)\b/i;

const START_KEYWORD_RE = /\b(largada|start|ini|inicio|início|partida)\b/i;
const FINISH_KEYWORD_RE = /\b(chegada|finish|fim|meta)\b/i;
const SPLIT_KEYWORD_RE = /\b(parcial|split|pc|controle|sector|setor|p\d+)\b/i;

function classifyPointKind(name: string): {
  explicitKind: GeoTrapKind | null;
  isPoiKeyword: boolean;
} {
  const isPoiKeyword = POI_KEYWORD_RE.test(name);
  if (isPoiKeyword) return { explicitKind: null, isPoiKeyword: true };
  const hasStart = START_KEYWORD_RE.test(name) || /^l(?:\s*[-:]|\s*\d|$)/i.test(name.trim());
  const hasFinish = FINISH_KEYWORD_RE.test(name) || /^c(?:\s*[-:]|\s*\d|$)/i.test(name.trim());
  if (hasStart && hasFinish) return { explicitKind: 'start_finish', isPoiKeyword: false };
  if (hasStart) return { explicitKind: 'start', isPoiKeyword: false };
  if (hasFinish) return { explicitKind: 'finish', isPoiKeyword: false };
  if (SPLIT_KEYWORD_RE.test(name)) return { explicitKind: 'split', isPoiKeyword: false };
  return { explicitKind: null, isPoiKeyword: false };
}

interface RawKmlStyleLookup {
  lineColors: Map<string, string>;
  iconColors: Map<string, string>;
  styleMapNormal: Map<string, string>;
}

function extractKmlStyles(doc: Document): RawKmlStyleLookup {
  const lineColors = new Map<string, string>();
  const iconColors = new Map<string, string>();
  const styleMapNormal = new Map<string, string>();

  const readStyleColors = (styleEl: Element): { line?: string; icon?: string } => {
    let line: string | undefined;
    let icon: string | undefined;
    const lineStyle = getDirectChild(styleEl, 'LineStyle') ?? styleEl.getElementsByTagName('LineStyle')[0];
    if (lineStyle) {
      const c = parseKmlColorToHex(getDirectChildText(lineStyle, 'color'));
      if (c) line = c;
    }
    const iconStyle = getDirectChild(styleEl, 'IconStyle') ?? styleEl.getElementsByTagName('IconStyle')[0];
    if (iconStyle) {
      const c = parseKmlColorToHex(getDirectChildText(iconStyle, 'color'));
      if (c) icon = c;
    }
    return { line, icon };
  };

  for (const styleEl of Array.from(doc.getElementsByTagName('Style'))) {
    const id = styleEl.getAttribute('id')?.trim();
    if (!id) continue;
    const { line, icon } = readStyleColors(styleEl);
    if (line) lineColors.set(id, line);
    if (icon) iconColors.set(id, icon);
  }

  for (const smEl of Array.from(doc.getElementsByTagName('StyleMap'))) {
    const id = smEl.getAttribute('id')?.trim();
    if (!id) continue;
    const pairs = getDirectChildren(smEl, 'Pair');
    let normalTarget: string | undefined;
    let firstTarget: string | undefined;
    for (const pair of pairs) {
      const key = getDirectChildText(pair, 'key').toLowerCase();
      const url = getDirectChildText(pair, 'styleUrl').replace(/^#/, '');
      if (url && !firstTarget) firstTarget = url;
      if (key === 'normal' && url) {
        normalTarget = url;
        break;
      }
      // Inline Style inside Pair
      if (key === 'normal' && !url) {
        const inlineStyle = getDirectChild(pair, 'Style');
        if (inlineStyle) {
          const { line, icon } = readStyleColors(inlineStyle);
          if (line) lineColors.set(id, line);
          if (icon) iconColors.set(id, icon);
        }
      }
    }
    const resolvedTarget = normalTarget || firstTarget;
    if (resolvedTarget) {
      styleMapNormal.set(id, resolvedTarget);
    }
  }

  return { lineColors, iconColors, styleMapNormal };
}

function resolveElementKmlColor(
  el: Element,
  styles: RawKmlStyleLookup,
  prefer: 'line' | 'icon',
  folderEl?: Element
): string | undefined {
  const tryStyleEl = (container: Element): string | undefined => {
    const inlineStyle = getDirectChild(container, 'Style');
    if (inlineStyle) {
      const subTag = prefer === 'line' ? 'LineStyle' : 'IconStyle';
      const sub = getDirectChild(inlineStyle, subTag);
      const c = parseKmlColorToHex(sub ? getDirectChildText(sub, 'color') : undefined);
      if (c) return c;
      const altSubTag = prefer === 'line' ? 'IconStyle' : 'LineStyle';
      const altSub = getDirectChild(inlineStyle, altSubTag);
      const altC = parseKmlColorToHex(altSub ? getDirectChildText(altSub, 'color') : undefined);
      if (altC) return altC;
    }

    const styleUrlRaw = getDirectChildText(container, 'styleUrl');
    if (styleUrlRaw) {
      const styleId = styleUrlRaw.replace(/^#/, '').trim();
      const mappedId = styles.styleMapNormal.get(styleId) ?? styleId;
      const primaryMap = prefer === 'line' ? styles.lineColors : styles.iconColors;
      const secondaryMap = prefer === 'line' ? styles.iconColors : styles.lineColors;
      const found =
        primaryMap.get(mappedId) ??
        primaryMap.get(styleId) ??
        secondaryMap.get(mappedId) ??
        secondaryMap.get(styleId);
      if (found) return found;

      // Fallback MAPS.ME style ids (#placemark-blue, #placemark-orange, etc.)
      const lowerId = styleId.toLowerCase();
      if (MAPS_ME_STYLE_COLORS[lowerId]) return MAPS_ME_STYLE_COLORS[lowerId];
      // Google My Maps encoded hex in styleId: line-0288D1-5000 or icon-1899-F57C00
      const hexInId = styleId.match(/(?:line|poly|icon)-([0-9a-fA-F]{6})\b/i) ??
        styleId.match(/\b([0-9a-fA-F]{6})-(?:\d+|nodesc)\b/i);
      if (hexInId) return `#${hexInId[1].toUpperCase()}`;
    }
    return undefined;
  };

  return tryStyleEl(el) ?? (folderEl ? tryStyleEl(folderEl) : undefined);
}

interface ExtractedLineItem {
  id: string;
  folderId: string;
  folderName?: string;
  name: string;
  description?: string;
  color?: string;
  coords: Array<{ lat: number; lon: number; alt: number | null }>;
}

interface ExtractedPointItem {
  id: string;
  folderId: string;
  folderName?: string;
  name: string;
  description?: string;
  color?: string;
  lat: number;
  lon: number;
}

function extractLineCoordsFromGeometry(geomEl: Element): Array<Array<{ lat: number; lon: number; alt: number | null }>> {
  const tag = getLocalTagName(geomEl);
  if (tag === 'linestring') {
    const coordEl = getDirectChild(geomEl, 'coordinates') ?? geomEl.getElementsByTagName('coordinates')[0];
    if (!coordEl?.textContent) return [];
    const parsed = parseCoordTuples(coordEl.textContent);
    return parsed.length >= 2 ? [parsed] : [];
  }
  if (tag === 'track') {
    const out: Array<{ lat: number; lon: number; alt: number | null }> = [];
    for (const child of Array.from(geomEl.children)) {
      if (getLocalTagName(child) === 'coord') {
        const parts = (child.textContent || '').trim().split(/\s+/);
        if (parts.length < 2) continue;
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);
        const alt = parts.length >= 3 && Number.isFinite(Number(parts[2])) ? Number(parts[2]) : null;
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180 &&
          !(lat === 0 && lon === 0)
        ) {
          out.push({ lat, lon, alt });
        }
      }
    }
    return out.length >= 2 ? [out] : [];
  }
  if (tag === 'multitrack') {
    const segments: Array<Array<{ lat: number; lon: number; alt: number | null }>> = [];
    for (const child of Array.from(geomEl.children)) {
      if (getLocalTagName(child) === 'track') {
        segments.push(...extractLineCoordsFromGeometry(child));
      }
    }
    return segments;
  }
  if (tag === 'multigeometry') {
    const segments: Array<Array<{ lat: number; lon: number; alt: number | null }>> = [];
    for (const child of Array.from(geomEl.children)) {
      segments.push(...extractLineCoordsFromGeometry(child));
    }
    return segments;
  }
  return [];
}

function extractPointFromPlacemark(pmEl: Element): { lat: number; lon: number } | null {
  const directPt = getDirectChild(pmEl, 'Point');
  if (directPt) {
    const coordEl = getDirectChild(directPt, 'coordinates') ?? directPt.getElementsByTagName('coordinates')[0];
    const tuples = coordEl?.textContent ? parseCoordTuples(coordEl.textContent) : [];
    if (tuples.length > 0) return { lat: tuples[0].lat, lon: tuples[0].lon };
  }
  const multi = getDirectChild(pmEl, 'MultiGeometry');
  if (multi) {
    const nestedPt = getDirectChild(multi, 'Point');
    if (nestedPt) {
      const coordEl = getDirectChild(nestedPt, 'coordinates') ?? nestedPt.getElementsByTagName('coordinates')[0];
      const tuples = coordEl?.textContent ? parseCoordTuples(coordEl.textContent) : [];
      if (tuples.length > 0) return { lat: tuples[0].lat, lon: tuples[0].lon };
    }
  }
  return null;
}

/**
 * Interpreta arquivos KML respeitando a árvore real de `<Folder>` e `<Placemark>` (MAPS.ME / Google My Maps),
 * mantendo cada `<LineString>` / `<gx:Track>` independente e separando POIs (ex: "Parque Serviços") das pistas.
 */
export function parseKmlToGeoResult(kmlXml: string, fileName: string): ParsedGeoImportResult {
  const cleanFileName = fileName.replace(/\.(kml|kmz)$/i, '');
  const now = Date.now();
  const sanitizedXml = kmlXml
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  const doc = new DOMParser().parseFromString(sanitizedXml, 'application/xml');

  const kmlRoot = doc.documentElement;
  const documentEl =
    getDirectChild(kmlRoot, 'Document') ??
    doc.getElementsByTagName('Document')[0] ??
    kmlRoot;

  const documentName =
    (documentEl ? getDirectChildText(documentEl, 'name') : '') || cleanFileName;

  const styles = extractKmlStyles(doc);
  const lines: ExtractedLineItem[] = [];
  const points: ExtractedPointItem[] = [];
  let folderSeq = 0;

  const walkContainer = (
    containerEl: Element,
    folderId: string,
    folderName?: string,
    folderDesc?: string,
    folderEl?: Element
  ) => {
    for (const child of Array.from(containerEl.children)) {
      const tag = getLocalTagName(child);
      if (tag === 'folder' || tag === 'document') {
        folderSeq += 1;
        const subFolderId = `fld_${folderSeq}`;
        const rawSubName = getDirectChildText(child, 'name');
        const subFolderName = rawSubName || folderName;
        const subFolderDesc =
          sanitizeDescription(getDirectChildText(child, 'description')) || folderDesc;
        walkContainer(child, subFolderId, subFolderName, subFolderDesc, child);
      } else if (tag === 'placemark') {
        const pmNameRaw = getDirectChildText(child, 'name');
        const pmDesc =
          sanitizeDescription(getDirectChildText(child, 'description')) || folderDesc;

        const geomSegments: Array<Array<{ lat: number; lon: number; alt: number | null }>> = [];
        for (const pmChild of Array.from(child.children)) {
          const gTag = getLocalTagName(pmChild);
          if (
            gTag === 'linestring' ||
            gTag === 'track' ||
            gTag === 'multitrack' ||
            gTag === 'multigeometry'
          ) {
            geomSegments.push(...extractLineCoordsFromGeometry(pmChild));
          }
        }

        if (geomSegments.length > 0) {
          const resolvedName =
            (!isGenericPlacemarkName(pmNameRaw) ? pmNameRaw : folderName || pmNameRaw) ||
            `${cleanFileName} #${lines.length + 1}`;
          const lineColor = resolveElementKmlColor(child, styles, 'line', folderEl);
          const trackKmDesc = extractTrackKmOnlyDescription(pmDesc);

          geomSegments.forEach((coords, segIdx) => {
            const segName =
              geomSegments.length > 1
                ? `${resolvedName} (${segIdx + 1})`
                : resolvedName;
            lines.push({
              id: `kml_line_${lines.length + 1}_${now}`,
              folderId,
              folderName,
              name: segName,
              description: trackKmDesc,
              color: lineColor,
              coords,
            });
          });
        } else {
          const pt = extractPointFromPlacemark(child);
          if (pt) {
            const ptName = pmNameRaw || folderName || `Ponto ${points.length + 1}`;
            const iconColor = resolveElementKmlColor(child, styles, 'icon', folderEl);
            points.push({
              id: `kml_pt_${points.length + 1}_${now}`,
              folderId,
              folderName,
              name: ptName,
              description: pmDesc,
              color: iconColor,
              lat: pt.lat,
              lon: pt.lon,
            });
          }
        }
      }
    }
  };

  if (documentEl) {
    walkContainer(documentEl, 'fld_root', undefined, undefined, documentEl);
  }

  // Fallback for KML files with unusual nesting where <Placemark> wasn't direct child of Document/Folder
  if (lines.length === 0 && points.length === 0) {
    for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
      const parentFolder =
        pm.parentElement && getLocalTagName(pm.parentElement) === 'folder'
          ? pm.parentElement
          : undefined;
      const folderName = parentFolder ? getDirectChildText(parentFolder, 'name') : undefined;
      const folderId = parentFolder
        ? `fld_fb_${Array.from(doc.getElementsByTagName('Folder')).indexOf(parentFolder)}`
        : 'fld_root';
      const pmName = getDirectChildText(pm, 'name');
      const pmDesc = sanitizeDescription(getDirectChildText(pm, 'description'));

      const geomSegments: Array<Array<{ lat: number; lon: number; alt: number | null }>> = [];
      for (const ls of Array.from(pm.getElementsByTagName('LineString'))) {
        geomSegments.push(...extractLineCoordsFromGeometry(ls));
      }
      if (geomSegments.length === 0) {
        for (const trk of Array.from(pm.getElementsByTagNameNS('*', 'Track'))) {
          geomSegments.push(...extractLineCoordsFromGeometry(trk));
        }
      }

      if (geomSegments.length > 0) {
        const lineColor = resolveElementKmlColor(pm, styles, 'line', parentFolder);
        const resolvedName =
          (!isGenericPlacemarkName(pmName) ? pmName : folderName || pmName) ||
          `${cleanFileName} #${lines.length + 1}`;
        const trackKmDesc = extractTrackKmOnlyDescription(pmDesc);
        geomSegments.forEach((coords, segIdx) => {
          lines.push({
            id: `kml_line_${lines.length + 1}_${now}`,
            folderId,
            folderName,
            name: geomSegments.length > 1 ? `${resolvedName} (${segIdx + 1})` : resolvedName,
            description: trackKmDesc,
            color: lineColor,
            coords,
          });
        });
      } else {
        const pt = extractPointFromPlacemark(pm);
        if (pt) {
          const iconColor = resolveElementKmlColor(pm, styles, 'icon', parentFolder);
          points.push({
            id: `kml_pt_${points.length + 1}_${now}`,
            folderId,
            folderName,
            name: pmName || folderName || `Ponto ${points.length + 1}`,
            description: pmDesc,
            color: iconColor,
            lat: pt.lat,
            lon: pt.lon,
          });
        }
      }
    }
  }

  // Group lines per folder so we know which folders are single-track, multi-track, or point-only
  const linesByFolder = new Map<string, ExtractedLineItem[]>();
  for (const line of lines) {
    const arr = linesByFolder.get(line.folderId) ?? [];
    arr.push(line);
    linesByFolder.set(line.folderId, arr);
  }

  // Build trace for every LineString independently (NEVER concatenating across lines)
  const builtTracks: Array<{
    line: ExtractedLineItem;
    baseTrace: GeoParsedSample[];
    traps: GeoParsedTrap[];
  }> = lines.map((line, idx) => ({
    line: {
      ...line,
      color: line.color || DEFAULT_TRACK_PALETTE[idx % DEFAULT_TRACK_PALETTE.length],
    },
    baseTrace: buildTraceFromCoords(line.coords, now + idx * 10000),
    traps: [],
  }));

  const waypoints: GeoWaypoint[] = [];

  // Assign each Point Placemark either as a Track Trap (L, C, P1...) or a standalone Waypoint (POI)
  points.forEach((pt, ptIdx) => {
    const { explicitKind, isPoiKeyword } = classifyPointKind(pt.name);
    const sameFolderLines = linesByFolder.get(pt.folderId) ?? [];

    // 1. If clearly a POI (e.g. "Parque Serviços"), always treat as Waypoint, never as a trap
    if (isPoiKeyword) {
      waypoints.push({
        id: pt.id,
        name: pt.name,
        description: pt.description,
        lat: pt.lat,
        lon: pt.lon,
        color: pt.color || '#F59E0B',
        folderName: pt.folderName,
      });
      return;
    }

    // 2. If inside a folder that has LineString(s), find matching track in that folder
    if (sameFolderLines.length > 0 && builtTracks.length > 0) {
      let bestTarget = builtTracks.find((bt) => bt.line.id === sameFolderLines[0].id)!;
      let bestDistM = minDistanceToTraceM(pt.lat, pt.lon, bestTarget.baseTrace).distM;

      for (const candidateLine of sameFolderLines.slice(1)) {
        const candidateBt = builtTracks.find((bt) => bt.line.id === candidateLine.id)!;
        const d = minDistanceToTraceM(pt.lat, pt.lon, candidateBt.baseTrace).distM;
        if (d < bestDistM) {
          bestDistM = d;
          bestTarget = candidateBt;
        }
      }

      // If it's an explicit L/C/Parcial OR reasonably close to the track (<= 500m), make it a trap on that track
      if (explicitKind !== null || bestDistM <= 500) {
        const kind: GeoTrapKind = explicitKind ?? 'split';
        const fallbackBearing =
          kind === 'start'
            ? computeEndpointBearing(bestTarget.baseTrace, true)
            : kind === 'finish'
              ? computeEndpointBearing(bestTarget.baseTrace, false)
              : 0;
        bestTarget.traps.push({
          id: `trap_kml_${ptIdx + 1}_${now}`,
          name: pt.name,
          kind,
          lat: pt.lat,
          lon: pt.lon,
          bearingDeg: inferBearingNearTrace(pt.lat, pt.lon, bestTarget.baseTrace, fallbackBearing),
          widthM: 40,
          unidirectional: true,
        });
        return;
      }

      // Otherwise inside same folder but far off-route -> POI Waypoint
      waypoints.push({
        id: pt.id,
        name: pt.name,
        description: pt.description,
        lat: pt.lat,
        lon: pt.lon,
        color: pt.color || '#F59E0B',
        folderName: pt.folderName,
      });
      return;
    }

    // 3. Point-only Folder or Root Document Point:
    // Attach to closest track ONLY if it's an explicit trap or very close to a track (<= 220m)
    if (builtTracks.length > 0) {
      let bestBt = builtTracks[0];
      let bestDistM = Infinity;
      for (const bt of builtTracks) {
        const d = minDistanceToTraceM(pt.lat, pt.lon, bt.baseTrace).distM;
        if (d < bestDistM) {
          bestDistM = d;
          bestBt = bt;
        }
      }
      if (
        (explicitKind !== null && bestDistM <= 1500) ||
        (bestDistM <= 220 && !pt.folderName)
      ) {
        const kind: GeoTrapKind = explicitKind ?? 'split';
        bestBt.traps.push({
          id: `trap_kml_${ptIdx + 1}_${now}`,
          name: pt.name,
          kind,
          lat: pt.lat,
          lon: pt.lon,
          bearingDeg: inferBearingNearTrace(pt.lat, pt.lon, bestBt.baseTrace, 0),
          widthM: 40,
          unidirectional: true,
        });
        return;
      }
    }

    // 4. Standalone Point-only folder (ex: "Parque Serviços") -> Waypoint / POI (NEVER an empty track)
    waypoints.push({
      id: pt.id,
      name: pt.name,
      description: pt.description,
      lat: pt.lat,
      lon: pt.lon,
      color: pt.color || '#F59E0B',
      folderName: pt.folderName,
    });
  });

  // Finalize traps for every track: sort splits along trace and auto-add missing L / C traps from LineString endpoints
  const tracks: GeoParsedTrack[] = builtTracks.map((bt, idx) => {
    const { line, baseTrace, traps } = bt;
    const starts = traps.filter((t) => t.kind === 'start' || t.kind === 'start_finish');
    const finishes = traps.filter((t) => t.kind === 'finish');
    const splits = traps
      .filter((t) => t.kind === 'split')
      .sort((a, b) => {
        const idxA = minDistanceToTraceM(a.lat, a.lon, baseTrace).closestIdx;
        const idxB = minDistanceToTraceM(b.lat, b.lon, baseTrace).closestIdx;
        return idxA - idxB;
      });

    const finalizedTraps: GeoParsedTrap[] = [];

    if (starts.length > 0) {
      finalizedTraps.push(...starts);
    } else if (baseTrace.length >= 2) {
      const first = baseTrace[0];
      finalizedTraps.push({
        id: `trap_kml_start_${idx + 1}_${now}`,
        name: 'Largada (L)',
        kind: 'start',
        lat: first.lat,
        lon: first.lon,
        bearingDeg: computeEndpointBearing(baseTrace, true),
        widthM: 40,
        unidirectional: true,
      });
    }

    finalizedTraps.push(...splits);

    if (finishes.length > 0) {
      finalizedTraps.push(...finishes);
    } else if (baseTrace.length >= 2 && !starts.some((t) => t.kind === 'start_finish')) {
      const last = baseTrace[baseTrace.length - 1];
      finalizedTraps.push({
        id: `trap_kml_finish_${idx + 1}_${now}`,
        name: 'Chegada (C)',
        kind: 'finish',
        lat: last.lat,
        lon: last.lon,
        bearingDeg: computeEndpointBearing(baseTrace, false),
        widthM: 40,
        unidirectional: true,
      });
    }

    const totalDistKm = baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0;

    return {
      id: `trk_kml_${idx + 1}_${now}`,
      name: line.name,
      description: line.description,
      color: line.color,
      waypoints: waypoints.length > 0 ? waypoints : undefined,
      mode: finalizedTraps.some((t) => t.kind === 'start_finish') ? 'circuit' : 'point-to-point',
      traps: finalizedTraps,
      createdAtMs: now + idx,
      referenceDistanceKm: totalDistKm,
      baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
    };
  });

  if (tracks.length === 0 && waypoints.length === 0) {
    throw new Error('KML sem coordenadas válidas de rota ou pontos.');
  }

  return {
    documentName,
    tracks,
    waypoints,
  };
}

/**
 * Interpreta GPX (múltiplos `<trk>` / `<rte>` independentes + `<wpt>`) ou GeoJSON (FeatureCollection multi-LineString + Points)
 */
export function parseGpxOrGeoJsonToGeoResult(
  content: string,
  fileName: string
): ParsedGeoImportResult {
  const cleanName = fileName.replace(/\.(geojson|json|gpx)$/i, '');
  const now = Date.now();

  if (content.trim().startsWith('{')) {
    const parsed = JSON.parse(content) as {
      name?: string;
      features?: Array<{
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown };
      }>;
    };
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    const tracks: GeoParsedTrack[] = [];
    const pointFeatures: Array<{
      name: string;
      description?: string;
      lat: number;
      lon: number;
      kind?: GeoTrapKind;
      bearingDeg?: number;
      widthM?: number;
      unidirectional?: boolean;
      color?: string;
      id?: string;
    }> = [];

    for (const f of features) {
      const g = f.geometry;
      const props = f.properties || {};
      const featName = String(props.name || '').trim();
      const featDesc = sanitizeDescription(
        typeof props.description === 'string' ? props.description : undefined
      );
      const featColor =
        typeof props.color === 'string'
          ? props.color
          : typeof props.stroke === 'string'
            ? props.stroke
            : undefined;

      const pushLineCoords = (coordList: unknown[], suffix = '') => {
        const coords: Array<{ lat: number; lon: number; alt: number | null }> = [];
        coordList.forEach((coord) => {
          if (!Array.isArray(coord) || coord.length < 2) return;
          const lon = Number(coord[0]);
          const lat = Number(coord[1]);
          const alt = coord.length > 2 && Number.isFinite(Number(coord[2])) ? Number(coord[2]) : null;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          coords.push({ lat, lon, alt });
        });
        if (coords.length < 2) return;
        const trace = buildTraceFromCoords(coords, now + tracks.length * 10000);
        const idx = tracks.length;
        tracks.push({
          id: `trk_json_${idx + 1}_${now}`,
          name: (featName || `${cleanName}${tracks.length > 0 ? ` ${idx + 1}` : ''}`) + suffix,
          description: extractTrackKmOnlyDescription(featDesc),
          color: featColor || DEFAULT_TRACK_PALETTE[idx % DEFAULT_TRACK_PALETTE.length],
          mode: 'point-to-point',
          traps: [],
          createdAtMs: now + idx,
          referenceDistanceKm: trace[trace.length - 1]?.distKm ?? 0,
          baseTrace: trace,
        });
      };

      if (g?.type === 'LineString' && Array.isArray(g.coordinates)) {
        pushLineCoords(g.coordinates);
      } else if (g?.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
        g.coordinates.forEach((sub, sIdx) => {
          if (Array.isArray(sub)) {
            pushLineCoords(
              sub,
              (g.coordinates as unknown[]).length > 1 ? ` (${sIdx + 1})` : ''
            );
          }
        });
      } else if (g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
        const lon = Number(g.coordinates[0]);
        const lat = Number(g.coordinates[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const rawKind = String(props.trapKind || props.kind || '');
        const explicitFromProp: GeoTrapKind | undefined =
          rawKind === 'start' || rawKind === 'finish' || rawKind === 'start_finish' || rawKind === 'split'
            ? rawKind
            : undefined;
        pointFeatures.push({
          id: props.id ? String(props.id) : undefined,
          name: featName || `Ponto ${pointFeatures.length + 1}`,
          description: featDesc,
          lat,
          lon,
          kind: explicitFromProp,
          bearingDeg: Number.isFinite(Number(props.bearingDeg)) ? Number(props.bearingDeg) : undefined,
          widthM: Number.isFinite(Number(props.widthM)) ? Number(props.widthM) : undefined,
          unidirectional: props.unidirectional !== false,
          color: featColor,
        });
      }
    }

    const waypoints: GeoWaypoint[] = [];
    pointFeatures.forEach((pt, idx) => {
      const { explicitKind, isPoiKeyword } = classifyPointKind(pt.name);
      const resolvedKind = pt.kind ?? explicitKind;

      if (isPoiKeyword || tracks.length === 0) {
        waypoints.push({
          id: pt.id || `wpt_json_${idx + 1}_${now}`,
          name: pt.name,
          description: pt.description,
          lat: pt.lat,
          lon: pt.lon,
          color: pt.color || '#F59E0B',
        });
        return;
      }

      let bestTrack = tracks[0];
      let bestDist = Infinity;
      for (const trk of tracks) {
        if (!trk.baseTrace) continue;
        const d = minDistanceToTraceM(pt.lat, pt.lon, trk.baseTrace).distM;
        if (d < bestDist) {
          bestDist = d;
          bestTrack = trk;
        }
      }

      if (resolvedKind || bestDist <= 300) {
        const kind = resolvedKind ?? 'split';
        bestTrack.traps.push({
          id: pt.id || `trap_json_${idx + 1}_${now}`,
          name: pt.name,
          kind,
          lat: pt.lat,
          lon: pt.lon,
          bearingDeg:
            pt.bearingDeg ??
            (bestTrack.baseTrace
              ? inferBearingNearTrace(pt.lat, pt.lon, bestTrack.baseTrace, 0)
              : 0),
          widthM: pt.widthM ?? 40,
          unidirectional: pt.unidirectional !== false,
        });
      } else {
        waypoints.push({
          id: pt.id || `wpt_json_${idx + 1}_${now}`,
          name: pt.name,
          description: pt.description,
          lat: pt.lat,
          lon: pt.lon,
          color: pt.color || '#F59E0B',
        });
      }
    });

    // Ensure auto L/C traps on GeoJSON tracks
    tracks.forEach((trk, idx) => {
      if (waypoints.length > 0) trk.waypoints = waypoints;
      if (trk.traps.some((t) => t.kind === 'start_finish')) {
        trk.mode = 'circuit';
      }
      if (trk.baseTrace && trk.baseTrace.length >= 2) {
        if (!trk.traps.some((t) => t.kind === 'start' || t.kind === 'start_finish')) {
          const first = trk.baseTrace[0];
          trk.traps.unshift({
            id: `trap_json_start_${idx + 1}_${now}`,
            name: 'Largada (L)',
            kind: 'start',
            lat: first.lat,
            lon: first.lon,
            bearingDeg: computeEndpointBearing(trk.baseTrace, true),
            widthM: 40,
            unidirectional: true,
          });
        }
        if (
          !trk.traps.some((t) => t.kind === 'finish' || t.kind === 'start_finish')
        ) {
          const last = trk.baseTrace[trk.baseTrace.length - 1];
          trk.traps.push({
            id: `trap_json_finish_${idx + 1}_${now}`,
            name: 'Chegada (C)',
            kind: 'finish',
            lat: last.lat,
            lon: last.lon,
            bearingDeg: computeEndpointBearing(trk.baseTrace, false),
            widthM: 40,
            unidirectional: true,
          });
        }
      }
    });

    return {
      documentName: String(parsed.name || cleanName),
      tracks,
      waypoints,
    };
  }

  // GPX XML parse via DOMParser — keeping each <trk> / <rte> independent
  const sanitizedGpx = content
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  const doc = new DOMParser().parseFromString(sanitizedGpx, 'application/xml');
  const gpxMetaName =
    doc.querySelector('gpx > metadata > name')?.textContent?.trim() || cleanName;

  const tracks: GeoParsedTrack[] = [];

  const extractGpxColor = (container: Element): string | undefined => {
    const colorText =
      container.getElementsByTagName('color')[0]?.textContent?.trim() ||
      container.getElementsByTagNameNS('*', 'DisplayColor')[0]?.textContent?.trim() ||
      '';
    if (!colorText) return undefined;
    const lower = colorText.toLowerCase();
    if (GARMIN_COLOR_MAP[lower]) return GARMIN_COLOR_MAP[lower];
    if (/^#?[0-9a-f]{6}$/i.test(colorText)) {
      return colorText.startsWith('#') ? colorText.toUpperCase() : `#${colorText.toUpperCase()}`;
    }
    return undefined;
  };

  const trkEls = Array.from(doc.querySelectorAll('trk'));
  trkEls.forEach((trkEl, trkIdx) => {
    const trkName =
      getDirectChildText(trkEl, 'name') ||
      (trkEls.length > 1 ? `${cleanName} ${trkIdx + 1}` : cleanName);
    const trkDesc = extractTrackKmOnlyDescription(
      getDirectChildText(trkEl, 'desc') || getDirectChildText(trkEl, 'cmt')
    );
    const trkColor =
      extractGpxColor(trkEl) ||
      DEFAULT_TRACK_PALETTE[tracks.length % DEFAULT_TRACK_PALETTE.length];

    const segEls = getDirectChildren(trkEl, 'trkseg');
    const segments = segEls.length > 0 ? segEls : [trkEl];

    segments.forEach((segEl, segIdx) => {
      const ptEls = Array.from(segEl.querySelectorAll('trkpt'));
      const coords: Array<{ lat: number; lon: number; alt: number | null }> = [];
      ptEls.forEach((pt) => {
        const lat = Number(pt.getAttribute('lat'));
        const lon = Number(pt.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const eleText = pt.querySelector('ele')?.textContent;
        const ele = eleText !== null && eleText !== undefined && eleText !== '' ? Number(eleText) : null;
        coords.push({
          lat,
          lon,
          alt: ele !== null && Number.isFinite(ele) ? ele : null,
        });
      });
      if (coords.length < 2) return;
      const trace = buildTraceFromCoords(coords, now + tracks.length * 10000);
      const segName = segments.length > 1 ? `${trkName} (${segIdx + 1})` : trkName;
      tracks.push({
        id: `trk_gpx_${tracks.length + 1}_${now}`,
        name: segName,
        description: trkDesc,
        color: trkColor,
        mode: 'point-to-point',
        traps: [],
        createdAtMs: now + tracks.length,
        referenceDistanceKm: trace[trace.length - 1]?.distKm ?? 0,
        baseTrace: trace,
      });
    });
  });

  // Also parse <rte> / <rtept> if no <trk> segments existed (or in addition)
  const rteEls = Array.from(doc.querySelectorAll('rte'));
  rteEls.forEach((rteEl, rteIdx) => {
    const rteName =
      getDirectChildText(rteEl, 'name') || `${cleanName} Rota ${rteIdx + 1}`;
    const rteDesc = extractTrackKmOnlyDescription(
      getDirectChildText(rteEl, 'desc') || getDirectChildText(rteEl, 'cmt')
    );
    const rteColor =
      extractGpxColor(rteEl) ||
      DEFAULT_TRACK_PALETTE[tracks.length % DEFAULT_TRACK_PALETTE.length];
    const coords: Array<{ lat: number; lon: number; alt: number | null }> = [];
    Array.from(rteEl.querySelectorAll('rtept')).forEach((pt) => {
      const lat = Number(pt.getAttribute('lat'));
      const lon = Number(pt.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const eleText = pt.querySelector('ele')?.textContent;
      const ele = eleText !== null && eleText !== undefined && eleText !== '' ? Number(eleText) : null;
      coords.push({
        lat,
        lon,
        alt: ele !== null && Number.isFinite(ele) ? ele : null,
      });
    });
    if (coords.length < 2) return;
    const trace = buildTraceFromCoords(coords, now + tracks.length * 10000);
    tracks.push({
      id: `trk_gpx_rte_${tracks.length + 1}_${now}`,
      name: rteName,
      description: rteDesc,
      color: rteColor,
      mode: 'point-to-point',
      traps: [],
      createdAtMs: now + tracks.length,
      referenceDistanceKm: trace[trace.length - 1]?.distKm ?? 0,
      baseTrace: trace,
    });
  });

  // Parse <wpt> elements -> attach traps to nearest track OR keep as Waypoint POI
  const waypoints: GeoWaypoint[] = [];
  const wpts = Array.from(doc.querySelectorAll('wpt'));
  wpts.forEach((wpt, idx) => {
    const lat = Number(wpt.getAttribute('lat'));
    const lon = Number(wpt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const name = wpt.querySelector('name')?.textContent?.trim() || `Ponto ${idx + 1}`;
    const desc = sanitizeDescription(
      wpt.querySelector('desc')?.textContent || wpt.querySelector('cmt')?.textContent
    );
    const typeParts = (wpt.querySelector('type')?.textContent || '').split('|');
    const rawKind = typeParts[0];
    const explicitTypeKind: GeoTrapKind | null =
      rawKind === 'start' || rawKind === 'finish' || rawKind === 'start_finish' || rawKind === 'split'
        ? rawKind
        : null;

    const { explicitKind, isPoiKeyword } = classifyPointKind(name);
    const kindFromNameOrType = explicitTypeKind ?? explicitKind;

    if (isPoiKeyword || tracks.length === 0) {
      waypoints.push({
        id: `wpt_gpx_${idx + 1}_${now}`,
        name,
        description: desc,
        lat,
        lon,
        color: '#F59E0B',
      });
      return;
    }

    let bestTrack = tracks[0];
    let bestDist = Infinity;
    for (const trk of tracks) {
      if (!trk.baseTrace) continue;
      const d = minDistanceToTraceM(lat, lon, trk.baseTrace).distM;
      if (d < bestDist) {
        bestDist = d;
        bestTrack = trk;
      }
    }

    if (kindFromNameOrType || bestDist <= 300) {
      bestTrack.traps.push({
        id: `trap_gpx_${idx + 1}_${now}`,
        name,
        kind: kindFromNameOrType ?? 'split',
        lat,
        lon,
        bearingDeg:
          Number(typeParts[1]) ||
          (bestTrack.baseTrace
            ? inferBearingNearTrace(lat, lon, bestTrack.baseTrace, 0)
            : 0),
        widthM: Number(typeParts[2]) || 40,
        unidirectional: typeParts[3] !== '0',
      });
    } else {
      waypoints.push({
        id: `wpt_gpx_${idx + 1}_${now}`,
        name,
        description: desc,
        lat,
        lon,
        color: '#F59E0B',
      });
    }
  });

  // Auto-add Start / Finish traps if missing on GPX tracks
  tracks.forEach((trk, idx) => {
    if (waypoints.length > 0) trk.waypoints = waypoints;
    if (trk.traps.some((t) => t.kind === 'start_finish')) {
      trk.mode = 'circuit';
    }
    if (trk.baseTrace && trk.baseTrace.length >= 2) {
      if (!trk.traps.some((t) => t.kind === 'start' || t.kind === 'start_finish')) {
        const first = trk.baseTrace[0];
        trk.traps.unshift({
          id: `trap_gpx_start_${idx + 1}_${now}`,
          name: 'Largada (L)',
          kind: 'start',
          lat: first.lat,
          lon: first.lon,
          bearingDeg: computeEndpointBearing(trk.baseTrace, true),
          widthM: 40,
          unidirectional: true,
        });
      }
      if (!trk.traps.some((t) => t.kind === 'finish' || t.kind === 'start_finish')) {
        const last = trk.baseTrace[trk.baseTrace.length - 1];
        trk.traps.push({
          id: `trap_gpx_finish_${idx + 1}_${now}`,
          name: 'Chegada (C)',
          kind: 'finish',
          lat: last.lat,
          lon: last.lon,
          bearingDeg: computeEndpointBearing(trk.baseTrace, false),
          widthM: 40,
          unidirectional: true,
        });
      }
    }
  });

  if (tracks.length === 0 && waypoints.length === 0) {
    throw new Error('Arquivo GPX/GeoJSON sem coordenadas válidas de trilha ou pontos.');
  }

  return {
    documentName: gpxMetaName,
    tracks,
    waypoints,
  };
}

/**
 * Unifica leitura multi-especial para .KML, .KMZ, .GPX e .GeoJSON/.JSON
 */
export async function parseTrackFileToGeoResult(
  file: File
): Promise<ParsedGeoImportResult> {
  const MAX_TRACK_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_KMZ_ENTRIES = 500;
  const MAX_KML_XML_BYTES = 25 * 1024 * 1024;

  if (file.size > MAX_TRACK_FILE_BYTES) {
    throw new Error('Arquivo de pista excede o limite máximo de 50 MB.');
  }

  const lowerName = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const looksLikeZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (lowerName.endsWith('.kmz') || looksLikeZip) {
    const zip = await JSZip.loadAsync(buf);
    const allNames = Object.keys(zip.files);
    if (allNames.length > MAX_KMZ_ENTRIES) {
      throw new Error('Arquivo .KMZ excede o limite de entradas internas permitidas.');
    }
    const kmlEntries = allNames.filter(
      (k) => !zip.files[k].dir && k.toLowerCase().endsWith('.kml')
    );
    if (kmlEntries.length === 0) {
      throw new Error('Arquivo .KMZ não contém arquivo .KML interno.');
    }
    const preferred =
      kmlEntries.find((k) => k.toLowerCase().endsWith('doc.kml')) ?? kmlEntries[0];
    const rawKmlBytes = await zip.files[preferred].async('uint8array');
    if (rawKmlBytes.byteLength > MAX_KML_XML_BYTES) {
      throw new Error('Conteúdo KML descompactado excede o limite seguro (25 MB).');
    }
    const kmlText = new TextDecoder('utf-8').decode(rawKmlBytes);
    return parseKmlToGeoResult(kmlText, file.name);
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  if (lowerName.endsWith('.kml') || /<kml[\s>]/i.test(text)) {
    return parseKmlToGeoResult(text, file.name);
  }

  return parseGpxOrGeoJsonToGeoResult(text, file.name);
}

export function formatImportedTrackNamesList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}
