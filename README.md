# Command Center

A Claude Code mod: a live side pane for the session you're in. It shows Claude's task list, context and plan limits, background work, subagents, side questions, approvals and quick actions.

## Cards

| Card | What it shows and does |
| --- | --- |
| **Plan** | The task list Claude keeps during a turn: done steps checked, the current one highlighted, with a done/total count. Each step has its own bar and time: full when done, empty until started, and for the step under way an estimate, filled by its time so far against the average of the steps already done (held under 90% until it finishes). Minimized, it shows the current step and a progress bar. Appears once Claude sets a plan; desktop app only. |
| **Actions** | Pin or unpin the session, move it to a sidebar group or create a new group, archive it (with a confirm step), and hide or show the sidebar. Desktop app only. |
| **Approvals** | Appears only when a permission prompt is waiting: Approve, Deny, or hand it back to the dialog. Always on top. |
| **Session** | Running time and cost in the header, with context, 5-hour and 7-day usage bars and a Compact button. Minimized, it shows three small rings instead. |
| **Side question** | Ask about the session without interrupting it, like `/btw`. Answers come from a fork of the conversation, without tools, and nothing is added to the chat. |
| **Shortcuts** | One-click buttons that put your commands in the message box. |
| **Background work** | Background shells, agents, monitors and workflows, with how long each has run and a Stop button. |
| **Agents** | A card per subagent. **▸ Details** shows its full task, steps, tokens, latest note and recent tool calls. |
| **Activity** | Tool calls per minute over the last 20 minutes, the most-used tools and recent failures. Minimized, it shows a thin strip of bars. |

Click a card's title to minimize it. **⇅ Arrange cards** shows ↑/↓ buttons to reorder them. Minimized cards and the card order are saved, so new sessions open with your last layout.

`/command-center` opens or closes the pane. `/command-center open` and `/command-center close` do one or the other.

## Notes

- The Actions buttons and Stop buttons run through the session's normal tool permissions. They work in bypass permissions mode. In auto mode the desktop app may refuse them.
- The pane draws charts and rings as SVG on the desktop app and VS Code, and as text in a terminal.

## Use it in a project (local or cloud sessions)

Add to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "tomstools-mods": {
      "source": { "source": "github", "repo": "TomsTools11/claude-command-center" }
    }
  },
  "enabledPlugins": {
    "command-center@tomstools-mods": true
  }
}
```

## Develop

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
claude plugin validate .
```
