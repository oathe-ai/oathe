# Oathe roadmap

**Everyone will have an Agent.**

YES. uppercase AGENT.

Agents need durable, verifiable work in order to be trusted across teams and to interact with our teammate's agents.

Start something with Claude. Continue it with Codex. Send part of it to a teammate. Let another attempt finish in the cloud. Ask a different harness to verify what came back.

Through all of that, Oathe keeps one coherent record of:

```text
what is owed
→ who owns it
→ what has been attempted
→ what changed
→ what evidence came back
→ whether the work passed
→ what should happen next
```

A task may cross several Agents, people, harnesses, sessions, and machines. Oathe keeps it one episode of work instead of turning it into five disconnected conversations.

## What we're building

Today, Agent work belongs to sessions.

A session dies and its unfinished work becomes your problem. A context window compacts and an agent reconstructs from fragments. A provider rate-limits you and switching harnesses means pasting a transcript. A teammate’s agent returns a result and nobody knows whether to trust it. An agent says “done,” and that statement quietly becomes reality.

We’re moving that responsibility out of any one session.

With Oathe:

- a task exists before an agent starts and after an agent stops;
- ownership is distinct;
- every attempt receives a bounded, freshly compiled view of the work;
- progress survives durably, not hidden model memory;
- another allowed agent can continue without reconstructing the job from you;
- completion remains a claim until a non-author verifies the agent's trajectory;
- rejected work stays open;
- consequential actions carry durable identities and receipts;
- people and agents can hand work across organizational boundaries without losing accountability.

Autosave is just the start. 
Durable coordination is already being built.

## Where we're going

One obligation might:

```text
begin with you and Claude
→ continue in Codex after a provider limit
→ wait on work delegated to a teammate
→ resume when that result is verified
→ move to a cloud worker when you close your laptop
→ return to your local agent for final verification
→ settle once its contract is satisfied
```

Oathe should make that ordinary.

Nobody should have to preserve a session, keep a parent agent alive, paste context, remember who owes what, or accept an agent’s account of its own work.

## Roadmap

1. **Turn a session into durable work**  
   Give an obligation, its owner, its attempts, its progress, and its definition of done a life outside any model context.

2. **Let another agent continue it**  
   Reconstruct a workspace and a fresh briefing so Claude, Codex, or another allowed endpoint can take the next attempt.

3. **Let work leave your machine**  
   End or fence a local attempt, restore its workspace elsewhere, and continue locally, on your own cloud machine, or through a hosted worker.

4. **Let work cross a team**  
   Delegate an accountable child obligation to another person or agent and give its parent a durable reason to wait.

5. **Make completion prove itself**  
   "done" is an assertion, agent trajectory still needs to be reviewed, and settle or reopen work from evidence.

6. **Make consequential actions survivable**  
   Give deploys, messages, payments, and other external effects durable identities, receipts, and reconciliation paths.

7. **Give a company one shared work state**  
   Let people keep their preferred tools while obligations, ownership, evidence, dependencies, and outcomes remain coherent across all of them.

8. **Publish the ways agent systems fail**  
   Benchmark process death, lost work, duplicate effects, false completion, compaction, stale attempts, and silent degradation—including our own failures.
