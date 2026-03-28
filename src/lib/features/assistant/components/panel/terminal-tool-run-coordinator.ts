import {
  buildTerminalToolExcerpt,
  readTerminalTranscriptSlice,
  type TerminalTranscriptReader,
} from "./terminal-tool-transcript";
import type {
  TerminalToolExecutionMode,
  TerminalToolRunStore,
} from "./terminal-tool-run-store";

export interface TerminalCoordinatorSession extends TerminalTranscriptReader {
  id: string;
  getCleanOutputCursor: () => number;
  executeCommand?: (
    command: string,
    timeoutMs: number,
  ) => Promise<{
    output: string;
    exitCode: number;
    timedOut: boolean;
  }>;
}

export interface TerminalDetachedProcessInfo {
  processId: number;
  detectedUrl?: string;
}

export interface TerminalToolRunCoordinatorDeps {
  runStore: TerminalToolRunStore;
  getSession: (cwd?: string) => Promise<TerminalCoordinatorSession>;
  classifyLongRunning: (command: string, transcript: string) => boolean;
  trackDetachedProcess: (
    command: string,
    cwd?: string,
    terminalId?: string,
  ) => TerminalDetachedProcessInfo | Promise<TerminalDetachedProcessInfo>;
}

export interface RunForegroundInput {
  runId: string;
  toolCallId: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface RunForegroundResult {
  success: boolean;
  output?: string;
  error?: string;
}

const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_EXCERPT_LINES = 12;

function getFailureReason(exitCode: number, timedOut: boolean): string | undefined {
  if (timedOut) {
    return "Command timed out";
  }
  if (exitCode !== 0) {
    return `Command failed with exit code ${exitCode}`;
  }
  return undefined;
}

function getCompletedState(exitCode: number, timedOut: boolean) {
  return exitCode === 0 && !timedOut ? "completed" : "failed";
}

export function createTerminalToolRunCoordinator(
  deps: TerminalToolRunCoordinatorDeps,
) {
  return {
    async runForeground(input: RunForegroundInput): Promise<RunForegroundResult> {
      deps.runStore.upsert({
        runId: input.runId,
        toolCallId: input.toolCallId,
        command: input.command,
        cwd: input.cwd,
        captureStartOffset: 0,
        captureCurrentOffset: 0,
        executionMode: "foreground",
        state: "launching",
        startedAt: Date.now(),
      });

      try {
        const session = await deps.getSession(input.cwd);
        const captureStartOffset = session.getCleanOutputCursor();

        deps.runStore.patch(input.runId, {
          terminalId: session.id,
          captureStartOffset,
          captureCurrentOffset: captureStartOffset,
          state: "running",
        });

        const initialSlice = readTerminalTranscriptSlice(
          session,
          captureStartOffset,
          MAX_TRANSCRIPT_CHARS,
        );

        const completion = session.executeCommand
          ? await session.executeCommand(input.command, input.timeoutMs)
          : {
              output: initialSlice.text,
              exitCode: 0,
              timedOut: false,
            };

        const finalSlice = readTerminalTranscriptSlice(
          session,
          captureStartOffset,
          MAX_TRANSCRIPT_CHARS,
        );
        const output = finalSlice.text || completion.output;

        if (deps.classifyLongRunning(input.command, output)) {
          deps.runStore.patch(input.runId, {
            state: "detaching",
            executionMode: "background_detached",
            captureCurrentOffset: finalSlice.nextOffset,
          });

          const detached = await deps.trackDetachedProcess(
            input.command,
            input.cwd,
            session.id,
          );
          const excerpt = buildTerminalToolExcerpt(output, MAX_EXCERPT_LINES);

          deps.runStore.patch(input.runId, {
            state: "detached",
            executionMode: "background_detached" satisfies TerminalToolExecutionMode,
            processId: detached.processId,
            detectedUrl: detached.detectedUrl,
            captureCurrentOffset: finalSlice.nextOffset,
            captureEndOffset: finalSlice.nextOffset,
            excerpt,
            transcriptTruncated: finalSlice.truncatedBeforeOffset,
            endedAt: Date.now(),
          });

          return {
            success: true,
            output: excerpt,
          };
        }

        deps.runStore.patch(input.runId, {
          state: getCompletedState(completion.exitCode, completion.timedOut),
          captureCurrentOffset: finalSlice.nextOffset,
          captureEndOffset: finalSlice.nextOffset,
          excerpt: buildTerminalToolExcerpt(output, MAX_EXCERPT_LINES),
          transcriptTruncated: finalSlice.truncatedBeforeOffset,
          exitCode: completion.exitCode,
          endedAt: Date.now(),
          failureReason: getFailureReason(
            completion.exitCode,
            completion.timedOut,
          ),
        });

        return {
          success: completion.exitCode === 0 && !completion.timedOut,
          output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.runStore.patch(input.runId, {
          state: "failed",
          failureReason: message,
          endedAt: Date.now(),
        });
        return {
          success: false,
          error: message,
        };
      }
    },
  };
}
