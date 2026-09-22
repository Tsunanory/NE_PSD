---
id: 2
title: Continue routine corrections when evidence supports progress
status: open
type: internal
skill:
  - superpowers:executing-plans
proposes_skill: []
siblings_checked: "Checked planning and coordination workflow; this is a project policy correction, not a new skill family."
area: planning and coordination
date: 2026-09-22
session_context: Foundation Task 1 was falsely halted by a malformed dependency ledger despite passing build and tests. A bounded task packet must continue routine documentation/test corrections while evidence supports progress; only true external blockers or exhausted progress stop work. Missing optional model telemetry is not a blocker when explicit Luna routing is accepted.
reference: docs/superpowers/model-routing.md
---

**Issue:**

A malformed evidence artifact can incorrectly halt a task even when authoritative source records and build/test results support bounded continuation.

**Suggested improvement:**

Keep correction packets scoped to the malformed artifact, revalidate against authoritative manifest and lock evidence, and stop only for a true external blocker or exhausted progress. Missing optional telemetry alone is not a blocker.

**Principle:**

Evidence-backed documentation repair should preserve forward progress without weakening release gates.
