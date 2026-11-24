package dev.smartcodereview.provider;

import dev.smartcodereview.model.Model.ConnectionRequest;
import dev.smartcodereview.model.Model.SavedConnection;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Startup configuration, config page and runtime cookie: which value wins and where it comes from. */
class ConnectionSettingsTest {

    private static final String GITLAB_COM = "https://gitlab.com";
    private static final String SELF = "https://gitlab.example.com";

    @Test
    void theStartupConfigurationAloneWorksAsBefore() {
        ConnectionSettings s = startup(SELF + "/", "glpat-env", "Cookie: sso=1");

        assertEquals(SELF, s.url());
        assertEquals("startup", s.urlSource());
        assertEquals(Optional.of("glpat-env"), s.token());
        assertEquals("startup", s.tokenSource());
        assertEquals("sso=1", s.cookie());
        assertEquals("startup", s.cookieSource());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void nothingConfiguredMeansGitLabComWithoutToken() {
        ConnectionSettings s = startup(GITLAB_COM, null, null);

        assertEquals(GITLAB_COM, s.url());
        assertEquals("default", s.urlSource());
        assertEquals(Optional.empty(), s.token());
        assertNull(s.tokenSource());
        assertNull(s.cookie());
        assertNull(s.cookieSource());
    }

    @Test
    void theConfigPageAddsAWholeConnection() {
        ConnectionSettings s = startup(GITLAB_COM, null, null)
                .apply(new ConnectionRequest(SELF, "glpat-page", "sso=2", true));

        assertEquals(SELF, s.url());
        assertEquals("saved", s.urlSource());
        assertEquals(Optional.of("glpat-page"), s.token());
        assertEquals("saved", s.tokenSource());
        assertEquals("sso=2", s.cookie());
        assertEquals("saved", s.cookieSource());
        assertEquals(new SavedConnection(SELF, "glpat-page", "sso=2"), s.saved());
    }

    @Test
    void theConfigPageOverridesFieldByFieldAndKeepsTheRest() {
        ConnectionSettings s = startup(SELF, "glpat-env", "sso=1").apply(new ConnectionRequest(null, "glpat-page", null, null));

        assertEquals(SELF, s.url());
        assertEquals("startup", s.urlSource());
        assertEquals(Optional.of("glpat-page"), s.token());
        assertEquals("sso=1", s.cookie());
        assertEquals("startup", s.cookieSource());
        assertEquals(new SavedConnection(null, "glpat-page", null), s.saved());
    }

    @Test
    void anEmptyFieldGoesBackToTheStartupConfiguration() {
        ConnectionSettings s = startup(SELF, "glpat-env", "sso=1")
                .apply(new ConnectionRequest("https://other.example.com", "glpat-page", "sso=2", true))
                .apply(new ConnectionRequest("", "", "", null));

        assertEquals(SELF, s.url());
        assertEquals(Optional.of("glpat-env"), s.token());
        assertEquals("sso=1", s.cookie());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void theStartupUrlEnteredAgainFollowsTheStartupConfiguration() {
        ConnectionSettings s = startup(SELF, null, null).apply(new ConnectionRequest(SELF + "/", null, null, null));

        assertEquals("startup", s.urlSource());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void aNewUrlDropsTheTokenAndCookieOfTheOldOne() {
        ConnectionSettings s = startup(GITLAB_COM, null, null)
                .apply(new ConnectionRequest(SELF, "glpat-self", "sso=self", true))
                .apply(new ConnectionRequest("https://evil.example.com", null, null, null));

        assertEquals(Optional.empty(), s.token());
        assertNull(s.cookie());
        assertEquals(new SavedConnection("https://evil.example.com", null, null), s.saved());

        ConnectionSettings moved = startup(GITLAB_COM, null, null)
                .apply(new ConnectionRequest(SELF, "glpat-self", null, null))
                .apply(new ConnectionRequest("https://other.example.com", "glpat-other", null, null));
        assertEquals(Optional.of("glpat-other"), moved.token());

        ConnectionSettings same = startup(GITLAB_COM, null, null)
                .apply(new ConnectionRequest(SELF, "glpat-self", null, null))
                .apply(new ConnectionRequest(SELF + "/", null, null, null));
        assertEquals(Optional.of("glpat-self"), same.token()); // the same URL again keeps it
    }

    @Test
    void aCookieIsOnlyKeptInMemoryUnlessItIsSaved() {
        ConnectionSettings s = startup(SELF, "t", null).apply(new ConnectionRequest(null, null, "sso=2", false));

        assertEquals("sso=2", s.cookie());
        assertEquals("runtime", s.cookieSource());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void aCookieOnlyInMemoryReplacesASavedOne() {
        ConnectionSettings s = startup(SELF, "t", null)
                .apply(new ConnectionRequest(null, null, "sso=old", true))
                .apply(new ConnectionRequest(null, null, "sso=new", false));

        assertEquals("sso=new", s.cookie());
        assertEquals("runtime", s.cookieSource());
        assertNull(s.saved().cookie()); // the old one must not come back at the next start
    }

    @Test
    void renewingASavedCookieFromTheStatusBarKeepsItSaved() {
        ConnectionSettings s = startup(SELF, "t", null)
                .apply(new ConnectionRequest(null, null, "sso=old", true))
                .withCookie("sso=fresh");

        assertEquals("sso=fresh", s.cookie());
        assertEquals("saved", s.cookieSource());
        assertEquals("sso=fresh", s.saved().cookie());
    }

    @Test
    void theStatusBarAloneStaysInMemoryAsBefore() {
        ConnectionSettings s = startup(SELF, "t", "sso=startup").withCookie("sso=fresh");
        assertEquals("sso=fresh", s.cookie());
        assertEquals("runtime", s.cookieSource());
        assertTrue(s.saved().isEmpty());

        ConnectionSettings removed = s.withCookie(" ");
        assertNull(removed.cookie()); // removed until the next start, even the configured one
        assertNull(removed.cookieSource());
    }

    @Test
    void removingASavedCookieRemovesItForGood() {
        ConnectionSettings s = startup(SELF, "t", null)
                .apply(new ConnectionRequest(null, "glpat-page", "sso=1", true))
                .withCookie("");

        assertNull(s.cookie());
        assertEquals(new SavedConnection(null, "glpat-page", null), s.saved());
    }

    @Test
    void resetLeadsBackToTheStartupConfiguration() {
        ConnectionSettings s = startup(SELF, "glpat-env", "sso=1")
                .apply(new ConnectionRequest("https://other.example.com", "glpat-page", "sso=2", false))
                .reset();

        assertEquals(SELF, s.url());
        assertEquals(Optional.of("glpat-env"), s.token());
        assertEquals("sso=1", s.cookie());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void savedValuesAreUsedOnTopOfTheStartupConfiguration() {
        ConnectionSettings s = startup(SELF, "glpat-env", null).withSaved(new SavedConnection(null, null, "sso=1"));

        assertEquals(SELF, s.url());
        assertEquals(Optional.of("glpat-env"), s.token());
        assertEquals("startup", s.tokenSource());
        assertEquals("saved", s.cookieSource());
    }

    @Test
    void theStartupTokenAndCookieAreNeverSentToAnotherHost() {
        ConnectionSettings s = startup(GITLAB_COM, "glpat-gitlab-com", "sso=1")
                .withSaved(new SavedConnection(SELF + "/api/v4", null, null));

        assertEquals(SELF, s.url());
        assertEquals(Optional.empty(), s.token());
        assertNull(s.tokenSource());
        assertNull(s.cookie());

        ConnectionSettings back = s.apply(new ConnectionRequest("", null, null, null));
        assertEquals(Optional.of("glpat-gitlab-com"), back.token());
        assertEquals("sso=1", back.cookie());
    }

    @Test
    void savedValuesThatCannotBeUsedAreDropped() {
        ConnectionSettings s = startup(SELF, "glpat-env", null)
                .withSaved(new SavedConnection("ftp://x", "a\nb", "c\rd"));

        assertEquals(SELF, s.url());
        assertEquals(Optional.of("glpat-env"), s.token());
        assertNull(s.cookie());
        assertTrue(s.saved().isEmpty());
    }

    @Test
    void readsUrlsAsTheyAreCopied() {
        assertEquals(SELF, ConnectionSettings.normaliseUrl("  https://gitlab.example.com/ "));
        assertEquals(SELF, ConnectionSettings.normaliseUrl("https://gitlab.example.com/api/v4/"));
        assertEquals("http://localhost:8929/gitlab", ConnectionSettings.normaliseUrl("http://localhost:8929/gitlab"));
        for (String bad : new String[] {"", "gitlab.example.com", "ftp://gitlab.example.com", "https://", "https://x/?a=1"}) {
            ProviderException e = assertThrows(ProviderException.class, () -> ConnectionSettings.normaliseUrl(bad));
            assertEquals(400, e.status());
        }
    }

    @Test
    void refusesValuesAHeaderCannotCarry() {
        ConnectionSettings s = startup(SELF, null, null);
        assertThrows(ProviderException.class, () -> s.apply(new ConnectionRequest(null, "glpat\r\nX: 1", null, null)));
        assertThrows(ProviderException.class, () -> s.apply(new ConnectionRequest(null, null, "a=1\nb=2", true)));
        assertEquals(Optional.of("glpat-x"), s.apply(new ConnectionRequest(null, " glpat-x \n", null, null)).token());
    }

    private static ConnectionSettings startup(String url, String token, String cookie) {
        return ConnectionSettings.startup(GITLAB_COM, url == null ? GITLAB_COM : url, () -> Optional.ofNullable(token), cookie);
    }
}
