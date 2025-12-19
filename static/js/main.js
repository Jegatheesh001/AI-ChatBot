// update only if relevent
// Ensure Tailwind respects the 'dark' class on the html element
tailwind.config = {
    darkMode: 'class',
}

// Set theme on page load to avoid flickering
if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
} else {
    document.documentElement.classList.remove('dark');
}

// --- GLOBAL STATE ---
let sessionId = generateUUID();
let currentFiles = [];
let chatHistory = {};
let mediaRecorder;
let audioChunks = [];
let audioBlob;

// Settings will be populated by fetchCurrentSettings on page load
let configSettings = {};

// --- INITIALIZATION ---
fetchChatHistory();
// Fetch settings from the server on startup.
fetchCurrentSettings();
document.getElementById('user-input').focus();

/**
 * Fetches current settings from the server and populates the UI.
 */
async function fetchChatHistory() {
    try {
        const response = await fetch('/history');
        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }
        chatHistory = await response.json();
        console.log("✅ Chat history successfully loaded from server.", chatHistory);
    } catch (err) {
        console.error("⚠️ Failed to load chat history from server:", err);
        chatHistory = {};
    }
    renderSidebar();
}
async function fetchCurrentSettings() {
    try {
        const response = await fetch('/settings');
        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }
        const serverSettings = await response.json();

        // Map server-side keys (e.g., 'openai_model') to client-side keys (e.g., 'model')
        configSettings = {
            model: serverSettings.openai_model || '',
            apiKey: serverSettings.openai_api_key || '',
            baseUrl: serverSettings.openai_base_url || '',
            mcpCommand: serverSettings.mcp_command || ''
        };
        
        console.log("✅ Settings successfully loaded from server.", configSettings.model);

    } catch (err) {
        console.error("⚠️ Failed to load settings from server:", err);
        // Fallback to empty settings if the server is unreachable
        configSettings = { model: '', apiKey: '', baseUrl: '', mcpCommand: '' };
    }
}

function toggleTheme() {
    // update only if relevent
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

function toggleSidebar() {
    const sb = document.getElementById('sidebar'), mc = document.getElementById('main-content');
    if (sb.classList.contains('sidebar-expanded')) {
        sb.classList.replace('sidebar-expanded', 'sidebar-slim');
        mc.classList.replace('content-expanded', 'content-slim');
    } else {
        sb.classList.replace('sidebar-slim', 'sidebar-expanded');
        mc.classList.replace('content-slim', 'content-expanded');
    }
}

function openSettings() {
    // Ensure UI is populated from the centralized state
    document.getElementById('setting-model').value = configSettings.model;
    document.getElementById('setting-api-key').value = configSettings.apiKey;
    document.getElementById('setting-base-url').value = configSettings.baseUrl;
    document.getElementById('setting-mcp').value = configSettings.mcpCommand;
    
    document.getElementById('settings-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('modal-content').classList.remove('scale-95', 'opacity-0'), 10);
}

function closeSettings() {
    document.getElementById('modal-content').classList.add('scale-95', 'opacity-0');
    setTimeout(() => document.getElementById('settings-modal').classList.add('hidden'), 200);
}

async function saveSettings() {
    // Capture UI values
    configSettings = {
        model: document.getElementById('setting-model').value,
        apiKey: document.getElementById('setting-api-key').value,
        baseUrl: document.getElementById('setting-base-url').value,
        mcpCommand: document.getElementById('setting-mcp').value
    };
    
    // Persist to backend Priority 1 (saved_settings.json) and re-init session
    await syncSettingsWithServer({
        openai_model: configSettings.model,
        openai_api_key: configSettings.apiKey,
        openai_base_url: configSettings.baseUrl,
        mcp_command: configSettings.mcpCommand
    });
    closeSettings();
}

async function syncSettingsWithServer(newSettings) {
    try {
        await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                messages: [],
                settings: newSettings
            })
        });
    } catch (err) { console.error("Sync error:", err); }
}

function startNewChat() {
    sessionId = generateUUID();
    const container = document.getElementById('messages-container');
    
    // Revoke any existing object URLs before starting a new chat
    container.querySelectorAll('img').forEach(img => {
        if (img.src.startsWith('blob:')) {
            URL.revokeObjectURL(img.src);
        }
    });
    cancelAudio();
    container.innerHTML = `
        <div id="empty-state" class="flex flex-col items-center justify-center h-full text-gray-300 dark:text-gray-600">
            <div class="p-6 bg-white dark:bg-gray-700/50 rounded-full shadow-sm mb-4 border border-gray-100 dark:border-gray-700">
                <i class="ph ph-chat-circle-dots text-5xl text-indigo-200 dark:text-indigo-400"></i>
            </div>
            <p class="text-xl font-medium text-gray-400 dark:text-gray-500">How can I help you today?</p>
        </div>
    `;
    // Unselect any selected chat in the sidebar
    renderSidebar();
    // Clear any existing files from a previous session
    currentFiles = [];
    updateFilePreview();
    
    document.getElementById('user-input').focus();
}

async function sendMessage() {
    const input = document.getElementById('user-input');
    let text = input.value.trim();
    
    if (!text && currentFiles.length === 0) return;

    const filesToSend = [...currentFiles];
    const userMsgId = addMessageToUI('user', text, filesToSend);

    currentFiles = [];
    updateFilePreview();
    input.value = '';
    input.style.height = 'auto';

    const isNewChat = !chatHistory[sessionId];

    // Wait for history to be saved with data URLs before proceeding
    await saveToHistory('user', text, filesToSend, userMsgId);

    if (isNewChat) {
        const newTitle = text.substring(0, 35) + (text.length > 35 ? '...' : '');
        chatHistory[sessionId].title = newTitle;
        renderSidebar();
    }

    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const payload = {
        session_id: sessionId,
        messages: getSessionMessages(), // Now gets messages with data URLs
        settings: {
            openai_model: configSettings.model,
            openai_api_key: configSettings.apiKey,
            openai_base_url: configSettings.baseUrl,
            mcp_command: configSettings.mcpCommand
        }
    };
    
    const assistantMsgId = addMessageToUI('assistant', '', []);
    const contentDiv = document.getElementById(assistantMsgId).querySelector('.markdown-body');
    let fullResponse = "";

    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const err = await response.json();
            fullResponse = `<p class="text-red-500 font-bold">Error: ${err.detail || 'Request failed'}</p>`;
            contentDiv.innerHTML = fullResponse;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); 
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.type === 'token') {
                        fullResponse += data.content;
                        contentDiv.innerHTML = marked.parse(fullResponse);
                        scrollToBottom();
                    } else if (data.type === 'status') {
                        if (!document.getElementById('thinking-'+assistantMsgId)) {
                            contentDiv.innerHTML += `<p id="thinking-${assistantMsgId}" class="text-xs text-indigo-400 font-medium animate-pulse mt-2">🛠️ ${data.content}</p>`;
                         }
                        scrollToBottom();
                    } else if (data.type === 'tool_result') {
                        const el = document.getElementById('thinking-'+assistantMsgId);
                        if (el) el.remove();
                    } else if (data.type === 'error') {
                        fullResponse += `<p class="text-red-500 font-bold mt-2">⚠️ Stream Error: ${data.content}</p>`;
                        contentDiv.innerHTML = fullResponse;
                    }
                } catch (e) {}
            }
        }
    } catch (err) { 
        fullResponse = `<p class="text-red-500">Network Error: ${err.message}</p>`;
        contentDiv.innerHTML = fullResponse;
    } finally {
        await saveToHistory('assistant', fullResponse, [], assistantMsgId);
        document.getElementById('send-btn').disabled = document.getElementById('user-input').value.trim() === '' && currentFiles.length === 0;
    }
}

function addMessageToUI(role, text, files = []) {
    const container = document.getElementById('messages-container');
    const msgId = 'msg-' + Date.now();
    const isUser = role === 'user';

    const filesHtml = files.length ?
        `<div class="flex gap-2 mb-2 flex-wrap">` +
        files.map(f => {
            const src = (typeof f === 'object' && f instanceof File) ? URL.createObjectURL(f) : f;
            const fileType = (typeof f === 'object' && f instanceof File) ? f.type : '';

            if (src.startsWith('data:audio') || fileType.startsWith('audio/')) {
                return `<audio controls src="${src}" class="w-full"></audio>`;
            } else if (src.startsWith('data:image') || fileType.startsWith('image/')) {
                return `<img src="${src}" class="h-32 w-auto max-w-full object-contain rounded-xl border border-gray-200 dark:border-gray-600">`;
            } else {
                 return `<a href="${src}" target="_blank" class="text-indigo-400 hover:underline">Unsupported file type</a>`;
            }
        }).join('') + `</div>` : '';

    const html = `<div class="flex ${isUser ? 'justify-end' : 'justify-start'} w-full animate-in fade-in slide-in-from-bottom-2 duration-300" id="${msgId}">
        <div class="max-w-[85%] md:max-w-[75%] lg:max-w-[65%]">
            <div class="flex items-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : ''}">
                <div class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${isUser ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-800 text-white dark:bg-gray-600 dark:text-gray-200'}">${isUser ? 'YOU' : 'AI'}</div>
            </div>
            <div class="p-3.5 md:p-4 ${isUser ? 'bg-indigo-600 dark:bg-indigo-700 text-white rounded-2xl rounded-tr-none' : 'bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 shadow-sm rounded-2xl rounded-tl-none'}">
                ${filesHtml}<div class="markdown-body text-[16px] ${isUser ? '' : 'dark:text-gray-100'}">${isUser ? text.replace(/\n/g, '<br>') : marked.parse(text)}</div>
            </div>
        </div>
    </div>`;
    container.insertAdjacentHTML('beforeend', html);
    scrollToBottom();
    return msgId;
}

function scrollToBottom() { const c = document.getElementById('messages-container'); if (c) requestAnimationFrame(() => c.scrollTop = c.scrollHeight); }

async function saveToHistory(role, content, files = [], msgId) {
    if (!chatHistory[sessionId]) {
        chatHistory[sessionId] = { timestamp: Date.now(), title: '', messages: [] };
    }

    if (role === 'user') {
        // Only update the timestamp when the user sends a message
        chatHistory[sessionId].timestamp = Date.now();
    }

    let messageContent;
    if (role === 'user' && files.length > 0) {
        const fileDataURLs = await Promise.all(files.map(fileToDataURL));
        messageContent = [
            { type: "text", text: content },
            ...fileDataURLs.map((url, i) => {
                if (files[i].type.startsWith('image/')) {
                    return { type: "image_url", image_url: { url } };
                } else if (files[i].type.startsWith('audio/')) {
                    // Standard format for many backends; adjust if your specific API differs
                    return {
                        type: "input_audio", 
                        input_audio: { data: url.split(',')[1], format: "wav" } 
                    };
                }
                return null;
            }).filter(Boolean)
        ];
    } else {
        messageContent = content;
    }
    
    const message = { id: msgId, role, content: messageContent };

    const existingMsgIndex = chatHistory[sessionId].messages.findIndex(m => m.id === msgId);
    if (existingMsgIndex > -1) {
        chatHistory[sessionId].messages[existingMsgIndex] = message;
    } else {
        chatHistory[sessionId].messages.push(message);
    }

    try {
        await fetch('/history', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ history: chatHistory })
        });
    } catch (err) {
        console.error("⚠️ Failed to save chat history to server:", err);
    }
}

function getSessionMessages() {
    const session = chatHistory[sessionId];
    if (!session) return [];
    // Use structuredClone to deep-copy messages, ensuring the original array is not modified.
    return structuredClone(session.messages);
}
function renderSidebar() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    const sortedChats = Object.entries(chatHistory).sort((a, b) => b[1].timestamp - a[1].timestamp);
    
    sortedChats.forEach(([id, s]) => {
        if (!s.title) return;
        // update only if relevent - Improved contrast for dark mode inactive text
        const active = id === sessionId ? 'bg-gray-700 text-gray-500 dark:hover:bg-gray-700 dark:text-gray-300 hover:bg-gray-800/50' : 'hover:bg-gray-800/50 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-300';
        const buttonHtml = `
            <button onclick="loadSession('${id}')" class="w-full text-left p-3.5 rounded-xl text-sm truncate transition-all ${active}">
                <i class="ph ph-chat-centered-text mr-2"></i> 
                ${s.title}
            </button>
        `;
        list.insertAdjacentHTML('beforeend', buttonHtml);
    });

    // Scroll to the top of the list
    list.scrollTop = 0;
}

function loadSession(id) {
    sessionId = id;
    const container = document.getElementById('messages-container');
    
    container.querySelectorAll('img, audio').forEach(media => {
        if (media.src.startsWith('blob:')) {
            URL.revokeObjectURL(media.src);
        }
    });
    container.innerHTML = '';

    const emptyState = document.getElementById('empty-state');
    if(emptyState) emptyState.style.display = 'none';

    const session = chatHistory[id];
    if (session) {
        session.messages.forEach(m => {
            let text = '', files = [];
            if (Array.isArray(m.content)) {
                text = m.content.find(p => p.type === 'text')?.text || '';
                files = m.content.filter(p => p.type === 'image_url' || p.type === 'audio_url').map(p => (p.image_url || p.audio_url).url);
            } else {
                text = m.content;
            }
            addMessageToUI(m.role, text, files);
        });
    }
    
    // update only if relevent - Manually update active class in sidebar with higher dark mode contrast
    const historyButtons = document.querySelectorAll('#history-list button');
    historyButtons.forEach(btn => {
        if (btn.getAttribute('onclick') === `loadSession('${id}')`) {
            btn.classList.add('bg-gray-700', 'text-white');
            btn.classList.remove('hover:bg-gray-800/50', 'text-gray-500');
        } else {
            btn.classList.remove('bg-gray-700', 'text-white');
            btn.classList.add('hover:bg-gray-800/50', 'text-gray-500');
        }
    });
}

// --- UTILITY FUNCTIONS ---
function generateUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0, v=c=='x'?r:(r&0x3|0x8); return v.toString(16); }); }

function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    document.getElementById('send-btn').disabled = el.value.trim() === '' && currentFiles.length === 0;
}
function handleEnter(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        document.getElementById('mic-icon').classList.remove('text-red-500', 'animate-pulse');
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // 1. Let browser pick the best format
            mediaRecorder = new MediaRecorder(stream);
            
            // 2. IMMEDIATELY capture the mimeType (e.g., audio/webm;codecs=opus)
            recordedMimeType = mediaRecorder.mimeType; 
            
            mediaRecorder.start();
            audioChunks = [];
            document.getElementById('mic-icon').classList.add('text-red-500', 'animate-pulse');

            mediaRecorder.addEventListener('dataavailable', event => {
                if (event.data.size > 0) audioChunks.push(event.data);
            });

            mediaRecorder.addEventListener('stop', () => {
                // 3. Use the captured mimeType here
                audioBlob = new Blob(audioChunks, { type: recordedMimeType || 'audio/webm' });
                
                const audioUrl = URL.createObjectURL(audioBlob);
                const player = document.getElementById('audio-player');
                player.src = audioUrl;
                
                document.getElementById('user-input').classList.add('hidden');
                document.getElementById('audio-playback').classList.remove('hidden');
                
                // Stop all tracks to release the microphone
                stream.getTracks().forEach(track => track.stop());
            });
        } catch (err) {
            console.error("Error accessing microphone:", err);
            alert("Could not access microphone. Please ensure permissions are granted.");
        }
    }
}

function playAudio() {
    document.getElementById('audio-player').play();
}

async function sendAudio() {
    if (!audioBlob) return;
    
    // Determine extension based on mimeType
    console.log("Audio Blob Type:", audioBlob.type);
    const extension = audioBlob.type.includes('webm') ? 'webm' : 'ogg';
    const audioFile = new File([audioBlob], `recording.${extension}`, { type: audioBlob.type });
    
    currentFiles.push(audioFile);
    
    // MUST await this so currentFiles isn't cleared too early
    await sendMessage(); 
    cancelAudio();
}

function cancelAudio() {
    audioBlob = null;
    audioChunks = [];
    URL.revokeObjectURL(document.getElementById('audio-player').src);
    document.getElementById('audio-player').src = '';
    document.getElementById('user-input').classList.remove('hidden');
    document.getElementById('audio-playback').classList.add('hidden');
}

function handleFileSelect(event) {
    const files = event.target.files;
    if (!files) return;

    for (const file of files) {
        if (file.type.startsWith('image/') || file.type.startsWith('audio/')) {
            currentFiles.push(file);
        }
    }
    updateFilePreview();
    event.target.value = ''; // Reset to allow re-selecting the same file
}

function updateFilePreview() {
    const previewContainer = document.getElementById('file-preview');
    // Revoke previous object URLs to prevent memory leaks
    previewContainer.querySelectorAll('img, audio').forEach(media => {
        if (media.src.startsWith('blob:')) {
            URL.revokeObjectURL(media.src);
        }
    });
    previewContainer.innerHTML = '';

    if (currentFiles.length === 0) {
        previewContainer.classList.add('hidden');
        return;
    }
    
    previewContainer.classList.remove('hidden');
    currentFiles.forEach((file, index) => {
        let element;
        if (file.type.startsWith('image/')) {
            element = document.createElement('img');
            element.src = URL.createObjectURL(file);
            element.className = "h-20 w-auto object-contain rounded-lg border border-gray-300 bg-gray-100 dark:bg-gray-800 dark:border-gray-700";
        } else if (file.type.startsWith('audio/')) {
            element = document.createElement('audio');
            element.src = URL.createObjectURL(file);
            element.controls = true;
            element.className = "h-12 w-full";
        }

        const removeBtn = document.createElement('button');
        removeBtn.innerHTML = '&times;';
        removeBtn.className = "absolute top-0 right-0 bg-red-600 text-white rounded-full h-5 w-5 flex items-center justify-center text-xs font-bold";
        removeBtn.onclick = () => removeFile(index);

        const wrapper = document.createElement('div');
        wrapper.className = "relative flex-shrink-0";
        wrapper.appendChild(element);
        wrapper.appendChild(removeBtn);

        previewContainer.appendChild(wrapper);
    });
    document.getElementById('send-btn').disabled = document.getElementById('user-input').value.trim() === '' && currentFiles.length === 0;
}
function handleFileSelect(event) {
    const files = event.target.files;
    if (!files) return;

    for (const file of files) {
        if (file.type.startsWith('image/') || file.type.startsWith('audio/')) {
            currentFiles.push(file);
        }
    }
    updateFilePreview();
    event.target.value = ''; // Reset to allow re-selecting the same file
}

function updateFilePreview() {
    const previewContainer = document.getElementById('file-preview');
    // Revoke previous object URLs to prevent memory leaks
    previewContainer.querySelectorAll('img, audio').forEach(media => {
        if (media.src.startsWith('blob:')) {
            URL.revokeObjectURL(media.src);
        }
    });
    previewContainer.innerHTML = '';

    if (currentFiles.length === 0) {
        previewContainer.classList.add('hidden');
        return;
    }
    
    previewContainer.classList.remove('hidden');
    currentFiles.forEach((file, index) => {
        let element;
        if (file.type.startsWith('image/')) {
            element = document.createElement('img');
            element.src = URL.createObjectURL(file);
            element.className = "h-20 w-auto object-contain rounded-lg border border-gray-300 bg-gray-100 dark:bg-gray-800 dark:border-gray-700";
        } else if (file.type.startsWith('audio/')) {
            element = document.createElement('audio');
            element.src = URL.createObjectURL(file);
            element.controls = true;
            element.className = "h-12 w-full";
        }

        const removeBtn = document.createElement('button');
        removeBtn.innerHTML = '&times;';
        removeBtn.className = "absolute top-0 right-0 bg-red-600 text-white rounded-full h-5 w-5 flex items-center justify-center text-xs font-bold";
        removeBtn.onclick = () => removeFile(index);

        const wrapper = document.createElement('div');
        wrapper.className = "relative flex-shrink-0";
        wrapper.appendChild(element);
        wrapper.appendChild(removeBtn);

        previewContainer.appendChild(wrapper);
    });
    document.getElementById('send-btn').disabled = document.getElementById('user-input').value.trim() === '' && currentFiles.length === 0;
}

function removeFile(index) {
    currentFiles.splice(index, 1);
    updateFilePreview();
}

document.getElementById('user-input').addEventListener('paste', (event) => {
    const items = (event.clipboardData || event.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('audio/'))) {
            event.preventDefault();
            const file = item.getAsFile();
            currentFiles.push(file);
            updateFilePreview();
        }
    }
});