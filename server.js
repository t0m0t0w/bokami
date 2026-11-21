const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const DEFAULT_BOOKS_DIR = process.env.BOOKS_DIR ? path.resolve(process.env.BOOKS_DIR) : path.join(ROOT_DIR, 'books');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LEGACY_USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');
const BOOKMETA_FALLBACK_FILE = path.join(DATA_DIR, 'bookmeta.json');
const COVERS_CACHE_DIR = path.join(DATA_DIR, 'covers');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COVERS_CACHE_DIR)) fs.mkdirSync(COVERS_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DEFAULT_BOOKS_DIR)) fs.mkdirSync(DEFAULT_BOOKS_DIR, { recursive: true });

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const EBOOK_EXTENSIONS = new Set(['.pdf', '.epub']);
const EPUB_SAFE_ASSET_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf'
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_PREF_KEYS = new Set([
  'shelfView',
  'gridCoverMode',
  'readerMode',
  'fitMode',
  'spreadCoverSolo'
]);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS = 500;
const MAX_PROFILES = 50;
const MAX_AVATAR_LEN = 250_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_EPUB_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_BYTES = 150 * 1024 * 1024;
const MAX_CONCURRENT_EXPORTS = 2;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let activeExports = 0;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function setBoundedCache(map, key, val, max = MAX_CACHE_ENTRIES) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, val);
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return null;
  }
}

function isValidBookId(bookId) {
  if (typeof bookId !== 'string') return false;
  if (!bookId || bookId.length > 200) return false;
  if (bookId === '.' || bookId === '..') return false;
  if (bookId === 'lost+found') return false;
  if (FORBIDDEN_KEYS.has(bookId)) return false;
  if (bookId.startsWith('.')) return false;
  if (bookId.includes('/') || bookId.includes('\\') || bookId.includes('\0')) return false;
  if (path.basename(bookId) !== bookId) return false;
  return true;
}

function isPathInsideDir(baseDir, targetPath, { allowMissingLeaf = false } = {}) {
  try {
    const realBase = fs.realpathSync(baseDir);
    const prefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
    let realTarget;
    if (fs.existsSync(targetPath)) {
      realTarget = fs.realpathSync(targetPath);
    } else if (allowMissingLeaf) {
      const parent = path.dirname(targetPath);
      if (!fs.existsSync(parent)) return false;
      const realParent = fs.realpathSync(parent);
      if (realParent !== realBase && !realParent.startsWith(prefix)) {
        return false;
      }
      realTarget = path.join(realParent, path.basename(targetPath));
    } else {
      return false;
    }
    return realTarget.startsWith(prefix);
  } catch {
    return false;
  }
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Feil ved lesing av ${filePath}:`, err.message);
  }
  return fallback;
}

function saveJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    console.error(`Feil ved lagring av ${filePath}:`, err.message);
    return false;
  }
}

// ==================== PASSWORD HASHING & CONFIG ====================
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(plain, storedHash) {
  if (typeof plain !== 'string' || typeof storedHash !== 'string' || !plain) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = crypto.scryptSync(plain, salt, 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function getEnvPassword(primaryName, fallbackName = null) {
  const v1 = process.env[primaryName];
  if (typeof v1 === 'string' && v1.length > 0) return v1;
  if (fallbackName) {
    const v2 = process.env[fallbackName];
    if (typeof v2 === 'string' && v2.length > 0) return v2;
  }
  return null;
}

const startupNotices = {
  generatedReaderPassword: null,
  generatedAdminPassword: null,
  defaultReaderPasswordWarning: false
};

function initConfig() {
  const loaded = loadJson(CONFIG_FILE, {});
  const config = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? { ...loaded } : {};
  let changed = false;

  if (typeof config.booksDir !== 'string' || !config.booksDir.trim()) {
    config.booksDir = DEFAULT_BOOKS_DIR;
    changed = true;
  }

  // Migrate legacy plaintext config.password -> scrypt passwordHash
  if (typeof config.password === 'string') {
    if (config.password.length > 0 && !config.passwordHash) {
      if (config.password === 'passord') {
        startupNotices.defaultReaderPasswordWarning = true;
      }
      config.passwordHash = hashPassword(config.password);
    }
    delete config.password;
    changed = true;
  }

  const envReader = getEnvPassword('BOKAMI_PASSWORD', 'PASSWORD');
  if (!envReader && (typeof config.passwordHash !== 'string' || !config.passwordHash.startsWith('scrypt$'))) {
    const genReader = crypto.randomBytes(9).toString('base64url'); // 12 chars
    config.passwordHash = hashPassword(genReader);
    startupNotices.generatedReaderPassword = genReader;
    changed = true;
  }

  const envAdmin = getEnvPassword('BOKAMI_ADMIN_PASSWORD');
  if (!envAdmin && (typeof config.adminPasswordHash !== 'string' || !config.adminPasswordHash.startsWith('scrypt$'))) {
    const genAdmin = crypto.randomBytes(12).toString('base64url'); // 16 chars
    config.adminPasswordHash = hashPassword(genAdmin);
    startupNotices.generatedAdminPassword = genAdmin;
    changed = true;
  }

  if (changed || !fs.existsSync(CONFIG_FILE)) {
    saveJson(CONFIG_FILE, config);
  }
}

initConfig();

function getRuntimeConfig() {
  const loaded = loadJson(CONFIG_FILE, {});
  const envReaderPassword = getEnvPassword('BOKAMI_PASSWORD', 'PASSWORD');
  const envAdminPassword = getEnvPassword('BOKAMI_ADMIN_PASSWORD');
  const booksDir = process.env.BOOKS_DIR
    ? path.resolve(process.env.BOOKS_DIR)
    : typeof loaded.booksDir === 'string' && loaded.booksDir.trim()
      ? path.resolve(loaded.booksDir.trim())
      : DEFAULT_BOOKS_DIR;

  return {
    booksDir,
    envReaderPassword,
    envAdminPassword,
    passwordHash: typeof loaded.passwordHash === 'string' ? loaded.passwordHash : null,
    adminPasswordHash: typeof loaded.adminPasswordHash === 'string' ? loaded.adminPasswordHash : null,
    passwordLockedByEnv: Boolean(envReaderPassword),
    adminPasswordLockedByEnv: Boolean(envAdminPassword)
  };
}

function verifyReaderPassword(input) {
  if (typeof input !== 'string' || !input) return false;
  const cfg = getRuntimeConfig();
  if (cfg.envReaderPassword) {
    return timingSafeStringEqual(input, cfg.envReaderPassword);
  }
  return verifyPassword(input, cfg.passwordHash);
}

function verifyGlobalAdminPassword(input) {
  if (typeof input !== 'string' || !input) return false;
  const cfg = getRuntimeConfig();
  if (cfg.envAdminPassword) {
    return timingSafeStringEqual(input, cfg.envAdminPassword);
  }
  return verifyPassword(input, cfg.adminPasswordHash);
}

// ==================== SESSIONS, COOKIES & RATE LIMIT ====================
const sessions = new Map();

function loadSessions() {
  const raw = loadJson(SESSIONS_FILE, { sessions: [] });
  const now = Date.now();
  let pruned = false;
  if (raw && Array.isArray(raw.sessions)) {
    for (const s of raw.sessions) {
      if (
        s &&
        typeof s.id === 'string' &&
        s.id.length >= 16 &&
        typeof s.expiresAt === 'number' &&
        s.expiresAt > now
      ) {
        sessions.set(s.id, {
          id: s.id,
          role: s.role === 'admin' ? 'admin' : 'user',
          activeProfileId: typeof s.activeProfileId === 'string' ? s.activeProfileId : null,
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : now,
          expiresAt: s.expiresAt
        });
      } else {
        pruned = true;
      }
    }
  }
  if (pruned) persistSessions();
}

function persistSessions() {
  saveJson(SESSIONS_FILE, { sessions: Array.from(sessions.values()) });
}

function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions.entries()) {
    if (!s || s.expiresAt <= now) {
      sessions.delete(id);
      changed = true;
    }
  }
  return changed;
}

function createSession(role = 'user', activeProfileId = null) {
  pruneExpiredSessions();
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const now = Date.now();
  const id = crypto.randomBytes(32).toString('base64url');
  const session = {
    id,
    role: role === 'admin' ? 'admin' : 'user',
    activeProfileId: typeof activeProfileId === 'string' ? activeProfileId : null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  };
  sessions.set(id, session);
  persistSessions();
  return session;
}

function rotateSession(oldSessionId, newRole, activeProfileId) {
  if (oldSessionId) sessions.delete(oldSessionId);
  return createSession(newRole, activeProfileId);
}

function deleteSession(sessionId) {
  if (sessionId && sessions.delete(sessionId)) {
    persistSessions();
  }
}

loadSessions();

function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return proto === 'https';
  }
  return false;
}

function getSessionCookieName(req) {
  return isSecureRequest(req) ? '__Host-bokami_session' : 'bokami_session';
}

function buildSessionSetCookie(req, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  if (isSecureRequest(req)) {
    return `__Host-bokami_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  }
  return `bokami_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function buildClearSessionCookie(req) {
  if (isSecureRequest(req)) {
    return '__Host-bokami_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
  }
  return 'bokami_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function parseCookies(req) {
  const list = Object.create(null);
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach((cookie) => {
    const eqIdx = cookie.indexOf('=');
    if (eqIdx <= 0) return;
    const key = cookie.slice(0, eqIdx).trim();
    const rawVal = cookie.slice(eqIdx + 1).trim();
    if (!key || FORBIDDEN_KEYS.has(key)) return;
    try {
      list[key] = decodeURIComponent(rawVal);
    } catch {
      list[key] = rawVal;
    }
  });
  return list;
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const cookieName = getSessionCookieName(req);
  const sessionId = cookies[cookieName];
  if (!sessionId || typeof sessionId !== 'string') return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    persistSessions();
    return null;
  }
  return session;
}

// Rate limiter for auth endpoints
const loginAttempts = new Map();

function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (loginAttempts.size > 500) {
    for (const [k, v] of loginAttempts.entries()) {
      if (v.resetAt <= now) loginAttempts.delete(k);
    }
  }
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.resetAt <= now) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

// ==================== SECURITY HEADERS, FETCH METADATA & CSRF ====================
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Vary', 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');
  res.setHeader('Content-Security-Policy', DEFAULT_CSP);
  if (TRUST_PROXY && isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=300');
  }
}

function checkFetchMetadata(req, pathname) {
  if (pathname === '/healthz') return true;
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (!site) return true; // Non-browser / legacy client fallback
  if (site === 'same-origin' || site === 'none') return true;

  const mode = String(req.headers['sec-fetch-mode'] || '').trim().toLowerCase();
  const dest = String(req.headers['sec-fetch-dest'] || '').trim().toLowerCase();

  // Allow top-level page navigations only for app HTML (NOT API, media, or EPUB assets, and NOT same-site subresources)
  if (
    (site === 'cross-site' || site === 'same-site') &&
    mode === 'navigate' &&
    req.method === 'GET' &&
    !['object', 'embed', 'iframe', 'frame'].includes(dest) &&
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/book-media/') &&
    !pathname.startsWith('/epub-resource/')
  ) {
    return true;
  }

  return false;
}

function getExpectedOrigin(req) {
  const rawHost = String(req.headers.host || '').trim();
  if (!rawHost) return null;
  const scheme = isSecureRequest(req) ? 'https' : 'http';
  try {
    const parsed = new URL(`${scheme}://${rawHost}`);
    return parsed.origin !== 'null' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isSameOriginUrl(candidateUrl, expectedOrigin) {
  if (!candidateUrl || !expectedOrigin) return false;
  try {
    const parsed = new URL(candidateUrl);
    return parsed.origin !== 'null' && parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function checkOriginForMutation(req) {
  const expectedOrigin = getExpectedOrigin(req);
  const originHeader = req.headers.origin;
  if (typeof originHeader === 'string') {
    return isSameOriginUrl(originHeader, expectedOrigin);
  }
  const refererHeader = req.headers.referer;
  if (typeof refererHeader === 'string') {
    return isSameOriginUrl(refererHeader, expectedOrigin);
  }
  return true;
}

// ==================== PROFILES & ACCESS HELPERS ====================
const DEFAULT_PREFERENCES = {
  shelfView: 'grid',
  gridCoverMode: 'c1',
  readerMode: 'auto',
  fitMode: 'height',
  spreadCoverSolo: true
};

const VALID_SHELF_VIEWS = new Set(['grid', 'spine']);
const VALID_GRID_MODES = new Set(['c1', 'c2', 'c3']);
const VALID_READER_MODES = new Set(['auto', 'single', 'spread', 'vertical']);
const VALID_FIT_MODES = new Set(['height', 'width', 'original']);

function sanitizePreferences(rawPrefs) {
  const base = { ...DEFAULT_PREFERENCES };
  if (!rawPrefs || typeof rawPrefs !== 'object') return base;
  if (VALID_SHELF_VIEWS.has(rawPrefs.shelfView)) base.shelfView = rawPrefs.shelfView;
  if (VALID_GRID_MODES.has(rawPrefs.gridCoverMode)) base.gridCoverMode = rawPrefs.gridCoverMode;
  if (VALID_READER_MODES.has(rawPrefs.readerMode)) base.readerMode = rawPrefs.readerMode;
  if (VALID_FIT_MODES.has(rawPrefs.fitMode)) base.fitMode = rawPrefs.fitMode;
  if (typeof rawPrefs.spreadCoverSolo === 'boolean') base.spreadCoverSolo = rawPrefs.spreadCoverSolo;
  return base;
}

function isValidAvatar(val) {
  if (val === '') return true;
  if (typeof val !== 'string' || val.length > MAX_AVATAR_LEN) return false;
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(val);
}

function isValidHexColor(val) {
  return typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val);
}

function getProfilesData() {
  if (fs.existsSync(PROFILES_FILE)) {
    const data = loadJson(PROFILES_FILE, { profiles: [] });
    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      let changed = false;
      for (const p of data.profiles) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.isAdmin !== 'boolean') {
          p.isAdmin = false;
          changed = true;
        }
        if (p.adminPasswordHash !== null && (typeof p.adminPasswordHash !== 'string' || !p.adminPasswordHash.startsWith('scrypt$'))) {
          p.adminPasswordHash = null;
          changed = true;
        }
        const cleanHidden = Array.isArray(p.hiddenBooks)
          ? [...new Set(p.hiddenBooks.filter(isValidBookId))]
          : [];
        if (!Array.isArray(p.hiddenBooks) || cleanHidden.length !== p.hiddenBooks.length) {
          p.hiddenBooks = cleanHidden;
          changed = true;
        }
        if (!isValidHexColor(p.color)) {
          p.color = '#00A3FF';
          changed = true;
        }
        if (!isValidAvatar(p.avatar || '')) {
          p.avatar = '';
          changed = true;
        }
        if (!p.progress || typeof p.progress !== 'object' || Array.isArray(p.progress)) {
          p.progress = {};
          changed = true;
        }
        if (!p.bookmarks || typeof p.bookmarks !== 'object' || Array.isArray(p.bookmarks)) {
          p.bookmarks = {};
          changed = true;
        }
        p.preferences = sanitizePreferences(p.preferences);
      }

      if (!data.profiles.some((p) => p.isAdmin)) {
        const defaultAdmin = data.profiles.find((p) => p.id === 'main') || data.profiles[0];
        if (defaultAdmin) {
          defaultAdmin.isAdmin = true;
          changed = true;
        }
      }

      if (changed) {
        saveJson(PROFILES_FILE, data);
      }
      return data;
    }
  }

  const legacy = loadJson(LEGACY_USERDATA_FILE, null);
  const initialProfile = {
    id: 'main',
    name: 'Meg',
    avatar: '',
    color: '#00A3FF',
    isAdmin: true,
    adminPasswordHash: null,
    hiddenBooks: [],
    createdAt: new Date().toISOString(),
    progress: legacy && legacy.progress ? legacy.progress : {},
    bookmarks: legacy && legacy.bookmarks ? legacy.bookmarks : {},
    preferences: sanitizePreferences(legacy && legacy.preferences)
  };

  const initialData = { profiles: [initialProfile] };
  saveJson(PROFILES_FILE, initialData);
  return initialData;
}

function sanitizeProfileSummary(p, includeAdminDetails = false) {
  const bookmarkTotal = Object.values(p.bookmarks || {}).reduce(
    (acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0),
    0
  );
  const readingCount = Object.keys(p.progress || {}).length;
  const out = {
    id: p.id,
    name: p.name,
    avatar: p.avatar || '',
    color: isValidHexColor(p.color) ? p.color : '#00A3FF',
    isAdmin: Boolean(p.isAdmin),
    bookmarkTotal,
    readingCount
  };
  if (includeAdminDetails) {
    out.hiddenBooks = Array.isArray(p.hiddenBooks) ? p.hiddenBooks : [];
    out.hasPersonalAdminPassword = Boolean(p.adminPasswordHash);
  }
  return out;
}

function resolveRequestProfile(session, req, parsedUrl) {
  const data = getProfilesData();
  const requestedId =
    (session && session.activeProfileId) ||
    req.headers['x-profile-id'] ||
    parsedUrl.searchParams.get('profileId') ||
    null;

  let profile = requestedId ? data.profiles.find((p) => p.id === requestedId) : null;
  if (!profile) {
    if (session && session.role === 'admin') {
      profile = data.profiles[0];
    } else {
      profile = data.profiles.find((p) => !p.isAdmin) || data.profiles[0];
    }
  }

  if (!profile) {
    return { error: 404, message: 'Ingen profil funnet' };
  }

  if (profile.isAdmin && (!session || session.role !== 'admin')) {
    return {
      error: 403,
      requireAdmin: true,
      message: 'Admin-tilgang kreves for denne profilen'
    };
  }

  if (!profile.progress) profile.progress = {};
  if (!profile.bookmarks) profile.bookmarks = {};
  if (!Array.isArray(profile.hiddenBooks)) profile.hiddenBooks = [];
  profile.preferences = sanitizePreferences(profile.preferences);

  return { data, profile };
}

function isBookHiddenForProfile(session, profile, bookId, metaOrBook) {
  if (metaOrBook && metaOrBook.adminOnly && (!session || session.role !== 'admin')) {
    return true;
  }
  if (profile && Array.isArray(profile.hiddenBooks) && profile.hiddenBooks.includes(bookId)) {
    return true;
  }
  return false;
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// ==================== BOOK METADATA ====================
function loadBookMeta(booksDir, folderName) {
  const defaultMeta = {
    title: '',
    adminOnly: false,
    forsatsAlene: true,
    sizeScale: 1.0,
    pageCount: null,
    chapters: []
  };
  if (!isValidBookId(folderName)) return defaultMeta;

  const fullPath = path.join(booksDir, folderName);
  const inside = isPathInsideDir(booksDir, fullPath);
  const isDir = inside && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  const bookJsonPath = isDir ? path.join(fullPath, 'book.json') : null;
  const fallbackStore = loadJson(BOOKMETA_FALLBACK_FILE, {});
  const fallbackMeta =
    fallbackStore && typeof fallbackStore === 'object' && Object.hasOwn(fallbackStore, folderName)
      ? fallbackStore[folderName] || {}
      : {};

  let folderMeta = {};
  if (bookJsonPath && fs.existsSync(bookJsonPath) && isPathInsideDir(fullPath, bookJsonPath)) {
    folderMeta = loadJson(bookJsonPath, {});
  }

  const rawScale =
    typeof folderMeta.sizeScale === 'number'
      ? folderMeta.sizeScale
      : typeof fallbackMeta.sizeScale === 'number'
        ? fallbackMeta.sizeScale
        : defaultMeta.sizeScale;

  const rawTitle =
    typeof folderMeta.title === 'string'
      ? folderMeta.title
      : typeof fallbackMeta.title === 'string'
        ? fallbackMeta.title
        : '';

  const merged = {
    title: rawTitle.trim().slice(0, 140),
    adminOnly:
      typeof folderMeta.adminOnly === 'boolean'
        ? folderMeta.adminOnly
        : typeof fallbackMeta.adminOnly === 'boolean'
          ? fallbackMeta.adminOnly
          : defaultMeta.adminOnly,
    forsatsAlene:
      typeof folderMeta.forsatsAlene === 'boolean'
        ? folderMeta.forsatsAlene
        : typeof fallbackMeta.forsatsAlene === 'boolean'
          ? fallbackMeta.forsatsAlene
          : defaultMeta.forsatsAlene,
    sizeScale: Math.max(0.5, Math.min(1.5, Number(rawScale) || 1.0)),
    pageCount:
      typeof folderMeta.pageCount === 'number'
        ? folderMeta.pageCount
        : typeof fallbackMeta.pageCount === 'number'
          ? fallbackMeta.pageCount
          : null,
    chapters: Array.isArray(folderMeta.chapters)
      ? folderMeta.chapters
      : Array.isArray(fallbackMeta.chapters)
        ? fallbackMeta.chapters
        : []
  };

  merged.chapters.sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
  return merged;
}

function saveBookMeta(booksDir, folderName, meta) {
  if (!isValidBookId(folderName)) {
    throw new HttpError(400, 'Ugyldig bok-ID');
  }
  const rawScale = typeof meta.sizeScale === 'number' && Number.isFinite(meta.sizeScale) ? meta.sizeScale : 1.0;
  const cleanTitle = typeof meta.title === 'string' ? meta.title.trim().slice(0, 140) : '';
  const cleanMeta = {
    ...(cleanTitle ? { title: cleanTitle } : {}),
    adminOnly: Boolean(meta.adminOnly),
    forsatsAlene: typeof meta.forsatsAlene === 'boolean' ? meta.forsatsAlene : true,
    sizeScale: Math.max(0.5, Math.min(1.5, Math.round(rawScale * 100) / 100)),
    ...(typeof meta.pageCount === 'number' && Number.isFinite(meta.pageCount) && meta.pageCount > 0
      ? { pageCount: Math.min(20000, Math.round(meta.pageCount)) }
      : {}),
    chapters: Array.isArray(meta.chapters)
      ? meta.chapters
          .slice(0, 500)
          .filter((ch) => ch && typeof ch === 'object')
          .map((ch) => ({
            id: typeof ch.id === 'string' && ch.id ? ch.id.slice(0, 80) : `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: String(ch.title || 'Kapittel').trim().slice(0, 140),
            pageIndex: Math.max(0, parseInt(ch.pageIndex, 10) || 0),
            pageFile: typeof ch.pageFile === 'string' && isValidBookId(ch.pageFile) ? ch.pageFile : undefined
          }))
          .sort((a, b) => a.pageIndex - b.pageIndex)
      : []
  };

  const fullPath = path.join(booksDir, folderName);
  const inside = isPathInsideDir(booksDir, fullPath);
  const isDir = inside && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  const bookJsonPath = isDir ? path.join(fullPath, 'book.json') : null;
  const wroteToFolder = isDir && isPathInsideDir(fullPath, bookJsonPath, { allowMissingLeaf: true })
    ? saveJson(bookJsonPath, cleanMeta)
    : false;

  const loadedFallback = loadJson(BOOKMETA_FALLBACK_FILE, {});
  const fallbackStore = loadedFallback && typeof loadedFallback === 'object' && !Array.isArray(loadedFallback)
    ? loadedFallback
    : {};
  fallbackStore[folderName] = cleanMeta;
  saveJson(BOOKMETA_FALLBACK_FILE, fallbackStore);

  return { meta: cleanMeta, wroteToFolder };
}

// ==================== IMAGE & BINARY HELPERS ====================
function isValidImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true;
  // GIF
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return true;
  // WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return true;
  }
  return false;
}

const imageDimCache = new Map();
function readImageDimensions(filePath) {
  if (!filePath) return null;
  if (imageDimCache.has(filePath)) return imageDimCache.get(filePath);
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const slice = buf.subarray(0, bytesRead);

    // PNG header check
    if (slice.length >= 24 && slice[0] === 0x89 && slice[1] === 0x50 && slice[2] === 0x4e && slice[3] === 0x47) {
      const width = slice.readUInt32BE(16);
      const height = slice.readUInt32BE(20);
      if (width > 0 && height > 0) {
        const res = { width, height, ratio: Number((width / height).toFixed(4)) };
        setBoundedCache(imageDimCache, filePath, res);
        return res;
      }
    }

    // JPEG header check
    if (slice.length >= 4 && slice[0] === 0xff && slice[1] === 0xd8) {
      const info = getJpegInfo(slice);
      if (info && info.width && info.height) {
        const res = {
          width: info.width,
          height: info.height,
          ratio: Number((info.width / info.height).toFixed(4))
        };
        setBoundedCache(imageDimCache, filePath, res);
        return res;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ==================== NATIVE ZIP / EPUB & PDF PARSERS ====================
function safeCoverCachePath(bookId) {
  const hash = crypto.createHash('md5').update(String(bookId)).digest('hex').slice(0, 12);
  const clean = String(bookId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return path.join(COVERS_CACHE_DIR, `${clean}_${hash}.jpg`);
}

function readZipArchive(zipFilePath) {
  const stat = fs.statSync(zipFilePath);
  if (!stat.isFile() || stat.size > MAX_EPUB_FILE_BYTES) {
    throw new Error('EPUB-fil er for stor');
  }
  const buf = fs.readFileSync(zipFilePath);
  let eocdOffset = -1;
  const minSearch = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return new Map();

  const cdCount = Math.min(MAX_ZIP_ENTRIES, buf.readUInt16LE(eocdOffset + 10));
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= buf.length) return new Map();
  const entries = new Map();

  let ptr = cdOffset;
  for (let i = 0; i < cdCount && ptr + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    if (ptr + 46 + nameLen > buf.length) break;
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8').replace(/\\/g, '/');

    entries.set(name, {
      name,
      method,
      compSize,
      uncompSize,
      localHeaderOffset
    });

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  function extractEntry(entryName) {
    const normalized = String(entryName).replace(/^\/+/, '');
    let info = entries.get(normalized);
    if (!info) {
      const lower = normalized.toLowerCase();
      for (const [k, v] of entries.entries()) {
        if (k.toLowerCase() === lower) {
          info = v;
          break;
        }
      }
    }
    if (!info) return null;
    if (info.compSize > MAX_ZIP_ENTRY_BYTES || info.uncompSize > MAX_ZIP_ENTRY_BYTES) {
      return null;
    }

    const lho = info.localHeaderOffset;
    if (lho < 0 || lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    if (dataStart < 0 || dataStart + info.compSize > buf.length) return null;
    const compSlice = buf.subarray(dataStart, dataStart + info.compSize);

    try {
      if (info.method === 0) return Buffer.from(compSlice);
      if (info.method === 8) {
        return zlib.inflateRawSync(compSlice, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      }
    } catch {
      return null;
    }
    return null;
  }

  return { entries, extractEntry };
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function escapeHtmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const EPUB_BLOCKED_CONTAINER_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
  'form', 'input', 'button', 'textarea', 'select', 'link', 'meta',
  'base', 'template', 'noscript', 'applet', 'audio', 'video',
  'source', 'canvas'
]);

const EPUB_ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'div', 'span', 'blockquote', 'pre', 'code', 'em', 'strong', 'i', 'b', 'u', 's',
  'sub', 'sup', 'small', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'img', 'a', 'section', 'article', 'aside',
  'header', 'footer', 'nav', 'ruby', 'rt', 'rp'
]);

const EPUB_VOID_TAGS = new Set(['br', 'hr', 'img']);

function parseHtmlAttributes(attrStr) {
  const attrs = [];
  let i = 0;
  const len = attrStr.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrStr[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrStr[i])) i++;
    const name = attrStr.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < len && /\s/.test(attrStr[i])) i++;
    let value = '';
    if (i < len && attrStr[i] === '=') {
      i++;
      while (i < len && /\s/.test(attrStr[i])) i++;
      if (i < len && (attrStr[i] === '"' || attrStr[i] === "'")) {
        const quote = attrStr[i++];
        const valStart = i;
        while (i < len && attrStr[i] !== quote) i++;
        value = attrStr.slice(valStart, i);
        if (i < len && attrStr[i] === quote) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrStr[i])) i++;
        value = attrStr.slice(valStart, i);
      }
    }
    attrs.push([name, value]);
  }
  return attrs;
}

function isSafeEpubHref(rawVal) {
  const decoded = decodeXmlEntities(rawVal).replace(/[\u0000-\u0020]+/g, '').trim();
  if (!decoded) return null;
  if (decoded.startsWith('#')) return decoded;
  try {
    const u = new URL(decoded);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      return decoded;
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeEpubHtml(html) {
  const input = String(html || '');
  const out = [];
  const blockedStack = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      if (blockedStack.length === 0) {
        out.push(input.slice(i));
      }
      break;
    }

    if (lt > i && blockedStack.length === 0) {
      out.push(input.slice(i, lt));
    }

    // Comment <!-- ... -->
    if (input.startsWith('<!--', lt)) {
      const endComment = input.indexOf('-->', lt + 4);
      i = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // Processing instruction / DOCTYPE / CDATA
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const gt = input.indexOf('>', lt + 2);
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Scan tag end respecting quotes
    let pos = lt + 1;
    let quote = null;
    while (pos < len) {
      const ch = input[pos];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      pos++;
    }

    if (pos >= len) {
      if (blockedStack.length === 0) {
        out.push('&lt;' + input.slice(lt + 1).replace(/</g, '&lt;'));
      }
      break;
    }

    const rawTag = input.slice(lt + 1, pos).trim();
    i = pos + 1;

    if (!rawTag) continue;
    const isClose = rawTag.startsWith('/');
    const body = isClose ? rawTag.slice(1).trim() : rawTag;
    const tagMatch = body.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!tagMatch) {
      if (blockedStack.length === 0) out.push('&lt;');
      continue;
    }

    const tagName = tagMatch[1].toLowerCase();
    const isSelfClosing = !isClose && body.endsWith('/');
    const attrPart = isClose
      ? ''
      : body.slice(tagMatch[0].length, isSelfClosing ? body.length - 1 : body.length);

    if (EPUB_BLOCKED_CONTAINER_TAGS.has(tagName)) {
      if (isClose) {
        const idx = blockedStack.lastIndexOf(tagName);
        if (idx !== -1) blockedStack.splice(idx);
      } else if (!isSelfClosing) {
        blockedStack.push(tagName);
      }
      continue;
    }

    if (blockedStack.length > 0) {
      continue;
    }

    if (!EPUB_ALLOWED_TAGS.has(tagName)) {
      continue;
    }

    if (isClose) {
      if (!EPUB_VOID_TAGS.has(tagName)) {
        out.push(`</${tagName}>`);
      }
      continue;
    }

    const rawAttrs = parseHtmlAttributes(attrPart);
    const safeAttrs = [];

    if (tagName === 'img') {
      for (const [k, v] of rawAttrs) {
        if (k === 'src') {
          const srcClean = decodeXmlEntities(v).trim();
          if (srcClean.startsWith('/epub-resource/') && !/[\s\u0000-\u001f]/.test(srcClean)) {
            safeAttrs.push(`src="${escapeHtmlAttr(srcClean)}"`);
          }
        } else if (k === 'alt') {
          safeAttrs.push(`alt="${escapeHtmlAttr(decodeXmlEntities(v).slice(0, 300))}"`);
        }
      }
    } else if (tagName === 'a') {
      for (const [k, v] of rawAttrs) {
        if (k === 'href') {
          const safeHref = isSafeEpubHref(v);
          if (safeHref) {
            safeAttrs.push(`href="${escapeHtmlAttr(safeHref)}"`);
            if (safeHref.startsWith('http://') || safeHref.startsWith('https://')) {
              safeAttrs.push('rel="noopener noreferrer" target="_blank"');
            }
          }
        } else if (k === 'data-epub-href') {
          const cleanRef = decodeXmlEntities(v).trim();
          if (cleanRef && !cleanRef.includes(':') && !/[\u0000-\u001f]/.test(cleanRef)) {
            safeAttrs.push(`data-epub-href="${escapeHtmlAttr(cleanRef.slice(0, 300))}"`);
          }
        } else if (k === 'title') {
          safeAttrs.push(`title="${escapeHtmlAttr(decodeXmlEntities(v).slice(0, 200))}"`);
        }
      }
    } else if (tagName === 'td' || tagName === 'th') {
      for (const [k, v] of rawAttrs) {
        if (k === 'colspan' || k === 'rowspan') {
          const num = parseInt(v, 10);
          if (Number.isInteger(num) && num >= 1 && num <= 100) {
            safeAttrs.push(`${k}="${num}"`);
          }
        }
      }
    }

    const attrOut = safeAttrs.length > 0 ? ' ' + safeAttrs.join(' ') : '';
    out.push(EPUB_VOID_TAGS.has(tagName) ? `<${tagName}${attrOut} />` : `<${tagName}${attrOut}>`);
  }

  return out.join('');
}

const epubCache = new Map();
function parseEpubData(epubFilePath, bookId) {
  try {
    const stat = fs.statSync(epubFilePath);
    const cached = epubCache.get(epubFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const zip = readZipArchive(epubFilePath);
    if (!zip.extractEntry) return null;

    const containerBuf = zip.extractEntry('META-INF/container.xml');
    let opfPath = '';
    if (containerBuf) {
      const xml = containerBuf.toString('utf8');
      const m = xml.match(/full-path\s*=\s*["']([^"']+)["']/i);
      if (m) opfPath = m[1];
    }
    if (!opfPath) {
      for (const k of zip.entries.keys()) {
        if (k.toLowerCase().endsWith('.opf')) {
          opfPath = k;
          break;
        }
      }
    }
    if (!opfPath) return null;

    const opfDir = path.posix.dirname(opfPath);
    const resolveRel = (relHref) => {
      if (!relHref) return '';
      const clean = relHref.split('#')[0];
      return opfDir === '.' ? clean : path.posix.normalize(path.posix.join(opfDir, clean));
    };

    const opfBuf = zip.extractEntry(opfPath);
    if (!opfBuf) return null;
    const opfXml = opfBuf.toString('utf8');

    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const epubTitle = titleMatch ? decodeXmlEntities(titleMatch[1].trim()).slice(0, 140) : null;

    // Parse manifest items
    const manifest = new Map();
    const itemRegex = /<item\b([^>]+?)\/?>/gi;
    let match;
    while ((match = itemRegex.exec(opfXml)) !== null) {
      const attrs = match[1];
      const idM = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
      const hrefM = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      const typeM = attrs.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i);
      const propM = attrs.match(/\bproperties\s*=\s*["']([^"']+)["']/i);
      if (idM && hrefM) {
        const decodedHref = safeDecodeURIComponent(hrefM[1]) || hrefM[1];
        manifest.set(idM[1], {
          id: idM[1],
          href: decodedHref,
          fullPath: resolveRel(decodedHref),
          mediaType: typeM ? typeM[1].toLowerCase() : '',
          properties: propM ? propM[1].toLowerCase() : ''
        });
      }
    }

    // Find cover image in manifest
    let coverItem = null;
    const metaCoverM =
      opfXml.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
      opfXml.match(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i);
    if (metaCoverM && manifest.has(metaCoverM[1])) {
      coverItem = manifest.get(metaCoverM[1]);
    }
    if (!coverItem) {
      for (const item of manifest.values()) {
        if (item.properties.includes('cover-image') && item.mediaType.startsWith('image/')) {
          coverItem = item;
          break;
        }
      }
    }
    if (!coverItem) {
      for (const item of manifest.values()) {
        if (
          item.mediaType.startsWith('image/') &&
          (item.id.toLowerCase().includes('cover') || item.href.toLowerCase().includes('cover'))
        ) {
          coverItem = item;
          break;
        }
      }
    }
    if (!coverItem) {
      for (const item of manifest.values()) {
        if (item.mediaType.startsWith('image/')) {
          coverItem = item;
          break;
        }
      }
    }

    const coverCacheFile = safeCoverCachePath(bookId);
    if (coverItem && !fs.existsSync(coverCacheFile)) {
      const imgBuf = zip.extractEntry(coverItem.fullPath);
      if (imgBuf && imgBuf.length > 0 && imgBuf.length <= MAX_COVER_BYTES && isValidImageBuffer(imgBuf)) {
        try {
          fs.writeFileSync(coverCacheFile, imgBuf);
        } catch {
          // ignore
        }
      }
    }

    // Parse spine itemrefs
    const spineIds = [];
    const itemrefRegex = /<itemref\b([^>]+?)\/?>/gi;
    while ((match = itemrefRegex.exec(opfXml)) !== null) {
      const idrefM = match[1].match(/\bidref\s*=\s*["']([^"']+)["']/i);
      if (idrefM && manifest.has(idrefM[1])) {
        spineIds.push(idrefM[1]);
      }
    }

    const pages = [];
    const hrefToPageIndex = new Map();
    const encodedBookId = encodeURIComponent(bookId);

    spineIds.forEach((idref) => {
      const item = manifest.get(idref);
      if (!item) return;
      const rawBuf = zip.extractEntry(item.fullPath);
      if (!rawBuf) return;
      const htmlStr = rawBuf.toString('utf8');
      const bodyMatch = htmlStr.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      let bodyHtml = bodyMatch ? bodyMatch[1] : htmlStr;

      const sectionDir = path.posix.dirname(item.fullPath);
      bodyHtml = bodyHtml.replace(
        /\b(src|href|xlink:href)\s*=\s*["']([^"']+)["']/gi,
        (full, attr, val) => {
          if (/^(https?:|mailto:|#)/i.test(val)) return full;
          if (/^(javascript:|vbscript:|data:)/i.test(val.trim())) return `${attr}="#"`;
          const cleanVal = val.split('#')[0];
          const resolved =
            sectionDir === '.'
              ? cleanVal
              : path.posix.normalize(path.posix.join(sectionDir, cleanVal));
          if (attr.toLowerCase() === 'href' && /\.(xhtml|html|htm)$/i.test(cleanVal)) {
            return `data-epub-href="${escapeHtmlAttr(resolved)}"`;
          }
          const ext = path.posix.extname(resolved).toLowerCase();
          if (!EPUB_SAFE_ASSET_EXTS.has(ext)) {
            return '';
          }
          return `${attr}="/epub-resource/${encodedBookId}/${encodeURIComponent(resolved)}"`;
        }
      );

      bodyHtml = sanitizeEpubHtml(bodyHtml);
      if (!bodyHtml.trim()) return;

      hrefToPageIndex.set(item.fullPath, pages.length);
      hrefToPageIndex.set(item.href, pages.length);

      pages.push({
        filename: item.fullPath,
        label: `Del ${pages.length + 1}`,
        shortLabel: `Side ${pages.length + 1}`,
        type: 'epub-section',
        pageNumber: pages.length + 1,
        html: bodyHtml
      });
    });

    // Parse Table of Contents (NCX) without catastrophic backtracking regex
    const autoChapters = [];
    let ncxItem = null;
    for (const item of manifest.values()) {
      if (item.mediaType.includes('dtbncx') || item.href.toLowerCase().endsWith('.ncx')) {
        ncxItem = item;
        break;
      }
    }
    if (ncxItem) {
      const ncxBuf = zip.extractEntry(ncxItem.fullPath);
      if (ncxBuf) {
        const ncxXml = ncxBuf.toString('utf8');
        const ncxDir = path.posix.dirname(ncxItem.fullPath);
        let searchPos = 0;
        while (autoChapters.length < 500) {
          const startIdx = ncxXml.indexOf('<navPoint', searchPos);
          if (startIdx === -1) break;
          const tagEnd = ncxXml.indexOf('>', startIdx);
          if (tagEnd === -1) break;
          const nextStart = ncxXml.indexOf('<navPoint', tagEnd + 1);
          const closeIdx = ncxXml.indexOf('</navPoint>', tagEnd + 1);
          let sliceEnd = ncxXml.length;
          if (closeIdx !== -1 && (nextStart === -1 || closeIdx < nextStart)) {
            sliceEnd = closeIdx;
          } else if (nextStart !== -1) {
            sliceEnd = nextStart;
          }
          const chunk = ncxXml.slice(tagEnd + 1, Math.min(sliceEnd, tagEnd + 4096));
          searchPos = tagEnd + 1;

          const textM = chunk.match(/<text\b[^>]*>([^<]{0,300})<\/text>/i);
          const contentM = chunk.match(/<content\b[^>]*\bsrc\s*=\s*["']([^"']{1,500})["']/i);
          if (textM && contentM) {
            const chTitle = decodeXmlEntities(textM[1].trim()).slice(0, 140);
            const rawSrcPart = contentM[1].split('#')[0];
            const decodedSrc = safeDecodeURIComponent(rawSrcPart) || rawSrcPart;
            if (chTitle && decodedSrc) {
              const fullTarget =
                ncxDir === '.' ? decodedSrc : path.posix.normalize(path.posix.join(ncxDir, decodedSrc));
              const pIdx = hrefToPageIndex.get(fullTarget) ?? hrefToPageIndex.get(decodedSrc) ?? 0;
              autoChapters.push({
                id: `epub-ch-${autoChapters.length}`,
                title: chTitle,
                pageIndex: pIdx,
                pageLabel: `Side ${pIdx + 1}`
              });
            }
          }
        }
      }
    }

    const result = {
      epubTitle,
      hasExtractedCover: fs.existsSync(coverCacheFile),
      coverCacheFile,
      pages,
      autoChapters
    };

    setBoundedCache(epubCache, epubFilePath, { mtimeMs: stat.mtimeMs, data: result });
    return result;
  } catch (err) {
    console.error('EPUB parse feil:', err.message);
    return null;
  }
}

const pdfInfoCache = new Map();
function inspectPdfFile(pdfFilePath) {
  try {
    const stat = fs.statSync(pdfFilePath);
    const cached = pdfInfoCache.get(pdfFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const readSize = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(pdfFilePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
    const str = buf.toString('latin1');

    let pageCount = 0;
    const typePageMatches = str.match(/\/Type\s*\/Page\b(?!s)/g);
    if (typePageMatches && typePageMatches.length > 0) {
      pageCount = typePageMatches.length;
    }
    const countMatches = [...str.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,240}?\/Count\s+(\d+)/g)];
    for (const m of countMatches) {
      const c = parseInt(m[1], 10);
      if (c > pageCount) pageCount = c;
    }
    if (pageCount <= 0) pageCount = 1;

    let ratio = 0.707;
    const mediaBoxM = str.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    if (mediaBoxM) {
      const w = parseFloat(mediaBoxM[3]) - parseFloat(mediaBoxM[1]);
      const h = parseFloat(mediaBoxM[4]) - parseFloat(mediaBoxM[2]);
      if (w > 0 && h > 0) {
        ratio = Number((w / h).toFixed(4));
      }
    }

    const data = { pageCount, ratio };
    setBoundedCache(pdfInfoCache, pdfFilePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return { pageCount: 1, ratio: 0.707 };
  }
}

function parseBookFolder(booksDir, folderName) {
  if (!isValidBookId(folderName)) return null;
  const folderPath = path.join(booksDir, folderName);
  if (!isPathInsideDir(booksDir, folderPath)) return null;
  if (!fs.existsSync(folderPath)) return null;
  const stat = fs.statSync(folderPath);
  const encodedBookId = encodeURIComponent(folderName);
  const meta = loadBookMeta(booksDir, folderName);

  // Case 1: Standalone .pdf or .epub file directly inside booksDir
  if (stat.isFile()) {
    const ext = path.extname(folderName).toLowerCase();
    if (!EBOOK_EXTENSIONS.has(ext)) return null;
    const format = ext === '.pdf' ? 'pdf' : 'epub';
    const baseTitle = path.parse(folderName).name;
    const coverCacheFile = safeCoverCachePath(folderName);

    if (format === 'epub') {
      const epubInfo = parseEpubData(folderPath, folderName);
      if (!epubInfo) return null;
      const hasCover = fs.existsSync(coverCacheFile);
      const c1Dim = hasCover
        ? readImageDimensions(coverCacheFile) || { width: 1400, height: 2000, ratio: 0.7 }
        : { width: 1400, height: 2000, ratio: 0.7 };
      const c2Dim = { width: Math.round(c1Dim.height * 0.065), height: c1Dim.height, ratio: 0.065 };
      const coverUrl = hasCover ? `/book-media/${encodedBookId}/__cover` : null;

      const totalPages = Math.max(1, epubInfo.pages.length);
      const chapters = meta.chapters.length > 0 ? meta.chapters : epubInfo.autoChapters;
      const originalTitle = epubInfo.epubTitle || baseTitle;

      return {
        id: folderName,
        title: meta.title || originalTitle,
        originalTitle,
        customTitle: meta.title || '',
        adminOnly: Boolean(meta.adminOnly),
        format: 'epub',
        ebookUrl: `/book-media/${encodedBookId}/__ebook`,
        sizeScale: meta.sizeScale || 1.0,
        covers: {
          c1: coverUrl,
          c2: coverUrl,
          c3: coverUrl,
          hasC1: hasCover,
          hasC2: false,
          hasC3: false,
          dims: { c1: c1Dim, c2: c2Dim, c3: c1Dim }
        },
        contentPageCount: totalPages,
        totalPages,
        forsatsAlene: meta.forsatsAlene,
        chapters,
        pages: epubInfo.pages.map((p, index) => ({ ...p, index }))
      };
    }

    // Standalone PDF file
    const pdfInfo = inspectPdfFile(folderPath);
    const hasCover = fs.existsSync(coverCacheFile);
    const c1Dim = hasCover
      ? readImageDimensions(coverCacheFile) || { width: 1414, height: 2000, ratio: pdfInfo.ratio }
      : { width: Math.round(2000 * pdfInfo.ratio), height: 2000, ratio: pdfInfo.ratio };
    const c2Dim = { width: Math.round(c1Dim.height * 0.065), height: c1Dim.height, ratio: 0.065 };
    const coverUrl = hasCover ? `/book-media/${encodedBookId}/__cover` : null;
    const totalPages = meta.pageCount || pdfInfo.pageCount || 1;

    const pages = Array.from({ length: totalPages }, (_, idx) => ({
      index: idx,
      filename: `page-${idx + 1}.pdf`,
      label: idx === 0 ? 'Forsats / Side 1' : `Side ${idx + 1}`,
      shortLabel: `Side ${idx + 1}`,
      type: idx === 0 ? 'c1' : 'page',
      pageNumber: idx + 1,
      pdfPageNumber: idx + 1
    }));

    return {
      id: folderName,
      title: meta.title || baseTitle,
      originalTitle: baseTitle,
      customTitle: meta.title || '',
      adminOnly: Boolean(meta.adminOnly),
      format: 'pdf',
      ebookUrl: `/book-media/${encodedBookId}/__ebook`,
      sizeScale: meta.sizeScale || 1.0,
      covers: {
        c1: coverUrl,
        c2: coverUrl,
        c3: coverUrl,
        hasC1: hasCover,
        hasC2: false,
        hasC3: false,
        dims: { c1: c1Dim, c2: c2Dim, c3: c1Dim }
      },
      contentPageCount: totalPages,
      totalPages,
      forsatsAlene: meta.forsatsAlene,
      chapters: meta.chapters,
      pages
    };
  }

  // Case 2: Subfolder inside booksDir
  if (!stat.isDirectory()) return null;
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const imageFiles = entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalCollator.compare);

  const ebookFiles = entries
    .filter((e) => e.isFile() && EBOOK_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalCollator.compare);

  let c1 = null;
  let c2 = null;
  let c3 = null;
  const contentPages = [];

  for (const file of imageFiles) {
    const base = path.parse(file).name.toLowerCase();
    if (base === 'c1' && !c1) {
      c1 = file;
    } else if (base === 'c2' && !c2) {
      c2 = file;
    } else if (base === 'c3' && !c3) {
      c3 = file;
    } else {
      contentPages.push(file);
    }
  }

  const mediaUrl = (filename) =>
    filename ? `/book-media/${encodedBookId}/${encodeURIComponent(filename)}` : null;

  if (contentPages.length === 0 && ebookFiles.length > 0) {
    const ebookFile = ebookFiles[0];
    const ext = path.extname(ebookFile).toLowerCase();
    const ebookFullPath = path.join(folderPath, ebookFile);
    if (!isPathInsideDir(folderPath, ebookFullPath)) return null;
    const coverCacheFile = safeCoverCachePath(folderName);

    if (ext === '.epub') {
      const epubInfo = parseEpubData(ebookFullPath, folderName);
      if (!epubInfo) return null;
      const hasExtracted = fs.existsSync(coverCacheFile);
      const c1Path = c1 ? path.join(folderPath, c1) : hasExtracted ? coverCacheFile : null;
      const c2Path = c2 ? path.join(folderPath, c2) : null;
      const c3Path = c3 ? path.join(folderPath, c3) : c1Path;

      const c1Dim = readImageDimensions(c1Path) || { width: 1400, height: 2000, ratio: 0.7 };
      const c2Dim = c2Path
        ? readImageDimensions(c2Path) || { width: 120, height: 2000, ratio: 0.06 }
        : { width: Math.round(c1Dim.height * 0.065), height: c1Dim.height, ratio: 0.065 };
      const c3Dim = readImageDimensions(c3Path) || c1Dim;

      const c1Url = c1 ? mediaUrl(c1) : hasExtracted ? `/book-media/${encodedBookId}/__cover` : null;
      const c2Url = c2 ? mediaUrl(c2) : c1Url;
      const c3Url = c3 ? mediaUrl(c3) : c1Url;

      const totalPages = Math.max(1, epubInfo.pages.length);
      const chapters = meta.chapters.length > 0 ? meta.chapters : epubInfo.autoChapters;

      return {
        id: folderName,
        title: meta.title || folderName,
        originalTitle: folderName,
        customTitle: meta.title || '',
        adminOnly: Boolean(meta.adminOnly),
        format: 'epub',
        ebookFile,
        ebookUrl: mediaUrl(ebookFile),
        sizeScale: meta.sizeScale || 1.0,
        covers: {
          c1: c1Url,
          c2: c2Url,
          c3: c3Url,
          hasC1: Boolean(c1 || hasExtracted),
          hasC2: Boolean(c2),
          hasC3: Boolean(c3),
          dims: { c1: c1Dim, c2: c2Dim, c3: c3Dim }
        },
        contentPageCount: totalPages,
        totalPages,
        forsatsAlene: meta.forsatsAlene,
        chapters,
        pages: epubInfo.pages.map((p, index) => ({ ...p, index }))
      };
    }

    // Folder with a .pdf file
    const pdfInfo = inspectPdfFile(ebookFullPath);
    const hasExtracted = fs.existsSync(coverCacheFile);
    const c1Path = c1 ? path.join(folderPath, c1) : hasExtracted ? coverCacheFile : null;
    const c2Path = c2 ? path.join(folderPath, c2) : null;
    const c3Path = c3 ? path.join(folderPath, c3) : c1Path;

    const c1Dim = readImageDimensions(c1Path) || {
      width: Math.round(2000 * pdfInfo.ratio),
      height: 2000,
      ratio: pdfInfo.ratio
    };
    const c2Dim = c2Path
      ? readImageDimensions(c2Path) || { width: 120, height: 2000, ratio: 0.06 }
      : { width: Math.round(c1Dim.height * 0.065), height: c1Dim.height, ratio: 0.065 };
    const c3Dim = readImageDimensions(c3Path) || c1Dim;

    const c1Url = c1 ? mediaUrl(c1) : hasExtracted ? `/book-media/${encodedBookId}/__cover` : null;
    const c2Url = c2 ? mediaUrl(c2) : c1Url;
    const c3Url = c3 ? mediaUrl(c3) : c1Url;
    const totalPages = meta.pageCount || pdfInfo.pageCount || 1;

    const pages = Array.from({ length: totalPages }, (_, idx) => ({
      index: idx,
      filename: `page-${idx + 1}.pdf`,
      label: idx === 0 ? 'Forsats / Side 1' : `Side ${idx + 1}`,
      shortLabel: `Side ${idx + 1}`,
      type: idx === 0 ? 'c1' : 'page',
      pageNumber: idx + 1,
      pdfPageNumber: idx + 1
    }));

    return {
      id: folderName,
      title: meta.title || folderName,
      originalTitle: folderName,
      customTitle: meta.title || '',
      adminOnly: Boolean(meta.adminOnly),
      format: 'pdf',
      ebookFile,
      ebookUrl: mediaUrl(ebookFile),
      sizeScale: meta.sizeScale || 1.0,
      covers: {
        c1: c1Url,
        c2: c2Url,
        c3: c3Url,
        hasC1: Boolean(c1 || hasExtracted),
        hasC2: Boolean(c2),
        hasC3: Boolean(c3),
        dims: { c1: c1Dim, c2: c2Dim, c3: c3Dim }
      },
      contentPageCount: totalPages,
      totalPages,
      forsatsAlene: meta.forsatsAlene,
      chapters: meta.chapters,
      pages
    };
  }

  if (imageFiles.length === 0) return null;

  const readingPages = [];
  if (c1) {
    readingPages.push({
      filename: c1,
      label: 'Forsats',
      shortLabel: 'Forsats',
      type: 'c1'
    });
  }
  contentPages.forEach((file, idx) => {
    const baseName = path.parse(file).name;
    readingPages.push({
      filename: file,
      label: `Side ${idx + 1} (${baseName})`,
      shortLabel: `Side ${idx + 1}`,
      rawName: baseName,
      type: 'page',
      pageNumber: idx + 1
    });
  });
  if (c3) {
    readingPages.push({
      filename: c3,
      label: 'Baksats',
      shortLabel: 'Baksats',
      type: 'c3'
    });
  }

  if (readingPages.length === 0 && c2) {
    readingPages.push({
      filename: c2,
      label: 'Rygg',
      shortLabel: 'Rygg',
      type: 'c2'
    });
  }

  const fallbackFront = c1 || contentPages[0] || c2 || c3;

  const resolvedChapters = meta.chapters.map((ch) => {
    let pageIdx = typeof ch.pageIndex === 'number' ? ch.pageIndex : 0;
    if (ch.pageFile) {
      const foundIdx = readingPages.findIndex(
        (p) => p.filename.toLowerCase() === String(ch.pageFile).toLowerCase()
      );
      if (foundIdx !== -1) pageIdx = foundIdx;
    }
    pageIdx = Math.max(0, Math.min(readingPages.length - 1, pageIdx));
    const pageObj = readingPages[pageIdx];
    return {
      id: ch.id || `ch-${pageIdx}`,
      title: ch.title || 'Kapittel',
      pageIndex: pageIdx,
      pageFile: pageObj ? pageObj.filename : ch.pageFile,
      pageLabel: pageObj ? pageObj.shortLabel : `Side ${pageIdx + 1}`
    };
  });

  const c1File = fallbackFront ? path.join(folderPath, fallbackFront) : null;
  const c2File = (c2 || fallbackFront) ? path.join(folderPath, c2 || fallbackFront) : null;
  const c3File = (c3 || fallbackFront) ? path.join(folderPath, c3 || fallbackFront) : null;

  const c1Dim = readImageDimensions(c1File) || { width: 1460, height: 2000, ratio: 0.73 };
  const c2Dim = c2
    ? readImageDimensions(c2File) || { width: 120, height: 2000, ratio: 0.06 }
    : { width: Math.round(c1Dim.height * 0.062), height: c1Dim.height, ratio: 0.062 };
  const c3Dim = readImageDimensions(c3File) || c1Dim;

  return {
    id: folderName,
    title: meta.title || folderName,
    originalTitle: folderName,
    customTitle: meta.title || '',
    adminOnly: Boolean(meta.adminOnly),
    format: 'images',
    sizeScale: meta.sizeScale || 1.0,
    covers: {
      c1: mediaUrl(fallbackFront),
      c2: mediaUrl(c2 || fallbackFront),
      c3: mediaUrl(c3 || fallbackFront),
      hasC1: Boolean(c1),
      hasC2: Boolean(c2),
      hasC3: Boolean(c3),
      dims: {
        c1: c1Dim,
        c2: c2Dim,
        c3: c3Dim
      }
    },
    contentPageCount: contentPages.length,
    totalPages: readingPages.length,
    forsatsAlene: meta.forsatsAlene,
    chapters: resolvedChapters,
    pages: readingPages.map((p, index) => ({
      ...p,
      index,
      url: mediaUrl(p.filename)
    }))
  };
}

function scanAllBooks() {
  const config = getRuntimeConfig();
  const booksDir = config.booksDir;
  if (!fs.existsSync(booksDir)) {
    return [];
  }

  let dirEntries;
  try {
    dirEntries = fs.readdirSync(booksDir, { withFileTypes: true });
  } catch (err) {
    console.error('Kunne ikke lese bokmappe:', err.message);
    return [];
  }

  const candidateNames = dirEntries
    .filter((e) => {
      if (!isValidBookId(e.name)) return false;
      if (e.isDirectory()) return true;
      if (e.isFile() && EBOOK_EXTENSIONS.has(path.extname(e.name).toLowerCase())) return true;
      return false;
    })
    .map((e) => e.name);

  const books = [];
  for (const name of candidateNames) {
    const parsed = parseBookFolder(booksDir, name);
    if (parsed) {
      books.push(parsed);
    }
  }
  books.sort((a, b) => naturalCollator.compare(a.title, b.title));
  return books;
}

// ==================== NATIVE JPEG -> PDF & ZIP EXPORT HELPERS ====================
function getJpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { width: 800, height: 1200, components: 3 };
  }
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      const components = buf[offset + 9] || 3;
      return {
        width: width || 800,
        height: height || 1200,
        components
      };
    }
    offset += 2 + len;
  }
  return { width: 800, height: 1200, components: 3 };
}

function buildPdfFromJpegs(filePaths) {
  const chunks = [];
  let byteOffset = 0;
  const offsets = {};

  function pushStr(str) {
    const b = Buffer.from(str, 'binary');
    chunks.push(b);
    byteOffset += b.length;
  }

  function pushBuf(b) {
    chunks.push(b);
    byteOffset += b.length;
  }

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const pageCount = filePaths.length;
  const totalObjects = 2 + pageCount * 3;
  const pageObjIds = [];

  for (let i = 0; i < pageCount; i++) {
    const pageObjId = 3 + i * 3;
    const contentObjId = 4 + i * 3;
    const imageObjId = 5 + i * 3;
    pageObjIds.push(pageObjId);

    const imgBuf = fs.readFileSync(filePaths[i]);
    const info = getJpegInfo(imgBuf);
    const colorSpace = info.components === 1 ? '/DeviceGray' : '/DeviceRGB';

    const pdfW = 595.28;
    const pdfH = Math.round(((pdfW * info.height) / info.width) * 100) / 100;

    offsets[imageObjId] = byteOffset;
    pushStr(
      `${imageObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBuf.length} >>\nstream\n`
    );
    pushBuf(imgBuf);
    pushStr('\nendstream\nendobj\n');

    const contentStr = `q\n${pdfW} 0 0 ${pdfH} 0 0 cm\n/Im0 Do\nQ\n`;
    offsets[contentObjId] = byteOffset;
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}endstream\nendobj\n`
    );

    offsets[pageObjId] = byteOffset;
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfW} ${pdfH}] /Resources << /XObject << /Im0 ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );
  }

  offsets[2] = byteOffset;
  const kidsRef = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj\n`);

  offsets[1] = byteOffset;
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const xrefOffset = byteOffset;
  pushStr(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (let objId = 1; objId <= totalObjects; objId++) {
    const off = String(offsets[objId] || 0).padStart(10, '0');
    pushStr(`${off} 00000 n \n`);
  }

  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return Buffer.concat(chunks);
}

function buildZipFromFiles(items) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of items) {
    const fileBuf = fs.readFileSync(item.filePath);
    const nameBuf = Buffer.from(item.name, 'utf8');
    const crc = zlib.crc32(fileBuf) >>> 0;
    const size = fileBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, fileBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ==================== HTTP HELPERS ====================
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        req.pause();
        reject(new HttpError(413, 'Forespørselen er for stor'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'Forventet JSON-objekt'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Ugyldig JSON'));
      }
    });

    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

function streamBinaryUploadToFile(req, tmpPath, ext, maxBytes) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;
    let headerBuf = Buffer.alloc(0);
    let headerChecked = false;
    const outStream = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });

    const fail = (statusCode, message) => {
      if (settled) return;
      settled = true;
      req.pause();
      outStream.destroy();
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      reject(new HttpError(statusCode, message));
    };

    const verifyMagic = (buf) => {
      if (ext === '.pdf') {
        return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
      }
      if (ext === '.epub') {
        return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
      }
      return false;
    };

    outStream.on('error', () => fail(500, 'Kunne ikke lagre opplastet fil'));

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(413, 'Filen er for stor (maks 100 MB)');
        return;
      }
      if (!headerChecked) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= 5) {
          headerChecked = true;
          if (!verifyMagic(headerBuf)) {
            fail(400, `Ugyldig ${ext.toUpperCase()}-fil (signatur stemmer ikke)`);
            return;
          }
        }
      }
      if (!outStream.write(chunk)) {
        req.pause();
        outStream.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });

    req.on('end', () => {
      if (settled) return;
      if (totalBytes === 0 || (!headerChecked && !verifyMagic(headerBuf))) {
        fail(400, `Ugyldig eller tom ${ext.toUpperCase()}-fil`);
        return;
      }
      outStream.end(() => {
        if (!settled) {
          settled = true;
          resolve(totalBytes);
        }
      });
    });

    req.on('error', () => fail(400, 'Avbrutt opplasting'));
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

function serveFile(req, res, filePath, cacheControl = 'public, max-age=3600') {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Ikke funnet');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const rangeHeader = req.headers.range;

    if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parts[0] ? parseInt(parts[0], 10) : 0;
      const end = parts[1] ? Math.min(stats.size - 1, parseInt(parts[1], 10)) : stats.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= stats.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        'Cache-Control': cacheControl
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    const etag = `W/"${stats.size}-${stats.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      ETag: etag
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    stream.pipe(res);
  });
}

// ==================== HTTP SERVER ====================
const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(req, res);

    const rawUrlPath = String(req.url || '/').split('?')[0].split('#')[0];
    if (
      rawUrlPath
        .split('/')
        .some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))
    ) {
      return sendJson(res, 400, { error: 'Ugyldig sti' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Ugyldig URL' });
    }
    if (parsedUrl.origin !== 'http://localhost') {
      return sendJson(res, 400, { error: 'Ugyldig URL' });
    }

    const pathname = parsedUrl.pathname;
    if (pathname.includes('\0') || pathname.toLowerCase().includes('%00')) {
      return sendJson(res, 400, { error: 'Ugyldig sti' });
    }

    // ==================== HEALTHCHECK ====================
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    }

    // ==================== FETCH METADATA & CSRF CHECKS ====================
    if (!checkFetchMetadata(req, pathname)) {
      return sendJson(res, 403, { error: 'Blokkert av sikkerhetspolicy' });
    }

    const isMutation =
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'DELETE' ||
      req.method === 'PATCH';

    if (isMutation) {
      if (!checkOriginForMutation(req)) {
        return sendJson(res, 403, { error: 'Ugyldig opprinnelse' });
      }
      if (pathname.startsWith('/api/')) {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (pathname === '/api/upload-ebook' && req.method === 'POST') {
          if (!contentType.startsWith('application/octet-stream') || req.headers['x-requested-with'] !== 'fetch') {
            return sendJson(res, 415, { error: 'Forventet application/octet-stream' });
          }
        } else if (!contentType.startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Forventet application/json' });
        }
      }
    }

    // ==================== AUTHENTICATION API ====================
    const session = getSessionFromRequest(req);

    if (pathname === '/api/auth/check' && req.method === 'GET') {
      const cfg = getRuntimeConfig();
      return sendJson(res, 200, {
        authenticated: Boolean(session),
        isAdmin: Boolean(session && session.role === 'admin'),
        activeProfileId: session ? session.activeProfileId : null,
        passwordLockedByEnv: cfg.passwordLockedByEnv,
        adminPasswordLockedByEnv: cfg.adminPasswordLockedByEnv
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = getClientIp(req);
      const rl = checkRateLimit(ip);
      if (!rl.allowed) {
        return sendJson(
          res,
          429,
          { error: 'For mange innloggingsforsøk. Prøv igjen senere.' },
          { 'Retry-After': String(rl.retryAfterSec) }
        );
      }

      const body = await readRequestBody(req, 32 * 1024);
      const inputPwd = typeof body.password === 'string' ? body.password : '';
      if (!inputPwd || inputPwd.length > 256) {
        recordFailedAttempt(ip);
        return sendJson(res, 401, { error: 'Feil passord' });
      }

      let matchedRole = null;
      let matchedProfileId = null;

      if (verifyGlobalAdminPassword(inputPwd)) {
        matchedRole = 'admin';
      } else {
        const profilesData = getProfilesData();
        const matchedAdminProfile = profilesData.profiles.find(
          (p) => p.isAdmin && p.adminPasswordHash && verifyPassword(inputPwd, p.adminPasswordHash)
        );
        if (matchedAdminProfile) {
          matchedRole = 'admin';
          matchedProfileId = matchedAdminProfile.id;
        } else if (verifyReaderPassword(inputPwd)) {
          matchedRole = 'user';
        }
      }

      if (!matchedRole) {
        recordFailedAttempt(ip);
        return sendJson(res, 401, { error: 'Feil passord' });
      }

      clearFailedAttempts(ip);
      const newSession = rotateSession(session ? session.id : null, matchedRole, matchedProfileId);
      return sendJson(
        res,
        200,
        {
          ok: true,
          isAdmin: newSession.role === 'admin',
          matchedProfileId
        },
        { 'Set-Cookie': buildSessionSetCookie(req, newSession.id) }
      );
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      if (session) deleteSession(session.id);
      return sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': buildClearSessionCookie(req),
          'Clear-Site-Data': '"cookies", "storage", "cache"'
        }
      );
    }

    // All API, book-media, and epub-resource routes below require an active session
    if (
      (pathname.startsWith('/api/') ||
        pathname.startsWith('/book-media/') ||
        pathname.startsWith('/epub-resource/')) &&
      !session
    ) {
      return sendJson(res, 401, { error: 'Krever innlogging' });
    }

    if (pathname === '/api/auth/admin-unlock' && req.method === 'POST') {
      const ip = getClientIp(req);
      const rl = checkRateLimit(ip);
      if (!rl.allowed) {
        return sendJson(
          res,
          429,
          { error: 'For mange forsøk. Prøv igjen senere.' },
          { 'Retry-After': String(rl.retryAfterSec) }
        );
      }

      const body = await readRequestBody(req, 32 * 1024);
      const inputPwd = typeof body.password === 'string' ? body.password : '';
      const targetProfileId = typeof body.profileId === 'string' && body.profileId ? body.profileId : null;
      const profilesData = getProfilesData();

      let targetProfile = null;
      if (targetProfileId) {
        targetProfile = profilesData.profiles.find((p) => p.id === targetProfileId);
        if (!targetProfile) {
          return sendJson(res, 404, { error: 'Profil ikke funnet' });
        }
      }

      let authorized = false;
      if (inputPwd && inputPwd.length <= 256) {
        if (verifyGlobalAdminPassword(inputPwd)) {
          authorized = true;
        } else if (targetProfile) {
          if (targetProfile.isAdmin && targetProfile.adminPasswordHash) {
            authorized = verifyPassword(inputPwd, targetProfile.adminPasswordHash);
          }
        } else {
          authorized = profilesData.profiles.some(
            (p) => p.isAdmin && p.adminPasswordHash && verifyPassword(inputPwd, p.adminPasswordHash)
          );
        }
      }

      if (!authorized) {
        recordFailedAttempt(ip);
        return sendJson(res, 401, { error: 'Feil admin-passord' });
      }

      clearFailedAttempts(ip);
      const nextActiveProfileId = targetProfile ? targetProfile.id : session.activeProfileId;
      const upgraded = rotateSession(session.id, 'admin', nextActiveProfileId);
      return sendJson(
        res,
        200,
        {
          ok: true,
          isAdmin: true,
          activeProfileId: upgraded.activeProfileId
        },
        { 'Set-Cookie': buildSessionSetCookie(req, upgraded.id) }
      );
    }

    if (pathname === '/api/auth/admin-lock' && req.method === 'POST') {
      const profilesData = getProfilesData();
      let nextProfileId = session.activeProfileId;
      if (nextProfileId) {
        const activeProf = profilesData.profiles.find((p) => p.id === nextProfileId);
        if (!activeProf || activeProf.isAdmin) {
          nextProfileId = null;
        }
      }
      const downgraded = rotateSession(session.id, 'user', nextProfileId);
      return sendJson(
        res,
        200,
        {
          ok: true,
          isAdmin: false,
          activeProfileId: downgraded.activeProfileId
        },
        { 'Set-Cookie': buildSessionSetCookie(req, downgraded.id) }
      );
    }

    if (pathname === '/api/session/profile' && req.method === 'POST') {
      const body = await readRequestBody(req, 16 * 1024);
      const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
      if (!profileId) {
        return sendJson(res, 400, { error: 'Mangler profileId' });
      }
      const profilesData = getProfilesData();
      const target = profilesData.profiles.find((p) => p.id === profileId);
      if (!target) {
        return sendJson(res, 404, { error: 'Profil ikke funnet' });
      }
      if (target.isAdmin && session.role !== 'admin') {
        return sendJson(res, 403, {
          error: 'Admin-tilgang kreves for denne profilen',
          requireAdmin: true
        });
      }
      session.activeProfileId = target.id;
      persistSessions();
      return sendJson(res, 200, {
        ok: true,
        activeProfileId: target.id,
        isAdmin: session.role === 'admin'
      });
    }

    // ==================== ADMIN API ====================
    if (pathname.startsWith('/api/admin/')) {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }

      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        const cfg = getRuntimeConfig();
        const allBooks = scanAllBooks();
        const profilesData = getProfilesData();
        return sendJson(res, 200, {
          books: allBooks.map((b) => ({
            id: b.id,
            title: b.title,
            originalTitle: b.originalTitle || b.id,
            customTitle: b.customTitle || '',
            format: b.format || 'images',
            adminOnly: Boolean(b.adminOnly),
            totalPages: b.totalPages
          })),
          profiles: profilesData.profiles.map((p) => sanitizeProfileSummary(p, true)),
          passwordLockedByEnv: cfg.passwordLockedByEnv,
          adminPasswordLockedByEnv: cfg.adminPasswordLockedByEnv,
          serverInfo: {
            port: PORT,
            lanIps: getLanAddresses()
          }
        });
      }

      if (
        pathname.startsWith('/api/admin/profiles/') &&
        pathname.endsWith('/access') &&
        req.method === 'PUT'
      ) {
        const rawId = pathname.slice(
          '/api/admin/profiles/'.length,
          pathname.length - '/access'.length
        );
        const targetId = safeDecodeURIComponent(rawId);
        if (!targetId) {
          return sendJson(res, 400, { error: 'Ugyldig profil-ID' });
        }

        const body = await readRequestBody(req, 128 * 1024);
        const data = getProfilesData();
        const target = data.profiles.find((p) => p.id === targetId);
        if (!target) {
          return sendJson(res, 404, { error: 'Profil ikke funnet' });
        }

        if (typeof body.isAdmin === 'boolean') {
          if (!body.isAdmin && target.isAdmin) {
            const adminCount = data.profiles.filter((p) => p.isAdmin).length;
            if (adminCount <= 1) {
              return sendJson(res, 400, { error: 'Minst én profil må være administrator' });
            }
          }
          target.isAdmin = body.isAdmin;
          if (!target.isAdmin) {
            target.adminPasswordHash = null;
          }
        }

        if (Array.isArray(body.hiddenBooks)) {
          if (body.hiddenBooks.length > 1000) {
            return sendJson(res, 400, { error: 'For mange skjulte bøker' });
          }
          const cleaned = [];
          for (const item of body.hiddenBooks) {
            if (typeof item !== 'string' || !isValidBookId(item)) {
              return sendJson(res, 400, { error: 'Ugyldig bok-ID i skjulte bøker' });
            }
            if (!cleaned.includes(item)) cleaned.push(item);
          }
          target.hiddenBooks = cleaned;
        }

        if (body.clearAdminPassword === true) {
          target.adminPasswordHash = null;
        } else if (typeof body.adminPassword === 'string' && body.adminPassword.length > 0) {
          if (!target.isAdmin) {
            return sendJson(res, 400, { error: 'Profilen må være admin for å ha personlig admin-passord' });
          }
          if (body.adminPassword.length < 4 || body.adminPassword.length > 128) {
            return sendJson(res, 400, { error: 'Admin-passordet må være mellom 4 og 128 tegn' });
          }
          target.adminPasswordHash = hashPassword(body.adminPassword);
        }

        saveJson(PROFILES_FILE, data);
        return sendJson(res, 200, {
          ok: true,
          profile: sanitizeProfileSummary(target, true)
        });
      }

      if (pathname === '/api/admin/passwords' && req.method === 'POST') {
        const body = await readRequestBody(req, 32 * 1024);
        const cfg = getRuntimeConfig();
        const loadedRaw = loadJson(CONFIG_FILE, {});
        const nextConfig =
          loadedRaw && typeof loadedRaw === 'object' && !Array.isArray(loadedRaw)
            ? { ...loadedRaw }
            : {};

        let updatedAny = false;
        let readerUpdated = false;
        let adminUpdated = false;

        if (typeof body.readerPassword === 'string' && body.readerPassword.length > 0) {
          if (cfg.passwordLockedByEnv) {
            return sendJson(res, 400, {
              error: 'Leserpassordet styres av miljøvariabelen BOKAMI_PASSWORD'
            });
          }
          if (body.readerPassword.length < 4 || body.readerPassword.length > 128) {
            return sendJson(res, 400, { error: 'Leserpassordet må være mellom 4 og 128 tegn' });
          }
          nextConfig.passwordHash = hashPassword(body.readerPassword);
          delete nextConfig.password;
          updatedAny = true;
          readerUpdated = true;
        }

        if (typeof body.adminPassword === 'string' && body.adminPassword.length > 0) {
          if (cfg.adminPasswordLockedByEnv) {
            return sendJson(res, 400, {
              error: 'Admin-passordet styres av miljøvariabelen BOKAMI_ADMIN_PASSWORD'
            });
          }
          if (body.adminPassword.length < 4 || body.adminPassword.length > 128) {
            return sendJson(res, 400, { error: 'Admin-passordet må være mellom 4 og 128 tegn' });
          }
          nextConfig.adminPasswordHash = hashPassword(body.adminPassword);
          updatedAny = true;
          adminUpdated = true;
        }

        if (!updatedAny) {
          return sendJson(res, 400, { error: 'Ingen passord å oppdatere' });
        }

        saveJson(CONFIG_FILE, nextConfig);

        let sessionsChanged = false;
        for (const [sid, s] of sessions.entries()) {
          if (readerUpdated && s.role === 'user') {
            sessions.delete(sid);
            sessionsChanged = true;
          } else if (adminUpdated && s.role === 'admin' && sid !== session.id) {
            sessions.delete(sid);
            sessionsChanged = true;
          }
        }
        if (sessionsChanged) {
          persistSessions();
        }

        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Ukjent admin-endepunkt' });
    }

    // ==================== EXPORT PAGES API (PDF / ZIP) ====================
    if (pathname.startsWith('/api/export/') && req.method === 'GET') {
      const bookId = safeDecodeURIComponent(pathname.slice('/api/export/'.length));
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }

      const config = getRuntimeConfig();
      const book = parseBookFolder(config.booksDir, bookId);
      if (!book || isBookHiddenForProfile(session, resolvedProfile.profile, book.id, book)) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      if (activeExports >= MAX_CONCURRENT_EXPORTS) {
        return sendJson(res, 429, { error: 'For mange samtidige eksporter, prøv igjen straks' });
      }

      const fromPage = Math.max(1, parseInt(parsedUrl.searchParams.get('from'), 10) || 1);
      const toPage = Math.min(
        book.totalPages,
        Math.max(fromPage, parseInt(parsedUrl.searchParams.get('to'), 10) || fromPage)
      );
      const format = (parsedUrl.searchParams.get('format') || 'pdf').toLowerCase();
      if (format !== 'pdf' && format !== 'zip') {
        return sendJson(res, 400, { error: 'Ugyldig eksportformat' });
      }

      const folderPath = path.join(config.booksDir, bookId);
      const selectedPages = book.pages.slice(fromPage - 1, toPage);
      const fileItems = [];
      let totalSourceBytes = 0;

      for (const p of selectedPages) {
        if (!isValidBookId(p.filename)) continue;
        const ext = path.extname(p.filename).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        const filePath = path.join(folderPath, p.filename);
        if (!isPathInsideDir(folderPath, filePath) || !fs.existsSync(filePath)) continue;
        const st = fs.statSync(filePath);
        if (!st.isFile()) continue;
        totalSourceBytes += st.size;
        if (totalSourceBytes > MAX_EXPORT_BYTES) {
          return sendJson(res, 413, { error: 'Valgt eksportområde er for stort (maks 150 MB)' });
        }
        fileItems.push({
          name: `${String(p.index + 1).padStart(4, '0')}_${p.filename}`,
          filePath
        });
      }

      if (fileItems.length === 0) {
        return sendJson(res, 404, { error: 'Ingen sider funnet i valgt område' });
      }

      const safeTitle = book.title.replace(/[^a-zA-Z0-9æøåÆØÅ _-]/g, '').trim() || 'bok';
      const rangeLabel = fromPage === toPage ? `side-${fromPage}` : `side-${fromPage}-${toPage}`;

      activeExports++;
      try {
        if (format === 'zip') {
          const zipBuf = buildZipFromFiles(fileItems);
          const outName = encodeURIComponent(`${safeTitle}_${rangeLabel}.zip`);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zipBuf.length,
            'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${outName}`
          });
          return res.end(zipBuf);
        } else {
          const pdfBuf = buildPdfFromJpegs(fileItems.map((f) => f.filePath));
          const outName = encodeURIComponent(`${safeTitle}_${rangeLabel}.pdf`);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuf.length,
            'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${outName}`
          });
          return res.end(pdfBuf);
        }
      } finally {
        activeExports--;
      }
    }

    // ==================== PROFILES API ====================
    if (pathname === '/api/profiles' && req.method === 'GET') {
      const data = getProfilesData();
      const isAdmin = session.role === 'admin';
      const profilesSummary = data.profiles.map((p) => sanitizeProfileSummary(p, isAdmin));
      return sendJson(res, 200, {
        profiles: profilesSummary,
        isAdmin,
        activeProfileId: session.activeProfileId
      });
    }

    if (pathname === '/api/profiles' && req.method === 'POST') {
      const body = await readRequestBody(req, 512 * 1024);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) {
        return sendJson(res, 400, { error: 'Navn kan ikke være tomt' });
      }
      const avatar = body.avatar === undefined ? '' : body.avatar;
      if (!isValidAvatar(avatar)) {
        return sendJson(res, 400, { error: 'Ugyldig profilbilde' });
      }
      const color = body.color === undefined ? '#00A3FF' : body.color;
      if (!isValidHexColor(color)) {
        return sendJson(res, 400, { error: 'Ugyldig fargekode' });
      }

      const data = getProfilesData();
      if (data.profiles.length >= MAX_PROFILES) {
        return sendJson(res, 400, { error: `Maksimalt antall profiler (${MAX_PROFILES}) er nådd` });
      }

      const newProfile = {
        id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        avatar,
        color,
        isAdmin: false,
        adminPasswordHash: null,
        hiddenBooks: [],
        createdAt: new Date().toISOString(),
        progress: {},
        bookmarks: {},
        preferences: { ...DEFAULT_PREFERENCES }
      };
      data.profiles.push(newProfile);
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, {
        ok: true,
        profile: sanitizeProfileSummary(newProfile, session.role === 'admin')
      });
    }

    if (pathname.startsWith('/api/profiles/') && req.method === 'PUT') {
      const targetId = safeDecodeURIComponent(pathname.slice('/api/profiles/'.length));
      if (!targetId) {
        return sendJson(res, 400, { error: 'Ugyldig profil-ID' });
      }

      const body = await readRequestBody(req, 512 * 1024);
      const data = getProfilesData();
      const target = data.profiles.find((p) => p.id === targetId);
      if (!target) {
        return sendJson(res, 404, { error: 'Profil ikke funnet' });
      }
      if (target.isAdmin && session.role !== 'admin') {
        return sendJson(res, 403, {
          error: 'Admin-tilgang kreves for å redigere denne profilen',
          requireAdmin: true
        });
      }

      if (body.name !== undefined) {
        const cleanName = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        if (!cleanName) {
          return sendJson(res, 400, { error: 'Navn kan ikke være tomt' });
        }
        target.name = cleanName;
      }
      if (body.avatar !== undefined) {
        if (!isValidAvatar(body.avatar)) {
          return sendJson(res, 400, { error: 'Ugyldig profilbilde' });
        }
        target.avatar = body.avatar;
      }
      if (body.color !== undefined) {
        if (!isValidHexColor(body.color)) {
          return sendJson(res, 400, { error: 'Ugyldig fargekode' });
        }
        target.color = body.color;
      }

      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, {
        ok: true,
        profile: sanitizeProfileSummary(target, session.role === 'admin')
      });
    }

    if (pathname.startsWith('/api/profiles/') && req.method === 'DELETE') {
      const targetId = safeDecodeURIComponent(pathname.slice('/api/profiles/'.length));
      if (!targetId) {
        return sendJson(res, 400, { error: 'Ugyldig profil-ID' });
      }

      const data = getProfilesData();
      const target = data.profiles.find((p) => p.id === targetId);
      if (!target) {
        return sendJson(res, 404, { error: 'Profil ikke funnet' });
      }
      if (target.isAdmin && session.role !== 'admin') {
        return sendJson(res, 403, {
          error: 'Admin-tilgang kreves for å slette denne profilen',
          requireAdmin: true
        });
      }
      if (data.profiles.length <= 1) {
        return sendJson(res, 400, { error: 'Kan ikke slette den siste profilen' });
      }
      if (target.isAdmin && data.profiles.filter((p) => p.isAdmin).length <= 1) {
        return sendJson(res, 400, { error: 'Kan ikke slette den siste admin-profilen' });
      }

      data.profiles = data.profiles.filter((p) => p.id !== targetId);
      saveJson(PROFILES_FILE, data);

      let sessionsChanged = false;
      for (const s of sessions.values()) {
        if (s.activeProfileId === targetId) {
          s.activeProfileId = null;
          sessionsChanged = true;
        }
      }
      if (sessionsChanged) persistSessions();

      return sendJson(res, 200, { ok: true });
    }

    // ==================== RANDOM BACKDROP API ====================
    if (pathname === '/api/random-backdrop' && req.method === 'GET') {
      const profilesData = getProfilesData();
      let activeProfile = null;
      if (session.activeProfileId) {
        activeProfile = profilesData.profiles.find((p) => p.id === session.activeProfileId) || null;
      } else {
        const reqProfId = req.headers['x-profile-id'] || parsedUrl.searchParams.get('profileId');
        if (reqProfId) {
          const candidate = profilesData.profiles.find((p) => p.id === reqProfId);
          if (candidate && (!candidate.isAdmin || session.role === 'admin')) {
            activeProfile = candidate;
          }
        }
      }

      const allBooks = scanAllBooks();
      const candidates = [];
      for (const b of allBooks) {
        if (b.format !== 'images') continue;
        if (isBookHiddenForProfile(session, activeProfile, b.id, b)) continue;
        const contentOnly = b.pages.filter((p) => p.type === 'page' && p.url);
        const pool = contentOnly.length > 0 ? contentOnly : b.pages.filter((p) => p.url);
        for (const p of pool) {
          candidates.push({
            url: p.url,
            bookId: b.id,
            bookTitle: b.title
          });
        }
      }
      if (candidates.length === 0) {
        return sendJson(res, 200, { url: null });
      }
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      return sendJson(res, 200, chosen);
    }

    // ==================== BOOKS & LIBRARY API ====================
    if (pathname === '/api/books' && req.method === 'GET') {
      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { profile } = resolvedProfile;
      const allBooks = scanAllBooks();
      const visibleBooks = allBooks.filter(
        (book) => !isBookHiddenForProfile(session, profile, book.id, book)
      );

      const summarized = visibleBooks.map((book) => {
        const prog = Object.hasOwn(profile.progress, book.id) ? profile.progress[book.id] : null;
        const bms = Object.hasOwn(profile.bookmarks, book.id) ? profile.bookmarks[book.id] : [];
        return {
          id: book.id,
          title: book.title,
          originalTitle: book.originalTitle || book.id,
          customTitle: book.customTitle || '',
          adminOnly: Boolean(book.adminOnly),
          format: book.format || 'images',
          ebookUrl: book.ebookUrl || null,
          sizeScale: book.sizeScale || 1.0,
          covers: book.covers,
          contentPageCount: book.contentPageCount,
          totalPages: book.totalPages,
          forsatsAlene: book.forsatsAlene,
          chapterCount: book.chapters.length,
          chapters: book.chapters,
          progress: prog,
          bookmarkCount: bms.length,
          bookmarks: bms
        };
      });

      return sendJson(res, 200, {
        books: summarized,
        profile: sanitizeProfileSummary(profile, session.role === 'admin'),
        isAdmin: session.role === 'admin',
        preferences: profile.preferences
      });
    }

    // API (Admin-only): Cache rendered cover image + page count for PDF/EPUB books
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/cover-cache') && req.method === 'POST') {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }
      const bookId = safeDecodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/cover-cache'.length)
      );
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const config = getRuntimeConfig();
      const existing = parseBookFolder(config.booksDir, bookId);
      if (!existing) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const body = await readRequestBody(req, 8 * 1024 * 1024);

      if (typeof body.dataUrl === 'string') {
        const match = body.dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) {
          return sendJson(res, 400, { error: 'Ugyldig bildeformat for omslag' });
        }
        const buf = Buffer.from(match[2], 'base64');
        if (buf.length === 0 || buf.length > MAX_COVER_BYTES || !isValidImageBuffer(buf)) {
          return sendJson(res, 400, { error: 'Ugyldig eller for stort omslagsbilde (maks 5 MB)' });
        }
        const coverCacheFile = safeCoverCachePath(bookId);
        fs.writeFileSync(coverCacheFile, buf);
        imageDimCache.delete(coverCacheFile);
      }

      if (typeof body.pageCount === 'number' && Number.isFinite(body.pageCount) && body.pageCount > 0) {
        const currentMeta = loadBookMeta(config.booksDir, bookId);
        currentMeta.pageCount = Math.min(20000, Math.round(body.pageCount));
        saveBookMeta(config.booksDir, bookId, currentMeta);
      }

      const updatedBook = parseBookFolder(config.booksDir, bookId);
      return sendJson(res, 200, {
        ok: true,
        covers: updatedBook ? updatedBook.covers : null,
        totalPages: updatedBook ? updatedBook.totalPages : null
      });
    }

    // API (Admin-only): Stream-upload a raw .epub or .pdf file directly into booksDir
    if (pathname === '/api/upload-ebook' && req.method === 'POST') {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }
      const rawHeaderName = safeDecodeURIComponent(String(req.headers['x-filename'] || ''));
      const rawName = rawHeaderName ? path.basename(rawHeaderName.trim()) : '';
      if (!isValidBookId(rawName)) {
        return sendJson(res, 400, { error: 'Ugyldig filnavn' });
      }
      const ext = path.extname(rawName).toLowerCase();
      if (!EBOOK_EXTENSIONS.has(ext)) {
        return sendJson(res, 400, { error: 'Kun .epub og .pdf støttes' });
      }

      const config = getRuntimeConfig();
      if (!fs.existsSync(config.booksDir) || !fs.statSync(config.booksDir).isDirectory()) {
        return sendJson(res, 500, { error: 'Bokmappen er ikke tilgjengelig' });
      }

      const targetPath = path.join(config.booksDir, rawName);
      if (!isPathInsideDir(config.booksDir, targetPath, { allowMissingLeaf: true })) {
        return sendJson(res, 400, { error: 'Ugyldig filplassering' });
      }

      const overwrite = req.headers['x-overwrite'] === 'true';
      if (fs.existsSync(targetPath) && !overwrite) {
        return sendJson(res, 409, { error: 'En bok med dette filnavnet finnes allerede' });
      }

      const tmpName = `.upload-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      const tmpPath = path.join(config.booksDir, tmpName);

      await streamBinaryUploadToFile(req, tmpPath, ext, MAX_UPLOAD_BYTES);

      if (fs.existsSync(targetPath) && !overwrite) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        return sendJson(res, 409, { error: 'En bok med dette filnavnet finnes allerede' });
      }

      fs.renameSync(tmpPath, targetPath);
      return sendJson(res, 200, { ok: true, id: rawName });
    }

    // API (Admin-only): Shared Book Metadata (title, adminOnly, forsatsAlene, sizeScale & chapters)
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/meta') && req.method === 'POST') {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }
      const bookId = safeDecodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/meta'.length)
      );
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const config = getRuntimeConfig();
      const existingBook = parseBookFolder(config.booksDir, bookId);
      if (!existingBook) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const currentMeta = loadBookMeta(config.booksDir, bookId);
      const body = await readRequestBody(req, 256 * 1024);

      if (typeof body.title === 'string') {
        currentMeta.title = body.title.trim().slice(0, 140);
      }
      if (typeof body.adminOnly === 'boolean') {
        currentMeta.adminOnly = body.adminOnly;
      }
      if (typeof body.forsatsAlene === 'boolean') {
        currentMeta.forsatsAlene = body.forsatsAlene;
      }
      if (typeof body.sizeScale === 'number' && Number.isFinite(body.sizeScale)) {
        currentMeta.sizeScale = Math.max(0.5, Math.min(1.5, body.sizeScale));
      }
      if (typeof body.pageCount === 'number' && Number.isFinite(body.pageCount) && body.pageCount > 0) {
        currentMeta.pageCount = Math.min(20000, Math.round(body.pageCount));
      }
      if (Array.isArray(body.chapters)) {
        currentMeta.chapters = body.chapters;
      }

      const saved = saveBookMeta(config.booksDir, bookId, currentMeta);
      const updatedBook = parseBookFolder(config.booksDir, bookId);
      return sendJson(res, 200, {
        ok: true,
        id: bookId,
        title: updatedBook ? updatedBook.title : existingBook.title,
        originalTitle: updatedBook ? updatedBook.originalTitle : existingBook.originalTitle,
        customTitle: updatedBook ? updatedBook.customTitle : saved.meta.title || '',
        adminOnly: Boolean(saved.meta.adminOnly),
        forsatsAlene: saved.meta.forsatsAlene,
        sizeScale: saved.meta.sizeScale,
        chapters: updatedBook ? updatedBook.chapters : saved.meta.chapters
      });
    }

    // API (Admin-only): Add or update a shared chapter
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/chapters') && req.method === 'POST') {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }
      const bookId = safeDecodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/chapters'.length)
      );
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const config = getRuntimeConfig();
      const book = parseBookFolder(config.booksDir, bookId);
      if (!book) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const body = await readRequestBody(req, 32 * 1024);
      const pageIndex = Math.max(0, Math.min(book.totalPages - 1, parseInt(body.pageIndex, 10) || 0));
      const title =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, 140)
          : `Kapittel (Side ${pageIndex + 1})`;
      const pageObj = book.pages[pageIndex];

      const currentMeta = loadBookMeta(config.booksDir, bookId);
      const existingIdx = currentMeta.chapters.findIndex(
        (c) => (typeof body.id === 'string' && body.id && c.id === body.id) || c.pageIndex === pageIndex
      );

      if (existingIdx !== -1) {
        currentMeta.chapters[existingIdx].title = title;
        currentMeta.chapters[existingIdx].pageIndex = pageIndex;
        currentMeta.chapters[existingIdx].pageFile = pageObj ? pageObj.filename : undefined;
      } else {
        if (currentMeta.chapters.length >= 500) {
          return sendJson(res, 400, { error: 'Maks 500 kapitler per bok' });
        }
        currentMeta.chapters.push({
          id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          pageIndex,
          pageFile: pageObj ? pageObj.filename : undefined
        });
      }

      saveBookMeta(config.booksDir, bookId, currentMeta);
      const updatedBook = parseBookFolder(config.booksDir, bookId);
      return sendJson(res, 200, {
        ok: true,
        chapters: updatedBook ? updatedBook.chapters : currentMeta.chapters
      });
    }

    // API (Admin-only): Delete shared chapter
    if (pathname.startsWith('/api/books/') && pathname.includes('/chapters/') && req.method === 'DELETE') {
      if (session.role !== 'admin') {
        return sendJson(res, 403, { error: 'Krever admin-tilgang' });
      }
      const rest = pathname.slice('/api/books/'.length);
      const splitIdx = rest.indexOf('/chapters/');
      const bookId = safeDecodeURIComponent(rest.slice(0, splitIdx));
      const chapterId = safeDecodeURIComponent(rest.slice(splitIdx + '/chapters/'.length));
      if (!isValidBookId(bookId) || !chapterId) {
        return sendJson(res, 400, { error: 'Ugyldig bok- eller kapittel-ID' });
      }

      const config = getRuntimeConfig();
      const existingBook = parseBookFolder(config.booksDir, bookId);
      if (!existingBook) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const currentMeta = loadBookMeta(config.booksDir, bookId);
      currentMeta.chapters = currentMeta.chapters.filter((c) => c.id !== chapterId);
      saveBookMeta(config.booksDir, bookId, currentMeta);

      const updatedBook = parseBookFolder(config.booksDir, bookId);
      return sendJson(res, 200, {
        ok: true,
        chapters: updatedBook ? updatedBook.chapters : currentMeta.chapters
      });
    }

    // API: Single book detail
    if (pathname.startsWith('/api/books/') && req.method === 'GET') {
      const bookId = safeDecodeURIComponent(pathname.slice('/api/books/'.length));
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { profile } = resolvedProfile;

      const config = getRuntimeConfig();
      const book = parseBookFolder(config.booksDir, bookId);
      if (!book || isBookHiddenForProfile(session, profile, book.id, book)) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      return sendJson(res, 200, {
        ...book,
        isAdmin: session.role === 'admin',
        progress: Object.hasOwn(profile.progress, book.id) ? profile.progress[book.id] : null,
        bookmarks: Object.hasOwn(profile.bookmarks, book.id) ? profile.bookmarks[book.id] : [],
        preferences: profile.preferences
      });
    }

    // API: Save reading progress for a book (per profile)
    if (pathname.startsWith('/api/progress/') && req.method === 'POST') {
      const bookId = safeDecodeURIComponent(pathname.slice('/api/progress/'.length));
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { data, profile } = resolvedProfile;

      const config = getRuntimeConfig();
      const book = parseBookFolder(config.booksDir, bookId);
      if (!book || isBookHiddenForProfile(session, profile, book.id, book)) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const body = await readRequestBody(req, 16 * 1024);
      const pageIndex = Math.max(0, parseInt(body.pageIndex, 10) || 0);
      const totalPages = Math.max(1, parseInt(body.totalPages, 10) || 1);
      const completed = Boolean(body.completed) || pageIndex >= totalPages - 1;

      profile.progress[bookId] = {
        pageIndex,
        totalPages,
        completed,
        updatedAt: new Date().toISOString()
      };

      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, progress: profile.progress[bookId] });
    }

    // API: Add or update bookmark for a book (per profile)
    if (pathname.startsWith('/api/bookmarks/') && req.method === 'POST') {
      const bookId = safeDecodeURIComponent(pathname.slice('/api/bookmarks/'.length));
      if (!isValidBookId(bookId)) {
        return sendJson(res, 400, { error: 'Ugyldig bok-ID' });
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { data, profile } = resolvedProfile;

      const config = getRuntimeConfig();
      const book = parseBookFolder(config.booksDir, bookId);
      if (!book || isBookHiddenForProfile(session, profile, book.id, book)) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const body = await readRequestBody(req, 16 * 1024);
      if (!Object.hasOwn(profile.bookmarks, bookId) || !Array.isArray(profile.bookmarks[bookId])) {
        profile.bookmarks[bookId] = [];
      }

      const pageIndex = Math.max(0, parseInt(body.pageIndex, 10) || 0);
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      const pageLabel =
        typeof body.pageLabel === 'string'
          ? body.pageLabel.trim().slice(0, 60)
          : `Side ${pageIndex + 1}`;

      const existingIdx = profile.bookmarks[bookId].findIndex((b) => b.pageIndex === pageIndex);
      if (existingIdx !== -1 && body.toggle && !note) {
        profile.bookmarks[bookId].splice(existingIdx, 1);
      } else if (existingIdx !== -1) {
        profile.bookmarks[bookId][existingIdx].note = note;
        profile.bookmarks[bookId][existingIdx].updatedAt = new Date().toISOString();
      } else {
        if (profile.bookmarks[bookId].length >= 200) {
          return sendJson(res, 400, { error: 'Maks 200 bokmerker per bok' });
        }
        profile.bookmarks[bookId].push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          pageIndex,
          pageLabel,
          note,
          createdAt: new Date().toISOString()
        });
      }

      profile.bookmarks[bookId].sort((a, b) => a.pageIndex - b.pageIndex);
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, bookmarks: profile.bookmarks[bookId] });
    }

    // API: Delete bookmark (per profile)
    if (pathname.startsWith('/api/bookmarks/') && req.method === 'DELETE') {
      const rest = pathname.slice('/api/bookmarks/'.length);
      const parts = rest.split('/');
      const bookId = safeDecodeURIComponent(parts[0] || '');
      const bookmarkId = safeDecodeURIComponent(parts[1] || '');
      if (!isValidBookId(bookId) || !bookmarkId) {
        return sendJson(res, 400, { error: 'Ugyldig bok- eller bokmerke-ID' });
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { data, profile } = resolvedProfile;

      if (Object.hasOwn(profile.bookmarks, bookId) && Array.isArray(profile.bookmarks[bookId])) {
        profile.bookmarks[bookId] = profile.bookmarks[bookId].filter((b) => b.id !== bookmarkId);
        saveJson(PROFILES_FILE, data);
      }
      return sendJson(res, 200, {
        ok: true,
        bookmarks: Object.hasOwn(profile.bookmarks, bookId) ? profile.bookmarks[bookId] : []
      });
    }

    // API: Save user preferences (per profile, strict allowlist)
    if (pathname === '/api/preferences' && req.method === 'POST') {
      const body = await readRequestBody(req, 16 * 1024);
      for (const k of Object.keys(body)) {
        if (!ALLOWED_PREF_KEYS.has(k) || FORBIDDEN_KEYS.has(k)) {
          return sendJson(res, 400, { error: 'Ugyldig innstillingsnøkkel' });
        }
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        return sendJson(res, resolvedProfile.error, {
          error: resolvedProfile.message,
          requireAdmin: Boolean(resolvedProfile.requireAdmin)
        });
      }
      const { data, profile } = resolvedProfile;

      profile.preferences = sanitizePreferences({
        ...profile.preferences,
        ...body
      });
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, preferences: profile.preferences });
    }

    // ==================== EPUB INTERNAL SAFE ASSETS ====================
    if (pathname.startsWith('/epub-resource/') && req.method === 'GET') {
      const parts = pathname.slice('/epub-resource/'.length).split('/');
      if (parts.length < 2) {
        res.writeHead(400);
        res.end('Ugyldig EPUB-ressurs');
        return;
      }
      const bookId = safeDecodeURIComponent(parts[0]);
      const internalPath = safeDecodeURIComponent(parts.slice(1).join('/'));
      if (!isValidBookId(bookId) || !internalPath || internalPath.includes('\0')) {
        res.writeHead(400);
        res.end('Ugyldig EPUB-ressurs');
        return;
      }

      const ext = path.extname(internalPath).toLowerCase();
      if (!EPUB_SAFE_ASSET_EXTS.has(ext)) {
        res.writeHead(403);
        res.end('Filtype ikke tillatt');
        return;
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        res.writeHead(resolvedProfile.error);
        res.end('Ingen tilgang');
        return;
      }

      const config = getRuntimeConfig();
      const bookMeta = loadBookMeta(config.booksDir, bookId);
      if (isBookHiddenForProfile(session, resolvedProfile.profile, bookId, bookMeta)) {
        res.writeHead(404);
        res.end('EPUB ikke funnet');
        return;
      }

      const targetPath = path.join(config.booksDir, bookId);
      if (!isPathInsideDir(config.booksDir, targetPath)) {
        res.writeHead(403);
        res.end('Ingen tilgang');
        return;
      }

      let epubFile = null;
      if (fs.existsSync(targetPath)) {
        const st = fs.statSync(targetPath);
        if (st.isFile() && targetPath.toLowerCase().endsWith('.epub')) {
          epubFile = targetPath;
        } else if (st.isDirectory()) {
          const found = fs.readdirSync(targetPath).find((f) => f.toLowerCase().endsWith('.epub'));
          if (found) epubFile = path.join(targetPath, found);
        }
      }
      if (!epubFile || !isPathInsideDir(config.booksDir, epubFile)) {
        res.writeHead(404);
        res.end('EPUB ikke funnet');
        return;
      }

      const zip = readZipArchive(epubFile);
      const dataBuf = zip.extractEntry ? zip.extractEntry(internalPath) : null;
      if (!dataBuf) {
        res.writeHead(404);
        res.end('Ressurs ikke funnet i EPUB');
        return;
      }

      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': dataBuf.length,
        'Cache-Control': 'private, max-age=3600'
      });
      return res.end(dataBuf);
    }

    // ==================== BOOK MEDIA (STRICT EXTENSION + CONTAINMENT) ====================
    if (pathname.startsWith('/book-media/') && req.method === 'GET') {
      const parts = pathname.slice('/book-media/'.length).split('/');
      if (parts.length < 2) {
        res.writeHead(400);
        res.end('Ugyldig bilde-URL');
        return;
      }
      const bookId = safeDecodeURIComponent(parts[0]);
      const rawFilename = safeDecodeURIComponent(parts.slice(1).join('/'));
      if (!isValidBookId(bookId) || !rawFilename || rawFilename.includes('/') || rawFilename.includes('\\') || rawFilename.includes('\0')) {
        res.writeHead(400);
        res.end('Ugyldig bok- eller filnavn');
        return;
      }

      const resolvedProfile = resolveRequestProfile(session, req, parsedUrl);
      if (resolvedProfile.error) {
        res.writeHead(resolvedProfile.error);
        res.end('Ingen tilgang');
        return;
      }

      const config = getRuntimeConfig();
      const bookMeta = loadBookMeta(config.booksDir, bookId);
      if (isBookHiddenForProfile(session, resolvedProfile.profile, bookId, bookMeta)) {
        res.writeHead(404);
        res.end('Bok ikke funnet');
        return;
      }

      if (rawFilename === '__cover') {
        const book = parseBookFolder(config.booksDir, bookId);
        if (!book) {
          res.writeHead(404);
          res.end('Bok ikke funnet');
          return;
        }
        const coverCacheFile = safeCoverCachePath(bookId);
        if (fs.existsSync(coverCacheFile) && isPathInsideDir(COVERS_CACHE_DIR, coverCacheFile)) {
          return serveFile(req, res, coverCacheFile, 'private, max-age=3600');
        }
        res.writeHead(404);
        res.end('Omslag ikke funnet');
        return;
      }

      if (rawFilename === '__ebook') {
        const ext = path.extname(bookId).toLowerCase();
        if (!EBOOK_EXTENSIONS.has(ext)) {
          res.writeHead(403);
          res.end('Filtype ikke tillatt');
          return;
        }
        const directFile = path.join(config.booksDir, bookId);
        if (isPathInsideDir(config.booksDir, directFile) && fs.statSync(directFile).isFile()) {
          return serveFile(req, res, directFile, 'private, max-age=3600');
        }
        res.writeHead(404);
        res.end('E-bok ikke funnet');
        return;
      }

      if (!isValidBookId(rawFilename)) {
        res.writeHead(400);
        res.end('Ugyldig filnavn');
        return;
      }

      const fileExt = path.extname(rawFilename).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(fileExt) && !EBOOK_EXTENSIONS.has(fileExt)) {
        res.writeHead(403);
        res.end('Filtype ikke tillatt');
        return;
      }

      const filePath = path.join(config.booksDir, bookId, rawFilename);
      if (!isPathInsideDir(config.booksDir, filePath)) {
        res.writeHead(403);
        res.end('Ingen tilgang');
        return;
      }

      return serveFile(req, res, filePath, 'private, max-age=3600');
    }

    // Reject unknown API routes explicitly as 404 JSON instead of serving index.html
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Endepunkt ikke funnet' });
    }

    // ==================== STATIC FRONTEND FILES ====================
    const decodedStatic = safeDecodeURIComponent(pathname);
    if (decodedStatic === null || decodedStatic.includes('\0')) {
      res.writeHead(400);
      res.end('Ugyldig sti');
      return;
    }

    const relStatic = decodedStatic === '/' ? 'index.html' : decodedStatic.replace(/^\/+/, '');
    const publicRoot = path.resolve(PUBLIC_DIR);
    const resolvedStatic = path.resolve(publicRoot, relStatic);
    const publicPrefix = publicRoot.endsWith(path.sep) ? publicRoot : publicRoot + path.sep;

    if (resolvedStatic !== publicRoot && !resolvedStatic.startsWith(publicPrefix)) {
      res.writeHead(403);
      res.end('Ingen tilgang');
      return;
    }

    if (
      fs.existsSync(resolvedStatic) &&
      isPathInsideDir(PUBLIC_DIR, resolvedStatic) &&
      fs.statSync(resolvedStatic).isFile()
    ) {
      return serveFile(req, res, resolvedStatic, 'no-store, no-cache, must-revalidate, max-age=0');
    }

    return serveFile(
      req,
      res,
      path.join(PUBLIC_DIR, 'index.html'),
      'no-store, no-cache, must-revalidate, max-age=0'
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.statusCode, { error: err.message });
    }
    console.error('Serverfeil:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Intern serverfeil' });
    } else {
      res.end();
    }
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 10_000;

server.listen(PORT, '0.0.0.0', () => {
  const config = getRuntimeConfig();
  const lanIps = getLanAddresses();
  console.log('==================================================');
  console.log('  BOKAMI - Minimalistisk Bokleser');
  console.log('==================================================');
  console.log(`  Bokmappe : ${config.booksDir}`);
  console.log(`  PC (lokal): http://localhost:${PORT}`);
  if (lanIps.length > 0) {
    lanIps.forEach((ip) => {
      console.log(`  Mobil/LAN : http://${ip}:${PORT}`);
    });
  }
  if (startupNotices.generatedReaderPassword) {
    console.log('--------------------------------------------------');
    console.log(`  [NYTT LESERPASSORD] : ${startupNotices.generatedReaderPassword}`);
  }
  if (startupNotices.generatedAdminPassword) {
    console.log('--------------------------------------------------');
    console.log(`  [NYTT ADMIN-PASSORD] : ${startupNotices.generatedAdminPassword}`);
    console.log('  Lagre dette passordet eller sett BOKAMI_ADMIN_PASSWORD!');
  }
  if (startupNotices.defaultReaderPasswordWarning) {
    console.log('--------------------------------------------------');
    console.log('  ADVARSEL: Leserpassordet er fortsatt standard ("passord").');
    console.log('  Endre det i Admin-panelet (Innstillinger) snarest!');
  }
  console.log('==================================================');
});

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Mottok ${signal}, avslutter Bokami pent...`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
