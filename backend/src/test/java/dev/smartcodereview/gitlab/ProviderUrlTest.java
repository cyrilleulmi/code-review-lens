package dev.smartcodereview.gitlab;

import dev.smartcodereview.github.GitHubProvider;
import dev.smartcodereview.model.Model.PrRef;
import dev.smartcodereview.provider.ProviderException;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProviderUrlTest {

    @Test
    void parsesGitHubPullRequestUrls() {
        GitHubProvider github = new GitHubProvider();
        assertEquals(Optional.of(new PrRef("github", "cyrilleulmi", "spongecoach", 13)),
                github.parseUrl("https://github.com/cyrilleulmi/spongecoach/pull/13/files"));
        assertTrue(github.parseUrl("https://gitlab.com/a/b/-/merge_requests/1").isEmpty());
    }

    @Test
    void parsesGitLabMergeRequestUrlsWithNestedGroups() {
        GitLabProvider gitlab = new GitLabProvider();
        gitlab.baseUrl = "https://gitlab.com";
        assertEquals(Optional.of(new PrRef("gitlab", "gitlab-org", "cli", 4347)),
                gitlab.parseUrl("https://gitlab.com/gitlab-org/cli/-/merge_requests/4347"));
        assertEquals(Optional.of(new PrRef("gitlab", "acme~platform~web", "shop", 7)),
                gitlab.parseUrl("https://gitlab.com/acme/platform/web/shop/-/merge_requests/7/diffs"));
        assertTrue(gitlab.parseUrl("https://github.com/cyrilleulmi/spongecoach/pull/13").isEmpty());
    }

    @Test
    void selfManagedGitLabUrlsMatchByHostNotByText() {
        GitLabProvider gitlab = new GitLabProvider();
        gitlab.baseUrl = "https://my.git.com";
        PrRef mr = new PrRef("gitlab", "path~to", "project", 747);
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://my.git.com/path/to/project/-/merge_requests/747"));
        // as copied from a browser, a mail or a chat
        assertEquals(Optional.of(mr), gitlab.parseUrl("\u200bhttps://my.git.com/path/to/project/-/merge_requests/747\u00a0"));
        assertEquals(Optional.of(mr), gitlab.parseUrl("<https://my.git.com/path/to/project/-/merge_requests/747>"));
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://my.git.com/path/to/project/-/merge_requests/747/diffs?commit_id=abc#note_1"));
        // configured differently from how the browser shows it
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://My.Git.COM/path/to/project/-/merge_requests/747"));
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://my.git.com:443/path/to/project/-/merge_requests/747"));
        gitlab.baseUrl = "http://MY.git.com:443";
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://my.git.com/path/to/project/-/merge_requests/747"));
        // GitLab below a path
        gitlab.baseUrl = "https://my.git.com/gitlab";
        assertEquals(Optional.of(mr), gitlab.parseUrl("https://my.git.com/gitlab/path/to/project/-/merge_requests/747"));
        assertTrue(gitlab.parseUrl("https://my.git.com/gitlabx/path/to/project").isEmpty());
        // another port is another GitLab
        gitlab.baseUrl = "https://my.git.com:8443";
        assertThrows(ProviderException.class, () -> gitlab.parseUrl("https://my.git.com/path/to/project/-/merge_requests/747"));
    }

    @Test
    void mergeRequestOfAnotherGitLabSaysWhichOneIsConnected() {
        GitLabProvider gitlab = new GitLabProvider();
        gitlab.baseUrl = "https://gitlab.com";
        ProviderException e = assertThrows(ProviderException.class,
                () -> gitlab.parseUrl("https://my.git.com/path/to/project/-/merge_requests/747"));
        assertEquals("Der Merge Request liegt auf my.git.com, verbunden ist gitlab.com. Die GitLab-Verbindung lässt sich "
                + "unter «Verbindungen» ändern.", e.getMessage());
        assertTrue(gitlab.parseUrl("https://my.git.com/path/to/project").isEmpty());
        assertTrue(gitlab.parseUrl("https://github.com/cyrilleulmi/spongecoach/pull/13").isEmpty());
        assertTrue(gitlab.parseUrl("not a url").isEmpty());
    }

    @Test
    void repositoryUrlsMeanTheWholeRepository() {
        GitHubProvider github = new GitHubProvider();
        PrRef repo = new PrRef("github", "cyrilleulmi", "smart-code-review", 0);
        assertEquals(Optional.of(repo), github.parseUrl("https://github.com/cyrilleulmi/smart-code-review"));
        assertEquals(Optional.of(repo), github.parseUrl("https://github.com/cyrilleulmi/smart-code-review.git"));
        assertEquals(Optional.of(repo), github.parseUrl("https://github.com/cyrilleulmi/smart-code-review/tree/main/docs"));
        assertTrue(github.parseUrl("https://github.com/cyrilleulmi/smart-code-review/issues/3").isEmpty());

        GitLabProvider gitlab = new GitLabProvider();
        gitlab.baseUrl = "https://gitlab.com";
        assertEquals(Optional.of(new PrRef("gitlab", "acme~platform", "shop", 0)),
                gitlab.parseUrl("https://gitlab.com/acme/platform/shop"));
        assertEquals(Optional.of(new PrRef("gitlab", "gitlab-org", "cli", 0)),
                gitlab.parseUrl("https://gitlab.com/gitlab-org/cli/-/tree/main"));
        assertTrue(gitlab.parseUrl("https://gitlab.com/gitlab-org/cli/-/issues/12").isEmpty());
    }
}
