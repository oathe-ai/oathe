// oathe — the BreachDigest: the ONE budget over the pager's facts.
//
// The pager (src/pager.mjs) reads conditions and hands over whole rows; every surface that
// shows a breach — SessionStart context, the launch splash, tool attention, `oathe ls`, the
// glass — reads THIS digest and words it, never computing its own. R-PAGER + ruling 2
// (2026-09-01): one row per task, or per sibling group — children spawned under one claim
// are one row under the group's sharpest breach, and a child never has its own row while
// its parent is in view. UX rule 18: a digest is a budget, not a wall — sharpest first,
// DIGEST_ROW_CAP rows, then one `+N more` that names the pull; a rendered detail is clipped
// by its renderer, the data stays whole. Pure and synchronous: facts in, a budget out.
//
// Every word about a kind lives in KINDS — its person word (`rejected`), its push bucket
// (`to fix`), its one act (`continue ↗`) — and the kinds' order IS the sharpness order.
// Nothing about a kind is spelled twice: the glass reads the words off the frame, the
// renderers read them off the rows.

import { Place } from './home.mjs';

/** The resumption's word — a breach that continues into the work, and every working claim. */
export const CONTINUE_ACT = 'continue ↗';
export const KINDS = Object.freeze({
  reopened: Object.freeze({ word: 'rejected', bucket: 'fix', act: CONTINUE_ACT }),
  stalled: Object.freeze({ word: 'verify failed', bucket: 'fix', act: 'retry ↗' }),
  overdue: Object.freeze({ word: 'never verified', bucket: 'verify', act: 'verify ↗' }),
  quiet: Object.freeze({ word: 'quiet', bucket: 'quiet', act: CONTINUE_ACT }),
});
/** The act a stall whose engine is out of date offers instead of retry (ruling 2026-09-05). */
export const UPDATE_ACT = 'update ↗';
/** The one sentence an open-app act shows on the row it expands (ruling 2026-09-05): the line is on the clipboard, the app's word is its adapter's. */
export const OPEN_APP_FLASH = (app) => `command copied — paste in ${app} to continue`;
/**
 * The in-flight states ON a breach — ONE table (rulings 2026-09-04/05): a system claim is held,
 * so the machine is doing the thing the row would otherwise ask for. `verify`: a judge holds
 * `verify:<task>`. `update`: the machine holds `update:<engine>` and the row's stall names that
 * engine as out of date. Either way the row says so, wears no failure, offers no act (the glass
 * never offers an act it would refuse), and is not counted (nothing to act on). The pager stamps
 * a row's `busy_word`/`busy_detail` from here; the digest and the glass render them and add nothing.
 */
export const IN_FLIGHT = Object.freeze({
  verify: Object.freeze({ word: 'verifying', detail: 'a verifier holds it — the verdict lands on the glass' }),
  update: Object.freeze({
    word: (name) => `updating ${name}`,
    detail: (name) => `${name} is updating — the judgment re-runs when it lands`,
  }),
});
/**
 * The judgment an ASSERTED claim awaits (ruling 2026-09-04: nothing is invisible between done
 * and verdict): `verifying` while a judge holds the verify claim — IN_FLIGHT.verify's word,
 * spelled once, with the spinner — and `awaiting` until one does. Keyed by the board's
 * `judgment`; every surface renders these words and adds nothing.
 */
export const JUDGMENT = Object.freeze({
  verifying: Object.freeze({ word: IN_FLIGHT.verify.word, busy: true }),
  awaiting: Object.freeze({ word: 'awaiting verdict', busy: false }),
});
/** The push buckets, in the order the one ambient line speaks them. */
export const BUCKET_WORDS = Object.freeze({ fix: 'to fix', verify: 'to verify', quiet: 'gone quiet' });
/** The kinds in sharpness order: a verdict that came back first, an unjudged assertion last. */
export const BREACH_KINDS = Object.freeze(Object.keys(KINDS));
/** Rows a surface shows before `+N more` — the glass sheet (Theme.swift rowCap) is sized for eight. */
export const DIGEST_ROW_CAP = 8;
/** A rendered detail's width; the whole text rides the row for the card and oathe_board. */
export const DETAIL_CLIP = 160;

// The pull each channel points at when the budget is exceeded — worded once, placed by the
// renderer. The glass gets the number, never a sentence (its `+N more` row is its own).
const PULL = Object.freeze({
  context: 'oathe_board lists every breach on this board; `oathe ls` every one on this machine',
  splash: 'oathe ls',
  attention: 'oathe_board lists every breach on this board',
});

export class DigestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DigestError';
    this.code = code;
  }
}

/** The one order every breach list is in: kind rank, then the breach's own clock, then id. */
export function breachOrder(a, b) {
  return (BREACH_KINDS.indexOf(a.kind) - BREACH_KINDS.indexOf(b.kind))
    || String(a.at ?? '').localeCompare(String(b.at ?? ''))
    || String(a.task_id).localeCompare(String(b.task_id));
}

export function clip(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function clipDetail(text) {
  return clip(text, DETAIL_CLIP);
}

/** A row's one-line form for a text surface: a single is its detail, clipped; a group its spawn count. */
export function rowLine(row) {
  return row.group ? `${row.group.n} spawned` : clipDetail(row.detail);
}

export function pullPointer(channel, more) {
  const pull = PULL[channel];
  if (!pull) {
    throw new DigestError('OATHE_DIGEST_CHANNEL_UNKNOWN',
      `no pull wording for channel '${channel}' (known: ${Object.keys(PULL).join(', ')})`);
  }
  return more > 0 ? `+${more} more — ${pull}` : null;
}

/** `19 rejected · 1 verify failed` — kinds in sharpness order, zero counts omitted. */
function countWords(byKind) {
  return BREACH_KINDS.filter((kind) => byKind[kind]).map((kind) => `${byKind[kind]} ${KINDS[kind].word}`).join(' · ');
}

function pushLine(counts) {
  const byBucket = {};
  for (const kind of BREACH_KINDS) byBucket[KINDS[kind].bucket] = (byBucket[KINDS[kind].bucket] ?? 0) + counts[kind];
  const parts = Object.keys(BUCKET_WORDS).filter((bucket) => byBucket[bucket] > 0)
    .map((bucket) => `${byBucket[bucket]} ${BUCKET_WORDS[bucket]}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A member's word: the kind's, unless its judgment is in flight. */
// A busy row wears the in-flight words the pager stamped (IN_FLIGHT); a busy row without them is
// not a row the pager made — refused, never defaulted (zero legacy, 2026-09-05).
const busyWords = (breach) => {
  if (typeof breach.busy_word !== 'string' || typeof breach.busy_detail !== 'string') {
    throw new DigestError('OATHE_DIGEST_BUSY_UNWORDED', `busy breach '${breach.task_id}' carries no busy_word/busy_detail — the pager stamps both`, { task_id: breach.task_id });
  }
  return { word: breach.busy_word, detail: breach.busy_detail };
};
const busyWord = (breach) => busyWords(breach).word;
const busyDetail = (breach) => busyWords(breach).detail;
const wordOf = (breach) => (breach.busy ? busyWord(breach) : KINDS[breach.kind].word);

function single(breach) {
  return breach.busy
    ? { ...breach, busy: true, kind_word: busyWord(breach), detail: busyDetail(breach), group: null }
    : { ...breach, busy: false, kind_word: KINDS[breach.kind].word, group: null };
}

/**
 * One row for a parent and the children spawned under it. `own` is the parent's own breach
 * when it has one (its facts lead the row); otherwise the row is synthesized from what the
 * children know of their parent. The row's kind is the sharpest among all members; its
 * clock is the oldest member of that kind, which is what a person reads as the age.
 */
function groupRow(own, children) {
  const members = [...(own ? [own] : []), ...children].sort(breachOrder);
  const sortedChildren = [...children].sort(breachOrder);
  const byKind = {};
  let busyChildren = 0;
  for (const child of children) {
    if (child.busy) busyChildren += 1;
    else byKind[child.kind] = (byKind[child.kind] ?? 0) + 1;
  }
  const shown = sortedChildren.slice(0, DIGEST_ROW_CAP);
  const more = children.length - shown.length;
  const lead = own ?? members[0];
  const detail = [
    ...(own ? [own.busy ? busyDetail(own) : own.detail] : []),
    ...shown.map((child) => `${child.task_id} · ${wordOf(child)} · ${child.busy ? busyDetail(child) : child.detail}`),
    ...(more > 0 ? [`+${more} more`] : []),
  ].join('\n');
  // The one act a verify-led group offers targets its oldest child whose judgment is NOT in
  // flight — a child being judged is not retried; none idle → the row offers no act.
  const retry = sortedChildren.find((child) => !child.busy)?.task_id ?? null;
  return {
    kind: members[0].kind,
    kind_word: [
      ...(own ? [wordOf(own)] : []),
      countWords(byKind),
      ...(busyChildren > 0 ? [`${busyChildren} ${IN_FLIGHT.verify.word}`] : []),
    ].filter(Boolean).join(' · '),
    task_id: own ? own.task_id : children[0].parent,
    objective: own ? own.objective : children[0].parent_objective,
    home: lead.home,
    home_ref: lead.home_ref,
    place: lead.place ?? null,
    places: lead.places ?? [],
    detail,
    at: members[0].at,
    busy: own?.busy === true,
    group: { n: children.length, by_kind: byKind, children: shown.map((child) => child.task_id), more, retry },
  };
}

/** Rows in breach order, and each breach's row (a single is its own; a child's is its parent's). */
function groupSiblings(breaches) {
  const childrenOf = new Map();
  for (const breach of breaches) {
    if (!breach.parent) continue;
    if (!childrenOf.has(breach.parent)) childrenOf.set(breach.parent, []);
    childrenOf.get(breach.parent).push(breach);
  }
  const rowOf = new Map();
  const place = (row, members) => { for (const member of members) rowOf.set(member, row); return row; };
  const rows = [];
  for (const breach of breaches) {
    if (breach.parent) continue;
    const children = childrenOf.get(breach.task_id) ?? [];
    childrenOf.delete(breach.task_id);
    rows.push(children.length > 0 ? place(groupRow(breach, children), [breach, ...children]) : place(single(breach), [breach]));
  }
  for (const children of childrenOf.values()) rows.push(place(groupRow(null, children), children));
  return { rows: rows.sort(breachOrder), rowOf };
}

export class BreachDigest {
  #breaches;
  #rowOf;

  /** @param {{breaches: object[]}} o  the pager's rows, whole */
  constructor({ breaches }) {
    for (const breach of breaches) {
      if (!(breach.kind in KINDS)) {
        throw new DigestError('OATHE_DIGEST_KIND_UNKNOWN',
          `breach '${breach.task_id}' has kind '${breach.kind}' — the digest knows ${BREACH_KINDS.join(', ')}`);
      }
    }
    this.#breaches = breaches;
    // A judgment in flight is not a breach to act on: it keeps its row (a person sees it
    // verifying) and leaves every count — the ambient line, attention, the model channel.
    this.counts = Object.fromEntries(BREACH_KINDS.map((kind) => [kind, 0]));
    for (const breach of breaches) if (!breach.busy) this.counts[breach.kind] += 1;
    this.total = breaches.length;
    this.push = pushLine(this.counts);
    const { rows, rowOf } = groupSiblings(breaches);
    this.#rowOf = rowOf;
    this.groups = rows;
    this.rows = rows.slice(0, DIGEST_ROW_CAP);
    this.more = rows.length - this.rows.length;
  }

  /** This board's digest — the facts homed on `homeRef`; `null` is the whole machine (this). */
  scoped(workspaceRef) {
    if (workspaceRef === null) return this;
    // A breach belongs to EVERY folder that ever picked its task up (ruling 2026-09-05) — the
    // row's `places` — never only to where it resides now.
    const here = String(Place.workspace(workspaceRef));
    return new BreachDigest({ breaches: this.#breaches.filter((breach) => (breach.places ?? []).includes(here)) });
  }

  /** The digest over the rows `keep` accepts — a group is kept or dropped whole. */
  filter(keep) {
    return new BreachDigest({ breaches: this.#breaches.filter((breach) => keep(this.#rowOf.get(breach))) });
  }
}
