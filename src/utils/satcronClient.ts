import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface SatcronCategory {
  cat: string;
  desc: string;
}

export interface SatcronModality {
  id: string;
  name: string;
  apiArgs: string;
  staticJSONFile?: string;
  stageIds: string[];
  categories: SatcronCategory[];
}

export interface SatcronStandingRow {
  pos: string;
  carNo: string;
  crew: string;
  category: string;
  stageTime: string;
  totalTime: string;
  diffLeader: string;
}

export interface SatcronParsedTable {
  headers: string[];
  rows: string[][];
}

export interface SatcronStagesResponse {
  ok: boolean;
  error?: string;
  sourceUrl?: string;
  race?: string;
  mod?: string;
  ss?: string;
  eventTitle?: string;
  subtitle?: string;
  stageTitle?: string;
  liveStatusMessage?: string;
  modalities?: SatcronModality[];
  categories?: SatcronCategory[];
  stageIds?: string[];
  tables?: SatcronParsedTable[];
  standings?: SatcronStandingRow[];
  fetchedAtMs?: number;
}

export const DEFAULT_SATCRON_URL = 'https://satcron.com/stages/?race=novaitalia26&mod=1&ss=G';
const SATCRON_ALLOWED_HOSTS = new Set(['satcron.com', 'www.satcron.com']);

function sanitizeSatcronText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveSafeSatcronUrl(
  rawUrl?: string,
  mod?: string,
  ss?: string
): URL | null {
  let parsed: URL;
  try {
    const candidate = (rawUrl || '').trim();
    if (!candidate) {
      parsed = new URL(DEFAULT_SATCRON_URL);
    } else {
      parsed = new URL(candidate.startsWith('http') ? candidate : `https://${candidate}`);
    }
  } catch {
    return null;
  }

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!SATCRON_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  if (mod && /^[a-zA-Z0-9_-]{1,12}$/.test(mod.trim())) {
    parsed.searchParams.set('mod', mod.trim());
  }
  if (ss && /^[a-zA-Z0-9_-]{1,12}$/.test(ss.trim())) {
    parsed.searchParams.set('ss', ss.trim());
  }
  return parsed;
}

function extractBalancedJson(source: string, keyMarker: string): Record<string, unknown> | null {
  const idx = source.indexOf(keyMarker);
  if (idx === -1) return null;
  const braceStart = source.indexOf('{', idx + keyMarker.length);
  if (braceStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < source.length && i < braceStart + 65000; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const snippet = source.slice(braceStart, i + 1);
            return JSON.parse(snippet) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function extractRowsCollection(payload: unknown, ss: string): Array<Record<string, unknown>> {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
  }
  if (typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;

  for (const key of ['data', 'rows', 'crews', 'racetimes', 'stagetimes', 'standings', 'results']) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
    }
    if (candidate && typeof candidate === 'object') {
      const mapObj = candidate as Record<string, unknown>;
      // Handle stage-keyed map like { "1": [...], "2": [...] }
      if (ss && ss !== 'G' && Array.isArray(mapObj[ss])) {
        return (mapObj[ss] as unknown[]).filter(
          (x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')
        );
      }
      const values = Object.entries(mapObj)
        .filter(([, v]) => Boolean(v && typeof v === 'object' && !Array.isArray(v)))
        .map(([k, v]) => ({ car: k, ...(v as Record<string, unknown>) }));
      if (values.length > 0) return values;
    }
  }

  // Fallback for direct object-keyed map { "101": { driver: ..., time: ... } }
  const directEntries = Object.entries(obj).filter(
    ([k, v]) => k !== 'status' && k !== 'message' && Boolean(v && typeof v === 'object' && !Array.isArray(v))
  );
  if (directEntries.length > 0) {
    return directEntries.map(([k, v]) => ({ car: k, ...(v as Record<string, unknown>) }));
  }

  return [];
}

function formatSatcronStatusMessage(rawMsg: string): string {
  const clean = rawMsg.trim();
  if (!clean) return '';
  if (/live data disabled/i.test(clean)) {
    return 'Prova sem tempos ativos no momento ou encerrada (Live data disabled for this race).';
  }
  return clean;
}

async function httpGetTextDirect(url: string, accept = 'text/html,application/json'): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 PitStopSports/1.0',
          Accept: accept,
        },
        connectTimeout: 8000,
        readTimeout: 8000,
      });
      if (res.status < 200 || res.status >= 300) return null;
      if (typeof res.data === 'string') return res.data;
      if (res.data && typeof res.data === 'object') return JSON.stringify(res.data);
      return null;
    } catch {
      return null;
    }
  }

  // Web CORS proxy fallback list when backend /api/satcron/stages is not available
  const proxyCandidates = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];
  for (const proxyUrl of proxyCandidates) {
    try {
      const resp = await fetch(proxyUrl, {
        headers: { Accept: accept },
        signal: AbortSignal.timeout(8500),
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text && text.length > 2) return text;
    } catch {
      // Try next proxy
    }
  }
  return null;
}

async function httpGetJsonDirect(url: string): Promise<Record<string, unknown> | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 PitStopSports/1.0',
          Accept: 'application/json',
        },
        connectTimeout: 6500,
        readTimeout: 6500,
      });
      if (res.status < 200 || res.status >= 300) return null;
      if (typeof res.data === 'string') {
        return JSON.parse(res.data) as Record<string, unknown>;
      }
      if (res.data && typeof res.data === 'object') {
        return res.data as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  const text = await httpGetTextDirect(url, 'application/json');
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseSatcronHtmlAndPayloads(params: {
  html: string;
  targetUrl: URL;
  crewsData: Record<string, unknown> | null;
  raceTimesData: Record<string, unknown> | null;
  stageTimesData: Record<string, unknown> | null;
  staticJsonData?: Record<string, unknown> | null;
}): SatcronStagesResponse {
  const { html, targetUrl, crewsData, raceTimesData, stageTimesData, staticJsonData } = params;
  const race = targetUrl.searchParams.get('race') || 'novaitalia26';
  const mod = targetUrl.searchParams.get('mod') || '1';
  const ss = targetUrl.searchParams.get('ss') || 'G';

  const pageTitleMatch = html.match(/id=["']PageTitle["'][^>]*>([\s\S]*?)<\/div>/i);
  const raceTitleMatch = html.match(/raceTitle\s*:\s*['"]([^'"]+)['"]/i);
  const htmlTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const eventTitle = sanitizeSatcronText(
    pageTitleMatch?.[1] || raceTitleMatch?.[1] || htmlTitleMatch?.[1] || `Satcron (${race})`
  ).replace(/\s*-\s*ChronoStages$/i, '');

  const bodyStripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const subtitleMatch = html.match(
    /(?:id=["']race-subtitle["']|class=["'][^"']*bfw-subtitle[^"']*["'])[^>]*>([\s\S]*?)<\/div>/i
  );
  const stageHeaderMatch = html.match(/class=["'][^"']*CS-stage-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const stageRegexMatch = sanitizeSatcronText(bodyStripped).match(
    /(SS\d+[^.]{0,90}\(\d+(?:\.\d+)?\s*km\))/i
  );

  const subtitle = subtitleMatch ? sanitizeSatcronText(subtitleMatch[1]) : '';
  const stageTitle = stageHeaderMatch
    ? sanitizeSatcronText(stageHeaderMatch[1])
    : stageRegexMatch?.[1] ||
      (ss === 'G' ? 'Classificação Geral (Acumulado)' : `Especial SS${ss}`);

  const modernConfig = extractBalancedJson(html, 'modernApiConfig:');
  const rawModalidades =
    modernConfig && typeof modernConfig.modalidades === 'object' && modernConfig.modalidades
      ? (modernConfig.modalidades as Record<string, Record<string, unknown>>)
      : {};

  const modalities: SatcronModality[] = Object.entries(rawModalidades).map(([id, cfg]) => {
    const rawCats = Array.isArray(cfg.cats) ? (cfg.cats as Array<Record<string, unknown>>) : [];
    const splitDists =
      cfg.splitDists && typeof cfg.splitDists === 'object'
        ? Object.keys(cfg.splitDists as Record<string, unknown>)
        : [];
    return {
      id,
      name: typeof cfg.name === 'string' ? cfg.name : `Mod ${id}`,
      apiArgs: typeof cfg.apiArgs === 'string' ? cfg.apiArgs : '',
      staticJSONFile: typeof cfg.staticJSONFile === 'string' ? cfg.staticJSONFile : '',
      stageIds: splitDists,
      categories: rawCats.map((c) => ({
        cat: String(c.cat || ''),
        desc: String(c.cat_desc || c.cat || ''),
      })),
    };
  });

  const activeMod = modalities.find((m) => m.id === mod) || modalities[0] || null;

  const tables: SatcronParsedTable[] = [];
  for (const tm of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const headers: string[] = [];
    const rows: string[][] = [];
    for (const tr of tm[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const thCells = [...tr[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
        sanitizeSatcronText(m[1])
      );
      const tdCells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        sanitizeSatcronText(m[1])
      );
      if (thCells.length > 0 && headers.length === 0) {
        headers.push(...thCells);
      } else if (tdCells.length > 0) {
        rows.push(tdCells);
      }
    }
    if (rows.length > 0 || headers.length > 0) {
      tables.push({ headers, rows });
    }
  }

  let liveStatusMessage = '';
  const errorPayload = [crewsData, raceTimesData, stageTimesData].find(
    (d) => d && d.status === 'error' && typeof d.message === 'string'
  );
  if (errorPayload && typeof errorPayload.message === 'string') {
    liveStatusMessage = formatSatcronStatusMessage(errorPayload.message);
  }

  const crewsMap = new Map<string, { crew: string; category: string }>();
  const rawCrewList = extractRowsCollection(crewsData ?? staticJsonData, ss);
  for (const item of rawCrewList) {
    const carNo = String(item.car ?? item.carNo ?? item.num ?? item.id ?? '');
    if (!carNo) continue;
    const driver = String(item.driver ?? item.piloto ?? item.crew ?? item.nome ?? '');
    const codriver = String(item.codriver ?? item.navegador ?? '');
    const crewName = codriver ? `${driver} / ${codriver}` : driver || `Carro #${carNo}`;
    const cat = String(item.cat ?? item.category ?? '');
    crewsMap.set(carNo, { crew: crewName, category: cat });
  }

  const timeSource =
    (ss === 'G' ? raceTimesData : stageTimesData || raceTimesData) ?? staticJsonData;
  const rawTimeRows = extractRowsCollection(timeSource, ss);
  const standings: SatcronStandingRow[] = [];
  for (let i = 0; i < rawTimeRows.length; i += 1) {
    const row = rawTimeRows[i];
    const carNo = String(row.car ?? row.carNo ?? row.num ?? '');
    const crewInfo = crewsMap.get(carNo);
    const stageT = String(row.stagetime ?? row.ss_time ?? row.ss ?? row.time ?? '-');
    const totalT = String(row.total ?? row.racetime ?? row.accumulated ?? row.time ?? '-');
    if (stageT === '-' && totalT === '-' && !row.crew && !crewInfo) continue;
    standings.push({
      pos: String(row.pos ?? row.rank ?? i + 1),
      carNo: carNo || '-',
      crew: String(row.crew ?? crewInfo?.crew ?? `Carro #${carNo || i + 1}`),
      category: String(row.cat ?? row.category ?? crewInfo?.category ?? '-'),
      stageTime: stageT,
      totalTime: totalT,
      diffLeader: String(row.diff ?? row.diff_first ?? row.gap ?? '-'),
    });
  }

  if (standings.length === 0 && !liveStatusMessage) {
    liveStatusMessage = 'Prova sem tempos publicados para esta etapa no momento.';
  }

  return {
    ok: true,
    sourceUrl: targetUrl.toString(),
    race,
    mod,
    ss,
    eventTitle,
    subtitle,
    stageTitle,
    liveStatusMessage,
    modalities,
    categories: activeMod?.categories || [],
    stageIds: activeMod?.stageIds || [],
    tables,
    standings,
    fetchedAtMs: Date.now(),
  };
}

export async function fetchSatcronStagesClient(
  targetUrlInput: string,
  modOverride?: string,
  ssOverride?: string
): Promise<SatcronStagesResponse> {
  const safeUrl = resolveSafeSatcronUrl(targetUrlInput, modOverride, ssOverride);
  if (!safeUrl) {
    return {
      ok: false,
      error: 'Link inválido. Informe uma URL oficial do satcron.com.',
    };
  }

  // On Web (browser), try Express server proxy first when available
  if (!Capacitor.isNativePlatform()) {
    try {
      const params = new URLSearchParams();
      params.set('url', safeUrl.toString());
      if (modOverride) params.set('mod', modOverride);
      if (ssOverride) params.set('ss', ssOverride);
      const resp = await fetch(`/api/satcron/stages?${params.toString()}`, {
        signal: AbortSignal.timeout(9500),
      });
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const payload = (await resp.json()) as SatcronStagesResponse;
        if (resp.ok && payload.ok) {
          return payload;
        }
      }
    } catch {
      // Fallback below to direct/CORS-proxy fetch
    }
  }

  // Direct Native CapacitorHttp or Web CORS Proxy fetch
  const html = await httpGetTextDirect(safeUrl.toString(), 'text/html,application/xhtml+xml');
  if (!html) {
    return {
      ok: false,
      error: 'Não foi possível conectar ao Satcron. Verifique o link da prova e sua internet.',
    };
  }

  const modernConfig = extractBalancedJson(html, 'modernApiConfig:');
  const rawModalidades =
    modernConfig && typeof modernConfig.modalidades === 'object' && modernConfig.modalidades
      ? (modernConfig.modalidades as Record<string, Record<string, unknown>>)
      : {};
  const mod = safeUrl.searchParams.get('mod') || '1';
  const race = safeUrl.searchParams.get('race') || 'novaitalia26';
  const modCfg = rawModalidades[mod] ?? Object.values(rawModalidades)[0] ?? null;
  const safeApiArgs =
    modCfg && typeof modCfg.apiArgs === 'string'
      ? modCfg.apiArgs.replace(/[^a-zA-Z0-9=&_-]/g, '')
      : 'db=9';
  const staticJSONFile =
    modCfg && typeof modCfg.staticJSONFile === 'string' ? modCfg.staticJSONFile.trim() : '';

  const buildApiUrl = (endpoint: string) => {
    const ep = new URL('https://satcron.com/stages/api/cache_api.php');
    ep.searchParams.set('race', race);
    if (safeApiArgs) {
      for (const pair of safeApiArgs.split('&')) {
        const [k, v] = pair.split('=');
        if (k && v) ep.searchParams.set(k, v);
      }
    }
    ep.searchParams.set('endpoint', endpoint);
    return ep.toString();
  };

  const staticUrl =
    staticJSONFile && !staticJSONFile.includes('..')
      ? `https://satcron.com/stages/${staticJSONFile.replace(/^\/+/, '')}`
      : null;

  const [crewsData, raceTimesData, stageTimesData, staticJsonData] = await Promise.all([
    httpGetJsonDirect(buildApiUrl('crews')),
    httpGetJsonDirect(buildApiUrl('racetimes')),
    httpGetJsonDirect(buildApiUrl('stagetimes')),
    staticUrl ? httpGetJsonDirect(staticUrl) : Promise.resolve(null),
  ]);

  return parseSatcronHtmlAndPayloads({
    html,
    targetUrl: safeUrl,
    crewsData,
    raceTimesData,
    stageTimesData,
    staticJsonData,
  });
}
