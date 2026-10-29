// Port of render() from base/build_resume.py: same HTML, same CSS, same spacing steps.
// Personal details (contact, education, certifications, languages, hobbies, company) come from the data.
(function (global) {
  "use strict";

  // spacing steps: [line-height, section gap px, top margin mm]
  var STEPS = [[1.38, 11, 14], [1.33, 9, 12], [1.30, 8, 11], [1.27, 7, 10], [1.24, 6, 9]];

  // same as Python's html.escape (quote=True)
  function e(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }

  function link(url) {
    var href = /^http/.test(url) ? url : "https://" + url;
    return '<a href="' + e(href) + '">' + e(url) + "</a>";
  }

  function num(x) {
    // Python prints 1.30 as 1.3
    return String(Number(x));
  }

  function contactLine(c) {
    var parts = [];
    if (c.location) parts.push(e(c.location));
    if (c.phone) parts.push(e(c.phone));
    if (c.email) parts.push('<a href="mailto:' + e(c.email) + '">' + e(c.email) + "</a>");
    (c.links || []).forEach(function (l) {
      var href = /^(https?:|mailto:)/.test(l.url) ? l.url : "https://" + l.url;
      parts.push('<a href="' + e(href) + '">' + e(l.label || l.url) + "</a>");
    });
    return parts.join(" | ");
  }

  function css(step) {
    var lh = step[0], gap = step[1], top = step[2];
    return "\n" +
      "@page { size: A4; margin: " + top + "mm 15mm 11mm 15mm; }\n" +
      "* { box-sizing: border-box; }\n" +
      // ligatures off: Chrome printed "fi" as "f i" (e.g. "Certi fi cation") in the first real PDF, 29 Oct 2026
      "body { font-family: Calibri, Carlito, Arial, sans-serif; font-variant-ligatures: none; font-feature-settings: \"liga\" 0, \"clig\" 0; color: #111; font-size: 9.4pt; line-height: " + num(lh) + "; margin: 0; }\n" +
      "h1 { font-size: 21pt; margin: 0 0 3px; }\n" +
      ".role { font-weight: bold; margin: 0; }\n" +
      ".contact { color: #333; font-size: 9pt; margin: 1px 0 0; }\n" +
      "a { color: #0b57b0; }\n" +
      "h2 { font-size: 10pt; letter-spacing: 2.2px; text-transform: uppercase; margin: " + gap + "px 0 " + Math.max(3, Math.floor(gap / 2)) + "px; padding-bottom: 3px; border-bottom: 1px solid #bbb; }\n" +
      "p { margin: 0 0 3px; }\n" +
      ".row { display: flex; justify-content: space-between; gap: 12px; font-weight: bold; margin: 6px 0 2px; }\n" +
      ".row span:last-child { font-weight: normal; color: #333; white-space: nowrap; }\n" +
      "ul { margin: 2px 0 3px 18px; padding: 0; }\n" +
      "li { margin-bottom: 2px; }\n" +
      ".co { font-weight: bold; margin: 5px 0 3px; }\n" +
      ".keep { break-inside: avoid; }\n";
  }

  function render(d, step) {
    step = step || STEPS[0];
    var c = d.contact || {};
    var out = ["<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Resume " + e(c.name) + "</title><style>" + css(step) + "</style></head><body>",
      "<h1>" + e(c.name) + "</h1>",
      "<p class='role'>" + e(d.role_line) + "</p>",
      "<p class='contact'>" + contactLine(c) + "</p>"];
    if ((d.summary || []).length) {
      out.push("<h2>Summary</h2>");
      d.summary.forEach(function (x) { out.push("<p>" + e(x) + "</p>"); });
    }
    if ((d.skills || []).length) {
      out.push("<h2>Skills</h2>");
      d.skills.forEach(function (kv) { out.push("<p><b>" + e(kv[0]) + ":</b> " + e(kv[1]) + "</p>"); });
    }
    if (d.tools) out.push("<h2>Tools</h2>", "<p>" + e(d.tools) + "</p>");

    function experience() {
      if (!(d.experience || []).length) return [];
      var o = ["<h2>Experience</h2>"], last = null;
      d.experience.forEach(function (j) {
        // one company line per run of jobs at the same company
        if (j.company && j.company !== last) o.push("<p class='co'>" + e(j.company) + "</p>");
        last = j.company;
        o.push("<div class='keep'>");
        o.push("<div class='row'><span>" + e(j.title) + "</span><span>" + e(j.dates) + "</span></div>");
        if (j.intro) o.push("<p>" + e(j.intro) + "</p>");
        if ((j.bullets || []).length) o.push("<ul>" + j.bullets.map(function (b) { return "<li>" + e(b) + "</li>"; }).join("") + "</ul>");
        o.push("</div>");
      });
      return o;
    }

    function portfolio() {
      if (!(d.portfolio || []).length) return [];
      var o = ["<h2>Portfolio</h2>"];
      d.portfolio.forEach(function (p) {
        o.push("<div class='keep'>");
        o.push("<div class='row'><span>" + e(p.name) + "</span><span>" + e(p.date || "") + "</span></div>");
        if (p.link) o.push("<p>" + link(p.link) + "</p>");
        o.push("<ul>" + (p.bullets || []).map(function (b) { return "<li>" + e(b) + "</li>"; }).join("") + "</ul></div>");
      });
      return o;
    }

    (d.order || ["experience", "portfolio"]).forEach(function (part) {
      out = out.concat(part === "experience" ? experience() : portfolio());
    });
    if ((d.education || []).length) {
      out.push("<h2>Education</h2>");
      d.education.forEach(function (x) {
        out.push("<div class='row'><span>" + e(x.title) + "</span><span>" + e(x.dates) + "</span></div><p>" + e(x.place) + "</p>");
      });
    }
    if (d.certifications) out.push("<h2>Certifications</h2>", "<p>" + e(d.certifications) + "</p>");
    if (d.languages) out.push("<h2>Languages</h2>", "<p>" + e(d.languages) + "</p>");
    if (d.hobbies) out.push("<h2>Hobbies</h2>", "<p>" + e(d.hobbies) + "</p>");
    out.push("</body></html>");
    return out.join("\n");
  }

  // Page count the way print will lay it out: A4 content height per page, and a .keep block
  // that would cross a page edge moves whole to the next page.
  var MM = 96 / 25.4;
  function countPages(doc, step) {
    var pageH = (297 - step[2] - 11) * MM;
    var pages = 1, pageEnd = pageH;
    var blocks = doc.body.children;
    for (var i = 0; i < blocks.length; i++) {
      var r = blocks[i].getBoundingClientRect();
      var top = r.top + doc.defaultView.scrollY, bottom = top + r.height;
      if (bottom <= pageEnd) continue;
      // Oversized sections cannot stay together on one sheet. Count every page
      // they cross so a long job history cannot falsely pass the two-page fit.
      if ((blocks[i].className === "keep" && r.height <= pageH) || r.height < 40) {
        pages++;
        pageEnd = top + pageH;
      } else {
        while (bottom > pageEnd) { pages++; pageEnd += pageH; }
      }
    }
    return pages;
  }

  // Render into an iframe and step through STEPS until it fits on 2 pages.
  // For measuring, the body is set as wide as the A4 content box (210mm - 30mm). print() takes
  // that width off again, so the printed page is exactly build_resume.py's document.
  var MEASURE_BODY = "<body style='width:180mm'>";
  function fit(iframe, d) {
    return new Promise(function (resolve) {
      var i = 0;
      function tryStep() {
        var step = STEPS[i];
        iframe.onload = function () {
          var doc = iframe.contentDocument;
          var go = function () {
            var pages = countPages(doc, step);
            if (pages <= 2 || i === STEPS.length - 1) {
              doc.title = d.file_name || doc.title;
              resolve({ pages: pages, step: i, fits: pages <= 2 });
            } else { i++; tryStep(); }
          };
          if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(go); else go();
        };
        iframe.srcdoc = render(d, step).replace("<body>", MEASURE_BODY);
      }
      tryStep();
    });
  }

  function print(iframe) {
    var body = iframe.contentDocument.body;
    var style = body.getAttribute("style");
    body.removeAttribute("style");
    var win = iframe.contentWindow;
    var restore = function () { if (style) body.setAttribute("style", style); win.removeEventListener("afterprint", restore); };
    win.addEventListener("afterprint", restore);
    win.focus();
    win.print();
  }

  var api = { STEPS: STEPS, render: render, countPages: countPages, fit: fit, print: print, escape: e };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ResumeRender = api;
})(typeof window !== "undefined" ? window : globalThis);
