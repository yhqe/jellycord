// index.js
import rpc from '@xhayper/discord-rpc';
const { Client, Presence } = rpc;
import axios from 'axios';
import config from './config.js';
import fs from 'fs/promises';

const client = new Client({
    clientId: config.discordClientId,
});

const albumArtCache = new Map(); // Cache for uploaded album art URLs
const CACHE_FILE = 'art_cache.json'; // The file to store our cache
let lastTrackId = null;

async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf-8');

        if (!data) {
            console.log(`[Cache] ${CACHE_FILE} is empty. A new cache will be created.`);
            return;
        }

        const parsed = JSON.parse(data);

        // --- THE FIX ---
        // Instead of reassigning albumArtCache, clear the existing map
        // and add the loaded entries to it. This preserves the global reference.
        albumArtCache.clear();
        for (const [key, value] of Object.entries(parsed)) {
            albumArtCache.set(key, value);
        }

        console.log(`[Cache] Loaded ${albumArtCache.size} items from ${CACHE_FILE}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[Cache] ${CACHE_FILE} not found. A new cache will be created.`);
        } else {
            console.warn(`[Cache] Warning: Failed to read or parse ${CACHE_FILE}. Starting with a fresh cache. Error: ${error.message}`);
        }
    }
}

async function saveCache() {
    try {
        const dataToSave = Object.fromEntries(albumArtCache);
        await fs.writeFile(CACHE_FILE, JSON.stringify(dataToSave, null, 2));
        // This is a useful one-time log, so we keep it.
        console.log(`[Cache] Successfully saved cache with ${albumArtCache.size} items.`);
    } catch (error) {
        console.error('[Cache] Failed to save cache:', error);
    }
}

/**
 * Uploads an image to Catbox.moe by manually constructing the multipart/form-data request.
 * This avoids using the 'form-data' library which was causing conflicts.
 * @param {string} imageUrl The local URL of the image to upload.
 * @returns {Promise<string|null>} The public URL of the uploaded image, or null on failure.
 */
async function uploadImageToHost(imageUrl) {
    try {
        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
        });
        const imageBuffer = Buffer.from(imageResponse.data);

        if (imageBuffer.length === 0) {
            console.error('[Album Art] Downloaded image is empty. Aborting upload.');
            return null;
        }

        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
        const filename = 'albumart.jpg';

        const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}`;
        const bodyParts = [
            `--${boundary}`, 'Content-Disposition: form-data; name="reqtype"', '', 'fileupload',
            `--${boundary}`, `Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"`, `Content-Type: ${contentType}`, '', '',
        ];
        const bodyPrefix = Buffer.from(bodyParts.join('\r\n'));
        const bodySuffix = Buffer.from(`\r\n--${boundary}--`);
        const requestBody = Buffer.concat([bodyPrefix, imageBuffer, bodySuffix]);

        const uploadResponse = await axios.post('https://catbox.moe/user/api.php', requestBody, {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': requestBody.length, },
            validateStatus: () => true,
        });

        if (uploadResponse.status === 200 && uploadResponse.data.startsWith('http')) {
            console.log(`[Album Art] Uploaded to: ${uploadResponse.data}`);
            return uploadResponse.data;
        } else {
            console.error('[Album Art] Upload failed. Catbox.moe responded with:');
            console.error(`  - Status: ${uploadResponse.status}, Data: ${uploadResponse.data}`);
            return null;
        }
    } catch (error) {
        console.error(`[Album Art] A network error occurred during upload: ${error.message}`);
        return null;
    }
}

async function getJellyfinSession() {
    try {
        const response = await axios.get(`${config.jellyfinServerUrl}/Sessions`, {
            headers: { 'X-Emby-Token': config.jellyfinApiKey }
        });
        return response.data.find(s =>
            s.UserId === config.jellyfinUserId &&
            s.NowPlayingItem &&
            s.NowPlayingItem.Type === 'Audio'
        );
    } catch (error) {
        if (error.code !== 'ECONNREFUSED') {
            console.error(`[Jellyfin] Error fetching session: ${error.message}`);
        }
        return null;
    }
}

async function getAlbumArtUrl(albumId, trackId) {
    const artId = albumId || trackId;
    if (!artId) return 'jellyfin_logo';

    if (albumArtCache.has(artId)) {
        return albumArtCache.get(artId);
    }

    // This log is important because it only happens once per new album/single.
    console.log(`[Album Art] New item detected (ID: ${artId}). Proceeding to upload...`);
    const localArtUrl = `${config.jellyfinServerUrl}/Items/${artId}/Images/Primary`;
    const publicUrl = await uploadImageToHost(localArtUrl);

    if (publicUrl) {
        albumArtCache.set(artId, publicUrl);
        await saveCache();
        return publicUrl;
    }

    return 'jellyfin_logo';
}

async function updatePresence() {
    const session = await getJellyfinSession();

    if (session && session.NowPlayingItem) {
        const track = session.NowPlayingItem;
        const trackId = track.Id;
        const albumId = track.AlbumId;

        if (trackId !== lastTrackId) {
            lastTrackId = trackId;
            console.log(`[Discord] Now listening to: ${track.Artists.join(', ')} - ${track.Name}`);
        }

        // pass trackid for singles
        const largeImageUrl = await getAlbumArtUrl(albumId, trackId);

        /*const presence = new Presence()
            .setDetails(`${track.Name}`)
            .setState(`by ${track.Artists.join(', ')}`)
            .setLargeImage(`${config.jellyfinServerUrl}/Items/${track.AlbumId}/Images/Primary`)
            .setLargeText(`on ${track.Album}`)
            .setSmallImage('jellyfin_logo')
            .setSmallText('Jellyfin')
            .setStartTimestamp(Date.now() - Math.floor(session.PlayState.PositionTicks / 10000))
            .addButton('Listen on Jellyfin', `${config.jellyfinServerUrl}/web/index.html#!/details?id=${trackId}`);

        presence.data.type = 2; // Type 2 is for "Listening"*/

        client.user?.setActivity({
            details: `${track.Name}`,
            state: `by ${track.Artists.join(', ')}`,
            largeImageKey: largeImageUrl,
            largeImageText: `on ${track.Album}`,
            smallImageKey: 'jellyfin_logo',
            smallImageText: 'Jellyfin',
            startTimestamp: Date.now() - Math.floor(session.PlayState.PositionTicks / 10000),
            buttons: [
                {
                    label: 'Listen on Jellyfin',
                    url: `${config.jellyfinServerUrl}/web/index.html#!/details?id=${trackId}`
                }
            ],
            type: 2 // Type 2 is for "Listening"
        });

    } else {
        if (lastTrackId !== null) {
            console.log('[Discord] Playback stopped. Clearing presence.');
            lastTrackId = null;
            client.user?.clearActivity();
        }
    }
}

client.on('ready', () => {
    console.log(`[Discord] RPC connected for user ${client.user.username}`);
    console.log('[Jellyfin] Monitoring for listening activity...');
    updatePresence();
    setInterval(updatePresence, 2 * 1000);
});

client.on('disconnected', () => {
    console.log('[Discord] RPC disconnected. Will try to reconnect if the script is restarted.');
});

// --- NEW: Connection logic with a 15-second timeout ---
async function connectToDiscord() {
    await loadCache(); // --- MODIFIED: Load cache before starting ---
    console.log('[Discord] Connecting to RPC...');
    try {
        // Create a timeout promise
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out after 15 seconds.')), 15000)
        );
        // Race the connection against the timeout
        await Promise.race([client.login(), timeout]);
    } catch (err) {
        console.error(`\n[Discord] Failed to connect: ${err.message}`);
        console.error("Please check the following:");
        console.error("  1. Is the Discord desktop application running?");
        console.error("  2. Is the 'discordClientId' in config.js correct?");
        console.error("  3. Go to Discord Settings > Activity Privacy > 'Share your activity status by default' and ensure it's enabled.");
        process.exit(1); // Exit the script so it doesn't run in a broken state
    }
}

connectToDiscord();