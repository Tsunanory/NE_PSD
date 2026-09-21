# Interactive model routing

Owner decision, 2026-09-22.

The main interactive session runs on `gpt-5.6-sol` and acts only as coordinator: route work, read required context, make decisions, integrate delegated results, and write final summaries. The owner must select Sol in the actual session settings. Verify exposed session metadata when available; never claim a model selection that metadata does not establish. Sol must not take over implementation or troubleshooting when a worker fails.

All implementation, code changes, tests, debugging, bulk edits, and integration commands run in an explicitly pinned Luna worker on `gpt-5.6-luna`. Delegate a bounded task packet without inheriting the full conversation, for example:

```js
collaboration.spawn_agent({
  task_name: 'execute_item',
  model: 'gpt-5.6-luna',
  fork_turns: 'none',
  message: 'Execute this bounded implementation task: ...'
})
```

Use one Luna worker per session by default. The explicitly pinned Luna child executes its assigned task directly and must not recursively delegate merely because it reads this rule. No Sol execution fallback is allowed if Luna is unavailable, mismatched, or its selected model metadata cannot be confirmed where exposed; stop dependent work and report the blocker. Allow one bounded task and at most one correction retry, then hand off the blocker. Do not modify `config.toml` to change model selection. These instructions do not switch the main model or cap tokens.

This interactive routing rule does not change runtime application policy: the requested local Qwen remains the qualified interactive application brain, the image reviewer remains a real Windows-job runtime layer, and future digest or token-intensive scheduled jobs remain pinned to `gpt-5.6-luna` in both scheduler settings and actual invocation with no fallback.
