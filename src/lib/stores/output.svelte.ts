/**
 * Output store for managing log channels
 * Provides real log output for Volt, Terminal, and File System channels
 */

export type OutputChannel = 'Volt' | 'Terminal' | 'File System';

interface OutputLine {
  timestamp: Date;
  message: string;
}

interface ChannelData {
  lines: OutputLine[];
}

const MAX_LINES_PER_CHANNEL = 1000;

class OutputStore {
  private channels = $state<Record<OutputChannel, ChannelData>>({
    'Volt': { lines: [] },
    'Terminal': { lines: [] },
    'File System': { lines: [] }
  });

  activeChannel = $state<OutputChannel>('Volt');

  /**
   * Get all available channel names
   */
  get channelNames(): OutputChannel[] {
    return ['Volt', 'Terminal', 'File System'];
  }

  /**
   * Get lines for the active channel
   */
  get activeLines(): OutputLine[] {
    return this.channels[this.activeChannel].lines;
  }

  /**
   * Get lines for a specific channel
   */
  getLines(channel: OutputChannel): OutputLine[] {
    return this.channels[channel].lines;
  }

  /**
   * Append a line to a channel
   */
  append(channel: OutputChannel, message: string): void {
    const channelData = this.channels[channel];
    channelData.lines.push({
      timestamp: new Date(),
      message
    });

    // Trim old lines if exceeding max
    if (channelData.lines.length > MAX_LINES_PER_CHANNEL) {
      channelData.lines = channelData.lines.slice(-MAX_LINES_PER_CHANNEL);
    }
  }

  /**
   * Set the active channel
   */
  setActiveChannel(channel: OutputChannel): void {
    this.activeChannel = channel;
  }

  /**
   * Clear a specific channel
   */
  clear(channel: OutputChannel): void {
    this.channels[channel].lines = [];
  }

  /**
   * Clear all channels
   */
  clearAll(): void {
    for (const channel of this.channelNames) {
      this.channels[channel].lines = [];
    }
  }
}

// Singleton instance
export const outputStore = new OutputStore();

// Helper function for easy logging
export function logOutput(channel: OutputChannel, message: string): void {
  outputStore.append(channel, message);
}
