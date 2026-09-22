# Model qualification

Qualification is two-stage. `artifactVerified` requires authoritative provenance, immutable revision, exact file byte counts and SHA-256 digests, quantization, tokenizer/chat-template identity, and supported runtime build. `runtimeQualified` additionally requires load/probe, fixed corpus, capability, and resource evidence on the actual platform.

The requested `Qwen3.8-27B` artifact is unverified by the approved plan. It remains blocked. Fixture profiles are visible test data and cannot be selected for production assets. `verify-model` reads local manifests and checks files; it never downloads, executes manifest commands, follows arbitrary URLs, or edits scheduler settings.
