/**
 * nostipedia.js
 * * Main client-side logic for Nostipedia.
 * Handles connections to Nostr relays, fetching articles,
 * and rendering content on the page.
 */

// --- Configuration ---

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nostr-pub.wellorder.net',
    'wss://relay.wikifreedia.xyz/',
];

const ARTICLE_KIND = 30818; // NIP-54: Wikipedia-style article

// --- State ---

let relays = [];
let pool = [];
let connected = false;
let receivedEvents = {}; // Track received events per subscription

// --- DOM Elements ---
const searchInput = document.getElementById('search-input');
const searchButton = document.getElementById('search-button');
const connectLink = document.getElementById('connect-link');
const settingsLink = document.getElementById('settings-link');
const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
const settingsCloseButton = document.getElementById('settings-close-button');
const relayList = document.getElementById('relay-list');
const addRelayInput = document.getElementById('add-relay-input');
const addRelayButton = document.getElementById('add-relay-button');


// --- NIP-19 Bech32 Decoding Utility ---
// A minimal bech32 decoder function to avoid external dependencies.
// Based on the BIP173 reference implementation.
const bech32 = (() => {
    const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const ALPHABET_MAP = {};
    for (let z = 0; z < ALPHABET.length; z++) {
        const x = ALPHABET.charAt(z);
        ALPHABET_MAP[x] = z;
    }
    function polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (let p = 0; p < values.length; ++p) {
            const top = chk >> 25;
            chk = (chk & 0x1ffffff) << 5 ^ values[p];
            for (let i = 0; i < 5; ++i) {
                if ((top >> i) & 1) {
                    chk ^= GEN[i];
                }
            }
        }
        return chk;
    }
    function HRPExpand(hrp) {
        const ret = [];
        let p;
        for (p = 0; p < hrp.length; ++p) {
            ret.push(hrp.charCodeAt(p) >> 5);
        }
        ret.push(0);
        for (p = 0; p < hrp.length; ++p) {
            ret.push(hrp.charCodeAt(p) & 31);
        }
        return ret;
    }
    function verifyChecksum(hrp, data) {
        return polymod(HRPExpand(hrp).concat(data)) === 1;
    }
    function fromWords(words) {
        const BITS_PER_BYTE = 8;
        const BITS_PER_WORD = 5;
        let res = '';
        let bits = 0;
        let value = 0;
        for(let i=0; i<words.length; ++i) {
            value = (value << BITS_PER_WORD) | words[i];
            bits += BITS_PER_WORD;
            while(bits >= BITS_PER_BYTE) {
                bits -= BITS_PER_BYTE;
                const b = (value >> bits) & 255;
                res += String.fromCharCode(b);
            }
        }
        return res;
    }
    function decode(str) {
        let p;
        let hasLower = false;
        let hasUpper = false;
        for (p = 0; p < str.length; ++p) {
            if (str.charCodeAt(p) < 33 || str.charCodeAt(p) > 126) {
                return null;
            }
            if (str.charCodeAt(p) >= 97 && str.charCodeAt(p) <= 122) {
                hasLower = true;
            }
            if (str.charCodeAt(p) >= 65 && str.charCodeAt(p) <= 90) {
                hasUpper = true;
            }
        }
        if (hasLower && hasUpper) {
            return null;
        }
        str = str.toLowerCase();
        const pos = str.lastIndexOf('1');
        if (pos < 1 || pos + 7 > str.length || str.length > 90) {
            return null;
        }
        const hrp = str.substring(0, pos);
        const data = [];
        for (p = pos + 1; p < str.length; ++p) {
            const d = ALPHABET_MAP[str.charAt(p)];
            if (d === undefined) {
                return null;
            }
            data.push(d);
        }
        if (!verifyChecksum(hrp, data)) {
            return null;
        }
        return { hrp: hrp, words: data.slice(0, data.length - 6) };
    }
    return { decode };
})();

/**
 * Parses a Nostr identifier (hex, note1, nevent1) and returns the event ID.
 * @param {string} identifier The string to parse.
 * @returns {string|null} The hex event ID or null if invalid.
 */
function parseNostrIdentifier(identifier) {
    identifier = identifier.trim();

    // Check if it's a raw hex ID
    if (/^[a-f0-9]{64}$/.test(identifier)) {
        return identifier;
    }

    // Check for bech32 format (note1, nevent1)
    if (identifier.startsWith('note1') || identifier.startsWith('nevent1')) {
        try {
            const decoded = bech32.decode(identifier);
            if (!decoded) return null;

            const data = new Uint8Array(decoded.words.map(w => w));
            
            if (decoded.hrp === 'nevent') {
                 // In nevent, the first TLV entry is the event ID (32 bytes)
                 const idBytes = data.slice(2, 34); // Skip type and length bytes
                 const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
                 return idHex;
            } else if (decoded.hrp === 'note') {
                const idBytes = data.slice(0, 32);
                return Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            }
            
        } catch (e) {
            console.error("Error decoding bech32 string:", e);
            return null;
        }
    }

    return null;
}


// --- Settings & Local Storage ---

function loadRelaysFromStorage() {
    const storedRelays = localStorage.getItem('nostipedia_relays');
    if (storedRelays) {
        relays = JSON.parse(storedRelays);
    } else {
        relays = [...DEFAULT_RELAYS];
    }
}

function saveRelaysToStorage() {
    localStorage.setItem('nostipedia_relays', JSON.stringify(relays));
}

// --- Core Functions ---

/**
 * Connects to the configured Nostr relays.
 */
function connectToRelays() {
    return new Promise((resolve) => {
        if (connected) {
            console.log("Disconnecting from old relays first...");
            pool.forEach(relay => relay.close());
            pool = [];
            connected = false;
        }

        console.log("Connecting to relays...", relays);
        if(connectLink) connectLink.textContent = "Connecting...";

        if (relays.length === 0) {
            console.warn("No relays configured.");
            if(connectLink) connectLink.textContent = "No Relays";
            return resolve();
        }

        relays.forEach(url => {
            try {
                const relay = new WebSocket(url);
                relay.onopen = () => {
                    console.log(`Connected to ${url}`);
                    pool.push(relay);
                    if (!connected) {
                        connected = true;
                        if(connectLink) connectLink.textContent = "Connected";
                        resolve();
                    }
                };
                relay.onmessage = (event) => {
                    const [type, subId, data] = JSON.parse(event.data);
                    handleNostrEvent(type, subId, data);
                };
                relay.onerror = (error) => console.error(`Error with ${url}:`, error);
                relay.onclose = () => {
                    console.log(`Connection closed from ${url}`);
                    pool = pool.filter(r => r.url !== url);
                    if (pool.length === 0) {
                        connected = false;
                        if(connectLink) connectLink.textContent = "Connect";
                    }
                };
            } catch (error) {
                console.error(`Failed to connect to ${url}`, error);
            }
        });
        setTimeout(() => resolve(), 3000); 
    });
}

/**
 * Handles incoming events from relays.
 */
function handleNostrEvent(type, subId, data) {
    if (type === 'EVENT') {
        if (!receivedEvents[subId]) {
            receivedEvents[subId] = 0;
        }
        receivedEvents[subId]++;

        console.log(`Received event for sub ${subId}:`, data);
        if (subId === 'recent-articles') {
             renderArticlePreview(data, 'recent-articles-container');
        } else if (subId.startsWith('article-')) {
            renderArticle(data);
        } else if (subId === 'search-results') {
            renderArticlePreview(data, 'search-results-container');
        } else if (subId.startsWith('compare-pane-1-')) {
            renderArticleInPane(data, 'pane-1-content');
        } else if (subId.startsWith('compare-pane-2-')) {
            renderArticleInPane(data, 'pane-2-content');
        }
    } else if (type === 'EOSE') {
        console.log(`Received EOSE for sub ${subId}`);
        // If a subscription ends and we haven't received any events for it, update the UI.
        if (!receivedEvents[subId]) {
             if (subId === 'recent-articles') {
                const container = document.getElementById('recent-articles-container');
                if (container) container.innerHTML = '<p>No recent articles found on the connected relays.</p>';
            } else if (subId === 'search-results') {
                const container = document.getElementById('search-results-container');
                if (container) container.innerHTML = '<p>No articles found matching your search.</p>';
            }
        }
    }
}

/**
 * Subscribes to a set of filters on all connected relays.
 */
function subscribe(filters, subId) {
    if (!connected) {
        console.warn("Not connected to relays. Cannot subscribe.");
        return;
    }
    // Reset the event counter for this subscription
    receivedEvents[subId] = 0;
    const req = ["REQ", subId, filters];
    console.log("Sending subscription:", req);
    pool.forEach(relay => {
        relay.send(JSON.stringify(req));
    });
}


/**
 * Simple Markdown to HTML converter.
 */
function simpleMarkdownToHtml(markdownText) {
    let html = markdownText
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^\* (.*$)/gim, '<ul><li>$1</li></ul>')
        .replace(/<\/ul>\n<ul>/g, '')
        .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        .split('\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('')
        .replace(/<p><h1>(.*?)<\/h1><\/p>/g, '<h1>$1</h1>')
        .replace(/<p><h2>(.*?)<\/h2><\/p>/g, '<h2>$1</h2>')
        .replace(/<p><h3>(.*?)<\/h3><\/p>/g, '<h3>$1</h3>')
        .replace(/<p><ul>(.*?)<\/ul><\/p>/g, '<ul>$1</ul>');
        
    return html;
}

// --- Page-specific Logic ---
function fetchRecentArticles() { subscribe({ kinds: [ARTICLE_KIND], limit: 10 }, 'recent-articles'); }
function fetchArticle(eventId) { 
    const hexId = parseNostrIdentifier(eventId);
    if (!hexId) {
         console.error("Invalid Nostr identifier provided:", eventId);
         document.getElementById('content').innerHTML = `<h1>Error: Invalid article ID format.</h1><p>Please use a valid hex, note1, or nevent1 identifier.</p>`;
         return;
    }
    subscribe({ ids: [hexId], kinds: [ARTICLE_KIND], limit: 1 }, `article-${hexId}`); 
}
function searchArticles(query) { subscribe({ kinds: [ARTICLE_KIND], search: query, limit: 20 }, 'search-results'); }
function fetchArticleForPane(eventId, paneId, inputElement) { 
    const hexId = parseNostrIdentifier(eventId);
    if (!hexId) {
        console.error("Invalid Nostr identifier for pane:", eventId);
        inputElement.value = '';
        inputElement.placeholder = 'Invalid ID. Try again.';
        return;
    }
    const subId = `compare-${paneId}-${hexId}`; 
    subscribe({ ids: [hexId], kinds: [ARTICLE_KIND], limit: 1 }, subId); 
}
function renderArticlePreview(event, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // If this is the first event for this container, clear the "Loading..." message.
    if (receivedEvents[containerId.replace('-container','s')] === 1) {
        container.innerHTML = '';
    }

    const titleTag = event.tags.find(tag => tag[0] === 'd');
    const title = titleTag ? titleTag[1] : 'Untitled Article';
    const summaryTag = event.tags.find(tag => tag[0] === 'summary');
    const summary = summaryTag ? summaryTag[1] : event.content.substring(0, 150) + '...';
    const articleLink = `/article.html?id=${event.id}`;
    const articleDiv = document.createElement('div');
    articleDiv.className = 'article-preview';
    articleDiv.innerHTML = `<h3><a href="${articleLink}">${title}</a></h3><p>${summary}</p><small>by: ${event.pubkey.substring(0, 10)}... | id: <a href="${articleLink}">${event.id.substring(0, 10)}...</a></small><hr>`;
    container.appendChild(articleDiv);
}
function renderArticle(event) {
    const titleEl = document.getElementById('article-title');
    const authorEl = document.getElementById('article-author');
    const dateEl = document.getElementById('article-date');
    const contentEl = document.getElementById('article-content');
    if (!titleEl || !contentEl) return;
    const titleTag = event.tags.find(tag => tag[0] === 'd');
    titleEl.textContent = titleTag ? titleTag[1] : 'Untitled Article';
    authorEl.textContent = event.pubkey;
    dateEl.textContent = new Date(event.created_at * 1000).toLocaleString();
    contentEl.innerHTML = simpleMarkdownToHtml(event.content);
}
function renderArticleInPane(event, paneContentId) {
    const contentEl = document.getElementById(paneContentId);
    if (!contentEl) return;
    const titleTag = event.tags.find(tag => tag[0] === 'd');
    const title = titleTag ? titleTag[1] : 'Untitled Article';
    let html = `<h2>${title}</h2>`;
    html += `<p><small>Author: ${event.pubkey}<br>Date: ${new Date(event.created_at * 1000).toLocaleString()}</small></p><hr>`;
    html += simpleMarkdownToHtml(event.content);
    contentEl.innerHTML = html;
}

// --- Settings Modal Logic ---

function openSettingsModal() {
    populateRelayList();
    settingsModalBackdrop.style.display = 'block';
}

function closeSettingsModal() {
    settingsModalBackdrop.style.display = 'none';
}

function populateRelayList() {
    relayList.innerHTML = '';
    relays.forEach((relayUrl, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${relayUrl}</span><span class="remove-relay" data-index="${index}">&times;</span>`;
        relayList.appendChild(li);
    });
}

// --- Event Listeners & Page Initialization ---

if (connectLink) {
    connectLink.addEventListener('click', (e) => {
        e.preventDefault();
        connectToRelays();
    });
}

if (searchButton) {
    searchButton.addEventListener('click', () => {
        const query = searchInput.value;
        if (query) {
            window.location.href = `/search.html?q=${encodeURIComponent(query)}`;
        }
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            searchButton.click();
        }
    });
}

// Settings Modal Listeners
settingsLink.addEventListener('click', openSettingsModal);
settingsCloseButton.addEventListener('click', closeSettingsModal);
settingsModalBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsModalBackdrop) {
        closeSettingsModal();
    }
});
addRelayButton.addEventListener('click', () => {
    const newRelay = addRelayInput.value.trim();
    if (newRelay && newRelay.startsWith('wss://')) {
        if (!relays.includes(newRelay)) {
            relays.push(newRelay);
            saveRelaysToStorage();
            populateRelayList();
        }
        addRelayInput.value = '';
    } else {
        addRelayInput.value = '';
        addRelayInput.placeholder = 'Invalid URL. Must start with wss://';
    }
});
relayList.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-relay')) {
        const indexToRemove = parseInt(e.target.dataset.index, 10);
        relays.splice(indexToRemove, 1);
        saveRelaysToStorage();
        populateRelayList();
    }
});


// --- Router: Initialize page based on URL ---
window.addEventListener('load', async () => {
    loadRelaysFromStorage();
    await connectToRelays();
    
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);

    if (path.endsWith('/') || path.endsWith('/index.html')) {
        fetchRecentArticles();
    } else if (path.endsWith('/recent.html')) {
        fetchRecentArticles();
    } else if (path.endsWith('/article.html')) {
        const articleId = params.get('id');
        if (articleId) {
            fetchArticle(articleId);
        } else {
            document.getElementById('content').innerHTML = '<h1>Error: No article ID provided.</h1>';
        }
    } else if (path.endsWith('/search.html')) {
        const query = params.get('q');
        document.getElementById('search-query-display').textContent = query;
        if(query) {
            searchArticles(query);
        }
    } else if (path.endsWith('/compare.html')) {
        const inputPane1 = document.getElementById('input-pane-1');
        const inputPane2 = document.getElementById('input-pane-2');
        document.getElementById('load-pane-1').addEventListener('click', () => {
            const eventId = inputPane1.value;
            if (eventId) fetchArticleForPane(eventId, 'pane-1', inputPane1);
        });
        document.getElementById('load-pane-2').addEventListener('click', () => {
            const eventId = inputPane2.value;
            if (eventId) fetchArticleForPane(eventId, 'pane-2', inputPane2);
        });
    }
});

