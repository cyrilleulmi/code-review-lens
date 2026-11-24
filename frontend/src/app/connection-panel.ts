import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Api, Connection, NewConnection, User, errorMessage, hostLabel } from './api';
import { ConnectionForm, defaultUrl, tokenHelp, tokenPlaceholder } from './connections';
import { Icon } from './icon';
import { t } from './i18n';
import { ReviewStore } from './review.store';

/** The kinds of host a connection can go to, in the order the choice shows them. */
const KINDS = [
  { id: 'gitlab', label: 'GitLab' },
  { id: 'github', label: 'GitHub' },
];

/**
 * A connection still to be added: kind, URL, token (and for GitLab the cookie of an SSO proxy). When the connection of
 * the startup configuration of that kind is not set up yet, or goes to the same host, it is set instead of adding a
 * second one: the first GitHub and the first GitLab keep their plain ids.
 */
@Component({
  selector: 'app-new-connection',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <form novalidate (submit)="save($event)" [attr.aria-label]="t('Verbindung hinzufügen')">
      <div class="kinds" role="radiogroup" [attr.aria-label]="t('Art')">
        @for (k of kinds; track k.id) {
          <button type="button" role="radio" [attr.aria-checked]="kind() === k.id" [class.on]="kind() === k.id" (click)="choose(k.id)">
            <app-icon [name]="k.id" [size]="13" /> {{ k.label }}
          </button>
        }
      </div>

      <label class="field">
        <span class="name">{{ t('URL') }}</span>
        <input type="url" autocomplete="off" spellcheck="false" [placeholder]="defaultUrl(kind())"
               [value]="url()" (input)="url.set($any($event.target).value)" />
        <span class="hint">{{ kind() === 'github' ? t('github.com oder die Adresse eines GitHub Enterprise Server.') : t('gitlab.com oder die Adresse eines self-managed GitLab.') }}</span>
      </label>

      <label class="field">
        <span class="name">{{ t('Token') }}</span>
        <input type="password" autocomplete="off" spellcheck="false" [placeholder]="tokenPlaceholder(kind())"
               [value]="token()" (input)="token.set($any($event.target).value)" />
        <span class="hint">{{ tokenHelp(kind()) }}</span>
      </label>

      @if (kind() === 'gitlab') {
        @if (showCookie()) {
          <label class="field">
            <span class="name">{{ t('Cookie des SSO-Proxys') }} <span class="opt">{{ t('optional') }}</span></span>
            <input type="password" autocomplete="off" spellcheck="false" [placeholder]="t('name=wert; name2=wert2')"
                   [value]="cookie()" (input)="cookie.set($any($event.target).value)" />
          </label>
          <label class="check">
            <input type="checkbox" [checked]="saveCookie()" (change)="saveCookie.set($any($event.target).checked)" />
            {{ t('Cookie speichern – sonst gilt es nur bis zum nächsten Start') }}
          </label>
        } @else {
          <p class="hint"><button type="button" class="link" (click)="showCookie.set(true)">{{ t('Liegt {host} hinter einem SSO-Proxy? Cookie eintragen', { host: 'GitLab' }) }}</button></p>
        }
      }

      @if (tested(); as u) {
        <p class="okmsg" role="status"><app-icon name="check" [size]="12" /> {{ t('Test erfolgreich: angemeldet als {login}', { login: u.login }) }}</p>
      }
      @if (error(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }

      <div class="actions">
        <button type="submit" class="btn primary" [disabled]="busy() || !ready()">{{ t('Verbinden') }}</button>
        <button type="button" class="btn" [disabled]="busy() || !ready()" (click)="test()"
                [title]="t('Mit den Werten im Formular anmelden, ohne sie zu übernehmen')">{{ t('Verbindung testen') }}</button>
        @if (cancellable()) {
          <span class="spacer"></span>
          <button type="button" class="btn" (click)="closed.emit()">{{ t('Abbrechen') }}</button>
        }
      </div>
    </form>
  `,
  styles: `
    form {
      font-size: 12.5px;
      line-height: 1.45;
    }

    .kinds {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;

      button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 24px;
        padding: 0 10px;
        border: 0;
        border-radius: 4px;
        background: none;
        color: var(--fg-muted);
        font: inherit;
        cursor: pointer;

        &.on {
          background: var(--bg-selected-soft);
          color: var(--fg);
        }
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

    .hint {
      color: var(--fg-muted);
    }

    p.hint {
      margin: 8px 0 0;
    }

    .check {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      cursor: pointer;
    }

    .link {
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent-fg);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &:hover {
        text-decoration: underline;
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
export class NewConnectionForm {
  /** false in the setup box: there is nothing to go back to */
  readonly cancellable = input(true);
  readonly closed = output<void>();

  private readonly api = inject(Api);
  private readonly store = inject(ReviewStore);
  protected readonly t = t;
  protected readonly kinds = KINDS;
  protected readonly defaultUrl = defaultUrl;
  protected readonly tokenPlaceholder = tokenPlaceholder;
  protected readonly tokenHelp = tokenHelp;

  protected readonly kind = signal('gitlab');
  protected readonly url = signal('');
  protected readonly token = signal('');
  protected readonly cookie = signal('');
  protected readonly saveCookie = signal(false);
  protected readonly showCookie = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tested = signal<User | null>(null);

  /** An address and a token: a connection without a token cannot list anything. */
  protected readonly ready = computed(() => !!this.url().trim() && !!this.token().trim());

  constructor() {
    // start with the address of the startup connection of the chosen kind, once the connections are known
    effect(() => {
      this.store.connections();
      untracked(() => {
        if (!this.url().trim()) {
          this.url.set(this.suggestedUrl(this.kind()));
        }
      });
    });
    effect(() => {
      this.kind();
      this.url();
      this.token();
      this.cookie();
      untracked(() => this.tested.set(null));
    });
  }

  protected choose(kind: string): void {
    if (this.url().trim() === '' || this.url().trim() === this.suggestedUrl(this.kind())) {
      this.url.set(this.suggestedUrl(kind));
    }
    this.kind.set(kind);
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (!this.ready() || this.busy()) {
      return;
    }
    const startup = this.startupToSet();
    const call = startup
      ? this.api.saveConnection(startup.provider, { url: this.url().trim(), token: this.token().trim(), cookie: this.cookieValue(), saveCookie: this.saveCookie() })
      : this.api.addConnection(this.request());
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: (connections) => {
        this.busy.set(false);
        this.store.connectionChanged(connections);
        this.store.notify(t('Verbunden mit {host}', { host: hostLabel(this.url().trim()) }));
        this.closed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected test(): void {
    const startup = this.startupToSet();
    const call = startup
      ? this.api.testConnection(startup.provider, { url: this.url().trim(), token: this.token().trim(), cookie: this.cookieValue(), saveCookie: false })
      : this.api.testNewConnection(this.request());
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
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

  /**
   * The connection of the startup configuration of this kind, when it is to be set rather than a second one added:
   * nothing is set up for it yet, or it goes to this host but is not connected.
   */
  private startupToSet(): Connection | null {
    const startup = (this.store.connections() ?? []).find((c) => c.provider === this.kind());
    if (!startup || startup.account.user && !sameHost(startup.url, this.url())) {
      return null;
    }
    return sameHost(startup.url, this.url()) || !startup.token && !startup.saved ? startup : null;
  }

  private request(): NewConnection {
    return { kind: this.kind(), url: this.url().trim(), token: this.token().trim(), cookie: this.cookieValue(), saveCookie: this.saveCookie() };
  }

  private cookieValue(): string | null {
    return this.kind() === 'gitlab' ? this.cookie().trim() || null : null;
  }

  /**
   * The address to start with: that of the startup connection of the kind while it is not connected (the likely one
   * to set up); nothing when it is connected, as another host of that kind is to be added.
   */
  private suggestedUrl(kind: string): string {
    const startup = (this.store.connections() ?? []).find((c) => c.provider === kind);
    return !startup ? defaultUrl(kind) : startup.account.user ? '' : startup.url;
  }
}

/** Same host and port, whatever the scheme, case or trailing slash. */
export function sameHost(a: string, b: string): boolean {
  try {
    const x = new URL(a.trim());
    const y = new URL(b.trim());
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && effectivePort(x) === effectivePort(y);
  } catch {
    return false;
  }
}

function effectivePort(u: URL): string {
  return u.port === '80' || u.port === '443' ? '' : u.port;
}

/**
 * The connections at the top of the «Pull/Merge Requests» tool window. Nothing connected: a highlighted box to set up
 * GitHub or GitLab. Otherwise a quiet list to choose whose pull requests the list shows («Alle» or one connection),
 * with a gear per connection for its form and «Verbindung hinzufügen» for another host.
 */
@Component({
  selector: 'app-connection-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ConnectionForm, NewConnectionForm],
  template: `
    @if (store.connections(); as list) {
      @if (!connected()) {
        <section class="setup" [attr.aria-label]="t('Code-Host verbinden')">
          <header>
            <app-icon name="plug" [size]="16" />
            <h3>{{ t('Code-Host verbinden') }}</h3>
          </header>
          <p>{{ t('Verbinde GitHub oder GitLab, dann stehen hier deine offenen Pull und Merge Requests.') }}</p>
          <app-new-connection [cancellable]="false" />
        </section>
      }

      @if (shown().length) {
        <div class="hosts" role="radiogroup" [attr.aria-label]="t('Pull Requests von')">
          @if (connected()) {
            <button type="button" class="host all" role="radio" [attr.aria-checked]="!store.activeHost()" [class.on]="!store.activeHost()"
                    (click)="store.chooseHost(null)">
              <app-icon name="layers" [size]="13" />
              <span class="name">{{ t('Alle') }}</span>
              <span class="badge">{{ store.prs().length }}</span>
            </button>
          }
          @for (c of shown(); track c.provider) {
            <div class="row" [class.on]="store.activeHost() === c.provider" [class.editing]="editing() === c.provider">
              <button type="button" class="host" role="radio" [attr.aria-checked]="store.activeHost() === c.provider"
                      (click)="store.chooseHost(c.provider)" [title]="c.url">
                <app-icon [name]="c.kind" [size]="13" />
                <span class="name">{{ host(c.url) }}</span>
                @if (c.account.user; as u) {
                  <span class="state ok">{{ u.login }}</span>
                } @else {
                  <span class="state off" [title]="c.account.error ?? ''"><app-icon name="warning" [size]="11" /> {{ t('nicht verbunden') }}</span>
                }
                <span class="badge">{{ count(c.provider) }}</span>
              </button>
              <button type="button" class="gear" (click)="toggleEdit(c.provider)" [attr.aria-expanded]="editing() === c.provider"
                      [title]="t('Verbindung einstellen')" [attr.aria-label]="t('Verbindung einstellen')">
                <app-icon name="cog" [size]="13" />
              </button>
            </div>
            @if (editing() === c.provider) {
              <div class="body">
                <app-connection-form [connection]="c" [embedded]="true" />
                <p class="dim">{{ t('Gespeichert wird in {file}. Token und Cookie stehen dort im Klartext und werden nie wieder angezeigt.', { file: file() }) }}</p>
              </div>
            }
          }
          @if (connected()) {
            @if (adding()) {
              <div class="body add">
                <app-new-connection (closed)="adding.set(false)" />
              </div>
            } @else {
              <button type="button" class="host add-btn" (click)="startAdding()">
                <app-icon name="plus" [size]="13" />
                <span class="name">{{ t('Verbindung hinzufügen') }}</span>
              </button>
            }
          }
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      flex-shrink: 0;
      max-height: 70%;
      overflow: auto;
      margin-bottom: 2px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid var(--border);
      font-size: 12.5px;
    }

    .setup {
      margin-bottom: 8px;
      padding: 12px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      background: var(--bg-panel);
      box-shadow: inset 3px 0 0 var(--accent);

      header {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      p {
        margin: 8px 0 12px;
        line-height: 1.45;
      }
    }

    .hosts {
      display: grid;
      gap: 1px;
    }

    .row {
      display: flex;
      align-items: center;
      border-radius: 5px;

      &.on {
        background: var(--bg-selected-soft);
      }
    }

    .host {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 6px;
      min-width: 0;
      height: 26px;
      padding: 0 8px;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--fg-muted);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--fg);
      }

      &.all.on {
        background: var(--bg-selected-soft);
        color: var(--fg);
      }
    }

    .row.on .host {
      color: var(--fg);
    }

    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      white-space: nowrap;
      font-size: 11.5px;

      &.ok {
        color: var(--fg-dim);
      }

      &.off {
        color: var(--warn);
      }
    }

    .badge {
      padding: 0 5px;
      border-radius: 8px;
      background: var(--bg-hover);
      font-size: 10.5px;
    }

    .gear {
      display: grid;
      place-items: center;
      flex: none;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--fg-dim);
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--fg);
      }
    }

    .row.editing .gear {
      color: var(--accent-fg);
    }

    .body {
      margin: 2px 0 6px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-panel);
    }

    .add-btn {
      flex: none;
      width: 100%;
    }

    .dim {
      margin: 8px 0 0;
      color: var(--fg-muted);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
  `,
})
export class ConnectionPanel {
  protected readonly store = inject(ReviewStore);
  protected readonly t = t;
  protected readonly adding = signal(false);
  protected readonly host = hostLabel;

  /** Some connection has a signed-in user: then the panel stays quiet. */
  protected readonly connected = computed(() => (this.store.connections() ?? []).some((c) => !!c.account.user));

  /**
   * The connections worth a line: connected, or set up somehow (token, saved, added). A GitHub or GitLab of the startup
   * configuration with nothing set is left out; «Verbindung hinzufügen» sets it up.
   */
  protected readonly shown = computed(() =>
    (this.store.connections() ?? []).filter((c) => !!c.account.user || c.token || c.saved || c.added));

  /** The connection whose form is open: the one asked for, else the chosen one, else the first. */
  protected readonly editing = computed(() => {
    if (!this.store.connectionsOpen()) {
      return null;
    }
    const shown = this.shown();
    const wanted = this.store.editedConnection() ?? this.store.activeHost();
    return shown.find((c) => c.provider === wanted)?.provider ?? shown[0]?.provider ?? null;
  });

  protected readonly file = computed(() => {
    const dir = this.store.me()?.dataDir;
    return dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}connections.json` : 'connections.json';
  });

  constructor() {
    // fresh state of the accounts every time a form is opened (toolbar, status bar, gear)
    effect(() => {
      if (this.store.connectionsOpen()) {
        untracked(() => this.store.loadConnections());
      }
    });
  }

  protected count(provider: string): number {
    return this.store.prs().filter((p) => p.provider === provider).length;
  }

  protected toggleEdit(provider: string): void {
    if (this.editing() === provider) {
      this.store.connectionsOpen.set(false);
    } else {
      this.adding.set(false);
      this.store.editConnection(provider);
    }
  }

  protected startAdding(): void {
    this.store.connectionsOpen.set(false);
    this.adding.set(true);
  }
}
