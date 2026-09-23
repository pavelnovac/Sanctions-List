# Lista de sancțiuni a Republicii Moldova

Aplicație statică, fără server, pentru căutarea și verificarea persoanelor, entităților și navelor pentru care Republica Moldova a pus în aplicare măsuri restrictive internaționale. Se publică pe GitHub Pages și oferă și un API static pentru instituții.

Sursa sunt deciziile Consiliului interinstituțional de supervizare (CIS) din mapa `data/`. Lista oficială curentă rămâne cea de pe [date.gov.md](https://date.gov.md/open/sanctioned-subjects) și textul publicat în Monitorul Oficial.

## Funcționalități

| Pagină | Ce face |
| --- | --- |
| **Acasă** `#/` | Căutare rapidă, indicatori (înregistrări, regimuri, ultima decizie), ultimii adăugați, topuri, distribuția pe regimuri, cronologia aplicării, cele mai mari programe. |
| **Căutare** `#/cauta` | Căutare liberă cu rezultate pe măsură ce scrieți; verificare exactă IDNP sau document; filtre după tip, regim, program, măsură, an; ordonare; export CSV; „Poate ați căutat” pentru nume asemănătoare. Linkul păstrează căutarea și filtrele. |
| **Topuri** `#/topuri` | Cei mai relevanți, legătură cu RM, figuri internaționale, ultimii adăugați (pe loturi), sancționați de mai multe regimuri, entități, programe. Formula indicelui de relevanță este publicată pe pagină. |
| **Verificare în lot** `#/lot` | Lipiți sau încărcați (CSV/TXT) până la 5.000 de nume, IDNP-uri sau documente. Potrivire aproximativă cu sensibilitate reglabilă, confirmare după data nașterii, export CSV și raport tipăribil. Totul rulează în browser. |
| **Fișa subiectului** `#/subiect/{id}` | Rezumat, cronologie (inclus la sursă → decizia CIS → aplicat în RM), date de identificare, măsurile explicate, motivul, temeiul juridic, aceeași persoană în alte decizii, link direct la pagina din PDF. |
| **Dovada verificării** `#/dovada?q=…&mode=…` | Document tipăribil cu data, criteriul, versiunea listei și rezultatul, pentru dosarul clientului. |
| **Decizii** `#/decizii` | Catalogul deciziilor pe ani, cu filtre; fiecare decizie are lista ei de subiecți, căutare internă și export. |
| **API** `#/api` | Documentația API-ului static, exemple cURL / JavaScript / Python și un tester live. |
| **Ghid** `#/ghid` | Ce sunt sancțiunile, cine decide, măsurile, ce faceți la o potrivire, glosar, limite, întrebări frecvente. |

Căutarea ignoră diacriticele, ordinea cuvintelor și diferențele de transliterare (Șor / Shor, Iurii / Yuri, chirilic / latin).

## API static

Toate fișierele sunt servite ca JSON sau CSV, fără cheie. GitHub Pages trimite CORS deschis.

| Endpoint | Conținut |
| --- | --- |
| `api/v1/index.json` | Manifest: versiune, `generatedAt`, numărul de înregistrări, lista endpoint-urilor |
| `api/v1/idnp/{IDNP}.json` | Verificare exactă: 200 dacă figurează, 404 dacă nu |
| `dataset/subjects.json` | Lista completă a înregistrărilor |
| `api/v1/subjects.csv` | Lista completă în CSV (UTF-8 cu BOM, se deschide direct în Excel) |
| `dataset/details/{decizie}.json` | Motivul, funcția, locul nașterii și textul de identificare pentru fiecare subiect |
| `dataset/decisions.json` | Catalogul deciziilor |
| `api/v1/latest.json` | Ultimele 150 de înregistrări aplicate în RM |
| `api/v1/top.json` | Clasamentele și formula lor |
| `api/v1/stats.json` | Statistici pe tip, regim, măsură, lună și program |

## Deschidere locală

```bash
python3 -m http.server 8000
```

Apoi deschideți `http://localhost:8000`. Deschiderea directă a fișierului `index.html` nu încarcă datele.

## GitHub Pages

1. Publicați depozitul pe GitHub.
2. În Settings → Pages, alegeți ramura `main` și folderul `/` (root).
3. Site-ul este servit din fișierele deja generate. Nu este nevoie de build.

## Actualizarea listei

Când apare o decizie nouă, puneți PDF-ul în `data/` și rulați:

```bash
python3 scripts/extract.py
```

Scriptul rescrie `dataset/`, apoi construiește `api/v1/` prin `scripts/build_api.py`. Are nevoie de [Poppler](https://poppler.freedesktop.org/) (`pdftotext`) și, pentru deciziile scanate, de Tesseract cu limbile `ron`, `rus` și `eng`. Dacă s-a schimbat doar logica de clasament, e suficient `python3 scripts/build_api.py`, care nu citește PDF-urile.

Deciziile de modificare nu sunt importate a doua oară: textul consolidat al deciziei de punere în aplicare este deja forma în vigoare. Decizia nr. 3 este abrogată și nu intră în căutare.

## Indicele de relevanță

Topurile folosesc un scor calculat automat, identic pentru toți subiecții (constantele sunt în `scripts/build_api.py`):

- +30 legătură cu Republica Moldova (cetățenie sau IDNP);
- +25 pentru fiecare regim suplimentar (UE, ONU, SUA, UK, Canada) și +10 pentru fiecare decizie CIS suplimentară;
- +5 pentru fiecare alt subiect în a cărui motivare este menționat (maximum 40);
- +30 / +20 / +10 după funcție (demnitar sau lider politic / comandant, judecător, conducător / om de afaceri sau politician);
- +5 pentru ambele măsuri și +5 pentru aplicare în ultimele 12 luni.

Scorul arată vizibilitatea unui caz, nu gravitatea faptelor.

## Limite

- Unele anexe din PDF (de exemplu decizia nr. 50) nu conțin numele, ci doar un marcaj. Ele apar în catalog, cu mențiunea corespunzătoare.
- Deciziile scanate (nr. 1, 8, 9 și 10) trec prin recunoaștere optică; textul poate fi incomplet.
- Coloanele tabelelor sunt reconstruite după poziția cuvintelor. Textul original de identificare este disponibil în fiecare fișă.
