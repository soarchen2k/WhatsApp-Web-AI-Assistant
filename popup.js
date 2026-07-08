// Popup script for WhatsApp AI Assistant
document.addEventListener('DOMContentLoaded', function() {
  // Localize all static text based on the browser's UI language
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const message = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (message) el.textContent = message;
  });

  const openWhatsAppBtn = document.getElementById('openWhatsApp');
  const openSettingsBtn = document.getElementById('openSettings');
  const viewHelpBtn = document.getElementById('viewHelp');
  const statusDiv = document.getElementById('status');

  // Check if we're already on WhatsApp Web
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    const currentTab = tabs[0];
    if (currentTab.url && currentTab.url.includes('web.whatsapp.com')) {
      openWhatsAppBtn.textContent = chrome.i18n.getMessage('btnWhatsAppActive');
      openWhatsAppBtn.style.background = '#28a745';
      showStatus(chrome.i18n.getMessage('statusExtensionActive'), 'success');
    }
  });

  openWhatsAppBtn.addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      const currentTab = tabs[0];

      if (currentTab.url && currentTab.url.includes('web.whatsapp.com')) {
        // Already on WhatsApp Web, just refresh the content script
        chrome.tabs.reload(currentTab.id);
        showStatus(chrome.i18n.getMessage('statusRefreshing'), 'success');
      } else {
        // Open WhatsApp Web
        chrome.tabs.create({ url: 'https://web.whatsapp.com' });
        showStatus(chrome.i18n.getMessage('statusOpeningWhatsApp'), 'success');
      }
    });
  });

  openSettingsBtn.addEventListener('click', function() {
    // Check if we're on WhatsApp Web to open settings
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      const currentTab = tabs[0];

      if (currentTab.url && currentTab.url.includes('web.whatsapp.com')) {
        // Send message to content script to open settings
        chrome.tabs.sendMessage(currentTab.id, { action: 'openSettings' }, function(response) {
          if (chrome.runtime.lastError) {
            showStatus(chrome.i18n.getMessage('statusRefreshFirst'), 'error');
          } else {
            showStatus(chrome.i18n.getMessage('statusOpeningSettings'), 'success');
            window.close();
          }
        });
      } else {
        showStatus(chrome.i18n.getMessage('statusOpenWhatsAppFirst'), 'warning');
      }
    });
  });

  viewHelpBtn.addEventListener('click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status status-${type}`;
    statusDiv.style.display = 'block';
    
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});
