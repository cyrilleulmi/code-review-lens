package dev.codereviewlens.analysis;

import dev.codereviewlens.analysis.Expectations.Assertion;
import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.analysis.TestProfiles.TestText;
import dev.codereviewlens.model.Model.TestProfile;
import dev.codereviewlens.model.Model.TestSmell;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Test-Smells: changed test cases whose value is doubtful, so the reviewer looks there first. Deterministic and
 * pattern-based (rules section "testSmells", see {@link Rules.SmellRule}), no AI. Per changed test case:
 * <ul>
 *   <li><b>no-assertion</b>: no assertion statement at all (rules "assertions"; verify, expectOne, toHaveBeenCalled
 *       count as assertions) - unless the head says an exception is expected (@Test(expected = ...)).</li>
 *   <li><b>weak-only</b>: every assertion only checks existence or truthiness (rules "weakAssertions", assertion kind
 *       "existence" - a verify that only checks the call is an interaction check, not weak).</li>
 *   <li><b>focused</b>: fit, fdescribe, it.only, ... in the head of the test or of an enclosing suite.</li>
 *   <li><b>sleep</b>: a fixed wait in the body (Thread.sleep, TimeUnit.x.sleep, time.Sleep); setTimeout/sleep( only when the
 *       test file does not use fake timers (jest/vi.useFakeTimers, fakeAsync, jasmine.clock().install).</li>
 *   <li><b>mocks-subject</b>: the test replaces the unit it tests. (a) A mocked collaborator (the profile's mocks, also
 *       the unit named like the test file) is the unit under test or the class of changed code the test really calls
 *       ({@link MockBoundaries#ownerKeys} keys); (b) the test itself calls changed code of a mocked collaborator outside
 *       of stubbing and verification (it runs the mock); (c) a spy on the test's own fixture (spyOn(component, ...)) or
 *       one that replaces the very method the test calls (spyOn(view, 'save') while it calls save) - unless it only
 *       watches (callThrough).</li>
 *   <li><b>disabled</b>: a <em>new</em> test that is switched off (xit, @Disabled, skip) - never runs. Tests of the base
 *       version are covered by the expectation change "disabled" ({@link Expectations}).</li>
 * </ul>
 * Limits: a mock created in a helper of another file, a test that delegates its assertions to a helper the assertion
 * rules do not know, an unknown wait helper are not seen.
 */
public final class TestSmells {

    public static final String NO_ASSERTION = "no-assertion";
    public static final String WEAK_ONLY = "weak-only";
    public static final String FOCUSED = "focused";
    public static final String SLEEP = "sleep";
    public static final String MOCKS_SUBJECT = "mocks-subject";
    public static final String DISABLED = "disabled";

    /**
     * Changed code of a mocked collaborator that a test calls directly: member = the method or function name,
     * ownerKeys = the names the collaborator can be mocked by ({@link MockBoundaries#ownerKeys}).
     */
    public record MockedMember(String member, Set<String> ownerKeys) {
    }

    /**
     * What detection needs about one test case. unit: the unit under test from the test file name (may be null);
     * realKeys: owner keys of the changed code the test really reaches directly (not through a mock); mockedMembers: the
     * changed code of mocked collaborators it calls directly; isNew: the test case is new in this change.
     */
    public record Input(CodeText text, List<Symbol> symbols, Symbol test, TestProfile profile, String unit,
                        Set<String> realKeys, List<MockedMember> mockedMembers, boolean isNew) {
    }

    private record Hit(Integer line) {
    }

    private final Rules rules;
    private final TestProfiles profiles;
    private final Expectations expectations;

    public TestSmells(Rules rules) {
        this.rules = rules;
        this.profiles = new TestProfiles(rules);
        this.expectations = new Expectations(rules);
    }

    /** The smells of one test case, in the order of the rules; empty when there are none. */
    public List<TestSmell> detect(Input in) {
        List<TestSmell> result = new ArrayList<>();
        TestText t = profiles.read(in.text(), in.symbols(), in.test(), in.profile().targets());
        for (var entry : rules.testSmells.entrySet()) {
            Rules.SmellRule rule = entry.getValue();
            if (!rule.enabled()) {
                continue;
            }
            Hit hit = switch (entry.getKey()) {
                case NO_ASSERTION -> noAssertion(in, t, rule);
                case WEAK_ONLY -> weakOnly(t);
                case FOCUSED -> focused(in, rule);
                case SLEEP -> sleep(in, t, rule);
                case MOCKS_SUBJECT -> mocksSubject(in, t, rule);
                case DISABLED -> disabled(in);
                default -> null;
            };
            if (hit != null) {
                Integer line = hit.line() != null && hit.line() >= in.test().startLine() && hit.line() <= in.test().endLine()
                        ? hit.line() : null;
                String code = line == null ? null : Expectations.lineText(in.text(), line);
                result.add(new TestSmell(entry.getKey(), rule.label(), line, code, rule.hint()));
            }
        }
        return result;
    }

    // ------------------------------------------------------------------ the smells

    private Hit noAssertion(Input in, TestText t, Rules.SmellRule rule) {
        if (!t.assertions().isEmpty()) {
            return null;
        }
        int decl = Expectations.declarationLine(in.text(), in.test());
        for (int li = in.test().startLine(); li <= decl; li++) {
            if (find(rule.list("unless"), in.text().code.get(li - 1)) != null) {
                return null; // an exception is expected by the annotation
            }
        }
        return new Hit(decl);
    }

    private Hit weakOnly(TestText t) {
        if (t.assertions().isEmpty()) {
            return null;
        }
        for (Assertion a : t.assertions()) {
            if (!a.weak() || !TestProfiles.EXISTENCE.equals(profiles.kindOf(a))) {
                return null;
            }
        }
        return new Hit(t.assertions().getFirst().line());
    }

    private Hit focused(Input in, Rules.SmellRule rule) {
        List<Symbol> scopes = new ArrayList<>();
        scopes.add(in.test());
        for (Symbol s : in.symbols()) {
            if ((s.kind().equals("suite") || s.kind().equals("class")) && s != in.test()
                    && s.startLine() <= in.test().startLine() && s.endLine() >= in.test().endLine()) {
                scopes.add(s);
            }
        }
        for (Symbol s : scopes) {
            int decl = Expectations.declarationLine(in.text(), s);
            for (int li = s.startLine(); li <= decl; li++) {
                if (find(rule.list("patterns"), in.text().code.get(li - 1)) != null) {
                    return new Hit(li);
                }
            }
        }
        return null;
    }

    private Hit sleep(Input in, TestText t, Rules.SmellRule rule) {
        Integer line = firstLine(rule.list("patterns"), t.bodyCode(), t.bodyLine());
        if (line != null) {
            return new Hit(line);
        }
        String file = String.join("\n", in.text().code);
        if (find(rule.list("fakeTimers"), file) != null) {
            return null; // fake timers: the wait is virtual
        }
        line = firstLine(rule.list("timerPatterns"), t.bodyCode(), t.bodyLine());
        return line == null ? null : new Hit(line);
    }

    private Hit mocksSubject(Input in, TestText t, Rules.SmellRule rule) {
        List<Integer> lines = new ArrayList<>();
        boolean found = false;
        List<String> mocks = profiles.mocks(in.text(), in.symbols(), in.test(), null);
        Set<String> mockKeys = MockBoundaries.keys(mocks);
        // (a) a mocked collaborator is the unit under test or the class of the changed code the test really calls
        Set<String> subject = new HashSet<>(in.realKeys());
        if (in.unit() != null && !TestProfiles.comparable(in.unit()).isEmpty()) {
            subject.add(TestProfiles.comparable(in.unit()));
        }
        for (String m : mocks) {
            if (!TestProfiles.HTTP.equals(m) && subject.contains(TestProfiles.comparable(m))) {
                found = true;
                Matcher w = Pattern.compile("(?<![\\w$])" + Pattern.quote(m) + "(?![\\w$])").matcher(String.join("\n", in.text().visible));
                if (w.find()) {
                    lines.add(lineOf(String.join("\n", in.text().visible), w.start()));
                }
            }
        }
        // (b) the test calls the changed code of a mocked collaborator itself, outside of stubbing and verification
        String[] body = t.body().split("\n", -1);
        String[] bodyCode = t.bodyCode().split("\n", -1);
        for (MockedMember mm : in.mockedMembers()) {
            if (mm.ownerKeys().stream().noneMatch(mockKeys::contains)) {
                continue;
            }
            Pattern call = Pattern.compile("\\.\\s*" + Pattern.quote(mm.member()) + "\\s*\\(");
            for (int i = 0; i < bodyCode.length; i++) {
                if (call.matcher(bodyCode[i]).find() && find(rule.list("stubbing"), bodyCode[i]) == null) {
                    found = true;
                    lines.add(t.bodyLine() + i);
                    break;
                }
            }
        }
        // (c) spies on the test's own fixture, or that replace the very method the test calls
        List<Pattern> spies = new ArrayList<>(rule.list("patterns"));
        for (String target : in.profile().targets()) {
            if (target.matches("[A-Za-z_$][\\w$]*")) {
                for (String template : rule.targetPatterns()) {
                    spies.add(Pattern.compile(template.replace("{target}", Pattern.quote(target))));
                }
            }
        }
        for (int i = 0; i < body.length; i++) {
            if (find(spies, body[i]) != null && find(rule.list("observing"), body[i]) == null) {
                found = true;
                lines.add(t.bodyLine() + i);
                break;
            }
        }
        return found ? new Hit(lines.stream().filter(l -> l != null).min(Integer::compare).orElse(null)) : null;
    }

    private Hit disabled(Input in) {
        if (!in.isNew()) {
            return null;
        }
        int line = expectations.disabledLine(in.text(), in.test(), true);
        if (line == 0) {
            for (Symbol s : in.symbols()) {
                if ((s.kind().equals("suite") || s.kind().equals("class")) && s != in.test()
                        && s.startLine() <= in.test().startLine() && s.endLine() >= in.test().endLine()) {
                    line = expectations.disabledLine(in.text(), s, false);
                    if (line > 0) {
                        break;
                    }
                }
            }
        }
        return line == 0 ? null : new Hit(line);
    }

    // ------------------------------------------------------------------ helpers

    private static Matcher find(List<Pattern> patterns, String code) {
        for (Pattern p : patterns) {
            Matcher m = p.matcher(code);
            if (m.find()) {
                return m;
            }
        }
        return null;
    }

    /** The line of the earliest match of any pattern in the text (its first line is `firstLine`), or null. */
    private static Integer firstLine(List<Pattern> patterns, String text, int firstLine) {
        int best = -1;
        for (Pattern p : patterns) {
            Matcher m = p.matcher(text);
            if (m.find() && (best < 0 || m.start() < best)) {
                best = m.start();
            }
        }
        return best < 0 ? null : firstLine + lineOf(text, best) - 1;
    }

    /** 1-based line number of a character offset. */
    private static int lineOf(String text, int offset) {
        int line = 1;
        for (int i = 0; i < offset && i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }
}
