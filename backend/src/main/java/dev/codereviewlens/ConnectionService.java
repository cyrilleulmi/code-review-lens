package dev.codereviewlens;

import dev.codereviewlens.model.Model.Connection;
import dev.codereviewlens.model.Model.NewConnection;
import dev.codereviewlens.model.Model.ConnectionRequest;
import dev.codereviewlens.model.Model.SavedConnection;
import dev.codereviewlens.model.Model.SavedConnections;
import dev.codereviewlens.model.Model.User;
import dev.codereviewlens.provider.ConnectionIds;
import dev.codereviewlens.provider.ConnectionSettings;
import dev.codereviewlens.provider.HostProvider;
import dev.codereviewlens.provider.ProviderException;
import dev.codereviewlens.provider.ReviewProvider;
import dev.codereviewlens.store.DataStore;
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
 * Connections to the code hosts as the UI sets them. The startup configuration (scr.gitlab.*, scr.github.*,
 * environment, CLI) stays the base of the connections "github" and "gitlab"; what the UI saves goes to
 * {@code <data>/connections.json} and overrides it field by field. Further connections to other hosts (id kind~host)
 * are added in the UI and live only in that file. The file is read once at start (after the data directory exists)
 * and written on every change; it holds secrets, which the API never returns.
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
        if (saved == null) {
            return;
        }
        for (ReviewProvider p : service.providers()) {
            SavedConnection s = saved.get(p.id());
            if (s != null && !s.isEmpty()) {
                p.loadConnection(s);
                Log.infof("%s: using the connection saved in %s", p.label(), file());
            }
        }
        for (Map.Entry<String, SavedConnection> e : saved.entrySet()) {
            String id = e.getKey();
            SavedConnection s = e.getValue();
            if (!id.contains("~") || s == null || s.url() == null) {
                continue;
            }
            try {
                HostProvider p = template(ConnectionIds.kind(id)).added(s.url());
                p.loadConnection(s);
                service.addProvider(p);
                Log.infof("%s: using the connection to %s saved in %s", p.label(), p.host(), file());
            } catch (ProviderException ex) {
                Log.warnf("Ignoring the connection %s in %s: %s", id, file(), ex.getMessage());
            }
        }
    }

    /** Adds a connection to another host; it is used at once and saved. */
    public List<Connection> add(NewConnection request) {
        HostProvider p = newConnection(request);
        service.addProvider(p);
        persist();
        return connections();
    }

    /** Signs in with the values of a connection still to be added, without adding it. */
    public User testNew(NewConnection request) {
        return newConnection(request).currentUser();
    }

    /** A connection to a host that has none yet, configured from the request but not used yet. */
    private HostProvider newConnection(NewConnection request) {
        if (request == null || request.url() == null || request.url().isBlank()) {
            throw new ProviderException(400, "Die Adresse des Hosts fehlt");
        }
        HostProvider p = template(ConnectionIds.requireKind(request.kind())).added(request.url());
        for (ReviewProvider other : service.providers()) {
            if (ConnectionIds.kind(other.id()).equals(p.kind()) && sameHost(other.host(), p.host())) {
                throw new ProviderException(409, "Mit " + p.host() + " gibt es schon eine Verbindung. Ändere dort Token "
                        + "oder Cookie.");
            }
        }
        p.configure(new ConnectionRequest(null, request.token(), request.cookie(), request.saveCookie()));
        return p;
    }

    /** Drops an added connection, or brings the one of the startup configuration back to it. */
    public List<Connection> remove(String provider) {
        ReviewProvider p = service.provider(provider);
        if (p instanceof HostProvider h && h.added()) {
            service.removeProvider(provider);
        } else {
            p.resetConnection();
        }
        persist();
        return connections();
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

    /** The connection of the startup configuration of a kind: added connections are built like it. */
    private HostProvider template(String kind) {
        if (service.provider(kind) instanceof HostProvider h) {
            return h;
        }
        throw new ProviderException(400, "Zu " + kind + " lassen sich keine weiteren Verbindungen hinzufügen");
    }

    private static boolean sameHost(String a, String b) {
        try {
            return ConnectionIds.of("x", ConnectionSettings.normaliseUrl(a)).equals(ConnectionIds.of("x", b));
        } catch (ProviderException e) {
            return false;
        }
    }

    private Path file() {
        return store.root().resolve(FILE);
    }
}
