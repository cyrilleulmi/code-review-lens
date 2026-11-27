package dev.codereviewlens.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CaseColumn;
import dev.codereviewlens.model.Model.CaseMatrix;
import dev.codereviewlens.model.Model.CaseRow;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static dev.codereviewlens.analysis.SpecsTest.added;
import static dev.codereviewlens.analysis.SpecsTest.analyse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Fallmatrix: similar and parameterised tests as tables input → expected, with duplicates and covered values. */
class CaseMatricesTest {

    private static final CaseMatrices MATRICES = new CaseMatrices(rules());

    /** Every test counts as changed (segment "seg:<name>"). */
    private static List<CaseMatrix> matrices(String path, String source) {
        return MATRICES.of(path, source, (p, s) -> "seg:" + s.name());
    }

    private static List<String> labels(CaseMatrix m) {
        return m.columns().stream().map(c -> c.label() + (c.role().equals(CaseMatrices.INPUT) ? "" : " =>")).toList();
    }

    private static List<String> row(CaseMatrix m, int i) {
        return m.rows().get(i).values();
    }

    // ------------------------------------------------------------------ similar tests

    @Test
    void similarRestAssuredTestsWithADuplicate() {
        String java = """
                @QuarkusTest
                class JerseyNumberApiTest {
                    @BeforeEach
                    void createPlayer() {
                        player = testData.createPlayer("Carmela");
                    }

                    @Test
                    void setsJerseyNumberSeven() {
                        putJerseyNumber(7).then().statusCode(200).body("jerseyNumber", equalTo(7));
                    }

                    @Test
                    void setsJerseyNumberTwentyThree() {
                        putJerseyNumber(23).then().statusCode(200).body("jerseyNumber", equalTo(23));
                    }

                    @Test
                    void rejectsJerseyNumberZero() {
                        putJerseyNumber(0).then().statusCode(400);
                    }

                    @Test
                    void rejectsJerseyNumberOneHundredFifty() {
                        putJerseyNumber(150).then().statusCode(400);
                    }

                    @Test
                    void storesTheLuckyNumber() {
                        putJerseyNumber(7).then().statusCode(200).body("jerseyNumber", equalTo(7));
                    }

                    private Response putJerseyNumber(int jerseyNumber) {
                        return given().body(Map.of("jerseyNumber", jerseyNumber)).when().put("/api/players/" + player.id);
                    }
                }
                """;
        List<CaseMatrix> all = matrices("src/test/java/JerseyNumberApiTest.java", java);
        assertEquals(1, all.size(), all.toString());
        CaseMatrix m = all.getFirst();
        assertEquals(CaseMatrices.SIMILAR, m.kind());
        assertEquals("JerseyNumberApiTest › putJerseyNumber(…)", m.title());
        assertEquals(List.of("putJerseyNumber(…) Arg 1", "statusCode =>", "jerseyNumber =>"), labels(m));
        assertEquals(List.of("0", "7", "23", "150"), m.columns().getFirst().values(), "covered values, numerically sorted");
        assertEquals(List.of(), m.columns().get(1).values());
        assertEquals(Arrays.asList("7", "200", "equalTo(7)"), row(m, 0));
        assertEquals(Arrays.asList("0", "400", null), row(m, 2), "the rejecting tests do not check the body");
        assertEquals(List.of("setsJerseyNumberSeven", "setsJerseyNumberTwentyThree", "rejectsJerseyNumberZero",
                "rejectsJerseyNumberOneHundredFifty", "storesTheLuckyNumber"), m.rows().stream().map(CaseRow::name).toList());
        CaseRow lucky = m.rows().get(4);
        assertEquals(0, lucky.duplicateOf(), "same input as setsJerseyNumberSeven");
        assertFalse(lucky.contradicts());
        assertNull(m.rows().get(1).duplicateOf());
        assertEquals(9, m.rows().getFirst().line());
        assertEquals("seg:setsJerseyNumberSeven", m.rows().getFirst().segmentId());
        assertEquals("putJerseyNumber(‹1›).then().statusCode(‹2›).body(\"jerseyNumber\", ‹3›);", m.template());
    }

    @Test
    void typeScriptTestsDifferingInInputTextAndExpectedMessage() {
        String spec = """
                describe('PlayerForm', () => {
                  describe('name', () => {
                    it('rejects an empty name', () => {
                      const form = new PlayerForm(42);
                      form.setName('');
                      expect(form.error).toBe('Name fehlt');
                    });

                    it('rejects a name that is too long', () => {
                      const form = new PlayerForm(42);
                      form.setName('Maximiliane-Alexandra von Hohenberg-Lichtenstein');
                      expect(form.error).toBe('Name zu lang');
                    });

                    it('accepts a short name', () => {
                      const form = new PlayerForm(42);
                      form.setName('Ann');
                      expect(form.error).toBeNull();
                    });

                    it('trims the name', () => {
                      const form = new PlayerForm(42);
                      form.setName('  Ann ');
                      form.submit();
                      expect(form.value.name).toBe('Ann');
                    });
                  });
                });
                """;
        List<CaseMatrix> all = matrices("src/app/player-form.spec.ts", spec);
        assertEquals(1, all.size(), "the test with an extra submit() differs structurally: " + all);
        CaseMatrix m = all.getFirst();
        assertEquals("PlayerForm › name › setName(…)", m.title());
        assertEquals(List.of("setName(…) Arg 1", "expect(form.error) =>", "expect(form.error) (2) =>"), labels(m),
                "42 is the same everywhere: template, not a column; toBe and toBeNull are different checks");
        assertEquals(Arrays.asList("''", "'Name fehlt'", null), row(m, 0));
        assertEquals(Arrays.asList("'Ann'", null, "✓"), row(m, 2));
        assertEquals(List.of("''", "'Ann'", "'Maximiliane-Alexandra von Hohenberg-Lichtenstein'"), m.columns().getFirst().values());
        assertTrue(m.template().startsWith("const form = new PlayerForm(42);\nform.setName(‹1›);"), m.template());
        assertTrue(m.rows().stream().allMatch(r -> r.duplicateOf() == null));
    }

    @Test
    void contradictoryDuplicateAndUnchangedRows() {
        String spec = """
                describe('discount', () => {
                  it('gives ten percent from 100', () => {
                    expect(discount(100)).toBe(10);
                  });
                  it('gives nothing below 100', () => {
                    expect(discount(99)).toBe(0);
                  });
                  it('gives twenty percent from 100', () => {
                    expect(discount(100)).toBe(20);
                  });
                });
                """;
        // only the last test is changed
        List<CaseMatrix> all = MATRICES.of("src/discount.spec.ts", spec,
                (p, s) -> s.name().startsWith("gives twenty") ? "s9" : null);
        assertEquals(1, all.size());
        CaseMatrix m = all.getFirst();
        assertEquals(List.of("discount(…) Arg 1", "expect(discount(‹›)) =>"), labels(m).stream()
                .map(l -> l.replace("100", "‹›")).toList());
        CaseRow twenty = m.rows().get(2);
        assertEquals(0, twenty.duplicateOf());
        assertTrue(twenty.contradicts(), "same input, other expectation");
        assertNull(m.rows().getFirst().segmentId(), "unchanged test of the file");
        assertEquals("s9", twenty.segmentId());

        List<CaseMatrix> none = MATRICES.of("src/discount.spec.ts", spec, (p, s) -> null);
        assertTrue(none.isEmpty(), "a group without any changed test is no matrix");
    }

    @Test
    void identicalLiteralsAreTemplateAndStructuralDifferencesSplitGroups() {
        String java = """
                class CalculatorTest {
                    @Test
                    void addsSmallNumbers() {
                        Calculator calc = new Calculator("EUR");
                        assertEquals(3, calc.add(1, 2));
                    }

                    @Test
                    void addsLargeNumbers() {
                        Calculator calc = new Calculator("EUR");
                        assertEquals(3000, calc.add(1000, 2000));
                    }

                    @Test
                    void subtracts() {
                        Calculator calc = new Calculator("EUR");
                        assertEquals(1, calc.subtract(3, 2));
                    }
                }
                """;
        List<CaseMatrix> all = matrices("src/test/java/CalculatorTest.java", java);
        assertEquals(1, all.size());
        CaseMatrix m = all.getFirst();
        assertEquals(2, m.rows().size(), "subtract is another call");
        assertEquals(List.of("add(…) Arg 1", "add(…) Arg 2", "calc.add(1, 2) =>"), labels(m));
        assertEquals(List.of("1", "2", "3"), row(m, 0));
        assertEquals("Calculator calc = new Calculator(\"EUR\");\nassertEquals(‹3›, calc.add(‹1›, ‹2›));", m.template());
        assertEquals("CalculatorTest › add(…)", m.title());
    }

    @Test
    void assignedValuesAndObjectKeysNameTheirSlot() {
        String spec = """
                describe('jersey', () => {
                  it('saves seven', () => {
                    const number = 7;
                    save({ jerseyNumber: number, team: 'a' });
                    expect(saved()).toEqual(true);
                  });
                  it('saves twelve', () => {
                    const number = 12;
                    save({ jerseyNumber: number, team: 'b' });
                    expect(saved()).toEqual(true);
                  });
                });
                """;
        CaseMatrix m = matrices("src/jersey.spec.ts", spec).getFirst();
        assertEquals(List.of("number =", "team:"), labels(m), "an expectation equal in all tests is no column");
    }

    // ------------------------------------------------------------------ parameterised tests

    @Test
    void valueSourceAndNullSource() {
        String java = """
                class JerseyNumberValidationTest {
                    @ParameterizedTest
                    @ValueSource(ints = {0, 100, 150})
                    @TestTransaction
                    void rejectsNumbersOutsideTheRange(int jerseyNumber) {
                        Player carmela = newPlayer("Carmela");
                        BadRequestException rejected = assertThrows(BadRequestException.class,
                                () -> resource.update(carmela.id, new PlayerUpdateRequest(null, jerseyNumber)));
                        assertEquals("jersey number must be between 1 and 99", rejected.getMessage());
                    }

                    @ParameterizedTest
                    @NullAndEmptySource
                    @ValueSource(strings = {" "})
                    void rejectsBlankNames(String name) {
                        assertFalse(valid(name));
                    }
                }
                """;
        List<CaseMatrix> all = matrices("src/test/java/JerseyNumberValidationTest.java", java);
        assertEquals(2, all.size());
        CaseMatrix m = all.getFirst();
        assertEquals(CaseMatrices.PARAMETERIZED, m.kind());
        assertEquals("JerseyNumberValidationTest › rejectsNumbersOutsideTheRange", m.title());
        assertEquals(List.of("jerseyNumber"), labels(m), "used in the call under test: input");
        assertEquals(List.of("0", "100", "150"), m.columns().getFirst().values());
        assertEquals(List.of("[1] 0", "[2] 100", "[3] 150"), m.rows().stream().map(CaseRow::name).toList());
        assertEquals(3, m.rows().getFirst().line());
        assertEquals("seg:rejectsNumbersOutsideTheRange", m.rows().get(2).segmentId());
        assertTrue(m.template().contains("new PlayerUpdateRequest(null, ‹1›)"), m.template());

        CaseMatrix blank = all.get(1);
        assertEquals(List.of(List.of("null"), List.of("\"\""), List.of("\" \"")), blank.rows().stream().map(CaseRow::values).toList());
    }

    @Test
    void csvSourceWithAnExpectedColumn() {
        String java = """
                class CalculatorTest {
                    @ParameterizedTest(name = "{0} + {1} = {2}")
                    @CsvSource({
                        "1, 2, 3",
                        "-1, 1, 0",
                        "1, 2, 4",
                    })
                    void adds(int a, int b, int sum) {
                        assertEquals(sum, calculator.add(a, b));
                    }

                    @ParameterizedTest
                    @CsvSource(delimiter = '|', textBlock = \"""
                        # input | expected
                        'Ann'   | 3
                        ''      | 0
                        \""")
                    void measures(String input, int expected) {
                        assertEquals(expected, input.length());
                    }
                }
                """;
        List<CaseMatrix> all = matrices("src/test/java/CalculatorTest.java", java);
        assertEquals(2, all.size(), all.toString());
        CaseMatrix adds = all.getFirst();
        assertEquals(List.of("a", "b", "sum =>"), labels(adds), "sum is only used as the expected value");
        assertEquals(List.of("1 + 2 = 3", "-1 + 1 = 0", "1 + 2 = 4"), adds.rows().stream().map(CaseRow::name).toList());
        assertEquals(List.of("-1", "1"), adds.columns().getFirst().values());
        assertEquals(0, adds.rows().get(2).duplicateOf());
        assertTrue(adds.rows().get(2).contradicts());
        assertEquals(List.of(4, 5, 6), adds.rows().stream().map(CaseRow::line).toList());

        CaseMatrix measures = all.get(1);
        assertEquals(List.of("input", "expected =>"), labels(measures));
        assertEquals(List.of(List.of("'Ann'", "3"), List.of("''", "0")), measures.rows().stream().map(CaseRow::values).toList());
    }

    @Test
    void itEachArrayAndTemplateTable() {
        String spec = """
                describe('PlayerView', () => {
                  describe('invalid input', () => {
                    it.each([
                      ['-3', 400, 'Trikotnummer konnte nicht gespeichert werden.'],
                      ['150', 400, 'Trikotnummer konnte nicht gespeichert werden.'],
                      ['23', 409, 'Die Nummer 23 trägt schon jemand im Team.'],
                    ])('shows the message for the typed text %s (server answers %i)', async (typed, status, message) => {
                      const el = await render();
                      view.saveJerseyNumber(typed);
                      httpMock.expectOne('/api/players/p-1').flush({ error: 'x' }, { status, statusText: 'Error' });
                      expect(el.textContent).toContain(message);
                    });

                    test.each`
                      a    | b    | total
                      ${1} | ${1} | ${2}
                      ${2} | ${1} | ${3}
                    `('returns $total when $a is added to $b', ({ a, b, total }) => {
                      expect(add(a, b)).toBe(total);
                    });

                    it.each([{ input: 'x', valid: false }, { input: 'xy', valid: true }])('checks %o', (row) => {
                      expect(check(row.input)).toBe(row.valid);
                    });
                  });
                });
                """;
        List<CaseMatrix> all = matrices("src/app/player-view.spec.ts", spec);
        assertEquals(3, all.size(), all.toString());
        CaseMatrix each = all.getFirst();
        assertEquals("PlayerView › invalid input › shows the message for the typed text %s (server answers %i)", each.title());
        assertEquals(List.of("typed", "status =>", "message =>"), labels(each),
                "status by its name, message because it is only used in an assertion");
        assertEquals(List.of("'-3'", "400", "'Trikotnummer konnte nicht gespeichert werden.'"), row(each, 0));
        assertEquals("shows the message for the typed text 23 (server answers 409)", each.rows().get(2).name());
        assertEquals(List.of("'-3'", "'150'", "'23'"), each.columns().getFirst().values());
        assertEquals(List.of(4, 5, 6), each.rows().stream().map(CaseRow::line).toList());
        assertTrue(each.template().contains("view.saveJerseyNumber(‹1›);"), each.template());
        assertTrue(each.template().contains("toContain(‹3›)"), each.template());

        CaseMatrix table = all.get(1);
        assertEquals(List.of("a", "b", "total =>"), labels(table));
        assertEquals(List.of("1", "1", "2"), row(table, 0));
        assertEquals("returns 3 when 2 is added to 1", table.rows().get(1).name());

        CaseMatrix objects = all.get(2);
        assertEquals(List.of("input", "valid =>"), labels(objects));
        assertEquals(List.of("'xy'", "true"), row(objects, 1));
        assertTrue(objects.template().contains("check(‹1›)"), objects.template());
    }

    @Test
    void goTableTest() {
        String go = """
                package player

                import "testing"

                func TestValidateJerseyNumber(t *testing.T) {
                	tests := []struct {
                		name  string
                		input int
                		want  error
                	}{
                		{"zero", 0, ErrRange},
                		{"seven", 7, nil},
                		{name: "too big", input: 150, want: ErrRange},
                		{name: "seven again", input: 7, want: nil},
                	}
                	for _, tt := range tests {
                		t.Run(tt.name, func(t *testing.T) {
                			if got := ValidateJerseyNumber(tt.input); got != tt.want {
                				t.Errorf("got %v, want %v", got, tt.want)
                			}
                		})
                	}
                }
                """;
        List<CaseMatrix> all = matrices("player/jersey_test.go", go);
        assertEquals(1, all.size());
        CaseMatrix m = all.getFirst();
        assertEquals(List.of("input", "want =>"), labels(m), "name names the rows, want is an expectation by its name");
        assertEquals(List.of("zero", "seven", "too big", "seven again"), m.rows().stream().map(CaseRow::name).toList());
        assertEquals(List.of("150", "ErrRange"), row(m, 2));
        assertEquals(1, m.rows().get(3).duplicateOf());
        assertFalse(m.rows().get(3).contradicts());
        assertEquals(List.of(11, 12, 13, 14), m.rows().stream().map(CaseRow::line).toList());
        assertTrue(m.template().startsWith("for _, tt := range tests {"), m.template());
        assertTrue(m.template().contains("ValidateJerseyNumber(‹1›)"), m.template());
    }

    // ------------------------------------------------------------------ in the analysis

    @Test
    void analysisListsTheMatricesOfChangedTestFilesButNotForTheWholeRepository() throws Exception {
        String path = "src/app/discount.spec.ts";
        String spec = """
                describe('discount', () => {
                  it('gives ten percent from 100', () => {
                    expect(discount(100)).toBe(10);
                  });
                  it('gives nothing below 100', () => {
                    expect(discount(99)).toBe(0);
                  });
                });
                """;
        Analysis analysis = analyse(List.of(added(path, spec)), Map.of(path, spec), Map.of());
        assertEquals(1, analysis.caseMatrices().size());
        CaseMatrix m = analysis.caseMatrices().getFirst();
        assertEquals("m1", m.id());
        assertTrue(m.rows().stream().allMatch(r -> r.segmentId() != null), "added tests have segments");
        CaseColumn input = m.columns().getFirst();
        assertEquals(List.of("99", "100"), input.values());

        PullRequestInfo repo = new PullRequestInfo("github", "o", "r", 0, "t", "", "me", "", false, "open", "main", "main",
                "base", "head", "", "", 0, 0, 0, null);
        Analysis whole = new Analyzer(rules()).analyze(new Snapshot(1, "now", repo, List.of(added(path, spec))),
                new HashMap<>(Map.of(path, spec)), null, Map.of());
        assertTrue(whole.caseMatrices().isEmpty());
    }

    private static Rules rules() {
        try (InputStream in = CaseMatricesTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8)), "test");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
