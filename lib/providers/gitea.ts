/**
 * GiteaProvider — IssueProvider implementation using tea CLI.
 */
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  type IssueComment,
  type PrStatus,
  type PrReviewComment,
  PrState,
} from "./provider.js";
import { runCommand } from "../run-command.js";
import { withResilience } from "./resilience.js";
import {
  DEFAULT_WORKFLOW,
  getStateLabels,
  getLabelColors,
  type WorkflowConfig,
} from "../workflow.js";

type GiteaIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
  web_url: string;
};

type GiteaPR = {
  number: number;
  title: string;
  body: string;
  head_ref: string;
  base_ref: string;
  web_url: string;
  state: string;
  merged: boolean;
  mergeable?: boolean;
  review_decision?: string;
  status?: string;
};

type GiteaComment = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  system: boolean;
};

function toIssue(gitea: GiteaIssue): Issue {
  return {
    iid: gitea.number,
    title: gitea.title,
    description: gitea.body ?? "",
    labels: gitea.labels.map((l) => l.name),
    state: gitea.state,
    web_url: gitea.web_url,
  };
}

export class GiteaProvider implements IssueProvider {
  private repoPath: string;
  private workflow: WorkflowConfig;

  constructor(opts: { repoPath: string; workflow?: WorkflowConfig }) {
    this.repoPath = opts.repoPath;
    this.workflow = opts.workflow ?? DEFAULT_WORKFLOW;
  }

  private async tea(args: string[]): Promise<string> {
    return withResilience(async () => {
      const result = await runCommand(["tea", ...args], {
        timeoutMs: 30_000,
        cwd: this.repoPath,
      });
      return result.stdout.trim();
    });
  }

  /**
   * Get repo owner/name via tea CLI. Cached per instance.
   * Returns null if unavailable (no git remote, etc.).
   */
  private repoInfo: { owner: string; name: string } | null | undefined =
    undefined;

  private async getRepoInfo(): Promise<{ owner: string; name: string } | null> {
    if (this.repoInfo !== undefined) return this.repoInfo;
    try {
      const raw = await this.tea([
        "repo",
        "view",
        "--json",
        "owner,name",
      ]);
      const data = JSON.parse(raw);
      this.repoInfo = { owner: data.owner?.login ?? data.owner, name: data.name };
    } catch {
      this.repoInfo = null;
    }
    return this.repoInfo;
  }

  /**
   * Find PRs linked to an issue via Gitea's API.
   * Returns null if the query fails (caller should fall back).
   */
  private async findPrsViaAPI(
    issueId: number,
    state: "open" | "merged" | "all",
  ): Promise<
    Array<{
      number: number;
      title: string;
      body: string;
      head_ref: string;
      web_url: string;
      merged: boolean;
      review_decision?: string;
      state: string;
    }> | null
  > {
    const repo = await this.getRepoInfo();
    if (!repo) return null;

    try {
      const stateFilter =
        state === "open"
          ? "?state=open"
          : state === "merged"
          ? "?state=merged"
          : "";
      const raw = await this.tea([
        "api",
        `repos/${repo.owner}/${repo.name}/pulls${stateFilter}`,
      ]);
      const prs = JSON.parse(raw) as GiteaPR[];

      // Filter PRs by associated issue via body or title
      const issuePattern = new RegExp(`#?${issueId}\\b`, "g");
      const filtered = prs.filter(
        (pr) =>
          issuePattern.test(pr.body ?? "") ||
          issuePattern.test(pr.title) ||
          pr.head_ref.includes(`/${issueId}-`),
      );

      return filtered.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        head_ref: pr.head_ref,
        web_url: pr.web_url,
        merged: pr.merged,
        review_decision: pr.review_decision,
        state: pr.state,
      }));
    } catch {
      return null;
    }
  }

  /**
   * Find PRs associated with an issue.
   * Primary: Gitea API query.
   * Fallback: regex matching on branch name / title / body.
   */
  private async findPrsForIssue<T extends {
    title: string;
    body: string;
    head_ref?: string;
    web_url: string;
    number: number;
    review_decision?: string;
    state: string;
    merged?: boolean;
  }>(
    issueId: number,
    state: "open" | "merged" | "all",
  ): Promise<T[]> {
    // Try API first
    const apiPrs = await this.findPrsViaAPI(issueId, state);
    if (apiPrs && apiPrs.length > 0) {
      return apiPrs as unknown as T[];
    }

    // Fallback: use tea pr list
    try {
      const args = ["pr", "list", "--json", "number,title,body,head_ref,web_url,review_decision,status,state"];
      if (state !== "all") args.push("--state", state);
      const raw = await this.tea(args);
      if (!raw) return [];
      const prs = JSON.parse(raw) as T[];
      const branchPat = new RegExp(`^(?:fix|feat|feature|chore|bugfix|hotfix|refactor|docs|test)/${issueId}-`);
      const titlePat = new RegExp(`#?${issueId}\\b`);

      // Primary: match by branch name
      const byBranch = prs.filter((pr) => pr.head_ref && branchPat.test(pr.head_ref));
      if (byBranch.length > 0) return byBranch;

      // Fallback: word-boundary match in title/body
      return prs.filter((pr) =>
        titlePat.test(pr.title) || titlePat.test(pr.body ?? ""),
      );
    } catch {
      return [];
    }
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try {
      // Check if label exists first
      const labelsRaw = await this.tea(["label", "list", "--json", "name,color"]);
      const labels = JSON.parse(labelsRaw) as Array<{ name: string; color: string }>;
      const existing = labels.find((l) => l.name === name);

      if (existing) {
        // Update existing label
        await this.tea([
          "label",
          "update",
          name,
          "--color",
          color.replace(/^#/, ""),
        ]);
      } else {
        // Create new label
        await this.tea([
          "label",
          "create",
          name,
          "--color",
          color.replace(/^#/, ""),
        ]);
      }
    } catch {
      // Best-effort fallback
      await this.tea([
        "label",
        "create",
        name,
        "--color",
        color.replace(/^#/, ""),
      ]);
    }
  }

  async ensureAllStateLabels(): Promise<void> {
    const labels = getStateLabels(this.workflow);
    const colors = getLabelColors(this.workflow);
    for (const label of labels) {
      await this.ensureLabel(label, colors[label]);
    }
  }

  async createIssue(
    title: string,
    description: string,
    label: StateLabel,
    assignees?: string[],
  ): Promise<Issue> {
    const args = [
      "issue",
      "create",
      "--title",
      title,
      "--body",
      description,
      "--label",
      label,
    ];
    if (assignees?.length) args.push("--assignee", assignees.join(","));
    const raw = await this.tea(args);
    // Parse URL to extract issue number
    const match = raw.match(/\/issues\/(\d+)$/);
    if (!match) {
      // Try to find issue by listing
      const issues = await this.listIssues({ label, state: "open" });
      return issues[0] ?? {
        iid: 0,
        title,
        description,
        labels: [label],
        state: "open",
        web_url: "",
      };
    }
    return this.getIssue(parseInt(match[1], 10));
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.tea([
        "issue",
        "list",
        "--label",
        label,
        "--state",
        "open",
        "--json",
        "number,title,body,labels,state,web_url",
      ]);
      return (JSON.parse(raw) as GiteaIssue[]).map(toIssue);
    } catch {
      return [];
    }
  }

  async listIssues(
    opts?: { label?: string; state?: "open" | "closed" | "all" },
  ): Promise<Issue[]> {
    try {
      const args = [
        "issue",
        "list",
        "--state",
        opts?.state ?? "open",
        "--json",
        "number,title,body,labels,state,web_url",
      ];
      if (opts?.label) args.push("--label", opts.label);
      const raw = await this.tea(args);
      return (JSON.parse(raw) as GiteaIssue[]).map(toIssue);
    } catch {
      return [];
    }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.tea([
      "issue",
      "view",
      String(issueId),
      "--json",
      "number,title,body,labels,state,web_url",
    ]);
    return toIssue(JSON.parse(raw) as GiteaIssue);
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    try {
      const raw = await this.tea([
        "api",
        `issues/${issueId}/comments`,
        "--method",
        "GET",
      ]);
      const comments = JSON.parse(raw) as GiteaComment[];
      return comments
        .filter((c) => !c.system)
        .map((c) => ({
          id: c.id,
          author: c.user.login,
          body: c.body,
          created_at: c.created_at,
        }));
    } catch {
      return [];
    }
  }

  async transitionLabel(
    issueId: number,
    from: StateLabel,
    to: StateLabel,
  ): Promise<void> {
    // Two-phase transition to ensure atomicity
    // Phase 1: Add new label first
    await this.tea([
      "issue",
      "update",
      String(issueId),
      "--add-label",
      to,
    ]);

    // Phase 2: Remove old state labels (best-effort)
    const issue = await this.getIssue(issueId);
    const stateLabels = getStateLabels(this.workflow);
    const currentStateLabels = issue.labels.filter(
      (l) => stateLabels.includes(l) && l !== to,
    );

    if (currentStateLabels.length > 0) {
      const args = ["issue", "update", String(issueId)];
      for (const l of currentStateLabels) args.push("--remove-label", l);
      await this.tea(args);
    }
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    await this.tea([
      "issue",
      "update",
      String(issueId),
      "--add-label",
      label,
    ]);
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ["issue", "update", String(issueId)];
    for (const l of labels) args.push("--remove-label", l);
    await this.tea(args);
  }

  async closeIssue(issueId: number): Promise<void> {
    await this.tea(["issue", "close", String(issueId)]);
  }

  async reopenIssue(issueId: number): Promise<void> {
    await this.tea(["issue", "reopen", String(issueId)]);
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    type MergedPr = {
      title: string;
      body: string;
      head_ref: string;
      web_url: string;
      merged: boolean;
    };
    const prs = await this.findPrsForIssue<MergedPr>(
      issueId,
      "merged",
    );
    if (prs.length === 0) return null;
    prs.sort(
      (a, b) => new Date(b.web_url).getTime() - new Date(a.web_url).getTime(),
    );
    return prs[0].web_url;
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    // Check open PRs first
    type OpenPr = {
      title: string;
      body: string;
      head_ref: string;
      web_url: string;
      number: number;
      review_decision?: string;
      state: string;
      mergeable?: boolean;
    };
    const open = await this.findPrsForIssue<OpenPr>(issueId, "open");
    if (open.length > 0) {
      const pr = open[0];
      let state: PrState;
      if (pr.review_decision === "APPROVED") {
        state = PrState.APPROVED;
      } else if (pr.review_decision === "CHANGES_REQUESTED") {
        state = PrState.CHANGES_REQUESTED;
      } else {
        // Check for unacknowledged reviews (Gitea doesn't have the same concept as GitHub)
        // Fall back to open state if no review decision
        state = PrState.OPEN;
      }

      const mergeable =
        pr.mergeable === true
          ? true
          : pr.mergeable === false
          ? false
          : undefined;

      return {
        state,
        url: pr.web_url,
        title: pr.title,
        sourceBranch: pr.head_ref,
        mergeable,
      };
    }

    // Check merged PRs
    type MergedPr = {
      title: string;
      body: string;
      head_ref: string;
      web_url: string;
      merged: boolean;
    };
    const merged = await this.findPrsForIssue<MergedPr>(issueId, "merged");
    if (merged.length > 0) {
      const pr = merged[0];
      return {
        state: PrState.MERGED,
        url: pr.web_url,
        title: pr.title,
        sourceBranch: pr.head_ref,
      };
    }

    // Check for closed PRs
    const all = await this.findPrsForIssue<OpenPr>(issueId, "all");
    const closedPr = all.find((pr) => pr.state === "closed");
    if (closedPr) {
      return {
        state: PrState.CLOSED,
        url: closedPr.web_url,
        title: closedPr.title,
        sourceBranch: closedPr.head_ref,
      };
    }

    return { state: PrState.CLOSED, url: null };
  }

  async mergePr(issueId: number): Promise<void> {
    type OpenPr = {
      title: string;
      body: string;
      head_ref: string;
      web_url: string;
      number: number;
    };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open");
    if (prs.length === 0) {
      throw new Error(`No open PR found for issue #${issueId}`);
    }
    await this.tea(["pr", "merge", String(prs[0].number)]);
  }

  async getPrDiff(issueId: number): Promise<string | null> {
    type OpenPr = {
      title: string;
      body: string;
      head_ref: string;
      number: number;
    };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open");
    if (prs.length === 0) return null;
    try {
      return await this.tea(["pr", "diff", String(prs[0].number)]);
    } catch {
      return null;
    }
  }

  async getPrReviewComments(issueId: number): Promise<PrReviewComment[]> {
    type OpenPr = {
      title: string;
      body: string;
      head_ref: string;
      number: number;
    };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open");
    if (prs.length === 0) return [];
    const prNumber = prs[0].number;
    const comments: PrReviewComment[] = [];

    try {
      // Get PR comments via API
      const raw = await this.tea([
        "api",
        `pulls/${prNumber}/comments`,
        "--method",
        "GET",
      ]);
      const apiComments = JSON.parse(raw) as Array<{
        id: number;
        user: { login: string };
        body: string;
        created_at: string;
        position?: { new_line?: number; path?: string };
      }>;

      for (const c of apiComments) {
        comments.push({
          id: c.id,
          author: c.user.login,
          body: c.body,
          state: "INLINE",
          created_at: c.created_at,
          path: c.position?.path,
          line: c.position?.new_line ?? undefined,
        });
      }
    } catch {
      /* best-effort */
    }

    // Sort by date
    comments.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return comments;
  }

  async addComment(issueId: number, body: string): Promise<number> {
    const raw = await this.tea([
      "api",
      `issues/${issueId}/comments`,
      "--method",
      "POST",
      "--field",
      `body=${body}`,
    ]);
    const parsed = JSON.parse(raw) as { id: number };
    return parsed.id;
  }

  async reactToIssue(issueId: number, emoji: string): Promise<void> {
    try {
      await this.tea([
        "api",
        `issues/${issueId}/reactions`,
        "--method",
        "POST",
        "--field",
        `content=${emoji}`,
      ]);
    } catch {
      /* best-effort */
    }
  }

  async issueHasReaction(issueId: number, emoji: string): Promise<boolean> {
    try {
      const raw = await this.tea([
        "api",
        `issues/${issueId}/reactions`,
        "--method",
        "GET",
      ]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch {
      return false;
    }
  }

  async reactToPr(issueId: number, emoji: string): Promise<void> {
    try {
      type OpenPr = {
        title: string;
        body: string;
        head_ref: string;
        number: number;
      };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open");
      if (prs.length === 0) return;
      await this.tea([
        "api",
        `pulls/${prs[0].number}/reactions`,
        "--method",
        "POST",
        "--field",
        `content=${emoji}`,
      ]);
    } catch {
      /* best-effort */
    }
  }

  async prHasReaction(issueId: number, emoji: string): Promise<boolean> {
    try {
      type OpenPr = {
        title: string;
        body: string;
        head_ref: string;
        number: number;
      };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open");
      if (prs.length === 0) return false;
      const raw = await this.tea([
        "api",
        `pulls/${prs[0].number}/reactions`,
        "--method",
        "GET",
      ]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch {
      return false;
    }
  }

  async reactToIssueComment(
    _issueId: number,
    commentId: number,
    emoji: string,
  ): Promise<void> {
    try {
      await this.tea([
        "api",
        `issues/comments/${commentId}/reactions`,
        "--method",
        "POST",
        "--field",
        `content=${emoji}`,
      ]);
    } catch {
      /* best-effort */
    }
  }

  async reactToPrComment(
    _issueId: number,
    commentId: number,
    emoji: string,
  ): Promise<void> {
    try {
      await this.tea([
        "api",
        `pulls/comments/${commentId}/reactions`,
        "--method",
        "POST",
        "--field",
        `content=${emoji}`,
      ]);
    } catch {
      /* best-effort */
    }
  }

  async reactToPrReview(
    _issueId: number,
    _reviewId: number,
    emoji: string,
  ): Promise<void> {
    // Gitea doesn't have separate review entities like GitHub
    // Use the same PR comment reaction API
  }

  async issueCommentHasReaction(
    issueId: number,
    commentId: number,
    emoji: string,
  ): Promise<boolean> {
    try {
      const raw = await this.tea([
        "api",
        `issues/comments/${commentId}/reactions`,
        "--method",
        "GET",
      ]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch {
      return false;
    }
  }

  async prCommentHasReaction(
    issueId: number,
    commentId: number,
    emoji: string,
  ): Promise<boolean> {
    try {
      const raw = await this.tea([
        "api",
        `pulls/comments/${commentId}/reactions`,
        "--method",
        "GET",
      ]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch {
      return false;
    }
  }

  async prReviewHasReaction(
    _issueId: number,
    _reviewId: number,
    emoji: string,
  ): Promise<boolean> {
    // Gitea doesn't have separate review entities
    return false;
  }

  async editIssue(
    issueId: number,
    updates: { title?: string; body?: string },
  ): Promise<Issue> {
    const args = ["issue", "update", String(issueId)];
    if (updates.title !== undefined) args.push("--title", updates.title);
    if (updates.body !== undefined) args.push("--body", updates.body);
    await this.tea(args);
    return this.getIssue(issueId);
  }

  /**
   * Check if work for an issue is already present on the base branch via git log.
   * Searches the last 200 commits on baseBranch for commit messages mentioning #issueId.
   * Used as a fallback when no PR exists (e.g., direct commit to main).
   */
  async isCommitOnBaseBranch(
    issueId: number,
    baseBranch: string,
  ): Promise<boolean> {
    try {
      const result = await runCommand(
        [
          "git",
          "log",
          `origin/${baseBranch}`,
          "--oneline",
          "-200",
          "--grep",
          `#${issueId}`,
        ],
        { timeoutMs: 15_000, cwd: this.repoPath },
      );
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async uploadAttachment(
    issueId: number,
    file: { filename: string; buffer: Buffer; mimeType: string },
  ): Promise<string | null> {
    try {
      const branch = "devclaw-attachments";
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `attachments/${issueId}/${Date.now()}-${safeFilename}`;
      const base64Content = file.buffer.toString("base64");

      // Get repo owner/name
      const repo = await this.getRepoInfo();
      if (!repo) return null;

      // Ensure branch exists
      let branchExists = false;
      try {
        await this.tea([
          "api",
          `repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`,
          "--method",
          "GET",
        ]);
        branchExists = true;
      } catch {
        /* doesn't exist */
      }

      if (!branchExists) {
        const raw = await this.tea([
          "repo",
          "view",
          "--json",
          "default_branch",
          "--jq",
          ".default_branch",
        ]);
        const defaultBranch = raw.trim();
        const shaRaw = await this.tea([
          "api",
          `repos/${repo.owner}/${repo.name}/git/ref/heads/${defaultBranch}`,
          "--jq",
          ".object.sha",
        ]);
        await this.tea([
          "api",
          `repos/${repo.owner}/${repo.name}/git/refs`,
          "--method",
          "POST",
          "--field",
          `ref=refs/heads/${branch}`,
          "--field",
          `sha=${shaRaw.trim()}`,
        ]);
      }

      // Upload via Contents API
      await this.tea([
        "api",
        `repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        "--method",
        "PUT",
        "--field",
        `message=attachment: ${file.filename} for issue #${issueId}`,
        "--field",
        `content=${base64Content}`,
        "--field",
        `branch=${branch}`,
      ]);

      // Get the raw file URL
      const repoInfo = await this.getRepoInfo();
      if (!repoInfo) return null;
      return `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.name}/${branch}/${filePath}`;
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.tea(["auth", "status"]);
      return true;
    } catch {
      return false;
    }
  }
}