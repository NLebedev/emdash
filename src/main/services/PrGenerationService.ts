import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../lib/logger';
import { getProvider, type ProviderId } from '@shared/providers/registry';

const execAsync = promisify(exec);
const execFileAsync = promisify(require('child_process').execFile);

export interface GeneratedPrContent {
  title: string;
  description: string;
}

export interface GeneratedCommitMessage {
  message: string;
  providerId?: string;
  source: 'provider' | 'heuristic';
}

/**
 * PrGenerationService uses CLI providers (like Claude Code) to generate
 * PR titles and descriptions based on git diffs.
 */
export class PrGenerationService {
  /**
   * Main entry point: Generate PR content for a worktree.
   * Fetches the diff against base and invokes the provider.
   */
  async generatePrContent(
    taskPath: string,
    base: string = 'main',
    providerId: string | null = null
  ): Promise<GeneratedPrContent | null> {
    const activeProviderId = (providerId || 'claude') as ProviderId;

    if (!this.canUseForPrGeneration(activeProviderId)) {
      log.debug(`Provider ${activeProviderId} does not support PR generation`);
      return null;
    }

    try {
      // 1. Get diff and commit subjects
      const [diffResult, logResult] = await Promise.all([
        execAsync(`git diff origin/${base}...HEAD`, {
          cwd: taskPath,
          maxBuffer: 10 * 1024 * 1024,
        }),
        execAsync(`git log --oneline origin/${base}..HEAD`, { cwd: taskPath }),
      ]);

      const diff = (diffResult.stdout || '').trim();
      const commits = (logResult.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (!diff) {
        log.debug('No diff found for PR generation');
        return null;
      }

      // 2. Invoke provider
      return await this.generateWithProvider(activeProviderId, taskPath, diff, commits);
    } catch (error) {
      log.error('Failed to fetch git context for PR generation', error);
      return null;
    }
  }

  /**
   * Generate a commit message from staged changes.
   */
  async generateCommitMessage(
    taskPath: string,
    providerId: string | null = null
  ): Promise<GeneratedCommitMessage | null> {
    const activeProviderId = (providerId || 'claude') as ProviderId;

    if (!this.canUseForPrGeneration(activeProviderId)) {
      return this.generateHeuristicCommitMessage(taskPath);
    }

    try {
      const context = await this.getStagedGitContext(taskPath);
      if (!context.stagedDiffPatch && context.stagedFiles.length === 0) {
        return null;
      }

      const prompt = this.buildCommitMessagePrompt(
        context.stagedDiffStat,
        context.stagedDiffPatch,
        context.stagedFiles
      );

      const provider = getProvider(activeProviderId);
      const cliCommand = provider!.cli!;

      // Try up to 2 times
      for (let attempt = 0; attempt < 2; attempt++) {
        const { result, shouldRetry } = await this.spawnProvider(
          activeProviderId,
          cliCommand,
          provider,
          taskPath,
          prompt
        );

        if (result && (result as any).message) {
          return {
            message: (result as any).message,
            providerId: activeProviderId,
            source: 'provider',
          };
        }

        // Handle if parseProviderResponse returned GeneratedPrContent instead of commit message
        if (result && (result as any).title) {
          return {
            message: (result as any).title,
            providerId: activeProviderId,
            source: 'provider',
          };
        }

        if (!shouldRetry) break;
      }

      return this.generateHeuristicCommitMessage(taskPath);
    } catch (error) {
      log.error('Failed to generate commit message', error);
      return this.generateHeuristicCommitMessage(taskPath);
    }
  }

  private async generateHeuristicCommitMessage(taskPath: string): Promise<GeneratedCommitMessage> {
    try {
      const { stdout } = await execAsync('git diff --cached --name-only', { cwd: taskPath });
      const files = stdout
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
      if (files.length === 0) return { message: 'Update files', source: 'heuristic' };
      if (files.length === 1) return { message: `Update ${files[0]}`, source: 'heuristic' };
      return { message: `Update ${files.length} files`, source: 'heuristic' };
    } catch {
      return { message: 'Update files', source: 'heuristic' };
    }
  }

  /**
   * Check if a provider can be used for automated PR generation.
   * Requires a CLI and support for initial prompts.
   */
  private canUseForPrGeneration(providerId: ProviderId): boolean {
    const provider = getProvider(providerId);
    if (!provider || !provider.cli) return false;

    // Currently only allow providers that support passing a prompt via CLI arg.
    // (initialPromptFlag: '' means positional arg, '-i' means flag)
    return provider.initialPromptFlag !== undefined;
  }

  private async generateWithProvider(
    providerId: ProviderId,
    taskPath: string,
    diff: string,
    commits: string[]
  ): Promise<GeneratedPrContent | null> {
    if (!this.canUseForPrGeneration(providerId)) {
      return null;
    }

    const provider = getProvider(providerId);
    const cliCommand = provider!.cli!;

    // Build prompt for PR generation
    const prompt = this.buildPrGenerationPrompt(diff, commits);

    // Try up to 2 times: retry once if the process succeeded but JSON parsing failed
    for (let attempt = 0; attempt < 2; attempt++) {
      const { result, shouldRetry } = await this.spawnProvider(
        providerId,
        cliCommand,
        provider,
        taskPath,
        prompt
      );
      if (result) return result as GeneratedPrContent;
      if (!shouldRetry) break;
      log.debug(`Retrying provider ${providerId} (attempt ${attempt + 2}/2) after parse failure`);
    }

    return null;
  }

  /**
   * Spawn a provider CLI process and collect its output.
   * Returns the parsed result (if any) and whether a retry is worthwhile.
   */
  private spawnProvider(
    providerId: ProviderId,
    cliCommand: string,
    provider: ReturnType<typeof getProvider>,
    taskPath: string,
    prompt: string
  ): Promise<{ result: GeneratedPrContent | { message: string } | null; shouldRetry: boolean }> {
    return new Promise((resolve) => {
      const timeout = 60000;
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const done = (
        result: GeneratedPrContent | { message: string } | null,
        shouldRetry: boolean
      ) => {
        if (resolved) return;
        resolved = true;
        resolve({ result, shouldRetry });
      };

      const args: string[] = [];
      const isClaudeProvider = providerId === 'claude';

      if (isClaudeProvider) {
        args.push('-p', prompt, '--output-format', 'json');
        if (provider!.autoApproveFlag) {
          args.push(provider!.autoApproveFlag);
        }
      } else {
        if (provider!.defaultArgs?.length) {
          args.push(...provider!.defaultArgs);
        }
        if (provider!.autoApproveFlag) {
          args.push(provider!.autoApproveFlag);
        }
      }

      if (!isClaudeProvider && provider!.initialPromptFlag !== undefined) {
        if (provider!.initialPromptFlag) {
          args.push(provider!.initialPromptFlag);
        }
        args.push(prompt);
      }

      const child = spawn(cliCommand, args, {
        cwd: taskPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Force non-interactive modes for some CLIs if possible
          PAGER: 'cat',
          TERM: 'dumb',
        },
      });

      const timeoutId = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        log.debug(`Provider ${providerId} invocation timed out`);
        done(null, false);
      }, timeout);

      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
      }

      child.on('close', (code: number) => {
        clearTimeout(timeoutId);
        if (code !== 0 && !stdout.trim()) {
          log.debug(`Provider ${providerId} exited with code ${code}`, { stderr });
          done(null, false);
          return;
        }

        const result = this.parseProviderResponse(stdout);
        if (result) {
          log.info(`Successfully generated content with ${providerId}`);
          done(result, false);
        } else {
          log.debug(`Failed to parse response from ${providerId}`, { stdout, stderr });
          done(null, true);
        }
      });

      child.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        log.debug(`Failed to spawn ${providerId}`, { error });
        done(null, false);
      });

      if (child.stdin) {
        child.stdin.end();
      }
    });
  }

  private buildPrGenerationPrompt(diff: string, commits: string[]): string {
    const diffLimit = 15000;
    const truncatedDiff =
      diff.length > diffLimit ? diff.slice(0, diffLimit) + '\n\n[Diff truncated...]' : diff;

    return `You are helping a developer generate a Pull Request title and description based on their git changes.

Commits in this PR:
${commits.map((c) => `- ${c}`).join('\n')}

Git Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Respond with ONLY valid JSON — no markdown fences, no conversational filler.
Format:
{
  "title": "A concise PR title (max 72 chars, use conventional commit format if applicable)",
  "description": "A well-structured markdown description using proper markdown formatting. Use ## for section headers, - or * for lists, \`code\` for inline code, and proper line breaks.\n\nUse actual newlines (\\n in JSON) for line breaks, not literal \\n text. Keep it straightforward and to the point."
}`;
  }

  private async getStagedGitContext(taskPath: string): Promise<{
    stagedDiffStat: string;
    stagedDiffPatch: string;
    stagedFiles: string[];
  }> {
    let stagedDiffStat = '';
    let stagedDiffPatch = '';
    let stagedFiles: string[] = [];

    try {
      const { stdout: statOut } = await execAsync('git diff --cached --stat', {
        cwd: taskPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      stagedDiffStat = (statOut || '').trim();
    } catch {}

    try {
      const { stdout: filesOut } = await execAsync('git diff --cached --name-only', {
        cwd: taskPath,
        maxBuffer: 2 * 1024 * 1024,
      });
      stagedFiles = (filesOut || '')
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean);
    } catch {}

    try {
      const { stdout: patchOut } = await execAsync('git diff --cached --no-color --no-ext-diff', {
        cwd: taskPath,
        maxBuffer: 20 * 1024 * 1024,
      });
      stagedDiffPatch = (patchOut || '').trim();
    } catch {}

    return {
      stagedDiffStat,
      stagedDiffPatch,
      stagedFiles,
    };
  }

  private buildCommitMessagePrompt(
    stagedDiffStat: string,
    stagedDiffPatch: string,
    stagedFiles: string[]
  ): string {
    const filesContext =
      stagedFiles.length > 0
        ? `\n\nStaged files:\n${stagedFiles
            .slice(0, 80)
            .map((file) => `- ${file}`)
            .join('\n')}`
        : '';
    const statsContext = stagedDiffStat ? `\n\nStaged diff stats:\n${stagedDiffStat}` : '';
    const patchLimit = 5000;
    const patchContext = stagedDiffPatch
      ? `\n\nStaged patch:\n${stagedDiffPatch.slice(0, patchLimit)}${stagedDiffPatch.length > patchLimit ? '\n...' : ''}`
      : '';

    return `Generate exactly one git commit message for these STAGED changes.

Requirements:
- Return a single concise commit message line.
- Use conventional commit style when appropriate (feat:, fix:, refactor:, docs:, test:, chore:, etc.).
- Keep it under 72 characters.
- Focus on what changed, not why the model generated it.
- Do not include markdown, code fences, bullet points, or explanation.

${filesContext}${statsContext}${patchContext}

Respond in JSON only:
{
  "message": "your commit message"
}`;
  }

  private stripAnsi(text: string): string {
    // Covers CSI sequences, OSC sequences, and other common escape codes
    // eslint-disable-next-line no-control-regex
    return text.replace(
      /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[^[(\x1b]*?[a-zA-Z]/g,
      ''
    );
  }

  private parseProviderResponse(response: string): GeneratedPrContent | { message: string } | null {
    try {
      const clean = this.stripAnsi(response).trim();
      if (!clean) return null;

      // 1. Try direct JSON parse
      try {
        const parsed = JSON.parse(clean);
        if (this.isValidResponse(parsed)) return parsed;
      } catch {}

      // 2. Try to find JSON block in the output
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (this.isValidResponse(parsed)) return parsed;
        } catch {}
      }

      return null;
    } catch (error) {
      log.debug('Failed to parse provider response', { error, response });
      return null;
    }
  }

  private isValidResponse(parsed: any): parsed is GeneratedPrContent | { message: string } {
    if (!parsed || typeof parsed !== 'object') return false;
    return (
      (typeof parsed.title === 'string' && typeof parsed.description === 'string') ||
      typeof parsed.message === 'string'
    );
  }
}

export const prGenerationService = new PrGenerationService();
