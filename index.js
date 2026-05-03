// index.js
import rpc from '@xhayper/discord-rpc';
const { Client, Presence } = rpc;
import axios from 'axios';
import config from './config.js';
import fs from 'fs/promises';

const client = new Client({
    clientId: config.discordClientId,
});

const albumArtCache = new Map();
const CACHE_FILE = 'art_cache.json';
let lastTrackId = null;

async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf-8');

        if (!data) {
            console.log(`[cache] ${CACHE_FILE} is empty! a new cache will be created...`);
            return;
        }

        const parsed = JSON.parse(data);

        // the fix...
        albumArtCache.clear();
        for (const [key, value] of Object.entries(parsed)) {
            albumArtCache.set(key, value);
        }

        console.log(`[cache] loaded ${albumArtCache.size} items from ${CACHE_FILE}...`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[cache] ${CACHE_FILE} not found. a new cache will be created!`);
        } else {
            console.warn(`[cache] warning!! failed to read or parse ${CACHE_FILE}. starting with a fresh cache! error: ${error.message}`);
        }
    }
}

async function saveCache() {
    try {
        const dataToSave = Object.fromEntries(albumArtCache);
        await fs.writeFile(CACHE_FILE, JSON.stringify(dataToSave, null, 2));
        console.log(`[cache] successfully saved cache with ${albumArtCache.size} items!`);
    } catch (error) {
        console.error('[cache] failed to save cache!! ', error);
    }
}

async function uploadImageToHost(imageUrl) {
    try {
        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            validateStatus: () => true, // mmmmmm
        });

        if (imageResponse.status === 404) {
            return null;
        }
        const imageBuffer = Buffer.from(imageResponse.data);

        if (imageBuffer.length === 0) {
            console.error('[covers] downloaded image is empty :( aborting upload!');
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
            console.log(`[covers] success! uploaded to: ${uploadResponse.data}`);
            return uploadResponse.data;
        } else {
            console.error('[covers] upload failed!! catbox responded with:');
            console.error(`  - Status: ${uploadResponse.status}, Data: ${uploadResponse.data}`);
            return null;
        }
    } catch (error) {
        console.error(`[covers] a network error occurred during upload!! ${error.message}`);
        return null;
    }
}

async function getjellyfinSession() {
    try {
        const response = await axios.get(`${config.jellyfinServerUrl}/Sessions`, {
            headers: { 'X-Emby-Token': config.jellyfinApiKey }
        });

        const allowedTypes = new Set(['Audio', 'Movie', 'Episode', 'Video']);

        return response.data.find(s =>
            s.UserId === config.jellyfinUserId &&
            s.NowPlayingItem &&
            allowedTypes.has(s.NowPlayingItem.Type)
        );
    } catch (error) {
        if (error.code !== 'ECONNREFUSED') {
            console.error(`[jellyfin] error fetching session!! ${error.message}`);
        }
        return null;
    }
}

async function getAlbumArtUrl(albumId, trackId) {
    const artId = albumId || trackId;
    if (!artId) return 'disc';

    if (albumArtCache.has(artId)) {
        return albumArtCache.get(artId);
    }

    albumArtCache.set(artId, 'disc'); // fallback so it doesnt spam the console with "uplloading"

    console.log(`[covers] new item detected!! (id: ${artId}) proceeding to upload...`);
    const localArtUrl = `${config.jellyfinServerUrl}/Items/${artId}/Images/Primary`;
    const publicUrl = await uploadImageToHost(localArtUrl);

    if (publicUrl) {
        albumArtCache.set(artId, publicUrl);
        await saveCache();
        return publicUrl;
    } else {
        console.log(`[covers] no art found for ${artId}, using fallback`);
    }

    return 'disc';
}

async function updatePresence() {
    const session = await getjellyfinSession();

    if (session && session.NowPlayingItem && session.PlayState && !session.PlayState.IsPaused) {
        const item = session.NowPlayingItem;
        const itemType = item.Type;
        const currentId = `${itemType}:${item.Id}`;

        if (currentId !== lastTrackId) {
            lastTrackId = currentId;

            if (itemType === 'Audio') {
                console.log(`[discord] now listening to: ${(item.Artists || []).join(', ')} - ${item.Name}`);
            } else if (itemType === 'Movie') {
                console.log(`[discord] now watching movie: ${item.Name}`);
            } else if (itemType === 'Episode') {
                console.log(`[discord] now watching TV: ${item.SeriesName || 'Unknown Show'} - ${item.Name}`);
            } else {
                console.log(`[discord] now playing: ${item.Name || itemType}`);
            }
        }

        let details = item.Name || 'Playing media';
        let state = '';
        let largeImageText = 'jellyfin';
        let artAlbumId = null;
        let artTrackId = item.Id;

        if (itemType === 'Audio') {
            details = item.Name;
            state = `by ${(item.Artists || []).join(', ') || 'Unknown Artist'}`;
            largeImageText = `on ${item.Album || 'Unknown Album'}`;
            artAlbumId = item.AlbumId;
        } else if (itemType === 'Movie') {
            details = item.Name;
            state = `Watching movie`;
            largeImageText = item.ProductionYear ? `${item.ProductionYear}` : 'Movie';
            artAlbumId = item.ParentId || null;
        } else if (itemType === 'Episode') {
            details = item.Name;
            state = `${item.SeriesName || 'TV Show'}${item.ParentIndexNumber != null && item.IndexNumber != null
                ? ` • S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')}`
                : ''}`;
            largeImageText = item.SeriesName || 'TV Show';
            artAlbumId = item.SeriesId || item.SeasonId || null;
        }

        const largeImageUrl = await getAlbumArtUrl(artAlbumId, artTrackId);
        // console.log('[discord] setting activity for user:', client.user?.username); sjhut up prick
        client.user?.setActivity({
            details,
            state,
            largeImageKey: largeImageUrl,
            largeImageText,
            smallImageKey: 'jellyfin_logo',
            smallImageText: 'jellyfin',
            startTimestamp: Date.now() - Math.floor(session.PlayState.PositionTicks / 10000),
            endTimestamp: Date.now() + Math.floor((item.RunTimeTicks - session.PlayState.PositionTicks) / 10000),
            type: itemType === 'Audio' ? 2 : 3
        });

    } else {
        if (lastTrackId !== null) {
            console.log('[discord] playback stopped or paused... clearing presence');
            lastTrackId = null;
            client.user?.clearActivity();
        }
    }
}

client.on('ready', () => {
    console.log(`[discord] rpc connected for user ${client.user.username}`);
    console.log('[jellyfin] monitoring for listening activity...');
    updatePresence();
    setInterval(updatePresence, 2 * 1000);
});

client.on('disconnected', () => {
    console.log('[discord] rpc disconnected. will try to reconnect if the script is restarted!');
});

async function connectToDiscord() {
    await loadCache(); // IMPORTANT FOR covers DO NOT TOUCH!@!!!!!!!!@
    console.log('[discord] connecting to rpc...');
    try {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('connection timed out after 15 seconds!!')), 15000)
        );
        await Promise.race([client.login(), timeout]);
    } catch (err) {
        console.error(`\n[discord] failed to connect: ${err.message}`);
        console.error("please check the following");
        console.error("  1. is the discord client running?");
        console.error("  2. is the 'discordClientId' in config.js correct?");
        console.error("  3. go to discord settings > 'Activity Privacy' > 'Share your activity status by default' and ensure it's enabled");
        process.exit(1);
    }
}

connectToDiscord();

async function shutdown() {
    console.log('[discord] shutting down, clearing presence...');
    await client.user?.clearActivity();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);