#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const vm = require('vm');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const ROOT_DIR = path.resolve(__dirname, '..');
const PREVIEWS_DIR = path.join(ROOT_DIR, 'previews');
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const WAIT_AFTER_LOAD_MS = 2000;
const DEFAULT_PLACEHOLDER_SIZE = { width: 640, height: 360 };

function readManifest() {
  const manifestPath = path.join(ROOT_DIR, 'tool-manifest.js');
  const code = fs.readFileSync(manifestPath, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.toolManifest || [];
}

function slugify(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensurePreviewsDir() {
  if (!fs.existsSync(PREVIEWS_DIR)) {
    fs.mkdirSync(PREVIEWS_DIR);
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.webm': 'video/webm'
  };
  return map[ext] || 'application/octet-stream';
}

function createStaticServer(rootDir) {
  const streamFile = (res, filePath, stats, rangeHeader) => {
    const headers = {
      'Content-Type': getContentType(filePath),
      'Accept-Ranges': 'bytes'
    };

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : stats.size - 1;
        const chunkSize = end - start + 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
        headers['Content-Length'] = chunkSize;
        res.writeHead(206, headers);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    headers['Content-Length'] = stats.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  };

  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url);
    let pathname = decodeURIComponent(parsed.pathname || '/');
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const requestedPath = path.join(rootDir, pathname);
    const resolvedPath = requestedPath.startsWith(rootDir)
      ? requestedPath
      : rootDir;

    try {
      let stats = await fs.promises.stat(resolvedPath);
      let servePath = resolvedPath;
      if (stats.isDirectory()) {
        servePath = path.join(resolvedPath, 'index.html');
        stats = await fs.promises.stat(servePath);
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': getContentType(servePath),
          'Content-Length': stats.size,
          'Accept-Ranges': 'bytes'
        });
        res.end();
        return;
      }

      streamFile(res, servePath, stats, req.headers.range);
    } catch (err) {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
}

async function startServer() {
  const server = createStaticServer(ROOT_DIR);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] = [0, 0, 0];
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else if (hp < 6) [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];

  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcBuffer = Buffer.alloc(4);
    const crc = crc32(Buffer.concat([typeBuffer, data]));
    crcBuffer.writeUInt32BE(crc >>> 0, 0);
    chunks.push(Buffer.concat([length, typeBuffer, data, crcBuffer]));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  createChunk('IHDR', ihdr);

  const rawData = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    rawData[rowStart] = 0; // filter type 0
    pixels.copy(rawData, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawData);
  createChunk('IDAT', compressed);
  createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ...chunks]);
}

function createPlaceholderPng(slug, width = DEFAULT_VIEWPORT.width, height = DEFAULT_VIEWPORT.height) {
  const pixels = Buffer.alloc(width * height * 4);
  const baseHue = hashString(slug) % 360;
  const accentHue = (baseHue + 180) % 360;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const mix = x / width;
      const hue = baseHue * (1 - mix) + accentHue * mix;
      const [r, g, b] = hslToRgb(hue, 0.55, 0.55 - 0.1 * Math.sin((y / height) * Math.PI));
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }
  return buildPng(width, height, pixels);
}

function createPlaceholderSvg(slug, width = DEFAULT_PLACEHOLDER_SIZE.width, height = DEFAULT_PLACEHOLDER_SIZE.height) {
  const baseHue = hashString(slug) % 360;
  const accentHue = (baseHue + 120) % 360;
  const textHue = (baseHue + 300) % 360;
  const gradientId = `${slug}-grad`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="${gradientId}" x1="0%" x2="100%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="hsl(${baseHue}, 60%, 55%)" />
      <stop offset="50%" stop-color="hsl(${accentHue}, 65%, 50%)" />
      <stop offset="100%" stop-color="hsl(${(accentHue + 40) % 360}, 70%, 45%)" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gradientId})" />
  <circle cx="${width * 0.2}" cy="${height * 0.3}" r="${width * 0.18}" fill="hsla(${accentHue}, 70%, 60%, 0.4)" />
  <circle cx="${width * 0.75}" cy="${height * 0.25}" r="${width * 0.22}" fill="hsla(${baseHue}, 60%, 55%, 0.3)" />
  <circle cx="${width * 0.55}" cy="${height * 0.72}" r="${width * 0.28}" fill="hsla(${textHue}, 65%, 50%, 0.28)" />
  <text x="50%" y="54%" font-family="'Helvetica Neue', Arial, sans-serif" font-size="${Math.max(16, width * 0.05)}" font-weight="600" letter-spacing="1" fill="hsla(${textHue}, 80%, 90%, 0.9)" text-anchor="middle">
    ${slug.replace(/_/g, ' ')}
  </text>
  <text x="50%" y="68%" font-family="'Helvetica Neue', Arial, sans-serif" font-size="${Math.max(12, width * 0.03)}" font-weight="400" fill="hsla(${textHue}, 80%, 90%, 0.75)" text-anchor="middle">
    poster placeholder
  </text>
</svg>`;

  return svg;
}

async function captureWithPlaywright(tools) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    throw new Error('Playwright is not installed. Run "npm install playwright" to enable screenshots.');
  }

  const { server, port } = await startServer();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });

  try {
    for (const tool of tools) {
      const page = await context.newPage();
      const url = `http://localhost:${port}/${tool.file}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(WAIT_AFTER_LOAD_MS);
      const target = (await page.$('canvas')) || (await page.$('main')) || (await page.$('body'));
      if (!target) {
        throw new Error(`No capture target found for ${tool.name}`);
      }
      const slug = slugify(tool.file);
      const outputPath = path.join(PREVIEWS_DIR, `${slug}.png`);
      await target.screenshot({ path: outputPath });
      console.log(`Captured ${outputPath}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

async function createPlaceholders(tools, { svgOutput = false } = {}) {
  ensurePreviewsDir();
  for (const tool of tools) {
    const slug = slugify(tool.file);
    const outputPath = path.join(PREVIEWS_DIR, `${slug}.${svgOutput ? 'svg' : 'png'}`);
    if (svgOutput) {
      const svg = createPlaceholderSvg(slug);
      fs.writeFileSync(outputPath, svg, 'utf8');
    } else {
      const png = createPlaceholderPng(slug);
      fs.writeFileSync(outputPath, png);
    }
    console.log(`Generated placeholder poster at ${outputPath}`);
  }
}

async function main() {
  const manifest = readManifest();
  const toolsWithoutVideo = manifest.filter((entry) => !entry.video);
  const usePlaceholders = process.argv.includes('--placeholders');
  const useSvgPlaceholders = process.argv.includes('--svg-placeholders');

  ensurePreviewsDir();

  if (toolsWithoutVideo.length === 0) {
    console.log('All tools already have videos; nothing to capture.');
    return;
  }

  if (usePlaceholders) {
    await createPlaceholders(toolsWithoutVideo, { svgOutput: useSvgPlaceholders });
    return;
  }

  await captureWithPlaywright(toolsWithoutVideo);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
