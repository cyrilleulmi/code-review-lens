# Anforderungen

Alle Funktionen von SmartCodeReview als prüfbare Anforderungen, mit Akzeptanzkriterien und Nachweis. Das Dokument beschreibt den **Ist-Stand** (0.5.0 + Unreleased); Ideen für später stehen in [07-roadmap.md](07-roadmap.md), Schwächen in [11-verbesserungen.md](11-verbesserungen.md). Wie die Funktionen umgesetzt sind, steht in [09-architektur-ueberblick.md](09-architektur-ueberblick.md) und [05-analyse.md](05-analyse.md).

## Notation

* **ID:** `FR-<Bereich>-<Nr>` funktional, `NFR-<Nr>` nicht-funktional. IDs werden nie neu vergeben; entfällt eine Anforderung, bleibt die Zeile mit Status «entfallen».
* **Anforderung:** «Das System muss …» (verbindlich). «Soll» heisst: erwünscht, aber nicht zwingend.
* **Nachweis:**
  * `T:` automatischer Test (Klasse › Methode, Backend unter `backend/src/test/java/dev/smartcodereview/`, Frontend `*.spec.ts`).
  * `M:` manuell geprüft an den Test-PRs ([06-test-prs.md](06-test-prs.md)) bzw. am eigenen Repo.
  * `–`: kein Nachweis. Diese Lücken sind in Abschnitt 14 gesammelt.
* **Annahmen** (`A…`, `B…`, `C…`) verweisen auf [02-annahmen.md](02-annahmen.md).

## 1. Beteiligte und Nutzungsszenarien

| Rolle | Ziel | Typisches Szenario |
|---|---|---|
| Reviewer:in | Einen PR schnell und vollständig verstehen | Quick wins abhaken, Datenflüsse lesen, Kommentare schreiben |
| Autor:in | Den eigenen PR vor dem Review prüfen | Commit für Commit durchgehen, fehlende Tests sehen |
| Software-Architekt:in | Struktur und Schichten beurteilen | Ganzes Repository analysieren, Komponentendiagramm, Architektur-Kategorien |
| Agent | Teile des Reviews übernehmen | Über REST oder Dateien markieren, Regeln ergänzen, kommentieren |
| Betreiber:in (lokal) | Das Tool starten und aktuell halten | Start-Skript oder Docker-Image, Token aus der Umgebung |

## 2. Zugang zu Code-Hosts (FR-ZUG)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-ZUG-01 | Das System muss die offenen GitHub-PRs auflisten, die die angemeldete Person erstellt hat oder bei denen ihr Review angefragt ist. | Liste mit Titel, Repo, Nummer, Autor, Rolle («von mir» / «Review»), lokalem Fortschritt; max. 100 pro Suche (A10). Team-Anfragen nicht garantiert (A9). | M |
| FR-ZUG-02 | Das System muss dasselbe für GitLab-Merge-Requests leisten (gitlab.com oder eine self-managed Instanz). | «Von mir» = `created_by_me`, «Review» = Reviewer (A9a); verschachtelte Gruppen als `gruppe~untergruppe` (A9b). | M |
| FR-ZUG-03 | Das System muss einen PR/MR über seine Web-URL öffnen können, auch wenn er nicht in der Liste steht. | GitHub `…/pull/<n>`, GitLab `…/-/merge_requests/<n>` (auch mit Untergruppen) werden erkannt; sonst Fehlermeldung. | T: ProviderUrlTest › parsesGitHubPullRequestUrls, parsesGitLabMergeRequestUrlsWithNestedGroups |
| FR-ZUG-04 | Das System muss öffentliche GitLab-MRs ohne Token lesend öffnen können. | Öffnen per URL funktioniert; Liste und Kommentieren melden fehlenden Token (A9c). | M |
| FR-ZUG-05 | Das System muss Tokens aus Konfiguration, Umgebung oder CLI beziehen und nie speichern. | Reihenfolge Config → Env (`GITHUB_TOKEN`/`GH_TOKEN`, `GITLAB_TOKEN`/`GL_TOKEN`) → `gh auth token` / `glab config get token`; kein Token in Dateien oder Logs. | M (Code: `provider/Tokens`) |
| FR-ZUG-06 | Das System muss pro Provider anzeigen, welches Konto verbunden ist oder warum keines. | `GET /api/me` liefert pro Provider User oder Grund, dazu Datenverzeichnis und Version. | M |
| FR-ZUG-07 | Das System muss die Liste nach «Alle / Von mir / Review» filtern und durchsuchen lassen. | Filter-Chips mit Anzahl; Suchfeld filtert, eine URL + Enter öffnet. | M |

## 3. Snapshot (FR-SNP)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-SNP-01 | Das System muss beim ersten Öffnen einen eingefrorenen Stand des PRs speichern (Metadaten, Diff, Quelltexte der neuen Version für analysierte Dateien). | `snapshot.json` und `sources/` entstehen; weitere Aufrufe gehen ohne Code-Host. | M |
| FR-SNP-02 | Das System muss den Snapshot auf Wunsch neu laden und neu analysieren. | `POST …/reload`; ohne neuen Head bleibt `review.json` unverändert. | M |
| FR-SNP-05 | Bringt das Neuladen neue Commits (oder einen Rebase), muss das System die Markierungen auf die neuen Zeilenschlüssel übertragen: unveränderte Zeilen behalten sie, geänderte und neue sind offen; nie darf neuer Code als geprüft erscheinen. | Paarung nach Inhalt und Reihenfolge pro Datei (A4); Orte in `okAt` folgen der Gruppe bzw. dem Flow (Einstiegspunkt); umbenannte Dateien über `previousPath`; `reload` in `review.json` mit `kept`, `dropped`, `newLines`; Log-Eintrag `carry`. | T: MarkCarryTest; LineMatchTest; manuell spongecoach#13 (`1cc0359`) |
| FR-SNP-03 | Das System muss fehlende Quelltexte nachladen, wenn neue Regeln sie brauchen. | Analyse nach Regeländerung holt fehlende `sources/` einmal nach (B9). | M |
| FR-SNP-04 | Das System muss Grenzen des Hosts einhalten und sauber melden. | Max. 3000 Dateien pro PR, Dateien > 1 MB ohne Inhalt (A10). | M |

## 4. Analyse (FR-ANA)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-ANA-01 | Das System muss jede geänderte Datei in Segmente zerlegen: Funktion/Methode/Typ/Konstante, sonst Hunk. | Unified-Diff wird mit Zeilennummern und Schlüsseln `N`/`O` gelesen; Strings und Kommentare stören die Symbolerkennung nicht; Sprachen TS/JS, Java, Kotlin, C#, Go (B1). | T: AnalyzerTest › parsesPatchWithLineNumbersAndKeys, extractsSymbolsIgnoringStringsAndComments |
| FR-ANA-02 | Das System muss Quick wins **ohne KI** über Regeln erkennen (Pfad-Regeln, dann Zeilen-Regeln, erste passende gewinnt). | Generiert/Lockfiles, Übersetzungen, Doku, Werkzeug-Konfiguration, DTOs & Typen, Mapper, banale REST-Aufrufe, Imports & Formatierung, deklarative Felder, Logging (B6). | T: AnalyzerTest › buildsFlowAcrossFilesAndRecognisesQuickWins |
| FR-ANA-03 | Das System muss Aufrufe zwischen geänderten Funktionen erkennen, über Dateigrenzen nur mit Import-Beleg. | Kurze/generische Namen nur mit `name(`; Hubs (> 5 Aufrufer) verbinden keine Flüsse; Tests rufen Produktivcode, nie umgekehrt (B2, B4). | T: AnalyzerTest › buildsFlowAcrossFilesAndRecognisesQuickWins |
| FR-ANA-04 | Das System muss pro Einstiegspunkt einen Datenfluss in Aufrufreihenfolge bilden. | ≥ 2 Segmente, ≥ 1 davon Logik; gemeinsame Funktionen in jedem Flow (ausser in Gruppen > 20 Funktionen, B4a); Titel als Kette, mit Auslöser bei Endpunkt/Listener. | T: AnalyzerTest › buildsFlowAcrossFilesAndRecognisesQuickWins; StructureAndHttpTest › buildsOneFlowFromTheComponentThroughRestIntoTheBackend |
| FR-ANA-05 | Das System muss Frontend-HTTP-Aufrufe mit literaler URL mit Backend-Endpunkten verbinden. | JAX-RS, Spring, Next.js, Express/Fastify, Go; Parameter als Platzhalter; Kante `http` (B8). | T: StructureAndHttpTest › matchesFrontendCallsToBackendEndpoints |
| FR-ANA-06 | Das System muss Aufrufe generierter OpenAPI-Clients über die operationId mit der Implementierung verbinden. | Verträge im Repo (max. 10) gelesen; geänderte Vertragszeilen verweisen auf Aufrufer und Implementierungen (B19). | T: LayeredSpringAngularTest › readsOperationsFromAnOpenApiContract, classifiesTheLayeredSpringAngularRepository |
| FR-ANA-07 | Das System muss Ports & Adapters bzw. Schichten mit Adaptern erkennen und Segmenten eine Schicht geben. | Kategorien Domäne, Use Cases, Application, Adapter (eingehend/ausgehend/Mapping/Konfiguration) (B14, B14a). | T: StructureAndHttpTest › recognisesPortsAndAdapters; LayeredSpringAngularTest › recognisesAdapterRolesOfALayeredRepository |
| FR-ANA-08 | Das System muss Frontend-Segmente einem Aspekt zuordnen (Routing, Zustand, API-Anbindung, Formulare, Komponenten-Logik, Templates). | Höchstens ein Aspekt pro Segment, erste passende Regel (B15). | T: LayeredSpringAngularTest › classifiesTheLayeredSpringAngularRepository |
| FR-ANA-09 | Das System muss Querschnittsthemen erkennen: Sicherheit, Messaging, Transaktionen, Datenbank. | Alle passenden Regeln zählen; auch Konfigurationsdateien (B20). | M |
| FR-ANA-10 | Das System muss Migration und Entity derselben Tabelle zusammen zeigen und aufeinander verweisen lassen. | Gruppe «Tabelle x» in *Datenbank & Migrationen* (B21). | M |
| FR-ANA-11 | Das System muss Laufzeit-Konfiguration, Build und Deployment als eigene Kategorie zeigen statt als Quick win. | `application*.properties/yml`, Dockerfile, CI, Helm/Terraform, Abhängigkeiten (B22). | M |
| FR-ANA-12 | Das System muss geänderte Testfälle erkennen und mit dem Code verknüpfen, den sie statisch erreichen. | `describe/it/test`, JUnit, Go; direkt / indirekt bis 4 Ebenen; getestete Komponenten nach Name und Aufruf (B10–B12). | T: AnalyzerTest › extractsTestCases, linksTestsToCodeAndListsAllPlacesOfSharedCode |
| FR-ANA-13 | Das System muss geänderte Komponenten und ihre Abhängigkeiten als Diagramm-Daten liefern. | Komponente = Dateien gleichen Namens im gleichen Ordner; Spalte nach Schicht; Kanten aus Aufrufen und REST (B18). | M |
| FR-ANA-14 | Jede Kategorie muss ein eigenständiges Modul sein, das sich selbst beschreibt. | Gleiche Schnittstelle (`info`, `groups`, `view`, `origin`); Entfernen eines Moduls ändert die anderen nicht; `builds`/`divides` aus Regeln abgeleitet oder überschrieben. | T: CategoryModulesTest (5 Tests); AnalyzerTest › everyCategoryDescribesItselfAndFlowsKeepTheirOwnView |
| FR-ANA-15 | Das System muss eigene Regeln aus `<data>/rules.json` verwenden und die Analyse bei Änderung automatisch neu berechnen. | Ungültige Datei → Fehlermeldung `rules.json ist ungültig`; neue Regeln wirken beim nächsten Öffnen. | M |
| FR-ANA-16 | Die Analyse muss deterministisch sein. | Gleicher Snapshot + gleiche Regeln + gleiche Version = byte-gleiches Ergebnis (abgesehen von `generatedAt`). | M (Vergleich vor/nach Performance-Änderung, PR #1) |
| FR-ANA-17 | Das System muss bei bestehenden Tests geänderte Erwartungen erkennen: geänderte, entfernte und abgeschwächte Assertions sowie aus- und wieder eingeschaltete Tests. | Musterbasiert (`assertions`, `weakAssertions`, `disabledTests` in `rules.json`); Paarung über den geprüften Gegenstand, bei `assertEquals(erwartet, tatsächlich)` das zweite Argument; reines Umformatieren ist keine Änderung; eine ausgeschaltete Suite schaltet ihre Tests aus; Anzahl Assertions alt/neu; im UI Warnmarkierung mit Details im Spec-Diff, Warnzeile auf der Kachel Tests, Abzeichen im Code-Block (B12b, 05-analyse 5c). | T: ExpectationsTest (6 Tests); expectations.spec.ts |
| FR-ANA-18 | Das System muss für jeden geänderten Testfall einen Steckbrief liefern: was er prüft, Fall (Fehler-, Grenz-, Normalfall), Ebene (Unit, Integration, E2E), Anzahl und Art der Assertions, ersetzte Abhängigkeiten (Mocks) und Anzahl parametrisierter Fälle – und alle Tests als Tabelle zeigen. | Musterbasiert (Abschnitt `testProfile` in `rules.json`, fehlende Schlüssel aus den eingebauten Regeln), jede Einstufung mit Fundstelle (`…By`, `…Reason`); Grenzfall im Code nur aus Eingaben des geprüften Codes (Ziel- und HTTP-Aufrufe, Parameterquellen), nicht aus Testdaten; Mocks auch aus Feldern, Setup-Blöcken und umschliessenden Suites, nicht aus Geschwister-Suites; Fälle aus `@ValueSource`/`@CsvSource`/`@EnumSource`, `it.each`, Go-Tabellentests; im UI Zeile pro Test mit Tooltips, Umschalter «Liste \| Tabelle», sortierbare Tabelle, Zusammenfassung mit Filter (B12c, 05-analyse 5d). | T: TestProfilesTest (11 Tests); test-profile.spec.ts |
| FR-ANA-19 | Das System muss ähnliche Tests (gleicher Eingabecode bis auf Literale) und parametrisierte Tests der geänderten Testdateien als Tabelle Eingabe → Erwartung zeigen, doppelte und widersprüchliche Fälle markieren und die abgedeckten Eingabewerte nennen. | Token-basiert und deterministisch; alle Tests der geänderten Testdateien (auch unveränderte), mindestens ein geänderter Test pro Matrix, keine für das ganze Repository; Gruppe = gleiche Suite und identisches Eingabe-Skelett (Literale maskiert, Assertions dürfen abweichen); Eingabespalten = Literale, die sich unterscheiden; Erwartungen nach Gegenstand ausgerichtet; parametrisierte Zeilen aus `@ValueSource`/`@CsvSource`/`@EnumSource`/`@NullSource`, `it.each` (Array, Objekte, Template-Tabelle), Go-Tabellentests; Rolle einer Spalte nach Name (`caseMatrix.expectedNames`) oder Verwendung nur in Assertions; im UI Vorlage mit Slots, Trennstrich Eingabe | Erwartung, Duplikate in Warnfarbe, «geprüft: …» (B12d, 05-analyse 5e). | T: CaseMatricesTest (10 Tests); case-matrices.spec.ts |
| FR-ANA-20 | Das System muss bestehende, unveränderte Tests des geänderten Codes nachladen und mit ihm verknüpfen, damit von ihnen abgedeckter Code nicht als «ohne Test» erscheint und sichtbar ist, welche alten Tests durch die Änderung laufen. | Auswahl nur über Dateinamen aus der Dateiliste des Repositorys: nach der geänderten Datei benannt im gespiegelten Testordner oder daneben (`mirror`), sonst gleicher Name anderswo, der nächstgelegene (`name`), plus Name mit gleichem Anfang im gespiegelten Ordner (`prefix`); keine Testdateien des PRs; deterministische Reihenfolge; höchstens `relatedTests.limit` (30) Dateien, Abschneiden wird gemeldet; nicht beim ganzen Repository. Geladen am Head (`sources-related/`, Auswahl in `related.json`), Fehler übersprungen. Verknüpfung wie bei geänderten Tests (Namensbezug + Import, Hilfsfunktionen durchlässig, HTTP-Anfragen wie FR-ANA-26, 4 Ebenen); keine Segmente. Abdeckungsstatus `existing` (Reihenfolge none, indirect, existing, direct); bestehende Tests auch bei direkt/indirekt getesteten Funktionen gelistet. Im UI Gruppe «Nur durch bestehende Tests», eigene Chips mit `datei:zeile` ohne Navigation, Grundlage-Zeile mit Warnung, Abzeichen «durch bestehende Tests», Zählung auf der Kachel (B11a, 05-analyse 5f). | T: RelatedTestsTest (7 Tests); existing-tests.spec.ts |
| FR-ANA-21 | Das System muss zeigen, welche Teile eines Flows die Tests wirklich ausführen (Mock-Grenzen), und Tests melden, die geänderten Code mocken. | Erreicht ein Test Code einer Abhängigkeit, die er mockt (Steckbrief `mocks`; Klasse, Dateiname oder Komponente gleich, ohne Gross-/Kleinschreibung und Satzzeichen), zählt das als `mocked`, die Suche hält dort an; nur gemockt erreichter Code ist «ohne Test» (`mockedTests`). Warnung, wenn eine gemockte Abhängigkeit eine geänderte Funktion hat und der Test sie beim Namen stubbt oder nennt (`testProfile.mockMembers`), mit Zeile; auch für bestehende Tests. Pro Flow Schritte `tested`/`mocked`/`none` und Verbindungen `tested` (ein Test läuft hindurch) / `separate` (beide Seiten getestet, keiner läuft hindurch, z. B. REST) / `partial` / `none`; REST-Verbindungen mit `clientTests`/`serverTests` (FR-ANA-26). Im UI Knoten nach Status eingefärbt mit Legende und Tooltip, Verbindungen durchgezogen / gestrichelt «einzeln» / blass, Warnzeichen am gemockten Schritt, Liste «Mocks auf geändertem Code» mit Sprung zur Stub-Zeile, Abzeichen «mockt geänderten Code» im Block (B10b, 05-analyse 5g). | T: MockBoundariesTest (5 Tests); mock-boundaries.spec.ts |
| FR-ANA-22 | Das System muss pro testbarer geänderter Funktion zeigen, welche Fälle und Wirkungen des Codes die Tests prüfen, die sie wirklich erreichen (Fall- und Effekt-Abgleich). | Fehlerausgänge (`throw new X(`, `throwError(`, `errors.New(` …) gelten als geprüft, wenn ein erreichender Test den Typ, irgendeinen Fehler oder den gemappten HTTP-Status erwartet (`caseCheck.statuses`, z. B. `NotFoundException` → 404); Grenzen (`<`, `<=`, `>`, `>=` mit ganzer Zahl oder Konstante derselben Datei) liefern ihre Grenzwerte (k−1/k bzw. k/k+1), verglichen mit den ganzzahligen Eingaben der erreichenden Tests (Argumente, Parameterquellen, Fallmatrix); Wirkungen geänderter Zeilen (Feld, Setter, Persistenz, Nachricht, HTTP) gelten als geprüft, wenn eine Assertion das Feld nennt, den Aufruf verifiziert oder gespeicherte Daten wieder liest; Hinweis bei mehr Verzweigungen als Tests. Gemockte Erreichungen zählen nicht. Ergebnis `coverage[].findings`, Grenzen zusätzlich an der Fallmatrix (`boundaries`). Im UI Kurzzeile pro Funktion (aufklappbar, Klick springt zur Zeile), Warnzeichen auch bei «direkt getestet», Zusammenfassung «n offene Fälle in m Funktionen», Chips auf der Codezeile, Grenzhinweis unter der Fallmatrix (B10c, 05-analyse 5h). | T: CaseChecksTest (8 Tests); case-checks.spec.ts |
| FR-ANA-23 | Das System muss Regeln der Form «wenn X geändert wird, wird ein Test der Form Y erwartet» pro PR prüfen (Erwartungs-Regeln). | Regeln im Abschnitt `testRules` (eigene in `rules.json` nach Id eingemischt, `enabled: false` schaltet ab); Auslöser `changed`, `text`, `concern`, `endpoint`, `newEndpoint`, `kinds`, `paths`; Erwartung `assertion`, `code`, `scenario`, `level`, `http`. Es zählen Tests, die das Segment echt erreichen (nicht gemockt), auch über eine HTTP-Anfrage (FR-ANA-26; RestAssured mit Pfadparametern, MockMvc, supertest …), nicht `HttpTestingController`; `http` = erreicht den auslösenden Endpunkt direkt über HTTP. Eingebaut: `auth-denied`, `endpoint-http`, `validation-boundary`, `transaction-integration`, `listener-test`. Ergebnis `ruleChecks[]`, leer für das ganze Repository. Im UI Box «Erwartete Tests (Regeln)» (nicht erfüllte zuerst mit Hinweis, erfüllte eingeklappt mit den Tests, Klick springt zur auslösenden Zeile, Zusammenfassung «n von m Regeln nicht erfüllt»), Chip auf der auslösenden Zeile, Zahl auf der Übersicht (B10d, 05-analyse 5i). | T: TestRulesTest (9 Tests), HttpTestsTest; rule-checks.spec.ts |
| FR-ANA-24 | Das System muss geänderte Testfälle markieren, deren Wert zweifelhaft ist (Test-Smells). | Pro geändertem Testfall, Regel-Abschnitt `testSmells` (je Art `label`, `hint`, `enabled`, Muster): `no-assertion` (keine Assertion; `verify`, `expectOne`, `toHaveBeenCalled` zählen), `weak-only` (nur Existenz-/Wahrheitsprüfungen), `focused` (`fit`, `fdescribe`, `.only` am Test oder an einer Suite), `sleep` (`Thread.sleep`, `TimeUnit.X.sleep`, `time.Sleep`; `setTimeout`/`sleep(` nur ohne Fake-Timer), `mocks-subject` (Mock oder Spy der getesteten Einheit: Name aus dem Dateinamen oder des wirklich aufgerufenen geänderten Codes, direkter Aufruf eines Mocks ausserhalb von Stubbing, Spy auf die aufgerufene Methode), `disabled` (neuer, ausgeschalteter Test). Ergebnis `tests[].smells[]` (`kind`, `label`, `line`, `code`, `hint`). Im UI Warn-Chips in der Steckbrief-Zeile, Spalte «Smells» in der Tabelle, Zusammenfassung «n Tests mit Smells» als Filter, Abzeichen im Kopf des Test-Blocks, Chip auf der Zeile, Zahl auf der Kachel der Tests (B10e, 05-analyse 5j). | T: TestSmellsTest (13 Tests); test-smells.spec.ts |
| FR-ANA-25 | Das System muss zeigen, auf welche Tests ein geänderter Setup-Block, eine geänderte Fixture oder Testhilfe wirkt – auch auf Tests, die nicht im Diff stehen (Wirkung von Setup und Testdaten). | Stücke in Testdateien und Test-Hilfsdateien (`setupImpact.supportPaths`) mit nicht trivialer Änderung: `setup` (`beforeEach` & Co., JUnit `@BeforeEach`/`@BeforeAll`/`@AfterEach`/`@AfterAll`/`@Before`/`@After` …) wirkt auf alle Tests seiner Suite/Klasse inkl. verschachtelter, `@Nested` und Unterklassen, oben in der Datei auf die ganze Datei; `fixture` (Konstante oberster Ebene, Feld oder Suite-Variable mit Wert) und `helper` (Funktion, Methode, Klasse, die kein Test ist) auf alle Tests, die den Namen nennen – selbst, in ihrem Setup oder transitiv über andere Hilfen, Konstanten und Felder; andere Dateien nur mit Import-Nachweis. Durchsucht: alle Testdateien des PRs (auch unveränderte Tests) und die nachgeladenen bestehenden. Ergebnis `setupImpacts[]` (`segmentId`, `kind`, `name`, `line`, `affected[]` mit `path`, `name`, `line`, `segmentId`, `status`, `existing`; `unchangedCount`), leer für das ganze Repository. Im UI Hinweise in der Spezifikation (Warnung nur bei unveränderten betroffenen Tests, aufklappbare Liste, Klick springt zum Stück), Markierung «Setup geändert» an unveränderten Tests (bleiben sichtbar, «n unveränderte, aber betroffen»), Abzeichen «wirkt auf n Tests (m unverändert)» im Kopf des Blocks, Zahl auf der Kachel der Tests (B10f, 05-analyse 5k). | T: SetupImpactTest (15 Tests); setup-impact.spec.ts |
| FR-ANA-26 | Das System muss Tests, die eine echte HTTP-Anfrage an einen geänderten Endpunkt schicken, mit diesem Endpunkt und dem Code dahinter verknüpfen und bei gemocktem Backend die erwarteten Anfragen als Vertrag an der REST-Verbindung zeigen (HTTP-Tests). | Anfragen per Regel-Abschnitt `testHttpCalls` (RestAssured, MockMvc, WebTestClient, TestRestTemplate, supertest, Playwright `request.put`, Cypress `cy.request`, `fetch`, Go `httptest`) im Test und in Hilfsfunktionen derselben Datei (bis 3 Aufrufe tief, Zeile = Aufruf im Test); Pfadparameter und `+`-verkettete Werte als Platzhalter; Basispfad (`testHttpLinks.bases`) aus `@TestHTTPEndpoint(X.class)` (Klassen-Pfad von X), `basePath`, `baseUrl`; Vergleich mit den Endpunkten der geänderten Segmente wie bei REST-Flüssen, bei mehreren der genaueste. Erreichung **direkt** (`covers[]` mit `http`, `endpoint`), das Aufgerufene indirekt; wirkt auf Abdeckung, `testedBy`, Komponenten (`how: http`), Steckbrief-`targets`, Fall-Abgleich (Argumente des Hilfsfunktions-Aufrufs und Literale der Anfrage als Eingaben), Mock-Grenzen und Erwartungs-Regeln; gilt auch für bestehende Tests. Gemocktes Backend (`HttpTestingController`, `MockWebServer`, WireMock, nock, msw …) erreicht nichts; erwartete Anfragen im Test selbst (`testHttpLinks.expectations`: `expectOne(url)`/`expectOne({ method, url })`, `cy.intercept`, `page.route`, nock, msw, WireMock, `requestTo`; Methode auch aus `x.request.method`-Prüfung) ergeben an REST-Kanten `clientTests` (erreichen das aufrufende Ende echt), Backend-Tests über HTTP `serverTests`. `page.goto`/Klicks verknüpfen nicht. Im UI Kürzel «HTTP» an Abdeckungs- und Verknüpfungs-Chips, «direkt über HTTP: PUT …» in der Testübersicht, «update (PUT /api/players/{})» in der Spalte «Prüft», REST-Verbindung «beidseitig geprüft» mit Legende und Tooltip (Frontend- und Backend-Tests) (B10h, 05-analyse 5m). | T: HttpTestsTest (9 Tests); http-tests.spec.ts; M: spongecoach#13 (`JerseyNumberApiTest` erreicht `update` über HTTP, `isInRange` mit 23, REST-Sprung beidseitig geprüft) |

## 5. Darstellung und Navigation (FR-UI)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-UI-01 | Das System muss eine Übersicht mit Fortschritt und vorgeschlagener Reihenfolge der Kategorien zeigen. | Karten pro Kategorie mit Beschreibung, Anzahl Gruppen/Blöcke, Fortschritt; Beschreibung, allgemeine Kommentare, letzte Markierungen. | M |
| FR-UI-02 | Das System muss ein Review-Fenster mit den Tabs Kategorien, Flows, Dateien und Commits bieten. | Baum mit Fortschritt pro Knoten, ✓-Aktion beim Überfahren. | M |
| FR-UI-03 | Das System muss Symbol-Segmente als ganze Funktion mit eingewobenen gelöschten Zeilen zeigen. | Unveränderte Strecken > 2 Zeilen ausserhalb ±2 Zeilen werden zu «⋯ n unveränderte Zeilen»; Zeilen anderer Segmente gedimmt. | M |
| FR-UI-04 | Das System muss Datenflüsse als Diagramm und als Code in Aufrufreihenfolge zeigen, mit Verbindungen zwischen Aufrufstelle und Ziel. | Eigene Farbe pro Verbindung (Diagramm, Linie, Chip); REST gestrichelt; Einrückung nach Tiefe. | M |
| FR-UI-05 | Das System muss Fokus-Werkzeuge bieten. | Blöcke ein-/ausklappen, alle ein/aus, «Einzeln durchgehen» mit «Ok & weiter»; im Flow Schritte ausblenden, Erledigte ausblenden, «nur dieser Zweig». Zustand nicht gespeichert (B13). | M |
| FR-UI-06 | Das System muss Aufrufstellen anklickbar machen und «aufgerufen von» zeigen. | Chip `→ ② name` springt zum Block. | M |
| FR-UI-07 | Das System muss alle Orte eines Blocks anzeigen und zu ihnen springen. | Leiste «n Orte» mit ✓ pro Ort. | M |
| FR-UI-08 | Das System muss eine Dateiansicht bieten. | Pro Zeile Anzahl Orte; Häkchen dort gilt für alle Orte (B7a). | M |
| FR-UI-09 | Das System muss ein Komponentendiagramm mit Fokus pro Komponente zeigen. | Spalten nach Schicht; ⌖ zeigt eine Komponente mit Abhängigkeiten. | M |
| FR-UI-10 | Das System muss eine Testübersicht zeigen. | Pro Testfall Komponenten und abgedeckte Stellen (direkt / über …), mit Sprüngen; im Block «Getestet von …» / «Testet …». | M |
| FR-UI-11 | Das System muss Schicht und Sprache jedes Blocks und Knotens sichtbar machen. | Farbiger Streifen + Badge; Farben nur aus Tokens. | M |
| FR-UI-12 | Das System muss vollständig markierte Blöcke einklappen können. | Toolbar-Knopf, Standard an. | M |
| FR-UI-13 | Das System muss jeden Zustand verlinkbar machen. | Hash-Routing `#/<provider>/<owner>/<repo>/<n>[/c/<sha>]/<auswahl>`; Neuladen stellt PR, Auswahl und Commit-Filter wieder her. | M |
| FR-UI-14 | Das System muss Tastaturkürzel für die Tool-Fenster bieten. | Alt+1 PR-Liste, Alt+2 Review-Fenster. | M |
| FR-UI-15 | Das UI muss dem IntelliJ New UI Dark folgen. | Nur Dark Theme (A8); Farben als Tokens in `styles.scss`. | M |

## 6. Review-Status (FR-REV)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-REV-01 | Das System muss jede geänderte Zeile als «ok» markieren lassen. | Häkchen im Gutter; nur hinzugefügte und gelöschte Zeilen (A3). | M |
| FR-REV-02 | Das System muss einen Bereich per Shift-Klick markieren lassen. | Alle eigenen Zeilen zwischen letztem und aktuellem Klick. | M |
| FR-REV-03 | Das System muss ganze Blöcke, Gruppen, Flows, Kategorien und Commits auf einmal markieren lassen. | «Block ok», ✓ im Baum, «Ganzen Flow als ok markieren», ✓ in der Commit-Liste; erneuter Klick nimmt zurück, wenn alles ok war. | M |
| FR-REV-04 | Eine Zeile an mehreren Orten muss an jedem Ort ein eigenes Ok brauchen; erst dann gilt sie als erledigt. | `okAt` pro Ort, Wechsel nach `ok`, wenn alle Orte ok (B7). | T: LineAcceptanceTest › acceptedEverywhereOnceAllPlacesAreAccepted; acceptance.spec.ts |
| FR-REV-05 | Eine an einem Ort akzeptierte Zeile muss an den übrigen Orten als «halb akzeptiert» erscheinen. | Halbes Häkchen, Hinweis einmal pro Lauf, Tooltip mit Orten, Klick springt hin; zählt nicht im Fortschritt; nicht gespeichert. | T: LineAcceptanceTest › acceptingAtOnePlaceMakesTheOthersHalfAccepted, severalAcceptsAreTrackedAndListedAsElsewhere; acceptance.spec.ts |
| FR-REV-06 | Das Zurücknehmen an einem Ort muss die anderen Orte stehen lassen. | Auch bei vorher überall akzeptierter Zeile. | T: LineAcceptanceTest › takingBackOnePlaceOfAFullyAcceptedLineKeepsTheOthers, takingBackTheLastAcceptReturnsToOpen |
| FR-REV-07 | Eine Markierung ohne Ort (Dateiansicht, Agent) muss für alle Orte gelten. | Auch für einen Ort, an dem die Zeile nicht vorkommt. | T: LineAcceptanceTest › markWithoutPlaceOrForAForeignPlaceAppliesToAllPlaces; acceptance.spec.ts |
| FR-REV-08 | Das System muss den Fortschritt pro Block, Gruppe, Flow, Kategorie, Commit und gesamt zeigen. | Gesamt: Zeilen, die überall ok sind / alle zählenden Zeilen. | M |
| FR-REV-09 | Das System muss Kategorien global ausschalten lassen; ausgeschaltete Orte zählen nicht. | `settings.json`; Zeilen nur in ausgeschalteten Kategorien fallen aus dem Fortschritt (B17). | T: LineAcceptanceTest › placesThatAreSwitchedOffNoLongerCount |
| FR-REV-10 | Das System muss Markierungen nur lokal speichern, mit Protokoll. | `review.json` atomar geschrieben; `log` mit `at`, `by`, `action`, `scope`, `count`, max. 500 Einträge. | M |
| FR-REV-11 | Das UI muss Markierungen sofort zeigen und Änderungen von aussen übernehmen. | Optimistische Anzeige, danach Server-Stand; Status wird beim Fokus des Fensters neu geladen. | M |

## 7. Kommentare (FR-KOM)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-KOM-01 | Das System muss Inline- und allgemeine Kommentare des PRs anzeigen. | Inline-Kommentare als Threads an der Zeile; allgemeine auf der Übersicht. Bei Host-Fehler der letzte Stand. | M |
| FR-KOM-02 | Das System muss Inline-Kommentare sofort auf dem Code-Host veröffentlichen. | Sprechblase nur auf Zeilen im Diff (A6); Ctrl+Enter sendet; kein Pending Review (A5). | M |
| FR-KOM-03 | Das System muss auf bestehende Inline-Kommentare antworten lassen. | Antwort landet im selben Thread. | M |
| FR-KOM-04 | Das System muss einen allgemeinen Kommentar zum PR schreiben lassen. | Editor auf der Übersicht. | M |
| FR-KOM-05 | Im Repository-Modus darf es keine Kommentare geben. | Keine Kommentar-Knöpfe; `POST …/0/comments` → 400 mit Meldung; `GET` → leere Liste. | M |

## 8. Commits (FR-COM)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-COM-01 | Das System muss die Commits des PRs anzeigen. | Älteste zuerst, mit Nummer, Kurz-SHA, Titel, Autor, Datum, ±Zeilen, Dateien, Fortschritt; im Review-Fenster und auf der Übersicht. GitHub: max. 250. | M |
| FR-COM-02 | Das System muss jede geänderte Zeile des PR-Diffs dem Commit zuordnen, der sie zuletzt geschrieben bzw. entfernt hat. | Ohne Git; jede Zuordnung am Zeilentext geprüft; nicht prüfbare Zeilen bleiben ohne Commit. PR #1: 2288/2288 hinzugefügte Zeilen zugeordnet. | T: AttributionTest (7 Tests); M: PR #1 und Commit-Bereich `8cb1516…b4461ff` (1602/1602) |
| FR-COM-03 | Commits aus gemergten Seitenzweigen müssen dem Merge-Commit zugeschlagen und als solche gekennzeichnet werden. | `mergedVia`; Liste zeigt «via Merge …»; Klick springt zum Merge-Commit (A11). | T: AttributionTest › sideBranchCommitsAreCarriedByTheMerge |
| FR-COM-04 | Das System muss alle Ansichten auf die Änderungen eines Commits filtern lassen. | Nur Segmente mit Zeilen des Commits; Zeilen anderer Commits abgeblendet und ohne Häkchen; Fortschritt, «Block ok», Baum und Flow (Knoten gepunktet) folgen dem Filter. | M |
| FR-COM-05 | Das System muss zwischen Commits vor- und zurückschalten lassen. | Toolbar ← →, überspringt Commits ohne Zeilen im Diff; × hebt den Filter auf. | M |
| FR-COM-06 | Der gewählte Commit muss in der URL stehen. | `…/c/<sha>/…`; Öffnen der URL stellt den Filter wieder her. | M |
| FR-COM-07 | Die Zuordnung muss gecacht und bei neuem Head oder neuem Algorithmus neu berechnet werden. | `commits.json` mit `headSha` und `version`. | M |
| FR-COM-08 | Das System muss aus der Reihenfolge der Commits ableiten, was sie über die Tests sagen (Commit-Bezug der Tests). | Regel-Abschnitt `commitChecks` (`fixTitles`, `testAdjustTitles`, `notCode`). `expectation-later`: eine Assertion-Zeile (Erkennung wie FR-ANA-17) eines im PR geschriebenen Tests gehört zu einem späteren Commit als seine Deklarationszeile – `warn`, wenn dieser Commit nur Testdateien ändert oder sein Titel Tests anpasst, sonst `info`. `fix-without-test` (`warn`): Fix-Titel (nicht Test-Anpassung), ändert Quellcode und keine Testdatei. `logic-without-test` (`info`): Commit ändert eine testbare Funktion (`coverage[]`) und keine Testdatei, kein späterer Commit ändert einen erreichenden Test, nicht «Test zuerst», nicht schon «Fix ohne Test». Merge-Commits, Seitenzweige (`mergedVia`) und Commits ohne Diff übersprungen; leer für das ganze Repository. Ergebnis `commits.json` → `findings[]`, bei jedem Abruf aus Zuordnung und aktueller Analyse neu berechnet. Im UI Chips «Fix ohne Test», «passt Erwartungen an», «Logik ohne Test» an den Commits, Zahl bei «Commits» auf der Übersicht, Markierung «Erwartung nachträglich in <sha> «<Titel>» geändert» in der Spezifikation (Klick springt zur Assertion), Chip auf der Assertion-Zeile (Klick filtert auf den Commit) (B10g, 05-analyse 7a). | T: CommitChecksTest (9 Tests); commit-findings.spec.ts; M: spongecoach#13 (`9cb532b` Fix ohne Test, `406522a` passt Erwartungen an) |

## 9. Blame (FR-BLA)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-BLA-01 | Das System muss in allen Code-Blöcken eine Blame-Spalte ein- und ausblenden lassen. | Toolbar-Knopf, Zustand im Browser gemerkt. | M |
| FR-BLA-02 | Die Spalte muss pro Zeile Commit, Autor und Datum zeigen, wie «Annotate» in IntelliJ. | Text nur auf der ersten Zeile eines Laufs; Uhrzeit statt Datum, wenn alles vom selben Tag; jüngere Zeilen stärker eingefärbt; PR-Commits mit Nummer und Markierung; Tooltip mit SHA, Autor, Datum, Message. | M |
| FR-BLA-03 | Gelöschte Zeilen müssen den Commit zeigen, der sie entfernt hat. | Durchgestrichen, Nummer mit «−». | M |
| FR-BLA-04 | Ein Klick auf die Annotation muss bei PR-Commits filtern, sonst den Commit auf dem Host öffnen. | Erneuter Klick hebt den Filter auf. | M |
| FR-BLA-05 | Blame muss pro Datei erst bei Bedarf geholt und pro Head gecacht werden. | GitHub GraphQL, GitLab REST; `blame/<pfad>.json`. | M (GitLab und GitHub-GraphQL nicht live, siehe 14) |

## 10. Repository-Modus (FR-REP)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-REP-01 | Das System muss ein ganzes Repository über seine URL oder aus einem offenen PR heraus öffnen lassen. | `github.com/o/r[.git][/tree/…]`, GitLab-Projekt-URL (auch `/-/tree/…`); Ordner-Knopf in der Toolbar, Knopf auf der Übersicht. Issues-URLs werden nicht als Repo erkannt. | T: ProviderUrlTest › repositoryUrlsMeanTheWholeRepository |
| FR-REP-02 | Das System muss alle Dateien des Default-Branches wie einen PR analysieren, in dem jede Datei neu ist. | Ein Archiv-Download; jede Textdatei ein Hunk aus hinzugefügten Zeilen; Ordner und OpenAPI aus dem Archiv. | T: RepositorySnapshotTest › everyTextFileBecomesOneAddedHunk; M: eigenes Repo (116 Dateien) |
| FR-REP-03 | Das System muss im Repository-Modus Grenzen einhalten. | Max. 5000 Dateien; Binärdateien, > 1 MB oder > 5000 Zeilen ohne Inhalt gelistet. | T: RepositorySnapshotTest (Binärdatei) |
| FR-REP-04 | Im Repository-Modus müssen Commits die letzten 50 des Branches sein. | Ältere Zeilen ohne Commit; Blame zeigt sie trotzdem. | M |
| FR-REP-05 | Das UI muss den Repository-Modus erkennbar machen. | Titel «Ganzes Repository @ <sha>», Branch ohne Ziel, «Zeilen» statt «geänderte Zeilen». | M |

## 11. Agenten und API (FR-AGT)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-AGT-01 | Das System muss alle Funktionen des UI auch über REST anbieten. | Endpunkte laut [03-architektur.md](03-architektur.md#rest-api); Fehler als `{"message"}` mit Status. | M |
| FR-AGT-02 | Das System muss seinen Zustand in dokumentierten, lesbaren Dateien halten. | Format laut [04-persistenz-und-agenten.md](04-persistenz-und-agenten.md); Felder werden ergänzt, nicht umbenannt. | M |
| FR-AGT-03 | Das System muss Agenten eine Anleitung ins Datenverzeichnis legen. | `AGENTS.md` und `rules.default.json` beim Start geschrieben. | M |
| FR-AGT-04 | Markierungen von Agenten müssen im Protokoll erkennbar sein. | `by: "agent:<name>"`. | M |
| FR-AGT-05 | Das System muss PRs mit lokalen Daten auflisten, auch offline. | `GET /api/local`. | M |

## 12. Betrieb (FR-BET)

| ID | Anforderung | Akzeptanzkriterien | Nachweis |
|---|---|---|---|
| FR-BET-01 | Das System muss lokal mit einem Skript startbar sein (Windows, macOS, Linux). | `start.ps1` / `start.sh` bauen das UI beim ersten Mal und starten Quarkus; UI auf `http://localhost:8080`. | M |
| FR-BET-02 | Das System muss als natives Docker-Image laufen. | `culmi/smart-code-review:<version>` und `:latest`; Volume `/data`; Port nur auf `127.0.0.1`. | M |
| FR-BET-03 | Das Datenverzeichnis muss konfigurierbar sein. | `SCR_DATA_DIR` / `scr.data-dir`, Default `~/.smart-code-review`. | M |
| FR-BET-04 | Die Version muss im UI und in der API sichtbar sein. | Statusleiste, `GET /api/me` → `version`. | M |
| FR-BET-05 | Releases müssen mit einem Skript reproduzierbar sein. | `release.sh X.Y.Z` prüft Branch, Arbeitsstand, Tag, Changelog; baut Image inkl. Unit-Tests; rollt bei Fehler zurück. | M |
| FR-BET-06 | Das System soll einen Health-Endpunkt anbieten. | `/q/health` (SmallRye Health). | – |

## 13. Nicht-funktionale Anforderungen

| ID | Qualität | Anforderung | Messgrösse / Akzeptanz | Nachweis |
|---|---|---|---|---|
| NFR-01 | Nachvollziehbarkeit | Keine KI in Klassifikation, Flüssen, Zuordnung. | Kein Modellaufruf im Code; Heuristiken in `rules.json` oder benannten Klassen. | Code-Review |
| NFR-02 | Determinismus | Gleiche Eingabe → gleiches Ergebnis. | Siehe FR-ANA-16. | M |
| NFR-03 | Datenschutz | Code, Markierungen und Tokens verlassen den Rechner nur Richtung Code-Host. | Keine weiteren ausgehenden Verbindungen; API nur auf `127.0.0.1`. | Code-Review |
| NFR-04 | Performance: Analyse | Ein typischer Feature-PR wird in < 1 s analysiert, ein Repo mit 15'000 Zeilen in < 5 s. | Gemessen (JVM, kalt): PR #1 (39 Dateien, 2373 geänderte Zeilen) 0,7 s, eigenes Repo 2,3–2,5 s. | M |
| NFR-05 | Performance: Start | Native-Binary startet in < 0,5 s. | Gemessen ca. 50 ms. | M |
| NFR-06 | Performance: UI | Öffnen eines geladenen PRs < 1 s; eine Kategorie mit 150 Blöcken < 2 s. | Gemessen: Übersicht 0,7 s, 155 Blöcke 1,5 s (Repository-Modus). | M |
| NFR-07 | Kompatibilität | Dateiformate und API werden nur ergänzt. | Umbenennen/Entfernen nur mit Major-Release ([08-versionierung.md](08-versionierung.md)). | Prozess |
| NFR-08 | Robustheit | Teilausfälle des Hosts machen das Review nicht unbrauchbar. | Ohne Struktur, Kommentare, Commits oder einzelne Quelltexte läuft der Rest weiter. | M |
| NFR-09 | Datenintegrität | Abbruch beim Schreiben darf keine kaputten Dateien hinterlassen. | Temporäre Datei + atomarer Move. | Code-Review |
| NFR-10 | Sicherheit | Pfade aus PR-Daten dürfen das Datenverzeichnis nicht verlassen. | `DataStore.resolveInside` wirft bei Ausbruch. | Code-Review (kein Test, siehe 14) |
| NFR-11 | Portabilität | Windows, macOS, Linux, Docker (linux/amd64). | Start-Skripte für PowerShell und bash; Image amd64. | M |
| NFR-12 | Native-Tauglichkeit | Backend muss ohne Zusatzkonfiguration nativ laufen. | Records mit `@RegisterForReflection`, Ressourcen in `quarkus.native.resources.includes`. | Image-Build |
| NFR-13 | Wartbarkeit | Kategorien und Provider sind austauschbar ohne Seiteneffekte. | Module sehen nur `SegmentFacts`; nur `github/`/`gitlab/` kennen ihren Host. | T: CategoryModulesTest |
| NFR-14 | Bedienbarkeit | Vertrautes Bedienkonzept für IntelliJ-Nutzer:innen. | Tool-Fenster, Stripe, Breadcrumbs, Annotate-Spalte. | M |
| NFR-15 | Sprache | UI und Doku Deutsch (Schweizer Schreibweise), Code Englisch. | Kein «ß» in UI/Doku. | Code-Review |

## 14. Rückverfolgbarkeit und Lücken

**Tests → Anforderungen**

| Testklasse | Tests | Deckt ab |
|---|---|---|
| `analysis/AnalyzerTest` | 6 | FR-ANA-01, -02, -03, -04, -12, -14, FR-REV-04 (Orte) |
| `analysis/StructureAndHttpTest` | 3 | FR-ANA-04, -05, -07 |
| `analysis/LayeredSpringAngularTest` | 3 | FR-ANA-06, -07, -08 |
| `analysis/CategoryModulesTest` | 5 | FR-ANA-14, NFR-13 |
| `review/LineAcceptanceTest` | 9 | FR-REV-04 bis -07, -09 |
| `review/MarkCarryTest` | 5 | FR-SNP-05 |
| `review/LineMatchTest` | 5 | FR-SNP-05 (Paarung der Zeilen) |
| `frontend/src/app/acceptance.spec.ts` | 5 | FR-REV-04, -05, -07 (UI-Seite) |
| `analysis/ExpectationsTest` | 6 | FR-ANA-17 |
| `frontend/src/app/expectations.spec.ts` | 4 | FR-ANA-17 (Markierungen und Warnzeile im UI) |
| `analysis/TestProfilesTest` | 11 | FR-ANA-18 |
| `frontend/src/app/test-profile.spec.ts` | 5 | FR-ANA-18 (Steckbrief-Zeile, Zusammenfassung, Filter, Sortierung im UI) |
| `analysis/CaseMatricesTest` | 10 | FR-ANA-19 |
| `frontend/src/app/case-matrices.spec.ts` | 3 | FR-ANA-19 (Zusammenfassung, Vorlage-Slots, Duplikat-Hinweise im UI) |
| `analysis/RelatedTestsTest` | 7 | FR-ANA-20 |
| `frontend/src/app/existing-tests.spec.ts` | 3 | FR-ANA-20 (Grundlage-Zeile, Warnungen, Chips im UI) |
| `analysis/MockBoundariesTest` | 5 | FR-ANA-21 |
| `frontend/src/app/mock-boundaries.spec.ts` | 5 | FR-ANA-21 (Tooltips, Warnungen nach Test/Schritt, Block der Stub-Zeile im UI) |
| `analysis/CaseChecksTest` | 8 | FR-ANA-22 |
| `frontend/src/app/case-checks.spec.ts` | 6 | FR-ANA-22 (Kurzzeile, Zusammenfassung, Zeilen-Chips, Grenzhinweis der Fallmatrix im UI) |
| `analysis/TestRulesTest` | 9 | FR-ANA-23 |
| `frontend/src/app/rule-checks.spec.ts` | 4 | FR-ANA-23 (Reihenfolge, Zusammenfassung, Zeilen-Chips, Übersicht im UI) |
| `analysis/TestSmellsTest` | 13 | FR-ANA-24 |
| `frontend/src/app/test-smells.spec.ts` | 3 | FR-ANA-24 (Texte, Zählung und Zeilen, Zusammenfassung, Filter und Sortierung der Tabelle) |
| `analysis/SetupImpactTest` | 15 | FR-ANA-25 |
| `frontend/src/app/setup-impact.spec.ts` | 4 | FR-ANA-25 (Hinweise, Abzeichen, Markierung in der Gliederung, Zählung für Zusammenfassung und Kachel) |
| `analysis/HttpTestsTest` | 9 | FR-ANA-26, FR-ANA-21 (beide Seiten der REST-Verbindung), FR-ANA-22 (Eingaben aus HTTP-Tests) |
| `frontend/src/app/http-tests.spec.ts` | 4 | FR-ANA-26 (Tooltips, Erreichungstext, Ziele mit Endpunkt, Vertrag der REST-Verbindung im UI) |
| `commits/AttributionTest` | 7 | FR-COM-02, -03 |
| `commits/CommitChecksTest` | 9 | FR-COM-08 |
| `frontend/src/app/commit-findings.spec.ts` | 3 | FR-COM-08 (Chips pro Commit, Zählung für die Übersicht, Markierung und Zeilen-Chips) |
| `gitlab/ProviderUrlTest` | 3 | FR-ZUG-03, FR-REP-01 |
| `repo/RepositorySnapshotTest` | 1 | FR-REP-02, -03 |

**Anforderungen ohne automatischen Test** (nur manuell oder gar nicht geprüft). Sie sind die Grundlage für V-02 bis V-04 in [11-verbesserungen.md](11-verbesserungen.md):

* Alle Provider-Abbildungen (FR-ZUG-01, -02, -04, -06, FR-SNP-01, FR-KOM-01 bis -04, FR-COM-01, FR-BLA-05, FR-REP-04): kein Test gegen aufgezeichnete Antworten von GitHub/GitLab. GitHub-Blame (GraphQL) und alle GitLab-Teile von Commits, Blame und Repository-Modus sind auch manuell noch nicht live geprüft.
* `ReviewService` (Caching, Invalidierung, `mark` mit Schreiben/Lesen von `review.json`, Fortschritt, Laden der bestehenden Tests für FR-ANA-20, Neuberechnen der Commit-Befunde für FR-COM-08): kein Test, nur über `LineAcceptance` indirekt.
* REST-API (FR-AGT-01): kein `@QuarkusTest`.
* UI (FR-UI-*, FR-COM-04 bis -06, FR-BLA-01 bis -04): ausser `acceptance.spec.ts`, `expectations.spec.ts`, `test-profile.spec.ts`, `case-matrices.spec.ts`, `existing-tests.spec.ts`, `mock-boundaries.spec.ts`, `case-checks.spec.ts`, `rule-checks.spec.ts`, `test-smells.spec.ts`, `setup-impact.spec.ts`, `commit-findings.spec.ts` und `http-tests.spec.ts` (reine Hilfsfunktionen) keine Frontend-Tests.
* NFR-10 (Pfad-Sicherheit), FR-BET-06 (Health).
