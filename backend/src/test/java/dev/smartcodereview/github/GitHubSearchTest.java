package dev.smartcodereview.github;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GitHubSearchTest {

    private static final List<String> OWNERS = List.of("user:me", "org:acme");

    @Test
    void freeTextSearchesOnlyTheUserAndTheirOrganisations() {
        assertEquals("billing user:me org:acme", GitHubProvider.scoped("billing", OWNERS));
        assertEquals("billing in:name user:me org:acme", GitHubProvider.scoped("billing in:name", OWNERS));
    }

    @Test
    void ownQualifiersSearchAsGiven() {
        assertEquals("billing org:other", GitHubProvider.scoped("billing org:other", OWNERS));
        assertEquals("repo:o/r fix in:name", GitHubProvider.scoped("repo:o/r fix in:name", OWNERS));
        assertEquals("a: b", GitHubProvider.scoped("a: b", List.of()));
    }

    @Test
    void staysWithinTheQueryLength() {
        List<String> many = Collections.nCopies(100, "org:some-organisation");
        assertTrue(GitHubProvider.scoped("billing", many).length() <= 250);
    }
}
