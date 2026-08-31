// Only job: open the side panel from the toolbar icon. The agent loop lives in
// the side panel, which stays alive while open — a service worker would be
// killed mid-run.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
