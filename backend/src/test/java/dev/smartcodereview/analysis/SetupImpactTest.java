package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.diff.PatchParser;
import dev.smartcodereview.model.Model.AffectedTest;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.PullRequestInfo;
import dev.smartcodereview.model.Model.RelatedTestFile;
import dev.smartcodereview.model.Model.RelatedTests;
import dev.smartcodereview.model.Model.SetupImpact;
import dev.smartcodereview.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Wirkung von Setup und Testdaten: which tests a changed setup block, fixture or helper affects. */
class SetupImpactTest {

    // ------------------------------------------------------------------ setup blocks

    @Test
    void beforeEachInNestedDescribeAffectsOnlyItsSuite() {
        String spec = """
                describe('PlayerView', () => {
                  it('shows the name', () => {
                    expect(1).toBe(1);
                  });
                  describe('jersey number', () => {
                    beforeEach(() => {
                      api.number = 9;
                    });
                    it('saves it', () => {
                      expect(2).toBe(2);
                    });
                    describe('invalid input', () => {
                      it('ignores text', () => {
                        expect(3).toBe(3);
                      });
                    });
                  });
                });
                """;
        Files files = new Files().file("a.spec.ts", spec);
        List<SetupImpact> impacts = files.changed("a.spec.ts", "beforeEach").find();
        assertEquals(1, impacts.size());
        SetupImpact i = impacts.getFirst();
        assertEquals("setup", i.kind());
        assertEquals("PlayerView › jersey number › beforeEach", i.name());
        assertEquals(List.of("PlayerView › jersey number › saves it", "PlayerView › jersey number › invalid input › ignores text"),
                names(i));
    }

    @Test
    void topLevelBeforeEachAffectsTheWholeFile() {
        String spec = """
                beforeEach(() => {
                  jest.useFakeTimers();
                });
                describe('A', () => {
                  it('a', () => {});
                });
                describe('B', () => {
                  it('b', () => {});
                });
                """;
        List<SetupImpact> impacts = new Files().file("a.spec.ts", spec).changed("a.spec.ts", "beforeEach").find();
        assertEquals(List.of("A › a", "B › b"), names(impacts.getFirst()));
    }

    @Test
    void junitBeforeEachIsSetupAndAffectsTheClassWithNestedClasses() {
        String java = """
                class PlayerResourceTest {
                    private Player player;

                    @BeforeEach
                    void createPlayer() {
                        player = new Player("Carmela");
                    }

                    @AfterEach
                    void cleanUp() {
                        player = null;
                    }

                    @Test
                    void savesJerseyNumber() {
                        assertEquals(1, 1);
                    }

                    @Nested
                    class ClearJerseyNumber {
                        @BeforeEach
                        void clear() {
                            player.setJerseyNumber(null);
                        }

                        @Test
                        void removesTheNumber() {
                            assertNull(player.getJerseyNumber());
                        }
                    }
                }
                """;
        String path = "src/test/java/a/PlayerResourceTest.java";
        List<Symbol> symbols = SymbolExtractor.extract(CodeText.of(java), path);
        assertEquals(List.of("createPlayer", "cleanUp", "clear"),
                symbols.stream().filter(s -> s.kind().equals("setup")).map(Symbol::name).toList());

        Files files = new Files().file(path, java);
        SetupImpact outer = files.changed(path, "createPlayer").find().getFirst();
        assertEquals("PlayerResourceTest › createPlayer", outer.name());
        assertEquals(List.of("PlayerResourceTest › savesJerseyNumber", "ClearJerseyNumber › removesTheNumber"), names(outer));
        SetupImpact inner = new Files().file(path, java).changed(path, "clear").find().getFirst();
        assertEquals(List.of("ClearJerseyNumber › removesTheNumber"), names(inner));
    }

    @Test
    void setupOfABaseClassAffectsTheTestsOfItsSubclasses() {
        String base = """
                abstract class ApiTestBase {
                    @BeforeEach
                    void login() {
                        token = "x";
                    }
                }
                """;
        String sub = """
                class PlayerApiTest extends ApiTestBase {
                    @Test
                    void listsPlayers() {
                        assertEquals(1, 1);
                    }
                }
                """;
        String other = """
                class OtherTest {
                    @Test
                    void other() {
                        assertEquals(1, 1);
                    }
                }
                """;
        SetupImpact i = new Files().file("src/test/java/a/ApiTestBase.java", base).file("src/test/java/a/PlayerApiTest.java", sub)
                .file("src/test/java/a/OtherTest.java", other).changed("src/test/java/a/ApiTestBase.java", "login").find().getFirst();
        assertEquals(List.of("PlayerApiTest › listsPlayers"), names(i));
    }

    // ------------------------------------------------------------------ fixtures

    private static final String PLAYER_VIEW_SPEC = """
            const CARMELA = { id: 'p-1', name: 'Carmela', jerseyNumber: 9 };
            const OTHER = { id: 'p-2' };

            describe('PlayerView', () => {
              async function render(detail = CARMELA) {
                return mount(detail);
              }

              it('shows the name', async () => {
                const el = await render();
                expect(el.name).toBe('Carmela');
              });

              it('shows the other player', async () => {
                const el = await render(OTHER);
                expect(el).toBeTruthy();
              });

              it('saves a number', () => {
                put.flush({ ...CARMELA, jerseyNumber: 7 });
              });

              it('knows nothing of it', () => {
                expect(OTHER.id).toBe('p-2');
              });
            });

            describe('with a stubbed API', () => {
              const api = {
                getPlayer: jest.fn(() => of(CARMELA)),
              };

              beforeEach(() => {
                TestBed.configureTestingModule({ providers: [{ provide: PlayerApi, useValue: api }] });
              });

              it('loads the player', () => {
                expect(api.getPlayer).toHaveBeenCalled();
              });
            });
            """;

    @Test
    void topLevelFixtureReachesTestsDirectlyAndThroughHelpersSetupAndSuiteVariables() {
        SetupImpact i = new Files().file("p.spec.ts", PLAYER_VIEW_SPEC).changed("p.spec.ts", "CARMELA").find().getFirst();
        assertEquals("fixture", i.kind());
        assertEquals("CARMELA", i.name());
        assertEquals(1, i.line());
        // render() uses CARMELA as default (even when called with another player: static, by name);
        // the stubbed API suite gets it through `api` in its beforeEach
        assertEquals(List.of("PlayerView › shows the name", "PlayerView › shows the other player", "PlayerView › saves a number",
                "with a stubbed API › loads the player"), names(i));
    }

    @Test
    void suiteLevelVariableIsAFixtureOfItsSuite() {
        Files files = new Files().file("p.spec.ts", PLAYER_VIEW_SPEC);
        int line = lineOf(PLAYER_VIEW_SPEC, "getPlayer: jest.fn");
        List<SetupImpact> impacts = files.changedLines("p.spec.ts", "with a stubbed API", Set.of(line)).find();
        assertEquals(1, impacts.size());
        assertEquals("fixture", impacts.getFirst().kind());
        assertEquals("api", impacts.getFirst().name());
        assertEquals(List.of("with a stubbed API › loads the player"), names(impacts.getFirst()));
    }

    @Test
    void javaFieldWithAValueIsAFixtureOfItsClass() {
        String java = """
                class PlayerTest {
                    private static final Player CARMELA = new Player("Carmela", 9);
                    @Inject
                    PlayerResource resource;

                    @Test
                    void usesCarmela() {
                        resource.save(CARMELA);
                    }

                    @Test
                    void usesNothing() {
                        assertEquals(1, 1);
                    }
                }
                """;
        String path = "src/test/java/a/PlayerTest.java";
        List<SetupImpact> impacts = new Files().file(path, java).changedLines(path, "PlayerTest", Set.of(2)).find();
        assertEquals(1, impacts.size());
        assertEquals("CARMELA", impacts.getFirst().name());
        assertEquals(List.of("PlayerTest › usesCarmela"), names(impacts.getFirst()));
        // a field without a value is no fixture
        assertTrue(new Files().file(path, java).changedLines(path, "PlayerTest", Set.of(4)).find().isEmpty());
    }

    @Test
    void onlyTrivialLinesChangedIsNoImpact() {
        String spec = """
                const CARMELA = {
                  id: 'p-1',

                };
                describe('A', () => {
                  it('a', () => { expect(CARMELA).toBeTruthy(); });
                });
                """;
        assertTrue(new Files().file("a.spec.ts", spec).changedLines("a.spec.ts", "CARMELA", Set.of(3, 4)).find().isEmpty());
        assertEquals(1, new Files().file("a.spec.ts", spec).changedLines("a.spec.ts", "CARMELA", Set.of(2)).find().size());
    }

    // ------------------------------------------------------------------ helpers

    @Test
    void helperMethodOfATestClassAffectsTheTestsCallingIt() {
        String java = """
                class PlayerResourceTest {
                    @Test
                    void savesJerseyNumber() {
                        Player p = playerWithNumber("Carmela", 9);
                    }

                    @Nested
                    class Clear {
                        @Test
                        void removesTheNumber() {
                            Player p = playerWithNumber("Carmela", 9);
                        }
                    }

                    @Test
                    void other() {
                        assertEquals(1, 1);
                    }

                    private static Player playerWithNumber(String name, Integer jerseyNumber) {
                        return new Player(name, jerseyNumber);
                    }
                }
                """;
        String path = "src/test/java/a/PlayerResourceTest.java";
        SetupImpact i = new Files().file(path, java).changed(path, "playerWithNumber").find().getFirst();
        assertEquals("helper", i.kind());
        assertEquals("PlayerResourceTest.playerWithNumber", i.name());
        assertEquals(List.of("PlayerResourceTest › savesJerseyNumber", "Clear › removesTheNumber"), names(i));
    }

    @Test
    void helperClassUsedFromOtherTestFiles() {
        String testData = """
                public class TestData {
                    public static Player player(String name) {
                        return new Player(name, 9);
                    }

                    public static List<Player> squad() {
                        return List.of(player("A"), player("B"));
                    }
                }
                """;
        String user = """
                class PlayerResourceTest {
                    @Test
                    void savesJerseyNumber() {
                        Player p = TestData.player("Carmela");
                    }

                    @Test
                    void listsTheSquad() {
                        assertEquals(2, TestData.squad().size());
                    }

                    @Test
                    void unrelated() {
                        Player player = new Player("x", 1);
                    }
                }
                """;
        String unrelated = """
                class OtherTest {
                    @Test
                    void calls() {
                        player("x");
                    }
                }
                """;
        String existing = """
                import static a.TestData.player;

                class ExistingTest {
                    @Test
                    void old() {
                        Player p = player("Old");
                    }
                }
                """;
        Files files = new Files()
                .file("src/test/java/a/TestData.java", testData)
                .file("src/test/java/a/PlayerResourceTest.java", user)
                .file("src/test/java/a/OtherTest.java", unrelated)
                .existing("src/test/java/a/ExistingTest.java", existing);
        SetupImpact i = files.changed("src/test/java/a/TestData.java", "player").find().getFirst();
        assertEquals("TestData.player", i.name());
        // squad() calls player(): listsTheSquad is affected through it; OtherTest never names TestData
        assertEquals(List.of("ExistingTest › old", "PlayerResourceTest › savesJerseyNumber", "PlayerResourceTest › listsTheSquad"),
                names(i));
        AffectedTest old = i.affected().getFirst();
        assertTrue(old.existing());
        assertEquals("unchanged", old.status());
        assertEquals(3, i.unchangedCount());
    }

    @Test
    void exportedHelperOfATestSupportFileNeedsAnImport() {
        String helper = """
                export function playerWithNumber(n: number) {
                  return { id: 'p-1', jerseyNumber: n };
                }
                """;
        String importing = """
                import { playerWithNumber } from '../testing/players';

                describe('A', () => {
                  it('uses it', () => {
                    expect(playerWithNumber(7).jerseyNumber).toBe(7);
                  });
                });
                """;
        String notImporting = """
                describe('B', () => {
                  it('has its own', () => {
                    expect(playerWithNumber(7)).toBeTruthy();
                  });
                });
                """;
        SetupImpact i = new Files().file("src/app/testing/players.ts", helper).file("src/app/a/a.spec.ts", importing)
                .file("src/app/b/b.spec.ts", notImporting).changed("src/app/testing/players.ts", "playerWithNumber").find().getFirst();
        assertEquals(List.of("A › uses it"), names(i));
    }

    @Test
    void testSupportPathsAreRules() throws Exception {
        Rules rules = defaultRules();
        assertTrue(dev.smartcodereview.analysis.SetupImpact.isTestOrSupport(rules, "src/app/testing/players.ts"));
        assertTrue(dev.smartcodereview.analysis.SetupImpact.isTestOrSupport(rules, "src/app/players/player.fixture.ts"));
        assertTrue(dev.smartcodereview.analysis.SetupImpact.isTestOrSupport(rules, "src/app/players/player-view.spec.ts"));
        assertFalse(dev.smartcodereview.analysis.SetupImpact.isTestOrSupport(rules, "src/app/players/player-view.ts"));
    }

    // ------------------------------------------------------------------ counts and statuses

    @Test
    void countsTheUnchangedTestsAmongTheAffected() {
        Files files = new Files().file("p.spec.ts", PLAYER_VIEW_SPEC, Map.of("shows the name", "unchanged",
                "shows the other player", "changed", "saves a number", "added", "loads the player", "unchanged"));
        SetupImpact i = files.changed("p.spec.ts", "CARMELA").find().getFirst();
        assertEquals(List.of("unchanged", "changed", "added", "unchanged"), i.affected().stream().map(AffectedTest::status).toList());
        assertEquals(2, i.unchangedCount());
    }

    @Test
    void analyzerReportsTheFixtureOfAModifiedSpecWithItsUnchangedTests() throws Exception {
        String base = """
                const CARMELA = { id: 'p-1', jerseyNumber: 7 };

                describe('PlayerView', () => {
                  it('shows the number', () => {
                    expect(render(CARMELA).number).toBe(7);
                  });
                  it('shows the name', () => {
                    expect(render(CARMELA).name).toBe('x');
                  });
                  it('knows nothing of it', () => {
                    expect(1).toBe(1);
                  });
                });
                """;
        String head = base.replace("jerseyNumber: 7 }", "jerseyNumber: 9 }").replace("toBe(7)", "toBe(9)");
        String patch = "@@ -1,1 +1,1 @@\n-const CARMELA = { id: 'p-1', jerseyNumber: 7 };\n+const CARMELA = { id: 'p-1', jerseyNumber: 9 };\n"
                + "@@ -5,1 +5,1 @@\n-    expect(render(CARMELA).number).toBe(7);\n+    expect(render(CARMELA).number).toBe(9);\n";
        String path = "src/app/player-view.spec.ts";
        DiffFile file = new DiffFile(path, null, "modified", 2, 2, Languages.of(path), false, PatchParser.parse(patch));
        Snapshot snapshot = new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open",
                "main", "feature", "base", "head", "", "", 0, 0, 0, null), List.of(file));
        Analysis a = new Analyzer(defaultRules()).analyze(snapshot, Map.of(path, head), null, Map.of(path, base),
                new RelatedTests(30, 0, false, false, List.of()), Map.of());
        assertEquals(1, a.setupImpacts().size());
        SetupImpact i = a.setupImpacts().getFirst();
        assertEquals("CARMELA", i.name());
        assertEquals(List.of("changed", "unchanged"), i.affected().stream().map(AffectedTest::status).toList());
        assertEquals(1, i.unchangedCount());
        assertTrue(i.affected().get(0).segmentId() != null);
        assertEquals(null, i.affected().get(1).segmentId());

        // the whole repository: no impacts
        Snapshot repo = new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 0, "t", "", "me", "", false, "open",
                "main", "feature", "base", "head", "", "", 0, 0, 0, null), List.of(file));
        assertTrue(new Analyzer(defaultRules()).analyze(repo, Map.of(path, head)).setupImpacts().isEmpty());
    }

    @Test
    void existingTestFilesAreSearchedToo() throws Exception {
        String fixture = """
                export const CARMELA = { id: 'p-1', jerseyNumber: 9 };
                """;
        String existing = """
                import { CARMELA } from '../testing/players.fixture';

                describe('PlayerList', () => {
                  it('lists Carmela', () => {
                    expect(list([CARMELA]).length).toBe(1);
                  });
                });
                """;
        String fixturePath = "src/app/testing/players.fixture.ts";
        String[] lines = fixture.split("\n");
        DiffFile file = new DiffFile(fixturePath, null, "added", 1, 0, Languages.of(fixturePath), false,
                PatchParser.parse("@@ -0,0 +1,1 @@\n+" + lines[0] + "\n"));
        Snapshot snapshot = new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open",
                "main", "feature", "base", "head", "", "", 0, 0, 0, null), List.of(file));
        String existingPath = "src/app/player-list/player-list.spec.ts";
        RelatedTests related = new RelatedTests(30, 1, false, false,
                List.of(new RelatedTestFile(existingPath, "mirror", List.of(), true)));
        Analysis a = new Analyzer(defaultRules()).analyze(snapshot, Map.of(fixturePath, fixture), null, Map.of(), related,
                Map.of(existingPath, existing));
        SetupImpact i = a.setupImpacts().getFirst();
        assertEquals("CARMELA", i.name());
        assertEquals(List.of("PlayerList › lists Carmela"), names(i));
        assertTrue(i.affected().getFirst().existing());
        assertEquals(1, i.unchangedCount());
    }

    // ------------------------------------------------------------------ helpers of the test

    /** Files to search plus the changed segments; statuses by test name (default "unchanged"). */
    private static final class Files {
        final List<dev.smartcodereview.analysis.SetupImpact.TestFile> files = new ArrayList<>();
        final List<dev.smartcodereview.analysis.SetupImpact.Changed> changed = new ArrayList<>();
        final Map<String, List<Symbol>> symbols = new HashMap<>();

        Files file(String path, String source) {
            return file(path, source, Map.of());
        }

        Files file(String path, String source, Map<String, String> statuses) {
            CodeText text = CodeText.of(source);
            List<Symbol> s = SymbolExtractor.extract(text, path);
            symbols.put(path, s);
            files.add(new dev.smartcodereview.analysis.SetupImpact.TestFile(path, text, s, false,
                    t -> new dev.smartcodereview.analysis.SetupImpact.TestState(statuses.getOrDefault(t.name(), "unchanged"), null)));
            return this;
        }

        Files existing(String path, String source) {
            CodeText text = CodeText.of(source);
            List<Symbol> s = SymbolExtractor.extract(text, path);
            symbols.put(path, s);
            files.add(new dev.smartcodereview.analysis.SetupImpact.TestFile(path, text, s, true, null));
            return this;
        }

        /** The symbol changed in all its lines. */
        Files changed(String path, String name) {
            Symbol s = symbol(path, name);
            Set<Integer> lines = new LinkedHashSet<>();
            IntStream.rangeClosed(s.startLine(), s.endLine()).forEach(lines::add);
            return changedLines(path, name, lines);
        }

        Files changedLines(String path, String name, Set<Integer> lines) {
            changed.add(new dev.smartcodereview.analysis.SetupImpact.Changed("s" + (changed.size() + 1), path, symbol(path, name), lines));
            return this;
        }

        Symbol symbol(String path, String name) {
            return symbols.get(path).stream().filter(x -> x.name().equals(name)).findFirst()
                    .orElseThrow(() -> new AssertionError("no symbol " + name + " in " + symbols.get(path)));
        }

        List<SetupImpact> find() {
            return dev.smartcodereview.analysis.SetupImpact.find(changed, files);
        }
    }

    private static List<String> names(SetupImpact i) {
        return i.affected().stream().map(AffectedTest::name).toList();
    }

    private static int lineOf(String source, String text) {
        String[] lines = source.split("\n");
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].contains(text)) {
                return i + 1;
            }
        }
        throw new AssertionError(text);
    }

    private static Rules defaultRules() throws Exception {
        try (InputStream in = SetupImpactTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8)), "test");
        }
    }
}
