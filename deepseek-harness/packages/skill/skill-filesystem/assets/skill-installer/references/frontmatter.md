# SKILL.md frontmatter contract

Every skill is a folder with a required `SKILL.md`. The YAML envelope between the first two `---` lines carries routing; the body below carries instructions.

## Required fields

```yaml
---
name: my-skill
description: What the skill does and when it applies, in one paragraph.
---
```

- `name`: kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), matches the folder name for directory bundles.
- `description`: one paragraph stating the capability AND its boundary. Mention the requests that must NOT activate the skill when misrouting is likely.

## Optional fields

- `whenToUse`: extra routing guidance beyond the description.
- `disable-model-invocation: true`: hide from the model catalog (explicit `$name` user gesture still loads it).
- `user-invocable: false`: hide from the `/name` user gesture catalog.
- `metadata`: mapping of provider-specific data; never prose instructions.

Rejected at install time: legacy keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`), missing envelope, empty body.

## Body guidance

State the outcome, non-obvious context, real constraints, and tool choices. Assume the reader is already capable: no generic advice, no restated policies, no speculative edge cases. Link each supporting file where its use becomes relevant instead of duplicating content.
