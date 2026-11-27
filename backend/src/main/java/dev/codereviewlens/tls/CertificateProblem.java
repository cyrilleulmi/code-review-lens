package dev.codereviewlens.tls;

import dev.codereviewlens.provider.ProviderException;

/**
 * A request failed on the certificate of the host. The API answers with the host and port besides the message, so
 * the UI can offer to look at the certificate and trust it (or switch the check off for that host).
 */
public class CertificateProblem extends ProviderException {

    private final String host;
    private final int port;

    public CertificateProblem(String host, int port, String detail) {
        super(502, "Zertifikat von " + Tls.hostKey(host, port) + " wird nicht vertraut: " + detail);
        this.host = host;
        this.port = port;
    }

    public String host() {
        return host;
    }

    public int port() {
        return port;
    }
}
