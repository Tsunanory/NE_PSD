---
id: 1
title: Distinguish runtime product review from development review
status: open
type: internal
skill:
  - superpowers:writing-plans
  - superpowers:brainstorming
proposes_skill: []
siblings_checked: "Checked brainstorming and writing-plans: the same runtime-versus-build-time ambiguity applies to both; no narrower tool family is involved."
area: requirements interpretation
date: 2026-09-21
session_context: NE_PSD implementation planning; owner clarified that the reviewer checks completed images during Windows production work.
reference: docs/superpowers/specs/2026-09-21-ne-psd-design.md
---

## Issue
The phrase 'reviewer layer after every iteration' was expanded into mandatory new reviewers after development tasks, although the requested product behavior was runtime image checking.

## Improvement
Define the iteration's subject and lifecycle explicitly in the product specification before translating it into workflow gates. Keep normal development verification separate. The corrected plans require visual per-output verdicts in the running Windows job and remove the extra developer-review layer.

## Principle
A product requirement for runtime verification must not silently become a requirement on how the product is built.
