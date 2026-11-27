package dev.codereviewlens.store;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DataStoreTest {

    @TempDir
    Path home;

    @Test
    void newInstallationUsesTheNewDirectory() {
        assertEquals(home.resolve(".code-review-lens"), DataStore.defaultDir(home));
    }

    @Test
    void keepsTheDirectoryOfSmartCodeReviewWhileThereIsNoNewOne() throws IOException {
        Files.createDirectories(home.resolve(".smart-code-review"));
        assertEquals(home.resolve(".smart-code-review"), DataStore.defaultDir(home));
    }

    @Test
    void prefersTheNewDirectoryOnceItExists() throws IOException {
        Files.createDirectories(home.resolve(".smart-code-review"));
        Files.createDirectories(home.resolve(".code-review-lens"));
        assertEquals(home.resolve(".code-review-lens"), DataStore.defaultDir(home));
    }
}
