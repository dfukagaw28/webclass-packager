// src/*.ts をバンドルして src/index.html に埋め込み、dist/webclass-packager.html を出力する
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const r = await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  format: "iife",
  target: ["chrome103", "firefox113", "safari16.4"],
  write: false,
  legalComments: "none",
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = (await readFile("src/index.html", "utf8")).replace("/*__APP__*/", () => js);
await mkdir("dist", { recursive: true });
await writeFile("dist/webclass-packager.html", html);
console.log(`dist/webclass-packager.html (${(html.length / 1024).toFixed(1)} KB)`);
