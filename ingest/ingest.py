"""Load knowledge/ into the Supabase `documents` table. Run from the repo root.
python ingest/ingest.py [--dry-run: chunk only | --check: query-time embedding sanity test]
Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (never commit it)."""
import hashlib
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE = ROOT / "knowledge"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".bmp", ".tif", ".tiff", ".ico"}
MAX_CHARS, OVERLAP, MIN_CHARS, BATCH = 2800, 300, 200, 100


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def clean(md):
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)                      # images
    md = re.sub(r"\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)", r"\1", md)    # links -> link text
    md = re.sub(r"<https?://[^>]+>", "", md)
    md = re.sub(r"(?m)^\s*[*-]?\s*https?://\S+\s*$", "", md)            # URL-only lines
    md = re.sub(r"https?://\S*[?&](utm_|ref=|fbclid|gclid|mc_)\S*", "", md)  # tracking links
    return re.sub(r"\n{3,}", "\n\n", md).strip()


def strip_marks(s):
    return re.sub(r"<[^>]+>|[*_`]", "", s).strip()


def topic_for(rel):
    n = rel.lower()
    if "greenhouse" in n or "parse" in n:
        return "ats"
    if "intro" in n or "demonstration" in n or "xyz" in n or "veterans" in n:
        return "bullets"
    if "huntr" in n or "hiring-insights" in n or "algorithmic" in n or n.endswith(".pdf"):
        return "research"
    return "general"


def split_long(text):
    parts, start = [], 0
    while start < len(text):
        end = min(start + MAX_CHARS, len(text))
        if end < len(text):  # prefer to cut at a paragraph, then a sentence
            cut = max(text.rfind("\n\n", start, end), text.rfind(". ", start, end))
            if cut > start + MAX_CHARS // 2:
                end = cut + 1
        parts.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - OVERLAP, start + 1)
    return parts


def chunk(md, title):
    sections, heading, buf = [], title, []
    for line in md.splitlines():
        m = re.match(r"^#{1,6}\s+(.*)", line)
        if m:
            sections.append((heading, "\n".join(buf).strip()))
            heading, buf = strip_marks(m.group(1)) or heading, []
        else:
            buf.append(line)
    sections.append((heading, "\n".join(buf).strip()))
    merged = []  # merge sections under MIN_CHARS into the previous one
    for h, body in [x for x in sections if x[1] and not re.match(r"(?i)(references|bibliography)\b", x[0])]:
        if merged and len(body) < MIN_CHARS:
            merged[-1] = (merged[-1][0], merged[-1][1] + f"\n\n{h}\n{body}")
        else:
            merged.append((h, body))
    if len(merged) > 1 and len(merged[0][1]) < MIN_CHARS:  # a short opening joins the next section
        first = merged.pop(0)
        merged[0] = (merged[0][0], first[1] + "\n\n" + merged[0][1])
    return [(h, part) for h, body in merged for part in split_long(body)]


def read_file(path):
    if path.suffix.lower() == ".pdf":
        import pymupdf4llm
        return pymupdf4llm.to_markdown(str(path))
    return path.read_text(encoding="utf-8", errors="replace")


def collect():
    rows, files, skipped = [], 0, 0
    for path in sorted(KNOWLEDGE.rglob("*")):
        if path.is_dir() or "images" in path.relative_to(KNOWLEDGE).parts:
            continue
        if path.suffix.lower() in IMAGE_EXT or path.suffix.lower() not in {".md", ".txt", ".pdf"}:
            skipped += 1
            continue
        rel = path.relative_to(KNOWLEDGE).as_posix()
        md = clean(read_file(path))
        h1 = re.search(r"(?m)^#\s+(.+)$", md)
        title = strip_marks(h1.group(1)) if h1 else path.stem
        files += 1
        for i, (heading, text) in enumerate(chunk(md, title)):
            content = f"{title} > {heading}\n\n{text}"
            rows.append({"source": rel, "title": title, "heading": heading, "topic": topic_for(rel),
                         "chunk_index": i, "content": content,
                         "content_hash": hashlib.sha256((rel + content).encode()).hexdigest()})
    return rows, files, skipped


def api(method, path, body=None, params=None):
    import requests
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    r = requests.request(method, os.environ["SUPABASE_URL"].rstrip("/") + path, params=params, json=body,
                         timeout=120, headers={"apikey": key, "Authorization": f"Bearer {key}",
                                               "Prefer": "resolution=merge-duplicates,return=minimal"})
    r.raise_for_status()
    return r.json() if r.text else None


def main():
    load_env()
    rows, files, skipped = collect()
    print(f"files: {files}  chunks: {len(rows)}  skipped: {skipped}")
    if "--dry-run" in sys.argv:
        return [print(f"  [{r['topic']:8}] {r['source']} #{r['chunk_index']} {len(r['content'])} chars") for r in rows]
    if "--check" in sys.argv:
        res = api("POST", "/functions/v1/rag-check", {"text": rows[0]["content"], "content_hash": rows[0]["content_hash"]})
        print(res)
        sys.exit(0 if res.get("ok") else 1)
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("thenlper/gte-small")
    vecs = model.encode([r["content"] for r in rows], normalize_embeddings=True, batch_size=32, show_progress_bar=True)
    for r, v in zip(rows, vecs):
        r["embedding"] = "[" + ",".join(f"{x:.7f}" for x in v) + "]"
    for i in range(0, len(rows), BATCH):
        api("POST", "/rest/v1/documents", rows[i:i + BATCH], params={"on_conflict": "content_hash"})
    keep = {r["content_hash"] for r in rows}
    stale = [d["id"] for d in api("GET", "/rest/v1/documents", params={"select": "id,content_hash", "limit": 10000})
             if d["content_hash"] not in keep]
    for i in range(0, len(stale), BATCH):
        api("DELETE", "/rest/v1/documents", params={"id": f"in.({','.join(map(str, stale[i:i + BATCH]))})"})
    print(f"upserted: {len(rows)}  deleted stale: {len(stale)}")


if __name__ == "__main__":
    main()
