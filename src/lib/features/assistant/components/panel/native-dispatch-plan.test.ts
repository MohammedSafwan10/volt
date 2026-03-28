import { describe, expect, it, vi } from "vitest";

import { executeNativeDispatchPlan } from "./native-dispatch-plan";

describe("executeNativeDispatchPlan", () => {
  it("follows the native dispatch cursor instead of local stage order", async () => {
    const setPlan = vi.fn(async () => ({
      success: true,
      conversationId: "conv-1",
      runId: "run-1",
      waitingApproval: false,
      hasMoreSteps: true,
      activeStep: null,
      completedStep: null,
      snapshot: null,
    }));
    const claimNextStep = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        conversationId: "conv-1",
        runId: "run-1",
        waitingApproval: false,
        hasMoreSteps: true,
        activeStep: {
          stepId: "step-file",
          stage: "file_edits",
          status: "running",
          toolIds: [],
          fileQueueKeys: ["src/app.ts"],
          fileEditConcurrency: 2,
          blockedReason: null,
        },
        completedStep: null,
        snapshot: null,
      })
      .mockResolvedValueOnce({
        success: true,
        conversationId: "conv-1",
        runId: "run-1",
        waitingApproval: false,
        hasMoreSteps: true,
        activeStep: {
          stepId: "step-eager",
          stage: "eager_tools",
          status: "running",
          toolIds: ["search"],
          fileQueueKeys: [],
          fileEditConcurrency: null,
          blockedReason: null,
        },
        completedStep: null,
        snapshot: null,
      })
      .mockResolvedValueOnce({
        success: true,
        conversationId: "conv-1",
        runId: "run-1",
        waitingApproval: false,
        hasMoreSteps: false,
        activeStep: null,
        completedStep: null,
        snapshot: null,
      });
    const completeStep = vi.fn(async () => ({
      success: true,
      conversationId: "conv-1",
      runId: "run-1",
      waitingApproval: false,
      hasMoreSteps: true,
      activeStep: null,
      completedStep: null,
      snapshot: null,
    }));

    const stageOrder: string[] = [];
    await executeNativeDispatchPlan({
      schedulingDecision: {
        executionStages: ["eager_tools", "file_edits"],
        deferUntilFileEditsComplete: false,
        fileEditConcurrency: 2,
      },
      eagerTools: [
        { id: "search", name: "workspace_search", args: {}, runAfterFileEdits: false },
      ],
      deferredTools: [],
      fileEditTasks: [
        [
          "src/app.ts",
          [{ id: "edit-1", name: "apply_patch", args: {}, queueIndex: 0 }],
        ],
      ],
      authority: {
        setPlan,
        claimNextStep,
        completeStep,
      },
      runQueuedNonFileStage: async () => {
        stageOrder.push("eager_tools");
        return [{ id: "search", name: "workspace_search", result: { success: true } }];
      },
      runFileEditStage: async () => {
        stageOrder.push("file_edits");
        return [{ id: "edit-1", name: "apply_patch", result: { success: true } }];
      },
    });

    expect(stageOrder).toEqual(["file_edits", "eager_tools"]);
    expect(setPlan).toHaveBeenCalledTimes(1);
    expect(completeStep).toHaveBeenCalledTimes(2);
  });
});
