import path from "node:path"

import path from "node:path"

import { describe, expect, test } from "bun:test"

import {
  buildPreviewUrl,
  PREVIEW_SYSTEM_PROMPT,
  PREVIEW_TOOL_DESCRIPTION,
  resolvePreviewInput,
  resolvePreviewInputPath,
  toProjectRelativePath,
} from "../src/index"

describe("preview plugin guidance", () => {
  test("adds a system prompt that requires using the preview tool", () => {
    const prompt = PREVIEW_SYSTEM_PROMPT
    expect(prompt).toContain("MUST call the preview tool")
    expect(prompt).toContain("Markdown (.md)")
    expect(prompt).toContain("DrawIO (.drawio)")
    expect(prompt).toContain("PNG")
    expect(prompt).toContain("Do not manually construct preview URLs")
    expect(prompt).toContain("exact Preview URL")
  })

  test("exposes an enhanced preview tool description for LLM tool definitions", () => {
    expect(PREVIEW_TOOL_DESCRIPTION).toContain("copy the returned Preview URL exactly")
  })

  test("builds encoded preview URLs", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project id", "docs/test file.md")

    expect(url).toBe("http://localhost:17890/preview?project=project%20id&file=docs%2Ftest%20file.md")
  })

  test("includes worktree when provided", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project", "diagram.drawio", "feature/link-preview")

    expect(url).toBe(
      "http://localhost:17890/preview?project=project&file=diagram.drawio&worktree=feature%2Flink-preview",
    )
  })

  test("preserves explicit worktree preview paths as provided", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project", "docs/readme.md", "feature/link-preview")

    expect(url).toContain("file=docs%2Freadme.md")
    expect(url).toContain("worktree=feature%2Flink-preview")
  })

  test("resolves preview input relative to tool context directory", () => {
    expect(resolvePreviewInputPath("docs/readme.md", "/workspace/project")).toBe(path.resolve("/workspace/project", "docs/readme.md"))
    expect(resolvePreviewInputPath("/tmp/outside.md", "/workspace/project")).toBe(path.resolve("/tmp/outside.md"))
  })

  test("converts files inside the worktree to stable project-relative paths", () => {
    expect(toProjectRelativePath("/workspace/project/docs/readme.md", "/workspace/project")).toBe("docs/readme.md")
  })

  test("returns null for files outside the worktree", () => {
    expect(toProjectRelativePath("/tmp/outside.md", "/workspace/project")).toBeNull()
  })
})

describe("resolvePreviewInput (filePath alias)", () => {
  test("prefers file over filePath", () => {
    expect(resolvePreviewInput("README.md", "docs/other.md")).toBe("README.md")
  })

  test("falls back to the filePath alias", () => {
    expect(resolvePreviewInput(undefined, "docs/guide.md")).toBe("docs/guide.md")
  })

  test("trims whitespace on both arguments", () => {
    expect(resolvePreviewInput("  README.md  ")).toBe("README.md")
    expect(resolvePreviewInput(undefined, "  docs/guide.md  ")).toBe("docs/guide.md")
  })

  test("returns empty string when neither argument is present", () => {
    expect(resolvePreviewInput()).toBe("")
  })
})