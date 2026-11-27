package dev.codereviewlens.tls;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertPathBuilderException;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * The TLS trust of every request to a code host. Two parts, both replaceable while running:
 * <ul>
 *   <li>extra certificates trusted on top of the default ones of the runtime (its cacerts, or
 *   {@code javax.net.ssl.trustStore}): e.g. the root certificate of a company CA;</li>
 *   <li>hosts (host:port) whose certificate is not checked at all - the insecure way out, switched on per host.</li>
 * </ul>
 * Static, as the HTTP clients of all connections (also those added while running) share it; {@link CertificateService}
 * fills it from the startup configuration, the data directory and the UI.
 */
public final class Tls {

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

    private static volatile State state = new State(List.of(), Set.of());

    private Tls() {
    }

    /** The HTTP client for a request to uri: with the trust in use, or without any check for an insecure host. */
    public static HttpClient client(URI uri) {
        State s = state;
        return s.insecure.contains(hostKey(uri)) ? s.unverifiedClient() : s.verifiedClient();
    }

    /** Replaces the extra certificates and the hosts without check; requests already running finish as they were. */
    public static synchronized void use(List<X509Certificate> extra, Set<String> insecureHosts) {
        State old = state;
        state = new State(List.copyOf(extra), Set.copyOf(insecureHosts));
        old.shutdown();
    }

    public static boolean insecure(String hostKey) {
        return state.insecure.contains(hostKey);
    }

    /** The SSL context with the trust in use (default certificates plus the extra ones). */
    public static SSLContext verifiedContext() {
        return state.verifiedContext();
    }

    /** An SSL context that accepts every certificate and host name: for insecure hosts and to look at a chain. */
    public static SSLContext unverifiedContext() {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{new AcceptAll()}, null);
            return ctx;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("TLS nicht verfügbar: " + e.getMessage(), e);
        }
    }

    /** host:port as the lists of hosts use it: lower case, the default port of the scheme filled in. */
    public static String hostKey(URI uri) {
        return hostKey(uri.getHost() == null ? "" : uri.getHost(), port(uri));
    }

    /** The port of uri, the default one of its scheme when it names none. */
    public static int port(URI uri) {
        return uri.getPort() > 0 ? uri.getPort() : "http".equalsIgnoreCase(uri.getScheme()) ? 80 : 443;
    }

    public static String hostKey(String host, int port) {
        return host.toLowerCase(Locale.ROOT) + ":" + port;
    }

    /**
     * Why a connection failed, when it failed on the certificate of the host (unknown CA, expired, issued for another
     * name …); empty for every other failure (host unreachable, timeout, protocol).
     */
    public static Optional<String> problem(Throwable error) {
        for (Throwable t = error; t != null; t = t.getCause()) {
            if (t instanceof CertificateExpiredException) {
                return Optional.of("Das Zertifikat ist abgelaufen.");
            }
            if (t instanceof CertificateNotYetValidException) {
                return Optional.of("Das Zertifikat ist noch nicht gültig.");
            }
        }
        for (Throwable t = error; t != null; t = t.getCause()) {
            String m = t.getMessage() == null ? "" : t.getMessage();
            if (m.contains("subject alternative") || m.contains("No name matching")) {
                return Optional.of("Das Zertifikat gilt nicht für diesen Hostnamen.");
            }
            if (t instanceof CertPathBuilderException || m.contains("PKIX path building failed")
                    || m.contains("unable to find valid certification path")) {
                return Optional.of("Es ist von einer unbekannten Zertifizierungsstelle ausgestellt (z. B. einer "
                        + "Firmen-CA) oder selbst signiert.");
            }
        }
        for (Throwable t = error; t != null; t = t.getCause()) {
            if (t instanceof CertificateException || t instanceof CertPathValidatorException) {
                return Optional.of(t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
            }
        }
        return Optional.empty();
    }

    /** Default trust of the runtime plus the extra certificates; the default alone when there are none. */
    static X509TrustManager trustManager(List<X509Certificate> extra) {
        try {
            X509TrustManager defaults = first(TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()), null);
            if (extra.isEmpty()) {
                return defaults;
            }
            KeyStore ks = KeyStore.getInstance("PKCS12");
            ks.load(null, null);
            int n = 0;
            for (X509Certificate c : defaults.getAcceptedIssuers()) {
                ks.setCertificateEntry("default-" + n++, c);
            }
            for (X509Certificate c : extra) {
                ks.setCertificateEntry("extra-" + n++, c);
            }
            return first(TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()), ks);
        } catch (GeneralSecurityException | java.io.IOException e) {
            throw new IllegalStateException("Zertifikate lassen sich nicht laden: " + e.getMessage(), e);
        }
    }

    private static X509TrustManager first(TrustManagerFactory tmf, KeyStore ks) throws GeneralSecurityException {
        tmf.init(ks);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager x) {
                return x;
            }
        }
        throw new GeneralSecurityException("Kein X509TrustManager");
    }

    private static HttpClient client(SSLContext ctx) {
        return HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .sslContext(ctx)
                .build();
    }

    /** The trust in use; its clients and contexts are built when first needed. */
    private static final class State {
        final List<X509Certificate> extra;
        final Set<String> insecure;
        private SSLContext verifiedContext;
        private HttpClient verified;
        private HttpClient unverified;

        State(List<X509Certificate> extra, Set<String> insecure) {
            this.extra = extra;
            this.insecure = insecure;
        }

        synchronized SSLContext verifiedContext() {
            if (verifiedContext == null) {
                try {
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, new TrustManager[]{trustManager(extra)}, null);
                    verifiedContext = ctx;
                } catch (GeneralSecurityException e) {
                    throw new IllegalStateException("TLS nicht verfügbar: " + e.getMessage(), e);
                }
            }
            return verifiedContext;
        }

        synchronized HttpClient verifiedClient() {
            if (verified == null) {
                verified = client(verifiedContext());
            }
            return verified;
        }

        synchronized HttpClient unverifiedClient() {
            if (unverified == null) {
                unverified = client(unverifiedContext());
            }
            return unverified;
        }

        synchronized void shutdown() {
            List<HttpClient> clients = new ArrayList<>();
            if (verified != null) {
                clients.add(verified);
            }
            if (unverified != null) {
                clients.add(unverified);
            }
            clients.forEach(HttpClient::shutdown);
        }
    }

    /**
     * Accepts every certificate and, as an X509ExtendedTrustManager, also every host name (the JDK leaves that check
     * to such a trust manager).
     */
    private static final class AcceptAll extends X509ExtendedTrustManager {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) {
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
