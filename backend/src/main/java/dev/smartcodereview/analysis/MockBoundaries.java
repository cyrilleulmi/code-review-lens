package dev.smartcodereview.analysis;

import dev.smartcodereview.model.Model.EdgeCoverage;
import dev.smartcodereview.model.Model.ExistingTest;
import dev.smartcodereview.model.Model.Flow;
import dev.smartcodereview.model.Model.FlowCoverage;
import dev.smartcodereview.model.Model.FlowEdge;
import dev.smartcodereview.model.Model.FlowStep;
import dev.smartcodereview.model.Model.StepCoverage;
import dev.smartcodereview.model.Model.TestCoverage;
import dev.smartcodereview.model.Model.TestInfo;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Mock-Grenzen: which parts of a flow the tests really execute. A test that replaces a collaborator (TestProfile.mocks)
 * reaches only the mock: changed code of that collaborator counts as <em>mocked</em> in that test and the walk through
 * the call graph stops there ({@link Analyzer}). Deterministic, name-based:
 * <ul>
 *   <li>A changed segment belongs to a mocked collaborator when one of its <em>owner names</em> - the class/object it
 *       is declared in (symbol container), its own name for a class/component, the file name without extension - equals
 *       the mock's name, compared without case and punctuation (PlayerApiService = player-api.service). "HTTP" (a mocked
 *       HTTP backend) never matches a segment: http edges are not followed by tests anyway.</li>
 *   <li>Per flow ({@link #flowCoverage}): a step is "tested" when a test reaches it really, "mocked" when tests only
 *       reach a mock of it, else "none"; an edge is "tested" when one test reaches both ends really through a call edge
 *       (it crosses it), "separate" when both ends are tested but no single test crosses it, "partial" when only one end
 *       is tested, else "none".</li>
 * </ul>
 */
final class MockBoundaries {

    static final String TESTED = "tested";
    static final String MOCKED = "mocked";
    static final String NONE = "none";
    static final String SEPARATE = "separate";
    static final String PARTIAL = "partial";

    private MockBoundaries() {
    }

    /** The comparable keys of the mocked collaborators of a test (without "HTTP"). */
    static Set<String> keys(Collection<String> mocks) {
        Set<String> keys = new HashSet<>();
        for (String m : mocks) {
            if (!TestProfiles.HTTP.equals(m)) {
                String k = TestProfiles.comparable(m);
                if (!k.isEmpty()) {
                    keys.add(k);
                }
            }
        }
        return keys;
    }

    /**
     * The owner names of a changed segment: container (also its last part when nested), its own name when it is a
     * class-like symbol, the file name without extension. kind / name / container may be null (hunk, module code).
     */
    static Set<String> ownerKeys(String path, String kind, String name, String container) {
        Set<String> keys = new HashSet<>();
        if (container != null) {
            keys.add(TestProfiles.comparable(container));
            keys.add(TestProfiles.comparable(container.substring(container.lastIndexOf('.') + 1)));
        }
        if (name != null && kind != null && Set.of("class", "component", "interface", "object").contains(kind)) {
            keys.add(TestProfiles.comparable(name));
        }
        String file = path.substring(path.lastIndexOf('/') + 1);
        keys.add(TestProfiles.comparable(file.contains(".") ? file.substring(0, file.lastIndexOf('.')) : file));
        keys.remove("");
        return keys;
    }

    /** The mocked collaborator (as named in mocks) one of the owner keys belongs to, or null. */
    static String mockedBy(Collection<String> mocks, Set<String> ownerKeys) {
        for (String m : mocks) {
            if (!TestProfiles.HTTP.equals(m) && ownerKeys.contains(TestProfiles.comparable(m))) {
                return m;
            }
        }
        return null;
    }

    /**
     * Mock-Grenzen of every flow: per step whether a test reaches it really or only a mock of it, per edge whether a
     * single test crosses it (see the class comment). Changed tests are identified by their segment id, existing tests
     * by their id ("e1").
     */
    static List<FlowCoverage> flowCoverage(List<Flow> flows, List<TestInfo> tests, List<ExistingTest> existingTests) {
        Map<String, List<TestCoverage>> coversByTest = new LinkedHashMap<>();
        tests.forEach(t -> coversByTest.put(t.segmentId(), t.covers()));
        existingTests.forEach(t -> coversByTest.put(t.id(), t.covers()));
        Map<String, Set<String>> real = new HashMap<>(); // segment -> tests reaching it really
        Map<String, Set<String>> mocked = new HashMap<>(); // segment -> tests reaching only a mock of it
        coversByTest.forEach((test, covers) -> {
            for (TestCoverage c : covers) {
                (c.mocked() ? mocked : real).computeIfAbsent(c.segmentId(), k -> new LinkedHashSet<>()).add(test);
            }
        });
        List<FlowCoverage> result = new ArrayList<>();
        for (Flow f : flows) {
            List<StepCoverage> steps = new ArrayList<>();
            for (FlowStep s : f.steps()) {
                List<String> r = List.copyOf(real.getOrDefault(s.segmentId(), Set.of()));
                List<String> m = mocked.getOrDefault(s.segmentId(), Set.of()).stream().filter(t -> !r.contains(t)).toList();
                steps.add(new StepCoverage(s.segmentId(), !r.isEmpty() ? TESTED : !m.isEmpty() ? MOCKED : NONE, r, m));
            }
            List<EdgeCoverage> edges = new ArrayList<>();
            for (FlowEdge e : f.edges()) {
                Set<String> fromTests = real.getOrDefault(e.from(), Set.of());
                Set<String> toTests = real.getOrDefault(e.to(), Set.of());
                // a test crosses a call when it executes both ends; tests never follow http edges (they mock HTTP)
                List<String> crossing = "http".equals(e.kind()) ? List.of()
                        : fromTests.stream().filter(toTests::contains).toList();
                String status = !crossing.isEmpty() ? TESTED
                        : !fromTests.isEmpty() && !toTests.isEmpty() ? SEPARATE
                        : !fromTests.isEmpty() || !toTests.isEmpty() ? PARTIAL : NONE;
                edges.add(new EdgeCoverage(e.from(), e.to(), status, crossing));
            }
            result.add(new FlowCoverage(f.id(), steps, edges));
        }
        return result;
    }
}
