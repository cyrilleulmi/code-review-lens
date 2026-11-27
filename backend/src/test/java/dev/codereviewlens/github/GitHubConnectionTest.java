package dev.codereviewlens.github;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.model.Model.PrRef;
import dev.codereviewlens.provider.HostProvider;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** GitHub Enterprise Server: the host of the startup configuration and further ones added in the UI. */
class GitHubConnectionTest {

    @Test
    void gitHubEnterpriseUrlsBelongToTheConnectionOfTheirHost() {
        GitHubProvider ghe = new GitHubProvider();
        ghe.mapper = new ObjectMapper();
        ghe.apiUrl = "https://GHE.example.com/api/v3/";
        ghe.init();
        assertEquals("https://GHE.example.com", ghe.host());
        assertEquals(Optional.of(new PrRef("github", "team", "app", 5)),
                ghe.parseUrl("https://ghe.example.com/team/app/pull/5/files"));
        assertTrue(ghe.parseUrl("https://github.com/team/app/pull/5").isEmpty());

        HostProvider added = ghe.added("https://ghe2.example.com:8443");
        assertEquals("github~ghe2.example.com_8443", added.id());
        assertEquals(Optional.of(new PrRef("github~ghe2.example.com_8443", "team", "app", 0)),
                added.parseUrl("https://ghe2.example.com:8443/team/app"));
    }

    @Test
    void theWebUrlOfTheStartupConfigurationFollowsItsApiUrl() {
        assertEquals("https://github.com", GitHubProvider.webUrl(null));
        assertEquals("https://github.com", GitHubProvider.webUrl("https://api.github.com/"));
        assertEquals("https://ghe.example.com", GitHubProvider.webUrl("https://ghe.example.com/api/v3"));
    }
}
