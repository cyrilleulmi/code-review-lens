import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from './icon';
import { t } from './i18n';
import { PLAYER_SPEEDS, SequencePlayer } from './sequence-player';

/**
 * The buttons of a playback (sequence-player.ts): back, play / pause, on, the position, the speed. What the current
 * call is, the view says in its own words between the tags (content).
 */
@Component({
  selector: 'app-sequence-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let i = player().index();
    @let playing = player().playing();
    <button type="button" class="ftool icon" [disabled]="i === 0" (click)="player().prev()" [title]="t('Einen Aufruf zurück')" [attr.aria-label]="t('Einen Aufruf zurück')">
      <app-icon name="stepPrev" [size]="13" />
    </button>
    <button type="button" class="ftool play" [class.on]="playing" [disabled]="length() === 0" (click)="player().toggle()"
            [title]="playing ? t('Abspielen anhalten') : t('Die Aufrufe der Reihe nach abspielen')">
      <app-icon [name]="playing ? 'pause' : 'play'" [size]="13" />
      {{ playing ? t('Pause') : i > 0 && i < length() ? t('Weiter abspielen') : t('Abfolge abspielen') }}
    </button>
    <button type="button" class="ftool icon" [disabled]="i >= length()" (click)="player().next()" [title]="t('Einen Aufruf weiter')" [attr.aria-label]="t('Einen Aufruf weiter')">
      <app-icon name="stepNext" [size]="13" />
    </button>
    <div class="seg-switch" role="group" [attr.aria-label]="t('Tempo')" [title]="t('Tempo')">
      @for (s of speeds; track s) {
        <button type="button" [class.on]="player().speed() === s" [attr.aria-pressed]="player().speed() === s" (click)="player().setSpeed(s)">{{ s }}×</button>
      }
    </div>
    <span class="pos">
      @if (i > 0) {
        {{ t('Aufruf {no} von {total}', { no: i, total: length() }) }}
      } @else {
        {{ length() === 1 ? t('1 Aufruf') : t('{n} Aufrufe', { n: length() }) }}
      }
    </span>
    <span class="caption"><ng-content /></span>
    @if (i > 0) {
      <button type="button" class="ftool" (click)="player().reset()" [title]="t('Abfolge beenden: wieder alle Aufrufe gleich zeigen')">
        <app-icon name="close" [size]="12" /> {{ t('Beenden') }}
      </button>
    }
  `,
  styles: `
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; font-size: 12px; }
    button, .seg-switch, .pos { flex: none; }
    .ftool.icon { padding: 0 6px; }
    .ftool.play { border-color: var(--border-strong); color: var(--fg); }
    .ftool.play.on { border-color: var(--accent); }
    .pos { padding: 0 6px; color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* what is played now: takes the room that is left, and is cut off rather than pushing the buttons around */
    .caption { display: flex; align-items: center; gap: 6px; flex: 1 1 160px; min-width: 0; overflow: hidden; color: var(--fg-muted); white-space: nowrap; }
  `,
})
export class SequenceControls {
  readonly player = input.required<SequencePlayer>();
  /** number of calls of the sequence */
  readonly length = input.required<number>();
  protected readonly t = t;
  protected readonly speeds = PLAYER_SPEEDS;
}
