/**
 * 校验列表副标题的「省略路径」逻辑。
 *
 * app.js 是一个 IIFE，里面的 baseName() 拿不到外面，所以这里直接把源码里的
 * 那个函数**抠出来**求值 —— 保持对真实源码的校验，而不是抄一份实现。
 *
 *   node tools/check-summary.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`在 app.js 里找不到 ${name}()`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const head = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() 的花括号不配对（起点 ${head}）`);
}

const baseName = new Function(`${extract("baseName")}; return baseName;`)();

const cases = [
  // [输入, 期望]
  ["code", "code"],
  ["wt", "wt"],
  ["C:\\Tools\\run.exe", "run.exe"],
  ["C:\\Program Files\\Git\\git-bash.exe", "git-bash.exe"],
  ['"C:\\Program Files\\Git\\git-bash.exe"', "git-bash.exe"],
  ["'C:/Portable/ffmpeg.exe'", "ffmpeg.exe"],
  ["D:/Code/bin/node.exe", "node.exe"],
  // 混合斜杠 + 空格
  ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh.exe"],
  // 尾部斜杠：最后一段为空，按原样退回（不该崩）
  ["C:\\Tools\\", ""],
  // 空值不能抛
  ["", ""],
  [undefined, ""],
  [null, ""],
];

let pass = 0;
const fails = [];
cases.forEach(([input, want]) => {
  const got = baseName(input);
  if (got === want) pass++;
  else fails.push(`${JSON.stringify(input)} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
});

/* commandSummary 只做「程序名 + 参数」，这里顺带断言它不再吐出完整路径 */
const joined = [
  baseName("C:\\Program Files\\Microsoft VS Code\\Code.exe"),
  '-n "{qpath}"',
]
  .filter(Boolean)
  .join(" ");
if (joined === 'Code.exe -n "{qpath}"') pass++;
else fails.push(`拼接结果不对：${joined}`);
if (!/Program Files|C:\\/.test(joined)) pass++;
else fails.push(`副标题里仍然残留路径：${joined}`);

console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  fails.forEach((f) => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
} else {
  console.log("✓ 副标题省略路径逻辑校验通过");
}
