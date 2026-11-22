package dev.smartcodereview;

import dev.smartcodereview.model.Model.Connection;
import dev.smartcodereview.model.Model.ConnectionRequest;
import dev.smartcodereview.model.Model.SavedConnection;
import dev.smartcodereview.model.Model.SavedConnections;
import dev.smartcodereview.model.Model.User;
import dev.smartcodereview.provider.ProviderException;
import dev.smartcodereview.provider.ReviewProvider;
import dev.smartcodereview.store.DataStore;
import io.quarkus.logging.Log;
import io.quarkus.runtime.StartupEvent;
import jakarta.annotation.Priority;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;
import jakarta.interceptor.Interceptor;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Connections to the code hosts as the config page sets them. The startup configuration (scr.gitlab.*, environment,
 * CLI) stays the base; what the config page saves goes to {@code <data>/connections.json} and overrides it field by
 * field. The file is read once at start (after the data directory exists) and written on every change; it holds
 * secrets, which the API never returns.
 */
@ApplicationScoped
public class ConnectionService {

    static final String FILE = "connections.json";

    @Inject
    ReviewService service;

    @Inject
    DataStore store;

    /** After DataStore.onStart (default priority APPLICATION + 500), which creates the data directory. */
    void onStart(@Observes @Priority(Interceptor.Priority.APPLICATION + 600) StartupEvent ev) {
        Map<String, SavedConnection> saved = store.read(file(), SavedConnections.class)
                .map(SavedConnections::connections).orElse(Map.of());
        for (ReviewProvider p : service.providers()) {
            SavedConnection s = saved == null ? null : saved.get(p.id());
            if (s != null && !s.isEmpty()) {
                p.loadConnection(s);
                Log.infof("%s: using the connection saved in %s", p.label(), file());
            }
        }
    }

    /** Every connection the config page can change, with its state. */
    public List<Connection> connections() {
        List<Connection> result = new ArrayList<>();
        for (ReviewProvider p : service.providers()) {
            p.connection(service.account(p)).ifPresent(result::add);
        }
        return result;
    }

    /** Changes a connection; it is used at once and saved for the next start. */
    public List<Connection> configure(String provider, ConnectionRequest request) {
        if (request == null) {
            throw new ProviderException(400, "Keine Angaben zur Verbindung");
        }
        ReviewProvider p = service.provider(provider);
        p.configure(request);
        persist();
        return connections();
    }

    /** Back to the startup configuration. */
    public List<Connection> reset(String provider) {
        service.provider(provider).resetConnection();
        persist();
        return connections();
    }

    /** Tries the values of the request without using or saving them. */
    public User test(String provider, ConnectionRequest request) {
        return service.provider(provider).testConnection(request == null ? new ConnectionRequest(null, null, null, null) : request);
    }

    /** Replaces the session cookies of an SSO proxy (status bar); a saved cookie stays saved. */
    public void setCookie(String provider, String cookie) {
        service.provider(provider).setCookie(cookie);
        persist();
    }

    /** Writes the saved values of all providers; no file when there are none. */
    private synchronized void persist() {
        Map<String, SavedConnection> saved = new TreeMap<>();
        for (ReviewProvider p : service.providers()) {
            SavedConnection s = p.savedConnection();
            if (s != null && !s.isEmpty()) {
                saved.put(p.id(), s);
            }
        }
        if (saved.isEmpty()) {
            try {
                Files.deleteIfExists(file());
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        } else {
            store.write(file(), new SavedConnections(saved));
        }
    }

    private Path file() {
        return store.root().resolve(FILE);
    }
}
