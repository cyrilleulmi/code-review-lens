import { EdgeCoverage, TestCoverage, TestProfile } from './api';

/**
 * HTTP-Tests in words: a test that sends a real HTTP request to a changed endpoint reaches it directly, and what the
 * endpoint calls indirectly (TestCoverage.http); a REST edge of a flow lists both sides of its contract (EdgeCoverage
 * clientTests / serverTests). Pure helpers for the coverage, the test overview, the code blocks and the flow view.
 */

/** The short tag on a chip of a reach over HTTP. */
export const HTTP_TAG = 'HTTP';

/** The label of a REST edge whose contract both sides check. */
export const BOTH_SIDES_LABEL = 'beidseitig geprüft';

/** The reach of a segment in a test's covers when it goes over HTTP; null otherwise (also for a mocked reach). */
export function httpCover(covers: TestCoverage[] | null | undefined, segmentId: string): TestCoverage | null {
  const c = (covers ?? []).find((x) => x.segmentId === segmentId);
  return c?.http && !c.mocked ? c : null;
}

/** Tooltip part of a reach over HTTP: the request for the endpoint itself, the way for what it calls. */
export function httpTitle(c: TestCoverage): string {
  return c.direct
    ? `über HTTP: der Test schickt ${c.endpoint ? c.endpoint + ' ' : 'eine Anfrage '}an diesen Endpunkt`
    : 'über HTTP: der Test ruft einen geänderten Endpunkt auf, der diese Funktion erreicht';
}

/** How a test reaches a segment, for its link list: «direkt über HTTP: PUT /api/x/{} · Testzeile 7», «über update (HTTP)». */
export function reachText(c: { direct: boolean; line: number | null; via: string | null; http?: boolean; endpoint?: string | null }): string {
  const line = c.line ? ' · Testzeile ' + c.line : '';
  if (c.direct) {
    return c.http ? `direkt über HTTP${c.endpoint ? ': ' + c.endpoint : ''}${line}` : 'direkt' + line;
  }
  return 'über ' + c.via + (c.http ? ' (HTTP)' : '');
}

/**
 * The targets of a profile, an endpoint reached over HTTP with its request: «update (PUT /api/players/{})».
 * nameOf: the symbol name (no container) of a segment id.
 */
export function targetLabels(profile: TestProfile, covers: TestCoverage[] | null | undefined,
                             nameOf: (segmentId: string) => string | null | undefined): string[] {
  const endpoints = new Map<string, string>();
  for (const c of covers ?? []) {
    const name = c.http && c.direct && !c.mocked && c.endpoint ? nameOf(c.segmentId) : null;
    if (name && !endpoints.has(name)) endpoints.set(name, c.endpoint!);
  }
  return profile.targets.map((t) => (endpoints.has(t) ? `${t} (${endpoints.get(t)})` : t));
}

/** Both sides of a REST edge are checked: a client test expects the request, a server test sends it. */
export function bothSides(edge: EdgeCoverage | null | undefined): boolean {
  return !!edge?.clientTests?.length && !!edge?.serverTests?.length;
}

/**
 * The contract lines of a REST edge for its tooltip (empty when neither side has such tests). request: the endpoint
 * of the edge («PUT /api/players/{}»), name: test name by id.
 */
export function contractLines(edge: EdgeCoverage | null | undefined, request: string, name: (id: string) => string): string[] {
  const client = edge?.clientTests ?? [];
  const server = edge?.serverTests ?? [];
  if (!client.length && !server.length) return [];
  const lines: string[] = [];
  if (client.length && server.length) {
    lines.push(`${BOTH_SIDES_LABEL}: Frontend erwartet ${request}, Backend-Test ruft ihn auf`);
  } else if (client.length) {
    lines.push(`nur Frontend geprüft: erwartet ${request}, kein Backend-Test ruft ihn über HTTP auf`);
  } else {
    lines.push(`nur Backend geprüft: ein Test ruft ${request} über HTTP auf, kein Frontend-Test erwartet die Anfrage`);
  }
  if (client.length) lines.push(`Frontend (erwartet die Anfrage): ${list(client.map(name))}`);
  if (server.length) lines.push(`Backend (ruft über HTTP auf): ${list(server.map(name))}`);
  return lines;
}

function list(names: string[], max = 4): string {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} und ${names.length - max} weitere`;
}
