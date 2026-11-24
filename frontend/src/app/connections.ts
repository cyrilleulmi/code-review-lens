import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Api, Connection, ConnectionRequest, ConnectionSource, User, errorMessage, hostLabel } from './api';
import { Icon } from './icon';
import { serverText, t } from './i18n';
import { ReviewStore } from './review.store';

/**
 * One connection of the config page: URL, token and the session cookies of an SSO proxy. Fields left empty keep their
 * value; token and cookie are never sent back by the backend, so their fields always start empty and only say whether
 * one is set and where it comes from. «Testen» signs in with the values of the form without using them.
 */
@Component({
  selector: 'app-connection-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let c = connection();
    <form class="card" [class.embedded]="embedded()" novalidate (submit)="save($event)" [attr.aria-label]="c.label">
      @if (!embedded()) {
        <header>
          <app-icon [name]="c.provider" [size]="16" />
          <h2>{{ c.label }}</h2>
          @if (c.account.user; as u) {
            <span class="state ok"><app-icon name="check" [size]="12" /> {{ t('verbunden als {login}', { login: u.login }) }}</span>
          } @else {
            <span class="state off">{{ t('nicht verbunden') }}</span>
          }
        </header>
      }
      @if (!c.account.user && c.account.error && (c.token || !embedded())) {
        <p class="err" role="alert">{{ serverText(c.account.error) }}</p>
      }

      <label class="field">
        <span class="name">{{ t('URL') }}</span>
        <input type="url" autocomplete="off" spellcheck="false" [placeholder]="defaultUrl(c.kind)" [readOnly]="c.added"
               [value]="url()" (input)="url.set($any($event.target).value)" />
        <span class="hint">{{ urlHint() }}</span>
        @if (urlChanged()) {
          <span class="hint warn">{{ t('Andere URL: Token und Cookie gelten nur für die URL, für die sie eingetragen wurden. Trage sie für die neue mit ein.') }}</span>
        }
      </label>

      <label class="field">
        <span class="name">{{ t('Token') }}</span>
        <input type="password" autocomplete="off" spellcheck="false"
               [placeholder]="c.token ? t('gesetzt – leer lassen, um es zu behalten') : tokenPlaceholder(c.kind)"
               [value]="token()" (input)="token.set($any($event.target).value)" />
        <span class="hint">
          {{ tokenHint() }}
          @if (c.tokenSource === 'saved') {
            <button type="button" class="link" [disabled]="busy()" (click)="send({ token: '' }, t('Gespeichertes Token entfernt'))">{{ t('Gespeichertes Token entfernen') }}</button>
          }
        </span>
      </label>

      @if (c.cookie != null && !showCookie()) {
        <p class="dim">
          <button type="button" class="link first" (click)="showCookie.set(true)">{{ t('Liegt {host} hinter einem SSO-Proxy? Cookie eintragen', { host: c.label }) }}</button>
        </p>
      } @else if (c.cookie != null) {
        <label class="field">
          <span class="name">{{ t('Cookie des SSO-Proxys') }} <span class="opt">{{ t('optional') }}</span></span>
          <input type="password" autocomplete="off" spellcheck="false"
                 [placeholder]="c.cookie ? t('gesetzt – leer lassen, um es zu behalten') : t('name=wert; name2=wert2')"
                 [value]="cookie()" (input)="cookie.set($any($event.target).value)" />
          <span class="hint">
            {{ cookieHint() }}
            @if (c.cookieSource === 'saved' || c.cookieSource === 'runtime') {
              <button type="button" class="link" [disabled]="busy()" (click)="send({ cookie: '' }, t('Cookie entfernt'))">{{ t('Cookie entfernen') }}</button>
            }
          </span>
        </label>
        <p class="dim">{{ t('Nur nötig, wenn {host} hinter einem SSO-Proxy liegt (z. B. Pritunl Zero): Wert des Cookie-Headers, wie ihn der Browser an die URL schickt (Entwicklertools → Netzwerk → Request-Header «Cookie»).', { host: c.label }) }}</p>
        <label class="check">
          <input type="checkbox" [checked]="saveCookie()" (change)="saveCookie.set($any($event.target).checked)" />
          {{ t('Cookie speichern – sonst gilt es nur bis zum nächsten Start') }}
        </label>
      }

      @if (tested(); as u) {
        <p class="okmsg" role="status"><app-icon name="check" [size]="12" /> {{ t('Test erfolgreich: angemeldet als {login}', { login: u.login }) }}</p>
      }
      @if (error(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }

      <div class="actions">
        <button type="submit" class="btn primary" [disabled]="busy() || !dirty()">{{ t('Speichern') }}</button>
        <button type="button" class="btn" [disabled]="busy()" (click)="test()"
                [title]="t('Mit den Werten im Formular anmelden, ohne sie zu übernehmen')">{{ t('Verbindung testen') }}</button>
        <span class="spacer"></span>
        @if (c.added) {
          <button type="button" class="btn" [disabled]="busy()" (click)="reset()"
                  [title]="t('Die Verbindung nicht mehr verwenden. Reviews und Markierungen im Datenverzeichnis bleiben.')">
            {{ t('Verbindung entfernen') }}
          </button>
        } @else {
          <button type="button" class="btn" [disabled]="busy() || !(c.saved || c.cookieSource === 'runtime')" (click)="reset()"
                  [title]="t('Alles, was hier gesetzt wurde, verwerfen: es gilt wieder die Startkonfiguration ({url})', { url: c.startupUrl })">
            {{ t('Auf Startkonfiguration zurücksetzen') }}
          </button>
        }
      </div>
    </form>
  `,
  styles: `
    .card {
      max-width: 640px;
      margin: 0 0 18px;
      padding: 14px 16px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-panel);
      font-size: 12.5px;
      line-height: 1.45;

      &.embedded {
        max-width: none;
        margin: 0;
        padding: 0;
        border: 0;
        background: none;

        .field:first-of-type {
          margin-top: 0;
        }
      }
    }

    header {
      display: flex;
      align-items: center;
      gap: 8px;

      h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      font-size: 12px;

      &.ok {
        color: var(--ok);
      }

      &.off {
        color: var(--fg-muted);
      }
    }

    .field {
      display: grid;
      gap: 4px;
      margin-top: 12px;
    }

    .name {
      font-weight: 600;
    }

    .opt {
      font-weight: 400;
      color: var(--fg-dim);
    }

    input[type='url'],
    input[type='password'] {
      width: 100%;
      box-sizing: border-box;
      height: 28px;
      padding: 0 8px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      background: var(--bg-editor);
      color: var(--fg);
      font: 12.5px var(--font-code);
    }

    .hint,
    .dim {
      color: var(--fg-muted);
    }

    .hint.warn {
      color: var(--warn);
    }

    .dim {
      margin: 6px 0 0;
      overflow-wrap: anywhere;
    }

    .check {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      cursor: pointer;
    }

    .link {
      margin-left: 6px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent-fg);
      font: inherit;
      cursor: pointer;

      &:hover:not(:disabled) {
        text-decoration: underline;
      }

      &:disabled {
        opacity: 0.5;
        cursor: default;
      }

      &.first {
        margin-left: 0;
        text-align: left;
      }
    }

    .err,
    .okmsg {
      margin: 10px 0 0;
      padding: 6px 8px;
      border-radius: 5px;
      overflow-wrap: anywhere;
    }

    .err {
      border: 1px solid var(--error-border);
      background: var(--error-bg);
    }

    .okmsg {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--ok-border);
      color: var(--ok);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .spacer {
      flex: 1;
    }
  `,
})
export class ConnectionForm {
  readonly connection = input.required<Connection>();
  /** Inside the connection panel: no card and no head of its own, the panel shows host and state. */
  readonly embedded = input(false);

  private readonly api = inject(Api);
  private readonly store = inject(ReviewStore);

  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly url = signal('');
  protected readonly token = signal('');
  protected readonly cookie = signal('');
  protected readonly saveCookie = signal(false);
  /** The cookie fields are shown: a cookie is set, or someone asked for them (most hosts need none). */
  protected readonly showCookie = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** the user of the last successful test (of the values in the form at that time) */
  protected readonly tested = signal<User | null>(null);

  /** Something in the form differs from the connection. */
  protected readonly dirty = computed(
    () => this.url().trim() !== this.connection().url || !!this.token().trim() || !!this.cookie().trim());

  /** Another host is entered: token and cookie of the old one will not be sent there. */
  protected readonly urlChanged = computed(() => {
    const url = this.url().trim().replace(/\/+$/, '');
    return !!url && url !== this.connection().url;
  });

  protected readonly defaultUrl = defaultUrl;
  protected readonly tokenPlaceholder = tokenPlaceholder;

  protected readonly urlHint = computed(() => {
    const c = this.connection();
    const github = c.kind === 'github';
    switch (c.urlSource) {
      case 'added':
        return t('Feste Adresse dieser Verbindung. Für einen anderen Host eine weitere Verbindung hinzufügen.');
      case 'saved':
        return t('Hier gespeichert. Startkonfiguration: {url}', { url: c.startupUrl });
      case 'startup':
        return github ? t('Aus der Startkonfiguration (SCR_GITHUB_API_URL).') : t('Aus der Startkonfiguration (SCR_GITLAB_URL).');
      default:
        return github ? t('Standard. Für GitHub Enterprise dessen Adresse eintragen.')
                      : t('Standard. Für ein self-managed GitLab dessen Adresse eintragen.');
    }
  });

  protected readonly tokenHint = computed(() => {
    const c = this.connection();
    return sourceText(c.tokenSource, {
      saved: t('Hier gespeichert.'),
      startup: c.kind === 'github' ? t('Aus der Startkonfiguration (GITHUB_TOKEN, GH_TOKEN oder gh).')
                                   : t('Aus der Startkonfiguration (GITLAB_TOKEN, GL_TOKEN oder glab).'),
      none: tokenHelp(c.kind),
    });
  });

  protected readonly cookieHint = computed(() =>
    sourceText(this.connection().cookieSource, {
      saved: t('Hier gespeichert.'),
      runtime: t('Nur im Arbeitsspeicher gesetzt: gilt bis zum nächsten Start.'),
      startup: t('Aus der Startkonfiguration (SCR_GITLAB_COOKIE).'),
      none: t('Kein Cookie gesetzt.'),
    }));

  constructor() {
    // A new state of the connection (saved, reset, cookie from the status bar): the form starts from it again.
    effect(() => {
      const c = this.connection();
      untracked(() => {
        this.url.set(c.url);
        this.token.set('');
        this.cookie.set('');
        this.saveCookie.set(c.cookieSource === 'saved');
        this.showCookie.set(this.showCookie() || !!c.cookie);
      });
    });
    // Changing the form makes an earlier test result meaningless.
    effect(() => {
      this.url();
      this.token();
      this.cookie();
      untracked(() => this.tested.set(null));
    });
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.dirty() && !this.busy()) {
      this.send(this.request(), t('Verbindung gespeichert'));
    }
  }

  protected test(): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.testConnection(this.connection().provider, this.request()).subscribe({
      next: (user) => {
        this.busy.set(false);
        this.tested.set(user);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected reset(): void {
    const c = this.connection();
    this.run(this.api.resetConnection(c.provider),
      c.added ? t('Verbindung zu {host} entfernt', { host: hostLabel(c.url) }) : t('Zurückgesetzt: es gilt die Startkonfiguration'));
  }

  /** Sends a change; fields not given are kept. */
  protected send(change: Partial<ConnectionRequest>, done: string): void {
    const request: ConnectionRequest = { url: null, token: null, cookie: null, saveCookie: null, ...change };
    this.run(this.api.saveConnection(this.connection().provider, request), done);
  }

  private request(): ConnectionRequest {
    return formRequest(this.connection(), {
      url: this.url(), token: this.token(), cookie: this.cookie(), saveCookie: this.saveCookie(),
    });
  }

  private run(call: ReturnType<Api['saveConnection']>, done: string): void {
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: (connections) => {
        this.busy.set(false);
        this.store.connectionChanged(connections);
        const now = connections.find((c) => c.provider === this.connection().provider);
        this.store.notify(now?.account.user ? `${done} – ${t('verbunden als {login}', { login: now.account.user.login })}` : done);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }
}

/**
 * What the form sends: only what was changed. An unchanged or emptied URL keeps the URL in use (going back to the
 * startup URL is «reset»); empty token and cookie fields keep the values that are set.
 */
export function formRequest(
  connection: Pick<Connection, 'url'>,
  form: { url: string; token: string; cookie: string; saveCookie: boolean },
): ConnectionRequest {
  const url = form.url.trim();
  return {
    url: url && url !== connection.url ? url : null,
    token: form.token.trim() || null,
    cookie: form.cookie.trim() || null,
    saveCookie: form.saveCookie,
  };
}

/** The URL a connection of this kind has without anything configured. */
export function defaultUrl(kind: string): string {
  return kind === 'github' ? 'https://github.com' : 'https://gitlab.com';
}

export function tokenPlaceholder(kind: string): string {
  return kind === 'github' ? 'ghp_…' : 'glpat-…';
}

/** What a missing token means and which one to create. */
export function tokenHelp(kind: string): string {
  return kind === 'github'
    ? t('Kein Token: Pull Requests lassen sich nicht auflisten und nicht öffnen. Ein Personal Access Token mit Scope «repo».')
    : t('Kein Token: Merge Requests lassen sich nicht auflisten und nicht kommentieren, öffentliche nur per URL öffnen. Scope «api».');
}

function sourceText(
  source: ConnectionSource,
  texts: { saved: string; runtime?: string; startup: string; none: string },
): string {
  switch (source) {
    case 'saved':
      return texts.saved;
    case 'runtime':
      return texts.runtime ?? texts.saved;
    case 'startup':
      return texts.startup;
    default:
      return texts.none;
  }
}
