package dev.smartcodereview.tls;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import dev.smartcodereview.model.Model.CertificateProbe;
import dev.smartcodereview.model.Model.TlsSettings;
import dev.smartcodereview.provider.JsonHttp;
import dev.smartcodereview.provider.ProviderException;
import dev.smartcodereview.store.DataStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A GitLab behind a certificate of a company CA (here: self-signed): refused with the host named, trusted from the UI
 * (its chain, a pasted PEM), from the startup configuration, or without check - each at once, without a restart.
 */
class CertificateServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final char[] PASSWORD = "changeit".toCharArray();

    /** for 127.0.0.1 and localhost */
    private static Path keystore;
    /** for another name only: the host name does not match */
    private static Path otherNameKeystore;

    private Path dir;
    private HttpsServer server;
    private X509Certificate serverCertificate;

    @BeforeAll
    static void keys() throws Exception {
        Path tmp = Files.createTempDirectory("scr-tls-keys");
        keystore = keytool(tmp.resolve("server.p12"), "CN=gitlab.firma.test, O=Firma", "ip:127.0.0.1,dns:localhost");
        otherNameKeystore = keytool(tmp.resolve("other.p12"), "CN=other.firma.test", "dns:other.firma.test");
    }

    private static Path keytool(Path file, String dname, String san) throws Exception {
        Path keytool = Path.of(System.getProperty("java.home"), "bin", "keytool");
        Process p = new ProcessBuilder(keytool.toString(), "-genkeypair", "-alias", "server", "-keyalg", "EC",
                "-groupname", "secp256r1", "-validity", "30", "-dname", dname, "-ext", "san=" + san,
                "-keystore", file.toString(), "-storetype", "PKCS12", "-storepass", new String(PASSWORD))
                .redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), out);
        return file;
    }

    @BeforeEach
    void setUp() throws Exception {
        dir = Files.createTempDirectory("scr-tls");
        start(keystore);
    }

    private void start(Path keys) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(keys)) {
            ks.load(in, PASSWORD);
        }
        serverCertificate = (X509Certificate) ks.getCertificate("server");
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, PASSWORD);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), null, null);
        server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(ctx));
        server.createContext("/", exchange -> {
            byte[] bytes = "{\"username\":\"anna\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            try (exchange) {
                exchange.getResponseBody().write(bytes);
            }
        });
        server.start();
    }

    @AfterEach
    void tearDown() throws IOException {
        server.stop(0);
        Tls.use(List.of(), Set.of());
        try (Stream<Path> files = Files.walk(dir)) {
            for (Path p : files.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        }
    }

    @Test
    void refusesAnUnknownCertificateAndNamesTheHost() {
        service(null, null).reload();

        CertificateProblem e = assertThrows(CertificateProblem.class, this::get);

        assertEquals("127.0.0.1", e.host());
        assertEquals(port(), e.port());
        assertEquals(502, e.status());
        assertEquals("Zertifikat von 127.0.0.1:" + port() + " wird nicht vertraut: Es ist von einer unbekannten "
                + "Zertifizierungsstelle ausgestellt (z. B. einer Firmen-CA) oder selbst signiert.", e.getMessage());
    }

    @Test
    void trustsACertificateOfTheChainAtOnceAndAfterARestart() {
        CertificateService service = service(null, null);
        service.reload();

        CertificateProbe probe = service.probe("https://127.0.0.1:" + port() + "/group/repo/-/merge_requests/1", null);
        assertFalse(probe.trusted());
        assertEquals(1, probe.chain().size());
        assertTrue(probe.chain().get(0).selfSigned());
        assertTrue(probe.problem().contains("unbekannten Zertifizierungsstelle"), probe.problem());

        TlsSettings settings = service.trust("127.0.0.1", port(), probe.chain().get(0).fingerprint().toLowerCase());

        assertEquals("anna", get());
        assertEquals(1, settings.certificates().size());
        assertEquals("saved", settings.certificates().get(0).source());
        assertTrue(Files.isRegularFile(Path.of(settings.certificates().get(0).file())));
        assertTrue(service.probe("127.0.0.1", port()).trusted());

        Tls.use(List.of(), Set.of()); // as after a restart
        assertThrows(CertificateProblem.class, this::get);
        service(null, null).reload();
        assertEquals("anna", get());
    }

    @Test
    void removesASavedCertificate() {
        CertificateService service = service(null, null);
        service.reload();
        service.add(Certificates.pem(serverCertificate));
        assertEquals("anna", get());

        TlsSettings settings = service.remove(Certificates.fingerprint(serverCertificate));

        assertTrue(settings.certificates().isEmpty());
        assertThrows(CertificateProblem.class, this::get);
    }

    @Test
    void trustsTheCertificatesOfTheStartupConfiguration() throws IOException {
        Path pem = dir.resolve("firma-ca.pem");
        Files.writeString(pem, "Firma CA\n" + Certificates.pem(serverCertificate));
        CertificateService service = service(List.of(pem.toString(), dir.resolve("missing.pem").toString()), null);

        TlsSettings settings = service.reload();

        assertEquals("anna", get());
        assertEquals("startup", settings.certificates().get(0).source());
        assertEquals(List.of("Zertifikat der Startkonfiguration nicht gefunden: " + dir.resolve("missing.pem")), settings.warnings());
        ProviderException e = assertThrows(ProviderException.class, () -> service.remove(Certificates.fingerprint(serverCertificate)));
        assertEquals(409, e.status());
    }

    @Test
    void connectsWithoutCheckToAnInsecureHostUntilTheCheckIsOnAgain() throws IOException {
        CertificateService service = service(null, null);
        service.reload();

        TlsSettings settings = service.insecure("127.0.0.1", port(), true);

        assertEquals("anna", get());
        assertEquals("127.0.0.1:" + port(), settings.insecureHosts().get(0).host());
        assertTrue(Files.readString(dir.resolve("tls.json")).contains("127.0.0.1:" + port()));
        assertTrue(service.probe("127.0.0.1", port()).insecure());

        service.insecure("127.0.0.1", port(), false);

        assertThrows(CertificateProblem.class, this::get);
        assertFalse(Files.exists(dir.resolve("tls.json")));
    }

    @Test
    void insecureHostsOfTheStartupConfigurationStaySwitchedOff() {
        CertificateService service = service(null, List.of("127.0.0.1:" + port()));
        service.reload();

        assertEquals("anna", get());
        assertEquals(409, assertThrows(ProviderException.class, () -> service.insecure("127.0.0.1", port(), false)).status());
    }

    @Test
    void namesACertificateForAnotherHost() throws Exception {
        server.stop(0);
        start(otherNameKeystore);
        CertificateService service = service(null, null);
        service.reload();
        service.add(Certificates.pem(serverCertificate));

        CertificateProblem e = assertThrows(CertificateProblem.class, this::get);

        assertTrue(e.getMessage().endsWith("Das Zertifikat gilt nicht für diesen Hostnamen."), e.getMessage());
        assertFalse(service.probe("127.0.0.1", port()).trusted());
    }

    @Test
    void refusesTextWithoutCertificate() {
        CertificateService service = service(null, null);
        service.reload();

        assertEquals(400, assertThrows(ProviderException.class, () -> service.add("hello")).status());
        assertEquals(400, assertThrows(ProviderException.class, () -> service.add("")).status());
    }

    @Test
    void readsHostsAsTheUserGivesThem() {
        assertEquals("gitlab.example.com:443", CertificateService.hostKey("https://GitLab.example.com/group/repo", null));
        assertEquals("gitlab.example.com:8443", CertificateService.hostKey("gitlab.example.com:8443", null));
        assertEquals("gitlab.example.com:8443", CertificateService.hostKey("gitlab.example.com", 8443));
        assertEquals(400, assertThrows(ProviderException.class, () -> CertificateService.hostKey(" ", null)).status());
        assertEquals(400, assertThrows(ProviderException.class, () -> CertificateService.hostKey("a b", null)).status());
    }

    private String get() {
        JsonHttp http = new JsonHttp(MAPPER, "GitLab");
        return http.json(HttpRequest.newBuilder(URI.create("https://127.0.0.1:" + port() + "/api/v4/user")).build(), "/user")
                .path("username").asText();
    }

    private int port() {
        return server.getAddress().getPort();
    }

    private CertificateService service(List<String> startupCertificates, List<String> startupInsecure) {
        CertificateService s = new CertificateService();
        s.startupCertificates = Optional.ofNullable(startupCertificates);
        s.startupInsecureHosts = Optional.ofNullable(startupInsecure);
        s.store = new DataStore() {
            @Override
            public Path root() {
                return dir;
            }

            @Override
            public <T> Optional<T> read(Path file, Class<T> type) {
                try {
                    return Files.isRegularFile(file) ? Optional.of(MAPPER.readValue(file.toFile(), type)) : Optional.empty();
                } catch (IOException e) {
                    return Optional.empty();
                }
            }

            @Override
            public void write(Path file, Object value) {
                try {
                    Files.createDirectories(file.getParent());
                    MAPPER.writeValue(file.toFile(), value);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            }
        };
        return s;
    }
}
