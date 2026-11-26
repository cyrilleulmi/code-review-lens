# Test-PRs

Für den PoC wurden in drei eigenen Repos **Draft-PRs** erstellt. Alle tragen **[TEST-MR]** im Titel, einen Warnhinweis in der Beschreibung und gehören **nicht gemergt**. Nach den Tests einfach schliessen und den Branch löschen (siehe unten).

| PR | Repo / Basis | Inhalt | Was es testet |
|---|---|---|---|
| [spongecoach#13](https://github.com/cyrilleulmi/spongecoach/pull/13) | `master` | Trikotnummer für Spieler: Migration, Entity, DTOs, Resource, Angular-Service, Komponente, Template, SCSS; zweiter Commit: `PlayerResourceTest.java` (JUnit) und Tests in `player-view.spec.ts` (Jasmine/Vitest); dritter Commit: Trikotnummer entfernen (`clearJerseyNumber` in Backend und Frontend, Hilfsfunktion `isInRange`), bewusst ohne eigene Tests; vierter Commit «Rework player tests»: Tests umgebaut (Spezifikations-Diff) und `clearJerseyNumber` im Backend getestet; fünfter Commit «Adjust player test expectations»: bestehende Tests (`player-view.spec.ts`, `GreetingResourceTest.java`) so angepasst, dass geänderte Erwartungen sichtbar werden; sechster Commit «More jersey number tests»: neue Testklassen `JerseyNumberValidationTest.java` und `JerseyNumberApiTest.java` (Mockito, RestAssured, `@ParameterizedTest`) sowie weitere Tests in `player-view.spec.ts` (Test-Steckbrief und Fallmatrix); siebter Commit «Jersey number in the player list; stubbed API test»: `PlayerList` zeigt die Trikotnummer (bestehende Tests `player-list.spec.ts` bleiben unangetastet) und ein Test mit gemocktem `PlayerApiService` in `player-view.spec.ts`; achter Commit «Own-profile check for editing the jersey number»: `CurrentUserService.canEditPlayer` (neuer Helfer `isSelf`) geändert, ohne `current-user.service.spec.ts` anzufassen; Commits neun bis vierzehn (Testdaten für Fall-/Effekt-Prüfung, Erwartungsregel, Test-Smells, Fixture-Einfluss, Commit-Bezug): `85e20f8`, `451b88d`, `f8e01b6`, `a3a2363`, `9cb532b` «Fix jersey number rounding», `406522a` «fix tests»; Commit 15 `1cc0359` (Markierungen über neue Commits übertragen) | Fullstack Quarkus + Angular; Java- und TS-Symbole; DTO-/REST-Quick-wins; zwei Flüsse; Tests ↔ Code; Block an zwei Orten; bestehende Tests nachladen; Mock-Grenzen im Flow |
| [camperquiz#1](https://github.com/cyrilleulmi/camperquiz/pull/1) | `master` | Joker pro Team | Vanilla-JS **ohne Module** (globale Funktionen über Dateien hinweg) |
| [stv-bero-website#2](https://github.com/cyrilleulmi/stv-bero-website/pull/2) | `wave-1/new-site` | Anmeldeschluss für Anlässe | Payload-Collection, generierte Typen, Next.js-Komponente, Helfer, Konstante im Flow |
| [stv-bero-website#1](https://github.com/cyrilleulmi/stv-bero-website/pull/1) | `main` | (bestehender, echter PR «Wave 1») | Stresstest: 294 Dateien, ca. 900 Segmente |

## Ergebnisse (Stand PoC)

**spongecoach#13**

* Quick wins → DTOs & Typen: `PlayerDetailDto`, `PlayerSummaryDto`, `PlayerUpdateRequest`, Feld in `Player`, `player.model.ts`
* Quick wins → Banale REST-Aufrufe: `PlayerApiService.setJerseyNumber`
* Flow 1: `update → validateJerseyNumber → isJerseyNumberTaken`
* Flow 2: `saveJerseyNumber → setJerseyNumber`
* Einzelne Änderungen: Migration, Template, Klassenfelder in `PlayerView`, Konstante in `PlayerResource`
* Zwei Orte: `PlayerApiService.setJerseyNumber` (Quick wins › Banale REST-Aufrufe **und** Flow 2) braucht zwei Oks
* Tests (5 Testfälle):
  * `PlayerResourceTest › savesJerseyNumber` / `rejectsJerseyNumberAboveMax` → Komponente `PlayerResource.java`; `update` direkt, `validateJerseyNumber` und `Player.isJerseyNumberTaken` indirekt
  * `PlayerResourceTest › detectsNumberWornByTeammate` → `Player.isJerseyNumberTaken` direkt (Komponenten `PlayerResource.java` per Name, `Player` per Aufruf)
  * `PlayerView › jersey number › …` (2 Fälle) → Komponente `player-view.ts`; `saveJerseyNumber` direkt, `PlayerApiService.setJerseyNumber` indirekt

* Dritter Commit «Clear jersey number; validation of the number range» (Abdeckungsansicht, drei Zustände):
  * **Ohne Test:** im Frontend `PlayerApiService.clearJerseyNumber` sowie `PlayerView.clearJerseyNumber` (Verzweigungen: nichts zu entfernen, Bestätigung abgelehnt); kein Test erreicht sie. Das Backend-Gegenstück `PlayerResource.clearJerseyNumber` war hier ebenfalls ohne Test, wird seit dem vierten Commit aber direkt getestet (siehe unten)
  * **Nur indirekt getestet:** `PlayerResource.validateJerseyNumber` und das neue `isInRange` (zwei Verzweigungen), nur über `update` erreicht (`rejectsJerseyNumberAboveMax`, `savesJerseyNumber`); ebenso `Player.isJerseyNumberTaken` und im Frontend `PlayerApiService.setJerseyNumber` (über `saveJerseyNumber`)
  * **Direkt getestet:** `PlayerResource.update`, `Player.isJerseyNumberTaken` (`detectsNumberWornByTeammate`, direkt und zusätzlich indirekt) und `PlayerView.saveJerseyNumber`

* Vierter Commit «Rework player tests (SmartCodeReview test data: spec diff)»:
  * **Abdeckung:** `PlayerResource.clearJerseyNumber` wechselt von «ohne Test» zu «direkt getestet» (`ClearJerseyNumber.removesTheNumber`, `isANoOpWithoutNumber`); `PlayerView.clearJerseyNumber` und `PlayerApiService.clearJerseyNumber` bleiben «ohne Test»
  * **Spezifikations-Diff** (Zustände neu / geändert / umbenannt / entfernt / unverändert), `player-view.spec.ts` (existiert auf `master`):
    * **umbenannt:** «shows a not-found page for an unknown Player» → «shows the not-found page for an unknown Player» (Rumpf identisch)
    * **geändert:** «applies a rating click immediately and rolls it back if the save fails» (zusätzliche Assertion am Ende); seit dem fünften Commit zusätzlich «saves the Player’s whole Development goal set …», «uploads the painting as a PNG, …», «keeps the painter open with an error …» und «removes the Avatar and shows the initials again» (siehe unten)
    * **entfernt:** «creates a Player skill from the player screen and rates it on the Player straight away»
    * **unverändert:** «shows the Player’s name, avatar, …», «shows a Player someone else read-only, and themselves editable» sowie «opens the painter from the Avatar» (Gruppe `Avatar painter`)
    * **neu:** Gruppe `jersey number` mit «saves a new jersey number», «explains a number that a teammate already wears» und der verschachtelten Gruppe `invalid input` mit «ignores text that is not a number» und «does not save the number the player already wears»
  * `PlayerResourceTest.java` (im PR neu angelegt, daher alles **neu**): `PlayerResourceTest › savesJerseyNumber`, `rejectsJerseyNumberAboveMax`, `detectsNumberWornByTeammate` sowie die verschachtelte Klasse `PlayerResourceTest › ClearJerseyNumber › removesTheNumber` und `isANoOpWithoutNumber`; geändert/umbenannt/entfernt/unverändert gibt es in der Java-Datei nicht, weil es sie auf `master` nicht gibt

* Fünfter Commit «Adjust player test expectations (SmartCodeReview test data: changed expectations)»: nur Tests, die auf `master` existieren und bisher unverändert waren. Erwartete **geänderte Erwartungen** pro Test:
  * `player-view.spec.ts › PlayerView › Avatar painter › uploads the painting as a PNG, closes the painter and shows the new Avatar` → **Erwartungswert geändert:** `expect(put.request.headers.get('Content-Type')).toBe('image/png');` → `toBe('image/jpeg');`
  * `… › Avatar painter › removes the Avatar and shows the initials again` → **Assertion entfernt:** `expect(el.querySelector('.page-head img')).toBeNull();` (der Test behält weitere Assertions)
  * `… › PlayerView › saves the Player’s whole Development goal set when a goal chip is toggled` → **abgeschwächt:** `expect(new Set(put.request.body.developmentGoalIds)).toEqual(new Set(['pg-1', 'pg-2']));` → `expect(new Set(put.request.body.developmentGoalIds)).toBeTruthy();`
  * `… › Avatar painter › keeps the painter open with an error when the upload fails` → **deaktiviert:** `it(` → `xit(`
  * `GreetingResourceTest › testHelloEndpoint` (Java, einziger Test der Datei) → **deaktiviert:** neue Annotation `@Disabled("greeting text is being reworked")`
  * Weiterhin **unverändert:** «shows the Player’s name, avatar, …», «shows a Player someone else read-only, and themselves editable», «opens the painter from the Avatar»; die Tests aus dem vierten Commit (umbenannt / geändert / entfernt) blieben unangetastet, ebenso die neuen `jersey number`-Tests (neu, daher ohne Vergleichszustand)

* Sechster Commit «More jersey number tests (SmartCodeReview test data: test profile and case matrix)» (spongecoach `eec1cd1`; neue Test-Abhängigkeit `io.quarkus:quarkus-junit-mockito` in `backend/build.gradle.kts`). `validateJerseyNumber`/`isInRange` werden weiterhin nur indirekt über `update` bzw. HTTP getestet, `PlayerView.clearJerseyNumber` bleibt ohne Test; die Tests aus Commit 4 und 5 sind unangetastet. Alle neuen Tests sind **neu** im Spezifikations-Diff (neue Java-Dateien; in `player-view.spec.ts` neue Tests in `jersey number › invalid input`).
  * **Test-Steckbrief** (Fall / Ebene / Assertions / Mocks / Fälle):
    * `JerseyNumberValidationTest › asksAccessBeforeSavingTheNumber` → Normalfall; Integration (`@QuarkusTest`, `@TestTransaction`, `resource.update` direkt); Assertions: Interaktion (`verify(access).requireSelf`) und Gleichheit; Mocks: `@InjectMock Access`; keine parametrisierten Fälle; übt `PlayerResource.update` aus
    * `… › keepsTheNumberWhenAccessIsDenied` → Fehlerfall (erwartet Exception: `assertThrows(AccessDeniedException.class, …)`); Integration; Assertions: Exception, Existenz (`assertNull`); Mocks: `@InjectMock Access` mit `when(access.isCoachOf(any()))` und `doThrow(…).when(access).requireSelf(…)`
    * `… › rejectsNumbersOutsideTheRange` → Fehlerfall (Name «rejects…», `assertThrows(BadRequestException.class, …)`); Integration; Assertions: Exception, Gleichheit (Fehlermeldung); Mocks: `@InjectMock Access` (Klassenfeld, nur Stub); **parametrisiert:** `@ParameterizedTest` mit `@ValueSource(ints = {0, 100, 150})`, 3 Fälle
    * `JerseyNumberApiTest › setsJerseyNumberSeven`, `setsJerseyNumberTwentyThree`, `storesTheLuckyNumber` → Normalfall; Integration (`@QuarkusTest`, RestAssured `given()…put(…)`); Assertions: HTTP-Status (`statusCode(200)`) und Gleichheit (`body("jerseyNumber", equalTo(…))`); keine Mocks; nicht parametrisiert
    * `… › rejectsJerseyNumberZero`, `rejectsJerseyNumberOneHundredFifty` → Fehlerfall (HTTP 4xx: `statusCode(400)`, Name «rejects…»); Integration (RestAssured); Assertion: HTTP-Status; keine Mocks
    * `player-view.spec.ts › … › invalid input › ignores an empty text` und `ignores a number written as a word` → Randfall bzw. Fehlerfall (Name «empty»); Unit (`HttpTestingController`, `expectNone`); Assertion: Interaktion/Existenz (keine Anfrage); Mocks: `HttpTestingController`
    * `… › shows the message for the typed text %s (server answers %i)` → `it.each` mit 3 Zeilen; Fehlerfall (HTTP 400/409, Fehlermeldung im Text); Unit; Assertions: Gleichheit/Inhalt (`toContain`) und HTTP-Antwort über `HttpTestingController`
  * **Fallmatrix Backend** (`JerseyNumberApiTest`, 5 Tests mit identischem Rumpf `putJerseyNumber(N).then().statusCode(S)…`, Ziel: `PUT /api/players/{id}`):

    | Eingabe (`jerseyNumber`) | Erwartet | Test |
    |---|---|---|
    | 7 | 200, `jerseyNumber` = 7 | `setsJerseyNumberSeven` |
    | 23 | 200, `jerseyNumber` = 23 | `setsJerseyNumberTwentyThree` |
    | 0 | 400 | `rejectsJerseyNumberZero` |
    | 150 | 400 | `rejectsJerseyNumberOneHundredFifty` |
    | 7 | 200, `jerseyNumber` = 7 | `storesTheLuckyNumber` |

    * **Doppelter Fall:** `setsJerseyNumberSeven` und `storesTheLuckyNumber` prüfen den identischen Fall (Eingabe 7 → 200) unter verschiedenen Namen
    * **Abgedeckte Werte:** 0, 7, 23, 150 (dazu kommen aus dem parametrisierten Test 0, 100, 150 und aus `savesJerseyNumber` 7, 100); **nie getestet** sind die Grenzen des Codes 1 und 99 (`isInRange`: `< 1`, `<= 99`)
  * **Fallmatrix Backend, parametrisiert** (`rejectsNumbersOutsideTheRange`): 0 → `BadRequestException`, 100 → `BadRequestException`, 150 → `BadRequestException` (Meldung «jersey number must be between 1 and 99»); auch hier fehlen 1 und 99
  * **Fallmatrix Frontend** (`jersey number › invalid input`, Ziel `saveJerseyNumber`):
    * Gruppe der drei Tests mit gleichem Rumpf (`saveJerseyNumber(<Text>)`, dann `expectNone`): `'abc'` → keine Anfrage (bestehender Test «ignores text that is not a number»), `''` → keine Anfrage («ignores an empty text»), `'sieben'` → keine Anfrage («ignores a number written as a word»); die Eingaben sind verschieden, also **kein** doppelter Fall
    * `it.each`-Tabelle (Eingabe → Erwartet): `'-3'` → HTTP 400, «Trikotnummer konnte nicht gespeichert werden.»; `'150'` → HTTP 400, dieselbe Meldung; `'23'` → HTTP 409, «Die Nummer 23 trägt schon jemand im Team.»
    * Abgedeckte Werte: `'abc'`, `''`, `'sieben'`, `'-3'`, `'150'`, `'23'` (sowie `'7'` in den übrigen Tests); nie mit `'1'` oder `'99'` getestet

* Siebter Commit «Jersey number in the player list; stubbed API test (SmartCodeReview test data: existing tests, mock boundaries)» (spongecoach `998f612`; weiterer Commit `a8e2f34`, siehe A). Die Tests aus Commit 2 bis 6 sind unangetastet; `PlayerView.clearJerseyNumber` bleibt ohne Test, `validateJerseyNumber`/`isInRange` werden nicht direkt aufgerufen.
  * **A) Bestehende Tests nachladen:** geändert wird die Produktivdatei `frontend/src/app/players/player-list/player-list.ts` (Template `player-list.html` zeigt `label(player)` statt `player.name`): neue Funktion `byJerseyNumber` (Sortierung nach Trikotnummer, Spieler ohne Nummer am Ende), neue Methode `PlayerList.label` («#7 Carmela») und geänderte `PlayerList.ngOnInit` (sortiert die geladenen Spieler). Die Testdatei `player-list.spec.ts` liegt auf `master` und wird vom PR **nicht** berührt; sie wird über die Namenskonvention `X.ts` → `X.spec.ts` nachgeladen. Erwartet:
    * Geladen wird `player-list.spec.ts` (`PlayerList › lists every Player with avatar, name and Line badges, each linking to the player screen` und `… › links a Line badge to the line screen with that Line selected`), **verknüpft wird jedoch nichts**: beide Tests rendern nur die Komponente, kein Test nennt `ngOnInit`, `label` oder `byJerseyNumber` beim Namen (Lebenszyklus-Hooks sind keine Aufrufziele, Template-Verwendung zählt nicht)
    * Erwarteter Status der geänderten Segmente `PlayerList.ngOnInit`, `PlayerList.label`, `byJerseyNumber`: **«ohne Test»**; dokumentierte Grenze der statischen Verknüpfung (Verknüpfung über Namensreferenzen), kein Fehler
  * **A, verlässliches Beispiel (achter Commit «Own-profile check for editing the jersey number (SmartCodeReview test data: existing test calling a changed function by name)», spongecoach `a8e2f34`):** geändert wird `frontend/src/app/auth/current-user.service.ts`: `CurrentUserService.canEditPlayer` nutzt neu den privaten Helfer `isSelf` (Coach darf jeden Spieler bearbeiten, ein Spieler nur sich selbst, inklusive Trikotnummer). Die Testdatei `frontend/src/app/auth/current-user.service.spec.ts` liegt auf `master` und bleibt unangetastet. Erwartet:
    * Geladen (Konvention `X.ts` → `X.spec.ts`) und verknüpft: `CurrentUserService › lets a coach edit everything` (Zeile `expect(service.canEditPlayer('any-player')).toBe(true);`) und `CurrentUserService › lets a Player edit only their own Lines and themselves` (Zeilen `expect(service.canEditPlayer('p-carmela')).toBe(true);` und `expect(service.canEditPlayer('p-rahel')).toBe(false);`) → `canEditPlayer` direkt
    * Erwarteter Status von `CurrentUserService.canEditPlayer` und `isSelf`: **«Nur durch bestehende Tests»** (`canEditPlayer` direkt genannt, `isSelf` indirekt, da `canEditPlayer` es im selben File aufruft)
  * **B) Mock-Grenzen im Flow:** neue Gruppe `jersey number with a stubbed API › hands the typed number to the API and shows the saved one` in `player-view.spec.ts`: `PlayerApiService` wird per `{ provide: PlayerApiService, useValue: api }` ersetzt (Jest-Mocks `jest.fn`; das Projekt nutzt Jest, kein Jasmine), `setJerseyNumber` liefert ein `of(…)`, geprüft wird `expect(api.setJerseyNumber).toHaveBeenCalledWith('p-1', 11)`. Erwartet:
    * **Warnung:** der Test mockt `PlayerApiService.setJerseyNumber`, eine Funktion, die dieser PR ändert (der Mock friert das alte Verhalten ein)
    * **Flow `saveJerseyNumber → setJerseyNumber ⇢ PUT /api/players/{} ⇢ update → validateJerseyNumber → isJerseyNumberTaken`:** `saveJerseyNumber` **echt ausgeführt** (Frontend-Tests rufen es direkt auf); `setJerseyNumber` **nur gemockt** im Test «hands the typed number …», aber **echt** in den `HttpTestingController`-Tests (`saves a new jersey number`, `invalid input › …`) – gemischt eingefärbt, mit Warnung; der REST-Sprung ins Backend sowie `update` und `validateJerseyNumber` und `isJerseyNumberTaken` werden von Frontend-Tests **nicht erreicht** (die Backend-Tests erreichen sie über `PlayerResourceTest`, `JerseyNumberApiTest` usw. wie bisher)
    * Weiterhin ohne Test: `PlayerView.clearJerseyNumber`, `PlayerApiService.clearJerseyNumber`

* Commits neun bis vierzehn (spongecoach, Branch `test-mr/scr-jersey-number`; alle früheren Zustände bleiben unverändert, auch `PlayerView.clearJerseyNumber` ohne Test und `validateJerseyNumber`/`isInRange` nur indirekt):
  * **A) Fall-/Effekt-Prüfung** (`85e20f8` «Record when the jersey number was last changed»): `PlayerResource.update` hat neu zwei Effekte: setzt `player.jerseyNumber` **und** `player.jerseyNumberChangedAt = Instant.now()` (neues Feld in `Player`, Migration `V17__player_jersey_number_changed_at.sql`). Die bestehenden Tests (`PlayerResourceTest › savesJerseyNumber`, `JerseyNumberValidationTest › asksAccessBeforeSavingTheNumber`, `JerseyNumberApiTest`) prüfen nur `jerseyNumber`. Erwartet: Effekt `jerseyNumberChangedAt` von `update` **ungeprüft**; weiterhin ungeprüft: Entscheidungspunkte `isInRange` mit den Grenzen 1 und 99 sowie `PlayerResource.clearJerseyNumber` wirft `NotFoundException` (404) bei unbekanntem Spieler, ohne dass ein Test es erwartet
  * **B) Erwartungsregeln** (`451b88d` «Only a coach may clear a jersey number»): das Projekt nutzt keine Annotationen wie `@RolesAllowed`, sondern den Dienst `Access`; `PlayerResource.clearJerseyNumber` ruft neu `access.requireCoach(player.team)` statt `access.requireSelf(player)` auf (Erwartungsregel greift also auf den **Aufruf**). Erwartet: Regel «Zugriffsprüfung geändert → Test auf 401/403 (`AccessDeniedException`, `statusCode(403)`)» **nicht erfüllt**: `PlayerResourceTest › ClearJerseyNumber` ruft die Methode direkt auf und prüft keine Verweigerung; ein HTTP-Test für `DELETE /api/players/{id}/jersey-number` fehlt ganz
  * **C) Test-Smells** (`f8e01b6`, neue Dateien `frontend/src/app/players/player-view/player-view.smells.spec.ts` und `backend/src/test/java/com/spongecoach/api/JerseyNumberSmellsTest.java`; alle Tests darin sind neu). Erwartet:
    * **Ohne Assertion:** `PlayerView jersey number (smells) › saves the typed jersey number` und `JerseyNumberSmellsTest › updatesTheJerseyNumber`
    * **Nur schwache Assertion:** `… › shows the jersey number` (`toBeTruthy()`) und `JerseyNumberSmellsTest › returnsTheUpdatedPlayer` (`assertNotNull`)
    * **Fokussiert:** `… › shows a hint while the Player has no jersey number` (`fit(`; in Jest überspringt es die übrigen Tests der Datei)
    * **Wartezeit:** `… › shows the saved number after a short wait` (`setTimeout`) und `JerseyNumberSmellsTest › waitsUntilTheNumberIsStored` (`Thread.sleep(2000)`)
    * **Mockt die zu testende Einheit:** `… › hands the typed number to saveJerseyNumber` (`jest.spyOn(view, 'saveJerseyNumber')`, danach aufgerufen) und `JerseyNumberSmellsTest › updatesThroughAMockedResource` (Mockito-Mock von `PlayerResource`, ruft `update` darauf auf)
  * **D) Setup-/Fixture-Einfluss** (`a3a2363`): die gemeinsame Fixture `CARMELA` in `player-view.spec.ts` hat neu `jerseyNumber: 9`. Erwartet: «Testdaten geändert: `CARMELA` wirkt auf 17 Tests, davon 3 unverändert» – betroffen sind alle Tests der Datei, die `CARMELA` über `render()` (Default-Parameter), `{ ...CARMELA, … }` oder das `api`-Objekt der Suite `jersey number with a stubbed API` nutzen. Unverändert gegenüber der Basis des PRs sind nur «shows the Player’s name, avatar, …», «opens the painter from the Avatar» und «shows a Player someone else read-only, …» (Markierung «Setup geändert»); die übrigen 14 haben frühere Commits des PRs schon geändert oder neu angelegt. Die übrigen geänderten Hilfen (`putJerseyNumber`, `newPlayer`, `playerWithNumber`, Setup in `JerseyNumberApiTest`) wirken nur auf neue Tests und erscheinen deshalb ohne Warnung
  * **E) HTTP-Tests:** nichts Neues; `JerseyNumberApiTest` (RestAssured `put("/api/players/{id}")` → `PlayerResource.update`) und `HttpTestingController.expectOne('/api/players/p-1')` bleiben die HTTP-Tests
  * **F) Commit-Bezug** (in dieser Reihenfolge):
    * `9cb532b` «Fix jersey number rounding»: ändert nur Produktivcode (`PlayerView.saveJerseyNumber` rundet mit `Math.round(Number.parseFloat(value))` statt `parseInt`; `PlayerResource.validateJerseyNumber` nennt die Zahl in der Fehlermeldung), **kein Test geändert** → Erwartet: Commit «Produktivcode ohne Test»
    * `406522a` «fix tests»: ändert nur den Erwartungswert in `JerseyNumberValidationTest › rejectsNumbersOutsideTheRange` (`"jersey number must be between 1 and 99"` → `"jersey number " + jerseyNumber + " must be between 1 and 99"`), ein Test aus Commit 6 dieses PR, nachträglich in einem reinen Test-Commit angepasst → Erwartet: Commit «nur Tests», Erwartung nachträglich geändert (Test aus früherem Commit des PR)
  * **G) Neue Commits in einem angefangenen Review:** Vorbereitung am Stand `406522a`: alle Zeilen von `PlayerResource.java`, `Player.java` und `player-view.ts` ok (94 Zeilen), dazu `PlayerApiService.clearJerseyNumber` (N32–N35) nur am Ort `flows/flow-2`. Dann `1cc0359` «Name the lower jersey number bound»: fügt in `PlayerResource.java` oben `JERSEY_NUMBER_MIN` ein (alle Zeilen darunter rutschen um eins), ändert die geprüfte Zeile `if (jerseyNumber < 1)` und fügt in `player-api.service.ts` vor `clearJerseyNumber` die Methode `hasJerseyNumber` ein → Erwartet nach «Neu laden»: «97 Markierungen übernommen, 1 verworfen · 6 Zeilen neu oder geändert seit 406522a»; in `PlayerResource.java` 40 von 42 Zeilen ok, offen nur `N47` (neue Konstante) und `N226` (geänderte Zeile); die Markierung am Flow wandert auf N36–N39; «Neu seit letztem Review» in der Commit-Liste zeigt genau diese 6 Zeilen, `1cc0359` trägt «neu». Ein zweites «Neu laden» ändert nichts («keine neuen Commits»).

* Seit 0.4: **ein Flow über REST** `saveJerseyNumber → setJerseyNumber ⇢ PUT /api/players/{} ⇢ update → validateJerseyNumber → isJerseyNumberTaken`; Frontend-Kategorien *API-Anbindung* (`setJerseyNumber`), *Komponenten-Logik*, *Templates*; keine Architektur-Kategorien (geschichtet: `api` + `domain`, kein Ports & Adapters); Komponentendiagramm Frontend → API → Domäne mit gestrichelter REST-Kante.

**camperquiz#1**

* Flow: `renderPunkte → renderJokerButtons → canUseJoker / activateJoker`
* Flow: `confirmPunkte → applyJoker`
* Quick wins: README; Styles: CSS

**stv-bero-website#2**

* Quick wins: `payload-types.ts` (generiert), `Events`-Feld, `EventSummary`, `RegistrationStatus`, Imports
* Flow: `EventList → registrationStatus → CLOSING_SOON_MS` plus `DEADLINE_STYLE`, `formatDeadline`

**stv-bero-website#1:** Snapshot rund 15 s (194 Quelltexte), Analyse rund 5 s, 69 Flüsse, 20 Testfälle. Einzelne Flüsse sind bei so einem «ganze neue Website»-PR noch gross (bis 80 Schritte), siehe Annahme B4; 24 Blöcke liegen an mehreren Orten.

**Abfolge und Abspielen (FR-UI-22, -23)** – geprüft an gemergten PRs dieses Repos, weil sie Flüsse über mehrere Klassen mit mehrfachen Aufrufen enthalten:

* [smart-code-review#11](https://github.com/cyrilleulmi/smart-code-review/pull/11), Flow `resolve → resolveThread (+4)`: 3 Lebenslinien (`CodeBlock`, `Api`, `ReviewStore`), 7 Aufrufe. `Api.resolveThread` wird zweimal aufgerufen (Zeile 805 und aus `ReviewStore.resolveThread`, Zeile 1097) und steht beim zweiten Mal als «erneut»; `ReviewStore.samePr` zweimal aus `loadStatus` (Zeilen 1040 und 1041); `loadStatus` und `samePr` sind Schleifen auf der Lebenslinie von `ReviewStore`, mit verschachtelten Balken.
* smart-code-review#11, Flow `status → status → status`: Frontend → REST → Backend. Der Aufruf `Api.status` → `ReviewResource.status` ist gestrichelt und trägt `GET /prs/{}/{}/{}/{}/status`. Bereich «API» entfernen: ein Aufruf `Api.status` → `ReviewService.status`, «überbrückt».
* smart-code-review#11, Flow `approve → approve (+3)`: Die Aufrufstelle von `ReviewActions.approve` → `ReviewStore.approve` ist Zeile 225 (der Aufruf), nicht 223 (die eigene Deklaration; FR-ANA-27).
* Ganzes Repository (`#/github/cyrilleulmi/smart-code-review/0`), Flow `App → …`: 162 Aufrufe, 23 Lebenslinien – Liste und Köpfe bleiben beim Scrollen stehen, beim Abspielen bleibt der aktuelle Aufruf im Bild.
* Übersicht von smart-code-review#11 → Komponenten → «Abfolge» → `resolve → resolveThread (+4)`: `CodeBlock`, `ReviewStore` und `Api` bleiben, der Rest tritt zurück; der Punkt läuft `CodeBlock` → `Api`, `CodeBlock` → `ReviewStore`, `ReviewStore` → `Api`; die Aufrufe innerhalb von `ReviewStore` und `CodeBlock` lassen die jeweilige Komponente aufleuchten.

**Detail der Methoden (FR-UI-24, FR-ANA-28)** – an smart-code-review#11, Flow `resolve → resolveThread (+4)`:

* «Signatur», Ebene «Klassen + Methoden»: `resolve(thread: Thread): void`, `resolveThread(pr: PrKey, thread: string, …): Observable<Comment[]>` (gekürzt, der Tooltip zeigt die ganze Deklaration), `loadStatus(): void`.
* «Daten»: unter `resolve` steht `Thread { root: Comment, replies: Comment[] }`, unter `Api.resolveThread` stehen `PrKey { provider: string, owner: string, repo: string, number: number }` und `Comment { id: number, kind: 'review' | 'issue', path: string | null, +11 }`. `PrKey` und `Comment` sind in `api.ts` deklariert, `Thread` in `code-block.ts`.
* Ebene «Klassen» mit «Signatur» oder «Daten»: Der Knoten `CodeBlock` listet `resolve(…)` und `toggleThread(…)` zeilenweise, `ReviewStore` seine drei Methoden.
* «Abfolge» mit «Daten»: Die Zeilen mit Datenstrukturen sind höher, die Liste links bleibt Zeile für Zeile daneben; `CodeBlock` und `Api` stehen weiter auseinander, damit die Signatur Platz hat.
* Im Backend-Flow `approve → approve → requirePullRequest (+2)` (Java): `ReviewResource.approve(@PathParam("provider") String provider, …)` erscheint als `approve(provider: String, owner: String, …): PrStatus`, darunter die Records `ApprovalRequest { approved: boolean }` und `PrStatus` aus `Model.java` mit ihren Komponenten; `ReviewService.approve(PrRef ref, boolean approved)` gibt `Model.PrStatus` zurück und zeigt `PrRef` und `PrStatus` (der qualifizierte Name wird aufgelöst).

## Ports & Adapters

[thombergs/buckpal#41](https://github.com/thombergs/buckpal/pull/41) (öffentliches Beispielprojekt für Hexagonal Architecture, 47 Dateien, nur gelesen): erkannt über `adapter`, `application`, `application/domain`, `application/port`. Kategorien *Domäne* (Account, Activity, Money …), *Use Cases* (SendMoneyUseCase, GetAccountBalanceUseCase), *Application Layer* (SendMoneyService, LoadAccountPort …), *Adapter* (eingehend: SendMoneyController; ausgehend: AccountPersistenceAdapter, AccountMapper …). 38 Komponenten im Diagramm.

## GitLab

Für GitLab gibt es (noch) kein eigenes Konto mit Test-MRs. Getestet wurde **ohne Token** gegen öffentliche Merge Requests auf gitlab.com:

| MR | Ergebnis |
|---|---|
| [gitlab-org/gitlab-vscode-extension!3511](https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/merge_requests/3511) | TypeScript, 20 Dateien: Quick wins (Typen, Imports), 7 Flüsse, z. B. `parseHunk → lines → allLinesForNewSide → …`; 38 Testfälle, z. B. `MR discussion commands › cancelCommentInput › …` → `cancelCommentInput` direkt, `realComments` indirekt; 13 Blöcke an mehreren Orten |
| [gitlab-org/cli!4347](https://gitlab.com/gitlab-org/cli/-/merge_requests/4347) | Go, 5 Dateien: 4 Flüsse über zwei Pakete (`options.run` → `LocalConfigFile` → `LocalConfigDir` → `GitDir` …); `GitDir` und `revParseDir` liegen in allen 4 Flüssen; 5 Go-Testfälle, z. B. `Test_LocalConfigFile_HonoursAnExistingPerWorktreeFile` → `LocalConfigFile`, `GitDir` direkt, `LocalConfigDir`, `GitCommonDir` indirekt |

Nicht getestet (braucht Token): MR-Liste, Kommentieren. Mit Token: `GITLAB_TOKEN` setzen, Tool neu starten.

## Aufräumen

```bash
gh pr close 13 -R cyrilleulmi/spongecoach      --delete-branch
gh pr close 1  -R cyrilleulmi/camperquiz       --delete-branch
gh pr close 2  -R cyrilleulmi/stv-bero-website --delete-branch
```
