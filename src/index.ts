import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import { Plugin } from "@opencode/plugin"

import {
  buildExternalPreviewUrl,
  isPreviewable,
  registerExternalPreviewFile,
  registerServerProject,
  startServer,
} from "./server"

const DEFAULT_PORT = Number(process.env.PREVIEW_PORT ?? "17890")
const DEFAULT_HOST = process.env.PREVIEW_HOST ?? "localhost"

export const PREVIEW_TOOL_DESCRIPTION =
  "Open a browser preview and return a Preview URL for previewable files such as Markdown, DrawIO, HTML, PNG, SVG, and code files. Use this after creating or editing previewable files, and copy the returned Preview URL exactly into the final response."

export const PREVIEW_SYSTEM_PROMPT = `When you create or modify previewable files such as Markdown (.md), DrawIO (.drawio), HTML, PNG, SVG, or source code files, you MUST call the preview tool for each relevant file before your final response.

Do not manually construct preview URLs. Use only the exact Preview URL returned by the preview tool, and include that exact URL in your final response.`

function resolveBaseUrl(host: string, port: number): string {
  return host.includes(":") ? `http://${host}` : `http://${host}:${port}`
}

export function buildPreviewUrl(baseUrl: string, projectId: string, file: string, worktree?: string): string {
  let url = `${baseUrl}/preview?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(file)}`
  if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`
  return url
}

export function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir()
  if (filePath.startsWith(`~${path.sep}`)) return path.join(homedir(), filePath.slice(2))
  return filePath
}

export function resolvePreviewInputPath(input: string, directory: string): string {
  const expanded = expandHomePath(input)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(directory, expanded))
}

export function toProjectRelativePath(absolutePath: string, worktree: string): string | null {
  const resolvedWorktree = path.resolve(worktree)
  const relative = path.relative(resolvedWorktree, absolutePath)
  if (relative === "") return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

/**
 * Resolve the file used by the preview tool. Accepts both `file` (primary)
 * and `filePath` (alias — the model frequently passes filePath). Returns "".
 */
export function resolvePreviewInput(file?: string, filePath?: string): string {
  return (file ?? filePath ?? "").trim()
}

/**
 * V2 has no `$` helper (V1 bun-shell). Open the URL with a detached native
 * process so the plugin does not block on the browser.
 */
export function openInBrowser(url: string): void {
  const platform = process.platform
  try {
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref()
      return
    }
    if (platform === "win32") {
      // `cmd /c start "" <url>` — empty title arg avoids the first quoted
      // token being swallowed as the window title.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref()
      return
    }
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref()
  } catch (error) {
    console.debug(`[opencode-preview] Failed to open browser: ${error}`)
  }
}

interface PreviewInput {
  file?: string
  filePath?: string
  worktree?: string
}

export default Plugin.define({
  id: "opencode-preview",
  async setup(ctx) {
    const project = ctx.location.project
    const projectId = project.id
    const projectDir = ctx.location.directory

    // Register this project with the singleton preview server so it can
    // resolve `?project=<id>` URLs. V2 does not hand plugins the opencode
    // server URL (V1 `serverUrl`), and the server no longer discovers
    // projects over HTTP — each plugin instance is location-scoped and
    // knows its own project. Projects seen by the server = projects with a
    // live plugin instance (same semantics the V1 `/project` endpoint had:
    // only projects with an open session were listed).
    registerServerProject(projectId, projectDir)

    // Defer server startup to background so plugin init returns immediately
    // and does not block opencode startup. The ready promise is awaited
    // lazily when the preview tool is first invoked.
    const ready = (async () => {
      const port = await startServer(DEFAULT_PORT)
      const baseUrl = resolveBaseUrl(DEFAULT_HOST, port)
      console.log(`[opencode-preview] Preview server started at ${baseUrl}/browse?project=${projectId}`)
      return { port, baseUrl }
    })()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "preview",
        description: PREVIEW_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description:
                "Path to a previewable file (.md, .drawio, .png, code files); relative, absolute, and ~ paths are supported. Alias of filePath.",
            },
            filePath: {
              type: "string",
              description:
                "Alias of file: path to a previewable file (.md, .drawio, .png, code files); relative, absolute, and ~ paths are supported",
            },
            worktree: {
              type: "string",
              description: "Git worktree name to preview from (resolves via .git/worktrees/)",
            },
          },
          additionalProperties: false,
        },
        async execute(input: PreviewInput, _toolContext) {
          const { baseUrl } = await ready
          const file = resolvePreviewInput(input.file, input.filePath)
          if (!file) {
            return { content: "Error: preview requires a file or filePath argument." }
          }
          if (input.worktree) {
            const url = buildPreviewUrl(baseUrl, projectId, file, input.worktree)
            openInBrowser(url)
            return { content: `Preview URL: ${url}` }
          }

          const absolutePath = resolvePreviewInputPath(file, projectDir)
          const projectRelativePath = toProjectRelativePath(absolutePath, projectDir)
          let url: string

          if (projectRelativePath) {
            url = buildPreviewUrl(baseUrl, projectId, projectRelativePath)
          } else {
            // File outside the current project: preview via a one-time token.
            // V2 has no interactive `context.ask` (V1 permission request), so
            // the tokenized external-preview mechanism is used directly. The
            // server only serves files explicitly registered here.
            const fileStat = await stat(absolutePath)
            if (!fileStat.isFile() || !isPreviewable(absolutePath)) {
              return { content: "Error: file is not previewable." }
            }
            const token = registerExternalPreviewFile(absolutePath, absolutePath)
            url = buildExternalPreviewUrl(baseUrl, token)
          }
          openInBrowser(url)
          return { content: `Preview URL: ${url}` }
        },
      })
    })

    // Inject the preview usage rule into every session's system context.
    // V1 used `experimental.chat.system.transform`.
    const registration = await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: PREVIEW_SYSTEM_PROMPT })
    })

    // V2's public event stream has no `file.edited` event (V1 debug-only
    // logging hook dropped). Live reload inside the preview page is handled
    // by the preview server's own fs watchers over WebSocket — independent
    // of plugin events.

    return async () => {
      await registration.dispose()
    }
  },
})