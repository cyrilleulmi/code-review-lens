package dev.codereviewlens.tls;

import dev.codereviewlens.model.Model.CertificateInfo;
import dev.codereviewlens.model.Model.CertificateProbe;
import dev.codereviewlens.model.Model.InsecureHost;
import dev.codereviewlens.model.Model.SavedTls;
import dev.codereviewlens.model.Model.TlsSettings;
import dev.codereviewlens.provider.ProviderException;
import dev.codereviewlens.store.DataStore;
import io.quarkus.logging.Log;
import io.quarkus.runtime.StartupEvent;
import jakarta.annotation.Priority;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;
import jakarta.interceptor.Interceptor;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * Which certificates the tool trusts besides the default ones of the runtime, and which hosts it connects to without
 * checking their certificate. Three sources, all of them used together:
 * <ol>
 *   <li>startup configuration: {@code scr.tls.ca-certs} (env {@code SCR_TLS_CA_CERTS}): PEM files or directories,
 *   comma separated; {@code scr.tls.insecure-hosts} (env {@code SCR_TLS_INSECURE_HOSTS}): host or host:port;</li>
 *   <li>the directory {@code <data>/certificates}: every certificate file in it (added in the UI, or put there by hand -
 *   read at start and whenever the UI changes something);</li>
 *   <li>{@code <data>/tls.json}: hosts without check switched on in the UI.</li>
 * </ol>
 * Every change is used at once by all connections ({@link Tls}), no restart needed.
 */
@ApplicationScoped
public class CertificateService {

    static final String DIRECTORY = "certificates";
    static final String FILE = "tls.json";
    private static final int TIMEOUT_MS = 10_000;

    @Inject
    DataStore store;

    @ConfigProperty(name = "scr.tls.ca-certs")
    Optional<List<String>> startupCertificates = Optional.empty();

    @ConfigProperty(name = "scr.tls.insecure-hosts")
    Optional<List<String>> startupInsecureHosts = Optional.empty();

    /** What is in use (also for the list in the UI). */
    private volatile Loaded loaded = new Loaded(List.of(), List.of(), List.of());

    private record Loaded(List<Entry> certificates, List<InsecureHost> insecureHosts, List<String> warnings) {
    }

    private record Entry(X509Certificate certificate, String source, Path file) {
    }

    /** After DataStore.onStart (APPLICATION + 500), before the connections are checked (APPLICATION + 600). */
    void onStart(@Observes @Priority(Interceptor.Priority.APPLICATION + 550) StartupEvent ev) {
        reload();
        TlsSettings s = settings();
        if (!s.certificates().isEmpty() || !s.insecureHosts().isEmpty()) {
            Log.infof("TLS: %d extra trusted certificate(s), %d host(s) without certificate check",
                    s.certificates().size(), s.insecureHosts().size());
        }
        s.warnings().forEach(w -> Log.warnf("TLS: %s", w));
    }

    // ------------------------------------------------------------------ reading

    /** Reads all sources again and hands the result to {@link Tls}. */
    public synchronized TlsSettings reload() {
        List<String> warnings = new ArrayList<>();
        Map<String, Entry> certs = new LinkedHashMap<>();
        for (String raw : startupCertificates.orElse(List.of())) {
            if (raw == null || raw.isBlank()) {
                continue;
            }
            Path path = Path.of(raw.strip());
            if (!Files.exists(path)) {
                warnings.add("Zertifikat der Startkonfiguration nicht gefunden: " + path);
                continue;
            }
            readAll(path, "startup", certs, warnings);
        }
        Path dir = directory();
        if (Files.isDirectory(dir)) {
            readAll(dir, "saved", certs, warnings);
        }
        Map<String, InsecureHost> insecure = new LinkedHashMap<>();
        for (String raw : startupInsecureHosts.orElse(List.of())) {
            try {
                if (raw != null && !raw.isBlank()) {
                    String key = hostKey(raw, null);
                    insecure.putIfAbsent(key, new InsecureHost(key, "startup"));
                }
            } catch (ProviderException e) {
                warnings.add("scr.tls.insecure-hosts: " + e.getMessage());
            }
        }
        for (String key : savedInsecureHosts()) {
            insecure.putIfAbsent(key, new InsecureHost(key, "saved"));
        }
        loaded = new Loaded(List.copyOf(certs.values()), List.copyOf(insecure.values()), List.copyOf(warnings));
        Tls.use(certs.values().stream().map(Entry::certificate).toList(), insecure.keySet());
        return settings();
    }

    /** A file, or every certificate file of a directory (not recursive), in name order. */
    private static void readAll(Path path, String source, Map<String, Entry> into, List<String> warnings) {
        List<Path> files;
        if (Files.isDirectory(path)) {
            try (Stream<Path> s = Files.list(path)) {
                files = s.filter(Files::isRegularFile).filter(CertificateService::certificateFile).sorted().toList();
            } catch (IOException e) {
                warnings.add("Verzeichnis nicht lesbar: " + path + " (" + e.getMessage() + ")");
                return;
            }
        } else {
            files = List.of(path);
        }
        for (Path f : files) {
            try {
                for (X509Certificate c : Certificates.parse(Files.readAllBytes(f))) {
                    into.putIfAbsent(Certificates.fingerprint(c), new Entry(c, source, f.toAbsolutePath()));
                }
            } catch (IOException | ProviderException e) {
                warnings.add("Zertifikat nicht lesbar: " + f + " (" + e.getMessage() + ")");
            }
        }
    }

    private static boolean certificateFile(Path p) {
        String name = p.getFileName().toString().toLowerCase(Locale.ROOT);
        return name.endsWith(".pem") || name.endsWith(".crt") || name.endsWith(".cer") || name.endsWith(".der");
    }

    public TlsSettings settings() {
        Loaded l = loaded;
        List<CertificateInfo> certs = l.certificates().stream()
                .map(e -> Certificates.info(e.certificate(), e.source(), e.file().toString())).toList();
        return new TlsSettings(certs, l.insecureHosts(), l.warnings(), directory().toString());
    }

    // ------------------------------------------------------------------ changes from the UI

    /** Saves the certificates of a PEM text in {@code <data>/certificates} and trusts them at once. */
    public synchronized TlsSettings add(String pem) {
        List<X509Certificate> certs = Certificates.parse(pem);
        certs.forEach(this::save);
        return reload();
    }

    /** Looks at the chain of the host and trusts the certificate of it with that fingerprint. */
    public synchronized TlsSettings trust(String host, Integer port, String fingerprint) {
        String wanted = Certificates.normaliseFingerprint(fingerprint);
        String key = hostKey(host, port);
        List<X509Certificate> chain = chain(key);
        X509Certificate c = chain.stream().filter(x -> Certificates.fingerprint(x).equals(wanted)).findFirst()
                .orElseThrow(() -> new ProviderException(409, "Das Zertifikat " + wanted + " ist nicht (mehr) in der "
                        + "Kette von " + key + ". Schau es dir nochmals an."));
        save(c);
        return reload();
    }

    /**
     * Removes a certificate saved in {@code <data>/certificates}: its file is deleted (with all certificates in it).
     * Those of the startup configuration cannot be removed here.
     */
    public synchronized TlsSettings remove(String fingerprint) {
        String wanted = Certificates.normaliseFingerprint(fingerprint);
        Entry e = loaded.certificates().stream().filter(x -> Certificates.fingerprint(x.certificate()).equals(wanted))
                .findFirst().orElseThrow(() -> new ProviderException(404, "Kein Zertifikat " + wanted));
        if (!"saved".equals(e.source())) {
            throw new ProviderException(409, "Das Zertifikat kommt aus der Startkonfiguration (scr.tls.ca-certs) und "
                    + "lässt sich nur dort entfernen.");
        }
        try {
            Files.deleteIfExists(e.file());
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
        return reload();
    }

    /** Switches the certificate check of a host off (insecure) or on again; saved in tls.json. */
    public synchronized TlsSettings insecure(String host, Integer port, boolean insecure) {
        String key = hostKey(host, port);
        Set<String> saved = new TreeSet<>(savedInsecureHosts());
        if (insecure) {
            saved.add(key);
        } else {
            saved.remove(key);
            if (loaded.insecureHosts().stream().anyMatch(h -> h.host().equals(key) && "startup".equals(h.source()))) {
                throw new ProviderException(409, "Für " + key + " ist die Prüfung in der Startkonfiguration "
                        + "(scr.tls.insecure-hosts) ausgeschaltet und lässt sich nur dort wieder einschalten.");
            }
        }
        Path file = store.root().resolve(FILE);
        if (saved.isEmpty()) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        } else {
            store.write(file, new SavedTls(List.copyOf(saved)));
        }
        return reload();
    }

    private List<String> savedInsecureHosts() {
        List<String> result = new ArrayList<>();
        List<String> raw = store.read(store.root().resolve(FILE), SavedTls.class).map(SavedTls::insecureHosts).orElse(null);
        for (String h : raw == null ? List.<String>of() : raw) {
            try {
                result.add(hostKey(h, null));
            } catch (ProviderException e) {
                Log.warnf("Ignoring %s in %s: %s", h, FILE, e.getMessage());
            }
        }
        return result;
    }

    private void save(X509Certificate c) {
        String fp = Certificates.fingerprint(c);
        if (loaded.certificates().stream().anyMatch(e -> Certificates.fingerprint(e.certificate()).equals(fp))) {
            return; // trusted already
        }
        String name = Certificates.commonName(c).replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
        name = (name.isEmpty() ? "certificate" : name.substring(0, Math.min(name.length(), 60)))
                + "-" + fp.replace(":", "").substring(0, 12).toLowerCase(Locale.ROOT) + ".pem";
        store.writeText(directory().resolve(name), Certificates.pem(c));
        Log.infof("TLS: trusting %s (SHA-256 %s), saved in %s", c.getSubjectX500Principal().getName(), fp, directory());
    }

    private Path directory() {
        return store.root().resolve(DIRECTORY);
    }

    // ------------------------------------------------------------------ looking at a host

    /** The chain a host presents, whether the tool trusts it now and if not why. */
    public CertificateProbe probe(String host, Integer port) {
        String key = hostKey(host, port);
        String h = key.substring(0, key.lastIndexOf(':'));
        int p = Integer.parseInt(key.substring(key.lastIndexOf(':') + 1));
        List<CertificateInfo> chain = chain(key).stream().map(c -> Certificates.info(c, null, null)).toList();
        String problem = null;
        try {
            handshake(Tls.verifiedContext(), h, p, true);
        } catch (IOException e) {
            problem = Tls.problem(e).orElse(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
        return new CertificateProbe(h, p, problem == null, Tls.insecure(key), problem, chain);
    }

    /** The certificates the host presents (server first), read without checking them. */
    private static List<X509Certificate> chain(String key) {
        String h = key.substring(0, key.lastIndexOf(':'));
        int p = Integer.parseInt(key.substring(key.lastIndexOf(':') + 1));
        try {
            Certificate[] certs = handshake(Tls.unverifiedContext(), h, p, false);
            return Arrays.stream(certs).filter(X509Certificate.class::isInstance).map(X509Certificate.class::cast).toList();
        } catch (IOException e) {
            throw new ProviderException(502, key + " nicht erreichbar: "
                    + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
        }
    }

    /** A TLS handshake with the host; verify: also the host name, like the HTTP client does. */
    private static Certificate[] handshake(SSLContext ctx, String host, int port, boolean verify) throws IOException {
        try (SSLSocket socket = (SSLSocket) ctx.getSocketFactory().createSocket()) {
            socket.connect(new InetSocketAddress(host.replaceAll("^\\[|]$", ""), port), TIMEOUT_MS);
            socket.setSoTimeout(TIMEOUT_MS);
            SSLParameters params = socket.getSSLParameters();
            if (!host.matches("[0-9.]+|.*:.*")) {
                params.setServerNames(List.of(new SNIHostName(host)));
            }
            if (verify) {
                params.setEndpointIdentificationAlgorithm("HTTPS");
            }
            socket.setSSLParameters(params);
            socket.startHandshake();
            return socket.getSession().getPeerCertificates();
        }
    }

    /**
     * host:port from what the user gives: a URL (https://gitlab.example.com/group/repo), host:port or a bare host
     * (port from the argument, else 443).
     */
    static String hostKey(String raw, Integer port) {
        String value = raw == null ? "" : raw.strip();
        if (value.isEmpty()) {
            throw new ProviderException(400, "Der Host fehlt");
        }
        try {
            URI uri = URI.create(value.contains("://") ? value : "https://" + value);
            if (uri.getHost() == null || (uri.getPort() > 0 && port != null && uri.getPort() != port)) {
                throw new IllegalArgumentException();
            }
            int p = port != null ? port : uri.getPort() > 0 ? uri.getPort() : Tls.port(uri);
            if (p <= 0 || p > 65535) {
                throw new IllegalArgumentException();
            }
            return Tls.hostKey(uri.getHost(), p);
        } catch (IllegalArgumentException e) {
            throw new ProviderException(400, "Ungültiger Host: «" + value + "». Erwartet wird z. B. gitlab.example.com "
                    + "oder gitlab.example.com:8443");
        }
    }
}
