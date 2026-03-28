<script lang="ts">
  import { UIIcon } from "$shared/components/ui";

  interface ConversationTab {
    id: string;
    title: string;
    fullTitle: string;
    isActive: boolean;
    isRunning: boolean;
    hasError: boolean;
    updatedAt: number;
  }

  interface Props {
    conversationTabs: ConversationTab[];
    currentChatTitle: string;
    conversationTabsScrollRef?: HTMLDivElement;
    onSelectTab: (conversationId: string) => void;
    onCloseTab: (conversationId: string, event: MouseEvent) => void;
    onTabContextMenu: (
      tab: { id: string; fullTitle: string },
      event: MouseEvent,
    ) => void;
  }

  let {
    conversationTabs,
    currentChatTitle,
    conversationTabsScrollRef = $bindable(),
    onSelectTab,
    onCloseTab,
    onTabContextMenu,
  }: Props = $props();
</script>

<div class="conversation-tabs" bind:this={conversationTabsScrollRef}>
  {#each conversationTabs as tab (tab.id)}
    <div
      class="conversation-tab"
      class:active={tab.isActive}
      class:running={tab.isRunning}
      class:error={tab.hasError}
      role="presentation"
      oncontextmenu={(event) => onTabContextMenu(tab, event)}
    >
      <button
        class="conversation-tab-main"
        type="button"
        title={tab.fullTitle}
        aria-label={tab.fullTitle}
        onclick={() => onSelectTab(tab.id)}
      >
        <span class="conversation-tab-status" aria-hidden="true"></span>
        <span class="conversation-tab-title">{tab.title || currentChatTitle}</span>
      </button>
      <button
        class="conversation-tab-close"
        type="button"
        title="Close tab"
        aria-label="Close {tab.title}"
        onclick={(event) => onCloseTab(tab.id, event)}
      >
        <UIIcon name="close" size={10} />
      </button>
    </div>
  {/each}
</div>
