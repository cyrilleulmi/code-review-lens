package dev.codereviewlens.gitlab;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Optional;

/** Builds a GitLab provider outside CDI for tests of other packages, configured like at start. */
public final class GitLabProviders {

    private GitLabProviders() {
    }

    /** url, token, cookie: the startup configuration (scr.gitlab.*); null for not configured. */
    public static GitLabProvider create(ObjectMapper mapper, String url, String token, String cookie) {
        GitLabProvider p = new GitLabProvider();
        p.mapper = mapper;
        p.baseUrl = url == null ? "https://gitlab.com" : url;
        p.configuredToken = Optional.ofNullable(token);
        p.configuredCookie = Optional.ofNullable(cookie);
        p.init();
        return p;
    }
}
