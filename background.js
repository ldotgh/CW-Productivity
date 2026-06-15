// Track which node we've already processed for each tab.
// This avoids re-running title/group logic multiple times for the same page.
const handledNodeByTab = new Map();

function getNodeFromUrl(urlString) {
  try {
    const url = new URL(urlString);

    // Only handle Grafana Node Details pages.
    // If the tab is on any other page, ignore it.
    if (!url.pathname.includes('/d/ddbdicm9sw7c5x/node-details')) return null;

    // Pull the node name from the query string, e.g. ?var-node=g82e1b6
    const node = url.searchParams.get('var-node');

    // Return a cleaned-up node name, or null if it's missing/empty.
    return node && node.trim() ? node.trim() : null;
  } catch {
    // If the URL is invalid or can't be parsed, just ignore it.
    return null;
  }
}

async function setTitle(tabId, node) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (nodeName) => {
      // Update the page title so the Chrome tab is easier to identify at a glance.
      document.title = `${nodeName} · Node Details`;
    },
    args: [node],
  });
}

async function groupTab(tabId, node) {
  // Get the current tab so we know which window we're working in.
  const currentTab = await chrome.tabs.get(tabId);
  if (typeof currentTab.windowId !== 'number') return;

  // Look at every tab in the same window.
  const tabs = await chrome.tabs.query({ windowId: currentTab.windowId });

  // Find all tabs that point at the same Grafana node.
  const matchingTabs = tabs.filter((t) => getNodeFromUrl(t.url || '') === node);

  // Extract valid tab IDs only.
  const matchingTabIds = matchingTabs
    .map((t) => t.id)
    .filter((id) => typeof id === 'number');

  if (!matchingTabIds.length) return;

  // Reuse an existing tab group if one of the matching tabs is already grouped.
  // Otherwise, create a brand new group for these tabs.
  let groupId =
    matchingTabs.find((t) => typeof t.groupId === 'number' && t.groupId >= 0)?.groupId ??
    null;

  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: matchingTabIds });
  } else {
    await chrome.tabs.group({ groupId, tabIds: matchingTabIds });
  }

  try {
    // Give the group a readable label and consistent color.
    await chrome.tabGroups.update(groupId, {
      title: node,
      color: 'blue',
      collapsed: false,
    });
  } catch (e) {
    // Chrome tab groups can be a little race-y:
    // sometimes the group disappears or changes before update() runs.
    // If that happens, re-query the tabs and try again with the fresh group ID.
    if (!String(e).includes('No group with id')) throw e;

    const refreshedTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
    const refreshedGroupId = refreshedTabs.find(
      (t) =>
        getNodeFromUrl(t.url || '') === node &&
        typeof t.groupId === 'number' &&
        t.groupId >= 0
    )?.groupId;

    if (typeof refreshedGroupId === 'number') {
      await chrome.tabGroups.update(refreshedGroupId, {
        title: node,
        color: 'blue',
        collapsed: false,
      });
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Ignore partial updates.
  // We only care once the page is fully loaded and has a URL.
  if (changeInfo.status !== 'complete' || !tab.url) return;

  // Extract the node from the tab URL.
  // If this isn't a Node Details page, stop here.
  const node = getNodeFromUrl(tab.url);
  if (!node) return;

  // Skip work if we've already handled this tab for this exact node.
  // This prevents duplicate title/group updates during repeated tab refresh events.
  if (handledNodeByTab.get(tabId) === node) return;
  handledNodeByTab.set(tabId, node);

  try {
    // Make the tab easier to read, then group it with other tabs for the same node.
    await setTitle(tabId, node);
    await groupTab(tabId, node);
  } catch (e) {
    // Log failures without breaking the extension.
    console.error('CoreWeave Grafana Node Tabs:', e);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Clean up per-tab tracking once the tab is closed.
  handledNodeByTab.delete(tabId);
});
