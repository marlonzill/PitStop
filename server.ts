import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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

  app.post('/api/velocity/coach', async (req, res) => {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      res.status(503).json({
        ok: false,
        error:
          'Coach por IA indisponível no momento: configure a variável GEMINI_API_KEY no ambiente do servidor.',
      });
      return;
    }

    const body = req.body as {
      trackName?: string;
      lapA?: {
        runNumber: number;
        totalMs: number;
        avgSpeedKmh: number;
        maxSpeedKmh: number;
        distanceKm: number;
      };
      lapB?: {
        runNumber: number;
        totalMs: number;
        avgSpeedKmh: number;
        maxSpeedKmh: number;
        distanceKm: number;
      };
      comparison?: {
        totalDeltaSec: number;
        maxSpeedDeltaKmh: number;
        avgSpeedDeltaKmh: number;
        corners?: Array<{
          cornerIndex: number;
          distKm: number;
          lapAApexKmh: number;
          lapBApexKmh: number;
          lapAExitKmh: number;
          lapBExitKmh: number;
          timeDeltaSec: number;
          brakeShiftM: number;
        }>;
      };
    };

    if (!body?.lapA || !body?.lapB || !body?.comparison) {
      res.status(400).json({
        ok: false,
        error: 'Informe duas passagens válidas (Volta A e Volta B) para análise.',
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const prompt = [
        `Pista/Especial: ${String(body.trackName || 'Circuito').slice(0, 100)}`,
        `Volta analisada (#${body.lapA.runNumber}): ${(body.lapA.totalMs / 1000).toFixed(2)}s · Vel Méd ${body.lapA.avgSpeedKmh} km/h · Vel Máx ${body.lapA.maxSpeedKmh} km/h`,
        `Volta referência (#${body.lapB.runNumber}): ${(body.lapB.totalMs / 1000).toFixed(2)}s · Vel Méd ${body.lapB.avgSpeedKmh} km/h · Vel Máx ${body.lapB.maxSpeedKmh} km/h`,
        `Delta total: ${body.comparison.totalDeltaSec >= 0 ? '+' : ''}${body.comparison.totalDeltaSec}s`,
        `Curvas e zonas de frenagem detectadas no GPS: ${JSON.stringify(body.comparison.corners || [])}`,
        'Gere 3 a 4 dicas diretas e objetivas em português do Brasil comparando ponto de frenagem (metros antes/depois), velocidade de ápice e saída de curva, citando números reais dos dados acima.',
      ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'Você é um engenheiro de pista e coach de pilotagem para rally e track-day. Seja conciso (máximo 140 palavras), direto em tópicos curtos, usando exclusivamente os números fornecidos.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const advice = (response.text || '').trim();
      if (!advice) {
        res.status(502).json({
          ok: false,
          error: 'O modelo não retornou análise de telemetria. Tente novamente.',
        });
        return;
      }

      res.json({ ok: true, advice });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Erro desconhecido';
      res.status(502).json({
        ok: false,
        error: `Falha ao consultar Coach por IA: ${detail}`,
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
