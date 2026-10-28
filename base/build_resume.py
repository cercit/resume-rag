"""Build a tailored resume PDF from a job folder's resume.json, then check it.

Usage:  python build_resume.py jobs/<job-folder>

Reads   jobs/<job-folder>/resume.json  (and jd.txt for the keyword check)
Writes  resume.html, <file_name>.pdf and check-report.md in the same folder.

Checks: 2 pages max (tightens spacing up to 4 times), JD keywords found,
forbidden phrases, banned AI words, em dashes.
"""
import html
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Fictional example person. Replace these constants with your own details.
NAME = "Asha Verma"
COMPANY_LINE = "Northwind Finance Ltd · 8 years"
CONTACT = ('Bengaluru | +91 90000 00000 | <a href="mailto:asha.verma@example.com">asha.verma@example.com</a> | '
           '<a href="https://linkedin.com/in/asha-verma-example">linkedin.com/in/asha-verma-example</a> | '
           '<a href="https://asha-verma.example.com">asha-verma.example.com</a>')
EDUCATION = [
    ("Certificate, Business Analytics", "Jan 2026 – Jun 2026", "Example Institute of Management, Bengaluru"),
    ("Bachelor of Commerce (B.Com)", "2014 – 2017, First Class", "Example College of Commerce, Mysuru"),
]
CERTS = ("SQL Basics (Example Academy, 2025) · Power BI Data Analyst (Example Academy, 2024) · "
         "Python for Data Analysis (Example Academy, 2024)")
LANGUAGES = "Kannada (native), English (professional working), Hindi (professional working)"
HOBBIES = "Running, chess"

# Phrases this person must never use about themselves (example list; adjust to your own rules).
FORBIDDEN = ["owned the", "led a team", "managed a team"]
BANNED = re.compile(r"\b(delve\w*|leverag\w*|utili[sz]\w*|facilitat\w*|comprehensive|robust|seamless\w*|cutting-edge|"
                    r"innovative|game-changer|revolutioni[sz]\w*|empower\w*|harness\w*|paradigm|synerg\w*|foster\w*|"
                    r"spearhead\w*|bolster\w*|crucial|vital|pivotal|showcas\w*|tapestry|testament|underscor\w*|"
                    r"passionate|dynamic|results-driven|go-getter|proven track record)\b", re.I)

# spacing steps: (line-height, section gap px, top margin mm)
STEPS = [(1.38, 11, 14), (1.33, 9, 12), (1.30, 8, 11), (1.27, 7, 10), (1.24, 6, 9)]

e = html.escape


def link(url):
    href = url if url.startswith("http") else "https://" + url
    return f'<a href="{e(href)}">{e(url)}</a>'


def render(d, step):
    lh, gap, top = step
    css = f"""
@page {{ size: A4; margin: {top}mm 15mm 11mm 15mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: Calibri, Carlito, Arial, sans-serif; color: #111; font-size: 9.4pt; line-height: {lh}; margin: 0; }}
h1 {{ font-size: 21pt; margin: 0 0 3px; }}
.role {{ font-weight: bold; margin: 0; }}
.contact {{ color: #333; font-size: 9pt; margin: 1px 0 0; }}
a {{ color: #0b57b0; }}
h2 {{ font-size: 10pt; letter-spacing: 2.2px; text-transform: uppercase; margin: {gap}px 0 {max(3, gap // 2)}px; padding-bottom: 3px; border-bottom: 1px solid #bbb; }}
p {{ margin: 0 0 3px; }}
.row {{ display: flex; justify-content: space-between; gap: 12px; font-weight: bold; margin: 6px 0 2px; }}
.row span:last-child {{ font-weight: normal; color: #333; white-space: nowrap; }}
ul {{ margin: 2px 0 3px 18px; padding: 0; }}
li {{ margin-bottom: 2px; }}
.co {{ font-weight: bold; margin: 5px 0 3px; }}
.keep {{ break-inside: avoid; }}
"""
    out = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Resume {NAME}</title><style>{css}</style></head><body>",
           f"<h1>{NAME}</h1>",
           f"<p class='role'>{e(d.get('role_line', ''))}</p>",
           f"<p class='contact'>{CONTACT}</p>",
           "<h2>Summary</h2>", *[f"<p>{e(x)}</p>" for x in d["summary"]],
           "<h2>Skills</h2>", *[f"<p><b>{e(k)}:</b> {e(v)}</p>" for k, v in d["skills"]],
           "<h2>Tools</h2>", f"<p>{e(d['tools'])}</p>"]

    def experience():
        o = ["<h2>Experience</h2>", f"<p class='co'>{COMPANY_LINE}</p>"]
        for j in d["experience"]:
            o.append("<div class='keep'>")
            o.append(f"<div class='row'><span>{e(j['title'])}</span><span>{e(j['dates'])}</span></div>")
            if j.get("intro"):
                o.append(f"<p>{e(j['intro'])}</p>")
            if j.get("bullets"):
                o.append("<ul>" + "".join(f"<li>{e(b)}</li>" for b in j["bullets"]) + "</ul>")
            o.append("</div>")
        return o

    def portfolio():
        o = ["<h2>Portfolio</h2>"]
        for p in d["portfolio"]:
            o.append("<div class='keep'>")
            o.append(f"<div class='row'><span>{e(p['name'])}</span><span>{e(p.get('date', ''))}</span></div>")
            if p.get("link"):
                o.append(f"<p>{link(p['link'])}</p>")
            o.append("<ul>" + "".join(f"<li>{e(b)}</li>" for b in p["bullets"]) + "</ul></div>")
        return o

    order = d.get("order", ["experience", "portfolio"])
    for part in order:
        out += experience() if part == "experience" else portfolio()
    out.append("<h2>Education</h2>")
    for title, dates, place in EDUCATION:
        out.append(f"<div class='row'><span>{e(title)}</span><span>{e(dates)}</span></div><p>{e(place)}</p>")
    out += ["<h2>Certifications</h2>", f"<p>{e(d.get('certifications', CERTS))}</p>",
            "<h2>Languages</h2>", f"<p>{LANGUAGES}</p>", "<h2>Hobbies</h2>", f"<p>{HOBBIES}</p>", "</body></html>"]
    return "\n".join(out)


def main(folder):
    folder = Path(folder).resolve()
    d = json.loads((folder / "resume.json").read_text(encoding="utf-8"))
    pdf = folder / f"{d['file_name']}.pdf"
    page_html = folder / "resume.html"
    pages = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for step in STEPS:
            page_html.write_text(render(d, step), encoding="utf-8")
            page = browser.new_page()
            page.goto(page_html.as_uri())
            page.wait_for_timeout(300)
            page.pdf(path=str(pdf), format="A4", print_background=True, prefer_css_page_size=True)
            page.close()
            import pymupdf
            doc = pymupdf.open(str(pdf))
            pages = len(doc)
            text = "\n".join(pg.get_text() for pg in doc)
            doc.close()
            if pages <= 2:
                break
        browser.close()

    flat = re.sub(r"\s+", " ", text)
    report = [f"# Check report: {d['file_name']}", "", f"- Pages: **{pages}** {'OK' if pages <= 2 else 'OVER 2 PAGES: cut content'}"]
    kws = d.get("jd_keywords", [])
    hit = [k for k in kws if k.lower() in flat.lower()]
    miss = [k for k in kws if k.lower() not in flat.lower()]
    report.append(f"- JD keywords found: **{len(hit)}/{len(kws)}**")
    if miss:
        report.append(f"- Missing keywords: {', '.join(miss)}")
    forb = [f for f in FORBIDDEN if f.lower() in flat.lower()]
    report.append(f"- Forbidden phrases: {', '.join(forb) if forb else 'none'}")
    banned = sorted({m.group(0).lower() for m in BANNED.finditer(flat)})
    report.append(f"- Banned AI words: {', '.join(banned) if banned else 'none'}")
    report.append(f"- Em dashes: {flat.count('—')}")
    (folder / "check-report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))
    print("PDF:", pdf)
    ok = pages <= 2 and not forb and not banned
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv[1])
