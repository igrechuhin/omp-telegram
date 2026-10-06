import { basename } from "node:path";
import { type PiLike, execStdout } from "./types";

export interface ProjectInfo {
  repo: string;
  branch?: string;
}

async function git(pi: PiLike, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const out = execStdout(
      await pi.exec("git", ["-C", cwd, ...args], { cwd, signal: AbortSignal.timeout(3000) }),
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Repo folder name plus branch, so two worktrees of one project are distinguishable.
 * Falls back to the cwd basename outside a repository.
 */
export async function describeProject(pi: PiLike, cwd: string): Promise<ProjectInfo> {
  const top = await git(pi, ["rev-parse", "--show-toplevel"], cwd);
  if (!top) return { repo: basename(cwd) };
  const head = await git(pi, ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (head && head !== "HEAD") return { repo: basename(top), branch: head };
  const sha = await git(pi, ["rev-parse", "--short", "HEAD"], cwd);
  return { repo: basename(top), branch: sha ? `detached@${sha}` : undefined };
}
