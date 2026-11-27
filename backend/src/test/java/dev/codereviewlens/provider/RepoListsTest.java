package dev.codereviewlens.provider;

import dev.codereviewlens.model.Model.RepositorySummary;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RepoListsTest {

    private static RepositorySummary repo(String owner, String name, String updated) {
        return new RepositorySummary("github", owner, name, "", "", updated);
    }

    @Test
    void matchesIgnoresCaseAndSeesOwner() {
        RepositorySummary r = repo("Acme", "Billing-Service", "2024-01-01");
        assertTrue(RepoLists.matches(r, "billing"));
        assertTrue(RepoLists.matches(r, "acme/bill"));
        assertTrue(RepoLists.matches(r, " "));
        assertFalse(RepoLists.matches(r, "shipping"));
    }

    @Test
    void mergeDedupesAndKeepsOwnRepositoriesFirst() {
        List<RepositorySummary> merged = RepoLists.merge(
                List.of(repo("a", "x", "2024-01-01"), repo("a", "y", "2024-03-01")),
                List.of(repo("A", "X", "2023-01-01"), repo("b", "z", "2024-02-01")));
        assertEquals(List.of("y", "x", "z"), merged.stream().map(RepositorySummary::repo).toList());
    }
}
