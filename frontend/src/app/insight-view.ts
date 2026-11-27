import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ComponentDiagram } from './component-diagram';
import { Icon } from './icon';
import { serverText, t } from './i18n';
import {
  FitnessResult, FitnessStatus, INSIGHTS, againstDirection, componentCycles, fileArea, fitness, fitnessSummary, flowMatrix, hotspots, layerMatrix, prMetrics,
} from './insights';
import { areaColor, areaLabel, langColor, langLabel } from './look';
import { ReviewStore } from './review.store';
import { groupedTreemap } from './treemap';

/** The drawing of the change map, in its own units (shown as wide as the page, positions in percent). */
const MAP = { w: 1000, h: 540 };
/** How many hotspots are listed. */
const HOTSPOTS = 25;

const STATUS: Record<FitnessStatus, { icon: string; label: string }> = {
  ok: { icon: 'check', label: 'erfüllt' },
  warn: { icon: 'warning', label: 'Hinweis' },
  fail: { icon: 'close', label: 'verletzt' },
  na: { icon: 'circle', label: 'nicht anwendbar' },
};

interface Bar {
  label: string;
  value: number;
  /** width in percent of the largest */
  width: number;
  color: string;
}

/**
 * A view across the whole pull request (insights.ts), chosen in the tree under "Übergreifende Ansichten &
 * Informationen": components, metrics, fitness functions, the matrix of the layers, hotspots, the change map and
 * the matrix of flows and components. Everything is computed from the analysis; a click leads to the code.
 */
@Component({
  selector: 'app-insight-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ComponentDiagram, Icon],
  template: `
    @let info = insight();
    <header class="head">
      <app-icon [name]="info.icon" [size]="20" />
      <div>
        <h1>{{ t(info.label) }}</h1>
        <p>{{ t(info.tip) }}</p>
      </div>
    </header>

    @switch (id()) {
      @case ('components') {
        <app-component-diagram />
      }

      @case ('metrics') {
        <div class="tiles">
          @for (tile of tiles(); track tile.label) {
            <div class="tile">
              <span class="tile-label">{{ t(tile.label) }}</span>
              <span class="tile-value">{{ tile.value }}</span>
              <span class="tile-sub">{{ tile.sub }}</span>
            </div>
          }
        </div>
        <div class="charts">
          @for (chart of charts(); track chart.label) {
            <section class="chart">
              <h2>{{ t(chart.label) }}</h2>
              @for (bar of chart.bars; track bar.label) {
                <div class="bar-row" [title]="bar.label + ': ' + t('{n} Zeilen', { n: bar.value })">
                  <span class="bar-label">{{ bar.label }}</span>
                  <span class="bar-track"><span class="bar" [style.width.%]="bar.width" [style.background]="bar.color"></span></span>
                  <span class="bar-value">{{ bar.value }}</span>
                </div>
              } @empty {
                <p class="muted">{{ t('Keine Daten.') }}</p>
              }
            </section>
          }
        </div>
      }

      @case ('fitness') {
        @let sum = summary();
        <p class="summary">
          <span class="st ok"><app-icon name="check" [size]="13" /> {{ t('{n} erfüllt', { n: sum.ok }) }}</span>
          <span class="st warn"><app-icon name="warning" [size]="13" /> {{ sum.warn === 1 ? t('1 Hinweis') : t('{n} Hinweise', { n: sum.warn }) }}</span>
          <span class="st fail"><app-icon name="close" [size]="13" /> {{ t('{n} verletzt', { n: sum.fail }) }}</span>
          <span class="muted">{{ t('Statisch aus der Analyse berechnet, mit festen Grenzwerten.') }}</span>
        </p>
        <div class="checks">
          @for (r of results(); track r.id) {
            <section class="check" [class]="'check ' + r.status">
              <span class="badge" [title]="t(status[r.status].label)"><app-icon [name]="status[r.status].icon" [size]="14" /></span>
              <div class="check-body">
                <h3>{{ t(r.label) }} <span class="state">{{ t(status[r.status].label) }}</span></h3>
                <p class="measure"><b>{{ r.value }}</b> <span class="muted">· {{ t('Grenze: {limit}', { limit: r.limit }) }}</span></p>
                <p class="why">{{ t(r.tip) }}</p>
                @if (r.details.length) {
                  <ul class="details">
                    @for (d of r.details; track $index) {
                      <li>{{ d }}</li>
                    }
                  </ul>
                }
              </div>
              @if (canOpen(r)) {
                <button type="button" class="ftool" (click)="more(r)" [title]="t('Die Ansicht dazu öffnen')">
                  {{ t('Ansehen') }} <app-icon name="chevronRight" [size]="12" />
                </button>
              }
            </section>
          }
        </div>
      }

      @case ('dependencies') {
        @let m = matrix();
        @if (m.areas.length === 0) {
          <p class="muted">{{ t('Keine Komponenten mit Code-Änderungen.') }}</p>
        } @else {
          <p class="muted">{{ t('Zeile ruft Spalte auf; die Zahl ist die Anzahl Aufrufe. Erwartet sind Aufrufe nach rechts oben (von aussen nach innen) und innerhalb einer Schicht.') }}</p>
          <div class="scroll">
            <table class="matrix">
              <thead>
                <tr>
                  <th class="corner">{{ t('ruft auf →') }}</th>
                  @for (a of m.areas; track a) {
                    <th><span class="area-dot" [style.background]="areaColor(a)"></span>{{ areaLabel(a) }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (from of m.areas; track from; let i = $index) {
                  <tr>
                    <th><span class="area-dot" [style.background]="areaColor(from)"></span>{{ areaLabel(from) }}</th>
                    @for (to of m.areas; track to; let j = $index) {
                      @let n = m.cells[i][j];
                      <td [class.self]="i === j" [class.against]="n > 0 && against(from, to)" [style.background]="tint(n, m.max)"
                          [title]="cellTitle(from, to, n)">
                        @if (n > 0) {
                          {{ n }}
                          @if (against(from, to)) {
                            <app-icon name="warning" [size]="11" />
                          }
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <h2>{{ t('Gegen die Richtung') }} <span class="h2-count">{{ m.violations.length }}</span></h2>
          @if (m.violations.length) {
            <ul class="list">
              @for (v of m.violations; track $index) {
                <li><app-icon name="warning" [size]="12" class="warn-ico" />
                  <b>{{ v.from }}</b> <span class="muted">({{ areaLabel(v.fromArea) }})</span> → <b>{{ v.to }}</b> <span class="muted">({{ areaLabel(v.toArea) }})</span>
                  <span class="muted">· {{ v.calls === 1 ? t('1 Aufruf') : t('{n} Aufrufe', { n: v.calls }) }}</span></li>
              }
            </ul>
          } @else {
            <p class="muted">{{ t('Alle Aufrufe laufen in der erwarteten Richtung.') }}</p>
          }
          <h2>{{ t('Zyklen zwischen Komponenten') }} <span class="h2-count">{{ cycles().length }}</span></h2>
          @if (cycles().length) {
            <ul class="list">
              @for (c of cycles(); track $index) {
                <li><app-icon name="refresh" [size]="12" class="fail-ico" /> {{ c.join(' ↔ ') }}</li>
              }
            </ul>
          } @else {
            <p class="muted">{{ t('Keine Komponenten rufen sich gegenseitig auf.') }}</p>
          }
        }
      }

      @case ('hotspots') {
        @let rows = hot();
        @if (rows.length === 0) {
          <p class="muted">{{ t('Keine geänderten, testbaren Funktionen: nichts, was als Hotspot zählt.') }}</p>
        } @else {
          <p class="muted">{{ t('Risiko = Σ geänderte Zeilen × (1 + Verzweigungen) der geänderten Funktionen × (1 + Flüsse) × (1 + Funktionen ohne Test). Klick öffnet die Datei.') }}</p>
          <div class="scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('Datei') }}</th>
                  <th>{{ t('Schicht') }}</th>
                  <th class="num" [title]="t('Geänderte Zeilen der Datei (neu und entfernt)')">{{ t('Zeilen') }}</th>
                  <th class="num" [title]="t('Geänderte, testbare Funktionen')">{{ t('Funktionen') }}</th>
                  <th class="num" [title]="t('Verzweigungen in diesen Funktionen (if, case, catch, Schleifen, &&, ||)')">{{ t('Verzweigungen') }}</th>
                  <th class="num" [title]="t('Datenflüsse mit einem Schritt in der Datei')">{{ t('Flüsse') }}</th>
                  <th class="num" [title]="t('Geänderte Funktionen, die kein Test erreicht')">{{ t('ohne Test') }}</th>
                  <th class="num" [title]="t('Commits des Pull Requests, die die Datei ändern')">Commits</th>
                  <th>{{ t('Risiko') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (h of rows; track h.path) {
                  <tr role="button" tabindex="0" (click)="openFile(h.path)" (keydown.enter)="openFile(h.path)" [title]="h.path">
                    <td class="path"><b>{{ fileName(h.path) }}</b> <span class="muted">{{ dirName(h.path) }}</span></td>
                    <td>@if (h.area) {<span class="area-dot" [style.background]="areaColor(h.area)"></span>{{ areaLabel(h.area) }}}</td>
                    <td class="num">{{ h.lines }}</td>
                    <td class="num">{{ h.functions }}</td>
                    <td class="num">{{ h.branches }}</td>
                    <td class="num">{{ h.flows || '' }}</td>
                    <td class="num" [class.bad]="h.untested > 0">{{ h.untested || '' }}</td>
                    <td class="num">{{ h.commits || '' }}</td>
                    <td class="score"><span class="bar-track"><span class="bar" [style.width.%]="(h.score / rows[0].score) * 100"></span></span> {{ h.score }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (hotTotal() > rows.length) {
            <p class="muted">{{ t('Die {n} Dateien mit dem höchsten Risiko von {total}.', { n: rows.length, total: hotTotal() }) }}</p>
          }
        }
      }

      @case ('map') {
        @let groups = map();
        @if (groups.length === 0) {
          <p class="muted">{{ t('Keine geänderten Dateien.') }}</p>
        } @else {
          <p class="muted">{{ t('Fläche = geänderte Zeilen der Datei, gruppiert nach Schicht. Ein Haken: alle Zeilen der Datei sind akzeptiert. Klick öffnet die Datei.') }}</p>
          <div class="map" [style.aspect-ratio]="mapBox.w + ' / ' + mapBox.h">
            @for (g of groups; track g.id) {
              <div class="map-group" [style.left.%]="x(g.rect.x)" [style.top.%]="y(g.rect.y)" [style.width.%]="x(g.rect.w)" [style.height.%]="y(g.rect.h)"
                   [style.--area]="areaColor(g.id || null)">
                @if (g.rect.h > 20 && g.rect.w > 46) {
                  <span class="map-head">{{ g.id ? areaLabel(g.id) : t('ohne Schicht') }} <span class="muted">{{ g.value }}</span></span>
                }
              </div>
              @for (f of g.items; track f.id) {
                @let p = fileProgress(f.id);
                <button type="button" class="map-tile" [class.done]="p.total > 0 && p.ok === p.total"
                        [style.left.%]="x(f.rect.x)" [style.top.%]="y(f.rect.y)" [style.width.%]="x(f.rect.w)" [style.height.%]="y(f.rect.h)"
                        [style.--area]="areaColor(g.id || null)" (click)="openFile(f.id)"
                        [title]="f.id + ' · ' + t('{n} Zeilen', { n: f.value }) + (p.total ? ' · ' + t('{ok}/{total} Zeilen ok', { ok: p.ok, total: p.total }) : '')">
                  @if (f.rect.w > 74 && f.rect.h > 22) {
                    <span class="map-name">{{ fileName(f.id) }}</span>
                  }
                  @if (f.rect.w > 74 && f.rect.h > 40) {
                    <span class="map-lines">{{ f.value }}</span>
                  }
                  @if (p.total > 0 && p.ok === p.total && f.rect.w > 22 && f.rect.h > 22) {
                    <app-icon name="check" [size]="12" class="map-ok" />
                  }
                </button>
              }
            }
          </div>
        }
      }

      @case ('flow-matrix') {
        @let fm = flows();
        @if (fm.flows.length === 0 || fm.components.length === 0) {
          <p class="muted">{{ t('Keine Datenflüsse durch geänderte Komponenten.') }}</p>
        } @else {
          <p class="muted">{{ t('Die Zahl ist die Anzahl Schritte des Flusses in der Komponente. Eine Komponente in mehreren Flüssen ist hervorgehoben: Wer sie ändert, ändert alle diese Flüsse.') }}
            {{ fm.shared === 1 ? t('1 Komponente wird geteilt.') : t('{n} Komponenten werden geteilt.', { n: fm.shared }) }}</p>
          <div class="scroll">
            <table class="matrix flows">
              <thead>
                <tr>
                  <th class="corner">{{ t('Datenfluss') }}</th>
                  @for (c of fm.components; track c.id) {
                    <th class="vert" [class.shared]="c.flows > 1" [title]="c.name + ' · ' + areaLabel(c.area)">
                      <span><span class="area-dot" [style.background]="areaColor(c.area)"></span>{{ c.name }}</span>
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (f of fm.flows; track f.id; let i = $index) {
                  <tr>
                    <th class="flow-name"><button type="button" class="link" (click)="openFlow(f.id)" [title]="serverText(f.title)">{{ serverText(f.title) }}</button>
                      <span class="muted">{{ f.steps }}</span></th>
                    @for (c of fm.components; track c.id; let j = $index) {
                      @let n = fm.cells[i][j];
                      <td [class.shared]="n > 0 && c.flows > 1" [style.background]="tint(n, f.steps)" [title]="n ? serverText(f.title) + ' · ' + c.name + ': ' + n : ''">{{ n || '' }}</td>
                    }
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <th>{{ t('Flüsse durch die Komponente') }}</th>
                  @for (c of fm.components; track c.id) {
                    <td [class.shared]="c.flows > 1">{{ c.flows }}</td>
                  }
                </tr>
              </tfoot>
            </table>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 1200px; padding-bottom: 48px; }
    .head { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 18px; color: var(--fg-muted); }
    .head h1 { margin: 0 0 3px; font-size: 18px; font-weight: 600; color: var(--fg); }
    .head p { margin: 0; max-width: 820px; font-size: 12.5px; }
    h2 { margin: 24px 0 8px; font-size: 13px; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .h2-count { margin-left: 4px; padding: 0 6px; border-radius: 8px; background: var(--bg-hover); color: var(--fg-muted); font-size: 11px; }
    .muted { color: var(--fg-muted); font-size: 12px; }
    p.muted { margin: 0 0 10px; max-width: 900px; }
    .scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); }
    .area-dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 2px; vertical-align: 0; }

    /* metrics: the headline numbers as tiles, the distributions as bars */
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
    .tile { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); }
    .tile-label { color: var(--fg-muted); font-size: 11.5px; }
    .tile-value { color: var(--fg); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
    .tile-sub { min-height: 15px; color: var(--fg-dim); font-size: 11.5px; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 28px; }
    .bar-row { display: grid; grid-template-columns: minmax(90px, 34%) 1fr 48px; align-items: center; gap: 10px; height: 22px; font-size: 12px; }
    .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
    .bar-track { display: block; height: 8px; border-radius: 4px; background: var(--tint-hover); }
    .bar { display: block; height: 8px; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--accent); }
    .bar-value { color: var(--fg-muted); text-align: right; font-variant-numeric: tabular-nums; }

    /* fitness functions */
    .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 0 0 12px; font-size: 12.5px; }
    .st { display: inline-flex; align-items: center; gap: 5px; color: var(--fg); font-weight: 600; }
    .st.ok app-icon { color: var(--ok); }
    .st.warn app-icon { color: var(--warn); }
    .st.fail app-icon { color: var(--del-fg); }
    .checks { display: flex; flex-direction: column; gap: 8px; }
    .check { display: flex; gap: 12px; align-items: flex-start; padding: 11px 12px; border: 1px solid var(--border); border-left: 4px solid var(--st); border-radius: 8px;
      background: var(--bg-panel-2); --st: var(--border-strong); }
    .check.ok { --st: var(--ok); }
    .check.warn { --st: var(--warn); }
    .check.fail { --st: var(--del-fg); }
    .badge { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--st);
      background: color-mix(in srgb, var(--st) 16%, transparent); }
    .check-body { flex: 1; min-width: 0; }
    .check h3 { margin: 0 0 3px; font-size: 13px; font-weight: 600; color: var(--fg); }
    .state { margin-left: 6px; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--st) 55%, transparent); border-radius: 8px; color: var(--fg-muted);
      font-size: 10.5px; font-weight: 500; }
    .measure { margin: 0 0 3px; font-size: 12.5px; color: var(--fg); }
    .why { margin: 0; max-width: 860px; color: var(--fg-muted); font-size: 12px; }
    .details { margin: 6px 0 0; padding-left: 18px; color: var(--fg); font: 11.5px/1.6 var(--font-code); }
    .check .ftool { flex: none; }

    /* matrices */
    .matrix { border-collapse: collapse; font-size: 12px; }
    .matrix th, .matrix td { padding: 0 10px; height: 30px; border: 1px solid var(--border); white-space: nowrap; }
    .matrix th { background: var(--bg-panel); color: var(--fg); font-weight: 500; text-align: left; }
    .matrix .corner { color: var(--fg-dim); font-weight: 400; }
    .matrix td { min-width: 44px; color: var(--fg); text-align: center; font-variant-numeric: tabular-nums; }
    .matrix td.self { box-shadow: inset 0 0 0 1px var(--border-strong); }
    .matrix td.against { box-shadow: inset 0 0 0 2px var(--warn); font-weight: 700; }
    .matrix td.against app-icon { color: var(--warn); vertical-align: -1px; }
    .matrix.flows th.vert { height: 150px; padding: 6px 4px; vertical-align: bottom; text-align: left; }
    .matrix.flows th.vert > span { display: inline-block; max-height: 138px; overflow: hidden; text-overflow: ellipsis; writing-mode: vertical-rl; transform: rotate(180deg);
      font-family: var(--font-code); font-size: 11.5px; }
    .matrix.flows th.vert .area-dot { margin: 0 0 6px; }
    .matrix.flows .shared { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent); }
    .matrix.flows th.shared { color: var(--fg); font-weight: 700; }
    .matrix.flows tfoot th, .matrix.flows tfoot td { color: var(--fg-muted); font-size: 11.5px; }
    .flow-name { max-width: 380px; }
    .flow-name .muted { margin-left: 6px; }
    .link { max-width: 330px; padding: 0; border: 0; background: none; color: var(--accent-fg); font: 500 11.5px var(--font-code); cursor: pointer; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .link:hover { text-decoration: underline; }
    .list { margin: 0; padding: 0; list-style: none; font-size: 12.5px; }
    .list li { padding: 3px 0; }
    .list b { font: 600 12px var(--font-code); color: var(--fg); }
    .warn-ico { color: var(--warn); vertical-align: -2px; margin-right: 4px; }
    .fail-ico { color: var(--del-fg); vertical-align: -2px; margin-right: 4px; }

    /* hotspots */
    .table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .table th { padding: 7px 10px; border-bottom: 1px solid var(--border); background: var(--bg-panel); color: var(--fg-muted); font-weight: 500; text-align: left; white-space: nowrap; }
    .table td { padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--fg); white-space: nowrap; }
    .table tbody tr { cursor: pointer; }
    .table tbody tr:hover { background: var(--bg-hover); }
    .table tbody tr:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
    .table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .table td.bad { color: var(--del-fg); font-weight: 700; }
    .path b { font: 600 12px var(--font-code); }
    .path .muted { margin-left: 6px; font-size: 11px; }
    .path { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .score { min-width: 120px; font-variant-numeric: tabular-nums; }
    .score .bar-track { display: inline-block; width: 64px; margin-right: 8px; vertical-align: 1px; }

    /* change map: a treemap in two levels */
    .map { position: relative; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); overflow: hidden; }
    .map-group { position: absolute; box-sizing: border-box; border: 2px solid var(--bg-panel-2); border-radius: 6px;
      background: color-mix(in srgb, var(--area) 9%, var(--bg-panel)); }
    .map-head { display: block; padding: 2px 7px 0; overflow: hidden; color: var(--fg); font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; line-height: 15px; }
    .map-head .muted { margin-left: 4px; font-size: 10.5px; font-weight: 400; }
    .map-tile { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 3px 6px; overflow: hidden;
      border: 1px solid var(--bg-panel-2); border-radius: 4px; background: color-mix(in srgb, var(--area) 34%, var(--bg-editor)); color: var(--fg); font: inherit;
      text-align: left; cursor: pointer; }
    .map-tile:hover, .map-tile:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; z-index: 1; }
    .map-tile.done { background: color-mix(in srgb, var(--area) 12%, var(--bg-editor)); }
    .map-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11px var(--font-code); }
    .map-lines { color: var(--fg-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
    .map-ok { position: absolute; right: 3px; bottom: 3px; color: var(--ok); }
  `,
})
export class InsightView {
  protected readonly store = inject(ReviewStore);
  /** id of the view (INSIGHTS) */
  readonly id = input.required<string>();
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly areaColor = areaColor;
  protected readonly areaLabel = areaLabel;
  protected readonly status = STATUS;
  protected readonly mapBox = MAP;

  protected readonly insight = computed(() => INSIGHTS.find((i) => i.id === this.id()) ?? INSIGHTS[0]);
  private readonly bundle = computed(() => this.store.bundle()!);

  // ------------------------------------------------------------------ metrics
  private readonly metrics = computed(() => prMetrics(this.bundle()));
  protected readonly tiles = computed(() => {
    const m = this.metrics();
    const p = this.store.totalProgress();
    const percent = (share: number) => Math.round(share * 100) + ' %';
    const commits = this.store.commits()?.commits.length;
    return [
      { label: 'Geänderte Zeilen', value: String(m.additions + m.deletions), sub: `+${m.additions} −${m.deletions}` },
      { label: 'Dateien', value: String(m.files), sub: t('{n} Sprachen', { n: m.byLanguage.length }) },
      { label: 'Blöcke', value: String(m.blocks), sub: t('davon {n} Funktionen und Methoden', { n: m.functions }) },
      { label: 'Datenflüsse', value: String(m.flows), sub: m.flows ? t('längster Fluss: {n} Schritte', { n: m.longestFlow }) : '' },
      { label: 'Komponenten', value: String(m.components), sub: t('in {n} Schichten', { n: m.layers }) },
      { label: 'Commits', value: commits == null ? '…' : String(commits), sub: '' },
      { label: 'Anteil Tests', value: percent(m.testShare), sub: t('{n} geänderte Zeilen in Tests', { n: m.testLines }) },
      { label: 'Review-Fortschritt', value: percent(p.total ? p.ok / p.total : 0), sub: t('{ok}/{total} Zeilen ok', { ok: p.ok, total: p.total }) },
    ];
  });
  protected readonly charts = computed(() => {
    const m = this.metrics();
    const categories = new Map(this.bundle().analysis.categories.map((c) => [c.id, serverText(c.label)]));
    const bars = (shares: { id: string; value: number }[], label: (id: string) => string, color: (id: string) => string): Bar[] => {
      const max = Math.max(1, ...shares.map((s) => s.value));
      return shares.map((s) => ({ label: label(s.id), value: s.value, width: (s.value / max) * 100, color: color(s.id) }));
    };
    return [
      { label: 'Geänderte Zeilen nach Schicht', bars: bars(m.byArea, (id) => (id ? areaLabel(id) : t('ohne Schicht')), (id) => areaColor(id || null)) },
      { label: 'Geänderte Zeilen nach Sprache', bars: bars(m.byLanguage, (id) => langLabel(id) || id || t('andere'), (id) => langColor(id)) },
      { label: 'Geänderte Zeilen nach Kategorie', bars: bars(m.byCategory, (id) => categories.get(id) ?? id, () => 'var(--accent)') },
    ];
  });

  // ------------------------------------------------------------------ fitness functions
  protected readonly results = computed(() => fitness(this.bundle()));
  protected readonly summary = computed(() => fitnessSummary(this.results()));

  /** Is there a view that shows more about this fitness function? */
  protected canOpen(r: FitnessResult): boolean {
    return r.more === 'coverage' ? this.store.coverage().size > 0 : r.more != null;
  }

  protected more(r: FitnessResult): void {
    if (r.more === 'coverage') {
      this.store.openCoverage();
    } else if (r.more) {
      this.store.select({ kind: 'insight', id: r.more });
    }
  }

  // ------------------------------------------------------------------ dependencies
  protected readonly matrix = computed(() => layerMatrix(this.bundle().analysis.components, this.bundle().analysis.componentEdges));
  protected readonly cycles = computed(() => componentCycles(this.bundle().analysis.components, this.bundle().analysis.componentEdges));
  protected readonly against = againstDirection;

  /** The tint of a cell: one hue, stronger with the value (none for 0). */
  protected tint(value: number, max: number): string {
    return value > 0 && max > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(12 + 40 * Math.min(1, value / max))}%, transparent)` : '';
  }

  protected cellTitle(from: string, to: string, calls: number): string {
    if (!calls) {
      return '';
    }
    const text = t('{from} → {to}: {n} Aufrufe', { from: areaLabel(from), to: areaLabel(to), n: calls });
    return againstDirection(from, to) ? text + '\n' + t('Gegen die erwartete Richtung') : text;
  }

  // ------------------------------------------------------------------ hotspots
  private readonly allHot = computed(() => hotspots(this.bundle(), this.store.commits()?.commits ?? []));
  protected readonly hot = computed(() => this.allHot().slice(0, HOTSPOTS));
  protected readonly hotTotal = computed(() => this.allHot().length);

  // ------------------------------------------------------------------ change map
  protected readonly map = computed(() => {
    const b = this.bundle();
    const areas = this.store.areaBySegment();
    return groupedTreemap(
      b.files.map((f) => ({ id: f.path, group: fileArea(b.analysis.segments, f.path, areas) ?? '', value: f.additions + f.deletions })),
      { x: 0, y: 0, w: MAP.w, h: MAP.h },
    );
  });

  protected x(value: number): number {
    return (value / MAP.w) * 100;
  }

  protected y(value: number): number {
    return (value / MAP.h) * 100;
  }

  protected fileProgress(path: string) {
    return this.store.progressOf(this.store.slotsFor({ kind: 'file', path }));
  }

  // ------------------------------------------------------------------ flows × components
  protected readonly flows = computed(() => flowMatrix(this.bundle()));

  // ------------------------------------------------------------------ navigation
  protected openFile(path: string): void {
    this.store.select({ kind: 'file', path });
  }

  protected openFlow(id: string): void {
    this.store.select({ kind: 'flow', id });
  }

  protected fileName(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1);
  }

  protected dirName(path: string): string {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  }
}
