package dev.smartcodereview;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.smartcodereview.gitlab.GitLabProvider;
import dev.smartcodereview.gitlab.GitLabProviders;
import dev.smartcodereview.model.Model.Connection;
import dev.smartcodereview.model.Model.ConnectionRequest;
import dev.smartcodereview.model.Model.SavedConnection;
import dev.smartcodereview.provider.ProviderException;
import dev.smartcodereview.provider.ReviewProvider;
import dev.smartcodereview.store.DataStore;
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

        List<Connection> after = connections.reset("gitlab");

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

    private GitLabProvider gitlab() {
        return GitLabProviders.create(MAPPER, null, "glpat-startup", null);
    }

    private ConnectionService service(GitLabProvider provider) {
        ConnectionService s = new ConnectionService();
        s.service = new ReviewService() {
            @Override
            public List<ReviewProvider> providers() {
                return List.of(provider);
            }

            @Override
            public ReviewProvider provider(String id) {
                if (!id.equals(provider.id())) {
                    throw new ProviderException(404, "Unbekannter Provider: " + id);
                }
                return provider;
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
