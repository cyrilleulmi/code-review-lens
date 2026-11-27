package dev.codereviewlens.github;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.codereviewlens.analysis.Languages;
import dev.codereviewlens.analysis.OpenApi;
import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model;
import dev.codereviewlens.model.Model.Comment;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.NewComment;
import dev.codereviewlens.model.Model.PrRef;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.PullRequestSummary;
import dev.codereviewlens.model.Model.Snapshot;
import dev.codereviewlens.model.Model.User;
import dev.codereviewlens.provider.ConnectionIds;
import dev.codereviewlens.provider.ConnectionSettings;
import dev.codereviewlens.provider.HostProvider;
import dev.codereviewlens.provider.JsonHttp;
import dev.codereviewlens.provider.ProviderException;
import dev.codereviewlens.provider.RepoLists;
import dev.codereviewlens.provider.ReviewProvider;
import dev.codereviewlens.provider.Tokens;
import jakarta.annotation.PostConstruct;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import io.quarkus.logging.Log;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * GitHub (github.com or GitHub Enterprise Server) via its REST API. The connection of the startup configuration comes
 * from scr.github.api-url / scr.github.token, GITHUB_TOKEN, GH_TOKEN or `gh auth token`; the UI can override it and
 * add connections to further hosts.
 */
@ApplicationScoped
public class GitHubProvider extends HostProvider {

    static final String GITHUB_COM = "https://github.com";
    private static final String GITHUB_COM_API = "https://api.github.com";
    private static final int MAX_FILE_BYTES = 1_000_000;
    /** Path of a pull request below the host: /owner/repo/pull/<n>[/files …]. */
    private static final Pattern PR_PATH = Pattern.compile("^/([^/]+)/([^/]+)/pull/(\\d+)(?:/.*)?$");
    /** Path of a repository: /owner/repo, optionally .git or /tree/<branch>. */
    private static final Pattern REPO_PATH = Pattern.compile("^/([^/]+)/([^/]+?)(?:\\.git)?(?:/tree/.*)?/?$");
    /** Characters copy and paste brings along (non-breaking and zero-width spaces, byte order mark, <…> of mails). */
    private static final Pattern PASTE_NOISE = Pattern.compile("^[\\s\\u00a0\\u200b-\\u200d\\u2060\\ufeff<]+|[\\s\\u00a0\\u200b-\\u200d\\u2060\\ufeff>]+$");

    @Inject
    ObjectMapper mapper;

    /** REST API of the startup configuration: https://api.github.com, or https://host/api/v3 for GitHub Enterprise. */
    @ConfigProperty(name = "scr.github.api-url", defaultValue = GITHUB_COM_API)
    String apiUrl = GITHUB_COM_API;

    @ConfigProperty(name = "scr.github.token")
    Optional<String> configuredToken = Optional.empty();

    private JsonHttp http;

    @PostConstruct
    void init() {
        http = new JsonHttp(mapper, label());
        String startupUrl = webUrl(apiUrl);
        try {
            startupUrl = ConnectionSettings.normaliseUrl(startupUrl);
        } catch (ProviderException e) {
            Log.warnf("Ignoring scr.github.api-url: %s", e.getMessage());
            startupUrl = GITHUB_COM;
        }
        String host = URI.create(startupUrl).getHost();
        Tokens.Lazy startupToken = new Tokens.Lazy(() -> Tokens.first(configuredToken == null ? Optional.empty() : configuredToken,
                        "GITHUB_TOKEN", "GH_TOKEN")
                .or(() -> GITHUB_COM.equals(webUrlOf(host)) ? Tokens.fromCommand("gh", "auth", "token")
                        : Tokens.fromCommand("gh", "auth", "token", "--hostname", host)));
        use(ConnectionSettings.startup(GITHUB_COM, startupUrl, startupToken::get, null));
    }

    @Override
    public String kind() {
        return ConnectionIds.GITHUB;
    }

    @Override
    protected HostProvider blank() {
        GitHubProvider p = new GitHubProvider();
        p.mapper = mapper;
        p.http = new JsonHttp(mapper, label());
        return p;
    }

    @Override
    public String label() {
        return "GitHub";
    }

    /** The web URL of the host for an API URL of the startup configuration. */
    static String webUrl(String api) {
        String a = api == null || api.isBlank() ? GITHUB_COM_API : api.strip().replaceAll("/+$", "");
        if (a.equalsIgnoreCase(GITHUB_COM_API)) {
            return GITHUB_COM;
        }
        return a.replaceFirst("(?i)/api/v3$", "");
    }

    private static String webUrlOf(String host) {
        return "https://" + host;
    }

    /** REST API of the host in use: api.github.com for github.com, else <host>/api/v3 (GitHub Enterprise Server). */
    private String api() {
        String web = settings == null ? GITHUB_COM : settings.url();
        URI u = URI.create(web);
        return "github.com".equalsIgnoreCase(u.getHost()) ? GITHUB_COM_API : web + "/api/v3";
    }

    @Override
    public User currentUser() {
        JsonNode u = getJson("/user");
        return new User(u.path("login").asText(), u.path("name").asText(null), u.path("avatar_url").asText(null));
    }

    /** Pull request or repository URLs of the host in use, compared by host and port (scheme and case do not matter). */
    @Override
    public Optional<PrRef> parseUrl(String url) {
        URI u = uri(url);
        URI base = URI.create(settings == null ? GITHUB_COM : settings.url());
        if (u == null || !base.getHost().equalsIgnoreCase(u.getHost()) || port(base) != port(u)) {
            return Optional.empty();
        }
        String prefix = base.getPath() == null ? "" : base.getPath().replaceAll("/+$", "");
        if (!u.getPath().startsWith(prefix + "/")) {
            return Optional.empty();
        }
        String path = u.getPath().substring(prefix.length());
        Matcher m = PR_PATH.matcher(path);
        if (m.matches()) {
            return Optional.of(new PrRef(id(), m.group(1), m.group(2), Integer.parseInt(m.group(3))));
        }
        Matcher r = REPO_PATH.matcher(path);
        return r.matches() ? Optional.of(new PrRef(id(), r.group(1), r.group(2), 0)) : Optional.empty();
    }

    private static URI uri(String raw) {
        String value = raw == null ? "" : PASTE_NOISE.matcher(raw).replaceAll("");
        try {
            URI u = new URI(value);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            return (scheme.equals("http") || scheme.equals("https")) && u.getHost() != null && u.getPath() != null ? u : null;
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private static int port(URI u) {
        return u.getPort() == 80 || u.getPort() == 443 ? -1 : u.getPort();
    }

    @Override
    public List<PullRequestSummary> openPullRequests() {
        Map<String, PullRequestSummary> byKey = new LinkedHashMap<>();
        searchInto(byKey, "is:pr is:open archived:false review-requested:@me", "review-requested");
        searchInto(byKey, "is:pr is:open archived:false author:@me", "authored");
        searchInto(byKey, "is:pr is:open archived:false involves:@me", "involved");
        searchInto(byKey, "is:pr is:open archived:false assignee:@me", "involved");
        return new ArrayList<>(byKey.values());
    }

    @Override
    public List<Model.RepositorySummary> repositories(String query) {
        List<Model.RepositorySummary> mine = new ArrayList<>();
        for (JsonNode r : getJson("/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member")) {
            Model.RepositorySummary s = toRepository(r);
            if (RepoLists.matches(s, query)) {
                mine.add(s);
            }
        }
        List<Model.RepositorySummary> found = new ArrayList<>();
        if (query != null && !query.isBlank()) {
            JsonNode res = getJson("/search/repositories?per_page=20&q="
                    + URLEncoder.encode(scoped(query.trim() + " in:name", mine()), StandardCharsets.UTF_8));
            res.path("items").forEach(r -> found.add(toRepository(r)));
        }
        return RepoLists.merge(mine, found);
    }

    private Model.RepositorySummary toRepository(JsonNode r) {
        return new Model.RepositorySummary(id(), r.path("owner").path("login").asText(), r.path("name").asText(),
                r.path("description").asText(""), r.path("html_url").asText(),
                r.path("pushed_at").asText(r.path("updated_at").asText("")));
    }

    @Override
    public List<PullRequestSummary> repositoryPullRequests(String owner, String repo) {
        String me = currentUser().login();
        JsonNode list = getJson("/repos/" + owner + "/" + repo
                + "/pulls?state=open&sort=updated&direction=desc&per_page=100");
        List<PullRequestSummary> result = new ArrayList<>();
        for (JsonNode pr : list) {
            String author = pr.path("user").path("login").asText();
            List<String> roles = new ArrayList<>();
            if (author.equalsIgnoreCase(me)) {
                roles.add("authored");
            }
            for (JsonNode rr : pr.path("requested_reviewers")) {
                if (rr.path("login").asText().equalsIgnoreCase(me)) {
                    roles.add("review-requested");
                }
            }
            result.add(new PullRequestSummary(id(), owner, repo, pr.path("number").asInt(), pr.path("title").asText(),
                    author, pr.path("html_url").asText(), pr.path("draft").asBoolean(false),
                    pr.path("created_at").asText(), pr.path("updated_at").asText(), roles, null));
        }
        return result;
    }

    @Override
    public List<PullRequestSummary> searchPullRequests(String query) {
        String me = currentUser().login();
        JsonNode res = getJson("/search/issues?per_page=50&sort=updated&q="
                + URLEncoder.encode("is:pr is:open archived:false " + scoped(query.trim(), mine()), StandardCharsets.UTF_8));
        List<PullRequestSummary> result = new ArrayList<>();
        for (JsonNode item : res.path("items")) {
            String[] repoParts = item.path("repository_url").asText().split("/");
            String author = item.path("user").path("login").asText();
            List<String> roles = author.equalsIgnoreCase(me) ? List.of("authored") : List.of();
            result.add(new PullRequestSummary(id(), repoParts[repoParts.length - 2], repoParts[repoParts.length - 1],
                    item.path("number").asInt(), item.path("title").asText(), author, item.path("html_url").asText(),
                    item.path("draft").asBoolean(false), item.path("created_at").asText(),
                    item.path("updated_at").asText(), roles, null));
        }
        return result;
    }

    /** A search qualifier like org:acme, repo:o/r or author:x. */
    private static final Pattern QUALIFIER = Pattern.compile("(^|\\s)[a-z-]+:\\S");

    /** The user and their organisations: where a search without own qualifiers looks. */
    private List<String> mine() {
        List<String> owners = new ArrayList<>();
        owners.add("user:" + currentUser().login());
        for (JsonNode org : getJson("/user/orgs?per_page=100")) {
            owners.add("org:" + org.path("login").asText());
        }
        return owners;
    }

    /**
     * Limits a search to the given owners (OR-ed by GitHub) unless the query already has qualifiers like org: or
     * repo: - free text over all of GitHub finds mostly strangers' projects. Stays within GitHub's query length.
     */
    static String scoped(String query, List<String> owners) {
        if (QUALIFIER.matcher(query.replace(" in:name", "")).find()) {
            return query;
        }
        StringBuilder q = new StringBuilder(query);
        for (String owner : owners) {
            if (q.length() + owner.length() + 1 > 250) {
                break;
            }
            q.append(' ').append(owner);
        }
        return q.toString();
    }

    private void searchInto(Map<String, PullRequestSummary> byKey, String query, String role) {
        JsonNode res = getJson("/search/issues?per_page=100&sort=updated&q=" + URLEncoder.encode(query, StandardCharsets.UTF_8));
        for (JsonNode item : res.path("items")) {
            String[] repoParts = item.path("repository_url").asText().split("/");
            String owner = repoParts[repoParts.length - 2];
            String repo = repoParts[repoParts.length - 1];
            int number = item.path("number").asInt();
            String key = owner + "/" + repo + "#" + number;
            PullRequestSummary existing = byKey.get(key);
            if ("involved".equals(role) && existing != null && !existing.roles().isEmpty()) {
                continue; // keep the list clean: "involved" only for PRs without a more specific role
            }
            List<String> roles = new ArrayList<>(existing == null ? List.of() : existing.roles());
            if (!roles.contains(role)) {
                roles.add(role);
            }
            byKey.put(key, new PullRequestSummary(id(), owner, repo, number, item.path("title").asText(),
                    item.path("user").path("login").asText(), item.path("html_url").asText(),
                    item.path("draft").asBoolean(false), item.path("created_at").asText(),
                    item.path("updated_at").asText(), roles, null));
        }
    }

    @Override
    public Snapshot fetchSnapshot(PrRef ref) {
        String base = "/repos/" + ref.owner() + "/" + ref.repo() + "/pulls/" + ref.number();
        JsonNode pr = getJson(base);
        PullRequestInfo info = new PullRequestInfo(id(), ref.owner(), ref.repo(), ref.number(),
                pr.path("title").asText(), pr.path("body").asText(""), pr.path("user").path("login").asText(),
                pr.path("html_url").asText(), pr.path("draft").asBoolean(false), pr.path("state").asText(),
                pr.path("base").path("ref").asText(), pr.path("head").path("ref").asText(),
                pr.path("base").path("sha").asText(), pr.path("head").path("sha").asText(),
                pr.path("created_at").asText(), pr.path("updated_at").asText(),
                pr.path("additions").asInt(), pr.path("deletions").asInt(), pr.path("changed_files").asInt(), null);

        List<DiffFile> files = new ArrayList<>();
        for (int page = 1; page <= 30; page++) {
            JsonNode batch = getJson(base + "/files?per_page=100&page=" + page);
            batch.forEach(f -> files.add(diffFile(f)));
            if (batch.size() < 100) {
                break;
            }
        }
        return new Snapshot(Model.SCHEMA_VERSION, Instant.now().toString(), info, files);
    }

    @Override
    public Model.RepoStructure directories(PrRef ref, String sha) {
        JsonNode tree = getJson("/repos/" + ref.owner() + "/" + ref.repo() + "/git/trees/" + sha + "?recursive=1");
        List<String> dirs = new ArrayList<>();
        List<String> contracts = new ArrayList<>();
        List<String> files = new ArrayList<>();
        tree.path("tree").forEach(n -> {
            String path = n.path("path").asText();
            if ("tree".equals(n.path("type").asText())) {
                dirs.add(path);
            } else if ("blob".equals(n.path("type").asText())) {
                files.add(path);
                if (OpenApi.isContract(path)) {
                    contracts.add(path);
                }
            }
        });
        return new Model.RepoStructure(dirs, tree.path("truncated").asBoolean(false), contracts, null, files);
    }

    @Override
    public Optional<String> fileContent(PrRef ref, String path, String sha) {
        String encodedPath = URLEncoder.encode(path, StandardCharsets.UTF_8).replace("%2F", "/").replace("+", "%20");
        HttpResponse<byte[]> res = http.send(request("/repos/" + ref.owner() + "/" + ref.repo() + "/contents/" + encodedPath + "?ref=" + sha)
                .header("Accept", "application/vnd.github.raw+json").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        return res.statusCode() == 200 ? Tokens.text(res.body(), MAX_FILE_BYTES) : Optional.empty();
    }

    @Override
    public List<Model.Commit> commits(PrRef ref) {
        String base = "/repos/" + ref.owner() + "/" + ref.repo() + "/pulls/" + ref.number() + "/commits?per_page=100&page=";
        List<Model.Commit> result = new ArrayList<>();
        for (int page = 1; page <= 3; page++) { // GitHub lists at most 250 commits of a PR
            JsonNode batch = getJson(base + page);
            batch.forEach(c -> result.add(toCommit(c)));
            if (batch.size() < 100) {
                break;
            }
        }
        return result;
    }

    @Override
    public List<Model.Commit> branchCommits(PrRef ref, String sha, int max) {
        List<Model.Commit> result = new ArrayList<>();
        for (int page = 1; result.size() < max; page++) {
            JsonNode batch = getJson("/repos/" + ref.owner() + "/" + ref.repo() + "/commits?sha=" + sha
                    + "&per_page=" + Math.min(100, max) + "&page=" + page);
            batch.forEach(c -> result.add(toCommit(c)));
            if (batch.size() < Math.min(100, max)) {
                break;
            }
        }
        return result.size() > max ? result.subList(0, max) : result;
    }

    private static Model.Commit toCommit(JsonNode c) {
        String message = c.path("commit").path("message").asText("");
        List<String> parents = new ArrayList<>();
        c.path("parents").forEach(p -> parents.add(p.path("sha").asText()));
        return new Model.Commit(c.path("sha").asText(), firstLine(message), message,
                c.path("commit").path("author").path("name").asText(null), c.path("author").path("login").asText(null),
                c.path("author").path("avatar_url").asText(null), c.path("commit").path("author").path("date").asText(null),
                c.path("html_url").asText(null), parents, 0, 0, List.of());
    }

    @Override
    public Model.Repository repository(PrRef ref) {
        String base = "/repos/" + ref.owner() + "/" + ref.repo();
        JsonNode r = getJson(base);
        String branch = r.path("default_branch").asText("main");
        JsonNode head = getJson(base + "/commits/" + branch);
        return new Model.Repository(branch, head.path("sha").asText(), r.path("html_url").asText(),
                r.path("description").asText(""), head.path("commit").path("author").path("date").asText(null));
    }

    @Override
    public byte[] archive(PrRef ref, String sha) {
        String path = "/repos/" + ref.owner() + "/" + ref.repo() + "/tarball/" + sha;
        HttpResponse<byte[]> res = http.send(request(path).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        if (res.statusCode() != 200) {
            throw new ProviderException(res.statusCode() == 404 ? 404 : 502, "GitHub " + res.statusCode() + " auf " + path);
        }
        return res.body();
    }

    @Override
    public List<DiffFile> commitDiff(PrRef ref, String sha) {
        List<DiffFile> files = new ArrayList<>();
        for (int page = 1; page <= 30; page++) {
            JsonNode batch = getJson("/repos/" + ref.owner() + "/" + ref.repo() + "/commits/" + sha + "?per_page=100&page=" + page)
                    .path("files");
            batch.forEach(f -> files.add(diffFile(f)));
            if (batch.size() < 100) {
                break;
            }
        }
        return files;
    }

    private static final String BLAME_QUERY = """
            query($owner: String!, $repo: String!, $sha: GitObjectID!, $path: String!) {
              repository(owner: $owner, name: $repo) {
                object(oid: $sha) {
                  ... on Commit {
                    blame(path: $path) {
                      ranges { startingLine endingLine commit { oid message authoredDate url author { name user { login avatarUrl } } } }
                    }
                  }
                }
              }
            }""";

    /** The REST API has no blame; GraphQL does. */
    @Override
    public Model.Blame blame(PrRef ref, String path, String sha) {
        ObjectNode body = mapper.createObjectNode().put("query", BLAME_QUERY);
        body.putObject("variables").put("owner", ref.owner()).put("repo", ref.repo()).put("sha", sha).put("path", path);
        JsonNode res = http.json(request(URI.create(graphqlUrl())).header("Content-Type", "application/json")
                .POST(http.body(body)).build(), "GraphQL blame");
        if (res.path("errors").size() > 0) {
            throw new ProviderException(502, "GitHub blame: " + res.path("errors").get(0).path("message").asText());
        }
        List<Model.BlameRange> ranges = new ArrayList<>();
        Map<String, Model.Commit> commits = new LinkedHashMap<>();
        for (JsonNode r : res.path("data").path("repository").path("object").path("blame").path("ranges")) {
            JsonNode c = r.path("commit");
            String oid = c.path("oid").asText();
            ranges.add(new Model.BlameRange(r.path("startingLine").asInt(), r.path("endingLine").asInt(), oid));
            commits.computeIfAbsent(oid, k -> {
                String message = c.path("message").asText("");
                JsonNode user = c.path("author").path("user");
                return new Model.Commit(oid, firstLine(message), message, c.path("author").path("name").asText(null),
                        user.path("login").asText(null), user.path("avatarUrl").asText(null), c.path("authoredDate").asText(null),
                        c.path("url").asText(null), List.of(), 0, 0, List.of());
            });
        }
        return new Model.Blame(path, sha, ranges, new ArrayList<>(commits.values()));
    }

    /** https://api.github.com/graphql, or https://host/api/graphql for GitHub Enterprise (REST: /api/v3). */
    private String graphqlUrl() {
        String api = api();
        return api.endsWith("/api/v3") ? api.substring(0, api.length() - 3) + "graphql" : api + "/graphql";
    }

    private static String firstLine(String message) {
        int nl = message.indexOf('\n');
        return (nl < 0 ? message : message.substring(0, nl)).trim();
    }

    private static DiffFile diffFile(JsonNode f) {
        String path = f.path("filename").asText();
        String patch = f.path("patch").asText(null);
        return new DiffFile(path, f.path("previous_filename").asText(null), f.path("status").asText(),
                f.path("additions").asInt(), f.path("deletions").asInt(), Languages.of(path),
                patch == null, PatchParser.parse(patch));
    }

    @Override
    public List<Comment> comments(PrRef ref) {
        String repoBase = "/repos/" + ref.owner() + "/" + ref.repo();
        List<Comment> result = new ArrayList<>();
        for (JsonNode c : getJson(repoBase + "/pulls/" + ref.number() + "/comments?per_page=100")) {
            result.add(reviewComment(c));
        }
        for (JsonNode c : getJson(repoBase + "/issues/" + ref.number() + "/comments?per_page=100")) {
            result.add(issueComment(c));
        }
        result.sort((a, b) -> a.createdAt().compareTo(b.createdAt()));
        return result;
    }

    @Override
    public Comment postComment(PrRef ref, Snapshot snapshot, NewComment c) {
        String repoBase = "/repos/" + ref.owner() + "/" + ref.repo();
        ObjectNode body = mapper.createObjectNode().put("body", c.body());
        if (c.inReplyTo() != null) {
            return reviewComment(postJson(repoBase + "/pulls/" + ref.number() + "/comments/" + c.inReplyTo() + "/replies", body));
        }
        if (c.path() == null || c.line() == null) {
            return issueComment(postJson(repoBase + "/issues/" + ref.number() + "/comments", body));
        }
        body.put("commit_id", snapshot.pr().headSha()).put("path", c.path()).put("line", c.line())
                .put("side", c.side() == null ? "RIGHT" : c.side());
        return reviewComment(postJson(repoBase + "/pulls/" + ref.number() + "/comments", body));
    }

    private Comment reviewComment(JsonNode c) {
        Integer line = c.hasNonNull("line") ? c.get("line").asInt() : null;
        String side = c.path("side").asText("RIGHT");
        String key = line == null ? null : ("LEFT".equals(side) ? "O" : "N") + line;
        return new Comment(c.path("id").asLong(), "review", c.path("path").asText(null), line, side, key,
                c.path("body").asText(), c.path("user").path("login").asText(), c.path("user").path("avatar_url").asText(null),
                c.path("created_at").asText(), c.path("html_url").asText(),
                c.hasNonNull("in_reply_to_id") ? c.get("in_reply_to_id").asLong() : null, null, null);
    }

    private Comment issueComment(JsonNode c) {
        return new Comment(c.path("id").asLong(), "issue", null, null, null, null, c.path("body").asText(),
                c.path("user").path("login").asText(), c.path("user").path("avatar_url").asText(null),
                c.path("created_at").asText(), c.path("html_url").asText(), null, null, null);
    }

    // ---------------------------------------------------------------- http

    private JsonNode getJson(String path) {
        return http.json(request(path).header("Accept", "application/vnd.github+json").GET().build(), path);
    }

    private JsonNode postJson(String path, JsonNode body) {
        return http.json(request(path).header("Accept", "application/vnd.github+json")
                .header("Content-Type", "application/json").POST(http.body(body)).build(), path);
    }

    private HttpRequest.Builder request(String path) {
        return request(URI.create(api() + path));
    }

    private HttpRequest.Builder request(URI uri) {
        String t = settings.token().orElseThrow(() -> new ProviderException(401,
                "Kein GitHub-Token gefunden. Trage eines unter «Verbindungen» ein, setze GITHUB_TOKEN oder melde dich "
                        + "mit `gh auth login` an."));
        return HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + t)
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "CodeReviewLens");
    }
}
