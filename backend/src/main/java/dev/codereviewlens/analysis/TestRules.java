package dev.codereviewlens.analysis;

import dev.codereviewlens.model.Model.RuleCheck;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Erwartungs-Regeln: "if X changes, expect a test of form Y" - rules teams know ("a changed authorisation check needs a
 * test for the denied case", "a new endpoint needs a test over HTTP"), made explicit in the rules section "testRules"
 * (see {@link Rules.TestRule}) and checked per pull request. Deterministic and pattern-based, no AI:
 * <ol>
 *   <li><b>Trigger</b> ({@link Rules.TestRuleWhen}): every changed function, method or class outside the tests is
 *       checked against every rule; all given conditions must hold (a changed line matches, the code matches, a concern
 *       applies, it is a changed or new HTTP endpoint, its kind, its path). A rule applies at most once per segment.</li>
 *   <li><b>Tests that count</b>: the changed and existing tests that reach the segment for real - directly or via
 *       other changed code, also over HTTP (a request of the test to a changed endpoint, {@link HttpTests}), not only a
 *       mock of it (Mock-Grenzen). For a class, also the tests that reach its changed members.</li>
 *   <li><b>Expectation</b> ({@link Rules.TestRuleExpect}): one of those tests must show everything the rule expects
 *       (an assertion, code, scenario, level, a request to the triggering endpoint: it reaches it directly over HTTP).</li>
 * </ol>
 * Limits: only static evidence. A test reaching the code through something the call graph does not see (reflection,
 * a framework calling a listener, a request with a computed URL or a base path set in another file) does not count; a
 * type (DTO, entity) is reached only through its changed members.
 */
public final class TestRules {

    /** Longest trigger text kept. */
    private static final int MAX_TRIGGER = 80;

    /** An HTTP endpoint of a changed segment; line: its declaration (new file); added: that line is added in the PR. */
    public record EndpointAt(Http.Endpoint endpoint, int line, boolean added) {
    }

    /** A changed line of a segment: its line in the new file (deleted lines: where they were), its text. */
    public record ChangedLine(int line, String text) {
    }

    /**
     * A changed segment the rules look at. kind: symbol kind; startLine / lines: the code of the whole symbol (new
     * file); changed: its changed lines in file order; concerns: its concern categories; endpoints: the HTTP endpoints
     * it declares; reaching: ids of the tests that reach it for real (changed and existing), in order.
     */
    public record Target(String segmentId, String path, String kind, int startLine, List<String> lines,
                         List<ChangedLine> changed, List<String> concerns, List<EndpointAt> endpoints, List<String> reaching) {
    }

    /**
     * What a test shows. code: its head and body plus the same-file helpers it calls (comments blanked, strings kept);
     * assertions: its assertion statements; scenario / level: from its Test-Steckbrief; http: the endpoints it reaches
     * directly over HTTP ("PUT /api/x/{}") by segment id (TestCoverage.endpoint).
     */
    public record TestFacts(String id, String code, List<String> assertions, String scenario, String level,
                            Map<String, Set<String>> http) {
    }

    private record Trigger(int line, String code, String what) {
    }

    private final List<Rules.TestRule> rules;

    public TestRules(Rules rules) {
        this.rules = rules.testRules;
    }

    /**
     * The checks of all rules for the changed segments (in the given order, then by line and rule order). tests: the
     * facts of every changed and existing test, by id.
     */
    public List<RuleCheck> check(List<Target> targets, Map<String, TestFacts> tests) {
        record Ordered(int target, RuleCheck check) {
        }
        List<Ordered> result = new ArrayList<>();
        for (int ti = 0; ti < targets.size(); ti++) {
            Target target = targets.get(ti);
            for (Rules.TestRule rule : rules) {
                Trigger trigger = trigger(rule.when(), target);
                if (trigger == null) {
                    continue;
                }
                List<EndpointAt> endpoints = rule.when().newEndpoint()
                        ? target.endpoints().stream().filter(EndpointAt::added).toList() : target.endpoints();
                Set<String> candidates = new LinkedHashSet<>(target.reaching());
                List<String> metBy = candidates.stream().map(tests::get)
                        .filter(t -> t != null && shows(rule.expect(), t, target.segmentId(), endpoints))
                        .map(TestFacts::id).toList();
                result.add(new Ordered(ti, new RuleCheck(rule.id(), rule.label(), target.segmentId(), trigger.line(), trigger.code(),
                        shorten(trigger.what()), !metBy.isEmpty(), metBy, List.copyOf(candidates), rule.hint())));
            }
        }
        result.sort(Comparator.comparingInt(Ordered::target).thenComparingInt(o -> o.check().line() == null ? 0 : o.check().line()));
        return result.stream().map(Ordered::check).toList();
    }

    /** Does a test show everything the rule expects? */
    private static boolean shows(Rules.TestRuleExpect expect, TestFacts t, String segmentId, List<EndpointAt> endpoints) {
        if (expect.http() && endpoints.stream()
                .noneMatch(e -> t.http().getOrDefault(segmentId, Set.of()).contains(e.endpoint().label()))) {
            return false;
        }
        if (!expect.assertion().isEmpty()
                && t.assertions().stream().noneMatch(a -> expect.assertion().stream().anyMatch(p -> p.matcher(a).find()))) {
            return false;
        }
        if (!expect.code().isEmpty() && expect.code().stream().noneMatch(p -> p.matcher(t.code()).find())) {
            return false;
        }
        if (!expect.scenario().isEmpty() && !expect.scenario().contains(t.scenario())) {
            return false;
        }
        return expect.level().isEmpty() || expect.level().contains(t.level());
    }

    /**
     * Where and why a rule applies to a segment, or null. Line: the first changed line that matches, else the (new)
     * endpoint's declaration, else the first line with a matching text, else the start of the symbol.
     */
    private static Trigger trigger(Rules.TestRuleWhen when, Target t) {
        if (when.empty()) {
            return null;
        }
        if (!when.paths().isEmpty() && when.paths().stream().noneMatch(p -> p.matcher(t.path()).matches())) {
            return null;
        }
        if (!when.kinds().isEmpty() && !when.kinds().contains(t.kind())) {
            return null;
        }
        if (!when.concerns().isEmpty() && when.concerns().stream().noneMatch(t.concerns()::contains)) {
            return null;
        }
        EndpointAt endpoint = null;
        if (when.newEndpoint()) {
            endpoint = t.endpoints().stream().filter(EndpointAt::added).findFirst().orElse(null);
            if (endpoint == null) {
                return null;
            }
        } else if (when.endpoint()) {
            endpoint = t.endpoints().stream().findFirst().orElse(null);
            if (endpoint == null) {
                return null;
            }
        }
        Trigger changed = null;
        if (!when.changed().isEmpty()) {
            for (ChangedLine l : t.changed()) {
                if (Rules.isTrivial(l.text())) {
                    continue; // blank, braces, comments
                }
                Matcher m = first(when.changed(), l.text());
                if (m != null) {
                    changed = new Trigger(l.line(), l.text().strip(), m.group());
                    break;
                }
            }
            if (changed == null) {
                return null;
            }
        }
        Trigger text = null;
        if (!when.text().isEmpty()) {
            String joined = String.join("\n", t.lines());
            Matcher m = first(when.text(), joined);
            if (m == null) {
                return null;
            }
            int line = t.startLine() + (int) joined.substring(0, m.start()).chars().filter(c -> c == '\n').count();
            text = new Trigger(line, lineText(t, line), m.group());
        }
        if (changed != null) {
            return changed;
        }
        if (endpoint != null) {
            return new Trigger(endpoint.line(), lineText(t, endpoint.line()), endpoint.endpoint().label());
        }
        if (text != null) {
            return text;
        }
        return new Trigger(t.startLine(), lineText(t, t.startLine()), null);
    }

    /** The first match of any of the patterns (in pattern order), or null. */
    private static Matcher first(List<Pattern> patterns, String text) {
        for (Pattern p : patterns) {
            Matcher m = p.matcher(text);
            if (m.find()) {
                return m;
            }
        }
        return null;
    }

    private static String lineText(Target t, int line) {
        int i = line - t.startLine();
        return i >= 0 && i < t.lines().size() ? t.lines().get(i).strip() : null;
    }

    /** A trigger text, single line and at most MAX_TRIGGER characters. */
    static String shorten(String what) {
        if (what == null) {
            return null;
        }
        String s = what.replaceAll("\\s+", " ").strip();
        return s.length() <= MAX_TRIGGER ? s : s.substring(0, MAX_TRIGGER - 1) + "…";
    }
}
