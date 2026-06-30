/**
 * Drivable AzuraCast now-playing mock.
 *
 * Serves the static now-playing endpoint the orchestrator polls, plus control
 * endpoints so tests and manual integration runs can force track changes and
 * live-DJ transitions deterministically. Dependency-free (node:http only).
 *
 * Endpoints:
 *   GET  /api/nowplaying_static/main.json   -> current { now_playing, live }
 *   POST /__control/track  { artist, title, album }  -> advance sh_id, set song
 *   POST /__control/live   { is_live: boolean }       -> set live flag
 *   GET  /healthcheck                                  -> { status: 'ok' }
 *
 * Env: PORT (default 8095).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8095);

let state = {
  sh_id: 1,
  song: { artist: 'Stereolab', title: 'Brakhage', album: 'Dots and Loops' },
  is_live: false,
};

function payload() {
  return {
    now_playing: { sh_id: state.sh_id, song: state.song },
    live: { is_live: state.is_live },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => resolve({}));
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && url === '/api/nowplaying_static/main.json') {
    return json(res, 200, payload());
  }
  if (req.method === 'GET' && url === '/healthcheck') {
    return json(res, 200, { status: 'ok' });
  }
  if (req.method === 'POST' && url === '/__control/track') {
    const body = await readBody(req);
    state = {
      ...state,
      sh_id: state.sh_id + 1,
      song: {
        artist: body.artist ?? '',
        title: body.title ?? '',
        album: body.album ?? '',
      },
    };
    return json(res, 200, payload());
  }
  if (req.method === 'POST' && url === '/__control/live') {
    const body = await readBody(req);
    state = { ...state, is_live: Boolean(body.is_live) };
    return json(res, 200, payload());
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`azuracast-mock listening on :${PORT}`);
});
