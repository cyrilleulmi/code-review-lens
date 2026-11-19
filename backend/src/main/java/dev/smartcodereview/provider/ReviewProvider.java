package dev.smartcodereview.provider;

import dev.smartcodereview.model.Model;
import dev.smartcodereview.model.Model.Comment;
import dev.smartcodereview.model.Model.NewComment;
import dev.smartcodereview.model.Model.PrRef;
import dev.smartcodereview.model.Model.PullRequestSummary;
import dev.smartcodereview.model.Model.Snapshot;
import dev.smartcodereview.model.Model.User;

import java.util.List;
import java.util.Optional;

/**
 * A code host (GitHub, GitLab; later Bitbucket, Azure DevOps). Everything above this interface is
 * provider-agnostic. "Pull request" is used for GitLab merge requests as well.
 */
public interface ReviewProvider {

    /** Short id used in URLs and in the data directory, e.g. "github". */
    String id();

    /** Display name, e.g. "GitLab". */
    String label();

    /** Base URL of the web UI, e.g. https://gitlab.com. */
    String host();

    /** True when credentials are configured, i.e. the user and their open PRs can be listed. */
    boolean hasCredentials();

    User currentUser();

    /**
     * The session cookies of an SSO proxy in front of the host, sent with every request: empty when this host takes
     * none, else whether a cookie is set.
     */
    default Optional<Boolean> cookieSet() {
        return Optional.empty();
    }

    /** Replaces those cookies until the next start (kept in memory, never stored); blank removes them. */
    default void setCookie(String cookie) {
        throw new ProviderException(400, label() + " nimmt kein Cookie entgegen");
    }

    /** Open PRs authored by the user, waiting for the user's review, or (role "involved") otherwise involving the user. */
    List<PullRequestSummary> openPullRequests();

    /** Repositories the user can see, most recently active first, at most ~50; blank query = no filter. */
    List<Model.RepositorySummary> repositories(String query);

    /** Open PRs of one repository, newest update first; roles are "authored"/"review-requested" or empty. */
    List<PullRequestSummary> repositoryPullRequests(String owner, String repo);

    /** Free-text search over open PRs (provider-specific qualifiers allowed). */
    List<PullRequestSummary> searchPullRequests(String query);

    /** Recognises a PR web URL of this host, or a repository URL (number 0 = the whole repository). */
    Optional<PrRef> parseUrl(String url);

    /** Default branch and its head commit. */
    Model.Repository repository(PrRef ref);

    /** The repository at a commit as a .tar.gz archive (one request instead of one per file). */
    byte[] archive(PrRef ref, String sha);

    /** The newest commits reachable from sha (newest first), at most max. */
    List<Model.Commit> branchCommits(PrRef ref, String sha, int max);

    /** Fetches PR metadata and the full diff. */
    Snapshot fetchSnapshot(PrRef ref);

    /** All directories of the repository at a commit (for architecture detection); may be truncated. */
    Model.RepoStructure directories(PrRef ref, String sha);

    /** Content of a file at a commit, empty if missing/binary/too large. */
    Optional<String> fileContent(PrRef ref, String path, String sha);

    /** Commits of the PR (any order; each with its parents). Additions/deletions/files may be empty. */
    List<Model.Commit> commits(PrRef ref);

    /** The files a commit changed compared with its first parent, with parsed hunks. */
    List<Model.DiffFile> commitDiff(PrRef ref, String sha);

    /** git blame of a file at a commit: who last changed which lines. */
    Model.Blame blame(PrRef ref, String path, String sha);

    List<Comment> comments(PrRef ref);

    /** Posts immediately (no pending review). The snapshot provides commit SHAs and old file paths. */
    Comment postComment(PrRef ref, Snapshot snapshot, NewComment comment);
}
