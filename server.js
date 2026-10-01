// Decide: tiny group-poll server. No dependencies. Polls live in memory for 24h.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OPTIONS = 8, MAX_TEXT = 60, MAX_VOTERS = 50, MAX_POLLS = 5000;
const polls = new Map();

const id = (n) => crypto.randomBytes(n).toString('base64url');
const clean = (s, max = MAX_TEXT) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function results(p) {
  const voters = Object.values(p.votes);
  const scores = p.options.map((text, i) => {
    let yes = 0, no = 0, veto = 0;
    for (const v of voters) {
      if (v.choices[i] === 'yes') yes++;
      else if (v.choices[i] === 'veto') veto++;
      else if (v.choices[i] === 'no') no++;
    }
    return { text, yes, no, veto };
  });
  const eligible = scores.map((s, i) => ({ ...s, i })).filter((s) => s.veto === 0);
  const best = eligible.reduce((m, s) => Math.max(m, s.yes), -1);
  const winners = best > 0 ? eligible.filter((s) => s.yes === best).map((s) => s.i) : [];
  return { voters: voters.length, scores, winners };
}
const publicView = (p) => ({
  id: p.id, question: p.question, options: p.options, closed: p.closed,
  expiresAt: p.created + TTL_MS, ...results(p),
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// crude per-IP rate limit for creating polls
const created = new Map();
function rateLimited(ip) {
  const now = Date.now(); const list = (created.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now); created.set(ip, list); return list.length > 30;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api' && parts[1] === 'polls') {
      if (req.method === 'POST' && parts.length === 2) {
        if (rateLimited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many polls, try later.' });
        if (polls.size >= MAX_POLLS) return send(res, 503, { error: 'Busy, try later.' });
        const b = await readBody(req);
        const question = clean(b.question, 100);
        const options = [...new Set((Array.isArray(b.options) ? b.options : []).map((o) => clean(o)).filter(Boolean))].slice(0, MAX_OPTIONS);
        if (!question) return send(res, 400, { error: 'Add a question.' });
        if (options.length < 2) return send(res, 400, { error: 'Add at least 2 different options.' });
        const p = { id: id(6), adminToken: id(16), question, options, votes: {}, closed: false, created: Date.now() };
        polls.set(p.id, p);
        return send(res, 201, { id: p.id, adminToken: p.adminToken });
      }
      const p = polls.get(parts[2]);
      if (!p) return send(res, 404, { error: 'Poll not found or expired.' });
      if (req.method === 'GET' && parts.length === 3) return send(res, 200, publicView(p));
      if (req.method === 'POST' && parts[3] === 'vote') {
        if (p.closed) return send(res, 409, { error: 'Voting is closed.' });
        const b = await readBody(req);
        const voterId = clean(b.voterId, 40);
        if (!voterId) return send(res, 400, { error: 'Missing voter.' });
        if (!p.votes[voterId] && Object.keys(p.votes).length >= MAX_VOTERS) return send(res, 409, { error: 'Poll is full.' });
        const choices = {};
        p.options.forEach((_, i) => { const c = b.choices?.[i]; choices[i] = ['yes', 'no', 'veto'].includes(c) ? c : 'no'; });
        p.votes[voterId] = { name: clean(b.name, 24), choices };
        return send(res, 200, publicView(p));
      }
      if (req.method === 'POST' && parts[3] === 'close') {
        const b = await readBody(req);
        if (b.adminToken !== p.adminToken) return send(res, 403, { error: 'Only the creator can close.' });
        p.closed = true; return send(res, 200, publicView(p));
      }
    }
    // static files
    if (req.method === 'GET') {
      const file = parts[0] === 'p' || parts.length === 0 ? 'index.html' : path.basename(url.pathname);
      const full = path.join(__dirname, 'public', file);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: e.message }); }
});

setInterval(() => { const now = Date.now(); for (const [k, p] of polls) if (now - p.created > TTL_MS) polls.delete(k); }, 60_000).unref();
if (require.main === module) server.listen(PORT, () => console.log(`Decide running on http://localhost:${PORT}`));
module.exports = { server, results };
