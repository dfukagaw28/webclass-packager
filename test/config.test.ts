import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, toYaml } from "../src/config.ts";

test("YAML から設定とページ構成を読む", () => {
  const c = parseConfig(`# 第 2 回
title: 講義資料02
folder: "第 2 回"
folder_order: 9
start: 2026-10-02 9:00
end: 2027-03-31        # 時刻なし → 23:59
mode: csv
dummy_group: false
output: W02-webclass.zip
pages:
  - heading: スライド
    file: W02-slides.html
    attach: W02-slides.pdf
  - heading: 'It''s: 課題 # 1'
    file: W02-homework.pdf
  - W02-intro.html
`);
  assert.deepEqual(c, {
    title: "講義資料02",
    folder: "第 2 回",
    folderOrder: "9",
    start: { date: "2026-10-02", time: "09:00" },
    end: { date: "2027-03-31", time: "23:59" },
    mode: "csv",
    dummyGroup: false,
    output: "W02-webclass.zip",
    pages: [
      { heading: "スライド", file: "W02-slides.html", attach: "W02-slides.pdf" },
      { heading: "It's: 課題 # 1", file: "W02-homework.pdf", attach: "" },
      { heading: "講義資料", file: "W02-intro.html", attach: "" },
    ],
  });
});

test("書かれていない項目は含めない", () => {
  assert.deepEqual(parseConfig("start: 2026-10-02T08:50\n"), { start: { date: "2026-10-02", time: "08:50" } });
  assert.deepEqual(parseConfig(""), {});
});

test("誤りは行番号つきで知らせる", () => {
  assert.throws(() => parseConfig("title: a\ntitel: b\n"), /2 行目: 知らない項目です: titel/);
  assert.throws(() => parseConfig("start: 10/2\n"), /1 行目: 日時は/);
  assert.throws(() => parseConfig("mode: zip\n"), /mode は full か csv/);
  assert.throws(() => parseConfig("pages:\n  - heading: a\n    url: x\n"), /3 行目: ページの項目は/);
  assert.throws(() => parseConfig("  heading: a\n"), /pages の中にだけ/);
  assert.throws(() => parseConfig('title: "abc\n'), /閉じていない "/);
});

test("toYaml の出力は parseConfig で読み戻せる", () => {
  const src = {
    title: "講義資料02", folder: "", folderOrder: "", output: "W02-webclass.zip",
    start: { date: "2026-10-02", time: "09:00" }, end: { date: "2027-03-31", time: "23:59" },
    mode: "full" as const, dummyGroup: true,
    pages: [
      { heading: "提出課題: #1", file: "W02-hw.html", attach: "W02-hw.pdf" },
      { heading: "true", file: "02.pdf", attach: "" },
    ],
  };
  const { folderOrder, ...expected } = src;
  assert.deepEqual(parseConfig(toYaml(src)), expected);
});
