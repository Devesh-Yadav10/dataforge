import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';

export interface TokenResponse {
  url: string;
  token: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function startTokenServer(port = Number(process.env.PORT || 3000)): http.Server {
  const clientDistDir = path.resolve(process.cwd(), 'client', 'dist');

  const serveStaticFile = (reqPath: string, res: http.ServerResponse): boolean => {
    const sanitizedPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const targetFile = path.resolve(clientDistDir, sanitizedPath);

    // Prevent path traversal outside client/dist directory
    if (!targetFile.startsWith(clientDistDir)) {
      return false;
    }

    if (!fs.existsSync(targetFile)) {
      return false;
    }

    try {
      const stat = fs.statSync(targetFile);
      if (!stat.isFile()) {
        return false;
      }

      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
      });
      fs.createReadStream(targetFile).pipe(res);
      return true;
    } catch {
      return false;
    }
  };

  const server = http.createServer(async (req, res) => {
    // Enable CORS for development convenience
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/token' && req.method === 'GET') {
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      const livekitUrl = process.env.LIVEKIT_URL;

      if (!apiKey || !apiSecret || !livekitUrl) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Server misconfiguration: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL is missing.',
          })
        );
        return;
      }

      try {
        const participantIdentity = `user-${randomUUID().slice(0, 8)}`;
        const roomName = url.searchParams.get('room') || 'default-room';

        // Create short-lived token (15 minutes TTL)
        const at = new AccessToken(apiKey, apiSecret, {
          identity: participantIdentity,
          name: participantIdentity,
          ttl: '15m',
        });

        // Grant essential participant permissions for voice interaction:
        // - join room
        // - publish audio and data
        // - subscribe to agent audio and data
        at.addGrant({
          roomJoin: true,
          room: roomName,
          canPublish: true,
          canPublishData: true,
          canSubscribe: true,
        });

        const token = await at.toJwt();

        // Return ONLY LiveKit URL and short-lived participant token (NEVER secret or keys)
        const responseData: TokenResponse = {
          url: livekitUrl,
          token,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      } catch (err: any) {
        console.error('Error creating participant token:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to generate token' }));
      }
    } else if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      // Serve static frontend assets from client/dist
      const served = serveStaticFile(url.pathname, res);
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Token Server] Port ${port} is already in use. Reusing existing token endpoint.`);
    } else {
      console.error('[Token Server] Server error:', err);
    }
  });

  server.listen(port, () => {
    console.log(`[Token Server] LiveKit participant token service listening on port ${port} (GET /token)`);
  });

  return server;
}

