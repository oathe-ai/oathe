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

## Review and merge

Every change is merged through a pull request. At least one independent maintainer and any applicable code owner must approve it, all review conversations must be resolved, and every required check must pass. Changes to workflows, release infrastructure, security policy, authority or effect boundaries, and verification contracts require heightened review under [GOVERNANCE.md](GOVERNANCE.md).

By submitting a contribution, you agree that it may be distributed under the repository's Apache-2.0 license.
