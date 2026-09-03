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

/** The resumption's word — a breach that continues into the work, and every working claim. */
export const CONTINUE_ACT = 'continue ↗';
export const KINDS = Object.freeze({
  reopened: Object.freeze({ word: 'rejected', bucket: 'fix', act: CONTINUE_ACT }),
  stalled: Object.freeze({ word: 'verify failed', bucket: 'fix', act: 'retry ↗' }),
  overdue: Object.freeze({ word: 'never verified', bucket: 'verify', act: 'verify ↗' }),
  quiet: Object.freeze({ word: 'quiet', bucket: 'quiet', act: CONTINUE_ACT }),
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

function single(breach) {
  return { ...breach, kind_word: KINDS[breach.kind].word, group: null };
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
  for (const child of children) byKind[child.kind] = (byKind[child.kind] ?? 0) + 1;
  const shown = sortedChildren.slice(0, DIGEST_ROW_CAP);
  const more = children.length - shown.length;
  const lead = own ?? members[0];
  const detail = [
    ...(own ? [own.detail] : []),
    ...shown.map((child) => `${child.task_id} · ${KINDS[child.kind].word} · ${child.detail}`),
    ...(more > 0 ? [`+${more} more`] : []),
  ].join('\n');
  return {
    kind: members[0].kind,
    kind_word: [...(own ? [KINDS[own.kind].word] : []), countWords(byKind)].join(' · '),
    task_id: own ? own.task_id : children[0].parent,
    objective: own ? own.objective : children[0].parent_objective,
    home: lead.home,
    home_ref: lead.home_ref,
    detail,
    at: members[0].at,
    group: { n: children.length, by_kind: byKind, children: shown.map((child) => child.task_id), more },
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
    this.counts = Object.fromEntries(BREACH_KINDS.map((kind) => [kind, 0]));
    for (const breach of breaches) this.counts[breach.kind] += 1;
    this.total = breaches.length;
    this.push = pushLine(this.counts);
    const { rows, rowOf } = groupSiblings(breaches);
    this.#rowOf = rowOf;
    this.groups = rows;
    this.rows = rows.slice(0, DIGEST_ROW_CAP);
    this.more = rows.length - this.rows.length;
  }

  /** This board's digest — the facts homed on `homeRef`; `null` is the whole machine (this). */
  scoped(homeRef) {
    if (homeRef === null) return this;
    return new BreachDigest({ breaches: this.#breaches.filter((breach) => breach.home_ref === homeRef) });
  }

  /** The digest over the rows `keep` accepts — a group is kept or dropped whole. */
  filter(keep) {
    return new BreachDigest({ breaches: this.#breaches.filter((breach) => keep(this.#rowOf.get(breach))) });
  }
}
