import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../src/skills/metadata.js";

describe("parseSkillFile", () => {
  it("parses required frontmatter and derives triggers/body metadata", () => {
    const result = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/prd/SKILL.md",
      mtimeMs: 0,
      content: `---
name: prd
description: "Generate a PRD. Triggers on: create a prd, write prd for."
author:
  name: David Helmus
  url: "https://example.com"
version: 0.1.0
source:
  type: self
  name: ai-dev
triggers:
  - create a prd
  - write prd for
---

# PRD

## When to Use

- Planning a feature.
- Starting a project.

**Do NOT use when:**
- Implementing directly.
`
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.name).toBe("prd");
    expect(result.skill?.triggers).toEqual(["create a prd", "write prd for"]);
    expect(result.skill?.author).toEqual({ name: "David Helmus", url: "https://example.com" });
    expect(result.skill?.version).toBe("0.1.0");
    expect(result.skill?.source).toEqual({ type: "self", name: "ai-dev" });
    expect(result.skill?.warnings).toEqual([]);
    expect(result.skill?.whenToUse).toContain("Planning a feature.");
    expect(result.skill?.whenNotToUse).toContain("Implementing directly.");
  });

  it("does not derive misleading triggers from descriptions", () => {
    const result = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/prd/SKILL.md",
      mtimeMs: 0,
      content: `---
name: prd
description: "Generate a PRD. Triggers on: create a prd, write prd for."
author: David Helmus
version: 0.1.0
source:
  type: self
  name: ai-dev
---

# PRD
`
    });

    expect(result.skill?.triggers).toEqual([]);
  });

  it("normalizes imported source metadata and root trust warnings", () => {
    const result = parseSkillFile({
      sourceRoot: { name: "external", path: "/skills", defaultTrustStatus: "review_required" },
      skillFile: "/skills/grill-me/SKILL.md",
      mtimeMs: 0,
      content: `---
name: grill-me
description: Challenge a plan until it is clear.
author: Matt Pocock
source:
  type: git
  url: "https://github.com/mattpocock/skills"
  path: "skills/productivity/grill-me/SKILL.md"
  ref: main
  commit: abc123
---

# Grill Me
`
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.author).toEqual({ name: "Matt Pocock" });
    expect(result.skill?.version).toBeNull();
    expect(result.skill?.source).toEqual({
      type: "git",
      url: "https://github.com/mattpocock/skills",
      path: "skills/productivity/grill-me/SKILL.md",
      ref: "main",
      commit: "abc123"
    });
    expect(result.skill?.trustStatus).toBe("review_required");
    expect(result.skill?.warnings.map((warning) => warning.code)).toEqual(["review_required"]);
  });

  it("normalizes numeric, string, and missing version metadata", () => {
    const numeric = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/numeric/SKILL.md",
      mtimeMs: 0,
      content: `---
name: numeric
description: Numeric version.
author: David Helmus
version: 1.0
source:
  type: self
  name: ai-dev
---

# Numeric
`
    });
    const string = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/string/SKILL.md",
      mtimeMs: 0,
      content: `---
name: string
description: String version.
author: David Helmus
version: "1.0"
source:
  type: self
  name: ai-dev
---

# String
`
    });
    const missing = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/missing/SKILL.md",
      mtimeMs: 0,
      content: `---
name: missing
description: Missing version.
author: David Helmus
source:
  type: self
  name: ai-dev
---

# Missing
`
    });

    expect(numeric.skill?.version).toBe("1.0");
    expect(numeric.skill?.warnings.map((warning) => warning.code)).not.toContain("invalid_version");
    expect(string.skill?.version).toBe("1.0");
    expect(missing.skill?.version).toBeNull();
    expect(missing.skill?.warnings.map((warning) => warning.code)).toContain("missing_version");
  });

  it("keeps legacy skills indexable with metadata warnings", () => {
    const result = parseSkillFile({
      sourceRoot: { name: "legacy", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/legacy/SKILL.md",
      mtimeMs: 0,
      content: `---
name: legacy
description: Existing skill without source fields.
---

# Legacy
`
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.warnings.map((warning) => warning.code)).toEqual([
      "missing_author",
      "missing_source",
      "missing_version"
    ]);
  });

  it("reports missing required metadata", () => {
    const result = parseSkillFile({
      sourceRoot: { name: "test-root", path: "/skills", defaultTrustStatus: "trusted" },
      skillFile: "/skills/bad/SKILL.md",
      mtimeMs: 0,
      content: "---\nname: bad\n---\n# Bad\n"
    });

    expect(result.skill).toBeUndefined();
    expect(result.error?.code).toBe("missing_required_metadata");
  });
});
