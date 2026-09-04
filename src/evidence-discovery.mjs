// oathe — evidence discovery: the read-time half of the evidence rails. The substrate's
// tool results echo each claim's UUID into whatever transcript the harness keeps, so the
// record self-fingerprints — a claim's evidence can be FOUND from the record alone, with no
// dependence on hooks, registration, or the speaker having known its session (the ChatGPT
// desktop class of false rejection, live 2026-08-31 and 2026-09-04: the work sat on disk
// while the verifier judged an empty record).
//
// Two rails, kept apart on purpose: trace-link statements stay the act-time ATTRIBUTION rail
// (board, notch, reclaim bundle — cheap, per act); discovery is the read-time EVIDENCE rail.
// gather() serves their union — the record's own word leads, discovery only ever adds.
//
// Membership is PERFORMANCE, never mention: a discovered file must project to a trajectory
// whose claim intervals name the task (an investigator's transcript contains the UUID; only
// the worker's contains the acts). The verifier's own transcript claims `verify:<task>`,
// never the task, so the judge's record stays out of the evidence it judges — the same line
// LINKABLE draws (src/wire.mjs).

import { traceStores, byName, transcriptFor } from './harnesses/catalog.mjs';
import { projectAnnotated } from './oathe-annotator.mjs';
import { claimIntervals } from './atif.mjs';
import { taskTraceLinksSql, TRACE_SUBJECT_PREFIX } from './statements.mjs';
import { TraceContractError } from './traces.mjs';

// Design constants, not tunables — no consumer has a story for turning them (founder ruling
// 2026-09-01: no speculative config). The skew absorbs clock drift between the substrate's
// claimed_at and the store's mtimes; the cap bounds one gather's disk read.
const CLAIM_CLOCK_SKEW_MS = 5 * 60_000;
const DISCOVERY_MAX_FILES = 4000;

async function defaultStoresFor({ home }) {
  const stores = [];
  for (const name of traceStores()) {
    const { traces } = byName(name);
    stores.push(await traces.store({ home }));
  }
  return stores;
}

export class EvidenceDiscovery {
  /**
   * @param {{client: {query: Function}, orgId: string, home?: string,
   *          storesFor?: ({home}) => Promise<object[]>, maxFiles?: number}} o
   *   client/orgId read the record; home roots the stores; storesFor and maxFiles are seams.
   */
  constructor({ client, orgId, home = undefined, storesFor = defaultStoresFor, maxFiles = DISCOVERY_MAX_FILES }) {
    this.client = client;
    this.orgId = orgId;
    this.home = home;
    this.storesFor = storesFor;
    this.maxFiles = maxFiles;
  }

  /** The task's recorded trace links, resolved to the files the sessions actually write. */
  async #linked(taskId) {
    const { rows } = await this.client.query(taskTraceLinksSql(), [this.orgId, taskId]);
    const paths = [];
    const seen = new Set();
    for (const row of rows) {
      const sessionId = row.subject_ref.slice(TRACE_SUBJECT_PREFIX.length);
      for (const ref of row.evidence_refs) {
        const file = transcriptFor({ sessionId, reportedPath: ref, home: this.home });
        if (seen.has(file)) continue;
        seen.add(file);
        paths.push(file);
      }
    }
    return paths;
  }

  /**
   * Does the record ATTEST attribution at all? A store-less surface (cursor) links with
   * empty evidence — that is attribution without a transcript, and it keeps the claim
   * judgeable; a task with no link and no discovery hit has an empty record instead.
   */
  async hasAttribution(taskId) {
    const { rows } = await this.client.query(taskTraceLinksSql(), [this.orgId, taskId]);
    return rows.length > 0;
  }

  /** Every claim ever taken on the task — the needles, and the window's opening. */
  async #claims(taskId) {
    const { rows } = await this.client.query(
      `SELECT work_claim_id, claimed_at FROM cell.work_claim
        WHERE org_id = $1 AND task_id = $2 ORDER BY claimed_at`,
      [this.orgId, taskId]);
    return rows;
  }

  /**
   * The whole evidence read for one task: recorded links ∪ fingerprint discovery, projected,
   * performance-confirmed (discovered only), deterministically ordered — linked first in the
   * record's own order, then discovered by store order and path. `unreadable` names every
   * store file in the window the byte scan could not read (by path and cause): reported, never
   * a stall — a file that cannot be read cannot be known to be this task's, and an unrelated
   * one must never block the task's own evidence (Greptile on PR #37, 2026-09-04). A file that
   * DOES name the claim and cannot project still refuses typed: that one may be the evidence.
   * @returns {Promise<{traces: Array<{path: string, trajectory: object, via: 'linked'|'discovered'}>,
   *                    unreadable: Array<{path: string, code: string, message: string}>}>}
   */
  async read({ taskId }) {
    const linked = await this.#linked(taskId);
    const claims = await this.#claims(taskId);
    const traces = [];
    const unreadable = [];
    for (const file of linked) {
      traces.push({ path: file, trajectory: await projectAnnotated(file, { home: this.home }), via: 'linked' });
    }
    if (claims.length === 0) return { traces, unreadable };

    const sinceMs = Date.parse(claims[0].claimed_at) - CLAIM_CLOCK_SKEW_MS;
    const needles = claims.map((c) => c.work_claim_id);
    const linkedSet = new Set(linked);
    for (const store of await this.storesFor({ home: this.home })) {
      let candidates;
      try {
        candidates = store.evidenceFiles({ sinceMs });
      } catch (e) {
        // A store that cannot be enumerated (its root vanished or unreadable mid-walk) is
        // reported like an unreadable file — the other stores still serve; never a stall.
        unreadable.push({ path: `${store.harness} store`, code: e?.code ?? 'ENUMERATION_FAILED', message: String(e?.message ?? e) });
        continue;
      }
      if (candidates.length > this.maxFiles) {
        throw new TraceContractError('TRACE_DISCOVERY_OVERFLOW',
          `the ${store.harness} store holds ${candidates.length} files in this claim's window `
          + `(cap ${this.maxFiles}) — refusing a partial scan; narrow the window or thin the store`,
          { harness: store.harness, candidates: candidates.length });
      }
      for (const file of candidates) {
        if (linkedSet.has(file)) continue;
        let names;
        try {
          names = needles.some((needle) => store.contains(file, needle));
        } catch (e) {
          if (!(e instanceof TraceContractError)) throw e;
          unreadable.push({ path: file, code: e.code, message: e.message });
          continue;
        }
        if (!names) continue;
        // The projector, not the byte scan, decides membership: performing, never mentioning.
        const trajectory = await projectAnnotated(file, { home: this.home });
        if (!claimIntervals(trajectory).some((i) => i.task_id === taskId)) continue;
        traces.push({ path: file, trajectory, via: 'discovered' });
      }
    }
    return { traces, unreadable };
  }

  /** The evidence alone — read() for a caller that has no use for the unreadable list. */
  async gather({ taskId }) {
    return (await this.read({ taskId })).traces;
  }
}
