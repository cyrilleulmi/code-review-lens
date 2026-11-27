package dev.codereviewlens.provider;

import dev.codereviewlens.model.Model.RepositorySummary;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pure helpers to filter, merge and order repository lists (no network). */
public final class RepoLists {

    public static final int MAX = 50;

    private RepoLists() {
    }

    /** True when the query (blank = everything) occurs in "owner/repo", ignoring case. */
    public static boolean matches(RepositorySummary r, String query) {
        if (query == null || query.isBlank()) {
            return true;
        }
        String hay = (r.owner() + "/" + r.repo()).toLowerCase();
        return hay.contains(query.trim().toLowerCase().replace('~', '/'));
    }

    /**
     * Merges lists (first wins on duplicates), capped at {@link #MAX}. Every list is ordered by most recent activity,
     * but the lists stay in their order: the user's own repositories come before hits of a wider search.
     */
    @SafeVarargs
    public static List<RepositorySummary> merge(List<RepositorySummary>... lists) {
        Comparator<RepositorySummary> newestFirst =
                Comparator.comparing((RepositorySummary r) -> r.updatedAt() == null ? "" : r.updatedAt()).reversed();
        Map<String, RepositorySummary> byKey = new LinkedHashMap<>();
        for (List<RepositorySummary> list : lists) {
            for (RepositorySummary r : list.stream().sorted(newestFirst).toList()) {
                byKey.putIfAbsent((r.owner() + "/" + r.repo()).toLowerCase(), r);
            }
        }
        List<RepositorySummary> result = new ArrayList<>(byKey.values());
        return result.size() > MAX ? new ArrayList<>(result.subList(0, MAX)) : result;
    }
}
