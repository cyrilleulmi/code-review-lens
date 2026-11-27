package dev.codereviewlens.provider;

import java.net.URI;
import java.util.Locale;

/**
 * Ids of connections. The connection of the startup configuration of a kind keeps the plain kind as id ("github",
 * "gitlab"), as before there could be several; every added connection is kind~host, with a non-default port as
 * host_port (a colon cannot be part of a directory name on Windows). The id is part of {@code PrRef.provider}, of the
 * API paths and of the data directory ({@code <data>/prs/<id>/…}).
 */
public final class ConnectionIds {

    public static final String GITHUB = "github";
    public static final String GITLAB = "gitlab";

    private ConnectionIds() {
    }

    /** The kind of host a connection id stands for: "github" or "gitlab". */
    public static String kind(String id) {
        int i = id.indexOf('~');
        return i < 0 ? id : id.substring(0, i);
    }

    /** The id of an added connection of this kind to the host of url (already normalised). */
    public static String of(String kind, String url) {
        URI u = URI.create(url);
        int port = u.getPort();
        return kind + "~" + u.getHost().toLowerCase(Locale.ROOT) + (port > 0 && port != 80 && port != 443 ? "_" + port : "");
    }

    /** A kind this tool can connect to. */
    public static String requireKind(String kind) {
        if (!GITHUB.equals(kind) && !GITLAB.equals(kind)) {
            throw new ProviderException(400, "Unbekannte Art von Verbindung: " + kind + " (erwartet: github oder gitlab)");
        }
        return kind;
    }
}
