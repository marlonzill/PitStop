import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

interface StoredSubmission {
  id: string;
  fileName: string;
  eventName: string;
  carNumber: string;
  crewName: string;
  raceDate: string;
  startTimeStr: string;
  detectionRadiusM: number;
  recordedAt: string;
  passages: unknown[];
  rawTxt?: string;
}

interface StoredStanding {
  slug: string;
  eventName: string;
  createdAt: string;
  missedPenaltyPts: number;
  rows: unknown[];
  txtReport: string;
  csvReport: string;
}

interface BaseDatabase {
  organizerPassHash?: string;
  submissions: StoredSubmission[];
  publishedStandings: StoredStanding[];
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const TXT_DIR = path.resolve(DATA_DIR, 'txts');
const DB_FILE = path.resolve(DATA_DIR, 'pitstop_base.json');

const ENV_ORGANIZER_PASSCODE = (process.env.ORGANIZER_PASSCODE || '').trim();
const SESSION_SECRET =
  (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(TXT_DIR)) {
    fs.mkdirSync(TXT_DIR, { recursive: true });
  }
}

function readDb(): BaseDatabase {
  ensureDataDirs();
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { submissions: [], publishedStandings: [] };
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BaseDatabase>;
    return {
      organizerPassHash:
        typeof parsed.organizerPassHash === 'string' && parsed.organizerPassHash.includes(':')
          ? parsed.organizerPassHash
          : undefined,
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
      publishedStandings: Array.isArray(parsed.publishedStandings)
        ? parsed.publishedStandings
        : [],
    };
  } catch {
    return { submissions: [], publishedStandings: [] };
  }
}

let dbWriteChain: Promise<void> = Promise.resolve();

function writeDbQueued(mutator: (db: BaseDatabase) => BaseDatabase | void): Promise<BaseDatabase> {
  const run = dbWriteChain.then(() => {
    const db = readDb();
    const result = mutator(db) || db;
    ensureDataDirs();
    const tmpFile = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
    return result;
  });
  dbWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function hashPasscodeScrypt(passcode: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasscodeScrypt(passcode: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = crypto.scryptSync(passcode, salt, expectedBuf.length);
    return (
      actualBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(actualBuf, expectedBuf)
    );
  } catch {
    return false;
  }
}

function verifyEnvPasscode(candidate: string, configured: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

function signOrganizerToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      role: 'organizer',
      exp: Date.now() + SESSION_TTL_MS,
      jti: crypto.randomBytes(8).toString('hex'),
    })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyOrganizerToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;
  try {
    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(payload)
      .digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      role?: string;
      exp?: number;
    };
    return decoded.role === 'organizer' && typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

function isAllowedOrigin(origin: string, req: Request): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (hostHeader && parsed.host.toLowerCase() === hostHeader) {
      return true;
    }
    const appUrl = (process.env.APP_URL || '').trim();
    if (appUrl && appUrl !== 'MY_APP_URL') {
      try {
        const appOrigin = new URL(appUrl).origin.toLowerCase();
        if (parsed.origin.toLowerCase() === appOrigin) return true;
      } catch {
        // Ignore malformed APP_URL
      }
    }
    if (
      origin === 'capacitor://localhost' ||
      origin === 'https://localhost' ||
      origin === 'http://localhost' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    ) {
      return true;
    }
    // Private LAN IPs for local rally telemetry server over Wi-Fi hotspot
    const h = parsed.hostname;
    if (
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function resolveSafeTxtPath(fileName: string): string | null {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safeName) return null;
  const resolved = path.resolve(TXT_DIR, safeName);
  if (!resolved.startsWith(TXT_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function sanitizeSlugPart(val: string): string {
  return val
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function requireOrganizerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!verifyOrganizerToken(token)) {
    res.status(401).json({
      ok: false,
      error: 'Acesso restrito ao organizador. Informe a senha de apuração.',
    });
    return;
  }
  next();
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);

  // Origin-validated CORS for Web host, Capacitor APK, and local Wi-Fi rally devices
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin, req)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.status(origin && !isAllowedOrigin(origin, req) ? 403 : 204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    const db = readDb();
    res.json({
      ok: true,
      brand: 'PitStop Sports',
      submissionsCount: db.submissions.length,
      publishedCount: db.publishedStandings.length,
    });
  });

  app.get('/api/auth/status', (req, res) => {
    const db = readDb();
    const configured = Boolean(ENV_ORGANIZER_PASSCODE || db.organizerPassHash);
    const needsClaim = !ENV_ORGANIZER_PASSCODE && !db.organizerPassHash;
    const authenticated = verifyOrganizerToken(extractBearerToken(req));
    res.json({ ok: true, configured, needsClaim, authenticated });
  });

  app.post('/api/auth/claim', async (req, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 4 || passcode.length > 128) {
      res.status(400).json({
        ok: false,
        error: 'Defina uma senha de apuração com pelo menos 4 caracteres.',
      });
      return;
    }
    if (ENV_ORGANIZER_PASSCODE) {
      res.status(409).json({
        ok: false,
        error: 'Senha de apuração já configurada no servidor.',
      });
      return;
    }
    try {
      let alreadyClaimed = false;
      await writeDbQueued((db) => {
        if (db.organizerPassHash) {
          alreadyClaimed = true;
          return db;
        }
        db.organizerPassHash = hashPasscodeScrypt(passcode);
        return db;
      });
      if (alreadyClaimed) {
        res.status(409).json({
          ok: false,
          error: 'A senha de apuração já foi definida anteriormente.',
        });
        return;
      }
      const token = signOrganizerToken();
      res.status(201).json({ ok: true, token });
    } catch {
      res.status(500).json({ ok: false, error: 'Falha ao salvar senha no servidor.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (!passcode) {
      res.status(400).json({ ok: false, error: 'Informe a senha de apuração.' });
      return;
    }
    const db = readDb();
    if (ENV_ORGANIZER_PASSCODE) {
      if (!verifyEnvPasscode(passcode, ENV_ORGANIZER_PASSCODE)) {
        res.status(401).json({ ok: false, error: 'Senha de apuração incorreta.' });
        return;
      }
      res.json({ ok: true, token: signOrganizerToken() });
      return;
    }
    if (!db.organizerPassHash) {
      res.status(409).json({
        ok: false,
        needsClaim: true,
        error: 'Nenhuma senha cadastrada ainda. Crie a senha inicial.',
      });
      return;
    }
    if (!verifyPasscodeScrypt(passcode, db.organizerPassHash)) {
      res.status(401).json({ ok: false, error: 'Senha de apuração incorreta.' });
      return;
    }
    res.json({ ok: true, token: signOrganizerToken() });
  });

  app.get('/api/results', requireOrganizerAuth, (_req, res) => {
    const db = readDb();
    res.json({ ok: true, results: db.submissions });
  });

  app.post('/api/results', async (req, res) => {
    const body = req.body as Partial<StoredSubmission> | undefined;
    if (!body || !body.carNumber || !Array.isArray(body.passages)) {
      res.status(400).json({
        ok: false,
        error: 'Dados incompletos: informe número do carro e lista de passagens.',
      });
      return;
    }

    const carNumClean = String(body.carNumber).trim().slice(0, 24);
    const eventClean = String(body.eventName || 'Prova PitStop Sports')
      .trim()
      .slice(0, 120);
    if (!carNumClean) {
      res.status(400).json({ ok: false, error: 'Número do carro inválido.' });
      return;
    }
    if (body.passages.length > 5000) {
      res.status(400).json({ ok: false, error: 'Quantidade de passagens excede o limite.' });
      return;
    }

    const safeCarSlug = carNumClean.replace(/[^a-zA-Z0-9_-]/g, '') || 'carro';
    const rawId = typeof body.id === 'string' ? body.id.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : '';
    const id = rawId || `car_${safeCarSlug}_${Date.now()}`;
    const fileName =
      body.fileName && String(body.fileName).trim()
        ? String(body.fileName).trim().slice(0, 120)
        : `resultado_carro_${safeCarSlug}.txt`;

    const radiusRaw = Number(body.detectionRadiusM);
    const detectionRadiusM =
      Number.isFinite(radiusRaw) && radiusRaw > 0 ? Math.min(500, Math.max(5, radiusRaw)) : 30;

    const submission: StoredSubmission = {
      id,
      fileName,
      eventName: eventClean,
      carNumber: carNumClean,
      crewName: String(body.crewName || '').trim().slice(0, 120),
      raceDate: String(body.raceDate || '').trim().slice(0, 32),
      startTimeStr: String(body.startTimeStr || '').trim().slice(0, 32),
      detectionRadiusM,
      recordedAt: String(body.recordedAt || new Date().toISOString()).slice(0, 40),
      passages: body.passages,
      rawTxt: typeof body.rawTxt === 'string' ? body.rawTxt.slice(0, 2 * 1024 * 1024) : undefined,
    };

    const nextDb = await writeDbQueued((db) => {
      const existingByIdIdx = db.submissions.findIndex((x) => x.id === submission.id);
      if (existingByIdIdx >= 0) {
        const existing = db.submissions[existingByIdIdx];
        if (existing.carNumber === submission.carNumber && existing.eventName === submission.eventName) {
          db.submissions[existingByIdIdx] = submission;
        } else {
          submission.id = `car_${safeCarSlug}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
          db.submissions.unshift(submission);
        }
      } else {
        const existingByKeyIdx = db.submissions.findIndex(
          (x) =>
            x.carNumber === submission.carNumber &&
            x.eventName === submission.eventName &&
            x.startTimeStr === submission.startTimeStr
        );
        if (existingByKeyIdx >= 0) {
          db.submissions[existingByKeyIdx] = submission;
        } else {
          db.submissions.unshift(submission);
        }
      }
      return db;
    });

    if (submission.rawTxt) {
      try {
        ensureDataDirs();
        const txtTarget = resolveSafeTxtPath(fileName);
        if (txtTarget) {
          fs.writeFileSync(txtTarget, submission.rawTxt, 'utf-8');
        }
      } catch {
        // Non-fatal if txt mirror fails
      }
    }

    res.status(201).json({
      ok: true,
      id: submission.id,
      count: nextDb.submissions.length,
    });
  });

  app.delete('/api/results/:id', requireOrganizerAuth, async (req, res) => {
    let removedFiles: string[] = [];
    const nextDb = await writeDbQueued((db) => {
      const targetId = req.params.id;
      const toRemove = db.submissions.filter((s) => s.id === targetId);
      removedFiles = toRemove.map((s) => s.fileName).filter(Boolean);
      db.submissions = db.submissions.filter((s) => s.id !== targetId);
      return db;
    });
    for (const fname of removedFiles) {
      const txtTarget = resolveSafeTxtPath(fname);
      if (txtTarget && fs.existsSync(txtTarget)) {
        try {
          fs.unlinkSync(txtTarget);
        } catch {
          // Ignore txt unlink error
        }
      }
    }
    res.json({ ok: true, count: nextDb.submissions.length });
  });

  app.delete('/api/results', requireOrganizerAuth, async (_req, res) => {
    let removedFiles: string[] = [];
    await writeDbQueued((db) => {
      removedFiles = db.submissions.map((s) => s.fileName).filter(Boolean);
      db.submissions = [];
      return db;
    });
    for (const fname of removedFiles) {
      const txtTarget = resolveSafeTxtPath(fname);
      if (txtTarget && fs.existsSync(txtTarget)) {
        try {
          fs.unlinkSync(txtTarget);
        } catch {
          // Ignore txt unlink error
        }
      }
    }
    res.json({ ok: true, count: 0 });
  });

  app.post('/api/public-standings', requireOrganizerAuth, async (req, res) => {
    const body = req.body as Partial<StoredStanding> | undefined;
    if (!body || !Array.isArray(body.rows)) {
      res.status(400).json({ ok: false, error: 'Tabela de classificação inválida.' });
      return;
    }

    const eventName = String(body.eventName || 'Classificação Oficial PitStop Sports')
      .trim()
      .slice(0, 120);
    const slug = `${sanitizeSlugPart(eventName) || 'prova'}-${Date.now().toString(36).slice(-5)}`;

    const snapshot: StoredStanding = {
      slug,
      eventName,
      createdAt: new Date().toISOString(),
      missedPenaltyPts: Number(body.missedPenaltyPts) || 600,
      rows: body.rows.slice(0, 1000),
      txtReport: String(body.txtReport || '').slice(0, 1024 * 1024),
      csvReport: String(body.csvReport || '').slice(0, 1024 * 1024),
    };

    await writeDbQueued((db) => {
      db.publishedStandings.unshift(snapshot);
      if (db.publishedStandings.length > 50) {
        db.publishedStandings = db.publishedStandings.slice(0, 50);
      }
      return db;
    });

    res.status(201).json({
      ok: true,
      slug,
      path: `/?resultado=${encodeURIComponent(slug)}`,
    });
  });

  app.get('/api/public-standings/:slug', (req, res) => {
    const db = readDb();
    const match = db.publishedStandings.find((p) => p.slug === req.params.slug);
    if (!match) {
      res.status(404).json({ ok: false, error: 'Classificação não encontrada.' });
      return;
    }
    res.json({ ok: true, snapshot: match });
  });

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

  function resolveSafeSatcronUrl(rawUrl?: string, race?: string, mod?: string, ss?: string): URL | null {
    const defaultUrl = new URL('https://satcron.com/stages/?race=novaitalia26&mod=1&ss=G');
    let parsed: URL;
    try {
      const candidate = (rawUrl || '').trim();
      if (!candidate) {
        parsed = defaultUrl;
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

    if (race && /^[a-zA-Z0-9_-]{2,48}$/.test(race.trim())) {
      parsed.searchParams.set('race', race.trim());
    }
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

  app.get('/api/satcron/stages', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
    const qRace = typeof req.query.race === 'string' ? req.query.race : undefined;
    const qMod = typeof req.query.mod === 'string' ? req.query.mod : undefined;
    const qSs = typeof req.query.ss === 'string' ? req.query.ss : undefined;

    const targetUrl = resolveSafeSatcronUrl(rawUrl, qRace, qMod, qSs);
    if (!targetUrl) {
      res.status(400).json({
        ok: false,
        error: 'URL inválida. Apenas endereços oficiais satcron.com são permitidos.',
      });
      return;
    }

    const race = targetUrl.searchParams.get('race') || 'novaitalia26';
    const mod = targetUrl.searchParams.get('mod') || '1';
    const ss = targetUrl.searchParams.get('ss') || 'G';

    try {
      const pageResp = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 PitStopSports/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(9000),
      });

      if (!pageResp.ok) {
        res.status(502).json({
          ok: false,
          error: `Satcron respondeu com HTTP ${pageResp.status}.`,
        });
        return;
      }

      const html = await pageResp.text();

      const pageTitleMatch = html.match(/id=["']PageTitle["'][^>]*>([\s\S]*?)<\/div>/i);
      const htmlTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      const eventTitle = sanitizeSatcronText(
        pageTitleMatch?.[1] || htmlTitleMatch?.[1] || `Satcron (${race})`
      ).replace(/\s*-\s*ChronoStages$/i, '');

      const bodyStripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
      const subtitleMatch = html.match(/class=["'][^"']*bfw-subtitle[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const stageHeaderMatch = html.match(/class=["'][^"']*CS-stage-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const stageRegexMatch = sanitizeSatcronText(bodyStripped).match(/(SS\d+[^.]{0,90}\(\d+(?:\.\d+)?\s*km\))/i);

      const subtitle = subtitleMatch ? sanitizeSatcronText(subtitleMatch[1]) : '';
      const stageTitle = stageHeaderMatch
        ? sanitizeSatcronText(stageHeaderMatch[1])
        : stageRegexMatch?.[1] || (ss === 'G' ? 'Classificação Geral (Acumulado)' : `Especial SS${ss}`);

      const modernConfig = extractBalancedJson(html, 'modernApiConfig:');
      const rawModalidades =
        modernConfig && typeof modernConfig.modalidades === 'object' && modernConfig.modalidades
          ? (modernConfig.modalidades as Record<string, Record<string, unknown>>)
          : {};

      const modalities = Object.entries(rawModalidades).map(([id, cfg]) => {
        const rawCats = Array.isArray(cfg.cats)
          ? (cfg.cats as Array<Record<string, unknown>>)
          : [];
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

      const activeMod =
        modalities.find((m) => m.id === mod) || modalities[0] || null;

      // Parse HTML <select> menus & static tables if rendered by ChronoStages
      const selectControls: Array<{
        id: string;
        options: Array<{ value: string; label: string; selected: boolean }>;
      }> = [];
      for (const sm of html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/gi)) {
        const idM = sm[1].match(/id=["']([^"']+)["']/i);
        const options: Array<{ value: string; label: string; selected: boolean }> = [];
        for (const om of sm[2].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)) {
          const valM = om[1].match(/value=["']([^"']*)["']/i);
          const lbl = sanitizeSatcronText(om[2]);
          if (lbl && lbl !== 'Carregando...') {
            options.push({
              value: valM ? valM[1] : lbl,
              label: lbl,
              selected: /selected/i.test(om[1]),
            });
          }
        }
        if (options.length > 0) {
          selectControls.push({ id: idM?.[1] || 'select', options });
        }
      }

      const tables: Array<{ headers: string[]; rows: string[][] }> = [];
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

      // Try Satcron cache_api.php endpoints cleanly using allowlisted origin
      let liveStatusMessage = '';
      const standings: Array<{
        pos: string;
        carNo: string;
        crew: string;
        category: string;
        stageTime: string;
        totalTime: string;
        diffLeader: string;
      }> = [];

      const safeApiArgs = activeMod?.apiArgs
        ? activeMod.apiArgs.replace(/[^a-zA-Z0-9=&_-]/g, '')
        : 'db=9';

      const fetchSatcronEndpoint = async (endpoint: string) => {
        const epUrl = new URL('https://satcron.com/stages/api/cache_api.php');
        epUrl.searchParams.set('race', race);
        if (safeApiArgs) {
          for (const pair of safeApiArgs.split('&')) {
            const [k, v] = pair.split('=');
            if (k && v) epUrl.searchParams.set(k, v);
          }
        }
        epUrl.searchParams.set('endpoint', endpoint);
        const r = await fetch(epUrl.toString(), {
          signal: AbortSignal.timeout(5000),
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      };

      const staticUrl =
        activeMod?.staticJSONFile && !activeMod.staticJSONFile.includes('..')
          ? `https://satcron.com/stages/${activeMod.staticJSONFile.replace(/^\/+/, '')}`
          : null;

      const [crewsData, raceTimesData, stageTimesData, staticJsonData] = await Promise.all([
        fetchSatcronEndpoint('crews').catch(() => null),
        fetchSatcronEndpoint('racetimes').catch(() => null),
        fetchSatcronEndpoint('stagetimes').catch(() => null),
        staticUrl
          ? fetch(staticUrl, {
              signal: AbortSignal.timeout(5000),
              headers: { Accept: 'application/json' },
            })
              .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const errorPayload = [crewsData, raceTimesData, stageTimesData].find(
        (d) => d && d.status === 'error' && typeof d.message === 'string'
      );
      if (errorPayload && typeof errorPayload.message === 'string') {
        liveStatusMessage = /live data disabled/i.test(errorPayload.message)
          ? 'Prova sem tempos ativos no momento ou encerrada (Live data disabled for this race).'
          : errorPayload.message;
      }

      const extractRows = (payload: unknown): Array<Record<string, unknown>> => {
        if (!payload) return [];
        if (Array.isArray(payload)) {
          return payload.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
        }
        if (typeof payload !== 'object') return [];
        const obj = payload as Record<string, unknown>;
        for (const k of ['data', 'rows', 'crews', 'racetimes', 'stagetimes', 'standings']) {
          const v = obj[k];
          if (Array.isArray(v)) {
            return v.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
          }
          if (v && typeof v === 'object') {
            const mapObj = v as Record<string, unknown>;
            if (ss && ss !== 'G' && Array.isArray(mapObj[ss])) {
              return (mapObj[ss] as unknown[]).filter(
                (x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')
              );
            }
            const vals = Object.entries(mapObj)
              .filter(([, item]) => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
              .map(([key, item]) => ({ car: key, ...(item as Record<string, unknown>) }));
            if (vals.length > 0) return vals;
          }
        }
        return [];
      };

      // Normalize rows if live JSON arrays or maps are returned
      const crewsMap = new Map<string, { crew: string; category: string }>();
      const rawCrewList = extractRows(crewsData ?? staticJsonData);
      for (const item of rawCrewList) {
        const carNo = String(item.car ?? item.carNo ?? item.num ?? item.id ?? '');
        if (!carNo) continue;
        const driver = String(item.driver ?? item.piloto ?? item.crew ?? '');
        const codriver = String(item.codriver ?? item.navegador ?? '');
        const crewName = codriver ? `${driver} / ${codriver}` : driver || `Carro #${carNo}`;
        const cat = String(item.cat ?? item.category ?? '');
        crewsMap.set(carNo, { crew: crewName, category: cat });
      }

      const timeSource =
        (ss === 'G' ? raceTimesData : stageTimesData || raceTimesData) ?? staticJsonData;
      const rawTimeRows = extractRows(timeSource);
      for (let i = 0; i < rawTimeRows.length; i += 1) {
        const row = rawTimeRows[i];
        const carNo = String(row.car ?? row.carNo ?? row.num ?? '');
        const crewInfo = crewsMap.get(carNo);
        const stageT = String(row.stagetime ?? row.ss_time ?? row.time ?? '-');
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

      res.json({
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
        selectControls,
        tables,
        standings,
        fetchedAtMs: Date.now(),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Falha de conexão com Satcron';
      res.status(502).json({
        ok: false,
        error: `Não foi possível consultar o Satcron: ${detail}`,
      });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });

    // When HMR is disabled in middlewareMode, Vite 8 still injects /@vite/client
    // which attempts to open a WebSocket connection unless intercepted cleanly.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(`
const sheetsMap = new Map();
const linkSheetsMap = new Map();
if ("document" in globalThis) {
  document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => {
    sheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
  document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id]').forEach((el) => {
    linkSheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
}
export function updateStyle(id, content) {
  if (linkSheetsMap.has(id)) return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  if (linkSheetsMap.has(id)) {
    document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id="' + CSS.escape(id) + '"]').forEach((el) => el.remove());
    linkSheetsMap.delete(id);
  }
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  const noop = () => {};
  return {
    data: {},
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    decline: noop,
    invalidate: noop,
    on: noop,
    off: noop,
    send: noop,
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== "." && url[0] !== "/") return url;
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vite.dev");
  return pathname + "?" + queryToInject + (search ? "&" + search.slice(1) : "") + (hash || "");
}
export class ErrorOverlay {
  constructor() {}
}
`);
    });

    app.use(vite.middlewares);
  } else {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);

  // Real-time Navigator -> Pilot pairing WebSocket on /ws/pair
  const MAX_ROOMS = 200;
  const MAX_CLIENTS_PER_ROOM = 8;

  interface PairRoom {
    pin: string;
    clients: Map<WebSocket, 'navigator' | 'pilot'>;
    lastTelemetryJson: string | null;
  }
  const pairRooms = new Map<string, PairRoom>();
  const socketAlive = new WeakMap<WebSocket, boolean>();
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/pair',
    maxPayload: 512 * 1024,
  });

  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (socketAlive.get(client) === false) {
        client.terminate();
        continue;
      }
      socketAlive.set(client, false);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, 25000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  const broadcastPresence = (roomId: string, room: PairRoom) => {
    let navigators = 0;
    let pilots = 0;
    for (const r of room.clients.values()) {
      if (r === 'navigator') navigators += 1;
      else pilots += 1;
    }
    const msg = JSON.stringify({
      type: 'pair:presence',
      roomCode: roomId,
      navigators,
      pilots,
    });
    for (const ws of room.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  wss.on('connection', (ws, req) => {
    const reqUrl = new URL(req.url || '/ws/pair', `http://127.0.0.1:${PORT}`);
    const roomId = (reqUrl.searchParams.get('room') || 'PS-0000')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 12);
    const pinParam = (reqUrl.searchParams.get('pin') || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12);
    const roleParam = reqUrl.searchParams.get('role') === 'pilot' ? 'pilot' : 'navigator';

    let room = pairRooms.get(roomId);
    if (!room) {
      if (pairRooms.size >= MAX_ROOMS) {
        ws.close(4003, 'Limite de salas atingido.');
        return;
      }
      room = { pin: pinParam, clients: new Map(), lastTelemetryJson: null };
      pairRooms.set(roomId, room);
    } else {
      if (room.pin && pinParam !== room.pin) {
        ws.close(4001, 'PIN da sala inválido.');
        return;
      }
      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        ws.close(4003, 'Sala cheia.');
        return;
      }
    }

    socketAlive.set(ws, true);
    ws.on('pong', () => {
      socketAlive.set(ws, true);
    });

    room.clients.set(ws, roleParam);
    broadcastPresence(roomId, room);

    if (roleParam === 'pilot' && room.lastTelemetryJson && ws.readyState === WebSocket.OPEN) {
      ws.send(room.lastTelemetryJson);
    }

    ws.on('message', (rawData) => {
      const text = rawData.toString();
      if (text.length > 512 * 1024) return;
      try {
        const parsed = JSON.parse(text) as { type?: string };
        const currentRole = room?.clients.get(ws);
        if (!currentRole || !room) return;
        if (currentRole === 'pilot') {
          if (parsed.type === 'pilot:hello') {
            broadcastPresence(roomId, room);
            if (room.lastTelemetryJson && ws.readyState === WebSocket.OPEN) {
              ws.send(room.lastTelemetryJson);
            }
          }
          return;
        }
        if (parsed.type === 'nav:telemetry') {
          room.lastTelemetryJson = text;
          for (const [peer, peerRole] of room.clients.entries()) {
            if (peerRole === 'pilot' && peer.readyState === WebSocket.OPEN) {
              peer.send(text);
            }
          }
        } else if (parsed.type === 'nav:ping') {
          broadcastPresence(roomId, room);
        }
      } catch {
        // Ignore malformed telemetry payload
      }
    });

    ws.on('close', () => {
      const targetRoom = pairRooms.get(roomId);
      if (!targetRoom) return;
      targetRoom.clients.delete(ws);
      if (targetRoom.clients.size === 0) {
        pairRooms.delete(roomId);
      } else {
        broadcastPresence(roomId, targetRoom);
      }
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PitStop Sports server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PitStop Sports server:', err);
  process.exit(1);
});
