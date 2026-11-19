package dev.smartcodereview.gitlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.smartcodereview.github.GitHubProvider;
import dev.smartcodereview.model.Model.Comment;
import dev.smartcodereview.model.Model.PrRef;
import dev.smartcodereview.model.Model.Snapshot;
import dev.smartcodereview.provider.ProviderException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** The GitLab provider against a local HTTP server that answers like GitLab. */
class GitLabProviderHttpTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final PrRef MR = new PrRef("gitlab", "acme", "shop", 7);

    private HttpServer server;
    private final List<HttpExchange> requests = new CopyOnWriteArrayList<>();
    /** number of changed files of the merge request */
    private int diffs = 1;
    /** scr.gitlab.cookie */
    private String cookie;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requests.add(exchange);
            respond(exchange, 200, "application/json", body(exchange));
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void loadsMergeRequestDiffsInPagesOfThirty() {
        diffs = 65;

        Snapshot snapshot = provider().fetchSnapshot(MR);

        assertEquals(65, snapshot.files().size());
        assertEquals("f65.txt", snapshot.files().get(64).path());
        assertEquals(List.of("per_page=30&page=1", "per_page=30&page=2", "per_page=30&page=3"), diffQueries());
    }

    @Test
    void stopsAfterTheFirstPageThatIsNotFull() {
        diffs = 30;

        assertEquals(30, provider().fetchSnapshot(MR).files().size());
        assertEquals(List.of("per_page=30&page=1", "per_page=30&page=2"), diffQueries());
    }

    @Test
    void sendsTheConfiguredCookieWithTheToken() {
        cookie = "Cookie: sso-session=abc; sso-csrf=def";

        provider().fetchSnapshot(MR);

        assertEquals(2, requests.size()); // the merge request and one page of diffs
        for (HttpExchange r : requests) {
            assertEquals("sso-session=abc; sso-csrf=def", r.getRequestHeaders().getFirst("Cookie"));
            assertEquals("glpat-test", r.getRequestHeaders().getFirst("PRIVATE-TOKEN"));
        }
    }

    @Test
    void sendsNoCookieHeaderWithoutACookie() {
        provider().fetchSnapshot(MR);

        assertNull(requests.get(0).getRequestHeaders().getFirst("Cookie"));
    }

    @Test
    void replacesTheCookieWhileRunning() {
        cookie = "sso-session=expired";
        GitLabProvider gitlab = provider();
        assertEquals(Optional.of(true), gitlab.cookieSet());

        gitlab.setCookie("sso-session=fresh");
        gitlab.fetchSnapshot(MR);
        assertEquals("sso-session=fresh", requests.get(0).getRequestHeaders().getFirst("Cookie"));

        gitlab.setCookie(" ");
        gitlab.fetchSnapshot(MR);
        assertNull(requests.get(2).getRequestHeaders().getFirst("Cookie"));
        assertEquals(Optional.of(false), gitlab.cookieSet());
    }

    @Test
    void offersTheCookieOnlyWhereAProxyCanBe() {
        GitLabProvider gitlabCom = new GitLabProvider();
        gitlabCom.mapper = MAPPER;
        gitlabCom.baseUrl = "https://gitlab.com/";
        gitlabCom.configuredToken = Optional.of("glpat-test");
        gitlabCom.init();

        assertEquals(Optional.empty(), gitlabCom.cookieSet());
        assertEquals(Optional.of(false), provider().cookieSet()); // self-managed
        assertEquals(Optional.empty(), new GitHubProvider().cookieSet());
    }

    @Test
    void readsACookieAsItIsCopiedFromTheBrowser() {
        assertEquals("a=1; b=2", GitLabProvider.cookieValue("  a=1; b=2 \n"));
        assertEquals("a=1; b=2", GitLabProvider.cookieValue("cookie:a=1; b=2"));
        assertEquals("a=1; b=2", GitLabProvider.cookieValue("Cookie: a=1; b=2"));
        assertNull(GitLabProvider.cookieValue(" "));
        assertNull(GitLabProvider.cookieValue(null));
        ProviderException e = assertThrows(ProviderException.class, () -> GitLabProvider.cookieValue("a=1\r\nX-Injected: 1"));
        assertEquals(400, e.status());
    }

    @Test
    void readsWhetherAThreadIsResolved() {
        List<Comment> comments = provider().comments(MR);

        assertEquals(List.of("open", "open", "done", "plain"), comments.stream().map(Comment::body).toList());
        Comment root = comments.get(0);
        assertEquals("t-open", root.thread());
        assertEquals(Boolean.FALSE, root.resolved());
        assertEquals("N12", root.key());
        // a reply carries the thread and its state too
        assertEquals("t-open", comments.get(1).thread());
        assertEquals(Boolean.FALSE, comments.get(1).resolved());
        assertEquals(root.id(), comments.get(1).inReplyTo());
        assertEquals(Boolean.TRUE, comments.get(2).resolved());
        // a plain comment cannot be resolved
        assertEquals("t-plain", comments.get(3).thread());
        assertNull(comments.get(3).resolved());
    }

    @Test
    void resolvesAndReopensAThread() {
        GitLabProvider gitlab = provider();

        gitlab.resolveThread(MR, "t-open", true);
        gitlab.resolveThread(MR, "t-done", false);

        assertEquals(List.of("PUT /api/v4/projects/acme%2Fshop/merge_requests/7/discussions/t-open?resolved=true",
                "PUT /api/v4/projects/acme%2Fshop/merge_requests/7/discussions/t-done?resolved=false"),
                requests.stream().map(r -> r.getRequestMethod() + " " + r.getRequestURI()).toList());
        assertEquals("glpat-test", requests.get(0).getRequestHeaders().getFirst("PRIVATE-TOKEN"));
    }

    @Test
    void onlyGitLabResolvesThreads() {
        ProviderException e = assertThrows(ProviderException.class, () -> new GitHubProvider().resolveThread(MR, "t", true));

        assertEquals(400, e.status());
        assertEquals("GitHub kann hier keine Threads auflösen", e.getMessage());
    }

    // ---------------------------------------------------------------- helpers

    private GitLabProvider provider() {
        GitLabProvider gitlab = new GitLabProvider();
        gitlab.mapper = MAPPER;
        gitlab.baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        gitlab.configuredToken = Optional.of("glpat-test");
        gitlab.configuredCookie = Optional.ofNullable(cookie);
        gitlab.init();
        return gitlab;
    }

    private List<String> diffQueries() {
        return requests.stream().filter(r -> r.getRequestURI().getRawPath().endsWith("/diffs"))
                .map(r -> r.getRequestURI().getRawQuery()).toList();
    }

    private String body(HttpExchange exchange) {
        String path = exchange.getRequestURI().getRawPath();
        if (path.endsWith("/diffs")) {
            return diffPage(exchange.getRequestURI().getRawQuery()).toString();
        }
        if (path.endsWith("/discussions")) {
            return discussions().toString();
        }
        return MAPPER.createObjectNode().put("iid", 7).put("title", "Shop").put("state", "opened").toString();
    }

    /** One page of the diff list, sized by the per_page and page parameters like GitLab does. */
    private ArrayNode diffPage(String query) {
        int perPage = Integer.parseInt(query.replaceAll(".*per_page=(\\d+).*", "$1"));
        int page = Integer.parseInt(query.replaceAll(".*[?&]?page=(\\d+)$", "$1"));
        ArrayNode result = MAPPER.createArrayNode();
        for (int i = (page - 1) * perPage + 1; i <= Math.min(diffs, page * perPage); i++) {
            result.addObject().put("old_path", "f" + i + ".txt").put("new_path", "f" + i + ".txt")
                    .put("diff", "@@ -1 +1 @@\n-a\n+b\n");
        }
        return result;
    }

    /** An open thread with a reply, a resolved thread and a plain comment. */
    private static ArrayNode discussions() {
        ArrayNode result = MAPPER.createArrayNode();
        ArrayNode open = result.addObject().put("id", "t-open").putArray("notes");
        note(open, 1, "open", "2026-11-19T10:00:00Z").put("resolvable", true).put("resolved", false)
                .putObject("position").put("position_type", "text").put("new_path", "f1.txt").put("new_line", 12);
        note(open, 2, "open", "2026-11-19T10:01:00Z").put("resolvable", true).put("resolved", false);
        ArrayNode done = result.addObject().put("id", "t-done").putArray("notes");
        note(done, 3, "done", "2026-11-19T10:02:00Z").put("resolvable", true).put("resolved", true)
                .putObject("position").put("position_type", "text").put("new_path", "f1.txt").put("new_line", 20);
        ArrayNode plain = result.addObject().put("id", "t-plain").put("individual_note", true).putArray("notes");
        note(plain, 4, "plain", "2026-11-19T10:03:00Z").put("resolvable", false);
        return result;
    }

    private static ObjectNode note(ArrayNode notes, long id, String body, String createdAt) {
        ObjectNode note = notes.addObject().put("id", id).put("body", body).put("created_at", createdAt);
        note.putObject("author").put("username", "anna");
        return note;
    }

    private static void respond(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(status, bytes.length);
        try (exchange) {
            exchange.getResponseBody().write(bytes);
        }
    }
}
