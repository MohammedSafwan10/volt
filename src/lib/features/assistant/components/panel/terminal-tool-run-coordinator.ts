import {
  buildTerminalToolExcerpt,
  readTerminalTranscriptSlice,
  type TerminalTranscriptReader,
} from "./terminal-tool-transcript";
import { inferTerminalCommandFailure } from "$features/terminal/services/terminal-command-safety";
import type { ToolRuntimeContext } from "$core/ai/tools/runtime";
import type {
  TerminalToolExecutionMode,
  TerminalToolRunStore,
} from "./terminal-tool-run-store";

export interface TerminalCoordinatorSession extends TerminalTranscriptReader {
  id: string;
  info?: {
    shell?: string;
  };
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
  runtime?: ToolRuntimeContext;
}

export interface RunForegroundResult {
  success: boolean;
  output?: string;
  error?: string;
  meta?: {
    terminalRun?: {
      state?: string;
      commandPreview?: string;
      processId?: number;
      terminalId?: string;
      detectedUrl?: string;
      excerpt?: string;
    };
  };
}

const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_EXCERPT_LINES = 12;
const LIVE_TRANSCRIPT_POLL_MS = 120;

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
  const publishLiveTerminalUpdate = (
    input: RunForegroundInput,
    session: TerminalCoordinatorSession,
    excerpt: string,
  ) => {
    input.runtime?.onUpdate?.({
      liveStatus: "Running command...",
      meta: {
        terminalRun: {
          state: "running",
          commandPreview: input.command,
          terminalId: session.id,
          excerpt,
        },
        terminalOutput: excerpt,
      },
    });
  };

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
        publishLiveTerminalUpdate(
          input,
          session,
          buildTerminalToolExcerpt(initialSlice.text, MAX_EXCERPT_LINES),
        );

        let stopPolling = false;
        let lastPublishedOffset = initialSlice.nextOffset;
        let lastPublishedExcerpt = buildTerminalToolExcerpt(
          initialSlice.text,
          MAX_EXCERPT_LINES,
        );
        let lastPublishedTruncation = initialSlice.truncatedBeforeOffset;

        const pollPromise = session.executeCommand
          ? (async () => {
              while (!stopPolling) {
                await new Promise((resolve) =>
                  setTimeout(resolve, LIVE_TRANSCRIPT_POLL_MS),
                );
                if (stopPolling) break;

                const slice = readTerminalTranscriptSlice(
                  session,
                  captureStartOffset,
                  MAX_TRANSCRIPT_CHARS,
                );
                const excerpt = buildTerminalToolExcerpt(
                  slice.text,
                  MAX_EXCERPT_LINES,
                );

                if (
                  slice.nextOffset === lastPublishedOffset &&
                  excerpt === lastPublishedExcerpt &&
                  slice.truncatedBeforeOffset === lastPublishedTruncation
                ) {
                  continue;
                }

                lastPublishedOffset = slice.nextOffset;
                lastPublishedExcerpt = excerpt;
                lastPublishedTruncation = slice.truncatedBeforeOffset;

                deps.runStore.patch(input.runId, {
                  state: excerpt ? "streaming_output" : "running",
                  captureCurrentOffset: slice.nextOffset,
                  excerpt,
                  transcriptTruncated: slice.truncatedBeforeOffset,
                });
                publishLiveTerminalUpdate(input, session, excerpt);
              }
            })()
          : Promise.resolve();

        const completion = session.executeCommand
          ? await session.executeCommand(input.command, input.timeoutMs)
          : {
              output: initialSlice.text,
              exitCode: 0,
              timedOut: false,
            };
        stopPolling = true;
        await pollPromise;

        const finalSlice = readTerminalTranscriptSlice(
          session,
          captureStartOffset,
          MAX_TRANSCRIPT_CHARS,
        );
        const output = finalSlice.text || completion.output;
        const inferredFailure = inferTerminalCommandFailure({
          shell: session.info?.shell,
          command: input.command,
          exitCode: completion.exitCode,
          timedOut: completion.timedOut,
          output,
        });
        const effectiveExitCode = inferredFailure?.exitCode ?? completion.exitCode;
        const failureReason =
          inferredFailure?.reason ??
          getFailureReason(effectiveExitCode, completion.timedOut);

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
            meta: {
              terminalRun: {
                state: "detached",
                commandPreview: input.command,
                terminalId: session.id,
                processId: detached.processId,
                detectedUrl: detached.detectedUrl,
                excerpt,
              },
            },
          };
        }

        deps.runStore.patch(input.runId, {
          state: getCompletedState(effectiveExitCode, completion.timedOut),
          captureCurrentOffset: finalSlice.nextOffset,
          captureEndOffset: finalSlice.nextOffset,
          excerpt: buildTerminalToolExcerpt(output, MAX_EXCERPT_LINES),
          transcriptTruncated: finalSlice.truncatedBeforeOffset,
          exitCode: effectiveExitCode,
          endedAt: Date.now(),
          failureReason,
        });

        return {
          success: !failureReason,
          output,
          error: failureReason,
          meta: {
            terminalRun: {
              state: getCompletedState(effectiveExitCode, completion.timedOut),
              commandPreview: input.command,
              terminalId: session.id,
              excerpt: buildTerminalToolExcerpt(output, MAX_EXCERPT_LINES),
            },
          },
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
