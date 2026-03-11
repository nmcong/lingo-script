// =============================================================================
// LingoScript – Content Script
// =============================================================================

// ── Language → BCP-47 locale map ─────────────────────────────────────────────
const LANG_CODE = {
  Vietnamese: 'vi-VN',
  English:    'en-US',
  Japanese:   'ja-JP',
  Korean:     'ko-KR',
  Chinese:    'zh-CN',
  French:     'fr-FR',
  German:     'de-DE',
  Spanish:    'es-ES'
};

// ── Node map: id → DOM element ────────────────────────────────────────────────
let nodeMap = new Map();

// ── Platform auto-detection ───────────────────────────────────────────────────
const PLATFORM_DETECTORS = [
  {
    name: 'YouTube',
    test: () => location.hostname.includes('youtube.com'),
    selector: 'ytd-transcript-segment-renderer .segment-text',
    activeClass: 'active-ytd-transcript-segment-renderer',
    container: '#segments-container'
  },
  {
    name: 'Coursera',
    test: () => location.hostname.includes('coursera.org'),
    selector: '.rc-Phrase span',
    activeClass: 'rc-PhraseActive',
    container: '.transcript-body'
  },
  {
    name: 'Udemy',
    test: () => location.hostname.includes('udemy.com'),
    selector: '[data-purpose="cue-text"]',
    activeClass: '',  // Will detect via data-purpose="transcript-cue-active"
    container: '[data-purpose="sidebar-content"]'
  },
  {
    name: 'edX',
    test: () => location.hostname.includes('edx.org'),
    selector: '.subtitles-menu li span, .transcript-line',
    activeClass: 'current',
    container: '.subtitles-menu'
  },
  {
    name: 'LinkedIn Learning',
    test: () => location.hostname.includes('linkedin.com') && location.pathname.includes('/learning/'),
    selector: '.transcript-line__text',
    activeClass: 'transcript-line--active',
    container: '.classroom-transcript'
  }
];

function autoDetectPlatform() {
  return PLATFORM_DETECTORS.find(d => d.test()) || null;
}

// =============================================================================
// TRANSLATION VIA BACKGROUND WORKER (Secure API calls)
// =============================================================================

// Translation state
let isTranslating = false;
let shouldCancel = false;

async function translateBatch(batch, config) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'TRANSLATE_BATCH',
      batch,
      config,
      url: location.href
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response.error || 'Translation failed'));
      }
    });
  });
}

// =============================================================================
// TTS PROVIDERS
// =============================================================================

let currentAudio = null;
let isAutoPlay   = false;

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

const TTSProviders = {
  builtin: (text, lang) => new Promise((resolve) => {
    const utterance    = new SpeechSynthesisUtterance(text);
    utterance.lang     = LANG_CODE[lang] || 'vi-VN';
    utterance.rate     = 1.0;
    utterance.pitch    = 1.0;
    utterance.volume   = 1.0;
    utterance.onend    = resolve;
    utterance.onerror  = resolve;

    const speak = () => {
      const voices = window.speechSynthesis.getVoices();
      const voice  = voices.find(v => v.lang.startsWith((LANG_CODE[lang] || 'vi').split('-')[0]));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length > 0) speak();
    else window.speechSynthesis.onvoiceschanged = speak;
  }),

  openai: async (text, lang, apiKey) => {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice: 'alloy' })
    });
    if (!res.ok) throw new Error('OpenAI TTS error: ' + res.status);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    currentAudio = new Audio(url);

    return new Promise((resolve) => {
      currentAudio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      currentAudio.onerror = resolve;
      currentAudio.play();
    });
  }
};

async function speakText(text, config) {
  stopAudio();
  const provider = config.ttsProvider || 'builtin';
  const lang     = config.targetLanguage || 'Vietnamese';
  const apiKey   = config.ttsApiKey;
  try {
    if (provider !== 'builtin' && apiKey) {
      await TTSProviders[provider](text, lang, apiKey);
    } else {
      await TTSProviders.builtin(text, lang);
    }
  } catch (err) {
    console.warn('[LingoScript] TTS fallback to builtin:', err.message);
    try { await TTSProviders.builtin(text, lang); } catch (e) { /* silent */ }
  }
}

// =============================================================================
// TRANSCRIPT COLLECTION
// =============================================================================

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function collectAndChunk(selector, chunkSize = 20) {
  nodeMap.clear();
  const elements = document.querySelectorAll(selector);

  if (!elements.length) {
    console.warn(`[LingoScript] No elements for selector: "${selector}"`);
    return [];
  }

  const textData = [];
  elements.forEach((el, i) => {
    const text = el.innerText.trim();
    if (text && !el.dataset.lingoTranslated) {
      textData.push({ id: i, text });
      nodeMap.set(i, el);
    }
  });

  console.log(`[LingoScript] ${textData.length} segments found, ${chunkArray(textData, chunkSize).length} batches.`);
  return chunkArray(textData, chunkSize);
}

// =============================================================================
// UI HELPERS
// =============================================================================

// Non-blocking toast for errors/info (replaces alert())
function showLingoToast(msg, isError = false) {
  const old = document.getElementById('lingo-toast-msg');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'lingo-toast-msg';
  toast.style.cssText = [
    'position:fixed', 'top:20px', 'right:20px',
    `background:${isError ? '#c0392b' : '#27ae60'}`, 'color:#fff',
    'padding:12px 18px', 'border-radius:8px',
    'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
    'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:13px', 'max-width:380px', 'line-height:1.5',
    'transition:opacity 0.4s ease'
  ].join(';');
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 5000);
}

// Progress bar (thin red line at top)
function setProgress(current, total) {
  let bar = document.getElementById('lingo-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'lingo-progress-bar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'height:3px',
      'background:#e94560', 'z-index:2147483647',
      'transition:width 0.4s ease', 'box-shadow:0 0 8px #e94560'
    ].join(';');
    document.body.appendChild(bar);
  }
  const pct = Math.round((current / total) * 100);
  bar.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => bar.remove(), 1200);
}

// Cancel button
function addCancelButton() {
  if (document.getElementById('lingo-cancel-btn')) return;
  
  const btn = document.createElement('button');
  btn.id = 'lingo-cancel-btn';
  btn.innerHTML = '⏹️ Dừng dịch';
  btn.style.cssText = [
    'position:fixed', 'top:50px', 'right:20px',
    'background:#e74c3c', 'color:#fff', 'border:none',
    'padding:10px 16px', 'border-radius:6px', 'cursor:pointer',
    'z-index:2147483647', 'font-size:13px', 'font-weight:500',
    'box-shadow:0 2px 10px rgba(231,76,60,0.4)',
    'transition:all 0.2s ease'
  ].join(';');
  
  btn.onmouseenter = () => { btn.style.background = '#c0392b'; btn.style.transform = 'scale(1.05)'; };
  btn.onmouseleave = () => { btn.style.background = '#e74c3c'; btn.style.transform = 'scale(1)'; };
  btn.onclick = () => {
    shouldCancel = true;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerHTML = '⏳ Đang dừng...';
  };
  
  document.body.appendChild(btn);
}

function removeCancelButton() {
  const btn = document.getElementById('lingo-cancel-btn');
  if (btn) btn.remove();
}

// Mark segments as loading
function markLoading(batch) {
  batch.forEach(({ id }) => {
    const el = nodeMap.get(id);
    if (el) el.style.opacity = '0.4';
  });
}

function unmarkLoading(batch) {
  batch.forEach(({ id }) => {
    const el = nodeMap.get(id);
    if (el) el.style.opacity = '1';
  });
}

// Replace text + add speaker button
function replaceText(translatedBatch, targetLang, bilingualMode = false) {
  translatedBatch.forEach(item => {
    if (!item || !item.text) return;
    const el = nodeMap.get(item.id);
    if (!el) return;

    // Save original text if bilingual mode
    if (!el.dataset.lingoOriginal) {
      el.dataset.lingoOriginal = el.innerText.trim();
    }

    if (bilingualMode) {
      // Bilingual: Keep original, add translation below
      el.innerHTML = '';
      
      const originalSpan = document.createElement('div');
      originalSpan.style.cssText = 'color:#666;font-size:0.85em;line-height:1.4;margin-bottom:4px;';
      originalSpan.textContent = el.dataset.lingoOriginal;
      
      const translatedSpan = document.createElement('div');
      translatedSpan.style.cssText = 'color:#2e7d32;font-weight:500;line-height:1.5;';
      translatedSpan.textContent = item.text;
      
      el.appendChild(originalSpan);
      el.appendChild(translatedSpan);
    } else {
      // Replace mode
      el.innerText = item.text;
      el.style.color = '#2e7d32';
    }

    el.dataset.lingoTranslated = 'true';
    el.dataset.lingoText = item.text;
    el.title = item.fromCache ? '💾 Từ cache' : '✨ Vừa dịch';

    // Speaker button 🔊
    if (!el.querySelector('.lingo-speak-btn')) {
      const btn = document.createElement('span');
      btn.className = 'lingo-speak-btn';
      btn.textContent = ' 🔊';
      btn.title = 'Nghe đoạn này';
      btn.style.cssText = 'cursor:pointer;font-size:0.8em;opacity:0.6;transition:opacity 0.15s,transform 0.15s;margin-left:4px;';
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.6'; });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.style.transform = 'scale(1.3)';
        setTimeout(() => { btn.style.transform = 'scale(1)'; }, 200);
        chrome.storage.sync.get(['ttsProvider', 'ttsApiKey', 'targetLanguage'], (cfg) => {
          speakText(item.text, cfg);
        });
      });

      if (bilingualMode) {
        el.lastChild.appendChild(btn);
      } else {
        el.appendChild(btn);
      }
    }
  });
}

// Toast: volume warning
function showVolumeWarning() {
  if (document.getElementById('lingo-toast-vol')) return;

  const toast = document.createElement('div');
  toast.id = 'lingo-toast-vol';
  toast.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px',
    'background:#1a1a2e', 'color:#e0e0e0',
    'padding:14px 18px', 'border-radius:10px',
    'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
    'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:13px', 'max-width:300px',
    'border:1px solid #e94560',
    'display:flex', 'flex-direction:column', 'gap:10px',
    'transition:opacity 0.4s ease'
  ].join(';');

  toast.innerHTML = `
    <div>🎙️ <b>Gợi ý:</b> Giảm âm lượng video gốc để nghe giọng AI rõ hơn!</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="lingo-btn-lower"
        style="background:#28a745;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;">
        🔉 Giảm 10%
      </button>
      <button id="lingo-btn-close"
        style="background:#333;color:#e0e0e0;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;">
        Đóng
      </button>
    </div>
  `;
  document.body.appendChild(toast);

  const dismiss = () => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  };

  document.getElementById('lingo-btn-lower').addEventListener('click', () => {
    const video = document.querySelector('video');
    if (video) {
      video.volume = Math.max(0, video.volume - 0.1);
      toast.querySelector('div').textContent = '✅ Đã giảm âm lượng video!';
      setTimeout(dismiss, 2000);
    } else {
      toast.querySelector('div').innerHTML = '⚠️ Không tìm thấy video – vui lòng giảm thủ công.';
      setTimeout(dismiss, 3000);
    }
  });

  document.getElementById('lingo-btn-close').addEventListener('click', dismiss);
  setTimeout(dismiss, 10000);
}

// =============================================================================
// OVERLAY SUBTITLES (Display translations on video)
// =============================================================================

let overlayElement = null;

function createOverlay() {
  if (overlayElement) return overlayElement;

  overlayElement = document.createElement('div');
  overlayElement.id = 'lingo-subtitle-overlay';
  overlayElement.style.cssText = [
    'position:fixed',
    'bottom:80px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:rgba(0,0,0,0.85)',
    'color:#fff',
    'padding:12px 20px',
    'border-radius:8px',
    'font-size:18px',
    'font-weight:500',
    'line-height:1.6',
    'max-width:80%',
    'text-align:center',
    'z-index:2147483646',
    'pointer-events:none',
    'box-shadow:0 4px 20px rgba(0,0,0,0.7)',
    'display:none',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  ].join(';');

  document.body.appendChild(overlayElement);
  return overlayElement;
}

function showOverlaySubtitle(text, duration = 5000) {
  const overlay = createOverlay();
  overlay.textContent = text;
  overlay.style.display = 'block';
  overlay.style.animation = 'none';
  
  setTimeout(() => {
    overlay.style.animation = 'fadeIn 0.3s ease';
  }, 10);

  // Auto-hide after duration
  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
    }, 300);
  }, duration);
}

// Inject animation keyframes
if (!document.getElementById('lingo-overlay-styles')) {
  const style = document.createElement('style');
  style.id = 'lingo-overlay-styles';
  style.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; transform: translateX(-50%) translateY(10px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// =============================================================================
// LAZY LOADING OBSERVER (Auto-translate new transcript segments)
// =============================================================================

let lazyLoadObserver = null;
let pendingTranslations = [];
let translationTimer = null;

function setupLazyLoading(containerSelector, selector, config) {
  if (lazyLoadObserver) {
    lazyLoadObserver.disconnect();
    lazyLoadObserver = null;
  }
  
  const container = document.querySelector(containerSelector);
  if (!container) return;

  let nextId = nodeMap.size;

  lazyLoadObserver = new MutationObserver((mutations) => {
    const newElements = [];
    
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) {
          const matches = node.matches && node.matches(selector) 
            ? [node] 
            : (node.querySelectorAll ? Array.from(node.querySelectorAll(selector)) : []);
          
          matches.forEach(el => {
            if (!el.dataset.lingoTranslated && !el.dataset.lingoPending) {
              const text = el.innerText.trim();
              if (text) {
                el.dataset.lingoPending = 'true';
                nodeMap.set(nextId, el);
                newElements.push({ id: nextId, text });
                nextId++;
              }
            }
          });
        }
      });
    });

    if (newElements.length > 0) {
      console.log(`[LingoScript] Lazy-load detected ${newElements.length} new segments`);
      pendingTranslations.push(...newElements);
      
      // Debounce: wait 2s for more segments before translating
      clearTimeout(translationTimer);
      translationTimer = setTimeout(() => {
        if (pendingTranslations.length > 0) {
          const batch = pendingTranslations.splice(0);
          translateBatch(batch, config)
            .then(translated => replaceText(translated, config.targetLanguage, config.bilingualMode))
            .catch(err => console.error('[LingoScript] Lazy translation failed:', err));
        }
      }, 2000);
    }
  });

  lazyLoadObserver.observe(container, {
    childList: true,
    subtree: true
  });
  
  console.log('[LingoScript] Lazy-loading observer active');
}

// =============================================================================
// AUTO-PLAY OBSERVER
// =============================================================================

let autoPlayObserver = null;

function setupAutoPlay(containerSelector, activeClass, enableOverlay = false) {
  if (autoPlayObserver) { autoPlayObserver.disconnect(); autoPlayObserver = null; }
  if (!containerSelector) return;

  const container = document.querySelector(containerSelector);
  if (!container) {
    console.warn(`[LingoScript] Auto-play container not found: "${containerSelector}"`);
    return;
  }

  autoPlayObserver = new MutationObserver((mutations) => {
    if (!isAutoPlay) return;
    mutations.forEach(({ type, attributeName, target }) => {
      if (type === 'attributes' && (attributeName === 'class' || attributeName === 'data-purpose')) {
        // Check if element is active (via class or data-purpose)
        const isActive = (activeClass && target.classList.contains(activeClass)) || 
                        target.dataset.purpose === 'transcript-cue-active';
        
        // For Udemy: check if child span has the translated text
        let translatedElement = target;
        if (!target.dataset.lingoTranslated && target.querySelector) {
          translatedElement = target.querySelector('[data-lingo-translated="true"]');
        }
        
        if (isActive && translatedElement && translatedElement.dataset.lingoTranslated) {
          const text = translatedElement.dataset.lingoText || translatedElement.innerText.replace('🔊', '').trim();
          if (text) {
            // Show overlay subtitle
            if (enableOverlay) {
              showOverlaySubtitle(text);
            }

            // Speak text
            chrome.storage.sync.get(['ttsProvider', 'ttsApiKey', 'targetLanguage'], (cfg) => {
              speakText(text, cfg);
            });
          }
        }
      }
    });
  });

  autoPlayObserver.observe(container, {
    attributes: true,
    subtree: true,
    attributeFilter: ['class', 'data-purpose']
  });
  console.log('[LingoScript] Auto-play observer active.');
}

// =============================================================================
// MAIN: INITIATE TRANSLATION
// =============================================================================

async function initiateTranslation() {
  const config = await new Promise(resolve => {
    chrome.storage.sync.get([
      'llmProvider', 'llmApiKey', 'targetLanguage',
      'ollamaModel', 'ollamaModelCustom',
      'ttsProvider', 'ttsApiKey', 'isAutoPlayEnabled',
      'transcriptSelector', 'activeClass', 'containerSelector',
      'customSystemPrompt', 'bilingualMode', 'enableLazyLoading', 'enableOverlay'
    ], resolve);
  });

  // Resolve Ollama model name (custom text input takes priority)
  if (config.llmProvider === 'ollama') {
    config.resolvedOllamaModel = config.ollamaModel === 'custom'
      ? (config.ollamaModelCustom || 'gpt-oss:120b')
      : (config.ollamaModel || 'gpt-oss:120b');
  }

  if (!config.llmApiKey) {
    showLingoToast('Vui lòng nhập API Key trong cửa sổ Extension!', true);
    return;
  }

  // Reset cancel state
  shouldCancel = false;

  // Auto-detect platform nếu chưa cấu hình selector
  let selector      = (config.transcriptSelector || '').trim();
  let containerSel  = (config.containerSelector  || '').trim();
  let activeClassName = (config.activeClass || '').trim();

  if (!selector) {
    const detected = autoDetectPlatform();
    if (detected) {
      selector        = detected.selector;
      containerSel    = detected.container;
      activeClassName = detected.activeClass;
      showLingoToast(`🎯 Tự động phát hiện: ${detected.name}`);
      console.log('[LingoScript] Auto-detected:', detected.name);
    } else {
      showLingoToast('Không nhận ra nền tảng. Hãy nhập CSS Selector thủ công trong Extension!', true);
      return;
    }
  }

  let batches = collectAndChunk(selector, 20);

  // Fallback: selector thủ công không khớp → thử auto-detect
  if (!batches.length) {
    const detected = autoDetectPlatform();
    if (detected && detected.selector !== selector) {
      console.warn('[LingoScript] Selector yielded 0 results, trying auto-detect:', detected.name);
      selector        = detected.selector;
      containerSel    = detected.container;
      activeClassName = detected.activeClass;
      batches = collectAndChunk(selector, 20);
      if (batches.length) showLingoToast(`🎯 Dùng selector tự động: ${detected.name}`);
    }
  }

  if (!batches.length) {
    showLingoToast(
      `Không tìm thấy transcript!\nSelector: "${selector}"\nMở F12 > Elements để tìm đúng selector.`,
      true
    );
    return;
  }

  isAutoPlay = config.isAutoPlayEnabled || false;

  if (isAutoPlay) {
    showVolumeWarning();
    setupAutoPlay(containerSel, activeClassName, config.enableOverlay);
  }

  // Enable lazy loading observer if enabled
  if (config.enableLazyLoading) {
    setupLazyLoading(containerSel, selector, config);
  }

  const total = batches.length;
  isTranslating = true;
  console.log(`[LingoScript] Starting: ${total} batches, provider: ${config.llmProvider}`);

  // Add cancel button
  addCancelButton();

  for (let i = 0; i < batches.length; i++) {
    // Check if user cancelled
    if (shouldCancel) {
      console.log('[LingoScript] Translation cancelled by user');
      showLingoToast('❌ Đã dừng dịch', false);
      break;
    }

    setProgress(i, total);
    markLoading(batches[i]);

    try {
      const translated = await translateBatch(batches[i], config);
      unmarkLoading(batches[i]);
      replaceText(translated, config.targetLanguage || 'Vietnamese', config.bilingualMode);
    } catch (err) {
      unmarkLoading(batches[i]);
      console.error(`[LingoScript] Batch ${i + 1}/${total} failed:`, err.message);
      
      // Mark failed segments with red color for manual retry
      batches[i].forEach(({ id, text }) => {
        const el = nodeMap.get(id);
        if (el && !el.dataset.lingoTranslated) {
          el.style.color = '#e74c3c';
          el.title = '❌ Dịch thất bại - Click để thử lại';
          el.style.cursor = 'pointer';
          el.onclick = async () => {
            el.style.opacity = '0.4';
            el.style.cursor = 'wait';
            try {
              const retryConfig = await new Promise(resolve => {
                chrome.storage.sync.get([
                  'llmProvider', 'llmApiKey', 'targetLanguage', 
                  'ollamaModel', 'ollamaModelCustom', 'customSystemPrompt', 'bilingualMode'
                ], resolve);
              });
              retryConfig.resolvedOllamaModel = retryConfig.ollamaModel === 'custom'
                ? (retryConfig.ollamaModelCustom || 'gpt-oss:120b')
                : (retryConfig.ollamaModel || 'gpt-oss:120b');
              
              const retryTranslated = await translateBatch([{ id, text }], retryConfig);
              el.style.opacity = '1';
              el.style.cursor = '';
              replaceText(retryTranslated, retryConfig.targetLanguage || 'Vietnamese', retryConfig.bilingualMode);
            } catch (e) {
              el.style.opacity = '1';
              el.style.cursor = 'pointer';
              showLingoToast('Retry thất bại: ' + e.message, true);
            }
          };
        }
      });
      showLingoToast(`⚠️ Batch ${i + 1}/${total} thất bại - Segments màu đỏ click để retry`, true);
    }

    // Rate-limit: small delay between requests (skip after last batch)
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  isTranslating = false;
  removeCancelButton();

  setProgress(total, total);
  console.log('[LingoScript] ✓ Translation complete!');
}

// =============================================================================
// MESSAGE LISTENER (from popup.js)
// =============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START_TRANSLATE') {
    sendResponse({ status: 'processing' });
    initiateTranslation();
  }
  return true; // keep message channel open for async response
});
