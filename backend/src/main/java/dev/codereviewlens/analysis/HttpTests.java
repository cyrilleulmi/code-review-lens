package dev.codereviewlens.analysis;

import dev.codereviewlens.analysis.SymbolExtractor.Symbol;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP-Tests: what a test sends over HTTP, and what a test with a mocked HTTP backend expects. Deterministic and
 * pattern-based, no AI (rules "testHttpCalls" and "testHttpLinks"):
 * <ul>
 *   <li><b>Requests</b> ({@link Request}): RestAssured, MockMvc, WebTestClient, TestRestTemplate, supertest, Playwright
 *       {@code request.put(…)}, Cypress {@code cy.request(…)}, fetch, Go httptest - in the test itself and in the
 *       same-file helpers it calls (up to three calls deep). The path is normalised like the REST links of the flows
 *       ({@link Http}); a base path of the test (Quarkus {@code @TestHTTPEndpoint(X.class)} = the class-level path of X,
 *       RestAssured {@code basePath}, WebTestClient {@code baseUrl}) goes in front. The {@link Analyzer} turns a request
 *       that hits a changed endpoint into a reach of that endpoint (unless the test mocks the HTTP backend).</li>
 *   <li><b>Expectations</b> ({@link Expectation}): HttpTestingController {@code expectOne(url)} /
 *       {@code expectOne({ method, url })}, {@code cy.intercept}, {@code page.route}, nock, msw handlers, WireMock and
 *       MockRestServiceServer stubs - only in the test itself (a helper that loads data before the test is preparation).
 *       They reach nothing (the backend is replaced) but show the contract the client side expects; a method the test
 *       checks later ({@code expect(put.request.method).toBe('PUT')}) completes an expectation without one.</li>
 * </ul>
 * Not seen: URLs built from variables only, base paths set in other files (test profiles, config), {@code page.goto} and
 * UI clicks in end-to-end tests (they reach the frontend, not a known request).
 */
public final class HttpTests {

    /**
     * A real HTTP request of a test. call: method, normalised path (base path included), line: the line in the test that
     * leads to it (the request itself, or the call of the helper that sends it). helper: that same-file helper (the one
     * the test calls; null = in the test itself); inputs: the argument lists of the requests in the helpers, "" without.
     */
    public record Request(Http.Call call, String helper, String inputs) {
    }

    /** A request a test expects from the client side; method null = any method. line: in the test file. */
    public record Expectation(String method, String path, int line) {
        /** Does the expected request fit an endpoint (method and path as in {@link Http#matches})? */
        public boolean fits(Http.Endpoint endpoint) {
            String m = method != null ? method : endpoint.method() != null ? endpoint.method() : "GET";
            return Http.matches(new Http.Call(m, path, line), endpoint);
        }

        public String label() {
            return (method == null ? "" : method + " ") + path;
        }
    }

    /** What a test does over HTTP: its real requests and the requests it expects (see the class comment). */
    public record Found(List<Request> requests, List<Expectation> expectations) {
        static final Found NONE = new Found(List.of(), List.of());
    }

    private static final Pattern QUOTED = Pattern.compile("^(['\"`])(.*)\\1$", Pattern.DOTALL);
    /** The start of the statement a match is in: after the last ";", "{" or "}". */
    private static final Pattern ASSIGNED = Pattern.compile(
            "^(?:(?:const|let|var|val|final)\\s+)?([A-Za-z_$][\\w$]*)\\s*(?::\\s*[\\w$<>\\[\\].]+\\s*)?=\\s*[\\w$.()\\s]*$");

    private final List<Pattern> calls;
    private final Rules.HttpTestRules rules;
    private final TestProfiles profiles;

    public HttpTests(Rules rules) {
        this.calls = rules.testHttpCalls;
        this.rules = rules.testHttpLinks;
        this.profiles = new TestProfiles(rules);
    }

    /**
     * The requests and expectations of one test case. surroundings: its surroundings (TestProfiles, for the base path);
     * classPaths: the class-level paths of the endpoint classes the analysis knows, by simple class name
     * (for {@code @TestHTTPEndpoint}).
     */
    public Found find(CodeText text, List<Symbol> symbols, Symbol test, String surroundings, Map<String, String> classPaths) {
        int last = Math.min(test.endLine(), text.visible.size());
        if (test.startLine() < 1 || test.startLine() > last) {
            return Found.NONE;
        }
        String own = String.join("\n", text.visible.subList(test.startLine() - 1, last));
        String base = base(surroundings == null ? own : surroundings, classPaths);
        List<Request> requests = new ArrayList<>();
        for (Http.Call c : requests(own, test.startLine(), base)) {
            requests.add(new Request(c, null, ""));
        }
        // same-file helpers, up to three calls deep; a request in one counts at the line where the test calls the chain
        record Frontier(String code, int firstLine, int rootLine, String root) {
        }
        List<Symbol> helpers = symbols.stream()
                .filter(s -> s != test && s.isCallable() && !s.isTestBlock() && !s.contains(test.startLine())).toList();
        Set<Symbol> seen = new HashSet<>();
        List<Frontier> frontier = List.of(new Frontier(own, test.startLine(), 0, null));
        for (int depth = 0; depth < 3 && !frontier.isEmpty(); depth++) {
            List<Frontier> next = new ArrayList<>();
            for (Symbol h : helpers) {
                if (seen.contains(h)) {
                    continue;
                }
                Pattern call = Pattern.compile("(?<![\\w$])" + Pattern.quote(h.name()) + "\\s*(?:<[^<>()]*>)?\\s*\\(");
                for (Frontier f : frontier) {
                    Matcher m = call.matcher(f.code());
                    if (!m.find()) {
                        continue;
                    }
                    seen.add(h);
                    int line = f.root() == null ? f.firstLine() + newlines(f.code(), m.start()) : f.rootLine();
                    String root = f.root() == null ? h.name() : f.root();
                    int end = Math.min(h.endLine(), text.visible.size());
                    String visible = String.join("\n", text.visible.subList(h.startLine() - 1, end));
                    List<Http.Call> found = requests(visible, h.startLine(), base);
                    if (!found.isEmpty()) {
                        String inputs = profiles.requestInputs(visible, String.join("\n", text.code.subList(h.startLine() - 1, end)));
                        found.forEach(c -> requests.add(new Request(new Http.Call(c.method(), c.path(), line), root, inputs)));
                    }
                    next.add(new Frontier(visible, h.startLine(), line, root));
                    break;
                }
            }
            frontier = next;
        }
        return new Found(List.copyOf(requests), expectations(own, test.startLine()));
    }

    /**
     * The HTTP requests in a piece of test code (rules "testHttpCalls"): method (GET when the pattern has none) and the
     * path of the literal URL, below base (may be null); line: firstLine plus the line of the match in code. A URL that
     * is no path (no leading "/", no host) is left out; an empty one (a request without path) only goes to the base.
     */
    List<Http.Call> requests(String code, int firstLine, String base) {
        List<Http.Call> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Pattern p : calls) {
            Matcher m = p.matcher(code);
            boolean hasMethod = p.pattern().contains("(?<method>");
            while (m.find()) {
                String url = m.group("url");
                if (url == null) {
                    continue;
                }
                String u = url.strip();
                boolean concatenated = u.endsWith("+");
                if (concatenated) {
                    u = u.substring(0, u.length() - 1).strip();
                }
                Matcher q = QUOTED.matcher(u);
                if (q.matches()) {
                    u = q.group(2);
                }
                String path;
                if (u.isEmpty() && !concatenated) {
                    path = base == null || base.isBlank() ? null : Http.normalisePath("/" + base);
                } else {
                    path = Http.normaliseUrl(u, concatenated);
                    path = path == null ? null : Http.withBase(base, path);
                }
                if (path == null) {
                    continue;
                }
                String method = hasMethod && m.group("method") != null ? m.group("method").toUpperCase(Locale.ROOT) : "GET";
                int line = firstLine + newlines(code, m.start());
                if (seen.add(method + " " + path + " " + line)) {
                    result.add(new Http.Call(method, path, line));
                }
            }
        }
        result.sort(java.util.Comparator.comparingInt(Http.Call::line));
        return result;
    }

    /** The base path of a test (rules "testHttpLinks.bases", first match), or null. */
    String base(String code, Map<String, String> classPaths) {
        for (Pattern p : rules.bases()) {
            Matcher m = p.matcher(code);
            if (!m.find()) {
                continue;
            }
            if (p.pattern().contains("(?<base>") && m.group("base") != null) {
                return m.group("base");
            }
            if (p.pattern().contains("(?<endpointClass>") && m.group("endpointClass") != null) {
                String path = classPaths.get(m.group("endpointClass"));
                if (path != null) {
                    return path;
                }
            }
        }
        return null;
    }

    /**
     * The requests a test expects (rules "testHttpLinks.expectations") in its own code, by line; one with a method wins
     * over one without at the same place. A method missing in the pattern is taken from a later check of the variable
     * that holds the request ("expectationMethods").
     */
    List<Expectation> expectations(String code, int firstLine) {
        Map<String, Expectation> byPlace = new LinkedHashMap<>();
        for (Pattern p : rules.expectations()) {
            Matcher m = p.matcher(code);
            boolean hasMethod = p.pattern().contains("(?<method>");
            while (m.find()) {
                String path = expectedPath(m.group("url"));
                if (path == null) {
                    continue;
                }
                String method = hasMethod && m.group("method") != null ? m.group("method").toUpperCase(Locale.ROOT)
                        : checkedMethod(code, m.start());
                int line = firstLine + newlines(code, m.start());
                String key = line + " " + path;
                Expectation known = byPlace.get(key);
                if (known == null || (known.method() == null && method != null)) {
                    byPlace.put(key, new Expectation(method, path, line));
                }
            }
        }
        List<Expectation> result = new ArrayList<>(byPlace.values());
        result.sort(java.util.Comparator.comparingInt(Expectation::line));
        return List.copyOf(result);
    }

    /** The path of an expected URL as in {@link Http#normaliseUrl}; globs (`*`, `**`) stand for any segment; null = no path. */
    private static String expectedPath(String url) {
        if (url == null) {
            return null;
        }
        Matcher q = QUOTED.matcher(url.strip());
        String u = q.matches() ? q.group(2) : url.strip();
        u = u.replaceAll("\\*+", "{}");
        return Http.normaliseUrl(u, false);
    }

    /** The method a test checks on the request assigned at the statement around position at, or null. */
    private String checkedMethod(String code, int at) {
        int start = Math.max(Math.max(code.lastIndexOf(';', at - 1), code.lastIndexOf('{', at - 1)), code.lastIndexOf('}', at - 1)) + 1;
        Matcher v = ASSIGNED.matcher(code.substring(start, at).strip());
        if (!v.matches()) {
            return null;
        }
        String var = Pattern.quote(v.group(1));
        for (String template : rules.expectationMethods()) {
            Matcher m = Pattern.compile(template.replace("{var}", var)).matcher(code);
            if (m.find(at)) {
                return m.group("method").toUpperCase(Locale.ROOT);
            }
        }
        return null;
    }

    private static int newlines(String s, int end) {
        int n = 0;
        for (int i = 0; i < end && i < s.length(); i++) {
            if (s.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }
}
