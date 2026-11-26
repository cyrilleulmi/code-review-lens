# Persistenz und Zusammenarbeit mit Agenten

Alles, was SmartCodeReview lokal weiss, liegt als **lesbare Dateien** in einem Verzeichnis. Es gibt keine Datenbank und keinen versteckten Zustand: was in den Dateien steht, zeigt das UI.

## Datenverzeichnis

| Betrieb | Pfad |
|---|---|
| Lokal (Default) | `~/.smart-code-review/` (Windows: `C:\Users\<du>\.smart-code-review\`) |
| Anders | Env `SCR_DATA_DIR` oder Property `scr.data-dir` |
| Docker Compose | `./data/` im Repo (Volume nach `/data`) |

```
<data>/
├── AGENTS.md                 Kurzanleitung für Agenten (wird beim Start geschrieben)
├── rules.default.json        Mitgelieferte Regeln (wird beim Start überschrieben, nur zum Nachschlagen)
├── rules.json                OPTIONAL: eigene Regeln; hat Vorrang. Änderungen werden automatisch übernommen.
├── settings.json             Ausgeschaltete Kategorien {"disabledCategories": [...]} (vom UI geschrieben)
├── connections.json          OPTIONAL: Verbindungen des Bereichs «Verbindungen» {"connections": {"gitlab": {"url", "token", "cookie"}, "gitlab~git.example.com": {…}}};
│                             null = Startkonfiguration. Enthält Geheimnisse im Klartext: nicht lesen, kopieren oder ausgeben
└── reviews/
    └── <provider>/<owner>/<repo>/<number>/      (provider: github | gitlab, weitere Verbindungen github~host | gitlab~host, Port als host_port; GitLab-Gruppen: gruppe~untergruppe; Nummer 0 = ganzes Repository)
        ├── snapshot.json     PR-Metadaten + Diff (eingefroren)
        ├── sources/<pfad>    Quelltext der neuen Version (nur analysierte Dateien)
        ├── sources-base/<pfad>  Alte Version (Basis-Commit) geänderter Testdateien, unter dem alten Pfad (Spec-Diff)
        ├── sources-related/<pfad>  Bestehende, unveränderte Testdateien (PR-Stand), die den geänderten Code wohl testen
        ├── related.json      Welche bestehenden Testdateien ausgewählt wurden und warum (Bestehende Tests)
        ├── structure.json    Ordner und Dateipfade des Repos am PR-Stand (Architektur, bestehende Tests; Cache)
        ├── analysis.json     Segmente, Kategorien, Flüsse, Komponenten (abgeleitet, jederzeit neu berechenbar)
        ├── review.json       ◀ DEINE MARKIERUNGEN (die einzige Datei mit «echtem» Zustand)
        ├── comments.json     Letzter Abruf der GitHub-Kommentare (Cache)
        ├── commits.json      Commits des PRs und welcher Commit welche Zeile geändert hat (abgeleitet, Cache)
        └── blame/<pfad>.json Git-Blame einer Datei am PR-Stand (Cache, beim Annotieren geholt)
```

Alle Dateien sind UTF-8, eingerückt und werden **atomar** geschrieben (temporäre Datei + Move). Das Backend liest sie **bei jedem Request neu**; das UI holt den Status neu, sobald das Browserfenster den Fokus bekommt.

## `review.json`

```json
{
  "schemaVersion": 1,
  "pr": "github/cyrilleulmi/spongecoach/13",
  "headSha": "8d7ba2e4…",
  "ok": {
    "frontend/src/app/players/player.model.ts": ["N9", "N10", "N11"],
    "backend/src/main/java/…/PlayerResource.java": ["N75", "N76", "O12"]
  },
  "okAt": {
    "quick-wins/banale-rest-aufrufe": {
      "frontend/src/app/players/player-api.service.ts": ["N29"]
    }
  },
  "log": [
    { "at": "2026-11-13T09:33:06Z", "by": "agent:test", "action": "ok", "scope": "group:quick-wins/dtos-&-typen", "count": 3 },
    { "at": "2026-11-15T18:28:44Z", "by": "system", "action": "carry", "scope": "reload:406522a..1cc0359", "count": 97 }
  ],
  "reload": {
    "fromHeadSha": "406522a…", "toHeadSha": "1cc0359…", "at": "2026-11-15T18:28:44Z", "kept": 97, "dropped": 1,
    "newLines": { "backend/src/main/java/…/PlayerResource.java": ["N47", "N226"] }
  }
}
```

* **Zeilenschlüssel:** `N<zeile>` = Zeile in der **neuen** Datei (hinzugefügt), `O<zeile>` = Zeile in der **alten** Datei (gelöscht). Nur geänderte Zeilen zählen.
* `ok` ist pro Datei eine sortierte Liste der Zeilen, die **überall** ok sind. Was weder hier noch in `okAt` steht, ist nicht ok.
* `okAt` (Ort → Datei → Zeilen) hält Zeilen, die erst an **einem Teil** ihrer Orte ok sind. Die Orte einer Zeile stehen in `analysis.json` → `segments[].places`. Sobald eine Zeile an allen Orten ok ist, wandert sie nach `ok`. Zeilen mit nur einem Ort stehen immer direkt in `ok`. Eine Zeile, die in `okAt` steht, zeigt das UI als «halb akzeptiert» (grün, abgeleitet, nicht gespeichert); eine Zeile in `ok` ist überall akzeptiert (blau).
* `log` ist ein Protokoll (max. 500 Einträge), damit nachvollziehbar ist, wer was markiert hat. `by` ist `ui`, `agent:<name>` oder `system` (`action: carry` beim Übertragen der Markierungen).
* **Neue Commits:** Die Zeilenschlüssel gelten nur für den Snapshot in `headSha`. Bringt «Neu laden» einen neuen Head (oder eine neue Basis nach einem Rebase), überträgt das Backend die Markierungen: Pro Datei werden die geänderten Zeilen des alten und des neuen Snapshots nach Inhalt und Reihenfolge gepaart (hinzugefügte und gelöschte getrennt, wie ein Diff). Eine Markierung wandert nur mit einer **unveränderten** Zeile mit; Markierungen auf geänderten oder verschwundenen Zeilen fallen weg, neue Zeilen sind offen. Zeilen ohne eigenen Inhalt (`}`, Leerzeilen) wandern nur zusammen mit einer echten Nachbarzeile. Orte in `okAt` bleiben bei Gruppen dieselben (ihre ID kommt vom Namen); Flows sind nach Reihenfolge nummeriert und werden über ihren Einstiegspunkt wiedererkannt. Umbenannte Dateien werden über `previousPath` gefunden.
* `reload` (fehlt vor dem ersten solchen Neuladen) hält fest, was dabei geschah: `kept` / `dropped` = Zeilen, deren Markierung übernommen bzw. verworfen wurde, `newLines` (Datei → Zeilen) = neu oder geändert seit `fromHeadSha`, dazu noch offene aus früheren Neuladungen. Das UI filtert damit «Neu seit letztem Review». Agenten lassen `reload` beim Schreiben stehen.

## `commits.json`

```json
{
  "version": 1,
  "headSha": "b4461ff2…",
  "commits": [{ "sha": "76ce6d0d…", "title": "Flow connectors: one lane per connection", "author": "Cyrille",
                "date": "2026-11-13T16:18:00Z", "parents": ["69f7bd1f…"], "additions": 68, "deletions": 22, "files": ["…"] }],
  "lines": { "frontend/src/app/flow-view.ts": { "N186": "76ce6d0d…", "O116": "69f7bd1f…" } },
  "mergedVia": { "<sha eines Commits aus einem gemergten Seitenzweig>": "<sha des Merge-Commits>" },
  "findings": [{ "kind": "expectation-later", "level": "warn", "sha": "406522ac…", "title": "fix tests",
                 "path": "backend/src/test/java/…/JerseyNumberValidationTest.java", "lineKey": "N62",
                 "segmentId": "s37", "testSegmentId": "s37", "detail": "Test geschrieben in eec1cd1 …" }]
}
```

* `commits` stehen in Reihenfolge, die ältesten zuerst.
* `lines` ordnet die Zeilenschlüssel des PR-Diffs (dieselben wie in `lineKeys`) einem Commit zu. Hinzugefügte Zeilen gehören zum Commit, der sie zuletzt geschrieben hat, gelöschte Zeilen zu dem, der sie entfernt hat. Zeilen ohne sichere Zuordnung fehlen.
* `findings` (Commit-Bezug der Tests): was die Reihenfolge der Commits über die Tests sagt – `expectation-later` (eine Assertion eines in diesem PR geschriebenen Tests wurde in einem späteren Commit geändert; `warn`, wenn dieser nur Tests ändert oder «fix tests» heisst), `fix-without-test` (Fix-Commit ändert Code, aber keinen Test), `logic-without-test` (Info: Commit ändert testbaren Code ohne Test, und kein späterer Commit ändert einen Test dafür). `sha`/`title` = der Commit, `path`/`lineKey` = wo es sich zeigt, `testSegmentId` = der Test. `null` in Dateien älterer Versionen, leer für das ganze Repository (Abschnitt 7a in [05-analyse.md](05-analyse.md)).
* Die Zuordnung wird neu berechnet, wenn sich `headSha` oder der Algorithmus (`version`) ändert. `findings` werden bei jedem Abruf aus der Zuordnung und der aktuellen `analysis.json` neu bestimmt und bei einer Änderung zurückgeschrieben. Die Datei ist abgeleitet und kann gelöscht werden.

## `analysis.json` (Auszug)

```json
{
  "segments": [{
    "id": "s3", "path": "…/PlayerResource.java", "kind": "symbol",
    "symbol": "PlayerResource.validateJerseyNumber", "symbolKind": "method", "startLine": 195, "endLine": 203,
    "category": "logic", "group": "…/PlayerResource.java", "ruleId": null, "reason": "Teil eines Datenflusses",
    "lineKeys": ["N195", "N196", "…"],
    "places": ["flows/flow-1"],
    "testedBy": ["s21", "s22"],
    "lines": [{ "type": "add", "newLine": 196, "key": "N196", "text": "…", "own": true, "inDiff": true,
                "refs": [{ "segmentId": "s9", "symbol": "Player.isJerseyNumberTaken" }] }]
  }],
  "categories": [{ "id": "quick-wins", "label": "Quick wins", "groups": [{ "id": "quick-wins/übersetzungen", "segmentIds": ["s4"] }] }],
  "flows": [{ "id": "flow-1", "title": "update → validateJerseyNumber → isJerseyNumberTaken",
              "steps": [{ "segmentId": "s2", "order": 1, "depth": 0, "parentSegmentId": null }],
              "edges": [{ "from": "s2", "to": "s3", "line": 76, "via": "validateJerseyNumber" }] }],
  "tests": [{ "segmentId": "s21", "name": "PlayerResourceTest › savesJerseyNumber", "path": "…/PlayerResourceTest.java",
              "subjects": [{ "name": "PlayerResource.java", "path": "…/PlayerResource.java", "inPr": true, "how": "name" }],
              "covers": [{ "segmentId": "s2", "direct": true, "via": null, "line": 28 },
                         { "segmentId": "s3", "direct": false, "via": "s2", "line": 28 }] }]
}
```

* `places`: alle Gruppen (`categories[].groups[].id`), die den Block zeigen. Mehr als ein Ort = mehrere Oks nötig. Orte in Kategorien aus `settings.json` → `disabledCategories` zählen nicht.
* `layer` (`domain` | `application` | `usecase` | `adapter` | null) und `frontend` (true/false) pro Segment; `architecture.style` = `hexagonal`, wenn das Repo Ports & Adapters nutzt (`evidence` = Ordner).
* `flows[].edges[].kind`: `call` oder `http` (dann `via` = `PUT /api/players/{}`). `line`: die Aufrufstelle, die das UI zeigt (erster Verweis auf einer geänderten Zeile, sonst der erste); `lines`: alle Zeilen des Aufrufers, die das Ziel aufrufen, aufsteigend – die Reihenfolge der Aufrufe (fehlt in Analysen vor `Analyzer.VERSION` 30).
* `components[]` (`id`, `name`, `paths`, `area`, `segmentIds`) und `componentEdges[]` (`from`, `to`, `calls`, `http`): das Komponentendiagramm.
* `tests[]`: pro geändertem Testfall die getesteten Komponenten (`how`: `name` = Namenskonvention, `call` = direkt aufgerufen, `http` = per HTTP-Anfrage an einen Endpunkt darin) und die erreichten Segmente (`direct`, sonst `via` = das Segment, über das es erreicht wird; `line` = Aufrufstelle im Test; `mocked` = der Test mockt die Abhängigkeit, zu der es gehört – nur der Mock läuft; `http` = der Weg beginnt mit einer echten HTTP-Anfrage des Tests, `endpoint` = beim direkt erreichten Endpunkt die Anfrage, z. B. `PUT /api/players/{}`; Abschnitt 5m in [05-analyse.md](05-analyse.md)). `testedBy` ist die Rückrichtung (ohne gemockte). `smells[]` (`kind`, `label`, `line`, `code`, `hint`): Test-Smells – Hinweise, dass der Test weniger wert ist, als er aussieht (`no-assertion`, `weak-only`, `focused`, `sleep`, `mocks-subject`, `disabled` für neue Tests); leer, wenn keine (Abschnitt 5j in [05-analyse.md](05-analyse.md)).
* `coverage[].findings[]` (`kind` `exception`/`boundary`/`effect`/`branches`, `line`, `code`, `label`, `subject`, `checked`, `checkedBy`, `covered`, `missing`): Fall- und Effekt-Abgleich – was der Code kann (Fehlerausgänge, Grenzen, Wirkungen) gegen das, was die Tests prüfen, die ihn wirklich erreichen; `caseMatrices[].boundaries[]` (`segmentId`, `subject`, `label`, `values`, `missing`): Grenzen im Code, den die Tests einer Fallmatrix erreichen (Abschnitt 5h in [05-analyse.md](05-analyse.md)).
* `ruleChecks[]` (`ruleId`, `label`, `segmentId`, `line`, `code`, `trigger`, `met`, `metBy`, `tests`, `hint`): Erwartungs-Regeln – für jede Regel aus `testRules`, die auf ein geändertes Segment greift (z. B. geänderte Berechtigung, neuer Endpunkt), ob ein Test der erwarteten Form existiert; leer für das ganze Repository. Ein Test, der einen geänderten Endpunkt über HTTP aufruft, erreicht ihn wie über einen Aufruf (Abschnitte 5i und 5m in [05-analyse.md](05-analyse.md)).
* `setupImpacts[]` (`segmentId`, `kind` `setup`/`fixture`/`helper`, `name`, `line`, `affected[]` mit `path`, `name`, `line`, `segmentId`, `status`, `existing`; `unchangedCount`): Wirkung von Setup und Testdaten – geänderte Setup-Blöcke, Fixtures und Testhilfen mit den Tests, auf die sie wirken, auch unveränderten; leer für das ganze Repository (Abschnitt 5k in [05-analyse.md](05-analyse.md)).
* `mockWarnings[]` (`test`, `testName`, `path`, `line`, `segmentId`, `member`, `collaborator`): Tests, die eine geänderte Funktion mocken und beim Namen stubben; `flowCoverage[]` (`flowId`, `steps[]` mit `status` `tested`/`mocked`/`none`, `edges[]` mit `tested`/`separate`/`partial`/`none`, bei REST-Verbindungen dazu `clientTests` und `serverTests` – die beiden Seiten des Vertrags): was die Tests in jedem Flow wirklich ausführen (Mock-Grenzen, Abschnitt 5g, und HTTP-Tests, Abschnitt 5m in [05-analyse.md](05-analyse.md)).
* `existingTests[]`: Testfälle **bestehender, unveränderter** Testdateien, die geänderten Code erreichen (`id` `e1`, `e2` …, `path`, `name`, `line`, `reason`, `covers` wie bei `tests[]`, `profile`). Sie sind keine Segmente – nichts zu markieren. `coverage[].existingTests` verweist auf ihre Ids. `relatedTests` beschreibt die Auswahl (siehe unten).

## `related.json`

Welche bestehenden Testdateien zum PR geladen wurden (Abschnitt 5f in [05-analyse.md](05-analyse.md)); dasselbe steht in `analysis.json` → `relatedTests`. Wird bei jeder Analyse neu geschrieben; die Dateien selbst liegen unter `sources-related/<pfad>` (Stand: Head des PRs). Beim erneuten Laden des PRs werden beide gelöscht und neu bestimmt. Beim ganzen Repository (Nummer 0) gibt es beides nicht.

```json
{
  "limit": 30, "candidates": 2, "truncated": false, "listIncomplete": false,
  "files": [{ "path": "frontend/src/app/auth/current-user.service.spec.ts", "reason": "mirror",
              "sources": ["frontend/src/app/auth/current-user.service.ts"], "loaded": true }]
}
```

* `reason`: `mirror` (nach der geänderten Datei benannt, im gespiegelten Testordner oder daneben), `name` (gleicher Name anderswo, der nächstgelegene), `prefix` (Name beginnt mit dem der geänderten Datei, im gespiegelten Testordner).
* `truncated`: Es passten mehr als `limit` Dateien (`candidates`); `listIncomplete`: Der Code-Host hat die Dateiliste gekürzt. `loaded: false`: Die Datei konnte nicht geladen werden (wird bei der nächsten Analyse erneut versucht).

`analysis.json` ist **abgeleitet**: löschen oder `POST …/reanalyse` berechnet sie neu. Sie wird auch automatisch neu berechnet, wenn sich `rules.json` oder die Analyzer-Version ändert (`rulesHash`).

## Wie ein Agent mitarbeiten kann

**Variante 1: Dateien.** Der Agent liest `analysis.json` (was gibt es, wie ist es gruppiert) und `sources/` (Code), und schreibt Markierungen in `review.json`. Regeln:

1. Erst lesen, dann die ganze Datei neu schreiben (atomar: in eine temporäre Datei schreiben, dann umbenennen).
2. Schlüssel nur aus `segments[].lineKeys` verwenden. Für «überall ok» in `ok` eintragen (und die Zeile aus allen `okAt`-Orten entfernen); für einen einzelnen Ort in `okAt[<ort>]`.
3. Einen `log`-Eintrag mit `"by": "agent:<name>"` anhängen.

**Variante 2: REST** (empfohlen, wenn das Tool läuft – keine Schreibkonflikte):

```bash
# Alle Quick wins der Gruppe "Generiert & Lockfiles" als ok markieren
curl -X POST localhost:8080/api/prs/github/OWNER/REPO/12/marks \
  -H 'Content-Type: application/json' \
  -d '{"lines":[{"path":"package-lock.json","key":"N1"}],"ok":true,"scope":"group:quick-wins/generiert-&-lockfiles","by":"agent:claude"}'

# Nur im Flow flow-2 als ok markieren (die Zeile erscheint auch als Quick win)
curl -X POST localhost:8080/api/prs/github/OWNER/REPO/12/marks \
  -H 'Content-Type: application/json' \
  -d '{"lines":[{"path":"src/api.ts","key":"N29","place":"flows/flow-2"}],"ok":true,"scope":"flow:flow-2","by":"agent:claude"}'
```

Ohne `place` gilt die Markierung an allen Orten der Zeile.

**Typische Aufträge an einen Agenten:**

* «Geh die Quick wins von PR 12 durch, markiere alles als ok, was wirklich trivial ist, und liste den Rest mit Begründung auf.»
* «Prüfe den Flow `flow-1` auf fehlende Fehlerbehandlung und kommentiere direkt auf GitHub» (`POST …/comments`).
* «Ergänze `rules.json` um eine Regel, die unsere `*.mapper.ts`-Dateien als Quick win erkennt.»
* «Welche geänderten Funktionen in PR 12 werden von keinem geänderten Test erreicht?» (`segments[]` mit `category` = `logic` und leerem `testedBy`).

Die gleiche Anleitung liegt kompakt als `AGENTS.md` im Datenverzeichnis.
