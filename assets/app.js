import { fold, tokens, buildIndex, fuzzyFind, personKey } from "./match.js";

const TYPE_LABEL = { person: "Persoană", entity: "Entitate", vessel: "Navă" };
const TYPE_PLURAL = { person: "persoane", entity: "entități", vessel: "nave" };
const REGIME_LABEL = {
  UE: "Uniunea Europeană",
  ONU: "Consiliul de Securitate al ONU",
  SUA: "Statele Unite ale Americii",
  UK: "Regatul Unit",
  Canada: "Canada",
  Altele: "Alte regimuri",
};
const MEASURE_LABEL = {
  asset_freeze: "Blocarea fondurilor și a resurselor economice",
  travel_ban: "Restricții de călătorie",
};
const MEASURE_INFO = {
  asset_freeze: {
    text: "Fondurile și resursele economice care aparțin subiectului, sunt deținute sau controlate de acesta se blochează. Nu i se pot pune la dispoziție, direct sau indirect, bani, bunuri sau alte resurse economice.",
    action: "Băncile, companiile și celelalte entități raportoare nu execută operațiuni în favoarea subiectului, păstrează bunurile blocate și informează autoritățile competente.",
  },
  travel_ban: {
    text: "Subiectului i se restricționează intrarea pe teritoriul Republicii Moldova sau tranzitarea acestuia.",
    action: "Autoritățile de frontieră și de migrație aplică restricția la punctele de trecere și la eliberarea vizelor sau a permiselor.",
  },
};
const MONTHS = ["ian.", "feb.", "mar.", "apr.", "mai", "iun.", "iul.", "aug.", "sep.", "oct.", "nov.", "dec."];
const PAGE_SIZE = 20;
const SEARCH_DEFAULTS = { q: "", mode: "all", type: "all", regime: "all", decision: "all", measure: "all", year: "all", md: false, sort: "relevance", page: 1 };
const EXAMPLES = [
  ["Ilan Șor", "all"],
  ["Plahotniuc", "all"],
  ["Gazprom", "all"],
  ["Wagner", "all"],
  ["2002008008309", "idnp"],
  ["B 08019342", "document"],
];

const state = {
  ready: false,
  error: "",
  generatedAt: "",
  decisions: [],
  subjects: [],
  byId: new Map(),
  decisionById: new Map(),
  blob: new Map(),
  groupsByKey: new Map(),
  datedDecisions: new Set(),
  top: null,
  roles: new Map(),
  index: null,
  detailCache: new Map(),
  batch: null,
};

const main = document.querySelector("main");

// ——— utilitare ———

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function num(value) {
  return Number(value || 0).toLocaleString("ro-RO");
}

function plural(count, one, many) {
  if (count === 1) return `${num(count)} ${one}`;
  return `${num(count)} ${noun(count, many)}`;
}

function noun(count, many) {
  const rest = count % 100;
  return count >= 20 && (rest === 0 || rest >= 20) ? `de ${many}` : many;
}

function formatDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.slice(0, 10).split("-");
  if (!day) return iso;
  return `${day}.${month}.${year}`;
}

function monthLabel(ym) {
  const [year, month] = ym.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function capitalize(text) {
  const value = String(text || "").trim();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function themeOf(title) {
  const cleaned = String(title || "")
    .replace(/\s+/g, " ")
    .replace(/^privind\s+/i, "")
    .replace(/^punerea în aplicare a măsurilor restrictive internaționale(?:\s+ale\s+[^.]{0,90}?)?(?=\s+(?:având|împotriva|îndreptate|privind|pentru|în raport|instituite)\b)/i, "")
    .replace(/^alinierea (?:la|ia) (?:unele |uncle )?(?:măsuri|măsurile) restrictive internaționale ale\s+[^.]{0,80}?(?=\s+(?:instituite|având|împotriva)\b)/i, "")
    .trim();
  return capitalize(cleaned || title);
}

function decisionLabel(decision) {
  if (!decision) return "Decizie";
  const date = decision.date ? formatDate(decision.date) : "";
  return `Decizia CIS nr. ${decision.number}${date ? ` din ${date}` : ""}`;
}

function shortDecision(decision) {
  return decision ? `Decizia nr. ${decision.number}` : "Decizie";
}

// Aceeași regulă ca applied_on din build_api.py.
function appliedOn(subject) {
  if (subject.listing?.md) return subject.listing.md;
  if (state.datedDecisions.has(subject.decisionId)) return "";
  return state.decisionById.get(subject.decisionId)?.date || "";
}

function pdfHref(decision, page) {
  if (!decision?.file) return "#";
  const href = encodeURI(decision.file);
  return page ? `${href}#page=${page}` : href;
}

function docLabel(doc) {
  const kind = { buletin: "Buletin", pasaport: "Pașaport", permis: "Permis" }[doc.kind] || "Act";
  return `${kind} ${doc.series ? `${doc.series} ` : ""}${doc.number}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function download(name, lines) {
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function hashCode(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function chip(text, tone = "") {
  return `<span class="chip ${tone}">${esc(text)}</span>`;
}

function regimeChips(regimes) {
  return regimes.map((regime) => `<span class="chip regime" title="${esc(REGIME_LABEL[regime] || regime)}">${esc(regime)}</span>`).join("");
}

function getIndex() {
  if (!state.index) state.index = buildIndex(state.subjects.filter((subject) => subject.active));
  return state.index;
}

function groupOf(subject) {
  return state.groupsByKey.get(personKey(subject)) || [subject];
}

// ——— router ———

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [withAnchor, query = ""] = raw.split("?");
  const [path, anchor = ""] = withAnchor.split("#");
  return { path: path || "/", anchor, params: new URLSearchParams(query) };
}

function setNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function setTitle(title) {
  document.title = title ? `${title} — Lista de sancțiuni RM` : "Lista de sancțiuni — Republica Moldova";
}

function render() {
  if (!state.ready) {
    main.innerHTML = `<p class="empty">${esc(state.error || "Se încarcă lista…")}</p>`;
    return;
  }
  const { path, params, anchor } = parseHash();
  if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  const routes = [
    [/^\/subiect\/(.+)$/, "cauta", (m) => renderSubject(decodeURIComponent(m[1]))],
    [/^\/decizie\/(.+)$/, "decizii", (m) => renderDecision(decodeURIComponent(m[1]), params)],
    [/^\/decizii$/, "decizii", () => renderCatalog(params)],
    [/^\/cauta$/, "cauta", () => renderSearch(params)],
    [/^\/topuri$/, "topuri", () => renderTops(params)],
    [/^\/lot$/, "lot", () => renderBatch()],
    [/^\/api$/, "api", () => renderApi()],
    [/^\/ghid$/, "ghid", () => renderGuide()],
    [/^\/dovada$/, "cauta", () => renderProof(params)],
  ];
  for (const [pattern, nav, handler] of routes) {
    const match = path.match(pattern);
    if (match) {
      setNav(nav);
      handler(match);
      return;
    }
  }
  setNav("acasa");
  renderHome();
}

// ——— căutare ———

function readSearch(params) {
  const s = { ...SEARCH_DEFAULTS };
  for (const key of Object.keys(SEARCH_DEFAULTS)) {
    const value = params.get(key === "page" ? "p" : key);
    if (value === null) continue;
    if (key === "md") s.md = value === "1";
    else if (key === "page") s.page = Math.max(1, Number(value) || 1);
    else s[key] = value;
  }
  return s;
}

function searchHash(s) {
  const params = new URLSearchParams();
  for (const [key, fallback] of Object.entries(SEARCH_DEFAULTS)) {
    const value = s[key];
    if (value === fallback || value === "" || value === undefined) continue;
    if (key === "md") params.set("md", "1");
    else if (key === "page") params.set("p", String(value));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return `#/cauta${qs ? `?${qs}` : ""}`;
}

function applyFilters(list, s) {
  return list.filter((subject) => {
    if (!subject.active) return false;
    if (s.type !== "all" && subject.type !== s.type) return false;
    if (s.regime !== "all" && subject.regime !== s.regime) return false;
    if (s.decision !== "all" && subject.decisionId !== s.decision) return false;
    if (s.md && !subject.moldova) return false;
    if (s.measure !== "all" && !(state.decisionById.get(subject.decisionId)?.measures || []).includes(s.measure)) return false;
    if (s.year !== "all" && !appliedOn(subject).startsWith(s.year)) return false;
    return true;
  });
}

function docKeys(subject) {
  const keys = new Set();
  for (const doc of subject.documents || []) {
    const series = String(doc.series || "").toLowerCase().replace(/[^a-z]/g, "");
    const number = String(doc.number || "").replace(/\D/g, "");
    if (number) keys.add(number);
    if (series && number) keys.add(series + number);
  }
  return keys;
}

function nameRank(subject, queryTokens) {
  const own = tokens(subject.name);
  const joined = [...queryTokens].sort().join(" ");
  if ([...own].sort().join(" ") === joined) return 0;
  if (queryTokens.every((q) => own.some((token) => token.startsWith(q)))) return 1;
  if (queryTokens.every((q) => own.some((token) => token.includes(q)))) return 2;
  return 3;
}

function runQuery(s, { filters = true } = {}) {
  const base = filters ? applyFilters(state.subjects, s) : state.subjects.filter((subject) => subject.active);
  const query = s.q.trim();
  if (!query) return { items: base, banner: null, hint: null, fuzzy: [] };
  if (s.mode === "idnp") {
    const digits = query.replace(/\D/g, "");
    if (digits.length !== 13) {
      return { items: [], banner: null, hint: "Pentru verificare, introduceți toate cele 13 cifre ale IDNP-ului.", fuzzy: [] };
    }
    const items = base.filter((subject) => subject.idnp === digits);
    return { items, banner: items.length ? "hit" : "miss", hint: null, fuzzy: [] };
  }
  if (s.mode === "document") {
    const norm = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length < 5) {
      return { items: [], banner: null, hint: "Introduceți seria și numărul, sau cel puțin 5 cifre ale documentului.", fuzzy: [] };
    }
    const items = base.filter((subject) => docKeys(subject).has(norm));
    return { items, banner: items.length ? "hit" : "miss", hint: null, fuzzy: [] };
  }
  const queryTokens = tokens(query);
  let items = base.filter((subject) => queryTokens.every((token) => state.blob.get(subject.id).includes(token)));
  if (s.sort === "relevance") {
    const rank = new Map(items.map((subject) => [subject.id, nameRank(subject, queryTokens)]));
    items = [...items].sort((a, b) => rank.get(a.id) - rank.get(b.id) || a.name.localeCompare(b.name, "ro"));
  }
  let fuzzy = [];
  if (items.length < 3 && /[a-z]/i.test(query)) {
    const allowed = new Set(base.map((subject) => subject.id));
    const seen = new Set(items.map((subject) => subject.id));
    fuzzy = fuzzyFind(getIndex(), query, { threshold: items.length ? 0.9 : 0.8, limit: 8 })
      .filter((hit) => allowed.has(hit.subject.id) && !seen.has(hit.subject.id));
  }
  return { items, banner: null, hint: null, fuzzy };
}

function sortItems(items, s) {
  if (s.sort === "name") return [...items].sort((a, b) => a.name.localeCompare(b.name, "ro"));
  if (s.sort === "recent") return [...items].sort((a, b) => appliedOn(b).localeCompare(appliedOn(a)) || a.name.localeCompare(b.name, "ro"));
  return items;
}

function groupResults(items) {
  const groups = [];
  const seen = new Map();
  for (const subject of items) {
    const key = personKey(subject);
    if (!seen.has(key)) {
      const group = { key, items: [] };
      seen.set(key, group);
      groups.push(group);
    }
    seen.get(key).items.push(subject);
  }
  return groups;
}

function modeButton(current, mode, label) {
  return `<button type="button" data-mode="${mode}" aria-pressed="${current === mode}">${label}</button>`;
}

function placeholder(mode) {
  if (mode === "idnp") return "13 cifre, de exemplu 2002008008309";
  if (mode === "document") return "Seria și numărul, de exemplu B 08019342";
  return "Nume, companie, alias, IDNP sau document";
}

function modeHint(mode) {
  if (mode === "idnp") return "Potrivire exactă a codului personal de identificare de stat (IDNP). Rezultatul poate fi salvat ca dovadă.";
  if (mode === "document") return "Potrivire exactă a seriei și numărului de buletin sau pașaport, cu sau fără spații.";
  return "Diacriticele, ordinea cuvintelor și transliterarea (Șor / Shor, Iurii / Yuri) nu contează. Apăsați / pentru a începe să scrieți.";
}

function select(name, label, options, current) {
  const html = options.map(([value, text]) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(text)}</option>`).join("");
  return `<label class="field">${esc(label)}<select name="${name}">${html}</select></label>`;
}

function searchPanel(s, { compact = false } = {}) {
  const active = state.subjects.filter((subject) => subject.active);
  const regimes = [...new Set(active.map((subject) => subject.regime))].sort();
  const years = [...new Set(active.map((subject) => appliedOn(subject).slice(0, 4)).filter(Boolean))].sort().reverse();
  const programs = state.decisions
    .filter((decision) => decision.kind === "implementation" && decision.status === "in_force" && decision.subjectCount)
    .sort((a, b) => a.number - b.number)
    .map((decision) => {
      const label = `nr. ${decision.number} · ${decision.regime} · ${themeOf(decision.title)}`;
      return [decision.id, label.length > 80 ? `${label.slice(0, 80)}…` : label];
    });
  const types = ["person", "entity", "vessel"].filter((type) => active.some((subject) => subject.type === type));
  return `
    <form class="search-panel ${compact ? "compact" : ""}" id="cautare" role="search">
      <div class="modes" role="group" aria-label="Modul de căutare">
        ${modeButton(s.mode, "all", "Căutare liberă")}
        ${modeButton(s.mode, "idnp", "Verificare IDNP")}
        ${modeButton(s.mode, "document", "Verificare document")}
      </div>
      <div class="search-row">
        <label class="sr" for="q">Termen de căutare</label>
        <input id="q" type="search" name="q" value="${esc(s.q)}" placeholder="${placeholder(s.mode)}" autocomplete="off" enterkeyhint="search" ${s.mode === "idnp" ? 'inputmode="numeric"' : ""}>
        <button type="submit">Verifică</button>
      </div>
      <p class="hint">${modeHint(s.mode)}</p>
      ${compact ? `<p class="examples">Exemple: ${EXAMPLES.map(([q, mode]) => `<a href="${searchHash({ ...SEARCH_DEFAULTS, q, mode })}">${esc(q)}</a>`).join("")}</p>` : `
      <details class="filters-box" ${hasFilters(s) ? "open" : ""}>
        <summary>Filtre${hasFilters(s) ? ` <span class="chip seal">active</span>` : ""}</summary>
        <div class="filters">
          ${select("type", "Tip", [["all", "Toate"], ...types.map((type) => [type, capitalize(TYPE_PLURAL[type])])], s.type)}
          ${select("regime", "Regim", [["all", "Toate"], ...regimes.map((item) => [item, `${item} — ${REGIME_LABEL[item] || item}`])], s.regime)}
          ${select("decision", "Program / decizie", [["all", "Toate"], ...programs], s.decision)}
          ${select("measure", "Măsură", [["all", "Toate"], ["asset_freeze", "Blocarea fondurilor"], ["travel_ban", "Restricții de călătorie"]], s.measure)}
          ${select("year", "Aplicat în RM", [["all", "Oricând"], ...years.map((year) => [year, `în ${year}`])], s.year)}
          ${select("sort", "Ordonare", [["relevance", "Relevanță"], ["recent", "Cele mai recente"], ["name", "Alfabetic"]], s.sort)}
          <label class="check"><input type="checkbox" name="md" ${s.md ? "checked" : ""}> Doar cu legătură cu Republica Moldova</label>
          ${hasFilters(s) ? `<a class="reset" href="${searchHash({ ...SEARCH_DEFAULTS, q: s.q, mode: s.mode })}">Resetează filtrele</a>` : ""}
        </div>
      </details>`}
    </form>`;
}

function hasFilters(s) {
  return s.type !== "all" || s.regime !== "all" || s.decision !== "all" || s.measure !== "all" || s.year !== "all" || s.md;
}

function renderSearch(params) {
  const s = readSearch(params);
  setTitle(s.q ? `„${s.q}”` : "Căutare");
  main.innerHTML = `
    <div class="page-head">
      <h2>Căutare și verificare</h2>
      <p class="muted">Verificați o persoană, o companie sau un document în ${plural(state.subjects.filter((x) => x.active).length, "înregistrare", "înregistrări")} din deciziile Consiliului interinstituțional de supervizare.</p>
    </div>
    ${searchPanel(s)}
    <div id="results" aria-live="polite"></div>
  `;
  bindSearch(s);
  paintResults(s);
}

function bindSearch(s) {
  const form = document.querySelector("#cautare");
  const input = form.elements.q;
  let timer;
  const sync = () => {
    history.replaceState(null, "", searchHash(s));
    paintResults(s);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      s.q = input.value;
      s.page = 1;
      sync();
    }, 180);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(timer);
    s.q = input.value;
    s.page = 1;
    sync();
  });
  form.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      s.mode = button.dataset.mode;
      s.q = input.value;
      s.page = 1;
      location.hash = searchHash(s);
      setTimeout(() => document.querySelector("#q")?.focus(), 0);
    });
  });
  for (const name of ["type", "regime", "decision", "measure", "year", "sort"]) {
    form.elements[name]?.addEventListener("change", () => {
      s[name] = form.elements[name].value;
      s.page = 1;
      location.hash = searchHash(s);
    });
  }
  form.elements.md?.addEventListener("change", () => {
    s.md = form.elements.md.checked;
    s.page = 1;
    location.hash = searchHash(s);
  });
}

function paintResults(s) {
  const target = document.querySelector("#results");
  if (!target) return;
  const result = runQuery(s);
  const showList = s.q.trim() || hasFilters(s);
  const proof = `#/dovada?${new URLSearchParams({ q: s.q, mode: s.mode })}`;
  let html = "";
  if (result.hint) html += `<p class="banner warn">${esc(result.hint)}</p>`;
  if (result.banner === "hit") {
    html += `<div class="banner hit"><p><b>Figurează în lista de sancțiuni</b> — ${plural(result.items.length, "înregistrare", "înregistrări")}.</p><a class="banner-link" href="${proof}">Salvează dovada verificării</a></div>`;
  }
  if (result.banner === "miss") {
    html += `<div class="banner miss"><p><b>Nu figurează</b> în lista extrasă din deciziile CIS (versiunea din ${esc(formatDate(state.generatedAt))}).</p><a class="banner-link" href="${proof}">Salvează dovada verificării</a></div>`;
  }
  if (result.hint || result.banner === "miss") {
    target.innerHTML = html;
    return;
  }
  if (!showList) {
    target.innerHTML = html + searchWelcome();
    return;
  }
  const groups = groupResults(sortItems(result.items, s));
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  s.page = Math.min(s.page, pages);
  const slice = groups.slice((s.page - 1) * PAGE_SIZE, s.page * PAGE_SIZE);
  const queryTokens = s.mode === "all" ? tokens(s.q) : [];
  html += `
    <div class="toolbar">
      <p><b>${num(groups.length)}</b> ${groups.length === 1 ? "subiect găsit" : "subiecți găsiți"}${groups.length !== result.items.length ? ` <span class="muted">(${plural(result.items.length, "înregistrare", "înregistrări")})</span>` : ""}</p>
      <div class="toolbar-actions">
        ${s.q.trim() ? `<a class="ghost" href="${proof}">Dovadă de verificare</a>` : ""}
        <button type="button" class="ghost" id="export">Export CSV</button>
      </div>
    </div>
    ${groups.length ? `<div class="cards">${slice.map((group) => resultCard(group, queryTokens)).join("")}</div>` : `<p class="empty">Nicio potrivire exactă pentru criteriile alese.</p>`}
    ${pager(s.page, pages)}
    ${result.fuzzy.length ? `
      <section class="fuzzy">
        <h3>${groups.length ? "Nume asemănătoare" : "Poate ați căutat"}</h3>
        <p class="muted">Potriviri aproximative, după asemănarea numelui. Verificați data nașterii și documentele înainte de a trage o concluzie.</p>
        <ul class="rank-list">${result.fuzzy.map((hit) => fuzzyRow(hit)).join("")}</ul>
      </section>` : ""}
  `;
  target.innerHTML = html;
  target.querySelector("#export")?.addEventListener("click", () => exportSubjects(result.items, "sanctiuni-rezultate.csv"));
  target.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      s.page = Number(button.dataset.page);
      history.replaceState(null, "", searchHash(s));
      paintResults(s);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function searchWelcome() {
  return `
    <section class="welcome">
      <h3>Ce puteți verifica</h3>
      <div class="tiles">
        <a class="tile" href="${searchHash({ ...SEARCH_DEFAULTS, mode: "all", q: "Ilan Șor" })}"><b>Un nume</b><span>Persoană, companie sau organizație, inclusiv aliasuri și scriere chirilică.</span></a>
        <a class="tile" href="${searchHash({ ...SEARCH_DEFAULTS, mode: "idnp" })}"><b>Un IDNP</b><span>Verificare exactă, cu dovadă descărcabilă pentru dosarul clientului.</span></a>
        <a class="tile" href="${searchHash({ ...SEARCH_DEFAULTS, mode: "document" })}"><b>Un document</b><span>Buletin sau pașaport, după serie și număr.</span></a>
        <a class="tile" href="#/lot"><b>O listă întreagă</b><span>Lipiți sute de nume sau încărcați un CSV. Datele nu părăsesc browserul.</span></a>
      </div>
      <p class="examples">Încercați: ${EXAMPLES.map(([q, mode]) => `<a href="${searchHash({ ...SEARCH_DEFAULTS, q, mode })}">${esc(q)}</a>`).join("")}</p>
    </section>`;
}

function highlight(name, queryTokens) {
  if (!queryTokens.length) return esc(name);
  return name.split(/(\s+)/).map((part) => {
    const own = tokens(part);
    const hit = own.length && own.some((token) => queryTokens.some((q) => token.includes(q)));
    return hit ? `<mark>${esc(part)}</mark>` : esc(part);
  }).join("");
}

function resultCard(group, queryTokens) {
  const head = group.items[0];
  const all = groupOf(head);
  const names = [...new Set(all.flatMap((item) => [item.name, ...(item.aliases || [])]))];
  const alias = names.filter((name) => fold(name) !== fold(head.name)).slice(0, 3).join(" · ");
  const regimes = [...new Set(all.map((item) => item.regime))].sort();
  const decisions = [...new Set(all.map((item) => item.decisionId))].map((id) => state.decisionById.get(id));
  const role = state.roles.get(head.id);
  const applied = all.map(appliedOn).filter(Boolean).sort()[0];
  return `<a class="card" href="#/subiect/${encodeURIComponent(head.id)}">
    <div class="card-top">
      <span class="chip">${esc(TYPE_LABEL[head.type] || head.type)}</span>
      ${regimeChips(regimes)}
      ${head.moldova ? chip("Legătură RM", "seal") : ""}
      ${applied ? `<span class="card-date">aplicat ${esc(formatDate(applied))}</span>` : ""}
    </div>
    <h3>${highlight(head.name, queryTokens)}</h3>
    ${alias ? `<p class="aliases">${esc(alias)}</p>` : ""}
    ${role ? `<p class="role">${esc(role)}</p>` : ""}
    <div class="meta">
      ${head.idnp ? chip(`IDNP ${head.idnp}`, "seal") : ""}
      ${head.birthDate ? chip(`n. ${formatDate(head.birthDate)}`) : ""}
      ${(head.citizenship || []).slice(0, 1).map((item) => chip(item)).join("")}
      ${(head.documents || []).slice(0, 2).map((doc) => chip(docLabel(doc))).join("")}
      ${decisions.map((decision) => chip(shortDecision(decision), "pine")).join("")}
    </div>
  </a>`;
}

function fuzzyRow(hit) {
  const subject = hit.subject;
  const decision = state.decisionById.get(subject.decisionId);
  return `<li class="rank-row">
    <span class="score-pill" title="Asemănarea numelui">${Math.round(hit.score * 100)}%</span>
    <div>
      <a href="#/subiect/${encodeURIComponent(subject.id)}">${esc(subject.name)}</a>
      <div class="meta">${chip(TYPE_LABEL[subject.type])}${regimeChips([subject.regime])}${subject.birthDate ? chip(`n. ${formatDate(subject.birthDate)}`) : ""}${chip(shortDecision(decision), "pine")}</div>
    </div>
  </li>`;
}

function pager(page, pages) {
  if (pages <= 1) return "";
  return `<div class="pager">
    <button type="button" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>← Înapoi</button>
    <span>Pagina ${page} din ${pages}</span>
    <button type="button" data-page="${page + 1}" ${page === pages ? "disabled" : ""}>Înainte →</button>
  </div>`;
}

function exportSubjects(items, name) {
  const header = ["Nume", "Aliasuri", "Tip", "Data nașterii", "IDNP", "Documente", "Cetățenie", "Regim", "Decizie", "Dată decizie", "Aplicat în RM", "Inclus la sursă", "Măsuri", "Pagină PDF", "Link"];
  const lines = [header.join(",")];
  const base = location.href.split("#")[0];
  for (const subject of items) {
    const decision = state.decisionById.get(subject.decisionId);
    lines.push([
      subject.name,
      (subject.aliases || []).join("; "),
      TYPE_LABEL[subject.type] || subject.type,
      subject.birthDate || "",
      subject.idnp || "",
      (subject.documents || []).map(docLabel).join("; "),
      (subject.citizenship || []).join("; "),
      subject.regime,
      decisionLabel(decision),
      decision?.date || "",
      subject.listing?.md || "",
      subject.listing?.foreign || "",
      (decision?.measures || []).map((m) => MEASURE_LABEL[m] || m).join("; "),
      subject.page,
      `${base}#/subiect/${subject.id}`,
    ].map(csvCell).join(","));
  }
  download(name, lines);
}

// ——— acasă ———

function renderHome() {
  setTitle("");
  const active = state.subjects.filter((subject) => subject.active);
  const count = (fn) => active.filter(fn).length;
  const regimes = countBy(active, (subject) => subject.regime);
  const months = countBy(active, (subject) => appliedOn(subject).slice(0, 7));
  const programs = countBy(active, (subject) => subject.decisionId);
  const latestDecision = [...state.decisions]
    .filter((decision) => decision.kind !== "report" && decision.status === "in_force")
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.number - a.number)[0];
  const recent = [...active].sort((a, b) => appliedOn(b).localeCompare(appliedOn(a)) || a.name.localeCompare(b.name, "ro"));
  const lastDate = appliedOn(recent[0] || {});
  const lastBatch = recent.filter((subject) => appliedOn(subject) === lastDate).length;
  const top = state.top;
  const unique = new Set(active.map(personKey)).size;

  main.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <p class="kicker">Verificare gratuită · fără cont · actualizată ${esc(formatDate(state.generatedAt))}</p>
        <h2>Aflați în câteva secunde dacă o persoană sau o companie este sancționată în Republica Moldova.</h2>
        <p class="lede-dark">${plural(unique, "subiect", "subiecți")} din ${plural(state.decisions.filter((d) => d.subjectCount).length, "decizie", "decizii")} ale Consiliului interinstituțional de supervizare, pe regimurile UE, ONU, SUA, Regatul Unit și Canada. Fiecare rezultat trimite la pagina exactă din actul oficial.</p>
      </div>
      ${searchPanel({ ...SEARCH_DEFAULTS }, { compact: true })}
    </section>

    <section class="kpis" aria-label="Rezumat">
      ${kpi(num(active.length), noun(active.length, "înregistrări în vigoare"), plural(unique, "subiect unic", "subiecți unici"))}
      ${kpi(num(count((s) => s.type === "person")), noun(count((s) => s.type === "person"), "persoane fizice"), plural(count((s) => s.type === "entity"), "entitate", "entități"))}
      ${kpi(num(Object.keys(regimes).length), "regimuri de sancțiuni", Object.keys(regimes).join(" · "))}
      ${kpi(num(top?.moldova?.length || 0), noun(top?.moldova?.length || 0, "subiecți legați de RM"), "cetățeni sau IDNP moldovenesc", "#/topuri?t=moldova")}
      ${kpi(latestDecision ? `nr. ${latestDecision.number}` : "—", "ultima decizie CIS", latestDecision ? formatDate(latestDecision.date) : "", latestDecision ? `#/decizie/${latestDecision.id}` : "")}
      ${kpi(num(lastBatch), noun(lastBatch, "subiecți noi la ultima actualizare"), formatDate(lastDate), "#/topuri?t=recente")}
    </section>

    <div class="widgets">
      <section class="widget">
        <header><h3>Ultimii adăugați</h3><a href="#/topuri?t=recente">Toate noutățile →</a></header>
        <p class="widget-note">Ordonați după data aplicării în Republica Moldova.</p>
        <ul class="mini-list">${recent.slice(0, 7).map((subject) => miniRow(subject, formatDate(appliedOn(subject)))).join("")}</ul>
      </section>
      <section class="widget">
        <header><h3>Top · legătură cu Republica Moldova</h3><a href="#/topuri?t=moldova">Lista completă →</a></header>
        <p class="widget-note">Cetățeni moldoveni sau subiecți cu IDNP, ordonați după indicele de relevanță.</p>
        <ol class="mini-list ranked">${(top?.moldova || []).slice(0, 7).map((group) => topMini(group)).join("")}</ol>
      </section>
      <section class="widget">
        <header><h3>Top · figuri internaționale</h3><a href="#/topuri?t=internationali">Clasamentul complet →</a></header>
        <p class="widget-note">Demnitari, comandanți și oameni de afaceri străini, sancționați de mai multe regimuri sau citați în alte dosare.</p>
        <ol class="mini-list ranked">${(top?.international || []).slice(0, 7).map((group) => topMini(group)).join("")}</ol>
      </section>
      <section class="widget">
        <header><h3>Pe regimuri</h3><a href="#/ghid#regimuri">Ce înseamnă →</a></header>
        <p class="widget-note">Cine a decis inițial sancțiunea preluată de Republica Moldova.</p>
        ${bars(Object.entries(regimes).sort((a, b) => b[1] - a[1]).map(([regime, value]) => ({
          label: `${regime} · ${REGIME_LABEL[regime] || regime}`, value, href: searchHash({ ...SEARCH_DEFAULTS, regime }),
        })))}
        <h4 class="sub">Pe tip</h4>
        ${bars(["person", "entity", "vessel"].map((type) => ({ label: capitalize(TYPE_PLURAL[type]), value: count((s) => s.type === type), href: searchHash({ ...SEARCH_DEFAULTS, type }) })).filter((row) => row.value))}
      </section>
    </div>

    <section class="widget wide">
      <header><h3>Cronologia aplicării în Republica Moldova</h3><span class="muted">înregistrări pe lună</span></header>
      ${timeline(months)}
    </section>

    <section class="widget wide">
      <header><h3>Cele mai mari programe de sancțiuni</h3><a href="#/decizii">Toate deciziile →</a></header>
      ${bars(Object.entries(programs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, value]) => {
        const decision = state.decisionById.get(id);
        return { label: `${decision.regime} · ${themeOf(decision.title)}`, value, href: `#/decizie/${id}`, note: shortDecision(decision) };
      }), { log: true })}
    </section>

    <section class="audiences">
      <article>
        <h3>Pentru cetățeni și jurnaliști</h3>
        <p>Căutați un nume așa cum îl știți, cu sau fără diacritice. Fișa arată motivul sancțiunii, măsurile aplicate și trimiterea la pagina din decizie.</p>
        <a href="#/ghid">Cum citiți o fișă →</a>
      </article>
      <article>
        <h3>Pentru bănci și entități raportoare</h3>
        <p>Verificați clienți după IDNP sau document, rulați liste întregi în lot și păstrați dovada verificării, cu data și versiunea listei.</p>
        <a href="#/lot">Verificare în lot →</a>
      </article>
      <article>
        <h3>Pentru instituții și dezvoltatori</h3>
        <p>API static, gratuit, fără cheie: JSON și CSV, verificare IDNP printr-un singur apel, topuri și statistici. Integrare în câteva minute.</p>
        <a href="#/api">Documentația API →</a>
      </article>
    </section>

    <section class="steps">
      <h3>Cum funcționează</h3>
      <ol>
        <li><b>Căutați</b><span>un nume, un IDNP sau un număr de document. Rezultatele apar pe măsură ce scrieți.</span></li>
        <li><b>Verificați identitatea</b><span>comparând data nașterii, cetățenia și documentele din fișă. Un nume identic nu înseamnă aceeași persoană.</span></li>
        <li><b>Documentați</b><span>salvând dovada verificării și consultând decizia oficială, la pagina indicată.</span></li>
      </ol>
    </section>
  `;
  bindHomeSearch();
}

function countBy(list, fn) {
  const out = {};
  for (const item of list) {
    const key = fn(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function kpi(value, label, note = "", href = "") {
  const body = `<b>${esc(value)}</b><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}`;
  return href ? `<a class="kpi" href="${href}">${body}</a>` : `<div class="kpi">${body}</div>`;
}

function miniRow(subject, date) {
  const decision = state.decisionById.get(subject.decisionId);
  return `<li><a href="#/subiect/${encodeURIComponent(subject.id)}">
    <span class="mini-name">${esc(subject.name)}</span>
    <span class="mini-meta">${esc(TYPE_LABEL[subject.type])} · ${esc(subject.regime)} · ${esc(themeOf(decision?.title).slice(0, 48))}</span>
  </a><span class="mini-date">${esc(date)}</span></li>`;
}

function topMini(group) {
  return `<li><a href="#/subiect/${encodeURIComponent(group.id)}">
    <span class="mini-name">${esc(group.name)}</span>
    <span class="mini-meta">${esc(group.role || `${TYPE_LABEL[group.type]} · ${group.regimes.join(", ")}`)}</span>
  </a><span class="mini-score" title="Indice de relevanță">${group.score}</span></li>`;
}

function bars(rows, { log = false } = {}) {
  const scale = (value) => (log ? Math.log10(value + 1) : value);
  const max = Math.max(1, ...rows.map((row) => scale(row.value)));
  return `<ul class="bars">${rows.map((row) => `<li>
    <a href="${row.href || "#"}">
      <span class="bar-label">${esc(row.label)}${row.note ? ` <small>${esc(row.note)}</small>` : ""}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (scale(row.value) / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar-value">${num(row.value)}</span>
    </a>
  </li>`).join("")}</ul>${log ? `<p class="widget-note">Scară logaritmică: programul Rusia–Ucraina are de zeci de ori mai mulți subiecți decât celelalte.</p>` : ""}`;
}

const TIMELINE_FROM = "2023-01";

function timeline(months) {
  const keys = Object.keys(months).sort();
  if (!keys.length) return "";
  const before = keys.filter((ym) => ym < TIMELINE_FROM).reduce((sum, ym) => sum + months[ym], 0);
  const start = keys[0] < TIMELINE_FROM ? TIMELINE_FROM : keys[0];
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = keys[keys.length - 1].split("-").map(Number);
  const all = [];
  for (let y = startYear, m = startMonth; y < endYear || (y === endYear && m <= endMonth); m += 1) {
    if (m > 12) { m = 1; y += 1; }
    if (y > endYear || (y === endYear && m > endMonth)) break;
    all.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const max = Math.max(before, ...all.map((ym) => months[ym] || 0));
  const height = (value) => (value ? Math.max(4, Math.sqrt(value / max) * 100) : 0);
  const peaks = all.map((ym) => [ym, months[ym] || 0]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ym, value]) => `${monthLabel(ym)} (${num(value)})`);
  return `<div class="timeline" role="img" aria-label="Înregistrări aplicate pe lună">
    ${before ? `<span class="tl-col before" title="Înainte de 2023: ${num(before)}">
      <span class="tl-bar" style="height:${height(before).toFixed(1)}%"></span><span class="tl-year">înainte</span>
    </span>` : ""}
    ${all.map((ym) => {
      const value = months[ym] || 0;
      return `<a class="tl-col" href="${searchHash({ ...SEARCH_DEFAULTS, year: ym.slice(0, 4), sort: "recent" })}" title="${monthLabel(ym)}: ${num(value)}">
        <span class="tl-bar" style="height:${height(value).toFixed(1)}%"></span>
        ${ym.endsWith("-01") || ym === all[0] ? `<span class="tl-year">${ym.slice(0, 4)}</span>` : ""}
      </a>`;
    }).join("")}
  </div>
  <p class="widget-note">Vârfuri: ${esc(peaks.join(", "))}.${before ? ` Alte ${num(before)} înregistrări au date de aplicare anterioare anului 2023.` : ""} Înălțimea barelor este pe scară radicală, ca lunile mici să rămână vizibile.</p>`;
}

function bindHomeSearch() {
  const form = document.querySelector("#cautare");
  let mode = "all";
  form.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      form.querySelectorAll("[data-mode]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      form.elements.q.placeholder = placeholder(mode);
      form.querySelector(".hint").textContent = modeHint(mode);
      form.elements.q.focus();
    });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    location.hash = searchHash({ ...SEARCH_DEFAULTS, q: form.elements.q.value, mode });
  });
}

// ——— topuri ———

const TOP_TABS = [
  ["relevanta", "Cei mai relevanți"],
  ["moldova", "Legătură cu RM"],
  ["internationali", "Internaționali"],
  ["recente", "Ultimii adăugați"],
  ["multi", "Mai multe regimuri"],
  ["entitati", "Entități"],
  ["programe", "Programe"],
];

function renderTops(params) {
  const tab = TOP_TABS.some(([id]) => id === params.get("t")) ? params.get("t") : "relevanta";
  setTitle(`Topuri — ${TOP_TABS.find(([id]) => id === tab)[1]}`);
  const top = state.top || {};
  const bodies = {
    relevanta: () => topList(top.relevance, "Primele 50 de persoane după indicele de relevanță."),
    moldova: () => topList(top.moldova, "Toți subiecții cu cetățenie moldovenească sau IDNP, grupați pe persoană. O persoană sancționată în mai multe decizii apare o singură dată."),
    internationali: () => topList(top.international, "Primele 50 de persoane fără legătură directă cu Republica Moldova, după indicele de relevanță."),
    recente: () => recentTimeline(),
    multi: () => topList(top.multiRegime, "Subiecți pe care cel puțin două regimuri diferite (de exemplu UE și Canada) i-au sancționat, iar Republica Moldova a preluat ambele decizii."),
    entitati: () => topList(top.entities, "Companii, organizații și grupări, după numărul de regimuri, de decizii și de denumiri alternative."),
    programe: () => programsTable(),
  };
  main.innerHTML = `
    <div class="page-head">
      <h2>Topuri și noutăți</h2>
      <p class="muted">Clasamente calculate automat din deciziile CIS, după criterii publice. Un loc în top indică vizibilitatea unui caz, nu gravitatea faptelor.</p>
    </div>
    <nav class="tabs" aria-label="Clasamente">
      ${TOP_TABS.map(([id, label]) => `<a href="#/topuri?t=${id}" ${id === tab ? 'aria-current="page"' : ""}>${label}</a>`).join("")}
    </nav>
    ${bodies[tab]()}
    ${["relevanta", "moldova", "internationali", "multi", "entitati"].includes(tab) ? methodology(top.method) : ""}
  `;
}

function topList(groups = [], intro) {
  if (!groups.length) return `<p class="empty">Nu există date pentru acest clasament.</p>`;
  const max = Math.max(...groups.map((group) => group.score), 1);
  return `
    <p class="muted">${esc(intro)}</p>
    <ol class="rank-list big">
      ${groups.map((group, index) => `<li class="rank-row">
        <span class="rank">${index + 1}</span>
        <div class="rank-body">
          <a class="rank-name" href="#/subiect/${encodeURIComponent(group.id)}">${esc(group.name)}</a>
          ${group.role ? `<p class="role">${esc(group.role)}</p>` : ""}
          <div class="meta">
            ${chip(TYPE_LABEL[group.type])}
            ${regimeChips(group.regimes)}
            ${group.idnp ? chip(`IDNP ${group.idnp}`, "seal") : ""}
            ${group.firstApplied ? chip(`din ${formatDate(group.firstApplied)}`) : ""}
          </div>
          ${group.why.length ? `<ul class="why">${group.why.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="rank-score" title="Indice de relevanță">
          <b>${group.score}</b>
          <span class="bar-track"><span class="bar-fill" style="width:${((group.score / max) * 100).toFixed(0)}%"></span></span>
        </div>
      </li>`).join("")}
    </ol>`;
}

function methodology(method) {
  if (!method) return "";
  return `
    <details class="method" id="metodologie">
      <summary>Cum se calculează indicele de relevanță</summary>
      <p>Indicele ajută la prioritizarea atenției și este calculat automat, fără intervenție editorială. Punctele se adună:</p>
      <ul>
        <li><b>+${method.moldova}</b> legătură cu Republica Moldova (cetățenie sau IDNP);</li>
        <li><b>+${method.perExtraRegime}</b> pentru fiecare regim suplimentar care sancționează aceeași persoană (UE, ONU, SUA, Regatul Unit, Canada);</li>
        <li><b>+${method.perExtraDecision}</b> pentru fiecare decizie CIS suplimentară;</li>
        <li><b>+${method.perMention}</b> pentru fiecare alt subiect în a cărui motivare este menționat (maximum ${method.mentionCap});</li>
        <li><b>+${method.role.join(" / +")}</b> după funcție: demnitar sau lider politic / comandant, judecător, conducător / om de afaceri sau politician;</li>
        <li><b>+${method.bothMeasures}</b> când se aplică atât blocarea fondurilor, cât și restricțiile de călătorie;</li>
        <li><b>+${method.recent}</b> când sancțiunea a fost aplicată în ultimele ${Math.round(method.recentDays / 30)} luni.</li>
      </ul>
      <p class="muted">Aceeași persoană din decizii diferite este recunoscută după IDNP sau după nume și data nașterii. Formula este publică și se aplică identic tuturor subiecților.</p>
    </details>`;
}

function recentTimeline() {
  const active = state.subjects.filter((subject) => subject.active);
  const byDate = new Map();
  for (const subject of active) {
    const date = appliedOn(subject);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(subject);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, 12);
  return `
    <p class="muted">Loturile de subiecți aplicate în Republica Moldova, de la cel mai recent. Data este cea a aplicării în RM din anexa deciziei; dacă lipsește, se folosește data deciziei.</p>
    <ol class="batches">
      ${dates.map((date) => {
        const items = byDate.get(date).sort((a, b) => a.name.localeCompare(b.name, "ro"));
        const decisions = countBy(items, (subject) => subject.decisionId);
        const persons = items.filter((s) => s.type === "person").length;
        return `<li class="batch">
          <div class="batch-date"><b>${esc(formatDate(date))}</b><span>${plural(items.length, "subiect", "subiecți")}</span></div>
          <div class="batch-body">
            <p class="batch-meta">${num(persons)} persoane · ${num(items.length - persons)} entități · ${Object.keys(decisions).map((id) => {
              const decision = state.decisionById.get(id);
              return `<a href="#/decizie/${id}">${esc(decision.regime)} · ${esc(themeOf(decision.title))}</a>`;
            }).join(" · ")}</p>
            <ul class="name-cloud">${items.slice(0, 14).map((subject) => `<li><a href="#/subiect/${encodeURIComponent(subject.id)}">${esc(subject.name)}</a></li>`).join("")}
              ${items.length > 14 ? `<li class="more">și încă ${num(items.length - 14)}</li>` : ""}
            </ul>
          </div>
        </li>`;
      }).join("")}
    </ol>`;
}

function programsTable() {
  const active = state.subjects.filter((subject) => subject.active);
  const counts = countBy(active, (subject) => subject.decisionId);
  const rows = Object.entries(counts).map(([id, value]) => ({ decision: state.decisionById.get(id), value }))
    .sort((a, b) => b.value - a.value);
  return `
    <p class="muted">Deciziile de punere în aplicare, după numărul de subiecți extrași.</p>
    ${bars(rows.map(({ decision, value }) => ({
      label: `${decision.regime} · ${themeOf(decision.title)}`, value, href: `#/decizie/${decision.id}`, note: decisionLabel(decision),
    })), { log: true })}`;
}

// ——— fișa subiectului ———

async function renderSubject(id) {
  const subject = state.byId.get(id);
  if (!subject) {
    main.innerHTML = `<p class="empty">Înregistrarea nu există. <a href="#/cauta">Înapoi la căutare</a></p>`;
    return;
  }
  main.innerHTML = `<p class="empty">Se încarcă fișa…</p>`;
  const decision = state.decisionById.get(subject.decisionId);
  const detail = await loadDetail(subject);
  const group = groupOf(subject).filter((item) => item.active);
  const siblings = group.filter((item) => item.id !== subject.id);
  const regimes = [...new Set(group.map((item) => item.regime))].sort();
  const measures = [...new Set(group.flatMap((item) => state.decisionById.get(item.decisionId)?.measures || []))];
  const reason = detail.reason || `Măsura este dispusă prin ${decisionLabel(decision)}. ${decision?.title || ""}`;
  const ranked = [...(state.top?.relevance || []), ...(state.top?.moldova || []), ...(state.top?.entities || [])]
    .find((item) => item.ids.includes(subject.id));
  const neighbours = state.subjects
    .filter((item) => item.decisionId === subject.decisionId && item.active && item.id !== subject.id && item.type === subject.type)
    .sort((a, b) => Math.abs(Number(a.listNumber) - Number(subject.listNumber)) - Math.abs(Number(b.listNumber) - Number(subject.listNumber)))
    .slice(0, 6);
  const foreign = subject.listing?.foreign;
  const md = subject.listing?.md || decision?.date;
  setTitle(subject.name);

  main.innerHTML = `
    <nav class="crumbs"><a href="#/cauta">Căutare</a> / <a href="#/decizie/${esc(decision?.id)}">${esc(shortDecision(decision))}</a> / <span>${esc(subject.name)}</span></nav>
    <article class="sheet">
      <p class="kicker">${esc(TYPE_LABEL[subject.type] || subject.type)} · ${esc(regimes.map((r) => REGIME_LABEL[r] || r).join(", "))}</p>
      <h2>${esc(subject.name)}</h2>
      ${(subject.aliases || []).length ? `<p class="aliases">Și: ${esc(subject.aliases.join(" · "))}</p>` : ""}
      <div class="banner hit"><p><b>Figurează în lista măsurilor restrictive</b> puse în aplicare de Republica Moldova${group.length > 1 ? `, în ${group.length} decizii` : ""}.</p></div>
      <div class="actions">
        <button type="button" class="ghost" id="copy">Copiază linkul</button>
        <button type="button" class="ghost" onclick="window.print()">Tipărește fișa</button>
        <a class="ghost" href="${esc(pdfHref(decision, detail.page || subject.page))}" target="_blank" rel="noopener">Decizia oficială (PDF, p. ${esc(detail.page || subject.page)})</a>
        <a class="ghost" href="dataset/details/${encodeURIComponent(subject.decisionId)}.json" target="_blank" rel="noopener">Date JSON</a>
      </div>

      <p class="summary">${esc(summarySentence(subject, decision, regimes, measures))}</p>

      ${ranked ? `<div class="rank-note"><b>Indice de relevanță ${ranked.score}</b>${ranked.why.length ? ` — ${esc(ranked.why.join("; "))}` : ""}. <a href="#/topuri#metodologie">Metodologie</a></div>` : ""}

      <ol class="steps-line" aria-label="Cronologie">
        ${foreign ? `<li><b>${esc(formatDate(foreign))}</b><span>inclus de ${esc(REGIME_LABEL[subject.regime] || subject.regime)}</span></li>` : ""}
        ${decision?.date ? `<li><b>${esc(formatDate(decision.date))}</b><span>${esc(shortDecision(decision))} a CIS</span></li>` : ""}
        ${md ? `<li><b>${esc(formatDate(md))}</b><span>aplicat în Republica Moldova${foreign && md > foreign ? ` · după ${plural(daysBetween(foreign, md), "zi", "zile")}` : ""}</span></li>` : ""}
        <li class="now"><b>în vigoare</b><span>la ${esc(formatDate(state.generatedAt))}</span></li>
      </ol>

      <h3>Date de identificare</h3>
      <div class="grid">
        ${field("Data nașterii", formatDate(subject.birthDate))}
        ${field("Locul nașterii", detail.birthPlace)}
        ${field("Cetățenie", (subject.citizenship || []).join(", "))}
        ${field("Sex", detail.gender)}
        ${field("Funcție", detail.function)}
        ${field("IDNP", subject.idnp)}
        ${field("Documente", (subject.documents || []).map(docLabel).join("; "))}
        ${field("Nr. în anexă", subject.listNumber)}
      </div>
      <p class="muted small">Un nume identic nu înseamnă aceeași persoană. Comparați data nașterii, cetățenia și documentele înainte de a lua o decizie.</p>

      <h3>Măsuri aplicate</h3>
      <div class="measures">
        ${measures.length ? measures.map((measure) => `<div class="measure">
          <h4>${esc(MEASURE_LABEL[measure] || measure)}</h4>
          <p>${esc(MEASURE_INFO[measure]?.text || "")}</p>
          <p class="muted">${esc(MEASURE_INFO[measure]?.action || "")}</p>
        </div>`).join("") : `<p class="muted">Decizia nu enumeră explicit măsurile în text. Consultați actul oficial.</p>`}
      </div>

      <div class="reason">
        <h3>Motivul includerii</h3>
        <p>${esc(reason)}</p>
      </div>

      ${detail.notes ? `<h3>Note din decizie</h3><p class="idents">${esc(detail.notes)}</p>` : ""}
      ${detail.identifiersText ? `<details class="raw"><summary>Textul de identificare din anexă, așa cum apare în PDF</summary><p class="idents">${esc(detail.identifiersText)}</p></details>` : ""}

      <h3>Temeiul juridic</h3>
      <p><a href="#/decizie/${esc(decision?.id || "")}">${esc(decisionLabel(decision))}</a> ${esc(decision?.title ? `privind ${decision.title.replace(/\s+/g, " ")}` : "")}</p>
      ${(decision?.instruments || []).length ? `<p class="muted">Actul sursă: ${esc(decision.instruments.join("; "))}</p>` : ""}
      ${(decision?.amendedBy || []).length ? `<p class="muted">Anexa a fost modificată prin deciziile nr. ${decision.amendedBy.map((n) => `<a href="#/decizie/${esc(n)}">${esc(n)}</a>`).join(", ")}.</p>` : ""}

      ${siblings.length ? `<h3>Aceeași persoană în alte decizii</h3><ul class="plain">${siblings.map((item) => {
        const other = state.decisionById.get(item.decisionId);
        return `<li><a href="#/subiect/${encodeURIComponent(item.id)}">${esc(decisionLabel(other))}</a> · ${esc(REGIME_LABEL[item.regime] || item.regime)}</li>`;
      }).join("")}</ul>` : ""}

      ${neighbours.length ? `<h3>Din aceeași decizie</h3><ul class="name-cloud">${neighbours.map((item) => `<li><a href="#/subiect/${encodeURIComponent(item.id)}">${esc(item.name)}</a></li>`).join("")}</ul>` : ""}
    </article>
  `;
  document.querySelector("#copy")?.addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(location.href);
      event.target.textContent = "Link copiat";
    } catch {
      event.target.textContent = "Copiați din bara de adrese";
    }
  });
}

function summarySentence(subject, decision, regimes, measures) {
  const who = subject.type === "person" ? "Persoana" : subject.type === "vessel" ? "Nava" : "Entitatea";
  const regimeText = regimes.map((r) => REGIME_LABEL[r] || r).join(" și ");
  const measureText = measures.length ? ` Măsuri: ${measures.map((m) => (MEASURE_LABEL[m] || m).toLowerCase()).join(" și ")}.` : "";
  return `${who} este inclusă în lista măsurilor restrictive aplicate de Republica Moldova prin ${decisionLabel(decision)}, care preia sancțiunile instituite de ${regimeText}.${measureText}`;
}

function field(label, value) {
  if (!value) return "";
  return `<div><h4>${esc(label)}</h4><p>${esc(value)}</p></div>`;
}

async function loadDetail(subject) {
  if (!state.detailCache.has(subject.decisionId)) {
    try {
      const response = await fetch(`dataset/details/${encodeURIComponent(subject.decisionId)}.json`);
      state.detailCache.set(subject.decisionId, response.ok ? await response.json() : {});
    } catch {
      state.detailCache.set(subject.decisionId, {});
    }
  }
  return state.detailCache.get(subject.decisionId)[subject.id] || {};
}

// ——— decizii ———

function kindLabel(decision) {
  return { implementation: "Punere în aplicare", amendment: "Modificare", alignment: "Aliniere", report: "Raport" }[decision.kind] || decision.kind;
}

function renderCatalog(params) {
  setTitle("Decizii");
  const filter = { regime: params.get("regime") || "all", kind: params.get("kind") || "all", q: params.get("q") || "" };
  const regimes = [...new Set(state.decisions.map((decision) => decision.regime))].sort();
  const render = () => {
    const q = fold(filter.q);
    const items = [...state.decisions]
      .filter((decision) => filter.regime === "all" || decision.regime === filter.regime)
      .filter((decision) => filter.kind === "all" || decision.kind === filter.kind)
      .filter((decision) => !q || fold(`${decision.number} ${decision.title} ${decision.regime}`).includes(q))
      .sort((a, b) => (b.date || "0").localeCompare(a.date || "0") || (b.number || 0) - (a.number || 0));
    const byYear = new Map();
    for (const decision of items) {
      const year = decision.date ? decision.date.slice(0, 4) : "Fără dată";
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(decision);
    }
    document.querySelector("#catalog").innerHTML = items.length ? [...byYear.entries()].map(([year, list]) => `
      <h3 class="year">${esc(year)} <span class="muted">· ${plural(list.length, "decizie", "decizii")}</span></h3>
      <ul class="decision-list">${list.map((decision) => `<li><a href="#/decizie/${esc(decision.id)}">
        <div class="card-top">
          ${regimeChips([decision.regime])}
          ${chip(kindLabel(decision))}
          ${decision.status === "repealed" ? chip("Abrogată", "seal") : ""}
          ${decision.subjectCount ? chip(plural(decision.subjectCount, "subiect", "subiecți"), "pine") : ""}
          <span class="card-date">${esc(formatDate(decision.date))}</span>
        </div>
        <h4>${esc(decision.kind === "report" ? "Raportul anual CIS" : `Decizia CIS nr. ${decision.number}`)}</h4>
        <p>${esc(themeOf(decision.title))}</p>
        ${decision.notice ? `<p class="muted small">${esc(decision.notice)}</p>` : ""}
      </a></li>`).join("")}</ul>`).join("") : `<p class="empty">Nicio decizie pentru filtrele alese.</p>`;
  };
  const kinds = [...new Set(state.decisions.map((decision) => decision.kind))];
  main.innerHTML = `
    <div class="page-head">
      <h2>Deciziile Consiliului interinstituțional de supervizare</h2>
      <p class="muted">${plural(state.decisions.length, "document", "documente")}. <b>Deciziile de punere în aplicare</b> conțin listele de subiecți; <b>deciziile de modificare</b> actualizează aceste liste, iar textul consolidat este deja inclus; <b>deciziile de aliniere</b> stabilesc cadrul pentru un nou regim.</p>
    </div>
    <form class="filters inline" id="catalog-filters">
      <label class="field">Caută<input type="search" name="q" value="${esc(filter.q)}" placeholder="Număr sau temă, ex. Venezuela"></label>
      ${select("regime", "Regim", [["all", "Toate"], ...regimes.map((r) => [r, r])], filter.regime)}
      ${select("kind", "Tip", [["all", "Toate"], ...kinds.map((kind) => [kind, kindLabel({ kind })])], filter.kind)}
    </form>
    <div id="catalog"></div>
  `;
  const form = document.querySelector("#catalog-filters");
  const sync = () => {
    filter.q = form.elements.q.value;
    filter.regime = form.elements.regime.value;
    filter.kind = form.elements.kind.value;
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v && v !== "all"));
    history.replaceState(null, "", `#/decizii${qs.toString() ? `?${qs}` : ""}`);
    render();
  };
  form.addEventListener("input", sync);
  form.addEventListener("submit", (event) => event.preventDefault());
  render();
}

function renderDecision(id, params) {
  const decision = state.decisionById.get(id);
  if (!decision) {
    main.innerHTML = `<p class="empty">Decizia nu există. <a href="#/decizii">Toate deciziile</a></p>`;
    return;
  }
  setTitle(decisionLabel(decision));
  const people = state.subjects
    .filter((subject) => subject.decisionId === id && subject.active)
    .sort((a, b) => a.page - b.page || Number(a.listNumber) - Number(b.listNumber));
  const filter = { q: params.get("q") || "", page: Number(params.get("p") || 1) };
  const counts = countBy(people, (subject) => subject.type);
  const amends = state.decisions.filter((other) => (other.amendedBy || []).includes(String(decision.number)));
  main.innerHTML = `
    <nav class="crumbs"><a href="#/decizii">Decizii</a> / <span>${esc(shortDecision(decision))}</span></nav>
    <article class="sheet">
      <p class="kicker">${esc(REGIME_LABEL[decision.regime] || decision.regime)} · ${esc(kindLabel(decision))}</p>
      <h2>${esc(decisionLabel(decision))}</h2>
      <p class="summary">privind ${esc(decision.title.replace(/\s+/g, " "))}</p>
      ${decision.status === "repealed" ? `<p class="banner warn">Decizie abrogată. Subiecții ei nu apar în căutare.</p>` : ""}
      ${decision.notice ? `<p class="banner warn">${esc(decision.notice)}</p>` : ""}
      <div class="kpis small">
        ${kpi(num(people.length), noun(people.length, "subiecți extrași"))}
        ${Object.entries(counts).map(([type, value]) => kpi(num(value), noun(value, TYPE_PLURAL[type]))).join("")}
        ${kpi(formatDate(decision.date) || "—", "data deciziei")}
      </div>
      ${(decision.measures || []).length ? `<div class="measures">${decision.measures.map((measure) => `<div class="measure"><h4>${esc(MEASURE_LABEL[measure] || measure)}</h4><p>${esc(MEASURE_INFO[measure]?.text || "")}</p></div>`).join("")}</div>` : ""}
      ${(decision.instruments || []).length ? `<p class="muted">Acte sursă: ${esc(decision.instruments.join("; "))}</p>` : ""}
      ${(decision.amendedBy || []).length ? `<p class="muted">Modificată prin deciziile nr. ${decision.amendedBy.map((n) => `<a href="#/decizie/${esc(n)}">${esc(n)}</a>`).join(", ")}.</p>` : ""}
      ${amends.length ? `<p class="muted">Această decizie modifică: ${amends.map((other) => `<a href="#/decizie/${esc(other.id)}">${esc(shortDecision(other))}</a>`).join(", ")}.</p>` : ""}
      <div class="actions">
        <a class="ghost" href="${esc(pdfHref(decision))}" target="_blank" rel="noopener">Deschide PDF-ul oficial</a>
        ${people.length ? `<button type="button" class="ghost" id="dexport">Export CSV (${num(people.length)})</button>` : ""}
      </div>
    </article>
    ${people.length ? `
      <div class="toolbar">
        <label class="field grow">Caută în această decizie<input type="search" id="dq" value="${esc(filter.q)}" placeholder="Nume sau alias"></label>
      </div>
      <div id="dlist"></div>` : `<p class="empty">Nu sunt subiecți extrași din acest fișier.</p>`}
  `;
  document.querySelector("#dexport")?.addEventListener("click", () => exportSubjects(people, `decizia-${decision.number}.csv`));
  const list = document.querySelector("#dlist");
  if (!list) return;
  const paint = () => {
    const queryTokens = tokens(filter.q);
    const items = queryTokens.length ? people.filter((subject) => queryTokens.every((token) => state.blob.get(subject.id).includes(token))) : people;
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    filter.page = Math.min(Math.max(1, filter.page), pages);
    const slice = items.slice((filter.page - 1) * PAGE_SIZE, filter.page * PAGE_SIZE);
    list.innerHTML = `
      <p class="muted">${plural(items.length, "subiect", "subiecți")}</p>
      <div class="cards">${slice.map((subject) => `
        <a class="card" href="#/subiect/${encodeURIComponent(subject.id)}">
          <div class="card-top">${chip(`${TYPE_LABEL[subject.type] || subject.type} · nr. ${subject.listNumber}`)}${subject.moldova ? chip("Legătură RM", "seal") : ""}${appliedOn(subject) ? `<span class="card-date">aplicat ${esc(formatDate(appliedOn(subject)))}</span>` : ""}</div>
          <h3>${highlight(subject.name, queryTokens)}</h3>
          <div class="meta">${subject.idnp ? chip(`IDNP ${subject.idnp}`, "seal") : ""}${subject.birthDate ? chip(`n. ${formatDate(subject.birthDate)}`) : ""}${(subject.citizenship || []).slice(0, 1).map((c) => chip(c)).join("")}</div>
        </a>`).join("")}</div>
      ${pager(filter.page, pages)}`;
    list.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
      filter.page = Number(button.dataset.page);
      syncUrl();
      paint();
      list.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  };
  const syncUrl = () => {
    const qs = new URLSearchParams();
    if (filter.q) qs.set("q", filter.q);
    if (filter.page > 1) qs.set("p", String(filter.page));
    history.replaceState(null, "", `#/decizie/${id}${qs.toString() ? `?${qs}` : ""}`);
  };
  document.querySelector("#dq").addEventListener("input", (event) => {
    filter.q = event.target.value;
    filter.page = 1;
    syncUrl();
    paint();
  });
  paint();
}

// ——— verificare în lot ———

function renderBatch() {
  setTitle("Verificare în lot");
  main.innerHTML = `
    <div class="page-head">
      <h2>Verificare în lot</h2>
      <p class="muted">Verificați dintr-o dată lista de clienți, parteneri sau beneficiari. Comparația se face <b>integral în browserul dvs.</b>: numele introduse nu sunt trimise nicăieri.</p>
    </div>
    <form class="search-panel" id="batch">
      <label class="field">Un subiect pe rând: nume, IDNP sau document. Opțional, după punct și virgulă, data nașterii.
        <textarea name="rows" rows="9" spellcheck="false" placeholder="Ilan Shor; 06.03.1987&#10;2002008008309&#10;SC Exemplu SRL&#10;Popescu Ion; 1980-01-31">${esc(state.batch?.raw || "")}</textarea>
      </label>
      <div class="filters">
        <label class="field">sau încărcați un fișier CSV / TXT<input type="file" name="file" accept=".csv,.txt,text/csv,text/plain"></label>
        ${select("threshold", "Sensibilitate", [["0.95", "Strictă — doar nume aproape identice"], ["0.88", "Standard (recomandat)"], ["0.82", "Extinsă — prinde transliterări diferite"]], state.batch?.threshold || "0.88")}
        <button type="submit" class="primary">Verifică lista</button>
      </div>
      <p class="hint">Fișierul CSV poate avea antet: coloanele <code>nume</code>/<code>name</code>, <code>idnp</code> și <code>data_nasterii</code>/<code>birth_date</code> sunt recunoscute automat. Maximum 5.000 de rânduri.</p>
    </form>
    <div id="batch-results" aria-live="polite"></div>
  `;
  const form = document.querySelector("#batch");
  form.elements.file.addEventListener("change", async () => {
    const file = form.elements.file.files[0];
    if (!file) return;
    form.elements.rows.value = parseUpload(await file.text());
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runBatch(form.elements.rows.value, form.elements.threshold.value);
  });
  if (state.batch?.results) paintBatch();
}

function parseUpload(text) {
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return "";
  const delimiter = [";", "\t", ","].map((d) => [d, lines[0].split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const split = (line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]).map((cell) => fold(cell));
  const find = (re) => head.findIndex((cell) => re.test(cell));
  const nameAt = find(/^(nume|name|denumire|full name|nume complet|client)/);
  const idnpAt = find(/^(idnp|idno|cod)/);
  const birthAt = find(/(nastere|nasterii|birth|dob)/);
  const hasHeader = nameAt >= 0 || idnpAt >= 0;
  const body = hasHeader ? lines.slice(1) : lines;
  return body.map((line) => {
    const cells = split(line);
    if (!hasHeader) return cells.filter(Boolean).slice(0, 2).join("; ");
    const primary = cells[nameAt] || cells[idnpAt] || "";
    const birth = birthAt >= 0 ? cells[birthAt] : "";
    const extra = nameAt >= 0 && idnpAt >= 0 && cells[idnpAt] ? `\n${cells[idnpAt]}` : "";
    return `${primary}${birth ? `; ${birth}` : ""}${extra}`;
  }).join("\n");
}

function parseBirth(text) {
  const value = String(text || "").trim();
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return value;
  m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

function runBatch(raw, threshold) {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5000);
  const target = document.querySelector("#batch-results");
  if (!rows.length) {
    target.innerHTML = `<p class="banner warn">Introduceți cel puțin un nume, un IDNP sau un număr de document.</p>`;
    return;
  }
  state.batch = { raw, threshold, results: [], checkedAt: new Date().toISOString() };
  const index = getIndex();
  const active = state.subjects.filter((subject) => subject.active);
  const byIdnp = new Map(active.filter((s) => s.idnp).map((s) => [s.idnp, s]));
  const byDoc = new Map();
  for (const subject of active) for (const key of docKeys(subject)) if (key.length >= 6) byDoc.set(key, subject);
  let at = 0;
  const step = () => {
    const end = Math.min(rows.length, at + 150);
    for (; at < end; at += 1) {
      const [query, birthRaw] = rows[at].split(/\s*;\s*/);
      const compact = (query || "").replace(/\s/g, "");
      const birth = parseBirth(birthRaw);
      let result;
      if (/^\d{13}$/.test(compact)) {
        const hit = byIdnp.get(compact);
        result = { query, birth, status: hit ? "exact" : "none", kind: "IDNP", subject: hit, score: hit ? 1 : 0 };
      } else if (/^[a-z]{0,3}\d{6,10}$/i.test(compact)) {
        const hit = byDoc.get(compact.toLowerCase());
        result = { query, birth, status: hit ? "exact" : "none", kind: "Document", subject: hit, score: hit ? 1 : 0 };
      } else {
        const [hit] = fuzzyFind(index, query, { threshold: Number(threshold), limit: 1, birthDate: birth });
        const strong = hit && hit.score >= 0.97 && hit.birth !== "different";
        result = {
          query, birth, kind: "Nume",
          status: !hit ? "none" : strong ? "strong" : "possible",
          subject: hit?.subject, score: hit?.score || 0, birthCheck: hit?.birth || "",
        };
      }
      state.batch.results.push(result);
    }
    target.innerHTML = `<p class="muted">Se verifică… ${num(at)} din ${num(rows.length)}</p>`;
    if (at < rows.length) setTimeout(step, 0);
    else paintBatch();
  };
  step();
}

const BATCH_STATUS = {
  exact: ["Potrivire exactă", "seal"],
  strong: ["Potrivire puternică", "seal"],
  possible: ["Posibilă potrivire", "warn"],
  none: ["Nu figurează", "ok"],
};

function paintBatch() {
  const { results, checkedAt } = state.batch;
  const target = document.querySelector("#batch-results");
  const tally = countBy(results, (row) => row.status);
  const flagged = results.filter((row) => row.status !== "none");
  const birthNote = { same: "data nașterii coincide", year: "același an al nașterii", different: "data nașterii diferă" };
  target.innerHTML = `
    <section class="kpis small">
      ${kpi(num(results.length), "rânduri verificate")}
      ${kpi(num((tally.exact || 0) + (tally.strong || 0)), "potriviri exacte sau puternice")}
      ${kpi(num(tally.possible || 0), "de verificat manual")}
      ${kpi(num(tally.none || 0), "nu figurează")}
    </section>
    <div class="toolbar">
      <p>Verificat la ${esc(new Date(checkedAt).toLocaleString("ro-RO"))} față de lista din ${esc(formatDate(state.generatedAt))}.</p>
      <div class="toolbar-actions">
        <label class="check"><input type="checkbox" id="only-flagged" checked> Doar rezultatele semnalate</label>
        <button type="button" class="ghost" id="bexport">Export CSV complet</button>
        <button type="button" class="ghost" onclick="window.print()">Tipărește raportul</button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="results-table">
        <thead><tr><th>#</th><th>Căutat</th><th>Rezultat</th><th>Subiect din listă</th><th>Asemănare</th></tr></thead>
        <tbody>
          ${results.map((row, index) => {
            const [label, tone] = BATCH_STATUS[row.status];
            const decision = row.subject ? state.decisionById.get(row.subject.decisionId) : null;
            return `<tr class="${row.status === "none" ? "is-clear" : ""}">
              <td>${index + 1}</td>
              <td>${esc(row.query)}${row.birth ? `<br><small>n. ${esc(formatDate(row.birth))}</small>` : ""}<br><small class="muted">${esc(row.kind)}</small></td>
              <td><span class="status ${tone}">${label}</span></td>
              <td>${row.subject ? `<a href="#/subiect/${encodeURIComponent(row.subject.id)}">${esc(row.subject.name)}</a><br><small>${esc(TYPE_LABEL[row.subject.type])} · ${esc(row.subject.regime)} · ${esc(shortDecision(decision))}${row.subject.birthDate ? ` · n. ${esc(formatDate(row.subject.birthDate))}` : ""}</small>${row.birthCheck ? `<br><small class="muted">${esc(birthNote[row.birthCheck])}</small>` : ""}` : "—"}</td>
              <td>${row.score ? `${Math.round(row.score * 100)}%` : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${flagged.length ? `<p class="muted small">„Posibilă potrivire” înseamnă doar nume asemănătoare. Confirmați identitatea cu data nașterii și documentele din fișa subiectului.</p>` : `<p class="banner miss"><b>Niciun rând din listă nu figurează</b> printre subiecții sancționați.</p>`}
  `;
  const toggle = target.querySelector("#only-flagged");
  const table = target.querySelector(".results-table");
  const apply = () => table.classList.toggle("hide-clear", toggle.checked && flagged.length > 0);
  toggle.addEventListener("change", apply);
  apply();
  target.querySelector("#bexport").addEventListener("click", () => {
    const lines = [["Rând", "Căutat", "Data nașterii introdusă", "Tip", "Rezultat", "Asemănare", "Subiect", "Data nașterii subiect", "Regim", "Decizie", "Link"].join(",")];
    const base = location.href.split("#")[0];
    results.forEach((row, index) => {
      const decision = row.subject ? state.decisionById.get(row.subject.decisionId) : null;
      lines.push([
        index + 1, row.query, row.birth, row.kind, BATCH_STATUS[row.status][0], row.score ? Math.round(row.score * 100) : "",
        row.subject?.name || "", row.subject?.birthDate || "", row.subject?.regime || "", decision ? decisionLabel(decision) : "",
        row.subject ? `${base}#/subiect/${row.subject.id}` : "",
      ].map(csvCell).join(","));
    });
    lines.push("", csvCell(`Verificat la ${checkedAt}; versiunea listei ${state.generatedAt}`));
    download("verificare-lot.csv", lines);
  });
}

// ——— dovada verificării ———

function renderProof(params) {
  const s = { ...SEARCH_DEFAULTS, q: params.get("q") || "", mode: params.get("mode") || "all" };
  const result = runQuery(s, { filters: false });
  const now = new Date();
  const listed = result.items.length > 0;
  const id = hashCode(`${s.q}|${s.mode}|${now.toISOString()}|${state.generatedAt}`);
  const modeText = { all: "Căutare după nume sau identificator", idnp: "Verificare exactă IDNP", document: "Verificare exactă document" }[s.mode];
  const latest = [...state.decisions].filter((d) => d.date && d.kind !== "report").sort((a, b) => b.date.localeCompare(a.date))[0];
  setTitle("Dovadă de verificare");
  main.innerHTML = `
    <div class="actions no-print">
      <a class="ghost" href="${searchHash(s)}">← Înapoi la rezultate</a>
      <button type="button" class="primary" onclick="window.print()">Tipărește sau salvează PDF</button>
    </div>
    <article class="sheet proof">
      <p class="kicker">Dovadă de verificare · nr. ${id}</p>
      <h2>Verificare în lista măsurilor restrictive aplicate de Republica Moldova</h2>
      <table class="kv">
        <tr><th>Data și ora verificării</th><td>${esc(now.toLocaleString("ro-RO", { dateStyle: "long", timeStyle: "medium" }))}</td></tr>
        <tr><th>Criteriu introdus</th><td><b>${esc(s.q || "—")}</b></td></tr>
        <tr><th>Tipul verificării</th><td>${esc(modeText)}</td></tr>
        <tr><th>Versiunea listei</th><td>${esc(formatDate(state.generatedAt))} · ${plural(state.subjects.filter((x) => x.active).length, "înregistrare", "înregistrări")} din ${plural(state.decisions.filter((d) => d.subjectCount).length, "decizie", "decizii")} CIS${latest ? `, ultima fiind ${esc(decisionLabel(latest))}` : ""}</td></tr>
        <tr><th>Rezultat</th><td>${result.hint ? esc(result.hint) : listed ? `<span class="status seal">Figurează · ${plural(result.items.length, "înregistrare", "înregistrări")}</span>` : `<span class="status ok">Nu figurează</span>`}</td></tr>
      </table>
      ${listed ? `<h3>Înregistrări găsite</h3><table class="results-table"><thead><tr><th>Nume</th><th>Identificare</th><th>Temei</th></tr></thead><tbody>
        ${result.items.slice(0, 50).map((subject) => {
          const decision = state.decisionById.get(subject.decisionId);
          return `<tr><td>${esc(subject.name)}<br><small>${esc(TYPE_LABEL[subject.type])} · ${esc(subject.regime)}</small></td>
            <td>${[subject.idnp ? `IDNP ${subject.idnp}` : "", subject.birthDate ? `n. ${formatDate(subject.birthDate)}` : "", ...(subject.documents || []).slice(0, 2).map(docLabel)].filter(Boolean).map(esc).join("<br>") || "—"}</td>
            <td>${esc(decisionLabel(decision))}, pagina ${esc(subject.page)}</td></tr>`;
        }).join("")}
      </tbody></table>${result.items.length > 50 ? `<p class="muted">Sunt afișate primele 50 din ${num(result.items.length)}.</p>` : ""}` : ""}
      <h3>Limitele verificării</h3>
      <p class="small">Verificarea s-a făcut față de datele extrase automat din deciziile Consiliului interinstituțional de supervizare, la versiunea indicată mai sus. Lista oficială este cea publicată pe date.gov.md și în Monitorul Oficial al Republicii Moldova. ${s.mode === "all" ? "Căutarea după nume găsește potriviri de text și nu confirmă identitatea unei persoane. " : ""}Documentul nu constituie un act oficial și nu înlocuiește procedurile interne de conformitate.</p>
      <p class="small muted">Generat de ${esc(location.href.split("#")[0])} · identificator ${id}</p>
    </article>
  `;
}

// ——— API ———

function renderApi() {
  setTitle("API pentru instituții");
  const base = location.href.split("#")[0].replace(/index\.html$/, "");
  const sampleIdnp = state.top?.moldova?.find((group) => group.idnp)?.idnp || "2002008008309";
  const endpoints = [
    ["GET", "api/v1/index.json", "Manifest: versiunea, data generării, numărul de înregistrări și lista endpoint-urilor. Verificați aici dacă lista s-a schimbat."],
    ["GET", "api/v1/idnp/{IDNP}.json", "Verificare exactă după IDNP. Răspuns 200 cu subiectul și deciziile, sau 404 dacă IDNP-ul nu figurează."],
    ["GET", "dataset/subjects.json", "Lista completă a înregistrărilor: nume, aliasuri, tip, IDNP, documente, cetățenie, regim, decizie, date de includere."],
    ["GET", "api/v1/subjects.csv", "Aceeași listă, în CSV (UTF-8), pentru import în Excel sau în sistemele de screening."],
    ["GET", "dataset/details/{decizie}.json", "Detalii pentru fiecare subiect dintr-o decizie: motivul, funcția, locul nașterii, textul de identificare."],
    ["GET", "dataset/decisions.json", "Catalogul deciziilor CIS: număr, dată, tip, regim, măsuri, acte sursă, modificări."],
    ["GET", "api/v1/latest.json", "Ultimele 150 de înregistrări aplicate în Republica Moldova."],
    ["GET", "api/v1/top.json", "Clasamentele: relevanță, legătură cu RM, mai multe regimuri, entități; cu formula de calcul."],
    ["GET", "api/v1/stats.json", "Statistici: pe tip, regim, măsură, lună de aplicare și program."],
  ];
  main.innerHTML = `
    <div class="page-head">
      <h2>API pentru instituții și dezvoltatori</h2>
      <p class="lede-dark">Integrați lista de sancțiuni a Republicii Moldova în onboarding, în monitorizarea tranzacțiilor sau în propriul portal. Fără cheie, fără cont, fără cost.</p>
    </div>
    <section class="audiences">
      <article><h3>Fișiere statice</h3><p>JSON și CSV servite prin HTTPS, cu cache și CORS deschis. Le puteți citi direct din browser, din server sau dintr-un job programat.</p></article>
      <article><h3>Verificare într-un apel</h3><p>Un singur GET pe <code>api/v1/idnp/{IDNP}.json</code>: 200 înseamnă că figurează, 404 că nu figurează.</p></article>
      <article><h3>Stabil și versionat</h3><p>Câmpurile din <code>v1</code> nu se elimină și nu își schimbă sensul. Pot apărea câmpuri noi; ignorați-le pe cele necunoscute.</p></article>
    </section>

    <section class="widget wide">
      <header><h3>Adresa de bază</h3></header>
      <pre class="code"><code>${esc(base)}</code></pre>
    </section>

    <section class="widget wide">
      <header><h3>Endpoint-uri</h3><a href="api/v1/index.json" target="_blank" rel="noopener">index.json →</a></header>
      <ul class="endpoints">${endpoints.map(([method, path, text]) => `<li>
        <span class="method">${method}</span>
        <div><code>${esc(path)}</code><p>${esc(text)}</p></div>
        ${path.includes("{") ? "" : `<a href="${esc(path)}" target="_blank" rel="noopener">Deschide</a>`}
      </li>`).join("")}</ul>
    </section>

    <section class="widget wide">
      <header><h3>Încercați acum</h3></header>
      <form class="search-row" id="tester">
        <label class="sr" for="tidnp">IDNP</label>
        <input id="tidnp" name="idnp" inputmode="numeric" value="${esc(sampleIdnp)}" placeholder="13 cifre">
        <button type="submit">Trimite GET</button>
      </form>
      <pre class="code" id="tester-out"><code>Răspunsul apare aici.</code></pre>
    </section>

    <section class="widget wide">
      <header><h3>Exemple de integrare</h3></header>
      <nav class="tabs small" id="code-tabs">
        <a href="#" data-tab="curl" aria-current="page">cURL</a><a href="#" data-tab="js">JavaScript</a><a href="#" data-tab="py">Python</a><a href="#" data-tab="sync">Sincronizare zilnică</a>
      </nav>
      <pre class="code" data-code="curl"><code>${esc(`# Verificare după IDNP: 200 = figurează, 404 = nu figurează
curl -s -o /dev/null -w "%{http_code}\\n" ${base}api/v1/idnp/${sampleIdnp}.json

# Detaliile subiectului
curl -s ${base}api/v1/idnp/${sampleIdnp}.json | jq '.subject.name, .records[].decision'

# Lista completă în CSV
curl -O ${base}api/v1/subjects.csv`)}</code></pre>
      <pre class="code" data-code="js" hidden><code>${esc(`const BASE = "${base}";

export async function checkIdnp(idnp) {
  const res = await fetch(\`\${BASE}api/v1/idnp/\${idnp}.json\`);
  if (res.status === 404) return { listed: false };
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json(); // { listed: true, subject, records, checkedAgainst }
}

// Căutare după nume pe lista completă
const { subjects } = await (await fetch(\`\${BASE}dataset/subjects.json\`)).json();
const norm = (s) => s.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();
const hits = subjects.filter((s) => s.active && norm(s.name).includes(norm("plahotniuc")));`)}</code></pre>
      <pre class="code" data-code="py" hidden><code>${esc(`import requests

BASE = "${base}"

def check_idnp(idnp: str) -> dict:
    r = requests.get(f"{BASE}api/v1/idnp/{idnp}.json", timeout=10)
    if r.status_code == 404:
        return {"listed": False}
    r.raise_for_status()
    return r.json()

print(check_idnp("${sampleIdnp}")["subject"]["name"])`)}</code></pre>
      <pre class="code" data-code="sync" hidden><code>${esc(`# Rulați zilnic (cron). Descarcă lista doar când s-a schimbat.
import json, pathlib, requests

BASE = "${base}"
state = pathlib.Path("sanctiuni_md.version")
manifest = requests.get(f"{BASE}api/v1/index.json", timeout=10).json()

if not state.exists() or state.read_text() != manifest["generatedAt"]:
    subjects = requests.get(f"{BASE}dataset/subjects.json", timeout=60).json()["subjects"]
    active = [s for s in subjects if s["active"]]
    # ... încărcați în baza de date și re-verificați portofoliul de clienți
    state.write_text(manifest["generatedAt"])
    print(f"Actualizat: {len(active)} înregistrări, versiunea {manifest['generatedAt']}")`)}</code></pre>
    </section>

    <section class="widget wide">
      <header><h3>Structura unei înregistrări</h3><span class="muted">dataset/subjects.json → subjects[]</span></header>
      <table class="kv schema">
        ${[
          ["id", "string", "Identificator stabil: {decizie}-{rând}, de exemplu 7-1."],
          ["decisionId", "string", "Numărul deciziei CIS; cheie în decisions.json și în dataset/details/."],
          ["type", "person | entity | vessel", "Persoană fizică, entitate sau navă."],
          ["name, aliases[]", "string", "Numele principal și variantele (alte grafii, chirilic, arab)."],
          ["idnp", "string | null", "Codul personal moldovenesc, 13 cifre, când apare în anexă."],
          ["birthDate", "YYYY-MM-DD | null", "Data nașterii."],
          ["citizenship[]", "string", "Cetățenia, așa cum apare în anexă."],
          ["documents[]", "{kind, series, number}", "Buletin, pașaport, permis."],
          ["regime", "UE | ONU | SUA | UK | Canada", "Regimul care a instituit sancțiunea inițială."],
          ["listing.foreign / listing.md", "YYYY-MM-DD | null", "Data includerii de către regimul sursă și data aplicării în Republica Moldova."],
          ["moldova", "boolean", "Are IDNP sau cetățenie moldovenească."],
          ["active", "boolean", "false pentru subiecții din decizii abrogate."],
          ["page", "number", "Pagina din PDF-ul deciziei, pentru trimitere directă."],
        ].map(([key, type, text]) => `<tr><th><code>${esc(key)}</code></th><td><small>${esc(type)}</small></td><td>${esc(text)}</td></tr>`).join("")}
      </table>
    </section>

    <section class="widget wide">
      <header><h3>Recomandări pentru entitățile raportoare</h3></header>
      <ol class="plain numbered">
        <li><b>Sincronizați zilnic.</b> Citiți <code>api/v1/index.json</code> și descărcați lista doar când <code>generatedAt</code> s-a schimbat.</li>
        <li><b>Verificați la inițierea relației și la fiecare actualizare a listei</b>, nu doar la onboarding.</li>
        <li><b>Folosiți identificatori când îi aveți.</b> IDNP-ul și documentul dau potriviri exacte; numele singur dă doar candidați de verificat.</li>
        <li><b>Păstrați urma verificării:</b> data, criteriul și versiunea listei (<code>checkedAgainst</code> în răspunsul IDNP).</li>
        <li><b>Confirmați cu sursa oficială</b> înainte de a bloca fonduri: decizia CIS și lista de pe <a href="https://date.gov.md/open/sanctioned-subjects" target="_blank" rel="noopener">date.gov.md</a>.</li>
      </ol>
    </section>
  `;
  const tester = document.querySelector("#tester");
  tester.addEventListener("submit", async (event) => {
    event.preventDefault();
    const idnp = tester.elements.idnp.value.replace(/\D/g, "");
    const out = document.querySelector("#tester-out");
    if (idnp.length !== 13) {
      out.textContent = "IDNP-ul are 13 cifre.";
      return;
    }
    out.textContent = `GET api/v1/idnp/${idnp}.json …`;
    const response = await fetch(`api/v1/idnp/${idnp}.json`);
    if (response.status === 404) {
      out.textContent = `HTTP 404 — IDNP-ul ${idnp} nu figurează în listă.`;
      return;
    }
    const body = await response.json();
    out.textContent = `HTTP ${response.status}\n${JSON.stringify(body, null, 2)}`;
  });
  document.querySelectorAll("#code-tabs [data-tab]").forEach((tab) => tab.addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelectorAll("#code-tabs [data-tab]").forEach((other) => other.toggleAttribute("aria-current", other === tab));
    document.querySelectorAll("[data-code]").forEach((block) => { block.hidden = block.dataset.code !== tab.dataset.tab; });
  }));
}

// ——— ghid ———

function renderGuide() {
  setTitle("Ghid și întrebări frecvente");
  const faq = [
    ["Am găsit un nume identic cu al clientului meu. Este aceeași persoană?",
      "Nu neapărat. Numele se repetă, mai ales în transliterare. Comparați data și locul nașterii, cetățenia, IDNP-ul și numerele de document din fișă. Dacă identificatorii coincid, tratați cazul ca potrivire confirmată; dacă diferă, este un omonim și documentați motivul pentru care l-ați exclus."],
    ["Ce fac dacă un client figurează în listă?",
      "Nu executați operațiunea și nu puneți fonduri la dispoziția persoanei. Păstrați bunurile blocate, documentați verificarea (puteți salva dovada din această aplicație) și informați fără întârziere autoritățile competente, conform procedurilor interne și legislației aplicabile. Evitați să alertați persoana în cauză."],
    ["Căutarea nu găsește nimic. Înseamnă că persoana nu este sancționată?",
      "Înseamnă că nu figurează în deciziile CIS incluse aici, la versiunea afișată. Verificați și grafiile alternative (inclusiv chirilice), folosiți IDNP-ul sau documentul și consultați lista oficială de pe date.gov.md. Sancțiunile altor state care nu au fost preluate de Republica Moldova nu apar aici."],
    ["De ce apare aceeași persoană de mai multe ori?",
      "Pentru că mai multe regimuri au sancționat-o, iar Republica Moldova a preluat fiecare decizie separat, de exemplu UE și Canada. Aplicația grupează aceste înregistrări pe aceeași fișă după IDNP sau după nume și data nașterii."],
    ["Cât de actuale sunt datele?",
      `Versiunea curentă este din ${formatDate(state.generatedAt)}. La fiecare decizie nouă a CIS, PDF-ul se adaugă în proiect și lista se regenerează automat. Data versiunii apare pe fiecare dovadă de verificare și în api/v1/index.json.`],
    ["Pot folosi datele în aplicația mea?",
      "Da. Deciziile CIS sunt acte publice. API-ul static este gratuit și nu cere cheie. Menționați sursa și data versiunii, și nu prezentați rezultatele drept listă oficială."],
    ["Ce este indicele de relevanță din topuri?",
      "Un scor calculat automat care ține cont de legătura cu Republica Moldova, de numărul de regimuri și decizii, de funcția ocupată și de cât de des este menționată persoana în motivarea altor subiecți. Arată vizibilitatea unui caz, nu gravitatea faptelor. Formula este publicată pe pagina Topuri."],
  ];
  main.innerHTML = `
    <div class="page-head">
      <h2>Ghid și întrebări frecvente</h2>
      <p class="muted">Ce sunt măsurile restrictive, cine le aplică în Republica Moldova și ce faceți dacă găsiți o potrivire.</p>
    </div>
    <div class="guide">
      <aside class="toc">
        <a href="#/ghid" data-jump="ce-sunt">Ce sunt sancțiunile</a>
        <a href="#/ghid" data-jump="cine">Cine decide</a>
        <a href="#/ghid" data-jump="masuri">Măsurile</a>
        <a href="#/ghid" data-jump="regimuri">Regimurile</a>
        <a href="#/ghid" data-jump="potrivire">Dacă găsiți o potrivire</a>
        <a href="#/ghid" data-jump="glosar">Glosar</a>
        <a href="#/ghid" data-jump="limite">Limitele datelor</a>
        <a href="#/ghid" data-jump="faq">Întrebări frecvente</a>
      </aside>
      <div class="prose">
        <section id="ce-sunt">
          <h3>Ce sunt măsurile restrictive internaționale</h3>
          <p>Măsurile restrictive, numite și sancțiuni, sunt instrumente prin care statele și organizațiile internaționale răspund la amenințări la adresa păcii, a securității, a democrației și a drepturilor omului. Ele nu sunt pedepse penale. Vizează persoane, companii, organizații sau nave considerate responsabile ori implicate în astfel de acțiuni și urmăresc schimbarea comportamentului lor.</p>
        </section>
        <section id="cine">
          <h3>Cine le aplică în Republica Moldova</h3>
          <p><b>Consiliul interinstituțional de supervizare (CIS)</b> decide punerea în aplicare, pe teritoriul Republicii Moldova, a măsurilor restrictive instituite de Consiliul de Securitate al ONU, de Uniunea Europeană și de alți parteneri, în temeiul Legii nr. 25/2016 privind aplicarea măsurilor restrictive internaționale. Deciziile se publică în Monitorul Oficial, iar lista consolidată pe <a href="https://date.gov.md/open/sanctioned-subjects" target="_blank" rel="noopener">date.gov.md</a>.</p>
          <p>O decizie CIS are de regulă o anexă cu lista subiecților. Deciziile ulterioare de modificare adaugă, scot sau corectează înregistrări; textul consolidat al anexei este forma în vigoare.</p>
        </section>
        <section id="masuri">
          <h3>Ce înseamnă fiecare măsură</h3>
          ${Object.entries(MEASURE_INFO).map(([key, info]) => `<div class="measure"><h4>${esc(MEASURE_LABEL[key])}</h4><p>${esc(info.text)}</p><p class="muted">${esc(info.action)}</p></div>`).join("")}
          <p>Unele decizii prevăd și alte măsuri, de exemplu embargouri asupra armelor sau interdicții de export pentru anumite bunuri. Acestea nu vizează persoane anume și nu apar în căutare, dar sunt descrise în textul deciziei.</p>
        </section>
        <section id="regimuri">
          <h3>Regimurile preluate</h3>
          <ul class="plain">
            ${Object.entries(REGIME_LABEL).filter(([key]) => key !== "Altele").map(([key, label]) => `<li><span class="chip regime">${esc(key)}</span> ${esc(label)} — ${plural(state.subjects.filter((s) => s.active && s.regime === key).length, "înregistrare", "înregistrări")}. <a href="${searchHash({ ...SEARCH_DEFAULTS, regime: key })}">Vezi lista</a></li>`).join("")}
          </ul>
        </section>
        <section id="potrivire">
          <h3>Ce faceți dacă găsiți o potrivire</h3>
          <ol class="plain numbered">
            <li><b>Confirmați identitatea.</b> Comparați data nașterii, cetățenia, IDNP-ul și documentele. Un nume identic nu este suficient.</li>
            <li><b>Opriți operațiunea.</b> Nu executați tranzacția și nu puneți fonduri sau resurse economice la dispoziția subiectului.</li>
            <li><b>Documentați.</b> Salvați dovada verificării și fișa subiectului, cu trimiterea la decizia CIS.</li>
            <li><b>Informați autoritățile.</b> Entitățile raportoare urmează procedurile prevăzute de legislația privind prevenirea și combaterea spălării banilor și finanțării terorismului și informează autoritatea competentă.</li>
            <li><b>Nu alertați persoana.</b> Comunicarea cu clientul se face conform procedurilor interne.</li>
          </ol>
          <p class="muted small">Acest ghid are caracter informativ. Pentru obligațiile exacte, consultați textul legilor în vigoare pe legis.md și ghidurile autorității de supraveghere.</p>
        </section>
        <section id="glosar">
          <h3>Glosar</h3>
          <dl class="glossary">
            <dt>IDNP</dt><dd>Numărul de identificare de stat al persoanei fizice din Republica Moldova, 13 cifre.</dd>
            <dt>Subiect desemnat</dt><dd>Persoana, entitatea sau nava inclusă în lista unei decizii de sancțiuni.</dd>
            <dt>Fonduri și resurse economice</dt><dd>Bani, conturi, valori mobiliare, bunuri mobile și imobile și orice alte active care pot fi folosite pentru a obține bani, bunuri sau servicii.</dd>
            <dt>Punere în aplicare</dt><dd>Decizia CIS care preia pe teritoriul Republicii Moldova o listă de sancțiuni a unui partener.</dd>
            <dt>Aliniere</dt><dd>Decizia CIS care stabilește că Republica Moldova se aliniază la un regim nou de sancțiuni.</dd>
            <dt>PESC</dt><dd>Politica externă și de securitate comună a Uniunii Europene; deciziile UE de sancțiuni poartă indicativul PESC.</dd>
            <dt>Omonim</dt><dd>O persoană cu același nume ca un subiect sancționat, dar cu alte date de identificare.</dd>
            <dt>Screening</dt><dd>Verificarea sistematică a clienților și a tranzacțiilor față de listele de sancțiuni.</dd>
          </dl>
        </section>
        <section id="limite">
          <h3>Limitele datelor</h3>
          <ul>
            <li>Datele sunt extrase automat din PDF-urile deciziilor. Coloanele tabelelor sunt reconstruite după poziția textului; textul original din anexă este disponibil în fiecare fișă.</li>
            <li>Deciziile scanate (nr. 1, 8, 9 și 10) trec prin recunoaștere optică, iar textul poate fi incomplet.</li>
            <li>Unele anexe nu redau numele subiecților, ci doar un marcaj. Acestea apar în catalogul deciziilor, cu mențiune.</li>
            <li>Instrumentul nu înlocuiește lista oficială de pe date.gov.md și textul din Monitorul Oficial.</li>
          </ul>
        </section>
        <section id="faq">
          <h3>Întrebări frecvente</h3>
          ${faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}
        </section>
      </div>
    </div>
  `;
  const jump = (target) => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll("[data-jump]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    jump(link.dataset.jump);
  }));
}

// ——— pornire ———

async function boot() {
  if (location.protocol === "file:") {
    state.error = "Deschideți aplicația printr-un server local (python3 -m http.server) sau prin GitHub Pages. Browserul nu încarcă datele dintr-un fișier deschis direct.";
    render();
    return;
  }
  render();
  try {
    const [decisionsRes, subjectsRes, topRes] = await Promise.all([
      fetch("dataset/decisions.json"),
      fetch("dataset/subjects.json"),
      fetch("api/v1/top.json"),
    ]);
    if (!decisionsRes.ok || !subjectsRes.ok) throw new Error("missing");
    const decisionsPayload = await decisionsRes.json();
    const subjectsPayload = await subjectsRes.json();
    state.top = topRes.ok ? await topRes.json() : null;
    state.generatedAt = subjectsPayload.generatedAt || decisionsPayload.generatedAt || "";
    state.decisions = decisionsPayload.decisions || [];
    state.subjects = subjectsPayload.subjects || [];
    state.decisionById = new Map(state.decisions.map((decision) => [decision.id, decision]));
    state.byId = new Map(state.subjects.map((subject) => [subject.id, subject]));
    for (const subject of state.subjects) {
      if (subject.listing?.md) state.datedDecisions.add(subject.decisionId);
      state.blob.set(subject.id, tokens([
        subject.name,
        ...(subject.aliases || []),
        subject.idnp || "",
        ...(subject.documents || []).flatMap((doc) => [doc.number, `${doc.series || ""}${doc.number || ""}`]),
      ].join(" ")).join(" "));
      if (!subject.active) continue;
      const key = personKey(subject);
      if (!state.groupsByKey.has(key)) state.groupsByKey.set(key, []);
      state.groupsByKey.get(key).push(subject);
    }
    for (const list of Object.values(state.top || {})) {
      if (!Array.isArray(list)) continue;
      for (const group of list) if (group.role) for (const id of group.ids) state.roles.set(id, group.role);
    }
    state.ready = true;
    document.querySelector("[data-version]")?.replaceChildren(`Versiunea datelor: ${formatDate(state.generatedAt)}`);
  } catch {
    state.error = "Lista nu a putut fi încărcată. Rulați scripts/extract.py, apoi deschideți site-ul printr-un server.";
  }
  render();
}

let lastPath = "";
window.addEventListener("hashchange", () => {
  const { path } = parseHash();
  render();
  if (path !== lastPath) window.scrollTo({ top: 0 });
  lastPath = path;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || /input|textarea|select/i.test(document.activeElement?.tagName || "")) return;
  const input = document.querySelector("#q");
  if (input) {
    event.preventDefault();
    input.focus();
  }
});
lastPath = parseHash().path;
boot();
