package dev.codereviewlens.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonHttpTest {

    private final JsonHttp http = new JsonHttp(new ObjectMapper(), "GitLab");
    private HttpServer server;
    private int status = 200;
    private String body = "{}";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            try (exchange) {
                exchange.getResponseBody().write(bytes);
            }
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void readsJson() {
        body = "{\"username\":\"anna\"}";

        assertEquals("anna", http.json(get(), "/user").path("username").asText());
    }

    @Test
    void reportsTheLoginPageOfAnSsoProxyInsteadOfAParseError() {
        body = "\n<!DOCTYPE html><html><body>Sign in</body></html>";

        ProviderException e = assertThrows(ProviderException.class, () -> http.json(get(), "/user"));

        assertEquals(401, e.status());
        assertEquals("Ungültige Antwort von GitLab: HTML statt JSON. Login-Seite eines SSO-Proxys? Ist das Cookie abgelaufen?",
                e.getMessage());
    }

    @Test
    void keepsTheStatusOfAnErrorPage() {
        status = 502;
        body = "<html><body>Bad Gateway</body></html>";

        ProviderException e = assertThrows(ProviderException.class, () -> http.json(get(), "/user"));

        assertEquals(502, e.status());
        assertTrue(e.getMessage().startsWith("GitLab 502 auf /user"), e.getMessage());
    }

    @Test
    void namesTheExceptionWhenTheHostCannotBeReached() {
        server.stop(0); // nothing listens on the port any more

        ProviderException e = assertThrows(ProviderException.class, () -> http.json(get(), "/user"));

        assertEquals(502, e.status());
        assertTrue(e.getMessage().startsWith("GitLab nicht erreichbar: "), e.getMessage());
        assertFalse(e.getMessage().endsWith("null"), e.getMessage());
    }

    private HttpRequest get() {
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/user")).GET().build();
    }
}
