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

// ── System prompt (shared across all LLM providers) ──────────────────────────
const systemPrompt = (lang) =>
  `Bạn là một hệ thống dịch thuật máy tính siêu tốc và chính xác.
Nhiệm vụ:
1. Nhận một mảng JSON chứa các đối tượng định dạng: [{"id": số, "text": "văn bản gốc"}]. Các đoạn liên tiếp tạo thành ngữ cảnh hoàn chỉnh.
2. Dịch phần "text" sang ${lang}. Duy trì văn phong tự nhiên, liền mạch giữa các đoạn.
3. Giữ nguyên giá trị "id" tương ứng với mỗi đoạn.

Ràng buộc TUYỆT ĐỐI:
- CHỈ trả về một mảng JSON hợp lệ.
- KHÔNG bọc trong markdown (không dùng \`\`\`json).
- KHÔNG giải thích, KHÔNG thêm bất kỳ từ ngữ nào bên ngoài mảng JSON.
- Nếu một đoạn "text" trống hoặc là ký tự đặc biệt, hãy giữ nguyên.`;

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
// LLM PROVIDERS
// =============================================================================

const GeminiProvider = {
  async translateChunk(batch, apiKey, lang) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(lang) }] },
        contents: [{ parts: [{ text: JSON.stringify(batch) }] }],
        generationConfig: { response_mime_type: 'application/json' }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
  }
};

const OpenAIProvider = {
  async translateChunk(batch, apiKey, lang) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(lang) },
          { role: 'user', content: `{"data": ${JSON.stringify(batch)}}` }
        ]
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    // Handle both direct array and {data:[...]} wrapper responses
    return Array.isArray(parsed) ? parsed : (parsed.data || parsed.translations || Object.values(parsed)[0]);
  }
};

const ClaudeProvider = {
  async translateChunk(batch, apiKey, lang) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt(lang),
        messages: [{ role: 'user', content: JSON.stringify(batch) }]
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return JSON.parse(data.content[0].text);
  }
};

const OllamaProvider = {
  async translateChunk(batch, apiKey, lang, model) {
    const res = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'gpt-oss:120b',
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt(lang) },
          { role: 'user',   content: JSON.stringify(batch) }
        ]
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.message?.content || data.choices?.[0]?.message?.content || '';
    return JSON.parse(text);
  }
};

const LLM = { gemini: GeminiProvider, openai: OpenAIProvider, claude: ClaudeProvider, ollama: OllamaProvider };

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
function replaceText(translatedBatch, targetLang) {
  translatedBatch.forEach(item => {
    if (!item || !item.text) return;
    const el = nodeMap.get(item.id);
    if (!el) return;

    el.innerText = item.text;
    el.style.color = '#2e7d32';
    el.dataset.lingoTranslated = 'true';
    el.dataset.lingoText = item.text;

    // Speaker button 🔊
    const btn = document.createElement('span');
    btn.className = 'lingo-speak-btn';
    btn.textContent = ' 🔊';
    btn.title = 'Nghe đoạn này';
    btn.style.cssText = 'cursor:pointer;font-size:0.8em;opacity:0.6;transition:opacity 0.15s,transform 0.15s;';
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
// AUTO-PLAY OBSERVER
// =============================================================================

let autoPlayObserver = null;

function setupAutoPlay(containerSelector, activeClass) {
  if (autoPlayObserver) { autoPlayObserver.disconnect(); autoPlayObserver = null; }
  if (!containerSelector || !activeClass) return;

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
        const isActive = target.classList.contains(activeClass) || 
                        target.dataset.purpose === 'transcript-cue-active';
        
        // For Udemy: check if child span has the translated text
        let translatedElement = target;
        if (!target.dataset.lingoTranslated && target.querySelector) {
          translatedElement = target.querySelector('[data-lingo-translated="true"]');
        }
        
        if (isActive && translatedElement && translatedElement.dataset.lingoTranslated) {
          const text = translatedElement.dataset.lingoText || translatedElement.innerText.replace('🔊', '').trim();
          if (text) {
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
      'transcriptSelector', 'activeClass', 'containerSelector'
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

  // Fix: trim() phòng trường hợp giá trị có whitespace/BOM từ storage
  const providerKey = (config.llmProvider || 'gemini').trim();
  const translator = LLM[providerKey];
  if (!translator) {
    showLingoToast(
      `Provider "${providerKey}" không được nhận. Hãy tải lại trang (F5) rồi thử lại!`,
      true
    );
    console.error('[LingoScript] Unknown provider:', providerKey, '| Available:', Object.keys(LLM));
    return;
  }

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
    setupAutoPlay(containerSel, activeClassName);
  }

  const total = batches.length;
  console.log(`[LingoScript] Starting: ${total} batches, provider: ${config.llmProvider}`);

  for (let i = 0; i < batches.length; i++) {
    setProgress(i, total);
    markLoading(batches[i]);

    try {
      const translated = await translator.translateChunk(
        batches[i],
        config.llmApiKey,
        config.targetLanguage || 'Vietnamese',
        config.resolvedOllamaModel
      );
      unmarkLoading(batches[i]);
      replaceText(translated, config.targetLanguage || 'Vietnamese');
    } catch (err) {
      unmarkLoading(batches[i]);
      console.error(`[LingoScript] Batch ${i + 1}/${total} failed:`, err.message);
    }

    // Rate-limit: small delay between requests (skip after last batch)
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

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
