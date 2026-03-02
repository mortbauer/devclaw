/**
 * Provider factory — auto-detects GitHub vs GitLab vs Gitea from git remote.
 */
import type { IssueProvider } from "./provider.js";
import type { RunCommand } from "../context.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../projects/index.js";
import { GiteaProvider } from "./gitea.js";
import { runCommand } from "../run-command.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github" | "gitea";
  repo?: string;
  repoPath?: string;
  runCommand: RunCommand;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab" | "gitea";
};

async function detectProvider(repoPath: string, runCommand: RunCommand): Promise<"gitlab" | "github"> {
  try {
    const result = await runCommand(["git", "remote", "get-url", "origin"], { timeoutMs: 5_000, cwd: repoPath });
    const url = result.stdout.trim();
    if (url.includes("github.com")) return "github";
    if (url.includes("gitlab.com")) return "gitlab";
    // Check for Gitea URL pattern (includes gitea, git, or custom domain)
    if (url.includes("gitea") || url.includes("git/")) return "gitea";
    // Fallback: try to detect via tea command
    try {
      await runCommand(["tea", "auth", "status"], { timeoutMs: 5_000, cwd: repoPath });
      return "gitea";
    } catch {
      return "gitlab";
    }
  } catch {
    return "gitlab";
  }
}

export async function createProvider(opts: ProviderOptions): Promise<ProviderWithType> {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const rc = opts.runCommand;
  const type = opts.provider ?? await detectProvider(repoPath, rc);
  const provider =
    type === "github"
      ? new GitHubProvider({ repoPath })
      : type === "gitlab"
      ? new GitLabProvider({ repoPath })
      : new GiteaProvider({ repoPath });
  return { provider, type };
}
