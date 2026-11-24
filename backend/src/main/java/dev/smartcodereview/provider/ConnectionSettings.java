package dev.smartcodereview.provider;

import dev.smartcodereview.model.Model.ConnectionRequest;
import dev.smartcodereview.model.Model.SavedConnection;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * The connection values of a code host and where each one comes from. Three layers, the first one that has a value
 * wins, field by field:
 * <ol>
 *   <li>runtime (cookie only): set while running, kept in memory until the next start;</li>
 *   <li>saved: set on the config page, stored in {@code <data>/connections.json};</li>
 *   <li>startup: the startup configuration (properties, environment, CLI), as before the config page existed.</li>
 * </ol>
 * So a startup configuration keeps working unchanged, and the config page can add or override any part of it;
 * removing the saved values leads back to the startup configuration. Token and cookie belong to the URL they were
 * given for: those of the startup configuration are not sent to a URL from the config page, and a new URL drops the
 * ones saved for the old one. Immutable: every change returns a new instance.
 */
public final class ConnectionSettings {

    public static final String SAVED = "saved";
    public static final String RUNTIME = "runtime";
    public static final String STARTUP = "startup";
    public static final String DEFAULT = "default";

    private final String defaultUrl;
    private final String startupUrl;
    private final Supplier<Optional<String>> startupToken;
    private final String startupCookie;
    private final SavedConnection saved;
    /** null: no runtime value; empty: the cookie was removed while running; else the cookie set while running */
    private final Optional<String> runtimeCookie;

    /**
     * defaultUrl: the built-in URL (e.g. https://gitlab.com); startupUrl: the configured one (may equal the default);
     * startupToken: resolved lazily (may call a CLI); startupCookie: raw, as configured (may be blank).
     */
    public static ConnectionSettings startup(String defaultUrl, String startupUrl, Supplier<Optional<String>> startupToken,
                                             String startupCookie) {
        String cookie;
        try {
            cookie = cookieValue(startupCookie);
        } catch (ProviderException e) {
            cookie = null; // reported by the provider at start; a broken cookie must not keep the tool from starting
        }
        return new ConnectionSettings(normaliseUrl(defaultUrl), normaliseUrl(startupUrl), startupToken, cookie,
                SavedConnection.NONE, null);
    }

    private ConnectionSettings(String defaultUrl, String startupUrl, Supplier<Optional<String>> startupToken,
                               String startupCookie, SavedConnection saved, Optional<String> runtimeCookie) {
        this.defaultUrl = defaultUrl;
        this.startupUrl = startupUrl;
        this.startupToken = startupToken;
        this.startupCookie = startupCookie;
        this.saved = saved == null ? SavedConnection.NONE : saved;
        this.runtimeCookie = runtimeCookie;
    }

    // ------------------------------------------------------------------ effective values

    public String url() {
        return saved.url() != null ? saved.url() : startupUrl;
    }

    public String urlSource() {
        return saved.url() != null ? SAVED : startupUrl.equals(defaultUrl) ? DEFAULT : STARTUP;
    }

    public String startupUrl() {
        return startupUrl;
    }

    public Optional<String> token() {
        return saved.token() != null ? Optional.of(saved.token()) : startupHost() ? startupToken.get() : Optional.empty();
    }

    public String tokenSource() {
        return saved.token() != null ? SAVED : startupHost() && startupToken.get().isPresent() ? STARTUP : null;
    }

    /** The value of the Cookie header, null for none. */
    public String cookie() {
        if (runtimeCookie != null) {
            return runtimeCookie.orElse(null);
        }
        return saved.cookie() != null ? saved.cookie() : startupHost() ? startupCookie : null;
    }

    public String cookieSource() {
        if (runtimeCookie != null) {
            return runtimeCookie.isPresent() ? RUNTIME : null;
        }
        return saved.cookie() != null ? SAVED : startupHost() && startupCookie != null ? STARTUP : null;
    }

    /** True while the URL of the startup configuration is in use: only then its token and cookie are sent. */
    private boolean startupHost() {
        return saved.url() == null;
    }

    /** What goes into connections.json (NONE: nothing, the entry is removed). */
    public SavedConnection saved() {
        return saved;
    }

    // ------------------------------------------------------------------ changes

    /** Uses values read from connections.json (e.g. at start). Values that cannot be used are dropped. */
    public ConnectionSettings withSaved(SavedConnection s) {
        if (s == null) {
            return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie, SavedConnection.NONE, null);
        }
        String url = null, token = null, cookie = null;
        try {
            url = s.url() == null || s.url().isBlank() ? null : normaliseUrl(s.url());
        } catch (ProviderException ignored) {
            // keep the startup URL
        }
        try {
            token = headerValue(s.token(), "Das Token");
        } catch (ProviderException ignored) {
            // keep the startup token
        }
        try {
            cookie = cookieValue(s.cookie());
        } catch (ProviderException ignored) {
            // keep the startup cookie
        }
        return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie,
                new SavedConnection(url, token, cookie), null);
    }

    /**
     * A change from the config page. Per field: null keeps it, "" goes back to the startup configuration, else the new
     * value. A new cookie is saved with saveCookie, else it is only kept in memory (and a saved one is dropped, so that
     * it does not come back at the next start). A new URL drops the token and cookie set for the old one, unless the
     * request brings new ones: they belong to their host.
     */
    public ConnectionSettings apply(ConnectionRequest r) {
        String url = saved.url(), token = saved.token(), cookie = saved.cookie();
        Optional<String> runtime = runtimeCookie;
        if (r.url() != null) {
            url = r.url().isBlank() ? null : normaliseUrl(r.url());
            if (startupUrl.equals(url)) {
                url = null; // the same as the startup configuration: follow it
            }
            if (!(url == null ? startupUrl : url).equals(url())) {
                // another host: token and cookie set for the old one must not go there
                token = null;
                cookie = null;
                runtime = null;
            }
        }
        if (r.token() != null) {
            token = headerValue(r.token(), "Das Token");
        }
        if (r.cookie() != null) {
            String value = cookieValue(r.cookie());
            runtime = null;
            if (value == null) {
                cookie = null;
            } else if (Boolean.TRUE.equals(r.saveCookie())) {
                cookie = value;
            } else {
                cookie = null;
                runtime = Optional.of(value);
            }
        }
        return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie,
                new SavedConnection(url, token, cookie), runtime);
    }

    /**
     * A cookie set while running (status bar). Renewing a saved cookie keeps it saved; any other cookie stays in memory.
     * Blank removes the cookie until the next start, and a saved one for good.
     */
    public ConnectionSettings withCookie(String raw) {
        String value = cookieValue(raw);
        if (value != null && saved.cookie() != null) {
            return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie,
                    new SavedConnection(saved.url(), saved.token(), value), null);
        }
        return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie,
                new SavedConnection(saved.url(), saved.token(), null), Optional.ofNullable(value));
    }

    /** Back to the startup configuration: no saved values, no cookie set while running. */
    public ConnectionSettings reset() {
        return new ConnectionSettings(defaultUrl, startupUrl, startupToken, startupCookie, SavedConnection.NONE, null);
    }

    // ------------------------------------------------------------------ values as the user gives them

    /**
     * The base URL of a web UI as the user gives it: trimmed, without trailing slashes or an API path copied along
     * (/api/v4); only http and https with a host.
     */
    public static String normaliseUrl(String raw) {
        String value = raw == null ? "" : raw.strip().replaceAll("/+$", "").replaceFirst("(?i)/api/v\\d+$", "");
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
            if ((scheme.equals("http") || scheme.equals("https")) && uri.getHost() != null
                    && uri.getRawQuery() == null && uri.getRawFragment() == null) {
                return value;
            }
        } catch (URISyntaxException e) {
            // reported below
        }
        throw new ProviderException(400, "Ungültige URL: «" + value + "». Erwartet wird z. B. https://gitlab.example.com");
    }

    /**
     * The value of a Cookie header as the user gives it: trimmed, a leading "Cookie:" (copied along from the
     * browser's developer tools) removed; null when blank. Characters a header cannot carry are refused.
     */
    public static String cookieValue(String raw) {
        String value = raw == null ? "" : raw.strip().replaceFirst("(?i)^cookie:\\s*", "");
        if (!headerSafe(value)) {
            throw new ProviderException(400, "Das Cookie enthält Zeichen, die in einem HTTP-Header nicht erlaubt sind "
                    + "(z. B. Zeilenumbrüche).");
        }
        return value.isEmpty() ? null : value;
    }

    /** A token or similar header value: trimmed, null when blank; refused when a header cannot carry it. */
    static String headerValue(String raw, String what) {
        String value = raw == null ? "" : raw.strip();
        if (!headerSafe(value)) {
            throw new ProviderException(400, what + " enthält Zeichen, die in einem HTTP-Header nicht erlaubt sind "
                    + "(z. B. Zeilenumbrüche).");
        }
        return value.isEmpty() ? null : value;
    }

    private static boolean headerSafe(String value) {
        return value.chars().allMatch(c -> c >= 0x20 && c <= 0x7e);
    }
}
