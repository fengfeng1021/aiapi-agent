---
name: skill-installer
description: Create or update a skill with a valid SKILL.md and install it with the skill_install tool. Use when the user asks to add, install, or author a skill.
---

# Skill Installer

Write the skill, validate it, then install it. Do not hand-place files under skill roots without validating first.

## Workflow

1. Confirm the requirement: skill name (kebab-case), one-paragraph description, and the concrete task it improves. If the name or scope is unclear, ask before writing.
2. Compose the `SKILL.md` following [references/frontmatter.md](references/frontmatter.md). Keep the entrypoint short; move mode-specific detail into `references/`, deterministic mechanics into `scripts/`, and generated output into `assets/`.
3. Validate with `scripts/validate_skill.py <skill-folder>` and fix every reported issue. The validator checks structure only; incoherent instructions still need your judgment.
4. Install with the `skill_install` tool (preferred) — it validates again and refuses to overwrite without `overwrite: true`. Read [references/scopes.md](references/scopes.md) to pick the scope. Respect the user's explicit location; otherwise default to `project-dsh`.
5. Confirm with `skill_enable` state only when the user asked to toggle availability; newly installed skills are usable immediately.

## Boundaries

- Never write outside skill roots (project `.dsh/skills`, `.agents/skills`, user skill dirs, configured custom dirs). The installer rejects anything else.
- Never write into `.system` directories.
- Stop after one successful install; do not retry with broader scopes or looser validation.
- Approval to create a skill does not authorize unrelated file writes or external actions.
