# 目录速令 · 开发文档

面向要改这个插件的人。面向使用者的功能说明在 [`README.md`](./README.md)。

- 开发文档（本文）：架构 · 实现原理 · 开发约定 · 开发工具 · 校验 · 打包
- 使用文档：[`README.md`](./README.md)

---

## 一、架构概览

```
plugin.json          只有一个静态功能 manage（呼出词「目录速令」）
   │
preload.js           引擎：动态指令注册 / 取路径 / 占位符 / 图标 / 执行
   │  ▲
   │  └── utools.setFeature()  ← 每条命令 × 每种匹配方式 = 一条动态指令
   │
index.html + assets/ 唯一的界面：命令管理
   └── assets/app.js  渲染 + 交互（通过 window.folderCmd 调 preload）
       assets/style.css  MD3 × One Dark 主题
```

**只有一处会开窗口**：`manage` 功能（命令管理界面）。
其余全部是运行时注册的动态指令，`mainHide: true` + `hideMainWindow()` 保证无窗口执行。

### 关键设计：一条命令 → N 条指令

每条自定义命令的**每一种匹配方式**注册成一条**独立的 uTools 功能**，
code 形如 `dyn:<命令id>:<file|folder|window>`。这样它在超级面板里是单独一项，
而不是挤在同一个插件入口后面再选一次。

```
命令「VS Code 打开」勾了「文件 + 文件夹」
        ↓
utools.setFeature({ code: "dyn:c1a2b3:file",   ..., cmds: [{ type:"files", fileType:"file", …      }] })
utools.setFeature({ code: "dyn:c1a2b3:folder", ..., cmds: [{ type:"files", fileType:"directory", … }] })
        ↓
超级面板里出现两条独立入口（各自带自己的图标与说明）
```

`code` 里的模式段在运行时**真的会被用到**：`execute(command, paths, mode)` →
`resolveCommandParams(command, mode)`，于是「选中文件夹时」和「选中文件时」
可以传完全不同的参数。

---

## 二、目录结构

```
目录自定义运行命令/
├── plugin.json          # 只有一个静态功能：manage（呼出词「目录速令」）
├── preload.js           # 引擎：动态指令注册 + 取路径 + 图标解析 + 无窗口执行
├── index.html           # 界面：两个全屏视图 #view-manage（列表）/ #view-editor（编辑）
├── logo.png             # 插件图标（透明背景、单色线性）
├── assets/
│   ├── style.css        # MD3 × One Dark 主题令牌与组件样式
│   └── app.js           # 管理界面逻辑
├── dev/                 # 【仅开发用】离线预览，打包前可删
│   ├── mock-api.js      #   模拟 preload 的 API
│   ├── preview.html     #   build-preview.js 生成（不要手改）
│   └── drive.html       #   截图驱动页（同源 iframe 注入交互）
├── tools/               # 【仅开发用】辅助脚本，打包前可删
│   ├── build-preview.js #   index.html → dev/preview.html
│   ├── check-dom.js     #   静态一致性校验
│   ├── check-cmds.js    #   指令生成逻辑断言（150 项）
│   └── make_logo.py     #   重新生成 logo.png
├── docs/                # 【仅开发用】界面截图，打包前可删
├── README.md            # 用户文档
└── DEVELOP.md           # 本文档
```

`plugin.json` 里唯一的静态功能：

| code | 呼出词 | 说明 |
| --- | --- | --- |
| `manage` | `目录速令` | 打开命令管理界面（会显示窗口） |

---

## 三、数据模型

一条命令（`utools.dbStorage` 里的一个元素）：

```js
{
  id: "c1a2b3",          // uid() 生成
  name: "VS Code 打开",
  category: "开发",       // 分类标签，可为空
  type: "command",       // "command" | "builtin"
  cmd: "code",           // type === "command" 时才有（三种模式共用同一个程序）
  action: "copy-path",   // type === "builtin" 时才有
  icon: { type: "exe", value: "C:/…/Code.exe" },   // type 为空串 = 自动识别
  enabled: true,         // false = 停用，不注册

  // 匹配条件：键序 = MATCH_KEYS
  matches: {
    file:   { on: false, min: "1", max: "", nameMin: "", nameMax: "", range: "none", exts: "", regex: "" },
    folder: { on: true,  min: "1", max: "", nameMin: "", nameMax: "", range: "none", exts: "", regex: "" },
    window: { on: false, title: "" }
  },

  // 命令参数：键序 = MATCH_KEYS，按匹配方式各一份
  params: {
    file:   { args: '"{qpath}"', cwd: "", follow: "folder" },
    folder: { args: '"{qpath}"', cwd: "", follow: "" },
    window: { args: '"{qpath}"', cwd: "", follow: "" }
  }
}
```

要点：

- `cmd`（程序）是三种模式**共用**的；`args` / `cwd` 是**按模式各一份**的。
- **不要再把 `args` / `cwd` 放回顶层** —— 迁移会把它们铺到三种模式上然后删掉。
- `matches` / `params` **键序必须是 `MATCH_KEYS` 顺序**（有断言在盯）。
- `follow` 只存「跟随哪个模式」，不存值本身；保存时会把值**写实**（见第六节）。

### 默认值的两套语义（易混淆）

| 常量 | 位置 | `on` 默认 | 用途 |
| --- | --- | --- | --- |
| `DEFAULT_FOLDER / DEFAULT_FILE / DEFAULT_WINDOW` | `preload.js` | **一律 `false`** | 只是**参数骨架**，用来补全缺失字段；`on: false` 表示「没勾选」 |
| `DEFAULT_FOLDER` | `assets/app.js` | `true` | 编辑器**新建命令**时的默认勾选（默认勾「文件夹」） |

一个都没勾时，`featureCmds()` 仍会兜底产出 1 条文件夹指令，保证入口不会消失
（正常情况下进不来，因为编辑器会拦，但迁移出来的老数据可能有）。

### 数据迁移

`migrateCommand()` 在 `loadCommands()` 里跑，首次加载时自动迁移并**立即落盘**
（幂等，重复加载不会重复改动）。历史上两次结构调整：

| 旧结构 | 新结构 |
| --- | --- |
| `trigger: "folder" \| "window" \| "both"`（单值） | `matches` 三态多选；`both` → 文件夹 + 文件夹窗口都勾上 |
| 顶层的 `args` / `cwd`（一份） | `params` 按匹配方式各一份；顶层那份**铺到三种模式**上 |

迁移后删掉 `trigger` / `runMode` / 顶层 `args` / 顶层 `cwd`，**不再有两个真相来源**。
已有 `params` 的命令不会被覆盖。构造 `matches` 时用 `MATCH_KEYS.forEach` 循环落键，
保证迁移结果和新建命令是**同一种「规范形」**（`JSON.stringify` 类断言会盯键序）。

---

## 四、动态指令生成（对照 uTools `cmds` schema）

### files 类型（文件 / 文件夹）

```js
{
  type: "files",
  label: "VS Code 打开",
  fileType: "file" | "directory",
  minLength, maxLength,        // ⚠️ 选中「个数」，不是名称长度
  extensions: ["png","jpg"],   // ⚠️ 与 match 二选一
  match: "/…/i"                // ⚠️ 与 extensions 二选一
}
```

| 坑 | 说明 |
| --- | --- |
| `minLength` / `maxLength` | 是**选中个数**（`MatchFile[]` 的长度），不是名称长度 |
| `extensions` ↔ `match` | **互斥**，只能输出一个 |
| 名称长度（字符数） | uTools **没有**这个字段，只能并进 `match` 正则 |
| 正则格式 | 必须是 `/.../flags` 字符串；`normalizeRegex()` 自动补 `/i` |

**名称长度怎么实现**：`applyNameLength()` 在前面插一个**零宽断言**，
`lengthLookahead()` 负责把上下限变成一个合法量词：

```
名称 3~24 字符 + 扩展名 png/jpg
   →  /^(?=[\s\S]{3,24}$)\.(?:png|jpg)$/i
```

⚠️ 量词 **`{3,}` 合法、`{,24}` 不合法**（后者会变成字面量而不是量词）。
所以只有上限时，下限必须显式补 `0` 写成 `{0,24}`。

因为名称长度只能走 `match`，一旦启用了它，就**必须放弃原生的 `extensions`**，
把扩展名也一起塞进正则里（`(?:png|jpg)$`）。没设长度时不生成正则，仍走 `extensions`。

### window 类型（文件夹窗口）

```js
{
  type: "window",
  label: "VS Code 打开",
  match: {
    app: ["explorer.exe"],                                        // ⚠️ 必填
    class: ["CabinetWClass","ExploreWClass","WorkerW","Progman"], // 固定值
    title: "/^D:\\\\/i"                                           // 用户唯一可配的一项
  }
}
```

- `match.app` 是 uTools 的**必填字段**，用固定常量 `DEFAULT_WINDOW_TARGET` 兜底。
- `class` 把 `explorer.exe` 限定成「文件夹窗口 / 桌面」语义 ——
  否则它的其它窗口（比如复制进度框）也会命中。
- `app` 与 `class` **都不暴露给用户**，编辑器里窗口卡只有「窗口标题正则匹配」一个字段。

---

## 五、实现要点对照表

| 需求 | 实现 |
| --- | --- |
| 每个命令独立出现在超级面板 | `utools.setFeature({ code: "dyn:<id>:<mode>", explain, icon, mainHide: true, cmds: [...] })` |
| 不弹窗口 | 动态指令 `mainHide: true` + 代码里再 `utools.hideMainWindow()` 双保险 |
| 匹配文件夹 / 文件 | `cmds: [{ type: "files", fileType: "directory" \| "file", label, minLength, maxLength, extensions \| match }]` |
| 匹配文件夹窗口 / 桌面 | `cmds: [{ type: "window", match: { app, class, title } }]`（`app` 必填，只暴露 `title`） |
| 一条命令对应多种匹配方式 | `featureCmds()` 遍历 `MATCH_KEYS` 产出 0~3 条指令，逐条 `setFeature` |
| **匹配方式的顺序只有一处定义** | `MATCH_KEYS = ["file","folder","window"]`，见第六节硬性约定 14 |
| 命令参数按场景分开 | `command.params = { file, folder, window }`，各含 `{args, cwd, follow}`；`resolveCommandParams()` 按 `dyn:<id>:<模式>` 里解析出的模式取用 |
| **编辑是整页视图，不是弹窗** | `#view-manage` / `#view-editor` 两个 `.view` 兄弟节点，`showEditorView(on)` 只切 `.hidden`。没有蒙层、没有 `max-width` 卡片、没有「点外部关闭」；退出口是左上「← 返回」/ `取消` / **Esc** |
| **参数测试**（不执行） | preload `buildPreview(command, rawPaths)`：`normalizePreviewPaths()` 先把输入整理成数组（数组 / 换行 / 分号串都吃、去重、剥成对引号、封顶 20 条），再 `buildContext(paths)` + `substitute()` 把 `cmd` / `args` / `cwd` 全替换一遍，按 `MATCH_KEYS` 给**每种被勾选的模式**各出一行 `{mode,label,line,cwd}`；页面渲染成 `.cmd-preview` 面板贴在底栏上方，点一行即复制。测试路径入口是 `#f-test-paths` 多行框（每行一个），「加目录」`api.pickFolders()` /「加文件」`api.pickFiles()` 都是**可多选**的系统对话框，追加进去 |
| 参数「跟随」 | 编辑器侧 `syncCmdFollowers()` 实时同步 + `collectDraft()` 保存时把值写实；运行时 `resolveCommandParams()` 兜底解析（含环检测与自引用保护） |
| 取路径 | `files` 用 `onPluginEnter` 的 `payload`（`MatchFile[]`）；`window` 用 `utools.readCurrentFolderPath()`（**异步**，见第十节坑 19） |
| 名称长度限制 | `applyNameLength()` 零宽断言并进 `match`；`lengthLookahead()` 负责量词合法性（见第四节） |
| 列表变量自定分隔符 | `PLACEHOLDER_RE` 捕获冒号后的可选分隔符；`unescapeSep()` 还原 `\n \t \r \\`；`joinList()` 负责拼接与加引号 |
| 执行命令 | `spawn(cmdline, { shell: true, detached: true, stdio: "ignore", windowsHide })` + `unref()` |
| 控制台程序自动显示窗口 | `needsConsole()` 取命令行里真正的程序名（`programToken()`，能处理带空格的路径与引号），命中 `cmd`/`powershell`/`wt`/`wsl`/`git-bash` 等则 `windowsHide: false` |
| 从 exe 取图标 | `utools.getFileIcon(exePath)` → base64 Data URL |
| 数据持久化 | `utools.dbStorage` |
| 命令增删改后刷新超级面板 | `saveCommands()` 内部自动调 `registerFeatures()`（先 `getFeatures()` 清理 `dyn:` 前缀的，再逐条 `setFeature`） |
| 临时停用某条命令 | `registerFeatures()` 跳过 `enabled === false`；`handleDynamicEnter()` 里再挡一道，防止指令残留时被误触发 |
| 单条启用 / 停用 | 每行的 `data-act="toggle"` 文本按钮（`启用` / `停用`）→ `setEnabledFor([id], …)` |
| 多选模式 | `state.multi`；关掉时 `renderManage()` 不渲染 `.item-check` **列**（不是 CSS 隐藏），`renderBatchBar()` 也不显示批量条。`setMulti()` 在关闭时 `state.selection.clear()` |
| 单击整行无响应 | `#manage-list` 的 click 委托里 `if (!btn) return;` —— 只有行内 `data-act` 按钮有行为。想改命令必须点 `编辑` |
| 列表副标题省路径 | `commandSummary()` 里对程序名过一遍 `baseName()`（同时吃 `\` 和 `/`、顺手去引号），完整命令挂到 `.item-sub` 的 `title`（`commandSummaryFull()`）。**不改数据，只影响显示** |
| 多选时隐藏拖拽手柄 | `renderManage()` 里 `state.multi ? "" : <drag-handle>`；`dragstart` 里再 `if (state.multi) return;` 兜一层。勾选框列（18px）正好顶上手柄（14px）的位置，切换时列表不怎么跳 |
| 框选（多选模式） | `bindMarquee()`：列表 `mousedown` → 在 `document.body` 上挂一个 `position:fixed` 的 `.marquee`，`mousemove` 里用 **clientX/clientY** 算矩形、和每行 `getBoundingClientRect()` 求交 → 命中的行加 `.mb-hit`；`mouseup` 把命中的 id **加选**进 `state.selection`。位移 < 4px 不算框、当成单击 → 切换该行勾选 |
| 批量启用 / 停用 / 删除 | 行首 `data-act="select"` 勾选 → `setEnabledFor([...state.selection], …)` / `removeSelected()`。全都要走同一个 `persist()`，注册状态才一致 |
| 反选 | `visibleRows()` 逐行 toggle `state.selection`（作用范围与「全选」一致：只针对可见行） |
| 勾选态与筛选互不干扰 | `state.selection` 是 `Set<id>`，**跨搜索 / 分类 / 状态切换保留**；`renderBatchBar()` 只拿它跟「当前可见行」做交集来渲染全选框的选中 / 半选态；`pruneSelection()` 在命令被删后清掉悬空 id |
| 启用状态筛选 | `state.status ∈ {all,on,off}`，在 `visibleRows()` 里**最后**叠加（分类之后），所以不影响分类芯片的计数 |
| 拖拽排序 | `.drag-handle[draggable]` + 列表上的 `dragstart/dragover/dragleave/drop`；落点按目标行中线判断前半/后半；`reorderCommand(from, insertAt)` 负责「先摘后插」的索引换算 |
| 注册数自检（原来在底栏） | 底栏已删。改为 `persist()` 里比对 `api.featureCount()` 与启用条数，不一致时 `setTimeout(0)` 抛一条错误 toast（延迟是为了盖掉调用方紧接着的成功提示） |
| 「启用」不在编辑器里 | 编辑器没有这个开关，`collectDraft()` 从 `state.draft.enabled` 沿用打开时的状态；切换统一走列表 |

---

## 六、开发约定（硬性）

1. `utools.onPluginEnter` / `onPluginOut` **只能注册一次**，然后通过自定义 DOM 事件
   （`folder-command:enter` / `folder-command:out`）转给页面。注册两次会重复执行。
2. `dyn:` 开头的进入动作由 preload **静默处理**，不派发给页面。
3. `uiActive` 为 true（管理窗口开着）时，动态指令执行完**不要**调 `utools.outPlugin()`，
   否则会把用户正在用的管理窗口一起关掉。
4. 匹配方式是**三种模式多选**，不存在 `trigger` 字段。旧数据的 `trigger` 由
   `migrateCommand()` 迁移（`both` → folder + window），**不要再往回加 `trigger`**。
5. 运行方式**已整体删除**（没有 `runMode`，也没有管理员提权）。默认静默，
   由 `needsConsole()` + `programToken()` 自动识别控制台程序并放行其窗口。
   路径含空格要用 `{qpath}` 或 `"{path}"`。
6. 图标只存来源（type + path），**不存 base64**；`data:image/svg+xml` 不传给 `setFeature`。
7. 命令可以 `enabled: false`：不注册、不在超级面板出现，配置保留。
   **不要再引入实际不生效的开关** —— 原来的 `keepOpen` 就是这样被删掉的。
   - 编辑器里**不放**「启用」开关，切换统一走列表。
   - 列表中它是「编辑」和「删除」**中间那颗文本按钮**（不是图标），
     文案随状态在 `停用` / `启用` 之间切；停用时按钮高亮成主色。
   - **不要再加「已停用」徽章** —— 整行变灰 + 高亮的「启用」按钮已经足够表达。
8. preload 的 `api` 对象只暴露页面真正用到的方法；改完跑 `node tools/check-dom.js` 验证。
   `featureCount()` 现在只被 `persist()` 的自检用到（底栏已删）。
9. 生成指令的硬规则（踩过坑）：
   - `extensions` 与 `match` **二选一**；
   - `minLength` / `maxLength` 是**选中个数**；
   - `window` 的 `match.app` **必填**；
   - 正则字段写成 `/.../flags` 字符串；
   - **`{3,}` 合法、`{,24}` 不合法**，没有下限必须补 `0`；
   - 没设名称长度时不要生成正则，仍走 `extensions`。
10. 参数「跟随」只作用于**命令参数**（`params`，字段仅 `args` / `cwd`），
    **不是匹配条件**。`syncCmdFollowers()` 实时同步 + `collectDraft()` 保存时把值写实；
    `createsCmdCycle()` 拦环形跟随；preload 侧 `resolveCommandParams()` 只做兜底。
    跟随中的卡片会**收起 `.match-card-body`**（`.match-card.following`），
    卡上只剩「参数来源」这一个控件，所以它要保留强调色、**不要**压暗它。
    两套概念的命名前缀要分开：匹配条件用 `data-p`，命令参数用 `data-cp`。
11. **迁移要产出「规范形」**：`migrateCommand()` 里 `params` 的完整性判断是
    「三种模式都在」，不满足就用 `normalizeParams()` 补齐（保留已有值）。
    否则下游到处都要写兜底，且部分缺失会静默丢数据。
12. 列表变量支持 `{var:分隔符}` 修饰：`{paths:,}` / `{qpaths:, }` / `{names:\n}`。
    `unescapeSep()` 还原 `\n \t \r \\`（其它 `\x` → `x`），`joinList()` 负责拼接与加引号；
    不带冒号按**空格**拼（向后兼容）。分隔符里不能有 `}`。
    `{qpaths:, }`（逗号 + 空格 + 每项引号）是传给 CLI 最常用的形式。
13. **`dev/preview.html` 是生成物**：改了 `index.html`（尤其增删 id）必须重新生成，
    否则 `$("新id")` 返回 null 并在 `renderManage()` **之前**抛错，
    表现为**列表整块空白**（页头 / 搜索栏还在），很像「数据没加载」。
    截图的 `--user-data-dir` 也**不要复用**，否则 Chrome 用缓存的旧 preview.html。
14. **顺序只有一个来源：`MATCH_KEYS`**。改匹配方式顺序 = 只改这一个常量，其余全部派生：
    `featureCmds()` 用 `MATCH_KEYS.forEach` 产指令；`migrateCommand()` 用循环写
    `next.matches[k]`；`renderMatchParams()` / `renderCmdParams()` 映射
    `checkedMatchKeys()`（它本身按 `MATCH_KEYS`）；`shareParams()` 按 `MATCH_KEYS` 出键。
    渲染函数里**一个模式名都不许硬编码顺序**（踩过坑，见第九节坑 4）。
15. **模板的 `matches` 要显式关掉没勾的**：模板只写「要勾的那几个」，
    所以 `matchesFromPreset()` 先把三种模式全置 `on: false` 再套模板的。
    否则会继承 `newDraft()` 默认勾上的「文件夹」，出现「点了 CMD 模板却也匹配文件夹」。
16. **「启用」是列表的职责**：编辑器不提供。`collectDraft()` 用
    `state.draft.enabled` 沿用打开编辑器时的值；新建时 `newDraft()` 是 `true`。
17. **`newDraft()` 三种匹配方式一律 `on: false`**（新建时一项都不勾），
    勾选框旁边跟一行「至少选中一项」的红字提醒。`saveEditor()` 会拦住零匹配方式。
    注意这跟 `preload.js` 的兜底不冲突：`featureCmds()` 仍会在「一条都没勾」时
    产出 1 条文件夹指令，那是给迁移出来的老数据兜底的，不是编辑器的默认值。
18. **多选模式是显式开关**（`state.multi`）：默认关，关的时候列表**根本不渲染**
    `.item-check` 列，批量条也隐藏。不要改回「常驻勾选框」——
    用户明确要求勾选框只在多选模式下出现。
    `setMulti(false)` 会清空 `state.selection`，避免留下看不见的「已选」。
    新增批量操作时记得同步 `renderBatchBar()` 里的 `disabled` 判断。
19. **排序只能靠拖拽**：`↑ ↓` 按钮已删除，别加回来。
    `.drag-handle` 是**整行唯一**的拖拽起点（只有它带 `draggable`），
    列表上用事件委托接 `dragstart / dragover / dragleave / drop`。
    落点用**目标行的中线**判断插前还是插后；`reorderCommand()` 负责
    「先摘后插」的索引换算（从前往后拖时目标索引要 −1）。
    `drop` 里**先 `endDrag()` 再重排** —— 重排会整块重绘，旧节点脱离文档后
    `dragend` 不会再冒泡上来。
20. **主页没有底栏了**。原来那条「选中文件夹 / 文件 → 超级面板 →…」+
    「已注册 N 条超级面板指令」的 `.hint` 已删（`.hint` / `.status` 两个类也没了）。
    注册数自检挪进了 `persist()`，只在**对不上**的时候弹一次错误 toast。
21. **单击整行不做任何事**（`if (!btn) return;`）。用户明确要求过 ——
    「手滑切到编辑页」比「少一次点击」更烦。别为了手感把 `openEditor` 加回行点击上。
22. **多选模式下不允许拖拽排序**：`.drag-handle` 在 `state.multi` 时**不渲染**，
    同一个「按住 + 移动」的手势让给**框选**（`bindMarquee()`）。
    ⚠️ 框选的两个关键点：
    ① `.marquee` 用 `position: fixed` + **clientX/clientY**（不要用列表内绝对定位，
       那样得自己加 `scrollLeft/scrollTop`，很容易差一截）；
    ② 必须 `pointer-events: none`，否则框一画出来就盖住行、`mousemove` 直接断掉。
    另外 `mousedown` 里要 `e.preventDefault()`，否则拉框时会把文字拖蓝。
    `mouseup` 的监听挂在 `document` 上（鼠标可能在列表外松开）。
23. **列表副标题不显示程序的完整路径**（`baseName()` 只留最后一段）。
    这是**纯显示层**的事：`command.cmd` 存的仍然是完整路径，`preload.js`
    拿到的也是完整的。改这里别顺手去动数据。
24. **`.row.split`（名称 + 分类标签）必须 `align-items: start`**。
    父类 `.row` 有 `align-items: center`，而 `.row.split` 只是改了 `display: grid`，
    继承下来的居中会把两格错开半个身位 —— 触发条件就是「分类标签」底下那排
    「已有：xx」建议 chips 撑高了它自己。`.cat-suggest:empty { display: none }`
    是第二道保险（空建议本来就不该占 8px）。
25. **编辑是整页视图，不是弹窗**（`.overlay` / `.editor` / `.editor-head` 三个类
    连同 `--scrim` / `--shadow-dialog` 两个令牌**一起删干净了**）。
    只有 `#view-manage` / `#view-editor` 两个 `.view`，切换只走 `showEditorView()`。
    **不要再引入蒙层 / 点对角关闭 / `role="dialog"`** —— 用户明确要求过。
    每次进编辑页都要 `editor-body.scrollTop = 0`（否则停在上一次滚到的位置）。
    改 `index.html` 的视图结构后记得 `node tools/build-preview.js`
    （预览页会把 `body > .view` 搬进外框）。
26. **删除入口只在列表里**。编辑页底栏的 `#btn-delete` 已删，
    底栏现在是 `试运行 / 参数测试 / 取消 / 保存`；编辑**已有**命令时 `#foot-hint`
    给一句「要删除这条命令，请回列表点它右边的「删除」」兜住可发现性。
27. **参数测试只算不跑**（`buildPreview()`）。四条硬约束：
    ① 必须走 `resolveCommandParams()`，这样「跟随」跟真跑一致；
    ② 必须**按 `MATCH_KEYS` 给每种被勾选的模式各出一行**（三种模式可以各配一套参数）；
    ③ 结果里的 `line` 是**变量已经替换完**的命令行，不是模板 —— 面板的意义就在这里；
    ④ **测试路径是多条**：入口 `#f-test-paths` 每行一个，「加目录/加文件」可多选追加，
       preload 侧 `normalizePreviewPaths()` 统一整理（去重、剥成对引号、封顶 20 条），
       别再退回单路径 `samplePath`。
    新增变量时 `buildPreview` 不用改（它复用 `substitute`），但 `check-cmds.js`
    里那组断言要跟着补。

### 变量

- 新增变量时：`assets/app.js` 的 `VAR_CHIPS` + `preload.js` 的 `PLACEHOLDER_RE`
  **两处都要加**（`buildContext()` 也要补对应的上下文值）。
- 文案要**文件夹 / 文件通用**（比如 `{name}` 写「名称（含后缀）」，不能只写「文件夹名」），
  且**每条 desc 必须自己写完整，禁止写「同上」**——面板里每条是独立一行，用户看不到上文。
- 变量面板是**复制**不是插入：点一下 `api.copyText(占位符)` + toast。
  不要改回「插到最后聚焦的输入框」—— 那套需要 `state.lastInput` 记焦点、还要把值
  写回 `state.cmdParamDraft`，插错格子是常态，整套都删了别捡回来。
- **列表变量的分隔符示例是「表」不是「一行备注」**（用户问过「空格怎么填」）：
  `VAR_SEP_ROWS`（app.js）渲染成 `#var-sep` 里的 `.var-sep-item` 网格行
  （写法 → 结果 → 说明），**点一下把整条写法复制走**；首两条专门回答「空格分隔」——
  不写冒号就是空格、写 `{paths: }` 也一样。脚注 `VAR_SEP_FOOT` 只放兜底规则
  （分隔符不能含 `}`、非列表变量跟冒号无意义）。新增列表变量时这个表也要补行。
- ⚠️ **`{qpath}` / `{qpaths}` 自带双引号**，模板里不要再套一层。
  种子命令与 `PRESETS` 曾经全写成 `"{qpath}"`，拼出来是 `""D:\a""`（参数测试一开就露馅了），
  已统一改成 `{qpath}`。参数输入框的 placeholder 也要写 `例如：{qpath}（自带引号）或 "{path}"`。
- ⚠️ **`{qpath}` / `{qpaths}` 加引号必须走 `quoteWin()`**，不能手写 `` `"${p}"` ``。
  它以反斜杠结尾时会**直接裸传不加引号**（前提是不含空白 / cmd 元字符），
  因为带引号的写法在这个场景下无法同时兼容两类程序，详见踩坑 20。
  唯一不走它的地方是内置动作 `copy-qpath`（写进剪贴板的是纯文本，要原样）。

### 匹配条件卡的两个易错点

### 匹配条件卡的两个易错点

- 「选中个数」和「名称字符数」是**两组独立限制**（用户澄清过一次，是易错点）：
  第一行 `.row.quad` 放 4 个数（最少/最多选中个数 + 名称最少/最多字符数），
  第二行 `.row.pair` 放「名称匹配」下拉 + 条件框（扩展名 / 正则，由 `data-params-when` 显隐）。
- 匹配条件的 `data-params-when="ext|regex"` 由 `[data-p="range"]` 的当前值决定显隐
  （`updateRangeVisibility()`）。

### 搜索与分类

- `searchFiltered()`（只按关键词）与 `visibleRows()`（再按分类）分开，
  **分类芯片计数按 `searchFiltered()` 算**，搜索与分类才能真正叠加；
  未命中的分类加 `.cat-chip.dim`（45% 不透明度）。
- 搜不到时给「清空筛选条件」（走 `data-act="reset-filter"` 的事件委托）。

---

## 七、视觉规范（MD3 × One Dark 暗蓝）

`assets/style.css` 全部用 **MD3 语义色角色**命名：`--primary` / `--on-primary` /
`--primary-container` / `--surface-container-{low,high,highest}` / `--on-surface` /
`--on-surface-variant` / `--outline` / `--outline-variant` / `--error …`。
改配色只动 `html[data-theme="dark"]` / `[data-theme="light"]` 两组令牌。

- 主色 = Atom One Dark 蓝 `#61afef`；表面阶梯
  `#15181e → #1b1f27 → #21262f → #272d38 → #2e3541`；
  语义色也来自 One Dark（青 `#56b6c2`、紫 `#c678dd`、红 `#e06c75`、绿 `#98c379`）。
- 形状用 `--shape-xs/sm/md/lg/xl/full`；按钮 · 芯片 · 分段控件 = full，卡片 16
  （**弹层半径 28 那条已随弹层一起删掉**）。
- 按钮语义类：`.btn.filled / .tonal / .outlined / .text / .danger`。
- 状态层用 MD3 叠加色（`--state-hover` 8% / `--state-press` 12%）而不是换边框色。
- **禁止使用 `color-mix()`**、`:has()` 等新 CSS（uTools 底座 Chromium 版本可能较旧）。
- **原生控件必须手动主题化**（否则会出现白底下拉、系统蓝勾选框）：
  ① `html[data-theme]` 上设 `color-scheme: dark|light`；
  ② `select option, select optgroup { background/color }` 给下拉项定色；
  ③ 勾选框**不用 `accent-color`**（旧 Chromium 不生效），用 `appearance:none` 手写。
- 列表里的图标**不加容器底色**（`.item-icon` 无 background、无圆角）。
- 列表行的操作按钮要**明确像按钮**：`.icon-btn` = `surface-container-high` 底 +
  `outline` 描边 + 全圆角；**三个都是文字按钮**（`编辑` / `停用`·`启用` / `删除`，
  不再用 ↑↓ / ⏻ 图标）；删除默认警示红；`.item-badge`（信息标签）保持浅色以拉开层次。
  - `.icon-btn.toggle` 定宽 `min-width: 46px`（`停用` 两字 / `启用` 两字等宽，行内不抖动）；
    已停用时加 `.off` → 主色描边 + `--primary-container` 底，视觉上强调「点它就是重新启用」。
  - `删除` 走**点两下确认**：第一次点击把文案换成 `确认删除?`（`state.pendingDelete`），
    点别处或再点一次其它行会清空。批量删除同理（`确认删除 N 项?`）。
- **排序只靠拖拽，没有上下箭头**。`.drag-handle` 是每行最左边的 14px 细列，
  `cursor: grab`，里面是 `DRAG_ICON`（两列 6 点，`svg { fill: currentColor }`）。
  **多选模式下这列不渲染**（让位给框选）。
  - `.item` 要 `position: relative`——落点指示线用 `::before`（2px 主色横线）画，
    **不能用 `box-shadow`**：`.item.picked:hover` 已经占了 `inset 0 0 0 1px var(--primary)`。
  - `.item.dragging` 半透明（`.4`）表示"正在拖的是这条"；`.item.drop-before` / `.drop-after`
    分别把指示线画在行顶 / 行底。
- **框选视觉**：`.marquee` = `position: fixed` + `1px solid var(--primary)` +
  `--marquee` 填充（暗 `rgba(97,175,239,.16)` / 亮 `rgba(43,108,176,.16)`，
  **比 `--picked` 略重**，否则暗底上几乎看不见）+ `pointer-events: none`。
  框到的行加 `.mb-hit`（`--picked` 底 + `inset 0 0 0 1px var(--primary)` 描边）实时预览。
  `.list.multi` 上 `user-select: none`，否则拉框会把文字拖蓝。
- **多选模式是一个显式开关**（`.btn.tonal.active` = 按下态填成主色）。
  关着的时候**整列 `.item-check` 根本不渲染**（不是靠 CSS 隐藏），`#batch-bar` 也不显示；
  `setMulti(false)` 顺带清空 `state.selection`。开着时每行前面才有勾选框。
- 底栏那条 `.segmented.xs`（`全部 | 启用 | 停用`）高度 `26px`、字号 `11.5px`，
  和左边分类芯片同高，不要拉满一行。
- **参数测试面板 `.cmd-preview`**：`flex: 0 0 auto` + `max-height: 260px`，
  夹在 `.editor-body` 和 `.editor-foot` 之间（**在滚动区外面**，不然一滚就看不见了）。
  头部一行是「测试路径 | 加目录 | 加文件 | 清空 | 已选 N 项 | ←spacer→ | 收起」；
  测试路径是 `<textarea id="f-test-paths">`（每行一个路径，`width:auto` + 左右
  20px 外边距靠 flex 列拉伸，**不要写 `width:100%`**——会加上外边距撑破容器）。
  每行 `.cp-row` 整行可点（点即复制），命令用 `--mono` + `word-break: break-all`
  （路径很长，不折行会把模式标签挤没）。
- `.view-head` 的「← 返回」是个 `.btn.text.sm`，用 `margin-left: -10px` 把箭头
  视觉上贴回内容左边线；箭头走 `stroke: currentColor`，跟着按钮的 hover 变色。
- `#batch-bar` 里的 `全选` 只对齐**高度（30px）和左右留白**，**不套外边框**。
  加边框会把它变成一颗"胶囊按钮"，跟右边的文字按钮混在一起分不清主次
  （第一版就是加了边框，用户看出来了）。
- **多选中的行**用专用令牌 `--picked`（暗 `rgba(97,175,239,.14)` / 亮 `rgba(43,108,176,.12)`），
  **不要**用 `--primary-container` 当选中底（太饱和，会把行里的勾选框和文字压糊）。
- `.item-check` 平时 55% 不透明度，hover / 勾选后完全显形。
- `.item-sub`（副标题）用 `--mono`，写的是「程序名 + 参数」，**不出现目录**。
- 被跟随的参数卡：虚线描边 + 参数框整块收起（`.match-card.following`）。
- **插件 logo 与所有图标都不带底色**，logo 是透明背景的单色线条
  （`tools/make_logo.py`，线条色 `rgb(47,127,208)` —— 与白底 `#f6f8fc` 和
  uTools 暗底 `#15181e` 的对比度都约 4.2:1，**两套主题通用，不需要各出一版**）。

### 编辑器版式约定

- 字段顺序：**起始模板条（仅新建）→ 图标 → 名称 + 分类标签（`.row.split`）→ 类型 →
  匹配方式 → 匹配条件卡 → 命令/程序 → 命令参数 → 复制变量 → 动作（仅内置动作）**。
- 编辑页的骨架是 `.view-head`（← 返回 + 标题）→ `.editor-body`（唯一滚动区）→
  `#cmd-preview`（可选，参数测试面板）→ `.editor-foot`（动作条）。
  `.editor-body` 必须 `flex:1; min-height:0`，否则它会顶掉底栏。
- **提示文案只留「有信息量」的**：非结构性的 `<em class="tip">…</em>` 尾巴、
  `.match-card-tip`、分隔线 `.divider` 都已删除；场景说明从正文搬进勾选框的 `title`。
  唯一保留的提示 = 变量分隔符示例表 `#var-sep`（`VAR_SEP_ROWS` + 脚注）、
  「一个匹配方式都没勾」的 `#match-hint` 警告、
  跟随卡的「参数与「×」保持一致…」说明。`.var-hint`（单行文字版）已删。
- `#match-hint`（文案固定为「至少选中一项」）是 `.match-picker` 里的 **inline-flex 兄弟节点**，
  **不是块级独占一行**——文案短，跟三个勾选框并排更省版面；`.hidden` 时彻底不占位。
  `.match-picker` 本身 `align-items: center` 保证它和勾选框垂直居中。
- **「名称 + 分类标签」那一行（`.row.split`）必须 `align-items: start`**（见第六节硬性约定 24）。
  「分类标签」底下那排「已有：开发 / 系统 / 终端」建议 chips（`.cat-suggest`）一旦撑高，
  继承来的 `align-items: center` 就会把「名称」整体压低半个身位，看起来就是"没对齐"。
  `.cat-suggest:empty { display: none }` 保证没有建议时不白留 8px。
- **输入框不要强制整行**：4 个数值进 `.row.quad` 网格；「名称匹配」下拉 + 条件框进
  `.row.pair`（下拉定宽 128px）。`.field.inline`、`.row.triple` 已删除。
- 场景提示文案 `MATCH_SCENE` **不要重复写「资源管理器」**（整个插件都在里面用）；
  它现在只作 `title` 用，不占版面。

---

## 八、本地调试

保存代码后，在 uTools 开发者工具里点「刷新」。调试超级面板时，需要**先切到资源管理器
选中一个文件夹**，再呼出超级面板。

### 不装 uTools 也能看管理界面

```bash
node tools/build-preview.js     # 生成 dev/preview.html
# 浏览器打开 dev/preview.html，右上角可切明/暗主题
```

预览页用 `dev/mock-api.js` 模拟了 preload 的 API，因此界面能完整交互
（增删改、图标预览、试运行、浏览按钮都走 mock）。
预览页首次进入时用的就是 `app.js` 里的 `SEED_COMMANDS`，所以顺带也验证了那份示例数据。

> ⚠️ `dev/preview.html` 是 `build-preview.js` 按 `index.html` **生成**的副本。
> **改过 `index.html`（动了 id / 结构）就要重新生成**，否则预览页还是旧结构 ——
> `app.js` 里 `$("新id")` 会取到 `null` 并抛错，而 `init()` 在渲染列表**之前**跑，
> 结果是**整个列表空白**（页头、搜索栏都在，就是没内容）。
> 改 `app.js` / `style.css` 不用重新生成。

### 给「点了按钮之后」的状态截图

用 `dev/drive.html`：它把 `preview.html` 装进一个同源 iframe，再按 `?shot=` 注入
点击 / 输入 / 勾选。用技能 `headless-chrome-ui-verify` 的系统 Chrome 无头模式：

```bash
python -m http.server 8765 --bind 127.0.0.1      # 必须走 http，且要后台跑住

chrome --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$PWD/.tmp-shot/profile" \
  --window-size=1000,780 --virtual-time-budget=6000 \
  --screenshot="$PWD/.tmp-shot/out.png" \
  "http://127.0.0.1:8765/dev/drive.html?shot=new"
```

`shot` 可选：

| shot | 效果 |
| --- | --- |
| `list` | 首屏（搜索 + 新建一行、分类芯片、列表徽章） |
| `search` / `searcharg` / `none` | 搜「终端」/ 搜参数内容 / 搜不到 |
| `cat` | 点第二个分类芯片 |
| `disabled` | 停用第 1、3 行（看「启用」按钮的高亮态） |
| `statusoff` | 停用两行后把状态筛选切到「停用」 |
| `toggle` | 点第 2 行的 `停用` 按钮 |
| `clickrow` | 普通模式下单击整行 —— **不应该**切到编辑页（截图应与 `list` 完全一致） |
| `subtitle` | 套「Git Bash Here」模板并保存，看副标题有没有省掉 `C:\Program Files\Git\` |
| `batch` / `batchall` | 勾 1/2/4 行 / 点全选 |
| `invert` | 勾 2 行后点「反选」 |
| `marquee` | 多选模式下合成 `mousedown`+`mousemove` 拉框（**不派发 mouseup**，把拉框中间态截下来） |
| `multiclick` | 多选模式下单击一行（按下即松开），应当只切换这一行 |
| `new` / `newtpl` | 打开新建页 / 新建后点一个模板 |
| `cmdtest` | 编辑页点「参数测试」，填**两条**测试路径 + 把文件夹参数改成 `{qpaths:, }`，看多路径下列表变量怎么拼 |
| `varcopy` | 编辑页点变量 `{qpath}`，看「已复制」提示 —— **`--virtual-time-budget` 要给 ~1700ms**，给大了 toast 会被虚拟时间跑完自动收掉 |
| `varsep` | 滚到「复制变量」面板的分隔符示例表那一段 |
| `editor` / `window` / `light` / `cmdparam` | 编辑页（全勾 / 滚到底 / 亮色 / 滚到命令参数） |
| `follow` / `namelen` / `vars` / `range` | 参数跟随 / 名称长度 / 变量面板 / 展开「名称匹配」三个选项 |

截图驱动页的几个坑（页内也有注释）：

- iframe **宽高都要显式设置**（只设高度会塌成 150px 宽）；
- iframe 宽度**不要超过窗口宽度**，否则会把 drive 页撑出横向滚动条，
  `body` 的居中会把内容整体右移，截出来右边被裁掉、看着像是布局溢出；
- 编辑页内容比视口高时，**要么滚 `.editor-body`、要么直接把 `--window-size` 调高**
  （编辑页是整页 `.view`，窗口变高它就长高）。`docs/name-length.png`
  就是用 `--window-size=1000,1350` 截的，比滚动好看；
- **`--user-data-dir` 每次换一个新的**。复用同一个目录时 Chrome 会拿缓存里的旧
  `preview.html`，重新生成也白搭 —— 两张不同 `?shot=` 的截图字节数一模一样就是它。
  判据：**不同 `?shot=` 之间**字节相同才算异常（同一个 shot 前后相同只说明界面没变）；
- **点击后列表会整块重绘**：连续点多个按钮时必须**每次重新 `querySelectorAll`**，
  否则第二次拿到的是已脱离文档的旧节点，`click()` 不会冒泡到 `#manage-list` 的委托监听器上
  （`disabled` shot 踩过：写 `[0,2].forEach(i => pw[i].click())` 只生效了第一个）；
- 原生 `<select>` 展开的 popup 截不到（系统绘制，不在 DOM 里）。
  要验证选项文案得临时 `setAttribute("size", "3")` 把它摊成内联 listbox（`range` shot 就是这么做的）。

### 其它辅助脚本

```bash
node tools/check-dom.js         # 界面静态一致性校验（id / data-when / api 覆盖）
node tools/check-summary.js     # 副标题「省略路径」的 baseName() 单测（抠源码求值）
node tools/check-cmds.js        # 指令生成 / 迁移 / 控制台识别 / 参数测试（150 项断言）
python tools/make_logo.py       # 重新生成 logo.png（纯标准库，无需 Pillow）
```

> `check-summary.js` 的做法值得记一下：`app.js` 是个 IIFE，内部函数外面拿不到，
> 它直接从**源码文本里按花括号配对抠出 `baseName()`** 再 `new Function` 求值 ——
> 校验的是真实源码，而不是抄一份实现（抄一份的话改坏了源码测试还是绿的）。

---

## 九、校验脚本

### `check-dom.js` —— 静态一致性（改完界面必跑）

一次跑四项：

1. `app.js` 里 `$("id")` 引用的 DOM id 是否都在 `index.html` 里；
2. `[data-when="…"]` 的取值两边是否一致；
3. `api.xxx()` 调用是否都在 `preload.js` 的 `api` 对象上（精简 API 时最有用）；
4. `dev/mock-api.js` 是否覆盖了同一批方法（漏了离线预览会莫名报错）。

这条静态检查抓到过真 bug：写了 `$("batch-off")` 而 HTML 的 id 是 `btn-batch-off` ——
**在运行时之前**就报出来了。

### `check-summary.js` —— 列表副标题的 `baseName()`（改显示逻辑后跑）

`app.js` 是 IIFE，内部函数外面拿不到，所以这个脚本**从源码文本里按花括号配对
抠出 `baseName()`** 再 `new Function` 求值 —— 校验的是真实源码。
覆盖 `code` / `C:\…\run.exe` / `C:\Program Files\…` / 带引号 / 正反斜杠混用 /
尾随斜杠 / `undefined` 等 14 项。之所以需要它：**种子数据里的命令都是裸命令**
（`code` / `cmd` / `wt`），界面上根本看不出路径被省掉，只能靠单测兜住。

### `check-cmds.js` —— 逻辑断言（改 `featureCmds` / 占位符 / 迁移后必跑）

用 Node 的 `vm` 造一个假的 `window` / `utools` 把 `preload.js` 跑起来，
再去断言它暴露在 `window.folderCmdRaw` 上的纯函数 —— **不用装 uTools 就能验证最核心的逻辑**：

- `featureCmds()`：三种匹配方式各自 / 多选 / 兜底时产出的指令字段是否合法
  （`extensions` / `match` 二选一、空值不输出、`fileType` 正确、window 的 `app` 必填兜底）；
  **以及输出顺序真的跟着 `MATCH_KEYS` 走**（第一条必须是「文件」）；
- 名称字符数：只有长度 / 扩展名 + 长度 / 正则 + 长度 / 只有下限（必须是 `{3,}`）/
  只有上限（必须是 `{0,24}`，不能出现 `{,24}`）/ 与选中个数共存 / 不填时回退原生 `extensions`；
- 变量：`{names}`、`{var:sep}` 的自定分隔符与 `\n \t \r \\` 转义、空列表与单项、
  未识别占位符原样保留；
- 「跟随」：来源被勾选时照抄、来源没勾选时不生效、`fileType` 仍是自己的；
- 命令参数：按模式各取一套、未知模式回退到第一个模式（文件）、跟随自引用 / 环保护；
- **参数测试（`buildPreview`）**：多路径归一（数组 / 换行串 / 分号串 / 去重 / 剥引号 /
  封顶 20 条）、空输入报错、按模式分行、跟随一致、列表变量多路径拼接、内置动作提示；
- `needsConsole()` / `programToken()`：带空格与引号的路径
  （`C:\Program Files\Git\git-bash.exe`）也要能正确取出程序名；
- `loadCommands()` 的旧数据迁移：`trigger: "both"` → `folder + window` 都勾上、
  `trigger` / `runMode` 被删除、结果落盘、重复加载稳定、
  **迁移结果的 `matches` 键序也是 `MATCH_KEYS` 顺序**。

```
通过 150 项，失败 0 项
✓ 指令生成逻辑校验通过
```

> 测试里要断言纯函数时，记得往 `folderCmdRaw` 上挂（已挂
> `buildContext` / `substitute` / `joinList`）。
> 沙箱只注入 `window/utools/console/process/require/module/exports/setTimeout`，
> **不要手动注入 `Object/Array/RegExp`**。

---

## 十、几个踩过的坑

1. `utools.onPluginEnter` / `onPluginOut` **只注册一次**（重复注册会让手动选目录的对话框弹两次）。
2. 管理界面开着时动态指令执行完**不要** `utools.outPlugin()`，否则会关掉用户的管理窗口。
3. 正则量词 **`{3,}` 合法、`{,24}` 不合法**。只有上限时下限必须显式补 `0`。
4. **别在渲染函数里手写模式顺序**。`featureCmds()` 和 `renderMatchParams()` 原来都是
   `if (folder) …; if (file) …; if (window) …` 三连写死，改 `MATCH_KEYS` 时**不会跟着变**，
   结果勾选框是新顺序、生成的卡片和指令还是旧顺序（一次挂了 8 条断言）。
   正确写法是 `MATCH_KEYS.forEach(...)` / `.map(...)`。
   迁移函数里构造 `matches` 时同理 —— `{"folder": …}` 字面量写出来的键序
   会被 `JSON.stringify` 比对类断言抓到。
5. **`extensions` 与 `match` 二选一**，一旦要用名称长度（只能走正则），
   就必须放弃原生 `extensions`，把扩展名也一起塞进正则里。
6. **`dev/preview.html` 是生成物**（见第八节）。
7. **点击后列表重绘 → 旧节点脱离文档 → 事件不再冒泡**（见第八节）。
8. 单击整行**故意不做任何事**，所以点击委托里 `if (!btn) return;` 之后就别再加行点击逻辑。
   勾选列仍然要白名单整个 `.item-check`（不只 `input`），否则点 label 空白处会穿透到行的处理分支。
9. `.checkbox.sm` 曾覆盖 18px 的 MD3 勾选框尺寸，导致对勾错位 —— 现在只改字号。
10. **Chrome 无头截图的 `--screenshot=` 必须给绝对路径**。给相对路径时它**静默不写文件**，
    一句报错都没有（`Exit Code: 0`、stderr 干净），一次批量截图 15 张全空就是这么来的。
    用 `$OUT/xxx.png` 这种绝对路径就正常。
11. **`.row.split` 的对齐是被父类 `.row` 的 `align-items: center` 带歪的**。
    `.row.split` 只改了 `display: grid`，`align-items` 会继承 —— 一旦两格高度不等
    （分类标签下面那排「已有：xx」chips 撑高了它自己），两边的 label / 输入框
    就会错开半个身位。修法是 `align-items: start` + 让空建议 `:empty` 不占高度。
12. **框选矩形的 `.marquee` 一旦忘了 `pointer-events: none`**，
    框画出来的瞬间就盖在行上面，`mousemove` 会被框自己吃掉，拖一下就卡住。
13. **同一个「按住 + 移动」手势不能给两个功能**。拖拽排序和拉框选行都是
    mousedown + move，同时开着必然互相打架 —— 所以多选模式直接不渲染手柄，
    把手势整个让给框选，而不是想办法"共存"。
14. **页面里挂 `document` 级监听的那类功能（框选），在无头驱动里要往
    `iframe.contentDocument` 上派发事件**，派发到外层 drive 页的 document 上不起作用。
15. **无头截图抓不到 toast**：`--virtual-time-budget` 会把 setTimeout 快进掉，
    给 5000ms 时 toast 早就自动收了。要截「点了之后弹个提示」这类中间态，
    **把预算调到刚好够（~1700ms）** —— `varcopy` shot 就是这么做的。
    反过来，要截稳定终态就别太小（> 4000ms 才安全）。
16. **`{qpath}` / `{qpaths}` 自带双引号**，模板里再包一层就变成 `""D:\a""`。
    Windows 的 MSVCRT 解析下两层引号会互相抵消、多数情况还能跑，但 `cmd /k cd /d`
    这类就该出问题了 —— 不做「参数测试」根本发现不了。种子命令、`PRESETS`、
    输入框 placeholder 三处都改过一遍，**新增模板时别再写 `"{qpath}"`**。
17. 编辑页的 `.editor-body` 必须 `flex: 1; min-height: 0`。这是滚动区，
    少了 `min-height: 0` 它在 flex 列里不会收缩，会把底栏顶出可视区。
18. **`check-dom.js` 数括号前要先把字符串 / 正则字面量剥掉**。
    mock-api 里 `/\{(paths|qpaths|names)(?::([^}]*))?\}/g` 这种正则的 `}` 比 `{` 多一个，
    直接按字符数 `{`/`}` 会把 depth 提前减到 0，扫描提前结束 ——
    表现为「mock 明明有 `testRun`，校验却报缺」。修法见 `stripLiterals()`。
19. ⚠️ **`utools.readCurrentFolderPath()` 是异步的（返回 Promise）**，
    而页面取「测试路径默认值」是同步的 —— preload 的 `api.currentFolder()`
    直接 `return utools.readCurrentFolderPath()` 会让输入框里出现 **`[object Promise]`**。
    现在的做法是 `refreshCurrentFolder()` 把结果**缓存**进 `lastKnownFolder`
    （进插件时先取一次），`currentFolder()` 只返回字符串；拿不到就返回空串让页面用兜底示例。
    页面侧 `defaultTestPath()` 再 `await` 一次 + `typeof v === "string"` 过滤做双保险。
    **任何要交给页面当字符串用的 preload 返回值，都别直接透传异步 API 的结果。**
    `check-cmds.js` 的 stub 故意让 `readCurrentFolderPath` 返回 Promise，专门拦这类回归。
20. ⚠️ **引号内以反斜杠结尾的路径会被 cmd 吃掉闭合引号**（`wt -d "D:\"` 报
    「无法访问启动目录"D:\"」，而 `D:\sub` 正常）。
    根因是 Windows `CommandLineToArgvW` 的规则：引号里尾部的 n 个 `\` 后面紧跟
    闭合引号时会被当成**转义引号**，所以必须写成 2n 个才能还原。
    实测（cmd.exe 里跑 node 打印 `process.argv`）：

    | 命令行写法 | 程序实际收到的 argv | 结论 |
    |---|---|---|
    | `-d "D:\"` | `D:\"` | ✗ 盘根目录必错 |
    | `-d "D:\sub"` | `D:\sub` | ✓ 子目录没问题 |
    | `-d "D:\sub\"` | `D:\sub\"` | ✗ **子目录带尾斜杠也错** |
    | `-d D:\` | `D:\` | ✓ 不带引号就不转义 |
    | `-d "D:\\"` | `D:\` | ✓ 尾斜杠加倍 |
    | `-d "D:\."` / `-d "D:/"` / `-d "D:"` | 原样 | ✓ 都能绕过 |

    **注意这不只是「盘根目录」的问题**——任何以 `\` 结尾的路径都中招，
    只是资源管理器里只有盘根天然带尾斜杠，所以平时看不出来。

    **但「加倍反斜杠」不是通用解**：它只对**严格遵循该规则**的程序有效。
    自己解析命令行的程序（Everything 就是这类，voidtools 官方论坛那个
    「右键打不开盘符」的老 bug 同根因，他们的修法是**去掉尾部引号**让字符串
    不闭合）会把 `\\` 当作两个字面反斜杠 —— 于是 `"D:\\"` 对它是错的，
    反而 `"D:\"` 才对。带引号的写法**无法同时满足两类程序**。

    最终策略（`quoteWin()`）：以反斜杠结尾且不含空白 / cmd 元字符时
    **直接裸传**，不加引号 —— 两种解析器拿到的都是原样路径：

    | 场景 | 输出 | 说明 |
    |---|---|---|
    | `D:\sub`（无尾斜杠） | `"D:\sub"` | 照常加引号 |
    | `D:\`（尾斜杠，无空格） | `D:\` | 裸传，两边都对 |
    | `D:\My Folder\`（尾斜杠 + 空格） | `"D:\My Folder\\"` | 躲不掉，按标准规则加倍 |

    兜底：万一下游程序两种都不吃，让用户改用 `{path}`（本来就是裸路径）。
    改这个函数必须同步 `check-cmds.js` 第 12b 节。

---

## 十一、打包发布

1. 删除 `dev/`、`tools/`、`docs/`、`.tmp-shot/`（都是开发用的，可选，仅减小体积）。
2. uTools 开发者工具 → 选择本目录 → **打包**，产物 `.upx`。
3. 到 uTools 插件应用市场开发者中心提交审核。

---

## 十二、uTools API 注意事项

- 平台 API 使用前**先查官方文档确认存在**（`onPluginReady` 已被移除过一次）。
  文档：<https://www.u-tools.cn/docs/developer/basic/getting-started.html>
- `utools.setFeature` 的 `cmds` 字段语义见第四节。
- `utools.getFeatures()` 用来清理旧的动态指令（按 `dyn:` 前缀过滤）。
- `utools.dbStorage` 做持久化；`utools.readCurrentFolderPath()` 取窗口模式下的路径。
