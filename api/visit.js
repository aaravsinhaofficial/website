const crypto = require('crypto');

const MAX_FIELD_LENGTH = 500;
const IP_LOG_MODE = (process.env.VISITOR_LOG_IP_MODE || 'raw').toLowerCase();
const IP_HASH_SALT = process.env.VISITOR_LOG_IP_SALT || '';
const VISITOR_LOG_WEBHOOK_URL = process.env.VISITOR_LOG_WEBHOOK_URL || '';
const VISITOR_LOG_WEBHOOK_TOKEN = process.env.VISITOR_LOG_WEBHOOK_TOKEN || '';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  const forwardedFor = req.headers && req.headers['x-forwarded-for'];
  const realIp = req.headers && req.headers['x-real-ip'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0].split(',')[0].trim();
  }

  if (typeof realIp === 'string' && realIp.trim() !== '') {
    return realIp.trim();
  }

  return 'unknown';
}

function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(IP_HASH_SALT + ip)
    .digest('hex');
}

function truncateIp(ip) {
  if (ip === 'unknown') {
    return ip;
  }

  if (ip.indexOf(':') !== -1) {
    return ip.split(':').slice(0, 4).join(':') + '::';
  }

  if (ip.indexOf('.') !== -1) {
    return ip.split('.').slice(0, 3).join('.') + '.0';
  }

  return ip;
}

function formatIpForLog(ip) {
  if (IP_LOG_MODE === 'off' || IP_LOG_MODE === 'none') {
    return undefined;
  }

  if (IP_LOG_MODE === 'hash' || IP_LOG_MODE === 'hashed') {
    return hashIp(ip);
  }

  if (IP_LOG_MODE === 'truncate' || IP_LOG_MODE === 'truncated') {
    return truncateIp(ip);
  }

  return ip;
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

function normalizeBody(body) {
  if (!body) {
    return {};
  }

  if (Buffer.isBuffer(body)) {
    return normalizeBody(body.toString('utf8'));
  }

  if (typeof body === 'object') {
    return body;
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (error) {
      return {};
    }
  }

  return {};
}

function readRawBody(req) {
  return new Promise(function (resolve) {
    let rawBody = '';

    req.on('data', function (chunk) {
      rawBody += chunk;
    });

    req.on('end', function () {
      resolve(rawBody);
    });

    req.on('error', function () {
      resolve('');
    });
  });
}

function getVercelGeo(req) {
  const headers = req.headers || {};

  return {
    country: cleanString(headers['x-vercel-ip-country']),
    region: cleanString(headers['x-vercel-ip-country-region']),
    city: cleanString(headers['x-vercel-ip-city'])
  };
}

async function forwardVisit(visit) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (!VISITOR_LOG_WEBHOOK_URL) {
    return;
  }

  if (VISITOR_LOG_WEBHOOK_TOKEN) {
    headers.Authorization = 'Bearer ' + VISITOR_LOG_WEBHOOK_TOKEN;
  }

  await fetch(VISITOR_LOG_WEBHOOK_URL, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(visit)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const rawBody = req.body === undefined ? await readRawBody(req) : req.body;
  const body = normalizeBody(rawBody);
  const ip = getClientIp(req);
  const loggedIp = formatIpForLog(ip);
  const visit = {
    event: 'page_visit',
    timestamp: new Date().toISOString(),
    ipMode: IP_LOG_MODE,
    path: cleanString(body.path),
    title: cleanString(body.title),
    referrer: cleanString(body.referrer),
    timezone: cleanString(body.timezone),
    userAgent: cleanString(req.headers && req.headers['user-agent']),
    geo: getVercelGeo(req)
  };

  if (loggedIp !== undefined) {
    visit.ip = loggedIp;
  }

  console.log(JSON.stringify(visit));

  try {
    await forwardVisit(visit);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'visit_forward_failed',
      timestamp: new Date().toISOString(),
      message: error && error.message ? error.message : 'Unknown webhook error'
    }));
  }

  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
};
