---
name: oathe-work
description: Use when working in a workspace with an Oathe board (the SessionStart context shows one) — before starting any substantive task, when reporting progress, when picking prior work back up, and when stopping. Claims are speech acts recorded in the cell substrate via the oathe_* MCP tools.
---

# Working the Oathe board

The board in this session's opening context is the durable record of this folder's work.
The substrate refuses dishonesty by construction — work with it, not around it.

## The loop

1. **Claim before you build.** Substantive work starts with `oathe_claim {task_id, objective}`.
   A claim takes responsibility; it never mints the work as done. A task without a real plan
   is honestly `plan_status: "unknown"` — never fabricate one.
2. **Statements as you go.** Record findings and progress with
   `oathe_statement {task_id, proposition, evidence_ref}`. A statement is a statement, not
   truth — nothing settles by saying it.
3. **Pick up, don't re-derive.** When the user says "continue <task>" (or the board shows a
   lease of yours), call `oathe_pickup {task_id}`: the successor sequence returns the compiled
   frame for the obligation. The obligation, not the conversation, is what comes back.
4. **Yield what you cannot finish.** Stopping without finishing means
   `oathe_yield {task_id, note}` — the obligation goes back on the board, unowned, with a
   declared cause. Walking away silently leaves a lease to expire, which the board will show.

## Refusals are the product

A second claimant is refused. A statement against no claim is refused. A yield without a
declared cause is refused. When a tool returns a typed error, report it faithfully — do not
retry blindly and do not soften it into success.
