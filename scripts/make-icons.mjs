// @ts-check
/**
 * The tray icon.
 *
 * The tray needs a **small** image: Windows scales the icon into a 16×16
 * box, and a large picture is drawn tiny and muddy.
 *
 * The picture is the Mini App's own `fuzzy` skin — the bot face the upstream
 * client already uses as its brand mark — so the tray and the app's icon are
 * the same face, and the upstream art keeps its notice.
 *
 * The image is drawn by hand, so that the build has no dependency on an
 * image library: a 32×32 RGBA PNG is a few hundred bytes of zlib data.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const buildDir = join(root, 'build');

/** The size the tray icon is drawn at. */
const SIZE = 32;

/**
 * The PNG's signature and the chunk that says how big the picture is.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The CRC table PNG chunks need. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC of a chunk's type and data. */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: its length, its type, its data and its CRC. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * Write an RGBA PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} pixels the RGBA bytes, row by row
 */
function writePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // the bit depth
  header.writeUInt8(6, 9); // the colour type: RGBA
  header.writeUInt8(0, 10); // the compression
  header.writeUInt8(0, 11); // the filter
  header.writeUInt8(0, 12); // the interlace

  // Every row is prefixed with its filter byte; zero means "no filter".
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read the upstream skin image.
 *
 * Only what the tray icon needs is read: the image's size and its pixels.
 * The file is a PNG, and PNG's pixels are deflated and filtered — the filters
 * are undone here.
 */
function readPng(file) {
  const buffer = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  /** @type {Buffer[]} */
  const data = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-row filters.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= bytesPerPixel ? pixels[outStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[outStart - stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[outStart - stride + x - bytesPerPixel] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          restored = value + predictor;
          break;
        }
        default:
          throw new Error(`Unknown PNG filter ${filter}.`);
      }
      pixels[outStart + x] = restored & 0xff;
    }
  }

  return { width, height, pixels };
}

/**
 * Downscale an image with a box filter.
 *
 * A tray icon is 16 or 32 pixels wide, so the 256-pixel source is reduced by
 * an integer factor. The box filter averages every source pixel that falls
 * into the target pixel, which keeps the edges soft rather than jagged.
 */
function downscale(source, targetSize) {
  const factor = source.width / targetSize;
  const out = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const x0 = Math.floor(x * factor);
      const y0 = Math.floor(y * factor);
      const x1 = Math.min(source.width, Math.ceil((x + 1) * factor));
      const y1 = Math.min(source.height, Math.ceil((y + 1) * factor));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * source.width + sx) * 4;
          const alpha = source.pixels[index + 3] ?? 0;
          // The colour is weighted by the alpha, so that a transparent
          // source pixel does not drag the colour towards black.
          r += (source.pixels[index] ?? 0) * alpha;
          g += (source.pixels[index + 1] ?? 0) * alpha;
          b += (source.pixels[index + 2] ?? 0) * alpha;
          a += alpha;
          count += 1;
        }
      }
      const outIndex = (y * targetSize + x) * 4;
      if (a === 0 || count === 0) {
        out[outIndex] = 0;
        out[outIndex + 1] = 0;
        out[outIndex + 2] = 0;
        out[outIndex + 3] = 0;
        continue;
      }
      out[outIndex] = Math.round(r / a);
      out[outIndex + 1] = Math.round(g / a);
      out[outIndex + 2] = Math.round(b / a);
      out[outIndex + 3] = Math.round(a / count);
    }
  }
  return out;
}

mkdirSync(buildDir, { recursive: true });

const skinFile = join(root, 'vendor', 'minimax-bot', 'miniapp', 'client', 'skins', 'fuzzy.png');
const source = readPng(skinFile);

// The tray icon, at the size Windows asks for.
const trayPixels = downscale(source, SIZE);
writeFileSync(join(buildDir, 'tray-icon.png'), writePng(SIZE, SIZE, trayPixels));

// A 64-pixel icon, for the app's own window on the taskbar.
const iconPixels = downscale(source, 64);
writeFileSync(join(buildDir, 'icon-64.png'), writePng(64, 64, iconPixels));

// eslint-disable-next-line no-console
console.log(`The tray icon and the app icon are ready in build/.`);
