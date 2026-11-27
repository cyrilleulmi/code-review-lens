package dev.codereviewlens.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CaseFinding;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.EdgeCoverage;
import dev.codereviewlens.model.Model.FlowCoverage;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.Snapshot;
import dev.codereviewlens.model.Model.TestCoverage;
import dev.codereviewlens.model.Model.TestInfo;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** HTTP-Tests: real requests of tests reach changed endpoints; expected requests of mocked backends are contracts. */
class HttpTestsTest {

    private static final String VIEW = """
            import { PlayerApiService } from './player-api.service';

            @Component({ selector: 'app-player', template: '' })
            export class PlayerView {
              saveJerseyNumber(value: string): void {
                const n = Number.parseInt(value, 10);
                this.api.setJerseyNumber(this.id, n).subscribe();
              }
            }
            """;
    private static final String API = """
            export class PlayerApiService {
              setJerseyNumber(playerId: string, jerseyNumber: number): Observable<PlayerDetail> {
                return this.http.put<PlayerDetail>(`/api/players/${playerId}`, { jerseyNumber });
              }
            }
            """;
    private static final String RESOURCE = """
            package app.api;

            @Path("/api/players")
            public class PlayerResource {

                @GET
                @Path("/me")
                public PlayerDetailDto me() {
                    return current.player();
                }

                @PUT
                @Path("/{playerId}")
                public PlayerDetailDto update(UUID playerId, PlayerUpdateRequest request) {
                    if (request.jerseyNumber() != null) {
                        validateJerseyNumber(request.jerseyNumber());
                    }
                    return null;
                }

                @GET
                @Path("/{playerId}")
                public PlayerDetailDto byId(UUID playerId) {
                    return find(playerId);
                }

                private static void validateJerseyNumber(int jerseyNumber) {
                    if (jerseyNumber < 1 || jerseyNumber > 99) {
                        throw new BadRequestException("out of range");
                    }
                }
            }
            """;
    /** RestAssured through a helper with a "+"-built URL; the number goes in as the helper's argument. */
    private static final String API_TEST = """
            package app.api;

            @QuarkusTest
            class JerseyNumberApiTest {
                @Test
                void setsTwentyThree() {
                    putJerseyNumber(23).then().statusCode(200);
                }

                @Test
                void readsTheCurrentPlayer() {
                    given().when().get("/api/players/me").then().statusCode(200);
                }

                private Response putJerseyNumber(int jerseyNumber) {
                    return given()
                            .contentType(ContentType.JSON)
                            .body(Map.of("jerseyNumber", jerseyNumber))
                            .when().put("/api/players/" + playerId);
                }
            }
            """;
    /** HttpTestingController: the backend is mocked; the test expects the PUT (method checked on the request). */
    private static final String SPEC = """
            import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
            import { PlayerView } from './player-view';

            describe('PlayerView', () => {
              let httpMock: HttpTestingController;

              function render() {
                httpMock.expectOne('/api/players/p-1').flush(CARMELA);
              }

              it('saves the number', () => {
                render();
                view.saveJerseyNumber('7');
                const put = httpMock.expectOne('/api/players/p-1');
                expect(put.request.method).toBe('PUT');
                put.flush({});
              });

              it('ignores text', () => {
                render();
                view.saveJerseyNumber('abc');
                httpMock.expectNone('/api/players/p-1');
              });
            });
            """;
    private static final String VIEW_PATH = "frontend/src/app/players/player-view.ts";
    private static final String API_PATH = "frontend/src/app/players/player-api.service.ts";
    private static final String SPEC_PATH = "frontend/src/app/players/player-view.spec.ts";
    private static final String RESOURCE_PATH = "backend/src/main/java/app/api/PlayerResource.java";
    private static final String API_TEST_PATH = "backend/src/test/java/app/api/JerseyNumberApiTest.java";

    @Test
    void restAssuredThroughAHelperReachesTheEndpointAndWhatItCalls() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, API_TEST_PATH, API_TEST));
        Segment update = segment(a, "PlayerResource.update");
        Segment validate = segment(a, "PlayerResource.validateJerseyNumber");
        TestInfo test = test(a, "JerseyNumberApiTest › setsTwentyThree");

        Map<String, TestCoverage> covers = covers(test.covers());
        TestCoverage direct = covers.get(update.id());
        assertTrue(direct.direct() && direct.http(), "the request hits the endpoint directly");
        assertEquals("PUT /api/players/{}", direct.endpoint());
        assertEquals(7, direct.line(), "the line in the test that calls the helper");
        TestCoverage indirect = covers.get(validate.id());
        assertFalse(indirect.direct());
        assertEquals(update.id(), indirect.via(), "the walk continues from the endpoint into the backend");
        assertTrue(indirect.http());
        assertNull(indirect.endpoint());
        assertFalse(covers.containsKey(segment(a, "PlayerResource.byId").id()), "the PUT is no GET");

        assertEquals(List.of("update"), test.profile().targets(), "the endpoint method, not the name-convention unit");
        assertTrue(test.subjects().stream().anyMatch(s -> s.name().equals("PlayerResource") && s.how().equals("http")));
        assertEquals(List.of(test.segmentId()), update.testedBy());
        Map<String, CodeCoverage> coverage = coverage(a);
        assertEquals("direct", coverage.get(update.id()).status());
        assertEquals("indirect", coverage.get(validate.id()).status());

        // the most exact endpoint wins: GET /api/players/me, not GET /api/players/{playerId}
        TestInfo me = test(a, "JerseyNumberApiTest › readsTheCurrentPlayer");
        assertEquals(List.of(segment(a, "PlayerResource.me").id()), me.covers().stream().map(TestCoverage::segmentId).toList());
    }

    @Test
    void literalsOfTheHelperCallAreInputsOfTheEndpoint() throws Exception {
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, API_TEST_PATH, API_TEST));
        CodeCoverage validate = coverage(a).get(segment(a, "PlayerResource.validateJerseyNumber").id());
        CaseFinding boundary = validate.findings().stream().filter(f -> f.kind().equals(CaseChecks.BOUNDARY)).findFirst().orElseThrow();
        assertEquals(List.of("23"), boundary.covered(), "putJerseyNumber(23)");
        assertEquals(List.of("0", "1", "99", "100"), boundary.missing());
    }

    @Test
    void quarkusTestHttpEndpointGivesTheBasePath() throws Exception {
        String test = """
                package app.api;

                @QuarkusTest
                @TestHTTPEndpoint(PlayerResource.class)
                class PlayerResourceHttpTest {
                    @Test
                    void readsMe() {
                        given().when().get("/me").then().statusCode(200);
                    }

                    @Test
                    void updates() {
                        given().body(Map.of("jerseyNumber", 7)).when().put("/" + id).then().statusCode(200);
                    }
                }
                """;
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, "backend/src/test/java/app/api/PlayerResourceHttpTest.java", test));
        assertEquals(List.of(segment(a, "PlayerResource.me").id()),
                test(a, "PlayerResourceHttpTest › readsMe").covers().stream().map(TestCoverage::segmentId).toList());
        TestCoverage update = covers(test(a, "PlayerResourceHttpTest › updates").covers()).get(segment(a, "PlayerResource.update").id());
        assertEquals("PUT /api/players/{}", update.endpoint());
    }

    @Test
    void httpTestingControllerIsNoReachButBothSidesOfTheRestEdgeAreShown() throws Exception {
        Analysis a = analyse(Map.of(VIEW_PATH, VIEW, API_PATH, API, SPEC_PATH, SPEC, RESOURCE_PATH, RESOURCE,
                API_TEST_PATH, API_TEST));
        Segment set = segment(a, "PlayerApiService.setJerseyNumber");
        Segment update = segment(a, "PlayerResource.update");
        TestInfo saves = test(a, "PlayerView › saves the number");
        TestInfo ignores = test(a, "PlayerView › ignores text");
        TestInfo server = test(a, "JerseyNumberApiTest › setsTwentyThree");
        assertTrue(covers(saves.covers()).containsKey(set.id()));
        assertFalse(covers(saves.covers()).containsKey(update.id()), "the backend is mocked: expectOne is no request");

        FlowCoverage fc = a.flowCoverage().stream()
                .filter(c -> c.edges().stream().anyMatch(e -> e.from().equals(set.id()) && e.to().equals(update.id())))
                .findFirst().orElseThrow();
        EdgeCoverage rest = fc.edges().stream().filter(e -> e.from().equals(set.id()) && e.to().equals(update.id()))
                .findFirst().orElseThrow();
        assertEquals(MockBoundaries.SEPARATE, rest.status(), "no single test crosses the REST hop");
        assertEquals(List.of(saves.segmentId()), rest.clientTests(),
                "expects the PUT in the test itself; the GET in render() and expectNone do not count");
        assertFalse(rest.clientTests().contains(ignores.segmentId()));
        assertEquals(List.of(server.segmentId()), rest.serverTests());
        fc.edges().stream().filter(e -> e != rest).forEach(e -> assertTrue(e.clientTests().isEmpty() && e.serverTests().isEmpty()));
    }

    @Test
    void endToEndRequestsReachPageNavigationDoesNot() throws Exception {
        String e2e = """
                import { test, expect } from '@playwright/test';

                test('a coach sets the number', async ({ request }) => {
                  const response = await request.put('/api/players/p-1', { data: { jerseyNumber: 7 } });
                  expect(response.status()).toBe(200);
                });

                test('a coach opens the player', async ({ page }) => {
                  await page.goto('/players/p-1');
                  await page.getByRole('button', { name: 'Speichern' }).click();
                });
                """;
        Analysis a = analyse(Map.of(RESOURCE_PATH, RESOURCE, "e2e/players.spec.ts", e2e));
        Segment update = segment(a, "PlayerResource.update");
        assertTrue(covers(test(a, "a coach sets the number").covers()).get(update.id()).http());
        assertTrue(test(a, "a coach opens the player").covers().isEmpty());
    }

    // ------------------------------------------------------------------ requests and expectations in code

    @Test
    void requestsInTestCode() throws Exception {
        HttpTests http = new HttpTests(defaultRules());
        assertEquals(List.of("DELETE /api/players/{}/jersey-number"),
                labels(http.requests("mockMvc.perform(delete(\"/api/players/{id}/jersey-number\", id))", 1, null)));
        assertEquals(List.of("PUT /api/players/{}"),
                labels(http.requests("webTestClient.put().uri(\"/api/players/\" + id).exchange()", 1, null)));
        assertEquals(List.of("DELETE /api/x/{}"), labels(http.requests("cy.request('DELETE', `/api/x/${id}`)", 1, null)));
        assertEquals(List.of("POST /api/x"), labels(http.requests("await fetch('/api/x', { method: 'POST', body })", 1, null)));
        assertEquals(List.of("PATCH /api/x"), labels(http.requests("request(app).patch('/api/x').send({})", 1, null)));
        assertEquals(List.of("DELETE /x/1"), labels(http.requests("req := httptest.NewRequest(http.MethodDelete, \"/x/1\", nil)", 1, null)));
        assertTrue(http.requests("map.put(\"key\", value); httpMock.expectOne('/api/x')", 1, null).isEmpty(), "no path, no request");
        assertTrue(http.requests("map.get(\"key\")", 1, "/api").isEmpty(), "a base path does not turn a key into a path");
        assertEquals(List.of("GET /api/players"), labels(http.requests("given().when().get().then()", 1, "/api/players")),
                "a request without a path goes to the base");
        assertEquals(3, http.requests("given()\n  .body(x)\n  .when().put(\"/api/x\")", 1, null).getFirst().line());
    }

    @Test
    void basePaths() throws Exception {
        HttpTests http = new HttpTests(defaultRules());
        assertEquals("/api", http.base("given().basePath(\"/api\").when().get(\"/x\")", Map.of()));
        assertEquals("/api", http.base("RestAssured.basePath = \"/api\";", Map.of()));
        assertEquals("/api", http.base("WebTestClient.bindToServer().baseUrl(\"http://localhost:8080/api\")", Map.of()));
        assertEquals("/api/players", http.base("@TestHTTPEndpoint(PlayerResource.class)", Map.of("PlayerResource", "/api/players")));
        assertNull(http.base("@TestHTTPEndpoint(Unknown.class)", Map.of()), "a class the analysis does not know");
    }

    @Test
    void expectedRequests() throws Exception {
        HttpTests http = new HttpTests(defaultRules());
        assertEquals(List.of("PUT /api/players/{}"), expectations(http,
                "httpMock.expectOne({ method: 'PUT', url: `/api/players/${id}` }).flush({});"));
        assertEquals(List.of("DELETE /api/players/p-1/avatar"), expectations(http,
                "const del = httpMock.expectOne('/api/players/p-1/avatar');\nexpect(del.request.method).toBe('DELETE');"));
        assertEquals(List.of("/api/players/p-1"), expectations(http, "httpMock.expectOne('/api/players/p-1').flush({});"),
                "no method: any");
        assertTrue(expectations(http, "httpMock.expectNone('/api/players/p-1');").isEmpty());
        assertEquals(List.of("PUT {}/api/players/{}"), expectations(http, "cy.intercept('PUT', '**/api/players/*').as('save');"));
        assertEquals(List.of("{}/api/players/{}"), expectations(http, "await page.route('**/api/players/*', r => r.fulfill({}));"));
        assertEquals(List.of("PUT /api/players/1"), expectations(http, "nock('http://api').put('/api/players/1').reply(200);"));
        assertEquals(List.of("PUT /api/players/{}"),
                expectations(http, "http.put('/api/players/:id', async ({ request }) => HttpResponse.json({}))"));
        assertTrue(expectations(http, "this.http.put('/api/players/1', body)").isEmpty(), "a client call is no msw handler");
        assertEquals(List.of("GET /api/x"), expectations(http, "stubFor(get(urlEqualTo(\"/api/x\")).willReturn(ok()));"));
        assertEquals(List.of("POST /api/x"), expectations(http,
                "server.expect(requestTo(\"/api/x\")).andExpect(method(HttpMethod.POST)).andRespond(withSuccess());"));

        HttpTests.Expectation any = new HttpTests.Expectation(null, "/api/players/{}", 1);
        assertTrue(any.fits(new Http.Endpoint("PUT", "/api/players/{}")));
        assertFalse(new HttpTests.Expectation("GET", "/api/players/{}", 1).fits(new Http.Endpoint("PUT", "/api/players/{}")));
    }

    @Test
    void requestsInHelpersCountAtTheCallOfTheHelper() throws Exception {
        String code = """
                class T {
                    @Test
                    void a() {
                        prepare();
                        send(5);
                    }

                    void prepare() {
                    }

                    Response send(int n) {
                        return deeper(n);
                    }

                    Response deeper(int n) {
                        return given().body(Map.of("n", 42)).when().post("/api/x");
                    }
                }
                """;
        CodeText text = CodeText.of(code);
        List<Symbol> symbols = SymbolExtractor.extract(text, "src/test/java/T.java");
        Symbol test = symbols.stream().filter(s -> s.name().equals("a")).findFirst().orElseThrow();
        HttpTests.Found found = new HttpTests(defaultRules()).find(text, symbols, test, code, Map.of());
        assertEquals(1, found.requests().size());
        HttpTests.Request r = found.requests().getFirst();
        assertEquals("POST /api/x", r.call().method() + " " + r.call().path());
        assertEquals(5, r.call().line(), "where the test calls send(…)");
        assertEquals("send", r.helper(), "the helper the test calls");
        assertTrue(r.inputs().contains("42"), r.inputs());
    }

    // ------------------------------------------------------------------ helpers

    private static List<String> expectations(HttpTests http, String code) {
        return http.expectations(code, 1).stream().map(HttpTests.Expectation::label).toList();
    }

    private static List<String> labels(List<Http.Call> calls) {
        return calls.stream().map(c -> c.method() + " " + c.path()).toList();
    }

    private static Map<String, TestCoverage> covers(List<TestCoverage> covers) {
        Map<String, TestCoverage> map = new HashMap<>();
        covers.forEach(c -> map.put(c.segmentId(), c));
        return map;
    }

    private static Map<String, CodeCoverage> coverage(Analysis a) {
        Map<String, CodeCoverage> map = new HashMap<>();
        a.coverage().forEach(c -> map.put(c.segmentId(), c));
        return map;
    }

    private static TestInfo test(Analysis a, String name) {
        return a.tests().stream().filter(t -> t.name().equals(name)).findFirst()
                .orElseThrow(() -> new AssertionError(name + " in " + a.tests().stream().map(TestInfo::name).toList()));
    }

    private static Segment segment(Analysis a, String symbol) {
        return a.segments().stream().filter(s -> symbol.equals(s.symbol())).findFirst().orElseThrow(() -> new AssertionError(symbol));
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
        try (InputStream in = HttpTestsTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(in), "test");
        }
    }
}
