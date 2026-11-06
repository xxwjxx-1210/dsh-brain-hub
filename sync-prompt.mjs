import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hub = path.dirname(fileURLToPath(import.meta.url));
const promptFile = path.join(hub, "distill.md");
const text = fs.readFileSync(promptFile, "utf8").trim();
if (text.length < 200) throw new Error("prompt too short");

const literal = JSON.stringify(text);

/** 常量可能是 `[...].join("\n")` 形式，也可能是已经替换好的 JSON 字符串，两种都吃掉。 */
function endPattern(marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `${escaped}(?:\\[[\\s\\S]*?\\]\\.join\\("\\\\n"\\)|"(?:[^"\\\\]|\\\\.)*")\\s*;`
  );
}

function patch(file, marker) {
  const src = fs.readFileSync(file, "utf8");
  const pattern = endPattern(marker);
  const match = pattern.exec(src);
  if (!match) throw new Error(`constant not found: ${marker} in ${file}`);
  const next = `${src.slice(0, match.index)}${marker}${literal};${src.slice(match.index + match[0].length)}`;
  fs.writeFileSync(file, next, "utf8");
  return next.length;
}

const hostFile = path.join(hub, "dist", "index.js");
const clientFile = path.join(hub, "dist", "client.cjs");
const a = patch(hostFile, "const DISTILL_FALLBACK = ");
const b = patch(clientFile, "const DISTILL_PROMPT = ");

for (const f of [hostFile, clientFile]) {
  execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
}

const live = "C:\\Users\\Dust\\.dsh\\memory\\prompts\\distill.md";
fs.mkdirSync(path.dirname(live), { recursive: true });
fs.writeFileSync(live, `${text}\n`, "utf8");

console.log(`prompt chars: ${text.length}`);
console.log(`index.js ${a} bytes, client.cjs ${b} bytes`);
console.log(`live prompt: ${live} (${fs.statSync(live).size} bytes)`);
for (const [name, f] of [["host", hostFile], ["client", clientFile]]) {
  const s = fs.readFileSync(f, "utf8");
  console.log(`${name}: 模板警告 ${(s.match(/抄了模板/g) || []).length}, 旧「最多 4 张」 ${(s.match(/最多 4 张/g) || []).length}`);
}
