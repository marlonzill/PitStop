import {
  getOrCreateDeviceIdentitySync,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
} from './deviceLicenseService';
import {
  ensureAutoTrapsFromBaseTrace,
  haversineMetersVel,
  type VelocitySample,
  type VelocityTrack,
  type VelocityTrap,
} from '../utils/velocityEngine';
import { loadVelocityDatabase, persistVelocityTracks } from '../utils/velocityStorage';

export interface CloudTrackCoord {
  lat: number;
  lon: number;
  distKm?: number;
}

export interface PistaNuvemRecord {
  id?: string | number;
  nome: string;
  distancia: number;
  coordenadas: CloudTrackCoord[];
  parciais: VelocityTrap[];
  device_id: string;
  aprovada: boolean;
  criado_em: string;
  cidade_estado?: string;
  piso?: string;
  autor?: string;
  pasta_nome?: string;
}

export const PISTAS_NUVEM_SETUP_SQL = `-- Execute no SQL Editor do Supabase (PitStop Sports)
create table if not exists public.pistas_nuvem (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  distancia double precision not null default 0,
  coordenadas jsonb not null default '[]'::jsonb,
  parciais jsonb not null default '[]'::jsonb,
  device_id text not null default '',
  aprovada boolean not null default true,
  cidade_estado text,
  piso text,
  autor text,
  pasta_nome text,
  criado_em timestamptz not null default now()
);

alter table public.pistas_nuvem add column if not exists cidade_estado text;
alter table public.pistas_nuvem add column if not exists piso text;
alter table public.pistas_nuvem add column if not exists autor text;
alter table public.pistas_nuvem add column if not exists pasta_nome text;

alter table public.pistas_nuvem enable row level security;

drop policy if exists "pistas_nuvem_select_public" on public.pistas_nuvem;
create policy "pistas_nuvem_select_public"
  on public.pistas_nuvem for select to anon, authenticated using (true);

drop policy if exists "pistas_nuvem_insert_public" on public.pistas_nuvem;
create policy "pistas_nuvem_insert_public"
  on public.pistas_nuvem for insert to anon, authenticated with check (true);

drop policy if exists "pistas_nuvem_update_public" on public.pistas_nuvem;
create policy "pistas_nuvem_update_public"
  on public.pistas_nuvem for update to anon, authenticated using (true) with check (true);

drop policy if exists "pistas_nuvem_delete_public" on public.pistas_nuvem;
create policy "pistas_nuvem_delete_public"
  on public.pistas_nuvem for delete to anon, authenticated using (true);

notify pgrst, 'reload schema';`;

export class CloudTracksTableMissingError extends Error {
  readonly isMissingTable = true;

  constructor(
    message = 'A tabela public.pistas_nuvem ainda não existe no Supabase. Crie-a usando o SQL de configuração abaixo.'
  ) {
    super(message);
    this.name = 'CloudTracksTableMissingError';
  }
}

export function isMissingCloudTracksTableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof CloudTracksTableMissingError) return true;
  if (typeof err === 'object' && 'isMissingTable' in err && (err as { isMissingTable?: boolean }).isMissingTable) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('404') ||
    msg.includes('PGRST205') ||
    msg.includes('42P01') ||
    msg.toLowerCase().includes('pistas_nuvem') && msg.toLowerCase().includes('not found')
  );
}

async function isMissingTableResponse(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  try {
    const text = (await res.clone().text()).toLowerCase();
    return (
      text.includes('pgrst205') ||
      text.includes('42p01') ||
      text.includes('could not find the table') ||
      text.includes('relation "public.pistas_nuvem" does not exist')
    );
  } catch {
    return false;
  }
}

async function isSchemaColumnMismatchResponse(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  try {
    const text = (await res.clone().text()).toLowerCase();
    return (
      text.includes('pgrst204') ||
      text.includes('42703') ||
      text.includes('column') ||
      text.includes('schema cache')
    );
  } catch {
    return false;
  }
}

const FETCH_TIMEOUT_MS = 9000;
const MAX_CLOUD_COORDS = 200;

function getSupabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function isValidCoord(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return (parsed as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeCloudRow(raw: Record<string, unknown>): PistaNuvemRecord {
  const rawCoords = parseJsonField<unknown[]>(raw.coordenadas, []);
  const coordenadas: CloudTrackCoord[] = rawCoords
    .map((pt) => {
      if (!pt || typeof pt !== 'object') return null;
      const obj = pt as Record<string, unknown>;
      const lat = Number(obj.lat);
      const lon = Number(obj.lon);
      if (!isValidCoord(lat, lon)) return null;
      const distKm =
        typeof obj.distKm === 'number' && Number.isFinite(obj.distKm)
          ? Number(obj.distKm.toFixed(3))
          : undefined;
      return distKm !== undefined ? { lat, lon, distKm } : { lat, lon };
    })
    .filter((pt): pt is CloudTrackCoord => pt !== null);

  const rawTraps = parseJsonField<unknown[]>(raw.parciais, []);
  const parciais: VelocityTrap[] = rawTraps
    .map((tr, idx): VelocityTrap | null => {
      if (!tr || typeof tr !== 'object') return null;
      const obj = tr as Record<string, unknown>;
      const lat = Number(obj.lat);
      const lon = Number(obj.lon);
      if (!isValidCoord(lat, lon)) return null;
      const kind =
        obj.kind === 'start' ||
        obj.kind === 'split' ||
        obj.kind === 'finish' ||
        obj.kind === 'start_finish'
          ? obj.kind
          : 'split';
      return {
        id: typeof obj.id === 'string' && obj.id ? obj.id : `trap_${idx}_${Date.now()}`,
        name: typeof obj.name === 'string' && obj.name ? obj.name : `Marco ${idx + 1}`,
        kind,
        lat,
        lon,
        bearingDeg:
          typeof obj.bearingDeg === 'number' && Number.isFinite(obj.bearingDeg)
            ? obj.bearingDeg
            : 0,
        widthM:
          typeof obj.widthM === 'number' && Number.isFinite(obj.widthM) && obj.widthM > 0
            ? obj.widthM
            : 40,
        unidirectional: typeof obj.unidirectional === 'boolean' ? obj.unidirectional : true,
      };
    })
    .filter((tr): tr is VelocityTrap => tr !== null);

  const distanciaNum = Number(raw.distancia);
  const idVal =
    typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : undefined;

  return {
    id: idVal,
    nome:
      typeof raw.nome === 'string' && raw.nome.trim()
        ? raw.nome.trim().slice(0, 120)
        : 'Pista Sem Nome',
    distancia:
      Number.isFinite(distanciaNum) && distanciaNum >= 0
        ? Number(distanciaNum.toFixed(3))
        : 0,
    coordenadas,
    parciais,
    device_id: typeof raw.device_id === 'string' ? raw.device_id.trim() : '',
    aprovada: raw.aprovada !== false,
    criado_em:
      typeof raw.criado_em === 'string' && raw.criado_em
        ? raw.criado_em
        : new Date().toISOString(),
    cidade_estado: typeof raw.cidade_estado === 'string' && raw.cidade_estado.trim() ? raw.cidade_estado.trim() : undefined,
    piso: typeof raw.piso === 'string' && raw.piso.trim() ? raw.piso.trim() : undefined,
    autor: typeof raw.autor === 'string' && raw.autor.trim() ? raw.autor.trim() : undefined,
    pasta_nome: typeof raw.pasta_nome === 'string' && raw.pasta_nome.trim() ? raw.pasta_nome.trim() : undefined,
  };
}

function getOrderedTrackTraps(track: VelocityTrack): VelocityTrap[] {
  const rank = (kind: VelocityTrap['kind']) => {
    if (kind === 'start' || kind === 'start_finish') return 0;
    if (kind === 'split') return 1;
    return 2;
  };
  return [...track.traps].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function compressTrackCoords(track: VelocityTrack): CloudTrackCoord[] {
  const trace = track.baseTrace ?? [];
  const validTrace = trace.filter((p) => isValidCoord(p.lat, p.lon));

  if (validTrace.length >= 2) {
    if (validTrace.length <= MAX_CLOUD_COORDS) {
      return validTrace.map((p) => ({
        lat: Number(p.lat.toFixed(6)),
        lon: Number(p.lon.toFixed(6)),
        distKm: Number((p.distKm || 0).toFixed(3)),
      }));
    }
    const sampled: CloudTrackCoord[] = [];
    const lastIdx = validTrace.length - 1;
    for (let i = 0; i < MAX_CLOUD_COORDS; i += 1) {
      const idx = Math.round((i / (MAX_CLOUD_COORDS - 1)) * lastIdx);
      const p = validTrace[idx];
      sampled.push({
        lat: Number(p.lat.toFixed(6)),
        lon: Number(p.lon.toFixed(6)),
        distKm: Number((p.distKm || 0).toFixed(3)),
      });
    }
    return sampled;
  }

  const orderedTraps = getOrderedTrackTraps(track).filter((tr) =>
    isValidCoord(tr.lat, tr.lon)
  );
  if (orderedTraps.length >= 2) {
    let cumM = 0;
    return orderedTraps.map((tr, idx) => {
      if (idx > 0) {
        cumM += haversineMetersVel(
          orderedTraps[idx - 1].lat,
          orderedTraps[idx - 1].lon,
          tr.lat,
          tr.lon
        );
      }
      return {
        lat: Number(tr.lat.toFixed(6)),
        lon: Number(tr.lon.toFixed(6)),
        distKm: Number((cumM / 1000).toFixed(3)),
      };
    });
  }

  return [];
}

function computeTrackDistanceKm(
  track: VelocityTrack,
  coords: CloudTrackCoord[]
): number {
  if (
    typeof track.referenceDistanceKm === 'number' &&
    Number.isFinite(track.referenceDistanceKm) &&
    track.referenceDistanceKm > 0
  ) {
    return Number(track.referenceDistanceKm.toFixed(3));
  }
  if (coords.length >= 2) {
    const lastDist = coords[coords.length - 1].distKm;
    if (typeof lastDist === 'number' && lastDist > 0) {
      return Number(lastDist.toFixed(3));
    }
    let sumM = 0;
    for (let i = 1; i < coords.length; i += 1) {
      sumM += haversineMetersVel(
        coords[i - 1].lat,
        coords[i - 1].lon,
        coords[i].lat,
        coords[i].lon
      );
    }
    return Number((sumM / 1000).toFixed(3));
  }
  return 0;
}

function buildRowFilterQuery(row: Pick<PistaNuvemRecord, 'id' | 'device_id' | 'nome'>): string {
  if (row.id !== undefined && row.id !== null && String(row.id).trim() !== '') {
    return `id=eq.${encodeURIComponent(String(row.id))}`;
  }
  return `device_id=eq.${encodeURIComponent(row.device_id)}&nome=eq.${encodeURIComponent(row.nome)}`;
}

export interface UploadTrackMeta {
  title?: string;
  cidadeEstado?: string;
  piso?: string;
  autor?: string;
  pastaNome?: string;
  aprovada?: boolean;
}

export async function uploadTrackToCloudLibrary(
  track: VelocityTrack,
  meta: UploadTrackMeta = {}
): Promise<{ ok: boolean; missingTable?: boolean; error?: string }> {
  if (!track) return { ok: false, error: 'Selecione uma pista válida.' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'Sem conexão com a internet para enviar à nuvem.' };
  }

  const cleanName = (meta.title?.trim() || track.name || '').trim().slice(0, 120);
  if (!cleanName) return { ok: false, error: 'Informe um título para a pista.' };

  const coords = compressTrackCoords(track);
  const traps = track.traps.filter((tr) => isValidCoord(tr.lat, tr.lon));
  if (coords.length < 2 && traps.length < 2) {
    return {
      ok: false,
      error: 'A pista precisa de pelo menos 2 coordenadas ou 2 marcos (Largada/Chegada).',
    };
  }

  const distancia = computeTrackDistanceKm(track, coords);
  const deviceId = getOrCreateDeviceIdentitySync().deviceId;
  const approvedFlag = meta.aprovada ?? true;

  const baseBody = {
    nome: cleanName,
    distancia,
    coordenadas: coords,
    parciais: traps,
    device_id: deviceId,
    aprovada: approvedFlag,
    criado_em: new Date().toISOString(),
  };

  const extendedBody: Record<string, unknown> = {
    ...baseBody,
    ...(meta.cidadeEstado?.trim() ? { cidade_estado: meta.cidadeEstado.trim() } : {}),
    ...(meta.piso?.trim() ? { piso: meta.piso.trim() } : {}),
    ...(meta.autor?.trim() ? { autor: meta.autor.trim() } : {}),
    ...(meta.pastaNome?.trim() || track.folderName?.trim()
      ? { pasta_nome: (meta.pastaNome?.trim() || track.folderName?.trim()) ?? undefined }
      : {}),
  };

  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/pistas_nuvem?device_id=eq.${encodeURIComponent(
      deviceId
    )}&nome=eq.${encodeURIComponent(cleanName)}&select=id,aprovada&limit=1`;

    const checkRes = await fetchWithTimeout(checkUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: getSupabaseHeaders(),
    });

    if (!checkRes.ok) {
      if (await isMissingTableResponse(checkRes)) {
        return {
          ok: false,
          missingTable: true,
          error: 'Tabela pistas_nuvem não encontrada no Supabase.',
        };
      }
      return { ok: false, error: `Falha ao consultar nuvem (HTTP ${checkRes.status}).` };
    }

    const existing = (await checkRes.json()) as Array<{
      id?: string | number;
      aprovada?: boolean;
    }>;

    if (Array.isArray(existing) && existing.length > 0) {
      const existingRow = existing[0];
      const filter = buildRowFilterQuery({
        id: existingRow.id,
        device_id: deviceId,
        nome: cleanName,
      });
      const patchUrl = `${SUPABASE_URL}/rest/v1/pistas_nuvem?${filter}`;
      const extPatch = {
        distancia,
        coordenadas: coords,
        parciais: traps,
        ...(meta.cidadeEstado?.trim() ? { cidade_estado: meta.cidadeEstado.trim() } : {}),
        ...(meta.piso?.trim() ? { piso: meta.piso.trim() } : {}),
        ...(meta.autor?.trim() ? { autor: meta.autor.trim() } : {}),
        ...(meta.pastaNome?.trim() || track.folderName?.trim()
          ? { pasta_nome: (meta.pastaNome?.trim() || track.folderName?.trim()) ?? undefined }
          : {}),
      };

      let patchRes = await fetchWithTimeout(patchUrl, {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify(extPatch),
      });

      if (!patchRes.ok && (await isSchemaColumnMismatchResponse(patchRes))) {
        patchRes = await fetchWithTimeout(patchUrl, {
          method: 'PATCH',
          headers: getSupabaseHeaders(),
          body: JSON.stringify({
            distancia,
            coordenadas: coords,
            parciais: traps,
          }),
        });
      }

      if (!patchRes.ok) {
        if (await isMissingTableResponse(patchRes)) {
          return { ok: false, missingTable: true, error: 'Tabela pistas_nuvem não encontrada.' };
        }
        return { ok: false, error: `Erro ao atualizar pista (HTTP ${patchRes.status}).` };
      }
      return { ok: true };
    }

    let postRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/pistas_nuvem`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(extendedBody),
    });

    if (!postRes.ok && (await isSchemaColumnMismatchResponse(postRes))) {
      postRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/pistas_nuvem`, {
        method: 'POST',
        headers: getSupabaseHeaders(),
        body: JSON.stringify(baseBody),
      });
    }

    if (!postRes.ok) {
      if (await isMissingTableResponse(postRes)) {
        return { ok: false, missingTable: true, error: 'Tabela pistas_nuvem não encontrada.' };
      }
      return { ok: false, error: `Erro ao enviar pista (HTTP ${postRes.status}).` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha de conexão com a nuvem.',
    };
  }
}

/**
 * Envia automaticamente uma pista criada/editada/importada para `pistas_nuvem`
 * com deduplicação por `(device_id, nome)`. Nunca lança erro nem trava o fluxo offline.
 */
export async function uploadVelocityTrackToCloud(track: VelocityTrack): Promise<boolean> {
  if (!track || !track.name || track.id.startsWith('demo_')) return false;
  const res = await uploadTrackToCloudLibrary(track, {
    pastaNome: track.folderName,
  });
  return res.ok;
}

export async function uploadAllTracksToCloud(
  tracks: VelocityTrack[]
): Promise<{ uploaded: number }> {
  if (!Array.isArray(tracks) || tracks.length === 0) return { uploaded: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { uploaded: 0 };
  }

  let uploaded = 0;
  for (const track of tracks) {
    const ok = await uploadVelocityTrackToCloud(track);
    if (ok) uploaded += 1;
  }
  return { uploaded };
}

export async function fetchApprovedCloudTracks(): Promise<PistaNuvemRecord[]> {
  const url = `${SUPABASE_URL}/rest/v1/pistas_nuvem?aprovada=eq.true&order=criado_em.desc&select=*`;
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getSupabaseHeaders(),
  });
  if (!res.ok) {
    if (await isMissingTableResponse(res)) {
      throw new CloudTracksTableMissingError();
    }
    throw new Error(`Erro ao carregar biblioteca online (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeCloudRow);
}

export async function fetchAllCloudTracksAdmin(): Promise<PistaNuvemRecord[]> {
  const url = `${SUPABASE_URL}/rest/v1/pistas_nuvem?order=criado_em.desc&select=*`;
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getSupabaseHeaders(),
  });
  if (!res.ok) {
    if (await isMissingTableResponse(res)) {
      throw new CloudTracksTableMissingError();
    }
    throw new Error(`Erro ao listar pistas na nuvem (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeCloudRow);
}

export async function updateCloudTrackApproval(
  row: PistaNuvemRecord,
  aprovada: boolean
): Promise<PistaNuvemRecord> {
  const filter = buildRowFilterQuery(row);
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/pistas_nuvem?${filter}`,
    {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ aprovada }),
    }
  );
  if (!res.ok) {
    if (await isMissingTableResponse(res)) {
      throw new CloudTracksTableMissingError();
    }
    throw new Error(`Falha ao atualizar pista (HTTP ${res.status}).`);
  }
  const updatedRows = (await res.json()) as Array<Record<string, unknown>>;
  if (Array.isArray(updatedRows) && updatedRows[0]) {
    return normalizeCloudRow(updatedRows[0]);
  }
  return { ...row, aprovada };
}

export async function deleteCloudTrack(row: PistaNuvemRecord): Promise<void> {
  const filter = buildRowFilterQuery(row);
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/pistas_nuvem?${filter}`,
    {
      method: 'DELETE',
      headers: getSupabaseHeaders(),
    }
  );
  if (!res.ok) {
    if (await isMissingTableResponse(res)) {
      throw new CloudTracksTableMissingError();
    }
    throw new Error(`Falha ao excluir pista (HTTP ${res.status}).`);
  }
}

export function buildCloudTrackLocalId(row: PistaNuvemRecord): string {
  if (row.id !== undefined && row.id !== null && String(row.id).trim() !== '') {
    return `cloud_${String(row.id).trim()}`;
  }
  const slug = row.nome
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `cloud_${row.device_id || 'net'}_${slug || 'pista'}`;
}

export function isCloudTrackAlreadyDownloaded(
  row: PistaNuvemRecord,
  localTracks: VelocityTrack[]
): boolean {
  const targetId = buildCloudTrackLocalId(row);
  const normName = row.nome.trim().toLowerCase();
  return localTracks.some(
    (t) =>
      t.id === targetId ||
      (t.name.trim().toLowerCase() === normName &&
        Math.abs((t.referenceDistanceKm || 0) - (row.distancia || 0)) <= 0.15)
  );
}

export function convertCloudTrackToVelocityTrack(row: PistaNuvemRecord): VelocityTrack {
  const localId = buildCloudTrackLocalId(row);
  const baseTime = Date.parse(row.criado_em) || Date.now();
  let cumM = 0;

  const baseTrace: VelocitySample[] = row.coordenadas.map((pt, idx) => {
    if (idx > 0) {
      cumM += haversineMetersVel(
        row.coordenadas[idx - 1].lat,
        row.coordenadas[idx - 1].lon,
        pt.lat,
        pt.lon
      );
    }
    const distKm =
      typeof pt.distKm === 'number' && Number.isFinite(pt.distKm)
        ? pt.distKm
        : Number((cumM / 1000).toFixed(3));
    return {
      lat: pt.lat,
      lon: pt.lon,
      speedKmh: 0,
      accuracyM: 5,
      headingDeg: null,
      altitudeM: null,
      timestampMs: baseTime + idx * 1000,
      distKm,
      stageElapsedMs: idx * 1000,
    };
  });

  const hasCircuitGate = row.parciais.some((tr) => tr.kind === 'start_finish');
  const computedDist =
    row.distancia > 0
      ? row.distancia
      : baseTrace.length > 1
        ? Number(baseTrace[baseTrace.length - 1].distKm.toFixed(3))
        : 0;

  const folderSlug = row.pasta_nome
    ? `cloud_folder_${row.pasta_nome
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)}`
    : undefined;

  const baseTrack: VelocityTrack = {
    id: localId,
    name: row.nome,
    mode: hasCircuitGate ? 'circuit' : 'point-to-point',
    traps: row.parciais.map((tr) => ({ ...tr })),
    createdAtMs: baseTime,
    referenceDistanceKm: computedDist,
    baseTrace: baseTrace.length >= 2 ? baseTrace : undefined,
    ...(row.pasta_nome ? { folderName: row.pasta_nome, folderId: folderSlug } : {}),
  };

  return ensureAutoTrapsFromBaseTrace(baseTrack);
}

export async function importCloudTracksOffline(
  rows: PistaNuvemRecord[]
): Promise<{ added: number; skipped: number; totalLocal: number }> {
  const db = await loadVelocityDatabase();
  const current = [...db.tracks];
  let added = 0;
  let skipped = 0;
  const toPrepend: VelocityTrack[] = [];

  for (const row of rows) {
    if (isCloudTrackAlreadyDownloaded(row, [...toPrepend, ...current])) {
      skipped += 1;
      continue;
    }
    toPrepend.push(convertCloudTrackToVelocityTrack(row));
    added += 1;
  }

  if (added > 0) {
    const merged = [...toPrepend, ...current];
    await persistVelocityTracks(merged);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pitstop:velocity-db-updated'));
    }
    return { added, skipped, totalLocal: merged.length };
  }

  return { added: 0, skipped, totalLocal: current.length };
}
