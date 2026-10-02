/**
 * preload.js —— 目录速令
 *
 * 运行在 uTools 预加载环境中，拥有 Node.js 原生能力 + uTools API。
 *
 * 核心设计：
 *   每条自定义命令都会被注册成一个「动态指令」(utools.setFeature)，
 *   并带上 mainHide: true —— 于是它在超级面板里是一个独立条目，
 *   点一下直接执行，完全不弹出 uTools 窗口。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* ==========================================================================
 * 常量
 * ========================================================================== */

const DB_KEY = "folder-command.list";

/** 动态指令 code 前缀，用于识别与清理 */
const DYN_PREFIX = "dyn:";

/* --- 匹配方式 -----------------------------------------------------------
 * 三种模式可以多选，每种模式的「匹配条件」与「命令参数」都各自独立：
 *   folder / file → uTools 的 files 指令（fileType = directory / file）
 *   window        → uTools 的 window 指令（match.title）
 * ---------------------------------------------------------------------- */

/* 顺序 = 界面上的展示顺序，也是「都没勾时」的兜底顺序。
 * 编辑器里的勾选框、匹配条件卡、命令参数卡都按这个顺序渲染。 */
const MATCH_KEYS = ["file", "folder", "window"];

/* 跟 MATCH_KEYS 一一对应的中文名。参数测试的结果要按模式分行，得有个标题。
 * （界面里还有一份 MATCH_LABEL，两边都改才算改全。） */
const MATCH_LABEL = { file: "文件", folder: "文件夹", window: "文件夹窗口" };

/* 下面三个只是「参数骨架」：用来补全缺失字段，不表达"要不要匹配"。
 * 所以 on 一律为 false —— 没写进配置的模式就等于没勾选。
 * 新建命令默认勾上「文件夹」是编辑器（assets/app.js）的默认值，不在这里。 */
const DEFAULT_FOLDER_MATCH = {
  on: false,
  min: "1",
  max: "",
  range: "none",
  exts: "",
  regex: "",
};
const DEFAULT_FILE_MATCH = Object.assign({}, DEFAULT_FOLDER_MATCH);
/* 窗口模式只暴露一个可配项（标题正则）；app / class 是固定值，
 * 见下面的 DEFAULT_WINDOW_TARGET —— 它们才定义了"文件夹窗口"这个语义。 */
const DEFAULT_WINDOW_MATCH = {
  on: false,
  title: "",
};

/**
 * 窗口指令的固定匹配目标（用户不可配）。
 * app 是 uTools 的必填字段；class 限定为「文件夹窗口 / 桌面」，
 * 否则 explorer.exe 的其它窗口（如复制进度框）也会命中。
 */
const DEFAULT_WINDOW_TARGET = {
  app: ["explorer.exe"],
  class: ["CabinetWClass", "ExploreWClass", "WorkerW", "Progman"],
};

/**
 * 会自己开控制台窗口的程序。
 * 这些程序如果用 windowsHide 把控制台藏起来，用户会「什么都没看到」，
 * 所以要单独识别出来。GUI 程序依然静默执行，避免黑框一闪。
 */
const CONSOLE_APPS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "wt",
  "wt.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "zsh",
  "fish",
  "wsl",
  "wsl.exe",
  "conhost",
  "conhost.exe",
  "mintty",
  "mintty.exe",
  "git-bash",
  "git-bash.exe",
  "git-cmd",
  "git-cmd.exe",
  "nu",
  "nushell",
  "alacritty",
  "wezterm",
  "wezterm-gui",
  "tabby",
  "hyper",
  "cygwin",
]);

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ==========================================================================
 * 数据持久化
 * ========================================================================== */

/**
 * 把旧版本的命令补成新结构。已迁移过的命令会原样返回（幂等）。
 *
 * 迁移 1：`trigger: "folder" | "window" | "both"` 单值 + `runMode`
 *         → `matches: { folder, file, window }` 三态多选（runMode 已取消，
 *           改为按命令名自动识别控制台程序）。
 * 迁移 2：顶层的一份 `args` / `cwd`
 *         → `params: { folder, file, window }`，即「命令参数」按匹配方式各一份，
 *           并删掉顶层字段，避免出现两个真相来源。
 */
function migrateCommand(command) {
  if (!command || typeof command !== "object") return command;

  const hasMatches = command.matches && typeof command.matches === "object";
  const hasTrigger = command.trigger !== undefined || command.runMode !== undefined;
  const hasLegacyArgs = command.args !== undefined || command.cwd !== undefined;
  const rawParams = command.params && typeof command.params === "object" ? command.params : null;
  // params 必须是「三种模式都在」才算完整，否则补齐（补的时候保留已有的那几份）
  const paramsOk =
    !!rawParams &&
    MATCH_KEYS.every((k) => rawParams[k] && typeof rawParams[k] === "object");
  if (hasMatches && !hasTrigger && paramsOk && !hasLegacyArgs) return command;

  const next = Object.assign({}, command);

  if (!hasMatches) {
    const t = command.trigger || "folder";
    const on = {
      folder: t === "folder" || t === "both",
      file: false,
      window: t === "window" || t === "both",
    };
    // 同样按 MATCH_KEYS 顺序落键，保证迁移结果和新建命令是同一种「规范形」
    next.matches = {};
    MATCH_KEYS.forEach((k) => {
      next.matches[k] = { on: on[k] };
    });
  }
  delete next.trigger;
  delete next.runMode;

  if (!paramsOk) next.params = normalizeParams(command);
  delete next.args;
  delete next.cwd;

  return next;
}

function loadCommands() {
  try {
    const data = utools.dbStorage.getItem(DB_KEY);
    const list = Array.isArray(data) ? data : [];

    let dirty = false;
    const migrated = list.map((c) => {
      const next = migrateCommand(c);
      if (next !== c) dirty = true;
      return next;
    });

    // 迁移结果立刻落盘，避免每次加载都重算
    if (dirty) {
      try {
        utools.dbStorage.setItem(DB_KEY, migrated);
      } catch (err) {
        console.error("[目录速令] 迁移结果写入失败", err);
      }
    }
    return migrated;
  } catch (err) {
    console.error("[目录速令] 读取命令失败", err);
    return [];
  }
}

function saveCommands(list) {
  const safe = Array.isArray(list) ? list : [];
  try {
    utools.dbStorage.setItem(DB_KEY, safe);
  } catch (err) {
    console.error("[目录速令] 保存命令失败", err);
  }
  registerFeatures();
  return safe;
}

/* ==========================================================================
 * 路径工具
 * ========================================================================== */

/** 把 onPluginEnter 的 payload 统一转成文件夹路径数组 */
function toPaths(payload) {
  if (!payload) return [];
  if (typeof payload === "string") return [payload];
  const arr = Array.isArray(payload) ? payload : [payload];
  return arr
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        if (item.isFile === true && item.isDirectory !== true) return "";
        return item.path || item.filePath || item.file || "";
      }
      return "";
    })
    .filter(Boolean);
}

/** 去掉路径末尾的分隔符，保留根目录（如 C:\） */
function normalizeDir(p) {
  if (!p) return "";
  let out = String(p).replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:$/.test(out)) out += "\\";
  return out;
}

/** 依据进入动作解析出目标文件夹 */
async function resolveTarget(action) {
  const kind = action && action.type ? action.type : "none";
  const code = action && action.code ? action.code : "";

  // 1) 资源管理器 / 桌面窗口 -> 读取当前文件夹路径
  if (kind === "window") {
    try {
      const folder = await utools.readCurrentFolderPath();
      if (folder) return { kind, paths: [normalizeDir(folder)], source: "explorer" };
    } catch (err) {
      console.error("[目录速令] readCurrentFolderPath 失败", err);
    }
    return { kind, paths: [], source: "explorer" };
  }

  // 2) 匹配到文件夹
  if (kind === "files") {
    return { kind, paths: toPaths(action.payload).map(normalizeDir), source: "files" };
  }

  // 3) 兜底（正常不会走到：动态指令总能拿到 window / files）
  return { kind, code, paths: [], source: "manual" };
}

/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，东八区凌晨会差一天） */
function localDateString(d) {
  const t = d || new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 构建命令模板的上下文变量 */
function buildContext(paths) {
  const list = (paths || []).filter(Boolean);
  const first = list[0] || "";
  const drive = first ? path.parse(first).root || "" : "";
  return {
    path: first,
    paths: list,
    names: list.map((p) => path.basename(p)),
    name: first ? path.basename(first) : "",
    parent: first ? path.dirname(first) : "",
    drive: drive.replace(/[\\/]+$/, ""),
    ts: String(Date.now()),
    date: localDateString(),
  };
}

/**
 * 占位符。列表类变量支持一个可选的「分隔符」修饰：`{paths:,}`、`{qpaths:, }`、`{names:\n}`。
 * 分隔符里可以用 `\n` `\t` `\r` `\\` 这几个转义；不能包含 `}`。
 */
const PLACEHOLDER_RE = /\{(path|qpath|name|names|parent|drive|paths|qpaths|ts|date)(?::([^}]*))?\}/g;

/** 把一个字面分隔符里的转义还原成真实字符 */
function unescapeSep(text) {
  return String(text == null ? "" : text).replace(/\\(.)/g, (_, c) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    if (c === "\\") return "\\";
    return c; // 其它情况原样保留（比如 "\," 就是 ","）
  });
}

/** 裸传会出事的字符：空白 + cmd 的元字符（引号内是安全的，裸传不行） */
const SHELL_UNSAFE = /[\s"&^<>|()%!]/;

/**
 * 给路径加引号。**不能无脑包**，Windows 命令行解析在这里有个坑：
 *
 * CommandLineToArgvW 规则：引号内尾部的 n 个反斜杠紧跟闭合引号时会被当成
 * 「转义引号」，必须写成 2n 个才能还原。所以：
 *   `"D:\"`  →  程序收到 `D:\"`（闭合引号被吃掉）
 * 这正是 `wt -d {qpath}` 在盘根报「无法访问启动目录"D:\"」的原因，
 * 而 `D:\sub` 不以反斜杠结尾，所以子目录从来不出问题。
 *
 * 但「加倍反斜杠」只讨好**严格遵循该规则**的程序（wt、node、绝大多数原生程序）；
 * 自己解析命令行的程序会把 `\\` 当成两个字面反斜杠（Everything 就是这类，
 * 官方论坛那个「打不开盘符」的 bug 正是同一个根因，他们的修法是**去掉尾部引号**
 * 让字符串不闭合）。带引号的写法没法同时满足两边。
 *
 * 所以取一个两边都能原样到达的形式：**尾斜杠且不含空白 / 元字符时直接裸传**。
 * 实测（cmd.exe + node 打印 argv，见 DEVELOP.md 踩坑 20）：
 *   "D:\"     -> D:\"     错
 *   "D:\\"    -> D:\      对（仅对标准解析器的程序）
 *   D:\       -> D:\      对（两种解析器都拿到 D:\，故为默认策略）
 *   D:\sub    -> 仍需引号  -> "D:\sub"
 */
function quoteWin(p) {
  const s = String(p == null ? "" : p);
  if (!s) return '""';
  const tail = (s.match(/\\+$/) || [""])[0].length;
  if (!tail) return '"' + s + '"'; // 不以反斜杠结尾：正常加引号
  // 以反斜杠结尾：只要没有空白 / 元字符就裸传，绕开整套转义分歧
  if (!SHELL_UNSAFE.test(s)) return s;
  // 实在需要引号（路径带空格等）：只能按标准规则加倍反斜杠
  return '"' + s + "\\".repeat(tail) + '"';
}

/** 列表 -> 字符串。sep 省略时按空格拼（保持向后兼容）。 */
function joinList(list, sep, quote) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return "";
  const parts = quote ? items.map((p) => quoteWin(p)) : items;
  return parts.join(sep === null || sep === undefined ? " " : unescapeSep(sep));
}

function substitute(template, ctx) {
  if (!template) return "";
  return String(template).replace(PLACEHOLDER_RE, (_, key, sep) => {
    const paths = ctx.paths || [];
    switch (key) {
      case "path":
        return ctx.path || "";
      case "qpath":
        return ctx.path ? quoteWin(ctx.path) : "";
      case "name":
        return ctx.name || "";
      case "parent":
        return ctx.parent || "";
      case "drive":
        return ctx.drive || "";
      case "paths":
        return joinList(paths, sep, false);
      case "qpaths":
        return joinList(paths, sep, true);
      case "names":
        return joinList(ctx.names || [], sep, false);
      case "ts":
        return ctx.ts;
      case "date":
        return ctx.date;
      default:
        return "";
    }
  });
}

/* ==========================================================================
 * 图标
 * ========================================================================== */

function fileToDataUrl(file) {
  if (!file || !fs.existsSync(file)) return "";
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext] || "image/png";
  const buf = fs.readFileSync(file);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

const iconCache = new Map();

/** 解析图标配置 -> base64 data url（空字符串表示无自定义图标） */
function resolveIcon(icon) {
  if (!icon || !icon.type) return "";
  const value = icon.value || "";
  const key = `${icon.type}::${value}`;
  if (iconCache.has(key)) return iconCache.get(key);

  let url = "";
  try {
    switch (icon.type) {
      case "file":
        url = fileToDataUrl(value);
        break;
      case "exe":
        // utools.getFileIcon 支持 exe / lnk / 任意文件真实路径，返回系统图标
        url = utools.getFileIcon(value);
        break;
      case "folder":
        url = utools.getFileIcon("folder");
        break;
      case "ext":
        url = utools.getFileIcon(value || ".exe");
        break;
      case "data":
        url = value;
        break;
      default:
        url = "";
    }
  } catch (err) {
    console.error("[目录速令] 解析图标失败", icon, err);
    url = "";
  }

  iconCache.set(key, url || "");
  return url || "";
}

/** 极简 which 实现（Windows 优先按 PATHEXT 补全） */
function which(cmd) {
  const isWin = process.platform === "win32";
  const dirs = (process.env.PATH || "").split(isWin ? ";" : ":");
  const exts = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch (err) {
        /* 忽略 */
      }
    }
  }
  return "";
}

/** 从命令行第一个 token 自动猜测图标 */
function guessIconFromCommand(cmdText) {
  if (!cmdText) return "";
  const first = String(cmdText).trim().split(/\s+/)[0].replace(/^["']|["']$/g, "");
  if (!first) return "";
  try {
    if (first.includes("\\") || first.includes("/")) {
      const withExt = /\.(exe|lnk|bat|cmd|com|ps1)$/i.test(first) ? first : `${first}.exe`;
      if (fs.existsSync(withExt)) return utools.getFileIcon(withExt);
      if (fs.existsSync(first)) return utools.getFileIcon(first);
    } else {
      const found = which(first);
      if (found) return utools.getFileIcon(found);
    }
  } catch (err) {
    /* 忽略 */
  }
  return "";
}

/**
 * 综合解析一条命令的图标：
 * 自定义图标 -> 从命令推导 -> 内置动作回退到文件夹图标
 */
function commandIcon(command) {
  if (!command) return "";
  let url = "";
  if (command.icon && command.icon.type) {
    url = resolveIcon(command.icon) || "";
  }
  if (!url && command.type !== "builtin" && command.cmd) {
    url = guessIconFromCommand(command.cmd) || "";
  }
  if (!url && command.type === "builtin") {
    url = resolveIcon({ type: "folder", value: "" }) || "";
  }
  return url || "";
}

/* ==========================================================================
 * 动态指令：每条自定义命令 = 超级面板里的一个独立条目
 * ========================================================================== */

/** "a, b;c" -> ["a","b","c"] */
function splitList(text) {
  if (!text) return [];
  const out = String(text)
    .split(/[\n,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

/** 数字字段：空 / 非法 -> null（= 不传该参数） */
function toInt(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * uTools 要求 match / title 这类字段是「正则表达式字符串」，形如 `/xxx/i`。
 * 用户通常只会填 `\.(jpg|png)$`，这里统一补上斜杠与 i 标志。
 */
function normalizeRegex(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return "";
  if (s.startsWith("/")) return s;
  return `/${s}/i`;
}

/** 把 command.matches 补全成三模式完整结构 */
function normalizeMatches(command) {
  const raw = (command && command.matches) || {};
  const out = {};
  MATCH_KEYS.forEach((k) => {
    const def = k === "window" ? DEFAULT_WINDOW_MATCH : k === "folder" ? DEFAULT_FOLDER_MATCH : DEFAULT_FILE_MATCH;
    const src = raw[k] && typeof raw[k] === "object" ? raw[k] : {};
    const merged = Object.assign({}, def, src);
    merged.on = !!merged.on;
    out[k] = merged;
  });
  return out;
}

/**
 * 把 command.params（「命令参数」）补全成三模式完整结构。
 * 缺 params 时从顶层 args / cwd 兜底（正常已被 migrateCommand 迁移过）。
 */
function normalizeParams(command) {
  const legacyArgs = typeof command.args === "string" ? command.args : "";
  const legacyCwd = typeof command.cwd === "string" ? command.cwd : "";
  const raw = command && command.params && typeof command.params === "object" ? command.params : null;
  const out = {};
  MATCH_KEYS.forEach((k) => {
    const src = raw && raw[k] && typeof raw[k] === "object" ? raw[k] : null;
    out[k] = {
      args: src && src.args != null ? String(src.args) : legacyArgs,
      cwd: src && src.cwd != null ? String(src.cwd) : legacyCwd,
      follow: src && typeof src.follow === "string" ? src.follow : "",
    };
  });
  return out;
}

/**
 * 解析某个匹配方式实际要用的「命令参数」。
 * 配了「跟随」就用目标的；目标不存在或指向自己时用自身的。
 * 编辑器保存时已把跟随的值写实，这里只是运行时兜底。
 */
function resolveCommandParams(command, mode) {
  const all = normalizeParams(command);
  const key = all[mode] ? mode : MATCH_KEYS[0];
  const own = all[key];
  const target = own.follow;
  if (target && target !== key && all[target]) return all[target];
  return own;
}

/** 第一条被勾选的匹配方式（试运行 / 列表摘要用） */
function firstEnabledMatch(command) {
  const m = normalizeMatches(command);
  return MATCH_KEYS.find((k) => m[k].on) || MATCH_KEYS[0];
}

/** 把 `/body/flags` 形式的正则字符串拆开；不符合形式时按裸正则处理 */
function splitRegexString(text) {
  const txt = String(text == null ? "" : text);
  if (txt.startsWith("/")) {
    const end = txt.lastIndexOf("/");
    if (end > 0) return { body: txt.slice(1, end), flags: txt.slice(end + 1) };
  }
  return { body: txt, flags: "i" };
}

/**
 * 名称长度约束 -> 正则前置的零宽断言。
 * `{3,}` / `{0,10}` 都是合法量词（注意不能写成 `{,10}`）。
 */
function lengthLookahead(min, max) {
  const lo = min === null ? 0 : min;
  const hi = max === null ? "" : max;
  return `^(?=[\\s\\S]{${lo},${hi}}$)`;
}

/**
 * 把「名称长度」并进名称正则。
 * 必须是正则 —— uTools 的 extensions 与 match 是二选一的，
 * 而长度限制只有正则能表达，所以设了长度就只能走 match。
 */
function applyNameLength(re, min, max) {
  if (min === null && max === null) return re;
  const { body, flags } = splitRegexString(re);
  return `/${lengthLookahead(min, max)}${body}/${flags}`;
}

/** 只按长度约束时的正则（名称任意字符，长度在区间内） */
function nameLengthOnlyRegex(min, max) {
  const { body, flags } = splitRegexString("[\\s\\S]*");
  return `/${lengthLookahead(min, max)}${body}/${flags}`;
}

/** files 类型的指令 */
function buildFileCmd(p, fileType, label) {
  const cmd = { type: "files", fileType, label };

  // ① 选中「个数」—— uTools 原生字段（官方定义：最少/最多文件数）
  const min = toInt(p.min);
  if (min !== null) cmd.minLength = min;
  const max = toInt(p.max);
  if (max !== null) cmd.maxLength = max;

  // ② 「名称长度」—— uTools 没有原生字段，只能并进 match 正则
  const nameMin = toInt(p.nameMin);
  const nameMax = toInt(p.nameMax);
  const hasLen = nameMin !== null || nameMax !== null;

  // 文档明确：extensions 与 match 二选一
  if (p.range === "ext") {
    const exts = splitList(p.exts).map((e) => e.replace(/^\./, "")).filter(Boolean);
    if (exts.length && !hasLen) {
      // 没有长度限制时用原生的 extensions，最省事也最准
      cmd.extensions = exts;
    } else if (exts.length) {
      const escaped = exts.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      cmd.match = applyNameLength(`/\\.(?:${escaped.join("|")})$/i`, nameMin, nameMax);
    } else if (hasLen) {
      cmd.match = nameLengthOnlyRegex(nameMin, nameMax);
    }
  } else if (p.range === "regex") {
    const re = normalizeRegex(p.regex);
    if (re) cmd.match = applyNameLength(re, nameMin, nameMax);
    else if (hasLen) cmd.match = nameLengthOnlyRegex(nameMin, nameMax);
  } else if (hasLen) {
    cmd.match = nameLengthOnlyRegex(nameMin, nameMax);
  }
  return cmd;
}

/**
 * window 类型的指令。
 * 用户只配「窗口标题正则」；app / class 用固定值（app 是 uTools 的必填字段）。
 */
function buildWindowCmd(p, label) {
  const match = {
    app: DEFAULT_WINDOW_TARGET.app.slice(),
    class: DEFAULT_WINDOW_TARGET.class.slice(),
  };
  const title = normalizeRegex(p.title);
  if (title) match.title = title;
  return { type: "window", label, match };
}

/** 按勾选的匹配方式生成指令数组（可能有 0~3 条） */
function featureCmds(command) {
  const label = command.name || "目录速令";
  const m = normalizeMatches(command);
  const cmds = [];

  // 顺序完全跟着 MATCH_KEYS：界面上的勾选框、卡片、以及超级面板里的条目顺序都一致
  MATCH_KEYS.forEach((k) => {
    if (!m[k].on) return;
    if (k === "window") cmds.push(buildWindowCmd(m[k], label));
    else cmds.push(buildFileCmd(m[k], k === "folder" ? "directory" : "file", label));
  });

  // 一条都没勾（理论上进不来）也让命令有兜底入口
  if (!cmds.length) cmds.push(buildFileCmd(DEFAULT_FOLDER_MATCH, "directory", label));
  return cmds;
}

/** 清掉本插件注册过的全部动态指令 */
function clearFeatures() {
  let removed = 0;
  try {
    const list = utools.getFeatures() || [];
    list.forEach((f) => {
      if (f && typeof f.code === "string" && f.code.indexOf(DYN_PREFIX) === 0) {
        try {
          utools.removeFeature(f.code);
          removed += 1;
        } catch (err) {
          /* 忽略单条失败 */
        }
      }
    });
  } catch (err) {
    console.error("[目录速令] 清理动态指令失败", err);
  }
  return removed;
}

/**
 * 按当前命令列表重新注册动态指令。
 * 每条命令对应一个 feature：mainHide = true，触发时不显示 uTools 窗口。
 * `enabled === false` 的命令跳过注册（= 从超级面板里隐藏，但配置仍保留）。
 */
function registerFeatures() {
  const list = loadCommands();
  clearFeatures();

  let ok = 0;
  let active = 0;
  list.forEach((command) => {
    if (!command || !command.id || !command.name) return;
    if (command.enabled === false) return;
    active += 1;

    const feature = {
      code: DYN_PREFIX + command.id,
      explain: `目录速令 · ${command.name}`,
      mainHide: true,
      platform: ["win32", "darwin", "linux"],
      cmds: featureCmds(command),
    };

    // setFeature 的 icon 用 data:image/png;base64 最稳；svg 等不做透传，回退到插件 logo
    const icon = commandIcon(command);
    if (icon && icon.indexOf("data:image/svg") !== 0) feature.icon = icon;

    try {
      utools.setFeature(feature);
      ok += 1;
    } catch (err) {
      console.error("[目录速令] 注册动态指令失败", command.name, err);
    }
  });

  console.log(`[目录速令] 已注册 ${ok}/${active} 条动态指令（共 ${list.length} 条配置）`);
  return ok;
}

/* ==========================================================================
 * 执行命令
 * ========================================================================== */

const detachedOpts = (windowsHide) => ({
  detached: true,
  stdio: "ignore",
  windowsHide,
});

function spawnShell(commandLine, cwd, windowsHide) {
  const child = spawn(commandLine, [], {
    cwd,
    shell: true,
    ...detachedOpts(windowsHide),
  });
  child.unref();
  return child;
}

/** 取出命令行的第一个 token（去掉引号与路径），判断是不是自带控制台的程序 */
/**
 * 取命令行里「被启动的那个程序」。
 * 不能直接按空白切：`C:\Program Files\Git\git-bash.exe --cd=x` 的路径本身就带空格。
 * 优先级：引号包裹 > 绝对路径里第一个可执行后缀 > 第一个空白分隔 token。
 */
function programToken(commandLine) {
  const s = String(commandLine || "").trim();
  if (!s) return "";

  const quoted = s.match(/^"([^"]+)"/) || s.match(/^'([^']+)'/);
  if (quoted) return quoted[1];

  const token = s.split(/\s+/)[0];
  // 没引号但确实以路径开头：一路吃到第一个可执行后缀为止
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s)) {
    const m = s.match(/^(.*?\.(?:exe|com|bat|cmd|ps1|lnk))(?=\s|$)/i);
    if (m && m[1].length > token.length) return m[1];
  }
  return token;
}

/** 要执行的是不是「会自己开控制台」的程序 */
function needsConsole(commandLine) {
  const token = programToken(commandLine);
  if (!token) return false;
  const base = token.replace(/\\/g, "/").split("/").pop().toLowerCase();
  return CONSOLE_APPS.has(base);
}

/** 内置动作 */
function runBuiltin(action, ctx) {
  switch (action) {
    case "copy-path":
      utools.copyText(ctx.paths.join("\r\n"));
      return `已复制 ${ctx.paths.length} 个路径`;
    case "copy-name":
      utools.copyText(ctx.paths.map((p) => path.basename(p)).join("\r\n"));
      return `已复制 ${ctx.paths.length} 个名称`;
    case "copy-qpath":
      utools.copyText(ctx.paths.map((it) => `"${it}"`).join(" "));
      return "已复制带引号路径";
    case "open-folder":
      utools.shellOpenPath(ctx.path);
      return `已打开 ${ctx.path}`;
    case "reveal-folder":
      utools.shellShowItemInFolder(ctx.path);
      return `已在资源管理器中定位 ${ctx.path}`;
    case "copy-to-clipboard-files":
      utools.copyFile(ctx.paths);
      return "已复制到剪贴板";
    default:
      throw new Error(`未知的内置动作：${action}`);
  }
}

/**
 * 执行一条命令
 * @param {object} command 命令定义
 * @param {string[]} rawPaths 目标文件夹 / 文件路径
 * @param {string} [mode] 触发它的匹配方式（folder / file / window），
 *                        决定用哪一套「命令参数」；省略则取第一条勾选的
 */
function execute(command, rawPaths, mode) {
  const ctx = buildContext(rawPaths);
  if (!ctx.path) {
    return { ok: false, message: "没有获取到文件夹路径" };
  }

  try {
    if (command.type === "builtin") {
      const message = runBuiltin(command.action, ctx);
      return { ok: true, builtin: true, message, ctx };
    }

    const params = resolveCommandParams(command, mode || firstEnabledMatch(command));
    const cmdText = substitute(command.cmd, ctx).trim();
    const argsText = substitute(params.args, ctx).trim();
    const commandLine = [cmdText, argsText].filter(Boolean).join(" ");
    if (!commandLine) {
      return { ok: false, message: "命令内容为空，请先在「目录速令」管理页里配置" };
    }

    const cwdRaw = substitute(params.cwd, ctx).trim();
    let cwd;
    if (cwdRaw && fs.existsSync(cwdRaw)) cwd = cwdRaw;
    else if (ctx.path && fs.existsSync(ctx.path)) cwd = ctx.path;

    // 默认静默（GUI 程序不会闪黑框）；自带控制台的程序则保留窗口，否则用户看不到东西
    const showConsole = needsConsole(cmdText);
    spawnShell(commandLine, cwd, !showConsole);

    return { ok: true, message: `已执行：${commandLine}`, commandLine, cwd, ctx, showConsole };
  } catch (err) {
    console.error("[目录速令] 执行失败", err);
    return { ok: false, message: `执行失败：${err.message}` };
  }
}

/* ==========================================================================
 * 进入动态指令：静默执行，不弹窗口
 * ========================================================================== */

function safeOut() {
  if (uiActive) return; // 管理界面正开着，别把用户窗口关掉
  try {
    utools.outPlugin();
  } catch (err) {
    /* 忽略 */
  }
}

/**
 * 管理界面是否正处于打开状态。
 * 打开时不要再调用 outPlugin，否则会把用户正在用的窗口一起关掉。
 */
let uiActive = false;

utools.onPluginOut((isKill) => {
  uiActive = false;
  window.dispatchEvent(new CustomEvent("folder-command:out", { detail: !!isKill }));
});

function handleDynamicEnter(action) {
  // 双保险：即使 mainHide 没生效，也立刻把 uTools 窗口收起来，保证「无窗口执行」
  if (!uiActive) {
    try {
      utools.hideMainWindow();
    } catch (err) {
      /* 忽略 */
    }
  }

  // code 形如 dyn:<命令id>:<模式>
  const rest = String(action.code).slice(DYN_PREFIX.length);
  const dot = rest.indexOf(":");
  const id = dot >= 0 ? rest.slice(0, dot) : rest;
  const mode = dot >= 0 ? rest.slice(dot + 1) : "";

  const command = loadCommands().find((c) => c.id === id);

  if (!command) {
    utools.showNotification("目录速令：找不到该命令（可能已在管理页删除）", "manage");
    safeOut();
    return;
  }

  if (command.enabled === false) {
    utools.showNotification(`目录速令「${command.name}」已停用，请在管理页启用`, "manage");
    safeOut();
    return;
  }

  Promise.resolve()
    .then(() => resolveTarget(action))
    .then((target) => {
      const result = execute(command, target.paths, mode);
      if (!result.ok) {
        utools.showNotification(`目录速令「${command.name}」失败：${result.message}`, "manage");
      } else if (result.builtin) {
        // 内置动作没有窗口反馈，补一个系统通知
        utools.showNotification(`目录速令：${result.message}`);
      }
      safeOut();
    })
    .catch((err) => {
      console.error("[目录速令] 执行异常", err);
      utools.showNotification(`目录速令执行异常：${err && err.message}`, "manage");
      safeOut();
    });
}

/* ==========================================================================
 * 对外 API（供 index.html 的管理界面使用）
 * ========================================================================== */

/* ==========================================================================
 * 参数测试：只把「程序 + 参数」拼出来，不执行
 * ========================================================================== */

/**
 * 资源管理器当前打开的目录（缓存一份）。
 *
 * ⚠️ `utools.readCurrentFolderPath()` 是**异步**的（返回 Promise，见 resolveTarget 里的 await），
 * 而页面取「测试路径默认值」是同步的 —— 直接把返回值交出去会被 String() 成
 * "[object Promise]"，输入框里就出现这么一串。所以这里提前取一次存着，
 * api.currentFolder() **只返回字符串**，拿不到就返回空串让页面用兜底示例。
 */
let lastKnownFolder = "";

function refreshCurrentFolder() {
  try {
    const r = utools.readCurrentFolderPath();
    if (r && typeof r.then === "function") {
      r.then((p) => {
        lastKnownFolder = typeof p === "string" ? p : "";
      }).catch(() => {
        lastKnownFolder = "";
      });
      return lastKnownFolder; // 还没 resolve 就先把旧值（可能为空）交出去
    }
    lastKnownFolder = typeof r === "string" ? r : "";
  } catch (err) {
    lastKnownFolder = "";
  }
  return lastKnownFolder;
}

/**
 * 把界面里填的测试路径整理成数组：
 * 支持数组、换行/分号分隔的字符串、单个字符串；去空、去重、保留顺序。
 * 上限 20 条——参数测试只是看命令行，再多也没意义还容易把面板撑爆。
 */
function normalizePreviewPaths(raw) {
  const items = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[\r\n;]+/);
  const out = [];
  items.forEach((it) => {
    const p = String(it == null ? "" : it).trim().replace(/^"(.*)"$/, "$1");
    if (p && out.indexOf(p) < 0) out.push(p);
  });
  return out.slice(0, 20);
}

/**
 * 把命令模板里的变量替换成测试路径，拼出完整命令行。
 * 三种匹配方式可以各配一套命令参数，所以每种被勾选的模式都出一行；
 * 参数带「跟随」时 resolveCommandParams 会给出跟随目标那一套（跟真跑一致）。
 * 传多条测试路径时，列表变量（{paths} {qpaths} {names}）才有意义。
 */
function buildPreview(command, rawPaths) {
  const paths = normalizePreviewPaths(rawPaths);
  if (!paths.length) {
    return {
      ok: false,
      message: "先加一个测试路径：「加目录」/「加文件」挑，或者直接粘贴多行路径",
    };
  }

  // 选中多项时 uTools 给的 payload 就是路径数组，这里同样把测试路径当上下文
  const ctx = buildContext(paths);

  if (command.type === "builtin") {
    return {
      ok: true,
      paths,
      rows: [
        {
          mode: "",
          label: "内置动作",
          line: "内置动作不产生命令行，由插件自己完成（如复制路径）",
          cwd: "",
        },
      ],
    };
  }

  const rows = [];
  MATCH_KEYS.forEach((k) => {
    const m = (command.matches && command.matches[k]) || {};
    if (!m.on) return;
    const params = resolveCommandParams(command, k);
    const cmdText = substitute(command.cmd, ctx).trim();
    const argsText = substitute(params.args, ctx).trim();
    const cwdText = substitute(params.cwd, ctx).trim();
    rows.push({
      mode: k,
      label: MATCH_LABEL[k] || k,
      line: [cmdText, argsText].filter(Boolean).join(" "),
      cwd: cwdText,
    });
  });

  return { ok: true, paths, rows };
}

/* ==========================================================================
 * API：暴露给渲染进程
 * ========================================================================== */

const api = {
  /* --- 环境 --- */
  env() {
    return {
      platform: process.platform,
      isWindows: utools.isWindows(),
      isMacOS: utools.isMacOS(),
      isLinux: utools.isLinux(),
      dark: utools.isDarkColors(),
      version: utools.getAppVersion(),
      appName: utools.getAppName(),
      deviceId: utools.getNativeId(),
      home: utools.getPath("home"),
    };
  },

  onDarkModeChange(cb) {
    if (typeof utools.onDarkColorsChange === "function") {
      utools.onDarkColorsChange(cb);
      return true;
    }
    return false;
  },

  /* --- 数据 --- */
  loadCommands,
  saveCommands,

  /* --- 动态指令 --- */
  registerFeatures,
  clearFeatures,
  featureCount() {
    try {
      return (utools.getFeatures() || []).filter(
        (f) => typeof f.code === "string" && f.code.indexOf(DYN_PREFIX) === 0
      ).length;
    } catch (err) {
      return 0;
    }
  },

  /* --- 进入 / 离开插件 --- */
  onEnter(cb) {
    window.addEventListener("folder-command:enter", (e) => cb(e.detail));
  },
  onOut(cb) {
    window.addEventListener("folder-command:out", (e) => cb(e.detail));
  },

  /* --- 选择器 --- */
  pickFolder() {
    const res = utools.showOpenDialog({
      title: "选择文件夹",
      properties: ["openDirectory"],
    });
    return res && res.length ? res[0] : "";
  },
  pickImage() {
    const res = utools.showOpenDialog({
      title: "选择图标",
      filters: [
        { name: "图标图片", extensions: ["png", "jpg", "jpeg", "ico", "svg", "webp", "bmp", "gif"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    return res && res.length ? res[0] : "";
  },
  pickExecutable() {
    const res = utools.showOpenDialog({
      title: "选择程序（从 EXE 提取图标）",
      filters: [
        { name: "可执行文件", extensions: ["exe", "lnk", "bat", "cmd", "com"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    return res && res.length ? res[0] : "";
  },

  /** 选择要执行的程序 / 脚本（命令那一栏的「浏览」） */
  pickProgram() {
    const res = utools.showOpenDialog({
      title: "选择要执行的程序",
      filters: [
        {
          name: "可执行文件 / 脚本",
          extensions: ["exe", "com", "bat", "cmd", "ps1", "vbs", "lnk", "jar", "py"],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    return res && res.length ? res[0] : "";
  },

  /* --- 图标 --- */
  resolveIcon,
  guessIconFromCommand,
  commandIcon,

  /* --- 参数测试 --- */
  /**
   * 资源管理器当前打开的目录，用来给「测试路径」兜个默认值。
   * 必须返回**字符串**：readCurrentFolderPath 是异步的，直接返回它的值会拿到 Promise。
   */
  currentFolder() {
    return refreshCurrentFolder() || "";
  },
  /** 多选文件夹（参数测试用：一次可以加好几个目录） */
  pickFolders() {
    const res = utools.showOpenDialog({
      title: "选择用于测试的文件夹（可多选）",
      properties: ["openDirectory", "multiSelections"],
    });
    return res && res.length ? res : [];
  },
  /** 多选文件（参数测试用） */
  pickFiles() {
    const res = utools.showOpenDialog({
      title: "选择用于测试的文件（可多选）",
      properties: ["openFile", "multiSelections"],
    });
    return res && res.length ? res : [];
  },
  copyText(text) {
    utools.copyText(String(text == null ? "" : text));
    return true;
  },
  /** rawPaths 可以是数组，也可以是换行分隔的字符串 */
  previewCommand(command, rawPaths) {
    return buildPreview(command, rawPaths);
  },

  /* --- 试运行 --- */
  testRun(command) {
    const res = utools.showOpenDialog({
      title: "选择用于试运行的文件夹",
      properties: ["openDirectory"],
    });
    if (!res || !res.length) return { ok: false, message: "已取消" };
    return execute(command, res);
  },
};

window.folderCmd = api;

/* ==========================================================================
 * 事件注册
 * ========================================================================== */

utools.onPluginEnter((action) => {
  if (!action) return;

  // 动态指令：无窗口模式，直接执行，不交给页面
  if (typeof action.code === "string" && action.code.indexOf(DYN_PREFIX) === 0) {
    handleDynamicEnter(action);
    return;
  }

  // 静态指令（只有 manage）：打开管理窗口，交给页面渲染
  uiActive = true;
  // 趁进入插件先把当前目录取好（异步），之后页面同步取默认值就有东西
  refreshCurrentFolder();
  window.dispatchEvent(new CustomEvent("folder-command:enter", { detail: action }));
});

/* 每次插件被加载都刷新一遍动态指令，保证与命令列表一致 */
registerFeatures();

// 页面控制台里方便调试
window.folderCmdRaw = {
  utools,
  fs,
  path,
  process,
  registerFeatures,
  featureCmds,
  normalizeParams,
  resolveCommandParams,
  firstEnabledMatch,
  needsConsole,
  programToken,
  DYN_PREFIX,
  // 占位符相关（供 dev 校验脚本直接断言）
  buildContext,
  substitute,
  joinList,
  quoteWin,
  buildPreview,
  normalizePreviewPaths,
  refreshCurrentFolder,
  MATCH_KEYS,
  MATCH_LABEL,
};
