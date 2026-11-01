// 依存なしの最小 zip 読み書き（CompressionStream / DecompressionStream の deflate-raw を使用）

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const deflateRaw = (d: Uint8Array) => pipe(d, new CompressionStream("deflate-raw"));
export const inflateRaw = (d: Uint8Array) => pipe(d, new DecompressionStream("deflate-raw"));

export interface ZipEntry {
  name: string;
  isDir: boolean;
  size: number;
  read(): Promise<Uint8Array>;
}

/** zip の中央ディレクトリを読み、エントリ一覧を返す（中身は read() で遅延展開） */
export function readZip(buf: ArrayBuffer): ZipEntry[] {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip ファイルではありません（終端レコードが見つかりません）");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder("utf-8");
  let sjis: TextDecoder | null = null;
  try { sjis = new TextDecoder("shift_jis"); } catch { /* 未対応ブラウザ */ }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip の中央ディレクトリが壊れています");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const raw = u8.subarray(p + 46, p + 46 + nlen);
    const isAscii = raw.every((b) => b < 0x80);
    const name = flags & 0x800 || isAscii || !sjis ? utf8.decode(raw) : sjis.decode(raw);
    p += 46 + nlen + xlen + clen;
    entries.push({
      name,
      isDir: name.endsWith("/"),
      size: usize,
      async read() {
        const ln = dv.getUint16(lho + 26, true);
        const lx = dv.getUint16(lho + 28, true);
        const start = lho + 30 + ln + lx;
        const data = u8.subarray(start, start + csize);
        if (method === 0) return data.slice();
        if (method === 8) return inflateRaw(data);
        throw new Error(`未対応の圧縮方式です (${method}): ${name}`);
      },
    });
  }
  return entries;
}

interface Pending { name: Uint8Array; data: Uint8Array; isDir: boolean }

/** エントリを順に追加し、build() で zip の Blob を作る */
export class ZipWriter {
  private items: Pending[] = [];
  private dirs = new Set<string>();
  private enc = new TextEncoder();

  private ensureDir(dir: string) {
    if (!dir || this.dirs.has(dir)) return;
    const i = dir.lastIndexOf("/");
    if (i > 0) this.ensureDir(dir.slice(0, i));
    this.dirs.add(dir);
    this.items.push({ name: this.enc.encode(dir + "/"), data: new Uint8Array(0), isDir: true });
  }
  dir(path: string) { this.ensureDir(path.replace(/\/$/, "")); }
  add(path: string, data: Uint8Array) {
    const i = path.lastIndexOf("/");
    if (i > 0) this.ensureDir(path.slice(0, i));
    this.items.push({ name: this.enc.encode(path), data, isDir: false });
  }

  async build(onProgress?: (done: number, total: number) => void): Promise<Blob> {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    let done = 0;
    for (const it of this.items) {
      const crc = it.isDir ? 0 : crc32(it.data);
      let method = 0;
      let body = it.data;
      if (!it.isDir && it.data.length > 0) {
        const c = await deflateRaw(it.data);
        if (c.length < it.data.length) { method = 8; body = c; }
      }
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x800, true); // UTF-8 ファイル名
      lh.setUint16(8, method, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, body.length, true);
      lh.setUint32(22, it.data.length, true);
      lh.setUint16(26, it.name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), it.name as BlobPart, body as BlobPart);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, (3 << 8) | 20, true); // made by: Unix
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x800, true);
      ch.setUint16(10, method, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, body.length, true);
      ch.setUint32(24, it.data.length, true);
      ch.setUint16(28, it.name.length, true);
      ch.setUint32(38, it.isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, true);
      ch.setUint32(42, offset, true);
      const c = new Uint8Array(46 + it.name.length);
      c.set(new Uint8Array(ch.buffer), 0);
      c.set(it.name, 46);
      central.push(c);
      offset += 30 + it.name.length + body.length;
      onProgress?.(++done, this.items.length);
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    return new Blob([...parts, ...(central as BlobPart[]), new Uint8Array(eocd.buffer)], { type: "application/zip" });
  }
}
