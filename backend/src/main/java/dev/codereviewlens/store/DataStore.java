package dev.codereviewlens.store;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import dev.codereviewlens.model.Model.PrRef;
import io.quarkus.logging.Log;
import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * The local data directory. Plain, pretty-printed JSON and text files so that humans and agents can read
 * and edit them directly; every write is atomic (temp file + move). Files are re-read on every request,
 * so external edits show up immediately. Layout is documented in docs/04-persistenz-und-agenten.md and in
 * the AGENTS.md written into the data directory.
 */
@ApplicationScoped
public class DataStore {

    @ConfigProperty(name = "scr.data-dir")
    Optional<String> configuredDir;

    @Inject
    ObjectMapper mapper;

    private ObjectMapper pretty;
    private Path root;

    void onStart(@Observes StartupEvent ev) {
        pretty = mapper.copy().enable(SerializationFeature.INDENT_OUTPUT);
        root = configuredDir.filter(s -> !s.isBlank()).map(Path::of)
                .orElseGet(() -> defaultDir(Path.of(System.getProperty("user.home"))))
                .toAbsolutePath().normalize();
        try {
            Files.createDirectories(root.resolve("reviews"));
            copyResource("/data-dir/AGENTS.md", root.resolve("AGENTS.md"));
            copyResource("/rules/default-rules.json", root.resolve("rules.default.json"));
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot initialise data directory " + root, e);
        }
        Log.infof("CodeReviewLens data directory: %s", root);
    }

    /**
     * The data directory when none is configured: ~/.code-review-lens. Until 0.11.0 the tool was called
     * SmartCodeReview and kept its data in ~/.smart-code-review; that one stays in use while it exists and the new one
     * does not, so earlier marks and connections are not lost.
     */
    static Path defaultDir(Path home) {
        Path current = home.resolve(".code-review-lens");
        Path former = home.resolve(".smart-code-review");
        return !Files.isDirectory(current) && Files.isDirectory(former) ? former : current;
    }

    private void copyResource(String resource, Path target) throws IOException {
        try (InputStream in = DataStore.class.getResourceAsStream(resource)) {
            if (in != null) {
                writeAtomic(target, in.readAllBytes());
            }
        }
    }

    public Path root() {
        return root;
    }

    public Path prDir(PrRef ref) {
        return root.resolve("reviews").resolve(safe(ref.provider())).resolve(safe(ref.owner()))
                .resolve(safe(ref.repo())).resolve(String.valueOf(ref.number()));
    }

    public Path sourcesDir(PrRef ref) {
        return prDir(ref).resolve("sources");
    }

    /** Old versions (at the PR's base commit) of changed test files, by their path in the base version. */
    public Path baseSourcesDir(PrRef ref) {
        return prDir(ref).resolve("sources-base");
    }

    /** Existing, unchanged test files (at the PR head) loaded for the changed code (Bestehende Tests), by path. */
    public Path relatedSourcesDir(PrRef ref) {
        return prDir(ref).resolve("sources-related");
    }

    /** Deletes a directory with everything in it (no-op if it does not exist). */
    public void deleteTree(Path dir) {
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public <T> Optional<T> read(Path file, Class<T> type) {
        if (!Files.isRegularFile(file)) {
            return Optional.empty();
        }
        try {
            return Optional.of(mapper.readValue(file.toFile(), type));
        } catch (IOException e) {
            Log.warnf("Cannot read %s (%s) - ignoring it", file, e.getMessage());
            return Optional.empty();
        }
    }

    public void write(Path file, Object value) {
        try {
            writeAtomic(file, pretty.writeValueAsBytes(value));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public Optional<String> readText(Path file) {
        try {
            return Files.isRegularFile(file) ? Optional.of(Files.readString(file, StandardCharsets.UTF_8)) : Optional.empty();
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    public void writeText(Path file, String text) {
        try {
            writeAtomic(file, text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void writeAtomic(Path target, byte[] bytes) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = Files.createTempFile(target.getParent(), ".tmp-", ".part");
        Files.write(tmp, bytes);
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** Resolves a repo-relative path below base without allowing it to escape. */
    public static Path resolveInside(Path base, String relative) {
        Path p = base.resolve(relative).normalize();
        if (!p.startsWith(base)) {
            throw new IllegalArgumentException("Invalid path: " + relative);
        }
        return p;
    }

    private static String safe(String segment) {
        if (!segment.matches("[A-Za-z0-9._~-]+") || segment.equals("..") || segment.equals(".")) {
            throw new IllegalArgumentException("Invalid name: " + segment);
        }
        return segment;
    }
}
