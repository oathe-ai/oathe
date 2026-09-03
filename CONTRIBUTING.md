# Contributing to Oathe

Oathe is an open-source runtime for autosave, handoff, and verification of agent work across harnesses. Contributions should preserve its core boundary: Oathe defines generic reliability primitives; organization-specific intelligence remains outside the project.

## Before you start

- Search existing issues before opening a new one.
- Use the bug, conformance, or proposal form so maintainers receive reproducible information.
- Discuss substantial changes before implementing them. New protocols, public APIs, persistence formats, security boundaries, or behavioral guarantees require an accepted design issue.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Contribution workflow

1. Fork the repository and create a focused branch.
2. Keep each pull request limited to one coherent change.
3. Add tests for the expected behavior, relevant failure modes, and a negative control when the change affects verification or conformance.
4. Update documentation, examples, schemas, and migration notes as applicable.
5. Complete the pull request template with the exact verification performed.
6. Respond to review feedback with additional commits; maintainers will squash the pull request when merging.

Pull requests execute as untrusted code. They must not require repository secrets, production credentials, privileged runners, or access to private infrastructure.

## Quality expectations

Contributions should be deterministic, reviewable, and reproducible. Prefer small units, explicit contracts, typed failures, and evidence that can be independently dereferenced. Avoid hidden network dependencies in tests.

Do not include:

- credentials, tokens, personal data, customer data, or proprietary material you do not have the right to distribute;
- code whose license is incompatible with Apache-2.0;
- generated or copied code whose provenance you cannot establish;
- bundled proprietary SDKs or dependencies that cannot legally be redistributed.

AI-assisted contributions are welcome, but the contributor remains responsible for correctness, provenance, licensing, security, and reviewability.

## Harness drift monitors

Every harness adapter (`src/harnesses/`) declares the facts it depends on: the documentation
pages (`docs`), how a runner installs the real CLI (`install`), and its headless run (`headless`).
Three lanes hold those facts to the world:

- **Harness docs drift** (daily) re-pulls every page in `harness-docs.lock.json` and fails loud
  when one changed — naming the page and the adapters that depend on it. It never blocks a PR.
- **Install contract** (every PR) installs each real CLI at `@latest` and proves `oathe init`
  against it through the doctor's row verification. It blocks merges.
- **Harness live contract** (nightly) runs one real headless session per harness and checks the
  hook payload, the transcript, and the output against the pinned fixtures.
- **Harbor conformance** (nightly) installs the Harbor pinned in `harbor-conformance.lock.json`,
  drives its converters on every trace fixture, and compares the structure against the reviewed
  baseline in that lock — fails loud on a divergence the baseline does not carry. It never
  blocks a PR.

When a lane goes red, the fix is a pin, never a silence:

1. Read the report (the issue the monitor opened, or the job log). The docs lane prints a
   `diff` command against your local snapshot; the live lane prints the field diff against
   `tests/fixtures/hooks/<harness>/`.
2. If behaviour changed, update the adapter fact — and add a NEW dated fixture beside the old
   one (`tests/fixtures/hooks/<harness>/<date>-<event>.json`); the contract suite must keep
   serving both shapes.
3. Re-pin the docs: `npm run pull-harness-docs && npm run harness-docs-lock`, and commit
   `harness-docs.lock.json` with the change that answers it. Re-pin the Harbor baseline the
   same way: `npm run harbor-conformance-lock` with `harbor` importable from `python3`, and
   commit `harbor-conformance.lock.json` with the converter change that explains the diff.

Run any lane locally: `npm run harness-docs-drift`, `npm run install-contract -- <harness>`,
`npm run live-contract -- <harness> --in-place` (your own login, no sandbox),
`npm run harbor-conformance` (with `harbor` on your `python3`).

## Review and merge

Every change is merged through a pull request. At least one independent maintainer and any applicable code owner must approve it, all review conversations must be resolved, and every required check must pass. Changes to workflows, release infrastructure, security policy, authority or effect boundaries, and verification contracts require heightened review under [GOVERNANCE.md](GOVERNANCE.md).

By submitting a contribution, you agree that it may be distributed under the repository's Apache-2.0 license.
