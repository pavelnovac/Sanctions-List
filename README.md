# Lista de sancțiuni a Republicii Moldova

Aplicație statică, fără server, pentru căutarea și verificarea persoanelor, entităților și navelor pentru care Republica Moldova a pus în aplicare măsuri restrictive. Poate fi publicată pe GitHub Pages.

Sursa sunt deciziile Consiliului interinstituțional de supervizare din mapa `data/`. Lista oficială curentă rămâne cea de pe [date.gov.md](https://date.gov.md/open/sanctioned-subjects) și textul publicat în Monitorul Oficial.

## Ce se poate căuta

- nume și aliasuri, inclusiv cu sau fără diacritice
- codul de identificare de stat (IDNP), potrivire exactă în modul „Verificare IDNP”
- seria și numărul documentului (buletin, pașaport), de exemplu `B 28017764` sau `AB1637205`

Fișa unui subiect arată cauza, datele de identificare, măsurile (blocarea fondurilor, restricții de călătorie) și decizia CIS, cu legătură către pagina din PDF.

## Deschidere locală

Din rădăcina proiectului:

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

Scriptul rescrie `dataset/`. Are nevoie de [Poppler](https://poppler.freedesktop.org/) (`pdftotext`) și, pentru cele patru decizii scanate, de Tesseract cu limbile `ron`, `rus` și `eng`.

Deciziile de modificare nu sunt importate a doua oară: textul consolidat al deciziei de punere în aplicare este deja forma în vigoare. Decizia nr. 3 este abrogată și nu intră în căutare.

## Limite

- Unele anexe din PDF (de exemplu decizia nr. 50) nu conțin numele, ci doar un marcaj. Ele apar în catalog, cu mențiunea corespunzătoare.
- Deciziile scanate (nr. 1, 8, 9 și 10) trec prin recunoaștere optică; textul poate fi incomplet.
- Coloanele tabelelor sunt reconstruite după poziția cuvintelor. Căutați și în textul de identificare din fișă dacă un câmp nu a fost separat.
