/* 直接验证 preload.js 里的核心逻辑，不用装 uTools：
 *   - featureCmds()：按勾选的匹配方式生成 uTools 指令，字段是否合法
 *   - loadCommands()：旧数据迁移（trigger / runMode -> matches）
 *   - needsConsole()：控制台程序识别
 *
 * 做法：用 vm 造一个假的 window / utools 环境把 preload.js 跑起来，
 * 再取它暴露在 window.folderCmdRaw 上的函数来断言。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "preload.js"), "utf8");

/* ---------------- 假环境 ---------------- */

const dbStore = {};

const utoolsStub = {
  dbStorage: {
    getItem: (k) => (k in dbStore ? dbStore[k] : null),
    setItem: (k, v) => {
      dbStore[k] = v;
    },
  },
  getFeatures: () => [],
  setFeature: () => {},
  removeFeature: () => {},
  onPluginEnter: () => {},
  onPluginOut: () => {},
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  isDarkColors: () => true,
  getAppVersion: () => "9.9.9",
  getAppName: () => "uTools",
  getNativeId: () => "test",
  getPath: () => "C:\\Users\\test",
  showOpenDialog: () => [],
  // 真实实现是**异步**的（返回 Promise），这里故意也返回 Promise，
  // 好把「拿到 Promise 却被当字符串用」这类 bug 挡在测试里
  readCurrentFolderPath: () => Promise.resolve("D:\\Stub\\当前目录"),
  showNotification: () => {},
  getFileIcon: () => "",
  copyText: () => {},
  copyFile: () => {},
  shellOpenPath: () => {},
  shellShowItemInFolder: () => {},
  outPlugin: () => {},
  hideMainWindow: () => {},
};

const windowStub = {
  addEventListener: () => {},
  dispatchEvent: () => {},
};

const sandbox = {
  window: windowStub,
  utools: utoolsStub,
  console,
  process,
  require,
  module: { exports: {} },
  exports: {},
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  RegExp,
  Error,
  Set,
  Map,
  Promise,
  encodeURIComponent,
};
sandbox.global = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "preload.js" });

const raw = sandbox.window.folderCmdRaw;
const api = sandbox.window.folderCmd;

if (!raw || typeof raw.featureCmds !== "function") {
  console.error("❌ 没能从 preload.js 拿到 featureCmds");
  process.exit(1);
}

/* ---------------- 断言工具 ---------------- */

let failed = 0;
let passed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`❌ ${label}`);
  console.log(`   期望: ${e}`);
  console.log(`   实际: ${a}`);
}

function ok(cond, label) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`❌ ${label}`);
}

const cmds = (matches) => raw.featureCmds({ name: "T", matches });

/* ---------------- 1. files：文件夹默认 ---------------- */

eq(
  cmds({ folder: { on: true } }),
  [{ type: "files", fileType: "directory", label: "T", minLength: 1 }],
  "文件夹：默认只带 minLength=1，maxLength 未填则不输出"
);

/* ---------------- 2. files：扩展名 ---------------- */

{
  const [c] = cmds({ file: { on: true, min: "1", max: "30", range: "ext", exts: "png, .jpg,.PNG" } });
  eq(c.fileType, "file", "文件：fileType=file");
  eq(c.extensions, ["png", "jpg", "PNG"], "文件：扩展名去点、去重、保序");
  eq(c.minLength, 1, "文件：minLength 转数字");
  eq(c.maxLength, 30, "文件：maxLength 转数字");
  ok(!("match" in c), "文件：选了扩展名就不能同时出现 match（二选一）");
}

/* ---------------- 3. files：正则规范化 ---------------- */

{
  const [c] = cmds({ file: { on: true, range: "regex", regex: "\\.(jpg|png)$" } });
  eq(c.match, "/\\.(jpg|png)$/i", "文件：裸正则自动补成 /.../i");
  ok(!("extensions" in c), "文件：选了正则就不能同时出现 extensions");

  const [d] = cmds({ file: { on: true, range: "regex", regex: "/^IMG_\\d+/g" } });
  eq(d.match, "/^IMG_\\d+/g", "文件：已经带斜杠的正则原样保留");
}

/* ---------------- 4. files：不限制 ---------------- */

{
  const [c] = cmds({ file: { on: true, range: "none", exts: "png", regex: "\\.x$" } });
  ok(!("extensions" in c) && !("match" in c), "不限制：既不带 extensions 也不带 match");
  ok(!("maxLength" in c), "不限制：空的 maxLength 不输出");
}

/* ---------------- 5. 匹配条件不再有「跟随」 ---------------- */

{
  // MATCH_KEYS 顺序是 file / folder / window，所以输出顺序也是 文件 → 文件夹
  const out = cmds({
    folder: { on: true, min: "2", max: "9", range: "ext", exts: "md" },
    file: { on: true, follow: "folder", min: "999", range: "none" },
  });
  eq(out.length, 2, "匹配条件：文件夹 + 文件各生成一条");
  eq(out[0].fileType, "file", "匹配条件：第一条是「文件」");
  eq(out[1].fileType, "directory", "匹配条件：第二条是「文件夹」");
  eq(out[1].extensions, ["md"], "匹配条件：文件夹自己的 extensions");
  // 匹配条件里的 follow 应该被完全忽略（跟随已经移到「命令参数」上）
  ok(!("extensions" in out[0]), "匹配条件：残留的 follow 字段被忽略");
  eq(out[0].minLength, 999, "匹配条件：文件仍用自己的 minLength");
}

/* ---------------- 6. window：只配标题 ---------------- */

{
  const [c] = cmds({ window: { on: true, title: "^D:\\\\" } });
  eq(c.type, "window", "窗口：type=window");
  eq(c.match.title, "/^D:\\\\/i", "窗口：title 正则规范化");
  eq(c.match.app, ["explorer.exe"], "窗口：app 是固定值");
  eq(
    c.match.class,
    ["CabinetWClass", "ExploreWClass", "WorkerW", "Progman"],
    "窗口：class 是固定值"
  );
  ok(!("minLength" in c), "窗口：不带 files 才有的 minLength");
}

{
  const [c] = cmds({ window: { on: true, title: "" } });
  ok(!("title" in c.match), "窗口：空 title 不输出");
  eq(c.match.app, ["explorer.exe"], "窗口：app 依然固定输出（uTools 必填）");
}

{
  // 用户不再能配 app / winClass，即使配置里有残留也一律忽略
  const [c] = cmds({ window: { on: true, app: "TotalCMD64.exe", winClass: "Notepad" } });
  eq(c.match.app, ["explorer.exe"], "窗口：残留的 app 配置被忽略");
  eq(
    c.match.class,
    ["CabinetWClass", "ExploreWClass", "WorkerW", "Progman"],
    "窗口：残留的 winClass 配置被忽略"
  );
}

/* ---------------- 7. 多选 ---------------- */

{
  const out = cmds({
    folder: { on: true },
    file: { on: true },
    window: { on: true },
  });
  eq(out.length, 3, "多选：三种模式生成三条指令");
  eq(
    out.map((c) => c.type),
    ["files", "files", "window"],
    "多选：类型顺序 文件/文件夹/窗口（都是 files，最后 window）"
  );
  eq(
    out.map((c) => c.fileType).slice(0, 2),
    ["file", "directory"],
    "多选：fileType 顺序是 file / directory"
  );
}

/* ---------------- 8. 兜底 ---------------- */

{
  const out = cmds({ folder: { on: false }, file: { on: false }, window: { on: false } });
  eq(out.length, 1, "一个都没勾：兜底仍是 1 条，不至于没有入口");
  eq(out[0].fileType, "directory", "兜底：按文件夹入口");
}

/* ---------------- 9. needsConsole ---------------- */

{
  const cases = [
    ["cmd /k cd /d \"D:\\\\x\"", true],
    ["C:\\Windows\\System32\\cmd.exe", true],
    ["powershell -NoExit", true],
    ["pwsh", true],
    ["wt -d \"D:\\\\x\"", true],
    ["C:\\Program Files\\Git\\git-bash.exe --cd=x", true],
    ['"C:\\Program Files\\Git\\git-bash.exe" --cd=x', true],
    ["wsl", true],
    ["powershell -File C:\\x\\y.ps1", true],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoLogo", true],
    ["C:\\Program Files\\Windows Terminal\\wt.exe -d .", true],
    ["code \"D:\\\\x\"", false],
    ["C:\\Program Files\\Microsoft VS Code\\Code.exe", false],
    ["C:\\Users\\me\\bin\\code.cmd --help", false],
    ["explorer \"D:\\\\x\"", false],
    ["", false],
  ];
  cases.forEach(([line, want]) => eq(raw.needsConsole(line), want, `needsConsole(${JSON.stringify(line)})`));

  // 取程序名：路径带空格时不能被空白切坏
  eq(raw.programToken("C:\\Program Files\\Git\\git-bash.exe --cd=x"), "C:\\Program Files\\Git\\git-bash.exe", "programToken：无引号带空格路径");
  eq(raw.programToken('"C:\\a b\\x.exe" /c y'), "C:\\a b\\x.exe", "programToken：双引号");
  eq(raw.programToken("cmd.exe /c \"C:\\Program Files\\a.exe\""), "cmd.exe", "programToken：取第一个程序而不是参数里的 exe");
  eq(raw.programToken("   "), "", "programToken：空白输入");
}

/* ---------------- 10. 命令参数：三份 + 跟随 ---------------- */

{
  // 只写了 file 的 args，其余为空
  const cmd = {
    name: "T",
    cmd: "code",
    params: {
      folder: { args: '"{qpath}"', cwd: "", follow: "" },
      file: { args: "", cwd: "", follow: "folder" },
      window: { args: "-w", cwd: "", follow: "" },
    },
  };

  const p = raw.normalizeParams(cmd);
  eq(p.folder.args, '"{qpath}"', "命令参数：folder 自己的 args");
  eq(p.window.args, "-w", "命令参数：window 自己的 args");

  eq(raw.resolveCommandParams(cmd, "file").args, '"{qpath}"', "命令参数：file 跟随 folder");
  eq(raw.resolveCommandParams(cmd, "window").args, "-w", "命令参数：window 不受跟随影响");
  eq(raw.resolveCommandParams(cmd, "folder").args, '"{qpath}"', "命令参数：folder 用自身的");

  // 指向自己 / 指向不存在的模式 -> 用自身的
  const weird = {
    cmd: "x",
    params: {
      folder: { args: "A", cwd: "", follow: "folder" },
      file: { args: "B", cwd: "", follow: "nope" },
      window: { args: "C", cwd: "", follow: "" },
    },
  };
  eq(raw.resolveCommandParams(weird, "folder").args, "A", "命令参数：跟随自己时用自身");
  eq(raw.resolveCommandParams(weird, "file").args, "B", "命令参数：跟随不存在的模式时用自身");

  // 缺 params 时从顶层 args/cwd 兜底
  const legacy = { cmd: "x", args: "-legacy", cwd: "D:\\x" };
  const lp = raw.normalizeParams(legacy);
  eq(lp.folder.args, "-legacy", "命令参数：缺 params 时用顶层 args 兜底");
  eq(lp.window.cwd, "D:\\x", "命令参数：缺 params 时用顶层 cwd 兜底");

  // 未知模式回退到第一个模式（文件）
  eq(raw.resolveCommandParams(cmd, "").args, '"{qpath}"', "命令参数：未知模式回退到第一个模式");
  const solo = {
    params: {
      file: { args: "F", cwd: "", follow: "" },
      folder: { args: "D", cwd: "", follow: "" },
      window: { args: "W", cwd: "", follow: "" },
    },
  };
  eq(raw.resolveCommandParams(solo, "").args, "F", "命令参数：未知模式取「文件」那套");
  eq(raw.resolveCommandParams(solo, "folder").args, "D", "命令参数：已知模式仍按模式取");
}

{
  const cmd = { matches: { folder: { on: false }, file: { on: true }, window: { on: true } } };
  eq(raw.firstEnabledMatch(cmd), "file", "firstEnabledMatch：取第一条勾选的");
  eq(raw.firstEnabledMatch({ matches: {} }), "file", "firstEnabledMatch：都没勾时兜底第一个模式（文件）");
}

/* ---------------- 11. files：名称字符数（长度） ---------------- */

{
  // 只设名称长度、不选其它条件 -> 纯长度正则
  const [c] = cmds({ file: { on: true, range: "none", nameMin: "3", nameMax: "10" } });
  eq(c.match, "/^(?=[\\s\\S]{3,10}$)[\\s\\S]*/i", "名称长度：只有长度约束时生成纯长度正则");
  ok(!("extensions" in c), "名称长度：此时不带 extensions");
  // 关键：名称字符数绝不能被当成「选中个数」塞进 minLength
  eq(c.minLength, 1, "名称长度：不会把名称字符数误当成选中个数");
  ok(!("maxLength" in c), "名称长度：不填最多选中个数就不输出 maxLength");
}

{
  // 扩展名 + 长度 -> 必须合并成一条正则（extensions 与 match 是二选一的）
  const [c] = cmds({ file: { on: true, range: "ext", exts: "png, jpg", nameMin: "3", nameMax: "10" } });
  ok(!("extensions" in c), "名称长度：设了长度就不用原生 extensions");
  eq(c.match, "/^(?=[\\s\\S]{3,10}$)\\.(?:png|jpg)$/i", "名称长度：与扩展名合并成一条正则");
}

{
  // 自定义正则 + 长度 -> 断言插到正则最前面，flags 原样保留
  const [c] = cmds({ file: { on: true, range: "regex", regex: "/^IMG_\\d+/g", nameMax: "20" } });
  eq(c.match, "/^(?=[\\s\\S]{0,20}$)^IMG_\\d+/g", "名称长度：与自定义正则合并并保留 flags");
}

{
  // 只有下限 -> {3,} ；注意不能写成 {,}
  const [c] = cmds({ file: { on: true, range: "none", nameMin: "3" } });
  eq(c.match, "/^(?=[\\s\\S]{3,}$)[\\s\\S]*/i", "名称长度：只有下限时是 {3,}");
  ok(!c.match.includes("{,,}") && !c.match.includes("{,3}"), "名称长度：不会产出非法的 {,} 量词");
}

{
  // 只有上限 -> 下限补 0，仍是合法量词
  const [c] = cmds({ file: { on: true, range: "none", nameMax: "10" } });
  eq(c.match, "/^(?=[\\s\\S]{0,10}$)[\\s\\S]*/i", "名称长度：只有上限时下限补 0");
}

{
  // 选中个数 与 名称长度 可以同时存在，互不干扰
  const [c] = cmds({ file: { on: true, min: "1", max: "5", range: "ext", exts: "png", nameMin: "4" } });
  eq(c.minLength, 1, "名称长度：与选中个数共存时 minLength 仍走原生字段");
  eq(c.maxLength, 5, "名称长度：与选中个数共存时 maxLength 仍走原生字段");
  eq(c.match, "/^(?=[\\s\\S]{4,}$)\\.(?:png)$/i", "名称长度：与选中个数共存时长度走正则");
}

{
  // 没设长度 -> 回到最省事的原生 extensions
  const [c] = cmds({ file: { on: true, range: "ext", exts: "png" } });
  eq(c.extensions, ["png"], "名称长度：未设长度时仍走原生 extensions");
  ok(!("match" in c), "名称长度：未设长度时不会多出一条 match");
}

/* ---------------- 12. 变量：{names} 与分隔符修饰 ---------------- */

{
  const ctx = raw.buildContext(["D:\\a\\one.txt", "D:\\b\\two.log"]);
  eq(ctx.names, ["one.txt", "two.log"], "变量：names 是各路径的文件名");

  eq(raw.substitute("{path}", ctx), "D:\\a\\one.txt", "变量：{path} 取第一个");
  eq(raw.substitute("{name}", ctx), "one.txt", "变量：{name} 取第一个的名称");

  // 列表变量的默认行为：空格分隔
  eq(raw.substitute("{names}", ctx), "one.txt two.log", "变量：{names} 默认空格分隔");
  eq(raw.substitute("{paths}", ctx), "D:\\a\\one.txt D:\\b\\two.log", "变量：{paths} 默认空格分隔");
  eq(
    raw.substitute("{qpaths}", ctx),
    '"D:\\a\\one.txt" "D:\\b\\two.log"',
    "变量：{qpaths} 默认空格分隔且各自加引号"
  );

  // 自定义分隔符
  eq(raw.substitute("{names:,}", ctx), "one.txt,two.log", "变量：{names:,} 逗号分隔");
  eq(raw.substitute("{paths:,}", ctx), "D:\\a\\one.txt,D:\\b\\two.log", "变量：{paths:,} 逗号分隔");
  eq(
    raw.substitute("{qpaths:, }", ctx),
    '"D:\\a\\one.txt", "D:\\b\\two.log"',
    "变量：{qpaths:, } 逗号+空格且各自加引号"
  );

  // 转义：\n \t \r \\ 以及 \x -> x
  eq(raw.substitute("{names:\\n}", ctx), "one.txt\ntwo.log", "变量：{names:\\n} 换行分隔");
  eq(raw.substitute("{names:\\t}", ctx), "one.txt\ttwo.log", "变量：{names:\\t} 制表符分隔");
  eq(raw.substitute("{names:\\,}", ctx), "one.txt,two.log", "变量：{names:\\,} 转义后仍是逗号");
  eq(raw.substitute("{names: | }", ctx), "one.txt | two.log", "变量：分隔符可以是任意字面文本");
  eq(raw.substitute("{names:}", ctx), "one.txttwo.log", "变量：分隔符为空就是直接拼接");
}

/* -------- 12b. 引号内的尾斜杠转义（`wt -d "D:\"` 报「无法访问启动目录」） -------- */
/* 盘根目录天然以反斜杠结尾，而 CommandLineToArgvW 里引号尾部的一个 `\`
 * 会把闭合引号转义掉 —— 结果程序收到的是 `D:\"`。子目录通常不带尾斜杠，
 * 所以只有盘根会暴露；但 `D:\sub\` 这种写法一样中招。 */
{
  // 盘根 / 尾斜杠：裸传，让「标准解析器」和「自己解析的程序」拿到同一个值
  eq(raw.quoteWin("D:\\"), "D:\\", "quoteWin：盘根目录裸传（不加引号）");
  eq(raw.quoteWin("D:\\a\\b\\\\"), "D:\\a\\b\\\\", "quoteWin：尾部两个反斜杠也裸传原样");
  // 不带尾斜杠：照常加引号
  eq(raw.quoteWin("D:\\sub"), '"D:\\sub"', "quoteWin：不以反斜杠结尾时正常加引号");
  eq(raw.quoteWin("D:/"), '"D:/"', "quoteWin：正斜杠结尾不算尾斜杠");
  eq(raw.quoteWin("D:"), '"D:"', "quoteWin：盘符不带斜杠时正常加引号");
  eq(raw.quoteWin(""), '""', "quoteWin：空串也给一对引号");
  // 带空格又带尾斜杠：躲不掉，退回标准转义
  eq(
    raw.quoteWin("D:\\My Folder\\"),
    '"D:\\My Folder\\\\"',
    "quoteWin：含空格时仍需引号，尾斜杠按标准规则加倍"
  );
  eq(raw.quoteWin("D:\\a&b\\"), '"D:\\a&b\\\\"', "quoteWin：含 cmd 元字符时同上");

  const root = raw.buildContext(["D:\\"]);
  eq(raw.substitute("{path}", root), "D:\\", "变量：{path} 本来就不带引号");
  eq(raw.substitute("{qpath}", root), "D:\\", "变量：{qpath} 盘根目录裸传");

  const two = raw.buildContext(["D:\\", "E:\\x\\"]);
  eq(raw.substitute("{qpaths}", two), "D:\\ E:\\x\\", "变量：{qpaths} 每条各自决定加不加引号");
  eq(raw.substitute("{qpaths:,}", two), "D:\\,E:\\x\\", "变量：{qpaths:,} 自定义分隔符时同理");

  // 常规子目录不能被误伤（引号该加还得加）
  const sub = raw.buildContext(["D:\\a\\b"]);
  eq(raw.substitute("{qpath}", sub), '"D:\\a\\b"', "变量：{qpath} 子目录保持加引号");
  const sp = raw.buildContext(["D:\\My Project"]);
  eq(raw.substitute("{qpath}", sp), '"D:\\My Project"', "变量：{qpath} 含空格时加引号");
}

{
  // 只有一项 / 空列表
  const one = raw.buildContext(["D:\\a\\only.txt"]);
  eq(raw.substitute("{names:,}", one), "only.txt", "变量：单项时分隔符不参与");
  const none = raw.buildContext([]);
  eq(raw.substitute("{names:,}", none), "", "变量：空列表得到空串");
  eq(raw.substitute("{paths:,}", none), "", "变量：空列表 {paths} 也是空串");
  eq(raw.substitute("[{names:,}]", none), "[]", "变量：空列表不会留下多余分隔符");
}

{
  // 未知变量 / 非列表变量带分隔符
  const ctx = raw.buildContext(["D:\\a\\one.txt"]);
  eq(raw.substitute("{nope}", ctx), "{nope}", "变量：未识别的占位符原样保留");
  eq(raw.substitute("{name:,}", ctx), "one.txt", "变量：非列表变量忽略多余的分隔符");
}

{
  // joinList 直接测
  eq(raw.joinList(["a", "b"], null, false), "a b", "joinList：sep 省略按空格");
  eq(raw.joinList(["a", "b"], ",", true), '"a","b"', "joinList：quote 时各自加引号");
  eq(raw.joinList([], ",", true), "", "joinList：空数组得到空串");
  eq(raw.joinList(["", "a"], ",", false), "a", "joinList：过滤掉空项");
}

/* ---------------- 13. 旧数据迁移 ---------------- */

{
  dbStore["folder-command.list"] = [
    { id: "old1", name: "旧命令", trigger: "both", runMode: "console", cmd: "cmd", args: '-k "{qpath}"', cwd: "D:\\a" },
    { id: "old2", name: "旧命令2", trigger: "window", runMode: "admin", cmd: "wt" },
    {
      id: "new1",
      name: "新命令",
      category: "x",
      matches: { file: { on: true } },
      params: { folder: { args: "A", cwd: "", follow: "" } },
    },
  ];

  const list = api.loadCommands();
  eq(list.length, 3, "迁移：命令条数不变");
  // normalizeMatches 按 MATCH_KEYS 顺序产出，所以键序是 file / folder / window
  eq(
    list[0].matches,
    { file: { on: false }, folder: { on: true }, window: { on: true } },
    "迁移：both -> 文件夹 + 窗口都勾上"
  );
  eq(
    list[1].matches,
    { file: { on: false }, folder: { on: false }, window: { on: true } },
    "迁移：window -> 只勾窗口"
  );
  ok(!("trigger" in list[0]) && !("runMode" in list[0]), "迁移：trigger / runMode 已删除");

  // 顶层 args / cwd 铺到三种模式，并删掉顶层字段
  eq(list[0].params.folder.args, '-k "{qpath}"', "迁移：顶层 args 进 folder");
  eq(list[0].params.window.args, '-k "{qpath}"', "迁移：顶层 args 进 window");
  eq(list[0].params.file.cwd, "D:\\a", "迁移：顶层 cwd 进 file");
  ok(!("args" in list[0]) && !("cwd" in list[0]), "迁移：顶层 args / cwd 已删除");
  eq(list[0].params.folder.follow, "", "迁移：follow 初始为空");

  eq(list[2].category, "x", "迁移：新格式命令的分类保留");
  eq(list[2].params.folder.args, "A", "迁移：已有 params 的命令原样保留");
  eq(list[2].params.file.args, "", "迁移：已有 params 时不会被顶层值覆盖");

  const persisted = dbStore["folder-command.list"];
  ok(!("trigger" in persisted[0]), "迁移：结果已落盘");
  ok("params" in persisted[0], "迁移：params 已落盘");

  // 再次读取不应该重复改动
  const again = api.loadCommands();
  eq(again[0].matches.folder.on, true, "迁移：重复加载保持稳定");
  eq(again[0].params.folder.args, '-k "{qpath}"', "迁移：重复加载 params 稳定");
}

/* ---------------- 参数测试（buildPreview） ---------------- */

{
  const base = {
    name: "T",
    type: "command",
    cmd: "code",
    matches: { file: { on: true }, folder: { on: true }, window: { on: false } },
    params: {
      // 注意：{qpath} 自带双引号，模板里不要再套一层
      file: { args: "--file {qpath}", cwd: "" },
      folder: { args: "{qpath}", cwd: "" },
      window: { args: "", cwd: "" },
    },
  };
  const clone = () => JSON.parse(JSON.stringify(base));

  const r = raw.buildPreview(base, "D:\\Demo");
  ok(r.ok === true, "参数测试：正常返回");
  eq(r.rows.length, 2, "参数测试：只出被勾选的两行");
  eq(
    r.rows.map((x) => x.mode),
    ["file", "folder"],
    "参数测试：分行顺序跟着 MATCH_KEYS"
  );
  eq(
    r.rows.map((x) => x.label),
    ["文件", "文件夹"],
    "参数测试：带中文模式名"
  );
  eq(r.rows[0].line, 'code --file "D:\\Demo"', "参数测试：变量替换成测试路径");
  eq(r.rows[1].line, 'code "D:\\Demo"', "参数测试：每种模式用自己的参数");
  eq(r.paths, ["D:\\Demo"], "参数测试：回显测试路径");

  eq(raw.buildPreview(base, "").ok, false, "参数测试：没填路径直接报错");
  eq(raw.buildPreview(base, "   ").ok, false, "参数测试：只有空格也算没填");
  eq(raw.buildPreview(base, []).ok, false, "参数测试：空数组也算没填");

  // 多条测试路径：数组、换行串、分号串都能吃，且去重
  const two = ["D:\\A", "D:\\B"];
  eq(raw.buildPreview(base, two).paths.length, 2, "参数测试：多条路径（数组）");
  eq(
    raw.buildPreview(base, "D:\\A\nD:\\B").paths,
    two,
    "参数测试：多条路径（换行分隔的字符串）"
  );
  eq(
    raw.buildPreview(base, "D:\\A;D:\\B").paths,
    two,
    "参数测试：多条路径（分号分隔的字符串）"
  );
  eq(
    raw.buildPreview(base, ["D:\\A", "D:\\A", "  D:\\B  ", ""]).paths,
    two,
    "参数测试：去重并去掉空行与两端空白"
  );
  eq(
    raw.buildPreview(base, ['"D:\\A"']).paths,
    ["D:\\A"],
    "参数测试：整行被引号包住时把引号剥掉"
  );
  ok(
    raw.buildPreview(base, new Array(30).fill(0).map((_, i) => "D:\\P" + i)).paths.length === 20,
    "参数测试：路径条数封顶 20"
  );

  // 多条时列表变量才是「列表」：带引号、按分隔符拼
  const listVar = JSON.parse(JSON.stringify(base));
  listVar.matches = { file: { on: false }, folder: { on: true }, window: { on: false } };
  listVar.params.folder.args = "-p {qpaths:, }";
  eq(
    raw.buildPreview(listVar, two).rows[0].line,
    'code -p "D:\\A", "D:\\B"',
    "参数测试：多条时列表变量按分隔符拼"
  );
  listVar.params.folder.args = "-p {paths}";
  eq(
    raw.buildPreview(listVar, two).rows[0].line,
    "code -p D:\\A D:\\B",
    "参数测试：{paths} 不写冒号默认空格"
  );
  // 单路径时列表变量退化成一项，不至于把命令行搞崩
  eq(
    raw.buildPreview(listVar, ["D:\\A"]).rows[0].line,
    "code -p D:\\A",
    "参数测试：只有一条时列表变量就是那一条"
  );

  const none = clone();
  none.matches = { file: { on: false }, folder: { on: false }, window: { on: false } };
  eq(raw.buildPreview(none, "D:\\Demo").rows.length, 0, "参数测试：没勾匹配方式就没有行");

  // 跟随：file 的命令参数跟着 folder，预览要跟真跑一致
  const follow = clone();
  follow.params.file.follow = "folder";
  follow.params.file.args = "SHOULD-BE-IGNORED";
  eq(
    raw.buildPreview(follow, "D:\\Demo").rows[0].line,
    'code "D:\\Demo"',
    "参数测试：跟随生效，用跟随目标那一套参数"
  );

  // 工作目录也走替换
  const cw = clone();
  cw.params.folder.cwd = "{path}\\sub";
  eq(raw.buildPreview(cw, "D:\\Demo").rows[1].cwd, "D:\\Demo\\sub", "参数测试：工作目录也替换");

  // 内置动作：不产生命令行，但也要给一行说明
  const builtin = {
    name: "复制路径",
    type: "builtin",
    action: "copy-path",
    matches: base.matches,
    params: base.params,
  };
  const rb = raw.buildPreview(builtin, "D:\\Demo");
  ok(rb.ok === true && rb.rows.length === 1, "参数测试：内置动作返回一行");
  eq(rb.rows[0].label, "内置动作", "参数测试：内置动作的标注");
  eq(rb.rows[0].line.indexOf("内置动作"), 0, "参数测试：内置动作说明不冒充命令行");

  // MATCH_LABEL 必须覆盖 MATCH_KEYS 的每一项，否则界面上会出现英文 key
  ok(
    raw.MATCH_KEYS.every((k) => typeof raw.MATCH_LABEL[k] === "string" && raw.MATCH_LABEL[k]),
    "参数测试：MATCH_LABEL 覆盖三种模式"
  );
}

/* ---------------- 当前目录（异步 API 不能把 Promise 交给页面） ---------------- */

{
  /* readCurrentFolderPath 是异步的，refreshCurrentFolder 必须只往外给字符串 ——
     否则页面同步拼默认值时会得到 "[object Promise]"（stub 在这里故意返回 Promise）。 */
  const v = raw.refreshCurrentFolder();
  eq(typeof v, "string", "当前目录：返回的是字符串不是 Promise");
  ok(v.indexOf("[object Promise]") < 0, "当前目录：不会出现 [object Promise]");
  eq(v, "", "当前目录：第一次还没 resolve 时先给空串（页面会用它自己的兜底示例）");
}

/* ---------------- 结果 ---------------- */

(async () => {
  await new Promise((r) => setTimeout(r, 20));
  eq(
    raw.refreshCurrentFolder(),
    "D:\\Stub\\当前目录",
    "当前目录：异步结果会写进缓存，之后再取就有值"
  );
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  console.log(failed ? "❌ 指令生成逻辑校验未通过" : "✓ 指令生成逻辑校验通过");
  process.exit(failed ? 1 : 0);
})();
