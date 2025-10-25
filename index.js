// index.js
import rpc from '@xhayper/discord-rpc';
const { Client, Presence } = rpc;
import axios from 'axios';
import config from './config.js';

const client = new Client({
    clientId: config.discordClientId,
});

let lastTrackId = null;

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

async function updatePresence() {
    const session = await getJellyfinSession();

    if (session && session.NowPlayingItem) {
        const track = session.NowPlayingItem;
        const trackId = track.Id;

        if (trackId !== lastTrackId) {
            lastTrackId = trackId;
            console.log(`[Discord] Now listening to: ${track.Artists.join(', ')} - ${track.Name}`);
        }

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
            largeImageKey: `${config.jellyfinServerUrl}/Items/${track.AlbumId}/Images/Primary`,
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
    setInterval(updatePresence, 15 * 1000);
});

client.on('disconnected', () => {
    console.log('[Discord] RPC disconnected. Will try to reconnect if the script is restarted.');
});

// --- NEW: Connection logic with a 15-second timeout ---
async function connectToDiscord() {
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