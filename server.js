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

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const LEGACY_USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');
const BOOKMETA_FALLBACK_FILE = path.join(DATA_DIR, 'bookmeta.json');
const COVERS_CACHE_DIR = path.join(DATA_DIR, 'covers');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COVERS_CACHE_DIR)) fs.mkdirSync(COVERS_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DEFAULT_BOOKS_DIR)) fs.mkdirSync(DEFAULT_BOOKS_DIR, { recursive: true });

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const EBOOK_EXTENSIONS = new Set(['.pdf', '.epub']);
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Feil ved lagring av ${filePath}:`, err.message);
    return false;
  }
}

function getConfig() {
  const envPassword =
    typeof process.env.BOKAMI_PASSWORD === 'string'
      ? process.env.BOKAMI_PASSWORD
      : typeof process.env.PASSWORD === 'string'
        ? process.env.PASSWORD
        : null;
  const defaultConfig = {
    booksDir: DEFAULT_BOOKS_DIR,
    password: envPassword !== null ? envPassword : 'passord'
  };
  const loaded = loadJson(CONFIG_FILE, defaultConfig);
  return {
    ...defaultConfig,
    ...loaded,
    password:
      envPassword !== null
        ? envPassword
        : typeof loaded.password === 'string'
          ? loaded.password
          : defaultConfig.password
  };
}

function makeAuthToken(password) {
  return crypto.createHash('sha256').update(`bokami-auth:${password}`).digest('hex').slice(0, 32);
}

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    const val = decodeURIComponent(parts.join('=').trim());
    if (key) list[key] = val;
  });
  return list;
}

function isRequestAuthenticated(req, parsedUrl) {
  const config = getConfig();
  if (!config.password) return true;
  const expected = makeAuthToken(config.password);
  const headerToken = req.headers['x-auth-token'];
  const queryToken = parsedUrl.searchParams.get('token');
  const cookies = parseCookies(req);
  const cookieToken = cookies.bokami_token;
  return headerToken === expected || queryToken === expected || cookieToken === expected;
}

const DEFAULT_PREFERENCES = {
  shelfView: 'grid',       // 'grid' | 'spine'
  gridCoverMode: 'c1',     // 'c1' (Forsats) | 'c2' (Rygg) | 'c3' (Baksats)
  readerMode: 'auto',      // 'auto' | 'spread' | 'single' | 'vertical'
  fitMode: 'height'        // 'height' | 'width' | 'original'
};

function getProfilesData() {
  if (fs.existsSync(PROFILES_FILE)) {
    const data = loadJson(PROFILES_FILE, { profiles: [] });
    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      return data;
    }
  }

  const legacy = loadJson(LEGACY_USERDATA_FILE, null);
  const initialProfile = {
    id: 'main',
    name: 'Meg',
    avatar: '',
    color: '#00A3FF',
    createdAt: new Date().toISOString(),
    progress: legacy && legacy.progress ? legacy.progress : {},
    bookmarks: legacy && legacy.bookmarks ? legacy.bookmarks : {},
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...(legacy && legacy.preferences ? legacy.preferences : {})
    }
  };

  const initialData = { profiles: [initialProfile] };
  saveJson(PROFILES_FILE, initialData);
  return initialData;
}

function getProfileById(profileId) {
  const data = getProfilesData();
  let profile = data.profiles.find((p) => p.id === profileId);
  if (!profile) {
    profile = data.profiles[0];
  }
  if (!profile.progress) profile.progress = {};
  if (!profile.bookmarks) profile.bookmarks = {};
  profile.preferences = { ...DEFAULT_PREFERENCES, ...(profile.preferences || {}) };
  return { data, profile };
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

function loadBookMeta(booksDir, folderName) {
  const fullPath = path.join(booksDir, folderName);
  const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  const bookJsonPath = isDir ? path.join(fullPath, 'book.json') : null;
  const fallbackStore = loadJson(BOOKMETA_FALLBACK_FILE, {});
  const fallbackMeta = fallbackStore[folderName] || {};

  const defaultMeta = {
    forsatsAlene: true,
    sizeScale: 1.0,
    pageCount: null,
    chapters: []
  };

  let folderMeta = {};
  if (bookJsonPath && fs.existsSync(bookJsonPath)) {
    folderMeta = loadJson(bookJsonPath, {});
  }

  const rawScale =
    typeof folderMeta.sizeScale === 'number'
      ? folderMeta.sizeScale
      : typeof fallbackMeta.sizeScale === 'number'
        ? fallbackMeta.sizeScale
        : defaultMeta.sizeScale;

  const merged = {
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
  const rawScale = typeof meta.sizeScale === 'number' ? meta.sizeScale : 1.0;
  const cleanMeta = {
    forsatsAlene: typeof meta.forsatsAlene === 'boolean' ? meta.forsatsAlene : true,
    sizeScale: Math.max(0.5, Math.min(1.5, Math.round(rawScale * 100) / 100)),
    ...(typeof meta.pageCount === 'number' ? { pageCount: meta.pageCount } : {}),
    chapters: Array.isArray(meta.chapters)
      ? meta.chapters
          .map((ch) => ({
            id: ch.id || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: String(ch.title || 'Kapittel').trim().slice(0, 140),
            pageIndex: Math.max(0, parseInt(ch.pageIndex, 10) || 0),
            pageFile: ch.pageFile || undefined
          }))
          .sort((a, b) => a.pageIndex - b.pageIndex)
      : []
  };

  const fullPath = path.join(booksDir, folderName);
  const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  const bookJsonPath = isDir ? path.join(fullPath, 'book.json') : path.join(DATA_DIR, 'bookmeta.json');
  const wroteToFolder = isDir ? saveJson(bookJsonPath, cleanMeta) : false;

  const fallbackStore = loadJson(BOOKMETA_FALLBACK_FILE, {});
  fallbackStore[folderName] = cleanMeta;
  saveJson(BOOKMETA_FALLBACK_FILE, fallbackStore);

  return { meta: cleanMeta, wroteToFolder, bookJsonPath };
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
        imageDimCache.set(filePath, res);
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
        imageDimCache.set(filePath, res);
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

  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
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

    const lho = info.localHeaderOffset;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const compSlice = buf.subarray(dataStart, dataStart + info.compSize);

    try {
      if (info.method === 0) return Buffer.from(compSlice);
      if (info.method === 8) return zlib.inflateRawSync(compSlice);
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
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
    const epubTitle = titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : null;

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
        manifest.set(idM[1], {
          id: idM[1],
          href: decodeURIComponent(hrefM[1]),
          fullPath: resolveRel(decodeURIComponent(hrefM[1])),
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
      if (imgBuf && imgBuf.length > 0) {
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

    // Extract HTML sections from spine and paginate longer chapters into readable chunks
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
      // Rewrite relative src and href attributes inside EPUB HTML to /epub-resource/:bookId/...
      bodyHtml = bodyHtml.replace(
        /\b(src|href|xlink:href)\s*=\s*["']([^"']+)["']/gi,
        (full, attr, val) => {
          if (/^(https?:|data:|mailto:|#)/i.test(val)) return full;
          const cleanVal = val.split('#')[0];
          const resolved =
            sectionDir === '.'
              ? cleanVal
              : path.posix.normalize(path.posix.join(sectionDir, cleanVal));
          if (attr.toLowerCase() === 'href' && /\.(xhtml|html|htm)$/i.test(cleanVal)) {
            return `data-epub-href="${resolved}"`;
          }
          return `${attr}="/epub-resource/${encodedBookId}/${encodeURIComponent(resolved)}"`;
        }
      );

      // Remove <script> and <style> tags that might break dark mode
      bodyHtml = bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

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

    // Parse Table of Contents (NCX or EPUB3 nav)
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
        const navPointRegex =
          /<navPoint\b[^>]*>[\s\S]*?<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s+src\s*=\s*["']([^"']+)["']/gi;
        while ((match = navPointRegex.exec(ncxXml)) !== null) {
          const chTitle = decodeXmlEntities(match[1].trim());
          const rawSrc = decodeURIComponent(match[2].split('#')[0]);
          const fullTarget =
            ncxDir === '.' ? rawSrc : path.posix.normalize(path.posix.join(ncxDir, rawSrc));
          const pIdx =
            hrefToPageIndex.get(fullTarget) ?? hrefToPageIndex.get(rawSrc) ?? 0;
          if (chTitle) {
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

    const result = {
      epubTitle,
      hasExtractedCover: fs.existsSync(coverCacheFile),
      coverCacheFile,
      pages,
      autoChapters
    };

    epubCache.set(epubFilePath, { mtimeMs: stat.mtimeMs, data: result });
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

    // Read up to 4MB to count /Type /Page or /Count
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

    let ratio = 0.707; // A4 default
    const mediaBoxM = str.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    if (mediaBoxM) {
      const w = parseFloat(mediaBoxM[3]) - parseFloat(mediaBoxM[1]);
      const h = parseFloat(mediaBoxM[4]) - parseFloat(mediaBoxM[2]);
      if (w > 0 && h > 0) {
        ratio = Number((w / h).toFixed(4));
      }
    }

    const data = { pageCount, ratio };
    pdfInfoCache.set(pdfFilePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return { pageCount: 1, ratio: 0.707 };
  }
}

function parseBookFolder(booksDir, folderName) {
  const folderPath = path.join(booksDir, folderName);
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

      return {
        id: folderName,
        title: epubInfo.epubTitle || baseTitle,
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
      label: idx === 0 ? `Forsats / Side 1` : `Side ${idx + 1}`,
      shortLabel: `Side ${idx + 1}`,
      type: idx === 0 ? 'c1' : 'page',
      pageNumber: idx + 1,
      pdfPageNumber: idx + 1
    }));

    return {
      id: folderName,
      title: baseTitle,
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

  // If the folder contains a .pdf or .epub and no numbered image pages, treat it as a PDF/EPUB folder book (which can still use c1/c2/c3 covers!)
  if (contentPages.length === 0 && ebookFiles.length > 0) {
    const ebookFile = ebookFiles[0];
    const ext = path.extname(ebookFile).toLowerCase();
    const ebookFullPath = path.join(folderPath, ebookFile);
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
        title: folderName,
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
      label: idx === 0 ? `Forsats / Side 1` : `Side ${idx + 1}`,
      shortLabel: `Side ${idx + 1}`,
      type: idx === 0 ? 'c1' : 'page',
      pageNumber: idx + 1,
      pdfPageNumber: idx + 1
    }));

    return {
      id: folderName,
      title: folderName,
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
      title: ch.title || `Kapittel`,
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
    title: folderName,
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
  const config = getConfig();
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
      if (e.name.startsWith('.')) return false;
      if (e.isDirectory()) return true;
      if (e.isFile() && EBOOK_EXTENSIONS.has(path.extname(e.name).toLowerCase())) return true;
      return false;
    })
    .map((e) => e.name)
    .sort(naturalCollator.compare);

  const books = [];
  for (const name of candidateNames) {
    const parsed = parseBookFolder(booksDir, name);
    if (parsed) {
      books.push(parsed);
    }
  }
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
    // SOF0, SOF1, SOF2 markers
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

/**
 * Builds a multi-page PDF buffer directly from JPEG files without re-compressing.
 */
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
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // For each page i (0..pageCount-1):
  //   pageObjId = 3 + i * 3
  //   contentObjId = 4 + i * 3
  //   imageObjId = 5 + i * 3
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

    // Scale to standard 595pt width (A4 width), preserving aspect ratio
    const pdfW = 595.28;
    const pdfH = Math.round(((pdfW * info.height) / info.width) * 100) / 100;

    // Image XObject
    offsets[imageObjId] = byteOffset;
    pushStr(
      `${imageObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBuf.length} >>\nstream\n`
    );
    pushBuf(imgBuf);
    pushStr('\nendstream\nendobj\n');

    // Content stream drawing the image across the full page
    const contentStr = `q\n${pdfW} 0 0 ${pdfH} 0 0 cm\n/Im0 Do\nQ\n`;
    offsets[contentObjId] = byteOffset;
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}endstream\nendobj\n`
    );

    // Page object
    offsets[pageObjId] = byteOffset;
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfW} ${pdfH}] /Resources << /XObject << /Im0 ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );
  }

  // Pages tree (Obj 2)
  offsets[2] = byteOffset;
  const kidsRef = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj\n`);

  // Catalog (Obj 1)
  offsets[1] = byteOffset;
  pushStr(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  // Cross-reference table
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

/**
 * Builds an uncompressed (STORE) ZIP buffer from an array of { name, filePath }.
 */
function buildZipFromFiles(items) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of items) {
    const fileBuf = fs.readFileSync(item.filePath);
    const nameBuf = Buffer.from(item.name, 'utf8');
    const crc = zlib.crc32(fileBuf) >>> 0;
    const size = fileBuf.length;

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed
    localHeader.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    localHeader.writeUInt16LE(0, 8);          // method 0 (STORE)
    localHeader.writeUInt16LE(0, 10);         // time
    localHeader.writeUInt16LE(0x21, 12);      // date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, fileBuf);

    // Central directory header (46 bytes + name)
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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        req.destroy();
        reject(new Error('Payload for stor'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
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
      if (start >= stats.size || start > end) {
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

function getRequestProfileId(req, parsedUrl) {
  return (
    parsedUrl.searchParams.get('profileId') ||
    req.headers['x-profile-id'] ||
    'main'
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const profileId = getRequestProfileId(req, parsedUrl);

    // ==================== HEALTHCHECK ====================
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    }

    // ==================== AUTHENTICATION API ====================
    if (pathname === '/api/auth/check' && req.method === 'GET') {
      const authenticated = isRequestAuthenticated(req, parsedUrl);
      return sendJson(res, 200, { authenticated });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const config = getConfig();
      const inputPwd = String(body.password || '');
      if (inputPwd === config.password) {
        const token = makeAuthToken(config.password);
        return sendJson(
          res,
          200,
          { ok: true, token },
          {
            'Set-Cookie': `bokami_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax`
          }
        );
      }
      return sendJson(res, 401, { error: 'Feil passord' });
    }

    // Protect API and book-media routes with password
    if (
      (pathname.startsWith('/api/') ||
        pathname.startsWith('/book-media/') ||
        pathname.startsWith('/epub-resource/')) &&
      !isRequestAuthenticated(req, parsedUrl)
    ) {
      return sendJson(res, 401, { error: 'Krever passord' });
    }

    // ==================== EXPORT PAGES API (PDF / ZIP) ====================
    if (pathname.startsWith('/api/export/') && req.method === 'GET') {
      const bookId = decodeURIComponent(pathname.slice('/api/export/'.length));
      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const book = parseBookFolder(config.booksDir, safeFolder);
      if (!book) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      // 1-based page numbers from query params (e.g. ?from=1&to=10&format=pdf)
      const fromPage = Math.max(1, parseInt(parsedUrl.searchParams.get('from'), 10) || 1);
      const toPage = Math.min(
        book.totalPages,
        Math.max(fromPage, parseInt(parsedUrl.searchParams.get('to'), 10) || fromPage)
      );
      const format = (parsedUrl.searchParams.get('format') || 'pdf').toLowerCase();

      const selectedPages = book.pages.slice(fromPage - 1, toPage);
      const fileItems = selectedPages
        .map((p) => ({
          name: `${String(p.index + 1).padStart(4, '0')}_${p.filename}`,
          filePath: path.join(config.booksDir, safeFolder, p.filename)
        }))
        .filter((item) => fs.existsSync(item.filePath));

      if (fileItems.length === 0) {
        return sendJson(res, 404, { error: 'Ingen sider funnet i valgt område' });
      }

      const safeTitle = safeFolder.replace(/[^a-zA-Z0-9æøåÆØÅ _-]/g, '').trim() || 'bok';
      const rangeLabel = fromPage === toPage ? `side-${fromPage}` : `side-${fromPage}-${toPage}`;

      if (format === 'zip') {
        const zipBuf = buildZipFromFiles(fileItems);
        const outName = encodeURIComponent(`${safeTitle}_${rangeLabel}.zip`);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zipBuf.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${outName}`
        });
        return res.end(zipBuf);
      } else {
        const pdfBuf = buildPdfFromJpegs(fileItems.map((f) => f.filePath));
        const outName = encodeURIComponent(`${safeTitle}_${rangeLabel}.pdf`);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfBuf.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${outName}`
        });
        return res.end(pdfBuf);
      }
    }

    // ==================== PROFILES API ====================
    if (pathname === '/api/profiles' && req.method === 'GET') {
      const data = getProfilesData();
      const profilesSummary = data.profiles.map((p) => {
        const bookmarkTotal = Object.values(p.bookmarks || {}).reduce(
          (acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0),
          0
        );
        const readingCount = Object.keys(p.progress || {}).length;
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar || '',
          color: p.color || '#00A3FF',
          bookmarkTotal,
          readingCount
        };
      });
      return sendJson(res, 200, { profiles: profilesSummary });
    }

    if (pathname === '/api/profiles' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) {
        return sendJson(res, 400, { error: 'Navn kan ikke være tomt' });
      }
      const data = getProfilesData();
      const newProfile = {
        id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        avatar: typeof body.avatar === 'string' ? body.avatar : '',
        color: typeof body.color === 'string' ? body.color : '#00A3FF',
        createdAt: new Date().toISOString(),
        progress: {},
        bookmarks: {},
        preferences: { ...DEFAULT_PREFERENCES }
      };
      data.profiles.push(newProfile);
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, profile: newProfile });
    }

    if (pathname.startsWith('/api/profiles/') && req.method === 'PUT') {
      const targetId = decodeURIComponent(pathname.slice('/api/profiles/'.length));
      const body = await readRequestBody(req);
      const data = getProfilesData();
      const target = data.profiles.find((p) => p.id === targetId);
      if (!target) {
        return sendJson(res, 404, { error: 'Profil ikke funnet' });
      }
      if (typeof body.name === 'string' && body.name.trim()) {
        target.name = body.name.trim().slice(0, 40);
      }
      if (typeof body.avatar === 'string') {
        target.avatar = body.avatar;
      }
      if (typeof body.color === 'string') {
        target.color = body.color;
      }
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, profile: target });
    }

    if (pathname.startsWith('/api/profiles/') && req.method === 'DELETE') {
      const targetId = decodeURIComponent(pathname.slice('/api/profiles/'.length));
      const data = getProfilesData();
      if (data.profiles.length <= 1) {
        return sendJson(res, 400, { error: 'Kan ikke slette den siste profilen' });
      }
      data.profiles = data.profiles.filter((p) => p.id !== targetId);
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true });
    }

    // ==================== RANDOM BACKDROP API ====================
    if (pathname === '/api/random-backdrop' && req.method === 'GET') {
      const allBooks = scanAllBooks();
      const candidates = [];
      for (const b of allBooks) {
        if (b.format !== 'images') continue;
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
      const config = getConfig();
      const { profile } = getProfileById(profileId);
      const allBooks = scanAllBooks();

      const summarized = allBooks.map((book) => {
        const prog = profile.progress[book.id] || null;
        const bms = profile.bookmarks[book.id] || [];
        return {
          id: book.id,
          title: book.title,
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
        profile: {
          id: profile.id,
          name: profile.name,
          avatar: profile.avatar,
          color: profile.color
        },
        preferences: profile.preferences,
        serverInfo: {
          booksDir: config.booksDir,
          port: PORT,
          lanIps: getLanAddresses()
        }
      });
    }

    // API: Cache rendered cover image + page count for PDF/EPUB books
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/cover-cache') && req.method === 'POST') {
      const bookId = decodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/cover-cache'.length)
      );
      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const body = await readRequestBody(req, 15 * 1024 * 1024);

      if (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:image/')) {
        const base64Part = body.dataUrl.split(',')[1];
        if (base64Part) {
          const buf = Buffer.from(base64Part, 'base64');
          const coverCacheFile = safeCoverCachePath(safeFolder);
          fs.writeFileSync(coverCacheFile, buf);
          imageDimCache.delete(coverCacheFile);
        }
      }

      if (typeof body.pageCount === 'number' && body.pageCount > 0) {
        const currentMeta = loadBookMeta(config.booksDir, safeFolder);
        currentMeta.pageCount = Math.round(body.pageCount);
        saveBookMeta(config.booksDir, safeFolder, currentMeta);
      }

      const updatedBook = parseBookFolder(config.booksDir, safeFolder);
      return sendJson(res, 200, {
        ok: true,
        covers: updatedBook ? updatedBook.covers : null,
        totalPages: updatedBook ? updatedBook.totalPages : null
      });
    }

    // API: Upload an .epub or .pdf file directly into booksDir
    if (pathname === '/api/upload-ebook' && req.method === 'POST') {
      const body = await readRequestBody(req, 160 * 1024 * 1024);
      const rawName = path.basename(String(body.filename || ''));
      const ext = path.extname(rawName).toLowerCase();
      if (!EBOOK_EXTENSIONS.has(ext)) {
        return sendJson(res, 400, { error: 'Kun .epub og .pdf støttes' });
      }
      if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
        return sendJson(res, 400, { error: 'Mangler fildata' });
      }
      const config = getConfig();
      const targetPath = path.join(config.booksDir, rawName);
      const fileBuf = Buffer.from(body.dataBase64, 'base64');
      fs.writeFileSync(targetPath, fileBuf);
      return sendJson(res, 200, { ok: true, id: rawName });
    }

    // API: Shared Book Metadata (forsatsAlene, sizeScale & chapters for all users)
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/meta') && req.method === 'POST') {
      const bookId = decodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/meta'.length)
      );
      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const currentMeta = loadBookMeta(config.booksDir, safeFolder);
      const body = await readRequestBody(req);

      if (typeof body.forsatsAlene === 'boolean') {
        currentMeta.forsatsAlene = body.forsatsAlene;
      }
      if (typeof body.sizeScale === 'number') {
        currentMeta.sizeScale = Math.max(0.5, Math.min(1.5, body.sizeScale));
      }
      if (typeof body.pageCount === 'number' && body.pageCount > 0) {
        currentMeta.pageCount = Math.round(body.pageCount);
      }
      if (Array.isArray(body.chapters)) {
        currentMeta.chapters = body.chapters;
      }

      const saved = saveBookMeta(config.booksDir, safeFolder, currentMeta);
      const updatedBook = parseBookFolder(config.booksDir, safeFolder);
      return sendJson(res, 200, {
        ok: true,
        forsatsAlene: saved.meta.forsatsAlene,
        sizeScale: saved.meta.sizeScale,
        chapters: updatedBook ? updatedBook.chapters : saved.meta.chapters,
        bookJsonPath: saved.bookJsonPath
      });
    }

    // API: Add or update a shared chapter in book.json
    if (pathname.startsWith('/api/books/') && pathname.endsWith('/chapters') && req.method === 'POST') {
      const bookId = decodeURIComponent(
        pathname.slice('/api/books/'.length, pathname.length - '/chapters'.length)
      );
      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const book = parseBookFolder(config.booksDir, safeFolder);
      if (!book) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }

      const body = await readRequestBody(req);
      const pageIndex = Math.max(0, Math.min(book.totalPages - 1, parseInt(body.pageIndex, 10) || 0));
      const title = String(body.title || '').trim().slice(0, 140) || `Kapittel (Side ${pageIndex + 1})`;
      const pageObj = book.pages[pageIndex];

      const currentMeta = loadBookMeta(config.booksDir, safeFolder);
      const existingIdx = currentMeta.chapters.findIndex(
        (c) => (body.id && c.id === body.id) || c.pageIndex === pageIndex
      );

      if (existingIdx !== -1) {
        currentMeta.chapters[existingIdx].title = title;
        currentMeta.chapters[existingIdx].pageIndex = pageIndex;
        currentMeta.chapters[existingIdx].pageFile = pageObj ? pageObj.filename : undefined;
      } else {
        currentMeta.chapters.push({
          id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          pageIndex,
          pageFile: pageObj ? pageObj.filename : undefined
        });
      }

      saveBookMeta(config.booksDir, safeFolder, currentMeta);
      const updatedBook = parseBookFolder(config.booksDir, safeFolder);
      return sendJson(res, 200, {
        ok: true,
        chapters: updatedBook ? updatedBook.chapters : currentMeta.chapters
      });
    }

    // API: Delete shared chapter
    if (pathname.startsWith('/api/books/') && pathname.includes('/chapters/') && req.method === 'DELETE') {
      const rest = pathname.slice('/api/books/'.length);
      const splitIdx = rest.indexOf('/chapters/');
      const bookId = decodeURIComponent(rest.slice(0, splitIdx));
      const chapterId = decodeURIComponent(rest.slice(splitIdx + '/chapters/'.length));

      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const currentMeta = loadBookMeta(config.booksDir, safeFolder);
      currentMeta.chapters = currentMeta.chapters.filter((c) => c.id !== chapterId);
      saveBookMeta(config.booksDir, safeFolder, currentMeta);

      const updatedBook = parseBookFolder(config.booksDir, safeFolder);
      return sendJson(res, 200, {
        ok: true,
        chapters: updatedBook ? updatedBook.chapters : currentMeta.chapters
      });
    }

    // API: Single book detail
    if (pathname.startsWith('/api/books/') && req.method === 'GET') {
      const bookId = decodeURIComponent(pathname.slice('/api/books/'.length));
      const config = getConfig();
      const safeFolder = path.basename(bookId);
      const book = parseBookFolder(config.booksDir, safeFolder);
      if (!book) {
        return sendJson(res, 404, { error: 'Bok ikke funnet' });
      }
      const { profile } = getProfileById(profileId);
      return sendJson(res, 200, {
        ...book,
        bookJsonPath: path.join(config.booksDir, safeFolder, 'book.json'),
        progress: profile.progress[book.id] || null,
        bookmarks: profile.bookmarks[book.id] || [],
        preferences: profile.preferences
      });
    }

    // API: Save reading progress for a book (per profile)
    if (pathname.startsWith('/api/progress/') && req.method === 'POST') {
      const bookId = decodeURIComponent(pathname.slice('/api/progress/'.length));
      const body = await readRequestBody(req);
      const { data, profile } = getProfileById(profileId);

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
      const bookId = decodeURIComponent(pathname.slice('/api/bookmarks/'.length));
      const body = await readRequestBody(req);
      const { data, profile } = getProfileById(profileId);

      if (!profile.bookmarks[bookId]) {
        profile.bookmarks[bookId] = [];
      }

      const pageIndex = Math.max(0, parseInt(body.pageIndex, 10) || 0);
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      const pageLabel = typeof body.pageLabel === 'string' ? body.pageLabel : `Side ${pageIndex + 1}`;

      const existingIdx = profile.bookmarks[bookId].findIndex((b) => b.pageIndex === pageIndex);
      if (existingIdx !== -1 && body.toggle && !body.note) {
        profile.bookmarks[bookId].splice(existingIdx, 1);
      } else if (existingIdx !== -1) {
        profile.bookmarks[bookId][existingIdx].note = note;
        profile.bookmarks[bookId][existingIdx].updatedAt = new Date().toISOString();
      } else {
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
      const bookId = decodeURIComponent(parts[0] || '');
      const bookmarkId = decodeURIComponent(parts[1] || '');
      const { data, profile } = getProfileById(profileId);

      if (profile.bookmarks[bookId]) {
        profile.bookmarks[bookId] = profile.bookmarks[bookId].filter((b) => b.id !== bookmarkId);
        saveJson(PROFILES_FILE, data);
      }
      return sendJson(res, 200, { ok: true, bookmarks: profile.bookmarks[bookId] || [] });
    }

    // API: Save user preferences (per profile)
    if (pathname === '/api/preferences' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const { data, profile } = getProfileById(profileId);
      profile.preferences = {
        ...profile.preferences,
        ...body
      };
      saveJson(PROFILES_FILE, data);
      return sendJson(res, 200, { ok: true, preferences: profile.preferences });
    }

    // API: Update server config (e.g. booksDir)
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const config = getConfig();
      if (typeof body.booksDir === 'string' && body.booksDir.trim()) {
        const candidate = path.resolve(body.booksDir.trim());
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
          return sendJson(res, 400, {
            error: `Mappen finnes ikke: ${candidate}`
          });
        }
        config.booksDir = candidate;
      }
      if (typeof body.password === 'string' && body.password.trim()) {
        config.password = body.password.trim();
      }
      saveJson(CONFIG_FILE, config);
      return sendJson(res, 200, { ok: true, config: { booksDir: config.booksDir } });
    }

    // Serve internal EPUB assets: /epub-resource/:bookId/:internalPath
    if (pathname.startsWith('/epub-resource/') && req.method === 'GET') {
      const parts = pathname.slice('/epub-resource/'.length).split('/');
      if (parts.length < 2) {
        res.writeHead(400);
        res.end('Ugyldig EPUB-ressurs');
        return;
      }
      const bookId = path.basename(decodeURIComponent(parts[0]));
      const internalPath = decodeURIComponent(parts.slice(1).join('/'));
      const config = getConfig();
      const targetPath = path.join(config.booksDir, bookId);
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
      if (!epubFile) {
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
      const ext = path.extname(internalPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': dataBuf.length,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(dataBuf);
    }

    // Serve book image / ebook files: /book-media/:bookId/:filename
    if (pathname.startsWith('/book-media/') && req.method === 'GET') {
      const parts = pathname.slice('/book-media/'.length).split('/');
      if (parts.length < 2) {
        res.writeHead(400);
        res.end('Ugyldig bilde-URL');
        return;
      }
      const bookId = path.basename(decodeURIComponent(parts[0]));
      const filename = path.basename(decodeURIComponent(parts.slice(1).join('/')));
      const config = getConfig();

      if (filename === '__cover') {
        const coverCacheFile = safeCoverCachePath(bookId);
        if (fs.existsSync(coverCacheFile)) {
          return serveFile(req, res, coverCacheFile, 'public, max-age=3600');
        }
        res.writeHead(404);
        res.end('Omslag ikke funnet');
        return;
      }

      if (filename === '__ebook') {
        const directFile = path.join(config.booksDir, bookId);
        const resolvedBooksDir = path.resolve(config.booksDir);
        const resolvedDirect = path.resolve(directFile);
        if (resolvedDirect.startsWith(resolvedBooksDir) && fs.existsSync(resolvedDirect) && fs.statSync(resolvedDirect).isFile()) {
          return serveFile(req, res, resolvedDirect, 'public, max-age=86400');
        }
        res.writeHead(404);
        res.end('E-bok ikke funnet');
        return;
      }

      const filePath = path.join(config.booksDir, bookId, filename);

      const resolvedBooksDir = path.resolve(config.booksDir);
      const resolvedFile = path.resolve(filePath);
      if (!resolvedFile.startsWith(resolvedBooksDir)) {
        res.writeHead(403);
        res.end('Ingen tilgang');
        return;
      }

      return serveFile(req, res, resolvedFile, 'public, max-age=86400');
    }

    // Serve static frontend files
    let staticPath = pathname === '/' ? '/index.html' : pathname;
    const resolvedStatic = path.resolve(PUBLIC_DIR, '.' + staticPath);
    if (!resolvedStatic.startsWith(path.resolve(PUBLIC_DIR))) {
      res.writeHead(403);
      res.end('Ingen tilgang');
      return;
    }

    if (fs.existsSync(resolvedStatic) && fs.statSync(resolvedStatic).isFile()) {
      return serveFile(req, res, resolvedStatic, 'no-store, no-cache, must-revalidate, max-age=0');
    }

    return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'), 'no-store, no-cache, must-revalidate, max-age=0');
  } catch (err) {
    console.error('Serverfeil:', err);
    sendJson(res, 500, { error: 'Intern serverfeil', details: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const config = getConfig();
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
  console.log('==================================================');
});
