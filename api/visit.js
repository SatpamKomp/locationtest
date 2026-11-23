const UAParser = require('ua-parser-js');

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
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

async function notifyDiscord(record) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
    if (!res.ok) console.error('Discord responded with status', res.status, await res.text());
  } catch (err) {
    console.warn('Discord notify failed:', err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

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

  console.log('New visit:', record); // viewable in Vercel's function logs

  await notifyDiscord(record);

  res.status(200).json({ ok: true, received: { device, ipLocation, gpsLocation } });
};
