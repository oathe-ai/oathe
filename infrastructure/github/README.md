# GitHub repository controls

This directory records GitHub rules that are enforced outside the Git tree. Keeping the payloads beside the code makes repository protections reviewable and recoverable.

The main ruleset requires the `required` status check produced by GitHub Actions (integration `15368`). That stable aggregate job succeeds only when every CI lane succeeds. When bootstrapping a new repository, add the required-check rule only after CI has produced the check at least once on a real pull request; requiring a check that has never run creates a merge deadlock.

Apply a new ruleset with an administrator token:

```sh
gh api --method POST repos/oathe-ai/oathe/rulesets \
  --input infrastructure/github/rulesets/protect-main.json
```

After changing an existing ruleset, use its numeric ID with the update endpoint and the reviewed JSON payload. Never replace a ruleset without first checking the active rules and current rule ID.

These files contain no bypass actor. Administrators follow the same merge rules as other contributors. Emergency changes must be documented and made by explicitly changing the ruleset, leaving an auditable ruleset history.
