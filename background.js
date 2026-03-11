// =============================================================================
// LingoScript – Background Service Worker
// Handles all API calls securely (prevents API key exposure in content scripts)
// Implements caching, smart batching, and translation queue management
// =============================================================================

// ── IndexedDB Cache Setup ────────────────────────────────────────────────────
const DB_NAME = 'LingoScriptCache';
const DB_VERSION = 1;
const STORE_NAME = 'translations';

let db = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('url', 'url', { unique: false });
      }
    };
  });
}

// Initialize DB when service worker starts
openDatabase().catch(err => console.error('[LingoScript BG] DB init failed:', err));

// Cache key format: `${url}:${originalText}`
async function getCachedTranslation(url, text, targetLang) {
  if (!db) await openDatabase();
  const key = `${url}:${targetLang}:${text.slice(0, 100)}`;
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    
    request.onsuccess = () => {
      const result = request.result;
      if (result && Date.now() - result.timestamp < 30 * 24 * 60 * 60 * 1000) { // 30 days
        resolve(result.translatedText);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
}

async function setCachedTranslation(url, originalText, translatedText, targetLang) {
  if (!db) await openDatabase();
  const key = `${url}:${targetLang}:${originalText.slice(0, 100)}`;
  
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({
        key,
        url,
        originalText,
        translatedText,
        targetLang,
        timestamp: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (err) {
      console.warn('[LingoScript BG] Cache write failed:', err);
      resolve(false);
    }
  });
}

// ── System Prompt ─────────────────────────────────────────────────────────────
const defaultSystemPrompt = (lang) =>
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

// ── LLM Provider Implementations ─────────────────────────────────────────────
const GeminiProvider = {
  async translateChunk(batch, apiKey, lang, customPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const systemMsg = customPrompt ? customPrompt.replace('${lang}', lang) : defaultSystemPrompt(lang);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemMsg }] },
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
  async translateChunk(batch, apiKey, lang, customPrompt) {
    const systemMsg = customPrompt ? customPrompt.replace('${lang}', lang) : defaultSystemPrompt(lang);
    
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
          { role: 'system', content: systemMsg },
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
    return Array.isArray(parsed) ? parsed : (parsed.data || parsed.translations || Object.values(parsed)[0]);
  }
};

const ClaudeProvider = {
  async translateChunk(batch, apiKey, lang, customPrompt) {
    const systemMsg = customPrompt ? customPrompt.replace('${lang}', lang) : defaultSystemPrompt(lang);
    
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemMsg,
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
  async translateChunk(batch, apiKey, lang, customPrompt, model) {
    const systemMsg = customPrompt ? customPrompt.replace('${lang}', lang) : defaultSystemPrompt(lang);
    
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
          { role: 'system', content: systemMsg },
          { role: 'user', content: JSON.stringify(batch) }
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

const LLM = { 
  gemini: GeminiProvider, 
  openai: OpenAIProvider, 
  claude: ClaudeProvider, 
  ollama: OllamaProvider 
};

// ── Translation Queue & State Management ─────────────────────────────────────
let translationState = {
  isRunning: false,
  isPaused: false,
  isCancelled: false,
  currentBatch: 0,
  totalBatches: 0,
  tabId: null
};

// ── Smart Batching by Token Count ────────────────────────────────────────────
function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 characters for English, 1.5 chars for Vietnamese
  return Math.ceil(text.length / 3);
}

function createSmartBatches(items, maxTokens = 1500) {
  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;

  items.forEach(item => {
    const tokens = estimateTokens(item.text);
    
    if (currentTokens + tokens > maxTokens && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    
    currentBatch.push(item);
    currentTokens += tokens;
  });

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ── Test API Connection ──────────────────────────────────────────────────────
async function testConnection(provider, apiKey, model) {
  const testBatch = [{ id: 0, text: "Hello, world!" }];
  
  try {
    const translator = LLM[provider.trim()];
    if (!translator) {
      return { success: false, error: `Unknown provider: ${provider}` };
    }
    
    const result = await translator.translateChunk(testBatch, apiKey, 'Vietnamese', null, model);
    
    if (Array.isArray(result) && result.length > 0) {
      return { success: true, message: 'Connection successful!' };
    } else {
      return { success: false, error: 'Invalid response format' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Translation with Cache & Retry ───────────────────────────────────────────
async function translateBatchWithCache(batch, config, url) {
  const { llmProvider, llmApiKey, targetLanguage, customSystemPrompt, resolvedOllamaModel } = config;
  const translator = LLM[llmProvider.trim()];
  
  if (!translator) {
    throw new Error(`Unknown provider: ${llmProvider}`);
  }

  // Check cache for each item
  const results = [];
  const itemsToTranslate = [];
  
  for (const item of batch) {
    const cached = await getCachedTranslation(url, item.text, targetLanguage);
    if (cached) {
      results.push({ id: item.id, text: cached, fromCache: true });
    } else {
      itemsToTranslate.push(item);
    }
  }

  // Translate uncached items with retry
  if (itemsToTranslate.length > 0) {
    let retries = 0;
    const maxRetries = 3;
    let translated = null;

    while (retries < maxRetries && !translated) {
      try {
        translated = await translator.translateChunk(
          itemsToTranslate,
          llmApiKey,
          targetLanguage,
          customSystemPrompt,
          resolvedOllamaModel
        );
      } catch (err) {
        retries++;
        if (retries < maxRetries) {
          const delay = Math.pow(2, retries - 1) * 1000;
          console.log(`[LingoScript BG] Retry ${retries}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }

    // Save to cache and merge results
    if (translated && Array.isArray(translated)) {
      for (let i = 0; i < itemsToTranslate.length; i++) {
        const original = itemsToTranslate[i];
        const trans = translated[i];
        if (trans && trans.text) {
          await setCachedTranslation(url, original.text, trans.text, targetLanguage);
          results.push({ id: original.id, text: trans.text, fromCache: false });
        }
      }
    }
  }

  // Sort results by original id order
  results.sort((a, b) => a.id - b.id);
  return results;
}

// ── Message Handlers ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // TEST CONNECTION
  if (request.action === 'TEST_CONNECTION') {
    testConnection(request.provider, request.apiKey, request.model)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // TRANSLATE BATCH
  if (request.action === 'TRANSLATE_BATCH') {
    const { batch, config, url } = request;
    
    if (translationState.isCancelled) {
      sendResponse({ success: false, error: 'Translation cancelled' });
      return true;
    }

    translateBatchWithCache(batch, config, url)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // PAUSE TRANSLATION
  if (request.action === 'PAUSE_TRANSLATION') {
    translationState.isPaused = true;
    sendResponse({ success: true });
    return true;
  }

  // RESUME TRANSLATION
  if (request.action === 'RESUME_TRANSLATION') {
    translationState.isPaused = false;
    sendResponse({ success: true });
    return true;
  }

  // CANCEL TRANSLATION
  if (request.action === 'CANCEL_TRANSLATION') {
    translationState.isCancelled = true;
    translationState.isRunning = false;
    sendResponse({ success: true });
    return true;
  }

  // SUMMARIZE TEXT
  if (request.action === 'SUMMARIZE_TEXT') {
    const { items, config, url } = request;

    if (!items || items.length === 0) {
      sendResponse({ success: false, error: 'No content to summarize' });
      return true;
    }

    const summarize = async () => {
      try {
        const provider = LLM[config.llmProvider.trim()];
        if (!provider) {
          throw new Error(`Unknown provider: ${config.llmProvider}`);
        }

        // Format transcript with timestamps for better context
        let formattedText = '';
        items.forEach((item, idx) => {
          const prefix = item.timestamp ? `[${item.timestamp}] ` : `[${idx + 1}] `;
          formattedText += prefix + item.text + '\n';
        });

        // Custom system prompt for summarization
        const systemPrompt = `Bạn là chuyên gia phân tích nội dung video. Nhiệm vụ của bạn là tóm tắt chi tiết transcript video bằng ${config.targetLanguage || 'Vietnamese'}.

YÊU CẦU:
- Chia thành 5-8 phần chính với tiêu đề rõ ràng
- Mỗi phần ghi rõ timestamp (nếu có) và tóm tắt chi tiết 2-3 câu
- Format: **[Timestamp] Tiêu đề phần**
Nội dung tóm tắt...

- Sử dụng bullet points khi cần liệt kê các ý chính
- Tổng cộng khoảng 300-500 từ
- CHỈ TRẢ VỀ NỘI DUNG TÓM TẮT, KHÔNG GIẢI THÍCH HAY THÊM COMMENT`;

        // Use custom system prompt for better summarization
        const response = await provider.translateChunk(
          [{ id: 0, text: formattedText }],
          config.llmApiKey,
          config.targetLanguage || 'Vietnamese',
          systemPrompt, // Use custom system prompt instead of default translation prompt
          config.resolvedOllamaModel
        );

        if (response && response[0] && response[0].text) {
          // Save summary to storage
          const summaryData = {
            url: url,
            summary: response[0].text,
            timestamp: Date.now(),
            itemCount: items.length
          };
          
          chrome.storage.local.set({ 
            [`summary_${url}`]: summaryData 
          });
          
          sendResponse({ success: true, summary: response[0].text, summaryData });
        } else {
          sendResponse({ success: false, error: 'Invalid summarization response' });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    };

    summarize();
    return true;
  }
  
  // GET SAVED SUMMARY
  if (request.action === 'GET_SUMMARY') {
    chrome.storage.local.get([`summary_${request.url}`], (result) => {
      const summaryData = result[`summary_${request.url}`];
      if (summaryData) {
        sendResponse({ success: true, summaryData });
      } else {
        sendResponse({ success: false, error: 'No summary found' });
      }
    });
    return true;
  }

  // GET TRANSLATION STATE
  if (request.action === 'GET_STATE') {
    sendResponse(translationState);
    return true;
  }

  // CLEAR CACHE
  if (request.action === 'CLEAR_CACHE') {
    if (!db) {
      sendResponse({ success: false, error: 'DB not initialized' });
      return true;
    }
    
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const clearRequest = store.clear();
    
    clearRequest.onsuccess = () => sendResponse({ success: true });
    clearRequest.onerror = () => sendResponse({ success: false, error: 'Clear failed' });
    return true;
  }

  // GET CACHE STATS
  if (request.action === 'GET_CACHE_STATS') {
    if (!db) {
      sendResponse({ count: 0, size: 0 });
      return true;
    }
    
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const countRequest = store.count();
    
    countRequest.onsuccess = () => {
      sendResponse({ count: countRequest.result });
    };
    countRequest.onerror = () => sendResponse({ count: 0 });
    return true;
  }
});

console.log('[LingoScript BG] Service worker initialized.');
