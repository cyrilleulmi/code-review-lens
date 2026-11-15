package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.analysis.TestSmells.MockedMember;
import dev.smartcodereview.model.Model.TestProfile;
import dev.smartcodereview.model.Model.TestSmell;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Test-Smells: each smell found and not found, per rules. */
class TestSmellsTest {

    private static final Rules RULES = rules(null);

    private static Rules rules(java.util.function.Consumer<ObjectNode> change) {
        try (InputStream in = TestSmellsTest.class.getResourceAsStream("/rules/default-rules.json")) {
            JsonNode root = new ObjectMapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            if (change != null) {
                change.accept((ObjectNode) root);
            }
            return Rules.parse(root, "test");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static List<TestSmell> smells(String path, String source, String testName, List<String> targets, Set<String> realKeys,
                                          List<MockedMember> mocked, boolean isNew, Rules rules) {
        CodeText text = CodeText.of(source);
        List<Symbol> symbols = SymbolExtractor.extract(text, path);
        Symbol test = symbols.stream().filter(s -> s.kind().equals("test") && s.name().equals(testName)).findFirst()
                .orElseThrow(() -> new AssertionError("no test " + testName + " in " + symbols));
        String file = path.substring(path.lastIndexOf('/') + 1);
        String unit = file.replaceAll("(\\.spec|\\.test|_test|Test)?\\.[a-z]+$", "");
        TestProfile profile = new TestProfiles(rules).profile(path, text, symbols, test, targets, unit);
        return new TestSmells(rules).detect(new TestSmells.Input(text, symbols, test, profile, unit, realKeys, mocked, isNew));
    }

    private static List<String> kinds(String path, String source, String testName) {
        return smells(path, source, testName, List.of(), Set.of(), List.of(), false, RULES).stream().map(TestSmell::kind).toList();
    }

    private static List<String> kinds(String path, String source, String testName, List<String> targets) {
        return smells(path, source, testName, targets, Set.of(), List.of(), false, RULES).stream().map(TestSmell::kind).toList();
    }

    // ------------------------------------------------------------------ no assertion / weak only

    @Test
    void noAssertion() {
        String spec = """
                describe('PlayerView', () => {
                  it('saves the number', async () => {
                    await render();
                    view.save('12');
                  });
                });
                """;
        List<TestSmell> found = smells("a.spec.ts", spec, "saves the number", List.of(), Set.of(), List.of(), false, RULES);
        assertEquals(List.of("no-assertion"), found.stream().map(TestSmell::kind).toList());
        assertEquals("keine Assertion", found.getFirst().label());
        assertEquals(2, found.getFirst().line());
        assertNotNull(found.getFirst().hint());
    }

    @Test
    void verifyAndExpectOneAreAssertions() {
        String java = """
                class PlayerTest {
                    @Test
                    void notifies() {
                        service.notifyAll();
                        verify(sender).send(any());
                    }
                }
                """;
        assertEquals(List.of(), kinds("PlayerTest.java", java, "notifies"));
        String spec = """
                describe('S', () => {
                  it('loads', () => {
                    svc.load();
                    httpMock.expectOne('/api/x');
                  });
                  it('calls', () => {
                    svc.load();
                    expect(spy).toHaveBeenCalled();
                  });
                });
                """;
        assertEquals(List.of(), kinds("s.spec.ts", spec, "loads"));
        assertEquals(List.of(), kinds("s.spec.ts", spec, "calls")); // a call check is an interaction, not an existence check
    }

    @Test
    void expectedExceptionAnnotationIsNoSmell() {
        String java = """
                class PlayerTest {
                    @Test(expected = IllegalArgumentException.class)
                    void rejects() {
                        service.create(null);
                    }
                }
                """;
        assertEquals(List.of(), kinds("PlayerTest.java", java, "rejects"));
    }

    @Test
    void weakOnly() {
        String spec = """
                describe('PlayerView', () => {
                  it('shows it', async () => {
                    const el = await render();
                    expect(el).toBeTruthy();
                    expect(el.textContent).toBeDefined();
                  });
                  it('shows it for real', async () => {
                    const el = await render();
                    expect(el).toBeTruthy();
                    expect(el.textContent).toContain('Carmela');
                  });
                });
                """;
        assertEquals(List.of("weak-only"), kinds("a.spec.ts", spec, "shows it"));
        assertEquals(List.of(), kinds("a.spec.ts", spec, "shows it for real"));
        String java = """
                class PlayerTest {
                    @Test
                    void returns() {
                        assertNotNull(resource.update(1, null));
                    }
                }
                """;
        List<TestSmell> found = smells("PlayerTest.java", java, "returns", List.of(), Set.of(), List.of(), false, RULES);
        assertEquals(List.of("weak-only"), found.stream().map(TestSmell::kind).toList());
        assertEquals(4, found.getFirst().line());
        assertEquals("assertNotNull(resource.update(1, null));", found.getFirst().code());
    }

    // ------------------------------------------------------------------ focused

    @Test
    void focusedTestOrSuite() {
        String spec = """
                describe('A', () => {
                  fit('runs alone', () => { expect(a()).toBe(1); });
                  it('is fine', () => { expect(a()).toBe(1); });
                  it.only('also alone', () => { expect(a()).toBe(1); });
                });
                fdescribe('B', () => {
                  it('inside a focused suite', () => { expect(b()).toBe(1); });
                });
                describe('C', () => {
                  it('mentions fit( in its name', () => { expect(c()).toBe(1); });
                  it('uses a fit() method', () => { expect(wardrobe.fit('x')).toBe(1); });
                });
                """;
        assertEquals(List.of("focused"), kinds("a.spec.ts", spec, "runs alone"));
        assertEquals(List.of(), kinds("a.spec.ts", spec, "is fine"));
        assertEquals(List.of("focused"), kinds("a.spec.ts", spec, "also alone"));
        assertEquals(List.of("focused"), kinds("a.spec.ts", spec, "inside a focused suite"));
        assertEquals(List.of(), kinds("a.spec.ts", spec, "uses a fit() method"));
        assertEquals(List.of(), kinds("a.spec.ts", spec, "mentions fit( in its name"));
        TestSmell s = smells("a.spec.ts", spec, "runs alone", List.of(), Set.of(), List.of(), false, RULES).getFirst();
        assertEquals(2, s.line());
    }

    // ------------------------------------------------------------------ sleep

    @Test
    void sleepInTheBody() {
        String java = """
                class PlayerTest {
                    @Test
                    void waits() throws Exception {
                        resource.update(1, null);
                        Thread.sleep(2000);
                        assertEquals(1, count());
                    }
                    @Test
                    void waitsWithUnit() throws Exception {
                        TimeUnit.SECONDS.sleep(1);
                        assertEquals(1, count());
                    }
                    @Test
                    void names() {
                        String s = "Thread.sleep(1)";
                        assertEquals(1, count());
                    }
                }
                """;
        List<TestSmell> found = smells("PlayerTest.java", java, "waits", List.of(), Set.of(), List.of(), false, RULES);
        assertEquals(List.of("sleep"), found.stream().map(TestSmell::kind).toList());
        assertEquals(5, found.getFirst().line());
        assertEquals(List.of("sleep"), kinds("PlayerTest.java", java, "waitsWithUnit"));
        assertEquals(List.of(), kinds("PlayerTest.java", java, "names")); // text in a string is no call
        assertEquals(List.of("sleep"), kinds("x_test.go", """
                func TestWaits(t *testing.T) {
                	time.Sleep(time.Second)
                	assert.Equal(t, 1, count())
                }
                """, "TestWaits"));
    }

    @Test
    void setTimeoutIsASleepUnlessFakeTimers() {
        String real = """
                describe('A', () => {
                  it('waits', async () => {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    expect(a()).toBe(1);
                  });
                });
                """;
        assertEquals(List.of("sleep"), kinds("a.spec.ts", real, "waits"));
        String jest = """
                describe('A', () => {
                  beforeEach(() => jest.useFakeTimers());
                  it('waits', async () => {
                    setTimeout(() => done(), 500);
                    jest.advanceTimersByTime(500);
                    expect(a()).toBe(1);
                  });
                });
                """;
        assertEquals(List.of(), kinds("a.spec.ts", jest, "waits"));
        String ng = """
                describe('A', () => {
                  it('waits', fakeAsync(() => {
                    setTimeout(() => done(), 500);
                    tick(500);
                    expect(a()).toBe(1);
                  }));
                });
                """;
        assertEquals(List.of(), kinds("a.spec.ts", ng, "waits"));
        // fake timers never excuse a real Thread.sleep
        String mixed = """
                describe('A', () => {
                  beforeEach(() => vi.useFakeTimers());
                  it('waits', () => {
                    Thread.sleep(10);
                    expect(a()).toBe(1);
                  });
                });
                """;
        assertEquals(List.of("sleep"), kinds("a.spec.ts", mixed, "waits"));
    }

    // ------------------------------------------------------------------ mocks the subject

    @Test
    void mockedUnitUnderTest() {
        String java = """
                class PlayerResourceTest {
                    @Test
                    void updates() {
                        PlayerResource resource = mock(PlayerResource.class);
                        when(resource.update(any(), any())).thenReturn(null);
                        resource.update(1, null);
                        verify(resource).update(1, null);
                    }
                    @Test
                    void usesACollaborator() {
                        PlayerRepository repo = mock(PlayerRepository.class);
                        when(repo.find(1)).thenReturn(null);
                        assertNull(new PlayerResource(repo).get(1));
                    }
                }
                """;
        // the unit named like the test file (PlayerResourceTest -> PlayerResource) is mocked
        List<TestSmell> found = smells("PlayerResourceTest.java", java, "updates", List.of(), Set.of(), List.of(), false, RULES);
        assertEquals(List.of("mocks-subject"), found.stream().map(TestSmell::kind).toList());
        assertEquals(List.of(), kinds("PlayerResourceTest.java", java, "usesACollaborator"));
    }

    @Test
    void mockedClassOfTheChangedCodeTheTestCalls() {
        String java = """
                class JerseyNumberTest {
                    @Test
                    void viaAMock() {
                        PlayerResource mocked = mock(PlayerResource.class);
                        when(mocked.update(any(), any())).thenReturn(null);
                        mocked.update(1, null);
                        verify(mocked).update(1, null);
                    }
                    @Test
                    void onlyStubbed() {
                        PlayerResource mocked = mock(PlayerResource.class);
                        when(mocked.update(any(), any())).thenReturn(null);
                        assertNull(service.touch(1));
                        verify(mocked).update(1, null);
                    }
                }
                """;
        Set<String> owner = Set.of("playerresource");
        // (a) the test calls changed code of PlayerResource for real while it also mocks PlayerResource
        List<TestSmell> a = smells("JerseyNumberTest.java", java, "viaAMock", List.of("update"), owner, List.of(), false, RULES);
        assertEquals(List.of("mocks-subject"), a.stream().map(TestSmell::kind).toList());
        // (b) the test runs the changed code of the mock outside stubbing and verification
        List<TestSmell> b = smells("JerseyNumberTest.java", java, "viaAMock", List.of("update"), Set.of(),
                List.of(new MockedMember("update", owner)), false, RULES);
        assertEquals(List.of("mocks-subject"), b.stream().map(TestSmell::kind).toList());
        assertEquals(6, b.getFirst().line());
        // stubbing and verification of a mock are no smell
        List<TestSmell> c = smells("JerseyNumberTest.java", java, "onlyStubbed", List.of(), Set.of(),
                List.of(new MockedMember("update", owner)), false, RULES);
        assertEquals(List.of(), c.stream().map(TestSmell::kind).toList());
    }

    @Test
    void spyOnTheSubjectItself() {
        String spec = """
                describe('PlayerView', () => {
                  it('spies on its own method', () => {
                    const save = jest.spyOn(view, 'saveJerseyNumber').mockImplementation(() => undefined);
                    view.saveJerseyNumber('12');
                    expect(save).toHaveBeenCalledWith('12');
                  });
                  it('spies on the component', () => {
                    spyOn(component, 'refresh');
                    component.reload();
                    expect(component.refresh).toHaveBeenCalledTimes(1);
                  });
                  it('spies on a collaborator', () => {
                    const load = jest.spyOn(service, 'loadPlayers').mockReturnValue(of([]));
                    view.saveJerseyNumber('12');
                    expect(load).toHaveBeenCalled();
                  });
                  it('only watches the target', () => {
                    spyOn(view, 'saveJerseyNumber').and.callThrough();
                    view.saveJerseyNumber('12');
                    expect(view.number).toBe('12');
                  });
                });
                """;
        List<String> targets = List.of("saveJerseyNumber");
        List<TestSmell> own = smells("player-view.spec.ts", spec, "spies on its own method", targets, Set.of(), List.of(), false, RULES);
        assertEquals(List.of("mocks-subject"), own.stream().map(TestSmell::kind).toList());
        assertEquals(3, own.getFirst().line());
        assertEquals(List.of("mocks-subject"), kinds("player-view.spec.ts", spec, "spies on the component", targets));
        assertEquals(List.of(), kinds("player-view.spec.ts", spec, "spies on a collaborator", targets));
        assertEquals(List.of(), kinds("player-view.spec.ts", spec, "only watches the target", targets));
    }

    // ------------------------------------------------------------------ disabled

    @Test
    void disabledOnlyForNewTests() {
        String spec = """
                describe('A', () => {
                  xit('never runs', () => { expect(a()).toBe(1); });
                  it('runs', () => { expect(a()).toBe(1); });
                });
                xdescribe('B', () => {
                  it('inside', () => { expect(b()).toBe(1); });
                });
                """;
        List<TestSmell> fresh = smells("a.spec.ts", spec, "never runs", List.of(), Set.of(), List.of(), true, RULES);
        assertEquals(List.of("disabled"), fresh.stream().map(TestSmell::kind).toList());
        assertEquals(2, fresh.getFirst().line());
        assertEquals(List.of("disabled"), smells("a.spec.ts", spec, "inside", List.of(), Set.of(), List.of(), true, RULES)
                .stream().map(TestSmell::kind).toList());
        // a test of the base version: the expectation change "disabled" shows it
        assertEquals(List.of(), smells("a.spec.ts", spec, "never runs", List.of(), Set.of(), List.of(), false, RULES)
                .stream().map(TestSmell::kind).toList());
        assertEquals(List.of(), smells("a.spec.ts", spec, "runs", List.of(), Set.of(), List.of(), true, RULES)
                .stream().map(TestSmell::kind).toList());
        String java = """
                class PlayerTest {
                    @Test
                    @Disabled("later")
                    void waits() {
                        assertEquals(1, count());
                    }
                }
                """;
        assertEquals(List.of("disabled"), smells("PlayerTest.java", java, "waits", List.of(), Set.of(), List.of(), true, RULES)
                .stream().map(TestSmell::kind).toList());
    }

    // ------------------------------------------------------------------ rules

    @Test
    void aSmellCanBeSwitchedOffAndKeysFallBackToBuiltIns() {
        Rules off = rules(root -> {
            ObjectNode smells = new ObjectMapper().createObjectNode();
            smells.putObject("no-assertion").put("enabled", false);
            smells.putObject("sleep").put("label", "Eigener Text");
            root.set("testSmells", smells);
        });
        String spec = """
                describe('A', () => {
                  it('only calls', async () => {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                  });
                });
                """;
        List<TestSmell> found = smells("a.spec.ts", spec, "only calls", List.of(), Set.of(), List.of(), false, off);
        assertEquals(List.of("sleep"), found.stream().map(TestSmell::kind).toList()); // no-assertion is off
        assertEquals("Eigener Text", found.getFirst().label());
        assertTrue(found.getFirst().hint().length() > 10, "the hint comes from the built-in rules");
        assertEquals(List.of("no-assertion", "sleep"), smells("a.spec.ts", spec, "only calls", List.of(), Set.of(), List.of(), false, RULES)
                .stream().map(TestSmell::kind).toList());
    }

    @Test
    void aRulesFileWithoutTheSectionUsesTheBuiltIns() {
        Rules none = rules(root -> root.remove("testSmells"));
        assertEquals(6, none.testSmells.size());
        assertFalse(none.testSmells.get("focused").patterns().get("patterns").isEmpty());
        assertNull(none.testSmells.get("disabled").patterns().get("nothing"));
    }
}
