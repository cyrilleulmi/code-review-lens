# Analyse ohne KI

Die gesamte Einteilung ist deterministisch: gleicher PR + gleiche Regeln = gleiches Ergebnis. Grundlage sind der Diff von GitHub und der Quelltext der neuen Dateiversion.

## 1. Segmente bilden

Für jede geänderte Datei:

1. **Pfad-Regel passt** (z. B. `**/package-lock.json`, `**/i18n/**`) → jede Hunk wird ein Segment dieser Kategorie. Fertig. Ausnahme: Regeln mit `"symbols": true` (die Test-Regel) zerlegen die Datei trotzdem wie in Punkt 2, damit jeder Testfall ein eigenes Segment ist.
2. **Sprache mit Struktur** (TS/JS/Java/Kotlin/C#/Go) und Quelltext vorhanden → `SymbolExtractor` findet Funktionen, Methoden, Klassen, Interfaces, Typen, Enums und Top-Level-Konstanten mit Zeilenbereich (Kommentare und Annotationen direkt darüber gehören dazu). Jede geänderte Zeile kommt in das **innerste** Symbol, das sie enthält. Leere Zeilen schliessen sich dem Nachbarn an. Zeilen ausserhalb aller Symbole (Imports, Modul-Code) bilden pro Hunk ein «Modul»-Segment.
3. **Sonst** (HTML, SQL, gelöschte Dateien …) → ein Segment pro Hunk.

Callbacks in Objekt-Literalen innerhalb von Funktionen (`subscribe({ next: … })`) werden **nicht** als eigene Symbole behandelt, damit eine Methode nicht zerstückelt wird. Ebenso Hilfsfunktionen innerhalb eines Testfalls.

**Testfälle** sind eigene Symbolarten: `test` (`it('…')`, `test('…')`, `@Test`-Methoden, Go `TestXxx`), `suite` (`describe('…')`) und `setup` (`beforeEach` & Co.). Ihr Name ist die Beschreibung, mit den umgebenden `describe`-Blöcken: `PlayerView › jersey number › saves a new jersey number`.

## 2. Quick wins erkennen

Segmente ohne Pfad-Regel werden gegen die **Segment-Regeln** geprüft (erste passende gewinnt):

| Regel | Erkennt | Prinzip |
|---|---|---|
| `imports` | Imports & Formatierung | Alle geänderten Zeilen sind Import-/Export-Zeilen |
| `formatting` | Imports & Formatierung | Hinzugefügte und gelöschte Zeilen sind ohne Leerraum identisch (umformatiert / verschoben) |
| `jpa-repositories` | → Datenbank & Migrationen | Datei enthält `interface … extends …Repository` oder `@Query(` (`fileText`) |
| `jpa-entities` | → Datenbank & Migrationen | Datei enthält `@Entity`, `@Embeddable` oder `@MappedSuperclass` |
| `type-symbols` | DTOs & Typen | Segment ist ein `interface`, `type` oder `enum` |
| `mapper-code` | Mapper | Funktionsname wie `map…`, `to…`, `from…`, `convert…` **und** alle Zeilen sind Feldzuweisungen |
| `rest-trivial` | Banale REST-Aufrufe | Alle Zeilen sind Signatur / `http.get(...)` / `fetch(...)` / Header / `return service.x(...)`, mindestens ein echter HTTP-Aufruf |
| `type-declarations` | DTOs & Typen | Alle Zeilen sind Feld-/Typdeklarationen (`name?: string;`, `private String name;`, Annotationen) |
| `declarative-config` | Deklarative Felder & Konfiguration | Alle Zeilen sind Objekt-Literale mit festen Werten (`{ name: 'title', type: 'text' }`) |
| `logging` | Logging | Nur `console.log`/`log.info(…)` |

«Alle Zeilen» ignoriert immer Leerzeilen, reine Klammerzeilen und Kommentare.

Die Pfad-Regeln (Auszug): generierte Dateien und Lockfiles (auch `gen/`, `dist/`, `build/generated/`), Übersetzungen (`i18n/`, `locales/`, `*.po`, `messages*.properties` …), Dokumentation (`*.md`), Werkzeug-Konfiguration (`tsconfig*.json`, Linter, generische `*.yml`), DTO-Dateien (`*Dto.*`, `dto/`, `*.model.ts`, `types.ts`), Mapper-Dateien (`*Mapper.*`), Tests, Styles & Assets. Keine Quick wins, sondern eigene Kategorien: Migrationen (*Datenbank & Migrationen*), API-Verträge (`openapi*.yaml` …), Laufzeit-Konfiguration, Deployment/CI und Abhängigkeiten (*Konfiguration, Build & Betrieb*).

## 3. Aufrufe und Flüsse

1. **Kanten:** Für jede geänderte Funktion A wird ihr Rumpf (ohne Imports, ohne darin verschachtelte geänderte Funktionen) nach den Namen der anderen geänderten Funktionen/Konstanten B durchsucht. Kurze oder generische Namen (`get`, `save`, `map` …) zählen nur mit Aufrufsyntax `name(`. Über Dateigrenzen braucht es einen Import-Beleg (Modulpfad, Klassen- oder Funktionsname im Import; Java: Klassenname im Code). Ausnahme: klassische Skripte ohne Module teilen sich den globalen Scope.
   Go: Dateien im selben Ordner sind ein Paket und brauchen keinen Import. Tests rufen Produktivcode auf, aber nie umgekehrt.
2. **Hubs** (mehr als 5 Aufrufer) werden für den Zusammenhang ignoriert, damit `cn()` oder `Button` nicht alles zu einem Fluss verkleben. Kanten von Tests zählen dabei nicht.
3. **Flüsse:** Jeder Einstiegspunkt (geänderte Funktion ohne geänderten Aufrufer) bekommt einen eigenen Flow mit allem, was er erreicht – mindestens zwei Segmente, davon mindestens eines Logik. Eine gemeinsam genutzte Funktion ist deshalb Teil **mehrerer** Flows. Ausnahme: In zusammenhängenden Gruppen mit mehr als 20 Funktionen kommt jede Funktion nur im ersten Flow vor, der sie erreicht (sonst würden riesige PRs mit Duplikaten geflutet). Tests werden nie Teil eines Flows.
4. **Reihenfolge:** Tiefensuche ab dem Einstiegspunkt (kein Aufrufer im Flow; äussere Schicht zuerst), Aufrufe in Reihenfolge ihrer Zeile. Daraus entstehen Schrittnummer und Tiefe für Diagramm und Einrückung.
5. **Titel:** Kette der ersten Schritte, z. B. `update → validateJerseyNumber → isJerseyNumberTaken`. Beginnt der Flow an einem Endpunkt oder Listener, steht der Auslöser davor: `PUT /rest/players/{}: updatePlayer → …`, `JMS-Listener: onMessage → readEvent → applyEvent`.

## 3b. Über REST ins Backend

Für jedes Segment werden HTTP-Aufrufe mit literaler URL gesucht (`this.http.put<T>(`/api/players/${id}`, …)`, `fetch('/api/x', { method: 'POST' })`, `axios.get(…)`), für jede Methode die Endpunkte (`@Path("/api/players")` an der Klasse + `@PUT @Path("/{playerId}")` an der Methode, `@GetMapping`, Next.js `app/api/…/route.ts` mit `export async function PUT`, `app.put('/x', …)`, `HandleFunc("PUT /x", …)`). Passen Methode und Pfad (Parameter = Platzhalter), entsteht eine Kante der Art `http`. Damit läuft ein Flow z. B. so: `PlayerView.saveJerseyNumber → PlayerApiService.setJerseyNumber ⇢ PUT /api/players/{} ⇢ PlayerResource.update → validateJerseyNumber → Player.isJerseyNumberTaken`.

**Generierte Clients (OpenAPI):** Ruft das Frontend einen generierten Service auf (`this.playersService.updatePlayer(id, body)`), steht keine URL im Code. Dafür liest die Analyse die Verträge des Repos (`openapi*.yaml`, `swagger.json` …) und kennt jede Operation mit operationId, Methode und Pfad (inkl. `servers: - url: /rest`). Ein Aufruf `.updatePlayer(` wird so zu `PUT /rest/players/{}`; das Gegenstück ist eine Methode `updatePlayer` in einer Klasse, die das generierte Interface implementiert (`class PlayerController implements PlayersApi`), oder ein Spring-/JAX-RS-Endpunkt mit passendem Pfad. Die Kante heisst dann `PUT /rest/players/{} (updatePlayer)`. Geänderte Zeilen im Vertrag (Kategorie *API-Verträge*) verweisen auf die geänderten Aufrufer und Implementierungen derselben Operation.

![Flow über REST](img/flow-rest.png)

## 3c. Architektur und Frontend

* **Ports & Adapters:** Die Ordner des ganzen Repos werden einmal geladen (`structure.json`). Gibt es Rand- und Kern-Ordner (siehe Annahme B14), bekommt jedes Code-Segment eine Schicht und erscheint zusätzlich in *Domäne*, *Use Cases*, *Application Layer* oder *Adapter* (eingehend / ausgehend / weitere).
* **Frontend:** Segmente in Frontend-Dateien werden gegen die `aspects`-Regeln geprüft (erste passende): Routing, Zustand, API-Anbindung, Formulare, Komponenten-Logik, Templates. Bedingungen: `paths`, `kinds`, `symbol`, `text` (Muster im Code des Segments), `fileText` (Muster irgendwo in der Datei), `special: "markup"` (mehrheitlich HTML/JSX-Zeilen).
* **Schichten mit Adaptern (Onion-Stil):** Hat das Repo `domain`, `application` und `adapter`, aber keine Ports/Use Cases, heisst der Stil `layered`. Die Kategorien sind dieselben; Adapter werden nach Rolle gruppiert (eingehend inkl. Message-Listener, ausgehend, Mapping, Konfiguration).
* **Querschnitt (`concerns`):** Sicherheit & Berechtigungen, Messaging & Events, Transaktionen & Nebenläufigkeit, Datenbank & Migrationen – für Frontend und Backend, **alle** passenden Regeln zählen. Funktionen werden mit ihren Annotationen geprüft (`@Transactional`, `@JmsListener`, `@PreAuthorize` …), Konfigurationsdateien zeilenweise (`spring.jms…`, `…cors…`, `ddl-auto`).
* **Schema:** Migrationen und Entities, die dieselbe Tabelle nennen, stehen in *Datenbank & Migrationen* in der Gruppe «Tabelle x» und verweisen aufeinander.
* Alles das sind **zusätzliche Orte** mit eigenem Ok. Regeln mit `"extras": false` (Generiert, Imports, Tests, Styles …) bekommen keine.

## 3d. Komponenten

Geänderte Code-Dateien gleichen Namens im gleichen Ordner bilden eine Komponente (`player-view.ts/.html/.scss`). Jede bekommt eine Spalte (Frontend, Adapter ein, API, Use Cases, Application, Logik, Adapter aus, Daten, Domäne, Tests); die Aufruf- und REST-Kanten zwischen ihren Segmenten werden zu `componentEdges` zusammengefasst. Die Übersicht zeigt daraus das Komponentendiagramm.

![Komponentendiagramm und Architektur-Kategorien (buckpal#41)](img/components.png)

## 3e. Kategorien als Module

Jede Kategorie ist ein eigenes **Modul** (`CategoryModule`) mit derselben Schnittstelle:

| Methode | Zweck |
|---|---|
| `id()`, `info()` | Name, Icon und **Selbstbeschreibung**: `summary` (wofür), `builds` (wie sie aufgebaut ist: welcher Code hier landet und warum), `divides` (wie sie in Gruppen unterteilt wird). Das UI zeigt `builds`/`divides` unter dem Titel der Kategorie («Wie entsteht diese Kategorie?») und als Tooltip in der Übersicht. |
| `groups(context)` | Die Gruppen der Kategorie, berechnet aus `SegmentFacts` (Pfad, Regel-Kategorie und -Gruppe, Schicht, Frontend-Aspekt, Querschnittsthemen, Adapter-Richtung, «Teil eines Flusses») und den Flüssen. |
| `view()` | `groups` (Standard: Liste von Gruppen mit Code-Blöcken) oder eine **Ausnahme mit eigener Ansicht**: `flow` (Aufrufdiagramm, Blöcke in Aufrufreihenfolge), `tests` (Gruppen plus Spezifikation der Testnamen, Abdeckung des geänderten Codes und Testübersicht, Abschnitte 5a–5c). Das UI entscheidet danach, nicht nach der Kategorie-Id. |
| `origin()` | `builtin` (fest eingebaut, z. B. Datenflüsse), `rules` (aus der Regeldatei); später `external`. |

**Entkoppelt:** Ein Modul kennt kein anderes Modul und den `Analyzer` nicht. Hinzufügen oder Entfernen einer Kategorie ändert nur ihre eigene Liste; ein Segment, das mehrere Module beanspruchen, wird einfach in jedem zu einem eigenen Ort (Abschnitt 4). Die Module werden aus den Kategorien der Regeldatei erzeugt (`CategoryModules`): Kategorie mit Regeln → Regel-Gruppen; `domain`/`usecases`/`application`/`adapters` → zusätzlich die Architektur-Schicht; Kategorie mit `aspects` → Frontend-Aspekt; mit `concerns` → Querschnittsthema; `flows` → eine Gruppe pro Fluss mit eigener Ansicht; `logic` → der Rest ausserhalb von Flüssen.

**Beschreibung:** `builds` und `divides` werden aus den Regeln abgeleitet (Regel-Gruppen mit ihrem Grund, Aspekte, Querschnittsthemen), stimmen also auch bei eigenen Regeln. Wer es anders formulieren will, setzt `"builds"` / `"divides"` an der Kategorie in `rules.json`.

**Später von aussen (noch nicht umgesetzt):** Das Modul bekommt nur `SegmentFacts` und liefert nur `Group`s, ohne gemeinsamen Zustand. Damit kann ein Modul von ausserhalb der Anwendung geliefert werden. `CategoryModules.build(rules, additional)` nimmt dafür bereits zusätzliche Module entgegen (Ids dürfen nicht doppelt vergeben werden); Gruppen-Ids beginnen mit `<id>/`. Es gibt noch keine Quelle für solche Module und nichts, das sie lädt.

## 4. Orte

Jede Gruppe, die ein Segment zeigt, ist ein **Ort** (`segments[].places`): die Gruppe seiner Kategorie (ausser Logik, die in einem Flow liegt – die steht nur dort) und jeder Flow, der es enthält. Beispiel: `PlayerApiService.setJerseyNumber` ist ein banaler REST-Aufruf *und* der letzte Schritt von `saveJerseyNumber → setJerseyNumber` → zwei Orte, zwei Oks.

**Eine Zeile an mehreren Orten** (`review/LineAcceptance`, im UI gespiegelt in `acceptance.ts`):

* Jeder Ort braucht sein eigenes Akzeptieren. Eine Zeile ist **akzeptiert**, sobald sie an allen ihren Orten akzeptiert ist.
* Ist sie an einem Ort akzeptiert, gilt sie an jedem anderen Ort als **halb akzeptiert**: Das Häkchen ist halb gefüllt, daneben steht der Hinweis «bereits an anderem Ort akzeptiert» (bei mehreren: «an *n* anderen Orten»; einmal pro zusammenhängendem Lauf solcher Zeilen, nicht auf jeder Zeile), der Tooltip nennt die Orte, ein Klick darauf springt zum ersten. Halb akzeptiert zählt im Fortschritt noch **nicht**; mit einem Klick auf das Häkchen wird sie auch hier akzeptiert.
* Mehrere akzeptierte Orte werden einzeln geführt. Nimmt man an einem Ort das Akzeptieren zurück, bleiben die anderen Orte akzeptiert (auch bei einer sonst überall akzeptierten Zeile).
* Eine Markierung ohne Ort (Dateiansicht, Agenten) oder auf einem Ort, an dem die Zeile nicht vorkommt, gilt für alle Orte auf einmal. Zeilen mit nur einem Ort kennen den Halbzustand nicht.
* Ausgeschaltete Kategorien zählen nicht als Ort. «Halb akzeptiert» ist abgeleitet und steht nicht in `review.json`; das Dateiformat (`ok`, `okAt`) ist unverändert.

## 5. Tests verknüpfen

Für jeden geänderten Testfall wird der Aufruf-Graph ab dem Test durchlaufen (Breitensuche, bis 4 Ebenen):

* Erreicht er eine geänderte Funktion direkt (oder über eine Hilfsfunktion in der Testdatei) → **direkt**, mit der Zeile im Test.
* Von dort aus weiter erreichte geänderte Funktionen → **indirekt**, mit dem Segment, über das sie erreicht werden.
* Gehört eine erreichte Funktion zu einer Abhängigkeit, die der Test **mockt** (Steckbrief `mocks`, 5d), läuft im Test nur der Mock: Sie steht mit `mocked: true` in `covers`, und die Suche geht dort nicht weiter (**Mock-Grenze**, 5g). HTTP-Kanten werden nie verfolgt – Unit-Tests mocken HTTP.
* **Komponenten:** die Datei nach Namenskonvention (`PlayerResourceTest.java` → `PlayerResource.java`, `player-view.spec.ts` → `player-view.ts`; bevorzugt gleiche Sprache) und die Klassen/Dateien des direkt aufgerufenen Codes.

Beispiel spongecoach#13: `PlayerResourceTest › savesJerseyNumber` → `PlayerResource.update` (direkt, Testzeile 28) → `validateJerseyNumber` (über update) → `Player.isJerseyNumberTaken` (über validateJerseyNumber).

![Testübersicht](img/tests.png)

### 5a. Abdeckung aus Sicht des Codes

Die Testübersicht zeigt, was ein Test erreicht. Die **Abdeckung** dreht die Sicht um: Welche geänderte Logik erreicht *kein* geänderter Test – und welche nur ein bestehender (5f)? Sie steht in `analysis.json` unter `coverage[]` (ein Eintrag pro testbarer Funktion) und im UI über der Testübersicht der Kategorie Tests.

**Testbar** ist ein Segment, wenn es eine geänderte Funktion, Methode oder Komponente ist (`symbolKind` `function`, `method`, `component`; keine Testfälle, Testhilfen oder Setup-Blöcke), mindestens eine nicht triviale Zeile geändert hat (nicht nur Leerzeilen, Kommentare, Klammern) und seine Hauptkategorie Tests braucht: `needsTests` an der Kategorie in der Regeldatei, Default `true`. In den Standardregeln steht `false` bei `quick-wins`, `tests`, `styles`, `api-contract` und `runtime` (Mechanisches und Konfiguration). `persistence` braucht Tests: Entities enthalten oft echte Logik (z. B. `Player.isJerseyNumberTaken`). Methoden, die nur Frameworks aufrufen (`constructor`, `ngOnInit`, `render`, `main`, `GET`/`POST` …), fehlen ebenfalls: Kein Test ruft sie beim Namen auf, sie stünden immer unter «Ohne Test».

**Triviale Zugriffsmethoden** fehlen in jeder Kategorie: Getter und Setter (Java `getX`/`setX`, TS `get`/`set`), deren Rumpf nur aus einer einzigen Anweisung besteht – `return this.x;`, `return x;` (auch mit einem Empfänger wie Gos `return p.x`), `this.x = x;` oder `x = value;`. Geprüft wird der Code ohne Kommentare und Strings zwischen der ersten `{` und der letzten `}` der Funktion; die Signatur und die Klammern zählen also nicht. Alles andere bleibt drin: ein Literal (`return "fix";`), ein Aufruf (`return repo.find(id);`), eine Rechnung, eine zweite Anweisung, Funktionen ohne geschweifte Klammern (Pfeilfunktionen, Kotlins `get() = field`) – im Zweifel lieber einmal zu viel in der Liste als echte Logik versteckt.

| Feld | Bedeutung |
|---|---|
| `status` | `direct`: ein geänderter Test ruft die Funktion auf (auch über Hilfsfunktionen der Testdatei). `indirect`: nur über anderen geänderten Code erreicht. `existing`: kein geänderter Test erreicht sie, aber ein bestehender, unveränderter Test (direkt oder indirekt, Abschnitt 5f). `none`: kein Test erreicht sie. Erreicht ein Test nur einen **Mock** der Funktion (5g), zählt das für keinen Status. |
| `directTests`, `indirectTests` | Ids der Test-Segmente, aus den Verknüpfungen von Abschnitt 5 (ohne gemockte). |
| `existingTests` | Ids der bestehenden Tests (`existingTests[]`, `e1` …), die die Funktion direkt oder indirekt erreichen – auch bei `direct`/`indirect`: alte Tests, die durch die Änderung laufen und vielleicht angepasst werden müssen (ohne gemockte). |
| `mockedTests` | Ids der geänderten und bestehenden Tests, die nur einen Mock der Funktion erreichen (5g). Eine Funktion, die nur gemockt erreicht wird, steht unter «Ohne Test». |
| `branches` | Entscheidungen in der **ganzen** Funktion, gezählt auf dem Code ohne Strings und Kommentare: `if` (auch `else if`, einmal), `elif`, `case`, `catch`, `except`, `for`, `while`, `&&`, `\|\|` und das `?` eines ternären Ausdrucks. Als ternär zählt nur ein `?` mit Leerraum (oder Zeilenende) auf beiden Seiten; so zählen `?.`, `??`, `?:` (TS-optional, Kotlin-Elvis), `<?>` und `String?` nicht. Nicht gezählt: `else`, `default`, Kotlins `when`-Zweige, Pythons `and`/`or`. |
| `changedLines` | Geänderte Zeilen des Segments ohne Leerzeilen, Kommentare und reine Klammern. |
| `risk` | `changedLines × (1 + branches)` – viel Geändertes mit vielen Verzweigungen zuerst. Nur zum Sortieren. |

Sortiert ist die Liste nach Status (`none`, `indirect`, `existing`, `direct`) und darin nach `risk` absteigend. Die Reihenfolge folgt dem Handlungsbedarf: Was kein Test erreicht, zuerst; dann, was ein geänderter Test nur über anderen Code erreicht; dann, was nur bestehende Tests erreichen – die Funktion läuft unter einem Test, aber keiner wurde für diese Änderung geschrieben oder angepasst, ob die alten Erwartungen das neue Verhalten prüfen, ist offen; zuletzt, was ein geänderter Test direkt aufruft. Ein geänderter Test bestimmt den Status immer, auch wenn zusätzlich bestehende Tests die Funktion erreichen. Wie die Verknüpfung selbst ist alles **statisch**: Es zählen geänderte Tests und die nachgeladenen bestehenden Testdateien (5f), Aufrufe über HTTP oder Reflection werden nicht gesehen, und «direkt getestet» heisst «aufgerufen», nicht «jeder Zweig geprüft».

**Im UI:** Die Kategorie Tests hat die Ansicht `tests` (`view()`): über der Testübersicht steht «Abdeckung des geänderten Codes» mit einer Zusammenfassung und den Funktionen in den Gruppen «Ohne Test», «Nur indirekt getestet», «Nur durch bestehende Tests» und «Direkt getestet» (eingeklappt). Unter dem Titel steht die Grundlage («Grundlage: geänderte Tests im PR + 2 nachgeladene Testdateien (Namenskonvention)», 5f). Klick auf eine Zeile springt zum Code, Klick auf einen Test zum Test. Ändert ein PR Code, aber keinen Test, gibt es die Kategorie Tests nicht; dann führt die Kachel «Abdeckung des geänderten Codes» auf der Übersicht (und der Eintrag «Abdeckung» im Review-Baum) auf eine eigene Seite. Jeder testbare Block trägt im Kopf ein Abzeichen: «ohne Test», «nur indirekt getestet», «durch bestehende Tests» oder «n Tests».

![Dateiansicht: Block an zwei Orten](img/places.png)

### 5b. Spezifikation (Testnamen)

Viele PRs bestehen zu einem guten Teil aus Tests. Bevor man Testcode liest, will man wissen, **welches Verhalten** die Tests festlegen und was sich daran geändert hat. Dafür zeigt die Kategorie Tests ganz oben die Testnamen jeder geänderten Testdatei als Gliederung (Suite › Suite › Test), als Diff gegen die Basisversion. In `analysis.json` steht das unter `specs[]` (eine `SpecFile` pro Testdatei, nach Pfad sortiert; Code in `analysis/Specs`).

**Welche Dateien:** Testdateien nach der Pfadregel der Kategorie `tests` (`*.spec.*`, `*Test.java`, `test/**` …) in einer Sprache mit Symbolen, mit Patch. Dateien ohne einen einzigen Testfall (Hilfsklassen, Fixtures) fehlen.

**Alte Version:** Für geänderte, umbenannte und gelöschte Testdateien wird der Inhalt am Basis-Commit des PRs (`baseSha`) geladen – bei umbenannten Dateien unter dem alten Pfad – und unter `sources-base/<alter Pfad>` gespeichert, einmal beim Laden des PRs (bzw. bei der ersten Analyse für ältere Snapshots). Schlägt das fehl, steht `baseAvailable: false` und die Gliederung zeigt nur die neue Seite («Basisversion nicht verfügbar – nur neue Seite»). Beim ganzen Repository (Nummer 0) gibt es keine Basis und damit keinen Spec-Diff (`specs` ist leer): Jeder Test wäre «neu», die Gliederung riesig und ohne Aussage.

**Einträge:** Suites und Testfälle kommen aus der Symbolerkennung (Arten `suite`, `test`; Abschnitt 5). Eine Klasse, die einen Testfall enthält, gilt als Suite – bei JUnit also die Testklasse und ihre `@Nested`-Klassen. Die Verschachtelung ergibt sich daraus, welcher Bereich welchen umschliesst; `suites` nennt die umschliessenden Suites von aussen nach innen, `depth` die Einrückung.

**Abgleich** zwischen alter und neuer Version, deterministisch in dieser Reihenfolge:

1. **Gleicher Pfad** (Art + Suite-Kette + Name) → derselbe Eintrag. Gibt es denselben Pfad mehrmals, werden sie in Dateireihenfolge gepaart. Status `changed`, wenn im PR-Diff eine geänderte Zeile im Bereich des Eintrags liegt (neue oder alte Seite; Leerzeilen und reine Klammerzeilen zählen nicht), sonst `unchanged`.
2. **Umbenannte Suites:** Eine entfernte und eine neue Suite derselben Datei, deren Text ohne Leerraum und ohne den eigenen Namen identisch ist, sind eine Umbenennung (`renamed`, `previousName`). Danach werden die alten Pfade darunter auf den neuen Namen umgeschrieben und Schritt 1 wiederholt – die unveränderten Tests einer umbenannten Suite bleiben so `unchanged`.
3. **Umbenannte Tests:** dasselbe für Testfälle. Gepaart wird in alter Dateireihenfolge, jeweils mit dem ersten freien neuen Eintrag (neue Dateireihenfolge) mit gleichem Text. Liegt der Test jetzt in einer anderen Suite, enthält `previousName` den alten Pfad mit « › ».
4. Der Rest ist `added` (nur neu) oder `removed` (nur alt). Eine Suite ist also `added`/`removed`, wenn sie ganz neu ist oder ganz fehlt; sonst `changed`, sobald darin etwas geändert ist.

Ändert man den Namen **und** den Inhalt, ist das keine Umbenennung, sondern «entfernt» + «neu». Wird eine Suite umbenannt und darin ein Test geändert, erscheint die ganze Suite als entfernt und neu (der unveränderte Teil wird dann über Schritt 3 trotzdem als umbenannt erkannt).

**Reihenfolge:** Einträge stehen in der Reihenfolge der neuen Datei. Ein entfernter Eintrag steht hinter seinem vorherigen Geschwister aus der alten Datei (und hinter dessen Kindern), sonst als erstes Kind seiner Suite, sonst ganz oben. Entfernte Kinder einer entfernten Suite folgen ihr in alter Reihenfolge.

**Ohne Basisversion** werden nur die Einträge der neuen Datei gezeigt; der Status kommt dann aus dem Diff allein: `added`, wenn alle nicht trivialen Zeilen hinzugefügt sind, `changed` bei sonstigen geänderten Zeilen (auch gelöschten) im Bereich, sonst `unchanged`. Entfernte und umbenannte Tests sind so nicht erkennbar.

| Feld (`SpecEntry`) | Bedeutung |
|---|---|
| `name`, `suites`, `kind` | Name, umschliessende Suites (aussen zuerst), `suite` oder `test`. |
| `status` | `added`, `removed`, `changed`, `renamed`, `unchanged`. |
| `previousName` | Bei `renamed` der alte Name (bzw. der alte Pfad, wenn sich die Suites geändert haben). |
| `segmentId` | Das Segment dieses Eintrags, wenn er geänderte Zeilen hat; `null` bei entfernten und unberührten Einträgen. |
| `line`, `oldLine` | Startzeile in der neuen bzw. alten Datei (`null`, wo es die Seite nicht gibt). |
| `depth` | Einrückung in der Gliederung. |
| `expectations` | Geänderte Erwartungen gegenüber der Basisversion (Abschnitt 5c); leer bei neuen und entfernten Einträgen und ohne Basisversion. |
| `assertionsBefore`, `assertionsAfter` | Anzahl Assertion-Anweisungen im Testrumpf, alt bzw. neu (`null` bei Suites und wo es die Seite nicht gibt). |
| `disabled` | Der Eintrag ist jetzt ausgeschaltet (selbst oder über eine umschliessende Suite); `false` bei entfernten Einträgen. |

**Im UI:** «Spezifikation (Testnamen)» steht in der Kategorie Tests über der Abdeckung: eine Zusammenfassung über alle Testfälle (z. B. «+6 neu · ~2 geändert · →1 umbenannt · −1 entfernt · 14 unverändert»; Suites zählen nicht) und pro Datei eine einklappbare Gliederung mit Markierung pro Eintrag: `+` neu, `~` geändert, `→` umbenannt mit «vorher: …», `−` entfernt (durchgestrichen). Unveränderte Einträge sind blass und hinter «n unveränderte anzeigen» versteckt; eine unveränderte Suite bleibt sichtbar, solange darunter etwas geändert ist. Ein Klick auf einen Eintrag mit Segment springt zum Testcode; ein entfernter Eintrag öffnet die Dateiansicht beim Block mit den gelöschten Zeilen (gesucht wird die Zeile `O<oldLine>` und die zwei folgenden), sonst ist er nicht klickbar.

### 5c. Geänderte Erwartungen

«Geändert» allein sagt nicht, **was** sich an einem Test geändert hat. Gefährlich ist der Fall, in dem ein PR bestehende Tests an kaputten Code anpasst: ein anderer erwarteter Wert, eine entfernte oder abgeschwächte Assertion, ein ausgeschalteter Test. Dafür vergleicht der Spec-Diff bei jedem gepaarten Eintrag (gleicher Pfad oder umbenannt) die Assertions der alten mit denen der neuen Version (Code in `analysis/Expectations`, Muster in den Regel-Abschnitten `assertions`, `weakAssertions`, `disabledTests`). Alles musterbasiert und deterministisch, ohne KI.

1. **Assertion-Anweisungen:** Eine Zeile des Testrumpfs, deren Code (Strings und Kommentare ausgeblendet) ein `assertions`-Muster enthält, beginnt eine Assertion – etwa `expect(`, `assertEquals(`, `assertThat(`, `verify(`, `t.Errorf(`, `assert.Equal(`, RestAssured `.statusCode(` / `.body("pfad", …)`, MockMvc `.andExpect(`, Angular `httpMock.expectOne(` / `expectNone(`, Kotest `x shouldBe 3`. Sie reicht über die folgenden Zeilen, solange Klammern offen sind, und über Fortsetzungszeilen, die mit `.` beginnen und selbst keine Assertion sind (`expect(x)` ⏎ `.toBe(1)`, AssertJ-Ketten). Von der Deklarationszeile zählt nur der Teil nach dem ersten `{` bzw. `=>` – ein Test namens `verifySaved` oder `shouldBeCreated` ist keine Assertion. Verglichen wird ohne Leerraum, ohne `;` am Ende und ohne Komma vor einer schliessenden Klammer: Umformatieren ist keine Änderung.
2. **Gegenstand** (was geprüft wird), bestimmt am Aufruf, den das Muster gefunden hat:
   * **Verketteter Matcher** (das Muster beginnt mit `.`, z. B. `.statusCode(…)`, `.body("name", …)`, `.andExpect(…)`): der Text davor, der Aufruf und alle Argumente ausser dem letzten – `.statusCode(200)` → `.statusCode(201)` ist also eine geänderte Erwartung.
   * **Gleichheit** (`assertEquals`, `assertNotEquals`, `assertSame`, `assertArrayEquals`, `assertIterableEquals`, testify `Equal`, `EqualValues`, `Exactly`, `JSONEq`, `ElementsMatch`, `InDelta` …; nur `assert…`-Namen, unqualifizierte Aufrufe und testify): der tatsächliche Wert, also das **zweite** Argument (erwartet kommt zuerst), das dritte, wenn das erste ein String ist (JUnit 4 mit Meldung vorne). JavaScripts `assert.equal(actual, expected)` hat die umgekehrte Reihenfolge und fällt deshalb unter die nächste Regel.
   * **Sonst** der Aufruf mit seinem ersten Argument: `expect(score(3))`, `assertThat(player.getName())`, `verify(repo)`, `assertNull(x)`.
   * Ein Go-Testhandle als erstes Argument (`t`, `b`, `s.T()`) wird übersprungen. Infix-Matcher ohne Klammern (Kotest): der Text vor dem Matcher.
3. **Paaren:** Zuerst identische Anweisungen (in Reihenfolge), dann übrige mit gleichem Gegenstand (in Reihenfolge).
   * `changed`: gleicher Gegenstand, anderer erwarteter Wert oder Matcher.
   * `weakened`: wie `changed`, aber die neue Anweisung passt auf ein `weakAssertions`-Muster und die alte nicht (`toEqual('Ann')` → `toBeTruthy()`, `isEqualTo(…)` → `isNotNull()`); oder eine Assertion ist weggefallen und der Test hat nur noch schwache.
   * `removed` / `added`: ohne Partner. Bei einem **entfernten Test** wird nicht jede Assertion einzeln gelistet, nur `assertionsBefore`.
4. **Ausgeschaltet:** Ein `disabledTests`-Muster im Kopf eines Tests oder einer Suite (Annotationszeilen und Deklarationszeile: `xit(`, `xdescribe(`, `it.skip`, `describe.skip`, `test.todo`, `@Disabled`, `@Ignore`, TestNG `@Test(enabled = false)`) oder – nur bei Tests – in einer Anweisung auf oberster Ebene des Rumpfs (gleich eingerückt wie die erste Rumpfzeile: Go `t.Skip(…)`, Jasmine `pending()`, Mocha `this.skip()`). Ein `t.Skip` in einem `if` ist bedingt und zählt nicht. Ein Test in einer ausgeschalteten Suite ist selbst ausgeschaltet. Gegenüber der Basis ergibt das `disabled` bzw. `enabled` (mit der ausschaltenden Zeile als Text), auch bei sonst unveränderten Tests.

Jede Änderung (`ExpectationChange`) trägt `kind`, `oldText`/`newText` (die Anweisung, Zeilen verbunden) und `oldLine`/`newLine` (ihre erste Zeile); was es auf einer Seite nicht gibt, ist `null`. Reihenfolge: wie im neuen Test, entfernte hinter der Anweisung, der sie folgten; `disabled`/`enabled` zuerst.

**Grenzen:** Gezählt wird nur, was direkt im Testrumpf steht – Assertions in Hilfsfunktionen oder `beforeEach` nicht, ausser ihr Name passt auf ein Muster (`assertPlayer(…)`). Erwartete Werte in Variablen (`want := 3`, `const expected = …`) ändern sich ausserhalb der Assertion und bleiben unsichtbar. Ohne Basisversion gibt es nur `assertionsAfter` und `disabled`, keine Änderungen.

**Im UI:** Einträge mit geänderten Erwartungen tragen in der Gliederung eine Markierung in Warnfarbe: «Erwartung geändert», «Assertion entfernt», «abgeschwächt», «deaktiviert» und «3 → 1 Assertions», wenn die Zahl sinkt. Neutral (ohne Warnung) erscheinen «wieder aktiviert», «+1 Assertion» und «deaktiviert» bei Tests, die schon in der Basis ausgeschaltet waren. Ein Klick auf die Markierung klappt die Details auf: alte Anweisung durchgestrichen in Löschfarbe, neue in Hinzufügefarbe, je mit Zeilennummer; ein Klick auf eine Zeile springt zu ihr im Testcode. Die Zusammenfassung oben und jeder Dateikopf ergänzen «⚠ n Erwartungen geändert · m deaktiviert» (gezählt werden Tests, nicht Suites; nur wenn > 0). Ausserhalb des Spec-Diffs: Die Kachel der Kategorie Tests in der Übersicht zeigt dieselbe Warnzeile, und der Code-Block eines solchen Tests trägt im Kopf «Erwartung geändert» bzw. «deaktiviert» (Tooltip: die einzelnen Änderungen).

### 5d. Test-Steckbrief

PRs bringen oft viele Tests. Bevor man ihren Code liest, soll jeder Test in einer Zeile fassbar sein – und alle zusammen als Tabelle. Dafür bekommt jeder geänderte Testfall einen **Steckbrief** (`tests[].profile`, Code in `analysis/TestProfiles`, Muster im Regel-Abschnitt `testProfile`). Musterbasiert und deterministisch, ohne KI.

Der Steckbrief schaut auf drei Teile des Tests:

* **Kopf:** Annotations- und Kommentarzeilen über der Deklaration (auch mehrzeilige wie `@CsvSource({ … })`).
* **Rumpf:** ab dem ersten `{` bzw. `=>` der Deklaration (bei `it.each` nach der Tabelle) bis zum Ende.
* **Umgebung:** die ganze Datei ohne andere Testfälle und ohne Suites/Klassen, die den Test nicht umschliessen – also Imports, Code auf oberster Ebene, Felder, Annotationen und Setup-Blöcke (`beforeEach`, `@BeforeEach`) der umschliessenden Klassen und `describe`-Blöcke sowie der Test selbst.

Alle drei werden ohne Kommentare, aber **mit** String-Inhalten durchsucht (`getByRole('alert')`, `vi.mock('../x')`).

| Feld | Bedeutung |
|---|---|
| `targets` | Was der Test prüft: die Namen der geänderten Funktionen, die er direkt aufruft (Abschnitt 5, `covers` mit `direct`), in Aufrufreihenfolge; ohne solche die Komponente aus dem Dateinamen (`PlayerResourceTest` → `PlayerResource`). |
| `scenario`, `scenarioBy`, `scenarioReason` | `error`, `edge` oder `normal`, wo es erkannt wurde (`code`, `name`) und der gefundene Text. Der erste Treffer entscheidet, in dieser Reihenfolge: `errorCode` im Kopf und Rumpf, `errorName` im Namen → Fehlerfall; `edgeName` im Namen, `edgeCode` in den **Eingaben des geprüften Codes** → Grenzfall; sonst Normalfall. |
| `assertions`, `assertionKinds` | Anzahl Assertion-Anweisungen im Rumpf (wie in 5c) und ihre Anzahl pro Art. Jede Anweisung bekommt die erste Art, deren Muster passt, in der Reihenfolge `exception`, `http`, `snapshot`, `interaction`, `existence`, `equality`; `existence` umfasst zusätzlich alle `weakAssertions`; sonst `other`. |
| `mocks` | Ersetzte Abhängigkeiten in der Umgebung, in Reihenfolge des Vorkommens, ohne Doppelte. Die Komponente aus dem Dateinamen fehlt (das ist der Prüfling, z. B. `@InjectMocks`). |
| `level`, `levelBy`, `levelReason` | `unit`, `integration` oder `e2e`, ob über den Pfad (`path`, Glob) oder den Code der Umgebung (`code`) erkannt, und der Treffer. |
| `parameterized`, `cases`, `casesSource` | Läuft der Test einmal pro Tabellenzeile, wie viele Zeilen (`null`, wenn nicht statisch bestimmbar) und woher (`@CsvSource`, `it.each`, `table` …). |

**Fehlerfall** (der Test erwartet ein Scheitern): im Code `assertThrows`, `assertThatThrownBy`, `.toThrow(` (nicht `.not.toThrow`), `.rejects`, `expectError`, `@Test(expected = …)`, `fail(…)` vor einem `catch`, Assertions in einem `catch`, testify `assert.Error`/`require.Error`, Go `err == nil {`, ein Stub, der wirft (`thenThrow`, `doThrow`, `mockRejectedValue`, `throwError(`), HTTP-Status ≥ 400 (`.statusCode(404)`, `status().isBadRequest()`, `{ status: 409 }` in `flush`, `toBe(404)`, `HttpStatus.NOT_FOUND`, `http.StatusNotFound`) sowie Prüfungen von `error`/`errors`/`errorMessage`/`alert` – ausser auf Abwesenheit (`toBeNull`, `toEqual([])`, `isEmpty` …). Im Namen Wörter wie *rejects, fails, throws, invalid, illegal, error, exception, denied, forbidden, unauthorized, not found, conflict*, ein Statuscode 4xx/5xx, *ungültig, Fehler, abgelehnt, verweigert, verboten, nicht gefunden*; davor stehendes *not, no, never, without, kein, ohne, nicht* hebt das Wort auf («does not throw» ist kein Fehlerfall).

**Grenzfall:** im Namen *empty, blank, null, nil, undefined, zero, boundary, limit, max(imum), min(imum), edge, overflow, negative, leer, Grenze, Grenzwert, maximal, minimal* (nicht nach *not/non/nicht*). Im Code zählen nur die **Eingaben des geprüften Codes**:

* die Argumentlisten `(…)` der Aufrufe der `targets` im Rumpf (`resource.update(id, null)`, auch in einer Assertion: `expect(valid(null))`) – verschachtelte Aufrufe mit mehreren Argumenten zählen nicht: `update(id, new Request(null, 7))` ist kein Grenzfall, ein `null` unter mehreren Feldern ist meist ein unbeteiligtes Feld (Teil-Update); `save(new Player(""))` mit einem einzigen Argument und leere Aufrufe wie `List.of()` zählen weiterhin,
* die Argumentlisten von HTTP-Anfragen (Regel-Liste `inputCalls`: `given().body(…)` vor `.then()`, `.content(…)`, `.queryParam(…)`, `http.put(…)`, `given().when().put(…)`, `request(app).post(…)`, `fetch(…)`, Go `httptest.NewRequest(…)`),
* die Parameterquellen: `@NullSource`, `@EmptySource`, `@NullAndEmptySource`, `@ValueSource`/`@CsvSource` (`""`, `''` als Wert), die Tabelle von `it.each` und die Tabelle eines Go-Tabellentests.

Darin sucht `edgeCode`, was eindeutig ist: `null`/`nil`/`undefined`, ein leerer String (`""`, `''`), `[]` oder `{}` als Argument, leere Sammlungen als Argument (`List.of()`, `emptyList()`, `new ArrayList<>()`, Go `[]T{}`), `Optional.empty()`, die drei Null-/Leer-Quellen und Grenzkonstanten (`Integer.MAX_VALUE`, `Number.MAX_SAFE_INTEGER`, `math.MaxInt64` …). Literale anderswo – Testdaten, Builder, Setup, erwartete Werte (`assertNull`, `.body("x", nullValue())`) – zählen **nicht**: `playerWithNumber("Carmela", null)` als Vorbereitung macht `savesJerseyNumber` nicht zum Grenzfall. Ruft ein Test kein Ziel auf und hat keine Parameterquelle, kommt ein Grenzfall nur aus dem Namen. Zahlen an typischen Grenzen (0, 99, 100) werden **nicht** ausgewertet – ob eine Zahl eine Grenze ist, steht im geprüften Code, nicht im Test.

**Namen** werden vor dem Vergleich in kleingeschriebene Wörter zerlegt: camelCase, snake_case, Ziffern und Satzzeichen trennen (`rejectsInvalidNumber` → «rejects invalid number», `returns404` → «returns 404», `TestCreate_Empty` → «test create empty»). Gesucht wird im Testnamen und in den Namen der umschliessenden `describe`-Blöcke (nicht im Klassennamen).

**Mocks:** Mockito und Quarkus (`@Mock`, `@MockBean`, `@MockitoBean`, `@InjectMock`, `@Spy`, `mock(X.class)`, MockK `mockk<X>()`), Stubbing-Empfänger (`when(repo.find(…))`, `given(…)`, `verify(repo)`, `every { repo.… }`, `doReturn(…).when(repo)`), Jasmine/Jest/Vitest (`jasmine.createSpyObj('X', …)`, `spyOn(obj, 'm')`, `vi.mock('…/x')`, `jest.mock(…)`, `const onSave = vi.fn()`), Angular `{ provide: X, useValue|useClass|useFactory … }` und ng-mocks `MockProvider(X)`, Go-Fakes (`&fakeStore{…}`, gomock `NewMockStore(…)`, mockery `mocks.NewStore(…)`). Ein gemocktes Backend (`HttpTestingController`, `provideHttpClientTesting()`, `MockWebServer`, WireMock, `MockRestServiceServer`, nock, msw, `httptest.NewServer`) heisst **HTTP**. Variablen werden über ihre Deklaration in der Umgebung aufgelöst (`repo: PlayerRepository`, `PlayerRepository repo`, `api = TestBed.inject(PlayerApi)`, `new X(…)`), sonst gilt der Name mit grossem Anfangsbuchstaben. Vor- und Nachsilben wie `mock`, `fake`, `stub`, `Spy`, `Mock` fallen weg (`playerApiSpy` → `PlayerApi`). `spyOn(component, …)` und `spyOn(fixture, …)` zählen nicht – das ist der Prüfling selbst.

**Ebene:** Die erste passende Regel gewinnt. **E2E** über den Pfad (`e2e/`, `cypress/`, `playwright/`, `*.e2e-spec.*`, `*.e2e.*`, `*.cy.*`) oder den Code (`cy.visit(`, `@playwright/test`, `page.goto(`, `WebDriver`). **Integration** über den Pfad (`*IT.java`, `*IntegrationTest.*`, `integration/`) oder den Code: `@QuarkusTest`, `@SpringBootTest`, `@DataJpaTest`, `@WebMvcTest`, `@WebFluxTest`, `@Testcontainers`, `@Container`, Testcontainers-Klassen, RestAssured (`given().`), `MockMvc`, `WebTestClient`, `TestRestTemplate`, supertest; ausserdem ein echter `provideHttpClient()` **ohne** `provideHttpClientTesting()`/`HttpTestingController` (Regel mit `unless`). Sonst **Unit** – auch Angular-Komponententests mit `TestBed` und gemocktem Backend.

**Parametrisierte Fälle** sind Syntax, keine Heuristik, und stehen deshalb nicht in den Regeln:

* **JUnit** `@ParameterizedTest`: `@ValueSource` zählt die Elemente (`ints = {1, 50, 99}` → 3), `@CsvSource` die Zeilen (auch als Text-Block, ohne Leer- und `#`-Zeilen), `@EnumSource(names = {…})` die Namen, `@NullSource`/`@EmptySource` je 1, `@NullAndEmptySource` 2; mehrere Quellen werden addiert. `@MethodSource`, `@ArgumentsSource`, `@CsvFileSource`, `@FieldSource` und `@EnumSource` ohne `names` (oder mit `mode`) → Anzahl unbekannt (`cases: null`, `parameterized: true`).
* **JS/TS** `it.each`/`test.each`: Elemente eines Array-Literals, bei einer Template-Tabelle die Zeilen ohne Kopfzeile; eine Variable (`it.each(cases)`) → unbekannt. `describe.each` zählt nicht. Mehrzeilige Tabellen werden jetzt auch als Testfall erkannt (der Name steht nach der Tabelle).
* **Go-Tabellentests:** eine Schleife `for _, tt := range tests {` über ein im Test deklariertes Slice- oder Map-Literal (`tests := []struct{…}{ {…}, {…} }`, `map[string]struct{…}{…}`, `[]testCase{…}`) → Anzahl Einträge. Eine Schleife über etwas anderes macht den Test nicht parametrisiert.

**Grenzen:** Alles statisch und pro Test. Eine `null`-Eingabe, die erst über eine Variable an das Ziel geht (`const x = null; valid(x)`), wird nicht gesehen; ebenso Aufrufe des Ziels in Hilfsfunktionen. In Tabellentests entscheiden Werte irgendeiner Zeile über den ganzen Test (eine Tabelle mit Normal- und Fehlerzeilen ist ein Fehlerfall, sobald der Rumpf einen Fehler prüft, z. B. `err == nil {`). Assertions in Hilfsfunktionen zählen nicht (wie in 5c), AssertJ-BDD `then(x)` ist keine Assertion. Mocks, die in Hilfsfunktionen anderer Dateien entstehen, und `@DisplayName` werden nicht gesehen.

**Im UI:** In der Testübersicht steht unter jedem Testnamen eine Zeile wie «Fehlerfall · Integration · 3 Assertions (Gleichheit, HTTP) · Mocks: PlayerRepository, HTTP · 4 Fälle»; jeder Teil erklärt im Tooltip, woran er erkannt wurde. Der Fall ist farbig markiert (Fehlerfall in Löschfarbe, Grenzfall in Akzentfarbe, Normalfall gedämpft), «keine Assertion» in Warnfarbe. Standardmässig zeigt die Testübersicht alle Tests als Tabelle (Umschalter «Liste | Tabelle» im Kopf, die Wahl wird pro Browser gemerkt) mit den Spalten Test, Prüft, Fall, Ebene, Assertions, Mocks, Fälle; ein Klick auf einen Spaltenkopf sortiert (nochmals: absteigend), ein Klick auf eine Zeile springt zum Test. Darüber eine Zusammenfassung wie «14 Tests · 9 Normalfall, 4 Fehlerfall, 1 Grenzfall · 11 Unit, 3 Integration · 2 parametrisiert (9 Fälle)»; ein Klick auf einen Teil filtert die Tabelle (nochmals: Filter aufheben).

### 5e. Fallmatrix

PRs bringen oft viele fast gleiche Tests: kopiert, ein Wert geändert. Einzeln gelesen sieht man nicht, was sie zusammen abdecken und welcher Fall doppelt vorkommt. Die **Fallmatrix** (`caseMatrices`, Code in `analysis/CaseMatrices`, Muster im Regel-Abschnitt `caseMatrix`) macht daraus eine Tabelle Eingabe → Erwartung. Token-basiert und deterministisch, ohne KI.

**Umfang:** alle Testfälle der geänderten Testdateien – auch unveränderte, damit ein neuer Test auffällt, der einen bestehenden wiederholt (wie beim Spec-Diff). Eine Matrix braucht mindestens eine Zeile mit geänderten Zeilen. Für das ganze Repository (`number` 0) gibt es keine Fallmatrix.

1. **Token:** Der Testrumpf (wie im Steckbrief, 5d) wird in Namen, Satzzeichen und **Literale** zerlegt: Zahlen (mit vorangestelltem Minus, wenn davor kein Wert steht: `f(-3)`), Strings und Zeichen (`'…'`, `"…"`, Text-Blöcke, Template-Strings ohne `${…}`), `true`/`false`, `null`/`nil`/`undefined`/`None`.
2. **Eingaben und Erwartungen:** Jede Assertion-Anweisung (wie in 5c) wird zerlegt in das, was sie anschaut (gehört zu den Eingaben), und das, was sie erwartet:
   * **Verkettete Matcher** (`.statusCode(200)`, `.body("jerseyNumber", equalTo(7))`, `.expectNone(url)`): der Text davor ist Eingabe (`putJerseyNumber(7).then()`); jeder angehängte Aufruf, der selbst eine Assertion ist, ist eine Erwartung mit dem letzten Argument als Wert. Aufrufe ohne Argumente werden übersprungen; der erste andere Aufruf mit Argumenten beendet die Erwartungen (`expectOne(url).flush(…)`: das `flush` ist wieder Eingabe).
   * **`expect(x)`, `assertThat(x)`, `verify(m)` mit Matcher-Kette:** der Aufruf ist Eingabe, die Kette (`.not.toBe(3)`) die Erwartung, Wert = Argumente des letzten Aufrufs (ohne Argumente: «✓»).
   * **Gleichheit** (`assertEquals`, testify `Equal` …, Hamcrest `assertThat(actual, matcher)`): das tatsächliche Argument ist Eingabe, das erwartete der Wert.
   * **Sonst** (`assertTrue(x)`, `assertNull(x)`, `assertThrows(E.class, () -> …)`): die Argumente sind Eingaben (ein einzelnes String-Literal neben anderen Argumenten ist eine Meldung), der Name der Assertion ist der Wert. Infix (Kotest `x shouldBe 3`): links Eingabe, rechts der Wert.
3. **Ähnliche Tests:** Tests derselben Suite (gleiche Klasse bzw. gleiche `describe`-Kette, also gleiches Setup), deren Eingabe-Token **identisch** sind, sobald alle Literale maskiert sind (das «Eingabe-Skelett»), bilden eine Gruppe (≥ 2 Tests). Die Assertions dürfen sich unterscheiden. Mehr Toleranz gibt es bewusst nicht: ein zusätzlicher Aufruf, ein anderer Name oder ein anderes Argument (`render()` gegen `render('p-1', true, …)`) trennt. Parametrisierte Tests und Tests ohne Aufruf ausserhalb der Assertions werden so nicht gruppiert.
   * **Eingabespalten** = Literal-Positionen, deren Wert sich in mindestens zwei Tests unterscheidet. Literale, die überall gleich sind, gehören zur Vorlage, nicht in eine Spalte.
   * **Erwartungsspalten** = Erwartungen, ausgerichtet über einen Schlüssel: die Eingabeseite der Assertion mit maskierten Literalen plus Matcher (`putJerseyNumber(‹›).then().statusCode(`, `expect(form.error).toBe`); die n-te Wiederholung desselben Schlüssels in einem Test ist ein eigener Schlüssel. Eine Erwartung, die jeder Test mit demselben Wert hat, ist keine Spalte; fehlt sie in einem Test, steht dort `null` («–»).
4. **Parametrisierte Tests:** eine Matrix pro Test mit mindestens zwei literalen Zeilen: `@ValueSource`, `@EnumSource(names = …)`, `@NullSource`/`@EmptySource`/`@NullAndEmptySource`, `@CsvSource` (auch Text-Block, `delimiter`, Kopfzeile bei `useHeadersInDisplayName`; leere Zelle = `null`) mit den Methodenparametern als Spaltennamen; `it.each`/`test.each` mit Array von Arrays (Namen aus den Parametern des Callbacks), Array von Objekten (Schlüssel) oder Template-Tabelle (Kopfzeile, `${x}` → `x`); Go-Tabellentests (Felder des Structs, auch eines benannten Typs `[]testCase{…}`; Einträge positionell oder mit `feld: wert`; bei Map-Tabellen der Schlüssel als Name). `@MethodSource` & Co. und `it.each(variable)` haben keine literalen Zeilen und keine Matrix.
   * **Rolle einer Spalte:** «Erwartung», wenn ihr Name auf ein `caseMatrix.expectedNames`-Muster passt (`expected…`, `want…`, `result`, `status`, `message`, `error`, `valid` …) oder nur in Erwartungen des Rumpfs vorkommt (`toContain(message)`, das erwartete Argument von `assertEquals`); sonst «Eingabe». Gezählt werden Vorkommen des Namens (nicht nach `.`, nicht als Objektschlüssel) bzw. `tt.feld`, wenn die Zeile über eine Variable kommt (Go `for _, tt := range tests`, `it.each([...])('…', (row) => …)`).
   * Ein Go-Feld, das auf `caseMatrix.nameFields` passt (`name`, `desc`, `scenario` …), benennt die Zeile statt eine Spalte zu sein. Sonst heisst die Zeile wie der Fall beim Testlauf: JUnit `name = "{0} + {1} = {2}"` bzw. «[n] Werte», `it.each` mit `%s`/`%i`/`%#`/`$name` ersetzt.
5. **Spaltennamen:** Eingaben nach dem nächsten Zusammenhang: `name =` / `name :=`, `schlüssel:`, sonst der umschliessende Aufruf mit Position (`putJerseyNumber(…) Arg 1`, `PlayerUpdateRequest(…) Arg 2`), sonst «Wert n»; Erwartungen nach dem Geprüften: der Matcher (`statusCode`), der Pfad von `.body("jerseyNumber", …)`, der Aufruf (`expect(el.textContent)`) bzw. das tatsächliche Argument, gekürzt auf 40 Zeichen; gleiche Namen bekommen « (2)».
6. **Befunde:** Eine Zeile, deren Eingabewerte denen einer früheren Zeile gleichen, ist ein **Duplikat** (`duplicateOf`: derselbe Fall zweimal getestet) – **widersprüchlich** (`contradicts`), wenn beide in einer Spalte, die beide prüfen, Verschiedenes erwarten. Pro Eingabespalte die verschiedenen Werte, sortiert (Zahlen numerisch): was abgedeckt ist. Fehlende Grenzwerte liest der Fall- und Effekt-Abgleich aus dem geprüften Code (5h, `boundaries`).

| Feld | Bedeutung |
|---|---|
| `id`, `path`, `title` | `m1`, `m2` … in Reihenfolge Pfad, Zeile; die Testdatei; gemeinsame Suite › gemeinsamer Aufruf (`JerseyNumberApiTest › putJerseyNumber(…)`) bzw. gemeinsame Anfangswörter der Namen, bei parametrisierten Tests der Testname. |
| `kind` | `similar` (ähnliche Tests) oder `parameterized`. |
| `template` | Der Code des ersten Tests (ohne die Klammern des Rumpfs, ausgerückt, höchstens 40 Zeilen) mit den Spalten als `‹1›`, `‹2›` … (`‹n›` = Spalte n): `putJerseyNumber(‹1›).then().statusCode(‹2›).body("jerseyNumber", ‹3›);`. Bei Go-Tabellen ab der Zeile nach der Tabelle. |
| `columns[]` | `label`, `role` (`input`/`expected`), `values` (bei Eingaben die abgedeckten Werte, sonst leer). Eingaben zuerst, dann Erwartungen. |
| `rows[]` | `name`, `segmentId` (`null` bei unveränderten Tests), `line` (Start des Tests bzw. der Tabellenzeile), `values` (eine pro Spalte, wie im Code geschrieben; `null` = nicht geprüft), `duplicateOf` (Index), `contradicts`. |
| `boundaries[]` | Grenzen im Code, den die Tests der Zeilen erreichen, mit den Grenzwerten, die in der Matrix fehlen (5h). |

**Grenzen:** Werte, die in Hilfsfunktionen oder in anderswo deklarierten Variablen stecken, sind unsichtbar; zwei Tests, die sich nur dort unterscheiden, gelten als Duplikat. Erwartungen in der Form `if (got != 3) t.Errorf(…)` zählen die 3 als Eingabe (das `if` ist keine Assertion). Schon ein zusätzlicher Aufruf trennt Tests, die man als ähnlich empfinden würde.

**Im UI:** «Fallmatrix (ähnliche Tests)» steht in der Kategorie Tests zwischen «Spezifikation» und «Abdeckung»: eine Zusammenfassung («3 Matrizen · 14 Fälle · 1 doppelt», Duplikate und Widersprüche in Warnfarbe) und pro Matrix Titel, Art und Datei, eine aufklappbare «Vorlage» (Monospace, Eingabe-Slots in Akzentfarbe, Erwartungs-Slots grün), die Tabelle mit den Eingabespalten, einem Trennstrich und den Erwartungsspalten sowie unter jeder Eingabespalte die abgedeckten Werte («geprüft: 0, 7, 23, 150»). Duplikate sind in Warnfarbe hinterlegt mit «gleicher Fall wie <Name>» bzw. «gleiche Eingabe, andere Erwartung als <Name>». Ein Klick auf eine Zeile springt zum Test; ein unveränderter Test öffnet die Dateiansicht (beim Block, der seine Zeile umschliesst, falls es einen gibt).

### 5f. Bestehende Tests

Verknüpft werden zunächst nur Tests, die der PR ändert. Code, den ein **bestehender, unveränderter** Test abdeckt, stünde sonst unter «Ohne Test» – eine falsche Lücke; und man sähe nicht, welche alten Tests durch den geänderten Code laufen (und vielleicht angepasst werden müssten). Deshalb werden zu jedem PR die wahrscheinlichsten bestehenden Testdateien nachgeladen und genauso verknüpft (Stufe A: nur nach Namen, ohne Index über das ganze Repository; Code in `analysis/RelatedTests`, Regel-Abschnitt `relatedTests`).

**Auswahl** – rein über Dateinamen, aus der Dateiliste des Repositorys am PR-Stand (`structure.json` → `files`; GitHub `git/trees?recursive=1`, GitLab `repository/tree`, beides wird für die Ordner ohnehin geholt). Für jede geänderte Quelldatei (nicht gelöscht, Sprache mit Symbolen, kein Test, keine Pfad-Regel ohne Symbole wie Generiertes):

1. **`mirror`:** eine Testdatei, die nach ihr benannt ist – dieselben Endungen wie bei der Namenskonvention in Abschnitt 5 (`X.spec.ts`, `X.test.ts`, `XTest.java`, `XTests.java`, `XIT.java`, `x_test.go` …) –, im selben Ordner oder im **gespiegelten Testordner**. Gespiegelt wird über `relatedTests.mirrors`: Das erste Vorkommen von `from` (ganze Pfadsegmente) im Ordner wird durch `to` ersetzt, Standard `src/main/` → `src/test/`, `main/` → `test/`, `src/` → `test/`, `src/` → `tests/`, `lib/` → `test/`. So wird aus `backend/src/main/java/a/b/PlayerResource.java` der Ordner `backend/src/test/java/a/b/`; bei TypeScript und Go liegt der Test meist daneben.
2. **`name`:** nur wenn es keine solche Datei gibt, eine Testdatei gleichen Namens anderswo – die nächstgelegene (längster gemeinsamer Ordnerpfad, bei Gleichstand alle). So zieht ein allgemeiner Name wie `index.spec.ts` nicht das halbe Repository nach.
3. **`prefix`:** Testdateien in diesen Ordnern, deren Name mit dem der geänderten Datei beginnt und mit einem neuen CamelCase-Wort oder einem Punkt weitergeht (`PlayerResourceSecurityTest` zu `PlayerResource`, `player-list.component.spec.ts` zu `player-list.ts`; nicht `player-list.spec.ts` zu `player.ts`).

Es zählen nur Testdateien nach der Pfadregel der Kategorie Tests, in einer Sprache mit Symbolen und derselben Sprachfamilie (TS/JS, Java/Kotlin), die **nicht** Teil des PRs sind. Reihenfolge: alle `mirror`, dann `name`, dann `prefix`, jeweils nach Pfad der geänderten Datei und der Testdatei. Höchstens `relatedTests.limit` Dateien (Standard 30) pro PR; schneidet das Limit ab, steht `truncated: true` (mit `candidates`), und das UI warnt. Beim ganzen Repository (Nummer 0) entfällt das – dort sind alle Dateien schon Teil der Analyse.

**Laden:** Die ausgewählten Dateien werden am Head-Commit über den Provider geholt (`sources-related/<pfad>`) – bei der ersten Analyse nach dem Laden des PRs, bei älteren Snapshots einmal bei der nächsten Analyse. Fehler werden geloggt und übersprungen (`loaded: false`, bei der nächsten Analyse neuer Versuch). Die Auswahl steht in `related.json` und in `analysis.json` → `relatedTests` (`limit`, `candidates`, `truncated`, `listIncomplete` = Dateiliste vom Host gekürzt, `files[]` mit `path`, `reason`, `sources`, `loaded`).

**Verknüpfen:** Die Testfälle der geladenen Dateien werden wie geänderte Tests mit dem geänderten Code verbunden (Abschnitt 5): Namensbezug plus Import-Nachweis, gleicher Aufruf-Graph, höchstens 4 Ebenen, keine HTTP-Kanten. Hilfsfunktionen der Testdatei (auch unveränderte) sind durchlässig. Die Tests sind **keine Segmente**: Es gibt nichts zu prüfen oder zu markieren, und sie stehen nicht im Diff. In `analysis.json` stehen unter `existingTests[]` nur Testfälle, die geänderten Code erreichen, nach Pfad und Zeile: `id` (`e1` …), `path`, `name`, `line`, `reason` (der Datei), `covers` (wie bei geänderten Tests) und `profile` (Test-Steckbrief, 5d).

Beispiel spongecoach#13: `current-user.service.ts` ändert `CurrentUserService.canEditPlayer`; die unveränderte `current-user.service.spec.ts` daneben (`mirror`) ruft `service.canEditPlayer(…)` auf → `canEditPlayer` steht unter «Nur durch bestehende Tests», das neue private `isSelf` (über `canEditPlayer`) ebenso. `player-list.spec.ts` wird ebenfalls geladen, rendert die Komponente aber nur – `PlayerList.label` bleibt «ohne Test».

**Grenzen:** Nur Namenskonventionen – ein Test mit ganz anderem Namen (`PlayerFlowTest` für `PlayerResource`) wird nicht gefunden (Stufe B, ein Index über alle Tests, ist später geplant). Tests, die den Code nur über HTTP (RestAssured, `HttpTestingController`) oder das Rendern einer Komponente erreichen, verknüpfen sich wie geänderte Tests nicht: Die Datei wird geladen, die Funktion bleibt «ohne Test».

**Im UI:** In der Abdeckung gibt es die Gruppe «Nur durch bestehende Tests» (zwischen «Nur indirekt getestet» und «Direkt getestet»). Bestehende Tests erscheinen pro Funktion als eigene Chips – gestrichelt und neutral, mit Name und `datei:zeile`; der Tooltip nennt den Pfad, ob direkt oder indirekt, und warum die Datei geladen wurde. Sie stehen auch bei direkt oder indirekt getesteten Funktionen. Da die Datei nicht im Diff ist, öffnet ein Klick nichts. Unter dem Titel steht die Grundlage, bei abgeschnittener Auswahl oder gekürzter Dateiliste mit Warnung. Code-Blöcke tragen das Abzeichen «durch bestehende Tests», die Kachel auf der Übersicht zählt «nur durch bestehende Tests».

### 5g. Mock-Grenzen

Ein Flow (`saveJerseyNumber → setJerseyNumber ⇢ PUT /api/players/{} ⇢ update → validateJerseyNumber → isInRange`) zeigt, wie der geänderte Code zusammenhängt – aber nicht, welche Teile die Tests **wirklich ausführen**. Ein Test, der eine Abhängigkeit mockt, endet dort; ein Frontend-Test mit `HttpTestingController` erreicht das Backend nie. Heikler: Ein Test, der eine Funktion mockt, die der PR ändert, hält das **alte** Verhalten dieser Funktion fest. Code in `analysis/MockBoundaries` (plus `Analyzer.reach`), Muster im Regel-Abschnitt `testProfile.mockMembers`. Namensbasiert und deterministisch, ohne KI.

**Gemockt** ist eine geänderte Funktion in einem Test, wenn einer ihrer **Besitzernamen** in den `mocks` des Tests steht (Steckbrief, 5d – also auch `@InjectMock`, `{ provide: X, useValue }`, `createSpyObj('X', …)`, `vi.mock('./x')`): die Klasse bzw. das Objekt, in dem sie deklariert ist (bei verschachtelten Klassen auch der letzte Teil), bei Klassen und Komponenten ihr eigener Name, und der Dateiname ohne Endung. Verglichen wird ohne Gross-/Kleinschreibung und Satzzeichen – `PlayerApiService` = `player-api.service`. **HTTP** (ein gemocktes Backend) passt auf keine Funktion: HTTP-Kanten verfolgen Tests ohnehin nicht. Die Suche ab dem Test (Abschnitt 5) hält an einer gemockten Funktion an: Sie steht mit `mocked: true` in `covers` (direkt oder indirekt wie sonst), ihre Aufgerufenen werden in diesem Test nicht erreicht. Gemockte Funktionen sind keine `targets` und keine Komponenten des Tests und fehlen in `testedBy`.

**Abdeckung (5a):** Gemockte Erreichungen zählen nicht; sie stehen in `coverage[].mockedTests`. Eine Funktion, die nur gemockt erreicht wird, ist «ohne Test».

**Warnungen** (`mockWarnings[]`): Ein Test mockt **geänderten Code**, wenn eine gemockte Abhängigkeit eine geänderte aufrufbare Funktion hat (keine Testhilfe, kein Framework-Hook wie `ngOnInit`) **und** der Test diese Funktion beim Namen nennt – gesucht in der Umgebung des Tests (5d, also auch `beforeEach`, Felder und Code der Suite) mit den Vorlagen aus `mockMembers`, in denen `{member}` für den Namen steht: Objekt-Stubs `setJerseyNumber: jest.fn(…)` / `api.m = vi.fn()`, `createSpyObj('X', ['m'])`, `spyOn(obj, 'm')`, Mockito `when(repo.m(…))`, `doThrow(…).when(repo).m(…)`, `verify(repo).m(…)`, MockK `every { repo.m(…) }`, `vi.mocked(m)`, gomock `.EXPECT().M(…)` und zuletzt jeder Memberzugriff `.m` (`expect(api.setJerseyNumber)`). Die erste Vorlage mit Treffer bestimmt die Zeile. Eine gemockte Abhängigkeit, deren geänderte Funktionen der Test nicht nennt, gibt keine Warnung (die Erreichung ist trotzdem `mocked`). Bestehende Tests (5f) werden genauso geprüft.

| Feld (`MockWarning`) | Bedeutung |
|---|---|
| `test`, `testName`, `path` | Der Test: Segment-Id eines geänderten Tests bzw. Id eines bestehenden (`e1`), sein Name und seine Datei. |
| `line` | Zeile, an der der Test (oder sein Setup) die Funktion stubbt oder nennt. |
| `segmentId`, `member` | Die gemockte geänderte Funktion und ihr Name. |
| `collaborator` | Die gemockte Abhängigkeit, wie in `mocks`. |

**Pro Flow** (`flowCoverage[]`, gleiche Reihenfolge wie `flows`) steht für jeden Schritt und jede Verbindung, was die Tests ausführen – über alle geänderten und bestehenden Tests:

| Feld | Bedeutung |
|---|---|
| `steps[].status` | `tested`: ein Test erreicht den Schritt echt (direkt oder indirekt). `mocked`: Tests erreichen nur einen Mock davon. `none`: kein Test. `tests` / `mockedBy`: die Ids (geänderte Tests: Segment-Id, bestehende: `e1` …). |
| `edges[].status` | `tested`: ein Test erreicht beide Enden echt über diesen Aufruf, durchläuft ihn also (`tests`). `separate`: beide Enden sind echt getestet, aber kein einzelner Test läuft hindurch – typisch für den REST-Sprung zwischen Frontend und Backend (HTTP-Kanten werden nie durchlaufen). `partial`: nur ein Ende ist echt getestet. `none`: keines. |

Beispiel spongecoach#13: Der neue Test «jersey number with a stubbed API › hands the typed number to the API and shows the saved one» stellt `PlayerApiService` als `useValue` mit `jest.fn`-Membern bereit, darunter `setJerseyNumber`, und prüft `toHaveBeenCalledWith('p-1', 11)` → Warnung für `PlayerApiService.setJerseyNumber` (Zeile des `jest.fn`). In diesem Test ist `setJerseyNumber` gemockt; die Tests mit `HttpTestingController` erreichen es echt → Schritt `tested`. Der REST-Sprung `setJerseyNumber ⇢ update` ist `separate`: Frontend-Tests erreichen `setJerseyNumber`, Backend-Tests `update`, keiner beide. `JerseyNumberValidationTest` mockt `Access` (unverändert) → keine Warnung.

**Grenzen:** Gemockt wird pro Abhängigkeit, nicht pro Methode: `spyOn(obj, 'm')` gilt für die ganze Klasse von `obj`, und Spione, die den echten Code aufrufen (Jest `spyOn` ohne Implementierung, Mockito `@Spy`), zählen trotzdem als Mock – statisch ist nicht sichtbar, ob durchgerufen wird. Der Memberzugriff `.m` kann auch eine gleichnamige Methode eines anderen Objekts treffen. Mocks in Hilfsfunktionen anderer Dateien sieht der Steckbrief nicht, also auch hier nicht.

**Im UI:** In der Flow-Ansicht ist jeder Knoten nach Status eingefärbt (echt getestet in Ok-Farbe, nur gemockt in Warnfarbe, nicht erreicht gestrichelt in Löschfarbe; Tokens `--run-*`), mit einer Legende «echt getestet · nur gemockt · nicht erreicht» über dem Diagramm; der Tooltip nennt die Tests und «gemockt in …». Verbindungen: durchlaufen durchgezogen, `separate` fein gestrichelt mit der Beschriftung «einzeln» (Tooltip «nur einzeln getestet»), `partial`/`none` blass. Ein Schritt mit Mock-Warnung trägt ein Warnzeichen. In der Kategorie Tests steht unter der Abdeckung «Mocks auf geändertem Code»: pro Warnung Test → `Abhängigkeit.funktion` und `datei:zeile`; ein Klick springt zur Stub-Zeile (im Block, der sie zeigt, z. B. dem Setup der Suite), ein Klick auf die Funktion zu ihr. Der Code-Block des Tests trägt im Kopf «mockt geänderten Code». In der Abdeckung erscheinen gemockte Erreichungen als gestrichelte Chips «Mock», die nicht zählen; in den Verknüpfungen eines Tests («Testet:») ebenso.

### 5h. Fall- und Effekt-Abgleich

Die Abdeckung (5a) sagt, **ob** ein Test eine geänderte Funktion erreicht – nicht, ob die Tests ihre Fälle und Wirkungen prüfen. Der **Fall- und Effekt-Abgleich** stellt pro testbarer Funktion (`coverage[]`) deterministische Fakten aus dem Code dem gegenüber, was die Tests prüfen, die sie **wirklich** erreichen: geänderte und bestehende Tests (5f), direkt oder indirekt, ohne gemockte Erreichungen (5g). Ergebnis: `coverage[].findings` (Code in `analysis/CaseChecks`, Muster im Regel-Abschnitt `caseCheck`). Musterbasiert und deterministisch, ohne KI.

1. **Fehlerausgänge** (in der **ganzen** Funktion, Code ohne Strings und Kommentare): `throw new X(…)`, Kotlins `throw X(…)`, Pythons `raise X`, `throwError(…)`, `Promise.reject(…)`, Gos `errors.New(…)`/`fmt.Errorf(…)` – einer pro Typ (die erste Stelle). Den **HTTP-Status** liefert die Regel-Tabelle `statuses` (`NotFoundException` → 404, `BadRequestException` → 400, `ForbiddenException`/`AccessDeniedException` → 403, `NotAuthorizedException` → 401, `ConflictException` → 409 …); ein anderer Typ nimmt ihn aus seinen Argumenten (eine ganze Zahl 400–599 wie in `new WebApplicationException("…", 409)` oder eine Konstante wie `HttpStatus.NOT_FOUND`). **Geprüft**, wenn ein erreichender Test (Kopf und Rumpf) den Typ erwartet (`typedChecks`: `assertThrows(X.class, …)`, `isInstanceOf(X.class)`, `toThrow(X)`, `toBeInstanceOf(X)`, `@Test(expected = X.class)`, `shouldThrow<X>` …), irgendeinen Fehler erwartet (`anyChecks`: `toThrow()`, `.rejects`, `assert.Error`, Go `err == nil {` – zählt für jeden Typ) oder den Status prüft (`statusChecks`: `.statusCode(404)`, `status().isNotFound()`, `{ status: 404 }` in einem `flush`, `toBe(404)`, `assertEquals(404, …)`, `HttpStatus.NOT_FOUND`).
2. **Grenzen** (ganze Funktion): Vergleiche `<`, `<=`, `>`, `>=` eines Werts (Name oder Member-Kette, auch ein Getter `x.getN()`) mit einer **ganzen Zahl** oder einer **Konstante derselben Datei** (`private static final int MAX = 99;`, `const LIMIT = 10`; Grossbuchstaben-Namen oder mit `const`/`final`/`val`/`readonly`), in beiden Schreibweisen (`1 > n` = `n < 1`). Grenzwerte: `x < k` und `x >= k` → k−1 und k; `x > k` und `x <= k` → k und k+1. Nicht gezählt: Schleifenköpfe `for (…)`, Längen und Grössen (`.length`, `.size()`, `count`, `len`), Teile einer Rechnung (`a - 1 < b`, `x < MAX * 2`), Kommazahlen, Kotlin-Bereiche `in 1..99`. Pro verglichenem Wert ein Befund «Grenze 1…99» (eine untere und eine obere Grenze), sonst «Grenze ≥ 1, ≤ 99». **Geprüfte Werte** sind die ganzen Zahlen unter den **Eingaben** der erreichenden Tests: die vollständigen Argumentlisten ihrer Aufrufe des geprüften Codes und der HTTP-Anfragen (wie im Steckbrief 5d, aber verschachtelte Aufrufe nicht eingeklappt: `update(id, new Request(null, 7))` liefert die 7), die Parameterquellen (`@ValueSource`, `@CsvSource`, `it.each`, Go-Tabellen; Spalten mit Erwartungsnamen nach `caseMatrix.expectedNames` zählen nicht) und die Eingabespalten ihrer Fallmatrix-Zeilen (5e). Ein String, der nur eine ganze Zahl enthält (`'150'`), zählt als diese Zahl – Formulareingaben kommen als Text. Zahlen in Rechnungen (`n - 1`) zählen nicht. Geprüft ist die Grenze, wenn **jeder** Grenzwert darunter ist; `covered` nennt alle Eingabewerte, `missing` die fehlenden Grenzwerte.
3. **Verzweigungen gegen Tests:** Hat die Funktion mehr Entscheidungen (`branches`, 5a) als verschiedene erreichende Tests (mindestens einer), gibt es den Hinweis «5 Verzweigungen, 1 Test» (`kind` `branches`, nie geprüft, keine Warnung).
4. **Wirkungen** (nur **geänderte** Zeilen): `effects` – Zuweisung an ein Feld eines Objekts (`player.jerseyNumberChangedAt = …`, `this.x = …`, auch `+=`) und Setter (`setJerseyNumber(…)` → `jerseyNumber`) als `field`; Persistenz (`persist(`, `save(`, `delete(`, `merge(`, `insert(` …, `repository.remove/update…`, Panache `deleteById`) als `persist`; Nachrichten und Ereignisse (`publish(`, `emit(`, `send(`, `fire(`, `convertAndSend(`, `dispatch(`) als `message`; dazu ausgehende HTTP-Aufrufe mit literaler URL (wie bei den REST-Flüssen, 3b). **Geprüft**, wenn eine Assertion-Anweisung (5c) eines erreichenden Tests das Feld nennt (`fieldChecks`, ohne Gross-/Kleinschreibung: Memberzugriff oder Getter `.jerseyNumber`/`.getJerseyNumber()`, JSON-Pfad `.body("jerseyNumber", …)`, Objektschlüssel `toEqual({ jerseyNumber: 7 })` – eine gleichnamige Variable, also eine Eingabe, zählt nicht), den Aufruf verifiziert (`callChecks`: `verify(repo).save(…)`, MockK `verify { repo.save(…) }`, `expect(api.publish).toHaveBeenCalled…`), bei Persistenz die Daten wieder liest (`readBack`: `findById(`, `count(`, `exists…(`, `list…(`) oder den HTTP-Aufruf prüft (`httpChecks`: `expectOne(url)`, `requestTo(url)` mit dem letzten literalen URL-Segment). Eine Wirkung pro Art und Name (erste Zeile).

| Feld (`CaseFinding`) | Bedeutung |
|---|---|
| `kind` | `exception`, `boundary`, `effect` oder `branches`. |
| `line`, `code` | Zeile in der neuen Datei und ihr Text (bei `branches` `null`). |
| `label` | Kurztext: «wirft NotFoundException (404)», «Fehlerausgang throwError(…)», «Grenze 1…99», «setzt jerseyNumberChangedAt», «speichert: persist», «sendet: publish», «ruft PUT /api/players/{}», «5 Verzweigungen, 1 Test». |
| `subject` | Ausnahmetyp (bzw. der Aufruf ohne Typ), verglichener Wert, Feld oder Aufruf; `null` bei `branches`. |
| `checked`, `checkedBy` | Ein erreichender Test prüft es, und welche (Segment-Ids geänderter Tests, `e1` … bestehender). Bei Grenzen: die Tests, die mindestens einen Grenzwert eingeben. |
| `covered`, `missing` | Nur bei Grenzen: die ganzzahligen Eingaben aller erreichenden Tests (sortiert) und die Grenzwerte, die keiner eingibt. |

Die Befunde stehen nach Zeile, `branches` zuletzt. Auch Funktionen «ohne Test» bekommen Befunde – dann ist alles offen.

**Fallmatrix:** Erreichen die Tests einer Matrix mit Zahleneingaben (echt, direkt oder indirekt) eine Funktion mit Grenzen, steht das in `caseMatrices[].boundaries` (`MatrixBoundary`: `segmentId`, `subject`, `label`, `values` = alle Grenzwerte, `missing` = die Grenzwerte, die keine Zeile **dieser** Matrix eingibt).

Beispiel spongecoach#13: `PlayerResource.isInRange` (`jerseyNumber < 1`, `jerseyNumber <= JERSEY_NUMBER_MAX` mit `JERSEY_NUMBER_MAX = 99`) → «Grenze 1…99: geprüft 0, 7, 12, 14, 15, 16, 100, 150 – nicht geprüft: 1, 99» (die Werte kommen aus `update(…, new PlayerUpdateRequest(null, 7))`, `@ValueSource(ints = {0, 100, 150})` usw.; `JerseyNumberApiTest` erreicht `update` nur über HTTP und zählt nicht). `validateJerseyNumber`: `BadRequestException` (400) geprüft von `rejectsJerseyNumberAboveMax` und `rejectsNumbersOutsideTheRange`, `ConflictException` (409) von keinem. `PlayerResource.clearJerseyNumber`: «wirft NotFoundException (404)» – kein Test erwartet sie. `PlayerResource.update`: «setzt jerseyNumber» geprüft (`assertEquals(7, …findById(…).jerseyNumber)`), «setzt jerseyNumberChangedAt» ungeprüft. Die Fallmatrix von `rejectsNumbersOutsideTheRange` meldet «in dieser Matrix fehlen 1, 99».

**Grenzen:** Alles statisch. Eine Ausnahme, die ein Test über ihre Oberklasse erwartet (`assertThrows(WebApplicationException.class, …)` für eine `NotFoundException`), gilt als ungeprüft; ein Status-Treffer wie `assertEquals(404, …)` kann zufällig sein. Werte, die über Variablen, Hilfsfunktionen anderer Dateien oder HTTP (RestAssured, 5f) zum Code gelangen, sieht der Abgleich nicht – nur das, was die Verknüpfung (5) als Erreichung kennt. Ob ein Grenzwert den Vergleich in der Funktion wirklich trifft (der Test gibt 1 ein, aber an einen anderen Parameter), wird nicht geprüft: Gesucht wird unter allen Eingaben. Wirkungen, die ein Test nur über die Anzeige prüft (DOM-Text statt Feld), gelten als ungeprüft; Angular-Signale (`x.set(…)`) zählen nicht als Wirkung.

**Im UI:** In der Abdeckung steht unter jeder Funktion mit Befunden eine Zeile wie «⚠ NotFoundException ungeprüft · Grenze 1…99: 1, 99 fehlen · jerseyNumberChangedAt ungeprüft · 5 Verzweigungen, 2 Tests» (in Warnfarbe, wenn etwas offen ist, sonst «n Fälle geprüft» in Ok-Farbe); ein Klick klappt die ganze Liste auf: geprüfte Befunde mit ✓ und den Tests, offene mit Warnzeichen, der Verzweigungs-Hinweis neutral. Ein Klick auf einen Befund springt zu seiner Zeile im Code. Funktionen mit offenen Befunden tragen ein Warnzeichen neben dem Namen – auch unter «Direkt getestet» –, die Gruppenköpfe zählen sie, und der Kopf der Box fasst zusammen: «7 offene Fälle in 4 Funktionen» (der Verzweigungs-Hinweis zählt nicht). Im Code-Block steht auf der Zeile eines offenen Befunds ein Chip in Warnfarbe – «kein Test erwartet NotFoundException», «Grenze nicht geprüft: 1, 99», «Wirkung ungeprüft: jerseyNumberChangedAt» (Tooltip: der ganze Befund; Klick: Abdeckung zeigen). Unter einer Fallmatrix mit Grenzen steht «Grenze im Code (PlayerResource.isInRange): jerseyNumber 1…99 – Grenzwerte 0, 1, 99, 100 – in dieser Matrix fehlen 1, 99» (Klick: zum Code).

## 6. Anzeige

* Symbol-Segmente zeigen die **ganze Funktion** aus der neuen Datei, mit eingewobenen gelöschten Zeilen. Unveränderte Strecken über 2 Zeilen ausserhalb von ±2 Zeilen um Änderungen und Aufrufstellen werden zu «⋯ n unveränderte Zeilen».
* Zeilen anderer Segmente innerhalb des Bereichs (z. B. eine verschachtelte geänderte Funktion) werden **gedimmt** und ohne Häkchen gezeigt.
* Aufrufstellen tragen `refs` → im UI ein Chip, der zum aufgerufenen Block springt; in der Flow-Ansicht zusätzlich eine Verbindungslinie.

## 7. Commits

Die Commit-Ansicht zeigt pro Commit nur die Teile des **endgültigen** PR-Diffs, die er gemacht hat. Markiert wird also weiterhin der Diff des PRs, nur in Stücken. Änderungen, die ein späterer Commit überschrieben hat, sind nicht mehr im Diff und erscheinen deshalb auch nicht.

Die Zuordnung (`commits/Attribution`) kommt ohne Git aus:

1. Die Commits werden topologisch sortiert. Ab dem Head-Commit wird die **First-Parent-Kette** genommen. Commits aus gemergten Seitenzweigen werden dem Merge-Commit zugeschlagen (`mergedVia`), denn dessen Diff gegen den ersten Parent enthält ihre Änderungen.
2. Pro Datei gibt es ein Modell, das für jede Zeile nur die Herkunft kennt: «Basiszeile n» oder «Commit x». Die Diffs der Commits werden in dieses Modell eingespielt. Hinzugefügte Zeilen bekommen den Commit, gelöschte Basiszeilen merken sich, wer sie entfernt hat. Unberührte Zeilen bleiben implizit, die Dateilänge muss nicht bekannt sein. Umbenennungen tragen das Modell weiter.
3. Danach gilt für den PR-Diff: Eine hinzugefügte Zeile `N<n>` gehört zum Commit an Position n im Modell, eine gelöschte Zeile `O<n>` zum Commit, der Basiszeile n entfernt hat. Jede Zuordnung wird am **Text** der Zeile geprüft; passt er nicht (z. B. weil der Basis-Branch hineingemergt wurde), bleibt die Zeile ohne Commit.
4. Diffs können gleiche Zeilen (ein einzelnes `}`) unterschiedlich ausrichten. Eine Zeile ohne Commit übernimmt deshalb den Commit der direkt benachbarten geänderten Zeile derselben Art.

Fehlt der Patch eines Commits (Binärdatei, zu gross), bleibt die Datei ab dort ohne Zuordnung. GitHub liefert höchstens 250 Commits pro PR. Getestet am eigenen Repo (6 Commits, 33 Dateien): 1602 von 1602 geänderten Zeilen sind zugeordnet.

**Blame** (Annotieren) kommt vom Code-Host: GitHub über GraphQL, GitLab über `/repository/files/…/blame`. Für geänderte Zeilen zeigt die Spalte den Commit aus der Zuordnung oben, für unveränderte Zeilen den Commit aus dem Blame am PR-Stand.

## 8. Ganzes Repository

Das ganze Repository wird genauso analysiert wie ein Pull Request (`number` 0). Der Snapshot ist ein PR, in dem **jede Datei neu** ist: Für jede Textdatei am Head des Default-Branches gibt es einen Hunk aus hinzugefügten Zeilen. So laufen Segmente, Quick wins, Flows, Architektur, Komponenten und Tests unverändert über den gesamten Code. Geholt wird ein einziges `.tar.gz`-Archiv, daraus kommen auch die Ordner und API-Verträge.

* Binärdateien, Dateien über 1 MB oder über 5000 Zeilen werden ohne Inhalt gelistet (wie ein Diff, den GitHub nicht zeigt); höchstens 5000 Dateien.
* Commits: die letzten 50 Commits des Branches, zugeordnet wie in Abschnitt 7. Jede Zeile gehört zum Commit, der sie zuletzt geschrieben hat; ältere Zeilen bleiben ohne Commit, die Blame-Spalte zeigt sie trotzdem.
* Kommentare gibt es nicht, es gibt keinen PR dazu.
* Getestet am eigenen Repo: 103 Dateien, 14'171 Zeilen, 701 Segmente, 53 Flows, 41 Komponenten; Analyse in rund 2,5 s.

## Eigene Regeln

`<data>/rules.json` anlegen (Vorlage: `rules.default.json` daneben). Format:

```json
{
  "categories": [ { "id": "quick-wins", "label": "Quick wins", "icon": "bolt", "description": "…", "builds": "…", "divides": "…", "needsTests": false } ],
  "rules": [
    { "id": "our-mappers", "category": "quick-wins", "group": "Mapper", "reason": "Unsere Mapper",
      "paths": ["**/*.mapper.ts"] },
    { "id": "feature-flags", "category": "quick-wins", "group": "Feature-Flags", "reason": "Nur Flag-Umschaltung",
      "lines": ["^\\s*[A-Z_]+:\\s*(true|false),?$"], "require": ["true|false"] },
    { "id": "enums", "category": "quick-wins", "group": "DTOs & Typen", "kinds": ["enum"] }
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `paths` | Globs (`**` über Ordner, `*` innerhalb). Klassifiziert ganze Dateien. |
| `lines` | Regex; **jede** geänderte Zeile muss eines davon ganz erfüllen. |
| `require` | Regex; **mindestens eine** Zeile muss es enthalten. |
| `symbol` | Regex auf den Funktions-/Klassennamen. |
| `kinds` | Symbolarten: `class`, `interface`, `type`, `enum`, `function`, `method`, `component`, `const`, `test`, `suite`, `setup`. |
| `special` | `same-content` = nur umformatiert/verschoben. |
| `symbols` | `true`: Dateien dieser Pfad-Regel trotzdem in Funktionen/Testfälle zerlegen (Default `false`). |
| `extras` | `false`: Segmente dieser Regel bekommen keine Architektur-/Frontend-Kategorie (Default `true`). |
| `needsTests` | (an einer **Kategorie**) `false`: geänderte Funktionen mit dieser Hauptkategorie gelten als trivial/mechanisch und fehlen in der Abdeckung (Default `true`, siehe 5a). |
| `text`, `fileText` | (nur `aspects`) Regex im Code des Segments bzw. irgendwo in der Datei. |
| `assertions` | (eigener Abschnitt, Liste von Regex) Beginn einer Assertion-Anweisung im Testrumpf, gesucht im Code ohne Strings und Kommentare (siehe 5c). Beginnt der Treffer mit `.`, gilt er als verketteter Matcher. |
| `weakAssertions` | (eigener Abschnitt) Assertions, die nur Existenz oder Wahrheitswert prüfen (`toBeTruthy`, `toBeDefined`, `not.toBeNull`, `assertNotNull`, `isNotNull`, `toBeGreaterThan(0)` auf Längen …): Wechsel dorthin ist «abgeschwächt». |
| `disabledTests` | (eigener Abschnitt) Ausgeschaltete Tests/Suites (`xit`, `it.skip`, `@Disabled`, `@Ignore`, `t.Skip` …), gesucht im Kopf und auf oberster Ebene des Testrumpfs. |
| `testProfile` | (eigener Abschnitt, Objekt; siehe 5d) Muster für den Test-Steckbrief. `errorCode`: Regex im Test (Kopf und Rumpf, ohne Kommentare, mit String-Inhalten). `edgeCode`: Regex nur in den Eingaben des geprüften Codes (Parameterquellen, Argumentlisten der Ziel- und HTTP-Aufrufe). `inputCalls`: Regex, die bei der `(` eines Aufrufs enden, dessen Argumente Eingaben sind (HTTP-Anfragen). `errorName`, `edgeName`: Regex auf den Namen als kleingeschriebene Wörter. `assertionKinds`: Art → Regex auf eine Assertion-Anweisung, geprüft in der Reihenfolge des Objekts (`existence` umfasst zusätzlich `weakAssertions`). `mocks`: Regex mit benannter Gruppe `type` (Name), `ref` (Variable, wird über ihre Deklaration aufgelöst) oder `module` (Modulpfad, letztes Segment); oder `{ "pattern": …, "name": "HTTP" }` für einen festen Namen. `mockMembers`: Regex-Vorlagen mit dem Platzhalter `{member}` (Name einer geänderten Funktion einer gemockten Abhängigkeit), die die Stelle finden, an der ein Test sie stubbt oder nennt; die erste Vorlage mit Treffer gibt die Zeile der Mock-Warnung (5g). `levels`: Liste `{ "level", "paths" (Globs), "code" (Regex in der Umgebung), "unless" (Regex, die die Regel aufheben) }`, erste passende gewinnt, sonst `unit`. Fehlt der Abschnitt oder einer seiner Schlüssel, gilt der eingebaute Wert. |
| `relatedTests` | (eigener Abschnitt, Objekt; siehe 5f) Bestehende Tests. `limit`: höchstens so viele bestehende Testdateien pro PR. `mirrors`: Liste `{ "from", "to" }`; das erste Vorkommen von `from` (ganze Pfadsegmente) im Ordner einer geänderten Datei wird durch `to` ersetzt, um ihren Testordner zu finden (der Ordner selbst zählt immer). Fehlt der Abschnitt oder einer seiner Schlüssel, gilt der eingebaute Wert. |
| `caseCheck` | (eigener Abschnitt, Objekt; siehe 5h) Fall- und Effekt-Abgleich. `exceptions`: Regex im Code der Funktion (ohne Strings und Kommentare) für einen Fehlerausgang, benannte Gruppe `type` = Ausnahmetyp (optional). `typedChecks`: Regex-Vorlagen mit `{type}`, die zeigen, dass ein Test diesen Typ erwartet; `anyChecks`: Regex für Tests, die irgendeinen Fehler erwarten. `statuses`: Ausnahmetyp → HTTP-Status; `statusNames`: Status → Konstantenname (`404` → `NOT_FOUND`). `statusChecks`: Vorlagen mit `{status}` (404), `{statusName}` (`NOT_FOUND`) und `{statusCamel}` (`NotFound`). `effects`: Liste `{ "kind": "field" \| "persist" \| "message", "pattern" }` mit benannter Gruppe `name`, gesucht in geänderten Zeilen. `fieldChecks`, `callChecks` (Vorlagen mit `{name}`), `readBack` (Regex) und `httpChecks` (Vorlagen mit `{segment}`) werden in den Assertion-Anweisungen der erreichenden Tests gesucht. Fehlt der Abschnitt oder einer seiner Schlüssel, gilt der eingebaute Wert. |
| `caseMatrix` | (eigener Abschnitt, Objekt; siehe 5e) Fallmatrix. `expectedNames`: Regex auf den Namen einer Tabellenspalte (Methoden-/Callback-Parameter, Objektschlüssel, Tabellenkopf, Struct-Feld); ein Treffer macht sie zur Erwartungsspalte. `nameFields`: Regex auf Go-Struct-Felder, die den Fall benennen (Zeilenname statt Spalte). Fehlt der Abschnitt oder einer seiner Schlüssel, gilt der eingebaute Wert. |

Fehlt einer der Abschnitte `assertions`, `weakAssertions`, `disabledTests` in einer eigenen `rules.json`, gilt die eingebaute Liste (ältere Kopien funktionieren so weiter). Eine leere Liste schaltet die Erkennung ab.

Zusätzlich zu `rules` gibt es die Liste **`aspects`** (Frontend-Kategorien, erste passende Regel gewinnt). Die Kategorien `domain`, `usecases`, `application`, `adapters` werden automatisch befüllt, wenn sie in `categories` stehen.

Kategorien: `quick-wins`, `logic` (Default für alles Übrige), `tests`, `styles`. `flows` wird automatisch befüllt. Weitere Kategorien kann man ergänzen; sie erscheinen in der Reihenfolge der Datei. `builds` und `divides` an einer Kategorie sind optional (Beschreibung im UI, sonst aus den Regeln abgeleitet, siehe 3e), ebenso `needsTests` (siehe 5a).
