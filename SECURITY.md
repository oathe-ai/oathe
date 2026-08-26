# Security policy

## Supported versions

Oathe is currently pre-release. Security fixes are applied to the latest development version and, once releases begin, to versions explicitly listed as supported in release documentation.

## Reporting a vulnerability

Do not open a public issue or discussion for an undisclosed vulnerability. Use GitHub's **Report a vulnerability** flow for this repository:

https://github.com/oathe-ai/oathe/security/advisories/new

Include the affected version or commit, impact, prerequisites, a minimal reproduction, and any suggested mitigation. Remove unrelated secrets, personal data, and customer information.

The security team will acknowledge credible reports, coordinate validation and remediation privately, and work with the reporter on disclosure timing. Please do not disclose the issue publicly until a fix or coordinated advisory is available.

## Scope

Security-sensitive areas include authority and attempt fencing, effect execution and reconciliation, credential or capability provisioning, durable state, handoff integrity, adapter isolation, verification and settlement, build and release infrastructure, and any path that crosses a trust boundary.

Good-faith research that avoids privacy violations, data destruction, service disruption, and access beyond what is needed to demonstrate the issue is welcome.
