package dev.smartcodereview.tls;

import dev.smartcodereview.model.Model.CertificateInfo;
import dev.smartcodereview.provider.ProviderException;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Reading and describing X.509 certificates: PEM (one or several, as a bundle), Base64 or binary DER. */
public final class Certificates {

    private static final Pattern CN = Pattern.compile("(?:^|,\\s*)CN=((?:\\\\,|[^,])+)");

    private Certificates() {
    }

    /** All certificates in the bytes of a file or of text pasted in the UI; refused when there is none. */
    public static List<X509Certificate> parse(byte[] bytes) {
        String text = new String(bytes, StandardCharsets.US_ASCII).strip();
        byte[] input = bytes;
        if (!text.contains("-----BEGIN") && text.matches("[A-Za-z0-9+/=\\s]+") && !text.isEmpty()) {
            try {
                input = Base64.getMimeDecoder().decode(text); // Base64 DER without the PEM lines
            } catch (IllegalArgumentException ignored) {
                // not Base64 after all: try the bytes as they are
            }
        }
        try {
            List<X509Certificate> result = new ArrayList<>();
            for (var c : CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(input))) {
                if (c instanceof X509Certificate x) {
                    result.add(x);
                }
            }
            if (!result.isEmpty()) {
                return result;
            }
        } catch (CertificateException e) {
            throw new ProviderException(400, "Kein gültiges Zertifikat: " + e.getMessage());
        }
        throw new ProviderException(400, "Kein Zertifikat gefunden. Erwartet wird PEM («-----BEGIN CERTIFICATE-----» …).");
    }

    public static List<X509Certificate> parse(String text) {
        return parse((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
    }

    /** SHA-256 of the DER encoding, as hex pairs separated by ":" (as browsers show it). */
    public static String fingerprint(X509Certificate c) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(c.getEncoded());
            return HexFormat.ofDelimiter(":").withUpperCase().formatHex(digest);
        } catch (NoSuchAlgorithmException | CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A fingerprint as the user may give it (any case, with or without ":" or spaces) in the form of {@link #fingerprint}. */
    public static String normaliseFingerprint(String raw) {
        String hex = raw == null ? "" : raw.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.ROOT);
        return HexFormat.ofDelimiter(":").withUpperCase().formatHex(HexFormat.of().parseHex(hex.length() % 2 == 0 ? hex : ""));
    }

    public static String pem(X509Certificate c) {
        try {
            return "-----BEGIN CERTIFICATE-----\n"
                    + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(c.getEncoded())
                    + "\n-----END CERTIFICATE-----\n";
        } catch (CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    public static CertificateInfo info(X509Certificate c, String source, String file) {
        String subject = c.getSubjectX500Principal().getName();
        String issuer = c.getIssuerX500Principal().getName();
        return new CertificateInfo(fingerprint(c), subject, issuer, c.getNotBefore().toInstant().toString(),
                c.getNotAfter().toInstant().toString(), c.getBasicConstraints() >= 0, subject.equals(issuer), source, file);
    }

    /** The common name of the subject (else the whole subject): a readable name, e.g. for the file name. */
    public static String commonName(X509Certificate c) {
        String subject = c.getSubjectX500Principal().getName();
        Matcher m = CN.matcher(subject);
        return m.find() ? m.group(1).replace("\\,", ",") : subject;
    }
}
