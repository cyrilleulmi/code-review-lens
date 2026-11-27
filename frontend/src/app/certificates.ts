import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Api, CertificateInfo, CertificateProbe, CertificateTarget, TlsSettings, errorMessage } from './api';
import { Icon } from './icon';
import { serverText, t } from './i18n';
import { ReviewStore } from './review.store';

/** The common name of a distinguished name ("CN=GitLab, O=Firma" -> "GitLab"), else the whole name. */
export function commonName(dn: string): string {
  const m = /(?:^|,\s*)CN=((?:\\,|[^,])+)/.exec(dn);
  return m ? m[1].replace(/\\,/g, ',') : dn;
}

/**
 * The certificate of the chain to trust by default: the topmost one the host sends (usually the CA, or an intermediate
 * of it), so that other hosts of the same company CA are trusted as well; the server certificate when it is alone.
 */
export function defaultChoice(chain: readonly CertificateInfo[]): string | null {
  return chain.length ? chain[chain.length - 1].fingerprint : null;
}

/** host:port as the backend names hosts; the port is left out when it is 443. */
export function hostLabelOf(target: CertificateTarget): string {
  return target.port === 443 ? target.host : `${target.host}:${target.port}`;
}

/** host or host:port as the user types it (a URL too); null when it cannot be one. */
export function parseTarget(raw: string): CertificateTarget | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    return u.hostname ? { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443 } : null;
  } catch {
    return null;
  }
}

/** Day of an ISO instant in the language of the UI, e.g. "24.11.2027". */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * The certificate of a host the tool does not trust (opened when a request failed on it, or from «Zertifikate»): the
 * chain the host presents, why it is not trusted, and two ways out. The clean one trusts a certificate of the chain -
 * by default the topmost (company CA) - for all connections, saved in <data>/certificates. The insecure one switches
 * the check off for this host only.
 */
@Component({
  selector: 'app-certificate-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="panel" role="dialog" [attr.aria-label]="t('Zertifikat von {host}', { host: label() })" (keydown.escape)="closed.emit()">
      <header>
        <app-icon name="lock" [size]="14" />
        <h2>{{ t('Zertifikat von {host}', { host: label() }) }}</h2>
        <button type="button" class="close" (click)="closed.emit()" [title]="t('Schliessen')" [attr.aria-label]="t('Schliessen')"><app-icon name="close" [size]="13" /></button>
      </header>

      @if (loading()) {
        <p class="dim">{{ t('Zertifikat wird abgerufen …') }}</p>
      } @else if (probe(); as p) {
        @if (p.trusted) {
          <p class="okmsg"><app-icon name="check" [size]="12" /> {{ t('Das Tool vertraut diesem Zertifikat.') }}</p>
        } @else if (p.insecure) {
          <p class="warnmsg"><app-icon name="warning" [size]="12" /> {{ t('Die Prüfung des Zertifikats ist für {host} ausgeschaltet.', { host: label() }) }}</p>
        } @else {
          <p class="err" role="alert">{{ t('Das Tool vertraut diesem Zertifikat nicht:') }} {{ serverText(p.problem ?? '') }}</p>
        }

        <p class="lead">{{ t('Kette, die {host} vorweist (Server zuerst):', { host: label() }) }}</p>
        <div class="chain" role="radiogroup" [attr.aria-label]="t('Zertifikat zum Vertrauen')">
          @for (c of p.chain; track c.fingerprint; let i = $index, last = $last) {
            <label class="cert" [class.on]="chosen() === c.fingerprint">
              <input type="radio" name="cert" [checked]="chosen() === c.fingerprint" (change)="chosen.set(c.fingerprint)" />
              <span class="what">
                <b>{{ commonName(c.subject) }}</b>
                <span class="tags">
                  @if (i === 0) { <span class="tag">{{ t('Server') }}</span> }
                  @if (c.ca) { <span class="tag">{{ t('Zertifizierungsstelle') }}</span> }
                  @if (c.selfSigned) { <span class="tag">{{ t('selbst signiert') }}</span> }
                  @if (last && !c.selfSigned) { <span class="tag dim">{{ t('ausgestellt von {issuer}', { issuer: commonName(c.issuer) }) }}</span> }
                </span>
                <span class="meta">{{ t('gültig bis {date}', { date: day(c.notAfter) }) }} · SHA-256 <code>{{ c.fingerprint }}</code></span>
              </span>
            </label>
          }
        </div>
        <p class="dim">{{ t('Vergleiche den Fingerabdruck mit dem, den deine IT oder der Browser für dieses Zertifikat zeigt. Vertraust du der Zertifizierungsstelle, gilt das auch für alle anderen Hosts mit Zertifikaten von ihr.') }}</p>
      }

      @if (problem(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }

      <div class="actions">
        <button type="button" class="btn primary" [disabled]="busy() || !chosen() || !!probe()?.trusted" (click)="trust()">
          <app-icon name="shield" [size]="13" /> {{ t('Diesem Zertifikat vertrauen') }}</button>
        <button type="button" class="btn" [disabled]="busy()" (click)="load()">{{ t('Erneut abrufen') }}</button>
      </div>

      <details class="unsafe" [open]="!!probe()?.insecure">
        <summary>{{ t('Ohne Prüfung verbinden (unsicher)') }}</summary>
        <p>{{ t('Die Verbindung zu {host} bleibt verschlüsselt, aber das Tool prüft nicht mehr, ob es wirklich mit {host} spricht: Wer sich dazwischen schaltet, sieht Token und Code. Nur als Notlösung, z. B. wenn die Zertifizierungsstelle nicht erhältlich ist.', { host: label() }) }}</p>
        @if (probe()?.insecure) {
          <button type="button" class="btn" [disabled]="busy()" (click)="insecure(false)">{{ t('Prüfung wieder einschalten') }}</button>
        } @else {
          <button type="button" class="btn" [disabled]="busy()" (click)="insecure(true)">
            <app-icon name="warning" [size]="13" /> {{ t('Prüfung für {host} ausschalten', { host: label() }) }}</button>
        }
      </details>
    </div>
  `,
  styles: `
    .panel {
      position: fixed;
      top: 64px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 40;
      width: min(600px, calc(100vw - 32px));
      max-height: calc(100vh - 96px);
      overflow: auto;
      box-sizing: border-box;
      padding: 12px 14px 14px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--bg-panel);
      box-shadow: 0 10px 30px var(--shadow-color);
      font-size: 12.5px;
      line-height: 1.45;
    }

    header {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--fg-muted);

      h2 {
        flex: 1;
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--fg);
      }
    }

    .close {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--fg-muted);
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--fg);
      }
    }

    p {
      margin: 8px 0 0;
      overflow-wrap: anywhere;
    }

    .dim {
      color: var(--fg-muted);
    }

    .lead {
      margin-top: 12px;
      font-weight: 600;
    }

    .err {
      padding: 6px 8px;
      border: 1px solid var(--error-border);
      border-radius: 5px;
      background: var(--error-bg);
    }

    .okmsg {
      color: var(--ok-all-fg);
    }

    .warnmsg {
      color: var(--warn);
    }

    .chain {
      display: grid;
      gap: 4px;
      margin-top: 6px;
    }

    .cert {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;

      &.on {
        border-color: var(--accent);
        background: var(--bg-selected-soft);
      }

      input {
        margin: 3px 0 0;
      }
    }

    .what {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tag {
      padding: 0 6px;
      border-radius: 8px;
      background: var(--bg-hover);
      font-size: 11px;
    }

    .meta {
      color: var(--fg-muted);
      font-size: 11.5px;
      overflow-wrap: anywhere;

      code {
        font: 10.5px var(--font-code);
      }
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .unsafe {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--border);

      summary {
        color: var(--warn);
        cursor: pointer;
      }

      .btn {
        margin-top: 8px;
      }
    }
  `,
})
export class CertificateDialog {
  readonly target = input.required<CertificateTarget>();
  readonly closed = output<void>();

  private readonly api = inject(Api);
  private readonly store = inject(ReviewStore);
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly commonName = commonName;
  protected readonly day = day;

  protected readonly probe = signal<CertificateProbe | null>(null);
  protected readonly chosen = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly label = computed(() => hostLabelOf(this.target()));

  constructor() {
    effect(() => {
      this.target();
      untracked(() => this.load());
    });
  }

  protected load(): void {
    const { host, port } = this.target();
    this.loading.set(true);
    this.problem.set(null);
    this.api.probeCertificate(host, port).subscribe({
      next: (p) => {
        this.loading.set(false);
        this.probe.set(p);
        this.chosen.set(defaultChoice(p.chain));
      },
      error: (e) => {
        this.loading.set(false);
        this.probe.set(null);
        this.problem.set(errorMessage(e));
      },
    });
  }

  protected trust(): void {
    const fingerprint = this.chosen();
    if (!fingerprint) return;
    const { host, port } = this.target();
    this.run(this.api.trustCertificate(host, port, fingerprint), t('Dem Zertifikat wird jetzt vertraut – versuche es nochmals'));
  }

  protected insecure(on: boolean): void {
    const { host, port } = this.target();
    this.run(this.api.setInsecure(host, port, on),
      on ? t('Prüfung für {host} ausgeschaltet – versuche es nochmals', { host: this.label() }) : t('Prüfung für {host} wieder eingeschaltet', { host: this.label() }));
  }

  private run(call: ReturnType<Api['tls']>, done: string): void {
    this.busy.set(true);
    this.problem.set(null);
    call.subscribe({
      next: (settings) => {
        this.busy.set(false);
        this.store.tlsChanged(settings);
        this.store.notify(done);
        this.closed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.problem.set(errorMessage(e));
      },
    });
  }
}

/**
 * «Zertifikate» below the connections: what the tool trusts besides the default certificates (startup configuration,
 * <data>/certificates) and the hosts without check. A certificate can be pasted (PEM, e.g. the root certificate of the
 * company CA from the IT), the certificate of any host looked at, and files put into the directory by hand read again.
 */
@Component({
  selector: 'app-tls-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (store.tls(); as s) {
      <p class="dim">{{ t('Zusätzlich zu den Standard-Zertifikaten vertraut das Tool:') }}</p>
      @if (s.certificates.length) {
        <ul class="list">
          @for (c of s.certificates; track c.fingerprint) {
            <li [title]="c.subject + '\\n' + t('ausgestellt von {issuer}', { issuer: c.issuer }) + '\\nSHA-256 ' + c.fingerprint + '\\n' + (c.file ?? '')">
              <app-icon name="shield" [size]="12" />
              <span class="name">{{ commonName(c.subject) }}</span>
              <span class="src">{{ c.source === 'startup' ? t('Startkonfiguration') : t('gespeichert') }} · {{ t('bis {date}', { date: day(c.notAfter) }) }}</span>
              @if (c.source === 'saved') {
                <button type="button" class="x" [disabled]="busy()" (click)="remove(c)" [title]="t('Nicht mehr vertrauen')" [attr.aria-label]="t('Nicht mehr vertrauen')"><app-icon name="close" [size]="11" /></button>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="none">{{ t('keine weiteren Zertifikate') }}</p>
      }
      @if (s.insecureHosts.length) {
        <p class="dim">{{ t('Ohne Prüfung des Zertifikats (unsicher):') }}</p>
        <ul class="list">
          @for (h of s.insecureHosts; track h.host) {
            <li>
              <app-icon name="warning" [size]="12" class="warn" />
              <span class="name">{{ h.host }}</span>
              <span class="src">{{ h.source === 'startup' ? t('Startkonfiguration') : t('gespeichert') }}</span>
              @if (h.source === 'saved') {
                <button type="button" class="x" [disabled]="busy()" (click)="check(h.host)" [title]="t('Prüfung wieder einschalten')" [attr.aria-label]="t('Prüfung wieder einschalten')"><app-icon name="close" [size]="11" /></button>
              }
            </li>
          }
        </ul>
      }
      @for (w of s.warnings; track w) {
        <p class="err">{{ serverText(w) }}</p>
      }

      <label class="field">
        <span class="label">{{ t('Zertifikat hinzufügen') }}</span>
        <textarea rows="4" spellcheck="false" [placeholder]="'-----BEGIN CERTIFICATE-----\\n…\\n-----END CERTIFICATE-----'"
                  [value]="pem()" (input)="pem.set($any($event.target).value)"></textarea>
        <span class="dim">{{ t('PEM, z. B. das Root-Zertifikat der Firmen-CA von der IT. Gespeichert in {dir}; dort abgelegte Dateien gelten nach «Neu einlesen» oder dem nächsten Start.', { dir: s.directory }) }}</span>
      </label>
      <div class="actions">
        <button type="button" class="btn small primary" [disabled]="busy() || !pem().trim()" (click)="add()">{{ t('Vertrauen') }}</button>
        <button type="button" class="btn small" [disabled]="busy()" (click)="reload()">{{ t('Neu einlesen') }}</button>
      </div>

      <label class="field">
        <span class="label">{{ t('Zertifikat eines Hosts ansehen') }}</span>
        <span class="row">
          <input type="text" spellcheck="false" autocomplete="off" placeholder="gitlab.example.com" [value]="host()"
                 (input)="host.set($any($event.target).value)" (keydown.enter)="look()" />
          <button type="button" class="btn small" [disabled]="!parse(host())" (click)="look()">{{ t('Ansehen') }}</button>
        </span>
      </label>

      @if (problem(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }
    } @else {
      <p class="dim">{{ t('Wird geladen …') }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      font-size: 12.5px;
      line-height: 1.45;
    }

    p {
      margin: 6px 0 0;
      overflow-wrap: anywhere;
    }

    p:first-child {
      margin-top: 0;
    }

    .dim,
    .none {
      color: var(--fg-muted);
    }

    .none {
      font-style: italic;
    }

    .list {
      margin: 4px 0 0;
      padding: 0;
      list-style: none;

      li {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 24px;
      }
    }

    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .src {
      color: var(--fg-dim);
      font-size: 11.5px;
      white-space: nowrap;
    }

    .warn {
      color: var(--warn);
    }

    .x {
      display: grid;
      place-items: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: none;
      color: var(--fg-dim);
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--fg);
      }
    }

    .field {
      display: grid;
      gap: 4px;
      margin-top: 12px;
    }

    .label {
      font-weight: 600;
    }

    .row {
      display: flex;
      gap: 6px;
    }

    textarea,
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 8px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      background: var(--bg-editor);
      color: var(--fg);
      font: 11.5px var(--font-code);
    }

    input {
      height: 24px;
    }

    textarea {
      resize: vertical;
    }

    .actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }

    .err {
      padding: 6px 8px;
      border: 1px solid var(--error-border);
      border-radius: 5px;
      background: var(--error-bg);
    }
  `,
})
export class TlsSettingsPanel {
  protected readonly store = inject(ReviewStore);
  private readonly api = inject(Api);
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly commonName = commonName;
  protected readonly day = day;
  protected readonly parse = parseTarget;

  protected readonly pem = signal('');
  protected readonly host = signal('');
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  constructor() {
    this.store.loadTls();
  }

  protected add(): void {
    this.run(this.api.addCertificate(this.pem()), t('Dem Zertifikat wird jetzt vertraut'), () => this.pem.set(''));
  }

  protected remove(c: CertificateInfo): void {
    this.run(this.api.removeCertificate(c.fingerprint), t('Dem Zertifikat wird nicht mehr vertraut'));
  }

  protected check(hostPort: string): void {
    const target = parseTarget(hostPort);
    if (target) {
      this.run(this.api.setInsecure(target.host, target.port, false), t('Prüfung für {host} wieder eingeschaltet', { host: hostLabelOf(target) }));
    }
  }

  protected reload(): void {
    this.run(this.api.reloadTls(), t('Zertifikate neu eingelesen'));
  }

  protected look(): void {
    const target = parseTarget(this.host());
    if (target) {
      this.store.certificateFor.set(target);
    }
  }

  private run(call: ReturnType<Api['tls']>, done: string, after?: () => void): void {
    this.busy.set(true);
    this.problem.set(null);
    call.subscribe({
      next: (settings: TlsSettings) => {
        this.busy.set(false);
        this.store.tlsChanged(settings);
        this.store.notify(done);
        after?.();
      },
      error: (e) => {
        this.busy.set(false);
        this.problem.set(errorMessage(e));
      },
    });
  }
}
