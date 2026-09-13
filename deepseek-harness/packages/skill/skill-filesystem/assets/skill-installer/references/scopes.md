# Install scopes and availability

## Scopes

The `scope` argument of `skill_install` selects the writable root:

| Scope | Root | Reach |
|---|---|---|
| `project-dsh` (default) | `<project>/.dsh/skills` | This project, highest precedence |
| `project-agents` | `<project>/.agents/skills` | This project, shared agent tooling |
| `user-dsh` | `<dshHome>/skills` | All projects of this user |
| `user-agents` | `<agentsHome>/skills` | All projects, shared agent tooling |
| `custom` | First configured `customSkillDirs`, or `custom_dir` | Deployment-defined roots only |

`custom_dir` must equal a configured custom root; anything else is rejected. Project scopes need a session workspace, otherwise the install fails loudly instead of guessing a location.

## Availability toggles

`skill_enable` writes the explicit enabled pair (`disable-model-invocation: false`, `user-invocable: true`); `skill_disable` writes the disabled pair. Only the two flag lines change — the rest of the file is byte-identical. Repeating the current state writes nothing.
