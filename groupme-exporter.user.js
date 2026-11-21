// ==UserScript==
// @name         GroupMe Chat Exporter
// @namespace    http://tampermonkey.net/
// @version      1
// @author       ZackDaQuack
// @description  Export GroupMe chats to JSON, CSV, or offline HTML with optional ZIP media archiving.
// @license      MIT
// @match        https://web.groupme.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      i.groupme.com
// @connect      m.groupme.com
// @connect      v.groupme.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const DOWNLOAD_CONCURRENCY = 8;
    const MEDIA_TYPES = new Set(['image', 'linked_image', 'video', 'file']);

    let activeGroupId = null;
    let isExporting = false;
    let lastPerfIdx = 0;
    let lastUIState = '';

    // ---------------------------------------------------------------
    // 1. Token
    // ---------------------------------------------------------------
    function getToken() {
        let raw = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
        if (!raw) {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.toLowerCase().includes('access_token')) {
                    raw = localStorage.getItem(key);
                    break;
                }
            }
        }
        if (!raw) {
            const m = document.cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
            if (m) raw = decodeURIComponent(m[1]);
        }
        return raw ? raw.replace(/^"+|"+$/g, '').trim() : null;
    }

    // ---------------------------------------------------------------
    // 2. Group ID tracking
    // ---------------------------------------------------------------
    function extractGroupIdFromStr(str) {
        if (!str || typeof str !== 'string') return null;
        const m = str.match(/\/(?:groups|chats)\/(\d{5,})/);
        return m ? m[1] : null;
    }

    function setGroupId(id) {
        if (id && id !== activeGroupId) {
            activeGroupId = id;
            updateUI();
        }
    }

    function detectGroupId() {
        const fromUrl = extractGroupIdFromStr(window.location.href);
        if (fromUrl) {
            setGroupId(fromUrl);
        } else {
            // Only scan network entries added since the last scan
            const entries = performance.getEntriesByType('resource');
            for (let i = entries.length - 1; i >= lastPerfIdx; i--) {
                const found = extractGroupIdFromStr(entries[i].name);
                if (found) { setGroupId(found); break; }
            }
            lastPerfIdx = entries.length;
        }
        updateUI();
    }

    const origFetch = pageWin.fetch.bind(pageWin);
    pageWin.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        setGroupId(extractGroupIdFromStr(url));
        return origFetch(...args);
    };

    const origOpen = pageWin.XMLHttpRequest.prototype.open;
    pageWin.XMLHttpRequest.prototype.open = function (method, url) {
        setGroupId(extractGroupIdFromStr(url));
        return origOpen.apply(this, arguments);
    };

    setInterval(detectGroupId, 1500);

    // ---------------------------------------------------------------
    // 3. Network helpers
    // ---------------------------------------------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // NOTE: no auth header is sent to media hosts (they're public CDN URLs,
    // and we don't want to leak the token to arbitrary domains).
    // Sends the access token ONLY to GroupMe's own hosts, and only when asked to.
    function authHeaders(url, token) {
        try {
            const host = new URL(url).hostname;
            if (token && (host === 'groupme.com' || host.endsWith('.groupme.com'))) {
                return { 'x-access-token': token };
            }
        } catch { /* ignore */ }
        return {};
    }

    function fetchBinary(url, timeout = 30000, token = null) {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: authHeaders(url, token),
                                  responseType: 'arraybuffer',
                                  timeout,
                                  onload: (res) => resolve(res.status >= 200 && res.status < 300 && res.response ? res.response : null),
                                  onerror: () => resolve(null),
                                  ontimeout: () => resolve(null),
                                  onabort: () => resolve(null)
                });
            } catch {
                resolve(null);
            }
        });
    }

    // ---- Minimal dependency-free ZIP writer (STORE, no compression) ----
    // Got Claude to write this. Kept struggling with zipping the file so it opted to embed it lmao
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // ---- Streaming ZIP64 writer (STORE) ----
    // Files are written to the sink as they finish downloading, so memory use stays
    // flat no matter how large the archive gets. Supports >4 GB and >65k entries.
    const U32MAX = 0xFFFFFFFF;

    class ZipWriter {
        constructor(sink) {
            this.sink = sink;
            this.offset = 0;
            this.entries = [];
            this.chain = Promise.resolve();
            this.enc = new TextEncoder();
            const d = new Date();
            this.dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
            this.dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        }

        async _write(chunk) {
            await this.sink.write(chunk);
            this.offset += chunk.length;
        }

        // Serialized so concurrent download workers can't interleave writes.
        addFile(name, data, crc) {
            const run = async () => {
                const size = data.length;
                if (size >= U32MAX) throw new Error(`File too large for a single entry: ${name}`);
                const nameBytes = this.enc.encode(name);
                const hdr = new Uint8Array(30 + nameBytes.length);
                const dv = new DataView(hdr.buffer);
                dv.setUint32(0, 0x04034b50, true);
                dv.setUint16(4, 20, true);
                dv.setUint16(6, 0x0800, true);      // UTF-8 names
                dv.setUint16(8, 0, true);           // STORE
                dv.setUint16(10, this.dosTime, true);
                dv.setUint16(12, this.dosDate, true);
                dv.setUint32(14, crc, true);
                dv.setUint32(18, size, true);
                dv.setUint32(22, size, true);
                dv.setUint16(26, nameBytes.length, true);
                dv.setUint16(28, 0, true);
                hdr.set(nameBytes, 30);

                this.entries.push({ nameBytes, crc, size, offset: this.offset });
                await this._write(hdr);
                await this._write(data);
            };
            this.chain = this.chain.then(run);
            return this.chain;
        }

        addText(name, text) {
            const b = this.enc.encode(text);
            return this.addFile(name, b, crc32(b));
        }

        async finish() {
            await this.chain;
            const cdStart = this.offset;
            let batch = [];
            let batchLen = 0;
            const flush = async () => {
                if (!batchLen) return;
                const buf = new Uint8Array(batchLen);
                let o = 0;
                for (const b of batch) { buf.set(b, o); o += b.length; }
                batch = []; batchLen = 0;
                await this._write(buf);
            };

            for (const e of this.entries) {
                const needsZip64 = e.offset >= U32MAX;
                const extraLen = needsZip64 ? 12 : 0;
                const rec = new Uint8Array(46 + e.nameBytes.length + extraLen);
                const dv = new DataView(rec.buffer);
                dv.setUint32(0, 0x02014b50, true);
                dv.setUint16(4, needsZip64 ? 45 : 20, true);
                dv.setUint16(6, needsZip64 ? 45 : 20, true);
                dv.setUint16(8, 0x0800, true);
                dv.setUint16(10, 0, true);
                dv.setUint16(12, this.dosTime, true);
                dv.setUint16(14, this.dosDate, true);
                dv.setUint32(16, e.crc, true);
                dv.setUint32(20, e.size, true);
                dv.setUint32(24, e.size, true);
                dv.setUint16(28, e.nameBytes.length, true);
                dv.setUint16(30, extraLen, true);
                dv.setUint32(42, needsZip64 ? U32MAX : e.offset, true);
                rec.set(e.nameBytes, 46);
                if (needsZip64) {
                    const x = 46 + e.nameBytes.length;
                    dv.setUint16(x, 0x0001, true);
                    dv.setUint16(x + 2, 8, true);
                    dv.setBigUint64(x + 4, BigInt(e.offset), true);
                }
                batch.push(rec);
                batchLen += rec.length;
                if (batchLen >= 512 * 1024) await flush();
            }
            await flush();

            const cdSize = this.offset - cdStart;
            const count = this.entries.length;
            const needZip64End = count >= 0xFFFF || cdStart >= U32MAX || cdSize >= U32MAX;

            if (needZip64End) {
                const z64Offset = this.offset;
                const rec = new DataView(new ArrayBuffer(56 + 20));
                rec.setUint32(0, 0x06064b50, true);
                rec.setBigUint64(4, 44n, true);
                rec.setUint16(12, 45, true);
                rec.setUint16(14, 45, true);
                rec.setUint32(16, 0, true);
                rec.setUint32(20, 0, true);
                rec.setBigUint64(24, BigInt(count), true);
                rec.setBigUint64(32, BigInt(count), true);
                rec.setBigUint64(40, BigInt(cdSize), true);
                rec.setBigUint64(48, BigInt(cdStart), true);
                rec.setUint32(56, 0x07064b50, true);          // locator
                rec.setUint32(60, 0, true);
                rec.setBigUint64(64, BigInt(z64Offset), true);
                rec.setUint32(72, 1, true);
                await this._write(new Uint8Array(rec.buffer));
            }

            const end = new DataView(new ArrayBuffer(22));
            end.setUint32(0, 0x06054b50, true);
            end.setUint16(8, needZip64End ? 0xFFFF : count, true);
            end.setUint16(10, needZip64End ? 0xFFFF : count, true);
            end.setUint32(12, needZip64End ? U32MAX : cdSize, true);
            end.setUint32(16, needZip64End ? U32MAX : cdStart, true);
            await this._write(new Uint8Array(end.buffer));

            return this.sink.close(); // Blob for the in-memory fallback, undefined for disk sink
        }

        async abort() {
            try { await this.sink.abort(); } catch { /* ignore */ }
        }
    }

    // Disk sink: streams straight to a user-chosen file (Chrome/Edge). Must be created
    // from a click handler (needs user activation) - see exportChat.
    async function createDiskSink(suggestedName) {
        const handle = await pageWin.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
        });
        const writable = await handle.createWritable();
        return {
            kind: 'disk',
            write: (chunk) => writable.write(chunk),
 close: async () => { await writable.close(); },
 abort: () => writable.abort()
        };
    }

    // Fallback (Firefox/Safari): accumulates in memory, so practical limit is RAM.
    function createMemorySink() {
        const parts = [];
        return {
            kind: 'memory',
            write: async (chunk) => { parts.push(chunk); },
 close: async () => new Blob(parts, { type: 'application/zip' }),
 abort: async () => { parts.length = 0; }
        };
    }

    async function runPool(items, limit, worker) {
        let next = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const idx = next++;
                if (idx >= items.length) return;
                await worker(items[idx], idx);
            }
        });
        await Promise.all(runners);
    }

    function sanitizeFilename(url, prefix = '', defaultExt = '.jpg') {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            let name = parts.slice(-2).join('_') || 'file';
            name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += defaultExt;
            return prefix ? `${prefix}_${name}` : name;
        } catch {
            return `${prefix || 'file'}_${Date.now()}.bin`;
        }
    }

    const API_HEADERS = (token) => ({
        'Accept': 'application/json',
        'x-access-token': token,
        'x-requested-with': 'GroupMeWeb/1.2.3'
    });

    async function fetchGroupMetadata(groupId, token) {
        const res = await origFetch(`https://api.groupme.com/v3/groups/${groupId}`, { headers: API_HEADERS(token) });
        if (!res.ok) return null;
        const json = await res.json();
        return json.response || null;
    }

    // ---------------------------------------------------------------
    // 4. Main export pipeline
    // ---------------------------------------------------------------
    async function exportChat(format) {
        if (isExporting) return;

        const token = getToken();
        const manualId = document.getElementById('gm-manual-gid')?.value.trim();
        const targetGroupId = manualId || activeGroupId;

        if (!token) { alert('Could not find "access_token". Ensure you are logged in.'); return; }
        if (!targetGroupId) { alert('No Group ID detected. Click into a chat or paste the Group ID into the box.'); return; }

        const includeMedia = document.getElementById('gm-chk-media')?.checked || false;
        const includeVideos = document.getElementById('gm-chk-video')?.checked || false;
        isExporting = true;
        setButtonsDisabled(true);

        const statusEl = document.getElementById('gm-osint-status');
        const setStatus = (t) => { statusEl.textContent = t; };
        const allMessages = [];
        let beforeId = null;
        let totalCount = '?';
        let zipWriter = null;
        let usingDisk = false;
        const zipNameHint = `groupme_${targetGroupId}_${new Date().toISOString().slice(0, 10)}.zip`;

        try {
            // Must happen first, directly inside the click's user activation.
            if (includeMedia) {
                if (typeof pageWin.showSaveFilePicker === 'function') {
                    try {
                        zipWriter = new ZipWriter(await createDiskSink(zipNameHint));
                        usingDisk = true;
                    } catch (e) {
                        if (e?.name === 'AbortError') throw new Error('Save cancelled.');
                        console.warn('[GM EXPORTER] Disk sink unavailable, using memory:', e);
                    }
                }
                if (!zipWriter) {
                    zipWriter = new ZipWriter(createMemorySink());
                    setStatus('No streaming support: ZIP is built in RAM (use Chrome/Edge for >2 GB).');
                    await sleep(1500);
                }
            }

            setStatus('Fetching group roster & metadata...');
            const groupInfo = await fetchGroupMetadata(targetGroupId, token);

            // ---- Paginate messages ----
            while (true) {
                let apiUrl = `https://api.groupme.com/v3/groups/${targetGroupId}/messages?acceptFiles=1&limit=100`;
                if (beforeId) apiUrl += `&before_id=${beforeId}`;

                const res = await origFetch(apiUrl, { headers: API_HEADERS(token) });
                if (res.status === 304) break;
                if (res.status === 429) { setStatus('Rate limited, waiting...'); await sleep(3000); continue; }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const data = await res.json();
                const batch = data?.response?.messages || [];
                if (data?.response?.count) totalCount = data.response.count;
                if (batch.length === 0) break;

                for (const m of batch) allMessages.push(m);
                beforeId = batch[batch.length - 1].id;
                setStatus(`Fetched ${allMessages.length} / ${totalCount} msgs...`);
                await sleep(100);
            }

            allMessages.reverse(); // Oldest -> Newest

            // ---- GroupMe emoji packs ----
            emojiMap = new Map();
            try {
                emojiMap = await resolveEmojiPacks(allMessages, format === 'html' || !!zipWriter, setStatus, token);
            } catch (e) {
                console.warn('[GM EXPORTER] emoji resolution failed', e);
            }
            if (emojiMap.size) {
                for (const m of allMessages) {
                    const info = getEmojiSlots(m);
                    if (!info) continue;
                    m.emoji_resolved = info.slots.map(([p, i]) => {
                        const e = emojiMap.get(emojiKey(p, i));
                        return { pack: p, index: i, label: e?.label || null, file: zipWriter && e?.bytes ? `./${e.path}` : null };
                    });
                }
                if (zipWriter) {
                    for (const e of emojiMap.values()) {
                        if (e.bytes) await zipWriter.addFile(e.path, e.bytes, crc32(e.bytes));
                    }
                }
            }

            const failedDownloads = [];

            // ---- Media archiving (parallel) ----
            if (includeMedia) {
                const targets = new Map();   // remoteUrl -> zipPath
                const usedPaths = new Set();

                const addTarget = (url, prefix, folder, ext = '.jpg') => {
                    if (!url || targets.has(url)) return;
                    let p = `${folder}/${sanitizeFilename(url, prefix, ext)}`;
                    while (usedPaths.has(p)) p = p.replace(/(\.[^.]+)?$/, `_${usedPaths.size}$1`);
                    usedPaths.add(p);
                    targets.set(url, p);
                };

                for (const m of allMessages) {
                    addTarget(m.avatar_url, `user_${m.user_id}`, 'avatars');
                    for (const att of (m.attachments || [])) {
                        if (!MEDIA_TYPES.has(att.type)) continue;
                        const remote = att.url || att.source_url;
                        if (!remote) continue;
                        if (att.type === 'video') {
                            if (includeVideos) addTarget(remote, `msg_${m.id}`, 'attachments', '.mp4');
                        } else {
                            addTarget(remote, `msg_${m.id}`, 'attachments');
                        }
                    }
                }
                addTarget(groupInfo?.image_url, 'group_cover', 'avatars');
                for (const mem of (groupInfo?.members || [])) {
                    addTarget(mem.image_url, `member_${mem.user_id}`, 'avatars');
                }

                const list = Array.from(targets.entries());
                const urlToLocalPath = new Map();
                let done = 0;

                await runPool(list, DOWNLOAD_CONCURRENCY, async ([remoteUrl, zipPath]) => {
                    const isVideo = zipPath.endsWith('.mp4');
                    const buf = await fetchBinary(remoteUrl, isVideo ? 120000 : 30000);
                    let ok = false;
                    if (buf) {
                        const bytes = new Uint8Array(buf);
                        try {
                            // Written to disk immediately; the buffer is then free to be GC'd.
                            await zipWriter.addFile(zipPath, bytes, crc32(bytes));
                            urlToLocalPath.set(remoteUrl, `./${zipPath}`);
                            ok = true;
                        } catch (e) {
                            if (usingDisk) throw e; // disk/IO error: abort the whole export
                            failedDownloads.push(remoteUrl);
                        }
                    }
                    if (!ok && !failedDownloads.includes(remoteUrl)) failedDownloads.push(remoteUrl);
                    done++;
                    setStatus(`Downloading media ${done} / ${list.length}${failedDownloads.length ? ` (${failedDownloads.length} failed)` : ''}...`);
                });

                // Rewrite paths in place (no deep clone needed)
                for (const m of allMessages) {
                    if (m.avatar_url && urlToLocalPath.has(m.avatar_url)) {
                        m.original_avatar_url = m.avatar_url;
                        m.avatar_url = urlToLocalPath.get(m.avatar_url);
                    }
                    if (Array.isArray(m.attachments)) {
                        for (const att of m.attachments) {
                            const remote = att.url || att.source_url;
                            if (remote && urlToLocalPath.has(remote)) {
                                att.original_url = remote;
                                att.url = urlToLocalPath.get(remote);
                            }
                        }
                    }
                }
            }

            setStatus('Building export file...');
            await sleep(0); // let the UI repaint

            const userMap = buildUserDirectory(allMessages, groupInfo);
            const msgMap = new Map(allMessages.map(m => [m.id, m]));

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const safeName = (groupInfo?.name || `group_${targetGroupId}`).replace(/[^a-z0-9_-]/gi, '_');
            const baseFilename = `${safeName}_${targetGroupId}_${timestamp}`;

            let mainContent = '';
            let mimeType = 'text/plain;charset=utf-8;';

            if (format === 'json') {
                mainContent = JSON.stringify({
                    exported_at: new Date().toISOString(),
                                             group_id: targetGroupId,
                                             group_metadata: groupInfo,
                                             resolved_user_directory: Object.fromEntries(userMap),
                                             total_messages_exported: allMessages.length,
                                             messages: allMessages
                }, null, 2);
                mimeType = 'application/json';
            } else if (format === 'csv') {
                mainContent = '\uFEFF' + convertToCSV(allMessages, userMap);
                mimeType = 'text/csv;charset=utf-8;';
            } else if (format === 'html') {
                mainContent = buildHTMLReport(allMessages, groupInfo, userMap, msgMap, targetGroupId);
                mimeType = 'text/html;charset=utf-8;';
            }

            if (zipWriter) {
                await zipWriter.addText(`${baseFilename}.${format}`, mainContent);
                if (groupInfo?.members) {
                    await zipWriter.addText(`${baseFilename}_roster.csv`, convertRosterToCSV(groupInfo.members, userMap));
                }
                if (failedDownloads.length) {
                    await zipWriter.addText('_failed_downloads.txt', failedDownloads.join('\n'));
                }

                setStatus('Finalizing ZIP...');
                const result = await zipWriter.finish();
                zipWriter = null;
                if (result instanceof Blob) triggerDownload(result, `${baseFilename}.zip`);
            } else {
                triggerDownload(new Blob([mainContent], { type: mimeType }), `${baseFilename}.${format}`);
            }

            setStatus(`Done! Exported ${allMessages.length} msgs.` +
            (failedDownloads.length ? ` (${failedDownloads.length} media failed, see _failed_downloads.txt)` : ''));
        } catch (err) {
            console.error('[GM EXPORTER]', err);
            if (zipWriter) await zipWriter.abort(); // discards the partial file
            setStatus(`Error: ${err.message}`);
        } finally {
            isExporting = false;
            setButtonsDisabled(false);
        }
    }

    function setButtonsDisabled(disabled) {
        for (const id of ['gm-btn-json', 'gm-btn-csv', 'gm-btn-html']) {
            const b = document.getElementById(id);
            if (b) { b.disabled = disabled; b.style.opacity = disabled ? '0.5' : '1'; }
        }
    }

    // ---------------------------------------------------------------
    // 5. OSINT directory & client fingerprinting
    // ---------------------------------------------------------------
    function inferClientOS(guid) {
        if (!guid) return 'unknown';
        if (guid.startsWith('android-')) return 'Android';
        if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(guid)) return 'iOS/Apple';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) return 'Web/Other';
        return 'System/Bot';
    }

    function buildUserDirectory(messages, groupInfo) {
        const dir = new Map();

        if (groupInfo?.members) {
            for (const mem of groupInfo.members) {
                dir.set(String(mem.user_id), {
                    user_id: String(mem.user_id),
                        member_id: String(mem.id || ''),
                        current_nickname: mem.nickname || mem.name || '',
                        account_name: mem.name || '',
                        roles: (mem.roles || []).join('|'),
                        muted: mem.muted ?? false,
                        autokicked: mem.autokicked ?? false,
                        aliases_seen: new Set(mem.nickname ? [mem.nickname] : []),
                        devices_seen: new Set(),
                        msg_count: 0
                });
            }
        }

        for (const m of messages) {
            const uid = String(m.user_id);
            let entry = dir.get(uid);
            if (!entry) {
                entry = {
                    user_id: uid,
                    member_id: '',
                    current_nickname: m.name || '',
                    account_name: m.name || '',
                    roles: 'former_or_system',
                    muted: '',
                    autokicked: '',
                    aliases_seen: new Set(),
 devices_seen: new Set(),
 msg_count: 0
                };
                dir.set(uid, entry);
            }
            if (m.name) entry.aliases_seen.add(m.name);
            entry.devices_seen.add(inferClientOS(m.source_guid));
            entry.msg_count++;
        }

        for (const v of dir.values()) {
            v.aliases_seen = Array.from(v.aliases_seen);
            v.devices_seen = Array.from(v.devices_seen);
        }
        return dir;
    }

    // ---------------------------------------------------------------
    // 6. CSV builders
    // ---------------------------------------------------------------
    function escapeCSV(val, forceText = false) {
        if (val === null || val === undefined || val === '') return '""';
        const str = String(val).replace(/"/g, '""');
        return forceText ? `"=""${str}"""` : `"${str}"`;
    }

    function convertRosterToCSV(members, userMap) {
        const rows = [['user_id', 'member_record_id', 'account_name', 'current_nickname', 'aliases_in_chat', 'devices_seen', 'msg_count', 'roles', 'autokicked', 'muted', 'avatar_url'].join(',')];
        for (const mem of members) {
            const info = userMap.get(String(mem.user_id));
            rows.push([
                escapeCSV(mem.user_id, true),
                      escapeCSV(mem.id, true),
                      escapeCSV(mem.name),
                      escapeCSV(mem.nickname),
                      escapeCSV(info ? info.aliases_seen.join('; ') : ''),
                      escapeCSV(info ? info.devices_seen.join('; ') : ''),
                      escapeCSV(info ? info.msg_count : 0),
                      escapeCSV((mem.roles || []).join('; ')),
                      escapeCSV(mem.autokicked),
                      escapeCSV(mem.muted),
                      escapeCSV(mem.image_url)
            ].join(','));
        }
        return rows.join('\n');
    }

    function convertToCSV(messages, userMap) {
        const rows = [[
            'message_id', 'unix_timestamp', 'iso_utc_time', 'local_time', 'user_id', 'sender_type',
            'display_name', 'account_name', 'inferred_client', 'platform', 'source_guid',
            'content_revision', 'updated_at', 'system_event', 'text', 'attachment_types',
            'attachment_paths_or_urls', 'location_lat_lng', 'reply_to_msg_id', 'reply_to_user_id',
            'favorited_by_ids', 'reactions_summary', 'pinned_by', 'avatar_path_or_url'
        ].join(',')];

        for (const m of messages) {
            const atts = m.attachments || [];
            const attTypes = atts.map(a => a.type).join('; ');
            const attUrls = atts.map(a => a.url || a.source_url || '').filter(Boolean).join('; ');
            const locAtt = atts.find(a => a.type === 'location');
            const locStr = locAtt ? `${locAtt.lat},${locAtt.lng} (${locAtt.name || ''})` : '';
            const replyAtt = atts.find(a => a.type === 'reply');
            const reactions = (m.reactions || [])
            .map(r => `${r.code || r.type}:[${(r.user_ids || []).join('|')}]`)
            .join('; ');
            const dt = new Date(m.created_at * 1000);
            const userDirEntry = userMap.get(String(m.user_id));

            rows.push([
                escapeCSV(m.id, true),
                      escapeCSV(m.created_at),
                      escapeCSV(dt.toISOString()),
                      escapeCSV(dt.toLocaleString()),
                      escapeCSV(m.user_id, true),
                      escapeCSV(m.sender_type),
                      escapeCSV(m.name),
                      escapeCSV(userDirEntry?.account_name || m.name),
                      escapeCSV(inferClientOS(m.source_guid)),
                      escapeCSV(m.platform || ''),
                      escapeCSV(m.source_guid),
                      escapeCSV(m.content_revision || ''),
                      escapeCSV(m.updated_at ? new Date(m.updated_at * 1000).toISOString() : ''),
                      escapeCSV(m.system ? (m.event?.type || 'true') : 'false'),
                      escapeCSV(csvText(m)),
                      escapeCSV(attTypes),
                      escapeCSV(attUrls),
                      escapeCSV(locStr),
                      escapeCSV(replyAtt?.reply_id || '', true),
                      escapeCSV(replyAtt?.user_id || '', true),
                      escapeCSV((m.favorited_by || []).join('; ')),
                      escapeCSV(reactions),
                      escapeCSV(m.pinned_by || '', true),
                      escapeCSV(m.avatar_url || '')
            ].join(','));
        }
        return rows.join('\n');
    }

    // ---------------------------------------------------------------
    // 7. Offline HTML report
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // GroupMe emoji packs ("powerups")
    // Message text holds a U+FFFD placeholder; the real emoji is a [pack, index]
    // pair in an `emoji` attachment's charmap. Images come from sprite sheets.
    // ---------------------------------------------------------------
    let emojiMap = new Map(); // "pack-index" -> { pack, index, label, path, bytes, dataUri }
    const emojiKey = (p, i) => `${p}-${i}`;

    function getEmojiSlots(m) {
        let ph = null;
        const slots = [];
        for (const att of (m.attachments || [])) {
            if (att.type === 'emoji' && Array.isArray(att.charmap)) {
                ph = ph || att.placeholder || '\uFFFD';
                for (const c of att.charmap) slots.push(c);
            }
        }
        return ph ? { ph, slots } : null;
    }

    // Splits message text into [{text}] / [{emoji:[pack,index]}] segments.
    // The k-th placeholder in the text maps to the k-th charmap entry.
    function emojiSegments(m) {
        const info = getEmojiSlots(m);
        const text = m.text || '';
        if (!info || !text) return null;
        const segs = [];
        let i = 0, k = 0;
        while (true) {
            const j = text.indexOf(info.ph, i);
            if (j < 0) { if (i < text.length) segs.push({ text: text.slice(i) }); break; }
            if (j > i) segs.push({ text: text.slice(i, j) });
            const slot = info.slots[k++];
            segs.push(slot ? { emoji: [slot[0], slot[1]] } : { text: info.ph });
            i = j + info.ph.length;
        }
        return segs;
    }

    function emojiLabel(p, i) {
        const e = emojiMap.get(emojiKey(p, i));
        return `[emoji p${p}#${i}${e?.label ? ': ' + e.label : ''}]`;
    }

    function csvText(m) {
        const segs = emojiSegments(m);
        if (!segs) return m.text || '';
        return segs.map(s => s.emoji ? emojiLabel(s.emoji[0], s.emoji[1]) : s.text).join('');
    }

    function emojiHtml(p, i) {
        const e = emojiMap.get(emojiKey(p, i));
        if (e?.dataUri) return `<span class="gme e${p}_${i}" title="${escHTML(e.label || `pack ${p} #${i}`)}"></span>`;
        return `<span class="gme-missing">${escHTML(emojiLabel(p, i))}</span>`;
    }

    function renderTextHtml(m) {
        const segs = emojiSegments(m);
        const plain = (t) => escHTML(t).replace(/\n/g, '<br>');
        if (!segs) return plain(m.text || '');
        return segs.map(s => s.emoji ? emojiHtml(s.emoji[0], s.emoji[1]) : plain(s.text)).join('');
    }

    function fetchText(url, token = null) {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 30000,
                    headers: { 'Accept': 'application/json', ...authHeaders(url, token) },
                                  onload: (r) => {
                                      if (r.status < 200 || r.status >= 300) console.warn(`[GM EXPORTER] ${url} -> HTTP ${r.status}`);
                                      resolve(r.status >= 200 && r.status < 300 ? r.responseText : null);
                                  },
                                  onerror: () => resolve(null),
                                  ontimeout: () => resolve(null)
                });
            } catch { resolve(null); }
        });
    }

    function loadImage(buf) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(new Blob([buf]));
            const img = new Image();
            img.onload = () => resolve({ img, url });
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
            img.src = url;
        });
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function transliterationFor(translit, index) {
        if (!Array.isArray(translit)) return '';
        const t = translit[index];
        if (Array.isArray(t)) return t.length ? String(t[0]) : '';
        return t ? String(t) : '';
    }

    async function resolveEmojiPacks(messages, needImages, setStatus, token) {
        const used = new Map();
        for (const m of messages) {
            const info = getEmojiSlots(m);
            if (!info) continue;
            for (const [p, i] of info.slots) used.set(emojiKey(p, i), { pack: p, index: i });
        }
        const out = new Map();
        if (!used.size) return out;

        setStatus(`Resolving ${used.size} GroupMe emoji...`);
        const packs = new Map();
        const txt = await fetchText('https://powerup.groupme.com/powerups', token);
        if (!txt) console.warn('[GM EXPORTER] could not download the emoji pack list; emoji will show as labels');
        try {
            for (const pu of (JSON.parse(txt)?.powerups || [])) {
                const id = pu?.meta?.pack_id;
                if (id != null) packs.set(Number(id), pu);
            }
        } catch (e) { console.warn('[GM EXPORTER] could not parse powerups list', e); }

        const byPack = new Map();
        for (const u of used.values()) {
            if (!byPack.has(u.pack)) byPack.set(u.pack, []);
            byPack.get(u.pack).push(u);
        }

        for (const [packId, items] of byPack) {
            const pu = packs.get(Number(packId));
            const translit = pu?.meta?.transliterations || pu?.transliterations || null;
            let sheet = null;

            if (needImages && pu) {
                // Largest sprite sheets first; some hi-DPI URLs return Access Denied, so fall through.
                const cands = [...(pu.meta?.inline || []), ...(pu.meta?.keyboard || [])]
                .filter(c => c && c.image_url)
                .sort((a, b) => ((b.x || 0) - (a.x || 0)) || ((b.density || 0) - (a.density || 0)));
                for (const c of cands.slice(0, 4)) {
                    const buf = (await fetchBinary(c.image_url)) || (await fetchBinary(c.image_url, 30000, token));
                    if (!buf) continue;
                    try { sheet = await loadImage(buf); break; } catch { /* try next */ }
                }
                if (!sheet) console.warn(`[GM EXPORTER] no usable sprite sheet for emoji pack ${packId}`);
            }

            for (const it of items) {
                const entry = {
                    pack: it.pack, index: it.index,
                    label: transliterationFor(translit, it.index),
 path: `emoji/pack${it.pack}_${it.index}.png`,
 bytes: null, dataUri: null
                };
                if (sheet) {
                    try {
                        // Sprite is a strip of square frames (vertical, or horizontal as a fallback).
                        const w = sheet.img.naturalWidth, h = sheet.img.naturalHeight;
                        const vertical = h >= w;
                        const size = vertical ? w : h;
                        const count = Math.floor((vertical ? h : w) / size);
                        if (it.index < count) {
                            const canvas = document.createElement('canvas');
                            canvas.width = size; canvas.height = size;
                            canvas.getContext('2d').drawImage(
                                sheet.img,
                                vertical ? 0 : it.index * size, vertical ? it.index * size : 0,
                                size, size, 0, 0, size, size
                            );
                            entry.dataUri = canvas.toDataURL('image/png');
                            entry.bytes = b64ToBytes(entry.dataUri.split(',')[1]);
                        }
                    } catch (e) { console.warn('[GM EXPORTER] emoji crop failed', it, e); }
                }
                out.set(emojiKey(it.pack, it.index), entry);
            }
            if (sheet) URL.revokeObjectURL(sheet.url);
        }
        return out;
    }

    const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    function escHTML(str) {
        return String(str ?? '').replace(/[&<>"]/g, c => HTML_ESC[c]);
    }

    function buildHTMLReport(messages, groupInfo, userMap, msgMap, targetGroupId) {
        const groupName = escHTML(groupInfo?.name || `Group ${targetGroupId}`);
        const createdDate = groupInfo?.created_at ? new Date(groupInfo.created_at * 1000).toLocaleString() : 'N/A';

        // user id -> best display name
        const nameCache = new Map();
        const nameOf = (uid) => {
            const key = String(uid);
            let n = nameCache.get(key);
            if (n === undefined) {
                const u = userMap.get(key);
                n = u
                ? (u.current_nickname || u.account_name || u.aliases_seen[u.aliases_seen.length - 1] || key)
                : key;
                nameCache.set(key, n);
            }
            return n;
        };
        const namesList = (ids) => (ids || []).map(nameOf).join(', ');

        const rosterRows = [];
        for (const u of userMap.values()) {
            rosterRows.push(`<tr><td><code>${escHTML(u.user_id)}</code></td><td>${escHTML(u.account_name)}</td><td>${escHTML(u.aliases_seen.join(', '))}</td><td>${escHTML(u.devices_seen.join(', '))}</td><td>${u.msg_count}</td><td>${escHTML(u.roles)}</td></tr>`);
        }

        const defaultAvatar = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="%23333"/></svg>';
        const msgBlocks = [];

        for (const m of messages) {
            const dt = new Date(m.created_at * 1000);
            const iso = dt.toISOString();
            const local = dt.toLocaleString();

            if (m.system) {
                msgBlocks.push(`<div class="msg system" data-user="${escHTML(m.user_id)}" data-text="${escHTML((m.text || '').toLowerCase())}"><span class="sys-badge">SYSTEM (${escHTML(m.event?.type || 'event')})</span><span>${escHTML(m.text)}</span><span class="meta-right">${escHTML(local)} | ID: ${escHTML(m.id)}</span></div>`);
                continue;
            }

            let replyHtml = '';
            let mediaHtml = '';
            for (const att of (m.attachments || [])) {
                if (att.type === 'reply') {
                    const orig = msgMap.get(att.reply_id);
                    const preview = orig ? `${orig.name}: ${(orig.text || '[media]').slice(0, 80)}` : `Msg ID ${att.reply_id}`;
                    replyHtml += `<div class="reply-box">↳ Replying to <b>${escHTML(preview)}</b> (${escHTML(nameOf(att.user_id))})</div>`;
                } else if (att.type === 'image' || att.url?.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                    mediaHtml += `<div class="att-item"><a href="${escHTML(att.url)}" target="_blank"><img src="${escHTML(att.url)}" loading="lazy" alt="attachment"></a></div>`;
                } else if (att.type === 'video' || att.url?.match(/\.(mp4|mov|webm)$/i)) {
                    mediaHtml += `<div class="att-item"><video src="${escHTML(att.url)}" controls preload="none"></video></div>`;
                } else if (att.type === 'location') {
                    mediaHtml += `<div class="loc-box">📍 Location: <b>${escHTML(att.name || 'Pin')}</b> (${escHTML(att.lat)}, ${escHTML(att.lng)})</div>`;
                } else if (att.url || att.source_url) {
                    const link = att.url || att.source_url;
                    mediaHtml += `<div class="att-item"><a href="${escHTML(link)}" target="_blank">📎 ${escHTML(att.type || 'File')}: ${escHTML(link)}</a></div>`;
                }
            }

            let reactHtml = '';
            if (m.reactions?.length) {
                reactHtml = m.reactions.map(r =>
                `<span class="badge" title="${escHTML((r.user_ids || []).join(', '))}">${escHTML(r.code || r.type)} ${escHTML(namesList(r.user_ids))}</span>`
                ).join(' ');
            } else if (m.favorited_by?.length) {
                reactHtml = `<span class="badge" title="${escHTML(m.favorited_by.join(', '))}">❤️ ${escHTML(namesList(m.favorited_by))}</span>`;
            }

            msgBlocks.push(`<div class="msg" data-user="${escHTML(m.user_id)}" data-text="${escHTML((m.text || '').toLowerCase())} ${escHTML((m.name || '').toLowerCase())}"><img class="avatar" src="${escHTML(m.avatar_url || defaultAvatar)}" loading="lazy"><div class="msg-body"><div class="msg-header"><span class="sender">${escHTML(m.name)}</span><span class="uid">UID: ${escHTML(m.user_id)}</span><span class="os-tag">${escHTML(inferClientOS(m.source_guid))}</span><span class="time" title="${escHTML(iso)}">${escHTML(local)}</span></div>${replyHtml}${m.text ? `<div class="text">${renderTextHtml(m)}</div>` : ''}${mediaHtml ? `<div class="media-grid">${mediaHtml}</div>` : ''}${reactHtml ? `<div class="reactions">${reactHtml}</div>` : ''}<div class="forensics">MsgID: ${escHTML(m.id)} | GUID: ${escHTML(m.source_guid)} ${m.updated_at ? '| Edited: ' + new Date(m.updated_at * 1000).toLocaleString() : ''}</div></div></div>`);
        }

        const emojiCss = Array.from(emojiMap.values())
        .filter(e => e.dataUri)
        .map(e => `    .e${e.pack}_${e.index} { background-image: url(${e.dataUri}); }`)
        .join('\n');

        const userOptions = Array.from(userMap.values())
        .map(u => `<option value="${escHTML(u.user_id)}">${escHTML(u.account_name)} (${escHTML(u.user_id)})</option>`)
        .join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <title>${groupName} - OSINT Archive</title>
        <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #121212; color: #e0e0e0; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: auto; }
        header { background: #1e1e1e; padding: 16px; border-radius: 8px; border: 1px solid #333; margin-bottom: 16px; }
        h1 { margin: 0 0 8px 0; color: #00aff0; font-size: 20px; }
        .meta-grid { font-size: 12px; color: #aaa; line-height: 1.6; }
        details { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
        summary { cursor: pointer; font-weight: bold; color: #00aff0; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { border: 1px solid #333; padding: 6px 8px; text-align: left; }
        th { background: #252525; }
        .toolbar { position: sticky; top: 0; background: #121212; padding: 10px 0; z-index: 10; display: flex; gap: 10px; }
        input, select { background: #1e1e1e; color: #fff; border: 1px solid #444; padding: 8px; border-radius: 4px; font-size: 13px; }
        input { flex: 1; }
        .msg { display: flex; gap: 12px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px; margin-bottom: 8px; content-visibility: auto; contain-intrinsic-size: auto 80px; }
        .msg.system { background: #161b22; border-color: #263238; font-size: 12px; color: #90caf9; justify-content: space-between; align-items: center; }
        .avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: #333; }
        .msg-body { flex: 1; min-width: 0; }
        .msg-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
        .sender { font-weight: bold; color: #fff; }
        .uid, .os-tag { font-size: 11px; background: #2a2a2a; padding: 1px 5px; border-radius: 3px; color: #aaa; }
        .time { font-size: 11px; color: #888; margin-left: auto; }
        .reply-box { font-size: 12px; color: #aaa; border-left: 3px solid #00aff0; padding-left: 8px; margin-bottom: 6px; }
        .text { font-size: 14px; line-height: 1.45; word-wrap: break-word; }
        .media-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .att-item img, .att-item video { max-width: 280px; max-height: 280px; border-radius: 4px; border: 1px solid #333; }
        .loc-box { background: #222; padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-top: 6px; display: inline-block; }
        .reactions { margin-top: 6px; }
        .badge { font-size: 11px; background: #263238; color: #80cbc4; padding: 2px 8px; border-radius: 10px; margin-right: 4px; display: inline-block; }
        .forensics { font-size: 10px; color: #666; margin-top: 6px; }
        .gme { display: inline-block; width: 1.8em; height: 1.8em; vertical-align: -0.5em; background-size: contain; background-repeat: no-repeat; background-position: center; }
        .gme-missing { font-size: 12px; color: #888; }
        ${emojiCss}
        </style>
        </head>
        <body>
        <div class="container">
        <header>
        <h1>${groupName} (ID: ${escHTML(targetGroupId)})</h1>
        <div class="meta-grid">
        <b>Created:</b> ${escHTML(createdDate)} | <b>Creator ID:</b> ${escHTML(groupInfo?.creator_user_id || 'N/A')} |
        <b>Messages Exported:</b> ${messages.length} | <b>Share URL:</b> ${escHTML(groupInfo?.share_url || 'Disabled')}
        </div>
        </header>

        <details>
        <summary>Participant &amp; Alias Directory (${userMap.size} Users)</summary>
        <table>
        <thead><tr><th>User ID</th><th>Account Name</th><th>Aliases Seen</th><th>Devices</th><th>Msgs</th><th>Roles</th></tr></thead>
        <tbody>${rosterRows.join('')}</tbody>
        </table>
        </details>

        <div class="toolbar">
        <input type="text" id="search" placeholder="Filter messages by text or display name...">
        <select id="userFilter">
        <option value="">All Users (${userMap.size})</option>
        ${userOptions}
        </select>
        </div>

        <div id="feed">${msgBlocks.join('\n')}</div>
        </div>
        <script>
        const searchInput = document.getElementById('search');
        const userSelect = document.getElementById('userFilter');
        const msgs = document.querySelectorAll('.msg');
        let timer;
        function filterFeed() {
            const q = searchInput.value.toLowerCase();
            const u = userSelect.value;
            msgs.forEach(el => {
                const matchUser = !u || el.dataset.user === u;
                const matchText = !q || el.dataset.text.includes(q);
                el.style.display = (matchUser && matchText) ? 'flex' : 'none';
            });
        }
        searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(filterFeed, 150); });
        userSelect.addEventListener('change', filterFeed);
        </script>
        </body>
        </html>`;
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Don't revoke immediately: for large blobs the browser may not have
        // started reading yet, which silently kills the download.
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    }

    // ---------------------------------------------------------------
    // 8. Floating UI
    // ---------------------------------------------------------------
    function injectUI() {
        if (document.getElementById('gm-osint-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'gm-osint-panel';
        panel.style.cssText = `
        position: fixed; bottom: 16px; right: 16px; z-index: 999999;
        background: #181a1b; color: #e8e6e3; border: 1px solid #3c4043;
        border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5); width: 270px;
        `;
        panel.innerHTML = `
        <div style="font-weight:bold; margin-bottom:6px; color:#00aff0;">GM EXPORTER Exporter v2.3</div>
        <div id="gm-osint-meta" style="margin-bottom:6px; line-height:1.4; color:#aaa;"></div>
        <input type="text" id="gm-manual-gid" placeholder="Auto-detected (or override ID)" style="width:100%; box-sizing:border-box; margin-bottom:8px; padding:4px 6px; background:#252729; color:#fff; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:11px;">
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer; color:#ddd;">
        <input type="checkbox" id="gm-chk-media"> Download attachments &amp; ZIP
        </label>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px; cursor:pointer; color:#ddd;">
        <input type="checkbox" id="gm-chk-video"> Include videos (large/slow)
        </label>
        <div style="display:flex; gap:5px; margin-bottom:8px;">
        <button id="gm-btn-json" style="flex:1; padding:6px 4px; background:#00aff0; color:#000; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">JSON</button>
        <button id="gm-btn-csv" style="flex:1; padding:6px 4px; background:#2e7d32; color:#fff; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">CSV</button>
        <button id="gm-btn-html" style="flex:1; padding:6px 4px; background:#8e24aa; color:#fff; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">HTML</button>
        </div>
        <div id="gm-osint-status" style="color:#8ab4f8; word-wrap:break-word;">Idle</div>
        `;
        document.body.appendChild(panel);

        document.getElementById('gm-btn-json').addEventListener('click', () => exportChat('json'));
        document.getElementById('gm-btn-csv').addEventListener('click', () => exportChat('csv'));
        document.getElementById('gm-btn-html').addEventListener('click', () => exportChat('html'));
        lastUIState = '';
        detectGroupId();
    }

    function updateUI() {
        const metaEl = document.getElementById('gm-osint-meta');
        if (!metaEl) return;
        const token = getToken();
        const state = `${token ? token.slice(0, 6) : ''}|${activeGroupId || ''}`;
        if (state === lastUIState) return; // only touch the DOM when something changed
        lastUIState = state;

        const tokStatus = token
        ? `<span style="color:#4caf50;">Ready (${token.slice(0, 6)}...)</span>`
        : `<span style="color:#f44336;">Not found</span>`;
        const grpStatus = activeGroupId
        ? `<span style="color:#4caf50;">${activeGroupId}</span>`
        : `<span style="color:#f44336;">Select a chat</span>`;
        metaEl.innerHTML = `Token: ${tokStatus}<br>Group ID: ${grpStatus}`;
    }

    injectUI();
})();
