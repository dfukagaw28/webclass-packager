# webclass-packager

HTML / PDF の講義資料から、WebClass の教材（Textbook 型）として取り込める zip を作る**単体 HTML ツール**。

- 配布物は `dist/webclass-packager.html` の 1 ファイルだけ。ダブルクリックしてブラウザで開けば使える
- 処理はすべてブラウザ内で完結し、ファイルを外部へ送信しない。外部ライブラリ・ネット接続も不要
- zip の読み書きはブラウザ標準の `CompressionStream` / `DecompressionStream`（deflate-raw）で実装

対応ブラウザ: Chrome / Edge 103+、Firefox 113+、Safari 16.4+

## 使い方（ツール）

1. **雛形**: WebClass から一度エクスポートした教材の zip を読み込む。授業 ID（`group_id`）・作成者 ID・テーブルの列構成をここから引き継ぐ。一度読み込むとブラウザに記憶される
2. **教材ファイル**: その回の HTML / PDF をまとめてドロップ
3. **ページ構成**: ファイル名から自動で組み立てる（下表）。見出し・本文・添付・順序は画面で変更できる
4. **設定**: 教材名・フォルダ名・公開期間（JST）・形式
5. **生成**: チェックを通ると zip を保存できる

| ファイル名（`Wnn-` の後ろ） | 見出し | 順序 |
|---|---|---|
| `slides` | スライド | 1 |
| `intro` / `notes` / `lecture` / `handout` | 講義資料 | 2 |
| `homework` / `hw` / `assignment` / `report` | 提出課題 | 3 |
| `homework-sheet` など `…sheet` | 提出課題　解答用紙 | 4 |
| それ以外 | ファイル名 | 末尾 |

同じ名前の `.html` と `.pdf` があれば、HTML を本文・PDF を添付にする。PDF だけなら PDF を本文と添付の両方にする。
`Wnn` から教材名（`講義資料nn`）・フォルダ名（`第 n 回`）・保存ファイル名の既定値を決める。

### チェック内容

- エラー（生成不可）: 雛形なし、ページなし、ファイル未読込、**同じファイル名を複数ページで使用**、公開期間の逆転 など
- 警告: HTML 内の相対リンク（`<a href="xxx.pdf">`）が教材内のどのファイルも指していない、読み込んだが未使用のファイルがある

### 出力形式

- **完全形式**（既定）: WebClass のエクスポートと同じ構造
  ```
  <contents_id>/text_book.tbl, contents_name.tbl, textbook_style.tbl, object_table.tbl, sco.tbl, scorm.tbl
  <contents_id>/objects/
  <contents_id>/text/<hash>, <hash>.html, <dir>/<dir末尾16桁>(.pdf) …
  contents/<元のファイル名>, <hash>.html, textbook.csv（BOM付き）, textbook-utf8.txt
  content_folder.tbl, content_folder_contents_name.tbl, control.tbl
  ```
- **CSV 形式**: `textbook.csv` と実ファイルだけを zip 直下に置く

## エクスポート形式のメモ

- `*.tbl` は 1 行目が列名、2 行目以降がデータ。列区切りは `@#@`、改行は LF
- `control.tbl` 以外は**各行を UTF-8 → Base64** した形で格納
- 教材ページは `text_book.tbl` の行で表現され、1 ページ = `H2`（見出し）→ `TEXT`（tiptap-html、空可）→ `FILE`（本文）→ `ATTACH`（添付）、`contents_order` = 1〜4
- ID（`contents_id`, `text_book_id`, `folder_id`, ファイルのハッシュ名）は 32 桁の 16 進。生成時はすべて新規発行し、既存教材と衝突させない
- 公開期間 `start_date` / `end_date` は UNIX 秒
- `contents_name.tbl` のうち、教材名・公開期間・作成/更新日時・ID 以外の列（`contents_perm` など）は雛形の値をそのまま使う

## 開発

```sh
npm install
npm run check      # 型チェック + テスト + ビルド
npm run build      # dist/webclass-packager.html を生成
npm test           # node:test によるテスト（ブラウザ不要）
```

```
src/
  index.html     画面（CSS 込み）。ビルド時に /*__APP__*/ の位置へ JS を埋め込む
  app.ts         画面の処理
  webclass.ts    エクスポート形式の読み書き・検証・生成（DOM 非依存）
  zip.ts         依存なしの zip 読み書き
test/
  webclass.test.ts
build.mjs        esbuild でバンドルし単体 HTML を出力
```

テストは授業データを含まない合成の雛形で行う。WebClass のエクスポート zip は授業 ID 等を含むため `.gitignore` で除外している。

GitHub Actions（`.github/workflows/build.yml`）で push / PR ごとにチェックし、ビルドした HTML を成果物として保存する。`v*` タグを push すると Release に HTML を添付する。
