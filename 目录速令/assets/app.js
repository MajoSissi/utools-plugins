/* ==========================================================================
 * 目录速令 —— 管理界面主逻辑
 *
 * 本插件只有一个界面：命令管理。
 * 每条命令通过 preload 注册成 uTools 动态指令，在超级面板里直接执行，不弹窗口。
 * ========================================================================== */

(function () {
  "use strict";

  const api = window.folderCmd;

  /* ======================================================================
   * 常量
   * ==================================================================== */

  /**
   * 变量列表。点一下把占位符复制到剪贴板。
   * desc 必须**自己写完整**（不能写「同上」）—— 变量面板里每条都是独立一行，
   * 用户看到的是单条，不是上下文连贯的一段话。
   */
  const VAR_CHIPS = [
    { key: "{path}", desc: "第一个选中项的完整路径，不带引号" },
    { key: "{qpath}", desc: "第一个选中项的完整路径，已带双引号（路径含空格时用它）" },
    { key: "{name}", desc: "第一个选中项的名称，文件夹名或文件名（含后缀）" },
    { key: "{parent}", desc: "第一个选中项所在的上级目录路径" },
    { key: "{drive}", desc: "第一个选中项所在的盘符 / 根目录，如 D:" },
    { key: "{paths}", desc: "全部选中项的完整路径（列表变量，可加分隔符）", list: true },
    { key: "{qpaths}", desc: "全部选中项的完整路径，每一项各自带双引号", list: true },
    { key: "{names}", desc: "全部选中项的名称，含后缀（列表变量，可加分隔符）", list: true },
    { key: "{ts}", desc: "当前时间戳（毫秒，13 位数字）" },
    { key: "{date}", desc: "当前日期，格式 YYYY-MM-DD" },
  ];

  /**
   * 列表变量的「分隔符用法」示例。
   * 原来只有一行文字说明，用户问过「要用一个空格分割怎么办」 ——
   * 所以现在摊成一排可点的示例卡片，点一下把写法复制走。
   * 第一个示例专门回答「空格」：不写冒号就是空格，写 `{paths: }` 也一样。
   */
  const VAR_SEP_ROWS = [
    { tpl: "{paths}", result: "D:\\a D:\\b", note: "默认就是空格" },
    { tpl: "{paths: }", result: "D:\\a D:\\b", note: "冒号后写一个空格，结果和不写冒号一样" },
    { tpl: "{paths:,}", result: "D:\\a,D:\\b", note: "逗号" },
    { tpl: "{paths:, }", result: "D:\\a, D:\\b", note: "逗号加空格" },
    { tpl: "{paths:}", result: "D:\\aD:\\b", note: "空分隔符 = 直接拼接" },
    { tpl: "{qpaths:, }", result: '"D:\\a", "D:\\b"', note: "每项自带引号，传给命令行最常用" },
    { tpl: "{names:\\n}", result: "a.txt 换行 b.log", note: "换行（\\t 制表、\\r 回车、\\\\ 反斜杠）" },
  ];

  const VAR_SEP_FOOT =
    "分隔符写在冒号后面，可以是任意字面文本，但不能包含 `}`（那是占位符的结束符）。" +
    "非列表变量（如 {name}）后面跟冒号没有意义，会被忽略。";

  const ACTIONS = [
    { value: "copy-path", label: "复制路径" },
    { value: "copy-qpath", label: "复制带双引号的路径" },
    { value: "copy-name", label: "复制名称" },
    { value: "open-folder", label: "用系统默认方式打开" },
    { value: "reveal-folder", label: "在资源管理器中定位" },
    { value: "copy-to-clipboard-files", label: "复制到剪贴板（文件）" },
  ];

  const ACTION_LABEL = ACTIONS.reduce((acc, it) => {
    acc[it.value] = it.label;
    return acc;
  }, {});

  /** 三种匹配方式 —— 顺序即界面展示顺序（勾选框 / 匹配条件卡 / 命令参数卡都按它渲染） */
  const MATCH_KEYS = ["file", "folder", "window"];
  /** 命令参数里可以被「跟随」复制的字段（不含 follow 本身，否则会把跟随关系自己抄过去） */
  const PARAM_FIELDS = ["args", "cwd"];

  const MATCH_LABEL = {
    file: "文件",
    folder: "文件夹",
    window: "文件夹窗口",
  };

  /* 场景描述：整个插件都是在资源管理器里用的，所以这里不再重复标注「资源管理器」 */
  const MATCH_SCENE = {
    file: "选中文件时",
    folder: "选中文件夹时",
    window: "焦点停在文件夹窗口 / 桌面时",
  };

  /** files 类型支持的匹配范围 */
  const RANGE_LABEL = {
    none: "不限制",
    ext: "扩展名",
    regex: "正则",
  };

  /* 匹配条件：min/max 是「选中个数」（uTools 原生 minLength/maxLength），
     nameMin/nameMax 是「名称字符数」—— 原生没有这个字段，由 preload 并进 match 正则。 */
  const DEFAULT_FOLDER = {
    on: true,
    min: "1",
    max: "",
    nameMin: "",
    nameMax: "",
    range: "none",
    exts: "",
    regex: "",
  };
  const DEFAULT_FILE = Object.assign({}, DEFAULT_FOLDER, { on: false });
  /* 窗口模式只暴露「窗口标题正则」；应用名与窗口类是固定值（见 DEVELOP.md 第四节） */
  const DEFAULT_WINDOW = { on: false, title: "" };

  /** 把同一份命令参数铺到三种匹配方式上（示例数据 / 模板用） */
  function shareParams(args, cwd) {
    const one = { args: args || "", cwd: cwd || "", follow: "" };
    return {
      file: Object.assign({}, one),
      folder: Object.assign({}, one),
      window: Object.assign({}, one),
    };
  }

  const CAT_ALL = "__all__";
  const CAT_NONE = "__none__";

  /** 启用状态筛选的取值 */
  const STATUS_ALL = "all";
  const STATUS_ON = "on";
  const STATUS_OFF = "off";

  /* 拖拽手柄：两列圆点，表示「按住可以拖」 */
  const DRAG_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>' +
    '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>' +
    '<circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>' +
    "</svg>";

  const SEED_COMMANDS = [
    {
      id: "seed-vscode",
      name: "VS Code 打开",
      category: "开发",
      type: "command",
      cmd: "code",
      params: {
        // {qpath} 本身就带双引号，模板里不要再套一层 —— 否则会拼出 ""D:\a""
        folder: { args: "{qpath}", cwd: "", follow: "" },
        file: { args: "{qpath}", cwd: "", follow: "folder" },
        window: { args: "{qpath}", cwd: "", follow: "" },
      },
      icon: { type: "exe", value: guessPath("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe") },
      enabled: true,
      matches: {
        folder: { on: true, min: "1", max: "", range: "none", exts: "", regex: "" },
        file: { on: true },
        window: { on: false },
      },
    },
    {
      id: "seed-cmd",
      name: "在此打开 CMD",
      category: "终端",
      type: "command",
      cmd: "cmd",
      params: shareParams("/k cd /d {qpath}"),
      icon: { type: "exe", value: guessPath("SystemRoot", "System32/cmd.exe") },
      enabled: true,
      matches: {
        folder: { on: false },
        file: { on: false },
        window: { on: true, title: "" },
      },
    },
    {
      id: "seed-powershell",
      name: "在此打开 PowerShell",
      category: "终端",
      type: "command",
      cmd: "powershell",
      params: shareParams("-NoExit -Command \"Set-Location -LiteralPath '{path}'\""),
      icon: { type: "exe", value: guessPath("SystemRoot", "System32/WindowsPowerShell/v1.0/powershell.exe") },
      enabled: true,
      matches: {
        folder: { on: false },
        file: { on: false },
        window: { on: true },
      },
    },
    {
      id: "seed-wt",
      name: "Windows Terminal 打开",
      category: "终端",
      type: "command",
      cmd: "wt",
      params: shareParams("-d {qpath}"),
      icon: { type: "exe", value: "" },
      enabled: true,
      matches: {
        folder: { on: true },
        file: { on: false },
        window: { on: true },
      },
    },
    {
      id: "seed-copy",
      name: "复制路径",
      category: "系统",
      type: "builtin",
      action: "copy-path",
      icon: { type: "folder", value: "" },
      enabled: true,
      matches: {
        folder: { on: true },
        file: { on: true },
        window: { on: false },
      },
    },
    {
      id: "seed-image",
      name: "复制图片路径",
      category: "系统",
      type: "builtin",
      action: "copy-path",
      icon: { type: "ext", value: ".png" },
      enabled: true,
      matches: {
        folder: { on: false },
        file: {
          on: true,
          min: "1",
          max: "100",
          range: "regex",
          exts: "",
          regex: "\\.(jpg|jpeg|png|webp|gif)$",
        },
        window: { on: false },
      },
    },
  ];

  const PRESETS = [
    {
      name: "VS Code 打开",
      category: "开发",
      type: "command",
      cmd: "code",
      args: "{qpath}",
      matches: { folder: { on: true }, file: { on: true } },
    },
    {
      name: "CMD 打开",
      category: "终端",
      type: "command",
      cmd: "cmd",
      args: "/k cd /d {qpath}",
      matches: { window: { on: true } },
    },
    {
      name: "PowerShell 打开",
      category: "终端",
      type: "command",
      cmd: "powershell",
      args: "-NoExit -Command \"Set-Location -LiteralPath '{path}'\"",
      matches: { window: { on: true } },
    },
    {
      name: "Windows Terminal",
      category: "终端",
      type: "command",
      cmd: "wt",
      args: "-d {qpath}",
      matches: { folder: { on: true }, window: { on: true } },
    },
    {
      name: "Git Bash Here",
      category: "终端",
      type: "command",
      cmd: "C:\\Program Files\\Git\\git-bash.exe",
      args: "--cd={qpath}",
      matches: { folder: { on: true } },
    },
    {
      name: "Everything 搜索此目录",
      category: "系统",
      type: "command",
      cmd: "C:\\Program Files\\Everything\\Everything.exe",
      args: "-path {qpath}",
      matches: { folder: { on: true } },
    },
    {
      name: "复制路径",
      category: "系统",
      type: "builtin",
      action: "copy-path",
      matches: { folder: { on: true }, file: { on: true } },
    },
    { name: "用默认程序打开", category: "系统", type: "builtin", action: "open-folder", matches: { folder: { on: true }, file: { on: true } } },
    {
      name: "资源管理器中定位",
      category: "系统",
      type: "builtin",
      action: "reveal-folder",
      matches: { folder: { on: true }, file: { on: true } },
    },
    {
      name: "只匹配图片文件",
      category: "系统",
      type: "builtin",
      action: "copy-path",
      matches: {
        file: { on: true, min: "1", max: "100", range: "regex", regex: "\\.(jpg|jpeg|png|webp|gif)$" },
      },
    },
    {
      name: "只匹配文档",
      category: "办公",
      type: "builtin",
      action: "copy-path",
      matches: {
        file: { on: true, min: "1", max: "50", range: "ext", exts: "pdf, doc, docx, md, txt" },
      },
    },
  ];

  function guessPath(envKey, sub) {
    let base = "";
    try {
      const env = (window.folderCmdRaw && window.folderCmdRaw.process
        ? window.folderCmdRaw.process.env
        : null) || {};
      base = env[envKey] || "";
    } catch (err) {
      base = "";
    }
    if (!base) return "";
    return base.replace(/\\/g, "/") + "/" + sub;
  }

  /* ======================================================================
   * 状态
   * ==================================================================== */

  const state = {
    commands: [],
    search: "",
    filter: CAT_ALL,
    /** 启用状态筛选：all | on | off */
    status: "all",
    /** 多选模式：关掉时列表里不出现勾选框，批量条也一并隐藏 */
    multi: false,
    /** 列表里被勾选（多选）的命令 id 集合，用于批量启用 / 停用 / 删除 */
    selection: new Set(),
    /** 拖拽排序时被拖动的命令 id */
    draggingId: null,
    /** 正在进行的框选（多选模式专用）；null = 没有在框选 */
    marquee: null,
    /** 新建时选中的起始模板下标；null = 空模板 */
    activePreset: null,
    editingId: null,
    draft: null,
    matchDraft: null,
    cmdParamDraft: null,
    pendingDelete: null,
    iconCache: new Map(),
  };

  const $ = (id) => document.getElementById(id);

  /* ======================================================================
   * 工具
   * ==================================================================== */

  function uid() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(message, isError) {
    const el = $("toast");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.classList.add("hidden"), 220);
    }, 1900);
  }

  function categoryOf(command) {
    return String((command && command.category) || "").trim();
  }

  /** 把一条命令的 matches（匹配条件）补全成三模式完整结构 */
  function matchesOf(command) {
    const raw = (command && command.matches) || {};
    const out = {};
    MATCH_KEYS.forEach((k) => {
      const def = k === "window" ? DEFAULT_WINDOW : k === "folder" ? DEFAULT_FOLDER : DEFAULT_FILE;
      const src = raw[k] && typeof raw[k] === "object" ? raw[k] : {};
      const merged = Object.assign({}, def, src);
      merged.on = !!merged.on;
      out[k] = merged;
    });
    return out;
  }

  /**
   * 把一条命令的 params（命令参数）补全成三模式完整结构。
   * 缺 params 时从顶层 args / cwd 兜底（preload 的 migrateCommand 已迁移，这里只是防御）。
   */
  function paramsOf(command) {
    const legacyArgs = command && typeof command.args === "string" ? command.args : "";
    const legacyCwd = command && typeof command.cwd === "string" ? command.cwd : "";
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

  function enabledMatches(command) {
    const m = matchesOf(command);
    return MATCH_KEYS.filter((k) => m[k].on);
  }

  function matchSummary(command) {
    const keys = enabledMatches(command);
    return keys.map((k) => MATCH_LABEL[k]).join(" + ") || "未设置";
  }

  /** 第一条勾选的匹配方式（列表摘要 / 试运行用，与 preload 的 firstEnabledMatch 一致） */
  function firstMatchOf(command) {
    return enabledMatches(command)[0] || MATCH_KEYS[0];
  }

  /** 解析命令图标：自定义 -> 自动识别 -> 内置动作回退（统一走 preload 的实现） */
  function commandIcon(command) {
    const key = command.id + "|" + JSON.stringify(command.icon || {}) + "|" + (command.cmd || "");
    if (state.iconCache.has(key)) return state.iconCache.get(key);
    let url = "";
    try {
      url = api.commandIcon(command) || "";
    } catch (err) {
      url = "";
    }
    state.iconCache.set(key, url);
    return url;
  }

  function invalidateIcon(commandId) {
    for (const key of Array.from(state.iconCache.keys())) {
      if (key.startsWith(commandId + "|")) state.iconCache.delete(key);
    }
  }

  function iconHtml(url, tag) {
    if (url) return `<img src="${escapeHtml(url)}" alt="" draggable="false" />`;
    return `<span class="glyph">${tag}</span>`;
  }

  /** 取路径最后一段（同时兼容 \ 和 /），并去掉两端可能存在的引号 */
  function baseName(value) {
    const s = String(value || "").trim().replace(/^["']+|["']+$/g, "");
    const cut = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return cut >= 0 ? s.slice(cut + 1) : s;
  }

  /**
   * 列表副标题：只显示「程序名 + 参数」。
   * 程序的完整路径太占地方（列表又窄），省略掉目录部分；
   * 完整命令挂在 title 上，鼠标悬停还是能看到。
   */
  function commandSummary(command) {
    if (command.type === "builtin") {
      return ACTION_LABEL[command.action] || "内置动作";
    }
    const p = paramsOf(command)[firstMatchOf(command)];
    return [baseName(command.cmd), p && p.args].filter(Boolean).join(" ");
  }

  /** 副标题的完整文本（不省路径），用于 title 提示 */
  function commandSummaryFull(command) {
    if (command.type === "builtin") return commandSummary(command);
    const p = paramsOf(command)[firstMatchOf(command)];
    return [command.cmd, p && p.args].filter(Boolean).join(" ");
  }

  /* ======================================================================
   * 初始化
   * ==================================================================== */

  function init() {
    applyTheme();

    let commands = api.loadCommands();
    if (!Array.isArray(commands) || !commands.length) {
      commands = clone(SEED_COMMANDS);
      api.saveCommands(commands);
    }
    state.commands = commands;

    buildVarChips();
    buildActionOptions();
    bindEvents();

    api.onEnter(() => renderManage());
    api.onOut(() => closeEditor());

    if (api.onDarkModeChange) {
      api.onDarkModeChange(() => applyTheme());
    }

    renderManage();
  }

  function applyTheme() {
    let dark = true;
    try {
      dark = api.env().dark;
    } catch (err) {
      dark = true;
    }
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }

  /* ======================================================================
   * 命令列表：搜索 + 分类筛选
   * ==================================================================== */

  function allCategories() {
    const set = new Set();
    state.commands.forEach((c) => {
      const v = categoryOf(c);
      if (v) set.add(v);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh"));
  }

  /** 一条命令参与搜索的全部文本 */
  function searchText(command) {
    const p = paramsOf(command);
    // 命令参数按匹配方式各一份，三份都要能被搜到
    const paramText = MATCH_KEYS.map((k) => `${p[k].args} ${p[k].cwd}`).join(" ");
    return [
      command.name,
      command.cmd,
      paramText,
      categoryOf(command),
      ACTION_LABEL[command.action],
      matchSummary(command),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  /** 只按搜索词过滤（不含分类）。分类标签的计数按它算，搜索与分类才能真正叠加。 */
  function searchFiltered() {
    const kw = state.search.trim().toLowerCase();
    if (!kw) return state.commands;
    return state.commands.filter((c) => searchText(c).includes(kw));
  }

  function renderCatBar() {
    const pool = searchFiltered();
    const cats = allCategories();
    const countOf = (fn) => pool.filter(fn).length;

    const items = [{ key: CAT_ALL, label: "全部", n: pool.length }];
    cats.forEach((c) => {
      items.push({ key: c, label: c, n: countOf((x) => categoryOf(x) === c) });
    });
    const noneN = countOf((x) => !categoryOf(x));
    if (noneN) items.push({ key: CAT_NONE, label: "未分类", n: noneN });

    // 当前筛选项已经不存在了（分类被改名/删掉）就回到「全部」
    if (state.filter !== CAT_ALL && !items.some((it) => it.key === state.filter)) {
      state.filter = CAT_ALL;
    }

    $("cat-bar").innerHTML = items
      .map((it) => {
        const active = state.filter === it.key;
        // 当前搜索词下没有命中的分类变灰，但依然可点
        const cls = ["cat-chip", active ? "active" : "", !it.n && !active ? "dim" : ""]
          .filter(Boolean)
          .join(" ");
        return `<button class="${cls}" data-cat="${escapeHtml(it.key)}">${escapeHtml(
          it.label
        )}<b>${it.n}</b></button>`;
      })
      .join("");
  }

  function visibleRows() {
    let rows = searchFiltered().map((c) => ({ c, i: state.commands.indexOf(c) }));
    // 分类
    if (state.filter !== CAT_ALL) {
      rows = rows.filter(({ c }) =>
        state.filter === CAT_NONE ? !categoryOf(c) : categoryOf(c) === state.filter
      );
    }
    // 启用状态（在分类之后叠加，两者互不影响计数）
    if (state.status !== STATUS_ALL) {
      const want = state.status === STATUS_ON;
      rows = rows.filter(({ c }) => (c.enabled !== false) === want);
    }
    return rows;
  }

  function renderManage() {
    renderCatBar();

    const list = $("manage-list");
    const rows = visibleRows();

    // 命令被删掉后，把残留的勾选清掉，否则批量操作会对着不存在的 id 干活
    pruneSelection();

    if (!state.commands.length) {
      list.innerHTML = `<div class="empty"><strong>还没有自定义命令</strong>点击右上角「新建」开始<br />新建时也可以从模板里挑一个</div>`;
      renderBatchBar([]);
      return;
    }

    if (!rows.length) {
      const canReset = !!state.search.trim() || state.filter !== CAT_ALL;
      list.innerHTML =
        `<div class="empty"><strong>没有匹配的命令</strong>换个关键词或分类试试` +
        (canReset
          ? `<br /><button class="btn tonal sm" data-act="reset-filter">清空筛选条件</button>`
          : "") +
        `</div>`;
      renderBatchBar([]);
      return;
    }

    list.innerHTML = rows
      .map(({ c }) => {
        const isOff = c.enabled === false;
        const tag = c.type === "builtin" ? "动作" : "CMD";
        const cat = categoryOf(c);
        const picked = state.selection.has(c.id);

        const badges = enabledMatches(c).map(
          (k) => `<span class="item-badge">${MATCH_LABEL[k]}</span>`
        );
        if (cat) badges.push(`<span class="item-badge cat">${escapeHtml(cat)}</span>`);

        // 勾选框只属于「多选模式」，关掉时整列不渲染，列表看起来更干净
        const check = state.multi
          ? `<label class="item-check" title="勾选后可批量操作">
               <input type="checkbox" data-act="select" ${picked ? "checked" : ""} />
             </label>`
          : "";

        // 拖拽排序手柄：多选模式下换成框选，手柄隐藏（勾选框正好顶上它的位置）
        const handle = state.multi
          ? ""
          : `<div class="drag-handle" draggable="true" title="按住拖动可调整顺序">${DRAG_ICON}</div>`;

        const sub = commandSummary(c);
        const subFull = commandSummaryFull(c);
        const subTitle = subFull && subFull !== sub ? ` title="${escapeHtml(subFull)}"` : "";

        return `
        <div class="item ${isOff ? "off" : ""} ${picked ? "picked" : ""}" data-id="${escapeHtml(
          c.id
        )}">
          ${handle}
          ${check}
          <div class="item-icon">${iconHtml(commandIcon(c), tag)}</div>
          <div class="item-body">
            <div class="item-title">${escapeHtml(c.name || "未命名命令")}</div>
            <div class="item-sub"${subTitle}>${escapeHtml(sub)}</div>
          </div>

          <div class="item-badges">${badges.join("")}</div>

          <div class="item-actions">
            <button class="icon-btn edit" data-act="edit" title="编辑这条命令">编辑</button>
            <button class="icon-btn toggle ${isOff ? "off" : ""}" data-act="toggle" title="${
          isOff ? "启用这条命令" : "停用这条命令"
        }">${isOff ? "启用" : "停用"}</button>
            <button class="icon-btn del" data-act="del" title="删除这条命令">${
          state.pendingDelete === c.id ? "确认删除?" : "删除"
        }</button>
          </div>
        </div>`;
      })
      .join("");

    renderBatchBar(rows);
  }

  /** 清掉指已不存在命令的勾选 */
  function pruneSelection() {
    const alive = new Set(state.commands.map((c) => c.id));
    Array.from(state.selection).forEach((id) => {
      if (!alive.has(id)) state.selection.delete(id);
    });
  }

  /** 批量操作条：只在「多选模式 + 有可见行」时出现；全选框反映当前可见行的勾选情况 */
  function renderBatchBar(rows) {
    const bar = $("batch-bar");
    if (!bar) return;
    const show = state.multi && rows.length > 0;
    bar.classList.toggle("hidden", !show);
    if (!show) return;

    const pickedVisible = rows.filter(({ c }) => state.selection.has(c.id)).length;
    const all = $("check-all");
    all.checked = pickedVisible > 0 && pickedVisible === rows.length;
    all.indeterminate = pickedVisible > 0 && pickedVisible < rows.length;

    const n = state.selection.size;
    $("batch-count").textContent = n ? `已选 ${n} 项` : `共 ${rows.length} 项`;
    $("btn-batch-off").disabled = !n;
    $("btn-batch-on").disabled = !n;
    $("btn-batch-del").disabled = !n;
  }

  /** 多选模式开关。关掉时一并清空勾选 —— 否则会留下一批看不见的「已选」。 */
  function setMulti(on) {
    state.multi = !!on;
    $("btn-multi").classList.toggle("active", state.multi);
    $("btn-multi").setAttribute("aria-pressed", state.multi ? "true" : "false");
    // 多选模式：列表上禁止文本选中（否则框选会连带选中文字），并且不再允许拖拽排序
    $("manage-list").classList.toggle("multi", state.multi);
    if (!state.multi) {
      state.selection.clear();
      endMarquee(false);
    }
    renderManage();
  }

  /** 批量启用 / 停用 */
  function setEnabledFor(ids, enabled) {
    let n = 0;
    ids.forEach((id) => {
      const c = state.commands.find((x) => x.id === id);
      if (!c) return;
      if ((c.enabled !== false) === enabled) return;
      c.enabled = enabled;
      n += 1;
    });
    if (!n) return;
    persist();
    renderManage();
    toast(enabled ? `已启用 ${n} 条命令` : `已停用 ${n} 条命令`);
  }

  function persist() {
    api.saveCommands(state.commands);

    // 底栏的「已注册 N 条」已经去掉，但「注册失败」这件事还是得让人知道，
    // 所以改成只在「启用数 ≠ 实际注册数」时提示一次。
    // setTimeout 是为了让调用方紧接着的那句成功 toast 先显示，再被这条错误提示盖掉。
    const enabled = state.commands.filter((c) => c.enabled !== false).length;
    let count = null;
    try {
      count = api.featureCount();
    } catch (err) {
      count = null;
    }
    if (count != null && count !== enabled) {
      setTimeout(() => toast(`已启用 ${enabled} 条，但只注册成功 ${count} 条`, true), 0);
    }
  }

  function moveCommand(from, to) {
    if (from === to || to < 0 || to >= state.commands.length) return;
    const [item] = state.commands.splice(from, 1);
    state.commands.splice(to, 0, item);
    persist();
    renderManage();
  }

  /**
   * 拖拽落点换算：insertAt 是「在**拖动前**的数组里要插到第几位」(0..n)。
   * 因为 moveCommand 是先摘掉再插入，若从前往后拖，目标索引要左移一位。
   */
  function reorderCommand(from, insertAt) {
    if (from < 0) return;
    moveCommand(from, insertAt > from ? insertAt - 1 : insertAt);
  }

  /* ---------------- 拖拽排序（替代原来的 ↑ ↓ 按钮） ---------------- */

  /** 落点在目标行的上半还是下半 —— 决定插到它前面还是后面 */
  function dropSide(el, clientY) {
    const box = el.getBoundingClientRect();
    return clientY < box.top + box.height / 2 ? "before" : "after";
  }

  function clearDropMarks() {
    $("manage-list")
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }

  function endDrag() {
    state.draggingId = null;
    clearDropMarks();
    document
      .querySelectorAll(".item.dragging")
      .forEach((el) => el.classList.remove("dragging"));
  }

  /* ======================================================================
   * 框选（只在多选模式下生效）
   * —— 多选模式下拖拽排序被关掉，同一个「按住拖动」手势改成框选：
   *    在列表空白 / 行上按下鼠标拉出一个矩形，松手时框到的行全部勾上。
   * ==================================================================== */

  /** 视口坐标下的两个矩形是否相交（框选命中判定） */
  function rectsHit(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function onMarqueeMove(e) {
    const m = state.marquee;
    if (!m) return;

    // 位移太小先当成普通点击，不画框 —— 免得点一下闪一个 1px 的方块
    if (
      !m.active &&
      Math.abs(e.clientX - m.startX) < 4 &&
      Math.abs(e.clientY - m.startY) < 4
    ) {
      return;
    }
    m.active = true;

    // 框用 position:fixed 挂在视口上，坐标全走 clientX/clientY，
    // 不用去算列表的滚动偏移（列表滚动时 mousemove 会跟着重算）
    const left = Math.min(m.startX, e.clientX);
    const top = Math.min(m.startY, e.clientY);
    const box = {
      left,
      top,
      right: Math.max(m.startX, e.clientX),
      bottom: Math.max(m.startY, e.clientY),
    };
    m.el.style.display = "block";
    m.el.style.left = box.left + "px";
    m.el.style.top = box.top + "px";
    m.el.style.width = box.right - box.left + "px";
    m.el.style.height = box.bottom - box.top + "px";

    m.hits = [];
    $("manage-list")
      .querySelectorAll(".item")
      .forEach((item) => {
        const hit = rectsHit(item.getBoundingClientRect(), box);
        item.classList.toggle("mb-hit", hit);
        if (hit) m.hits.push(item.dataset.id);
      });
  }

  function onMarqueeUp() {
    const m = state.marquee;
    if (!m) return;

    // 没拉出框 = 普通单击：多选模式下切换这一行的勾选
    if (!m.active) {
      const id = m.startId;
      endMarquee(false);
      if (!id) return;
      if (state.selection.has(id)) state.selection.delete(id);
      else state.selection.add(id);
      renderManage();
      return;
    }

    const hits = m.hits;
    endMarquee(false);
    hits.forEach((id) => state.selection.add(id));
    renderManage();
  }

  /**
   * 收尾框选。commit=false 只拆掉视觉（调用方自己决定要不要重绘）。
   * 监听挂在 document 上：鼠标可能在列表外松开，但框还是要收掉。
   */
  function endMarquee(commit) {
    const m = state.marquee;
    if (!m) return false;
    state.marquee = null;
    document.removeEventListener("mousemove", onMarqueeMove);
    document.removeEventListener("mouseup", onMarqueeUp);
    if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    $("manage-list")
      .querySelectorAll(".mb-hit")
      .forEach((el) => el.classList.remove("mb-hit"));
    if (commit && m.hits && m.hits.length) {
      m.hits.forEach((id) => state.selection.add(id));
      return true;
    }
    return false;
  }

  function bindMarquee() {
    const list = $("manage-list");

    list.addEventListener("mousedown", (e) => {
      if (!state.multi || e.button !== 0) return;
      // 行内按钮 / 勾选框 / 下拉之类交给它们自己处理
      if (e.target.closest("button, input, label, .item-check")) return;
      if (state.marquee) endMarquee(false);

      const item = e.target.closest(".item");
      // 阻止默认行为：既避免拖动时把文字选蓝，也避免触发原生 drag
      e.preventDefault();

      const el = document.createElement("div");
      el.className = "marquee";
      el.style.display = "none";
      document.body.appendChild(el);

      state.marquee = {
        el,
        active: false,
        startX: e.clientX,
        startY: e.clientY,
        startId: item ? item.dataset.id : null,
        hits: [],
      };
      if (item) item.classList.add("mb-hit");

      document.addEventListener("mousemove", onMarqueeMove);
      document.addEventListener("mouseup", onMarqueeUp);
    });
  }

  function bindDragSort() {
    const list = $("manage-list");

    list.addEventListener("dragstart", (e) => {
      // 多选模式下不排序（手柄本来就没渲染，这里再兜一层）
      if (state.multi) return;
      const handle = e.target.closest(".drag-handle");
      if (!handle) return;
      const item = handle.closest(".item");
      if (!item) return;
      state.draggingId = item.dataset.id;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // 部分环境不 setData 就不会触发 drop
      e.dataTransfer.setData("text/plain", item.dataset.id);
    });

    list.addEventListener("dragover", (e) => {
      if (!state.draggingId) return;
      const item = e.target.closest(".item");
      if (!item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarks();
      if (item.dataset.id === state.draggingId) return;
      item.classList.add(dropSide(item, e.clientY) === "before" ? "drop-before" : "drop-after");
    });

    list.addEventListener("dragleave", (e) => {
      // relatedTarget 还在列表里就只是移动到下一个子元素，别清掉标记
      if (!list.contains(e.relatedTarget)) clearDropMarks();
    });

    list.addEventListener("drop", (e) => {
      const id = state.draggingId;
      const item = e.target.closest(".item");
      if (!id || !item) return;
      e.preventDefault();
      const side = dropSide(item, e.clientY);
      const from = state.commands.findIndex((c) => c.id === id);
      const target = state.commands.findIndex((c) => c.id === item.dataset.id);
      // 先复位再重排：重排会整块重绘，dragend 就不会再从旧节点冒泡上来了
      endDrag();
      if (from < 0 || target < 0) return;
      reorderCommand(from, side === "before" ? target : target + 1);
    });

    /* 拖拽被取消（Esc、拖到窗口外）时收尾。重排成功后 draggingId 已经清空，这里是幂等的。 */
    document.addEventListener("dragend", endDrag);
  }

  function removeCommand(id, triggerBtn) {
    const item = state.commands.find((c) => c.id === id);
    if (!item) return;

    // 二次确认，避免弹原生对话框
    if (state.pendingDelete !== id) {
      state.pendingDelete = id;
      if (triggerBtn) {
        triggerBtn.textContent = "确认删除?";
        triggerBtn.dataset.confirm = "1";
      }
      clearTimeout(removeCommand._timer);
      removeCommand._timer = setTimeout(() => {
        state.pendingDelete = null;
        renderManage();
      }, 3200);
      return;
    }

    state.pendingDelete = null;
    state.commands = state.commands.filter((c) => c.id !== id);
    state.selection.delete(id);
    persist();
    invalidateIcon(id);
    renderManage();
    toast(`已删除「${item.name}」`);
  }

  /** 批量删除：作用于**所有已勾选项**（含当前被筛掉看不见的），与批量开关一致 */
  function removeSelected() {
    const ids = Array.from(state.selection);
    if (!ids.length) return;

    if (!removeSelected._armed) {
      removeSelected._armed = true;
      $("btn-batch-del").textContent = `确认删除 ${ids.length} 项?`;
      clearTimeout(removeSelected._timer);
      removeSelected._timer = setTimeout(() => {
        removeSelected._armed = false;
        $("btn-batch-del").textContent = "删除";
      }, 3200);
      return;
    }

    removeSelected._armed = false;
    clearTimeout(removeSelected._timer);
    $("btn-batch-del").textContent = "删除";

    const set = new Set(ids);
    state.commands = state.commands.filter((c) => !set.has(c.id));
    ids.forEach((id) => invalidateIcon(id));
    state.selection.clear();
    persist();
    renderManage();
    toast(`已删除 ${ids.length} 条命令`);
  }

  /* ======================================================================
   * 编辑器 —— 变量 / 动作 / 匹配参数卡
   * ==================================================================== */

  function buildVarChips() {
    $("var-chips").innerHTML = VAR_CHIPS.map((v) => {
      const hint = v.list ? `${v.desc}；下面的示例里有分隔符用法` : v.desc;
      return (
        `<button type="button" class="var-item" data-var="${escapeHtml(v.key)}" ` +
        `title="点击复制 ${escapeHtml(v.key)}\n${escapeHtml(hint)}">` +
        `<code>${escapeHtml(v.key)}</code><span>${escapeHtml(v.desc)}</span></button>`
      );
    }).join("");

    // 列表变量的分隔符：摊成一排可点的示例，不再是孤零零一行说明
    $("var-sep").innerHTML =
      `<div class="var-sep-title">列表变量（{paths} {qpaths} {names}）的分隔符 —— 点一下复制写法</div>` +
      VAR_SEP_ROWS.map(
        (r) =>
          `<button type="button" class="var-sep-item" data-var="${escapeHtml(r.tpl)}" ` +
          `title="点击复制 ${escapeHtml(r.tpl)}">` +
          `<code>${escapeHtml(r.tpl)}</code><span class="vs-arrow">→</span>` +
          `<span class="vs-result">${escapeHtml(r.result)}</span>` +
          `<span class="vs-note">${escapeHtml(r.note)}</span></button>`
      ).join("") +
      `<div class="var-sep-foot">${escapeHtml(VAR_SEP_FOOT)}</div>`;
  }

  function buildActionOptions() {
    $("f-action").innerHTML = ACTIONS.map(
      (a) => `<option value="${escapeHtml(a.value)}">${escapeHtml(a.label)}</option>`
    ).join("");
  }

  function newDraft() {
    return {
      name: "",
      category: "",
      type: "command",
      cmd: "",
      action: "copy-path",
      icon: { type: "", value: "" },
      enabled: true,
      // 默认一种匹配方式都不勾：让用户自己选，勾选框旁会给「至少选中一项」的提醒
      matches: { file: { on: false }, folder: { on: false }, window: { on: false } },
      params: shareParams("{qpath}"),
    };
  }

  function filledDraft(command) {
    return {
      name: command.name || "",
      category: command.category || "",
      type: command.type || "command",
      cmd: command.cmd || "",
      action: command.action || "copy-path",
      icon: command.icon || { type: "", value: "" },
      enabled: command.enabled !== false,
      matches: command.matches || newDraft().matches,
      params: paramsOf(command),
    };
  }

  function openEditor(command) {
    state.editingId = command ? command.id : null;
    // 每次打开都从空模板起步（模板条只在新建时出现）
    state.activePreset = null;
    fillEditor(command ? filledDraft(command) : newDraft(), !!command);
  }

  function fillEditor(draft, isEdit) {
    state.draft = draft;
    state.matchDraft = matchesOf(draft);
    state.cmdParamDraft = paramsOf(draft);

    $("editor-title").textContent = isEdit ? "编辑命令" : "新建命令";
    $("f-name").value = draft.name || "";
    $("f-category").value = draft.category || "";
    $("f-cmd").value = draft.cmd || "";
    $("f-action").value = draft.action || "copy-path";
    $("f-icon-type").value = (draft.icon && draft.icon.type) || "";
    $("f-icon-value").value = (draft.icon && draft.icon.value) || "";

    setSegmented("f-type", draft.type || "command");
    applyTypeVisibility();
    applyIconFieldVisibility();
    updateIconPreview();

    renderTplChips(isEdit);
    renderMatchPicker();
    renderMatchParams();
    renderCmdParams();
    renderCatSuggest();

    // 删除入口只在列表里（行尾「删除」/ 批量删除），编辑器底栏不再放删除按钮
    $("foot-hint").textContent = isEdit ? "要删除这条命令，请回列表点它右边的「删除」" : "";
    hideCmdPreview();
    showEditorView(true);
    setTimeout(() => $("f-name").focus(), 30);
  }

  /**
   * 切换「管理列表 / 编辑」两个视图。
   * 编辑不是弹窗，而是整页替换 —— 所以只切 .hidden，没有蒙层、没有点外部关闭。
   */
  function showEditorView(on) {
    $("view-manage").classList.toggle("hidden", on);
    $("view-editor").classList.toggle("hidden", !on);
    // 每次进来都从顶部开始，否则会停在上一轮滚到的位置（标题由 fillEditor 设）
    if (on) {
      const body = $("editor-body");
      if (body) body.scrollTop = 0;
    }
  }

  function closeEditor() {
    showEditorView(false);
    state.editingId = null;
    state.draft = null;
    state.matchDraft = null;
    state.cmdParamDraft = null;
  }

  /* ======================================================================
   * 参数测试
   * —— 不执行命令，只把「程序 + 参数」里的变量替换掉，摊开完整命令行。
   *    三种匹配方式可以各配一套命令参数，所以按模式分行显示。
   * ==================================================================== */

  function hideCmdPreview() {
    $("cmd-preview").classList.add("hidden");
  }

  /**
   * 测试路径的默认值：优先用资源管理器当前目录，拿不到就给个示例。
   * await 是双保险：桥接层有可能把 preload 的返回值包成 Promise
   * （不 await 的话 String(Promise) 会变成 "[object Promise]"），
   * 非字符串一律当没拿到。
   */
  async function defaultTestPath() {
    let p = "";
    try {
      const v = await api.currentFolder();
      p = typeof v === "string" ? v : "";
    } catch (err) {
      p = "";
    }
    return p || "D:\\示例\\我的文件夹";
  }

  /** 把多行文本框拆成路径数组（去掉空行与两端空白） */
  function testPathList() {
    const raw = $("f-test-paths") ? $("f-test-paths").value : "";
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function setTestPathList(list) {
    if ($("f-test-paths")) $("f-test-paths").value = (list || []).join("\n");
  }

  /** 追加测试路径（去重），立刻重算 */
  function addTestPaths(paths) {
    const add = (paths || []).filter(Boolean);
    if (!add.length) return;
    const next = testPathList();
    add.forEach((p) => {
      if (next.indexOf(p) < 0) next.push(p);
    });
    setTestPathList(next);
    runCmdPreview();
  }

  async function toggleCmdPreview() {
    if (!$("cmd-preview").classList.contains("hidden")) {
      hideCmdPreview();
      return;
    }
    if (!testPathList().length) setTestPathList([await defaultTestPath()]);
    if (!$("cmd-preview")) return; // await 期间编辑页可能已经被关掉
    $("cmd-preview").classList.remove("hidden");
    runCmdPreview();
  }

  /** 给「点一下复制」的容器挂监听（变量格和分隔符示例都在用） */
  function copyOnClick(containerId) {
    $(containerId).addEventListener("click", (e) => {
      const chip = e.target.closest("[data-var]");
      if (!chip) return;
      const token = chip.dataset.var;
      try {
        api.copyText(token);
        toast(`已复制 ${token}`);
      } catch (err) {
        toast("复制失败", true);
      }
    });
  }

  /** 表单有改动时重算参数测试（面板没开就什么都不做，别白跑） */
  function refreshCmdPreview() {
    if ($("cmd-preview").classList.contains("hidden")) return;
    runCmdPreview();
  }

  function runCmdPreview() {
    let res;
    try {
      res = api.previewCommand(collectDraft(), testPathList());
    } catch (err) {
      res = { ok: false, message: String((err && err.message) || err) };
    }
    renderCmdPreview(res);
  }

  function renderCmdPreview(res) {
    const box = $("cmd-preview-list");
    const n = testPathList().length;
    $("cp-count").textContent = n ? `已选 ${n} 项` : "还没选路径";
    if (!res || !res.ok) {
      box.innerHTML = `<div class="cp-empty">${escapeHtml(
        (res && res.message) || "参数测试失败"
      )}</div>`;
      return;
    }
    if (!res.rows || !res.rows.length) {
      box.innerHTML = `<div class="cp-empty">还没有勾选任何匹配方式</div>`;
      return;
    }
    box.innerHTML = res.rows
      .map(
        (r) => `
        <div class="cp-row" data-copy="${escapeHtml(r.line)}" title="点击复制这条命令">
          <span class="cp-mode">${escapeHtml(r.label)}</span>
          <code class="cp-line">${escapeHtml(r.line || "（空）")}</code>
          ${r.cwd ? `<span class="cp-cwd">工作目录：${escapeHtml(r.cwd)}</span>` : ""}
        </div>`
      )
      .join("");
  }

  function setSegmented(containerId, value) {
    const box = $(containerId);
    box.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === value);
    });
    box.dataset.value = value;
  }

  function getSegmented(containerId) {
    return $(containerId).dataset.value;
  }

  function applyTypeVisibility() {
    const type = getSegmented("f-type");
    document.querySelectorAll('[data-when="command"]').forEach((el) => {
      el.classList.toggle("hidden", type !== "command");
    });
    document.querySelectorAll('[data-when="builtin"]').forEach((el) => {
      el.classList.toggle("hidden", type !== "builtin");
    });
  }

  /* ---------------- 匹配方式勾选 ---------------- */

  function checkedMatchKeys() {
    if (!state.matchDraft) return [];
    return MATCH_KEYS.filter((k) => state.matchDraft[k].on);
  }

  function renderMatchPicker() {
    $("match-picker")
      .querySelectorAll("label.mcheck")
      .forEach((lab) => {
        const key = lab.querySelector("input[data-match]").dataset.match;
        const cb = lab.querySelector("input[data-match]");
        cb.checked = !!state.matchDraft[key].on;
        lab.classList.toggle("on", cb.checked);
        // 场景说明挪到 title：悬停能看到，但不占版面
        lab.title = MATCH_SCENE[key];
      });
    updateMatchHint();
  }

  /** 只在「一项都没勾」时提示（新建时默认就是这个状态）—— 否则命令不会出现在超级面板里 */
  function updateMatchHint() {
    const el = $("match-hint");
    if (checkedMatchKeys().length) {
      el.textContent = "";
      el.classList.remove("warn");
      el.classList.add("hidden");
      return;
    }
    el.textContent = "至少选中一项";
    el.classList.add("warn");
    el.classList.remove("hidden");
  }

  /* ---------------- 匹配条件卡（没有任何「跟随」，只是各模式自己的筛选条件） ---------------- */

  function fileCardHtml(key, checked) {
    const p = state.matchDraft[key];
    return `
    <div class="match-card" data-key="${key}">
      <div class="match-card-head">
        <span class="match-card-title">${MATCH_LABEL[key]}</span>
      </div>
      <div class="match-card-body">
        <div class="row quad">
          <div class="field">
            <label>最少选中个数</label>
            <input data-p="min" type="text" inputmode="numeric" placeholder="不限" value="${escapeHtml(
              p.min
            )}" />
          </div>
          <div class="field">
            <label>最多选中个数</label>
            <input data-p="max" type="text" inputmode="numeric" placeholder="不限" value="${escapeHtml(
              p.max
            )}" />
          </div>
          <div class="field">
            <label>名称最少字符数</label>
            <input data-p="nameMin" type="text" inputmode="numeric" placeholder="不限" value="${escapeHtml(
              p.nameMin
            )}" />
          </div>
          <div class="field">
            <label>名称最多字符数</label>
            <input data-p="nameMax" type="text" inputmode="numeric" placeholder="不限" value="${escapeHtml(
              p.nameMax
            )}" />
          </div>
        </div>
        <div class="row pair">
          <div class="field">
            <label>名称匹配</label>
            <select data-p="range">
              ${Object.keys(RANGE_LABEL)
                .map(
                  (v) =>
                    `<option value="${v}"${p.range === v ? " selected" : ""}>${RANGE_LABEL[v]}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="field" data-params-when="ext">
            <label>扩展名</label>
            <input data-p="exts" type="text" placeholder="png, jpg" value="${escapeHtml(p.exts)}" />
          </div>
          <div class="field" data-params-when="regex">
            <label>名称正则</label>
            <input data-p="regex" type="text" placeholder="\\.(jpg|png)$" value="${escapeHtml(
              p.regex
            )}" />
          </div>
        </div>
      </div>
    </div>`;
  }

  /** 窗口模式：只暴露「窗口标题正则」，应用名与窗口类是固定值 */
  function windowCardHtml() {
    const p = state.matchDraft.window;
    return `
    <div class="match-card" data-key="window">
      <div class="match-card-head">
        <span class="match-card-title">文件夹窗口</span>
      </div>
      <div class="match-card-body">
        <div class="field">
          <label>窗口标题正则匹配</label>
          <input data-p="title" type="text" placeholder="选填，例如 ^D:\\\\" value="${escapeHtml(
            p.title
          )}" />
        </div>
      </div>
    </div>`;
  }

  function renderMatchParams() {
    // checkedMatchKeys() 已经是 MATCH_KEYS 顺序，卡片的先后跟着它走
    $("match-params").innerHTML = checkedMatchKeys()
      .map((k) => (k === "window" ? windowCardHtml() : fileCardHtml(k)))
      .join("");
    updateRangeVisibility();
  }

  function updateRangeVisibility() {
    $("match-params")
      .querySelectorAll(".match-card")
      .forEach((card) => {
        const sel = card.querySelector('[data-p="range"]');
        const v = sel ? sel.value : "";
        card.querySelectorAll("[data-params-when]").forEach((el) => {
          el.classList.toggle("hidden", el.dataset.paramsWhen !== v);
        });
      });
  }

  function onMatchParamsChange(e) {
    const card = e.target.closest(".match-card");
    if (!card || !state.matchDraft) return;
    const key = card.dataset.key;
    const el = e.target;
    const p = el.dataset.p;
    if (!p) return;

    let v = el.value;
    if (p === "min" || p === "max") {
      v = v.replace(/[^\d]/g, "");
      el.value = v;
    }
    state.matchDraft[key][p] = v;
    updateRangeVisibility();
  }

  /* ---------------- 命令参数卡：按匹配方式各一份，可「跟随」 ---------------- */

  function cmdFollowSelectHtml(key, checked) {
    const others = checked.filter((k) => k !== key);
    if (!others.length) return "";
    const cur = state.cmdParamDraft[key].follow || "";
    const opts = [`<option value="">独立设置</option>`]
      .concat(
        others.map(
          (k) =>
            `<option value="${k}"${cur === k ? " selected" : ""}>跟随「${MATCH_LABEL[k]}」</option>`
        )
      )
      .join("");
    return `<label class="follow-box"><span>参数来源</span><select data-role="follow">${opts}</select></label>`;
  }

  function cmdParamCardHtml(key, checked) {
    const p = state.cmdParamDraft[key];
    return `
    <div class="match-card" data-key="${key}">
      <div class="match-card-head">
        <span class="match-card-title">${MATCH_LABEL[key]}</span>
        ${cmdFollowSelectHtml(key, checked)}
      </div>
      <div class="match-card-body">
        <div class="field">
          <label>参数</label>
          <input data-cp="args" type="text" placeholder='例如：{qpath}（自带引号）或 "{path}"' value="${escapeHtml(
            p.args
          )}" />
        </div>
        <div class="field">
          <label>工作目录</label>
          <div class="row">
            <input data-cp="cwd" type="text" placeholder="留空即使用当前文件夹" value="${escapeHtml(
              p.cwd
            )}" />
            <button type="button" class="btn outlined sm" data-cp-pick="1" title="用资源管理器选择目录">浏览</button>
          </div>
        </div>
      </div>
      <p class="match-card-note"></p>
    </div>`;
  }

  function renderCmdParams() {
    const checked = checkedMatchKeys();
    $("cmd-params").innerHTML = checked
      .map((k) => cmdParamCardHtml(k, checked))
      .join("");
    syncCmdFollowers();
  }

  /** 跟随链的最终来源（不含自身）；"" 表示不跟随 */
  function resolveCmdFollowSource(key) {
    const seen = new Set([key]);
    let cur = key;
    for (let i = 0; i < MATCH_KEYS.length + 1; i++) {
      const next = (state.cmdParamDraft[cur] && state.cmdParamDraft[cur].follow) || "";
      if (!next || seen.has(next) || !state.cmdParamDraft[next]) return cur === key ? "" : cur;
      seen.add(next);
      cur = next;
    }
    return cur === key ? "" : cur;
  }

  /** 设置 follow 后是否会形成环 */
  function createsCmdCycle(key) {
    const seen = new Set();
    let cur = key;
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = (state.cmdParamDraft[cur] && state.cmdParamDraft[cur].follow) || "";
    }
    return false;
  }

  /**
   * 把跟随来源的命令参数同步到被跟随的卡片上，并写回 state。
   * 跟随中的卡片会整个收起（只留标题 + 参数来源 + 一行说明），少占地方。
   */
  function syncCmdFollowers() {
    const cards = {};
    $("cmd-params")
      .querySelectorAll(".match-card")
      .forEach((c) => (cards[c.dataset.key] = c));

    Object.keys(cards).forEach((key) => {
      const card = cards[key];
      const srcKey = resolveCmdFollowSource(key);
      const following = !!srcKey;
      card.classList.toggle("following", following);

      const sel = card.querySelector('[data-role="follow"]');
      if (sel) sel.value = state.cmdParamDraft[key].follow || "";

      card.querySelectorAll("[data-cp]").forEach((el) => {
        const f = el.dataset.cp;
        if (following) {
          const v = state.cmdParamDraft[srcKey][f];
          el.value = v == null ? "" : v;
          el.disabled = true;
        } else {
          el.disabled = false;
        }
      });
      const pick = card.querySelector("[data-cp-pick]");
      if (pick) pick.disabled = following;

      const note = card.querySelector(".match-card-note");
      if (note) {
        note.textContent = following
          ? `参数与「${MATCH_LABEL[srcKey]}」保持一致，请到那张卡片里修改`
          : "";
      }

      if (following) {
        PARAM_FIELDS.forEach((f) => {
          if (state.cmdParamDraft[srcKey][f] !== undefined) {
            state.cmdParamDraft[key][f] = state.cmdParamDraft[srcKey][f];
          }
        });
      }
    });
  }

  function onCmdParamsChange(e) {
    const card = e.target.closest(".match-card");
    if (!card || !state.cmdParamDraft) return;
    const key = card.dataset.key;
    const el = e.target;

    // 参数来源
    if (el.dataset.role === "follow") {
      const prev = state.cmdParamDraft[key].follow || "";
      state.cmdParamDraft[key].follow = el.value;
      if (createsCmdCycle(key)) {
        state.cmdParamDraft[key].follow = prev;
        el.value = prev;
        toast("不能互相跟随，会形成循环", true);
        return;
      }
      syncCmdFollowers();
      return;
    }

    const f = el.dataset.cp;
    if (!f) return;
    state.cmdParamDraft[key][f] = el.value;
    syncCmdFollowers();
  }

  /* ---------------- 分类标签 ---------------- */

  function renderCatSuggest() {
    const cur = ($("f-category").value || "").trim();
    const cats = allCategories().filter((c) => c !== cur);
    const box = $("cat-suggest");
    if (!cats.length) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      `<span class="suggest-label">已有：</span>` +
      cats
        .map((c) => `<button type="button" class="cat-chip sm" data-cat-fill="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
        .join("");
  }

  /* ---------------- 图标 ---------------- */

  function applyIconFieldVisibility() {
    const type = $("f-icon-type").value;
    const field = $("icon-value-field");
    const input = $("f-icon-value");
    const btn = $("btn-pick-icon");

    field.classList.toggle("hidden", !type);
    if (!type) return;

    const tips = {
      file: "支持 .png / .jpg / .jpeg / .ico / .svg",
      exe: "选择一个 exe，自动提取其图标",
      ext: "填写扩展名，例如 .txt / .pdf / .mp4",
      folder: "使用系统文件夹图标（无需填写）",
      data: "粘贴 data:image/... base64 字符串",
    };
    input.placeholder = tips[type] || "";
    btn.classList.toggle("hidden", type === "folder" || type === "data");
    input.disabled = type === "folder";
    if (type === "folder") input.value = "";
  }

  function currentIconValue() {
    return {
      type: $("f-icon-type").value || "",
      value: $("f-icon-value").value.trim(),
    };
  }

  function updateIconPreview() {
    const icon = currentIconValue();
    const img = $("icon-preview");
    const text = $("icon-preview-text");

    let url = "";
    if (icon.type && icon.type !== "folder") {
      if (icon.value) url = api.resolveIcon(icon) || "";
    } else if (icon.type === "folder") {
      url = api.resolveIcon({ type: "folder", value: "" }) || "";
    }

    if (url) {
      img.src = url;
      img.classList.add("visible");
      text.textContent = icon.type ? "自定义图标" : "自动识别图标";
      return;
    }

    if (!icon.type) {
      const draft = collectDraft();
      let auto = "";
      if (draft.type === "command" && draft.cmd) {
        auto = api.guessIconFromCommand(draft.cmd) || "";
      }
      if (auto) {
        img.src = auto;
        img.classList.add("visible");
        text.textContent = "自动识别图标";
      } else {
        img.removeAttribute("src");
        img.classList.remove("visible");
        text.textContent = "默认图标（未能自动识别，可手动指定）";
      }
      return;
    }

    img.removeAttribute("src");
    img.classList.remove("visible");
    text.textContent = icon.value ? "图标解析失败，请检查路径" : "请先选择图标文件 / 填写路径";
  }

  /* ---------------- 保存 ---------------- */

  function collectDraft() {
    const icon = currentIconValue();
    const type = getSegmented("f-type");

    const matches = {};
    MATCH_KEYS.forEach((k) => {
      matches[k] = Object.assign({}, state.matchDraft[k]);
    });

    // 命令参数：把「跟随」到的值真正写进被跟随的模式，让存下来的数据自身就是完整的
    const params = {};
    MATCH_KEYS.forEach((k) => {
      params[k] = Object.assign({}, state.cmdParamDraft[k]);
    });
    MATCH_KEYS.forEach((k) => {
      const srcKey = resolveCmdFollowSource(k);
      if (!srcKey) return;
      PARAM_FIELDS.forEach((f) => {
        if (params[srcKey][f] !== undefined) params[k][f] = params[srcKey][f];
      });
    });

    const draft = {
      name: $("f-name").value.trim(),
      category: $("f-category").value.trim(),
      type,
      // 「启用」只在列表里切换，编辑器不再放这个开关：沿用打开编辑器时的状态
      enabled: !state.draft || state.draft.enabled !== false,
      icon: icon.type ? icon : null,
      matches,
      params,
    };
    if (type === "command") {
      draft.cmd = $("f-cmd").value.trim();
    } else {
      draft.action = $("f-action").value;
    }
    return draft;
  }

  function saveEditor() {
    const draft = collectDraft();
    if (!draft.name) {
      toast("请填写命令名称", true);
      $("f-name").focus();
      return;
    }
    if (!MATCH_KEYS.some((k) => draft.matches[k].on)) {
      toast("至少选中一项匹配方式", true);
      return;
    }
    if (draft.type === "command" && !draft.cmd) {
      toast("请填写要执行的命令或程序", true);
      $("f-cmd").focus();
      return;
    }

    if (state.editingId) {
      const idx = state.commands.findIndex((c) => c.id === state.editingId);
      if (idx >= 0) {
        state.commands[idx] = Object.assign({ id: state.editingId }, draft);
        invalidateIcon(state.editingId);
      }
    } else {
      state.commands.push(Object.assign({ id: uid() }, draft));
    }

    persist();
    closeEditor();
    renderManage();
    toast(draft.enabled === false ? "已保存（当前为停用状态）" : "已保存，超级面板已更新");
  }

  /* ---------------- 起始模板（只在「新建」时出现，默认空模板） ---------------- */

  /** 当前选中的模板下标；null = 空模板 */
  function renderTplChips(isEdit) {
    const field = $("tpl-field");
    if (!field) return;
    field.classList.toggle("hidden", !!isEdit);
    if (isEdit) return;

    const item = (value, label) =>
      `<span class="chip tpl${state.activePreset === value ? " on" : ""}" data-preset="${
        value == null ? "" : value
      }">${escapeHtml(label)}</span>`;

    $("tpl-chips").innerHTML =
      item(null, "空模板") + PRESETS.map((p, i) => item(i, p.name)).join("");
  }

  /** 模板里的 matches 只写了「要勾的」，其余必须显式关掉，否则会继承空模板的默认勾选 */
  function matchesFromPreset(preset) {
    const out = {};
    MATCH_KEYS.forEach((k) => {
      out[k] = { on: false };
    });
    const src = (preset && preset.matches) || {};
    Object.keys(src).forEach((k) => {
      if (out[k]) out[k] = Object.assign({}, out[k], src[k]);
    });
    return out;
  }

  /** value 为 "" / null 时回到空模板 */
  function applyPreset(value) {
    if (value === "" || value == null) {
      state.activePreset = null;
      fillEditor(newDraft(), false);
      return;
    }
    const preset = PRESETS[Number(value)];
    if (!preset) return;

    const base = newDraft();
    const draft = Object.assign({}, base, {
      name: preset.name || base.name,
      category: preset.category != null ? preset.category : base.category,
      type: preset.type || base.type,
      cmd: preset.cmd != null ? preset.cmd : base.cmd,
      action: preset.action || base.action,
      matches: matchesFromPreset(preset),
      // 模板给的是「一套通用参数」：铺到三种匹配方式上，并清掉跟随关系
      // （否则跟随会在运行时把模板参数覆盖掉）
      params: preset.args != null ? shareParams(preset.args, "") : base.params,
    });

    state.activePreset = Number(value);
    fillEditor(draft, false);
    toast(`已套用模板「${preset.name}」`);
  }

  /* ======================================================================
   * 事件绑定
   * ==================================================================== */

  function bindEvents() {
    /* ---- 列表 ---- */
    $("btn-add").addEventListener("click", () => openEditor(null));

    /* 多选模式开关：只有开着的时候，列表里才出现勾选框 */
    $("btn-multi").addEventListener("click", () => setMulti(!state.multi));

    setSegmented("status-filter", state.status);

    $("search").addEventListener("input", () => {
      state.search = $("search").value;
      $("btn-clear-search").classList.toggle("hidden", !state.search);
      renderManage();
    });

    $("btn-clear-search").addEventListener("click", () => {
      $("search").value = "";
      state.search = "";
      $("btn-clear-search").classList.add("hidden");
      renderManage();
      $("search").focus();
    });

    $("cat-bar").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-cat]");
      if (!chip) return;
      state.filter = chip.dataset.cat;
      renderManage();
    });

    /* 启用 / 停用筛选 */
    $("status-filter").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      setSegmented("status-filter", btn.dataset.value);
      state.status = btn.dataset.value;
      renderManage();
    });

    $("manage-list").addEventListener("click", (e) => {
      // 空结果里的「清空筛选」按钮：它不在 .item 里，要先处理
      if (e.target.closest('[data-act="reset-filter"]')) {
        state.search = "";
        state.filter = CAT_ALL;
        state.status = STATUS_ALL;
        setSegmented("status-filter", STATUS_ALL);
        $("search").value = "";
        renderManage();
        return;
      }
      // 勾选列自己处理（走 change）。整块 label 都算，否则点 label 的空白处会误触发
      if (e.target.closest(".item-check")) return;
      // 拖拽手柄不参与点击
      if (e.target.closest(".drag-handle")) return;

      const btn = e.target.closest("[data-act]");
      const item = e.target.closest(".item");
      if (!item) return;
      // 单击整行不做任何事 —— 想改就去点行尾的「编辑」，
      // 免得手指一滑就把编辑弹层顶出来（多选模式下的单击由框选那边接管）
      if (!btn) return;

      const id = item.dataset.id;
      const idx = state.commands.findIndex((c) => c.id === id);
      if (idx < 0) return;

      const act = btn.dataset.act;
      if (act === "edit") openEditor(state.commands[idx]);
      else if (act === "del") removeCommand(id, btn);
      else if (act === "toggle") setEnabledFor([id], state.commands[idx].enabled === false);
    });

    /* 列表里勾选框的选中/取消（用 change 才能兼顾键盘操作） */
    $("manage-list").addEventListener("change", (e) => {
      const cb = e.target.closest('input[data-act="select"]');
      if (!cb) return;
      const item = cb.closest(".item");
      if (!item) return;
      if (cb.checked) state.selection.add(item.dataset.id);
      else state.selection.delete(item.dataset.id);
      // 只更新受影响的这一行和批量条，避免整表重绘导致滚动位置跳动
      item.classList.toggle("picked", cb.checked);
      renderBatchBar(visibleRows());
    });

    /* ---- 批量操作条 ---- */
    $("check-all").addEventListener("change", () => {
      const on = $("check-all").checked;
      visibleRows().forEach(({ c }) => {
        if (on) state.selection.add(c.id);
        else state.selection.delete(c.id);
      });
      renderManage();
    });

    /* 反选：只反转当前可见行（和「全选」的作用范围保持一致） */
    $("btn-invert").addEventListener("click", () => {
      visibleRows().forEach(({ c }) => {
        if (state.selection.has(c.id)) state.selection.delete(c.id);
        else state.selection.add(c.id);
      });
      renderManage();
    });

    $("btn-batch-on").addEventListener("click", () =>
      setEnabledFor(Array.from(state.selection), true)
    );
    $("btn-batch-off").addEventListener("click", () =>
      setEnabledFor(Array.from(state.selection), false)
    );
    $("btn-batch-del").addEventListener("click", removeSelected);

    bindDragSort();
    bindMarquee();

    /* ---- 编辑器：起始模板（只在新建时出现） ---- */
    $("tpl-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-preset]");
      if (!chip) return;
      applyPreset(chip.dataset.preset);
    });

    /* ---- 编辑器：类型 ---- */
    $("f-type").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      setSegmented("f-type", btn.dataset.value);
      applyTypeVisibility();
      updateIconPreview();
    });

    /* ---- 编辑器：匹配方式勾选 ---- */
    $("match-picker").addEventListener("change", (e) => {
      const el = e.target.closest("input[data-match]");
      if (!el) return;
      const key = el.dataset.match;
      state.matchDraft[key].on = el.checked;
      // 取消勾选时，把跟随它的命令参数一并清掉，避免指向已经不存在的卡片
      MATCH_KEYS.forEach((k) => {
        if (state.cmdParamDraft[k].follow === key) state.cmdParamDraft[k].follow = "";
      });
      renderMatchPicker();
      renderMatchParams();
      renderCmdParams();
    });

    /* ---- 编辑器：匹配条件卡 ---- */
    $("match-params").addEventListener("input", onMatchParamsChange);
    $("match-params").addEventListener("change", onMatchParamsChange);

    /* ---- 编辑器：命令参数卡 ---- */
    $("cmd-params").addEventListener("input", onCmdParamsChange);
    $("cmd-params").addEventListener("change", onCmdParamsChange);
    $("cmd-params").addEventListener("click", (e) => {
      const pick = e.target.closest("[data-cp-pick]");
      if (!pick) return;
      const card = pick.closest(".match-card");
      if (!card) return;
      const picked = api.pickFolder();
      if (!picked) return;
      const input = card.querySelector('[data-cp="cwd"]');
      if (!input) return;
      input.value = picked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    /* ---- 编辑器：分类标签 ---- */
    $("f-category").addEventListener("input", renderCatSuggest);
    $("cat-suggest").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-cat-fill]");
      if (!chip) return;
      $("f-category").value = chip.dataset.catFill;
      renderCatSuggest();
    });

    /* ---- 编辑器：图标 ---- */
    $("f-icon-type").addEventListener("change", () => {
      $("f-icon-value").value = "";
      applyIconFieldVisibility();
      updateIconPreview();
    });

    $("f-icon-value").addEventListener("input", updateIconPreview);
    $("f-cmd").addEventListener("input", updateIconPreview);

    /* 变量 / 分隔符示例：点一下把写法复制到剪贴板
       （不再往输入框里插 —— 插哪儿经常不是用户想要的地方） */
    copyOnClick("var-chips");
    copyOnClick("var-sep");

    $("btn-pick-icon").addEventListener("click", () => {
      const type = $("f-icon-type").value;
      let picked = "";
      if (type === "exe") picked = api.pickExecutable();
      else if (type === "file") picked = api.pickImage();
      if (picked) {
        $("f-icon-value").value = picked;
        updateIconPreview();
      }
    });

    // 命令 / 程序：用资源管理器选
    $("btn-pick-cmd").addEventListener("click", () => {
      const picked = api.pickProgram ? api.pickProgram() : api.pickExecutable();
      if (!picked) return;
      $("f-cmd").value = picked;
      updateIconPreview();
    });

    $("btn-save").addEventListener("click", saveEditor);
    $("btn-cancel").addEventListener("click", closeEditor);
    $("btn-close-editor").addEventListener("click", closeEditor);

    $("btn-test").addEventListener("click", () => {
      const draft = collectDraft();
      if (draft.type === "command" && !draft.cmd) {
        toast("先填写要执行的命令", true);
        $("f-cmd").focus();
        return;
      }
      let res;
      try {
        res = api.testRun(draft);
      } catch (err) {
        res = { ok: false, message: String(err && err.message) };
      }
      if (res && res.ok) toast(res.message || "已执行");
      else if (res && res.message === "已取消") toast("已取消试运行");
      else toast((res && res.message) || "试运行失败", true);
    });

    /* ---- 参数测试 ---- */
    $("btn-preview-cmd").addEventListener("click", toggleCmdPreview);
    $("btn-preview-close").addEventListener("click", hideCmdPreview);

    /* 「加目录 / 加文件」是**追加**，不是替换 —— 多选时列表变量才有意义 */
    $("btn-add-dir").addEventListener("click", () => {
      let picked = [];
      try {
        picked = api.pickFolders ? api.pickFolders() : [api.pickFolder()];
      } catch (err) {
        picked = [];
      }
      addTestPaths(Array.isArray(picked) ? picked : [picked]);
    });

    $("btn-add-file").addEventListener("click", () => {
      let picked = [];
      try {
        picked = api.pickFiles ? api.pickFiles() : [];
      } catch (err) {
        picked = [];
      }
      addTestPaths(Array.isArray(picked) ? picked : [picked]);
    });

    $("btn-clear-test").addEventListener("click", () => {
      setTestPathList([]);
      runCmdPreview();
    });

    /* 面板开着的时候，编辑表单里任何改动都实时重算 —— 边改边看变量怎么被替换 */
    $("view-editor").addEventListener("input", refreshCmdPreview);
    $("view-editor").addEventListener("change", refreshCmdPreview);

    /* 点某一行 = 复制那条完整命令（比"自己圈选再 Ctrl+C"顺手） */
    $("cmd-preview-list").addEventListener("click", (e) => {
      const row = e.target.closest(".cp-row");
      if (!row || !row.dataset.copy) return;
      try {
        api.copyText(row.dataset.copy);
        toast("已复制完整命令");
      } catch (err) {
        toast("复制失败", true);
      }
    });

    /* ---- 键盘 ---- */
    // 编辑是整页视图，没有「点蒙层关闭」了，所以 Esc 是唯一的快捷退出口
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("view-editor").classList.contains("hidden")) return;
      e.preventDefault();
      closeEditor();
    });
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
