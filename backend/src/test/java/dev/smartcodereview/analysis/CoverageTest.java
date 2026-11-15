package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.smartcodereview.diff.PatchParser;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.CodeCoverage;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.PullRequestInfo;
import dev.smartcodereview.model.Model.Segment;
import dev.smartcodereview.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Coverage seen from the code: status per testable changed function, branch count, needsTests. */
class CoverageTest {

    private static final String SERVICE = """
            export class PlayerService {
              validateNumber(n: number): void {
                if (n > 99) {
                  throw new Error('too big');
                }
                checkRange(n);
              }

              updateNumber(n: number): void {
                this.validateNumber(n);
                this.store.save(n);
              }

              createPlayer(n: number, name?: string): void {
                const label = name ?? 'unnamed';
                if (n > 0 && label.length > 0 || this.force) {
                  this.store.add(n, label);
                } else {
                  this.store.add(0, label);
                }
              }
            }

            export function checkRange(n: number): void {
              if (n < 1) {
                throw new Error('too small');
              }
            }
            """;
    private static final String SPEC = """
            import { PlayerService } from './player.service';

            describe('PlayerService', () => {
              it('rejects numbers above 99', () => {
                const service = new PlayerService();
                expect(() => service.updateNumber(100)).toThrow();
              });
            });
            """;
    private static final String MAPPER = """
            export function toPlayer(dto: PlayerDto): Player {
              return dto.active ? { id: dto.id } : { id: 0 };
            }
            """;

    @Test
    void countsDecisionPointsButNotNullSafetyOrTypes() {
        String ts = """
                function pick(a?: number, b?: string): string | undefined {
                  const x = a?.toString() ?? 'none';
                  // if (a && b || c) ? d : e
                  const s = "if (a && b) ? c : d";
                  if (a > 1 && b) {
                    return a ? 'x' : 'y';
                  } else if (b || a) {
                    for (const i of list) { use(i); }
                  }
                  switch (a) { case 1: break; case 2: break; default: break; }
                  try { run(); } catch (e) { fail(); }
                  while (busy()) { wait(); }
                  return a
                    ? 'long'
                    : 'short';
                }
                """;
        // if + &&, ternary, else if + ||, for, 2 × case, catch, while, multi-line ternary
        assertEquals(11, Coverage.branches(CodeText.of(ts).code));

        String javaAndKotlin = """
                List<?> any = List.of();
                Map<? extends Number, ?> map = Map.of();
                val name: String? = null
                fun label(x: Int?): String? = x?.toString() ?: "none"
                String elseBranch = flag ? "a" : "b";
                """;
        assertEquals(1, Coverage.branches(CodeText.of(javaAndKotlin).code), "only the real ternary counts");
        assertEquals(0, Coverage.branches(List.of("int x = 1;", "notify(format);", "iffy(); forEach(x); casey();")));
    }

    @Test
    void statusDirectIndirectNoneSortedByStatusAndRisk() throws Exception {
        Analysis analysis = analyse(defaultRules());
        Segment validate = segment(analysis, "PlayerService.validateNumber");
        Segment update = segment(analysis, "PlayerService.updateNumber");
        Segment create = segment(analysis, "PlayerService.createPlayer");
        Segment range = segment(analysis, "checkRange");
        Segment test = segment(analysis, "PlayerService › rejects numbers above 99");

        Map<String, CodeCoverage> byId = new java.util.HashMap<>();
        analysis.coverage().forEach(c -> byId.put(c.segmentId(), c));
        assertEquals(4, analysis.coverage().size(), "the class, the test and the mapper (quick win) are not testable logic");

        assertEquals("direct", byId.get(update.id()).status());
        assertEquals(List.of(test.id()), byId.get(update.id()).directTests());
        assertEquals("indirect", byId.get(validate.id()).status());
        assertEquals(List.of(test.id()), byId.get(validate.id()).indirectTests());
        assertTrue(byId.get(validate.id()).directTests().isEmpty());
        assertEquals("indirect", byId.get(range.id()).status());
        CodeCoverage none = byId.get(create.id());
        assertEquals("none", none.status());
        assertTrue(none.directTests().isEmpty() && none.indirectTests().isEmpty());

        assertEquals(3, none.branches()); // if, &&, || - not "?:" and "??"
        assertEquals(1, byId.get(validate.id()).branches());
        assertEquals(5, none.changedLines()); // "} else {" and closing braces do not count
        assertEquals(5 * (1 + 3), none.risk());

        // none first, then indirect (higher risk first), then direct
        assertEquals(List.of(create.id(), validate.id(), range.id(), update.id()),
                analysis.coverage().stream().map(CodeCoverage::segmentId).toList());
        assertTrue(byId.get(validate.id()).risk() > byId.get(range.id()).risk());

        assertEquals("tests", analysis.categories().stream().filter(c -> c.id().equals("tests")).findFirst().orElseThrow().view());
    }

    @Test
    void categoriesWithoutNeedForTestsAreLeftOut() throws Exception {
        JsonNode root = new ObjectMapper().readTree(rulesJson());
        for (JsonNode c : root.path("categories")) {
            if (c.path("id").asText().equals("logic")) {
                ((ObjectNode) c).put("needsTests", false);
            }
        }
        Rules rules = Rules.parse(root, "test");
        assertTrue(!rules.needsTests("logic") && !rules.needsTests("quick-wins") && rules.needsTests("unknown"));
        Analysis analysis = analyse(rules);
        assertNotNull(analysis.coverage());
        assertTrue(analysis.coverage().isEmpty(), "all changed functions are plain logic, now marked as not needing tests");
    }

    @Test
    void recognisesTrivialAccessors() {
        assertTrue(Coverage.isTrivialAccessor(code("public String getName() {\n    return name;\n}")));
        assertTrue(Coverage.isTrivialAccessor(code("public int getNumber() { return this.number; }")));
        assertTrue(Coverage.isTrivialAccessor(code("public void setName(String name) {\n    // keep it\n    this.name = name;\n}")));
        assertTrue(Coverage.isTrivialAccessor(code("get label(): string {\n  return this._label;\n}")));
        assertTrue(Coverage.isTrivialAccessor(code("set label(value: string) {\n  this._label = value;\n}")));
        assertTrue(Coverage.isTrivialAccessor(code("func (p *Player) Name() string {\n\treturn p.name\n}")));

        assertTrue(!Coverage.isTrivialAccessor(code("int total() {\n  return a + b;\n}")), "computation");
        assertTrue(!Coverage.isTrivialAccessor(code("String name() {\n  return repo.find(id);\n}")), "call");
        assertTrue(!Coverage.isTrivialAccessor(code("void setName(String n) {\n  this.name = n;\n  changed();\n}")), "two statements");
        assertTrue(!Coverage.isTrivialAccessor(code("void setName(String n) {\n  this.name = n.trim();\n}")), "transforms the value");
        assertTrue(!Coverage.isTrivialAccessor(code("String label() {\n  return \"fixed\";\n}")), "string literal");
        assertTrue(!Coverage.isTrivialAccessor(code("label = () => this.name;")), "no braces: stays in the coverage");
    }

    @Test
    void entityLogicNeedsTestsButAccessorsDoNot() throws Exception {
        String entity = """
                package app;

                @Entity
                public class Player {
                    private String name;
                    private int jerseyNumber;

                    public String getName() {
                        return name;
                    }

                    public void setName(String name) {
                        this.name = name;
                    }

                    public int getJerseyNumber() { return this.jerseyNumber; }

                    public boolean isJerseyNumberTaken(List<Player> others) {
                        return others.stream().anyMatch(p -> p != this && p.jerseyNumber == jerseyNumber);
                    }
                }
                """;
        String path = "src/main/java/app/Player.java";
        Snapshot snapshot = new Snapshot(1, "now", info(), List.of(added(path, entity)));
        Analysis analysis = new Analyzer(defaultRules()).analyze(snapshot, Map.of(path, entity));
        Segment taken = segment(analysis, "Player.isJerseyNumberTaken");
        assertEquals("persistence", taken.category());
        assertEquals(List.of(taken.id()), analysis.coverage().stream().map(CodeCoverage::segmentId).toList(),
                "the entity's real logic is testable, its getters and setters are not");
    }

    private static List<String> code(String source) {
        return CodeText.of(source).code;
    }

    private static Analysis analyse(Rules rules) {
        Snapshot snapshot = new Snapshot(1, "now", info(), List.of(
                added("src/app/player.service.ts", SERVICE),
                added("src/app/player.service.spec.ts", SPEC),
                added("src/app/player.mapper.ts", MAPPER)));
        return new Analyzer(rules).analyze(snapshot, Map.of(
                "src/app/player.service.ts", SERVICE,
                "src/app/player.service.spec.ts", SPEC,
                "src/app/player.mapper.ts", MAPPER));
    }

    private static Segment segment(Analysis analysis, String symbol) {
        Segment s = analysis.segments().stream().filter(x -> symbol.equals(x.symbol())).findFirst().orElse(null);
        assertNotNull(s, "segment " + symbol);
        return s;
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

    private static PullRequestInfo info() {
        return new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open", "main", "feature",
                "base", "head", "", "", 0, 0, 0, null);
    }

    private static String rulesJson() throws Exception {
        try (InputStream in = CoverageTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static Rules defaultRules() throws Exception {
        return Rules.parse(new ObjectMapper().readTree(rulesJson()), "test");
    }
}
