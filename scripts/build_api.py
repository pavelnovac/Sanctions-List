#!/usr/bin/env python3
"""Construiește API-ul static din dataset/ în api/v1/.

Nu citește PDF-urile. Rulează după extract.py (care îl apelează automat) sau
separat, dacă s-a schimbat doar logica de clasament.

Fișiere produse:
  api/v1/index.json         manifest: versiune, dată, endpoint-uri
  api/v1/stats.json         totaluri pe tip, regim, program, lună de aplicare
  api/v1/latest.json        ultimele înregistrări aplicate în Republica Moldova
  api/v1/top.json           clasamente: relevanță, Republica Moldova, multi-regim, entități, nave
  api/v1/idnp/<IDNP>.json   verificare exactă după IDNP (404 = nu figurează)
  api/v1/subjects.csv       lista completă în vigoare, pentru sisteme de screening
"""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract import fold  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "dataset"
API = ROOT / "api" / "v1"
API_VERSION = "1.0"

TYPE_LABEL = {"person": "Persoană", "entity": "Entitate", "vessel": "Navă"}
MEASURE_LABEL = {
    "asset_freeze": "Blocarea fondurilor și a resurselor economice",
    "travel_ban": "Restricții de călătorie",
}

# Ponderea funcției publice: se ia cea mai mare potrivire.
ROLE_WEIGHTS = [
    (30, r"prim.ministru|\bministru\b|ministrul|guvernator|bascan|deputat|senator|\bduma\b|sef(?:ul)? statului"
         r"|presedinte(?:le)? (?:al )?(?:republicii|statului|partidului|consiliului)|oligarh"),
    (20, r"\bgeneral\b|comandant|director general|procuror|judecator|vicepresedinte|viceprim|adjunct al ministrului"
         r"|\blider|presedinte"),
    (10, r"om de afaceri|director|politician|membru|sef\b|coordonat"),
]
REGIME_BONUS = 25
DECISION_BONUS = 10
MOLDOVA_BONUS = 30
BOTH_MEASURES_BONUS = 5
RECENT_BONUS = 5
RECENT_DAYS = 365
MENTION_BONUS = 5
MENTION_CAP = 40


def canon(token: str) -> str:
    """Aceeași regulă ca în assets/match.js: Shor/Șor, Iurii/Yuri."""
    for a, b in (("sch", "s"), ("sh", "s"), ("ch", "c"), ("kh", "h"), ("ks", "x"), ("ts", "t"), ("y", "i"), ("ii", "i")):
        token = token.replace(a, b)
    return re.sub(r"(.)\1", r"\1", token)


def canon_words(text: str) -> list[str]:
    return [canon(word) for word in fold(text).split()]


def mention_index(subjects: list[dict], details: dict[str, dict]) -> dict[str, set[str]]:
    """Perechi de cuvinte consecutive din motivare → subiecții în care apar."""
    index: dict[str, set[str]] = defaultdict(set)
    for subject in subjects:
        detail = details.get(subject["id"], {})
        words = canon_words(" ".join([detail.get("reason") or "", detail.get("function") or "", detail.get("notes") or ""]))
        for a, b in zip(words, words[1:]):
            index[f"{a} {b}"].add(subject["id"])
    return index


def name_pairs(subject: dict) -> set[str]:
    pairs = set()
    for variant in [subject["name"], *(subject.get("aliases") or [])]:
        words = [w for w in canon_words(variant) if len(w) >= 3 and not w.isdigit()]
        if len(words) >= 2:
            pairs.add(f"{words[0]} {words[-1]}")
            pairs.add(f"{words[-1]} {words[0]}")
    return pairs


def pair_owners(buckets: dict[str, list[dict]]) -> dict[str, int]:
    """În câte grupuri distincte apare fiecare pereche prenume–nume."""
    owners: dict[str, int] = defaultdict(int)
    for items in buckets.values():
        for pair in set().union(*(name_pairs(s) for s in items)):
            owners[pair] += 1
    return owners


def mentioned_by(items: list[dict], index: dict[str, set[str]], owners: dict[str, int]) -> set[str]:
    """Perechile comune mai multor persoane (de ex. „Aung Oo”) nu identifică pe nimeni."""
    own = {s["id"] for s in items}
    found: set[str] = set()
    for subject in items:
        for pair in name_pairs(subject):
            if owners.get(pair, 0) <= 1:
                found |= index.get(pair, set())
    return found - own


def title_program(title: str) -> str:
    cleaned = re.sub(r"^privind\s+", "", title or "", flags=re.I)
    cleaned = re.sub(
        r"^punerea în aplicare a măsurilor restrictive internaționale(?:\s+ale\s+[^.]{0,90}?)?"
        r"(?=\s+(?:având|împotriva|îndreptate|privind|pentru|în raport|instituite)\b)",
        "",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = cleaned or title or ""
    return cleaned[:1].upper() + cleaned[1:]


def person_key(subject: dict) -> str:
    if subject.get("idnp"):
        return "idnp:" + subject["idnp"]
    tokens = sorted(fold(subject["name"]).split())
    return f"{subject['type']}:{' '.join(tokens)}:{subject.get('birthDate') or ''}"


def role_weight(function: str) -> int:
    folded = fold(function)
    for weight, pattern in ROLE_WEIGHTS:
        if re.search(pattern, folded):
            return weight
    return 0


def clean_role(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "")
    text = re.split(r"\s*(?:Alte informa[tțţ]ii|Informa[tțţ]ii suplimentare|Data na[sșş]terii|Locul na[sșş]terii)", text, maxsplit=1)[0]
    text = re.sub(r"^\W*func[tțţ]ii\)?\s*:?\s*", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip(" .;,:(")


def short(text: str, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:") + "…"


DATED_DECISIONS: set[str] = set()


def applied_on(subject: dict, decision: dict) -> str | None:
    """Data aplicării în RM din anexă. Data deciziei ține loc doar pentru anexele
    care nu au deloc coloana „RM – dată”; altfel lipsa ei e o scăpare la extragere."""
    md = (subject.get("listing") or {}).get("md")
    if md:
        return md
    return None if decision["id"] in DATED_DECISIONS else decision.get("date")


def load() -> tuple[dict, list[dict], list[dict], dict[str, dict]]:
    decisions_payload = json.loads((DATASET / "decisions.json").read_text(encoding="utf-8"))
    subjects_payload = json.loads((DATASET / "subjects.json").read_text(encoding="utf-8"))
    decisions = decisions_payload["decisions"]
    subjects = [s for s in subjects_payload["subjects"] if s.get("active")]
    details: dict[str, dict] = {}
    for path in (DATASET / "details").glob("*.json"):
        details.update(json.loads(path.read_text(encoding="utf-8")))
    return subjects_payload, decisions, subjects, details


def build_groups(subjects: list[dict], decisions: dict[str, dict], details: dict[str, dict], today: date) -> list[dict]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for subject in subjects:
        buckets[person_key(subject)].append(subject)
    recent_from = (today - timedelta(days=RECENT_DAYS)).isoformat()
    mentions = mention_index(subjects, details)
    owners = pair_owners(buckets)
    groups = []
    for items in buckets.values():
        items.sort(key=lambda s: (applied_on(s, decisions[s["decisionId"]]) or ""))
        # Numele „NUME, Prenume” din anexele britanice e mai greu de citit.
        head = min(items, key=lambda s: ("," in s["name"], int(s["decisionId"]) if s["decisionId"].isdigit() else 9999))
        function = max((clean_role(details.get(s["id"], {}).get("function") or "") for s in items), key=len, default="")
        regimes = sorted({s["regime"] for s in items})
        decision_ids = sorted({s["decisionId"] for s in items}, key=lambda x: int(x) if x.isdigit() else 9999)
        measures = sorted({m for s in items for m in decisions[s["decisionId"]].get("measures") or []})
        dates = [d for d in (applied_on(s, decisions[s["decisionId"]]) for s in items) if d]
        first_applied = min(dates) if dates else None
        last_applied = max(dates) if dates else None
        moldova = any(s.get("moldova") for s in items)
        weight = role_weight(function) if head["type"] == "person" else 0

        score = 0
        why: list[str] = []
        if moldova:
            score += MOLDOVA_BONUS
            why.append("Legătură cu Republica Moldova")
        if len(regimes) > 1:
            score += REGIME_BONUS * (len(regimes) - 1)
            why.append(f"Sancționat de {len(regimes)} regimuri: {', '.join(regimes)}")
        if len(decision_ids) > 1:
            score += DECISION_BONUS * (len(decision_ids) - 1)
            why.append(f"Inclus în {len(decision_ids)} decizii CIS")
        cited = len(mentioned_by(items, mentions, owners)) if head["type"] == "person" else 0
        if cited:
            score += min(MENTION_CAP, MENTION_BONUS * cited)
            why.append(f"Menționat în motivarea altor {cited}{' de' if cited >= 20 else ''} subiecți" if cited > 1 else "Menționat în motivarea altui subiect")
        if weight:
            score += weight
            why.append("Funcție publică sau de conducere" if weight >= 20 else "Rol economic sau politic")
        if len(measures) == 2:
            score += BOTH_MEASURES_BONUS
            why.append("Fonduri blocate și interdicție de călătorie")
        if last_applied and last_applied >= recent_from:
            score += RECENT_BONUS
            why.append("Aplicat în ultimele 12 luni")
        if head["type"] != "person":
            alias_bonus = min(10, 2 * len(head.get("aliases") or []))
            score += alias_bonus

        groups.append({
            "id": head["id"],
            "ids": [s["id"] for s in items],
            "name": head["name"],
            "type": head["type"],
            "aliases": (head.get("aliases") or [])[:5],
            "idnp": head.get("idnp"),
            "birthDate": head.get("birthDate"),
            "citizenship": head.get("citizenship") or [],
            "role": short(function),
            "regimes": regimes,
            "decisions": decision_ids,
            "measures": measures,
            "moldova": moldova,
            "firstApplied": first_applied,
            "lastApplied": last_applied,
            "cited": cited,
            "score": score,
            "why": why,
        })
    groups.sort(key=lambda g: (-g["score"], g["name"]))
    return groups


def stats(subjects: list[dict], decisions: list[dict], by_id: dict[str, dict], groups: list[dict], generated: str) -> dict:
    by_type = defaultdict(int)
    by_regime = defaultdict(int)
    by_month = defaultdict(int)
    by_program: dict[str, dict] = {}
    by_measure = defaultdict(int)
    for subject in subjects:
        decision = by_id[subject["decisionId"]]
        by_type[subject["type"]] += 1
        by_regime[subject["regime"]] += 1
        applied = applied_on(subject, decision)
        if applied:
            by_month[applied[:7]] += 1
        for measure in decision.get("measures") or []:
            by_measure[measure] += 1
        entry = by_program.setdefault(decision["id"], {
            "decision": decision["id"],
            "program": title_program(decision["title"]),
            "regime": decision["regime"],
            "date": decision.get("date"),
            "count": 0,
        })
        entry["count"] += 1
    in_force = [d for d in decisions if d["status"] == "in_force" and d["kind"] != "report"]
    latest_decision = max(in_force, key=lambda d: (d.get("date") or "", d.get("number") or 0))
    return {
        "generatedAt": generated,
        "subjects": len(subjects),
        "uniqueSubjects": len(groups),
        "byType": dict(by_type),
        "byRegime": dict(sorted(by_regime.items(), key=lambda kv: -kv[1])),
        "byMeasure": dict(by_measure),
        "moldova": sum(1 for g in groups if g["moldova"]),
        "multiRegime": sum(1 for g in groups if len(g["regimes"]) > 1),
        "decisions": {
            "total": len([d for d in decisions if d["kind"] != "report"]),
            "inForce": len(in_force),
            "withSubjects": len([d for d in in_force if d.get("subjectCount")]),
            "latest": {
                "id": latest_decision["id"],
                "number": latest_decision["number"],
                "date": latest_decision.get("date"),
                "title": latest_decision["title"],
            },
        },
        "byMonth": dict(sorted(by_month.items())),
        "byProgram": sorted(by_program.values(), key=lambda e: -e["count"]),
    }


def latest(subjects: list[dict], by_id: dict[str, dict], details: dict[str, dict], limit: int = 150) -> list[dict]:
    rows = []
    for subject in subjects:
        decision = by_id[subject["decisionId"]]
        rows.append({
            "id": subject["id"],
            "name": subject["name"],
            "type": subject["type"],
            "regime": subject["regime"],
            "idnp": subject.get("idnp"),
            "moldova": subject.get("moldova", False),
            "role": short(details.get(subject["id"], {}).get("function") or "", 110),
            "applied": applied_on(subject, decision),
            "sourceListed": (subject.get("listing") or {}).get("foreign"),
            "decision": decision["id"],
            "decisionDate": decision.get("date"),
            "program": title_program(decision["title"]),
        })
    rows = [row for row in rows if row["applied"]]
    rows.sort(key=lambda r: (r["applied"], r["decisionDate"] or "", r["name"]), reverse=True)
    return rows[:limit]


def slim(group: dict) -> dict:
    return {k: group[k] for k in (
        "id", "ids", "name", "type", "aliases", "idnp", "birthDate", "citizenship", "role",
        "regimes", "decisions", "measures", "moldova", "firstApplied", "lastApplied", "cited", "score", "why",
    )}


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def write_csv(path: Path, subjects: list[dict], by_id: dict[str, dict], details: dict[str, dict]) -> None:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "id", "nume", "aliasuri", "tip", "data_nasterii", "idnp", "documente", "cetatenie", "regim",
        "decizie_cis", "data_deciziei", "aplicat_rm", "inclus_la_sursa", "masuri", "functie", "pagina_pdf",
    ])
    for subject in subjects:
        decision = by_id[subject["decisionId"]]
        docs = "; ".join(f"{d['kind']} {d.get('series') or ''}{d['number']}".strip() for d in subject.get("documents") or [])
        writer.writerow([
            subject["id"],
            subject["name"],
            "; ".join(subject.get("aliases") or []),
            subject["type"],
            subject.get("birthDate") or "",
            subject.get("idnp") or "",
            docs,
            "; ".join(subject.get("citizenship") or []),
            subject["regime"],
            decision["number"],
            decision.get("date") or "",
            (subject.get("listing") or {}).get("md") or "",
            (subject.get("listing") or {}).get("foreign") or "",
            "; ".join(decision.get("measures") or []),
            details.get(subject["id"], {}).get("function") or "",
            subject.get("page") or "",
        ])
    path.write_text("\ufeff" + buffer.getvalue(), encoding="utf-8")


def main() -> int:
    payload, decisions, subjects, details = load()
    generated = payload.get("generatedAt") or datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    today = datetime.strptime(generated[:10], "%Y-%m-%d").date()
    by_id = {d["id"]: d for d in decisions}
    DATED_DECISIONS.update(s["decisionId"] for s in subjects if (s.get("listing") or {}).get("md"))
    groups = build_groups(subjects, by_id, details, today)

    if API.exists():
        shutil.rmtree(API)
    API.mkdir(parents=True)

    stats_payload = stats(subjects, decisions, by_id, groups, generated)
    write_json(API / "stats.json", stats_payload)
    write_json(API / "latest.json", {"generatedAt": generated, "items": latest(subjects, by_id, details)})

    persons = [g for g in groups if g["type"] == "person"]
    top = {
        "generatedAt": generated,
        "method": {
            "moldova": MOLDOVA_BONUS,
            "perExtraRegime": REGIME_BONUS,
            "perExtraDecision": DECISION_BONUS,
            "role": [weight for weight, _ in ROLE_WEIGHTS],
            "bothMeasures": BOTH_MEASURES_BONUS,
            "recent": RECENT_BONUS,
            "recentDays": RECENT_DAYS,
            "perMention": MENTION_BONUS,
            "mentionCap": MENTION_CAP,
        },
        "relevance": [slim(g) for g in persons[:50]],
        "international": [slim(g) for g in persons if not g["moldova"]][:50],
        "moldova": [slim(g) for g in groups if g["moldova"]],
        "multiRegime": [slim(g) for g in groups if len(g["regimes"]) > 1][:50],
        "entities": [slim(g) for g in groups if g["type"] == "entity"][:30],
        "vessels": [slim(g) for g in groups if g["type"] == "vessel"][:30],
    }
    write_json(API / "top.json", top)

    idnp_count = 0
    for group in groups:
        if not group["idnp"]:
            continue
        idnp_count += 1
        records = [s for s in subjects if s.get("idnp") == group["idnp"]]
        write_json(API / "idnp" / f"{group['idnp']}.json", {
            "idnp": group["idnp"],
            "listed": True,
            "checkedAgainst": generated,
            "subject": slim(group),
            "records": [{
                "id": s["id"],
                "name": s["name"],
                "regime": s["regime"],
                "decision": s["decisionId"],
                "decisionDate": by_id[s["decisionId"]].get("date"),
                "measures": [MEASURE_LABEL.get(m, m) for m in by_id[s["decisionId"]].get("measures") or []],
                "applied": applied_on(s, by_id[s["decisionId"]]),
                "pdf": by_id[s["decisionId"]]["file"],
                "page": s.get("page"),
            } for s in records],
        })

    write_csv(API / "subjects.csv", subjects, by_id, details)

    write_json(API / "index.json", {
        "name": "Lista de sancțiuni a Republicii Moldova — API static",
        "version": API_VERSION,
        "generatedAt": generated,
        "counts": {
            "subjects": len(subjects),
            "uniqueSubjects": len(groups),
            "idnp": idnp_count,
            "decisions": stats_payload["decisions"]["total"],
        },
        "endpoints": {
            "subjects": "dataset/subjects.json",
            "decisions": "dataset/decisions.json",
            "details": "dataset/details/{decisionId}.json",
            "stats": "api/v1/stats.json",
            "latest": "api/v1/latest.json",
            "top": "api/v1/top.json",
            "idnp": "api/v1/idnp/{idnp}.json",
            "csv": "api/v1/subjects.csv",
        },
        "disclaimer": "Date extrase automat din deciziile CIS. Lista oficială este cea publicată pe date.gov.md și în Monitorul Oficial.",
    })
    print(f"API: {len(subjects)} înregistrări, {len(groups)} subiecți unici, {idnp_count} IDNP → {API.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
