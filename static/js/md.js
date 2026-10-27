/* ============================================================
   md.js — dependency-free Markdown → safe HTML + syntax highlight
   Escape-first approach: raw HTML in source can never inject markup.
   ============================================================ */
(function () {
  "use strict";

  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* ---------------- syntax highlighting ---------------- */

  const KW = {
    js: "const let var function return if else for while do switch case break continue new class extends super import export from default async await try catch finally throw typeof instanceof in of this null undefined true false yield static get set delete void".split(" "),
    ts: "const let var function return if else for while do switch case break continue new class extends super import export from default async await try catch finally throw typeof instanceof in of this null undefined true false yield static get set delete void interface type enum implements declare namespace readonly public private protected abstract as keyof never unknown any string number boolean object symbol bigint".split(" "),
    py: "def class return if elif else for while break continue import from as pass raise try except finally with lambda global nonlocal yield assert del in is not and or True False None async await match case self".split(" "),
    bash: "if then else elif fi for while until do done case esac function in local return exit export echo printf read source alias cd ls grep sed awk curl git python pip npm node sudo chmod chown mkdir rm cp mv cat head tail which env echo set unset trap shift declare readonly".split(" "),
    json: ["true", "false", "null"],
    sql: "select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset distinct as and or not null primary key foreign references default unique check constraint varchar int integer text boolean date timestamp count sum avg min max between like in is exists union all case when then end".split(" "),
    go: "package import func return if else for range break continue switch case defer go chan map struct interface type var const nil true false new make len cap append delete panic recover print".split(" "),
    rs: "fn let mut const static if else for while loop match break continue return impl trait struct enum pub use mod crate self super as in where async await move ref dyn box true false Some None Ok Err String Vec HashMap".split(" "),
    css: ["color", "background", "margin", "padding", "border", "display", "flex", "grid", "position", "top", "left", "right", "bottom", "width", "height", "font", "size", "weight", "family", "text", "align", "justify", "content", "items", "gap", "overflow", "transition", "transform", "animation", "box", "shadow", "radius", "opacity", "z", "index", "min", "max"],
    html: ["html", "head", "body", "div", "span", "p", "a", "img", "ul", "ol", "li", "h1", "h2", "h3", "h4", "table", "tr", "td", "th", "form", "input", "button", "script", "style", "title", "meta", "link", "header", "footer", "main", "section", "article", "nav", "aside", "br", "hr", "pre", "code", "strong", "em", "input", "label", "select", "option", "textarea"],
    yaml: ["true", "false", "null", "yes", "no", "on", "off"],
    java: "public private protected static final void int long double float boolean char byte short class interface extends implements new return if else for while do switch case break continue try catch finally throw throws import package this super null true false abstract synchronized volatile transient instanceof".split(" "),
  };
  KW.javascript = KW.js; KW.typescript = KW.ts; KW.tsx = KW.ts; KW.jsx = KW.js;
  KW.python = KW.py; KW.sh = KW.bash; KW.shell = KW.bash; KW.zsh = KW.bash;
  KW.rust = KW.rs; KW.c = KW.java; KW.cpp = KW.java; KW.csharp = KW.java; KW.cs = KW.java;
  KW.markdown = []; KW.md = []; KW.text = []; KW.txt = []; KW.xml = KW.html;

  const COMMENT_STYLES = {
    py: "#", sh: "#", bash: "#", yaml: "#", rs: "//", go: "//", js: "//", sql: "--", html: "<!--", css: "/*",
  };

  function highlight(code, lang) {
    lang = (lang || "").toLowerCase();
    const kw = KW[lang] || (lang ? KW[lang] : null);
    if (!kw) return esc(code); // no language → plain escaped

    const hash = COMMENT_STYLES[lang] === "#" || lang === "py" || lang === "yaml" || lang === "sh" || lang === "bash";
    const sl = lang === "js" || lang === "ts" || lang === "go" || lang === "rs" || lang === "java" || lang === "c" || lang === "cs" || lang === "cpp";
    const parts = [];
    let i = 0;
    const n = code.length;

    const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

    while (i < n) {
      const c = code[i];

      // line comments
      if (hash && c === "#" && (lang !== "bash" || i === 0 || /\s/.test(code[i - 1]))) {
        let j = i; while (j < n && code[j] !== "\n") j++;
        parts.push('<span class="hl-com">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }
      if (sl && code.startsWith("//", i)) {
        let j = i + 2; while (j < n && code[j] !== "\n") j++;
        parts.push('<span class="hl-com">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }
      if (lang === "sql" && code.startsWith("--", i)) {
        let j = i + 2; while (j < n && code[j] !== "\n") j++;
        parts.push('<span class="hl-com">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }
      if ((lang === "html" || lang === "xml") && code.startsWith("<!--", i)) {
        let j = code.indexOf("-->", i + 4); j = j < 0 ? n : j + 3;
        parts.push('<span class="hl-com">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }
      if ((lang === "css" || lang === "js" || lang === "ts" || lang === "go" || lang === "java" || lang === "c" || lang === "cs" || lang === "cpp" || lang === "rs") && code.startsWith("/*", i)) {
        let j = code.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
        parts.push('<span class="hl-com">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }

      // strings
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        let j = i + 1;
        while (j < n) {
          if (code[j] === "\\") { j += 2; continue; }
          if (code[j] === quote) break;
          if (quote !== "`" && code[j] === "\n") break;
          j++;
        }
        j = Math.min(j + 1, n);
        parts.push('<span class="hl-str">' + esc(code.slice(i, j)) + "</span>");
        i = j; continue;
      }

      // numbers
      if (/[0-9]/.test(c) && !isIdent(code[i - 1] || "")) {
        let j = i;
        while (j < n && /[0-9a-fA-FxX._eE+-]/.test(code[j]) && !(code[j] === "-" && !/[0-9a-fA-F]/.test(code[j + 1] || ""))) j++;
        // trim trailing operators that snuck in
        while (j > i && /[+-]/.test(code[j - 1]) && j < n) j--;
        const num = code.slice(i, j);
        if (num.length > 1 || /[0-9]/.test(num)) {
          parts.push('<span class="hl-num">' + esc(num) + "</span>");
          i += num.length; continue;
        }
      }

      // words: keywords / attributes / function calls
      if (/[A-Za-z_$]/.test(c)) {
        let j = i; while (j < n && isIdent(code[j])) j++;
        const word = code.slice(i, j);
        // peek next non-space char
        let k = j; while (k < n && code[k] === " ") k++;
        const next = code[k] || "";
        if (kw.includes(word)) {
          parts.push('<span class="hl-kw">' + esc(word) + "</span>");
        } else if (next === "(") {
          parts.push('<span class="hl-fn">' + esc(word) + "</span>");
        } else if ((lang === "css" || lang === "html") && /["':(]/.test(next)) {
          parts.push('<span class="hl-attr">' + esc(word) + "</span>");
        } else if (lang === "json" && next === ":") {
          parts.push('<span class="hl-attr">' + esc(word) + "</span>");
        } else if (lang === "py" && /^[a-z_][a-z0-9_]*$/.test(word) && /["']/.test(next)) {
          parts.push('<span class="hl-str">' + esc(word) + "</span>");
        } else {
          parts.push(esc(word));
        }
        i = j; continue;
      }

      parts.push(esc(c));
      i++;
    }
    return parts.join("");
  }

  /* ---------------- inline ---------------- */

  function inline(s) {
    // s is already HTML-escaped
    const codes = [];
    // code spans first (protect them)
    s = s.replace(/`([^`\n]+)`/g, (m, c) => {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    // images (rare, skip to stay lean) — then links
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|[^"'>=])(https?:\/\/[^\s<]+[^\s<.,)])/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>");
    // bold+italic, bold, italic, strike
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // restore code
    s = s.replace(/\u0000C(\d+)\u0000/g, (m, idx) => '<code class="inline">' + esc(codes[+idx]) + "</code>");
    return s;
  }

  /* ---------------- block parser ---------------- */

  function render(src) {
    if (!src) return "";
    src = src.replace(/\r\n?/g, "\n");

    // extract fenced code blocks
    const blocks = [];
    src = src.replace(/```([\w+#.-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });
    // trailing unterminated fence (streaming)
    src = src.replace(/```([\w+#.-]*)\n?([\s\S]*)$/m, (m, lang, code) => {
      if (/^[\s]*$/.test(code)) return "";
      blocks.push({ lang: lang || "", code, open: true });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    const lines = src.split("\n");
    const out = [];
    let i = 0;

    const flushPara = (buf) => {
      if (buf.length) {
        out.push("<p>" + inline(esc(buf.join(" "))) + "</p>");
        buf.length = 0;
      }
    };
    let para = [];

    while (i < lines.length) {
      let line = lines[i];

      const bmatch = line.match(/^\u0000B(\d+)\u0000\s*$/);
      if (bmatch) {
        flushPara(para);
        out.push(codeBlockHtml(blocks[+bmatch[1]]));
        i++; continue;
      }

      if (/^\s*$/.test(line)) { flushPara(para); i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(para);
        const lvl = h[1].length;
        out.push(`<h${lvl}>` + inline(esc(h[2])) + `</h${lvl}>`);
        i++; continue;
      }

      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(para); out.push("<hr>"); i++; continue; }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        flushPara(para);
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + renderInner(buf.join("\n")) + "</blockquote>");
        continue;
      }

      // task/ul/ol list
      const liMatch = (l) => l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (liMatch(line)) {
        flushPara(para);
        const items = [];
        while (i < lines.length) {
          const m = liMatch(lines[i]);
          if (!m) break;
          items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        }
        out.push(renderList(items));
        continue;
      }

      // table
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushPara(para);
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(header, rows));
        continue;
      }

      para.push(line.trim());
      i++;
    }
    flushPara(para);
    return out.join("\n");
  }

  function renderInner(src) {
    // lightweight: paragraphs only (for blockquotes)
    const lines = src.split("\n");
    const out = [];
    let buf = [];
    for (const l of lines) {
      if (/^\s*$/.test(l)) { if (buf.length) { out.push("<p>" + buf.map((x) => inline(esc(x))).join("<br>") + "</p>"); buf = []; } }
      else buf.push(l.trim());
    }
    if (buf.length) out.push("<p>" + buf.map((x) => inline(esc(x))).join("<br>") + "</p>");
    return out.join("\n");
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  }

  function renderTable(header, rows) {
    let h = "<table><thead><tr>" + header.map((c) => "<th>" + inline(esc(c)) + "</th>").join("") + "</tr></thead><tbody>";
    for (const r of rows) h += "<tr>" + r.map((c) => "<td>" + inline(esc(c)) + "</td>").join("") + "</tr>";
    return h + "</tbody></table>";
  }

  function renderList(items) {
    let html = "";
    let i = 0;
    const walk = (indent) => {
      let body = "";
      while (i < items.length && items[i].indent >= indent) {
        if (items[i].indent > indent) {
          body += walk(items[i].indent);
          continue;
        }
        const it = items[i++];
        const task = it.text.match(/^\[([ xX])\]\s*(.*)$/);
        if (task) {
          const done = task[1] !== " ";
          body += `<li class="task${done ? " done" : ""}"><span class="cb"></span><span class="txt">${inline(esc(task[2]))}</span></li>`;
        } else {
          body += "<li>" + inline(esc(it.text)) + "</li>";
        }
      }
      const tag = items[0] && i > 0 ? (hasOrdered(items, indent) ? "ol" : "ul") : "ul";
      return `<${tag}>${body}</${tag}>`;
    };
    const hasOrdered = (arr, indent) => arr.some((x, idx) => x.indent === indent && x.ordered);
    html = walk(items[0].indent);
    return html;
  }

  function codeBlockHtml(b) {
    const lang = (b.lang || "").toLowerCase();
    const shown = lang || (b.code ? "text" : "");
    const copyId = "cb" + Math.random().toString(36).slice(2, 8);
    return (
      `<div class="codeblock" data-copy-id="${copyId}">` +
      `<div class="codeblock-head"><span class="cb-lang">${esc(shown)}</span>` +
      `<button class="cb-copy" data-copy="${copyId}" title="Copy code"><svg><use href="#i-copy"/></svg></button></div>` +
      `<pre><code>${highlight(b.code, lang)}</code></pre></div>`
    );
  }

  /* ---------------- public API ---------------- */

  window.MD = { render, highlight, esc };
})();
