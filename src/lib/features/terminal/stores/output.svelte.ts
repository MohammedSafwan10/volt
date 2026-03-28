/**
 * Output store for managing log channels
 * Provides real log output for Volt, Terminal, and File System channels
 */

import { writable, type Writable } from 'svelte/store';

export type OutputChannel = 'Volt' | 'Terminal' | 'File System' | 'Prettier' | 'MCP';

interface OutputLine {
  timestamp: Date;
  message: string;
}

interface ChannelData {
  lines: OutputLine[];
}

const MAX_LINES_PER_CHANNEL = 1000;

class OutputStore {
  private readonly channelsStore: Writable<Record<OutputChannel, ChannelData>>;
  private channels: Record<OutputChannel, ChannelData> = {
    'Volt': { lines: [] },
    'Terminal': { lines: [] },
    'File System': { lines: [] },
    'Prettier': { lines: [] },
    'MCP': { lines: [] }
  };

  private readonly activeChannelStore: Writable<OutputChannel>;
  activeChannel: OutputChannel = 'Volt';

  constructor() {
    this.channelsStore = writable<Record<OutputChannel, ChannelData>>(this.channels);
    this.channelsStore.subscribe((value) => {
      this.channels = value;
    });
    this.activeChannelStore = writable<OutputChannel>(this.activeChannel);
    this.activeChannelStore.subscribe((value) => {
      this.activeChannel = value;
    });
  }

  private setChannels(next: Record<OutputChannel, ChannelData>): void {
    this.channels = next;
    this.channelsStore.set(next);
  }

  private setActiveChannelValue(channel: OutputChannel): void {
    this.activeChannel = channel;
    this.activeChannelStore.set(channel);
  }

  /**
   * Get all available channel names
   */
  get channelNames(): OutputChannel[] {
    return ['Volt', 'Terminal', 'File System', 'Prettier', 'MCP'];
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
    const nextLines = [
      ...channelData.lines,
      {
      timestamp: new Date(),
      message
      },
    ];

    // Trim old lines if exceeding max
    const normalizedLines =
      nextLines.length > MAX_LINES_PER_CHANNEL
        ? nextLines.slice(-MAX_LINES_PER_CHANNEL)
        : nextLines;
    this.setChannels({
      ...this.channels,
      [channel]: {
        lines: normalizedLines,
      },
    });
  }

  /**
   * Set the active channel
   */
  setActiveChannel(channel: OutputChannel): void {
    this.setActiveChannelValue(channel);
  }

  /**
   * Clear a specific channel
   */
  clear(channel: OutputChannel): void {
    this.setChannels({
      ...this.channels,
      [channel]: { lines: [] },
    });
  }

  /**
   * Clear all channels
   */
  clearAll(): void {
    this.setChannels({
      'Volt': { lines: [] },
      'Terminal': { lines: [] },
      'File System': { lines: [] },
      'Prettier': { lines: [] },
      'MCP': { lines: [] },
    });
  }
}

// Singleton instance
export const outputStore = new OutputStore();

// Helper function for easy logging
export function logOutput(channel: OutputChannel, message: string): void {
  outputStore.append(channel, message);
}
