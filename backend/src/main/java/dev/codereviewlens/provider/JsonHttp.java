package dev.codereviewlens.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import dev.codereviewlens.tls.CertificateProblem;
import dev.codereviewlens.tls.Tls;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Optional;

/** Small JSON-over-HTTP helper shared by the providers (java.net.http + Jackson trees: native friendly). */
public final class JsonHttp {

    private final ObjectMapper mapper;
    private final String host;

    /** host: name used in error messages, e.g. "GitHub". */
    public JsonHttp(ObjectMapper mapper, String host) {
        this.mapper = mapper;
        this.host = host;
    }

    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
        try {
            // the client with the TLS trust in use (extra certificates, hosts without check: changeable while running)
            return Tls.client(request.uri()).send(request, handler);
        } catch (IOException e) {
            Optional<String> certificate = Tls.problem(e);
            if (certificate.isPresent()) {
                URI uri = request.uri();
                throw new CertificateProblem(uri.getHost(), Tls.port(uri), certificate.get());
            }
            // e.g. a ConnectException has no text: name the exception instead of "null"
            throw new ProviderException(502, host + " nicht erreichbar: "
                    + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ProviderException(503, "Abgebrochen");
        }
    }

    public JsonNode json(HttpRequest request, String what) {
        HttpResponse<String> res = send(request, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() < 400 && isHtml(res.body())) {
            // an SSO proxy in front of the host answers 200 (or a redirect) with its login page
            throw new ProviderException(401, "Ungültige Antwort von " + host + ": HTML statt JSON. "
                    + "Login-Seite eines SSO-Proxys? Ist das Cookie abgelaufen?");
        }
        if (res.statusCode() >= 300) {
            String message = res.body();
            try {
                JsonNode err = mapper.readTree(res.body());
                JsonNode m = err.has("message") ? err.get("message") : err.path("error");
                message = m.isMissingNode() ? message : m.isTextual() ? m.asText() : m.toString();
            } catch (IOException ignored) {
                // keep the raw body
            }
            throw new ProviderException(res.statusCode() == 401 ? 401 : res.statusCode(),
                    host + " " + res.statusCode() + " auf " + what + ": " + message);
        }
        try {
            return mapper.readTree(res.body());
        } catch (IOException e) {
            throw new ProviderException(502, "Ungültige Antwort von " + host + ": " + e.getMessage());
        }
    }

    /** True for a web page where JSON is expected (JSON never starts with "<"). */
    static boolean isHtml(String body) {
        return body != null && body.stripLeading().startsWith("<");
    }

    public HttpRequest.BodyPublisher body(JsonNode node) {
        return HttpRequest.BodyPublishers.ofString(node.toString());
    }

    public ObjectMapper mapper() {
        return mapper;
    }
}
