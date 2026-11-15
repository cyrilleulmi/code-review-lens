package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.TestInfo;
import dev.smartcodereview.model.Model.TestProfile;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static dev.smartcodereview.analysis.SpecsTest.added;
import static dev.smartcodereview.analysis.SpecsTest.analyse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Test-Steckbrief: scenario, assertion kinds, mocks, level and parameterised cases of a test case. */
class TestProfilesTest {

    private static final TestProfiles PROFILES = new TestProfiles(rules());

    private static TestProfile profile(String path, String source, String testName) {
        return profile(path, source, testName, List.of());
    }

    /** targets: the code under test (in the analysis: the changed code the test calls directly). */
    private static TestProfile profile(String path, String source, String testName, List<String> targets) {
        CodeText text = CodeText.of(source);
        List<Symbol> symbols = SymbolExtractor.extract(text, path);
        Symbol test = symbols.stream().filter(s -> s.kind().equals("test") && s.name().equals(testName)).findFirst()
                .orElseThrow(() -> new AssertionError("no test " + testName + " in " + symbols));
        String file = path.substring(path.lastIndexOf('/') + 1);
        String unit = file.replaceAll("(\\.spec|\\.test|_test|Test)?\\.[a-z]+$", "");
        return PROFILES.profile(path, text, symbols, test, targets, unit);
    }

    private static String scenario(TestProfile p) {
        return p.scenario() + (p.scenarioBy() == null ? "" : " " + p.scenarioBy() + ": " + p.scenarioReason());
    }

    // ------------------------------------------------------------------ scenario

    @Test
    void scenarioFromTheTestName() {
        String spec = """
                describe('PlayerService', () => {
                  it('rejects an invalid jersey number', () => {
                    expect(valid(0)).toBe(false);
                  });
                  it('returns an empty list without players', () => {
                    expect(list().length).toBe(0);
                  });
                  it('does not throw for valid input', () => {
                    expect(() => create('Ann')).not.toThrow();
                  });
                  it('creates a player', () => {
                    expect(create('Ann').name).toBe('Ann');
                  });
                  describe('with invalid input', () => {
                    it('keeps the old value', () => {
                      expect(update(1, 'x').name).toBe('Ann');
                    });
                  });
                });
                """;
        String path = "src/app/player.service.spec.ts";
        assertEquals("error name: rejects", scenario(profile(path, spec, "rejects an invalid jersey number")));
        assertEquals("edge name: empty", scenario(profile(path, spec, "returns an empty list without players")));
        assertEquals("normal", scenario(profile(path, spec, "does not throw for valid input")));
        assertEquals("normal", scenario(profile(path, spec, "creates a player")));
        assertEquals("error name: invalid", scenario(profile(path, spec, "keeps the old value")), "describe names count");

        String java = """
                class PlayerResourceTest {
                    @Test
                    void returns404WhenThePlayerIsUnknown() {
                        assertEquals(1, 1);
                    }

                    @Test
                    void acceptsTheMaximumNumber() {
                        assertTrue(valid(99));
                    }
                }
                """;
        String javaPath = "src/test/java/app/PlayerResourceTest.java";
        assertEquals("error name: 404", scenario(profile(javaPath, java, "returns404WhenThePlayerIsUnknown")));
        assertEquals("edge name: maximum", scenario(profile(javaPath, java, "acceptsTheMaximumNumber")));
    }

    @Test
    void scenarioFromTheTestCode() {
        String java = """
                class PlayerServiceTest {
                    @Test
                    void update() {
                        assertThrows(IllegalArgumentException.class, () -> service.update(1, 0));
                    }

                    @Test
                    void load() {
                        given().when().get("/api/players/7").then().statusCode(404);
                    }

                    @Test
                    void save() {
                        service.save(new Player(""));
                        verify(repository).save(any());
                    }

                    @Test
                    void find() {
                        assertNull(service.find(1));
                    }
                }
                """;
        String path = "src/test/java/app/PlayerServiceTest.java";
        assertEquals("error code: assertThrows(", scenario(profile(path, java, "update")));
        assertEquals("error code: .statusCode(404", scenario(profile(path, java, "load")));
        assertEquals("edge code: (\"\"", scenario(profile(path, java, "save", List.of("save"))));
        assertEquals("normal", scenario(profile(path, java, "save")), "without a target call only the name and parameter sources count");
        assertEquals("normal", scenario(profile(path, java, "find")), "a null in the assertion is no null input");

        String spec = """
                describe('PlayerApi', () => {
                  it('loads the player', () => {
                    api.load(7).subscribe({ error: (e) => (error = e) });
                    httpMock.expectOne('/api/players/7').flush('gone', { status: 404, statusText: 'Not Found' });
                  });
                  it('shows the message', () => {
                    fixture.detectChanges();
                    expect(el.querySelector('.alert')?.textContent).toContain('Fehler');
                  });
                  it('has no errors', () => {
                    expect(component.errors()).toEqual([]);
                  });
                });
                """;
        String ts = "src/app/player.api.spec.ts";
        assertEquals("error code: status: 404", scenario(profile(ts, spec, "loads the player")));
        assertEquals("error", profile(ts, spec, "shows the message").scenario());
        assertEquals("normal", scenario(profile(ts, spec, "has no errors")), "checking that there are no errors is no error case");
    }

    @Test
    void edgeOnlyFromTheInputsOfTheCodeUnderTest() {
        String java = """
                class PlayerResourceTest {
                    @Test
                    void savesJerseyNumber() {
                        Player carmela = playerWithNumber("Carmela", null);
                        resource.update(carmela.id, new PlayerUpdateRequest(null, 7));
                        assertEquals(7, find(carmela.id).jerseyNumber);
                    }

                    @Test
                    void clearsJerseyNumber() {
                        Player carmela = playerWithNumber("Carmela", 7);
                        resource.update(carmela.id, null);
                        assertNull(find(carmela.id).jerseyNumber);
                    }

                    @ParameterizedTest
                    @NullSource
                    void ignoresMissingNames(String name) {
                        assertTrue(Names.normalise(name).isEmpty());
                    }

                    @Test
                    void savesViaHttp() {
                        given().contentType(JSON).body("").when().put("/api/players/7").then().statusCode(200);
                    }

                    @Test
                    void readsViaHttp() {
                        given().when().get("/api/players/7").then().statusCode(200).body("number", nullValue());
                    }
                }
                """;
        String path = "src/test/java/app/PlayerResourceTest.java";
        List<String> update = List.of("update");
        assertEquals("normal", scenario(profile(path, java, "savesJerseyNumber", update)), "a null in setup data or nested in an argument (partial update DTO) is no input");
        assertEquals("edge code: , null", scenario(profile(path, java, "clearsJerseyNumber", update)));
        assertEquals("edge code: @NullSource", scenario(profile(path, java, "ignoresMissingNames")));
        assertEquals("edge code: (\"\"", scenario(profile(path, java, "savesViaHttp")), "the body of an HTTP request is an input");
        assertEquals("normal", scenario(profile(path, java, "readsViaHttp")), "an expected null in the response is no input");

        String spec = """
                describe('valid', () => {
                  it('checks a number', () => {
                    const fixture = { number: null, name: '' };
                    expect(valid(fixture.number ?? 5)).toBe(true);
                  });
                  it('checks nothing', () => {
                    expect(valid(null)).toBe(false);
                  });
                  it.each([
                    [1, true],
                    [null, false],
                  ])('valid(%s)', (n, ok) => {
                    expect(check(n)).toBe(ok);
                  });
                });
                """;
        String ts = "src/app/valid.spec.ts";
        List<String> valid = List.of("valid");
        assertEquals("normal", scenario(profile(ts, spec, "checks a number", valid)), "fixture literals are no input");
        assertEquals("edge code: (null", scenario(profile(ts, spec, "checks nothing", valid)), "a target call inside an assertion is an input");
        assertEquals("edge code: [null", scenario(profile(ts, spec, "valid(%s)")), "null row in the it.each table");
    }

    // ------------------------------------------------------------------ assertions

    @Test
    void assertionsByKind() {
        String spec = """
                describe('PlayerView', () => {
                  it('saves', () => {
                    expect(component.name()).toBe('Ann');
                    expect(saved).toEqual({ id: 1 });
                    expect(api.save).toHaveBeenCalledWith(1);
                    expect(component.form).toBeTruthy();
                    const req = httpMock.expectOne('/api/players/1');
                    expect(req.request.method).toBe('PUT');
                    expect(fixture.nativeElement).toMatchSnapshot();
                    expect(() => component.reset()).toThrow();
                    expect(check(1));
                  });
                });
                """;
        TestProfile p = profile("src/app/player-view.spec.ts", spec, "saves");
        assertEquals(9, p.assertions());
        assertEquals(Map.of("equality", 2, "interaction", 2, "existence", 1, "http", 1, "snapshot", 1, "exception", 1, "other", 1),
                p.assertionKinds());
        assertEquals(List.of("exception", "http", "snapshot", "interaction", "existence", "equality", "other"),
                List.copyOf(p.assertionKinds().keySet()), "in rule order, other last");
    }

    // ------------------------------------------------------------------ mocks

    @Test
    void mocksFromFieldsSetupAndProviders() {
        String java = """
                @ExtendWith(MockitoExtension.class)
                class PlayerServiceTest {
                    @Mock
                    PlayerRepository repository;
                    @InjectMocks
                    PlayerService service;
                    private final Clock clock = mock(Clock.class);

                    @Test
                    void saves() {
                        when(clock.now()).thenReturn(NOW);
                        when(mailer.send(any())).thenReturn(true);
                        service.save(new Player("Ann"));
                    }
                }
                """;
        TestProfile p = profile("src/test/java/app/PlayerServiceTest.java", java, "saves");
        assertEquals(List.of("PlayerRepository", "Clock", "Mailer"), p.mocks(), "the unit under test (@InjectMocks) is no mock");

        String spec = """
                import { vi } from 'vitest';
                vi.mock('../shared/audit.service');

                describe('PlayerView', () => {
                  let api: jasmine.SpyObj<PlayerApi>;

                  beforeEach(() => {
                    api = jasmine.createSpyObj('PlayerApi', ['load']);
                    TestBed.configureTestingModule({
                      providers: [
                        { provide: PlayerApi, useValue: api },
                        { provide: Router, useValue: { navigate: vi.fn() } },
                        provideHttpClient(),
                        provideHttpClientTesting(),
                      ],
                    });
                  });

                  it('loads the player', () => {
                    spyOn(api, 'load');
                    component.ngOnInit();
                  });
                });

                describe('PlayerList', () => {
                  beforeEach(() => {
                    TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: {} }] });
                  });
                  it('lists', () => {});
                });
                """;
        TestProfile view = profile("src/app/player-view.spec.ts", spec, "loads the player");
        assertEquals(List.of("audit.service", "PlayerApi", "Router", "HTTP"), view.mocks(), "not the Store of the sibling suite");
        assertEquals("unit", view.level(), "a TestBed component test with a mocked backend stays a unit test");
        assertEquals(List.of("audit.service", "Store"), profile("src/app/player-view.spec.ts", spec, "lists").mocks());
    }

    @Test
    void goFakesAndGomock() {
        String go = """
                package player

                func TestSave(t *testing.T) {
                    store := &fakeStore{players: map[int]Player{}}
                    ctrl := gomock.NewController(t)
                    mailer := NewMockMailer(ctrl)
                    svc := NewService(store, mailer)
                    if err := svc.Save(Player{}); err != nil {
                        t.Fatal(err)
                    }
                }
                """;
        TestProfile p = profile("player/service_test.go", go, "TestSave");
        assertEquals(List.of("Store", "Mailer"), p.mocks());
        assertEquals("normal", scenario(p), "an empty map in a fake is no edge input");
    }

    // ------------------------------------------------------------------ level

    @Test
    void levelFromAnnotationsCallsAndPaths() {
        String quarkus = """
                @QuarkusTest
                class PlayerResourceTest {
                    @Test
                    void lists() {
                        given().when().get("/api/players").then().statusCode(200);
                    }
                }
                """;
        TestProfile it = profile("src/test/java/app/PlayerResourceTest.java", quarkus, "lists");
        assertEquals("integration code: @QuarkusTest", it.level() + " " + it.levelBy() + ": " + it.levelReason());

        String e2e = """
                test('logs in', async ({ page }) => {
                  await page.goto('/login');
                });
                """;
        TestProfile login = profile("e2e/login.e2e-spec.ts", e2e, "logs in");
        assertEquals("e2e path: **/e2e/**", login.level() + " " + login.levelBy() + ": " + login.levelReason());

        String plain = """
                class ScoreTest {
                    @Test
                    void adds() {
                        assertEquals(3, Score.add(1, 2));
                    }
                }
                """;
        TestProfile unit = profile("src/test/java/app/ScoreTest.java", plain, "adds");
        assertEquals("unit", unit.level());
        assertNull(unit.levelBy());

        String realHttp = """
                describe('PlayerApi', () => {
                  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient()] }));
                  it('loads', () => {});
                });
                """;
        assertEquals("integration", profile("src/app/player.api.spec.ts", realHttp, "loads").level());
    }

    // ------------------------------------------------------------------ parameterised cases

    @Test
    void junitParameterisedCases() {
        String java = """
                class JerseyTest {
                    @ParameterizedTest
                    @ValueSource(ints = {1, 50, 99})
                    void accepts(int n) {
                        assertTrue(valid(n));
                    }

                    @CsvSource({
                        "0, false",
                        "1, true",
                        "100, false",
                        "99, true"
                    })
                    @ParameterizedTest
                    void checks(int n, boolean ok) {
                        assertEquals(ok, valid(n));
                    }

                    @ParameterizedTest
                    @CsvSource(textBlock = \"""
                        # number, valid
                        0,   false
                        7,   true
                        \""")
                    void table(int n, boolean ok) {
                        assertEquals(ok, valid(n));
                    }

                    @ParameterizedTest
                    @NullAndEmptySource
                    @ValueSource(strings = "  ")
                    void blank(String s) {
                        assertFalse(valid(s));
                    }

                    @ParameterizedTest
                    @MethodSource("numbers")
                    void fromMethod(int n) {
                        assertTrue(valid(n));
                    }

                    @Test
                    void plain() {
                        assertTrue(valid(5));
                    }
                }
                """;
        String path = "src/test/java/app/JerseyTest.java";
        assertCases(profile(path, java, "accepts"), 3, "@ValueSource");
        TestProfile checks = profile(path, java, "checks");
        assertCases(checks, 4, "@CsvSource");
        assertCases(profile(path, java, "table"), 2, "@CsvSource");
        assertCases(profile(path, java, "blank"), 3, "@NullAndEmptySource + @ValueSource");
        assertEquals("edge", profile(path, java, "blank").scenario());
        TestProfile method = profile(path, java, "fromMethod");
        assertTrue(method.parameterized());
        assertNull(method.cases(), "rows of a method source are unknown");
        assertFalse(profile(path, java, "plain").parameterized());
        assertEquals(1, checks.assertions(), "the multi-line @CsvSource above the method belongs to the test");
    }

    @Test
    void jsEachTablesAndGoTableTests() {
        String spec = """
                describe('valid', () => {
                  it.each([
                    [1, true],
                    [99, true],
                    [0, false],
                    [100, false],
                  ])('valid(%i) is %s', (n, ok) => {
                    expect(valid(n)).toBe(ok);
                  });

                  test.each`
                    a    | b    | sum
                    ${1} | ${2} | ${3}
                    ${2} | ${2} | ${4}
                  `('adds $a and $b', ({ a, b, sum }) => {
                    expect(add(a, b)).toBe(sum);
                  });

                  it.each(cases)('case %s', (c) => {
                    expect(valid(c)).toBe(true);
                  });
                });
                """;
        String path = "src/app/valid.spec.ts";
        TestProfile array = profile(path, spec, "valid(%i) is %s");
        assertCases(array, 4, "it.each");
        assertEquals(1, array.assertions());
        assertCases(profile(path, spec, "adds $a and $b"), 2, "test.each");
        TestProfile variable = profile(path, spec, "case %s");
        assertTrue(variable.parameterized());
        assertNull(variable.cases());

        String go = """
                package jersey

                func TestValid(t *testing.T) {
                    tests := []struct {
                        name string
                        n    int
                        want bool
                    }{
                        {"lowest", 1, true},
                        {"highest", 99, true},
                        {name: "zero", n: 0, want: false},
                    }
                    for _, tt := range tests {
                        t.Run(tt.name, func(t *testing.T) {
                            if got := Valid(tt.n); got != tt.want {
                                t.Errorf("Valid(%d) = %v", tt.n, got)
                            }
                        })
                    }
                }

                func TestNames(t *testing.T) {
                    cases := map[string]Case{
                        "empty": {in: ""},
                        "one":   {in: "a"},
                    }
                    for name, c := range cases {
                        t.Run(name, func(t *testing.T) { check(t, c) })
                    }
                }

                func TestLoop(t *testing.T) {
                    for _, p := range players() {
                        check(t, p)
                    }
                }
                """;
        assertCases(profile("jersey/valid_test.go", go, "TestValid"), 3, "table");
        assertCases(profile("jersey/valid_test.go", go, "TestNames"), 2, "table");
        assertFalse(profile("jersey/valid_test.go", go, "TestLoop").parameterized(), "a loop without a table literal");
    }

    private static void assertCases(TestProfile p, int cases, String source) {
        assertTrue(p.parameterized(), "parameterized");
        assertEquals(cases, p.cases());
        assertEquals(source, p.casesSource());
    }

    // ------------------------------------------------------------------ in the analysis

    @Test
    void analysisAttachesProfilesWithTargets() throws Exception {
        String service = """
                export function create(name: string) {
                  return { name };
                }

                export function rename(p: Player, name: string) {
                  return { ...p, name };
                }
                """;
        String spec = """
                import { create, rename } from './player.service';

                describe('player.service', () => {
                  it('creates and renames', () => {
                    expect(rename(create('Ann'), 'Bob').name).toBe('Bob');
                  });
                  it('knows nothing else', () => {
                    expect(1).toBe(1);
                  });
                });
                """;
        String sp = "src/app/player.service.ts";
        String tp = "src/app/player.service.spec.ts";
        Analysis analysis = analyse(List.of(added(sp, service), added(tp, spec)), Map.of(sp, service, tp, spec), Map.of());
        TestInfo both = analysis.tests().stream().filter(t -> t.name().endsWith("creates and renames")).findFirst().orElseThrow();
        assertNotNull(both.profile());
        assertEquals(List.of("create", "rename"), both.profile().targets());
        assertEquals("normal", both.profile().scenario());
        assertEquals(Map.of("equality", 1), both.profile().assertionKinds());
        TestInfo none = analysis.tests().stream().filter(t -> t.name().endsWith("knows nothing else")).findFirst().orElseThrow();
        assertEquals(List.of("player.service"), none.profile().targets(), "without calls: the unit from the file name");
    }

    // ------------------------------------------------------------------ helpers

    @Test
    void wordsSplitNames() {
        assertEquals("rejects invalid number", TestProfiles.words("rejectsInvalidNumber"));
        assertEquals("test create empty", TestProfiles.words("TestCreate_Empty"));
        assertEquals("returns 404 for http error", TestProfiles.words("returns404ForHTTPError"));
        assertEquals("lehnt ungültige nummer ab", TestProfiles.words("lehnt ungültige Nummer ab"));
    }

    private static Rules rules() {
        try (InputStream in = TestProfilesTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8)), "test");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
