# Local model setup

The requested interactive model label is `Qwen3.8-27B`. Main-process endpoint access accepts only literal loopback HTTP endpoints; the default is `http://127.0.0.1:8080`. Renderer code cannot supply arbitrary URLs, prompts or tools.

Readiness requires endpoint reachability, exact model identity, artifact SHA-256, runtime version, chat-template digest, quantization, context/output limits, independent JSON-schema/tools/vision capability checks, benchmark evidence and review-gate availability. A reachable endpoint alone is not Ready. Text-only evidence displays `Модель не проверяет изображение визуально` and cannot enable automated visual review.

Weights-only lower bounds for 27B are Q4 13.5 GB, Q5 16.9 GB, Q6 20.3 GB and Q8 27.0 GB. These exclude metadata, KV cache, runtime and Photoshop memory. Measured RAM, VRAM, headroom and latency are shown only when evidence supplies them. Scheduled local Qwen is rejected; scheduled Luna remains explicitly deferred. No scheduler or download path exists.
