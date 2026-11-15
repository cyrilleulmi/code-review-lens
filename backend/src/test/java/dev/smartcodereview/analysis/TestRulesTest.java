package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.smartcodereview.diff.PatchParser;
import dev.smartcodereview.model.Model;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.ExistingTest;
import dev.smartcodereview.model.Model.PullRequestInfo;
import dev.smartcodereview.model.Model.RelatedTestFile;
import dev.smartcodereview.model.Model.RuleCheck;
import dev.smartcodereview.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Erwartungs-Regeln: "if X changes, expect a test of form Y", checked per changed segment. */
class TestRulesTest {

    private static final String RESOURCE_PATH = "backend/src/main/java/app/api/PlayerResource.java";
    private static final String TEST_PATH = "backend/src/test/java/app/api/PlayerResourceTest.java";
    private static final String API_TEST_PATH = "backend/src/test/java/app/api/JerseyNumberApiTest.java";
    private static final String RESOURCE = """
            package app.api;

            @Path("/api/players")
            public class PlayerResource {
                @Inject
                Access access;

                @PUT
                @Path("/{playerId}")
                @Transactional
                public Player update(@PathParam("playerId") String id, @Min(1) int number) {
                    Player player = Player.findById(id);
                    player.number = number;
                    return player;
                }

                @DELETE
                @Path("/{playerId}/jersey-number")
                public Response clearJerseyNumber(@PathParam("playerId") String id) {
                    Player player = Player.findById(id);
                    access.requireCoach(player.team);
                    player.number = null;
                    return Response.noContent().build();
                }
            }
            """;
    /** Calls the resource directly, checks neither the denied case nor goes over HTTP; a plain unit test. */
    private static final String TEST = """
            package app.api;

            class PlayerResourceTest {
                PlayerResource resource = new PlayerResource();

                @Test
                void clearsTheNumber() {
                    resource.clearJerseyNumber("p-1");
                    assertNull(Player.<Player>findById("p-1").number);
                }

                @Test
                void savesTheNumber() {
                    resource.update("p-1", 7);
                    assertEquals(7, Player.<Player>findById("p-1").number);
                }
            }
            """;

    @Test
    void authorisationChangeNeedsATestForTheDeniedCase() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        RuleCheck denied = check(a, "auth-denied", "PlayerResource.clearJerseyNumber");
        assertFalse(denied.met(), "the test reaches it but checks no 401/403");
        assertEquals(List.of(testId(a, "clearsTheNumber")), denied.tests());
        assertEquals(21, denied.line(), "the changed line with access.requireCoach(");
        assertEquals("access.requireCoach(player.team);", denied.code());
        assertEquals("access.requireCoach(", denied.trigger());
        assertEquals("Test für den verweigerten Zugriff (401/403) fehlt", denied.hint());
        assertNull(find(a, "auth-denied", "PlayerResource.update"), "update has no authorisation check");

        String withDenied = TEST.replace("    @Test\n    void savesTheNumber() {", "    @Test\n    void refusesAPlayer() {\n"
                + "        doThrow(new AccessDeniedException(\"no\")).when(access).requireCoach(any());\n"
                + "        assertThrows(AccessDeniedException.class, () -> resource.clearJerseyNumber(\"p-1\"));\n"
                + "    }\n\n    @Test\n    void savesTheNumber() {");
        assertTrue(withDenied.contains("refusesAPlayer"));
        Analysis b = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, withDenied));
        RuleCheck met = check(b, "auth-denied", "PlayerResource.clearJerseyNumber");
        assertTrue(met.met());
        assertEquals(List.of(testId(b, "refusesAPlayer")), met.metBy());
    }

    @Test
    void newEndpointNeedsATestOverHttpWithPathParametersAndHelpers() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        RuleCheck clear = check(a, "endpoint-http", "PlayerResource.clearJerseyNumber");
        assertFalse(clear.met(), "a direct call is no request over HTTP");
        assertEquals(19, clear.line(), "the declaration line");
        assertEquals("DELETE /api/players/{}/jersey-number", clear.trigger());

        String api = """
                package app.api;

                @QuarkusTest
                class JerseyNumberApiTest {
                    @Test
                    void clearsOverHttp() {
                        given().pathParam("id", "p-1")
                                .when().delete("/api/players/{id}/jersey-number")
                                .then().statusCode(204);
                    }

                    @Test
                    void storesTheNumber() {
                        putNumber(7).then().statusCode(200);
                    }

                    private Response putNumber(int number) {
                        return given().body(Map.of("number", number)).when().put("/api/players/" + playerId);
                    }
                }
                """;
        Analysis b = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST, API_TEST_PATH, api));
        RuleCheck overHttp = check(b, "endpoint-http", "PlayerResource.clearJerseyNumber");
        assertTrue(overHttp.met(), "RestAssured with a path parameter, not linked by the call graph");
        assertEquals(List.of(testId(b, "clearsOverHttp")), overHttp.metBy());
        assertTrue(overHttp.tests().containsAll(List.of(testId(b, "clearsTheNumber"), testId(b, "clearsOverHttp"))));
        RuleCheck update = check(b, "endpoint-http", "PlayerResource.update");
        assertTrue(update.met(), "PUT through a helper with a concatenated URL");
        assertEquals(List.of(testId(b, "storesTheNumber")), update.metBy());

        // an HTTP test counts as reaching the endpoint for the other rules, too: a 403 over HTTP is the denied case
        String forbidden = api.replace(".then().statusCode(204);", ".then().statusCode(403);");
        Analysis c = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST, API_TEST_PATH, forbidden));
        assertEquals(List.of(testId(c, "clearsOverHttp")), check(c, "auth-denied", "PlayerResource.clearJerseyNumber").metBy());
    }

    @Test
    void httpTestingControllerIsNoRequestToTheBackend() throws Exception {
        String spec = """
                describe('PlayerApiService', () => {
                  let httpMock: HttpTestingController;

                  beforeEach(() => {
                    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
                    httpMock = TestBed.inject(HttpTestingController);
                  });

                  it('clears the number', () => {
                    TestBed.inject(HttpClient).delete('/api/players/7/jersey-number').subscribe();
                    httpMock.expectOne('/api/players/7/jersey-number').flush(null);
                  });
                });
                """;
        String specPath = "frontend/src/app/players/player-api.service.spec.ts";
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, specPath, spec));
        RuleCheck mocked = check(a, "endpoint-http", "PlayerResource.clearJerseyNumber");
        assertFalse(mocked.met(), "the HTTP backend is mocked");
        assertTrue(mocked.tests().isEmpty());

        String e2e = """
                test('a coach clears the number', async ({ request }) => {
                  const response = await request.delete('/api/players/7/jersey-number');
                  expect(response.status()).toBe(204);
                });
                """;
        Analysis b = analyse(Map.of(RESOURCE_PATH, RESOURCE, specPath, spec, "e2e/players.spec.ts", e2e));
        RuleCheck real = check(b, "endpoint-http", "PlayerResource.clearJerseyNumber");
        assertTrue(real.met(), "a real request from an end-to-end test");
        assertEquals(List.of(testId(b, "a coach clears the number")), real.metBy());
    }

    @Test
    void anEndpointThatIsNotNewNeedsNoNewTestButACustomRuleCanAskForIt() throws Exception {
        // only the body of update changes: its declaration line is context
        int changedLine = lineOf(RESOURCE, "player.number = number;");
        DiffFile resource = partly(RESOURCE_PATH, RESOURCE, Set.of(changedLine));
        String api = """
                package app.api;

                @QuarkusTest
                class JerseyNumberApiTest {
                    @Test
                    void storesTheNumber() {
                        given().body(Map.of("number", 7)).when().put("/api/players/" + playerId).then().statusCode(200);
                    }
                }
                """;
        Analysis a = analyse(List.of(resource, added(API_TEST_PATH, api)), Map.of(RESOURCE_PATH, RESOURCE, API_TEST_PATH, api),
                defaultRules());
        assertNull(find(a, "endpoint-http", "PlayerResource.update"), "the endpoint is not new");

        ObjectNode root = (ObjectNode) defaultTree();
        root.set("testRules", new ObjectMapper().readTree("""
                [
                  {"id": "auth-denied", "enabled": false},
                  {"id": "endpoint-changed-http", "label": "Endpunkt geändert → Test über HTTP", "when": {"endpoint": true},
                   "expect": {"http": true, "code": "statusCode\\\\(200\\\\)"}, "hint": "Kein Test über HTTP"}
                ]
                """));
        Rules custom = Rules.parse(root, "custom");
        assertEquals(List.of("endpoint-http", "validation-boundary", "transaction-integration", "listener-test",
                "endpoint-changed-http"), custom.testRules.stream().map(Rules.TestRule::id).toList(), "merged by id");
        Analysis b = analyse(List.of(resource, added(API_TEST_PATH, api)), Map.of(RESOURCE_PATH, RESOURCE, API_TEST_PATH, api), custom);
        RuleCheck changed = check(b, "endpoint-changed-http", "PlayerResource.update");
        assertTrue(changed.met());
        assertEquals("Endpunkt geändert → Test über HTTP", changed.label());
        assertEquals("PUT /api/players/{}", changed.trigger());
        assertEquals(List.of(testId(b, "storesTheNumber")), changed.metBy());
    }

    @Test
    void validationChangeNeedsAnErrorOrEdgeTest() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        RuleCheck normal = check(a, "validation-boundary", "PlayerResource.update");
        assertFalse(normal.met(), "savesTheNumber is a normal case");
        assertEquals("@Min", normal.trigger());

        String withError = TEST.replace("resource.update(\"p-1\", 7);", "resource.update(\"p-1\", 7);\n    }\n\n    @Test\n"
                + "    void rejectsZero() {\n        assertThrows(ConstraintViolationException.class, () -> resource.update(\"p-1\", 0));");
        Analysis b = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, withError));
        assertEquals(List.of(testId(b, "rejectsZero")), check(b, "validation-boundary", "PlayerResource.update").metBy());
    }

    @Test
    void transactionChangeNeedsAnIntegrationTest() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST));
        RuleCheck unit = check(a, "transaction-integration", "PlayerResource.update");
        assertFalse(unit.met(), "a plain unit test");
        assertEquals(List.of(testId(a, "savesTheNumber")), unit.tests());

        Analysis b = analyse(Map.of(RESOURCE_PATH, RESOURCE, TEST_PATH, TEST.replace("class PlayerResourceTest", "@QuarkusTest\nclass PlayerResourceTest")));
        assertTrue(check(b, "transaction-integration", "PlayerResource.update").met());
    }

    @Test
    void changedListenerNeedsATestThatCallsIt() throws Exception {
        String listenerPath = "backend/src/main/java/app/messaging/PlayerEvents.java";
        String listener = """
                package app.messaging;

                public class PlayerEvents {
                    @Incoming("players")
                    public void onPlayerChanged(String id) {
                        log.info(id);
                    }
                }
                """;
        Analysis a = analyse(Map.of(listenerPath, listener));
        RuleCheck none = check(a, "listener-test", "PlayerEvents.onPlayerChanged");
        assertFalse(none.met());
        assertEquals(4, none.line(), "the matching annotation");
        assertNull(find(a, "listener-test", "PlayerEvents"), "classes are no listeners");

        String test = """
                package app.messaging;

                class PlayerEventsTest {
                    PlayerEvents events = new PlayerEvents();

                    @Test
                    void logsTheChange() {
                        events.onPlayerChanged("p-1");
                    }
                }
                """;
        Analysis b = analyse(Map.of(listenerPath, listener, "backend/src/test/java/app/messaging/PlayerEventsTest.java", test));
        assertTrue(check(b, "listener-test", "PlayerEvents.onPlayerChanged").met(), "no expectation: reaching it suffices");
    }

    @Test
    void reachingOnlyAMockDoesNotCount() throws Exception {
        String ui = """
                package app.api;

                class PlayerUiTest {
                    @InjectMock
                    PlayerResource resource;

                    @Test
                    void refusesWhenDenied() {
                        when(resource.clearJerseyNumber("p-1")).thenThrow(new AccessDeniedException("no"));
                        assertThrows(AccessDeniedException.class, () -> ui.clear("p-1"));
                    }
                }
                """;
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, "backend/src/test/java/app/api/PlayerUiTest.java", ui));
        RuleCheck denied = check(a, "auth-denied", "PlayerResource.clearJerseyNumber");
        assertFalse(denied.met(), "the test runs a mock of the resource");
        assertTrue(denied.tests().isEmpty());
    }

    @Test
    void existingTestsOverHttpReachTheEndpoint() throws Exception {
        String existingPath = "backend/src/test/java/app/api/PlayerResourceTest.java";
        String existing = """
                package app.api;

                @QuarkusTest
                class PlayerResourceTest {
                    @Test
                    void forbidsAPlayer() {
                        given().cookie("user", "player").when().delete("/api/players/p-1/jersey-number").then().statusCode(403);
                    }

                    @Test
                    void listsPlayers() {
                        given().when().get("/api/players").then().statusCode(200);
                    }
                }
                """;
        var related = new Model.RelatedTests(30, 1, false, false,
                List.of(new RelatedTestFile(existingPath, "mirror", List.of(RESOURCE_PATH), true)));
        Snapshot snapshot = snapshot(List.of(added(RESOURCE_PATH, RESOURCE)));
        Analysis a = new Analyzer(defaultRules()).analyze(snapshot, Map.of(RESOURCE_PATH, RESOURCE), null, Map.of(), related,
                Map.of(existingPath, existing));
        assertEquals(List.of("PlayerResourceTest › forbidsAPlayer"), a.existingTests().stream().map(ExistingTest::name).toList(),
                "its request reaches a changed endpoint; the other one reaches nothing changed");
        var covers = a.existingTests().getFirst().covers();
        assertEquals(1, covers.size());
        assertTrue(covers.getFirst().http() && covers.getFirst().direct(), "reached directly over HTTP");
        assertEquals("DELETE /api/players/{}/jersey-number", covers.getFirst().endpoint());
        assertEquals(List.of("e1"), check(a, "endpoint-http", "PlayerResource.clearJerseyNumber").metBy());
        assertEquals(List.of("e1"), check(a, "auth-denied", "PlayerResource.clearJerseyNumber").metBy());
        assertFalse(check(a, "endpoint-http", "PlayerResource.update").met());
    }

    // ------------------------------------------------------------------ helpers

    private static RuleCheck check(Analysis a, String ruleId, String symbol) {
        RuleCheck c = find(a, ruleId, symbol);
        if (c == null) {
            throw new AssertionError(ruleId + " on " + symbol + " not in " + a.ruleChecks());
        }
        return c;
    }

    private static RuleCheck find(Analysis a, String ruleId, String symbol) {
        String id = a.segments().stream().filter(s -> symbol.equals(s.symbol())).findFirst().orElseThrow().id();
        return a.ruleChecks().stream().filter(c -> c.ruleId().equals(ruleId) && c.segmentId().equals(id)).findFirst().orElse(null);
    }

    private static String testId(Analysis a, String name) {
        return a.tests().stream().filter(t -> t.name().endsWith(name)).findFirst().orElseThrow().segmentId();
    }

    private static int lineOf(String content, String text) {
        String[] lines = content.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].contains(text)) {
                return i + 1;
            }
        }
        throw new AssertionError(text);
    }

    private static Analysis analyse(Map<String, String> sources) throws Exception {
        Map<String, String> ordered = new LinkedHashMap<>(sources);
        return analyse(ordered.entrySet().stream().map(e -> added(e.getKey(), e.getValue())).toList(), ordered, defaultRules());
    }

    private static Analysis analyse(List<DiffFile> files, Map<String, String> sources, Rules rules) {
        return new Analyzer(rules).analyze(snapshot(files), sources);
    }

    private static Snapshot snapshot(List<DiffFile> files) {
        return new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open",
                "main", "feature", "base", "head", "", "", 0, 0, 0, null), files);
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

    /** A modified file in which only the given lines (1-based, new file) are added; the others are context. */
    private static DiffFile partly(String path, String content, Set<Integer> addedLines) {
        String[] lines = content.split("\n", -1);
        int n = content.endsWith("\n") ? lines.length - 1 : lines.length;
        List<String> body = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            body.add((addedLines.contains(i + 1) ? "+" : " ") + lines[i]);
        }
        String patch = "@@ -1," + (n - addedLines.size()) + " +1," + n + " @@\n" + String.join("\n", body) + "\n";
        return new DiffFile(path, null, "modified", addedLines.size(), 0, Languages.of(path), false, PatchParser.parse(patch));
    }

    private static JsonNode defaultTree() throws Exception {
        try (InputStream in = TestRulesTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return new ObjectMapper().readTree(in);
        }
    }

    private static Rules defaultRules() throws Exception {
        return Rules.parse(defaultTree(), "test");
    }
}
