package dev.codereviewlens.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CaseFinding;
import dev.codereviewlens.model.Model.CaseMatrix;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.MatrixBoundary;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Fall- und Effekt-Abgleich: error outcomes, boundaries and effects of changed code against what reaching tests check. */
class CaseChecksTest {

    private static final String RESOURCE_PATH = "backend/src/main/java/app/api/PlayerResource.java";
    private static final String TEST_PATH = "backend/src/test/java/app/api/PlayerResourceTest.java";
    private static final String RESOURCE = """
            package app.api;

            public class PlayerResource {
                private static final int MAX = 99;

                public Player update(String id, int number) {
                    Player player = Player.findById(id);
                    if (player == null) {
                        throw new NotFoundException("no player " + id);
                    }
                    if (number < 1 || number > MAX) {
                        throw new BadRequestException("1 to 99");
                    }
                    player.number = number;
                    player.changedAt = Instant.now();
                    player.persist();
                    return player;
                }

                public void remove(String id) {
                    if (id == null) {
                        throw new WebApplicationException("missing", 409);
                    }
                    repository.delete(id);
                    events.publish(id);
                }
            }
            """;
    private static final String TEST = """
            package app.api;

            @QuarkusTest
            class PlayerResourceTest {
                @Inject
                PlayerResource resource;

                @Test
                void savesTheNumber() {
                    resource.update("p-1", 7);
                    assertEquals(7, Player.<Player>findById("p-1").number);
                }

                @ParameterizedTest
                @ValueSource(ints = {0, 1, 100})
                void rejectsNumbersOutsideTheRange(int number) {
                    assertThrows(BadRequestException.class, () -> resource.update("p-1", number));
                }

                @Test
                void removesAndKeepsQuiet() {
                    resource.remove("p-1");
                    verify(repository).delete("p-1");
                }
            }
            """;

    @Test
    void exceptionsAreCheckedByTypeOrMappedStatusOrNotAtAll() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        List<CaseFinding> update = findings(a, "PlayerResource.update");
        CaseFinding badRequest = find(update, "exception", "BadRequestException");
        assertEquals("wirft BadRequestException (400)", badRequest.label());
        assertTrue(badRequest.checked(), "assertThrows(BadRequestException.class, …)");
        assertEquals(List.of(testId(a, "rejectsNumbersOutsideTheRange")), badRequest.checkedBy());
        CaseFinding notFound = find(update, "exception", "NotFoundException");
        assertEquals("wirft NotFoundException (404)", notFound.label());
        assertFalse(notFound.checked(), "no test expects the 404");
        assertEquals(9, notFound.line());
        assertTrue(notFound.code().startsWith("throw new NotFoundException("));

        // the status of a WebApplicationException comes from its arguments; a test asserting it checks the exception
        String statusTest = TEST.replace("verify(repository).delete(\"p-1\");",
                "verify(repository).delete(\"p-1\");\n        assertEquals(409, assertThrows(WebApplicationException.class, () -> resource.remove(null)).getResponse().getStatus());");
        CaseFinding conflict = find(findings(analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, statusTest)), "PlayerResource.remove"),
                "exception", "WebApplicationException");
        assertEquals("wirft WebApplicationException (409)", conflict.label());
        assertTrue(conflict.checked());

        String byStatusOnly = TEST.replace("verify(repository).delete(\"p-1\");",
                "verify(repository).delete(\"p-1\");\n        assertEquals(409, resource.remove(null).getStatus());");
        assertTrue(find(findings(analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, byStatusOnly)), "PlayerResource.remove"),
                "exception", "WebApplicationException").checked(), "a status assertion with the mapped code");
        assertFalse(find(findings(a, "PlayerResource.remove"), "exception", "WebApplicationException").checked());
    }

    @Test
    void boundariesWithLiteralAndConstantAgainstTheTestInputs() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        CaseFinding boundary = find(findings(a, "PlayerResource.update"), "boundary", "number");
        assertEquals("Grenze 1…99", boundary.label(), "number < 1 and number > MAX with MAX = 99");
        assertEquals(List.of("0", "1", "7", "100"), boundary.covered(), "the call argument 7 and the @ValueSource");
        assertEquals(List.of("99"), boundary.missing());
        assertFalse(boundary.checked());
        assertEquals(List.of(testId(a, "rejectsNumbersOutsideTheRange")), boundary.checkedBy());

        String complete = TEST.replace("ints = {0, 1, 100}", "ints = {0, 1, 99, 100}");
        CaseFinding all = find(findings(analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, complete)), "PlayerResource.update"),
                "boundary", "number");
        assertTrue(all.checked());
        assertTrue(all.missing().isEmpty());

        // the Fallmatrix of the parameterised test names the boundary values it lacks
        CaseMatrix m = a.caseMatrices().stream().filter(x -> x.title().contains("rejectsNumbersOutsideTheRange")).findFirst().orElseThrow();
        assertEquals(1, m.boundaries().size(), String.valueOf(m.boundaries()));
        MatrixBoundary hint = m.boundaries().getFirst();
        assertEquals("1…99", hint.label());
        assertEquals(List.of("0", "1", "99", "100"), hint.values());
        assertEquals(List.of("99"), hint.missing());
    }

    @Test
    void caseMatrixValuesOfSimilarTestsCountAsInputs() throws Exception {
        String similar = """
                package app.api;

                @QuarkusTest
                class PlayerResourceTest {
                    @Inject
                    PlayerResource resource;

                    @Test
                    void acceptsOne() {
                        assertNotNull(resource.update("p-1", 1));
                    }

                    @Test
                    void acceptsNinetyNine() {
                        assertNotNull(resource.update("p-1", 99));
                    }
                }
                """;
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, similar));
        CaseFinding boundary = find(findings(a, "PlayerResource.update"), "boundary", "number");
        assertEquals(List.of("1", "99"), boundary.covered());
        assertEquals(List.of("0", "100"), boundary.missing());
    }

    @Test
    void effectsAreCheckedByFieldNameVerifyOrReadBack() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        List<CaseFinding> update = findings(a, "PlayerResource.update");
        CaseFinding number = find(update, "effect", "number");
        assertEquals("setzt number", number.label());
        assertTrue(number.checked(), "assertEquals(7, …findById(…).number)");
        assertEquals(List.of(testId(a, "savesTheNumber")), number.checkedBy());
        CaseFinding changedAt = find(update, "effect", "changedAt");
        assertFalse(changedAt.checked(), "no assertion mentions changedAt");
        assertEquals(15, changedAt.line());
        assertTrue(find(update, "effect", "persist").checked(), "the assertion reads the player again (findById)");

        List<CaseFinding> remove = findings(a, "PlayerResource.remove");
        CaseFinding delete = find(remove, "effect", "delete");
        assertEquals("speichert: delete", delete.label());
        assertTrue(delete.checked(), "verify(repository).delete(…)");
        CaseFinding publish = find(remove, "effect", "publish");
        assertEquals("sendet: publish", publish.label());
        assertFalse(publish.checked());
    }

    @Test
    void mockedReachesDoNotCount() throws Exception {
        String flowTest = """
                package app.api;

                @ExtendWith(MockitoExtension.class)
                class PlayerFlowTest {
                    @Mock
                    PlayerResource resource;

                    @Test
                    void stubbedUpdate() {
                        resource.update("p-1", 99);
                        assertThrows(NotFoundException.class, () -> resource.update("x", 1));
                        assertEquals(1, resource.update("p-1", 1).changedAt);
                    }
                }
                """;
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, "backend/src/test/java/app/api/PlayerFlowTest.java", flowTest));
        CodeCoverage c = coverage(a, "PlayerResource.update");
        assertEquals("none", c.status());
        assertFalse(c.mockedTests().isEmpty(), "the test reaches only a mock");
        assertFalse(find(c.findings(), "exception", "NotFoundException").checked());
        assertEquals(List.of("0", "1", "99", "100"), find(c.findings(), "boundary", "number").missing());
        assertFalse(find(c.findings(), "effect", "changedAt").checked());
    }

    @Test
    void moreBranchesThanTestsIsInformation() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        CaseFinding branches = find(findings(a, "PlayerResource.update"), "branches", null);
        assertEquals("3 Verzweigungen, 2 Tests", branches.label());
        assertFalse(branches.checked());
        assertEquals(null, branches.line());
    }

    // ------------------------------------------------------------------ pure parts

    @Test
    void numbersInTestInputs() {
        assertEquals(List.of(14L, -3L, 23L, 5L), CaseChecks.numbers("(carmela.id, new PlayerUpdateRequest(null, 14), -3, \"23\", 'abc7', x - 1.5, f(5))"));
        assertEquals(List.of(), CaseChecks.numbers("(id2, a-1)"), "names and subtractions are no inputs: " + CaseChecks.numbers("(id2, a-1)"));
        assertEquals(-3L, CaseChecks.number("'-3'"));
        assertEquals(1000L, CaseChecks.number("1_000L"));
        assertEquals(null, CaseChecks.number("'abc'"));
    }

    @Test
    void boundaryForms() throws Exception {
        String ts = """
                const LIMIT = 10;
                export function check(n: number, items: string[]): boolean {
                  for (let i = 0; i < 5; i++) {
                    log(i);
                  }
                  if (items.length > 0 && 1 > n) {
                    return false;
                  }
                  return n <= LIMIT && n < LIMIT * 2;
                }
                """;
        CodeText text = CodeText.of(ts);
        Symbol fn = SymbolExtractor.extract(text, "a.ts").stream().filter(s -> s.name().equals("check")).findFirst().orElseThrow();
        List<CaseChecks.Boundary> b = new CaseChecks(defaultRules()).boundaries(text, fn);
        assertEquals(1, b.size(), "for headers, sizes and sums are left out: " + b);
        assertEquals("n", b.getFirst().subject());
        assertEquals("1…10", b.getFirst().label(), "1 > n is n < 1 (lower bound 1), n <= LIMIT with LIMIT = 10");
        assertEquals(List.of(0L, 1L, 10L, 11L), b.getFirst().values());
    }

    // ------------------------------------------------------------------ helpers

    private static List<CaseFinding> findings(Analysis a, String symbol) {
        return coverage(a, symbol).findings();
    }

    private static CodeCoverage coverage(Analysis a, String symbol) {
        Segment s = a.segments().stream().filter(x -> symbol.equals(x.symbol())).findFirst().orElseThrow();
        CodeCoverage c = a.coverage().stream().filter(x -> x.segmentId().equals(s.id())).findFirst().orElse(null);
        assertNotNull(c, symbol + " is testable");
        return c;
    }

    private static CaseFinding find(List<CaseFinding> findings, String kind, String subject) {
        return findings.stream().filter(f -> f.kind().equals(kind) && java.util.Objects.equals(f.subject(), subject)).findFirst()
                .orElseThrow(() -> new AssertionError(kind + " " + subject + " not in " + findings));
    }

    private static String testId(Analysis a, String name) {
        return a.tests().stream().filter(t -> t.name().endsWith(name)).findFirst().orElseThrow().segmentId();
    }

    private static Analysis analyse(Map<String, String> sources) throws Exception {
        Map<String, String> ordered = new LinkedHashMap<>(sources);
        List<DiffFile> files = ordered.entrySet().stream().map(e -> added(e.getKey(), e.getValue())).toList();
        Snapshot snapshot = new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open",
                "main", "feature", "base", "head", "", "", 0, 0, 0, null), files);
        return new Analyzer(defaultRules()).analyze(snapshot, ordered);
    }

    private static DiffFile added(String path, String content) {
        String[] lines = content.split("\n", -1);
        int n = content.endsWith("\n") ? lines.length - 1 : lines.length;
        StringBuilder patch = new StringBuilder("@@ -0,0 +1," + n + " @@\n");
        for (int i = 0; i < n; i++) {
            patch.append('+').append(lines[i]).append('\n');
        }
        return new DiffFile(path, null, "added", n, 0, Languages.of(path), false, PatchParser.parse(patch.toString()));
    }

    private static Rules defaultRules() throws Exception {
        try (InputStream in = CaseChecksTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(in), "test");
        }
    }
}
