const CYR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "t", ч: "c", ш: "s", щ: "s", ъ: "", ы: "i", ь: "", э: "e", ю: "iu", я: "ia",
  і: "i", ї: "i", є: "e", ґ: "g",
};

export function fold(text) {
  let value = String(text || "").toLowerCase()
    .replace(/[șş]/g, "s")
    .replace(/[țţ]/g, "t")
    .replace(/[ăâ]/g, "a")
    .replace(/î/g, "i");
  let out = "";
  for (const ch of value) out += CYR[ch] ?? ch;
  out = out.normalize("NFD").replace(/\p{M}/gu, "");
  return out.replace(/[^a-z0-9]+/g, " ").trim();
}

// Transliterările diferă între surse: Shor/Șor, Yuri/Iurii, Aleksandr/Alexandr.
function canon(token) {
  return token
    .replace(/sch/g, "s")
    .replace(/sh/g, "s")
    .replace(/ch/g, "c")
    .replace(/kh/g, "h")
    .replace(/ks/g, "x")
    .replace(/ts/g, "t")
    .replace(/y/g, "i")
    .replace(/ii/g, "i")
    .replace(/(.)\1/g, "$1");
}

export function tokens(text) {
  return fold(text).split(" ").filter((token) => token.length > 1 || /\d/.test(token)).map(canon);
}

export function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false);
  const mb = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i += 1) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, lb);
    for (let j = lo; j < hi; j += 1) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = true;
      mb[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < la; i += 1) {
    if (!ma[i]) continue;
    while (!mb[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Scor 0–1 între două nume, indiferent de ordinea cuvintelor. */
export function nameScore(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const used = new Set();
  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    let bestAt = -1;
    candidateTokens.forEach((c, index) => {
      if (used.has(index)) return;
      const score = q.length <= 2 || c.length <= 2 ? (q === c ? 1 : 0) : jaroWinkler(q, c);
      if (score > best) { best = score; bestAt = index; }
    });
    if (bestAt >= 0 && best >= 0.8) used.add(bestAt);
    total += best;
  }
  const precision = total / queryTokens.length;
  const coverage = used.size / candidateTokens.length;
  return precision * 0.85 + coverage * 0.15;
}

/**
 * Index pentru căutare aproximativă: fiecare variantă de nume (nume principal
 * și aliasuri) este împărțită în cuvinte, iar un cuvânt este găsit după
 * primele două litere, ca să nu comparăm fiecare interogare cu toată lista.
 */
export function buildIndex(subjects) {
  const entries = [];
  const byPrefix = new Map();
  subjects.forEach((subject) => {
    const variants = [subject.name, ...(subject.aliases || [])]
      .map((name) => tokens(name))
      .filter((list) => list.length);
    variants.forEach((list) => {
      const at = entries.length;
      entries.push({ subject, tokens: list });
      for (const token of new Set(list)) {
        const key = token.slice(0, 2);
        if (!byPrefix.has(key)) byPrefix.set(key, []);
        byPrefix.get(key).push(at);
      }
    });
  });
  return { entries, byPrefix };
}

export function fuzzyFind(index, query, { limit = 10, threshold = 0.82, birthDate = "" } = {}) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  const candidates = new Set();
  for (const token of queryTokens) {
    for (const at of index.byPrefix.get(token.slice(0, 2)) || []) candidates.add(at);
  }
  const best = new Map();
  for (const at of candidates) {
    const entry = index.entries[at];
    let score = nameScore(queryTokens, entry.tokens);
    if (score < threshold - 0.1) continue;
    let birth = "";
    if (birthDate && entry.subject.birthDate) {
      if (entry.subject.birthDate === birthDate) { score = Math.min(1, score + 0.05); birth = "same"; }
      else if (entry.subject.birthDate.slice(0, 4) === birthDate.slice(0, 4)) birth = "year";
      else { score *= 0.8; birth = "different"; }
    }
    if (score < threshold) continue;
    const previous = best.get(entry.subject.id);
    if (!previous || previous.score < score) best.set(entry.subject.id, { subject: entry.subject, score, birth });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Cheia care leagă aceeași persoană din decizii diferite (aceeași regulă ca în build_api.py). */
export function personKey(subject) {
  if (subject.idnp) return `idnp:${subject.idnp}`;
  const sorted = fold(subject.name).split(" ").sort().join(" ");
  return `${subject.type}:${sorted}:${subject.birthDate || ""}`;
}
