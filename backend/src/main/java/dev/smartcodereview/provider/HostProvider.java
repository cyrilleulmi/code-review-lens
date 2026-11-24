package dev.smartcodereview.provider;

import dev.smartcodereview.model.Model;
import dev.smartcodereview.model.Model.ConnectionRequest;
import dev.smartcodereview.model.Model.SavedConnection;
import dev.smartcodereview.model.Model.User;

import java.util.Optional;

/**
 * A code host whose connection (URL, token, cookie) can be set in the UI, and of which there can be several. The one
 * of the startup configuration has the plain kind as id; further ones are added in the UI ({@link #added}), have a
 * fixed URL (the id names their host) and nothing from the startup configuration.
 */
public abstract class HostProvider implements ReviewProvider {

    /** null: the connection of the startup configuration (id = kind) */
    private String addedId;
    /** URL, token and cookie in use; one consistent set of values per request, replaced as a whole */
    protected volatile ConnectionSettings settings;

    /** "github" or "gitlab". */
    public abstract String kind();

    /** A new instance of the same kind, not yet configured, sharing what was injected (JSON mapper). */
    protected abstract HostProvider blank();

    /** Called after the values changed: drop what was derived from the old ones (signed-in user …). */
    protected void changed() {
    }

    @Override
    public String id() {
        return addedId == null ? kind() : addedId;
    }

    @Override
    public String host() {
        return settings.url();
    }

    @Override
    public boolean hasCredentials() {
        return settings.token().isPresent();
    }

    /** Added in the UI (can be removed), rather than the connection of the startup configuration. */
    public boolean added() {
        return addedId != null;
    }

    protected synchronized void use(ConnectionSettings next) {
        settings = next;
        changed();
    }

    /** Another connection of this kind to the host at url, without token or cookie yet ({@link #configure}). */
    public HostProvider added(String url) {
        String u = ConnectionSettings.normaliseUrl(url);
        HostProvider p = blank();
        p.addedId = ConnectionIds.of(kind(), u);
        p.use(ConnectionSettings.startup(u, u, Optional::empty, null));
        return p;
    }

    @Override
    public Optional<Model.Connection> connection(Model.Account account) {
        ConnectionSettings s = settings;
        Boolean cookie = cookieSet().orElse(null);
        return Optional.of(new Model.Connection(id(), label(), s.url(), added() ? "added" : s.urlSource(), s.startupUrl(),
                s.token().isPresent(), s.tokenSource(), cookie, cookie == null ? null : s.cookieSource(),
                added() || !s.saved().isEmpty(), account, kind(), added()));
    }

    /** An added connection keeps its URL in connections.json too: it has no startup configuration to come from. */
    @Override
    public SavedConnection savedConnection() {
        SavedConnection s = settings.saved();
        return added() ? new SavedConnection(settings.url(), s.token(), s.cookie()) : s;
    }

    @Override
    public synchronized void loadConnection(SavedConnection saved) {
        use(settings.withSaved(added() ? new SavedConnection(null, saved.token(), saved.cookie()) : saved));
    }

    @Override
    public synchronized void configure(ConnectionRequest request) {
        use(settings.apply(fixedUrl(request)));
    }

    @Override
    public synchronized void resetConnection() {
        use(settings.reset());
    }

    @Override
    public User testConnection(ConnectionRequest request) {
        HostProvider probe = blank();
        probe.addedId = addedId;
        probe.use(settings.apply(fixedUrl(request)));
        return probe.currentUser();
    }

    /** The URL of an added connection names it (id, data directory): another host is another connection. */
    private ConnectionRequest fixedUrl(ConnectionRequest r) {
        if (added() && r.url() != null && !r.url().isBlank()
                && !ConnectionSettings.normaliseUrl(r.url()).equals(settings.url())) {
            throw new ProviderException(400, "Die Adresse dieser Verbindung lässt sich nicht ändern. Füge für "
                    + r.url().strip() + " eine neue Verbindung hinzu.");
        }
        return added() ? new ConnectionRequest(null, r.token(), r.cookie(), r.saveCookie()) : r;
    }
}
