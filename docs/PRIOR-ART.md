# Prior art: Kirodex

[thabti/kirodex](https://github.com/thabti/kirodex) — MIT, Tauri 2 + Rust +
React — is the same problem in a different shell: a desktop UI over `kiro-cli`,
**also built on ACP**. Independent confirmation that our transport choice is
right, and the most useful reference we have for interaction design.

**Read it for interaction design and event shaping. Do not port code.** It is
Tauri with Rust IPC, `portable-pty` and `redb`; we are a browser talking to a
Node server over a WebSocket. Its plumbing assumptions do not transfer, its UI
decisions do.

Where to look, by problem:

| Problem | Look at |
|---|---|
| Folding an event log into renderable rows | `MessageList.logic.ts`, `TimelineRows.tsx`, `WorkGroupRow.tsx` |
| Tool call rendering | `ToolCallEntry.tsx` (collapsed) vs `ToolCallDisplay.tsx` (expanded), `tool-call-utils.ts` |
| Read/edit tool output | `ReadOutput.tsx` (syntax-highlighted), `InlineDiff.tsx` |
| Turn boundaries and progress | `WorkingRow.tsx`, `CompletionDivider.tsx`, `ThinkingDisplay.tsx` |
| Approvals | `PermissionBanner.tsx`, `AutoApproveToggle.tsx`, `QuestionCards.tsx` |
| Model / mode / effort selection | `ModelPicker.tsx`, `ModelPickerPanel.tsx`, `ReasoningEffortPicker.tsx` |
| CLI detection and first-run setup | `OnboardingCliSection.tsx` |
| Context window pressure | `ContextUsageBar.tsx`, `ContextRing.tsx`, `CompactSuggestBanner.tsx` |
| The changed-files drawer | `DiffPanel.tsx`, `ChangedFilesSummary.tsx` |

Patterns worth adopting, and why:

- **Typed timeline rows, not a message array.** They fold the event stream into
  rows with an explicit taxonomy (`user-message`, `system-message`,
  `assistant-text`, `work`, `working`, `changed-files`) and per-type height
  estimates for virtualization. Our `packages/web/src/timeline.ts` does the
  fold; the row taxonomy and virtualization are what it still lacks.
- **Queue messages typed during a turn.** `QueuedMessages.tsx` lets the user
  type while the agent runs; messages queue and send when the turn ends, and can
  be reordered, edited or removed first. This is the single best turn-handling
  idea in the repo — a running turn should never block the composer.
- **Collapsed by default, expandable on demand.** A tool call is one dense line
  until you open it. A transcript of expanded tool output is unreadable.
- **Selection is per-thread, live, and restored.** Model and mode changes apply
  mid-session and survive reconnects and restarts — which is exactly what ACP
  `configOptions` allows, and why we never cache a model list in code.
- **Detection with a manual fallback.** Their onboarding auto-detects the CLI,
  offers per-platform install commands when it fails, and lets the user browse
  to a path. Ours does both now — see [PROVIDERS.md](PROVIDERS.md).
