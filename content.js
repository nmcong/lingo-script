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
let isPaused = false;
let currentBatchIndex = 0;
let totalBatches = 0;

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
      // Add pending badge
      addSegmentBadge(el, 'pending');
    }
  });

  console.log(`[LingoScript] ${textData.length} segments found, ${chunkArray(textData, chunkSize).length} batches.`);
  return chunkArray(textData, chunkSize);
}

// =============================================================================
// FLOATING BUBBLE CONTROL CENTER
// =============================================================================

let floatingBubble = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let dragStartPos = { x: 0, y: 0 };
let hasMoved = false;

function createFloatingBubble() {
  if (floatingBubble) return floatingBubble;

  // Main bubble container
  floatingBubble = document.createElement('div');
  floatingBubble.id = 'lingo-floating-bubble';
  floatingBubble.style.cssText = [
    'position:fixed',
    'bottom:80px',
    'right:30px',
    'width:56px',
    'height:56px',
    'border-radius:50%',
    'background:linear-gradient(135deg, #e94560, #c73652)',
    'box-shadow:0 4px 20px rgba(233,69,96,0.4)',
    'cursor:move',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:24px',
    'transition:transform 0.2s ease, box-shadow 0.2s ease',
    'user-select:none'
  ].join(';');

  // Icon container
  const iconSpan = document.createElement('span');
  iconSpan.id = 'lingo-bubble-icon';
  iconSpan.innerHTML = '<i data-feather="globe" style="width:24px;height:24px;"></i>';
  iconSpan.style.cssText = 'pointer-events:none;display:flex;align-items:center;justify-content:center;';
  floatingBubble.appendChild(iconSpan);
  
  floatingBubble.title = 'LingoScript Control';

  // Message bubble (tooltip) - for transcript text display
  const messageBubble = document.createElement('div');
  messageBubble.id = 'lingo-bubble-message';
  messageBubble.style.cssText = [
    'position:fixed', // Changed from absolute to fixed
    'background:#1a1a2e',
    'color:#e0e0e0',
    'padding:12px 16px',
    'border-radius:8px',
    'font-size:14px',
    'line-height:1.5',
    'white-space:normal',
    'word-wrap:break-word',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'display:none',
    'max-width:400px',
    'min-width:200px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border:2px solid #e94560',
    'z-index:2147483649', // Higher than bubble
    'pointer-events:none' // Don't block clicks
  ].join(';');
  document.body.appendChild(messageBubble); // Append to body instead of bubble

  // Control panel (expands when clicked)
  const controlPanel = document.createElement('div');
  controlPanel.id = 'lingo-control-panel';
  controlPanel.style.cssText = [
    'position:absolute',
    'right:70px',
    'top:0',
    'background:#1a1a2e',
    'border-radius:12px',
    'padding:12px',
    'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
    'border:1px solid #e94560',
    'display:none',
    'min-width:180px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  ].join(';');

  controlPanel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button id="lingo-start-btn" style="padding:8px 12px;background:#28a745;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i data-feather="play" style="width:14px;height:14px;"></i> Bắt đầu dịch
      </button>
      <button id="lingo-pause-btn" style="padding:8px 12px;background:#ffc107;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;display:none;align-items:center;justify-content:center;gap:6px;">
        <i data-feather="pause" style="width:14px;height:14px;"></i> Tạm dừng
      </button>
      <button id="lingo-resume-btn" style="padding:8px 12px;background:#17a2b8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;display:none;align-items:center;justify-content:center;gap:6px;">
        <i data-feather="play-circle" style="width:14px;height:14px;"></i> Tiếp tục
      </button>
      <button id="lingo-stop-btn" style="padding:8px 12px;background:#dc3545;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;display:none;align-items:center;justify-content:center;gap:6px;">
        <i data-feather="square" style="width:14px;height:14px;"></i> Dừng
      </button>
      <button id="lingo-summarize-btn" style="padding:8px 12px;background:#6c757d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i data-feather="file-text" style="width:14px;height:14px;"></i> Tóm tắt
      </button>
      <div id="lingo-progress-text" style="font-size:11px;color:#8898aa;text-align:center;margin-top:4px;display:none;">
        0/0
      </div>
    </div>
  `;
  floatingBubble.appendChild(controlPanel);

  // Drag & Drop functionality with move detection
  floatingBubble.addEventListener('mousedown', (e) => {
    if (e.target === floatingBubble || e.target.id === 'lingo-bubble-icon') {
      isDragging = true;
      hasMoved = false;
      dragStartPos.x = e.clientX;
      dragStartPos.y = e.clientY;
      
      const rect = floatingBubble.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      floatingBubble.style.cursor = 'grabbing';
      floatingBubble.style.transform = 'scale(0.95)';
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const deltaX = Math.abs(e.clientX - dragStartPos.x);
      const deltaY = Math.abs(e.clientY - dragStartPos.y);
      
      // If moved more than 5px, consider it a drag (not a click)
      if (deltaX > 5 || deltaY > 5) {
        hasMoved = true;
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;
        floatingBubble.style.left = x + 'px';
        floatingBubble.style.top = y + 'px';
        floatingBubble.style.right = 'auto';
        floatingBubble.style.bottom = 'auto';
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      floatingBubble.style.cursor = 'move';
      floatingBubble.style.transform = 'scale(1)';
    }
  });

  // Click to toggle control panel (only if not dragged)
  floatingBubble.addEventListener('click', (e) => {
    if ((e.target === floatingBubble || e.target.id === 'lingo-bubble-icon') && !hasMoved) {
      const panel = controlPanel;
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        // Hide message bubble when panel opens
        hideBubbleMessage();
      } else {
        panel.style.display = 'none';
      }
    }
  });

  // Hover effects
  floatingBubble.addEventListener('mouseenter', () => {
    if (!isDragging) {
      floatingBubble.style.transform = 'scale(1.1)';
      floatingBubble.style.boxShadow = '0 6px 28px rgba(233,69,96,0.6)';
    }
  });

  floatingBubble.addEventListener('mouseleave', () => {
    if (!isDragging) {
      floatingBubble.style.transform = 'scale(1)';
      floatingBubble.style.boxShadow = '0 4px 20px rgba(233,69,96,0.4)';
    }
  });

  document.body.appendChild(floatingBubble);
  
  // Load Feather icons if not already loaded
  if (!window.feather) {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/feather-icons';
    script.onload = () => {
      if (window.feather) {
        window.feather.replace();
      }
    };
    document.head.appendChild(script);
  } else {
    window.feather.replace();
  }
  
  return floatingBubble;
}

function showBubbleMessage(text, duration = 3000, isTranscript = false) {
  const bubble = floatingBubble || createFloatingBubble();
  const message = document.getElementById('lingo-bubble-message');
  if (!message) return;
  
  // Position message next to bubble
  const bubbleRect = bubble.getBoundingClientRect();
  message.style.left = (bubbleRect.left - 420) + 'px'; // 400px width + 20px gap
  message.style.top = bubbleRect.top + 'px';
  
  // Style differently for transcript vs status messages
  if (isTranscript) {
    message.style.background = '#2c3e50';
    message.style.borderColor = '#3498db';
    message.style.fontSize = '15px';
    message.style.lineHeight = '1.6';
    message.style.maxWidth = '450px';
    message.style.padding = '14px 18px';
  } else {
    message.style.background = '#1a1a2e';
    message.style.borderColor = '#e94560';
    message.style.fontSize = '13px';
    message.style.lineHeight = '1.5';
    message.style.maxWidth = '300px';
    message.style.padding = '10px 14px';
  }
  
  message.textContent = text;
  message.style.display = 'block';
  message.style.opacity = '0';
  message.style.transition = 'opacity 0.3s ease';
  
  // Fade in
  setTimeout(() => {
    message.style.opacity = '1';
  }, 10);
  
  if (duration > 0) {
    setTimeout(() => {
      message.style.opacity = '0';
      setTimeout(() => {
        message.style.display = 'none';
      }, 300);
    }, duration);
  }
}

function hideBubbleMessage() {
  const bubble = floatingBubble;
  if (!bubble) return;
  
  const message = bubble.querySelector('#lingo-bubble-message');
  if (message && message.style.display !== 'none') {
    message.style.opacity = '0';
    setTimeout(() => {
      message.style.display = 'none';
    }, 300);
  }
}

function updateBubbleState(state) {
  const bubble = floatingBubble || createFloatingBubble();
  const icon = bubble.querySelector('#lingo-bubble-icon');
  const startBtn = bubble.querySelector('#lingo-start-btn');
  const pauseBtn = bubble.querySelector('#lingo-pause-btn');
  const resumeBtn = bubble.querySelector('#lingo-resume-btn');
  const stopBtn = bubble.querySelector('#lingo-stop-btn');
  const progressText = bubble.querySelector('#lingo-progress-text');

  // Reset all buttons
  startBtn.style.display = 'none';
  pauseBtn.style.display = 'none';
  resumeBtn.style.display = 'none';
  stopBtn.style.display = 'none';
  progressText.style.display = 'none';

  switch (state) {
    case 'idle':
      startBtn.style.display = 'flex';
      icon.innerHTML = '<i data-feather="globe" style="width:24px;height:24px;"></i>';
      bubble.style.background = 'linear-gradient(135deg, #e94560, #c73652)';
      break;
    case 'translating':
      pauseBtn.style.display = 'flex';
      stopBtn.style.display = 'flex';
      progressText.style.display = 'block';
      icon.innerHTML = '<i data-feather="refresh-cw" class="rotating" style="width:24px;height:24px;"></i>';
      bubble.style.background = 'linear-gradient(135deg, #28a745, #20863a)';
      break;
    case 'paused':
      resumeBtn.style.display = 'flex';
      stopBtn.style.display = 'flex';
      progressText.style.display = 'block';
      icon.innerHTML = '<i data-feather="pause-circle" style="width:24px;height:24px;"></i>';
      bubble.style.background = 'linear-gradient(135deg, #ffc107, #e0a800)';
      break;
    case 'completed':
      startBtn.style.display = 'flex';
      icon.innerHTML = '<i data-feather="check-circle" style="width:24px;height:24px;"></i>';
      bubble.style.background = 'linear-gradient(135deg, #28a745, #20863a)';
      showBubbleMessage('Dịch hoàn tất!', 3000);
      setTimeout(() => {
        icon.innerHTML = '<i data-feather="globe" style="width:24px;height:24px;"></i>';
        bubble.style.background = 'linear-gradient(135deg, #e94560, #c73652)';
        if (window.feather) window.feather.replace();
      }, 3000);
      break;
    case 'error':
      startBtn.style.display = 'flex';
      icon.innerHTML = '<i data-feather="x-circle" style="width:24px;height:24px;"></i>';
      bubble.style.background = 'linear-gradient(135deg, #dc3545, #c82333)';
      setTimeout(() => {
        icon.innerHTML = '<i data-feather="globe" style="width:24px;height:24px;"></i>';
        bubble.style.background = 'linear-gradient(135deg, #e94560, #c73652)';
        if (window.feather) window.feather.replace();
      }, 5000);
      break;
  }
  
  // Replace Feather icons
  if (window.feather) {
    window.feather.replace();
  }
}

function updateBubbleProgress(current, total) {
  const bubble = floatingBubble || createFloatingBubble();
  const progressText = bubble.querySelector('#lingo-progress-text');
  if (progressText) {
    progressText.textContent = `${current}/${total}`;
  }
}

// =============================================================================
// SEGMENT STATUS BADGES
// =============================================================================

function addSegmentBadge(element, status) {
  // Remove existing badge
  const existingBadge = element.querySelector('.lingo-status-badge');
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement('span');
  badge.className = 'lingo-status-badge';
  badge.style.cssText = [
    'display:inline-block',
    'width:18px',
    'height:18px',
    'border-radius:50%',
    'margin-right:6px',
    'vertical-align:middle',
    'flex-shrink:0',
    'border:2px solid'
  ].join(';');

  const configs = {
    pending: { bg: '#6c757d', border: '#5a6268', icon: 'clock' },
    translating: { bg: '#ffc107', border: '#e0a800', icon: 'loader' },
    completed: { bg: '#28a745', border: '#1e7e34', icon: 'check' },
    error: { bg: '#dc3545', border: '#bd2130', icon: 'x' },
    cached: { bg: '#17a2b8', border: '#138496', icon: 'database' }
  };

  const config = configs[status] || configs.pending;
  badge.style.background = config.bg;
  badge.style.borderColor = config.border;
  badge.style.color = '#fff';
  badge.style.fontSize = '10px';
  badge.style.fontWeight = '700';
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.justifyContent = 'center';
  badge.innerHTML = `<i data-feather="${config.icon}" style="width:12px;height:12px;stroke-width:3;"></i>`;
  badge.title = status.charAt(0).toUpperCase() + status.slice(1);
  
  // Replace icons
  if (window.feather) {
    window.feather.replace();
  }

  element.insertBefore(badge, element.firstChild);
  
  // Ensure element can display badge properly (but preserve inline if needed)
  const currentDisplay = window.getComputedStyle(element).display;
  if (currentDisplay === 'block' || currentDisplay === 'flex') {
    element.style.display = 'flex';
    element.style.alignItems = 'center';
  } else {
    // For inline elements, don't force flex
    element.style.display = 'inline-flex';
    element.style.alignItems = 'center';
  }
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

// Removed old cancel button - now using floating bubble

// Mark segments as loading
function markLoading(batch, status = 'translating') {
  batch.forEach(({ id }) => {
    const el = nodeMap.get(id);
    if (el) {
      el.style.opacity = '0.4';
      addSegmentBadge(el, status);
    }
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

    // Save original attributes before modifying
    const originalDataPurpose = el.dataset.purpose;
    const originalClass = el.className;

    // Add status badge
    const status = item.fromCache ? 'cached' : 'completed';
    addSegmentBadge(el, status);

    // Save original text if not saved yet
    if (!el.dataset.lingoOriginal) {
      el.dataset.lingoOriginal = el.textContent.trim();
    }

    // Save badge and speaker button if they exist
    const badge = el.querySelector('.lingo-status-badge');
    const existingSpeaker = el.querySelector('.lingo-speak-btn');

    // Clear content but preserve structure
    const childNodes = Array.from(el.childNodes);
    childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE || 
          (node.nodeType === Node.ELEMENT_NODE && 
           !node.classList.contains('lingo-status-badge') && 
           !node.classList.contains('lingo-speak-btn'))) {
        node.remove();
      }
    });

    if (bilingualMode) {
      // Bilingual: Keep original, add translation below
      const wrapper = document.createElement('div');
      wrapper.className = 'lingo-bilingual-wrapper';
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex:1;';
      
      const originalSpan = document.createElement('div');
      originalSpan.className = 'lingo-original-text';
      originalSpan.style.cssText = 'color:#666;font-size:0.85em;line-height:1.4;';
      originalSpan.textContent = el.dataset.lingoOriginal;
      
      const translatedSpan = document.createElement('div');
      translatedSpan.className = 'lingo-translated-text';
      translatedSpan.style.cssText = 'color:#2e7d32;font-weight:500;line-height:1.5;';
      translatedSpan.textContent = item.text;
      
      wrapper.appendChild(originalSpan);
      wrapper.appendChild(translatedSpan);
      
      // Insert wrapper after badge but before speaker button
      if (badge && !existingSpeaker) {
        el.appendChild(wrapper);
      } else if (badge && existingSpeaker) {
        el.insertBefore(wrapper, existingSpeaker);
      } else {
        el.appendChild(wrapper);
      }
    } else {
      // Replace mode: simple text node or span
      const textNode = document.createTextNode(item.text);
      if (existingSpeaker) {
        el.insertBefore(textNode, existingSpeaker);
      } else {
        el.appendChild(textNode);
      }
      el.style.color = '#2e7d32';
    }

    // Restore/set critical data attributes
    if (originalDataPurpose) {
      el.dataset.purpose = originalDataPurpose;
    }
    el.dataset.lingoTranslated = 'true';
    el.dataset.lingoText = item.text;
    el.title = item.fromCache ? '💾 Từ cache' : '✨ Vừa dịch';

    // Add speaker button if not exists
    if (!existingSpeaker) {
      const btn = document.createElement('span');
      btn.className = 'lingo-speak-btn';
      btn.innerHTML = '<i data-feather="volume-2" style="width:14px;height:14px;"></i>';
      btn.title = 'Nghe đoạn này';
      btn.style.cssText = 'cursor:pointer;opacity:0.6;transition:opacity 0.15s,transform 0.15s;margin-left:8px;display:inline-flex;align-items:center;';
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

      el.appendChild(btn);
      
      // Replace icons
      if (window.feather) {
        window.feather.replace();
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
    @keyframes rotating {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .rotating {
      animation: rotating 2s linear infinite;
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

function setupAutoPlay(containerSelector, activeClass, enableOverlay = false, enableBubbleText = true) {
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
        
        if (!isActive) return;

        // Find translated element (could be target itself or a child)
        let translatedElement = null;
        let translatedText = null;

        // Case 1: target itself is translated
        if (target.dataset.lingoTranslated) {
          translatedElement = target;
          translatedText = target.dataset.lingoText;
        } 
        // Case 2: target has translated child (Udemy case)
        else if (target.querySelector) {
          translatedElement = target.querySelector('[data-lingo-translated="true"]');
          if (translatedElement) {
            translatedText = translatedElement.dataset.lingoText;
          }
        }

        // Case 3: target is parent of transcript element (look for data-purpose="cue-text")
        if (!translatedText && target.querySelector) {
          const cueElement = target.querySelector('[data-purpose="cue-text"]');
          if (cueElement && cueElement.dataset.lingoTranslated) {
            translatedElement = cueElement;
            translatedText = cueElement.dataset.lingoText;
          }
        }

        if (translatedText) {
          console.log('[LingoScript] Auto-play:', translatedText.slice(0, 50) + '...', 'enableBubbleText:', enableBubbleText);

          // Show in bubble message if enabled (always close panel first)
          if (enableBubbleText) {
            // Close control panel if open
            const bubble = floatingBubble || createFloatingBubble();
            const panel = bubble.querySelector('#lingo-control-panel');
            if (panel) panel.style.display = 'none';
            
            // Show message
            setTimeout(() => {
              showBubbleMessage(translatedText, 0, true); // duration=0 means persistent until next cue
            }, 100);
          }

          // Show overlay subtitle if enabled
          if (enableOverlay) {
            showOverlaySubtitle(translatedText);
          }

          // Speak text
          chrome.storage.sync.get(['ttsProvider', 'ttsApiKey', 'targetLanguage'], (cfg) => {
            speakText(translatedText, cfg);
          });
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
// BUBBLE CONTROLS SETUP
// =============================================================================

function setupBubbleControls(batches, config) {
  const bubble = floatingBubble || createFloatingBubble();
  
  const startBtn = bubble.querySelector('#lingo-start-btn');
  const pauseBtn = bubble.querySelector('#lingo-pause-btn');
  const resumeBtn = bubble.querySelector('#lingo-resume-btn');
  const stopBtn = bubble.querySelector('#lingo-stop-btn');
  const summarizeBtn = bubble.querySelector('#lingo-summarize-btn');

  // Start button
  startBtn.onclick = () => {
    if (!isTranslating) {
      initiateTranslation();
      bubble.querySelector('#lingo-control-panel').style.display = 'none';
    }
  };

  // Pause button
  pauseBtn.onclick = () => {
    isPaused = true;
    updateBubbleState('paused');
    showBubbleMessage('Đã tạm dừng', 2000);
  };

  // Resume button
  resumeBtn.onclick = () => {
    isPaused = false;
    updateBubbleState('translating');
    showBubbleMessage('Tiếp tục dịch...', 2000);
  };

  // Stop button
  stopBtn.onclick = () => {
    shouldCancel = true;
    isPaused = false;
    updateBubbleState('idle');
    showBubbleMessage('Đang dừng...', 2000);
  };

  // Summarize button
  summarizeBtn.onclick = async () => {
    bubble.querySelector('#lingo-control-panel').style.display = 'none';
    showBubbleMessage('Đang tóm tắt transcript...', 0);
    
    try {
      const allTranslatedElements = document.querySelectorAll('[data-lingo-translated="true"]');
      if (allTranslatedElements.length === 0) {
        showBubbleMessage('Chưa có transcript được dịch!', 3000);
        return;
      }

      // Collect all translated text
      const allText = Array.from(allTranslatedElements)
        .map(el => el.dataset.lingoText || el.textContent.trim())
        .filter(t => t && t.length > 0)
        .join(' ');

      if (allText.length < 50) {
        showBubbleMessage('Transcript quá ngắn để tóm tắt!', 3000);
        return;
      }

      // Get config for LLM
      const cfg = await new Promise(resolve => {
        chrome.storage.sync.get([
          'llmProvider', 'llmApiKey', 'targetLanguage', 
          'ollamaModel', 'ollamaModelCustom'
        ], resolve);
      });

      const resolvedModel = cfg.ollamaModel === 'custom' 
        ? (cfg.ollamaModelCustom || 'gpt-oss:120b')
        : (cfg.ollamaModel || 'gpt-oss:120b');

      // Send to background for summarization
      const summary = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'SUMMARIZE_TEXT',
          text: allText,
          config: {
            llmProvider: cfg.llmProvider,
            llmApiKey: cfg.llmApiKey,
            targetLanguage: cfg.targetLanguage,
            resolvedOllamaModel: resolvedModel
          }
        }, (response) => {
          if (response && response.success) {
            resolve(response.summary);
          } else {
            reject(new Error(response?.error || 'Summarization failed'));
          }
        });
      });

      showBubbleMessage(summary, 0, true); // Show summary persistently
    } catch (err) {
      showBubbleMessage('Lỗi: ' + err.message, 5000);
      console.error('[LingoScript] Summarize failed:', err);
    }
  };
}

function setupRetryHandler(element, id, text, config) {
  element.style.cursor = 'pointer';
  element.title = '❌ Dịch thất bại - Click để thử lại';
  
  element.onclick = async () => {
    element.style.opacity = '0.4';
    element.style.cursor = 'wait';
    addSegmentBadge(element, 'translating');

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
      element.style.opacity = '1';
      element.style.cursor = '';
      replaceText(retryTranslated, retryConfig.targetLanguage || 'Vietnamese', retryConfig.bilingualMode);
      showBubbleMessage('✅ Retry thành công!', 2000);
    } catch (e) {
      element.style.opacity = '1';
      element.style.cursor = 'pointer';
      addSegmentBadge(element, 'error');
      showBubbleMessage('❌ Retry thất bại', 2000);
    }
  };
}

// =============================================================================
// MAIN: INITIATE TRANSLATION
// =============================================================================

async function initiateTranslation(mode = 'batch') {
  const config = await new Promise(resolve => {
    chrome.storage.sync.get([
      'llmProvider', 'llmApiKey', 'targetLanguage',
      'ollamaModel', 'ollamaModelCustom',
      'ttsProvider', 'ttsApiKey', 'isAutoPlayEnabled',
      'transcriptSelector', 'activeClass', 'containerSelector',
      'customSystemPrompt', 'bilingualMode', 'enableLazyLoading', 'enableOverlay', 'enableBubbleText',
      'singleBatchMode'
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
    setupAutoPlay(containerSel, activeClassName, config.enableOverlay, config.enableBubbleText !== false);
  }

  // Enable lazy loading observer if enabled
  if (config.enableLazyLoading) {
    setupLazyLoading(containerSel, selector, config);
  }

  totalBatches = batches.length;
  currentBatchIndex = 0;
  isTranslating = true;
  isPaused = false;
  shouldCancel = false;

  console.log(`[LingoScript] Starting: ${totalBatches} batches, provider: ${config.llmProvider}`);

  // Create and setup floating bubble
  const bubble = createFloatingBubble();
  updateBubbleState('translating');
  updateBubbleProgress(0, totalBatches);
  showBubbleMessage('🚀 Bắt đầu dịch...', 2000);

  // Setup button handlers
  setupBubbleControls(batches, config);

  // Single batch mode: Send all at once
  if (config.singleBatchMode && batches.length > 1) {
    const allItems = batches.flat();
    markLoading(allItems, 'translating');
    showBubbleMessage(`📤 Đang gửi ${allItems.length} đoạn cho AI...`, 0);

    try {
      const translated = await translateBatch(allItems, config);
      unmarkLoading(allItems);
      replaceText(translated, config.targetLanguage || 'Vietnamese', config.bilingualMode);
      
      updateBubbleState('completed');
      updateBubbleProgress(totalBatches, totalBatches);
      setProgress(totalBatches, totalBatches);
      console.log('[LingoScript] ✓ Single-batch translation complete!');
    } catch (err) {
      console.error('[LingoScript] Single-batch failed:', err.message);
      allItems.forEach(({ id, text }) => {
        const el = nodeMap.get(id);
        if (el && !el.dataset.lingoTranslated) {
          addSegmentBadge(el, 'error');
          setupRetryHandler(el, id, text, config);
        }
      });
      updateBubbleState('error');
      showBubbleMessage('❌ Dịch thất bại!', 3000);
    }
    
    isTranslating = false;
    return;
  }

  // Batch mode: Process one by one
  for (let i = 0; i < batches.length; i++) {
    currentBatchIndex = i;

    // Check pause
    while (isPaused && !shouldCancel) {
      await new Promise(r => setTimeout(r, 500));
    }

    // Check cancel
    if (shouldCancel) {
      console.log('[LingoScript] Translation cancelled by user');
      updateBubbleState('idle');
      showBubbleMessage('⏹️ Đã dừng dịch', 2000);
      break;
    }

    setProgress(i, totalBatches);
    updateBubbleProgress(i + 1, totalBatches);
    markLoading(batches[i], 'translating');
    showBubbleMessage(`🔄 Đang dịch batch ${i + 1}/${totalBatches}...`, 0);

    try {
      const translated = await translateBatch(batches[i], config);
      unmarkLoading(batches[i]);
      replaceText(translated, config.targetLanguage || 'Vietnamese', config.bilingualMode);
    } catch (err) {
      unmarkLoading(batches[i]);
      console.error(`[LingoScript] Batch ${i + 1}/${totalBatches} failed:`, err.message);
      
      // Mark failed segments
      batches[i].forEach(({ id, text }) => {
        const el = nodeMap.get(id);
        if (el && !el.dataset.lingoTranslated) {
          addSegmentBadge(el, 'error');
          setupRetryHandler(el, id, text, config);
        }
      });
      showBubbleMessage(`⚠️ Batch ${i + 1} thất bại`, 2000);
    }

    // Rate-limit delay
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  isTranslating = false;
  if (!shouldCancel) {
    updateBubbleState('completed');
    updateBubbleProgress(totalBatches, totalBatches);
    setProgress(totalBatches, totalBatches);
  }

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

// Initialize floating bubble on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => createFloatingBubble(), 1000);
  });
} else {
  setTimeout(() => createFloatingBubble(), 1000);
}
