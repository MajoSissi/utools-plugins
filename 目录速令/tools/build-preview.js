/* 由 index.html 生成离线预览页 dev/preview.html */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let html = fs.readFileSync(path.join(root, "index.html"), "utf8");

html = html
  .replace(/href="assets\//g, 'href="../assets/')
  .replace(
    /<script src="assets\/app\.js"><\/script>/,
    '<script src="mock-api.js"></script>\n    <script src="../assets/app.js"></script>'
  );

// 预览用的外框样式
const chrome = `
    <style>
      html, body { height: 100% !important; overflow: hidden !important; }
      body {
        display: flex; align-items: center; justify-content: center;
        background: #0e1116 !important; padding: 12px;
      }
      #preview-frame {
        width: 100%; max-width: 900px; height: 100%; overflow: hidden; position: relative;
        border-radius: 20px; border: 1px solid rgba(195,204,217,.12);
        box-shadow: 0 24px 60px rgba(0,0,0,.65);
        display: flex; flex-direction: column; background: var(--surface);
      }
      #preview-frame > .view { flex: 1; height: auto; min-height: 0; }
      #preview-bar {
        height: 32px; flex: 0 0 32px; display: flex; align-items: center; gap: 8px;
        padding: 0 12px; background: #1b1f27; border-bottom: 1px solid rgba(195,204,217,.1);
        font: 12px "Segoe UI","Microsoft YaHei",sans-serif; color: #8b95a5;
      }
      #preview-bar .dots { display: flex; gap: 6px; }
      #preview-bar .dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
      #preview-toggle {
        margin-left: auto; cursor: pointer; border: 1px solid #4c5666;
        background: transparent; color: #61afef; border-radius: 999px;
        padding: 3px 12px; font-size: 11px; font-weight: 500;
      }
      #preview-toggle:hover { background: rgba(97,175,239,.12); }
    </style>
`;

const wrapOpen = `
    <div id="preview-frame">
      <div id="preview-bar">
        <span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>
        <span>uTools · 目录速令（离线预览）</span>
        <button id="preview-toggle">切换主题</button>
      </div>`;
const wrapClose = `
    </div>
    <script>
      (function () {
        var frame = document.getElementById('preview-frame');
        Array.prototype.forEach.call(document.querySelectorAll('body > .view, body > .toast'), function (el) {
          frame.appendChild(el);
        });
        document.getElementById('preview-toggle').addEventListener('click', function () {
          var cur = document.documentElement.getAttribute('data-theme');
          document.documentElement.setAttribute('data-theme', cur === 'light' ? 'dark' : 'light');
        });
      })();
    </script>`;

html = html.replace("</head>", chrome + "  </head>");
html = html.replace(/<body>/, "<body>" + wrapOpen);
html = html.replace("</body>", wrapClose + "\n  </body>");

const out = path.join(root, "dev", "preview.html");
fs.writeFileSync(out, html, "utf8");
console.log("written:", out);
