# Command Center

A Claude Code mod: a live pane with context and rate limits, task progress rings, subagent cards and one-click approvals.

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
