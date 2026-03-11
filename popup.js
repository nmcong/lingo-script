// Detect platform from tab URL
function detectPlatformFromUrl(url) {
  if (!url) return null;
  if (url.includes('youtube.com'))  return { key: 'youtube',  name: 'YouTube' };
  if (url.includes('coursera.org')) return { key: 'coursera', name: 'Coursera' };
  if (url.includes('udemy.com'))    return { key: 'udemy',    name: 'Udemy' };
  if (url.includes('edx.org'))      return { key: 'edx',      name: 'edX' };
  if (url.includes('linkedin.com') && url.includes('/learning/'))
                                    return { key: 'linkedin', name: 'LinkedIn Learning' };
  return null;
}

// Platform presets: selector, activeClass, containerSelector
const PRESETS = {
  youtube: {
    selector: 'ytd-transcript-segment-renderer .segment-text',
    activeClass: 'active-ytd-transcript-segment-renderer',
    container: '#segments-container'
  },
  coursera: {
    selector: '.rc-Phrase span',
    activeClass: 'rc-PhraseActive',
    container: '.transcript-body'
  },
  udemy: {
    selector: '[data-purpose="cue-text"]',
    activeClass: '',
    container: '[data-purpose="sidebar-content"]'
  },
  edx: {
    selector: '.subtitles-menu li span, .transcript-line',
    activeClass: 'current',
    container: '.subtitles-menu'
  },
  linkedin: {
    selector: '.transcript-line__text',
    activeClass: 'transcript-line--active',
    container: '.classroom-transcript'
  },
  custom: { selector: '', activeClass: '', container: '' }
};

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const llmProvider        = $('llmProvider');
  const llmApiKey          = $('llmApiKey');
  const targetLang         = $('targetLang');
  const ollamaModel        = $('ollamaModel');
  const ollamaModelCustom  = $('ollamaModelCustom');
  const ttsProvider        = $('ttsProvider');
  const ttsApiKey          = $('ttsApiKey');
  const autoPlay           = $('autoPlay');
  const platformPreset     = $('platformPreset');
  const transcriptSelector = $('transcriptSelector');
  const activeClass        = $('activeClass');
  const customSystemPrompt = $('customSystemPrompt');
  const bilingualMode      = $('bilingualMode');
  const enableLazyLoading  = $('enableLazyLoading');
  const enableOverlay      = $('enableOverlay');
  const singleBatchMode    = $('singleBatchMode');
  const saveBtn            = $('saveBtn');
  const translateBtn       = $('translateBtn');
  const testConnBtn        = $('testConnBtn');
  const clearCacheBtn      = $('clearCacheBtn');
  const status             = $('status');
  const testStatus         = $('testStatus');
  const cacheInfo          = $('cacheInfo');

  // Show/hide Ollama model field
  function applyLLMProvider(val) {
    $('ollamaModelField').style.display = val === 'ollama' ? 'block' : 'none';
  }
  llmProvider.addEventListener('change', () => applyLLMProvider(llmProvider.value));

  // Show/hide custom model input
  ollamaModel.addEventListener('change', () => {
    ollamaModelCustom.style.display = ollamaModel.value === 'custom' ? 'block' : 'none';
  });

  // Show/hide TTS key field
  ttsProvider.addEventListener('change', () => {
    $('ttsKeyField').style.display = ttsProvider.value === 'openai' ? 'block' : 'none';
  });

  // Show/hide custom selector fields + fill preset values
  function applyPreset(platform) {
    const isCustom = platform === 'custom';
    $('customSelectorField').style.display = isCustom ? 'block' : 'none';
    $('customActiveClassField').style.display = isCustom ? 'block' : 'none';
    if (!isCustom) {
      transcriptSelector.value = PRESETS[platform].selector;
      activeClass.value = PRESETS[platform].activeClass;
    }
  }

  platformPreset.addEventListener('change', () => applyPreset(platformPreset.value));

  // ── Test Connection ────────────────────────────────────────────────────────
  testConnBtn.addEventListener('click', () => {
    const provider = llmProvider.value;
    const apiKey = llmApiKey.value.trim();
    const model = ollamaModel.value === 'custom' ? ollamaModelCustom.value.trim() : ollamaModel.value;

    if (!apiKey) {
      testStatus.textContent = '⚠️ Nhập API Key trước';
      testStatus.style.color = '#e94560';
      return;
    }

    testConnBtn.disabled = true;
    testConnBtn.textContent = '⏳';
    testStatus.textContent = 'Đang kiểm tra...';
    testStatus.style.color = '#8898aa';

    chrome.runtime.sendMessage({
      action: 'TEST_CONNECTION',
      provider,
      apiKey,
      model
    }, (response) => {
      testConnBtn.disabled = false;
      testConnBtn.textContent = '🔌';

      if (response && response.success) {
        testStatus.textContent = '✅ Kết nối thành công!';
        testStatus.style.color = '#28a745';
      } else {
        testStatus.textContent = '❌ ' + (response?.error || 'Kết nối thất bại');
        testStatus.style.color = '#e94560';
      }

      setTimeout(() => { testStatus.textContent = ''; }, 5000);
    });
  });

  // ── Clear Cache ────────────────────────────────────────────────────────────
  clearCacheBtn.addEventListener('click', () => {
    if (!confirm('Xóa toàn bộ cache đã dịch?')) return;

    chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' }, (response) => {
      if (response && response.success) {
        showStatus('✅ Đã xóa cache!', false);
        loadCacheStats();
      } else {
        showStatus('❌ Lỗi xóa cache', true);
      }
    });
  });

  // Load cache stats
  function loadCacheStats() {
    chrome.runtime.sendMessage({ action: 'GET_CACHE_STATS' }, (response) => {
      if (response && response.count !== undefined) {
        cacheInfo.textContent = `💾 ${response.count} đoạn`;
      }
    });
  }
  loadCacheStats();

  // ── Load saved config ──────────────────────────────────────────────────────
  chrome.storage.sync.get([
    'llmProvider', 'llmApiKey', 'targetLanguage',
    'ollamaModel', 'ollamaModelCustom',
    'ttsProvider', 'ttsApiKey', 'isAutoPlayEnabled',
    'platformPreset', 'transcriptSelector', 'activeClass',
    'customSystemPrompt', 'bilingualMode', 'enableLazyLoading', 'enableOverlay', 'singleBatchMode'
  ], (result) => {
    if (result.llmProvider)    llmProvider.value = result.llmProvider;
    if (result.llmApiKey)      llmApiKey.value   = result.llmApiKey;
    if (result.targetLanguage) targetLang.value  = result.targetLanguage;

    applyLLMProvider(result.llmProvider || 'gemini');
    if (result.ollamaModel) {
      ollamaModel.value = result.ollamaModel;
      ollamaModelCustom.style.display = result.ollamaModel === 'custom' ? 'block' : 'none';
    }
    if (result.ollamaModelCustom) ollamaModelCustom.value = result.ollamaModelCustom;

    if (result.ttsProvider) {
      ttsProvider.value = result.ttsProvider;
      $('ttsKeyField').style.display = result.ttsProvider === 'openai' ? 'block' : 'none';
    }
    if (result.ttsApiKey) ttsApiKey.value = result.ttsApiKey;
    autoPlay.checked = result.isAutoPlayEnabled || false;

    if (result.customSystemPrompt) customSystemPrompt.value = result.customSystemPrompt;
    bilingualMode.checked = result.bilingualMode || false;
    enableLazyLoading.checked = result.enableLazyLoading || false;
    enableOverlay.checked = result.enableOverlay || false;
    singleBatchMode.checked = result.singleBatchMode || false;

    const platform = result.platformPreset || 'youtube';
    platformPreset.value = platform;

    if (platform === 'custom') {
      $('customSelectorField').style.display = 'block';
      $('customActiveClassField').style.display = 'block';
      if (result.transcriptSelector) transcriptSelector.value = result.transcriptSelector;
      if (result.activeClass)        activeClass.value        = result.activeClass;
    } else {
      applyPreset(platform);
    }

    // ── Auto-detect platform from current tab URL ──────────────────────────
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      const detected = detectPlatformFromUrl(tabs[0].url || '');
      const badge = $('detectedBadge');

      if (detected) {
        badge.textContent = `🎯 Phát hiện: ${detected.name}`;
        badge.style.display = 'block';

        // Auto-select chỉ khi user chưa tùy chỉnh (dùng mặc định)
        if (!result.platformPreset) {
          platformPreset.value = detected.key;
          applyPreset(detected.key);
        } else if (result.platformPreset !== detected.key) {
          badge.textContent += ` (đang dùng: ${platformPreset.options[platformPreset.selectedIndex].text})`;
          badge.style.color = '#ffb300';
          badge.style.borderColor = 'rgba(255,179,0,0.3)';
          badge.style.background = 'rgba(255,179,0,0.08)';
        }
      }
    });
  });

  // ── Save config ────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const platform = platformPreset.value;
    const preset   = PRESETS[platform];

    const selectorVal   = platform === 'custom' ? transcriptSelector.value.trim() : preset.selector;
    const activeClassVal = platform === 'custom' ? activeClass.value.trim()       : preset.activeClass;
    const containerVal  = platform === 'custom' ? '' : preset.container;

    chrome.storage.sync.set({
      llmProvider:        llmProvider.value,
      llmApiKey:          llmApiKey.value.trim(),
      targetLanguage:     targetLang.value,
      ollamaModel:        ollamaModel.value,
      ollamaModelCustom:  ollamaModelCustom.value.trim(),
      ttsProvider:        ttsProvider.value,
      ttsApiKey:          ttsApiKey.value.trim(),
      isAutoPlayEnabled:  autoPlay.checked,
      platformPreset:     platform,
      transcriptSelector: selectorVal,
      activeClass:        activeClassVal,
      containerSelector:  containerVal,
      customSystemPrompt: customSystemPrompt.value.trim(),
      bilingualMode:      bilingualMode.checked,
      enableLazyLoading:  enableLazyLoading.checked,
      enableOverlay:      enableOverlay.checked,
      singleBatchMode:    singleBatchMode.checked
    }, () => showStatus('✓ Đã lưu thành công!', false));
  });

  // ── Trigger translation ────────────────────────────────────────────────────
  translateBtn.addEventListener('click', () => {
    if (!llmApiKey.value.trim()) {
      showStatus('Vui lòng nhập API Key!', true);
      return;
    }

    translateBtn.disabled = true;
    translateBtn.textContent = '⏳ Đang xử lý...';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showStatus('Không tìm thấy tab!', true);
        resetBtn();
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { action: 'START_TRANSLATE' }, (response) => {
        if (chrome.runtime.lastError) {
          showStatus('Lỗi kết nối – thử tải lại trang!', true);
        } else {
          showStatus('⚡ Đã bắt đầu dịch!', false);
        }
        resetBtn();
      });
    });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showStatus(msg, isError) {
    status.textContent = msg;
    status.className = 'status' + (isError ? ' error' : '');
    setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 3000);
  }

  function resetBtn() {
    translateBtn.disabled = false;
    translateBtn.textContent = '⚡ Dịch trang này';
  }
});
