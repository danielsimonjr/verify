"""Regenerates tests/fixtures/verify-skills/changes.docx (hand-written OOXML, no library).

Run: python tests/fixtures/verify-skills/make_docx_fixtures.py
The committed bytes are the source of truth for the tests; this records how they were made.
Every paragraph exists to pin one ordering or text-fidelity rule of docx_changes.ts.
"""

import zipfile
from pathlib import Path

here = Path(__file__).parent
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)
DOC_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
    "</Relationships>"
)


def run(text: str) -> str:
  return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


def del_run(text: str) -> str:
  return f'<w:r><w:delText xml:space="preserve">{text}</w:delText></w:r>'


def para(*parts: str) -> str:
  return "<w:p>" + "".join(parts) + "</w:p>"


def cstart(i: int) -> str:
  return f'<w:commentRangeStart w:id="{i}"/>'


def cend(i: int) -> str:
  return f'<w:commentRangeEnd w:id="{i}"/>'


def tracked(tag: str, i: int, author: str, date: str, inner: str) -> str:
  return f'<w:{tag} w:id="{i}" w:author="{author}" w:date="{date}">{inner}</w:{tag}>'


body = "".join(
    [
        # 1: a comment range sits BETWEEN two ordinary runs.
        para(run("Before "), cstart(0), run("anchored"), cend(0), run(" after")),
        # 2: delete, insert, delete in that order inside one paragraph.
        para(
            tracked("del", 11, "Ann", "2026-01-01T00:00:00Z", del_run("old")),
            tracked("ins", 12, "Bob", "2026-01-02T00:00:00Z", run("new")),
            tracked("del", 13, "Cy", "2026-01-03T00:00:00Z", del_run("gone")),
        ),
        # 3: text that must survive as written: leading/trailing spaces and a number.
        para(
            tracked(
                "ins", 14, "Dee", "2026-01-04T00:00:00Z", run("Total ") + run("42") + run(" units")
            )
        ),
        # 4: two overlapping comment ranges (1 starts first, 2 ends last).
        para(
            cstart(1), run("one "), cstart(2), run("two"), cend(1), run(" three"), cend(2)
        ),
        # 5: a tracked insertion that holds a comment range between its runs.
        para(
            tracked(
                "ins",
                15,
                "Eve",
                "2026-01-05T00:00:00Z",
                run("x") + cstart(3) + run("y") + cend(3) + run("z"),
            )
        ),
    ]
)
DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
)


def comment(i: int, author: str, text: str) -> str:
  return (
      f'<w:comment w:id="{i}" w:author="{author}" w:date="2026-02-0{i + 1}T00:00:00Z">'
      f"<w:p>{run(text)}</w:p></w:comment>"
  )


COMMENTS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:comments xmlns:w="{W}">'
    + comment(0, "Fay", "first")
    + comment(1, "Gus", "second")
    + comment(2, "Hal", "third")
    + comment(3, "Ivy", "fourth")
    + "</w:comments>"
)

PARTS = [
    ("[Content_Types].xml", CONTENT_TYPES),
    ("_rels/.rels", RELS),
    ("word/_rels/document.xml.rels", DOC_RELS),
    ("word/document.xml", DOCUMENT),
    ("word/comments.xml", COMMENTS),
]

with zipfile.ZipFile(here / "changes.docx", "w", zipfile.ZIP_DEFLATED) as z:
  for name, data in PARTS:
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data.encode("utf-8"))
