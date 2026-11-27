package dev.codereviewlens.analysis;

import dev.codereviewlens.model.Model.ExpectationChange;
import dev.codereviewlens.model.Model.SpecEntry;
import dev.codereviewlens.model.Model.SpecFile;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static dev.codereviewlens.analysis.SpecsTest.analyse;
import static dev.codereviewlens.analysis.SpecsTest.entry;
import static dev.codereviewlens.analysis.SpecsTest.modified;
import static dev.codereviewlens.analysis.SpecsTest.only;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Changed expectations: assertions of existing tests old against new, switched-off tests. */
class ExpectationsTest {

    private static final String TS = "src/app/player.service.spec.ts";
    private static final String JAVA = "src/test/java/app/PlayerResourceTest.java";

    private static SpecFile spec(String path, String before, String after) throws Exception {
        return only(analyse(List.of(modified(path, before, after)), Map.of(path, after), Map.of(path, before)));
    }

    private static List<String> changes(SpecEntry e) {
        return e.expectations().stream().map(ExpectationsTest::describe).toList();
    }

    private static String describe(ExpectationChange c) {
        return c.kind() + " " + (c.oldLine() == null ? "-" : c.oldLine()) + ":" + (c.oldText() == null ? "" : c.oldText())
                + " > " + (c.newLine() == null ? "-" : c.newLine()) + ":" + (c.newText() == null ? "" : c.newText());
    }

    @Test
    void changedRemovedAddedAndWeakenedInTypeScript() throws Exception {
        String before = """
                describe('PlayerService', () => {
                  it('computes the score', () => {
                    expect(score(3)).toBe(9);
                    expect(score(0)).toBe(0);
                  });

                  it('creates a player', () => {
                    const p = create('Ann');
                    expect(p.name).toEqual('Ann');
                  });

                  it('lists players', () => {
                    expect(list()).toEqual(['Ann', 'Bob']);
                    expect(list().length).toBe(2);
                    expect(spy).toHaveBeenCalledWith('x');
                  });

                  it('formats', () => {
                    expect(format(1)).toBe('1');
                  });
                });
                """;
        String after = """
                describe('PlayerService', () => {
                  it('computes the score', () => {
                    expect(score(3)).toBe(6);
                    expect(score(0)).toBe(0);
                  });

                  it('creates a player', () => {
                    const p = create('Ann');
                    expect(p.name).toBeTruthy();
                  });

                  it('lists players', () => {
                    expect(list()).toEqual(['Ann', 'Bob']);
                    expect(spy).toHaveBeenCalledWith('x');
                  });

                  it('formats', () => {
                    expect(format(1))
                      .toBe('1');
                    expect(format(2)).toBe('2');
                  });
                });
                """;
        SpecFile spec = spec(TS, before, after);

        SpecEntry score = entry(spec, "computes the score");
        assertEquals(List.of("changed 3:expect(score(3)).toBe(9); > 3:expect(score(3)).toBe(6);"), changes(score));
        assertEquals(2, score.assertionsBefore());
        assertEquals(2, score.assertionsAfter());

        assertEquals(List.of("weakened 9:expect(p.name).toEqual('Ann'); > 9:expect(p.name).toBeTruthy();"),
                changes(entry(spec, "creates a player")));

        SpecEntry list = entry(spec, "lists players");
        assertEquals(List.of("removed 14:expect(list().length).toBe(2); > -:"), changes(list));
        assertEquals(3, list.assertionsBefore());
        assertEquals(2, list.assertionsAfter());

        // a statement split over two lines is the same assertion; the new one is added
        SpecEntry format = entry(spec, "formats");
        assertEquals(List.of("added -: > 20:expect(format(2)).toBe('2');"), changes(format));
        assertEquals(1, format.assertionsBefore());
        assertEquals(2, format.assertionsAfter());

        SpecEntry suite = entry(spec, "PlayerService");
        assertTrue(suite.expectations().isEmpty());
        assertNull(suite.assertionsBefore());
        assertFalse(suite.disabled());
    }

    @Test
    void removedWhileOnlyWeakAssertionsRemainIsWeakened() throws Exception {
        String before = """
                it('loads the player', async () => {
                  const p = await load(1);
                  expect(p).toBeDefined();
                  expect(p.name).toBe('Ann');
                });
                """;
        String after = """
                it('loads the player', async () => {
                  const p = await load(1);
                  expect(p).toBeDefined();
                });
                """;
        SpecEntry e = entry(spec(TS, before, after), "loads the player");
        assertEquals(List.of("weakened 4:expect(p.name).toBe('Ann'); > -:"), changes(e));
    }

    @Test
    void whitespaceOnlyReformattingIsNoChange() throws Exception {
        String before = """
                it('saves', () => {
                  expect(save({ name: 'Ann', number: 7 })).toEqual({ id: 1, name: 'Ann' });
                  expect(repo.save).toHaveBeenCalledWith(player);
                });
                """;
        String after = """
                it('saves', () => {
                  expect(save({name: 'Ann', number: 7})).toEqual({
                    id: 1,
                    name: 'Ann',
                  });
                  expect(repo.save)
                    .toHaveBeenCalledWith(player);
                });
                """;
        SpecEntry e = entry(spec(TS, before, after), "saves");
        assertEquals("changed", e.status());
        assertTrue(e.expectations().isEmpty(), changes(e).toString());
        assertEquals(2, e.assertionsBefore());
        assertEquals(2, e.assertionsAfter());
    }

    @Test
    void junitExpectedFirstMockitoAssertJAndDisabled() throws Exception {
        String before = """
                class PlayerResourceTest {

                    @Test
                    void createsPlayer() {
                        Response response = post("/players");
                        assertEquals(201, response.status());
                        assertEquals("location", "/players/1", response.header("Location"));
                    }

                    @Test
                    void verifySaved() {
                        create("Ann");
                        verify(repo).save(player);
                        assertThat(player.getName()).isEqualTo("Ann");
                    }

                    @Test
                    void deletesPlayer() {
                        assertEquals(204, delete("/players/1").status());
                    }

                    @Test
                    void shouldBeRemoved() {
                        assertTrue(gone());
                        assertFalse(present());
                    }
                }
                """;
        String after = """
                class PlayerResourceTest {

                    @Test
                    void createsPlayer() {
                        Response response = post("/players");
                        assertEquals(200, response.status());
                        assertEquals("location", "/players/2", response.header("Location"));
                    }

                    @Test
                    void verifySaved() {
                        create("Ann");
                        verify(repo, never()).save(player);
                        assertThat(player.getName()).isNotNull();
                    }

                    @Disabled("flaky")
                    @Test
                    void deletesPlayer() {
                        assertEquals(204, delete("/players/1").status());
                    }
                }
                """;
        SpecFile spec = spec(JAVA, before, after);

        assertEquals(List.of(
                "changed 6:assertEquals(201, response.status()); > 6:assertEquals(200, response.status());",
                "changed 7:assertEquals(\"location\", \"/players/1\", response.header(\"Location\")); > "
                        + "7:assertEquals(\"location\", \"/players/2\", response.header(\"Location\"));"),
                changes(entry(spec, "createsPlayer")));

        SpecEntry saved = entry(spec, "verifySaved");
        assertEquals(List.of(
                "changed 13:verify(repo).save(player); > 13:verify(repo, never()).save(player);",
                "weakened 14:assertThat(player.getName()).isEqualTo(\"Ann\"); > 14:assertThat(player.getName()).isNotNull();"),
                changes(saved));
        assertEquals(2, saved.assertionsBefore(), "the test name verifySaved is no assertion");

        SpecEntry deletes = entry(spec, "deletesPlayer");
        assertTrue(deletes.disabled());
        assertEquals(List.of("disabled -: > 17:@Disabled(\"flaky\")"), changes(deletes));

        SpecEntry removed = entry(spec, "shouldBeRemoved");
        assertEquals("removed", removed.status());
        assertTrue(removed.expectations().isEmpty(), "the assertions of a removed test are not listed one by one");
        assertEquals(2, removed.assertionsBefore());
        assertNull(removed.assertionsAfter());
    }

    @Test
    void disabledViaXitSkipAndEnclosingSuite() throws Exception {
        String before = """
                describe('Player', () => {
                  it('has a name', () => {
                    expect(player.name).toBe('Ann');
                  });

                  it('has a number', () => {
                    expect(player.number).toBe(7);
                  });

                  describe('transfer', () => {
                    it('moves the player', () => {
                      expect(move(player)).toBe(true);
                    });
                  });

                  xit('was off', () => {
                    expect(off()).toBe(1);
                  });
                });
                """;
        String after = """
                describe('Player', () => {
                  xit('has a name', () => {
                    expect(player.name).toBe('Ann');
                  });

                  it.skip('has a number', () => {
                    expect(player.number).toBe(7);
                  });

                  xdescribe('transfer', () => {
                    it('moves the player', () => {
                      expect(move(player)).toBe(true);
                    });
                  });

                  it('was off', () => {
                    expect(off()).toBe(1);
                  });
                });
                """;
        SpecFile spec = spec(TS, before, after);
        assertEquals(List.of("disabled -: > 2:xit('has a name', () => {"), changes(entry(spec, "has a name")));
        assertEquals(List.of("disabled -: > 6:it.skip('has a number', () => {"), changes(entry(spec, "has a number")));
        assertEquals(List.of("disabled -: > 10:xdescribe('transfer', () => {"), changes(entry(spec, "transfer")));

        SpecEntry moves = entry(spec, "moves the player");
        assertEquals("unchanged", moves.status());
        assertTrue(moves.disabled(), "a test in a switched-off suite is switched off");
        assertEquals(List.of("disabled -: > 10:xdescribe('transfer', () => {"), changes(moves));

        SpecEntry on = entry(spec, "was off");
        assertFalse(on.disabled());
        assertEquals(List.of("enabled 16:xit('was off', () => { > -:"), changes(on));
        assertEquals(1, on.assertionsBefore());
        assertEquals(1, on.assertionsAfter());
    }

    @Test
    void goTestifyActualSecondAndOnlyUnconditionalSkip() throws Exception {
        String path = "player/player_test.go";
        String before = """
                package player

                func TestScore(t *testing.T) {
                	assert.Equal(t, 9, Score(3))
                }

                func TestSlow(t *testing.T) {
                	if testing.Short() {
                		t.Skip("slow")
                	}
                	require.NoError(t, run())
                }
                """;
        String after = """
                package player

                func TestScore(t *testing.T) {
                	t.Skip("later")
                	assert.Equal(t, 6, Score(3))
                }

                func TestSlow(t *testing.T) {
                	if testing.Short() {
                		t.Skip("slow!")
                	}
                	require.NoError(t, run())
                }
                """;
        SpecFile spec = spec(path, before, after);
        assertEquals(List.of(
                "disabled -: > 4:t.Skip(\"later\")",
                "changed 4:assert.Equal(t, 9, Score(3)) > 5:assert.Equal(t, 6, Score(3))"),
                changes(entry(spec, "TestScore")));
        SpecEntry slow = entry(spec, "TestSlow");
        assertFalse(slow.disabled(), "a t.Skip inside an if is conditional");
        assertTrue(slow.expectations().isEmpty());
    }
}
