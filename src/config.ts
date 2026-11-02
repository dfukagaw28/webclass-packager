// 教材の構成（設定とページ）を YAML で読み書きする。外部ライブラリを使わず、必要な範囲の YAML だけを扱う
//
//   title: 講義資料02
//   folder: 第 2 回
//   start: 2026-10-02 09:00
//   end: 2027-03-31            # 時刻を省略すると 23:59
//   pages:
//     - heading: スライド
//       file: W02-slides.html
//       attach: W02-slides.pdf
//     - W02-homework.pdf       # ファイル名だけなら見出しはファイル名から推定
import { Page, guessPages } from "./webclass";

/** YAML で指定された項目。書かれなかった項目は undefined */
export interface Config {
  title?: string;
  folder?: string;
  folderOrder?: string;
  start?: { date: string; time: string };
  end?: { date: string; time: string };
  mode?: "full" | "csv";
  dummyGroup?: boolean;
  output?: string;
  pages?: Page[];
}

const KEYS: Record<string, keyof Config> = {
  title: "title", folder: "folder", folder_order: "folderOrder", start: "start", end: "end",
  mode: "mode", dummy_group: "dummyGroup", output: "output", pages: "pages",
};
const PAGE_KEYS = ["heading", "file", "attach"] as const;

/** 行末コメントを除き、引用符を外したスカラー値 */
function scalar(raw: string, where: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);
    if (!m) throw new Error(`${where}: 閉じていない " があります`);
    return m[1].replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t" } as Record<string, string>)[c] ?? c);
  }
  if (s.startsWith("'")) {
    const m = s.match(/^'((?:[^']|'')*)'\s*(#.*)?$/);
    if (!m) throw new Error(`${where}: 閉じていない ' があります`);
    return m[1].replace(/''/g, "'");
  }
  return s.replace(/(^|\s)#.*$/, "").trim();
}

function dateTime(v: string, defTime: string, where: string): { date: string; time: string } {
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/);
  if (!m) throw new Error(`${where}: 日時は「2026-10-02 09:00」または「2026-10-02」の形で書いてください: ${v}`);
  return { date: m[1], time: m[2] ? `${m[2].padStart(2, "0")}:${m[3]}` : defTime };
}

function bool(v: string, where: string): boolean {
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  throw new Error(`${where}: true か false を指定してください: ${v}`);
}

/** YAML を読む。書式の誤りは行番号つきの Error を投げる */
export function parseConfig(text: string): Config {
  const cfg: Config = {};
  let inPages = false;
  let cur: Page | null = null;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `${i + 1} 行目`;
    if (!line.trim() || /^\s*#/.test(line) || /^(---|\.\.\.)\s*$/.test(line)) return;
    if (/\t/.test(line.match(/^\s*/)![0])) throw new Error(`${at}: 字下げにタブは使えません`);
    const indent = line.match(/^ */)![0].length;
    const body = line.trim();

    if (indent === 0) {
      const m = body.match(/^([\w-]+)\s*:(?:\s+(.*))?$/);
      if (!m) throw new Error(`${at}: 「項目名: 値」の形ではありません`);
      const key = KEYS[m[1]];
      if (!key) throw new Error(`${at}: 知らない項目です: ${m[1]}（使える項目: ${Object.keys(KEYS).join(", ")}）`);
      const v = scalar(m[2] ?? "", at);
      inPages = key === "pages";
      cur = null;
      if (inPages) {
        if (v && v !== "[]") throw new Error(`${at}: pages は次の行から「- heading: …」の形で並べてください`);
        cfg.pages = [];
        return;
      }
      switch (key) {
        case "start": cfg.start = dateTime(v, "00:00", at); break;
        case "end": cfg.end = dateTime(v, "23:59", at); break;
        case "mode":
          if (v !== "full" && v !== "csv") throw new Error(`${at}: mode は full か csv です: ${v}`);
          cfg.mode = v; break;
        case "dummyGroup": cfg.dummyGroup = bool(v, at); break;
        default: (cfg as Record<string, unknown>)[key] = v;
      }
      return;
    }

    if (!inPages) throw new Error(`${at}: 字下げされた行は pages の中にだけ書けます`);
    let rest = body;
    if (rest.startsWith("- ") || rest === "-") {
      cur = { heading: "", file: "", attach: "" };
      cfg.pages!.push(cur);
      rest = rest.slice(1).trim();
      if (!rest) return;
      if (!/^[\w-]+\s*:(\s|$)/.test(rest)) { // 「- ファイル名」だけの短縮形
        cur.file = scalar(rest, at);
        cur.heading = guessPages([cur.file]).pages[0]?.heading ?? cur.file;
        cur = null;
        return;
      }
    } else if (!cur) {
      throw new Error(`${at}: ページは「- heading: …」のように - で始めてください`);
    }
    const m = rest.match(/^([\w-]+)\s*:(?:\s+(.*))?$/);
    if (!m) throw new Error(`${at}: 「項目名: 値」の形ではありません`);
    if (!(PAGE_KEYS as readonly string[]).includes(m[1])) throw new Error(`${at}: ページの項目は ${PAGE_KEYS.join(", ")} です: ${m[1]}`);
    cur![m[1] as (typeof PAGE_KEYS)[number]] = scalar(m[2] ?? "", at);
  });
  return cfg;
}

/** 必要なときだけ引用符で囲む */
function q(v: string): string {
  if (v === "" || /^[\s\-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|:$|\s$|^(true|false|yes|no|on|off|null|~)$/i.test(v) || /^[\d.+-]+$/.test(v)) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return v;
}

/** 現在の画面の内容を YAML にする */
export function toYaml(c: Required<Omit<Config, "pages">> & { pages: Page[] }): string {
  const dt = (x: { date: string; time: string }) => `${x.date} ${x.time}`;
  const out = [
    `title: ${q(c.title)}`,
    `folder: ${q(c.folder)}` + (c.folder ? "" : "   # 空ならフォルダを作らない"),
    ...(c.folderOrder ? [`folder_order: ${c.folderOrder}`] : []),
    `start: ${dt(c.start)}`,
    `end: ${dt(c.end)}`,
    `mode: ${c.mode}`,
    `dummy_group: ${c.dummyGroup}`,
    `output: ${q(c.output)}`,
    "pages:",
  ];
  for (const p of c.pages) {
    out.push(`  - heading: ${q(p.heading)}`, `    file: ${q(p.file)}`);
    if (p.attach) out.push(`    attach: ${q(p.attach)}`);
  }
  return out.join("\n") + "\n";
}
