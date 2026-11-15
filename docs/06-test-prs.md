# Test-PRs

Für den PoC wurden in drei eigenen Repos **Draft-PRs** erstellt. Alle tragen **[TEST-MR]** im Titel, einen Warnhinweis in der Beschreibung und gehören **nicht gemergt**. Nach den Tests einfach schliessen und den Branch löschen (siehe unten).

| PR | Repo / Basis | Inhalt | Was es testet |
|---|---|---|---|
| [spongecoach#13](https://github.com/cyrilleulmi/spongecoach/pull/13) | `master` | Trikotnummer für Spieler: Migration, Entity, DTOs, Resource, Angular-Service, Komponente, Template, SCSS; zweiter Commit: `PlayerResourceTest.java` (JUnit) und Tests in `player-view.spec.ts` (Jasmine/Vitest); dritter Commit: Trikotnummer entfernen (`clearJerseyNumber` in Backend und Frontend, Hilfsfunktion `isInRange`), bewusst ohne eigene Tests; vierter Commit «Rework player tests»: Tests umgebaut (Spezifikations-Diff) und `clearJerseyNumber` im Backend getestet; fünfter Commit «Adjust player test expectations»: bestehende Tests (`player-view.spec.ts`, `GreetingResourceTest.java`) so angepasst, dass geänderte Erwartungen sichtbar werden; sechster Commit «More jersey number tests»: neue Testklassen `JerseyNumberValidationTest.java` und `JerseyNumberApiTest.java` (Mockito, RestAssured, `@ParameterizedTest`) sowie weitere Tests in `player-view.spec.ts` (Test-Steckbrief und Fallmatrix) | Fullstack Quarkus + Angular; Java- und TS-Symbole; DTO-/REST-Quick-wins; zwei Flüsse; Tests ↔ Code; Block an zwei Orten |
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

* Seit 0.4: **ein Flow über REST** `saveJerseyNumber → setJerseyNumber ⇢ PUT /api/players/{} ⇢ update → validateJerseyNumber → isJerseyNumberTaken`; Frontend-Kategorien *API-Anbindung* (`setJerseyNumber`), *Komponenten-Logik*, *Templates*; keine Architektur-Kategorien (geschichtet: `api` + `domain`, kein Ports & Adapters); Komponentendiagramm Frontend → API → Domäne mit gestrichelter REST-Kante.

**camperquiz#1**

* Flow: `renderPunkte → renderJokerButtons → canUseJoker / activateJoker`
* Flow: `confirmPunkte → applyJoker`
* Quick wins: README; Styles: CSS

**stv-bero-website#2**

* Quick wins: `payload-types.ts` (generiert), `Events`-Feld, `EventSummary`, `RegistrationStatus`, Imports
* Flow: `EventList → registrationStatus → CLOSING_SOON_MS` plus `DEADLINE_STYLE`, `formatDeadline`

**stv-bero-website#1:** Snapshot rund 15 s (194 Quelltexte), Analyse rund 5 s, 69 Flüsse, 20 Testfälle. Einzelne Flüsse sind bei so einem «ganze neue Website»-PR noch gross (bis 80 Schritte), siehe Annahme B4; 24 Blöcke liegen an mehreren Orten.

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
