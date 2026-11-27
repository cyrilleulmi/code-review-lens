package dev.codereviewlens;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.gitlab.GitLabProvider;
import dev.codereviewlens.gitlab.GitLabProviders;
import dev.codereviewlens.model.Model.Connection;
import dev.codereviewlens.model.Model.ConnectionRequest;
import dev.codereviewlens.model.Model.NewConnection;
import dev.codereviewlens.model.Model.SavedConnection;
import dev.codereviewlens.provider.ProviderException;
import dev.codereviewlens.provider.ReviewProvider;
import dev.codereviewlens.store.DataStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** connections.json: written on every change of the config page, read at start, gone when nothing is saved. */
class ConnectionServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private Path dir;
    private GitLabProvider gitlab;
    private ConnectionService connections;

    @BeforeEach
    void setUp() throws IOException {
        dir = Files.createTempDirectory("scr-connections");
        gitlab = gitlab();
        connections = service(gitlab);
    }

    @AfterEach
    void tearDown() throws IOException {
        try (Stream<Path> files = Files.walk(dir)) {
            for (Path p : files.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        }
    }

    @Test
    void savesTheConnectionAndUsesItAgainAfterARestart() throws IOException {
        connections.configure("gitlab", new ConnectionRequest("https://gitlab.example.com", "glpat-page", "sso=1", true));

        String file = Files.readString(dir.resolve("connections.json"));
        assertTrue(file.contains("\"gitlab\""), file);
        assertTrue(file.contains("glpat-page"), file);

        GitLabProvider restarted = gitlab();
        service(restarted).onStart(null);
        assertEquals("https://gitlab.example.com", restarted.host());
        assertEquals(new SavedConnection("https://gitlab.example.com", "glpat-page", "sso=1"), restarted.savedConnection());
    }

    @Test
    void aCookieOnlyForNowIsNotWritten() throws IOException {
        connections.configure("gitlab", new ConnectionRequest(null, "glpat-page", "sso=secret", false));

        String file = Files.readString(dir.resolve("connections.json"));
        assertFalse(file.contains("sso=secret"), file);
        assertEquals(Boolean.TRUE, connections.connections().get(0).cookie());
    }

    @Test
    void theStatusBarCookieDialogKeepsASavedCookieSaved() throws IOException {
        connections.configure("gitlab", new ConnectionRequest(null, null, "sso=old", true));

        connections.setCookie("gitlab", "sso=fresh");

        assertTrue(Files.readString(dir.resolve("connections.json")).contains("sso=fresh"));
    }

    @Test
    void resetRemovesTheFile() {
        connections.configure("gitlab", new ConnectionRequest(null, "glpat-page", null, null));
        assertTrue(Files.exists(dir.resolve("connections.json")));

        List<Connection> after = connections.remove("gitlab");

        assertFalse(Files.exists(dir.resolve("connections.json")));
        assertFalse(after.get(0).saved());
    }

    @Test
    void aWrongValueChangesNothing() {
        connections.configure("gitlab", new ConnectionRequest(null, "glpat-page", null, null));

        ProviderException e = assertThrows(ProviderException.class,
                () -> connections.configure("gitlab", new ConnectionRequest("not a url", "glpat-other", null, null)));

        assertEquals(400, e.status());
        assertEquals(new SavedConnection(null, "glpat-page", null), gitlab.savedConnection());
    }

    @Test
    void anUnreadableFileIsIgnoredAtStart() throws IOException {
        Files.writeString(dir.resolve("connections.json"), "{ not json");

        connections.onStart(null);

        assertEquals("https://gitlab.com", gitlab.host());
    }

    @Test
    void addsAConnectionToAnotherHostAndUsesItAgainAfterARestart() throws IOException {
        List<Connection> after = connections.add(new NewConnection("gitlab", "http://127.0.0.1:1/", "glpat-other", null, null));

        Connection added = after.stream().filter(Connection::added).findFirst().orElseThrow();
        assertEquals("gitlab~127.0.0.1_1", added.provider());
        assertEquals("http://127.0.0.1:1", added.url());
        assertEquals("gitlab", added.kind());
        String file = Files.readString(dir.resolve("connections.json"));
        assertTrue(file.contains("\"gitlab~127.0.0.1_1\"") && file.contains("glpat-other"), file);
        assertFalse(file.contains("\"gitlab\":"), "the startup connection has nothing saved: " + file);

        GitLabProvider restarted = gitlab();
        ConnectionService again = service(restarted);
        again.onStart(null);
        ReviewProvider back = again.service.provider("gitlab~127.0.0.1_1");
        assertEquals("http://127.0.0.1:1", back.host());
        assertTrue(back.hasCredentials());
        assertEquals("https://gitlab.com", restarted.host(), "the startup connection stays as it was");
    }

    @Test
    void aSecondConnectionToTheSameHostIsRefused() {
        connections.add(new NewConnection("gitlab", "https://git.example.com", "glpat-a", null, null));

        assertEquals(409, assertThrows(ProviderException.class,
                () -> connections.add(new NewConnection("gitlab", "HTTPS://git.example.com:443/", "glpat-b", null, null))).status());
        assertEquals(409, assertThrows(ProviderException.class,
                () -> connections.add(new NewConnection("gitlab", "https://gitlab.com", "glpat-b", null, null))).status(),
                "the startup connection already goes to gitlab.com");
        assertEquals(400, assertThrows(ProviderException.class,
                () -> connections.add(new NewConnection("bitbucket", "https://bitbucket.org", "x", null, null))).status());
    }

    @Test
    void theUrlOfAnAddedConnectionIsFixedButItsTokenCanChange() {
        connections.add(new NewConnection("gitlab", "https://git.example.com", "glpat-a", null, null));

        assertEquals(400, assertThrows(ProviderException.class, () -> connections.configure("gitlab~git.example.com",
                new ConnectionRequest("https://other.example.com", null, null, null))).status());
        connections.configure("gitlab~git.example.com", new ConnectionRequest("https://git.example.com/", "glpat-b", null, null));
        assertEquals(new SavedConnection("https://git.example.com", "glpat-b", null),
                connections.service.provider("gitlab~git.example.com").savedConnection());
    }

    @Test
    void removingAnAddedConnectionDropsIt() {
        connections.add(new NewConnection("gitlab", "https://git.example.com", "glpat-a", null, null));

        connections.remove("gitlab~git.example.com");

        assertFalse(Files.exists(dir.resolve("connections.json")));
        assertEquals(List.of("gitlab"), connections.service.providerIds());
    }

    private GitLabProvider gitlab() {
        return GitLabProviders.create(MAPPER, null, "glpat-startup", null);
    }

    private ConnectionService service(GitLabProvider provider) {
        ConnectionService s = new ConnectionService();
        s.service = new ReviewService() {
            @Override
            protected List<ReviewProvider> startupProviders() {
                return List.of(provider);
            }
        };
        s.store = new DataStore() {
            @Override
            public Path root() {
                return dir;
            }

            @Override
            public <T> Optional<T> read(Path file, Class<T> type) {
                try {
                    return Files.isRegularFile(file) ? Optional.of(MAPPER.readValue(file.toFile(), type)) : Optional.empty();
                } catch (IOException e) {
                    return Optional.empty();
                }
            }

            @Override
            public void write(Path file, Object value) {
                try {
                    Files.write(file, MAPPER.writeValueAsBytes(value));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            }
        };
        return s;
    }
}
