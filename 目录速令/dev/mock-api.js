/* 仅供离线预览使用：模拟 uTools 的 preload API
 * 注意：这里的图标只是 mock 的示意，真实插件里图标来自 exe / 图片文件本身。
 * 全部画成「无底色、纯线条」，跟真实的观感一致。 */

(function () {
  "use strict";

  /** 无背景的线性图标 */
  const stroke = (inner, color) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" ` +
        `stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
        `${inner}</svg>`
    );

  const TERM = '<path d="M7 11l5 5-5 5"/><path d="M16 21h9"/>';
  const CODE = '<path d="M12 9l-7 7 7 7"/><path d="M20 9l7 7-7 7"/>';
  const FOLDER = '<path d="M4 11a2 2 0 012-2h5.5l2 2H26a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2z"/>';

  const ICONS = {
    code: stroke(CODE, "#61afef"),
    cmd: stroke(TERM, "#8b95a5"),
    powershell: stroke(TERM, "#56b6c2"),
    wt: stroke(TERM, "#c678dd"),
    explorer: stroke(FOLDER, "#d1a24a"),
    gitbash: stroke(TERM, "#e06c75"),
    everything: stroke('<circle cx="14" cy="14" r="7"/><path d="M19.5 19.5L26 26"/>', "#e5c07b"),
    folder: stroke(FOLDER, "#d1a24a"),
    fallback: stroke('<path d="M12 10l6 6-6 6"/>', "#61afef"),
  };

  const MOCK_PATH = "D:\\Code-Project\\uTools\\目录自定义运行命令";

  let store = [];

  window.folderCmd = {
    env: () => ({
      platform: "win32",
      isWindows: true,
      isMacOS: false,
      isLinux: false,
      dark: document.documentElement.getAttribute("data-theme") !== "light",
      version: "9.9.9 (预览)",
      appName: "uTools",
      deviceId: "preview",
      home: "C:\\Users\\Majo",
    }),

    onDarkModeChange() {
      return false;
    },

    loadCommands: () => store,
    saveCommands(list) {
      store = Array.isArray(list) ? list : [];
      return store;
    },

    registerFeatures: () => store.filter((c) => c.enabled !== false).length,
    clearFeatures: () => 0,
    featureCount: () => store.filter((c) => c.enabled !== false).length,

    onEnter(cb) {
      setTimeout(() => cb({ code: "manage", type: "none", payload: null, from: "main" }), 0);
    },
    onOut() {},

    pickFolder: () => "D:\\Downloads\\示例文件夹",
    pickImage: () => "C:\\Icons\\my-icon.png",
    pickExecutable: () => "C:\\Program Files\\SomeApp\\app.exe",
    pickProgram: () => "C:\\Program Files\\Git\\git-bash.exe",

    resolveIcon(icon) {
      if (!icon || !icon.type) return "";
      if (icon.type === "folder") return ICONS.folder;
      const v = (icon.value || "").toLowerCase();
      if (v.includes("code")) return ICONS.code;
      if (v.includes("cmd")) return ICONS.cmd;
      if (v.includes("powershell")) return ICONS.powershell;
      if (v.includes("explorer")) return ICONS.explorer;
      if (v.includes("git-bash")) return ICONS.gitbash;
      if (v.includes("everything")) return ICONS.everything;
      if (icon.type === "exe" || icon.type === "file") return ICONS.fallback;
      return "";
    },

    guessIconFromCommand(cmd) {
      const c = String(cmd || "").toLowerCase();
      if (c.startsWith("code")) return ICONS.code;
      if (c.startsWith("cmd")) return ICONS.cmd;
      if (c.startsWith("powershell") || c.startsWith("pwsh")) return ICONS.powershell;
      if (c.startsWith("wt")) return ICONS.wt;
      if (c.startsWith("explorer")) return ICONS.explorer;
      if (c.includes("git-bash")) return ICONS.gitbash;
      if (c.includes("everything")) return ICONS.everything;
      return "";
    },

    commandIcon(command) {
      if (!command) return "";
      let url = "";
      if (command.icon && command.icon.type) url = window.folderCmd.resolveIcon(command.icon) || "";
      if (!url && command.type !== "builtin" && command.cmd) {
        url = window.folderCmd.guessIconFromCommand(command.cmd) || "";
      }
      if (!url && command.type === "builtin") url = ICONS.folder;
      return url;
    },

    /* --- 参数测试 ---
     * 预览页拿不到 preload 的 buildContext/substitute，这里做一份够用的替换：
     * 支持多条测试路径 + {var:分隔符} 修饰，够把面板的样子演出来就行。 */
    currentFolder() {
      return MOCK_PATH;
    },
    copyText() {
      return true;
    },
    pickFolders() {
      return ["D:\\Downloads\\示例文件夹", "D:\\Code-Project\\uTools\\目录自定义运行命令"];
    },
    pickFiles() {
      return ["D:\\Downloads\\报告.docx", "D:\\Downloads\\截图.png"];
    },
    previewCommand(command, rawPaths) {
      const paths = (Array.isArray(rawPaths) ? rawPaths : String(rawPaths || "").split(/[\r\n;]+/))
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      if (!paths.length) return { ok: false, message: "先加一个测试路径" };
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
      const LABEL = { file: "文件", folder: "文件夹", window: "文件夹窗口" };
      const unesc = (s) =>
        String(s || "")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\\\/g, "\\");
      const base = (p) => p.split(/[\\/]/).pop() || "";
      // {key:分隔符} → 按分隔符拼；不带冒号按空格拼
      const listVal = (key, sep) => {
        const s = unesc(sep === undefined ? " " : sep);
        if (key === "names") return paths.map(base).join(s);
        if (key === "qpaths") return paths.map((p) => `"${p}"`).join(s);
        return paths.join(s);
      };
      const sub = (t) =>
        String(t || "")
          .replace(/\{(paths|qpaths|names)(?::([^}]*))?\}/g, (m, key, sep) => listVal(key, sep))
          .replace(/\{qpath\}/g, `"${paths[0]}"`)
          .replace(/\{path\}/g, paths[0])
          .replace(/\{name\}/g, base(paths[0]))
          .replace(/\{parent\}/g, paths[0].replace(/[\\/][^\\/]*$/, ""))
          .replace(/\{drive\}/g, (paths[0].match(/^[A-Za-z]:/) || [""])[0])
          .trim();
      const rows = ["file", "folder", "window"]
        .filter((k) => command.matches && command.matches[k] && command.matches[k].on)
        .map((k) => {
          const p = (command.params && command.params[k]) || {};
          return {
            mode: k,
            label: LABEL[k],
            line: [sub(command.cmd), sub(p.args)].filter(Boolean).join(" "),
            cwd: sub(p.cwd),
          };
        });
      return { ok: true, paths, rows };
    },

    testRun(command) {
      return { ok: true, message: `（预览模式）试运行：${command.name || command.cmd} → ${MOCK_PATH}` };
    },
  };

  window.folderCmdRaw = { process: { env: {} } };
})();
