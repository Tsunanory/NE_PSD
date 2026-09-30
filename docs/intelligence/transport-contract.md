# Intelligence transport contract

C2 transport requests contain exactly two fresh messages: one fixed system prompt and one canonical current user payload. They carry a qualified profile, generated response schema, explicit sampling settings, output-byte limit, deadline and abort signal. They do not carry prior messages, conversation IDs, tools, or model-selected endpoints.

Local transport validates every request before capability handling, is loopback-only, and requires an exact identity, revision, runtime-version, context-limit, output-limit, JSON-schema, vision, tools, and image-input handshake. The Codex adapter validates the request then is explicitly blocked because no documented installed bridge is available; no REST endpoint or active-chat model is inferred. There is no automatic retry or fallback.

Requests additionally carry a trusted session ID and explicit positive integer output-token, output-byte and deadline limits. Sampling is temperature 0 and non-streaming. Responses are bounded raw bytes with model identity, finish reason, usage, provider revision and echoed session ID. Length, cancellation, deadline, incomplete completion, identity/revision/session mismatch and byte overflow are failures. The bounded wrapper passes a linked abort signal, makes one call, discards late replies, and never retries or falls back. Strict JSON decodes raw bytes with fatal UTF-8 handling, applies one supplied strict validator, and rejects duplicate keys (including escaped-equivalent names), fences, prose, malformed JSON and oversized responses.

Prompt hashes are fixed to the approved source blocks:

- planner: `7526e222bc7df7ec0211f72f678e1f5dcaecf8344b68f88eeb565dc449726b63`
- runtime reviewer: `5964f89bb5bfb776523ce0c012cd1063508b92b38ebbbf6cc677c7ded7bb132d`
- diagnostic: `32fbacdb9c912137751b4c0c202a851fb24c4fa60e1dfb211d35bdaddb952285`

The current source files are fixed approved inputs; arbitrary prompt paths and interpolation are not accepted.

C2 closure: request/profile output and revision pins are checked before transport; local artifact and chat-template hashes are part of the handshake; parent cancellation races and aborts the child call; malformed nested scanner input is normalized to `StrictJsonError`; budget preflight runs before invocation.

Final proof closure adds malformed response normalization, complete local-handshake mismatch coverage, and explicit timeout child-abort evidence. All malformed response fields become structured transport errors.
