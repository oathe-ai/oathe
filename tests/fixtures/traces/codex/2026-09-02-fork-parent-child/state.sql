CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
       tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);
CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
INSERT INTO threads (id, rollout_path, cwd, source, created_at) VALUES ('00000000-0000-7000-8000-000000000013', '<home>/.codex/sessions/2026/01/01/rollout-2026-01-01T00-05-00-00000000-0000-7000-8000-000000000013.jsonl', '/Users/dev/app', '{"subagent":{"thread_spawn":{"parent_thread_id":"00000000-0000-7000-8000-000000000003","depth":1,"agent_path":"/root/agent-2","agent_nickname":"agent-4","agent_role":"worker"}}}', 1);
INSERT INTO thread_spawn_edges VALUES ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000013', 'open');
