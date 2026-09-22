# Job recovery and evidence

The renderer job store hydrates from `JobSnapshot`, rejects stale job IDs/sequences, refreshes on gaps, reconnects with one subscription and consumes retry successors returned by the service. Old subscriptions are disposed before successor hydration. A bounded asset window prevents the renderer from materializing all rows.

Visual review is an explicit typed IPC operation. Three artifacts and the contact sheet are displayed without a preselected decision; only an operator approve/reject action can submit an attestation. Evidence reads require a current-job manifest-relative identifier. Committed output opening rejects staging and traversal. Ordinary logs redact local paths and tokens.

Closing an active job uses safe pause-and-close after the service reports a safe state or keeps the window open. It never force-kills Photoshop. The 10,000-asset fake endurance path is separate from Photoshop performance qualification.
