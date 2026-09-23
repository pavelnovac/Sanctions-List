const CYR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "t", ч: "c", ш: "s", щ: "s", ъ: "", ы: "i", ь: "", э: "e", ю: "iu", я: "ia",
  і: "i", ї: "i", є: "e", ґ: "g",
};

const TYPE_LABEL = { person: "Persoană", entity: "Entitate", vessel: "Navă" };
const MEASURE_LABEL = {
  asset_freeze: "Blocarea fondurilor și a resurselor economice",
  travel_ban: "Restricții de călătorie",
};
const PAGE_SIZE = 20;

const state = {
  ready: false,
  error: "",
  generatedAt: "",
  decisions: [],
  subjects: [],
  byId: new Map(),
  decisionById: new Map(),
  query: "",
  mode: "all",
  type: "all",
  regime: "all",
  theme: "all",
  moldova: false,
  page: 1,
  detailCache: new Map(),
};

const main = document.querySelector("main");

function fold(text) {
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

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function themeOf(title) {
  const cleaned = String(title || "")
    .replace(/^privind\s+/i, "")
    .replace(/^punerea în aplicare a măsurilor restrictive internaționale(?:\s+ale\s+[^.]{0,90}?)?(?=\s+(?:având|împotriva|îndreptate|privind|pentru|în raport)\b)/i, "")
    .replace(/^alinierea la (?:unele |uncle )?măsuri restrictive internaționale ale\s+[^.]{0,80}?(?=\s+(?:instituite|având|împotriva)\b)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || title;
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

function searchBlob(subject) {
  return fold([
    subject.name,
    ...(subject.aliases || []),
    subject.idnp || "",
    ...(subject.documents || []).flatMap((doc) => [doc.series, doc.number, `${doc.series || ""}${doc.number || ""}`]),
  ].join(" "));
}

function applyFilters(list) {
  return list.filter((subject) => {
    if (!subject.active) return false;
    if (state.type !== "all" && subject.type !== state.type) return false;
    if (state.regime !== "all" && subject.regime !== state.regime) return false;
    if (state.moldova && !subject.moldova) return false;
    if (state.theme !== "all") {
      const decision = state.decisionById.get(subject.decisionId);
      if (!decision || themeOf(decision.title) !== state.theme) return false;
    }
    return true;
  });
}

function runQuery() {
  const filtered = applyFilters(state.subjects);
  const query = state.query.trim();
  if (!query) return { items: filtered, banner: null, hint: null };
  if (state.mode === "idnp") {
    const digits = query.replace(/\D/g, "");
    if (digits.length !== 13) {
      return { items: [], banner: null, hint: "Pentru verificare, introduceți toate cele 13 cifre ale IDNP-ului." };
    }
    const items = filtered.filter((subject) => subject.idnp === digits);
    return {
      items,
      banner: items.length ? "hit" : "miss",
      hint: null,
    };
  }
  if (state.mode === "document") {
    const norm = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length < 5) {
      return { items: [], banner: null, hint: "Introduceți seria și numărul, sau cel puțin 5 cifre ale documentului." };
    }
    const items = filtered.filter((subject) => {
      const keys = docKeys(subject);
      return keys.has(norm);
    });
    return { items, banner: items.length ? "hit" : "miss", hint: null };
  }
  const tokens = fold(query).split(" ").filter((token) => token.length > 0);
  const items = filtered.filter((subject) => tokens.every((token) => searchBlob(subject).includes(token)));
  return { items, banner: null, hint: null };
}

function groupByIdnp(items) {
  const groups = [];
  const seen = new Map();
  for (const subject of items) {
    if (subject.idnp) {
      if (!seen.has(subject.idnp)) {
        const group = { id: subject.idnp, items: [] };
        seen.set(subject.idnp, group);
        groups.push(group);
      }
      seen.get(subject.idnp).items.push(subject);
    } else {
      groups.push({ id: subject.id, items: [subject] });
    }
  }
  return groups;
}

function decisionLabel(decision) {
  if (!decision) return "Decizie";
  const date = decision.date ? formatDate(decision.date) : "";
  return `Decizia CIS nr. ${decision.number}${date ? ` din ${date}` : ""}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  if (!day) return iso;
  return `${day}.${month}.${year}`;
}

function pdfHref(decision, page) {
  if (!decision?.file) return "#";
  const href = encodeURI(decision.file);
  return page ? `${href}#page=${page}` : href;
}

function setNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function render() {
  if (!state.ready) {
    main.innerHTML = `<p class="empty">${esc(state.error || "Se încarcă lista…")}</p>`;
    return;
  }
  const route = (location.hash.replace(/^#/, "") || "/").split("?")[0];
  if (route.startsWith("/subiect/")) {
    setNav("cauta");
    renderSubject(decodeURIComponent(route.slice("/subiect/".length)));
    return;
  }
  if (route.startsWith("/decizie/")) {
    setNav("decizii");
    renderDecision(decodeURIComponent(route.slice("/decizie/".length)));
    return;
  }
  if (route.startsWith("/decizii")) {
    setNav("decizii");
    renderCatalog();
    return;
  }
  setNav("cauta");
  renderSearch();
}

function renderSearch() {
  const active = state.subjects.filter((subject) => subject.active);
  const regimes = [...new Set(active.map((subject) => subject.regime))].sort();
  const themes = [...new Set(state.decisions
    .filter((decision) => decision.kind === "implementation" && decision.status === "in_force" && decision.subjectCount)
    .map((decision) => themeOf(decision.title)))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "ro"));
  const result = runQuery();
  const groups = groupByIdnp(result.items);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const slice = groups.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const showList = state.query.trim() || state.type !== "all" || state.regime !== "all" || state.theme !== "all" || state.moldova;

  main.innerHTML = `
    <section class="stats" aria-label="Rezumat">
      ${stat(active.length, "subiecți în vigoare")}
      ${stat(active.filter((s) => s.type === "person").length, "persoane")}
      ${stat(active.filter((s) => s.type === "entity").length, "entități")}
      ${stat(active.filter((s) => s.moldova).length, "cu legătură RM")}
    </section>
    <form class="search-panel" id="cautare">
      <div class="modes" role="group" aria-label="Modul de căutare">
        ${modeButton("all", "Căutare")}
        ${modeButton("idnp", "Verificare IDNP")}
        ${modeButton("document", "Verificare document")}
      </div>
      <div class="search-row">
        <input id="q" type="search" name="q" value="${esc(state.query)}" placeholder="${placeholder()}" autocomplete="off" enterkeyhint="search">
        <button type="submit">Caută</button>
      </div>
      <p class="hint">${state.mode === "all"
        ? "Nume, alias, IDNP sau număr de document. Diacriticele și spațiile nu contează."
        : state.mode === "idnp"
          ? "Potrivire exactă a codului de identificare de stat, 13 cifre."
          : "Potrivire exactă a seriei și numărului, de exemplu B 28017764 sau AB1637205."}</p>
      <div class="filters">
        ${select("type", "Tip", [["all", "Toate"], ["person", "Persoane"], ["entity", "Entități"], ["vessel", "Nave"]], state.type)}
        ${select("regime", "Regim", [["all", "Toate"], ...regimes.map((item) => [item, item])], state.regime)}
        ${select("theme", "Temă", [["all", "Toate"], ...themes.map((item) => [item, item.length > 72 ? `${item.slice(0, 72)}…` : item])], state.theme)}
        <label class="check"><input type="checkbox" name="moldova" ${state.moldova ? "checked" : ""}> Doar cetățeni sau IDNP din Republica Moldova</label>
      </div>
    </form>
    ${result.hint ? `<p class="banner warn">${esc(result.hint)}</p>` : ""}
    ${result.banner === "hit" ? `<p class="banner hit">Găsit în lista de sancțiuni — ${result.items.length} ${result.items.length === 1 ? "înregistrare" : "înregistrări"}.</p>` : ""}
    ${result.banner === "miss" ? `<p class="banner miss">Nu figurează în lista extrasă din deciziile aflate în acest proiect.</p>` : ""}
    ${result.hint || result.banner === "miss" ? "" : showList ? renderResultList(slice, groups.length, pages) : `<p class="empty">Introduceți un nume, un IDNP sau un număr de document. Puteți și restrânge lista cu filtrele de mai sus.</p>`}
  `;
  bindSearch();
}

function stat(value, label) {
  return `<div class="stat"><b>${value.toLocaleString("ro-RO")}</b><span>${esc(label)}</span></div>`;
}

function modeButton(mode, label) {
  return `<button type="button" data-mode="${mode}" aria-pressed="${state.mode === mode}">${label}</button>`;
}

function placeholder() {
  if (state.mode === "idnp") return "2002008008309";
  if (state.mode === "document") return "AB 1637205";
  return "Nume, alias, IDNP sau document";
}

function select(name, label, options, current) {
  const html = options.map(([value, text]) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(text)}</option>`).join("");
  return `<label class="field">${esc(label)}<select name="${name}">${html}</select></label>`;
}

function renderResultList(groups, total, pages) {
  if (!groups.length) {
    return `<p class="empty">Niciun rezultat pentru criteriile alese.</p>`;
  }
  const cards = groups.map((group) => {
    const head = group.items[0];
    const names = [...new Set(group.items.flatMap((item) => [item.name, ...(item.aliases || [])]))];
    const alias = names.filter((name) => fold(name) !== fold(head.name)).slice(0, 3).join(" · ");
    const decisions = group.items.map((item) => {
      const decision = state.decisionById.get(item.decisionId);
      return decisionLabel(decision);
    });
    return `<a class="card" href="#/subiect/${encodeURIComponent(head.id)}">
      <span class="chip">${esc(TYPE_LABEL[head.type] || head.type)}</span>
      <h2>${esc(head.name)}</h2>
      ${alias ? `<p class="aliases">${esc(alias)}</p>` : ""}
      <div class="meta">
        ${head.idnp ? `<span class="chip seal">IDNP ${esc(head.idnp)}</span>` : ""}
        ${head.birthDate ? `<span class="chip">n. ${esc(formatDate(head.birthDate))}</span>` : ""}
        ${head.documents.slice(0, 2).map((doc) => `<span class="chip">${esc(docLabel(doc))}</span>`).join("")}
        ${decisions.map((label) => `<span class="chip pine">${esc(label)}</span>`).join("")}
      </div>
    </a>`;
  }).join("");
  return `
    <div class="toolbar">
      <p>${total.toLocaleString("ro-RO")} ${total === 1 ? "rezultat" : "rezultate"}${state.query.trim() ? "" : " după filtre"}</p>
      <button type="button" class="ghost" id="export">Export CSV</button>
    </div>
    <div class="cards">${cards}</div>
    ${pages > 1 ? `<div class="pager">
      <button type="button" id="prev" ${state.page === 1 ? "disabled" : ""}>Înapoi</button>
      <span>Pagina ${state.page} din ${pages}</span>
      <button type="button" id="next" ${state.page === pages ? "disabled" : ""}>Înainte</button>
    </div>` : ""}
  `;
}

function docLabel(doc) {
  const kind = doc.kind === "buletin" ? "Buletin" : doc.kind === "pasaport" ? "Pașaport" : doc.kind === "permis" ? "Permis" : "Act";
  return `${kind} ${doc.series ? `${doc.series} ` : ""}${doc.number}`;
}

function bindSearch() {
  const form = document.querySelector("#cautare");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    readForm(form);
    state.page = 1;
    render();
  });
  form.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      state.page = 1;
      render();
      document.querySelector("#q")?.focus();
    });
  });
  for (const name of ["type", "regime", "theme"]) {
    form.elements[name].addEventListener("change", () => {
      readForm(form);
      state.page = 1;
      render();
    });
  }
  form.elements.moldova.addEventListener("change", () => {
    readForm(form);
    state.page = 1;
    render();
  });
  document.querySelector("#export")?.addEventListener("click", exportCsv);
  document.querySelector("#prev")?.addEventListener("click", () => { state.page -= 1; render(); });
  document.querySelector("#next")?.addEventListener("click", () => { state.page += 1; render(); });
}

function readForm(form) {
  state.query = form.elements.q.value;
  state.type = form.elements.type.value;
  state.regime = form.elements.regime.value;
  state.theme = form.elements.theme.value;
  state.moldova = form.elements.moldova.checked;
}

function exportCsv() {
  const { items } = runQuery();
  const header = ["Nume", "Aliasuri", "Tip", "Data nașterii", "IDNP", "Documente", "Cetățenie", "Regim", "Decizie", "Dată decizie", "Pagină"];
  const lines = [header.join(",")];
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
      subject.page,
    ].map(csv).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "sanctiuni-rezultate.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function renderSubject(id) {
  const subject = state.byId.get(id);
  if (!subject) {
    main.innerHTML = `<p class="empty">Înregistrarea nu există. <a href="#/">Înapoi la căutare</a></p>`;
    return;
  }
  main.innerHTML = `<p class="empty">Se încarcă fișa…</p>`;
  const decision = state.decisionById.get(subject.decisionId);
  const detail = await loadDetail(subject);
  const siblings = subject.idnp
    ? state.subjects.filter((item) => item.active && item.idnp === subject.idnp && item.id !== subject.id)
    : [];
  const reason = detail.reason
    || `Măsura este dispusă prin ${decisionLabel(decision)}. ${decision?.title || ""}`;
  document.title = `${subject.name} — Lista de sancțiuni`;
  main.innerHTML = `
    <a class="back" href="#/">← Înapoi la căutare</a>
    <article class="sheet">
      <p class="kicker">${esc(TYPE_LABEL[subject.type] || subject.type)} · regim ${esc(subject.regime)}</p>
      <h2>${esc(subject.name)}</h2>
      ${(subject.aliases || []).length ? `<p class="aliases">${esc(subject.aliases.join(" · "))}</p>` : ""}
      <p class="banner hit">Figurează în lista măsurilor restrictive puse în aplicare de Republica Moldova.</p>
      <div class="grid">
        ${field("Data nașterii", formatDate(subject.birthDate))}
        ${field("Locul nașterii", detail.birthPlace)}
        ${field("Cetățenie", (subject.citizenship || []).join(", "))}
        ${field("Sex", detail.gender)}
        ${field("Funcție", detail.function)}
        ${field("IDNP", subject.idnp)}
        ${field("Includere de către regimul sursă", formatDate(subject.listing?.foreign))}
        ${field("Aplicare de către Republica Moldova", formatDate(subject.listing?.md))}
      </div>
      ${(subject.documents || []).length ? `<h3>Documente</h3><ul>${subject.documents.map((doc) => `<li>${esc(docLabel(doc))}</li>`).join("")}</ul>` : ""}
      <div class="reason">
        <h3>Cauza</h3>
        <p>${esc(reason)}</p>
      </div>
      ${detail.notes ? `<h3>Note din decizie</h3><p class="idents">${esc(detail.notes)}</p>` : ""}
      ${detail.identifiersText ? `<h3>Textul de identificare din anexă</h3><p class="idents">${esc(detail.identifiersText)}</p>` : ""}
      <h3>Actul</h3>
      <p><a href="#/decizie/${esc(decision?.id || "")}">${esc(decisionLabel(decision))}</a></p>
      <p>${esc(decision?.title || "")}</p>
      ${(decision?.measures || []).length ? `<ul>${decision.measures.map((item) => `<li>${esc(MEASURE_LABEL[item] || item)}</li>`).join("")}</ul>` : ""}
      ${(decision?.instruments || []).length ? `<p class="muted">Temei extern: ${esc(decision.instruments.join("; "))}</p>` : ""}
      <p><a href="${esc(pdfHref(decision, detail.page || subject.page))}">Deschide decizia, pagina ${esc(detail.page || subject.page)}</a></p>
      ${siblings.length ? `<h3>Aceeași persoană în alte decizii</h3><ul>${siblings.map((item) => {
        const other = state.decisionById.get(item.decisionId);
        return `<li><a href="#/subiect/${encodeURIComponent(item.id)}">${esc(decisionLabel(other))} · ${esc(item.regime)}</a></li>`;
      }).join("")}</ul>` : ""}
    </article>
  `;
}

function field(label, value) {
  if (!value) return "";
  return `<div><h3>${esc(label)}</h3><p>${esc(value)}</p></div>`;
}

async function loadDetail(subject) {
  if (state.detailCache.has(subject.decisionId)) {
    return state.detailCache.get(subject.decisionId)[subject.id] || {};
  }
  try {
    const response = await fetch(`dataset/details/${encodeURIComponent(subject.decisionId)}.json`);
    const payload = response.ok ? await response.json() : {};
    state.detailCache.set(subject.decisionId, payload);
    return payload[subject.id] || {};
  } catch {
    return {};
  }
}

function renderCatalog() {
  document.title = "Decizii — Lista de sancțiuni";
  const items = [...state.decisions].sort((a, b) => (a.number || 999) - (b.number || 999) || a.file.localeCompare(b.file));
  main.innerHTML = `
    <h2>Deciziile din proiect</h2>
    <p class="muted">${items.length} fișiere. Listele active sunt deciziile de punere în aplicare. Deciziile de modificare nu sunt importate a doua oară.</p>
    <ul class="decision-list">
      ${items.map((decision) => `<li><a href="#/decizie/${esc(decision.id)}">
        <span class="chip">${esc(decision.regime)}</span>
        <span class="chip">${esc(kindLabel(decision))}</span>
        ${decision.status === "repealed" ? `<span class="chip seal">Abrogată</span>` : ""}
        <h2>${esc(decisionLabel(decision))}</h2>
        <p>${esc(decision.title)}</p>
        <p class="muted">${decision.subjectCount ? `${decision.subjectCount} subiecți extrași` : (decision.notice || "Fără listă de subiecți în acest fișier")}</p>
      </a></li>`).join("")}
    </ul>
  `;
}

function kindLabel(decision) {
  return {
    implementation: "Punere în aplicare",
    amendment: "Modificare",
    alignment: "Aliniere",
    report: "Raport",
  }[decision.kind] || decision.kind;
}

function renderDecision(id) {
  const decision = state.decisionById.get(id);
  if (!decision) {
    main.innerHTML = `<p class="empty">Decizia nu există. <a href="#/decizii">Catalog</a></p>`;
    return;
  }
  document.title = `${decisionLabel(decision)} — Lista de sancțiuni`;
  const people = state.subjects
    .filter((subject) => subject.decisionId === id && subject.active)
    .sort((a, b) => a.page - b.page || Number(a.listNumber) - Number(b.listNumber));
  const page = Math.min(pagesOf(people.length), Number(new URLSearchParams(location.hash.split("?")[1] || "").get("p") || 1));
  const pages = pagesOf(people.length);
  const slice = people.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  main.innerHTML = `
    <a class="back" href="#/decizii">← Toate deciziile</a>
    <article class="sheet">
      <p class="kicker">${esc(decision.regime)} · ${esc(kindLabel(decision))}</p>
      <h2>${esc(decisionLabel(decision))}</h2>
      <p>${esc(decision.title)}</p>
      ${decision.status === "repealed" ? `<p class="banner warn">Decizie abrogată. Subiecții ei nu apar în căutare.</p>` : ""}
      ${decision.notice ? `<p class="banner warn">${esc(decision.notice)}</p>` : ""}
      ${(decision.amendedBy || []).length ? `<p class="muted">Modificată prin deciziile nr. ${esc(decision.amendedBy.join(", "))}</p>` : ""}
      ${(decision.measures || []).length ? `<ul>${decision.measures.map((item) => `<li>${esc(MEASURE_LABEL[item] || item)}</li>`).join("")}</ul>` : ""}
      <p><a href="${esc(pdfHref(decision))}">Deschide PDF-ul</a></p>
    </article>
    ${people.length ? `<div class="toolbar"><p>${people.length} subiecți</p></div><div class="cards">${slice.map((subject) => `
      <a class="card" href="#/subiect/${encodeURIComponent(subject.id)}">
        <span class="chip">${esc(TYPE_LABEL[subject.type] || subject.type)} · nr. ${esc(subject.listNumber)}</span>
        <h2>${esc(subject.name)}</h2>
        <div class="meta">${subject.idnp ? `<span class="chip seal">IDNP ${esc(subject.idnp)}</span>` : ""}</div>
      </a>`).join("")}</div>` : `<p class="empty">Nu sunt subiecți extrași din acest fișier.</p>`}
    ${pages > 1 ? `<div class="pager">
      <button type="button" id="dprev" ${page <= 1 ? "disabled" : ""}>Înapoi</button>
      <span>Pagina ${page} din ${pages}</span>
      <button type="button" id="dnext" ${page >= pages ? "disabled" : ""}>Înainte</button>
    </div>` : ""}
  `;
  document.querySelector("#dprev")?.addEventListener("click", () => { location.hash = `#/decizie/${id}?p=${page - 1}`; });
  document.querySelector("#dnext")?.addEventListener("click", () => { location.hash = `#/decizie/${id}?p=${page + 1}`; });
}

function pagesOf(count) {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

async function boot() {
  if (location.protocol === "file:") {
    state.error = "Deschideți aplicația printr-un server local (python3 -m http.server) sau prin GitHub Pages. Browserul nu încarcă datele dintr-un fișier deschis direct.";
    render();
    return;
  }
  try {
    const [decisionsRes, subjectsRes] = await Promise.all([
      fetch("dataset/decisions.json"),
      fetch("dataset/subjects.json"),
    ]);
    if (!decisionsRes.ok || !subjectsRes.ok) throw new Error("missing");
    const decisionsPayload = await decisionsRes.json();
    const subjectsPayload = await subjectsRes.json();
    state.generatedAt = subjectsPayload.generatedAt || decisionsPayload.generatedAt || "";
    state.decisions = decisionsPayload.decisions || [];
    state.subjects = subjectsPayload.subjects || [];
    state.decisionById = new Map(state.decisions.map((decision) => [decision.id, decision]));
    state.byId = new Map(state.subjects.map((subject) => [subject.id, subject]));
    state.ready = true;
  } catch {
    state.error = "Lista nu a putut fi încărcată. Rulați scripts/extract.py, apoi deschideți site-ul printr-un server.";
  }
  render();
}

window.addEventListener("hashchange", () => {
  document.title = "Lista de sancțiuni — Republica Moldova";
  render();
});
boot();
