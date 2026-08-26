# Oathe governance

Oathe is maintained as an independent open-source project. Authority is earned through sustained, reviewable contribution and is separated by responsibility.

## Roles

- **Contributors** propose issues, designs, documentation, tests, and code through forks and pull requests.
- **Triagers** manage labels, reproduce reports, close duplicates, and moderate discussions. Triage does not grant merge or release authority.
- **Component reviewers** provide specialist review for defined areas but cannot merge solely because they reviewed a change.
- **Maintainers** review and merge pull requests, manage milestones, and uphold project boundaries and compatibility.
- **Security responders** receive private disclosures and coordinate remediation and publication.
- **Releasers** approve and execute the protected release process. Release credentials are not available to ordinary pull request workflows.
- **Repository administrators** manage GitHub settings and emergency recovery. Administrative access is not a substitute for normal review.

## Decisions

Small, reversible changes use lazy consensus through pull request review. Significant or difficult-to-reverse changes require a design issue describing the problem, alternatives, compatibility impact, security consequences, and migration path before implementation begins.

Maintainers seek consensus. If consensus cannot be reached, the maintainers responsible for the affected component record the decision and rationale in the design issue. Security responders may temporarily block a change or release while a credible security concern is evaluated.

## Reviews

All changes require an independent approval. Critical changes—including GitHub Actions workflows, release code, security boundaries, durable schemas, authority and effect handling, verification contracts, and licensing—require two maintainer reviews as the maintainer organization matures. Authors do not approve their own final push.

Emergency fixes may use a shortened process only when delay creates greater risk. The incident, bypass, verification, and follow-up review must be documented afterward.

## Becoming a project member

Triagers, reviewers, maintainers, security responders, and releasers are nominated by existing maintainers based on sustained contribution, technical judgment, constructive conduct, responsiveness, and demonstrated care with project trust boundaries. Access is least-privilege and reviewed periodically.

Inactive access may be removed after notice. Access is removed immediately when an account is compromised or its continued access creates a credible security risk.

## Releases

Releases are produced only from protected source, through the repository's release workflow, after required tests and approvals pass. Release artifacts should be reproducible, signed or attested where supported, accompanied by checksums and an SBOM, and published with migration and security notes when applicable.
