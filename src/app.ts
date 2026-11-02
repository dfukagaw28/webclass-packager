import { readZip } from "./zip";
import {
  B64_TABLES, Files, Page, Settings, Tables, baseName, buildZip, decodeTable, guessPages, readTemplate, validate,
} from "./webclass";

// ---------------------------------------------------------------------------
// 小さな DOM ヘルパ
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}
const fmtSize = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(0) + " KB" : n + " B");

// ---------------------------------------------------------------------------
// 状態
const LS_KEY = "webclass-textbook-template.v1";
let template: { source: string; tables: Tables } | null = null;
const files: Files = new Map();
let pages: Page[] = [];
const touched = new Set<string>(); // ユーザーが手で編集した設定項目

try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) template = JSON.parse(raw);
} catch { /* 保存領域が使えない環境 */ }

function settings(): Settings {
  return {
    title: $<HTMLInputElement>("#title").value,
    folder: $<HTMLInputElement>("#folder").value,
    folderOrder: $<HTMLInputElement>("#folderOrder").value,
    start: `${$<HTMLInputElement>("#startDate").value}T${$<HTMLInputElement>("#startTime").value || "00:00"}`,
    end: `${$<HTMLInputElement>("#endDate").value}T${$<HTMLInputElement>("#endTime").value || "23:59"}:59`,
    mode: ($<HTMLInputElement>('input[name="mode"]:checked')?.value as "full" | "csv") ?? "full",
    dummyGroup: $<HTMLInputElement>("#dummyGroup").checked,
  };
}

// ---------------------------------------------------------------------------
// 1. 雛形
async function loadTemplate(f: File) {
  try {
    const tables = await readTemplate(await f.arrayBuffer());
    template = { source: f.name, tables };
    try { localStorage.setItem(LS_KEY, JSON.stringify(template)); } catch { /* 保存できなくても続行 */ }
  } catch (e: any) {
    alertBox("#tplMsg", e.message ?? String(e));
    return;
  }
  render();
}

function renderTemplate() {
  const box = $("#tplInfo");
  box.replaceChildren();
  $("#tplMsg").replaceChildren();
  $("#tplClear").replaceChildren();
  if (!template) {
    box.append(h("p", { class: "muted" }, "まだ読み込まれていません。"));
    return;
  }
  const r = template.tables["contents_name.tbl"].rows[0] ?? {};
  const folder = template.tables["content_folder.tbl"]?.rows[0];
  box.append(
    h("dl", { class: "kv" },
      h("dt", {}, "ファイル"), h("dd", {}, template.source),
      h("dt", {}, "元の教材名"), h("dd", {}, r.contents_name ?? ""),
      h("dt", {}, "授業 ID（group_id）"), h("dd", {}, h("code", {}, r.group_id ?? "")),
      h("dt", {}, "作成者 ID"), h("dd", {}, h("code", {}, r.auther_id ?? "")),
      folder ? h("dt", {}, "元のフォルダ") : null, folder ? h("dd", {}, `${folder.name}（並び順 ${folder.folder_order}）`) : null,
    ),
  );
  $("#tplClear").append(
    h("button", { class: "ghost", onclick: () => { template = null; try { localStorage.removeItem(LS_KEY); } catch {} render(); } }, "雛形を消去"),
  );
  $<HTMLInputElement>("#folderOrder").placeholder = folder?.folder_order ? `雛形の値 ${folder.folder_order}` : "0";
}

// ---------------------------------------------------------------------------
// 2. ファイル
async function addFiles(list: FileList | File[]) {
  const arr = [...list];
  const zips = arr.filter((f) => /\.zip$/i.test(f.name));
  const others = arr.filter((f) => !/\.zip$/i.test(f.name));
  if (zips.length && !others.length && !template) { await loadTemplate(zips[0]); return; }
  for (const f of others) files.set(f.name, new Uint8Array(await f.arrayBuffer()));
  if (others.length) regroup(pages.length === 0);
  render();
}

function regroup(force: boolean) {
  const { pages: guessed, week } = guessPages([...files.keys()].sort());
  if (force) pages = guessed;
  if (week != null) {
    const nn = String(week).padStart(2, "0");
    setDefault("title", `講義資料${nn}`);
    setDefault("folder", `第 ${week} 回`);
    setDefault("outName", `W${nn}-webclass.zip`);
  }
}
function setDefault(id: string, v: string) {
  if (!touched.has(id)) $<HTMLInputElement>("#" + id).value = v;
}

function renderFiles() {
  const ul = $("#fileList");
  ul.replaceChildren();
  if (!files.size) { ul.append(h("li", { class: "muted" }, "HTML / PDF をここにドロップ、または「ファイルを選択」")); return; }
  const used = new Set(pages.flatMap((p) => [p.file, p.attach]));
  for (const [name, d] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    ul.append(h("li", {},
      h("span", { class: "fname" }, name),
      used.has(name) ? null : h("span", { class: "tag warn" }, "未使用"),
      h("span", { class: "muted size" }, fmtSize(d.length)),
      h("button", { class: "icon", title: "取り除く", "aria-label": `${name} を取り除く`, onclick: () => { files.delete(name); pages = pages.map((p) => ({ ...p, file: p.file === name ? "" : p.file, attach: p.attach === name ? "" : p.attach })); render(); } }, "×"),
    ));
  }
}

// ---------------------------------------------------------------------------
// 3. ページ構成
function renderPages() {
  const tbody = $("#pageRows");
  tbody.replaceChildren();
  const names = [...files.keys()].sort();
  const sel = (value: string, allowNone: boolean, on: (v: string) => void) => {
    const s = h("select", { onchange: (e: Event) => { on((e.target as HTMLSelectElement).value); render(); } });
    if (allowNone) s.append(h("option", { value: "" }, "（なし）"));
    else if (!value) s.append(h("option", { value: "" }, "選択してください"));
    for (const n of names) s.append(h("option", { value: n }, n));
    if (value && !files.has(value)) s.append(h("option", { value }, `${value}（未読込）`));
    s.value = value;
    return s;
  };
  pages.forEach((p, i) => {
    tbody.append(h("tr", {},
      h("td", { class: "num" }, String(i + 1)),
      h("td", {}, h("input", { type: "text", value: p.heading, "aria-label": `ページ ${i + 1} の見出し`, oninput: (e: Event) => { p.heading = (e.target as HTMLInputElement).value; renderIssues(); } })),
      h("td", {}, sel(p.file, false, (v) => (p.file = v))),
      h("td", {}, sel(p.attach, true, (v) => (p.attach = v))),
      h("td", { class: "ops" },
        h("button", { class: "icon", title: "上へ", "aria-label": "上へ", disabled: i === 0, onclick: () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; render(); } }, "↑"),
        h("button", { class: "icon", title: "下へ", "aria-label": "下へ", disabled: i === pages.length - 1, onclick: () => { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; render(); } }, "↓"),
        h("button", { class: "icon", title: "削除", "aria-label": "削除", onclick: () => { pages.splice(i, 1); render(); } }, "×"),
      ),
    ));
  });
  if (!pages.length) tbody.append(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "ファイルを読み込むと、ファイル名から自動で構成します。")));
}

// ---------------------------------------------------------------------------
// 5. チェックと生成
function renderIssues() {
  const { errors, warnings } = validate(template?.tables ?? null, files, pages, settings());
  const box = $("#issues");
  box.replaceChildren();
  if (!errors.length && !warnings.length) box.append(h("p", { class: "ok" }, "問題は見つかりませんでした。"));
  if (errors.length) box.append(h("ul", { class: "errors" }, ...errors.map((e) => h("li", {}, e))));
  if (warnings.length) box.append(h("ul", { class: "warnings" }, ...warnings.map((e) => h("li", {}, e))));
  $<HTMLButtonElement>("#build").disabled = errors.length > 0;
}

async function doBuild() {
  if (!template) return;
  const btn = $<HTMLButtonElement>("#build");
  const status = $("#buildStatus");
  btn.disabled = true;
  try {
    const { blob, contentsId } = await buildZip(template.tables, files, pages, settings(), (d, t) => {
      status.textContent = `圧縮中… ${d} / ${t}`;
    });
    const name = $<HTMLInputElement>("#outName").value.trim() || "webclass.zip";
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    status.replaceChildren(h("span", { class: "ok" }, `${name}（${fmtSize(blob.size)}）を保存しました。`), " ", h("span", { class: "muted" }, `contents_id = ${contentsId}`));
  } catch (e: any) {
    status.replaceChildren(h("span", { class: "err" }, "生成に失敗しました: " + (e.message ?? e)));
  } finally {
    btn.disabled = false;
    renderIssues();
  }
}

// ---------------------------------------------------------------------------
// 中身の確認
async function inspectZip(f: File) {
  const out = $("#inspectOut");
  out.replaceChildren(h("p", { class: "muted" }, "読み込み中…"));
  try {
    const entries = readZip(await f.arrayBuffer());
    const blocks: Node[] = [h("p", {}, `${f.name}: ${entries.length} エントリ`)];
    for (const e of entries) {
      const b = baseName(e.name);
      if (!b.endsWith(".tbl")) continue;
      const t = decodeTable(await e.read(), B64_TABLES.has(b));
      blocks.push(h("h4", {}, `${e.name}（${t.rows.length} 行）`),
        h("div", { class: "scroll" }, h("table", { class: "data" },
          h("thead", {}, h("tr", {}, ...t.header.map((c) => h("th", {}, c)))),
          h("tbody", {}, ...t.rows.map((r) => h("tr", {}, ...t.header.map((c) => h("td", {}, r[c]))))),
        )));
    }
    for (const e of entries) {
      if (!e.name.endsWith("textbook.csv")) continue;
      blocks.push(h("h4", {}, e.name), h("pre", {}, new TextDecoder().decode(await e.read()).replace(/^﻿/, "")));
    }
    blocks.push(h("h4", {}, "ファイル"), h("ul", { class: "plain mono" },
      ...entries.filter((e) => !e.isDir && !/\.(tbl|csv|txt)$/.test(e.name)).map((e) => h("li", {}, `${fmtSize(e.size).padStart(9)}  ${e.name}`))));
    out.replaceChildren(...blocks);
  } catch (e: any) {
    out.replaceChildren(h("p", { class: "err" }, e.message ?? String(e)));
  }
}

// ---------------------------------------------------------------------------
function alertBox(sel: string, msg: string) { $(sel).replaceChildren(h("p", { class: "err" }, msg)); }

function render() {
  renderTemplate();
  renderFiles();
  renderPages();
  renderIssues();
}

function dropZone(el: HTMLElement, on: (fs: FileList) => void) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); if (e.dataTransfer?.files.length) on(e.dataTransfer.files); });
}

function init() {
  if (!("CompressionStream" in window)) {
    alertBox("#tplMsg", "このブラウザは zip の圧縮に対応していません。最新の Chrome / Edge / Firefox / Safari を使ってください。");
  }
  // 既定の公開期間: 今日 〜 年度末
  const now = new Date(Date.now() + 9 * 3600e3);
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  $<HTMLInputElement>("#startDate").value = now.toISOString().slice(0, 10);
  $<HTMLInputElement>("#endDate").value = `${m >= 4 ? y + 1 : y}-03-31`;

  $<HTMLInputElement>("#tplInput").addEventListener("change", (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) loadTemplate(f); (e.target as HTMLInputElement).value = ""; });
  dropZone($("#tplCard"), (fs) => loadTemplate(fs[0]));
  $<HTMLInputElement>("#fileInput").addEventListener("change", (e) => { const t = e.target as HTMLInputElement; if (t.files) addFiles(t.files); t.value = ""; });
  dropZone($("#filesCard"), (fs) => addFiles(fs));
  $("#regroup").addEventListener("click", () => { regroup(true); render(); });
  $("#addPage").addEventListener("click", () => { pages.push({ heading: "", file: "", attach: "" }); render(); });
  for (const id of ["title", "folder", "folderOrder", "startDate", "startTime", "endDate", "endTime", "outName"]) {
    $("#" + id).addEventListener("input", () => { touched.add(id); renderIssues(); });
  }
  $("#dummyGroup").addEventListener("change", renderIssues);
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", renderIssues));
  $("#build").addEventListener("click", doBuild);
  $<HTMLInputElement>("#inspectInput").addEventListener("change", (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) inspectZip(f); });
  // ページ外へのドロップでファイルが開かれてしまうのを防ぐ
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  render();
}

init();
