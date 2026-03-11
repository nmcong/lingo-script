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
    selector: '.transcript--cue-text--2DisO',
    activeClass: 'transcript--is-active--2BPqe',
    container: '.transcript--container--3PBTk'
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
  const saveBtn            = $('saveBtn');
  const translateBtn       = $('translateBtn');
  const status             = $('status');

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

  // ── Load saved config ──────────────────────────────────────────────────────
  chrome.storage.sync.get([
    'llmProvider', 'llmApiKey', 'targetLanguage',
    'ollamaModel', 'ollamaModelCustom',
    'ttsProvider', 'ttsApiKey', 'isAutoPlayEnabled',
    'platformPreset', 'transcriptSelector', 'activeClass'
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
      containerSelector:  containerVal
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
