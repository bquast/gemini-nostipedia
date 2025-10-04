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
    // ... existing connectToRelays function ...
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
    // ... existing handleNostrEvent function ...
    if (type === 'EVENT') {
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
    }
}

/**
 * Subscribes to a set of filters on all connected relays.
 */
function subscribe(filters, subId) {
    // ... existing subscribe function ...
    if (!connected) {
        console.warn("Not connected to relays. Cannot subscribe.");
        return;
    }
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
    // ... existing simpleMarkdownToHtml function ...
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
// ... existing functions: fetchRecentArticles, fetchArticle, etc. ...
function fetchRecentArticles() { subscribe({ kinds: [ARTICLE_KIND], limit: 10 }, 'recent-articles'); }
function fetchArticle(eventId) { subscribe({ ids: [eventId], kinds: [ARTICLE_KIND], limit: 1 }, `article-${eventId}`); }
function searchArticles(query) { subscribe({ kinds: [ARTICLE_KIND], search: query, limit: 20 }, 'search-results'); }
function fetchArticleForPane(eventId, paneId) { const subId = `compare-${paneId}-${eventId}`; subscribe({ ids: [eventId], kinds: [ARTICLE_KIND], limit: 1 }, subId); }
function renderArticlePreview(event, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
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
    // ... existing search listeners ...
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
        alert("Please enter a valid relay URL starting with wss://");
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
        document.getElementById('load-pane-1').addEventListener('click', () => {
            const eventId = document.getElementById('input-pane-1').value;
            if (eventId) fetchArticleForPane(eventId, 'pane-1');
        });
        document.getElementById('load-pane-2').addEventListener('click', () => {
            const eventId = document.getElementById('input-pane-2').value;
            if (eventId) fetchArticleForPane(eventId, 'pane-2');
        });
    }
});

