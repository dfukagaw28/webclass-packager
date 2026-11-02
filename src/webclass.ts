// WebClass 教材（Textbook 型）エクスポート形式の読み書きと生成ロジック
import { readZip, ZipWriter } from "./zip";

export const SEP = "@#@";
export const B64_TABLES = new Set([
  "content_folder.tbl",
  "content_folder_contents_name.tbl",
  "contents_name.tbl",
  "object_table.tbl",
  "sco.tbl",
  "scorm.tbl",
  "text_book.tbl",
  "textbook_style.tbl",
]);
const CSV_HEADER = ["chapter", "section", "file", "htmlfile", "attach_file", "text"];

export interface Table { header: string[]; rows: Record<string, string>[] }
export type Tables = Record<string, Table>;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

function b64encUtf8(s: string): string {
  const b = enc.encode(s);
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decUtf8(s: string): string {
  const bin = atob(s.trim());
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return dec.decode(b);
}

export function decodeTable(data: Uint8Array, b64: boolean): Table {
  let lines = dec.decode(data).split(/\r?\n/).filter((l) => l.trim());
  if (b64) lines = lines.map(b64decUtf8);
  const header = lines[0].split(SEP);
  const rows = lines.slice(1).map((l) => {
    const v = l.split(SEP);
    return Object.fromEntries(header.map((h, i) => [h, v[i] ?? ""]));
  });
  return { header, rows };
}

export function encodeTable(t: Table, b64: boolean): Uint8Array {
  let lines = [t.header.join(SEP), ...t.rows.map((r) => t.header.map((h) => r[h] ?? "").join(SEP))];
  if (b64) lines = lines.map(b64encUtf8);
  return enc.encode(lines.join("\n") + "\n");
}

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** WebClass エクスポート zip から .tbl を読み込む */
export async function readTemplate(buf: ArrayBuffer): Promise<Tables> {
  const tables: Tables = {};
  for (const e of readZip(buf)) {
    const b = baseName(e.name);
    if (e.isDir || !b.endsWith(".tbl")) continue;
    if (b === "control.tbl" || B64_TABLES.has(b)) tables[b] = decodeTable(await e.read(), B64_TABLES.has(b));
  }
  const missing = ["control.tbl", "contents_name.tbl", "text_book.tbl"].filter((k) => !tables[k]);
  if (missing.length) throw new Error(`WebClass のエクスポート zip ではないようです（${missing.join(", ")} がありません）`);
  return tables;
}

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
export interface Page { heading: string; file: string; attach: string }
export interface Settings {
  title: string;
  folder: string;
  folderOrder: string;
  start: string;   // "YYYY-MM-DDTHH:MM"（JST として解釈）
  end: string;
  mode: "full" | "csv";
  /** 授業 ID（group_id）をダミーにする。同じ科目へ戻すときの「同じ ID」警告を避ける */
  dummyGroup?: boolean;
}

/** 実在しない授業 ID。桁数は雛形に合わせ、すべて 9 にする */
export const dummyGroupId = (real: string) => "9".repeat(Math.max(real.length, 1));
export type Files = Map<string, Uint8Array>;

/** "YYYY-MM-DDTHH:MM[:SS]" を JST として UNIX 秒へ */
export function jstEpoch(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h = "0", mi = "0", se = "0"] = m;
  return Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +se) / 1000;
}
function jstNowString(): string {
  return new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
}

export interface Issues { errors: string[]; warnings: string[] }
const HREF_RE = /<a\s[^>]*href="([\w.\-/]+\.\w+)"/gi;

export function validate(tpl: Tables | null, files: Files, pages: Page[], s: Settings): Issues {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!tpl) errors.push("雛形（WebClass からエクスポートした zip）が読み込まれていません");
  if (!pages.length) errors.push("ページが 1 つもありません");
  if (!s.title.trim()) errors.push("教材名が空です");
  const st = jstEpoch(s.start), en = jstEpoch(s.end);
  if (isNaN(st) || isNaN(en)) errors.push("公開期間の日時が正しくありません");
  else if (en <= st) errors.push("公開終了が公開開始より前です");

  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  pages.forEach((p, i) => {
    const n = `p${i + 1}`;
    if (!p.heading.trim()) errors.push(`${n}: 見出しが空です`);
    if (!p.file) errors.push(`${n}「${p.heading}」: 本文ファイルが選ばれていません`);
    for (const f of [p.file, p.attach].filter(Boolean)) {
      if (!files.has(f)) errors.push(`${n}「${p.heading}」: ファイル ${f} が読み込まれていません`);
      if (/[\\/]/.test(f)) errors.push(`${n}: ファイル名にディレクトリを含められません: ${f}`);
    }
    if (p.file && !/\.(html?|pdf)$/i.test(p.file)) warnings.push(`${n}: 本文ファイルが .html / .pdf 以外です: ${p.file}`);
    if (p.file) bump("F:" + p.file);
    if (p.attach) bump("A:" + p.attach);
  });
  for (const [k, n] of count) {
    if (n > 1) errors.push(`同じファイル名が ${n} ページで使われています: ${k.slice(2)}（contents/ では 1 つしか残らず、学生も区別できません）`);
  }

  const known = new Set(pages.flatMap((p) => [p.file, p.attach]).filter(Boolean));
  pages.forEach((p, i) => {
    const d = files.get(p.file);
    if (!d || !/\.html?$/i.test(p.file)) return;
    const html = dec.decode(d);
    const hrefs = new Set([...html.matchAll(HREF_RE)].map((m) => m[1]));
    for (const h of hrefs) if (!known.has(h)) warnings.push(`p${i + 1}: HTML 内の相対リンク '${h}' に対応するファイルが教材内にありません`);
  });
  const used = new Set(known);
  for (const f of files.keys()) if (!used.has(f)) warnings.push(`読み込んだファイル ${f} はどのページにも使われていません`);
  return { errors, warnings };
}

function csvBytes(rows: string[][], bom: boolean): Uint8Array {
  const q = (v: string) => (/[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = [CSV_HEADER, ...rows].map((r) => r.map(q).join(",") + "\r\n").join("");
  const body = enc.encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

export async function buildZip(
  tpl: Tables, files: Files, pages: Page[], s: Settings,
  onProgress?: (d: number, t: number) => void,
): Promise<{ blob: Blob; contentsId: string }> {
  const now = jstNowString();
  const cid = newId();
  const tcn = tpl["contents_name.tbl"];
  const base = { ...tcn.rows[0] };
  const groupId = s.dummyGroup ? dummyGroupId(base.group_id ?? "") : base.group_id ?? "";
  const authorId = base.auther_id ?? "";

  const tb: Record<string, string>[] = [];
  const csv: string[][] = [];
  const textFiles: [string, Uint8Array][] = [];
  const contentsFiles: [string, Uint8Array][] = [];
  const seen = new Set<string>();
  const addContents = (n: string, d: Uint8Array) => { if (!seen.has(n)) { seen.add(n); contentsFiles.push([n, d]); } };
  const row = (page: string, tag: string, format: string, contents: string, file_name: string, order: string) =>
    tb.push({ text_book_id: newId(), contents_id: cid, page_no: page, tag, format, contents, file_name, contents_order: order });

  pages.forEach((p, i) => {
    const no = String(i + 1);
    row(no, "H2", "legacy-html", p.heading, "", "1");
    row(no, "TEXT", "tiptap-html", "", "", "2");
    const body = files.get(p.file)!;
    let stored: string;
    if (/\.pdf$/i.test(p.file)) {
      const d = newId();
      stored = `${d}/${d.slice(16)}.pdf`;
      textFiles.push([`${d}/${d.slice(16)}`, body], [stored, body]);
    } else {
      const h = newId();
      stored = `${h}.html`;
      textFiles.push([h, body], [stored, body]);
    }
    row(no, "FILE", "text", stored, p.file, "3");
    addContents(stored, body);
    addContents(p.file, body);
    if (p.attach) {
      const att = files.get(p.attach)!;
      const ah = newId();
      textFiles.push([ah, att]);
      row(no, "ATTACH", "text", ah, p.attach, "4");
      addContents(p.attach, att);
    }
    csv.push(["", p.heading, p.file, stored, p.attach, ""]);
  });

  const z = new ZipWriter();
  if (s.mode === "csv") {
    for (const [n, d] of contentsFiles) z.add(n, d);
    z.add("textbook.csv", csvBytes(csv, true));
    z.add("textbook-utf8.txt", csvBytes(csv, false));
    return { blob: await z.build(onProgress), contentsId: cid };
  }

  const cn: Table = {
    header: tcn.header,
    rows: [{
      ...base,
      contents_id: cid,
      contents_name: s.title,
      group_id: groupId,
      start_date: String(jstEpoch(s.start)),
      end_date: String(jstEpoch(s.end)),
      updated: now,
      created_at: now,
    }],
  };
  const ctrl = tpl["control.tbl"];
  const control: Table = {
    header: ctrl.header,
    rows: [{ ...(ctrl.rows[0] ?? {}), contents_id: cid, contents_name: s.title, contents_kind: "Textbook", group_id: groupId, auther_id: authorId }],
  };
  const headerOnly = (n: string): Table | null => (tpl[n] ? { header: tpl[n].header, rows: [] } : null);

  z.add(`${cid}/text_book.tbl`, encodeTable({ header: tpl["text_book.tbl"].header, rows: tb }, true));
  const ot = headerOnly("object_table.tbl");
  if (ot) z.add(`${cid}/object_table.tbl`, encodeTable(ot, true));
  z.add(`${cid}/contents_name.tbl`, encodeTable(cn, true));
  for (const n of ["sco.tbl", "scorm.tbl"]) {
    const t = headerOnly(n);
    if (t) z.add(`${cid}/${n}`, encodeTable(t, true));
  }
  const st = tpl["textbook_style.tbl"];
  if (st) z.add(`${cid}/textbook_style.tbl`, encodeTable({ header: st.header, rows: [{ ...(st.rows[0] ?? {}), contents_id: cid }] }, true));
  z.dir(`${cid}/objects`);
  for (const [n, d] of textFiles) z.add(`${cid}/text/${n}`, d);

  if (s.folder.trim()) {
    const ft = tpl["content_folder.tbl"];
    const fct = tpl["content_folder_contents_name.tbl"];
    const fid = newId();
    const order = s.folderOrder.trim() || ft?.rows[0]?.folder_order || "0";
    z.add("content_folder.tbl", encodeTable({
      header: ft?.header ?? ["folder_id", "group_id", "name", "folder_order"],
      rows: [{ folder_id: fid, group_id: groupId, name: s.folder.trim(), folder_order: order }],
    }, true));
    z.add("content_folder_contents_name.tbl", encodeTable({
      header: fct?.header ?? ["folder_id", "contents_id"],
      rows: [{ folder_id: fid, contents_id: cid }],
    }, true));
  }
  z.dir("contents");
  for (const [n, d] of contentsFiles) z.add(`contents/${n}`, d);
  z.add("contents/textbook-utf8.txt", csvBytes(csv, false));
  z.add("contents/textbook.csv", csvBytes(csv, true));
  z.add("control.tbl", encodeTable(control, false));
  return { blob: await z.build(onProgress), contentsId: cid };
}

// ---------------------------------------------------------------------------
// ファイル名からページ構成を推定
const KIND: [RegExp, string, number][] = [
  [/^(slides?|slide-deck|presentation)$/i, "スライド", 0],
  [/^(intro|notes?|lecture|handout|text)$/i, "講義資料", 1],
  [/^(homework|hw|assignment|report)$/i, "提出課題", 2],
  [/^(homework|hw|assignment|report)-?sheet$/i, "提出課題　解答用紙", 3],
];

export function guessPages(names: string[]): { pages: Page[]; week: number | null } {
  const groups = new Map<string, { html?: string; pdf?: string; other?: string }>();
  let week: number | null = null;
  for (const n of names) {
    const m = n.match(/^(.*?)\.(html?|pdf|[^.]+)$/i);
    const stem = m ? m[1] : n;
    const ext = (m?.[2] ?? "").toLowerCase();
    const g = groups.get(stem) ?? {};
    if (ext.startsWith("htm")) g.html = n; else if (ext === "pdf") g.pdf = n; else g.other = n;
    groups.set(stem, g);
    const w = stem.match(/^W(\d+)/i);
    if (w && week === null) week = parseInt(w[1], 10);
  }
  const list = [...groups.entries()].map(([stem, g]) => {
    const suffix = stem.replace(/^W\d+[-_]?/i, "");
    const k = KIND.find(([re]) => re.test(suffix));
    const file = g.html ?? g.pdf ?? g.other!;
    return {
      order: k ? k[2] : 10,
      stem,
      page: { heading: k ? k[1] : suffix || stem, file, attach: g.pdf ?? "" },
    };
  });
  list.sort((a, b) => a.order - b.order || a.stem.localeCompare(b.stem));
  return { pages: list.map((x) => x.page), week };
}
