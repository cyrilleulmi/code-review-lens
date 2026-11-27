import { afterEach, describe, expect, it } from 'vitest';
import { CertificateInfo, certificateTarget, certificateTargetIn } from './api';
import { commonName, defaultChoice, hostLabelOf, parseTarget } from './certificates';
import { serverText, setLang } from './i18n';

const cert = (fingerprint: string): CertificateInfo => ({
  fingerprint, subject: 'CN=x', issuer: 'CN=y', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z',
  ca: false, selfSigned: false, source: null, file: null,
});

describe('certificates', () => {
  afterEach(() => setLang('de'));

  it('finds the host of an API error about a certificate, and only then', () => {
    expect(certificateTarget({ error: { message: '…', certificate: { host: 'gitlab.firma.ch', port: 443 } } }))
      .toEqual({ host: 'gitlab.firma.ch', port: 443 });
    expect(certificateTarget({ error: { message: 'GitLab nicht erreichbar: timeout' } })).toBeNull();
    expect(certificateTarget(null)).toBeNull();
  });

  it('finds the host in the error text of an account', () => {
    expect(certificateTargetIn('Zertifikat von gitlab.firma.ch:8443 wird nicht vertraut: Das Zertifikat ist abgelaufen.'))
      .toEqual({ host: 'gitlab.firma.ch', port: 8443 });
    expect(certificateTargetIn('Kein Token konfiguriert')).toBeNull();
    expect(certificateTargetIn(null)).toBeNull();
  });

  it('trusts the topmost certificate of the chain by default', () => {
    expect(defaultChoice([cert('server'), cert('intermediate'), cert('root')])).toBe('root');
    expect(defaultChoice([cert('self')])).toBe('self');
    expect(defaultChoice([])).toBeNull();
  });

  it('reads hosts as the user types them', () => {
    expect(parseTarget('gitlab.firma.ch')).toEqual({ host: 'gitlab.firma.ch', port: 443 });
    expect(parseTarget(' gitlab.firma.ch:8443 ')).toEqual({ host: 'gitlab.firma.ch', port: 8443 });
    expect(parseTarget('https://gitlab.firma.ch/group/repo/-/merge_requests/3')).toEqual({ host: 'gitlab.firma.ch', port: 443 });
    expect(parseTarget('')).toBeNull();
    expect(hostLabelOf({ host: 'a.ch', port: 443 })).toBe('a.ch');
    expect(hostLabelOf({ host: 'a.ch', port: 8443 })).toBe('a.ch:8443');
  });

  it('names a certificate by its common name', () => {
    expect(commonName('CN=Firma Root CA, O=Firma AG, C=CH')).toBe('Firma Root CA');
    expect(commonName('CN=Muster\\, AG,O=x')).toBe('Muster, AG');
    expect(commonName('O=Firma AG')).toBe('O=Firma AG');
  });

  it('shows the certificate errors of the backend in English', () => {
    setLang('en');
    expect(serverText('Zertifikat von gitlab.firma.ch:443 wird nicht vertraut: Es ist von einer unbekannten Zertifizierungsstelle '
      + 'ausgestellt (z. B. einer Firmen-CA) oder selbst signiert.'))
      .toBe('Certificate of gitlab.firma.ch:443 is not trusted: It is issued by an unknown certificate authority (e.g. a company CA) or self-signed.');
  });
});
