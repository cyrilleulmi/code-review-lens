package dev.smartcodereview.gitlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.smartcodereview.github.GitHubProvider;
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

    private static void respond(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(status, bytes.length);
        try (exchange) {
            exchange.getResponseBody().write(bytes);
        }
    }
}
