// 生成ロジックのテスト（Node 20+ の CompressionStream / Blob / crypto を使用。ブラウザ不要）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readZip, ZipWriter } from "../src/zip.ts";
import {
  B64_TABLES, Files, Page, Settings, baseName, buildZip, decodeTable, encodeTable, guessPages, jstEpoch, readTemplate, validate,
} from "../src/webclass.ts";

const enc = new TextEncoder();
const GROUP = "2610808219000";
const AUTHOR = "699adc70b4d4db706db6f159aa9899e7";
const OLD_CID = "a2355e2d74e0b905971263aafd92ff30";

/** 実際のエクスポートと同じ列構成をもつ最小の雛形 zip（授業データは含まない） */
async function fakeExport(): Promise<ArrayBuffer> {
  const z = new ZipWriter();
  const cnHeader = "contents_id contents_kind contents_name contents_memo contents_perm group_id auther_id time_limit start_date end_date border exec_times l_type l_number printable link_to peerreview carte shared_report updated created_at created_by_id scorm disp_order allow_update new_mark allowed_user lock_password exec_password label review_comment review_open external_data ipaddress_limit notice_recipient".split(" ");
  const cnRow = Object.fromEntries(cnHeader.map((h) => [h, ""]));
  Object.assign(cnRow, { contents_id: OLD_CID, contents_kind: "Textbook", contents_name: "講義資料01", contents_perm: "7", group_id: GROUP, auther_id: AUTHOR, disp_order: "11", new_mark: "1" });
  z.add(`${OLD_CID}/text_book.tbl`, encodeTable({ header: "text_book_id contents_id page_no tag format contents file_name contents_order".split(" "), rows: [] }, true));
  z.add(`${OLD_CID}/object_table.tbl`, encodeTable({ header: ["id", "application"], rows: [] }, true));
  z.add(`${OLD_CID}/contents_name.tbl`, encodeTable({ header: cnHeader, rows: [cnRow] }, true));
  z.add(`${OLD_CID}/sco.tbl`, encodeTable({ header: ["scorm_id", "sco_number"], rows: [] }, true));
  z.add(`${OLD_CID}/scorm.tbl`, encodeTable({ header: ["scorm_id", "scorm_title"], rows: [] }, true));
  z.add(`${OLD_CID}/textbook_style.tbl`, encodeTable({ header: ["contents_id", "show_content", "textbook_offset", "show_title", "enable_bookmark"], rows: [{ contents_id: OLD_CID, show_content: "1", textbook_offset: "0", show_title: "1", enable_bookmark: "0" }] }, true));
  z.add("content_folder.tbl", encodeTable({ header: ["folder_id", "group_id", "name", "folder_order"], rows: [{ folder_id: "f".repeat(32), group_id: GROUP, name: "第 1 回", folder_order: "9" }] }, true));
  z.add("content_folder_contents_name.tbl", encodeTable({ header: ["folder_id", "contents_id"], rows: [{ folder_id: "f".repeat(32), contents_id: OLD_CID }] }, true));
  z.add("control.tbl", encodeTable({ header: ["contents_id", "contents_name", "contents_kind", "group_id", "auther_id"], rows: [{ contents_id: OLD_CID, contents_name: "講義資料01", contents_kind: "Textbook", group_id: GROUP, auther_id: AUTHOR }] }, false));
  return (await z.build()).arrayBuffer();
}

const html = (s: string) => enc.encode(`<!doctype html><html><body>${s}</body></html>`);
function w02Files(): Files {
  return new Map<string, Uint8Array>([
    ["W02-slides.html", html("slides")],
    ["W02-slides.pdf", enc.encode("%PDF-slides")],
    ["W02-intro.html", html('<a href="W02-intro.pdf">PDF</a>')],
    ["W02-intro.pdf", enc.encode("%PDF-intro")],
    ["W02-homework.html", html('<a href="W02-homework.pdf">PDF</a>')],
    ["W02-homework.pdf", enc.encode("%PDF-hw")],
    ["W02-homework-sheet.pdf", enc.encode("%PDF-sheet")],
  ]);
}
const settings = (over: Partial<Settings> = {}): Settings => ({
  title: "講義資料02", folder: "第 2 回", folderOrder: "", start: "2026-10-02T00:00", end: "2027-03-31T23:59:59", mode: "full", ...over,
});

async function unzip(blob: Blob) {
  const entries = readZip(await blob.arrayBuffer());
  const out = new Map<string, Uint8Array>();
  for (const e of entries) if (!e.isDir) out.set(e.name, await e.read());
  return { names: entries.map((e) => e.name), files: out };
}
const tbl = (files: Map<string, Uint8Array>, suffix: string) => {
  const [name, data] = [...files].find(([n]) => n === suffix || n.endsWith("/" + suffix))!;
  return decodeTable(data, B64_TABLES.has(baseName(name)));
};

test("ファイル名からページ構成と週番号を推定する", () => {
  const { pages, week } = guessPages([...w02Files().keys()]);
  assert.equal(week, 2);
  assert.deepEqual(pages, [
    { heading: "スライド", file: "W02-slides.html", attach: "W02-slides.pdf" },
    { heading: "講義資料", file: "W02-intro.html", attach: "W02-intro.pdf" },
    { heading: "提出課題", file: "W02-homework.html", attach: "W02-homework.pdf" },
    { heading: "提出課題　解答用紙", file: "W02-homework-sheet.pdf", attach: "W02-homework-sheet.pdf" },
  ]);
});

test("公開日時は JST として UNIX 秒に変換する", () => {
  assert.equal(jstEpoch("2026-09-25T00:00"), 1790262000);
  assert.equal(jstEpoch("2027-03-31T23:59:59"), 1806505199);
});

test("同じ添付ファイル名を複数ページで使うとエラーになる", async () => {
  const tpl = await readTemplate(await fakeExport());
  const pages: Page[] = [
    { heading: "スライド", file: "W02-slides.html", attach: "W02-intro.pdf" },
    { heading: "講義資料", file: "W02-intro.html", attach: "W02-intro.pdf" },
  ];
  const { errors } = validate(tpl, w02Files(), pages, settings());
  assert.ok(errors.some((e) => e.includes("W02-intro.pdf")), errors.join("\n"));
});

test("HTML 内の相対リンクが教材内のファイルを指していなければ警告する", async () => {
  const tpl = await readTemplate(await fakeExport());
  const files = w02Files();
  files.set("W02-intro.html", html('<a href="W02-notes.pdf">x</a><a href="https://example.com/a.pdf">y</a>'));
  const { warnings } = validate(tpl, files, guessPages([...files.keys()]).pages, settings());
  assert.ok(warnings.some((w) => w.includes("W02-notes.pdf")));
  assert.ok(!warnings.some((w) => w.includes("example.com")));
});

test("完全形式: エクスポートと同じ構造で、ID はすべて新規", async () => {
  const tpl = await readTemplate(await fakeExport());
  const files = w02Files();
  const pages = guessPages([...files.keys()]).pages;
  assert.deepEqual(validate(tpl, files, pages, settings()).errors, []);
  const { blob, contentsId: cid } = await buildZip(tpl, files, pages, settings());
  const { names, files: out } = await unzip(blob);

  assert.notEqual(cid, OLD_CID);
  assert.match(cid, /^[0-9a-f]{32}$/);
  for (const n of ["text_book.tbl", "object_table.tbl", "contents_name.tbl", "sco.tbl", "scorm.tbl", "textbook_style.tbl"]) {
    assert.ok(names.includes(`${cid}/${n}`), n);
  }
  assert.ok(names.includes(`${cid}/objects/`));
  for (const n of ["content_folder.tbl", "content_folder_contents_name.tbl", "control.tbl", "contents/textbook.csv", "contents/textbook-utf8.txt"]) {
    assert.ok(names.includes(n), n);
  }

  const cn = tbl(out, "contents_name.tbl").rows[0];
  assert.equal(cn.contents_id, cid);
  assert.equal(cn.contents_name, "講義資料02");
  assert.equal(cn.group_id, GROUP);
  assert.equal(cn.auther_id, AUTHOR);
  assert.equal(cn.contents_perm, "7");
  assert.equal(cn.start_date, String(jstEpoch("2026-10-02T00:00")));
  assert.equal(cn.end_date, "1806505199");

  const ctrl = tbl(out, "control.tbl").rows[0];
  assert.deepEqual(ctrl, { contents_id: cid, contents_name: "講義資料02", contents_kind: "Textbook", group_id: GROUP, auther_id: AUTHOR });
  assert.ok(new TextDecoder().decode(out.get("control.tbl")).startsWith("contents_id@#@"), "control.tbl は平文");

  const folder = tbl(out, "content_folder.tbl").rows[0];
  assert.equal(folder.name, "第 2 回");
  assert.equal(folder.folder_order, "9", "並び順は雛形から引き継ぐ");
  assert.equal(tbl(out, "content_folder_contents_name.tbl").rows[0].folder_id, folder.folder_id);

  const tb = tbl(out, "text_book.tbl").rows;
  assert.equal(tb.length, 16);
  assert.equal(new Set(tb.map((r) => r.text_book_id)).size, 16);
  assert.deepEqual(tb.filter((r) => r.page_no === "1").map((r) => r.tag), ["H2", "TEXT", "FILE", "ATTACH"]);
  for (const r of tb.filter((r) => r.tag === "FILE" || r.tag === "ATTACH")) {
    const stored = `${cid}/text/${r.contents}`;
    assert.ok(out.has(stored), `参照先: ${stored}`);
    assert.deepEqual(out.get(stored), files.get(r.file_name), `内容一致: ${r.file_name}`);
    assert.ok(out.has(`contents/${r.file_name}`));
    if (r.tag === "FILE") {
      assert.ok(out.has(stored.replace(/\.(html|pdf)$/, "")), "拡張子なしの複製");
      assert.ok(out.has(`contents/${r.contents}`));
    }
  }
  const sheet = tb.find((r) => r.tag === "FILE" && r.file_name.endsWith(".pdf"))!;
  const [dir, file] = sheet.contents.split("/");
  assert.equal(file, dir.slice(16) + ".pdf", "PDF 本文は <dir>/<dir の末尾16桁>.pdf");

  const csv = out.get("contents/textbook.csv")!;
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(csv.subarray(3)).split("\r\n");
  assert.equal(lines[0], "chapter,section,file,htmlfile,attach_file,text");
  assert.equal(lines[1].split(",")[1], "スライド");
  assert.notDeepEqual([...out.get("contents/textbook-utf8.txt")!.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("CSV 形式: textbook.csv とファイルだけを zip の直下に置く", async () => {
  const tpl = await readTemplate(await fakeExport());
  const files = w02Files();
  const pages = guessPages([...files.keys()]).pages;
  const { blob } = await buildZip(tpl, files, pages, settings({ mode: "csv" }));
  const { names } = await unzip(blob);
  assert.ok(names.includes("textbook.csv"));
  assert.ok(!names.some((n) => n.endsWith(".tbl")));
  for (const f of files.keys()) assert.ok(names.includes(f), f);
});

test("フォルダ名が空ならフォルダのテーブルを作らない", async () => {
  const tpl = await readTemplate(await fakeExport());
  const files = w02Files();
  const { blob } = await buildZip(tpl, files, guessPages([...files.keys()]).pages, settings({ folder: "" }));
  const { names } = await unzip(blob);
  assert.ok(!names.includes("content_folder.tbl"));
});

test("zip の書き出しと読み込みが往復で一致する（圧縮・非圧縮・日本語名）", async () => {
  const z = new ZipWriter();
  const big = enc.encode("あ".repeat(10000));
  const rnd = crypto.getRandomValues(new Uint8Array(5000));
  z.add("日本語/ファイル.txt", big);
  z.add("bin/random.dat", rnd);
  z.add("empty.txt", new Uint8Array(0));
  const { files } = await unzip(await z.build());
  assert.deepEqual(files.get("日本語/ファイル.txt"), big);
  assert.deepEqual(files.get("bin/random.dat"), rnd);
  assert.equal(files.get("empty.txt")!.length, 0);
});

test("dummyGroup: 授業 ID を実在しない値に置き換える（作成者 ID はそのまま）", async () => {
  const tpl = await readTemplate(await fakeExport());
  const files: Files = new Map([["W02-slides.pdf", enc.encode("%PDF-1.4")]]);
  const { blob } = await buildZip(tpl, files, guessPages([...files.keys()]).pages, settings({ dummyGroup: true }));
  const { files: out } = await unzip(blob);
  const dummy = "9".repeat(GROUP.length);
  const cn = tbl(out, "contents_name.tbl").rows[0];
  assert.equal(cn.group_id, dummy);
  assert.equal(cn.auther_id, AUTHOR);
  assert.equal(tbl(out, "control.tbl").rows[0].group_id, dummy);
  assert.equal(tbl(out, "content_folder.tbl").rows[0].group_id, dummy);
});
