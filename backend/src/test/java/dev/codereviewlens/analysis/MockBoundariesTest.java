package dev.codereviewlens.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.EdgeCoverage;
import dev.codereviewlens.model.Model.ExistingTest;
import dev.codereviewlens.model.Model.Flow;
import dev.codereviewlens.model.Model.FlowCoverage;
import dev.codereviewlens.model.Model.FlowEdge;
import dev.codereviewlens.model.Model.FlowStep;
import dev.codereviewlens.model.Model.MockWarning;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.Snapshot;
import dev.codereviewlens.model.Model.StepCoverage;
import dev.codereviewlens.model.Model.TestCoverage;
import dev.codereviewlens.model.Model.TestInfo;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Mock-Grenzen: mocked collaborators stop the walk from a test, mock warnings, and what a flow's tests really execute. */
class MockBoundariesTest {

    // ------------------------------------------------------------------ Mockito: the mock stops the walk

    private static final String SERVICE = """
            package app.player;

            public class PlayerService {
                private final PlayerRepository repository;

                public void renamePlayer(Player p, String name) {
                    p.name = name;
                    repository.storePlayer(p);
                }
            }
            """;
    private static final String REPOSITORY = """
            package app.player;

            public class PlayerRepository {
                public void storePlayer(Player p) {
                    if (p.name == null) {
                        throw new IllegalArgumentException();
                    }
                    audit.recordChange(p);
                }
            }
            """;
    private static final String AUDIT = """
            package app.player;

            public class Audit {
                public void recordChange(Player p) {
                    if (p != null) {
                        log.add(p);
                    }
                }
            }
            """;
    private static final String SERVICE_TEST = """
            package app.player;

            @ExtendWith(MockitoExtension.class)
            class PlayerServiceTest {
                @Mock
                PlayerRepository repository;
                @Mock
                Clock clock;
                @InjectMocks
                PlayerService service;

                @Test
                void renamesThePlayer() {
                    service.renamePlayer(new Player(), "Carmela");
                    verify(repository).storePlayer(any());
                }
            }
            """;

    @Test
    void mockitoMockStopsTheWalkAndIsNotCoverage() throws Exception {
        Analysis a = analyse(Map.of(
                "src/main/java/app/player/PlayerService.java", SERVICE,
                "src/main/java/app/player/PlayerRepository.java", REPOSITORY,
                "src/main/java/app/player/Audit.java", AUDIT,
                "src/test/java/app/player/PlayerServiceTest.java", SERVICE_TEST));
        Segment rename = segment(a, "PlayerService.renamePlayer");
        Segment store = segment(a, "PlayerRepository.storePlayer");
        Segment record = segment(a, "Audit.recordChange");
        TestInfo test = a.tests().getFirst();
        assertEquals(List.of("PlayerRepository", "Clock"), test.profile().mocks());

        Map<String, TestCoverage> covers = covers(test.covers());
        assertFalse(covers.get(rename.id()).mocked(), "the unit under test runs for real");
        assertTrue(covers.get(store.id()).mocked(), "PlayerRepository is a mock in this test");
        assertFalse(covers.containsKey(record.id()), "the walk stops at the mock: its callees are not reached");
        assertEquals(List.of("renamePlayer"), test.profile().targets(), "a mock is no target");
        assertTrue(segment(a, "PlayerRepository.storePlayer").testedBy().isEmpty());

        Map<String, CodeCoverage> coverage = coverage(a);
        assertEquals("direct", coverage.get(rename.id()).status());
        assertEquals("none", coverage.get(store.id()).status(), "reached only as a mock: not covered");
        assertEquals(List.of(test.segmentId()), coverage.get(store.id()).mockedTests());
        assertTrue(coverage.get(store.id()).directTests().isEmpty());
        assertEquals("none", coverage.get(record.id()).status());
        assertTrue(coverage.get(record.id()).mockedTests().isEmpty());

        assertEquals(1, a.mockWarnings().size(), "Clock is mocked too, but has no changed code: " + a.mockWarnings());
        MockWarning w = a.mockWarnings().getFirst();
        assertEquals(test.segmentId(), w.test());
        assertEquals(store.id(), w.segmentId());
        assertEquals("storePlayer", w.member());
        assertEquals("PlayerRepository", w.collaborator());
        assertEquals(15, w.line(), "the verify(repository).storePlayer(…) line");
    }

    @Test
    void mockedCollaboratorWhoseChangedMembersTheTestDoesNotNameGivesNoWarning() throws Exception {
        String test = SERVICE_TEST.replace("        verify(repository).storePlayer(any());\n", "");
        Analysis a = analyse(Map.of(
                "src/main/java/app/player/PlayerService.java", SERVICE,
                "src/main/java/app/player/PlayerRepository.java", REPOSITORY,
                "src/test/java/app/player/PlayerServiceTest.java", test));
        assertTrue(a.mockWarnings().isEmpty(), String.valueOf(a.mockWarnings()));
        Segment store = segment(a, "PlayerRepository.storePlayer");
        assertTrue(covers(a.tests().getFirst().covers()).get(store.id()).mocked(), "still only a mock is reached");
    }

    // ------------------------------------------------------------------ Angular: stubbed API, HTTP mock, REST hop

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

                @PUT
                @Path("/{playerId}")
                public PlayerDetailDto update(UUID playerId, PlayerUpdateRequest request) {
                    if (request.jerseyNumber() != null) {
                        validateJerseyNumber(request.jerseyNumber());
                    }
                    return null;
                }

                private static void validateJerseyNumber(int jerseyNumber) {
                    if (jerseyNumber > 99) {
                        throw new BadRequestException("too big");
                    }
                }
            }
            """;
    private static final String SPEC = """
            import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
            import { PlayerView } from './player-view';
            import { PlayerApiService } from './player-api.service';

            describe('PlayerView', () => {
              let httpMock: HttpTestingController;

              beforeEach(() => {
                TestBed.configureTestingModule({ providers: [provideHttpClientTesting()] });
                httpMock = TestBed.inject(HttpTestingController);
              });

              it('saves the number', () => {
                view.saveJerseyNumber('7');
                httpMock.expectOne('/api/players/p-1').flush({});
              });
            });

            describe('PlayerView with a stubbed API', () => {
              let api: jasmine.SpyObj<PlayerApiService>;

              beforeEach(() => {
                api = jasmine.createSpyObj('PlayerApiService', ['setJerseyNumber']);
                TestBed.configureTestingModule({ providers: [{ provide: PlayerApiService, useValue: api }] });
              });

              it('hands the number to the API', () => {
                view.saveJerseyNumber('11');
                expect(api.setJerseyNumber).toHaveBeenCalledWith('p-1', 11);
              });
            });
            """;
    private static final String RESOURCE_TEST = """
            package app.api;

            @QuarkusTest
            class PlayerResourceTest {
                @Inject
                PlayerResource resource;

                @Test
                void savesTheNumber() {
                    resource.update(UUID.randomUUID(), new PlayerUpdateRequest(7));
                }
            }
            """;
    private static final String VIEW_PATH = "frontend/src/app/players/player-view.ts";
    private static final String API_PATH = "frontend/src/app/players/player-api.service.ts";
    private static final String SPEC_PATH = "frontend/src/app/players/player-view.spec.ts";
    private static final String RESOURCE_PATH = "backend/src/main/java/app/api/PlayerResource.java";
    private static final String RESOURCE_TEST_PATH = "backend/src/test/java/app/api/PlayerResourceTest.java";

    @Test
    void angularStubOfAChangedMemberWarnsAndHttpMockKeepsTheBackendUnreached() throws Exception {
        Analysis a = analyse(Map.of(VIEW_PATH, VIEW, API_PATH, API, SPEC_PATH, SPEC,
                RESOURCE_PATH, RESOURCE, RESOURCE_TEST_PATH, RESOURCE_TEST));
        Segment save = segment(a, "PlayerView.saveJerseyNumber");
        Segment set = segment(a, "PlayerApiService.setJerseyNumber");
        Segment update = segment(a, "PlayerResource.update");
        Segment validate = segment(a, "PlayerResource.validateJerseyNumber");
        TestInfo http = test(a, "PlayerView › saves the number");
        TestInfo stubbed = test(a, "PlayerView with a stubbed API › hands the number to the API");

        assertEquals(List.of("HTTP"), http.profile().mocks(), "not the stub of the sibling suite");
        Map<String, TestCoverage> viaHttp = covers(http.covers());
        assertFalse(viaHttp.get(set.id()).mocked(), "with HttpTestingController the API client runs for real");
        assertFalse(viaHttp.containsKey(update.id()), "but the backend is never reached");
        Map<String, TestCoverage> viaStub = covers(stubbed.covers());
        assertFalse(viaStub.get(save.id()).mocked());
        assertTrue(viaStub.get(set.id()).mocked(), "PlayerApiService is provided as useValue");

        assertEquals(1, a.mockWarnings().size(), String.valueOf(a.mockWarnings()));
        MockWarning w = a.mockWarnings().getFirst();
        assertEquals(stubbed.segmentId(), w.test());
        assertEquals(SPEC_PATH, w.path());
        assertEquals(set.id(), w.segmentId());
        assertEquals("setJerseyNumber", w.member());
        assertEquals("PlayerApiService", w.collaborator());
        assertEquals(23, w.line(), "the createSpyObj line in the setup of the suite");

        Flow flow = a.flows().stream().filter(f -> f.steps().getFirst().segmentId().equals(save.id())).findFirst().orElseThrow();
        FlowCoverage fc = a.flowCoverage().stream().filter(c -> c.flowId().equals(flow.id())).findFirst().orElseThrow();
        Map<String, StepCoverage> steps = new HashMap<>();
        fc.steps().forEach(s -> steps.put(s.segmentId(), s));
        assertEquals(MockBoundaries.TESTED, steps.get(set.id()).status(), "the HTTP test reaches it for real");
        assertEquals(List.of(http.segmentId()), steps.get(set.id()).tests());
        assertEquals(List.of(stubbed.segmentId()), steps.get(set.id()).mockedBy());
        assertEquals(MockBoundaries.TESTED, steps.get(update.id()).status());
        assertEquals(MockBoundaries.TESTED, steps.get(validate.id()).status());
        assertEquals(MockBoundaries.TESTED, edge(fc, save.id(), set.id()).status());
        assertEquals(MockBoundaries.SEPARATE, edge(fc, set.id(), update.id()).status(), "no test crosses the REST hop");
        assertTrue(edge(fc, set.id(), update.id()).tests().isEmpty());
        assertEquals(MockBoundaries.TESTED, edge(fc, update.id(), validate.id()).status());
    }

    // ------------------------------------------------------------------ edge and step statuses

    @Test
    void flowCoverageStatusesOfStepsAndEdges() {
        // a -> b -> c -> d, plus b ⇢ e (http); t1 runs a, b for real; t2 runs c for real and d only as a mock; t3 runs e
        Flow flow = new Flow("flow-1", "a → b", List.of(
                new FlowStep("a", 1, 0, null), new FlowStep("b", 2, 1, "a"), new FlowStep("c", 3, 2, "b"),
                new FlowStep("d", 4, 3, "c"), new FlowStep("e", 5, 2, "b"), new FlowStep("f", 6, 4, "d")),
                List.of(edge("a", "b", "call"), edge("b", "c", "call"), edge("c", "d", "call"), edge("b", "e", "http"),
                        edge("d", "f", "call")));
        List<TestInfo> tests = List.of(
                testInfo("t1", cover("a", false), cover("b", false)),
                testInfo("t2", cover("c", false), cover("d", true)),
                testInfo("t3", cover("e", false)));
        ExistingTest existing = new ExistingTest("e1", "x.spec.ts", "x", 1, "mirror", List.of(cover("d", true)), null);

        FlowCoverage fc = MockBoundaries.flowCoverage(List.of(flow), tests, List.of(existing)).getFirst();
        assertEquals(List.of("tested", "tested", "tested", "mocked", "tested", "none"),
                fc.steps().stream().map(StepCoverage::status).toList());
        assertEquals(List.of("t2", "e1"), fc.steps().get(3).mockedBy());
        assertEquals(List.of("tested", "separate", "partial", "separate", "none"),
                fc.edges().stream().map(EdgeCoverage::status).toList(), "a-b crossed by t1, b-c tested apart, c-d only c, "
                        + "b-e http never crossed, d-f none");
        assertEquals(List.of("t1"), fc.edges().getFirst().tests());
    }

    @Test
    void ownerNamesMatchAcrossNamingConventions() {
        Set<String> keys = MockBoundaries.ownerKeys("src/app/player-api.service.ts", "method", "setJerseyNumber", "PlayerApiService");
        assertNotNull(MockBoundaries.mockedBy(List.of("player-api.service"), keys), "vi.mock('./player-api.service')");
        assertNotNull(MockBoundaries.mockedBy(List.of("PlayerApiService"), keys));
        assertEquals(null, MockBoundaries.mockedBy(List.of("HTTP", "PlayerApi"), keys));
        assertTrue(MockBoundaries.keys(List.of("HTTP")).isEmpty(), "a mocked HTTP backend is no collaborator");
    }

    // ------------------------------------------------------------------ helpers

    private static FlowEdge edge(String from, String to, String kind) {
        return new FlowEdge(from, to, 1, to, kind);
    }

    private static TestCoverage cover(String segmentId, boolean mocked) {
        return new TestCoverage(segmentId, true, null, 1, mocked);
    }

    private static TestInfo testInfo(String id, TestCoverage... covers) {
        return new TestInfo(id, id, "t.spec.ts", List.of(), List.of(covers), null);
    }

    private static EdgeCoverage edge(FlowCoverage fc, String from, String to) {
        return fc.edges().stream().filter(e -> e.from().equals(from) && e.to().equals(to)).findFirst()
                .orElseThrow(() -> new AssertionError(from + ">" + to + " in " + fc.edges()));
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
        try (InputStream in = MockBoundariesTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(in), "test");
        }
    }
}
