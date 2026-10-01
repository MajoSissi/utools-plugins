/* 静态一致性校验
 *   1. app.js 里 $("id") 引用的 DOM id 是否都存在于 index.html
 *   2. app.js 里 document.querySelector('[data-when="x"]') 的取值是否存在于 index.html
 *   3. app.js 里 api.xxx 调用是否都在 preload.js 的 api 对象上
 *   4. mock-api.js 是否覆盖了同一批 api 方法（否则离线预览会莫名报错）
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const html = read("index.html");
const js = read("assets/app.js");
const preload = read("preload.js");
const mock = read("dev/mock-api.js");

let failed = false;

/* ---------- 1 & 2：DOM ---------- */

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
const unusedIds = [...htmlIds].filter((id) => !jsIds.has(id));

console.log("index.html 中的 id 数量:", htmlIds.size);
console.log("app.js 引用的 id 数量:", jsIds.size);
console.log(missingIds.length ? "❌ 缺失的 id: " + missingIds.join(", ") : "✓ 缺失的 id: 无");
if (unusedIds.length) {
  console.log("  未被 app.js 引用的 id（可能只在 CSS/HTML 使用）:", unusedIds.join(", "));
}
if (missingIds.length) failed = true;

const jsWhen = new Set([...js.matchAll(/\[data-when="([^"]+)"\]/g)].map((m) => m[1]));
const htmlWhen = new Set([...html.matchAll(/data-when="([^"]+)"/g)].map((m) => m[1]));
const missingWhen = [...jsWhen].filter((v) => !htmlWhen.has(v));
console.log(
  missingWhen.length
    ? "❌ app.js 用到但 HTML 里没有的 data-when: " + missingWhen.join(", ")
    : `✓ data-when 值一致（${[...htmlWhen].join(", ")}）`
);
if (missingWhen.length) failed = true;

/* ---------- 3：从 preload.js 抽出 api 对象的成员名 ---------- */

/**
 * 把一行里的字符串 / 模板串 / 正则字面量挖成空串，剩下的再数括号。
 * 否则 `/\{(paths|qpaths|names)(?::([^}]*))?\}/g` 这种正则会让 depth 提前归零，
 * 表现为「mock 明明有 testRun，校验却说缺」。
 */
function stripLiterals(line) {
  let out = "";
  let mode = ""; // "" | "'" | '"' | "`" | "/"
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (mode) {
      if (ch === "\\") {
        i++; // 跳过被转义的字符
        continue;
      }
      if (ch === mode) mode = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      mode = ch;
      continue;
    }
    // `/` 只有在不可能做除号的位置才当正则起点
    if (ch === "/" && next !== "/" && next !== "*") {
      const before = prev.trim();
      if (!before || "(,=:[!&|?{};+-*%~^".includes(before.slice(-1))) {
        mode = "/";
        continue;
      }
    }
    if (ch === "/" && next === "/") break; // 行尾注释直接丢掉
    out += ch;
    if (ch.trim()) prev = ch;
  }
  return out;
}

function extractObjectKeys(src, anchor) {
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(anchor)) {
      start = i;
      break;
    }
  }
  if (start < 0) return new Set();

  const keys = new Set();
  let depth = 1; // anchor 那一行已经进入对象
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过注释行，避免注释里的括号干扰计数
    if (!trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*")) {
      if (depth === 1) {
        const m = trimmed.match(/^([A-Za-z_$][\w$]*)\s*[(:,]/);
        if (m) keys.add(m[1]);
      }

      const code = stripLiterals(line);
      depth += (code.match(/\{/g) || []).length;
      depth -= (code.match(/\}/g) || []).length;
    }
    if (depth <= 0) break;
  }
  return keys;
}

const apiKeys = extractObjectKeys(preload, "const api = {");
const usedApi = new Set([...js.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

console.log("\npreload.js 暴露的 api 方法数量:", apiKeys.size);
console.log("app.js 调用的 api 方法数量:", usedApi.size);

const missingApi = [...usedApi].filter((k) => !apiKeys.has(k));
console.log(
  missingApi.length ? "❌ app.js 调用了但 preload 没有: " + missingApi.join(", ") : "✓ api 调用全部存在"
);
if (missingApi.length) failed = true;

/* ---------- 4：mock 是否覆盖 ---------- */

const mockKeys = extractObjectKeys(mock, "window.folderCmd = {");
const mockMissing = [...usedApi].filter((k) => !mockKeys.has(k));
console.log(
  mockMissing.length
    ? "❌ dev/mock-api.js 缺少: " + mockMissing.join(", ") + "（离线预览会报错）"
    : "✓ dev/mock-api.js 覆盖了全部被调用的 api 方法"
);
if (mockMissing.length) failed = true;

console.log("\n" + (failed ? "❌ 校验未通过" : "✓ 全部校验通过"));
process.exit(failed ? 1 : 0);
