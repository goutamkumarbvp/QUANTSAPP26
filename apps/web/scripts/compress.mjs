/**
 * Pre-compresses the built web app (dist/) so the server sends brotli / gzip files without compressing on
 * every request (@fastify/static preCompressed): every text asset of at least 1 KB gets a .br (quality 11)
 * and a .gz (level 9) next to it. The JavaScript is about a third of its size over the wire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/;
let files = 0;
let raw = 0;
let br = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (TEXT.test(e.name)) {
      const buf = fs.readFileSync(p);
      if (buf.length < 1024) continue;
      const b = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
      fs.writeFileSync(`${p}.br`, b);
      fs.writeFileSync(`${p}.gz`, zlib.gzipSync(buf, { level: 9 }));
      files++;
      raw += buf.length;
      br += b.length;
    }
  }
};
walk(dist);
console.log(`compressed ${files} files: ${(raw / 1024).toFixed(0)} KB → ${(br / 1024).toFixed(0)} KB brotli`);
