"""Offline tests for ingest/ingest.py (no network, no Supabase). Run: python3 tests/test_ingest.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))
import ingest as ing  # noqa: E402


def test_clean():
    md = "Intro ![chart](images/a.png) see [Greenhouse](https://x.io/a?b=1) now\nhttps://t.co/abc\nkeep https://x.io/p?utm_source=n end"
    out = ing.clean(md)
    assert "![" not in out and "images/" not in out
    assert "see Greenhouse now" in out
    assert "t.co" not in out and "utm_" not in out
    assert out.endswith("end")


def test_topics():
    assert ing.topic_for("greenhouse-resume-parse/x.md") == "ats"
    assert ing.topic_for("huntr-job-search-trends-q2-2026/x.md") == "research"
    assert ing.topic_for("resumegenius-hiring-insights-report/hiring-insights-report.md") == "research"
    assert ing.topic_for("2601.13286v2.pdf") == "research"
    assert ing.topic_for("Intro.md") == "bullets"
    assert ing.topic_for("[210 Shared] AI Skills Demonstration.md") == "bullets"
    assert ing.topic_for("resume-writing-tips-for-veterans-2021.pdf") == "bullets"
    assert ing.topic_for("notes/other.txt") == "general"


def test_chunking():
    long_body = ("This is a sentence about resumes. " * 300).strip()
    md = f"# Title\n\n## Small\nshort bit\n\n## Long\n{long_body}\n\n## References\nA. Author 2020."
    chunks = ing.chunk(md, "Title")
    heads = [h for h, _ in chunks]
    assert "References" not in heads
    assert all(len(t) <= ing.MAX_CHARS for _, t in chunks)
    longs = [t for h, t in chunks if h == "Long"]
    assert len(longs) >= 4
    assert longs[0][-100:].strip()[:40] in longs[1] or longs[1][:50] in longs[0]  # overlap kept
    assert "short bit" not in heads and any("short bit" in t for _, t in chunks)  # small section merged


def test_real_corpus():
    rows, files, skipped = ing.collect()
    assert files == 9 and skipped == 0
    assert len(rows) > 100
    assert len({r["content_hash"] for r in rows}) == len(rows), "duplicate hashes"
    assert all(len(r["content"]) >= 100 for r in rows)
    assert not any("![" in r["content"] for r in rows)
    rows2, _, _ = ing.collect()
    assert [r["content_hash"] for r in rows] == [r["content_hash"] for r in rows2], "not deterministic"
    print(f"corpus: {files} files, {len(rows)} chunks")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
