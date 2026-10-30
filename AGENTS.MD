This document governs AI and automated development in the "Nodo" project. During development, follow this file first, then the user's current message.

# Mandatory requirements
- Use modular, general-purpose designs for features.
- Read the existing code before making changes. Prefer the project's existing structure and coding style.
- Keep the number of lines of code to a minimum. Do not introduce complex abstractions when a simple implementation works.
- Use comments sparingly: explain only constraints the code itself cannot express, in plain language. Do not put design decisions, change history, or problem descriptions in comments.
- Prefer mature, stable libraries for common functionality such as standard formats, protocols, parsing, compression, encryption, and dates. Do not implement these from scratch unless the user explicitly requests it or an existing project implementation must be retained.
- Do not change unrelated files or perform incidental refactoring.
- Do not write or edit `CHANGELOG.md` unless the user has explicitly authorized it for the current task.
- When authorized to write `CHANGELOG.md`: group entries under `## YYYY-MM-DD` headings (newest first; today's entries go in today's section), then under `### 新增` / `### 变更` / `### 修复` / `### 移除`. One line per entry, user-visible changes only (no refactors, tests, or docs-only edits); prefix incompatible config, data-format, or public-interface changes with **不兼容**. Merge entries about the same feature or UI area into one line that states the final result.
- When the documentation conflicts with existing code, you should follow the code and list all the conflicts at the end of your response.

# UI requirements
- Don't add redundant explanatory text to the interface.
- Optimize the alignment of interface elements and the UI for better visual balance; for nested areas, try to make the rounded corners concentric.

# Testing requirements
- Run targeted tests by default. Run only the test files corresponding to the module affected by the change.
- Do not perform real-environment validation unless the user explicitly requests it.

# Prohibited actions
- Do not modify any Agent program. All plugin functionality must use publicly exposed Agent capabilities or protocols.
- Never disclose secrets. Do not write, print, or commit API keys, tokens, cookies, or the contents of the DSH_HOME directory.
