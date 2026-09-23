#!/usr/bin/env python3
"""Extrage subiecții sancționați din deciziile CIS (PDF) în dataset/.

Folosește pdftotext -bbox-layout (Poppler) ca să reconstruiască coloanele
tabelelor după coordonate. Deciziile scanate trec prin Tesseract.
Rulează local; site-ul static citește doar JSON-ul rezultat.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DATASET = ROOT / "dataset"
DETAILS = DATASET / "details"

AMENDMENTS = {18, 25, 28, 29, 30, 33, 39, 44, 47, 48, 52}
ALIGNMENTS = {23, 31, 35, 37}
REPEALED = {3}

MONTHS = {
    "ianuarie": 1,
    "februarie": 2,
    "martie": 3,
    "aprilie": 4,
    "mai": 5,
    "iunie": 6,
    "iulie": 7,
    "august": 8,
    "septembrie": 9,
    "octombrie": 10,
    "noiembrie": 11,
    "decembrie": 12,
}

CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "j", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "t", "ч": "c", "ш": "s", "щ": "s", "ъ": "",
    "ы": "i", "ь": "", "э": "e", "ю": "iu", "я": "ia", "і": "i", "ї": "i",
    "є": "e", "ґ": "g",
}


def fold(text: str) -> str:
    text = text or ""
    text = text.replace("ș", "s").replace("ş", "s").replace("ț", "t").replace("ţ", "t")
    text = text.replace("ă", "a").replace("â", "a").replace("î", "i")
    text = text.replace("Ș", "s").replace("Ş", "s").replace("Ț", "t").replace("Ţ", "t")
    text = text.replace("Ă", "a").replace("Â", "a").replace("Î", "i")
    out = []
    for ch in text.lower():
        if "\u0400" <= ch <= "\u04ff":
            out.append(CYR.get(ch, ""))
        else:
            out.append(ch)
    text = "".join(out)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_ws(text: str) -> str:
    text = text.replace("\u00ad", "")
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)
    text = text.replace("~i", "și").replace("~I", "Și")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def iso_date(day: int, month: int, year: int) -> str | None:
    if year < 100:
        year += 1900 if year > 30 else 2000
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def parse_numeric_date(raw: str) -> str | None:
    m = re.search(r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})", raw or "")
    if not m:
        return None
    return iso_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_ro_date(text: str) -> str | None:
    m = re.search(
        r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s+(\d{4})",
        fold(text),
    )
    if not m:
        return None
    return iso_date(int(m.group(1)), MONTHS[m.group(2)], int(m.group(3)))


def decision_number_from_name(name: str) -> int | None:
    m = re.search(r"(?:nr\.?\s*|cis\s+)(\d{1,3})", name, re.I)
    return int(m.group(1)) if m else None


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True)
    return proc.stdout.decode("utf-8", errors="replace")


def pdf_text(path: Path, first: int | None = None, last: int | None = None) -> str:
    cmd = ["pdftotext", "-layout"]
    if first:
        cmd += ["-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    cmd += [str(path), "-"]
    return run(cmd)


def pdf_pages(path: Path) -> int:
    info = run(["pdfinfo", str(path)])
    m = re.search(r"^Pages:\s+(\d+)", info, re.M)
    return int(m.group(1)) if m else 0


def ocr_pdf(path: Path) -> str:
    if not shutil.which("pdftoppm") or not shutil.which("tesseract"):
        return ""
    chunks: list[str] = []
    with tempfile.TemporaryDirectory(prefix="cis-ocr-") as tmp:
        prefix = str(Path(tmp) / "page")
        subprocess.run(["pdftoppm", "-png", "-r", "200", str(path), prefix], check=False)
        for image in sorted(Path(tmp).glob("page-*.png")):
            text = run(["tesseract", str(image), "stdout", "-l", "ron+rus+eng", "--psm", "6"])
            chunks.append(text)
    return "\n\n".join(chunks)


class Word:
    def __init__(self, x0: float, y0: float, x1: float, y1: float, text: str):
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1
        self.text = text


def parse_bbox_pages(path: Path) -> list[dict]:
    raw = run(["pdftotext", "-bbox-layout", str(path), "-"])
    pages = []
    for pm in re.finditer(
        r'<page width="([\d.]+)" height="([\d.]+)"(.*?)</page>', raw, re.S
    ):
        words: list[Word] = []
        for wm in re.finditer(
            r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>',
            pm.group(3),
            re.S,
        ):
            text = html.unescape(wm.group(5)).strip()
            if not text:
                continue
            words.append(
                Word(float(wm.group(1)), float(wm.group(2)), float(wm.group(3)), float(wm.group(4)), text)
            )
        pages.append(
            {
                "width": float(pm.group(1)),
                "height": float(pm.group(2)),
                "rows": cluster_rows(words),
            }
        )
    return pages


def cluster_rows(words: list[Word]) -> list[list[Word]]:
    if not words:
        return []
    ordered = sorted(words, key=lambda w: (w.y0, w.x0))
    rows: list[list[Word]] = []
    current: list[Word] = [ordered[0]]
    anchor = ordered[0].y0
    for word in ordered[1:]:
        if word.y0 - anchor > 3.2:
            rows.append(sorted(current, key=lambda w: w.x0))
            current = [word]
            anchor = word.y0
        else:
            current.append(word)
            anchor = min(anchor, word.y0) if abs(word.y0 - anchor) < 1 else anchor
    rows.append(sorted(current, key=lambda w: w.x0))
    return rows


def row_text(row: list[Word]) -> str:
    return clean_ws(" ".join(w.text for w in row))


def find_header(rows: list[list[Word]]) -> int | None:
    for i, row in enumerate(rows):
        folded = [fold(w.text) for w in row]
        has_name = any(w == "nume" or w == "numele" for w in folded)
        has_rest = any(w.startswith("informa") or w.startswith("motiv") or w == "identificare" for w in folded)
        if has_name and has_rest:
            return i
    return None


def header_anchors(header_row: list[Word]) -> list[tuple[str, float]]:
    found: dict[str, float] = {}
    for word in header_row:
        folded = fold(word.text)
        if folded in {"nume", "numele"} and "name" not in found:
            found["name"] = word.x0
        elif folded.startswith("informa") and "info" not in found:
            found["info"] = word.x0
        elif folded.startswith("motiv") and "motive" not in found:
            found["motive"] = word.x0
        elif folded == "data" and "date" not in found:
            found["date"] = word.x0
    return [(key, found[key]) for key in ("name", "info", "motive", "date") if key in found]


def column_starts(row: list[Word]) -> list[float]:
    """Pozițiile unde începe un bloc de text, după un spațiu mare între coloane."""
    if not row:
        return []
    starts = [row[0].x0]
    prev = row[0]
    for word in row[1:]:
        if word.x0 - prev.x1 >= 11:
            starts.append(word.x0)
        prev = word
    return starts


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def edges_from_header(header_row: list[Word], body_rows: list[list[Word]], page_width: float) -> list[float]:
    """Textul din celule este aliniat la stânga, iar cuvântul din antet stă
    adesea mai la dreapta. Marginea coloanei este începutul de celulă cel mai
    frecvent, în imediata stângă a etichetei din antet."""
    anchors = header_anchors(header_row)
    if not any(key == "info" for key, _ in anchors) or not any(key == "motive" for key, _ in anchors):
        return []
    edges: list[float] = []
    for key, anchor_x in anchors:
        window_lo = 28 if key == "name" else anchor_x - 90
        window_hi = min(anchor_x + 14, page_width)
        xs: list[float] = []
        for row in body_rows:
            for start in column_starts(row):
                if window_lo <= start <= window_hi:
                    xs.append(start)
                    break
        if len(xs) < 3:
            edge = anchor_x - 28
        else:
            xs.sort()
            clusters: list[list[float]] = [[xs[0]]]
            for value in xs[1:]:
                if value - clusters[-1][-1] <= 8:
                    clusters[-1].append(value)
                else:
                    clusters.append([value])
            clusters.sort(key=len, reverse=True)
            edge = _median(clusters[0])
        if not edges or edge - edges[-1] >= 24:
            edges.append(edge)
    return edges


INFO_LABELS = {
    "functia",
    "functie",
    "cetatenie",
    "cetatenia",
    "sexul",
    "adresa",
    "grad",
    "titlu",
    "pozitie",
    "nationalitate",
}


def snap_info_edge(rows: list[list[Word]], edges: list[float]) -> list[float]:
    """Unele pagini mută coloana de identificare la stânga față de antet.
    Etichetele aliniate (Funcția, Cetățenie) marchează începutul ei real."""
    if len(edges) < 3:
        return edges
    xs: list[float] = []
    for row in rows:
        for index, word in enumerate(row):
            token = fold(word.text).strip(":")
            if token in INFO_LABELS or (token == "data" and index + 1 < len(row) and fold(row[index + 1].text).startswith("naster")):
                xs.append(word.x0)
                break
    if len(xs) < 3:
        return edges
    xs.sort()
    clusters: list[list[float]] = [[xs[0]]]
    for value in xs[1:]:
        if value - clusters[-1][-1] <= 8:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    clusters.sort(key=len, reverse=True)
    if len(clusters[0]) < 3:
        return edges
    edge = _median(clusters[0]) - 4
    if not (edges[0] + 36 < edge < edges[2] - 24):
        return edges
    if abs(edge - edges[1]) <= 10:
        return edges
    return [edges[0], edge, *edges[2:]]


def is_footnote_row(row: list[Word], page_width: float, edges: list[float]) -> bool:
    """Paragraf pe toată lățimea, care nu se aliniază cu coloanele tabelului."""
    if len(row) < 6 or not edges:
        return False
    if row[-1].x1 - row[0].x0 < page_width * 0.62:
        return False
    hits = sum(1 for edge in edges if any(abs(word.x0 - edge) <= 12 for word in row))
    return hits < 2


def column_edges(rows: list[list[Word]]) -> list[float]:
    starts: list[float] = []
    for row in rows:
        if len(row) < 4:
            continue
        starts.append(row[0].x0)
        prev = row[0]
        for word in row[1:]:
            if word.x0 - prev.x1 >= 13:
                starts.append(word.x0)
            prev = word
    if not starts:
        return []
    starts.sort()
    clusters: list[list[float]] = [[starts[0]]]
    for value in starts[1:]:
        if value - clusters[-1][-1] > 18:
            clusters.append([value])
        else:
            clusters[-1].append(value)
    ranked = []
    for cluster in clusters:
        if len(cluster) < 4:
            continue
        cluster.sort()
        ranked.append((len(cluster), cluster[len(cluster) // 2]))
    ranked.sort(key=lambda item: -item[0])
    if not ranked:
        return []
    cutoff = max(4, ranked[0][0] * 0.18)
    edges = sorted(edge for count, edge in ranked if count >= cutoff)
    # Drop edges that sit inside a column (closer than 28px).
    kept: list[float] = []
    for edge in edges:
        if not kept or edge - kept[-1] >= 28:
            kept.append(edge)
        elif True:
            # keep the one that appeared more often; already sorted by x, prefer the earlier
            pass
    return kept[:5]


def split_columns(row: list[Word], edges: list[float]) -> list[str]:
    buckets = [[] for _ in edges]
    for word in row:
        idx = 0
        for i, edge in enumerate(edges):
            if word.x0 + 5 >= edge:
                idx = i
        buckets[idx].append(word.text)
    return [clean_ws(" ".join(parts)) for parts in buckets]


def section_type(text: str) -> str | None:
    folded = fold(text)
    if len(folded) > 140 or len(folded) < 8:
        return None
    if not re.match(r"^[a-z]\b|^i{1,3}\b|^iv\b", folded):
        return None
    if any(token in folded for token in ("naster", "funct", "idnp", "pasaport", "buletin")):
        return None
    if "nave" in folded or "vasel" in folded:
        return "vessel"
    if any(token in folded for token in ("juridic", "entit", "organism", "organiza")):
        return "entity"
    if "persoan" in folded or "fizic" in folded:
        return "person"
    return None


def is_column_index_row(cols: list[str]) -> bool:
    bits = [fold(c) for c in cols if fold(c)]
    return bool(bits) and all(re.fullmatch(r"\d{1,2}", bit) for bit in bits)


def is_junk_line(text: str) -> bool:
    folded = fold(text)
    if folded in {"anexa", "lista", "crt"}:
        return True
    if re.fullmatch(r"\d{1,4}", folded):
        return True
    return False


def drop_footnote(name: str) -> str:
    """Scoate o paranteză rămasă deschisă și marcajul de notă „1”.
    Nu taie un număr care face parte din nume, cum este „Tzav 9”."""
    name = name.strip(" ,;")
    if name.endswith("(") and name.count("(") > name.count(")"):
        name = name[:-1].rstrip(" ,;")
    if name.endswith(")") and name.count("(") < name.count(")"):
        name = name[:-1].rstrip(" ,;")
    name = re.sub(r"\s+1\*?$", "", name)
    return name.strip(" ,;")


def tidy_name(name: str, notes: str) -> tuple[str, str]:
    name = clean_ws(name)
    name = re.sub(r"^[^A-Za-zÀ-ž\u0400-\u04FF]+", "", name)
    for marker in (
        "Precizare necesară",
        "Precizare necesara",
        "* Precizare",
        "Modificare efectuată",
        "Modificare efectuata",
        "figurează în Registrul",
        "figureaza in Registrul",
        "Conform informației",
        "Conform informatiei",
        "Conform informaţiei",
    ):
        at = name.lower().find(marker.lower())
        if at > 2:
            notes = clean_ws(name[at:] + " " + notes)
            name = name[:at]
    name = re.sub(r"[\s\*]+$", "", name)
    name = drop_footnote(name)
    return clean_ws(name), clean_ws(notes)


def is_bad_name(name: str) -> bool:
    folded = fold(name)
    if len(folded) < 3 or re.fullmatch(r"\d+", folded or ""):
        return True
    bad = (
        "precizare",
        "modificare efectuata",
        "conform informatiei",
        "data nasterii",
        "http",
        "rectific",
        "not ",
    )
    if any(folded.startswith(item) for item in bad):
        return True
    if "modificare efectuata in baza" in folded:
        return True
    if folded in {"prim ministru", "prim-ministru", "exclusa", "exclus"} or folded.startswith("exclusa"):
        return True
    if folded.startswith("presedinte al consiliului interinstitutional"):
        return True
    return not re.search(r"[a-z]{3}", folded)


NAME_LABEL = re.compile(
    r"\s+(?=(?:Func[tț]i[ae]|Cet[aă][tț]eni[ae]|Sexul|Sex|Grad|Titlu|Pozi[tț]ie|"
    r"Adres[aă]|Locul(?:\s+na[sș]terii)?|Data(?:\s+na[sș]terii)?|Num[aă]rul|"
    r"Na[tț]ionalitate|Rus[aă]|Ucrainean[aă])\s*:)",
    re.I,
)


def detach_labels(name: str, info: str) -> tuple[str, str]:
    """Dacă o etichetă de identificare a încăput în coloana numelui, o mută la identificare."""
    match = NAME_LABEL.search(name)
    if match and match.start() >= 2:
        return clean_ws(name[: match.start()]), clean_ws(name[match.start() :] + " " + info)
    leading = re.match(
        r"^(?:Func[tț]i[ae]|Cet[aă][tț]eni[ae]|Sexul|Sex|Grad|Titlu|Pozi[tț]ie|"
        r"Adres[aă]|Locul(?:\s+na[sș]terii)?|Data(?:\s+na[sș]terii)?|Num[aă]rul|"
        r"Na[tț]ionalitate|Rus[aă]|Ucrainean[aă])\s*:",
        name,
        re.I,
    )
    if leading:
        return "", clean_ws(name + " " + info)
    return name, info


def leading_number(text: str) -> tuple[str, str] | None:
    m = re.match(r"^(\d{1,4})\.?\s+(.*)$", text.strip())
    if not m:
        return None
    number = int(m.group(1))
    if number < 1 or number > 5000:
        return None
    return m.group(1), m.group(2).strip()


def body_sample(pages: list[dict], page_index: int, header_at: int, limit_rows: int = 160) -> list[list[Word]]:
    """Rânduri de sub antet, inclusiv de pe paginile următoare.
    Antetul singur nu ajunge: sub el mai sunt doar rândurile lui împărțite pe mai multe linii."""
    sample: list[list[Word]] = []
    last = min(len(pages), page_index + 12)
    for offset, page in enumerate(pages[page_index:last]):
        rows = page["rows"]
        if offset == 0:
            chunk = rows[header_at + 1 :]
        else:
            if find_header(rows) is not None:
                break
            chunk = rows
        for row in chunk:
            text = row_text(row)
            if not text or is_junk_line(text):
                continue
            sample.append(row)
            if len(sample) >= limit_rows:
                return sample
    return sample


def extract_table(pages: list[dict]) -> tuple[list[dict], list[str], list[float]]:
    warnings: list[str] = []
    records: list[dict] = []
    edges: list[float] = []
    in_table = False
    subject_type = "person"
    current: dict | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        name, notes = tidy_name(current["name"], current.get("notes") or "")
        current["notes"] = notes
        if name and not is_bad_name(name):
            current["name"] = name
            current["info"] = clean_ws(current["info"])
            current["reason"] = clean_ws(current["reason"])
            current["dates"] = clean_ws(current["dates"])
            records.append(current)
        elif current["reason"] and re.search(r"precizare|modificare efectuata|corrigendum", fold(name + " " + current["reason"])):
            if records:
                note = clean_ws(current["name"] + " " + current["reason"])
                records[-1]["notes"] = clean_ws((records[-1].get("notes") or "") + " " + note)
        current = None

    for page_index, page in enumerate(pages, start=1):
        rows = page["rows"]
        header_at = find_header(rows)
        if header_at is not None:
            sample = body_sample(pages, page_index - 1, header_at)
            learned = edges_from_header(rows[header_at], sample, page["width"])
            if len(learned) >= 3:
                edges = learned
            for prev in rows[max(0, header_at - 4) : header_at]:
                kind = section_type(row_text(prev))
                if kind:
                    subject_type = kind
            in_table = True
            body = rows[header_at + 1 :]
        elif in_table and len(edges) >= 3:
            body = rows
        else:
            continue

        if len(edges) < 3:
            warnings.append(f"coloane_nesigure_pagina_{page_index}")
            continue

        page_edges = snap_info_edge(body, edges)
        for row in body:
            text = row_text(row)
            if not text or is_junk_line(text):
                continue
            if is_footnote_row(row, page["width"], page_edges):
                if re.search(r"precizare|modificare efectuata|corrigendum|http", fold(text)):
                    target = current if current else (records[-1] if records else None)
                    if target is not None:
                        target["notes"] = clean_ws((target.get("notes") or "") + " " + text)
                continue
            if find_header([row]) is not None:
                continue
            kind = section_type(text)
            if kind:
                flush()
                subject_type = kind
                continue
            cols = split_columns(row, page_edges)
            if is_column_index_row(cols):
                continue
            # First segment holds the row number and the name.
            numbered = leading_number(cols[0])
            if numbered and len(page_edges) >= 4:
                number, name = numbered
                info = cols[1] if len(cols) > 1 else ""
                reason = cols[2] if len(cols) > 2 else ""
                dates = " ".join(cols[3:]) if len(cols) > 3 else ""
            elif numbered and len(page_edges) == 3:
                number, name = numbered
                info = cols[1] if len(cols) > 1 else ""
                reason = cols[2] if len(cols) > 2 else ""
                dates = ""
            else:
                number = ""
                # Un număr singur în coloana numelui este un marcaj de notă, nu o intrare nouă.
                name = "" if re.fullmatch(r"\d{1,2}\*?", cols[0].strip()) else cols[0]
                info = cols[1] if len(cols) > 1 else ""
                reason = cols[2] if len(cols) > 2 else ""
                dates = " ".join(cols[3:]) if len(cols) > 3 else ""

            name, info = detach_labels(name, info)
            if number:
                if not name and re.search(r"precizare|modificare efectuata|http", fold(reason + info)):
                    if current:
                        current["notes"] = clean_ws((current.get("notes") or "") + " " + reason + " " + info)
                    elif records:
                        records[-1]["notes"] = clean_ws((records[-1].get("notes") or "") + " " + reason)
                    continue
                flush()
                current = {
                    "listNumber": number,
                    "type": subject_type,
                    "name": name,
                    "info": info,
                    "reason": reason,
                    "dates": dates,
                    "notes": "",
                    "page": page_index,
                }
            elif current:
                # Continuation: first column continues the name only when it
                # does not look like a fresh identification label dumped left.
                current["name"] = clean_ws(current["name"] + " " + name)
                current["info"] = clean_ws(current["info"] + " " + info)
                current["reason"] = clean_ws(current["reason"] + " " + reason)
                current["dates"] = clean_ws(current["dates"] + " " + dates)
        if not in_table:
            break
    flush()
    if in_table and not records:
        warnings.append("tabel_fara_randuri")
    return records, warnings, edges


ALIAS_RE = re.compile(
    r"\b(?:alias|a\.k\.a\.?|aka|cunoscut[ăa]?\s+și\s+sub\s+numele(?:\s+de)?|"
    r"variante ale numelui(?:\s+principal)?|nume nelatine?)\b[:\s]*",
    re.I,
)


def split_aliases(name: str) -> tuple[str, list[str]]:
    name = clean_ws(name)
    patronymic = re.search(r"\s+Patronimic:\s*(.+)$", name, re.I)
    extra_alias = ""
    if patronymic:
        extra_alias = clean_ws(patronymic.group(1))
        name = clean_ws(name[: patronymic.start()])
    parts = [clean_ws(p) for p in ALIAS_RE.split(name) if clean_ws(p)]
    if not parts:
        return "", []
    primary = parts[0]
    aliases = []
    for part in parts[1:]:
        for piece in re.split(r"\s*;\s*|\s+\(\d+\)\s+", part):
            piece = piece.strip(" ;,")
            if piece and fold(piece) != fold(primary):
                aliases.append(piece)
    for match in re.findall(r"[«“\"]([^»”\"]{2,80})[»”\"]", primary):
        if re.search(r"[\u0400-\u04FF]", match):
            aliases.append(match)
    if extra_alias:
        aliases.append(extra_alias)
    scripts = []
    primary, found = peel_scripts(primary)
    primary, transliterations = strip_script_labels(primary)
    scripts.extend(found)
    scripts.extend(transliterations)
    cleaned_aliases = []
    for alias in aliases:
        alias, found = peel_scripts(alias)
        scripts.extend(found)
        if alias:
            alias = drop_footnote(alias)
            if alias:
                cleaned_aliases.append(alias)
    aliases = cleaned_aliases + scripts
    # Drop alias markers left in the primary name.
    primary = drop_footnote(primary)
    seen = set()
    unique = []
    for alias in aliases:
        key = fold(alias) or alias
        if key and key not in seen and key != fold(primary):
            seen.add(key)
            unique.append(alias)
    return primary, unique


SCRIPT_RUN = re.compile(
    r"[\u0400-\u04FF][\u0400-\u04FF\s\-]{2,80}"
    r"|[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]"
    r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s\-]{1,80}"
)


def strip_script_labels(text: str) -> tuple[str, list[str]]:
    extras: list[str] = []

    def repl(match: re.Match) -> str:
        inner = re.sub(
            r"^(?:rus[aă]|ucrainean[aă]|belarus[aă]|uzbec[aă]|arab[aă]|persan[aă]|englez[aă]|chinez[aă])\s*:\s*",
            "",
            match.group(1),
            flags=re.I,
        )
        inner = clean_ws(SCRIPT_RUN.sub(" ", inner).strip(" ;,"))
        if re.search(r"[A-Za-zÀ-ž]{3}", inner):
            extras.append(inner)
        return " "

    text = re.sub(
        r"\(\s*((?:rus[aă]|ucrainean[aă]|belarus[aă]|uzbec[aă]|arab[aă]|persan[aă]|englez[aă]|chinez[aă])\s*:[^)]{0,120})\)?",
        repl,
        text,
        flags=re.I,
    )
    text = re.sub(r"\(\s*\)", " ", text)
    return clean_ws(text), extras


def peel_scripts(text: str) -> tuple[str, list[str]]:
    found = [clean_ws(item) for item in SCRIPT_RUN.findall(text)]
    found = [item for item in found if item]
    cleaned = SCRIPT_RUN.sub(" ", text)
    return clean_ws(cleaned), found


def parse_documents(text: str, idnp: str | None) -> list[dict]:
    found: list[dict] = []
    seen = set()

    def add(kind: str, series: str, number: str, raw: str) -> None:
        number = re.sub(r"\D", "", number)
        series = re.sub(r"[^A-Za-z]", "", series or "").upper()
        if len(number) < 5 or len(number) > 10:
            return
        if idnp and number == idnp:
            return
        key = (series, number)
        if key in seen:
            return
        seen.add(key)
        found.append({"kind": kind, "series": series, "number": number, "raw": clean_ws(raw)[:180]})

    for match in re.finditer(
        r"(buletin\w*|pa[sș]aport\w*|permis\w*)(.{0,80}?)"
        r"(?:seria\s+)?([A-Z]{1,3})?\s*(?:nr\.?\s*)?(\d[\d\s]{4,12})",
        text,
        re.I,
    ):
        label = fold(match.group(1))
        kind = "buletin" if "buletin" in label else "permis" if "permis" in label else "pasaport"
        add(kind, match.group(3) or "", match.group(4), match.group(0))

    for match in re.finditer(
        r"\b([A-Z]{1,2})\s+(?:nr\.?\s*)?(\d{6,9})\b",
        text,
    ):
        window = text[max(0, match.start() - 60) : match.start()]
        folded = fold(window)
        if "buletin" in folded:
            kind = "buletin"
        elif "pasaport" in folded or "pașaport" in folded or "pasaport" in fold(window):
            kind = "pasaport"
        elif "permis" in folded:
            kind = "permis"
        else:
            kind = "act"
        add(kind, match.group(1), match.group(2), match.group(0))
    return found


def parse_idnp(text: str) -> str | None:
    match = re.search(
        r"(?:IDNP|identificare de stat|număr(?:ul)? de identificare(?:\s+de stat)?"
        r"|numar national de identificare)[^\d]{0,40}(\d{13})",
        text or "",
        re.I,
    )
    return match.group(1) if match else None


def field_after(text: str, labels: str, stops: str) -> str:
    m = re.search(labels + r"\s*[:\-]?\s*(.+?)(?:" + stops + r"|$)", text, re.I | re.S)
    if not m:
        return ""
    return clean_ws(m.group(1))[:400]


def parse_listing(text: str) -> dict:
    listing = {"foreign": None, "md": None, "raw": clean_ws(text)[:240]}
    for label, raw in re.findall(
        r"\b(UE|UK|RM|SUA|US|CA|ONU)\s*[-–—:]\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})",
        text or "",
    ):
        iso = parse_numeric_date(raw)
        if label == "RM":
            listing["md"] = iso or listing["md"]
        else:
            listing["foreign"] = iso or listing["foreign"]
    return listing


def refine_type(declared: str, name: str, info: str) -> str:
    """Antetul de secțiune se lipește uneori de rândurile următoare.
    Data nașterii și numărul IMO sunt semnale mai sigure decât secțiunea curentă."""
    blob = fold(f"{name} {info}")
    birth = bool(re.search(r"data nasterii|sexul|nascut|cetateni", blob))
    imo = bool(re.search(r"\bimo\b", blob))
    entity = bool(re.search(r"tip de entitate|numar de inregistrare", blob))
    if imo and not birth:
        return "vessel"
    if birth:
        return "person"
    if entity:
        return "entity"
    return declared or "person"


def build_subject(record: dict, decision: dict, seq: int) -> tuple[dict, dict]:
    blob = " ".join(
        [
            record.get("name") or "",
            record.get("info") or "",
            record.get("reason") or "",
            record.get("dates") or "",
            record.get("notes") or "",
        ]
    )
    name, aliases = split_aliases(record.get("name") or "")
    info = record.get("info") or ""
    # Narrative records keep everything in info/name.
    if not name:
        name = clean_ws(record.get("name") or "Fără nume")
    idnp = parse_idnp(info) or parse_idnp(record.get("name") or "")
    documents = parse_documents(info + "\n" + (record.get("name") or ""), idnp)
    birth = parse_numeric_date(
        field_after(info, r"(?:Data na[sș]terii|n[aă]scut[ăa]?\s+la(?:\s+data\s+de)?)", r"Locul|Sex|Cet|Func|Num|IDNP|Pozi")
        or info
    )
    if not birth:
        birth = parse_numeric_date(field_after(blob, r"(?:Data na[sș]terii|n[aă]scut[ăa]?\s+la(?:\s+data\s+de)?)", r"Locul|Sex|Cet|Func|Num|IDNP|Pozi|este titular"))
    birth_place = field_after(info or blob, r"Locul na[sș]terii", r"Sex|Cet|Func|Num|IDNP|Gen|Pozi|Alte")
    gender = field_after(info or blob, r"(?:Sexul|Genul|Gen)", r"Cet|Func|Num|IDNP|Locul|Data|Pozi")
    citizenship_raw = field_after(
        info or blob,
        r"(?:Cet[aă][tț]eni[ae]|Na[tț]ionalitate(?:\(i\))?)",
        r"Num|IDNP|Func|Sex|Pa[sș]aport|Buletin|Gen|Pozi|Data|Locul",
    )
    function = field_after(info or blob, r"(?:Func[tț]i[ae]|Pozi[tț]ie|Funcție)", r"Data|Locul|Sex|Cet|Num|IDNP|Adres|Tip de|Na[tț]ional")
    citizenship = []
    if citizenship_raw:
        for part in re.split(r",|/|\s+și\s+", citizenship_raw):
            part = part.strip(" .;")
            if part and len(part) < 80:
                citizenship.append(part)
    listing = parse_listing((record.get("dates") or "") + " " + (record.get("reason") or "")[:200])
    reason = record.get("reason") or ""
    # If listing dates were pulled into the reason, keep them out of the opening.
    reason = re.sub(
        r"(?:\b(?:UE|UK|RM|SUA|US|CA|ONU)\s*[-–—]\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*)+",
        " ",
        reason,
    )
    reason = clean_ws(reason)
    moldova = bool(idnp) or any("moldova" in fold(c) for c in citizenship)
    subject_id = f"{decision['id']}-{seq}"
    subject = {
        "id": subject_id,
        "decisionId": decision["id"],
        "listNumber": record.get("listNumber") or str(seq),
        "type": refine_type(record.get("type") or "person", name, info),
        "name": name,
        "aliases": aliases,
        "birthDate": birth,
        "citizenship": citizenship,
        "idnp": idnp,
        "documents": documents,
        "regime": decision["regime"],
        "active": decision["status"] == "in_force",
        "moldova": moldova,
        "listing": {"foreign": listing["foreign"], "md": listing["md"]},
        "page": record.get("page") or 1,
    }
    detail = {
        "function": function,
        "birthPlace": birth_place,
        "gender": gender.strip(" :")[:40],
        "reason": reason,
        "notes": clean_ws(record.get("notes") or ""),
        "identifiersText": clean_ws(info),
        "listingRaw": listing["raw"],
        "page": record.get("page") or 1,
    }
    return subject, detail


def extract_narrative(text: str) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    idx = re.search(r"\bLISTA\b", text)
    if not idx:
        warnings.append("fara_lista")
        return [], warnings
    annex = text[idx.start() :]
    if re.search(r"\[\s*…\s*\]|\[\s*\.\.\.\s*\]", annex) and len(re.findall(r"(?m)^\s*\d+\.\s+\S", annex)) < 1:
        warnings.append("anexa_goala")
        return [], warnings
    subject_type = "person"
    records = []
    # Split keeping section markers and numbered entries.
    chunks = re.split(r"(?m)^(?=\s*(?:[A-Z]\.\s+\S.{0,80}|[IVX]{1,4}\.\s+\S.{0,80}|\d{1,4}\.\s+\S))", annex)
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        first = chunk.splitlines()[0].strip()
        kind = section_type(first)
        if kind and not re.match(r"^\d+\.", first):
            subject_type = kind
            chunk = "\n".join(chunk.splitlines()[1:]).strip()
            if not chunk:
                continue
            first = chunk.splitlines()[0].strip()
        m = re.match(r"^(\d{1,4})\.\s+([\s\S]+)$", chunk)
        if not m:
            continue
        body = clean_ws(m.group(2))
        notes = ""
        note_match = re.search(
            r"(?:^|\n)\s*(\d{1,2})\s+(Precizare necesară[\s\S]+)$",
            m.group(2),
            re.I,
        )
        if note_match:
            notes = clean_ws(note_match.group(2))
            body = clean_ws(m.group(2)[: note_match.start()])
        name, info, reason = narrative_fields(body)
        records.append(
            {
                "listNumber": m.group(1),
                "type": subject_type,
                "name": name,
                "info": info,
                "reason": reason,
                "dates": "",
                "notes": notes,
                "page": page_of_snippet(text, name[:40]),
            }
        )
    if not records:
        warnings.append("narativ_fara_intrari")
    return records, warnings


def page_of_snippet(text: str, snippet: str) -> int:
    if not snippet:
        return 1
    pos = text.find(snippet[:24])
    if pos < 0:
        return 1
    return text[:pos].count("\f") + 1


def narrative_fields(body: str) -> tuple[str, str, str]:
    reason = ""
    info = body
    for marker in ("Alte informații:", "Alte informatii:", "Expunerea de motive", "(Expunerea de motive"):
        at = body.find(marker)
        if at > 0:
            info = body[:at].strip()
            reason = body[at:].strip()
            break
    name_match = re.match(
        r"^(.+?)(?:,?\s+n[aă]scut[ăa]?|,?\s+IDNP\b|Data na[sș]terii\b|Func[tț]i|Pozi[tț]ie\b|Nume \(alfabet)",
        info,
        re.I | re.S,
    )
    if name_match:
        name = clean_ws(name_match.group(1))
        info_rest = clean_ws(info[name_match.end() :].lstrip(" ,"))
    else:
        lines = info.split(" ")
        # First sentence-ish up to 12 words if no label.
        name = clean_ws(info[:120])
        info_rest = info
    name = re.sub(r"\s+\d{1,2}$", "", name).strip(" ,;")
    return name, info_rest or info, reason


def classify(path: Path, text: str) -> dict:
    number = decision_number_from_name(path.name)
    header = text[:6000]
    num_match = re.search(r"nr\.?\s*(\d{1,3})\s+din\s+(.+?)(?:Priv|MODIFICAT|DECIDE)", header, re.S | re.I)
    if num_match:
        number = int(num_match.group(1))
        date = parse_ro_date(num_match.group(2))
    else:
        date = parse_ro_date(header)
    title_match = re.search(
        r"Priv\w+\s+(.+?)(?:\n\s*MODIFICAT|\bMODIFICAT\b|În conformitate|In conformitate|\bDECIDE\b)",
        header,
        re.S | re.I,
    )
    title = clean_ws(title_match.group(1)) if title_match else path.stem
    folded_title = fold(title)
    if "RAPORT" in path.name.upper():
        kind = "report"
    elif folded_title.startswith("modificarea") or (number in AMENDMENTS and not folded_title.startswith("punerea")):
        kind = "amendment"
    elif folded_title.startswith("aliniere") or number in ALIGNMENTS:
        kind = "alignment"
    else:
        kind = "implementation"
    status = "repealed" if number in REPEALED or re.search(r"\bAbrogat", header) else "in_force"
    regime = detect_regime(title + " " + header[:2500])
    measures = []
    folded_body = fold(text[:20000])
    if "blocarea fondurilor" in folded_body or "blocare a fondurilor" in folded_body:
        measures.append("asset_freeze")
    if "restrictiilor de calatorie" in folded_body or "interzice intrarea" in folded_body or "interdictie de intrare" in folded_body:
        measures.append("travel_ban")
    amended_by = []
    for match in re.finditer(r"DCIS\s*(\d{1,3})", header):
        value = match.group(1)
        if value not in amended_by:
            amended_by.append(value)
    instruments = []
    for match in re.finditer(
        r"(Decizia\s*\(PESC\)\s*\d{4}/\d+|Decizia\s+\d{4}/\d+/PESC|S\.I\.\s*\d{4}/\d+|SOR/\d{4}-\d+)",
        text[:15000],
        re.I,
    ):
        value = clean_ws(match.group(1))
        if value not in instruments:
            instruments.append(value)
    return {
        "id": str(number) if number is not None else path.stem,
        "number": number,
        "date": date,
        "title": title,
        "regime": regime,
        "kind": kind,
        "status": status,
        "measures": measures,
        "file": str(path.relative_to(ROOT)),
        "amendedBy": amended_by,
        "instruments": instruments[:8],
    }


def detect_regime(text: str) -> str:
    folded = fold(text)
    if "regatului unit" in folded or "marii britanii" in folded:
        return "UK"
    if "statelor unite" in folded:
        return "SUA"
    if "canad" in folded:
        return "Canada"
    if "natiunilor unite" in folded or re.search(r"\bonu\b", folded):
        return "ONU"
    if "uniunii europene" in folded or "pesc" in folded:
        return "UE"
    return "Altele"


def theme_of(title: str) -> str:
    folded = fold(title)
    prefixes = [
        "punerea in aplicare a masurilor restrictive internationale ale uniunii europene",
        "punerea in aplicare a masurilor restrictive internationale ale regatului unit al marii britanii si irlandei de nord",
        "punerea in aplicare a masurilor restrictive internationale ale regatului unit al marii britanii si al irlandei de nord",
        "punerea in aplicare a masurilor restrictive internationale ale statelor unite ale americii",
        "punerea in aplicare a masurilor restrictive internationale ale canadei",
        "punerea in aplicare a masurilor restrictive internationale",
        "alinierea la unele masuri restrictive internationale ale",
        "alinierea la masurile restrictive internationale ale",
        "alinierea la uncle masuri restrictive internationale ale",
        "modificarea unor decizii de punere in aplicare a masurilor restrictive internationale ale uniunii europene",
        "modificarea deciziei consiliului interinstitutional de supervizare",
    ]
    for prefix in prefixes:
        if folded.startswith(prefix):
            rest = folded[len(prefix) :].strip(" .")
            if rest:
                return rest[:180]
    return folded[:180] or "nedeterminat"


def should_extract(decision: dict) -> bool:
    return decision["kind"] == "implementation" and decision["status"] == "in_force"


def process_file(path: Path) -> tuple[dict, list[dict], dict[str, dict], dict]:
    text = pdf_text(path)
    ocr_used = False
    warnings: list[str] = []
    if len(text.strip()) < 80:
        text = ocr_pdf(path)
        ocr_used = True
        warnings.append("ocr")
        if len(text.strip()) < 40:
            warnings.append("ocr_gol")
    decision = classify(path, text)
    decision["theme"] = theme_of(decision["title"])
    subjects: list[dict] = []
    details: dict[str, dict] = {}
    method = "skipped"
    edges: list[float] = []
    if should_extract(decision):
        records: list[dict] = []
        if not ocr_used:
            pages = parse_bbox_pages(path)
            records, table_warnings, edges = extract_table(pages)
            warnings.extend(table_warnings)
            method = "table" if records else "table_empty"
        if not records:
            narrative_records, narrative_warnings = extract_narrative(text)
            warnings.extend(narrative_warnings)
            if narrative_records:
                records = narrative_records
                method = "ocr_narrative" if ocr_used else "narrative"
        if not records and "anexa_goala" not in warnings and "fara_lista" not in warnings:
            warnings.append("fara_subiecti")
        for seq, record in enumerate(records, start=1):
            subject, detail = build_subject(record, decision, seq)
            if len(fold(subject["name"])) < 3:
                warnings.append(f"nume_respins_{seq}")
                continue
            subjects.append(subject)
            details[subject["id"]] = detail
    decision["subjectCount"] = len(subjects)
    if "anexa_goala" in warnings:
        decision["notice"] = "Anexa din fișier nu redă numele subiecților."
    elif "ocr" in warnings:
        decision["notice"] = "Text obținut prin recunoaștere optică dintr-un document scanat."
    elif any(item in warnings for item in ("fara_lista", "fara_subiecti", "narativ_fara_intrari")):
        decision["notice"] = "Fișierul nu conține o listă de subiecți care să poată fi extrasă."
    report = {
        "id": decision["id"],
        "file": decision["file"],
        "kind": decision["kind"],
        "status": decision["status"],
        "method": method,
        "subjects": len(subjects),
        "edges": [round(e, 1) for e in edges],
        "warnings": warnings,
    }
    return decision, subjects, details, report


def write_json(path: Path, payload: object, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    else:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extrage lista de sancțiuni CIS în dataset/")
    parser.add_argument("--only", nargs="*", help="Procesează doar aceste PDF-uri")
    args = parser.parse_args()
    if args.only:
        files = [Path(item) if Path(item).is_absolute() else ROOT / item for item in args.only]
    else:
        files = sorted(DATA.glob("*.pdf"))
    if not files:
        print("Nu există PDF-uri în data/", file=sys.stderr)
        return 1
    if DETAILS.exists() and not args.only:
        shutil.rmtree(DETAILS)
    DETAILS.mkdir(parents=True, exist_ok=True)

    decisions = []
    subjects = []
    reports = []
    for index, path in enumerate(files, start=1):
        print(f"[{index}/{len(files)}] {path.name}", flush=True)
        decision, found, details, report = process_file(path)
        decisions.append(decision)
        subjects.extend(found)
        reports.append(report)
        if details:
            write_json(DETAILS / f"{decision['id']}.json", details)
        print(f"    {decision['kind']} nr.{decision['number']} → {len(found)} subiecți ({report['method']})", flush=True)
        if report["warnings"]:
            print(f"    avertismente: {', '.join(report['warnings'][:8])}", flush=True)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Stable order: decision number, then name.
    decisions.sort(key=lambda item: (item["number"] is None, item["number"] or 0, item["file"]))
    subjects.sort(key=lambda item: (int(item["decisionId"]) if item["decisionId"].isdigit() else 9999, item["name"]))
    write_json(
        DATASET / "decisions.json",
        {"generatedAt": generated, "source": "Deciziile Consiliului interinstituțional de supervizare din mapa data/", "decisions": decisions},
        pretty=True,
    )
    write_json(DATASET / "subjects.json", {"generatedAt": generated, "count": len(subjects), "subjects": subjects})
    write_json(
        DATASET / "report.json",
        {"generatedAt": generated, "subjects": len(subjects), "decisions": reports},
        pretty=True,
    )
    print(f"\nTotal subiecți: {len(subjects)}")
    problems = validate(subjects, details_dir=DETAILS)
    if problems:
        print("VERIFICARE EȘUATĂ:", file=sys.stderr)
        for problem in problems:
            print(" -", problem, file=sys.stderr)
        return 1
    print("Verificare Șor / Guțul: ok")
    return 0


def validate(subjects: list[dict], details_dir: Path) -> list[str]:
    problems = []
    sor = [s for s in subjects if s.get("idnp") == "0971007884125"]
    gutul = [s for s in subjects if s.get("idnp") == "2002008008309"]
    if not sor:
        problems.append("Ilan Șor (IDNP 0971007884125) lipsește")
    else:
        hit = next((s for s in sor if s["decisionId"] == "7"), sor[0])
        detail = json.loads((details_dir / "7.json").read_text(encoding="utf-8")).get(hit["id"], {})
        if hit["decisionId"] != "7":
            problems.append("Ilan Șor nu este legat de decizia nr. 7")
        if len(detail.get("reason") or "") < 40:
            problems.append("Motivul pentru Ilan Șor este gol sau prea scurt")
    if not gutul:
        problems.append("Evghenia Guțul (IDNP 2002008008309) lipsește")
    else:
        hit = next((s for s in gutul if s["decisionId"] == "32"), None)
        if not hit:
            problems.append("Evghenia Guțul nu este legată de decizia nr. 32")
        elif not any(doc["number"] == "08019342" for doc in hit["documents"]):
            problems.append("Buletinul B 08019342 al Evgheniei Guțul nu a fost extras")
    return problems


if __name__ == "__main__":
    sys.exit(main())
