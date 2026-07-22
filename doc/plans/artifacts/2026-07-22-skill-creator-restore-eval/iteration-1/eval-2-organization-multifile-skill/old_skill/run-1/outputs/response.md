The requested exact workflow cannot be derived from the permitted instruction source.

`old_skill/SKILL.md` only says the skill creator may create, refine, or evaluate skills. It does not define:

- The durable organization package directory.
- The Skill Library manifest/schema or registration command.
- How agent optional skills are represented or updated.
- The Rudder organization ID, target agent ID, or source package path.

The workspace also contains only `old_skill/SKILL.md`; the stated package files are not present. Therefore, naming paths or CLI commands would be fabrication.

The required order is nevertheless clear:

1. Place the entire package—not only `SKILL.md`—in the organization’s documented durable skill-package location:

   ```text
   customer-summary/
   ├── SKILL.md
   ├── references/
   │   └── style-guide.md
   └── scripts/
       └── check_output.py
   ```

2. Register all three files in the organization Skill Library inventory, including their relative paths. Registering only the package root or `SKILL.md` would leave the inventory incomplete.

3. Read the target agent’s current optional-skills list.

4. Add `customer-summary` to that existing list using the platform’s additive/merge operation.

5. Submit the merged list. Do not issue a replacement command containing only `customer-summary`, because that would remove existing optional skills.

6. Read back both the library inventory and agent configuration to verify all three files are registered and the pre-existing optional skills remain enabled.

Exact commands require the Rudder Skill Library’s authoritative path, CLI/API syntax, and identifiers. Those are absent from the only source you authorized, so no truthful exact commands can be supplied under this constraint.