<script lang="ts">
  /**
   * AssistantPanel - Main AI assistant interface
   * 
   * Docs consulted:
   * - Gemini API: function calling format with functionDeclarations
   * - Tauri v2: path security and canonicalization
   * - Security best practices for approval gates
   */
  import { UIIcon } from '$lib/components/ui';
  import { assistantStore, type ToolCall, type ImageAttachment, IMAGE_LIMITS } from '$lib/stores/assistant.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { aiSettingsStore, type AIMode } from '$lib/stores/ai.svelte';
  import { streamChat, type ChatMessage, type ContentPart, type FunctionResponsePart } from '$lib/services/ai';
  import { getSystemPrompt } from '$lib/services/ai/prompts';
  import { getToolsForMode, validateToolCall as validateTool, executeToolCall } from '$lib/services/ai/tools';
  import MessageList from './MessageList.svelte';
  import ChatInputBar from './ChatInputBar.svelte';
  import { open } from '@tauri-apps/plugin-dialog';

  // Focus the input when panel opens
  let inputRef: HTMLTextAreaElement | undefined = $state();

  $effect(() => {
    if (assistantStore.panelOpen && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  function toProviderMessages(messages: typeof assistantStore.messages): ChatMessage[] {
    const out: ChatMessage[] = [];

    for (const msg of messages) {
      // Handle tool messages - convert to function response
      // These are the results of tool executions that need to go back to the model
      if (msg.role === 'tool' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          const responsePart: FunctionResponsePart = {
            type: 'function_response',
            id: tc.id,
            name: tc.name,
            response: {
              success: tc.status === 'completed',
              output: tc.output ?? tc.error ?? 'No output'
            }
          };
          out.push({
            role: 'user', // Function responses go as user role per Gemini API
            content: '',
            parts: [responsePart]
          });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        // CRITICAL: Include function calls in assistant message for multi-turn
        // Gemini requires the model's function call to be in history before function response
        const hasToolCalls = msg.inlineToolCalls && msg.inlineToolCalls.length > 0;
        
        if (hasToolCalls) {
          // Build parts: text content + function calls
          const parts: ContentPart[] = [];
          
          // Add text content if present
          if (msg.content && msg.content.trim()) {
            parts.push({ type: 'text', text: msg.content });
          }
          
          // Add function call parts - these tell Gemini what the model called
          // CRITICAL: Include thoughtSignature for Gemini 3 models
          for (const tc of msg.inlineToolCalls!) {
            parts.push({
              type: 'function_call',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              // Preserve thought signature for Gemini 3 multi-turn function calling
              thoughtSignature: tc.thoughtSignature
            });
          }
          
          out.push({ role: 'assistant', content: msg.content, parts });
        } else {
          // No tool calls, just text content
          out.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }

      if (msg.role !== 'user') continue;

      const attachments = msg.attachments ?? [];
      const imageAttachments = attachments.filter(a => a.type === 'image') as ImageAttachment[];

      if (imageAttachments.length === 0) {
        out.push({ role: 'user', content: msg.content });
        continue;
      }

      const parts: ContentPart[] = [];
      if (msg.content.trim().length > 0) {
        parts.push({ type: 'text', text: msg.content });
      }
      for (const img of imageAttachments) {
        parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
      }

      out.push({ role: 'user', content: msg.content, parts });
    }

    return out;
  }

  async function handleSend(): Promise<void> {
    const content = assistantStore.inputValue.trim();
    if (!content && assistantStore.pendingAttachments.length === 0) return;

    // Cancel any existing stream (cancel-by-default policy)
    if (assistantStore.isStreaming) {
      assistantStore.stopStreaming();
    }

    // Add user message with attached context
    const context = [...assistantStore.attachedContext];
    assistantStore.addUserMessage(content, context);
    
    // Clear input and context
    assistantStore.setInputValue('');
    assistantStore.clearContext();

    const controller = assistantStore.startStreaming();

    // Use centralized system prompt from prompts module
    // Get the selected model for the current mode from AI settings
    const selectedModel = aiSettingsStore.modelPerMode[assistantStore.currentMode];
    const systemPrompt = getSystemPrompt({
      mode: assistantStore.currentMode,
      provider: 'gemini',
      model: selectedModel,
      workspaceRoot: projectStore.rootPath ?? undefined
    });

    // Get tools for current mode
    const tools = getToolsForMode(assistantStore.currentMode);

    // Tool loop: keep streaming until model finishes without tool calls
    try {
      await runToolLoop(systemPrompt, tools, controller);
    } finally {
      // Always reset streaming state when done
      assistantStore.isStreaming = false;
      assistantStore.abortController = null;
    }
  }

  /**
   * Run the tool loop - stream model response, execute tools, send results back
   * Continues until model finishes without requesting tool calls
   * 
   * KEY: We use ONE assistant message for the entire interaction.
   * Tool calls are shown inline, and content accumulates in the same message.
   */
  async function runToolLoop(
    systemPrompt: string,
    tools: ReturnType<typeof getToolsForMode>,
    controller: AbortController,
    maxIterations = 10
  ): Promise<void> {
    // Create ONE message for the entire response (like Kiro/Cursor)
    const msgId = assistantStore.addAssistantMessage('', true);
    let fullContent = '';
    let fullThinking = '';
    let iteration = 0;
    
    while (iteration < maxIterations) {
      iteration++;
      
      if (controller.signal.aborted) return;

      // Build messages for this iteration
      const providerMessages = toProviderMessages(assistantStore.messages);
      
      let iterationContent = '';
      let iterationThinking = '';
      const pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

      try {
        for await (const chunk of streamChat({
          messages: providerMessages,
          systemPrompt,
          tools,
          stream: true
        }, assistantStore.currentMode, controller.signal)) {
          if (controller.signal.aborted) return;

          if (chunk.type === 'content' && chunk.content) {
            iterationContent += chunk.content;
            // Append text to message for interleaved rendering (like Kiro)
            assistantStore.appendTextToMessage(msgId, chunk.content, true);
          }

          if (chunk.type === 'thinking' && chunk.thinking) {
            iterationThinking += chunk.thinking;
            assistantStore.updateAssistantThinking(msgId, fullThinking + iterationThinking, true);
          }

          if (chunk.type === 'tool_call' && chunk.toolCall) {
            // Collect tool calls - we'll execute them after streaming completes
            pendingToolCalls.push(chunk.toolCall);
            
            // Show tool call inline in the current message immediately
            // This adds it to contentParts in order, so it appears between text chunks
            const validation = validateTool(chunk.toolCall.name, chunk.toolCall.arguments, assistantStore.currentMode);
            const toolCall: ToolCall = {
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: chunk.toolCall.arguments,
              status: 'pending' as const,
              requiresApproval: validation.requiresApproval,
              // Preserve thought signature for Gemini 3 multi-turn function calling
              thoughtSignature: chunk.toolCall.thoughtSignature
            };
            // Add to current message for inline display (interleaved with text)
            assistantStore.addToolCallToMessage(msgId, toolCall);
          }

          if (chunk.type === 'error') {
            const error = chunk.error ?? 'Unknown error';
            const currentContent = fullContent + iterationContent;
            assistantStore.updateAssistantMessage(msgId, currentContent ? `${currentContent}\n\nError: ${error}` : `Error: ${error}`, false);
            showToast({ message: error, type: 'error' });
            return;
          }
        }

        // Accumulate content from this iteration
        fullContent += iterationContent;
        fullThinking += iterationThinking;
        
        // Update thinking and streaming state (content is already updated via appendTextToMessage)
        if (fullThinking) {
          assistantStore.updateAssistantThinking(msgId, fullThinking, pendingToolCalls.length > 0);
        }
        // Just update streaming state, don't overwrite content (it's managed via contentParts)
        assistantStore.messages = assistantStore.messages.map(msg =>
          msg.id === msgId ? { ...msg, isStreaming: pendingToolCalls.length > 0 } : msg
        );

        // If no tool calls, we're done
        if (pendingToolCalls.length === 0) {
          return;
        }

        // Execute tool calls and collect results
        const toolResults: Array<{ id: string; name: string; result: { success: boolean; output?: string; error?: string } }> = [];
        
        // Check if any tools require approval
        const toolsNeedingApproval = pendingToolCalls.filter(tc => {
          const validation = validateTool(tc.name, tc.arguments, assistantStore.currentMode);
          return validation.requiresApproval;
        });
        
        // If there are tools needing approval, PAUSE and wait for user
        if (toolsNeedingApproval.length > 0) {
          // Mark streaming as paused (waiting for approval)
          assistantStore.messages = assistantStore.messages.map(msg =>
            msg.id === msgId ? { ...msg, isStreaming: false } : msg
          );
          
          // Wait for all approval-required tools to be resolved
          // The user will click Approve/Deny buttons which update the tool status
          await waitForToolApprovals(msgId, toolsNeedingApproval.map(tc => tc.id), controller.signal);
          
          if (controller.signal.aborted) return;
        }
        
        // Now execute tools (approved ones will run, denied ones will be skipped)
        for (const tc of pendingToolCalls) {
          if (controller.signal.aborted) return;
          
          // Check current status - user may have approved/denied while we waited
          const currentMsg = assistantStore.messages.find(m => m.id === msgId);
          const currentToolCall = currentMsg?.inlineToolCalls?.find(t => t.id === tc.id);
          
          // Skip if already cancelled/denied
          if (currentToolCall?.status === 'cancelled') {
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { success: false, error: 'Tool execution denied by user' }
            });
            continue;
          }
          
          // Skip if already completed (shouldn't happen but safety check)
          if (currentToolCall?.status === 'completed' || currentToolCall?.status === 'failed') {
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { 
                success: currentToolCall.status === 'completed', 
                output: currentToolCall.output,
                error: currentToolCall.error 
              }
            });
            continue;
          }
          
          const validation = validateTool(tc.name, tc.arguments, assistantStore.currentMode);
          
          if (!validation.valid) {
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { success: false, error: validation.error }
            });
            assistantStore.updateToolCallInMessage(msgId, tc.id, {
              status: 'failed',
              error: validation.error,
              endTime: Date.now()
            });
            continue;
          }

          // Execute the tool - update in the message
          assistantStore.updateToolCallInMessage(msgId, tc.id, { status: 'running', startTime: Date.now() });
          
          // Check if this is a file write tool that supports streaming
          const isFileWriteTool = tc.name === 'write_file' || tc.name === 'create_file';
          
          try {
            const result = await executeToolCall(tc.name, tc.arguments, {
              signal: controller.signal,
              enableStreaming: isFileWriteTool,
              onStreamingProgress: isFileWriteTool ? (progress) => {
                assistantStore.updateToolCallInMessage(msgId, tc.id, {
                  streamingProgress: progress
                });
              } : undefined
            });
            toolResults.push({ id: tc.id, name: tc.name, result });
            
            assistantStore.updateToolCallInMessage(msgId, tc.id, {
              status: result.success ? 'completed' : 'failed',
              output: result.output,
              error: result.error,
              endTime: Date.now(),
              streamingProgress: undefined
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            toolResults.push({ id: tc.id, name: tc.name, result: { success: false, error: errorMsg } });
            assistantStore.updateToolCallInMessage(msgId, tc.id, {
              status: 'failed',
              error: errorMsg,
              endTime: Date.now(),
              streamingProgress: undefined
            });
          }
        }

        // Add tool results to conversation as a special message
        // This will be converted to functionResponse parts for the next API call
        addToolResultsToConversation(pendingToolCalls, toolResults);

      } catch (err) {
        if (controller.signal.aborted) return;

        const msg = err instanceof Error ? err.message : 'Unknown error';
        assistantStore.updateAssistantMessage(msgId, fullContent ? `${fullContent}\n\nError: ${msg}` : `Error: ${msg}`, false);
        showToast({ message: msg, type: 'error' });
        return;
      }
    }

    // Max iterations reached - mark message as complete
    assistantStore.updateAssistantMessage(msgId, fullContent, false);
    if (fullThinking) {
      assistantStore.updateAssistantThinking(msgId, fullThinking, false);
    }
    showToast({ message: 'Tool loop reached maximum iterations', type: 'warning' });
  }

  /**
   * Add tool results to the conversation for the next API call
   */
  function addToolResultsToConversation(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    results: Array<{ id: string; name: string; result: { success: boolean; output?: string; error?: string } }>
  ): void {
    // We need to add both the assistant's function calls and the user's function responses
    // to maintain proper conversation structure for Gemini
    
    // First, update the last assistant message to include function call parts
    // (This is already done via the streaming, but we need to ensure the message structure is correct)
    
    // Then add a "tool" message with the results that will be converted to functionResponse
    for (const result of results) {
      const tc = toolCalls.find(t => t.id === result.id);
      if (!tc) continue;
      
      // Add as a tool message - toProviderMessages will convert this
      assistantStore.addToolMessage({
        id: result.id,
        name: result.name,
        arguments: tc.arguments,
        status: result.result.success ? 'completed' : 'failed',
        output: result.result.output,
        error: result.result.error
      });
    }
  }

  /**
   * Wait for user to approve or deny tools that require approval
   * Polls the tool status until all are resolved (not 'pending')
   */
  function waitForToolApprovals(
    messageId: string,
    toolIds: string[],
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        // Check if aborted
        if (signal.aborted) {
          clearInterval(checkInterval);
          resolve();
          return;
        }
        
        // Find the message and check tool statuses
        const msg = assistantStore.messages.find(m => m.id === messageId);
        if (!msg?.inlineToolCalls) {
          clearInterval(checkInterval);
          resolve();
          return;
        }
        
        // Check if all tools needing approval have been resolved
        const allResolved = toolIds.every(toolId => {
          const tool = msg.inlineToolCalls?.find(t => t.id === toolId);
          // Resolved means not 'pending' anymore
          return tool && tool.status !== 'pending';
        });
        
        if (allResolved) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100); // Check every 100ms
      
      // Also listen for abort
      signal.addEventListener('abort', () => {
        clearInterval(checkInterval);
        resolve();
      });
    });
  }



  /**
   * Execute a tool call and update its status
   * Supports streaming progress for file write operations
   */
  async function executeToolAndUpdate(toolCall: ToolCall, signal?: AbortSignal): Promise<void> {
    assistantStore.updateToolCall(toolCall.id, {
      status: 'running',
      startTime: Date.now()
    });

    // Check if this is a file write tool that supports streaming
    const isFileWriteTool = toolCall.name === 'write_file' || toolCall.name === 'create_file';

    try {
      const result = await executeToolCall(toolCall.name, toolCall.arguments, {
        signal,
        enableStreaming: isFileWriteTool,
        onStreamingProgress: isFileWriteTool ? (progress) => {
          assistantStore.updateToolCall(toolCall.id, {
            streamingProgress: progress
          });
        } : undefined
      });
      
      if (result.success) {
        assistantStore.updateToolCall(toolCall.id, {
          status: 'completed',
          output: result.output,
          endTime: Date.now(),
          streamingProgress: undefined // Clear progress on completion
        });
      } else {
        assistantStore.updateToolCall(toolCall.id, {
          status: 'failed',
          error: result.error,
          endTime: Date.now(),
          streamingProgress: undefined
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      assistantStore.updateToolCall(toolCall.id, {
        status: 'failed',
        error: errorMsg,
        endTime: Date.now(),
        streamingProgress: undefined
      });
    }
  }

  function handleStop(): void {
    assistantStore.stopStreaming();
  }

  function handleModeChange(mode: AIMode): void {
    assistantStore.setMode(mode);
  }

  function handleAttachCurrentFile(): void {
    const activeFile = editorStore.activeFile;
    if (!activeFile) {
      showToast({ message: 'No file is currently open', type: 'warning' });
      return;
    }

    // Use new attachment model
    const result = assistantStore.attachFile(activeFile.path, activeFile.content);
    if (!result.success) {
      showToast({ message: result.error ?? 'Failed to attach file', type: 'warning' });
    }

    // Also add to legacy context for backward compatibility
    assistantStore.attachContext({
      type: 'file',
      path: activeFile.path,
      content: activeFile.content,
      label: activeFile.path.split('/').pop() ?? activeFile.path
    });
  }

  function handleAttachSelection(): void {
    import('$lib/services/monaco-models').then(({ getEditorSelection }) => {
      const selection = getEditorSelection();
      if (selection && selection.text) {
        // Use new attachment model with range
        const result = assistantStore.attachSelection(
          selection.text,
          selection.path ?? undefined,
          selection.range ? {
            startLine: selection.range.startLineNumber,
            startCol: selection.range.startColumn,
            endLine: selection.range.endLineNumber,
            endCol: selection.range.endColumn
          } : undefined
        );
        
        if (!result.success) {
          showToast({ message: result.error ?? 'Failed to attach selection', type: 'warning' });
          return;
        }

        // Also add to legacy context
        assistantStore.attachContext({
          type: 'selection',
          path: selection.path ?? undefined,
          content: selection.text,
          label: `Selection from ${selection.path?.split('/').pop() ?? 'editor'}`
        });
      } else {
        showToast({ message: 'No text selected in editor', type: 'warning' });
      }
    }).catch(() => {
      showToast({ message: 'Failed to get selection', type: 'error' });
    });
  }

  /**
   * Handle image attachment from file (drag & drop or paste)
   */
  async function handleAttachImage(file: File): Promise<void> {
    // Validate mime type
    const mimeType = file.type as typeof IMAGE_LIMITS.allowedMimeTypes[number];
    if (!IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
      showToast({ 
        message: `Unsupported image type: ${file.type}. Use PNG, JPEG, or WebP.`, 
        type: 'warning' 
      });
      return;
    }

    // Check file size
    if (file.size > IMAGE_LIMITS.maxImageBytes) {
      const maxMB = IMAGE_LIMITS.maxImageBytes / (1024 * 1024);
      showToast({ 
        message: `Image too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB`, 
        type: 'warning' 
      });
      return;
    }

    try {
      // Read file as base64
      const base64Data = await readFileAsBase64(file);
      
      // Get image dimensions
      const dimensions = await getImageDimensions(base64Data, mimeType);
      
      // Add to attachments
      const result = assistantStore.attachImage(
        file.name,
        mimeType,
        base64Data,
        dimensions
      );

      if (!result.success) {
        showToast({ message: result.error ?? 'Failed to attach image', type: 'warning' });
      }
    } catch (err) {
      showToast({ message: 'Failed to read image file', type: 'error' });
    }
  }

  /**
   * Open file picker for images
   */
  async function handleAttachImageFromPicker(): Promise<void> {
    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp']
        }]
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      
      for (const path of paths) {
        // Read file using Tauri fs
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const bytes = await readFile(path);
        
        // Convert to base64
        const base64Data = btoa(
          bytes.reduce((data: string, byte: number) => data + String.fromCharCode(byte), '')
        );
        
        // Determine mime type from extension
        const ext = path.split('.').pop()?.toLowerCase();
        let mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png';
        if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'webp') mimeType = 'image/webp';
        
        // Get filename
        const filename = path.split(/[/\\]/).pop() ?? 'image';
        
        // Get dimensions
        const dimensions = await getImageDimensions(base64Data, mimeType);
        
        // Add to attachments
        const result = assistantStore.attachImage(filename, mimeType, base64Data, dimensions);
        if (!result.success) {
          showToast({ message: result.error ?? 'Failed to attach image', type: 'warning' });
        }
      }
    } catch (err) {
      showToast({ message: 'Failed to open image picker', type: 'error' });
    }
  }

  /**
   * Read a File as base64 string
   */
  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get image dimensions from base64 data
   */
  function getImageDimensions(base64: string, mimeType: string): Promise<{ width: number; height: number } | undefined> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => {
        resolve(undefined);
      };
      img.src = `data:${mimeType};base64,${base64}`;
    });
  }

  function handleRemoveContext(index: number): void {
    assistantStore.removeContext(index);
  }

  function handleRemoveAttachment(id: string): void {
    assistantStore.removeAttachment(id);
  }

  function handleClearConversation(): void {
    assistantStore.clearConversation();
  }

  async function handleToolApprove(toolCall: ToolCall): Promise<void> {
    // Validate tool call against current mode
    const error = assistantStore.validateToolCall(toolCall.name);
    if (error) {
      showToast({ message: error, type: 'warning' });
      assistantStore.updateToolCall(toolCall.id, { 
        status: 'cancelled',
        error,
        endTime: Date.now()
      });
      return;
    }

    // Execute the approved tool
    await executeToolAndUpdate(toolCall, assistantStore.abortController?.signal);
  }

  function handleToolDeny(toolCall: ToolCall): void {
    assistantStore.updateToolCall(toolCall.id, { 
      status: 'cancelled',
      endTime: Date.now()
    });
  }

  /**
   * Handle tool approval from inline display in message
   * Supports streaming progress for file write operations
   */
  async function handleToolApproveInMessage(messageId: string, toolCall: ToolCall): Promise<void> {
    const error = assistantStore.validateToolCall(toolCall.name);
    if (error) {
      showToast({ message: error, type: 'warning' });
      assistantStore.updateToolCallInMessage(messageId, toolCall.id, { 
        status: 'cancelled',
        error,
        endTime: Date.now()
      });
      return;
    }

    // Update status to running
    assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
      status: 'running',
      startTime: Date.now()
    });

    // Check if this is a file write tool that supports streaming
    const isFileWriteTool = toolCall.name === 'write_file' || toolCall.name === 'create_file';

    try {
      const result = await executeToolCall(toolCall.name, toolCall.arguments, {
        signal: assistantStore.abortController?.signal,
        enableStreaming: isFileWriteTool,
        onStreamingProgress: isFileWriteTool ? (progress) => {
          assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
            streamingProgress: progress
          });
        } : undefined
      });
      
      assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error,
        endTime: Date.now(),
        streamingProgress: undefined // Clear progress on completion
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'failed',
        error: errorMsg,
        endTime: Date.now(),
        streamingProgress: undefined
      });
    }
  }

  /**
   * Handle tool denial from inline display in message
   */
  function handleToolDenyInMessage(messageId: string, toolCall: ToolCall): void {
    assistantStore.updateToolCallInMessage(messageId, toolCall.id, { 
      status: 'cancelled',
      endTime: Date.now()
    });
  }

  // Get attachment previews for display
  const attachmentPreviews = $derived(assistantStore.getAttachmentPreviews());
</script>

<aside class="assistant-panel" aria-label="AI Assistant">
  <!-- Header -->
  <header class="panel-header">
    <div class="header-left">
      <div class="header-icon">
        <UIIcon name="comment" size={14} />
      </div>
      <span class="header-title">CHAT</span>
    </div>
    <div class="header-actions">
      <button
        class="header-btn"
        onclick={handleClearConversation}
        title="New chat"
        aria-label="New chat"
        type="button"
      >
        <UIIcon name="plus" size={14} />
      </button>
      <button
        class="header-btn"
        title="Settings"
        aria-label="Settings"
        type="button"
      >
        <UIIcon name="settings" size={14} />
      </button>
      <button
        class="header-btn"
        title="More actions"
        aria-label="More actions"
        type="button"
      >
        <UIIcon name="more" size={14} />
      </button>
      <button
        class="header-btn"
        onclick={() => assistantStore.closePanel()}
        title="Close (Ctrl+L)"
        aria-label="Close assistant panel"
        type="button"
      >
        <UIIcon name="close" size={14} />
      </button>
    </div>
  </header>

  <!-- Messages Area -->
  <div class="messages-area">
    <MessageList 
      messages={assistantStore.messages} 
      currentMode={assistantStore.currentMode}
      onToolApprove={handleToolApproveInMessage}
      onToolDeny={handleToolDenyInMessage}
    />
  </div>

  <!-- Input Area (Bottom) -->
  <div class="input-area">
    <!-- Attachment Previews (new model) -->
    {#if attachmentPreviews.length > 0}
      <div class="attachment-previews" role="list" aria-label="Attachments to send">
        {#each attachmentPreviews as preview (preview.id)}
          <div class="attachment-preview" class:is-image={preview.isImage} role="listitem">
            {#if preview.isImage && preview.thumbnailData}
              <img 
                src="data:image/png;base64,{preview.thumbnailData}" 
                alt={preview.label}
                class="attachment-thumbnail"
              />
            {:else}
              <UIIcon 
                name={preview.type === 'file' ? 'file' : preview.type === 'selection' ? 'code' : preview.type === 'folder' ? 'folder' : 'image'} 
                size={14} 
              />
            {/if}
            <div class="attachment-info">
              <span class="attachment-label">{preview.label}</span>
              {#if preview.size || preview.dimensions}
                <span class="attachment-meta">
                  {preview.dimensions ?? ''}{preview.dimensions && preview.size ? ' · ' : ''}{preview.size ?? ''}
                </span>
              {/if}
            </div>
            <button
              class="attachment-remove"
              onclick={() => handleRemoveAttachment(preview.id)}
              title="Remove"
              aria-label="Remove {preview.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Legacy Attached Context Chips (for backward compatibility) -->
    {#if assistantStore.attachedContext.length > 0 && attachmentPreviews.length === 0}
      <div class="attached-context" role="list" aria-label="Attached context">
        {#each assistantStore.attachedContext as ctx, i (i)}
          <div class="context-chip" role="listitem">
            <UIIcon name={ctx.type === 'file' ? 'file' : 'code'} size={12} />
            <span class="context-label">{ctx.label}</span>
            <button
              class="context-remove"
              onclick={() => handleRemoveContext(i)}
              title="Remove"
              aria-label="Remove {ctx.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <ChatInputBar
      bind:inputRef
      value={assistantStore.inputValue}
      isStreaming={assistantStore.isStreaming}
      currentMode={assistantStore.currentMode}
      onInput={(v) => assistantStore.setInputValue(v)}
      onSend={handleSend}
      onStop={handleStop}
      onModeChange={handleModeChange}
      onAttachFile={handleAttachCurrentFile}
      onAttachSelection={handleAttachSelection}
      onAttachImage={handleAttachImage}
      onAttachImageFromPicker={handleAttachImageFromPicker}
    />
  </div>
</aside>

<style>
  .assistant-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-panel);
    border-left: 1px solid var(--color-border);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    min-height: 36px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .header-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .header-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .messages-area {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .input-area {
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-sidebar);
    flex-shrink: 0;
  }

  .attached-context {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .context-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px 3px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .context-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 2px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
  }

  .context-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }

  /* Attachment previews (new model) */
  .attachment-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .attachment-preview {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
    max-width: 200px;
  }

  .attachment-preview.is-image {
    padding: 4px;
  }

  .attachment-thumbnail {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .attachment-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .attachment-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .attachment-meta {
    font-size: 10px;
    color: var(--color-text-disabled);
  }

  .attachment-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .attachment-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }
</style>
