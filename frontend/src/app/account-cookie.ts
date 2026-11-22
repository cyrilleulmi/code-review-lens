import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Account, Api, errorMessage } from './api';
import { Icon } from './icon';
import { serverText, t } from './i18n';
import { ReviewStore } from './review.store';

/**
 * Sets the session cookies of an SSO proxy in front of a code host while the tool runs: such cookies expire
 * regularly, and the configured one would need a restart. The value goes to the backend only (kept in memory there,
 * or saved again when the cookie being replaced was saved on the config page «Verbindungen»); the backend never sends
 * it back, so the field always starts empty.
 */
@Component({
  selector: 'app-account-cookie',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let a = account();
    <form class="panel" role="dialog" [attr.aria-label]="t('Cookie für {host}', { host: a.label })"
          (submit)="save($event)" (keydown.escape)="closed.emit()">
      <header>
        <app-icon name="lock" [size]="14" />
        <h2>{{ t('Cookie für {host}', { host: a.label }) }}</h2>
        <button type="button" class="close" (click)="closed.emit()" [title]="t('Schliessen')" [attr.aria-label]="t('Schliessen')"><app-icon name="close" [size]="13" /></button>
      </header>
      <p>{{ t('Liegt {host} hinter einem SSO-Proxy, braucht jede Anfrage neben dem Token auch dessen Session-Cookies. Füge hier den Wert des Cookie-Headers ein, wie ihn der Browser an {url} schickt (Entwicklertools → Netzwerk → Request-Header «Cookie»).', { host: a.label, url: a.host }) }}</p>
      <p class="dim">{{ saved() ? t('Das Cookie ist unter «Verbindungen» gespeichert: Ein neues ersetzt es dort.') : t('Das Cookie wird nicht gespeichert: Es gilt, bis das Tool neu startet.') }}
        {{ a.cookie ? t('Zurzeit ist ein Cookie gesetzt.') : t('Zurzeit ist kein Cookie gesetzt.') }}
        <button type="button" class="link" (click)="openConnections()">{{ t('Alle Einstellungen der Verbindung …') }}</button></p>
      @if (problem(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }
      <input #field type="password" autocomplete="off" spellcheck="false" [placeholder]="t('name=wert; name2=wert2')"
             [attr.aria-label]="t('Wert des Cookie-Headers')" [value]="value()" (input)="value.set($any($event.target).value)" />
      <div class="actions">
        <button type="submit" class="btn primary" [disabled]="busy() || !value().trim()">{{ t('Cookie setzen') }}</button>
        <button type="button" class="btn" [disabled]="busy() || !a.cookie" (click)="send('')">{{ t('Cookie entfernen') }}</button>
      </div>
    </form>
  `,
  styles: `
    .panel {
      position: fixed;
      right: 16px;
      bottom: 36px;
      z-index: 30;
      width: min(460px, calc(100vw - 32px));
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

    .link {
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent-fg);
      font: inherit;
      cursor: pointer;

      &:hover {
        text-decoration: underline;
      }
    }

    .err {
      padding: 6px 8px;
      border: 1px solid var(--error-border);
      border-radius: 5px;
      background: var(--error-bg);
    }

    input {
      width: 100%;
      box-sizing: border-box;
      height: 28px;
      margin-top: 10px;
      padding: 0 8px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      background: var(--bg-editor);
      color: var(--fg);
      font: 12.5px var(--font-code);
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
  `,
})
export class AccountCookie {
  readonly account = input.required<Account>();
  readonly closed = output<void>();

  private readonly api = inject(Api);
  private readonly store = inject(ReviewStore);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly t = t;
  protected readonly value = signal('');
  protected readonly busy = signal(false);
  /** why the last attempt to set the cookie failed (the account's own error is shown otherwise) */
  protected readonly error = signal<string | null>(null);
  /** What is wrong right now: the failed attempt, else why the account is not connected. */
  /** The cookie was saved on the config page: a new one replaces it there. */
  protected readonly saved = computed(
    () => this.store.connections()?.find((c) => c.provider === this.account().provider)?.cookieSource === 'saved');
  protected readonly problem = computed(() => {
    const a = this.account();
    return this.error() ?? (a.user || !a.error ? null : serverText(a.error));
  });

  constructor() {
    afterNextRender(() => this.field()?.nativeElement.focus());
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.value().trim() && !this.busy()) {
      this.send(this.value());
    }
  }

  protected openConnections(): void {
    this.store.connectionsOpen.set(true);
    this.closed.emit();
  }

  /** Sets the cookie (blank: removes it). Closes when the account is connected afterwards, else shows why not. */
  protected send(cookie: string): void {
    const provider = this.account().provider;
    this.busy.set(true);
    this.error.set(null);
    this.api.setCookie(provider, cookie).subscribe({
      next: (me) => {
        this.busy.set(false);
        this.value.set('');
        this.store.me.set(me);
        this.store.loadConnections();
        this.store.loadPrs();
        const now = me.accounts.find((a) => a.provider === provider);
        if (!cookie.trim()) {
          this.store.notify(t('Cookie entfernt'));
          this.closed.emit();
        } else if (now?.user) {
          this.store.notify(t('Cookie gesetzt: verbunden als {login}', { login: now.user.login }));
          this.closed.emit();
        }
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }
}
