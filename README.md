# Bokami

Minimalistisk, rask bokleser og digital bokhylle for bildeserier, `.pdf` og `.epub`, laget av søte snille gem gem antigravity.

## Støttede bokformater

Legg bøkene dine i `books/`-mappen (styres av miljøvariabelen `BOOKS_DIR` eller `data/config.json` på serveren — kan ikke endres fra nettleseren):

1. **Bildeserie (1 bok per undermappe):**
   Støtter `.jpg`, `.jpeg`, `.png`, `.webp` og `.avif`.
   ```text
   books/
     Min Bok 1/
       c1.jpg      # Forside / forsats (valgfri)
       c2.jpg      # Bokrygg / spine (valgfri)
       c3.jpg      # Bakside / baksats (valgfri)
       0001.jpg    # Side 1
       0002.jpg    # Side 2
       ...
   ```
2. **PDF, EPUB og bildebok-ZIP:**
   Legg `.pdf`- eller `.epub`-filer direkte i `books/`, i en egen undermappe (gjerne sammen med `c1.jpg` / `c2.jpg` / `c3.jpg`), eller last opp `.pdf`, `.epub` eller `.zip` (med bildefiler) direkte fra **Innstillinger (⚙)** som admin.

## Funksjoner

* **To bokhylle-moduser:**
  * **Rutenett (Grid):** Minimalistisk rutenett med raskt bytte mellom forsats (`c1`), rygg (`c2`) og baksats (`c3`).
  * **Rygg-karusell:** Horisontal bokhylle der bøkene står som bokrygger (`c2`), og den valgte boka i midten utvider seg og viser forsiden (`c1`) eller baksiden (`c3`).
* **Leser (Player):**
  * **2-siders oppslag** på PC (med valgfritt `Forsats alene`), **enkeltside** (standard på mobil) og **vertikal scroll**.
  * Zoom & panorering, hurtigtaster og forhåndslasting av kommende sider.
* **Profiler, admin-roller, kapitler og bokmerker:**
  * Flere brukerprofiler lagres på serveren (`data/profiles.json`) med individuell leseprogresjon, preferanser og bokmerker med notater.
  * **Multi-admin:** Utvalgte profiler kan gis admin-rolle (med globalt eller personlig admin-passord) for å laste opp bøker, endre visningsnavn uten å røre mappenavn på disk, sette felles kapitler/bokstørrelse, og skjule eller låse bestemte bøker per brukerkonto.
  * Felles kapitler lagres i `book.json` inne i hver bokmappe (eller i `data/bookmeta.json` for enkeltstående PDF/EPUB).
* **Eksport og sikkerhet:**
  * Eksporter valgt sideområde fra bildeserier til **PDF** eller **ZIP** direkte fra leseren.
  * Eget leserpassord for vanlige brukere og eget admin-passord (lagret hashet med `scrypt`, `HttpOnly`-sesjonskapsler og beskyttelse mot CSRF/XSS/path traversal).
  * Ved første oppstart uten konfigurert passord genereres tilfeldige passord automatisk og skrives ut i konsollen.

## Starte lokalt

Krever **Node.js 22+**. Ingen `npm install` er nødvendig.

```bash
node server.js
```

* **På PC:** Åpne `http://localhost:3000`
* **På mobil (LAN):** Åpne LAN-adressen som vises i konsollen eller under **Innstillinger (⚙)** som admin.

## Kjøre med Docker

Prebygde images publiseres til GitHub Container Registry (`ghcr.io/t0m0t0w/bokami:latest`):

```bash
docker run -d \
  --name bokami \
  -p 3000:3000 \
  -e BOKAMI_PASSWORD=ditt-leserpassord \
  -e BOKAMI_ADMIN_PASSWORD=ditt-admin-passord \
  -v $(pwd)/books:/app/books \
  -v $(pwd)/data:/app/data \
  ghcr.io/t0m0t0w/bokami:latest
```

## Miljøvariabler

| Variabel | Standard | Beskrivelse |
| --- | --- | --- |
| `PORT` | `3000` | Porten HTTP-serveren lytter på |
| `BOOKS_DIR` | `./books` | Mappe som inneholder bøker (kun konfigurerbar på server) |
| `DATA_DIR` | `./data` | Mappe for `config.json`, `profiles.json`, `sessions.json` og cached omslag |
| `BOKAMI_PASSWORD` | Genereres / `config.json` | Overstyrer leserpassord for vanlige brukere (kan også bruke `PASSWORD`) |
| `BOKAMI_ADMIN_PASSWORD` | Genereres / `config.json` | Overstyrer globalt admin-passord for administratorer |
| `TRUST_PROXY` | `false` | Sett til `true` bak reverse proxy (f.eks. Traefik/Cloudflare) for `X-Forwarded-Proto`/`X-Forwarded-For` og `__Host-` sikre cookies |

## Kubernetes / Flux

Manifester for Kubernetes og Flux finnes i [`k8s-manifests/`](./k8s-manifests/README.md).
